import { useState, useEffect } from 'react';
import { apiFetch } from '../api';

const Admin = () => {
  const [activeTab, setActiveTab] = useState('chantiers');
  const [users, setUsers] = useState<any[]>([]);
  const [intervenants, setIntervenants] = useState<any[]>([]);
  const [fournisseurs, setFournisseurs] = useState<any[]>([]);
  const [chantiers, setChantiers] = useState<any[]>([]);
  const [parametres, setParametres] = useState<any>(null);
  const [perf, setPerf] = useState<any[]>([]);
  
  // Rôle réel
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const userRole = user?.role || 'CONDUCTEUR_TRAVAUX';

  useEffect(() => {
    fetchData();
  }, [activeTab]);

  const fetchData = async () => {
    // Les onglets marges/performances/utilisateurs s'appuient sur la liste des chantiers.
    const endpoints: Record<string, string> = {
      intervenants: '/intervenants',
      fournisseurs: '/fournisseurs',
      chantiers: '/chantiers',
      marges: '/chantiers',
      performances: '/chantiers',
    };

    try {
      const res = await apiFetch(endpoints[activeTab] || '/chantiers');
      const data = await res.json();

      if (activeTab === 'intervenants') setIntervenants(data);
      else if (activeTab === 'fournisseurs') setFournisseurs(data);
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
      tauxHoraireMoyen: parseFloat(formData.get('tauxHoraireMoyen') as string) || 0,
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
    const data = Object.fromEntries(formData.entries());
    
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
              <select name="responsableId" className="form-input">
                <option value="">Sélectionner (optionnel)...</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
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
            <table style={{width: '100%', minWidth: '500px', textAlign: 'left', borderCollapse: 'collapse'}}>
              <thead>
                <tr style={{borderBottom: '1px solid var(--color-border)'}}>
                  <th style={{padding: '8px'}}>Nom</th>
                  <th style={{padding: '8px'}}>Rôle / Fonction</th>
                  {userRole === 'ADMIN' && <th style={{padding: '8px'}}>Coût Horaire (€/h)</th>}
                </tr>
              </thead>
              <tbody>
                {intervenants.map(i => (
                  <tr key={i.id} style={{borderBottom: '1px solid #eee'}}>
                    <td style={{padding: '8px'}}><strong>{i.nom}</strong></td>
                    <td style={{padding: '8px'}} className="text-muted">{i.role}</td>
                    {userRole === 'ADMIN' && <td style={{padding: '8px'}}>{i.tauxHoraireCharge} €</td>}
                  </tr>
                ))}
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
          <ul className="flex flex-col gap-2">
            {fournisseurs.map(f => (
              <li key={f.id} className="p-3 bg-gray-50 border rounded">
                <strong>{f.nom}</strong> {f.contact && <span className="text-muted ml-2">- {f.contact}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {activeTab === 'marges' && userRole === 'ADMIN' && (
        <>
          <div className="card mb-4">
            <h2 className="mb-2 text-primary-dark">Paramètres de la Marge Commerciale</h2>
            <p className="text-sm text-muted mb-4">
              Réglages globaux. La marge commerciale est calculée côté serveur et n'est visible que par les administrateurs.
            </p>
            <form key={parametres ? 'loaded' : 'loading'} onSubmit={handleParamsSubmit} className="flex flex-col sm:flex-row gap-6 sm:items-end">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" name="margeCommercialeActive" defaultChecked={parametres?.margeCommercialeActive ?? true} className="w-4 h-4" />
                <span className="text-sm font-semibold text-gray-700">Activer l'affichage et le calcul de la marge commerciale</span>
              </label>
              <div className="form-group mb-0">
                <label className="form-label">Taux horaire moyen (€/h)</label>
                <input type="number" step="0.5" name="tauxHoraireMoyen" defaultValue={parametres?.tauxHoraireMoyen ?? 30} className="form-input" />
              </div>
              <button className="btn btn-primary">Enregistrer</button>
            </form>
          </div>
          <div className="card">
          <h2 className="mb-4 text-primary-dark">Politique de Commissionnement par Chantier</h2>
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
                      <label className="form-label">Taux Fixe (%)</label>
                      <input type="number" step="0.1" name="tauxFixe" defaultValue={comm.tauxFixe} className="form-input" />
                    </div>
                    <div className="form-group mb-0">
                      <label className="form-label">Bonus Avance (%)</label>
                      <input type="number" step="0.1" name="bonusHeure" defaultValue={comm.bonusHeure} className="form-input" />
                    </div>
                    <div className="form-group mb-0">
                      <label className="form-label">Malus Retard (%)</label>
                      <input type="number" step="0.1" name="malusHeure" defaultValue={comm.malusHeure} className="form-input" />
                    </div>
                    <button className="btn btn-primary w-full">Mettre à jour</button>
                  </form>
                </div>
              );
            })}
          </div>
          </div>
        </>
      )}

      {activeTab === 'performances' && userRole === 'ADMIN' && (
        <div className="card">
          <h2 className="mb-4 text-primary-dark">Performances & Statistiques des Conducteurs</h2>
          <p className="text-sm text-muted mb-4">Classement par marge commerciale générée (calculé côté serveur).</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 text-xs uppercase text-gray-500 border-b border-gray-100">
                  <th className="px-4 py-3 font-semibold">#</th>
                  <th className="px-4 py-3 font-semibold">Conducteur</th>
                  <th className="px-4 py-3 font-semibold text-center">Chantiers</th>
                  <th className="px-4 py-3 font-semibold text-right">CA Vendu</th>
                  <th className="px-4 py-3 font-semibold text-right">Marge générée</th>
                  <th className="px-4 py-3 font-semibold text-right">Marge %</th>
                  <th className="px-4 py-3 font-semibold text-right">Remplissage h.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {perf.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400 italic">Aucune donnée (aucun chantier affecté à un conducteur).</td></tr>
                ) : perf.map((p, i) => (
                  <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-bold text-gray-400">{i + 1}</td>
                    <td className="px-4 py-3 font-bold text-gray-800">{p.name}</td>
                    <td className="px-4 py-3 text-center">{p.nbChantiers}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{Math.round(p.caTotal).toLocaleString()} €</td>
                    <td className={`px-4 py-3 text-right font-bold ${p.margeTotal >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{Math.round(p.margeTotal).toLocaleString()} €</td>
                    <td className="px-4 py-3 text-right text-gray-600">{(p.margePct ?? 0).toFixed(1)}%</td>
                    <td className="px-4 py-3 text-right text-gray-600">{(p.tauxRemplissageHeures ?? 0).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'utilisateurs' && userRole === 'ADMIN' && (
        <div className="card">
          <h2 className="mb-4 text-primary-dark">Gestion des Comptes Utilisateurs (SSO & Local)</h2>
          <p className="mb-6 text-sm text-gray-600">
            Par défaut, les nouveaux utilisateurs se connectant via le SSO Microsoft se voient attribuer le rôle de <strong>Conducteur de Travaux</strong>. Vous pouvez les promouvoir en Administrateur ici.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse bg-white border rounded">
              <thead>
                <tr className="bg-gray-50 text-xs uppercase text-gray-500 border-b border-gray-100">
                  <th className="px-6 py-4 font-semibold">Nom</th>
                  <th className="px-6 py-4 font-semibold">Email</th>
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
                    <td className="px-6 py-4 text-right">
                      <button 
                        onClick={() => handlePasswordChange(u.id, u.name)}
                        className="text-sm px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded transition-colors"
                      >
                        Changer Mdp
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
