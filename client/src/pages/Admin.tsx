import { useState, useEffect, useRef, useMemo, useCallback, type RefObject } from 'react';
import { apiFetch } from '../api';
import { Link } from 'react-router-dom';
import { getCurrentUser, isAdminRole, isSuperAdminRole, roleLabel, useCurrentRole, ROLE_SUPERADMIN, ROLE_TECHNICIEN } from '../roles';
import { refreshModules } from '../modules';
import { useSociete } from '../companyTimezoneContext';
import OuvrirChantierAffaire from '../components/OuvrirChantierAffaire';
import JournalAdministration from '../components/JournalAdministration';
import { DROITS_DEVIS, droitsApresBasculeDevis, etatDroitDevis } from '../lib/droitDevis';

const fmtEuro = (n: number) => `${Math.round(n).toLocaleString()} €`;

// Éditeur d'un barème progressif. Une tranche = un plafond et un taux ; la DERNIÈRE peut
// avoir un plafond vide, ce qui signifie « au-delà, sans borne » (JSON ne représente pas
// Infinity, le serveur stocke null). Les plafonds doivent rester croissants — le serveur
// le revérifie et refuse l'enregistrement sinon.
type Tranche = { plafond: number | string | null; taux: number | string };

const EditeurBareme = ({ titre, tranches, modifiable, accent, onChange }: {
  titre: string;
  tranches?: Tranche[];
  modifiable: boolean;
  accent?: boolean;
  onChange: (t: Tranche[]) => void;
}) => {
  const lignes = tranches ?? [];
  const maj = (i: number, champ: 'plafond' | 'taux', valeur: string) => {
    const copie = lignes.map((t, j) => (j === i ? { ...t, [champ]: valeur } : t));
    onChange(copie);
  };
  let plancher = 0;
  return (
    <div className={`p-4 rounded border ${accent ? 'bg-amber-50 border-amber-200' : 'bg-gray-50'}`}>
      <div className={`text-xs font-bold uppercase tracking-wide mb-3 ${accent ? 'text-amber-700' : 'text-gray-500'}`}>{titre}</div>
      {lignes.length === 0 && <p className="text-sm text-gray-400 italic mb-3">Aucune tranche : aucune commission ne sera calculée.</p>}
      <div className="space-y-2">
        {lignes.map((t, i) => {
          const plafondCourant = t.plafond === null || t.plafond === '' ? null : Number(t.plafond);
          const depuis = plancher;
          plancher = plafondCourant ?? plancher;
          return (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs text-gray-500 w-20 shrink-0">dès {fmtEuro(depuis)}</span>
              <input
                type="number" min="0" step="any" className="form-input flex-1" style={{ margin: 0 }}
                placeholder="sans plafond"
                value={t.plafond ?? ''}
                disabled={!modifiable}
                onChange={(e) => maj(i, 'plafond', e.target.value)}
              />
              <input
                type="number" min="0" max="100" step="any" className="form-input w-24" style={{ margin: 0 }}
                value={t.taux}
                disabled={!modifiable}
                onChange={(e) => maj(i, 'taux', e.target.value)}
              />
              <span className="text-sm text-gray-500">%</span>
              {modifiable && (
                <button type="button" title="Retirer cette tranche" className="text-red-600 px-2"
                  onClick={() => onChange(lignes.filter((_, j) => j !== i))}>×</button>
              )}
            </div>
          );
        })}
      </div>
      {modifiable && (
        <button type="button" className="btn btn-secondary mt-3 text-sm"
          onClick={() => onChange([...lignes, { plafond: '', taux: 0 }])}>
          Ajouter une tranche
        </button>
      )}
    </div>
  );
};


// Contenu de référence "Système de rémunération commerciale" (document fourni par la
// direction, cf. MARGES_COMMERCIAL.pdf) : primes "Boost" par solution vendue et
// commissions sur contrats récurrents. Contrairement au barème et aux objectifs
// mensuels ci-dessus, ces primes ne sont PAS calculées par l'application (pas de
// saisie du nombre de caméras/points d'alarme/portes par chantier) — affichage en
// lecture seule à titre de référence pour un calcul manuel.
const PRIMES_VIDEOSURVEILLANCE = [
  { label: 'Entre 4 et 8 caméras', prime: 200 },
  { label: 'Entre 8 et 16 caméras', prime: 400 },
  { label: 'Entre 16 et 32 caméras', prime: 600 },
  { label: 'Plus de 32 caméras', prime: 1000 },
];
const PRIMES_ALARME = [
  { label: 'Entre 0 et 10 points d’alarme', prime: 100 },
  { label: 'Entre 10 et 20 points d’alarme', prime: 200 },
  { label: 'Entre 20 et 30 points d’alarme', prime: 300 },
  { label: 'Plus de 30 points d’alarme', prime: 400 },
];
const PRIMES_CONTROLE_ACCES = [
  { label: 'Par tranche de 2 portes installées', prime: 80 },
];
const COMMISSIONS_CONTRATS_RECURRENTS = [
  { label: 'Maintenance (engagement 36 mois)', detail: '1ère année seulement' },
  { label: 'Puce GSM', detail: '1ère année seulement' },
  { label: 'Routeur', detail: '1ère année seulement' },
  { label: 'Fibre optique (FTTH / FTTO)', detail: '16 % de la marge générée sur la 1ère année' },
];

const PrimeTable = ({ title, rows }: { title: string; rows: { label: string; prime: number }[] }) => (
  <div className="p-4 rounded border bg-gray-50">
    <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">{title}</div>
    <ul className="text-sm space-y-1">
      {rows.map((r, i) => (
        <li key={i} className="flex justify-between gap-4">
          <span className="text-gray-500">{r.label}</span>
          <strong className="text-gray-800">{fmtEuro(r.prime)}</strong>
        </li>
      ))}
    </ul>
  </div>
);

// Onglets ouverts aux CONDUCTEURS DE TRAVAUX : uniquement les référentiels du Journal des
// Achats, qu'ils alimentent au quotidien. Tout le reste de l'Administration (chantiers,
// intervenants et leurs taux, marges, comptes) reste réservé aux administrateurs.
const ONGLETS_CONDUCTEUR = ['fournisseurs', 'categories'];

const MESSAGE_COMPTE_SUPERADMIN = "Seul un super administrateur peut gérer un compte super administrateur.";

type CompteResume = { id: string; name: string };

