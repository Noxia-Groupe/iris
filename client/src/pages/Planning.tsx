import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus, Tags, Trash2, X, Users, Info, Share2, AlertTriangle } from 'lucide-react';
import { apiFetch } from '../api';
import {
  type Intervenant, type ChantierLite, type PlanningType, type PlanningEvent,
  lundiDe, joursDeLaSemaine, estWeekEnd, numeroSemaineIso, shiftDateStr, diffJours,
  couleurEvent, texteSurCouleur, libelleEvent, badgeCreneau, tooltipEvent,
} from '../planningUtils';
import ShareModal, { type PlanningShareState } from '../components/PlanningShareModal';
import { isAdminRole } from '../roles';
import { useModules } from '../modules';
import { formatDateOnly, jourCivilEntrepriseIso } from '../lib/dateFormatting';
import { useCompanyTimezone, useFuseauSocieteConnu } from '../companyTimezoneContext';
import { planningDayToIso } from '../lib/contractPlanningDate';

// ---------------------------------------------------------------------------
// Planning d'intervention (réservé aux administrateurs).
// Vue "planning d'équipe" : une ligne par technicien (Intervenant), une colonne par
// jour de la semaine. On y place des affectations PRÉVISIONNELLES : chantier suivi,
// chantier/intervention non suivi (ex: SAV) ou événement personnalisé (type + couleur).
// Aucun lien avec les heures réelles : rien n'est écrit dans le Journal des Heures.
// ---------------------------------------------------------------------------

type ContractQueueItem = {
  id: string; reference: string; titre: string; echeanceContrat: string;
  client: { raisonSociale: string }; site: { nom: string; ville: string } | null;
  contratMaintenance: { id: string; titre: string };
  dureePrevisionnelleMinutes: number;
};

type ModalState =
  | { mode: 'create'; date: string; intervenantId?: string }
  | { mode: 'edit'; event: PlanningEvent };

const CATEGORIES: { value: PlanningEvent['categorie']; label: string }[] = [
  { value: 'CHANTIER', label: 'Chantier suivi' },
  { value: 'HORS_CHANTIER', label: 'Hors suivi (SAV…)' },
  { value: 'EVENEMENT', label: 'Événement' },
];

const CRENEAUX: { value: PlanningEvent['creneau']; label: string }[] = [
  { value: 'JOURNEE', label: 'Journée' },
  { value: 'MATIN', label: 'Matin' },
  { value: 'APRES_MIDI', label: 'Après-midi' },
  { value: 'HEURES', label: 'Heures précises' },
];

