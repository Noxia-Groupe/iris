import { useState, useEffect } from 'react';
import { apiFetch } from '../api';
import { TYPES_CHANTIER } from '../chantierTypes';

// Une date "YYYY-MM-DD" (sans fuseau, tel que renvoyé par le serveur) -> "DD/MM".
const fmtJourMois = (isoDate: string) => {
  const [, m, d] = isoDate.split('-');
  return `${d}/${m}`;
};

// Plage d'heures affichée pour le créneau de saisie habituel (6h -> 19h).
const HOUR_RANGE = Array.from({ length: 14 }, (_, i) => i + 6);

const Admin = () => {
  const [activeTab, setActiveTab] = useState('chantiers');
  const [users, setUsers] = useState<any[]>([]);
  const [intervenants, setIntervenants] = useState<any[]>([]);
  const [fournisseurs, setFournisseurs] = useState<any[]>([]);
  const [chantiers, setChantiers] = useState<any[]>([]);
  const [parametres, setParametres] = useState<any>(null);
  const [perf, setPerf] = useState<any[]>([]);
  const [assiduite, setAssiduite] = useState<any>(null);
  // N'importe quelle date de la semaine affichée (le serveur calcule lundi-vendredi).
  const [weekRef, setWeekRef] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [categories, setCategories] = useState<any[]>([]);
  // Ligne en cours d'édition : { type: 'intervenant'|'fournisseur'|'categorie', id, ...champs }
  const [editRow, setEditRow] = useState<any>(null);

  // Rôle réel
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const userRole = user?.role || 'CONDUCTEUR_TRAVAUX';

  useEffect(() => {
    fetchData();
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'performances') fetchAssiduite();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, weekRef]);

  const fetchAssiduite = async () => {
    try {
      const res = await apiFetch(`/stats/conducteurs/assiduite?week=${weekRef}`);
      if (res.ok) setAssiduite(await res.json());
    } catch (e) {
      console.error(e);
    }
  };

  const shiftWeek = (deltaDays: number) => {
    const d = new Date(weekRef + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + deltaDays);
    setWeekRef(d.toISOString().slice(0, 10));
  };

  const fetchData = async () => {
    // Les onglets marges/performances/utilisateurs s'appuient sur la liste des chantiers.
    const endpoints: Record<string, string> = {
      intervenants: '/intervenants',
      fournisseurs: '/fournisseurs',
      categories: '/categories',
      chantiers: '/chantiers',
      marges: '/chantiers',
      performances: '/chantiers',
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
      }
      if (activeTab === 'performances') {
        const perfRes = await apiFetch('/stats/conducteurs');
        if (perfRes.ok) setPerf(await perfRes.json());
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

  const handleCommissionSubmit = async (e: React.FormEvent, chantierId: string) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    const data = Object.fromEntries(formData.entries());
    
    // Convert to numbers
    const payload = {
      mode: data.mode,
      tauxFixe: parseFloat(data.tauxFixe as string) || 0,
      bonusHeure: parseFloat(data.bonusHeure as string) || 0,
      malusHeure: parseFloat(data.malusHeure as string) || 0
    };

    await apiFetch(`/chantiers/${chantierId}/commissionnement`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    alert('Règles de commissionnement mises à jour');
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
            <button className={`btn ${activeTab === 'performances' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('performances')}>Performances</button>
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
          <div className="card">
          <h2 className="mb-2 text-primary-dark">Politique de Commissionnement par Chantier</h2>
          <p className="text-sm text-muted mb-4">
            La commission du conducteur est un <strong>pourcentage de la marge commerciale</strong> du chantier.
            En mode <strong>Dynamique</strong>, le taux de base est majoré (bonus) si le chantier est en avance sur
            les heures vendues, ou minoré (malus) s'il est en retard. Le taux effectif est borné entre 0 % et 100 %.
          </p>
          <div className="grid grid-cols-1 gap-6">
            {chantiers.map(c => {
              const comm = c.commissionnement || { mode: 'FIXE', tauxFixe: 0, bonusHeure: 0, malusHeure: 0 };
              return (
                <div key={c.id} className="p-4 border rounded bg-gray-50">
                  <h3 className="font-bold text-lg mb-4">{c.nom} <span className="text-sm font-normal text-muted">({c.client})</span></h3>
                  <form onSubmit={(e) => handleCommissionSubmit(e, c.id)} className="grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
                    <div className="form-group mb-0">
                      <label className="form-label">Mode</label>
                      <select name="mode" className="form-input" defaultValue={comm.mode}>
                        <option value="FIXE">Taux Fixe</option>
                        <option value="DYNAMIQUE">Dynamique (Bonus/Malus)</option>
                      </select>
                    </div>
                    <div className="form-group mb-0">
                      <label className="form-label">Commission de base (%)</label>
                      <input type="number" step="0.1" name="tauxFixe" defaultValue={comm.tauxFixe} className="form-input" />
                    </div>
                    <div className="form-group mb-0">
                      <label className="form-label">Bonus si avance (pts %)</label>
                      <input type="number" step="0.1" name="bonusHeure" defaultValue={comm.bonusHeure} className="form-input" />
                    </div>
                    <div className="form-group mb-0">
                      <label className="form-label">Malus si retard (pts %)</label>
                      <input type="number" step="0.1" name="malusHeure" defaultValue={comm.malusHeure} className="form-input" />
                    </div>
                    <button className="btn btn-primary w-full">Mettre à jour</button>
                  </form>
                  {c.metrics && c.metrics.commission != null && (
                    <div className="mt-3 text-sm text-muted">
                      Commission estimée à ce jour : <strong className="text-primary-dark">{Math.round(c.metrics.commission).toLocaleString()} €</strong>
                      {' '}— taux effectif <strong>{(c.metrics.tauxCommission ?? 0).toFixed(1)} %</strong> de la marge
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          </div>
        </>
      )}

      {activeTab === 'performances' && userRole === 'ADMIN' && (
        <div>
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-4">
            <div>
              <h2 className="text-primary-dark m-0">Performances & Statistiques des Conducteurs</h2>
              <p className="text-sm text-muted mt-1">
                Classées par marge commerciale générée. Visible uniquement par les administrateurs.
              </p>
            </div>
            <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg p-1.5 shrink-0">
              <button type="button" onClick={() => shiftWeek(-7)} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500 font-bold" title="Semaine précédente">‹</button>
              <span className="text-sm font-semibold text-gray-700 px-2 whitespace-nowrap">
                Semaine du {assiduite ? fmtJourMois(assiduite.weekStart) : '…'} au {assiduite ? fmtJourMois(assiduite.weekEnd) : '…'}
              </span>
              <button type="button" onClick={() => shiftWeek(7)} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500 font-bold" title="Semaine suivante">›</button>
              <button type="button" onClick={() => setWeekRef(new Date().toISOString().slice(0, 10))} className="ml-1 text-xs font-semibold px-2 py-1.5 rounded-md hover:bg-gray-100 text-accent">Aujourd'hui</button>
            </div>
          </div>

          {perf.length === 0 ? (
            <div className="card text-center py-12 text-gray-400 italic">
              Aucune donnée (aucun chantier affecté à un conducteur).
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {perf.map((p, i) => {
                const a = assiduite?.conducteurs?.find((c: any) => c.id === p.id);
                const maxSaisies = Math.max(1, ...(a?.tranchesHoraires || []).map((t: any) => t.nbSaisies));
                const tranchesMap = new Map<number, number>((a?.tranchesHoraires || []).map((t: any) => [t.heure, t.nbSaisies] as [number, number]));
                return (
                <div key={p.id} className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
                  <div className="flex items-start justify-between gap-3 mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-gray-100 text-gray-500 font-bold text-sm flex items-center justify-center shrink-0">#{i + 1}</div>
                      <div>
                        <div className="font-bold text-gray-800">{p.name}</div>
                        <div className="text-xs text-muted">{p.email}</div>
                      </div>
                    </div>
                    <div className="text-right text-xs font-semibold text-gray-500 whitespace-nowrap">
                      {p.nbChantiersEnCours} en cours · {p.nbChantiersTermines} terminé{p.nbChantiersTermines > 1 ? 's' : ''}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <div className="bg-gray-50 rounded-lg p-3">
                      <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">CA vendu</div>
                      <div className="font-bold text-gray-800 mt-0.5">{Math.round(p.caTotal).toLocaleString()} €</div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3">
                      <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Marge générée</div>
                      <div className={`font-bold mt-0.5 ${p.margeTotal >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{Math.round(p.margeTotal).toLocaleString()} €</div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3">
                      <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Marge %</div>
                      <div className="font-bold text-gray-800 mt-0.5">{(p.margePct ?? 0).toFixed(1)}%</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <div>
                      <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide mb-1.5">Chantiers en cours — heures</div>
                      <div className="flex gap-2">
                        <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full bg-emerald-100 text-emerald-700">{p.nbEnAvanceHeures} en avance</span>
                        <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full bg-red-100 text-red-700">{p.nbEnRetardHeures} en retard</span>
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide mb-1.5">Chantiers en cours — matériel</div>
                      <div className="flex gap-2">
                        <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full bg-emerald-100 text-emerald-700">{p.nbMaterielDansBudget} dans le budget</span>
                        <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full bg-red-100 text-red-700">{p.nbMaterielDepasse} dépassé{p.nbMaterielDepasse > 1 ? 's' : ''}</span>
                      </div>
                    </div>
                  </div>

                  <div className="pt-3 mb-3 border-t border-gray-100 flex items-center justify-between">
                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">Objectifs respectés (chantiers terminés)</span>
                    {p.tauxObjectifsRespectes == null ? (
                      <span className="text-sm text-gray-400 italic">Aucun chantier terminé</span>
                    ) : (
                      <span className={`text-sm font-black ${p.tauxObjectifsRespectes >= 50 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {p.nbObjectifsRespectes}/{p.nbChantiersTermines} ({p.tauxObjectifsRespectes.toFixed(0)}%)
                      </span>
                    )}
                  </div>

                  {/* Assiduité de saisie : usage réel de l'app cette semaine-là, pas l'avancement des chantiers */}
                  <div className="pt-3 border-t border-gray-100">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">Assiduité de saisie (semaine)</span>
                      {a && (
                        <span className={`text-sm font-black ${a.joursActifs >= 4 ? 'text-emerald-600' : a.joursActifs >= 2 ? 'text-amber-600' : 'text-red-600'}`}>
                          {a.joursActifs}/5 jours actifs
                        </span>
                      )}
                    </div>

                    {!a || a.nbSaisiesTotal === 0 ? (
                      <div className="text-sm text-gray-400 italic py-2">Aucune saisie sur cette semaine.</div>
                    ) : (
                      <>
                        <div className="grid grid-cols-5 gap-1.5 mb-3">
                          {a.days.map((d: any) => (
                            <div key={d.date} className={`rounded-lg px-1 py-2 text-center ${d.nbSaisies > 0 ? 'bg-emerald-50' : 'bg-gray-50'}`}>
                              <div className="text-[10px] font-bold text-gray-500 uppercase">{d.label.slice(0, 3)}</div>
                              <div className={`text-sm font-black mt-0.5 ${d.nbSaisies > 0 ? 'text-emerald-700' : 'text-gray-300'}`}>
                                {d.nbSaisies > 0 ? `${d.heuresSaisies.toFixed(1)}h` : '—'}
                              </div>
                            </div>
                          ))}
                        </div>

                        <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
                          <span>{a.heuresTotalesSaisies.toFixed(1)}h saisies · {a.nbSaisiesTotal} saisie{a.nbSaisiesTotal > 1 ? 's' : ''}</span>
                          <span>{a.moyenneHeuresParJourActif.toFixed(1)}h / jour actif en moyenne</span>
                        </div>

                        <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide mb-1">
                          Créneau de saisie habituel {a.heurePic != null && <span className="text-accent">— vers {a.heurePic}h-{a.heurePic + 1}h</span>}
                        </div>
                        <div className="flex items-end gap-0.5 h-12">
                          {HOUR_RANGE.map((h) => {
                            const count = tranchesMap.get(h) || 0;
                            const heightPct = count > 0 ? Math.max(12, (count / maxSaisies) * 100) : 4;
                            return (
                              <div key={h} className="flex-1 flex flex-col items-center justify-end h-full" title={`${h}h : ${count} saisie${count > 1 ? 's' : ''}`}>
                                <div
                                  className={`w-full rounded-t-sm transition-all ${h === a.heurePic ? 'bg-accent' : count > 0 ? 'bg-purple-300' : 'bg-gray-100'}`}
                                  style={{ height: `${heightPct}%` }}
                                />
                              </div>
                            );
                          })}
                        </div>
                        <div className="flex justify-between text-[9px] text-gray-400 mt-1">
                          <span>{HOUR_RANGE[0]}h</span>
                          <span>{HOUR_RANGE[HOUR_RANGE.length - 1]}h</span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
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
