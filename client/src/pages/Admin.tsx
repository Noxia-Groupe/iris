import { useState, useEffect } from 'react';
import { apiFetch } from '../api';
import { TYPES_CHANTIER } from '../chantierTypes';

const fmtEuro = (n: number) => `${Math.round(n).toLocaleString()} €`;

// Rendu des tranches d'un barème progressif (JSON.stringify transforme un plafond
// Infinity en null : la dernière tranche est donc "au-delà de X €", sans borne haute).
const BaremeTranches = ({ tranches }: { tranches?: { plafond: number | null; taux: number }[] }) => {
  if (!tranches || tranches.length === 0) return null;
  let plancher = 0;
  return (
    <ul className="text-sm space-y-1">
      {tranches.map((t, i) => {
        const label = plancher === 0
          ? `Jusqu'à ${fmtEuro(t.plafond ?? 0)}`
          : t.plafond == null
            ? `Au-delà de ${fmtEuro(plancher)}`
            : `De ${fmtEuro(plancher)} à ${fmtEuro(t.plafond)}`;
        plancher = t.plafond ?? plancher;
        return (
          <li key={i} className="flex justify-between gap-4">
            <span className="text-gray-500">{label}</span>
            <strong className="text-gray-800">{t.taux} %</strong>
          </li>
        );
      })}
    </ul>
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

const Admin = () => {
  const [activeTab, setActiveTab] = useState('chantiers');
  const [users, setUsers] = useState<any[]>([]);
  const [intervenants, setIntervenants] = useState<any[]>([]);
  const [fournisseurs, setFournisseurs] = useState<any[]>([]);
  const [chantiers, setChantiers] = useState<any[]>([]);
  const [parametres, setParametres] = useState<any>(null);
  const [categories, setCategories] = useState<any[]>([]);
  const [remunerationCommerciale, setRemunerationCommerciale] = useState<any>(null);
  // Ligne en cours d'édition : { type: 'intervenant'|'fournisseur'|'categorie', id, ...champs }
  const [editRow, setEditRow] = useState<any>(null);

  // Rôle réel
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const userRole = user?.role || 'CONDUCTEUR_TRAVAUX';

  useEffect(() => {
    fetchData();
  }, [activeTab]);

  const fetchData = async () => {
    const endpoints: Record<string, string> = {
      intervenants: '/intervenants',
      fournisseurs: '/fournisseurs',
      categories: '/categories',
      chantiers: '/chantiers',
    };

    try {
      const res = await apiFetch(endpoints[activeTab] || '/chantiers');
      const data = await res.json();

      if (activeTab === 'intervenants') setIntervenants(data);
      else if (activeTab === 'fournisseurs') setFournisseurs(data);
      else if (activeTab === 'categories') setCategories(data);
      else setChantiers(data);

      const usersRes = await apiFetch('/users');
      setUsers(await usersRes.json());

      if (activeTab === 'marges') {
        const pRes = await apiFetch('/parametres');
        if (pRes.ok) setParametres(await pRes.json());

        // Bareme/objectifs de la rémunération commerciale : valeurs de référence exposées
        // en lecture seule (cf. /api/stats/commerciaux), déjà utilisées telles quelles par
        // les commerciaux dans "Mes commerciaux" / "Résultat commercial".
        const cRes = await apiFetch('/stats/commerciaux');
        if (cRes.ok) {
          const data = await cRes.json();
          setRemunerationCommerciale({ bareme: data.bareme, objectifs: data.objectifs });
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleParamsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    const payload = {
      margeCommercialeActive: formData.get('margeCommercialeActive') === 'on',
    };
    const res = await apiFetch('/parametres', { method: 'PUT', body: JSON.stringify(payload) });
    if (res.ok) {
      setParametres(await res.json());
      alert('Paramètres mis à jour');
    }
  };

  const handleSubmit = async (e: React.FormEvent, type: string) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    const data: Record<string, unknown> = Object.fromEntries(formData.entries());
    // Plusieurs cases "types" partagent le même name : entries() n'en garderait qu'une.
    if (type === 'chantiers') data.types = formData.getAll('types');

    await apiFetch(`/${type}`, {
      method: 'POST',
      body: JSON.stringify(data)
    });

    (e.target as HTMLFormElement).reset();
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

  const handlePasswordChange = async (userId: string, userName: string) => {
    const newPassword = window.prompt(`Entrez le nouveau mot de passe pour ${userName} (minimum 6 caractères) :`);
    if (!newPassword) return;
    if (newPassword.length < 6) {
      alert("Le mot de passe doit faire au moins 6 caractères.");
      return;
    }
    
    try {
      const res = await apiFetch(`/users/${userId}/password`, {
        method: 'PUT',
        body: JSON.stringify({ newPassword })
      });
      if (res.ok) {
        alert("Mot de passe mis à jour avec succès.");
      } else {
        const data = await res.json();
        alert(data.error || "Erreur lors de la mise à jour du mot de passe.");
      }
    } catch (e) {
      alert("Impossible de joindre le serveur.");
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
    };
    try {
      const res = await apiFetch('/users', { method: 'POST', body: JSON.stringify(payload) });
      if (res.ok) {
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
            Connecté en tant que: <strong className="text-primary-dark">{userRole === 'ADMIN' ? 'Admin' : 'Conducteur'}</strong>
          </span>
        </div>
      </div>

      <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
        <button className={`btn ${activeTab === 'chantiers' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('chantiers')}>Chantiers</button>
        <button className={`btn ${activeTab === 'intervenants' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('intervenants')}>Intervenants</button>
        <button className={`btn ${activeTab === 'fournisseurs' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('fournisseurs')}>Fournisseurs</button>
        {userRole === 'ADMIN' && (
          <>
            <button className={`btn ${activeTab === 'categories' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('categories')}>Catégories</button>
            <button className={`btn ${activeTab === 'marges' ? 'btn-primary' : 'bg-white'}`} onClick={() => { setActiveTab('marges'); fetchData(); }}>Marges & Commissions</button>
            <button className={`btn ${activeTab === 'utilisateurs' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('utilisateurs')}>Utilisateurs</button>
          </>
        )}
      </div>

      {activeTab === 'chantiers' && (
        <div className="card">
          <h2 className="mb-4 text-primary-dark">Créer un nouveau chantier</h2>
          <form onSubmit={(e) => handleSubmit(e, 'chantiers')} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="form-group mb-0">
              <label className="form-label">Nom du Chantier</label>
              <input required name="nom" className="form-input" />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">Client</label>
              <input required name="client" className="form-input" />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">N° de Devis</label>
              <input name="numeroDevis" className="form-input" />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">Responsable Chantier</label>
              <select required name="responsableId" className="form-input" defaultValue="">
                <option value="" disabled>Sélectionner un conducteur...</option>
                {users.filter(u => u.role === 'CONDUCTEUR_TRAVAUX').map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div className="form-group mb-0">
              <label className="form-label">Commercial rattaché{users.some(u => u.role === 'COMMERCIAL') ? '' : ' (aucun disponible)'}</label>
              <select required={users.some(u => u.role === 'COMMERCIAL')} name="commercialId" className="form-input" defaultValue="">
                <option value="" disabled>Sélectionner un commercial...</option>
                {users.filter(u => u.role === 'COMMERCIAL').map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div className="form-group mb-0">
              <label className="form-label">Date Début</label>
              <input required type="date" name="dateDebut" className="form-input" />
            </div>
            
            <div className="col-span-1 md:col-span-2 mt-4 p-4 bg-gray-50 rounded border">
              <h3 className="text-primary mb-4 border-b pb-2">Détails Budgétaires Vendus</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                <div className="form-group mb-0">
                  <label className="form-label font-bold text-primary">Budget Global (€ HT)</label>
                  <input required type="number" step="0.01" name="budgetGlobalVendu" className="form-input" />
                </div>
                <div className="form-group mb-0">
                  <label className="form-label">Dont Matériel (€ HT)</label>
                  <input required type="number" step="0.01" name="budgetMaterielVendu" className="form-input" />
                </div>
                <div className="form-group mb-0">
                  <label className="form-label">Dont Main d'Œuvre (€ HT)</label>
                  <input required type="number" step="0.01" name="budgetMainOeuvreVendu" className="form-input" />
                </div>
                <div className="form-group mb-0">
                  <label className="form-label">Total Heures Vendues (h)</label>
                  <input required type="number" step="0.5" name="heuresVendues" className="form-input" />
                </div>
              </div>
            </div>

            <div className="form-group mb-0 md:col-span-2">
              <label className="form-label">Type(s) de chantier</label>
              <div className="flex flex-wrap gap-2">
                {TYPES_CHANTIER.map((t) => (
                  <label key={t} className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors">
                    <input type="checkbox" name="types" value={t} className="w-4 h-4" />
                    {t}
                  </label>
                ))}
              </div>
            </div>

            <div className="col-span-1 md:col-span-2 mt-2">
              <button className="btn btn-primary w-full md:w-auto px-8">Enregistrer le chantier</button>
            </div>
          </form>

          <h3 className="mt-10 mb-4 text-primary-dark">Base de données des Chantiers</h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {chantiers.map(c => (
              <div key={c.id} className="p-4 bg-white border rounded shadow-sm hover:shadow-md transition-shadow">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <h4 className="font-bold text-lg text-primary">{c.nom}</h4>
                    <span className="text-sm text-muted">Client : {c.client} | Devis : {c.numeroDevis || 'Non spécifié'}</span>
                    <div className="text-sm text-muted mt-0.5">Responsable : <strong className="text-gray-700">{c.responsable?.name || 'Non affecté'}</strong></div>
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

      {activeTab === 'intervenants' && (
        <div className="card">
          {userRole === 'ADMIN' ? (
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
                  {userRole === 'ADMIN' && <th style={{padding: '8px'}}>Coût Horaire (€/h)</th>}
                  {userRole === 'ADMIN' && <th style={{padding: '8px', textAlign: 'right'}}>Actions</th>}
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
                      {userRole === 'ADMIN' && (
                        <td style={{padding: '8px'}}>
                          {isEditing
                            ? <input type="number" step="0.1" className="form-input" value={editRow.tauxHoraireCharge} onChange={e => editField('tauxHoraireCharge', e.target.value)} />
                            : `${i.tauxHoraireCharge} €`}
                        </td>
                      )}
                      {userRole === 'ADMIN' && (
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

      {activeTab === 'categories' && userRole === 'ADMIN' && (
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

      {activeTab === 'marges' && userRole === 'ADMIN' && (
        <>
          <div className="card mb-4">
            <h2 className="mb-2 text-primary-dark">Paramètres de la Marge Commerciale</h2>
            <p className="text-sm text-muted mb-4">
              Réglages globaux. La marge commerciale est calculée côté serveur et n'est visible que par les administrateurs.
            </p>
            <form key={parametres ? 'loaded' : 'loading'} onSubmit={handleParamsSubmit} className="flex flex-col sm:flex-row gap-6 sm:items-center sm:justify-between">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" name="margeCommercialeActive" defaultChecked={parametres?.margeCommercialeActive ?? true} className="w-4 h-4" />
                <span className="text-sm font-semibold text-gray-700">Activer l'affichage et le calcul de la marge commerciale</span>
              </label>
              <button className="btn btn-primary">Enregistrer</button>
            </form>
          </div>

          <div className="card mb-4">
            <h2 className="mb-2 text-primary-dark">Rémunération Commerciale (barème progressif)</h2>
            <p className="text-sm text-muted mb-4">
              La commission des <strong>commerciaux</strong> ne suit plus un taux réglé par chantier : elle applique
              désormais un barème progressif sur la marge cumulée du mois (standard, ou réduit pour les dossiers
              NOXIA), complété par des primes d'objectifs mensuels. Ces valeurs sont pour l'instant fixées côté
              serveur — écran en lecture seule. Détail par commercial dans le menu « Mes commerciaux ».
            </p>
            {remunerationCommerciale ? (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                  <div className="p-4 rounded border bg-gray-50">
                    <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Barème standard</div>
                    <BaremeTranches tranches={remunerationCommerciale.bareme?.standard} />
                  </div>
                  <div className="p-4 rounded border bg-amber-50">
                    <div className="text-xs font-bold text-amber-700 uppercase tracking-wide mb-2">Barème dossiers NOXIA</div>
                    <BaremeTranches tranches={remunerationCommerciale.bareme?.noxia} />
                  </div>
                </div>
                {remunerationCommerciale.objectifs && (
                  <div className="p-4 rounded border bg-gray-50">
                    <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Objectifs et primes mensuelles</div>
                    <ul className="text-sm space-y-1 list-disc list-inside text-gray-600">
                      <li>Objectif CA vendu : <strong className="text-gray-800">{fmtEuro(remunerationCommerciale.objectifs.ca)}</strong> → prime de <strong className="text-gray-800">{remunerationCommerciale.objectifs.primeCA} €</strong></li>
                      <li>Objectif marge commerciale : <strong className="text-gray-800">{fmtEuro(remunerationCommerciale.objectifs.marge)}</strong> → prime de <strong className="text-gray-800">{remunerationCommerciale.objectifs.primeMarge} €</strong></li>
                      <li>Suivi administratif (validé manuellement chaque mois, cf. « Mes commerciaux ») → prime de <strong className="text-gray-800">{remunerationCommerciale.objectifs.primeAdmin} €</strong></li>
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-gray-400 italic">Chargement du barème...</p>
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

      {activeTab === 'utilisateurs' && userRole === 'ADMIN' && (
        <div className="card">
          <h2 className="mb-2 text-primary-dark">Gestion des Comptes Utilisateurs (SSO & Local)</h2>
          <p className="mb-6 text-sm text-gray-600">
            Cette liste est la <strong>liste blanche d'autorisation</strong> : seuls les comptes présents ici peuvent se
            connecter. Un email connu se connecte via le <strong>SSO Microsoft</strong> avec le rôle défini ci-dessous ;
            toute personne <strong>absente de la liste</strong> se voit refuser l'accès (écran « Accès refusé, contactez
            l'administrateur »). Ajoutez ci-dessous chaque personne autorisée et son rôle.
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
                <select name="role" defaultValue="CONDUCTEUR_TRAVAUX" className="form-input">
                  <option value="CONDUCTEUR_TRAVAUX">Conducteur de Travaux</option>
                  <option value="COMMERCIAL">Commercial</option>
                  <option value="ADMIN">Administrateur</option>
                </select>
              </div>
              <button className="btn btn-primary w-full">Autoriser</button>
            </form>
          </div>

          <h3 className="mb-4 text-primary-dark">Comptes autorisés</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse bg-white border rounded">
              <thead>
                <tr className="bg-gray-50 text-xs uppercase text-gray-500 border-b border-gray-100">
                  <th className="px-6 py-4 font-semibold">Nom</th>
                  <th className="px-6 py-4 font-semibold">Email</th>
                  <th className="px-6 py-4 font-semibold">Type</th>
                  <th className="px-6 py-4 font-semibold">Rôle d'accès</th>
                  <th className="px-6 py-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {users.map(u => (
                  <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4 font-bold text-gray-800">{u.name}</td>
                    <td className="px-6 py-4 text-sm text-gray-600">{u.email}</td>
                    <td className="px-6 py-4">
                      <span className={`text-xs font-semibold px-2 py-1 rounded ${u.hasPassword ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
                        {u.hasPassword ? 'Local + SSO' : 'SSO'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <select
                        className={`form-input py-1 px-3 text-sm font-semibold rounded ${u.role === 'ADMIN' ? 'bg-primary/10 text-primary border-primary' : 'bg-gray-100 text-gray-600 border-gray-300'}`}
                        value={u.role}
                        onChange={(e) => handleRoleChange(u.id, e.target.value)}
                        disabled={u.email === user?.email} // Empêcher l'admin de se rétrograder lui-même
                        title={u.email === user?.email ? "Vous ne pouvez pas modifier votre propre rôle." : "Modifier le rôle"}
                      >
                        <option value="CONDUCTEUR_TRAVAUX">Conducteur de Travaux</option>
                        <option value="COMMERCIAL">Commercial</option>
                        <option value="ADMIN">Administrateur</option>
                      </select>
                    </td>
                    <td className="px-6 py-4 text-right whitespace-nowrap">
                      <button
                        onClick={() => handlePasswordChange(u.id, u.name)}
                        className="text-sm px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded transition-colors"
                      >
                        Changer Mdp
                      </button>
                      <button
                        onClick={() => handleDeleteUser(u.id, u.name)}
                        disabled={u.email === user?.email}
                        title={u.email === user?.email ? "Vous ne pouvez pas révoquer votre propre compte." : "Révoquer l'accès"}
                        className="ml-2 text-sm px-3 py-1 bg-red-100 hover:bg-red-200 text-red-700 font-semibold rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Révoquer
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  );
};

export default Admin;
