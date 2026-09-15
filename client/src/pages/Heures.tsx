import { useState, useEffect } from 'react';
import { apiFetch } from '../api';
import { SectionRepliable } from '../components/SectionRepliable';
import { useCompanyTimezone } from '../companyTimezoneContext';
import { companyDateInputValue, formatDateOnly } from '../lib/dateFormatting';

const Heures = () => {
  const companyTimezone = useCompanyTimezone();
  const [heures, setHeures] = useState<any[]>([]);
  const [chantiers, setChantiers] = useState<any[]>([]);
  const [intervenants, setIntervenants] = useState<any[]>([]);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    const [heuresRes, chantiersRes, intervRes] = await Promise.all([
      apiFetch('/heures'),
      apiFetch('/chantiers'),
      apiFetch('/intervenants')
    ]);
    
    setHeures(await heuresRes.json());
    setChantiers(await chantiersRes.json());
    setIntervenants(await intervRes.json());
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    const data = Object.fromEntries(formData.entries());
    
    await apiFetch('/heures', {
      method: 'POST',
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


  // Un chantier terminé ne peut plus recevoir d'heures : il ne figure pas dans le
  // sélecteur, pour personne (les admins corrigent l'historique depuis la fiche du
  // chantier, où les pointages existants restent modifiables).
  const chantiersSelectionnables = chantiers.filter(c => c.statut === 'EN_COURS');

  return (
    <div>
      <h1 className="text-primary font-bold mb-4">Journal des Heures</h1>
      
      <div className="flex flex-col md:flex-row gap-4 mb-4">
        {chantiersSelectionnables.slice(0, 3).map(c => {
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

      <div className="card mb-6 shadow-sm border-0 bg-white">
        <h2 className="mb-4 text-xl font-bold text-gray-800 flex items-center gap-2">
          <svg className="w-6 h-6 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
          Saisir des Heures
        </h2>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          <div className="flex flex-col">
            <label className="text-sm font-semibold text-gray-600 mb-1">Date</label>
            <input required type="text" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" name="date" defaultValue={companyDateInputValue(companyTimezone)} placeholder="JJ-MM-AAAA" className="p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all w-full" />
          </div>
          
          <div className="flex flex-col">
            <label className="text-sm font-semibold text-gray-600 mb-1">Intervenant</label>
            <select required name="intervenantId" className="p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all w-full bg-white">
              <option value="">Sélectionner un intervenant...</option>
              {intervenants.map(i => <option key={i.id} value={i.id}>{i.nom} ({i.role})</option>)}
            </select>
          </div>
          
          <div className="flex flex-col">
            <label className="text-sm font-semibold text-gray-600 mb-1">Chantier</label>
            <select required name="chantierId" className="p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all w-full bg-white">
              <option value="">Sélectionner un chantier...</option>
              {chantiersSelectionnables.map(c => (
                <option key={c.id} value={c.id}>{c.nom}{c.numeroDevis ? ` — ${c.numeroDevis}` : ''}</option>
              ))}
            </select>
          </div>
          
          <div className="flex flex-col">
            <label className="text-sm font-semibold text-gray-600 mb-1">Nombre d'heures (h)</label>
            <input required type="number" step="0.5" min="0.5" name="nbrHeures" placeholder="Ex: 3.5" className="p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all w-full" />
          </div>
          
          <div className="flex flex-col lg:col-span-2">
            <label className="text-sm font-semibold text-gray-600 mb-1">Commentaire (Optionnel)</label>
            <input type="text" name="commentaire" className="p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all w-full" placeholder="Travaux effectués, imprévus..." />
          </div>
          
          <div className="md:col-span-2 lg:col-span-3 mt-2">
            <button className="w-full bg-primary hover:bg-primary-dark text-white font-bold py-4 px-6 rounded-xl transition-colors shadow-md text-lg">
              Enregistrer le pointage
            </button>
          </div>
        </form>
      </div>

      {/* Historique replié par défaut : la page sert d'abord à SAISIR un pointage, le
          formulaire doit rester la première chose visible. L'historique s'ouvre d'un clic. */}
      <SectionRepliable
        headerClassName="pb-3 mb-4"
        titre={<h3 className="text-xl font-bold text-gray-800 m-0">Historique récent</h3>}
        resume={
          <span className="text-xs font-bold text-gray-400 uppercase tracking-wider shrink-0">
            {heures.length} pointage{heures.length > 1 ? 's' : ''}
          </span>
        }
      >
      <div>
        {/* Vue Mobile : Cartes */}
        <div className="grid grid-cols-1 gap-4 md:hidden">
          {heures.slice().reverse().map(h => (
            <div key={h.id} className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-col gap-2">
              <div className="flex justify-between items-start border-b border-gray-50 pb-2">
                <span className="font-bold text-gray-800">{h.chantier?.nom}</span>
                <span className="text-xs font-semibold text-gray-500 bg-gray-100 px-2 py-1 rounded-md">{formatDateOnly(h.date)}</span>
              </div>
              <div className="flex justify-between items-center mt-1">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-xs">
                    {h.intervenant?.nom?.substring(0, 2).toUpperCase()}
                  </div>
                  <span className="text-sm text-gray-600">{h.intervenant?.nom}</span>
                </div>
                <div className="flex flex-col items-end">
                  <span className="font-extrabold text-primary text-lg">{h.nbrHeures}h</span>
                </div>
              </div>
              {h.commentaire && (
                <p className="text-xs text-gray-500 italic mt-1 bg-gray-50 p-2 rounded-md">"{h.commentaire}"</p>
              )}
            </div>
          ))}
        </div>

        {/* Vue Desktop : Tableau */}
        <div className="hidden md:block bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-50 text-xs uppercase text-gray-500 border-b border-gray-100">
                <th className="px-6 py-4">Date</th>
                <th className="px-6 py-4">Chantier</th>
                <th className="px-6 py-4">Intervenant</th>
                <th className="px-6 py-4">Heures</th>
                <th className="px-6 py-4 text-right">Coût Interne</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {heures.slice().reverse().map(h => (
                <tr key={h.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4 text-sm text-gray-600">{formatDateOnly(h.date)}</td>
                  <td className="px-6 py-4 font-semibold text-gray-800">{h.chantier?.nom}</td>
                  <td className="px-6 py-4 text-sm text-gray-600">{h.intervenant?.nom}</td>
                  <td className="px-6 py-4 font-bold text-primary">{h.nbrHeures}h</td>
                  <td className="px-6 py-4 text-sm font-semibold text-gray-500 text-right">
                    {(h.nbrHeures * h.tauxHoraireApplique).toFixed(2)} €
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </SectionRepliable>
    </div>
  );
};

export default Heures;
