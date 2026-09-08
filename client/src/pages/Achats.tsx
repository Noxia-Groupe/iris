import { useState, useEffect } from 'react';
import { apiFetch } from '../api';
import { isAdminRole } from '../roles';

const dateFrancaiseDuJour = () => {
  const maintenant = new Date();
  return `${String(maintenant.getDate()).padStart(2, '0')}-${String(maintenant.getMonth() + 1).padStart(2, '0')}-${maintenant.getFullYear()}`;
};

const Achats = () => {
  const [achats, setAchats] = useState<any[]>([]);
  const [chantiers, setChantiers] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [fournisseurs, setFournisseurs] = useState<any[]>([]);

  // Rôle réel
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const userRole = user?.role || 'CONDUCTEUR_TRAVAUX';

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    const [achatsRes, chantiersRes, categoriesRes, fournRes] = await Promise.all([
      apiFetch('/achats'),
      apiFetch('/chantiers'),
      apiFetch('/categories'),
      apiFetch('/fournisseurs')
    ]);
    
    setAchats(await achatsRes.json());
    setChantiers(await chantiersRes.json());
    setCategories(await categoriesRes.json());
    setFournisseurs(await fournRes.json());
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    const data = Object.fromEntries(formData.entries());
    
    await apiFetch('/achats', {
      method: 'POST',
      body: JSON.stringify(data)
    });

    (e.target as HTMLFormElement).reset();
    fetchData();
  };

  // Un chantier clôturé est en lecture seule pour un conducteur : on ne le propose
  // plus à la saisie (un admin, lui, garde la main pour corriger l'historique).
  const chantiersSelectionnables = isAdminRole(userRole) ? chantiers : chantiers.filter(c => c.statut === 'EN_COURS');

  return (
    <div>
      <h1 className="text-primary font-bold mb-4">Journal des Achats</h1>
      
      <div className="card mb-4">
        <h2 className="mb-4">Saisir une Facture / Dépense</h2>
        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-4 items-start sm:items-end flex-wrap">
          <div className="form-group mb-0 w-full sm:w-auto" style={{flex: '1 1 150px'}}>
            <label className="form-label">Date de facture</label>
            <input required type="text" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" name="date" defaultValue={dateFrancaiseDuJour()} placeholder="JJ-MM-AAAA" className="form-input" />
          </div>
          <div className="form-group mb-0" style={{flex: '1 1 200px'}}>
            <label className="form-label">Fournisseur</label>
            <select required name="fournisseurId" className="form-input">
              <option value="">Sélectionner...</option>
              {fournisseurs.map(f => <option key={f.id} value={f.id}>{f.nom}</option>)}
            </select>
          </div>
          <div className="form-group mb-0" style={{flex: '1 1 150px'}}>
            <label className="form-label">N° Facture (Optionnel)</label>
            <input name="numeroFacture" className="form-input" placeholder="Ex: FA-2023-01" />
          </div>
          <div className="form-group mb-0" style={{flex: '2 1 300px'}}>
            <label className="form-label">Libellé de la dépense</label>
            <input required name="description" className="form-input" placeholder="Achats matériaux divers..." />
          </div>
          <div className="form-group mb-0" style={{flex: '1 1 150px'}}>
            <label className="form-label">Chantier d'affectation</label>
            <select required name="chantierId" className="form-input">
              <option value="">Sélectionner...</option>
              {chantiersSelectionnables.map(c => <option key={c.id} value={c.id}>{c.nom}{c.statut === 'TERMINE' ? ' (Terminé)' : ''}</option>)}
            </select>
          </div>
          <div className="form-group mb-0" style={{flex: '1 1 150px'}}>
            <label className="form-label">Type de dépense</label>
            <select required name="categorieId" className="form-input">
              <option value="">Sélectionner...</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.nom}</option>)}
            </select>
          </div>
          <div className="form-group mb-0" style={{flex: '1 1 150px'}}>
            <label className="form-label">Montant (€ HT)</label>
            <input required type="number" step="0.01" name="montantHT" className="form-input" />
          </div>
          <button className="btn btn-primary" style={{flex: '1 1 100%'}}>Enregistrer l'achat</button>
        </form>
      </div>

      <div className="card">
        <h3 className="mb-4">Historique des Achats</h3>
        <div className="overflow-x-auto">
          <table style={{width: '100%', minWidth: '600px', textAlign: 'left', borderCollapse: 'collapse'}}>
            <thead>
              <tr style={{borderBottom: '1px solid var(--color-border)'}}>
              <th style={{padding: '8px'}}>Date</th>
              <th style={{padding: '8px'}}>Chantier</th>
              <th style={{padding: '8px'}}>Fournisseur</th>
              <th style={{padding: '8px'}}>N° Facture</th>
              <th style={{padding: '8px'}}>Libellé</th>
              <th style={{padding: '8px'}}>Type</th>
              <th style={{padding: '8px', textAlign: 'right'}}>Montant (€ HT)</th>
            </tr>
          </thead>
          <tbody>
            {achats.map(a => (
              <tr key={a.id} style={{borderBottom: '1px solid var(--color-border)'}}>
                <td style={{padding: '8px'}}>{new Date(a.date).toLocaleDateString()}</td>
                <td style={{padding: '8px'}}>{a.chantier?.nom}</td>
                <td style={{padding: '8px'}}>{a.fournisseur?.nom}</td>
                <td style={{padding: '8px'}}>{a.numeroFacture || '-'}</td>
                <td style={{padding: '8px'}}>{a.description}</td>
                <td style={{padding: '8px'}}>{a.categorie?.nom}</td>
                <td style={{padding: '8px', textAlign: 'right', fontWeight: 'bold'}}>{a.montantHT.toLocaleString()} €</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
};

export default Achats;
