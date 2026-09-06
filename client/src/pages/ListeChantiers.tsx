import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Archive, RotateCcw, Filter } from 'lucide-react';
import { apiFetch } from '../api';
import { SectionRepliable } from '../components/SectionRepliable';
import { isAdminRole, roleLabel } from '../roles';

const ListeChantiers = () => {
  const navigate = useNavigate();
  const [chantiers, setChantiers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterMaterielDepasse, setFilterMaterielDepasse] = useState(false);
  const [filterHeuresDepasse, setFilterHeuresDepasse] = useState(false);

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

  // Clôturer un chantier (en cours -> terminé) : possible pour son responsable ou un
  // admin. Une fois clôturé, plus aucune heure ni dépense ne peut y être ajoutée.
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

  // `repliable` : la liste des chantiers archivés est masquée tant qu'on ne l'ouvre pas,
  // pour ne pas noyer les chantiers en cours sous des dossiers clos.
  const renderTable = (list: any[], title: string, emptyMessage: string, repliable = false) => {
    const tableau = (
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-white text-xs uppercase text-gray-500 border-b border-gray-100">
              <th className="px-6 py-4 font-semibold">Chantier</th>
              <th className="px-6 py-4 font-semibold">Client</th>
              <th className="px-6 py-4 font-semibold text-center">Avancement</th>
              <th className="px-6 py-4 font-semibold text-right">
                {isAdminRole(userRole) ? 'Marge Actuelle' : 'Solde Heures'}
              </th>
              <th className="px-6 py-4 font-semibold text-right">Actions</th>
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
                <tr
                  key={c.id}
                  onClick={() => navigate(`/chantiers/${c.id}`)}
                  className="hover:bg-gray-50 transition-colors cursor-pointer"
                >
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
                    {isAdminRole(userRole) ? (
                      margeCommerciale !== null ? (
                        <span className={`inline-block px-3 py-1 rounded-md font-bold text-sm ${margeCommerciale >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                          {margeCommerciale > 0 ? '+' : ''}{margeCommerciale.toLocaleString()} €
                        </span>
                      ) : (
                        <span className="text-gray-400 text-sm">—</span>
                      )
                    ) : (
                      <span className={`inline-block px-3 py-1 rounded-md font-bold text-sm ${diffHeures >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                        {diffHeures > 0 ? '+' : ''}{diffHeures.toFixed(2)} h
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end items-center gap-2">
                      {c.statut === 'EN_COURS' && userRole !== 'COMMERCIAL' && (
                        <button
                          onClick={() => handleCloturer(c.id, c.nom)}
                          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg transition-colors"
                          title="Clôturer le chantier"
                        >
                          <Archive size={14} /> Clôturer
                        </button>
                      )}
                      {c.statut === 'TERMINE' && isAdminRole(userRole) && (
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
            <div className="bg-gray-50 border-b border-gray-100 px-6 py-4">
              <h2 className="text-lg font-bold text-primary-dark">{title}</h2>
            </div>
            {tableau}
          </>
        )}
      </div>
    );
  };

  // Filtres de dépassement — appliqués aux deux tableaux (en cours et terminés/archivés).
  const matchesFilters = (c: any) => {
    const metrics = c.metrics || {};
    if (filterMaterielDepasse && !((metrics.materielReel || 0) > (c.budgetMaterielVendu || 0))) return false;
    if (filterHeuresDepasse && !((metrics.heuresRealisees || 0) > (c.heuresVendues || 0))) return false;
    return true;
  };

  const chantiersEnCours = chantiers.filter(c => c.statut === 'EN_COURS').filter(matchesFilters);
  const chantiersTermines = chantiers.filter(c => c.statut === 'TERMINE').filter(matchesFilters);
  const filtresActifs = filterMaterielDepasse || filterHeuresDepasse;

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      
      {/* Header global */}
      <div className="flex justify-between items-center mb-6 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-primary-dark m-0 leading-tight">Liste des Chantiers</h1>
          <p className="text-sm text-muted mt-1">Vue globale et gestion du stockage</p>
        </div>
        
        <div className="flex items-center gap-3">
          {userRole !== 'COMMERCIAL' && (
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


      <div className="flex flex-wrap items-center gap-3 mb-6 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <span className="text-sm font-semibold text-gray-500 flex items-center gap-2"><Filter size={16} /> Filtrer :</span>
        <label className={`flex items-center gap-2 text-sm font-semibold px-3 py-1.5 rounded-lg cursor-pointer border transition-colors ${filterMaterielDepasse ? 'bg-red-50 border-red-200 text-red-700' : 'bg-gray-50 border-transparent text-gray-600 hover:bg-gray-100'}`}>
          <input type="checkbox" checked={filterMaterielDepasse} onChange={(e) => setFilterMaterielDepasse(e.target.checked)} className="w-4 h-4" />
          Budget matériel dépassé
        </label>
        <label className={`flex items-center gap-2 text-sm font-semibold px-3 py-1.5 rounded-lg cursor-pointer border transition-colors ${filterHeuresDepasse ? 'bg-red-50 border-red-200 text-red-700' : 'bg-gray-50 border-transparent text-gray-600 hover:bg-gray-100'}`}>
          <input type="checkbox" checked={filterHeuresDepasse} onChange={(e) => setFilterHeuresDepasse(e.target.checked)} className="w-4 h-4" />
          Heures prévues dépassées
        </label>
        {filtresActifs && (
          <button onClick={() => { setFilterMaterielDepasse(false); setFilterHeuresDepasse(false); }} className="text-xs font-semibold text-accent hover:underline ml-auto">
            Réinitialiser
          </button>
        )}
      </div>

      <div className="flex-1">
        {renderTable(chantiersEnCours, "Chantiers En Cours", filtresActifs ? "Aucun chantier en cours ne correspond aux filtres." : "Aucun chantier en cours.")}
        {renderTable(chantiersTermines, "Chantiers Terminés / Archivés", filtresActifs ? "Aucun chantier archivé ne correspond aux filtres." : "Aucun chantier archivé.", true)}
      </div>

    </div>
  );
};

export default ListeChantiers;
