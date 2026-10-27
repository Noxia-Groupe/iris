import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus, Tags, Users, Info, Share2, AlertTriangle } from 'lucide-react';
import { apiFetch } from '../api';
import {
  type Intervenant, type ChantierLite, type PlanningType, type PlanningEvent,
  lundiDe, joursDeLaSemaine, estWeekEnd, numeroSemaineIso, shiftDateStr, diffJours, lignesDuPlanning,
  couleurEvent, texteSurCouleur, libelleEvent, badgeCreneau, tooltipEvent,
} from '../planningUtils';
import ShareModal, { type PlanningShareState } from '../components/PlanningShareModal';
import { isAdminRole } from '../roles';
import { ROLE_TECHNICIEN } from '../lib/droits';
import { useModules } from '../modules';
import { jourCivilEntrepriseIso, jourFrancais, jourSemaineFrancais } from '../lib/dateFormatting';
import { useCompanyTimezone, useFuseauSocieteConnu } from '../companyTimezoneContext';
import { type ContractQueueItem, dateDue } from '../lib/fileAPlanifier';
import { ContractPlacement } from '../components/PlanningPlacementIntervention';
import { CreationSuite } from '../components/CreationSuite';
import { EventModal, type ModalState } from '../components/PlanningModaleAffectation';
import { TypesModal } from '../components/PlanningModaleTypes';

// ---------------------------------------------------------------------------
// Planning d'intervention (réservé aux administrateurs).
// Vue "planning d'équipe" : une ligne par technicien (Intervenant), une colonne par
// jour de la semaine. On y place des affectations PRÉVISIONNELLES : chantier suivi,
// chantier/intervention non suivi (ex: SAV) ou événement personnalisé (type + couleur).
// Aucun lien avec les heures réelles : rien n'est écrit dans le Journal des Heures.
// ---------------------------------------------------------------------------

