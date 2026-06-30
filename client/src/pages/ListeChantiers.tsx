import { useState, useEffect } from 'react';
import { apiFetch } from '../api';

const ListeChantiers = () => {
  const [chantiers, setChantiers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Rôle réel
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const userRole = user?.role || 'CONDUCTEUR_TRAVAUX';

  useEffect(() => {
    fetchChantiers();
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

  const handleZipExport = async (id: string, nom: string) => {
    try {
      const res = await apiFetch(`/chantiers/${id}/photos/export`);
      if (!res.ok) { alert("Export impossible"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `photos-${nom.replace(/\s+/g, '_')}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      alert("Export impossible");
    }
  };

  const handlePurge = async (id: string) => {
    if(!confirm("Purger TOUTES les photos de ce chantier ?")) return;
    try {
      await apiFetch(`/chantiers/${id}/photos/purge`, { method: 'DELETE' });
      fetchChantiers();
    } catch(e) {
      console.error(e);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-xl text-muted animate-pulse">Chargement des chantiers...</div>
    </div>
  );

  const renderTable = (list: any[], title: string, emptyMessage: string) => (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-8">
      <div className="bg-gray-50 border-b border-gray-100 px-6 py-4">
        <h2 className="text-lg font-bold text-primary-dark">{title}</h2>
      </div>
      
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-white text-xs uppercase text-gray-500 border-b border-gray-100">
              <th className="px-6 py-4 font-semibold">Chantier</th>
              <th className="px-6 py-4 font-semibold">Client</th>
              <th className="px-6 py-4 font-semibold text-center">Avancement</th>
              <th className="px-6 py-4 font-semibold text-right">
                {userRole === 'ADMIN' ? 'Marge Actuelle' : 'Solde Heures'}
              </th>
              {userRole === 'ADMIN' && (
                <th className="px-6 py-4 font-semibold text-right">Actions Photos</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {list.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-gray-400 italic">
                  {emptyMessage}
                </td>
              </tr>
            ) : list.map(c => {
              // Métriques calculées côté serveur (marge masquée pour les non-admins)
              const metrics = c.metrics || {};
              const heuresRealisees = metrics.heuresRealisees || 0;
              const diffHeures = metrics.diffHeures ?? (c.heuresVendues - heuresRealisees);
              const margeCommerciale: number | null = metrics.margeCommerciale ?? null;
              const progressPct = Math.min(100, Math.max(0, metrics.pctHeures ?? 0));

              return (
                <tr key={c.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4">
                    <div className="font-bold text-gray-800">{c.nom}</div>
                    <div className="text-xs text-gray-400">Devis: {c.numeroDevis || 'N/A'}</div>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">{c.client}</td>
                  <td className="px-6 py-4">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-24 h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${progressPct}%` }}></div>
                      </div>
                      <span className="text-xs font-semibold text-gray-500 w-8">{progressPct.toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    {userRole === 'ADMIN' ? (
                      margeCommerciale !== null ? (
                        <span className={`inline-block px-3 py-1 rounded-md font-bold text-sm ${margeCommerciale >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                          {margeCommerciale > 0 ? '+' : ''}{margeCommerciale.toLocaleString()} €
                        </span>
                      ) : (
                        <span className="text-gray-400 text-sm">—</span>
                      )
                    ) : (
                      <span className={`inline-block px-3 py-1 rounded-md font-bold text-sm ${diffHeures >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                        {diffHeures > 0 ? '+' : ''}{diffHeures} h
                      </span>
                    )}
                  </td>
                  {userRole === 'ADMIN' && (
                    <td className="px-6 py-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => handleZipExport(c.id, c.nom)}
                          className="p-2 text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
                          title="Télécharger Photos (ZIP)"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                        </button>
                        <button 
                          onClick={() => handlePurge(c.id)} 
                          className="p-2 text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors"
                          title="Purger Photos"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  const chantiersEnCours = chantiers.filter(c => c.statut === 'EN_COURS');
  const chantiersTermines = chantiers.filter(c => c.statut === 'TERMINE');

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      
      {/* Header global */}
      <div className="flex justify-between items-center mb-6 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-primary-dark m-0 leading-tight">Liste des Chantiers</h1>
          <p className="text-sm text-muted mt-1">Vue globale et gestion du stockage</p>
        </div>
        
        {/* Rôle actuel (Affichage uniquement) */}
        <div className="flex gap-1 items-center bg-gray-100 px-3 py-1.5 rounded-lg">
          <span className="text-sm font-semibold text-gray-500">
            Connecté en tant que: <strong className="text-primary-dark">{userRole === 'ADMIN' ? 'Admin' : 'Conducteur'}</strong>
          </span>
        </div>
      </div>

      <div className="flex-1">
        {renderTable(chantiersEnCours, "Chantiers En Cours", "Aucun chantier en cours.")}
        {renderTable(chantiersTermines, "Chantiers Terminés / Archivés", "Aucun chantier archivé.")}
      </div>

    </div>
  );
};

export default ListeChantiers;
