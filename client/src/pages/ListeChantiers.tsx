import { useState, useEffect, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Archive, RotateCcw, Search, X, AlertTriangle, CheckCircle2, Building2, TrendingDown } from 'lucide-react';
import { apiFetch } from '../api';
import { SectionRepliable } from '../components/SectionRepliable';
import { ProgressMeter } from '../components/ProgressMeter';
import { AlertesChantier } from '../components/AlertesChantier';
import { estExcluDesOperations, isAdminRole, roleLabel, ROLE_TECHNICIEN } from '../roles';
import {
  alertesDuChantier, ancienneteSaisie, estASurveiller, filtrerChantiers, trierChantiers,
  type ChantierSuivi, type FiltreChantiers, type TriChantiers,
} from '../lib/suiviChantiers';
import { arrondiEuro } from '../lib/montants';

type ChantierListe = ChantierSuivi & { metrics?: ChantierSuivi['metrics'] & { diffHeures?: number } };

const FILTRES: { valeur: FiltreChantiers; libelle: string; margeRequise?: boolean; montantsRequis?: boolean }[] = [
  { valeur: 'TOUS', libelle: 'Tous' },
  { valeur: 'A_SURVEILLER', libelle: 'À surveiller' },
  { valeur: 'EN_PERTE', libelle: 'En perte', margeRequise: true },
  { valeur: 'MARGE_FAIBLE', libelle: 'Marge faible', margeRequise: true },
  { valeur: 'HEURES_DEPASSEES', libelle: 'Heures dépassées', montantsRequis: true },
  { valeur: 'MAIN_OEUVRE_DEPASSEE', libelle: 'Main-d’œuvre dépassée', montantsRequis: true },
  { valeur: 'MATERIEL_DEPASSE', libelle: 'Matériel dépassé', montantsRequis: true },
  { valeur: 'SANS_SAISIE', libelle: 'Sans saisie' },
];
const TRIS: { valeur: TriChantiers; libelle: string; margeRequise?: boolean }[] = [
  { valeur: 'PRIORITE', libelle: 'À surveiller d’abord' },
  { valeur: 'AVANCEMENT', libelle: 'Plus avancés d’abord' },
  { valeur: 'MARGE', libelle: 'Marge estimée la plus faible d’abord', margeRequise: true },
  { valeur: 'NOM', libelle: 'Nom (A → Z)' },
];

const fmtEuro = (n: number) => `${arrondiEuro(n).toLocaleString('fr-FR')} €`;
const fmtHeures = (n: number) => `${n.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} h`;

// Compteurs cliquables : un chiffre qui intrigue mène directement à la liste filtrée.
function Compteur({ valeur, libelle, icone, actif, alerte = false, onClick }: { valeur: number; libelle: string; icone: ReactNode; actif: boolean; alerte?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={actif}
      className={`bg-white p-4 rounded-xl shadow-sm border text-left flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3 transition-colors hover:bg-gray-50 ${actif ? 'border-accent' : alerte ? 'border-red-200' : 'border-gray-100'}`}
    >
      <div className={`p-2 rounded-lg ${alerte ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-accent'}`}>{icone}</div>
      <div>
        <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">{libelle}</div>
        <div className={`text-2xl font-black mt-0.5 ${alerte ? 'text-red-600' : 'text-primary-dark'}`}>{valeur}</div>
      </div>
    </button>
  );
}

