import { useState, useEffect, useRef, useMemo } from 'react';
import { apiFetch } from '../api';
import { Link } from 'react-router-dom';
import { getCurrentUser, isAdminRole, isSuperAdminRole, roleLabel, useCurrentRole } from '../roles';
import { refreshModules } from '../modules';
import { useSociete } from '../companyTimezoneContext';
import OuvrirChantierAffaire from '../components/OuvrirChantierAffaire';
import JournalAdministration from '../components/JournalAdministration';
import { AdminReferentiels } from '../components/AdminReferentiels';
import { AdminMarges } from '../components/AdminMarges';
import { AdminUtilisateurs } from '../components/AdminUtilisateurs';
import { AdminModules } from '../components/AdminModules';

// Onglets ouverts aux CONDUCTEURS DE TRAVAUX : uniquement les référentiels du Journal des
// Achats, qu'ils alimentent au quotidien. Tout le reste de l'Administration (chantiers,
// intervenants et leurs taux, marges, comptes) reste réservé aux administrateurs.
const ONGLETS_CONDUCTEUR = ['fournisseurs', 'categories'];

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

  // Relie un compte technicien à sa fiche intervenant (lot pilote 3) : c'est ce lien qui lui
  // ouvre les interventions affectées à sa fiche. Le serveur ne relie qu'un compte technicien
  // actif, relié à aucune autre fiche, et journalise le changement.
  const relierCompte = async (intervenantId: string, userId: string) => {
    try {
      const res = await apiFetch(`/intervenants/${intervenantId}/compte`, { method: 'PUT', body: JSON.stringify({ userId: userId || null }) });
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Impossible de relier ce compte.'); }
      fetchData();
    } catch {
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

      <AdminReferentiels
        activeTab={activeTab}
        isAdmin={isAdmin}
        users={users}
        intervenants={intervenants}
        fournisseurs={fournisseurs}
        categories={categories}
        editRow={editRow}
        setEditRow={setEditRow}
        handleSubmit={handleSubmit}
        editField={editField}
        saveEdit={saveEdit}
        relierCompte={relierCompte}
        deleteEntity={deleteEntity}
      />

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
        <AdminMarges
          isSuper={isSuper}
          parametres={parametres}
          remuneration={remuneration}
          setRemuneration={setRemuneration}
          erreurRemuneration={erreurRemuneration}
          messageRemuneration={messageRemuneration}
          enregistrerRemuneration={enregistrerRemuneration}
          handleParamsSubmit={handleParamsSubmit}
        />
      )}

      {activeTab === 'utilisateurs' && isAdmin && (
        <AdminUtilisateurs
          user={user}
          isSuper={isSuper}
          users={users}
          newUserRole={newUserRole}
          setNewUserRole={setNewUserRole}
          peutGererCompte={peutGererCompte}
          comptesParId={comptesParId}
          derniereListeOuverte={derniereListeOuverte}
          responsablesProposables={responsablesProposables}
          handleRoleChange={handleRoleChange}
          handleResponsableHierarchique={handleResponsableHierarchique}
          handleToggleEstCommercial={handleToggleEstCommercial}
          handleToggleAccesFinance={handleToggleAccesFinance}
          handleTogglePermission={handleTogglePermission}
          enregistrerPermissions={enregistrerPermissions}
          handleToggleActif={handleToggleActif}
          handleAddUser={handleAddUser}
          handleDeleteUser={handleDeleteUser}
        />
      )}

      {activeTab === 'modules' && isSuper && (
        <AdminModules
          planningActif={planningActif}
          modulesMessage={modulesMessage}
          handleModulePlanning={handleModulePlanning}
        />
      )}

    </div>
  );
};

export default Admin;