const Planning = () => {
  // Rôle réel : le partage public (Publier/Renouveler/Désactiver) reste réservé aux
  // admins (action plus sensible, expose des données sans authentification) — le reste du
  // module (affectations, types d'événements) est ouvert aux conducteurs comme aux admins.
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const userRole = user?.role || 'CONDUCTEUR_TRAVAUX';
  const isAdmin = isAdminRole(userRole);
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
  const [loading, setLoading] = useState(true);
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
      try {
        const [intervRes, chantiersRes, typesRes] = await Promise.all([
          apiFetch('/intervenants'),
          apiFetch('/planning/chantiers'),
          apiFetch('/planning/types'),
        ]);
        const interv = await intervRes.json();
        const chant = await chantiersRes.json();
        const t = await typesRes.json();
        if (Array.isArray(interv)) setIntervenants(interv.sort((a: Intervenant, b: Intervenant) => a.nom.localeCompare(b.nom)));
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

  useEffect(() => { fetchQueue(); }, []);

  const fetchEvents = async () => {
    const requete = ++requeteEvents.current;
    try {
      const res = await apiFetch(`/planning/events?start=${weekStartStr}&end=${weekEndStr}`);
      const data = await res.json();
      if (Array.isArray(data) && requete === requeteEvents.current) setEvents(data);
    } catch (e) {
      console.error(e);
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

  const labelSemaine = `Semaine du ${formatDateOnly(`${weekStartStr}T00:00:00Z`, { day: 'numeric', month: 'long' })} au ${formatDateOnly(`${weekEndStr}T00:00:00Z`, { day: 'numeric', month: 'long', year: 'numeric' })}`;

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
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {isAdmin && (
            <button onClick={() => setShowShare(true)} className="btn btn-secondary flex items-center gap-2">
              <Share2 size={16} />
              {!share?.published ? 'Publier' : share.active ? 'Renouveler le lien' : 'Partage désactivé'}
            </button>
          )}
          <button onClick={() => setShowTypes(true)} className="btn btn-secondary flex items-center gap-2">
            <Tags size={16} /> Types d'événements
          </button>
          {/* Date du jour préremplie seulement une fois le fuseau de la société lu (sinon, celui d'Europe/Paris) : à saisir sinon. */}
          <button onClick={() => setModal({ mode: 'create', date: fuseauConnu ? todayStr : '' })} className="btn btn-primary flex items-center gap-2">
            <Plus size={16} /> Affectation
          </button>
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

      <section aria-label="Interventions contractuelles à planifier" className="mb-4 bg-white rounded-xl border p-4">
        <h2 className="font-bold mb-2">Interventions contractuelles à planifier</h2>
        {contractQueue.length === 0 ? <p className="text-sm text-muted">Aucune visite en attente.</p> : (
          <table className="w-full text-sm"><thead><tr><th>Échéance</th><th>Référence</th><th>Client / site</th><th>Contrat</th><th>Durée</th><th></th></tr></thead>
            <tbody>{contractQueue.map(item => <tr key={item.id} className="border-t">
              <td>{formatDateOnly(item.echeanceContrat).replaceAll('/', '-')}</td><td>{item.reference}</td>
              <td>{item.client.raisonSociale} — {item.site?.nom || 'Sans site'} {item.site?.ville || ''}</td>
              <td>{item.contratMaintenance.titre}</td><td>{item.dureePrevisionnelleMinutes} min</td>
              <td><button className="btn btn-primary" onClick={() => setToPlace(item)}>Placer</button></td>
            </tr>)}</tbody>
          </table>
        )}
      </section>

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

      {intervenants.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500 font-semibold mb-2">Aucun technicien enregistré.</p>
          <p className="text-sm text-gray-400">
            Ajoutez d'abord vos intervenants dans <Link to="/admin" className="text-accent font-semibold hover:underline">Administration → Intervenants</Link>.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full border-collapse" style={{ minWidth: '980px' }}>
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-gray-50 border border-gray-100 px-3 py-3 text-left text-xs uppercase text-gray-500 font-semibold" style={{ width: '170px', minWidth: '170px' }}>
                  Technicien
                </th>
                {jours.map((jStr) => {
                  const isToday = jStr === todayStr;
                  return (
                    <th key={jStr} className={`border border-gray-100 px-2 py-3 text-center text-xs uppercase ${isToday ? 'bg-blue-50 text-accent font-extrabold' : 'text-gray-500 font-semibold'}`}>
                      {formatDateOnly(`${jStr}T00:00:00Z`, { weekday: 'short' })} {jStr.slice(8, 10)}-{jStr.slice(5, 7)}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {intervenants.map((interv) => (
                <tr key={interv.id}>
                  <th className="sticky left-0 z-10 bg-white border border-gray-100 px-3 py-2 text-left align-top">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 shrink-0 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-xs">
                        {interv.nom.substring(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="font-bold text-gray-800 text-sm truncate">{interv.nom}</div>
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
                        onClick={() => setModal({ mode: 'create', date: jStr, intervenantId: interv.id })}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => { e.preventDefault(); handleDrop(interv.id, jStr); }}
                        className={`border border-gray-100 p-1 align-top cursor-pointer transition-colors hover:bg-gray-50 ${isToday ? 'bg-blue-50' : isWeekend ? 'bg-gray-50/50' : ''}`}
                        title="Cliquer pour ajouter une affectation"
                      >
                        <div className="flex flex-col gap-1" style={{ minHeight: '64px' }}>
                          {cellEvents.map((ev) => {
                            const bg = couleurEvent(ev);
                            const badge = badgeCreneau(ev);
                            return (
                              <div
                                key={ev.id}
                                draggable
                                onDragStart={(e) => {
                                  dragRef.current = { eventId: ev.id, fromIntervenantId: interv.id, fromDate: jStr };
                                  e.dataTransfer.effectAllowed = 'move';
                                }}
                                onClick={(e) => { e.stopPropagation(); setModal({ mode: 'edit', event: ev }); }}
                                className="rounded-md px-1.5 py-1 text-xs font-semibold cursor-pointer shadow-sm leading-tight"
                                style={{ backgroundColor: bg, color: texteSurCouleur(bg) }}
                                title={tooltipEvent(ev)}
                              >
                                {badge && <span className="block font-bold opacity-90" style={{ fontSize: '10px' }}>{badge}</span>}
                                <span className="block truncate">{libelleEvent(ev)}</span>
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

const ContractPlacement = ({ item, intervenants, onClose, onSaved }: {
  item: ContractQueueItem; intervenants: Intervenant[]; onClose: () => void; onSaved: () => void;
}) => {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const dateDebut = planningDayToIso(String(fd.get('jour')));
    if (!dateDebut) {
      setError('Date invalide : saisissez un jour réel au format JJ-MM-AAAA.');
      return;
    }
    const heureDebut = String(fd.get('heureDebut'));
    const duree = Number(fd.get('duree'));
    const depart = Number(heureDebut.slice(0, 2)) * 60 + Number(heureDebut.slice(3));
    if (!Number.isInteger(duree) || duree < 1 || depart + duree >= 1440) {
      setError('La durée doit être positive et se terminer le même jour.');
      return;
    }
    const fin = depart + duree;
    const heureFin = `${String(Math.floor(fin / 60)).padStart(2, '0')}:${String(fin % 60).padStart(2, '0')}`;
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch(`/interventions/${item.id}/planning`, { method: 'PUT', body: JSON.stringify({
        dateDebut, creneau: 'HEURES', heureDebut, heureFin,
        intervenantIds: [String(fd.get('technicienId'))],
      }) });
      if (!res.ok) { const data = await res.json(); setError(data.error || 'Placement impossible.'); return; }
      onSaved();
    } catch { setError('Impossible de joindre le serveur.'); }
    finally { setSaving(false); }
  };
  return <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
    <div role="dialog" aria-label={`Planifier ${item.reference}`} className="bg-white rounded-xl p-6 w-full max-w-md">
      <h2 className="font-bold mb-2">Planifier {item.reference}</h2>
      <p className="text-sm mb-4">{item.titre} — {item.client.raisonSociale}</p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label>Technicien<select required name="technicienId" className="form-input" defaultValue=""><option value="" disabled>Choisir</option>{intervenants.map(i => <option key={i.id} value={i.id}>{i.nom}</option>)}</select></label>
        <label>Jour<input required type="text" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" name="jour" className="form-input" defaultValue={formatDateOnly(item.echeanceContrat).replaceAll('/', '-')} /></label>
        <label>Heure de début<input required type="time" name="heureDebut" className="form-input" defaultValue="09:00" /></label>
        <label>Durée (minutes)<input required type="number" name="duree" min="1" max="1439" className="form-input" defaultValue={item.dureePrevisionnelleMinutes} /></label>
        {error && <p role="alert" className="text-red-700">{error}</p>}
        <div className="flex gap-2"><button disabled={saving} className="btn btn-primary">Confirmer le placement</button><button type="button" className="btn" onClick={onClose}>Annuler</button></div>
      </form>
    </div>
  </div>;
};

// ---------------------------------------------------------------------------
// Modale de création / édition d'une affectation.
// Champs texte/dates non contrôlés (FormData, comme le reste de l'appli) ; seuls la
// catégorie, le créneau et le choix de type (pour afficher/masquer les sections
// correspondantes) sont contrôlés.
// ---------------------------------------------------------------------------
const EventModal = ({
  modal,
  intervenants,
  chantiers,
  types,
  onClose,
  onSaved,
  onDelete,
  onTypesChanged,
}: {
  modal: ModalState;
  intervenants: Intervenant[];
  chantiers: ChantierLite[];
  types: PlanningType[];
  onClose: () => void;
  onSaved: () => void;
  onDelete: (ev: PlanningEvent) => void;
  onTypesChanged: () => void;
}) => {
  const isEdit = modal.mode === 'edit';
  const event = isEdit ? modal.event : null;
  const linkedIntervention = !!(event as PlanningEvent & { interventionId?: string } | null)?.interventionId;
  const [categorie, setCategorie] = useState<PlanningEvent['categorie']>(event?.categorie || 'CHANTIER');
  const [creneau, setCreneau] = useState<PlanningEvent['creneau']>(event?.creneau || 'JOURNEE');
  const [typeSel, setTypeSel] = useState<string>(event?.typeEventId || '');
  const [saving, setSaving] = useState(false);

  // On ne propose que les chantiers en cours (c'est le sens du module) ; si une
  // affectation existante pointe un chantier depuis clôturé, on le garde en option
  // pour ne pas casser l'édition.
  const chantiersEnCours = chantiers
    .filter((c) => c.statut === 'EN_COURS' || (event?.chantierId === c.id))
    .sort((a, b) => a.nom.localeCompare(b.nom));

  const defaultDebut = isEdit ? event!.dateDebut.slice(0, 10) : modal.date;
  const defaultFin = isEdit ? event!.dateFin.slice(0, 10) : modal.date;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);

    const intervenantIds = fd.getAll('intervenantIds').map(String);
    if (intervenantIds.length === 0) {
      alert('Sélectionnez au moins un technicien.');
      return;
    }

    setSaving(true);
    try {
      // Création d'un nouveau type d'événement à la volée si demandé.
      let typeEventId = typeSel;
      if (categorie === 'EVENEMENT' && typeSel === '__new__') {
        const nom = String(fd.get('nouveauTypeNom') || '').trim();
        if (!nom) {
          alert("Saisissez le libellé du nouveau type d'événement.");
          setSaving(false);
          return;
        }
        const resType = await apiFetch('/planning/types', {
          method: 'POST',
          body: JSON.stringify({ nom, couleur: fd.get('nouveauTypeCouleur') }),
        });
        const dType = await resType.json();
        if (!resType.ok) {
          alert(dType.error || 'Erreur lors de la création du type.');
          setSaving(false);
          return;
        }
        typeEventId = dType.id;
        onTypesChanged();
      }

      const payload = {
        categorie,
        creneau,
        dateDebut: String(fd.get('dateDebut') || ''),
        dateFin: String(fd.get('dateFin') || '') || String(fd.get('dateDebut') || ''),
        heureDebut: String(fd.get('heureDebut') || '') || null,
        heureFin: String(fd.get('heureFin') || '') || null,
        chantierId: String(fd.get('chantierId') || '') || null,
        titre: String(fd.get('titre') || '') || null,
        client: String(fd.get('client') || '') || null,
        adresse: String(fd.get('adresse') || '') || null,
        typeEventId: typeEventId || null,
        commentaire: String(fd.get('commentaire') || '') || null,
        intervenantIds,
      };

      const res = isEdit
        ? await apiFetch(`/planning/events/${event!.id}`, { method: 'PATCH', body: JSON.stringify(linkedIntervention ? {
          dateDebut: payload.dateDebut, dateFin: payload.dateFin, creneau: payload.creneau,
          heureDebut: payload.heureDebut, heureFin: payload.heureFin, intervenantIds: payload.intervenantIds,
          adresse: payload.adresse, commentaire: payload.commentaire,
        } : payload) })
        : await apiFetch('/planning/events', { method: 'POST', body: JSON.stringify(payload) });
      if (res.ok) {
        onSaved();
      } else {
        const d = await res.json();
        alert(d.error || "Erreur lors de l'enregistrement de l'affectation.");
      }
    } catch {
      alert('Impossible de joindre le serveur.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-4">
          <h2 className="text-lg font-bold text-primary-dark m-0">{isEdit ? "Modifier l'affectation" : 'Nouvelle affectation'}</h2>
          <button onClick={onClose} className="p-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors" title="Fermer">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Nature de l'affectation */}
          {!linkedIntervention && <div>
            <label className="form-label">Nature</label>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setCategorie(c.value)}
                  className={`text-sm font-semibold px-3 py-1.5 rounded-lg border transition-colors ${categorie === c.value ? 'bg-primary text-white border-primary' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>}

          {categorie === 'CHANTIER' && (
            <div className="form-group mb-0">
              <label className="form-label">Chantier (en cours)</label>
              <select required name="chantierId" className="form-input" defaultValue={event?.chantierId || ''}>
                <option value="" disabled>Sélectionner un chantier...</option>
                {chantiersEnCours.map((c) => (
                  <option key={c.id} value={c.id}>{c.nom} — {c.client}{c.statut === 'TERMINE' ? ' (Terminé)' : ''}</option>
                ))}
              </select>
            </div>
          )}

          {categorie === 'HORS_CHANTIER' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group mb-0">
                <label className="form-label">Nom du chantier / intervention</label>
                <input required name="titre" readOnly={linkedIntervention} className="form-input" placeholder="Ex: SAV alarme entrepôt" defaultValue={event?.titre || ''} />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Client (optionnel)</label>
                <input name="client" readOnly={linkedIntervention} className="form-input" defaultValue={event?.client || ''} placeholder="Nom du client" />
              </div>
              <div className="form-group mb-0 md:col-span-2">
                <label className="form-label">Adresse du site (optionnel)</label>
                <input name="adresse" className="form-input" defaultValue={event?.adresse || ''} placeholder="Adresse du site" />
              </div>
            </div>
          )}

          {categorie === 'EVENEMENT' && (
            <div className="form-group mb-0">
              <label className="form-label">Type d'événement</label>
              <select required name="typeEventId" className="form-input" value={typeSel} onChange={(e) => setTypeSel(e.target.value)}>
                <option value="" disabled>Sélectionner un type...</option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>{t.nom}</option>
                ))}
                <option value="__new__">+ Créer un nouveau type…</option>
              </select>
              {typeSel === '__new__' && (
                <div className="flex gap-2 mt-2 items-center">
                  <input name="nouveauTypeNom" className="form-input flex-1" placeholder="Libellé (ex: Congés, Formation...)" />
                  <input type="color" name="nouveauTypeCouleur" defaultValue="#f59e0b" className="h-9 w-14 p-0.5 border border-gray-200 rounded cursor-pointer" title="Couleur du type" />
                </div>
              )}
            </div>
          )}

          {/* Techniciens */}
          <div>
            <label className="form-label">Technicien(s)</label>
            <div className="flex flex-wrap gap-2">
              {intervenants.map((i) => (
                <label key={i.id} className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors">
                  <input
                    type="checkbox"
                    name="intervenantIds"
                    value={i.id}
                    className="w-4 h-4"
                    defaultChecked={isEdit ? event!.intervenants.some((x) => x.id === i.id) : modal.intervenantId === i.id}
                  />
                  {i.nom}
                </label>
              ))}
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="form-group mb-0">
              <label className="form-label">Du</label>
              <input required type="date" name="dateDebut" className="form-input" defaultValue={defaultDebut} />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">Au (inclus)</label>
              <input type="date" name="dateFin" className="form-input" defaultValue={defaultFin} />
            </div>
          </div>

          {/* Créneau */}
          <div>
            <label className="form-label">Créneau</label>
            <div className="flex flex-wrap gap-2">
              {CRENEAUX.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setCreneau(c.value)}
                  className={`text-sm font-semibold px-3 py-1.5 rounded-lg border transition-colors ${creneau === c.value ? 'bg-primary text-white border-primary' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            {creneau === 'HEURES' && (
              <div className="flex gap-4 mt-2">
                <div className="form-group mb-0 flex-1">
                  <label className="form-label">De</label>
                  <input required type="time" name="heureDebut" className="form-input" defaultValue={event?.heureDebut || '08:00'} />
                </div>
                <div className="form-group mb-0 flex-1">
                  <label className="form-label">À</label>
                  <input required type="time" name="heureFin" className="form-input" defaultValue={event?.heureFin || '12:00'} />
                </div>
              </div>
            )}
          </div>

          <div className="form-group mb-0">
            <label className="form-label">Commentaire (optionnel)</label>
            <input name="commentaire" className="form-input" placeholder="Consignes, matériel à prévoir..." defaultValue={event?.commentaire || ''} />
          </div>

          <div className="flex gap-2 mt-2">
            <button disabled={saving} className="btn btn-primary px-8">{saving ? 'Enregistrement…' : isEdit ? 'Enregistrer' : 'Ajouter au planning'}</button>
            <button type="button" onClick={onClose} className="btn bg-white border">Annuler</button>
            {isEdit && !linkedIntervention && (
              <button type="button" onClick={() => onDelete(event!)} className="btn ml-auto flex items-center gap-1.5 bg-red-100 hover:bg-red-200 text-red-700">
                <Trash2 size={15} /> Supprimer
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Modale de gestion des types d'événements réutilisables (libellé + couleur).
// ---------------------------------------------------------------------------
const TypesModal = ({ types, onClose, onChanged }: { types: PlanningType[]; onClose: () => void; onChanged: () => void }) => {
  const [edit, setEdit] = useState<PlanningType | null>(null);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    try {
      const res = await apiFetch('/planning/types', {
        method: 'POST',
        body: JSON.stringify({ nom: fd.get('nom'), couleur: fd.get('couleur') }),
      });
      if (res.ok) {
        form.reset();
        onChanged();
      } else {
        const d = await res.json();
        alert(d.error || 'Erreur lors de la création du type.');
      }
    } catch {
      alert('Impossible de joindre le serveur.');
    }
  };

  const handleSave = async () => {
    if (!edit) return;
    try {
      const res = await apiFetch(`/planning/types/${edit.id}`, {
        method: 'PUT',
        body: JSON.stringify({ nom: edit.nom, couleur: edit.couleur }),
      });
      if (res.ok) {
        setEdit(null);
        onChanged();
      } else {
        const d = await res.json();
        alert(d.error || 'Erreur lors de la modification du type.');
      }
    } catch {
      alert('Impossible de joindre le serveur.');
    }
  };

  const handleDelete = async (t: PlanningType) => {
    if (!confirm(`Supprimer le type « ${t.nom} » ?`)) return;
    try {
      const res = await apiFetch(`/planning/types/${t.id}`, { method: 'DELETE' });
      if (res.ok) onChanged();
      else {
        const d = await res.json();
        alert(d.error || 'Suppression impossible.');
      }
    } catch {
      alert('Impossible de joindre le serveur.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-lg w-full max-w-md max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className="text-lg font-bold text-primary-dark m-0">Types d'événements</h2>
            <p className="text-xs text-muted mt-1">Libellés réutilisables (congés, formation...) avec leur couleur dans le planning.</p>
          </div>
          <button onClick={onClose} className="p-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors" title="Fermer">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleAdd} className="flex gap-2 items-center mb-4">
          <input required name="nom" className="form-input flex-1" placeholder="Nouveau type (ex: Congés)" />
          <input type="color" name="couleur" defaultValue="#f59e0b" className="h-9 w-14 p-0.5 border border-gray-200 rounded cursor-pointer" title="Couleur" />
          <button className="btn btn-primary px-3 py-2" title="Ajouter"><Plus size={16} /></button>
        </form>

        <div className="flex flex-col gap-2">
          {types.length === 0 && <p className="text-sm text-gray-400 italic text-center py-4">Aucun type pour le moment.</p>}
          {types.map((t) => (
            <div key={t.id} className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg">
              {edit?.id === t.id ? (
                <>
                  <input
                    className="form-input flex-1"
                    value={edit.nom}
                    onChange={(e) => setEdit({ ...edit, nom: e.target.value })}
                  />
                  <input
                    type="color"
                    value={edit.couleur}
                    onChange={(e) => setEdit({ ...edit, couleur: e.target.value })}
                    className="h-9 w-12 p-0.5 border border-gray-200 rounded cursor-pointer"
                  />
                  <button type="button" onClick={handleSave} className="text-sm px-3 py-1 bg-primary text-white font-semibold rounded">OK</button>
                  <button type="button" onClick={() => setEdit(null)} className="text-sm px-2 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded">✕</button>
                </>
              ) : (
                <>
                  <span className="w-4 h-4 rounded shrink-0" style={{ backgroundColor: t.couleur }}></span>
                  <span className="flex-1 text-sm font-semibold text-gray-800">{t.nom}</span>
                  <button type="button" onClick={() => setEdit(t)} className="text-sm px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded">Modifier</button>
                  <button type="button" onClick={() => handleDelete(t)} className="text-sm px-2 py-1 bg-red-100 hover:bg-red-200 text-red-700 font-semibold rounded" title="Supprimer">
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Planning;