const ListeChantiers = () => {
  const navigate = useNavigate();
  const [chantiers, setChantiers] = useState<ChantierListe[]>([]);
  const [loading, setLoading] = useState(true);
  // Recherche, filtre et tri vivent dans l'URL : revenir d'une fiche chantier retrouve la
  // liste telle qu'on l'avait laissée, et un lien « à surveiller » s'ouvre déjà filtré.
  const [parametres, setParametres] = useSearchParams();
  const recherche = parametres.get('q') ?? '';
  const filtreDemande = (parametres.get('filtre') ?? 'TOUS') as FiltreChantiers;
  const triDemande = (parametres.get('tri') ?? 'PRIORITE') as TriChantiers;

  // Rôle réel
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const userRole = user?.role || 'CONDUCTEUR_TRAVAUX';

  useEffect(() => {
    fetchChantiers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchChantiers = async () => {
    try {
      const res = await apiFetch('/chantiers');
      const data = await res.json();
      if(Array.isArray(data)) setChantiers(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const majParametre = (cle: string, valeur: string, parDefaut: string) => {
    setParametres((actuels) => {
      const suivants = new URLSearchParams(actuels);
      if (valeur && valeur !== parDefaut) suivants.set(cle, valeur);
      else suivants.delete(cle);
      return suivants;
    }, { replace: true });
  };

  // Clôturer un chantier (en cours -> terminé) : quand le serveur le permet (peutCloturer).
  // Une fois clôturé, plus aucune heure ni dépense ne peut y être ajoutée.
  const handleCloturer = async (id: string, nom: string) => {
    if (!confirm(`Clôturer « ${nom} » ? Il passera en Terminé/Archivé et il ne sera plus possible d'y ajouter des heures ou des dépenses.`)) return;
    try {
      const res = await apiFetch(`/chantiers/${id}/statut`, { method: 'PATCH', body: JSON.stringify({ statut: 'TERMINE' }) });
      if (res.ok) fetchChantiers();
      else { const d = await res.json(); alert(d.error || 'Erreur lors de la clôture du chantier.'); }
    } catch (e) {
      alert('Impossible de joindre le serveur.');
    }
  };

  // Réouvrir un chantier clôturé (terminé -> en cours) : réservé aux admins.
  const handleReouvrir = async (id: string, nom: string) => {
    if (!confirm(`Réouvrir « ${nom} » ? Il repassera en cours.`)) return;
    try {
      const res = await apiFetch(`/chantiers/${id}/statut`, { method: 'PATCH', body: JSON.stringify({ statut: 'EN_COURS' }) });
      if (res.ok) fetchChantiers();
      else { const d = await res.json(); alert(d.error || 'Erreur lors de la réouverture du chantier.'); }
    } catch (e) {
      alert('Impossible de joindre le serveur.');
    }
  };


  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-xl text-muted animate-pulse">Chargement des chantiers...</div>
    </div>
  );

  const isAdmin = isAdminRole(userRole);
  // La marge n'arrive que pour les destinataires de la rentabilité de chaque chantier (cf.
  // Administration > Marges) et si le module est actif : la colonne Marge, le filtre « en
  // perte » et le tri par marge n'ont de sens que si au moins une marge est connue.
  const margeVisible = chantiers.some((c) => c.metrics?.margeCommerciale != null);
  // Un technicien ne reçoit ni montants ni alertes de dépassement (règle du serveur) : ni colonne
  // Matériel, ni filtre de dépassement qui resterait toujours vide.
  const montantsVisibles = userRole !== ROLE_TECHNICIEN;
  const filtresProposes = FILTRES.filter((f) => (!f.margeRequise || margeVisible) && (!f.montantsRequis || montantsVisibles));
  const trisProposes = TRIS.filter((t) => !t.margeRequise || margeVisible);
  const filtre = filtresProposes.some((f) => f.valeur === filtreDemande) ? filtreDemande : 'TOUS';
  const tri = trisProposes.some((t) => t.valeur === triDemande) ? triDemande : 'PRIORITE';

  const tousEnCours = chantiers.filter((c) => c.statut === 'EN_COURS');
  const nbASurveiller = tousEnCours.filter(estASurveiller).length;
  const nbEnPerte = tousEnCours.filter((c) => alertesDuChantier(c).includes('EN_PERTE')).length;
  const chantiersEnCours = trierChantiers(filtrerChantiers(tousEnCours, recherche, filtre), tri);
  const chantiersTermines = trierChantiers(filtrerChantiers(chantiers.filter((c) => c.statut === 'TERMINE'), recherche, filtre), tri);
  const filtresActifs = filtre !== 'TOUS' || recherche.trim() !== '';
  const reinitialiser = () => setParametres(new URLSearchParams(), { replace: true });

  // `repliable` : la liste des chantiers archivés est masquée tant qu'on ne l'ouvre pas,
  // pour ne pas noyer les chantiers en cours sous des dossiers clos.
  const renderTable = (list: ChantierListe[], title: string, emptyMessage: string, repliable = false) => {
    const tableau = (
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-white text-xs uppercase text-gray-500 border-b border-gray-100">
              <th className="px-6 py-4 font-semibold">Chantier</th>
              <th className="px-4 py-4 font-semibold hidden sm:table-cell w-44">Heures</th>
              {montantsVisibles && <th className="px-4 py-4 font-semibold hidden md:table-cell w-44">Matériel</th>}
              <th className="px-4 py-4 font-semibold text-right" title={margeVisible ? 'Marge du jour (vendu moins dépenses réelles) et marge estimée en fin de chantier' : 'Heures vendues moins heures réalisées'}>
                {margeVisible ? 'Marge' : 'Solde heures'}
              </th>
              <th className="px-6 py-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {list.length === 0 ? (
              <tr>
                <td colSpan={montantsVisibles ? 5 : 4} className="px-6 py-8 text-center text-gray-400 italic">
                  {emptyMessage}
                </td>
              </tr>
            ) : list.map(c => {
              // Métriques calculées côté serveur (marge masquée pour les non-admins)
              const metrics = c.metrics || {};
              const heuresRealisees = metrics.heuresRealisees || 0;
              const materielReel = metrics.materielReel || 0;
              const diffHeures = metrics.diffHeures ?? (c.heuresVendues - heuresRealisees);
              const margeCommerciale = metrics.margeCommerciale ?? null;

              return (
                <tr
                  key={c.id}
                  data-chantier={c.id}
                  onClick={() => navigate(`/chantiers/${c.id}`)}
                  className="hover:bg-gray-50 transition-colors cursor-pointer align-top"
                >
                  <td className="px-6 py-4">
                    <div className="font-bold text-gray-800">{c.nom}</div>
                    <div className="text-xs text-gray-400 mt-0.5 flex flex-wrap gap-x-3">
                      <span>{c.client}</span>
                      <span>Devis : {c.numeroDevis || 'N/A'}</span>
                      {c.responsable?.name && <span>Resp. : {c.responsable.name}</span>}
                      {metrics.joursSansSaisie != null && <span>Dernière saisie : {ancienneteSaisie(metrics.joursSansSaisie)}</span>}
                    </div>
                    <div className="mt-2 empty:hidden"><AlertesChantier chantier={c} /></div>
                  </td>
                  <td className="px-4 py-4 hidden sm:table-cell">
                    <div className="text-xs font-semibold text-gray-600 mb-1.5">
                      {fmtHeures(heuresRealisees)} <span className="text-gray-400">/ {fmtHeures(c.heuresVendues)}</span>
                    </div>
                    <ProgressMeter value={heuresRealisees} max={c.heuresVendues} color="purple" size="sm" />
                  </td>
                  {montantsVisibles && (
                  <td className="px-4 py-4 hidden md:table-cell">
                    <div className="text-xs font-semibold text-gray-600 mb-1.5">
                      {fmtEuro(materielReel)}{c.budgetMaterielVendu != null && <span className="text-gray-400"> / {fmtEuro(c.budgetMaterielVendu)}</span>}
                    </div>
                    {c.budgetMaterielVendu != null && <ProgressMeter value={materielReel} max={c.budgetMaterielVendu} color="blue" size="sm" />}
                  </td>
                  )}
                  <td className="px-4 py-4 text-right">
                    {margeVisible ? (
                      margeCommerciale != null ? (
                        <>
                          <span className={`inline-block px-3 py-1 rounded-md font-bold text-sm whitespace-nowrap ${margeCommerciale >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                            {margeCommerciale > 0 ? '+' : ''}{fmtEuro(margeCommerciale)}
                          </span>
                          {metrics.margePct != null && (
                            <div className={`text-xs font-semibold mt-1 ${margeCommerciale >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                              {metrics.margePct.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} % du vendu
                            </div>
                          )}
                          {c.statut === 'EN_COURS' && metrics.margeEstimee != null && metrics.margeEstimeePct != null && (
                            <div className="text-xs text-gray-500 mt-1 whitespace-nowrap" data-marge-estimee title="Marge estimée en fin de chantier : détail des hypothèses sur la fiche">
                              Fin estimée : <strong className={metrics.margeEstimee >= 0 ? 'text-gray-700' : 'text-red-700'}>{fmtEuro(metrics.margeEstimee)}</strong>
                              {' · '}{metrics.margeEstimeePct.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %
                            </div>
                          )}
                        </>
                      ) : (
                        // Liste mixte : la rentabilité de ce chantier n'est pas communiquée à ce
                        // compte (cf. Administration > Marges) ; le solde d'heures reste utile.
                        <span className="inline-flex flex-col items-end gap-1" title="Rentabilité non communiquée pour ce chantier">
                          <span className="text-gray-400 text-sm" aria-hidden="true">—</span>
                          <span className="sr-only">Rentabilité non communiquée ;</span>
                          <span className={`inline-block px-3 py-1 rounded-md font-bold text-xs whitespace-nowrap ${diffHeures >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                            Solde : {diffHeures > 0 ? '+' : ''}{fmtHeures(diffHeures)}
                          </span>
                        </span>
                      )
                    ) : (
                      <span className={`inline-block px-3 py-1 rounded-md font-bold text-sm whitespace-nowrap ${diffHeures >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                        {diffHeures > 0 ? '+' : ''}{fmtHeures(diffHeures)}
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end items-center gap-2">
                      {/* Clôture décidée par le serveur (peutCloturer, même règle que PATCH
                          /chantiers/:id/statut) : l'administration et les directeurs, le
                          responsable du chantier s'il n'est ni technicien ni commercial, et les
                          comptes Responsable de la branche d'un technicien. */}
                      {c.statut === 'EN_COURS' && c.peutCloturer && (
                        <button
                          onClick={() => handleCloturer(c.id, c.nom)}
                          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg transition-colors"
                          title="Clôturer le chantier"
                        >
                          <Archive size={14} /> Clôturer
                        </button>
                      )}
                      {c.statut === 'TERMINE' && isAdmin && (
                        <button
                          onClick={() => handleReouvrir(c.id, c.nom)}
                          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 bg-blue-50 text-accent hover:bg-blue-100 rounded-lg transition-colors"
                          title="Réouvrir le chantier"
                        >
                          <RotateCcw size={14} /> Réouvrir
                        </button>
                      )}
                      {/* Un chantier ne se supprime plus : il n'existe que par la
                          conversion d'un devis accepté, et c'est l'annulation de ce devis
                          — motif obligatoire, refusée dès la première heure ou le premier
                          achat — qui l'archive. L'action est donc sur l'écran Devis. */}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );

    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-8">
        {repliable ? (
          <SectionRepliable
            headerClassName="bg-gray-50 px-6 py-4"
            titre={<h2 className="text-lg font-bold text-primary-dark m-0">{title}</h2>}
            resume={
              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider shrink-0">
                {list.length} chantier{list.length > 1 ? 's' : ''}
              </span>
            }
          >
            {tableau}
          </SectionRepliable>
        ) : (
          <>
            <div className="bg-gray-50 border-b border-gray-100 px-6 py-4 flex items-center justify-between gap-3">
              <h2 className="text-lg font-bold text-primary-dark m-0">{title}</h2>
              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider shrink-0">
                {list.length} chantier{list.length > 1 ? 's' : ''}
              </span>
            </div>
            {tableau}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full overflow-x-hidden">

      {/* Header global */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-primary-dark m-0 leading-tight">Liste des Chantiers</h1>
          <p className="text-sm text-muted mt-1">Avancement, dépenses et rentabilité de vos chantiers</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {!estExcluDesOperations(userRole) && (
            <button onClick={() => navigate('/devis')} className="btn btn-primary flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4"></path></svg>
              Créer une affaire (devis)
            </button>
          )}
          {/* Rôle actuel (Affichage uniquement) */}
          <div className="flex gap-1 items-center bg-gray-100 px-3 py-1.5 rounded-lg">
            <span className="text-sm font-semibold text-gray-500">
              Connecté en tant que: <strong className="text-primary-dark">{roleLabel(userRole)}</strong>
            </span>
          </div>
        </div>
      </div>

      {/* Vue d'ensemble des chantiers en cours, indépendante de la recherche. */}
      <div className={`grid grid-cols-2 ${margeVisible ? 'md:grid-cols-4' : 'md:grid-cols-3'} gap-4 mb-6`}>
        <Compteur valeur={tousEnCours.length} libelle="En cours" icone={<Building2 size={18} />}
          actif={filtre === 'TOUS'} onClick={() => majParametre('filtre', 'TOUS', 'TOUS')} />
        <Compteur valeur={nbASurveiller} libelle="À surveiller" icone={<AlertTriangle size={18} />} alerte={nbASurveiller > 0}
          actif={filtre === 'A_SURVEILLER'} onClick={() => majParametre('filtre', 'A_SURVEILLER', 'TOUS')} />
        {margeVisible && (
          <Compteur valeur={nbEnPerte} libelle="En perte" icone={<TrendingDown size={18} />} alerte={nbEnPerte > 0}
            actif={filtre === 'EN_PERTE'} onClick={() => majParametre('filtre', 'EN_PERTE', 'TOUS')} />
        )}
        <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
          <div className="p-2 rounded-lg bg-emerald-50 text-emerald-600"><CheckCircle2 size={18} /></div>
          <div>
            <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Dans le budget</div>
            <div className="text-2xl font-black text-emerald-600 mt-0.5">{tousEnCours.length - nbASurveiller}</div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 mb-6 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <div className="flex flex-col sm:flex-row gap-3">
          <label className="relative flex-1">
            <span className="sr-only">Rechercher un chantier</span>
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              type="search"
              value={recherche}
              onChange={(e) => majParametre('q', e.target.value, '')}
              placeholder="Rechercher un chantier, un client, un n° de devis, un responsable…"
              className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm"
            />
          </label>
          <label className="flex min-w-0 max-w-full items-center gap-2 text-sm font-semibold text-gray-500">
            Trier
            <select
              value={tri}
              onChange={(e) => majParametre('tri', e.target.value, 'PRIORITE')}
              className="min-w-0 max-w-full border border-gray-200 rounded-lg px-2 py-2 text-sm font-normal"
            >
              {trisProposes.map((t) => <option key={t.valeur} value={t.valeur}>{t.libelle}</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrer les chantiers">
          {filtresProposes.map((f) => (
            <button
              key={f.valeur}
              type="button"
              aria-pressed={filtre === f.valeur}
              onClick={() => majParametre('filtre', f.valeur, 'TOUS')}
              className={`text-sm font-semibold px-3 py-1.5 rounded-full border transition-colors ${filtre === f.valeur ? 'bg-primary/10 border-primary text-primary-dark' : 'bg-gray-50 border-transparent text-gray-600 hover:bg-gray-100'}`}
            >
              {f.libelle}
            </button>
          ))}
          {filtresActifs && (
            <button type="button" onClick={reinitialiser} className="flex items-center gap-1 text-xs font-semibold text-accent hover:underline ml-auto">
              <X size={14} /> Réinitialiser
            </button>
          )}
        </div>
      </div>

      <div className="flex-1">
        {renderTable(chantiersEnCours, "Chantiers En Cours", filtresActifs ? "Aucun chantier en cours ne correspond à la recherche." : "Aucun chantier en cours.")}
        {renderTable(chantiersTermines, "Chantiers Terminés / Archivés", filtresActifs ? "Aucun chantier archivé ne correspond à la recherche." : "Aucun chantier archivé.", true)}
      </div>

    </div>
  );
};

export default ListeChantiers;