// Liste « Responsable hiérarchique » d'un compte. Elle ne construit ses options qu'une fois
// ouverte (clic, clavier, toucher) : proposer tous les comptes sur chaque ligne faisait croître
// la page comme le carré du nombre de comptes. L'état d'ouverture est local, pour qu'ouvrir ou
// refermer une liste ne fasse pas refaire le rendu de tout le tableau.
//
// Une liste peut s'ouvrir sans recevoir le focus (toucher en faisant défiler le tableau, aide
// technique) : elle ne recevrait alors jamais de blur. La dernière liste ouverte sans focus est
// donc refermée dès qu'une autre s'ouvre ou qu'un défilement ou une annulation tactile commencent
// sur elle. Une liste qui a le focus n'est jamais refermée par une autre : au plus deux listes sont
// construites à la fois.
function ChoixResponsable({ compte, responsableActuel, responsableDesactive, desactive, titre, proposables, onChoix, derniereOuverte }: {
  compte: CompteResume;
  responsableActuel: CompteResume | null;
  responsableDesactive: boolean;
  desactive: boolean;
  titre: string;
  proposables: (compteId: string) => CompteResume[];
  onChoix: (compteId: string, responsableId: string) => void;
  derniereOuverte: RefObject<(() => void) | null>;
}) {
  const [ouverte, setOuverte] = useState(false);
  const liste = useRef<HTMLSelectElement>(null);
  const fermerSansFocus = useCallback(() => {
    if (document.activeElement !== liste.current) setOuverte(false);
  }, []);
  const ouvrir = () => {
    if (derniereOuverte.current && derniereOuverte.current !== fermerSansFocus) derniereOuverte.current();
    derniereOuverte.current = fermerSansFocus;
    setOuverte(true);
  };
  const proposes = ouverte ? proposables(compte.id) : [];
  return (
    <select
      ref={liste}
      className="form-input py-1 px-3 text-sm rounded min-w-[11rem]"
      value={responsableActuel?.id ?? ''}
      onChange={(e) => onChoix(compte.id, e.target.value)}
      onFocus={ouvrir}
      onMouseDown={ouvrir}
      onTouchStart={ouvrir}
      onKeyDown={ouvrir}
      onTouchMove={fermerSansFocus}
      onTouchCancel={fermerSansFocus}
      onBlur={() => setOuverte(false)}
      disabled={desactive}
      aria-label={`Responsable hiérarchique de ${compte.name}`}
      title={titre}
    >
      <option value="">Aucun</option>
      {responsableActuel && !proposes.some((r) => r.id === responsableActuel.id) && (
        <option value={responsableActuel.id}>
          {responsableActuel.name}{responsableDesactive ? ' (compte désactivé)' : ''}
        </option>
      )}
      {proposes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
    </select>
  );
}

const DROIT_TRAVAUX_CORRECTION = 'chantiers:write';
const DROIT_TRAVAUX_ARCHIVAGE = 'chantiers:archive';
// Droits individuels qu'un technicien ne reçoit pas (miroir du serveur ; l'accès financier, lui,
// est porté par accesFinance).
const DROITS_INTERDITS_TECHNICIEN = ['devis:read', 'devis:write', DROIT_TRAVAUX_CORRECTION, DROIT_TRAVAUX_ARCHIVAGE];

const Admin = () => {
  // Le fuseau enregistré ici sert aux dates de toute l'application : il est relu aussitôt.
  const { rafraichir: rafraichirSociete } = useSociete();
  // Rôle réel du compte connecté (la page est fermée aux commerciaux, cf. App.tsx),
  // resynchronisé avec le serveur : l'onglet « Modules » d'un compte promu super
  // administrateur apparaît sans attendre une reconnexion.
  const user = getCurrentUser();
  const userRole = useCurrentRole();
  const isAdmin = isAdminRole(userRole);
  const isSuper = isSuperAdminRole(userRole);

  const [activeTab, setActiveTab] = useState(isAdmin ? 'chantiers' : 'fournisseurs');
  const [users, setUsers] = useState<any[]>([]);
  const [intervenants, setIntervenants] = useState<any[]>([]);
  const [fournisseurs, setFournisseurs] = useState<any[]>([]);
  const [chantiers, setChantiers] = useState<any[]>([]);
  const [parametres, setParametres] = useState<any>(null);
  const [categories, setCategories] = useState<any[]>([]);
  const [remuneration, setRemuneration] = useState<any>(null);
  const [erreurRemuneration, setErreurRemuneration] = useState('');
  // Onglet dont la liste n'a pas pu être chargée : le message ne s'affiche que sur cet onglet.
  const [erreurListe, setErreurListe] = useState<string | null>(null);
  // Numéro du dernier chargement de liste : la réponse d'un chargement plus ancien est ignorée.
  const dernierChargementListe = useRef(0);
  const [messageRemuneration, setMessageRemuneration] = useState('');
  // Ligne en cours d'édition : { type: 'intervenant'|'fournisseur'|'categorie', id, ...champs }
  const [editRow, setEditRow] = useState<any>(null);
  // Rôle sélectionné dans le formulaire "Autoriser un compte" — contrôlé uniquement pour
  // afficher la case "estCommercial" quand le rôle choisi est Administrateur.
  const [newUserRole, setNewUserRole] = useState('CONDUCTEUR_TRAVAUX');
  // Modules activables (onglet « Modules », superadmin) : état global du Planning.
  const [planningActif, setPlanningActif] = useState<boolean | null>(null);
  const [modulesMessage, setModulesMessage] = useState('');
  const [societe, setSociete] = useState<{ fuseauHoraire?: string | null } | null>(null);
  const [messageSociete, setMessageSociete] = useState<{ texte: string; ok: boolean } | null>(null);

  // Onglet affiché, lu par fetchData : un rechargement demandé par un gestionnaire créé sur un
  // onglet quitté depuis (fin d'une création, par exemple) recharge l'onglet affiché.
  const ongletActif = useRef(activeTab);
  useEffect(() => {
    ongletActif.current = activeTab;
    fetchData();
  }, [activeTab]);

  // Filet de sécurité : un conducteur de travaux ne peut jamais rester sur un onglet
  // réservé aux administrateurs (rôle changé en cours de session, onglet mémorisé...).
  useEffect(() => {
    if (!isAdmin && !ONGLETS_CONDUCTEUR.includes(activeTab)) setActiveTab(ONGLETS_CONDUCTEUR[0]);
  }, [activeTab, isAdmin]);

  const fetchData = async () => {
    // Onglets qui affichent une liste ; les autres (marges, utilisateurs, modules)
    // chargent leurs propres données plus bas.
    const endpoints: Record<string, string> = {
      intervenants: '/intervenants',
      fournisseurs: '/fournisseurs',
      categories: '/categories',
      chantiers: '/chantiers',
    };

    try {
      const onglet = ongletActif.current;
      const chargement = ++dernierChargementListe.current;
      setErreurListe(null);
      if (endpoints[onglet]) {
        // Une liste qui ne se charge pas (erreur serveur ou réseau, réponse illisible) ne
        // remplace pas la précédente : l'écran reste utilisable et le signale sur son onglet,
        // au lieu de planter sur la réponse d'erreur.
        let data: unknown = null;
        try {
          const res = await apiFetch(endpoints[onglet]);
          if (res.ok) data = await res.json();
        } catch (e) {
          console.error(e);
        }
        if (chargement === dernierChargementListe.current) {
          if (!Array.isArray(data)) setErreurListe(onglet);
          else if (onglet === 'intervenants') setIntervenants(data);
          else if (onglet === 'fournisseurs') setFournisseurs(data);
          else if (onglet === 'categories') setCategories(data);
          else setChantiers(data);
        }
      }

      // La liste des comptes est réservée aux administrateurs (403 pour un conducteur) :
      // on ne la demande donc que si le compte connecté y a droit.
      if (isAdmin) {
        const usersRes = await apiFetch('/users');
        if (usersRes.ok) setUsers(await usersRes.json());
      }

      if (onglet === 'modules' && isSuper) {
        const mRes = await apiFetch('/modules');
        if (mRes.ok) {
          const m = await mRes.json();
          setPlanningActif(m.planningActifGlobal !== false);
        }
      }

      if (onglet === 'marges') {
        const pRes = await apiFetch('/parametres');
        if (pRes.ok) setParametres(await pRes.json());

        // Règles de rémunération : leur propre route, en lecture pour un admin et en
        // écriture pour un superadmin (l'ancien écran les lisait dans /stats/commerciaux,
        // qui ne fait que les refléter).
        const rRes = await apiFetch('/parametres/remuneration');
        if (rRes.ok) setRemuneration(await rRes.json());
      }

      if (onglet === 'societe' && isSuper) {
        const sRes = await apiFetch('/company');
        if (sRes.ok) setSociete(await sRes.json());
      }
    } catch (e) {
      console.error(e);
    }
  };

  const enregistrerSociete = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessageSociete(null);
    const form = new FormData(e.currentTarget);
    const res = await apiFetch('/company', { method: 'PUT', body: JSON.stringify({ fuseauHoraire: form.get('fuseauHoraire') }) });
    const data = await res.json();
    if (!res.ok) return setMessageSociete({ texte: data.error || 'Enregistrement impossible.', ok: false });
    setSociete(data);
    rafraichirSociete();
    setMessageSociete({ texte: 'Fuseau horaire de la société enregistré.', ok: true });
  };

  // Enregistre les règles de rémunération. Les champs numériques transitent en texte
  // (saisie libre) ; le serveur les valide et renvoie les règles telles qu'il les a
  // retenues, qui remplacent l'état local — ce qui évite d'afficher une valeur que la
  // base n'a pas acceptée.
  const enregistrerRemuneration = async (e: React.FormEvent) => {
    e.preventDefault();
    setErreurRemuneration('');
    setMessageRemuneration('');
    try {
      const res = await apiFetch('/parametres/remuneration', {
        method: 'PUT',
        body: JSON.stringify({
          ...remuneration,
          baremeStandard: (remuneration.baremeStandard ?? []).map((t: any) => ({
            plafond: t.plafond === '' || t.plafond === null ? null : Number(t.plafond),
            taux: Number(t.taux),
          })),
          baremeReduit: (remuneration.baremeReduit ?? []).map((t: any) => ({
            plafond: t.plafond === '' || t.plafond === null ? null : Number(t.plafond),
            taux: Number(t.taux),
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErreurRemuneration(data.error || 'Enregistrement impossible.');
        return;
      }
      setRemuneration(data);
      setMessageRemuneration('Règles de rémunération enregistrées.');
    } catch {
      setErreurRemuneration('Impossible de joindre le serveur.');
    }
  };

  const handleParamsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);

  const payload = {
      margeCommercialeActive: formData.get('margeCommercialeActive') === 'on',
      tauxAcompteDefaut: formData.get('tauxAcompteDefaut'),
      // Champ vidé = délai sans saisie désactivé, ou seuil de marge faible retiré (une marge
      // estimée négative reste signalée) ; le serveur valide les bornes.
      seuilMargeFaible: String(formData.get('seuilMargeFaible') ?? '').trim(),
      joursSansSaisie: String(formData.get('joursSansSaisie') ?? '').trim(),
      rentabiliteConducteur: formData.get('rentabiliteConducteur') === 'on',
      rentabiliteHierarchie: formData.get('rentabiliteHierarchie') === 'on',
      rentabiliteDirecteurs: formData.get('rentabiliteDirecteurs') === 'on',
    };
    const res = await apiFetch('/parametres', { method: 'PUT', body: JSON.stringify(payload) });
    if (res.ok) {
      setParametres(await res.json());
      alert('Paramètres mis à jour');
    } else {
      const d = await res.json().catch(() => ({}));
      alert(d.error || 'Erreur lors de l’enregistrement des paramètres.');
    }
  };

  // Activation/désactivation du module Planning (superadmin). Désactivé, le planning
  // disparaît de tous les autres comptes — administrateurs compris — SANS qu'aucune
  // affectation ne soit supprimée : tout est restitué tel quel à la réactivation.
  const handleModulePlanning = async (actif: boolean) => {
    setModulesMessage('');
    try {
      const res = await apiFetch('/modules', { method: 'PUT', body: JSON.stringify({ planningActif: actif }) });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'Erreur lors de la mise à jour du module.');
        return;
      }
      const data = await res.json();
      setPlanningActif(data.planningActifGlobal !== false);
      setModulesMessage(actif
        ? 'Le module Planning est de nouveau visible par tous les comptes.'
        : "Le module Planning est désactivé : il n'apparaît plus que pour les super administrateurs. Aucune affectation n'a été supprimée.");
      // Le menu latéral suit immédiatement le nouveau réglage pour le compte connecté.
      await refreshModules();
    } catch (err) {
      alert('Impossible de joindre le serveur.');
    }
  };

  // Un compte SUPERADMIN n'est administrable que par un superadmin — même règle que côté
  // serveur (refuseSuperAdminTarget) : sans cela, un simple administrateur pourrait
  // s'emparer des droits de la direction en se promouvant ou en réinitialisant un accès.
  const peutGererCompte = (u: { role: string }) => isSuper || !isSuperAdminRole(u.role);
  // Comptes par identifiant et collaborateurs directs de chacun, calculés une fois par
  // chargement de la liste : la branche d'un compte se parcourt alors en un seul passage.
  const comptesParId = useMemo(() => new Map(users.map((c) => [c.id, c])), [users]);
  const collaborateursDe = useMemo(() => {
    const collaborateurs = new Map<string, string[]>();
    for (const c of users) {
      const chef = c.responsableHierarchique?.id;
      if (chef) collaborateurs.set(chef, [...(collaborateurs.get(chef) ?? []), c.id]);
    }
    return collaborateurs;
  }, [users]);
  // Branche hiérarchique d'un compte d'après la liste affichée : ses collaborateurs, puis les leurs.
  const brancheDe = (id: string) => {
    const branche = new Set<string>();
    const aVisiter = [id];
    while (aVisiter.length) {
      for (const collaborateur of collaborateursDe.get(aVisiter.pop()!) ?? []) {
        if (collaborateur !== id && !branche.has(collaborateur)) {
          branche.add(collaborateur);
          aVisiter.push(collaborateur);
        }
      }
    }
    return branche;
  };
  // Fermeture de la dernière liste de responsables ouverte (cf. ChoixResponsable).
  const derniereListeOuverte = useRef<(() => void) | null>(null);
  // Responsables proposables pour la liste que l'on ouvre (cf. ChoixResponsable) : comptes actifs
  // hors de la branche du compte, une boucle étant refusée par le serveur.
  const responsablesProposables = (compteId: string) => {
    const branche = brancheDe(compteId);
    return users.filter((r) => r.id !== compteId && r.actif !== false && !branche.has(r.id));
  };

  // Ajout d'un intervenant, d'un fournisseur ou d'une catégorie. Un refus du serveur est
  // affiché, et la saisie conservée pour être corrigée ; elle n'est vidée qu'après l'ajout.
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>, type: string) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data: Record<string, unknown> = Object.fromEntries(new FormData(form).entries());
    try {
      const res = await apiFetch(`/${type}`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'L’enregistrement a échoué.');
        return;
      }
    } catch {
      alert('Impossible de joindre le serveur.');
      return;
    }
    form.reset();
    fetchData();
  };

  const handleRoleChange = async (userId: string, newRole: string) => {
    try {
      await apiFetch(`/users/${userId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole })
      });
      fetchData(); // Rafraîchir la liste
    } catch (e) {
      alert("Erreur lors de la mise à jour du rôle");
    }
  };

  // Rattachement hiérarchique : le serveur refuse soi-même, un compte désactivé et une boucle,
  // et renvoie la raison, affichée telle quelle.
  const handleResponsableHierarchique = async (userId: string, responsableId: string) => {
    try {
      const res = await apiFetch(`/users/${userId}/responsable-hierarchique`, {
        method: 'PATCH',
        body: JSON.stringify({ responsableHierarchiqueId: responsableId || null }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'Erreur lors du rattachement hiérarchique.');
      }
    } catch {
      alert('Erreur lors du rattachement hiérarchique.');
    }
    fetchData();
  };

  // Bascule "estCommercial" sur un compte ADMIN : il reste administrateur à part entière,
  // mais apparaît en plus comme un choix de commercial rattaché et dans "Mes commerciaux".
  const handleToggleEstCommercial = async (userId: string, current: boolean) => {
    try {
      await apiFetch(`/users/${userId}/est-commercial`, {
        method: 'PATCH',
        body: JSON.stringify({ estCommercial: !current })
      });
      fetchData();
    } catch (e) {
      alert("Erreur lors de la mise à jour.");
    }
  };

  // Bascule l'accès au Suivi financier. Réservé au superadmin côté serveur : ces données
  // (encaissements, impayés, montants clients) relèvent de la direction.
  const handleToggleAccesFinance = async (userId: string, current: boolean) => {
    try {
      const res = await apiFetch(`/users/${userId}/acces-finance`, {
        method: 'PATCH',
        body: JSON.stringify({ accesFinance: !current }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || "Erreur lors de la mise à jour de l'accès au suivi financier.");
        return;
      }
      fetchData();
    } catch (e) {
      alert('Impossible de joindre le serveur.');
    }
  };

  const handleTogglePermission = async (userId: string, permissions: string[], permission: string | string[]) => {
    const cible = Array.isArray(permission) ? permission : [permission];
    const toutesActives = cible.every((item) => permissions.includes(item));
    const suivantes = toutesActives
      ? permissions.filter((item) => !cible.includes(item))
      : [...new Set([...permissions, ...cible])];
    await enregistrerPermissions(userId, suivantes);
  };

  const enregistrerPermissions = async (userId: string, suivantes: string[]) => {
    try {
      const res = await apiFetch(`/users/${userId}/permissions`, { method: 'PUT', body: JSON.stringify({ permissions: suivantes }) });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'Impossible de modifier les permissions individuelles.');
        return;
      }
      fetchData();
    } catch { alert('Impossible de joindre le serveur.'); }
  };

  // Active ou désactive un compte. Une désactivation vaut départ de l'entreprise : la
  // connexion est refusée et le compte disparaît des listes d'attribution (conducteur
  // responsable, commercial rattaché), MAIS son historique est conservé — les chantiers
  // qu'il a suivis lui restent rattachés, contrairement à une révocation. Réversible.
  const handleToggleActif = async (userId: string, userName: string, current: boolean) => {
    if (current && !window.confirm(
      `Désactiver le compte de ${userName} ?\n\n` +
      "Il ne pourra plus se connecter et n'apparaîtra plus dans les listes d'attribution.\n" +
      "Ses chantiers et son historique sont conservés. Vous pourrez le réactiver à tout moment."
    )) return;
    try {
      const res = await apiFetch(`/users/${userId}/actif`, {
        method: 'PATCH',
        body: JSON.stringify({ actif: !current }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || "Erreur lors de la mise à jour de l'activation du compte.");
        return;
      }
      fetchData();
    } catch (e) {
      alert('Impossible de joindre le serveur.');
    }
  };


  // Autorise un nouveau compte (liste blanche SSO). Le compte pourra se connecter
  // via le SSO Microsoft avec le rôle choisi ; sans mot de passe par défaut.
  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const formData = new FormData(form);
    const payload = {
      email: (formData.get('email') as string || '').trim(),
      name: (formData.get('name') as string || '').trim(),
      role: (formData.get('role') as string) || 'CONDUCTEUR_TRAVAUX',
      estCommercial: formData.get('estCommercial') === 'on',
      accesFinance: formData.get('accesFinance') === 'on',
    };
    try {
      const res = await apiFetch('/users', { method: 'POST', body: JSON.stringify(payload) });
      if (res.ok) {
        setNewUserRole('CONDUCTEUR_TRAVAUX');
        form.reset();
        fetchData();
      } else {
        const data = await res.json();
        alert(data.error || "Erreur lors de l'ajout du compte.");
      }
    } catch (err) {
      alert('Impossible de joindre le serveur.');
    }
  };

  // Révoque l'autorisation d'un compte (suppression).
  const handleDeleteUser = async (userId: string, userName: string) => {
    if (!window.confirm(`Révoquer l'accès de ${userName} ? Ce compte ne pourra plus se connecter.`)) return;
    try {
      const res = await apiFetch(`/users/${userId}`, { method: 'DELETE' });
      if (res.ok) {
        fetchData();
      } else {
        const data = await res.json();
        alert(data.error || 'Erreur lors de la révocation.');
      }
    } catch (err) {
      alert('Impossible de joindre le serveur.');
    }
  };

  // --- Édition / suppression génériques (intervenants, fournisseurs, catégories) ---
  const endpointFor: Record<string, string> = {
    intervenant: 'intervenants', fournisseur: 'fournisseurs', categorie: 'categories',
  };
  const editField = (field: string, value: string) => setEditRow((r: any) => ({ ...r, [field]: value }));

  const saveEdit = async () => {
    const { type, id, ...rest } = editRow || {};
    let payload: Record<string, unknown>;
    if (type === 'intervenant') payload = { nom: rest.nom, role: rest.role, tauxHoraireCharge: parseFloat(rest.tauxHoraireCharge) || 0 };
    else if (type === 'fournisseur') payload = { nom: rest.nom, contact: rest.contact || null };
    else payload = { nom: rest.nom, description: rest.description || null };
    try {
      const res = await apiFetch(`/${endpointFor[type]}/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      if (res.ok) { setEditRow(null); fetchData(); }
      else { const d = await res.json(); alert(d.error || 'Erreur lors de la modification.'); }
    } catch (err) {
      alert('Impossible de joindre le serveur.');
    }
  };

  const deleteEntity = async (type: string, id: string, label: string) => {
    if (!window.confirm(`Supprimer « ${label} » ? Cette action est définitive.`)) return;
    try {
      const res = await apiFetch(`/${endpointFor[type]}/${id}`, { method: 'DELETE' });
      if (res.ok) fetchData();
      else { const d = await res.json(); alert(d.error || 'Suppression impossible.'); }
    } catch (err) {
      alert('Impossible de joindre le serveur.');
    }
  };

  return (
    <div>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-4 gap-4">
        <h1 className="text-primary font-bold">Administration & Paramétrage</h1>
        <div className="flex gap-2 items-center bg-gray-100 p-2 rounded">
          <span className="text-sm font-semibold text-gray-500">
            Connecté en tant que: <strong className="text-primary-dark">{roleLabel(userRole)}</strong>
          </span>
        </div>
      </div>

      {/* Un conducteur de travaux n'accède qu'aux référentiels Fournisseurs et Catégories
          (cf. ONGLETS_CONDUCTEUR) ; les onglets réservés ne lui sont même pas proposés. */}
      <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
        {isAdmin && (
          <>
            <button className={`btn ${activeTab === 'chantiers' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('chantiers')}>Chantiers</button>
            <button className={`btn ${activeTab === 'intervenants' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('intervenants')}>Intervenants</button>
          </>
        )}
        <button className={`btn ${activeTab === 'fournisseurs' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('fournisseurs')}>Fournisseurs</button>
        <button className={`btn ${activeTab === 'categories' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('categories')}>Catégories</button>
        {isAdmin && (
          <>
            <button className={`btn ${activeTab === 'marges' ? 'btn-primary' : 'bg-white'}`} onClick={() => (activeTab === 'marges' ? fetchData() : setActiveTab('marges'))}>Marges & Commissions</button>
            <button className={`btn ${activeTab === 'utilisateurs' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('utilisateurs')}>Utilisateurs</button>
            <button className={`btn ${activeTab === 'journal' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('journal')}>Journal</button>
          </>
        )}
        {isSuper && (
          <>
            <button className={`btn ${activeTab === 'societe' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('societe')}>Société</button>
            <button className={`btn ${activeTab === 'modules' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('modules')}>Modules</button>
          </>
        )}
      </div>

      {activeTab === 'journal' && isAdmin && <JournalAdministration isSuper={isSuper} />}

      {erreurListe === activeTab && (
        <div role="alert" className="mb-4 p-4 bg-red-50 text-red-800 rounded text-sm">Cette liste n’a pas pu être chargée. Rechargez la page pour réessayer.</div>
      )}

      {!isAdmin && (
        <div className="mb-4 p-4 bg-blue-50 text-blue-800 rounded text-sm">
          Vous pouvez créer, modifier et supprimer les <strong>fournisseurs</strong> et les{' '}
          <strong>catégories d'achats</strong> utilisés dans le Journal des Achats. Les autres réglages de
          l'application sont réservés à la Direction.
        </div>
      )}

      {activeTab === 'chantiers' && isAdmin && (
        <div className="card">
          <OuvrirChantierAffaire onOuvert={fetchData} />

          <h3 className="mt-10 mb-4 text-primary-dark">Base de données des Chantiers</h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {chantiers.map(c => (
              <div key={c.id} className="p-4 bg-white border rounded shadow-sm hover:shadow-md transition-shadow">
                <div className="flex flex-wrap justify-between items-start gap-2 mb-2">
                  <div className="min-w-0">
                    <h4 className="font-bold text-lg text-primary break-words">
                      <Link to={`/chantiers/${c.id}`} className="hover:underline">{c.nom}</Link>
                    </h4>
                    <span className="text-sm text-muted break-words">Client : {c.client} | Devis : {c.numeroDevis || 'Non spécifié'}</span>
                    {/* Titulaire et commercial se modifient depuis la fiche (bouton « Modifier »),
                        par exemple au départ d'un conducteur en cours de chantier. */}
                    <div className="text-sm text-muted mt-0.5">Responsable : {c.responsable
                      ? <strong className="text-gray-700">{c.responsable.name}</strong>
                      : <strong className="text-amber-700">Non affecté — à attribuer depuis la fiche</strong>}</div>
                    {c.types && c.types.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {c.types.map((t: string) => (
                          <span key={t} className="text-[11px] font-semibold px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded-full">{t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <span className="badge" style={{ backgroundColor: 'var(--color-primary-dark)', color: 'white', padding: '4px 12px', borderRadius: '12px', fontSize: '0.8rem' }}>
                    {c.statut}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-4 pt-4 border-t">
                  <div>
                    <div className="text-xs text-muted uppercase">Global Vendu</div>
                    <div className="font-bold">{c.budgetGlobalVendu.toLocaleString()} €</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted uppercase">Heures Vendues</div>
                    <div className="font-bold">{c.heuresVendues} h</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted uppercase">Matériel</div>
                    <div className="font-bold text-accent">{c.budgetMaterielVendu.toLocaleString()} €</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted uppercase">Main d'Œuvre</div>
                    <div className="font-bold" style={{color: '#8b5cf6'}}>{c.budgetMainOeuvreVendu.toLocaleString()} €</div>
                  </div>
                </div>
              </div>
            ))}
            {chantiers.length === 0 && <p className="text-muted col-span-2 text-center py-8">Aucun chantier créé pour le moment.</p>}
          </div>
        </div>
      )}

      {activeTab === 'intervenants' && isAdmin && (
        <div className="card">
          {isAdmin ? (
            <>
              <h2 className="mb-4">Ajouter un intervenant</h2>
              <form onSubmit={(e) => handleSubmit(e, 'intervenants')} className="flex flex-col sm:flex-row gap-4 items-end mb-8">
                <div className="form-group mb-0 flex-1 w-full">
                  <label className="form-label">Nom complet</label>
                  <input required name="nom" className="form-input" />
                </div>
                <div className="form-group mb-0 flex-1 w-full">
                  <label className="form-label">Rôle / Fonction</label>
                  <input required name="role" className="form-input" />
                </div>
                <div className="form-group mb-0 flex-1 w-full">
                  <label className="form-label">Taux Horaire Chargé (€/h)</label>
                  <input required type="number" step="0.1" name="tauxHoraireCharge" className="form-input" />
                </div>
                <button className="btn btn-primary w-full sm:w-auto">Enregistrer</button>
              </form>
            </>
          ) : (
            <div className="mb-8 p-4 bg-yellow-50 text-yellow-800 rounded">
              <p>La création et la modification des intervenants et de leurs taux horaires sont réservées à la Direction.</p>
            </div>
          )}

          <h3 className="mb-4">Liste des Intervenants</h3>
          <div className="overflow-x-auto">
            <table style={{width: '100%', minWidth: '600px', textAlign: 'left', borderCollapse: 'collapse'}}>
              <thead>
                <tr style={{borderBottom: '1px solid var(--color-border)'}}>
                  <th style={{padding: '8px'}}>Nom</th>
                  <th style={{padding: '8px'}}>Rôle / Fonction</th>
                  {isAdmin && <th style={{padding: '8px'}}>Coût Horaire (€/h)</th>}
                  {isAdmin && <th style={{padding: '8px', textAlign: 'right'}}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {intervenants.map(i => {
                  const isEditing = editRow?.type === 'intervenant' && editRow.id === i.id;
                  return (
                    <tr key={i.id} style={{borderBottom: '1px solid #eee'}}>
                      <td style={{padding: '8px'}}>
                        {isEditing
                          ? <input className="form-input" value={editRow.nom} onChange={e => editField('nom', e.target.value)} />
                          : <strong>{i.nom}</strong>}
                      </td>
                      <td style={{padding: '8px'}} className="text-muted">
                        {isEditing
                          ? <input className="form-input" value={editRow.role} onChange={e => editField('role', e.target.value)} />
                          : i.role}
                      </td>
                      {isAdmin && (
                        <td style={{padding: '8px'}}>
                          {isEditing
                            ? <input type="number" step="0.1" className="form-input" value={editRow.tauxHoraireCharge} onChange={e => editField('tauxHoraireCharge', e.target.value)} />
                            : `${i.tauxHoraireCharge} €`}
                        </td>
                      )}
                      {isAdmin && (
                        <td style={{padding: '8px', textAlign: 'right', whiteSpace: 'nowrap'}}>
                          {isEditing ? (
                            <>
                              <button type="button" onClick={saveEdit} className="text-sm px-3 py-1 bg-primary text-white font-semibold rounded">Enregistrer</button>
                              <button type="button" onClick={() => setEditRow(null)} className="ml-2 text-sm px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded">Annuler</button>
                            </>
                          ) : (
                            <>
                              <button type="button" onClick={() => setEditRow({ type: 'intervenant', id: i.id, nom: i.nom, role: i.role, tauxHoraireCharge: i.tauxHoraireCharge })} className="text-sm px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded">Modifier</button>
                              <button type="button" onClick={() => deleteEntity('intervenant', i.id, i.nom)} className="ml-2 text-sm px-3 py-1 bg-red-100 hover:bg-red-200 text-red-700 font-semibold rounded">Supprimer</button>
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {intervenants.length === 0 && (
                  <tr><td colSpan={4} className="text-muted" style={{padding: '12px', textAlign: 'center'}}>Aucun intervenant.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'fournisseurs' && (
        <div className="card">
          <h2 className="mb-4">Ajouter un fournisseur</h2>
          <form onSubmit={(e) => handleSubmit(e, 'fournisseurs')} className="flex gap-4 items-end mb-8">
            <div className="form-group mb-0 flex-1">
              <label className="form-label">Nom du fournisseur</label>
              <input required name="nom" className="form-input" />
            </div>
            <div className="form-group mb-0 flex-1">
              <label className="form-label">Contact / Email (Optionnel)</label>
              <input name="contact" className="form-input" />
            </div>
            <button className="btn btn-primary">Enregistrer</button>
          </form>

          <h3 className="mb-4">Base Fournisseurs</h3>
          <div className="overflow-x-auto">
            <table style={{width: '100%', minWidth: '500px', textAlign: 'left', borderCollapse: 'collapse'}}>
              <thead>
                <tr style={{borderBottom: '1px solid var(--color-border)'}}>
                  <th style={{padding: '8px'}}>Nom</th>
                  <th style={{padding: '8px'}}>Contact</th>
                  <th style={{padding: '8px', textAlign: 'right'}}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {fournisseurs.map(f => {
                  const isEditing = editRow?.type === 'fournisseur' && editRow.id === f.id;
                  return (
                    <tr key={f.id} style={{borderBottom: '1px solid #eee'}}>
                      <td style={{padding: '8px'}}>
                        {isEditing
                          ? <input className="form-input" value={editRow.nom} onChange={e => editField('nom', e.target.value)} />
                          : <strong>{f.nom}</strong>}
                      </td>
                      <td style={{padding: '8px'}} className="text-muted">
                        {isEditing
                          ? <input className="form-input" value={editRow.contact || ''} onChange={e => editField('contact', e.target.value)} />
                          : (f.contact || '—')}
                      </td>
                      <td style={{padding: '8px', textAlign: 'right', whiteSpace: 'nowrap'}}>
                        {isEditing ? (
                          <>
                            <button type="button" onClick={saveEdit} className="text-sm px-3 py-1 bg-primary text-white font-semibold rounded">Enregistrer</button>
                            <button type="button" onClick={() => setEditRow(null)} className="ml-2 text-sm px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded">Annuler</button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => setEditRow({ type: 'fournisseur', id: f.id, nom: f.nom, contact: f.contact || '' })} className="text-sm px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded">Modifier</button>
                            <button type="button" onClick={() => deleteEntity('fournisseur', f.id, f.nom)} className="ml-2 text-sm px-3 py-1 bg-red-100 hover:bg-red-200 text-red-700 font-semibold rounded">Supprimer</button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {fournisseurs.length === 0 && (
                  <tr><td colSpan={3} className="text-muted" style={{padding: '12px', textAlign: 'center'}}>Aucun fournisseur.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'categories' && (
        <div className="card">
          <h2 className="mb-2 text-primary-dark">Catégories d'achats</h2>
          <p className="text-sm text-muted mb-6">
            Les catégories servent à <strong>classer les achats</strong> (Journal des Achats) : matériel, location d'engins,
            sous-traitance, consommables… Elles permettent le suivi des dépenses par poste.
          </p>
          <form onSubmit={(e) => handleSubmit(e, 'categories')} className="flex flex-col sm:flex-row gap-4 items-end mb-8">
            <div className="form-group mb-0 flex-1 w-full">
              <label className="form-label">Nom de la catégorie</label>
              <input required name="nom" className="form-input" placeholder="Ex : Matériel électrique" />
            </div>
            <div className="form-group mb-0 flex-1 w-full">
              <label className="form-label">Description (optionnel)</label>
              <input name="description" className="form-input" />
            </div>
            <button className="btn btn-primary w-full sm:w-auto">Enregistrer</button>
          </form>

          <h3 className="mb-4">Liste des catégories</h3>
          <div className="overflow-x-auto">
            <table style={{width: '100%', minWidth: '500px', textAlign: 'left', borderCollapse: 'collapse'}}>
              <thead>
                <tr style={{borderBottom: '1px solid var(--color-border)'}}>
                  <th style={{padding: '8px'}}>Nom</th>
                  <th style={{padding: '8px'}}>Description</th>
                  <th style={{padding: '8px', textAlign: 'right'}}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {categories.map(cat => {
                  const isEditing = editRow?.type === 'categorie' && editRow.id === cat.id;
                  return (
                    <tr key={cat.id} style={{borderBottom: '1px solid #eee'}}>
                      <td style={{padding: '8px'}}>
                        {isEditing
                          ? <input className="form-input" value={editRow.nom} onChange={e => editField('nom', e.target.value)} />
                          : <strong>{cat.nom}</strong>}
                      </td>
                      <td style={{padding: '8px'}} className="text-muted">
                        {isEditing
                          ? <input className="form-input" value={editRow.description || ''} onChange={e => editField('description', e.target.value)} />
                          : (cat.description || '—')}
                      </td>
                      <td style={{padding: '8px', textAlign: 'right', whiteSpace: 'nowrap'}}>
                        {isEditing ? (
                          <>
                            <button type="button" onClick={saveEdit} className="text-sm px-3 py-1 bg-primary text-white font-semibold rounded">Enregistrer</button>
                            <button type="button" onClick={() => setEditRow(null)} className="ml-2 text-sm px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded">Annuler</button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => setEditRow({ type: 'categorie', id: cat.id, nom: cat.nom, description: cat.description || '' })} className="text-sm px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded">Modifier</button>
                            <button type="button" onClick={() => deleteEntity('categorie', cat.id, cat.nom)} className="ml-2 text-sm px-3 py-1 bg-red-100 hover:bg-red-200 text-red-700 font-semibold rounded">Supprimer</button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {categories.length === 0 && (
                  <tr><td colSpan={3} className="text-muted" style={{padding: '12px', textAlign: 'center'}}>Aucune catégorie. Ajoutez-en une ci-dessus.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'societe' && isSuper && (
        <div className="card">
          <h2 className="mb-2 text-primary-dark">Fuseau horaire de la société</h2>
          <p className="text-sm text-muted mb-4">Paramétrage initial de l’entreprise qui exploite Iris. Il détermine ses jours civils, notamment la date du jour et les écritures comptables dérivées d’un instant.</p>
          {societe ? <form onSubmit={enregistrerSociete} className="space-y-4 max-w-xl">
            <label className="form-group block mb-0"><span className="form-label">Fuseau horaire</span>
              <select name="fuseauHoraire" className="form-input" defaultValue={societe.fuseauHoraire || 'Europe/Paris'}>
                <option value="Europe/Paris">Europe/Paris — Métropole</option>
                <option value="America/Guadeloupe">America/Guadeloupe — Guadeloupe</option><option value="America/Martinique">America/Martinique — Martinique</option><option value="America/Cayenne">America/Cayenne — Guyane</option><option value="America/Miquelon">America/Miquelon — Saint-Pierre-et-Miquelon</option><option value="Indian/Mayotte">Indian/Mayotte — Mayotte</option><option value="Indian/Reunion">Indian/Reunion — La Réunion</option><option value="Pacific/Noumea">Pacific/Noumea — Nouvelle-Calédonie</option><option value="Pacific/Wallis">Pacific/Wallis — Wallis-et-Futuna</option><option value="Pacific/Tahiti">Pacific/Tahiti — Polynésie française (Tahiti)</option><option value="Pacific/Marquesas">Pacific/Marquesas — Polynésie française (Marquises)</option><option value="Pacific/Gambier">Pacific/Gambier — Polynésie française (Gambier)</option>
              </select>
            </label>
            {messageSociete && <p className={messageSociete.ok ? 'text-emerald-700' : 'text-red-600'}>{messageSociete.texte}</p>}
            <button className="btn btn-primary">Enregistrer</button>
          </form> : <p className="text-sm text-gray-400">Chargement…</p>}
        </div>
      )}

      {activeTab === 'marges' && isAdmin && (
        <>
          <div className="card mb-4">
            <h2 className="mb-2 text-primary-dark">Paramètres de la Marge Commerciale</h2>
            <p className="text-sm text-muted mb-4">
              Réglages globaux. La marge commerciale est calculée côté serveur ; elle n'est montrée qu'aux
              administrateurs et aux destinataires choisis ci-dessous.
            </p>
            {/* Formulaire non contrôlé : il n'apparaît qu'une fois les paramètres chargés, sinon une
                saisie faite avant leur arrivée serait effacée par le remplissage des valeurs. */}
            {!parametres ? <p className="text-sm text-gray-400">Chargement des paramètres…</p> : (
            <form onSubmit={handleParamsSubmit} className="space-y-4">
              <label className="flex items-center gap-2 cursor-pointer w-fit">
                <input type="checkbox" name="margeCommercialeActive" defaultChecked={parametres?.margeCommercialeActive ?? true} className="w-4 h-4" />
                <span className="text-sm font-semibold text-gray-700">Activer l'affichage et le calcul de la marge commerciale</span>
              </label>
              {/* Politique d'acompte de la société. Elle ne vit pas dans le code : la
                  changer ici suffit. Elle ne s'applique qu'aux devis émis ENSUITE — chaque
                  devis fige son taux à l'émission, comme les barèmes de commission. */}
              <label className="flex items-center gap-3 w-fit">
                <span className="text-sm font-semibold text-gray-700">Taux d'acompte proposé par défaut</span>
                <input
                  type="number" name="tauxAcompteDefaut" min="0" max="100" step="0.01"
                  defaultValue={parametres?.tauxAcompteDefaut ?? 30}
                  className="form-input w-28" style={{ margin: 0 }}
                  title="Proposé à la création d'un devis exigeant un acompte. Sans effet sur les devis déjà émis."
                />
                <span className="text-sm text-gray-500">% du TTC</span>
              </label>
              {/* Alertes du suivi des chantiers (liste et tableau de bord). Vider le délai désactive
                  l'alerte sans saisie ; vider le seuil le retire, une marge estimée négative restant signalée. */}
              <fieldset className="border border-gray-100 rounded-lg p-4 space-y-3">
                <legend className="text-sm font-bold text-gray-700 px-1">Alertes de suivi des chantiers</legend>
                <label className="flex flex-wrap items-center gap-3 w-fit">
                  <span className="text-sm font-semibold text-gray-700">Marge faible : alerter sous</span>
                  <input
                    type="number" name="seuilMargeFaible" min="0" max="100" step="0.01"
                    defaultValue={parametres?.seuilMargeFaible ?? ''}
                    className="form-input w-28" style={{ margin: 0 }}
                    aria-label="Seuil de marge faible en pourcentage"
                  />
                  <span className="text-sm text-gray-500">% de marge estimée en fin de chantier</span>
                </label>
                <label className="flex flex-wrap items-center gap-3 w-fit">
                  <span className="text-sm font-semibold text-gray-700">Chantier sans saisie : alerter après</span>
                  <input
                    type="number" name="joursSansSaisie" min="1" max="365" step="1"
                    defaultValue={parametres?.joursSansSaisie ?? ''}
                    className="form-input w-28" style={{ margin: 0 }}
                    aria-label="Nombre de jours sans saisie"
                  />
                  <span className="text-sm text-gray-500">jours sans achat ni heure</span>
                </label>
                <p className="text-xs text-gray-500 m-0">
                  Vider le délai désactive l’alerte « sans saisie ». Vider le seuil retire le seuil, mais une marge estimée
                  négative reste signalée. La marge estimée compte, pour chaque poste, le plus élevé du
                  réel déjà dépensé et du coût attendu : heures vendues au coût horaire moyen réellement appliqué, matériel
                  vendu au ratio d’achat observé sur les chantiers terminés (au prix de vente tant qu’aucun n’est terminé).
                </p>
              </fieldset>
              {/* Destinataires de la rentabilité de chaque chantier : montant vendu global, marge du jour,
                  marge estimée, alertes « en perte » et « marge faible », facturation de la fiche, sur la
                  liste, le tableau de bord et la fiche. Les dépassements, l'absence de saisie et les budgets
                  par poste restent visibles de tous ceux qui voient le chantier, sauf du technicien, qui ne
                  reçoit aucun montant (cf. voitMontantsChantier côté serveur). */}
              <fieldset className="border border-gray-100 rounded-lg p-4 space-y-2">
                <legend className="text-sm font-bold text-gray-700 px-1">Qui suit la rentabilité des chantiers&nbsp;?</legend>
                <p className="text-xs text-gray-500 m-0">
                  Montant vendu global, marge du jour, marge estimée, alertes « en perte » ou « marge faible » et
                  facturation de la fiche. Les administrateurs les voient toujours. Les budgets par poste (matériel,
                  main-d’œuvre, heures) restent affichés pour suivre les dépassements : ils permettent d’en déduire le vendu,
                  donc la marge du jour. Exception : les techniciens ne voient aucun montant, ni les alertes de dépassement.
                </p>
                <label className="flex items-center gap-2 cursor-pointer w-fit">
                  <input type="checkbox" name="rentabiliteConducteur" defaultChecked={parametres?.rentabiliteConducteur ?? true} className="w-4 h-4" />
                  <span className="text-sm text-gray-700">Le conducteur (ou responsable) chargé du chantier</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer w-fit">
                  <input type="checkbox" name="rentabiliteHierarchie" defaultChecked={parametres?.rentabiliteHierarchie ?? true} className="w-4 h-4" />
                  <span className="text-sm text-gray-700">Ses responsables hiérarchiques, à tous les niveaux</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer w-fit">
                  <input type="checkbox" name="rentabiliteDirecteurs" defaultChecked={parametres?.rentabiliteDirecteurs ?? true} className="w-4 h-4" />
                  <span className="text-sm text-gray-700">Les directeurs (tous les chantiers)</span>
                </label>
                <p className="text-xs text-gray-500 m-0">
                  La chaîne hiérarchique se règle dans l’onglet « Utilisateurs », compte par compte.
                </p>
              </fieldset>
              <button className="btn btn-primary">Enregistrer</button>
            </form>)}
          </div>

          {/* Règles de rémunération commerciale : stockées en base, éditables par un
              superadmin. Elles étaient auparavant écrites en dur dans le serveur, ce qui
              imposait un redéploiement pour changer un taux et livrait à chaque client les
              barèmes d'une autre société. */}
          <div className="card mb-4">
            <h2 className="mb-2 text-primary-dark">Rémunération commerciale</h2>
            <p className="text-sm text-muted mb-4">
              La commission des <strong>commerciaux</strong> applique un barème progressif sur la marge cumulée
              du mois : chaque tranche est commissionnée à son propre taux, franchir un plafond ne requalifie que
              la fraction qui le dépasse. Un second barème s'applique aux chantiers cochés « barème réduit ».
              Détail par commercial dans le menu « Mes commerciaux ».
              {!isSuper && <> Seul un super administrateur peut modifier ces règles.</>}
            </p>
            {remuneration ? (
              <form onSubmit={enregistrerRemuneration} className="space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <EditeurBareme
                    titre="Barème standard"
                    tranches={remuneration.baremeStandard}
                    modifiable={isSuper}
                    onChange={(t) => setRemuneration({ ...remuneration, baremeStandard: t })}
                  />
                  <EditeurBareme
                    titre={remuneration.libelleBaremeReduit || 'Barème réduit'}
                    tranches={remuneration.baremeReduit}
                    modifiable={isSuper}
                    accent
                    onChange={(t) => setRemuneration({ ...remuneration, baremeReduit: t })}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Libellé du barème réduit (affiché sur les chantiers et les écrans commerciaux)</label>
                  <input
                    className="form-input"
                    value={remuneration.libelleBaremeReduit ?? ''}
                    disabled={!isSuper}
                    onChange={(e) => setRemuneration({ ...remuneration, libelleBaremeReduit: e.target.value })}
                    placeholder="Ex. Dossier apporté par la société"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {([
                    ['objectifCaMensuel', 'Objectif de CA mensuel (€)'],
                    ['primeObjectifCa', 'Prime si objectif CA atteint (€)'],
                    ['objectifMargeMensuel', 'Objectif de marge mensuel (€)'],
                    ['primeObjectifMarge', 'Prime si objectif marge atteint (€)'],
                    ['primeSuiviAdministratif', 'Prime de suivi administratif (€)'],
                  ] as const).map(([cle, libelle]) => (
                    <div className="form-group" key={cle}>
                      <label className="form-label">{libelle}</label>
                      <input
                        type="number" min="0" step="any" className="form-input"
                        value={remuneration[cle] ?? 0}
                        disabled={!isSuper}
                        onChange={(e) => setRemuneration({ ...remuneration, [cle]: e.target.value })}
                      />
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-400">
                  Un objectif laissé à 0 ne déclenche aucune prime : il n'est pas considéré comme atteint d'office.
                </p>

                {erreurRemuneration && <p className="text-sm text-red-600">{erreurRemuneration}</p>}
                {messageRemuneration && <p className="text-sm text-emerald-700">{messageRemuneration}</p>}
                {isSuper && <button className="btn btn-primary">Enregistrer les règles</button>}
              </form>
            ) : (
              <p className="text-sm text-gray-400 italic">Chargement des règles…</p>
            )}
          </div>

          <div className="card">
            <h2 className="mb-2 text-primary-dark">Politique de Rémunération Commerciale — document de référence</h2>
            <p className="text-sm text-muted mb-4">
              Détail complet du « Système de rémunération commerciale » sur lequel se basent les calculs de marge et de
              commission de l'application. Le barème et les objectifs mensuels ci-dessus sont calculés automatiquement ;
              les primes et règles ci-dessous sont <strong>en lecture seule</strong> — à appliquer manuellement, faute de
              saisie (nombre de caméras, points d'alarme, portes, type de contrat...) par chantier dans l'application.
            </p>

            <div className="mb-5">
              <div className="text-sm font-bold text-gray-700 mb-2">3. Primes « Boost » (ventes de solutions)</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <PrimeTable title="Vidéosurveillance" rows={PRIMES_VIDEOSURVEILLANCE} />
                <PrimeTable title="Alarme" rows={PRIMES_ALARME} />
                <PrimeTable title="Contrôle d'accès" rows={PRIMES_CONTROLE_ACCES} />
              </div>
            </div>

            <div className="mb-5">
              <div className="text-sm font-bold text-gray-700 mb-2">4. Commissions sur contrats et services récurrents</div>
              <div className="p-4 rounded border bg-gray-50">
                <ul className="text-sm space-y-1">
                  {COMMISSIONS_CONTRATS_RECURRENTS.map((c, i) => (
                    <li key={i} className="flex justify-between gap-4">
                      <span className="text-gray-500">{c.label}</span>
                      <strong className="text-gray-800">{c.detail}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="mb-5">
              <div className="text-sm font-bold text-gray-700 mb-2">5. Modalités de paiement et système de reliquat</div>
              <div className="p-4 rounded border bg-gray-50 text-sm text-gray-600">
                <p className="mb-2">
                  Les commissions sont <strong className="text-gray-800">calculées mensuellement</strong> mais{' '}
                  <strong className="text-gray-800">versées trimestriellement</strong>, après validation des résultats.
                </p>
                <p>
                  En cas de non-atteinte des objectifs mensuels ou trimestriels, un <strong className="text-gray-800">reliquat négatif</strong>{' '}
                  (différence entre objectifs fixés et performances réalisées) est :
                </p>
                <ul className="list-disc list-inside mt-1 space-y-0.5">
                  <li>reporté automatiquement sur le trimestre suivant ;</li>
                  <li>déduit des commissions futures ;</li>
                  <li>exigible tant que les objectifs ne sont pas compensés — le commercial doit le rattraper avant de percevoir de nouvelles commissions variables.</li>
                </ul>
              </div>
            </div>

            <div className="mb-5">
              <div className="text-sm font-bold text-gray-700 mb-2">6. Clauses de sécurisation des commissions</div>
              <div className="p-4 rounded border bg-gray-50 text-sm text-gray-600">
                <ul className="list-disc list-inside space-y-1">
                  <li>Les commissions sont calculées uniquement sur les marges réellement validées.</li>
                  <li>Une affaire n'est commissionnable que si elle est <strong className="text-gray-800">signée, installée, facturée et encaissée</strong> (dans l'application : chantier Terminé + Encaissé).</li>
                  <li>En cas d'annulation, de litige client, de non-paiement ou d'impayé, la commission associée n'est pas due, ou peut être annulée/récupérée si déjà versée.</li>
                  <li>Toute remise commerciale exceptionnelle impactant la marge doit être validée par la direction et peut entraîner une révision de la commission.</li>
                  <li>Les commissions ne sont définitivement acquises qu'après validation complète du chantier et paiement client.</li>
                  <li>En cas de départ du collaborateur, seules les commissions des affaires totalement finalisées et encaissées à la date de sortie sont dues.</li>
                </ul>
              </div>
            </div>

            <div>
              <div className="text-sm font-bold text-gray-700 mb-2">7. Principe général</div>
              <div className="p-4 rounded border bg-gray-50 text-sm text-gray-600">
                <ul className="list-disc list-inside space-y-1">
                  <li>Encourager la performance commerciale et la rentabilité.</li>
                  <li>Responsabiliser les commerciaux sur la qualité des ventes.</li>
                  <li>Valoriser la vente de solutions complètes et récurrentes.</li>
                  <li>Garantir la sécurité financière de l'entreprise.</li>
                </ul>
              </div>
            </div>
          </div>
        </>
      )}

      {activeTab === 'utilisateurs' && isAdmin && (
        <div className="card">
          <h2 className="mb-2 text-primary-dark">Gestion des Comptes Utilisateurs (SSO & Local)</h2>
          <p className="mb-6 text-sm text-gray-600">
            Cette liste est la <strong>liste blanche d'autorisation</strong> : seuls les comptes présents ici peuvent se
            connecter. Un email connu se connecte via le <strong>SSO Microsoft</strong> avec le rôle défini ci-dessous ;
            toute personne <strong>absente de la liste</strong> se voit refuser l'accès (écran « Accès refusé, contactez
            l'administrateur »). Ajoutez ci-dessous chaque personne autorisée et son rôle.
          </p>
          <p className="mb-6 text-sm text-gray-600">
            <strong>Responsable hiérarchique</strong> : un compte <strong>Responsable</strong> voit les chantiers de toute
            sa branche — ses collaborateurs directs, puis les leurs — et, si la société le laisse (onglet « Marges &amp;
            Commissions »), leur rentabilité. Un compte <strong>Directeur</strong> voit tous les chantiers et, si la
            société le laisse, leur rentabilité ; il clôture tout chantier en cours, sans rien administrer ni modifier
            d'autre sur les chantiers (seule l'administration rouvre un chantier).
          </p>

          <div className="mb-8 p-4 bg-gray-50 border rounded">
            <h3 className="mb-4 text-primary-dark">Autoriser un compte</h3>
            <form onSubmit={handleAddUser} className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
              <div className="form-group mb-0">
                <label className="form-label">Email (Microsoft 365)</label>
                <input required type="email" name="email" placeholder="prenom.nom@societe.fr" className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Nom complet</label>
                <input required name="name" placeholder="Prénom Nom" className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Rôle d'accès</label>
                <select name="role" value={newUserRole} onChange={(e) => setNewUserRole(e.target.value)} className="form-input">
                  <option value="CONDUCTEUR_TRAVAUX">Conducteur de Travaux</option>
                  <option value="COMMERCIAL">Commercial</option>
                  <option value="ASSISTANTE_COMMERCIALE">Assistante commerciale</option>
                  <option value="TECHNICIEN">Technicien</option>
                  <option value="COMPTABLE">Comptable</option>
                  <option value="DIRECTEUR_COMMERCIAL">Directeur commercial</option>
                  <option value="RESPONSABLE">Responsable</option>
                  <option value="DIRECTEUR">Directeur</option>
                  <option value="ADMIN">Administrateur</option>
                  {/* Seul un super administrateur peut en désigner un autre. */}
                  {isSuper && <option value={ROLE_SUPERADMIN}>Super Administrateur</option>}
                </select>
              </div>
              <div className="form-group mb-0 md:col-span-2 flex flex-wrap gap-3">
                {isAdminRole(newUserRole) && (
                  <label className="flex items-center gap-2 text-sm font-medium px-3 py-2.5 bg-white border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors w-fit">
                    <input type="checkbox" name="estCommercial" className="w-4 h-4" />
                    Commercial (affectation aux chantiers et statistiques dans « Mes commerciaux »)
                  </label>
                )}
                {/* L'accès au Suivi financier s'accorde à n'importe quel rôle, mais seul un
                    superadmin peut le donner. */}
                {isSuper && (
                  <label className="flex items-center gap-2 text-sm font-medium px-3 py-2.5 bg-white border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors w-fit">
                    <input type="checkbox" name="accesFinance" className="w-4 h-4" />
                    Finance (accès au Suivi financier)
                  </label>
                )}
              </div>
              <button className="btn btn-primary w-full">Autoriser</button>
            </form>
          </div>

          <h3 className="mb-4 text-primary-dark">Comptes autorisés</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse bg-white border rounded">
              <thead>
                <tr className="bg-gray-50 text-xs uppercase text-gray-500 border-b border-gray-100">
                  <th className="px-4 py-4 font-semibold">Nom</th>
                  <th className="px-4 py-4 font-semibold">Email</th>

                  <th className="px-4 py-4 font-semibold">Rôle d'accès</th>
                  <th className="px-4 py-4 font-semibold">Responsable hiérarchique</th>
                  <th className="px-4 py-4 font-semibold">Commercial</th>
                  <th className="px-4 py-4 font-semibold">Finance</th>
                  <th className="px-4 py-4 font-semibold">Droit devis</th>
                  <th className="px-4 py-4 font-semibold">Corriger Travaux</th>
                  <th className="px-4 py-4 font-semibold">Archiver Travaux</th>
                  <th className="px-4 py-4 font-semibold">Actif</th>
                  <th className="px-4 py-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {users.map(u => {
                  const { coche: aLeDroitDevis, vientDuRole: droitDevisVientDuRole } = etatDroitDevis(u.permissions || [], u.permissionsIndividuelles || []);
                  const peutCorrigerTravaux = (u.permissions || []).includes(DROIT_TRAVAUX_CORRECTION);
                  const peutArchiverTravaux = (u.permissions || []).includes(DROIT_TRAVAUX_ARCHIVAGE);
                  const correctionVientDuRole = peutCorrigerTravaux && !(u.permissionsIndividuelles || []).includes(DROIT_TRAVAUX_CORRECTION);
                  const archivageVientDuRole = peutArchiverTravaux && !(u.permissionsIndividuelles || []).includes(DROIT_TRAVAUX_ARCHIVAGE);
                  const responsableActuel = u.responsableHierarchique as CompteResume | null;
                  // Un technicien ne modifie aucune affaire et ne voit aucun montant : ni devis, ni
                  // saisie ou archivage Travaux, ni accès financier (refusés aussi par le serveur).
                  // Ceux enregistrés avant (règle, changement de type) restent affichés « Sans
                  // effet » : ils reprennent effet s'il change de type, et peuvent seulement être retirés.
                  const estTechnicien = u.role === ROLE_TECHNICIEN;
                  const individuels = u.permissionsIndividuelles || [];
                  const sansEffet = (droits: string[]) => estTechnicien && droits.some((droit) => DROITS_INTERDITS_TECHNICIEN.includes(droit) && individuels.includes(droit));
                  const devisSansEffet = sansEffet(DROITS_DEVIS);
                  const correctionSansEffet = sansEffet([DROIT_TRAVAUX_CORRECTION]);
                  const archivageSansEffet = sansEffet([DROIT_TRAVAUX_ARCHIVAGE]);
                  const MESSAGE_TECHNICIEN = 'Ce droit ne s’accorde pas à un compte technicien.';
                  const titreTechnicien = (enregistre: boolean) => enregistre
                    ? `Enregistré, sans effet pour un compte technicien ; il reprend effet si le compte change de type.${isSuper ? ' Décocher pour le retirer.' : ''}`
                    : MESSAGE_TECHNICIEN;
                  // Le retrait ne porte que sur les droits interdits enregistrés : clients:read (annuaire),
                  // permis au technicien par décision de Nelson, est conservé avec le droit devis.
                  const retirer = (droits: string[]) => handleTogglePermission(u.id, individuels, droits.filter((droit) => DROITS_INTERDITS_TECHNICIEN.includes(droit) && individuels.includes(droit)));
                  return (
                  <tr key={u.id} className={`hover:bg-gray-50 transition-colors ${u.actif === false ? 'bg-gray-50 text-gray-400' : ''}`}>
                    <td className="px-4 py-4 font-bold text-gray-800">{u.name}</td>
                    <td className="px-4 py-4 text-sm text-gray-600">{u.email}</td>

                    <td className="px-4 py-4">
                      {/* min-w : avec l'ajout des colonnes Commercial/Finance/Actif, le
                          select se comprimait au point de n'afficher que « Cor… ». */}
                      <select
                        className={`form-input py-1 px-3 text-sm font-semibold rounded min-w-[11rem] ${isAdminRole(u.role) ? 'bg-primary/10 text-primary border-primary' : 'bg-gray-100 text-gray-600 border-gray-300'}`}
                        value={u.role}
                        onChange={(e) => handleRoleChange(u.id, e.target.value)}
                        disabled={u.email === user?.email || !peutGererCompte(u)}
                        title={u.email === user?.email
                          ? "Vous ne pouvez pas modifier votre propre rôle."
                          : !peutGererCompte(u)
                            ? MESSAGE_COMPTE_SUPERADMIN
                            : 'Modifier le rôle'}
                      >
                        <option value="CONDUCTEUR_TRAVAUX">Conducteur de Travaux</option>
                        <option value="COMMERCIAL">Commercial</option>
                  <option value="ASSISTANTE_COMMERCIALE">Assistante commerciale</option>
                  <option value="TECHNICIEN">Technicien</option>
                  <option value="COMPTABLE">Comptable</option>
                  <option value="DIRECTEUR_COMMERCIAL">Directeur commercial</option>
                  <option value="RESPONSABLE">Responsable</option>
                  <option value="DIRECTEUR">Directeur</option>
                        <option value="ADMIN">Administrateur</option>
                        {isSuper && <option value={ROLE_SUPERADMIN}>Super Administrateur</option>}
                      </select>
                    </td>
                    <td className="px-4 py-4">
                      <ChoixResponsable
                        compte={u}
                        responsableActuel={responsableActuel}
                        responsableDesactive={!!responsableActuel && comptesParId.get(responsableActuel.id)?.actif === false}
                        desactive={!peutGererCompte(u)}
                        titre={!peutGererCompte(u) ? MESSAGE_COMPTE_SUPERADMIN : 'Rattacher ce compte à son responsable direct'}
                        proposables={responsablesProposables}
                        onChoix={handleResponsableHierarchique}
                        derniereOuverte={derniereListeOuverte}
                      />
                    </td>
                    <td className="px-4 py-4">
                      {isAdminRole(u.role) ? (
                        <label className="flex items-center gap-2 cursor-pointer w-fit">
                          <input
                            type="checkbox"
                            checked={!!u.estCommercial}
                            disabled={!peutGererCompte(u)}
                            onChange={() => handleToggleEstCommercial(u.id, !!u.estCommercial)}
                            className="w-4 h-4"
                          />
                          <span className="text-xs text-gray-500">{u.estCommercial ? 'Oui' : 'Non'}</span>
                        </label>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    {/* Accès au Suivi financier : ouvert à tous les rôles, réglable par le
                        seul superadmin — un administrateur le voit sans pouvoir le changer. */}
                    <td className="px-4 py-4">
                      {isSuperAdminRole(u.role) ? (
                        <span className="text-xs text-gray-500" title="Un super administrateur accède toujours au suivi financier.">Oui (par défaut)</span>
                      ) : (
                        <label className={`flex items-center gap-2 w-fit ${isSuper ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                          <input
                            type="checkbox"
                            aria-label={`Accès financier — ${u.name}`}
                            checked={!!u.accesFinance}
                            disabled={!isSuper || (estTechnicien && !u.accesFinance)}
                            onChange={() => handleToggleAccesFinance(u.id, !!u.accesFinance)}
                            className="w-4 h-4"
                            title={estTechnicien
                              ? titreTechnicien(!!u.accesFinance)
                              : isSuper
                                ? 'Autoriser ce compte à consulter le Suivi financier'
                                : "Seul un super administrateur peut accorder l'accès au suivi financier."}
                          />
                          <span className="text-xs text-gray-500">{u.accesFinance ? (estTechnicien ? 'Sans effet' : 'Oui') : 'Non'}</span>
                        </label>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <label className={`flex items-center gap-2 w-fit ${isSuper ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                        <input type="checkbox" aria-label={`Droit devis — ${u.name}`} checked={estTechnicien ? devisSansEffet : aLeDroitDevis} disabled={!isSuper || droitDevisVientDuRole || (estTechnicien && !devisSansEffet)} onChange={() => (estTechnicien ? retirer(DROITS_DEVIS) : enregistrerPermissions(u.id, droitsApresBasculeDevis(individuels, aLeDroitDevis)))} className="w-4 h-4" title={estTechnicien ? titreTechnicien(devisSansEffet) : droitDevisVientDuRole ? 'Droit accordé par le type de compte' : 'Autoriser la consultation et la création de devis'} />
                        <span className="text-xs text-gray-500">{devisSansEffet ? 'Sans effet' : 'Droit devis'}</span>
                      </label>
                    </td>
                    <td className="px-4 py-4">
                      <input type="checkbox" aria-label={`Corriger Travaux — ${u.name}`} checked={estTechnicien ? correctionSansEffet : peutCorrigerTravaux} disabled={!isSuper || correctionVientDuRole || (estTechnicien && !correctionSansEffet)} onChange={() => (estTechnicien ? retirer([DROIT_TRAVAUX_CORRECTION]) : handleTogglePermission(u.id, individuels, DROIT_TRAVAUX_CORRECTION))} className="w-4 h-4" title={estTechnicien ? titreTechnicien(correctionSansEffet) : correctionVientDuRole ? 'Droit accordé par le type de compte' : 'Autoriser la saisie et la correction Travaux'} />
                      {correctionSansEffet && <span className="ml-2 text-xs text-gray-500">Sans effet</span>}
                    </td>
                    <td className="px-4 py-4">
                      <input type="checkbox" aria-label={`Archiver Travaux — ${u.name}`} checked={estTechnicien ? archivageSansEffet : peutArchiverTravaux} disabled={!isSuper || archivageVientDuRole || (estTechnicien && !archivageSansEffet)} onChange={() => (estTechnicien ? retirer([DROIT_TRAVAUX_ARCHIVAGE]) : handleTogglePermission(u.id, individuels, DROIT_TRAVAUX_ARCHIVAGE))} className="w-4 h-4" title={estTechnicien ? titreTechnicien(archivageSansEffet) : archivageVientDuRole ? 'Droit accordé par le type de compte' : 'Autoriser l’archivage des écritures Travaux'} />
                      {archivageSansEffet && <span className="ml-2 text-xs text-gray-500">Sans effet</span>}
                    </td>
                    {/* Compte actif : décocher vaut départ de l'entreprise. La connexion est
                        refusée et le compte sort des listes d'attribution, mais son
                        historique de chantiers reste intact (à l'inverse de « Révoquer »). */}
                    <td className="px-4 py-4">
                      <label className={`flex items-center gap-2 w-fit ${u.email === user?.email || !peutGererCompte(u) ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                        <input
                          type="checkbox"
                          checked={u.actif !== false}
                          disabled={u.email === user?.email || !peutGererCompte(u)}
                          onChange={() => handleToggleActif(u.id, u.name, u.actif !== false)}
                          className="w-4 h-4"
                          title={u.email === user?.email
                            ? 'Vous ne pouvez pas désactiver votre propre compte.'
                            : !peutGererCompte(u)
                              ? MESSAGE_COMPTE_SUPERADMIN
                              : "Décocher pour désactiver le compte (historique conservé)"}
                        />
                        <span className={`text-xs ${u.actif === false ? 'font-bold text-red-600' : 'text-gray-500'}`}>
                          {u.actif === false ? 'Désactivé' : 'Oui'}
                        </span>
                      </label>
                    </td>
                    <td className="px-4 py-4 text-right whitespace-nowrap">
                      <button
                        onClick={() => handleDeleteUser(u.id, u.name)}
                        disabled={u.email === user?.email || !peutGererCompte(u)}
                        title={u.email === user?.email
                          ? "Vous ne pouvez pas révoquer votre propre compte."
                          : !peutGererCompte(u)
                            ? MESSAGE_COMPTE_SUPERADMIN
                            : "Révoquer l'accès"}
                        className="ml-2 text-sm px-3 py-1 bg-red-100 hover:bg-red-200 text-red-700 font-semibold rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Révoquer
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'modules' && isSuper && (
        <div className="card">
          <h2 className="mb-2 text-primary-dark">Modules de l'application</h2>
          <p className="text-sm text-muted mb-6">
            Réglages réservés au <strong>super administrateur</strong>. Désactiver un module le fait disparaître de
            l'application pour <strong>tous les autres comptes, administrateurs compris</strong> : le menu n'apparaît
            plus et les pages correspondantes deviennent inaccessibles. <strong>Aucune donnée n'est supprimée</strong> —
            tout est restitué à l'identique dès la réactivation. Vous conservez, vous, l'accès au module pour le
            préparer ou le consulter pendant sa désactivation.
          </p>

          {modulesMessage && (
            <div className="mb-4 p-3 bg-blue-50 text-blue-800 rounded text-sm">{modulesMessage}</div>
          )}

          {planningActif === null ? (
            <p className="text-sm text-gray-400 italic">Chargement des modules...</p>
          ) : (
            <div className="p-4 rounded border bg-gray-50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <div className="font-bold text-gray-800">Planning d'intervention</div>
                <div className="text-sm text-muted mt-0.5">
                  Affectation des techniciens à la semaine, types d'événements et lien de partage public.
                </div>
                <div className="text-sm mt-2">
                  État actuel :{' '}
                  <strong className={planningActif ? 'text-green-700' : 'text-red-700'}>
                    {planningActif ? 'Activé (visible par tous les comptes)' : 'Désactivé (visible du super administrateur uniquement)'}
                  </strong>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => handleModulePlanning(true)}
                  disabled={planningActif}
                  className={`btn ${planningActif ? 'bg-white' : 'btn-primary'} disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  Activer
                </button>
                <button
                  type="button"
                  onClick={() => handleModulePlanning(false)}
                  disabled={!planningActif}
                  className="btn bg-red-100 hover:bg-red-200 text-red-700 font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Désactiver
                </button>
              </div>
            </div>
          )}

          <p className="text-xs text-muted mt-4">
            Note : le <strong>lien de partage public</strong> du planning (destiné aux techniciens sans compte) garde
            son propre interrupteur, dans le module Planning — désactivez-le séparément si vous souhaitez aussi couper
            cet accès.
          </p>
        </div>
      )}

    </div>
  );
};

export default Admin;
