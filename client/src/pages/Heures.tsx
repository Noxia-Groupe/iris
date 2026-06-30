import { useState, useEffect } from 'react';

const API_URL = 'http://localhost:3001/api';

const Heures = () => {
  const [heures, setHeures] = useState<any[]>([]);
  const [chantiers, setChantiers] = useState<any[]>([]);
  const [intervenants, setIntervenants] = useState<any[]>([]);
  
  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    const [heuresRes, chantiersRes, intervRes] = await Promise.all([
      fetch(`${API_URL}/heures`),
      fetch(`${API_URL}/chantiers`),
      fetch(`${API_URL}/intervenants`)
    ]);
    
    setHeures(await heuresRes.json());
    setChantiers(await chantiersRes.json());
    setIntervenants(await intervRes.json());
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    const data = Object.fromEntries(formData.entries());
    
    await fetch(`${API_URL}/heures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    
    (e.target as HTMLFormElement).reset();
    fetchData();
  };

  const getHeuresRealisees = (chantierId: string) => {
    return heures
      .filter(h => h.chantierId === chantierId)
      .reduce((acc, h) => acc + h.nbrHeures, 0);
  };

  return (
    <div>
      <h1 className="text-primary font-bold mb-4">Journal des Heures</h1>
      
      <div className="flex flex-col md:flex-row gap-4 mb-4">
        {chantiers.slice(0, 3).map(c => {
          const realisees = getHeuresRealisees(c.id);
          const percent = c.heuresVendues > 0 ? (realisees / c.heuresVendues) * 100 : 0;
          return (
            <div key={c.id} className="card flex-1">
              <h3 className="mb-2 truncate text-primary-dark" title={c.nom}>{c.nom}</h3>
              <div className="flex justify-between text-sm mb-1">
                <span>{realisees}h réalisées</span>
                <span>{c.heuresVendues}h vendues</span>
              </div>
              <div style={{ width: '100%', height: '8px', backgroundColor: 'var(--color-gray-light)', borderRadius: '4px' }}>
                <div style={{ 
                  width: `${Math.min(100, percent)}%`, 
                  height: '100%', 
                  backgroundColor: percent > 100 ? 'var(--color-danger)' : 'var(--color-success)',
                  borderRadius: '4px'
                }}></div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="card mb-4">
        <h2 className="mb-4">Pointer des Heures</h2>
        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-4 items-start sm:items-end flex-wrap">
          <div className="form-group mb-0 w-full sm:w-auto" style={{flex: '1 1 150px'}}>
            <label className="form-label">Date</label>
            <input required type="date" name="date" className="form-input" />
          </div>
          <div className="form-group mb-0" style={{flex: '1 1 200px'}}>
            <label className="form-label">Intervenant</label>
            <select required name="intervenantId" className="form-input">
              <option value="">Sélectionner...</option>
              {intervenants.map(i => <option key={i.id} value={i.id}>{i.nom} ({i.role})</option>)}
            </select>
          </div>
          <div className="form-group mb-0" style={{flex: '1 1 200px'}}>
            <label className="form-label">Chantier</label>
            <select required name="chantierId" className="form-input">
              <option value="">Sélectionner...</option>
              {chantiers.map(c => <option key={c.id} value={c.id}>{c.nom}</option>)}
            </select>
          </div>
          <div className="form-group mb-0 w-full sm:w-auto" style={{flex: '1 1 150px'}}>
            <label className="form-label">Nombre d'heures (h)</label>
            <input required type="number" step="0.5" min="0.5" name="nbrHeures" className="form-input" />
          </div>
          <div className="form-group mb-0 w-full sm:w-auto" style={{flex: '2 1 200px'}}>
            <label className="form-label">Commentaire (Optionnel)</label>
            <input type="text" name="commentaire" className="form-input" placeholder="Travaux effectués..." />
          </div>
          <button className="btn btn-primary w-full sm:w-auto" style={{flex: '1 1 100%'}}>Enregistrer le pointage</button>
        </form>
      </div>

      <div className="card">
        <h3 className="mb-4">Historique des Pointages</h3>
        <div className="overflow-x-auto">
          <table style={{width: '100%', minWidth: '600px', textAlign: 'left', borderCollapse: 'collapse'}}>
            <thead>
              <tr style={{borderBottom: '1px solid var(--color-border)'}}>
              <th style={{padding: '8px'}}>Date</th>
              <th style={{padding: '8px'}}>Chantier</th>
              <th style={{padding: '8px'}}>Intervenant</th>
              <th style={{padding: '8px'}}>Heures Effectuées</th>
              <th style={{padding: '8px', textAlign: 'right'}}>Coût Interne Calculé</th>
            </tr>
          </thead>
          <tbody>
            {heures.map(h => (
              <tr key={h.id} style={{borderBottom: '1px solid var(--color-border)'}}>
                <td style={{padding: '8px'}}>{new Date(h.date).toLocaleDateString()}</td>
                <td style={{padding: '8px'}}>{h.chantier?.nom}</td>
                <td style={{padding: '8px'}}>{h.intervenant?.nom}</td>
                <td style={{padding: '8px'}}>{h.nbrHeures}h</td>
                <td style={{padding: '8px', textAlign: 'right', fontWeight: 'bold'}}>
                  {(h.nbrHeures * h.tauxHoraireApplique).toFixed(2)} €
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
};

export default Heures;