const Planning = () => {
  // Rôle réel : le partage public (Publier/Renouveler/Désactiver) reste réservé aux
  // admins (action plus sensible, expose des données sans authentification) — le reste du
  // module (affectations, types d'événements) est ouvert aux conducteurs comme aux admins.
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const userRole = user?.role || 'CONDUCTEUR_TRAVAUX';
  const isAdmin = isAdminRole(userRole);
  // Le technicien consulte le planning sans le modifier (lot pilote 3, choix par défaut) : ni
  // affectation, ni type d'événement, ni placement. Le serveur le refuse aussi (blockTechnicien).
  // Il n'y voit que ses affectations et celles des chantiers dont il est titulaire (décisions de Nelson
  // du 19 et du 21-10-2026) : sa ligne, puis celles des intervenants des affectations que le serveur
  // lui envoie.
  const lectureSeule = userRole === ROLE_TECHNICIEN;
  // Module désactivé par un super administrateur : la page n'est plus atteignable que par
  // lui (cf. App.tsx), d'où l'avertissement ci-dessous — il doit savoir que ce qu'il
  // prépare ici n'est visible de personne d'autre tant que le module reste coupé.
  const { planningActifGlobal } = useModules();

  const [intervenants, setIntervenants] = useState<Intervenant[]>([]);
  const [chantiers, setChantiers] = useState<ChantierLite[]>([]);
  const [types, setTypes] = useState<PlanningType[]>([]);
  const [events, setEvents] = useState<PlanningEvent[]>([]);
  const [contractQueue, setContractQueue] = useState<ContractQueueItem[]>([]);
  const [toPlace, setToPlace] = useState<ContractQueueItem | null>(null);
  // Intervention terminée « à suivre » dont on crée la suite depuis la file (intervention de suivi liée).
  const [aSuivre, setASuivre] = useState<ContractQueueItem | null>(null);
  const [suiteCreee, setSuiteCreee] = useState('');
  const [loading, setLoading] = useState(true);
  // Équipe illisible (panne, refus) : l'écran le dit, au lieu d'annoncer une équipe vide ou une fiche non reliée.
  const [equipeIllisible, setEquipeIllisible] = useState(false);
  // Semaine choisie (son lundi) ; tant qu'on n'a pas navigué, celle du jour de la société.
  const [semaineChoisie, setSemaineChoisie] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [showTypes, setShowTypes] = useState(false);
  const [showShare, setShowShare] = useState(false);
  // État du partage public (bouton Publier / Renouveler le lien / Partage désactivé) :
  // chargé une fois au montage, puis tenu à jour par les actions de la modale de partage.
  const [share, setShare] = useState<PlanningShareState | null>(null);
  // Glisser-déposer : l'affectation en cours de déplacement + la cellule d'origine.
  const dragRef = useRef<{ eventId: string; fromIntervenantId: string; fromDate: string } | null>(null);

  const fuseau = useCompanyTimezone();
  const fuseauConnu = useFuseauSocieteConnu();
  const todayStr = jourCivilEntrepriseIso(fuseau);
  // Seule la dernière demande d'affectations s'affiche : une réponse dépassée (semaine changée,
  // ou fuseau de la société lu entre-temps) est ignorée.
  const requeteEvents = useRef(0);
  const weekStartStr = semaineChoisie ?? lundiDe(todayStr);
  const jours = joursDeLaSemaine(weekStartStr);
  const weekEndStr = jours[6];

  useEffect(() => {
    (async () => {
      let equipeLue = false;
      try {
        const [intervRes, chantiersRes, typesRes] = await Promise.all([
          apiFetch('/intervenants'),
          // La liste des chantiers ne sert qu'au formulaire d'affectation, fermé au technicien (403).
          lectureSeule ? null : apiFetch('/planning/chantiers'),
          apiFetch('/planning/types'),
        ]);
        const interv = await intervRes.json();
        equipeLue = intervRes.ok && Array.isArray(interv);
        if (equipeLue) setIntervenants(interv.sort((a: Intervenant, b: Intervenant) => a.nom.localeCompare(b.nom)));
        else setEquipeIllisible(true);
        const chant = chantiersRes ? await chantiersRes.json() : [];
        const t = await typesRes.json();
        if (Array.isArray(chant)) setChantiers(chant);
        if (Array.isArray(t)) setTypes(t);
        // Le partage public reste réservé aux admins : pas la peine d'appeler une route
        // qu'un conducteur ne peut de toute façon pas utiliser (403 côté serveur).
        if (isAdmin) {
          const shareRes = await apiFetch('/planning/share');
          if (shareRes.ok) setShare(await shareRes.json());
        }
      } catch (e) {
        console.error(e);
        if (!equipeLue) setEquipeIllisible(true);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchQueue = async () => {
    try {
      const res = await apiFetch('/planning/interventions-a-planifier');
      if (res.ok) setContractQueue(await res.json());
    } catch (e) { console.error(e); }
  };

  // En consultation seule, la file n'est pas affichée : inutile de la demander.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!lectureSeule) fetchQueue(); }, []);

  // Semaine des affectations reçues, et semaine dont la lecture a échoué : au changement de
  // semaine, les lignes des collègues du technicien ne reprennent pas celles de la semaine quittée,
  // et son message « aucune fiche » attend la réponse.
  const [semaineRecue, setSemaineRecue] = useState<string | null>(null);
  const [semaineEnEchec, setSemaineEnEchec] = useState<string | null>(null);
  const fetchEvents = async () => {
    const requete = ++requeteEvents.current;
    const semaine = weekStartStr;
    let recue = false;
    try {
      const res = await apiFetch(`/planning/events?start=${weekStartStr}&end=${weekEndStr}`);
      const data = await res.json();
      if (Array.isArray(data) && requete === requeteEvents.current) {
        setEvents(data);
        setSemaineRecue(semaine);
        recue = true;
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (!recue && requete === requeteEvents.current) setSemaineEnEchec(semaine);
    }
  };

  useEffect(() => {
    fetchEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStartStr]);

  const fetchTypes = async () => {
    try {
      const res = await apiFetch('/planning/types');
      const data = await res.json();
      if (Array.isArray(data)) setTypes(data);
    } catch (e) {
      console.error(e);
    }
  };

  // Affectations d'un technicien couvrant un jour donné, triées par créneau
  // (matin → journée → heures → après-midi) pour une lecture naturelle de la cellule.
  const rangCreneau: Record<string, number> = { MATIN: 0, JOURNEE: 1, HEURES: 2, APRES_MIDI: 3 };
  const eventsCellule = (intervenantId: string, jour: string) =>
    events
      .filter((ev) => ev.intervenants.some((i) => i.id === intervenantId) && ev.dateDebut.slice(0, 10) <= jour && jour <= ev.dateFin.slice(0, 10))
      .sort((a, b) => (rangCreneau[a.creneau] - rangCreneau[b.creneau]) || (a.heureDebut || '').localeCompare(b.heureDebut || ''));

  // Dépôt d'une affectation sur une cellule : décale ses dates du nombre de jours du
  // déplacement et, si on change de ligne, remplace le technicien d'origine par celui
  // de la ligne cible (les autres techniciens de l'affectation restent inchangés).
  const handleDrop = async (targetIntervenantId: string, targetDate: string) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const ev = events.find((e) => e.id === drag.eventId);
    if (!ev) return;

    const delta = diffJours(drag.fromDate, targetDate);
    let intervenantIds = ev.intervenants.map((i) => i.id);
    if (targetIntervenantId !== drag.fromIntervenantId) {
      intervenantIds = intervenantIds.filter((id) => id !== drag.fromIntervenantId);
      if (!intervenantIds.includes(targetIntervenantId)) intervenantIds.push(targetIntervenantId);
    }
    if (delta === 0 && targetIntervenantId === drag.fromIntervenantId) return;

    try {
      const res = await apiFetch(`/planning/events/${ev.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          dateDebut: shiftDateStr(ev.dateDebut.slice(0, 10), delta),
          dateFin: shiftDateStr(ev.dateFin.slice(0, 10), delta),
          intervenantIds,
        }),
      });
      if (res.ok) fetchEvents();
      else {
        const d = await res.json();
        alert(d.error || 'Déplacement impossible.');
      }
    } catch {
      alert('Impossible de joindre le serveur.');
    }
  };

  const handleDelete = async (ev: PlanningEvent) => {
    if (!confirm(`Supprimer cette affectation (${libelleEvent(ev)}) du planning ?`)) return;
    try {
      const res = await apiFetch(`/planning/events/${ev.id}`, { method: 'DELETE' });
      if (res.ok) {
        setModal(null);
        fetchEvents();
      } else {
        const d = await res.json();
        alert(d.error || 'Suppression impossible.');
      }
    } catch {
      alert('Impossible de joindre le serveur.');
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-xl text-muted animate-pulse">Chargement du planning...</div>
    </div>
  );

  const labelSemaine = `Semaine du ${jourFrancais(weekStartStr)} au ${jourFrancais(weekEndStr)}`;
  const lignes = lignesDuPlanning(intervenants, lectureSeule ? { id: user?.id } : null, semaineRecue === weekStartStr ? events : []);
  const semaineLue = semaineRecue === weekStartStr || semaineEnEchec === weekStartStr;
  const ficheReliee = !!user?.id && intervenants.some((intervenant) => intervenant.userId === user.id);

  return (
    <div className="flex flex-col h-full">
      {/* En-tête : titre + navigation de semaine + actions */}
      <div className="flex flex-wrap justify-between items-center gap-3 mb-4 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-primary-dark m-0 leading-tight">Planning d'intervention</h1>
          <p className="text-sm text-muted mt-1 flex items-center gap-1.5">
            <Info size={14} className="shrink-0" />
            Prévisionnel uniquement : n'alimente jamais les heures des chantiers (saisie manuelle dans le Journal des Heures).
          </p>
          {lectureSeule && <p className="text-sm text-muted mt-1">Vous ne voyez que vos affectations et celles des chantiers dont vous êtes titulaire.</p>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {isAdmin && (
            <button onClick={() => setShowShare(true)} className="btn btn-secondary flex items-center gap-2">
              <Share2 size={16} />
              {!share?.published ? 'Publier' : share.active ? 'Renouveler le lien' : 'Partage désactivé'}
            </button>
          )}
          {lectureSeule ? (
            <span className="text-sm font-semibold px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700">Consultation seule</span>
          ) : (
            <>
              <button onClick={() => setShowTypes(true)} className="btn btn-secondary flex items-center gap-2">
                <Tags size={16} /> Types d'événements
              </button>
              {/* Date du jour préremplie seulement une fois le fuseau de la société lu (sinon, celui d'Europe/Paris) : à saisir sinon. */}
              <button onClick={() => setModal({ mode: 'create', date: fuseauConnu ? todayStr : '' })} className="btn btn-primary flex items-center gap-2">
                <Plus size={16} /> Affectation
              </button>
            </>
          )}
        </div>
      </div>

      {!planningActifGlobal && (
        <div className="mb-4 p-4 rounded-xl border border-amber-300 bg-amber-50 text-amber-900 flex items-start gap-3">
          <AlertTriangle size={20} className="shrink-0 mt-0.5" />
          <div className="text-sm">
            <strong className="block">Module Planning désactivé pour tous les utilisateurs.</strong>
            Le planning n'apparaît plus dans le menu des autres comptes — administrateurs compris — et leur est
            inaccessible. Aucune donnée n'a été supprimée : tout sera restitué à l'identique à la réactivation. En tant
            que super administrateur, vous pouvez continuer à le consulter et à le modifier. La réactivation se fait
            depuis <strong>Administration &gt; Modules</strong>.
          </div>
        </div>
      )}

      {!lectureSeule && (
      <section aria-label="Interventions à planifier" className="mb-4 bg-white rounded-xl border p-4">
        <h2 className="font-bold mb-2">Interventions à planifier</h2>
        {suiteCreee && <p role="status" className="mb-2 text-sm text-emerald-800">{suiteCreee}</p>}
        {/* Le tableau défile dans son cadre sur téléphone, au lieu de couper le bouton « Placer ». */}
        {contractQueue.length === 0 ? <p className="text-sm text-muted">Aucune intervention en attente.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th>Date due</th><th>Référence</th><th>Client / site</th><th>Origine</th><th>Durée</th><th></th></tr></thead>
            <tbody>{contractQueue.map(item => <tr key={item.id} className="border-t">
              <td>{dateDue(item) || '—'}</td><td>{item.reference}</td>
              <td>{item.client.raisonSociale} — {item.site?.nom || 'Sans site'} {item.site?.ville || ''}</td>
              <td>{item.contratMaintenance ? item.contratMaintenance.titre : 'SAV hors contrat'}{item.aSuivre && <span className="ml-2 inline-block rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">À suivre</span>}</td>
              <td>{item.dureePrevisionnelleMinutes ? `${item.dureePrevisionnelleMinutes} min` : '—'}</td>
              {/* Terminée « à suivre » : elle ne se place pas elle-même, on crée sa suite, qui entre dans la file. */}
              <td>{item.aSuivre ? <button className="btn btn-primary" onClick={() => { setSuiteCreee(''); setASuivre(item); }}>Créer la suite</button> : <button className="btn btn-primary" onClick={() => setToPlace(item)}>Placer</button>}</td>
            </tr>)}</tbody>
          </table></div>
        )}
      </section>
      )}

      {/* Navigation de semaine */}
      <div className="flex items-center justify-between gap-3 mb-4 bg-white px-4 py-3 rounded-xl shadow-sm border border-gray-100">
        <div className="flex items-center gap-2">
          <button onClick={() => setSemaineChoisie(shiftDateStr(weekStartStr, -7))} className="p-2 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors" title="Semaine précédente">
            <ChevronLeft size={18} />
          </button>
          <button onClick={() => setSemaineChoisie(null)} className="text-sm font-semibold px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors" title="Revenir à aujourd'hui">
            Semaine {numeroSemaineIso(weekStartStr)}
          </button>
          <button onClick={() => setSemaineChoisie(shiftDateStr(weekStartStr, 7))} className="p-2 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors" title="Semaine suivante">
            <ChevronRight size={18} />
          </button>
        </div>
        <h2 className="text-base font-bold text-gray-800 m-0 text-right">{labelSemaine}</h2>
      </div>

      {lectureSeule && !equipeIllisible && !ficheReliee && lignes.length > 0 && (
        <p className="mb-4 text-sm text-muted">Aucune fiche intervenant n'est reliée à votre compte : seules les affectations des chantiers dont vous êtes titulaire s'affichent.</p>
      )}

      {equipeIllisible ? (
        <div className="card text-center py-12" role="alert">
          <p className="text-gray-500 font-semibold mb-2">Lecture de l'équipe impossible pour le moment.</p>
          <p className="text-sm text-gray-400">Rechargez la page dans un instant.</p>
        </div>
      ) : lectureSeule && lignes.length === 0 && !semaineLue ? (
        <div className="card text-center py-12 text-sm text-gray-400">Chargement des affectations…</div>
      ) : lectureSeule && lignes.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500 font-semibold mb-2">Aucune fiche intervenant n'est reliée à votre compte.</p>
          <p className="text-sm text-gray-400">Vos affectations s'afficheront dès que l'administration l'aura reliée ; celles des chantiers dont vous êtes titulaire apparaissent ici lorsqu'il y en a cette semaine.</p>
        </div>
      ) : intervenants.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500 font-semibold mb-2">Aucun technicien enregistré.</p>
          <p className="text-sm text-gray-400">
            Ajoutez d'abord vos intervenants dans <Link to="/admin" className="text-accent font-semibold hover:underline">Administration → Intervenants</Link>.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          {/* Colonnes fixes : un nom de technicien ou un libellé long est tronqué au lieu d'élargir sa
              colonne. Sans cela, sur téléphone, la colonne des techniciens, fixée à gauche, pouvait
              couvrir toute la largeur du cadre et rendre les affectations impossibles à toucher. */}
          <table className="w-full border-collapse table-fixed" style={{ minWidth: '980px' }}>
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-gray-50 border border-gray-100 px-3 py-3 text-left text-xs uppercase text-gray-500 font-semibold" style={{ width: '170px', minWidth: '170px' }}>
                  Technicien
                </th>
                {jours.map((jStr) => {
                  const isToday = jStr === todayStr;
                  return (
                    <th key={jStr} className={`border border-gray-100 px-2 py-3 text-center text-xs uppercase ${isToday ? 'bg-blue-50 text-accent font-extrabold' : 'text-gray-500 font-semibold'}`}>
                      {jourSemaineFrancais(jStr)}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {lignes.map((interv) => (
                <tr key={interv.id}>
                  <th className="sticky left-0 z-10 bg-white border border-gray-100 px-3 py-2 text-left align-top">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 shrink-0 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-xs">
                        {interv.nom.substring(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="font-bold text-gray-800 text-sm truncate" title={interv.nom}>{interv.nom}</div>
                        <div className="text-xs text-gray-400 font-normal truncate">{interv.role}</div>
                      </div>
                    </div>
                  </th>
                  {jours.map((jStr) => {
                    const isToday = jStr === todayStr;
                    const isWeekend = estWeekEnd(jStr);
                    const cellEvents = eventsCellule(interv.id, jStr);
                    return (
                      <td
                        key={jStr}
                        onClick={lectureSeule ? undefined : () => setModal({ mode: 'create', date: jStr, intervenantId: interv.id })}
                        onDragOver={lectureSeule ? undefined : (e) => e.preventDefault()}
                        onDrop={lectureSeule ? undefined : (e) => { e.preventDefault(); handleDrop(interv.id, jStr); }}
                        className={`border border-gray-100 p-1 align-top ${lectureSeule ? '' : 'cursor-pointer transition-colors hover:bg-gray-50'} ${isToday ? 'bg-blue-50' : isWeekend ? 'bg-gray-50/50' : ''}`}
                        title={lectureSeule ? undefined : 'Cliquer pour ajouter une affectation'}
                      >
                        <div className="flex flex-col gap-1" style={{ minHeight: '64px' }}>
                          {cellEvents.map((ev) => {
                            const bg = couleurEvent(ev);
                            const badge = badgeCreneau(ev);
                            return (
                              <div
                                key={ev.id}
                                draggable={!lectureSeule}
                                onDragStart={lectureSeule ? undefined : (e) => {
                                  dragRef.current = { eventId: ev.id, fromIntervenantId: interv.id, fromDate: jStr };
                                  e.dataTransfer.effectAllowed = 'move';
                                }}
                                onClick={lectureSeule ? undefined : (e) => { e.stopPropagation(); setModal({ mode: 'edit', event: ev }); }}
                                className={`rounded-md px-1.5 py-1 text-xs font-semibold shadow-sm leading-tight ${lectureSeule ? '' : 'cursor-pointer'}`}
                                style={{ backgroundColor: bg, color: texteSurCouleur(bg) }}
                                title={tooltipEvent(ev)}
                              >
                                {badge && <span className="block font-bold opacity-90" style={{ fontSize: '10px' }}>{badge}</span>}
                                <span className="block truncate">{libelleEvent(ev)}</span>
                                {/* Intervention terminée « à suivre » : la marque se voit aussi au planning (point 29). */}
                                {ev.intervention?.aSuivre && <span className="inline-block rounded-full bg-violet-100 px-1.5 text-violet-800" style={{ fontSize: '10px' }}>À suivre</span>}
                                {ev.intervenants.length > 1 && (
                                  <span className="inline-flex items-center gap-0.5 opacity-90" style={{ fontSize: '10px' }}>
                                    <Users size={10} /> ×{ev.intervenants.length}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {aSuivre && <CreationSuite intervention={{ ...aSuivre, horsContrat: !aSuivre.contratMaintenance }} onClose={() => setASuivre(null)} onCreee={(suite) => { setASuivre(null); setSuiteCreee(`Suite ${suite.reference} créée : elle est dans la file, à placer.`); fetchQueue(); fetchEvents(); }} />}
      {toPlace && <ContractPlacement item={toPlace} intervenants={intervenants} onClose={() => setToPlace(null)} onSaved={() => { setToPlace(null); fetchQueue(); fetchEvents(); }} />}

      {modal && (
        <EventModal
          key={modal.mode === 'edit' ? modal.event.id : `create-${modal.date}-${modal.intervenantId || ''}`}
          modal={modal}
          intervenants={intervenants}
          chantiers={chantiers}
          types={types}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); fetchEvents(); }}
          onDelete={handleDelete}
          onTypesChanged={fetchTypes}
          // Intervention remise « à planifier » : elle quitte la grille et revient dans la file.
          onRemise={() => { setModal(null); fetchEvents(); fetchQueue(); }}
        />
      )}

      {showTypes && (
        <TypesModal types={types} onClose={() => setShowTypes(false)} onChanged={() => { fetchTypes(); fetchEvents(); }} />
      )}

      {isAdmin && showShare && (
        <ShareModal share={share} onClose={() => setShowShare(false)} onChanged={setShare} />
      )}
    </div>
  );
};

export default Planning;
