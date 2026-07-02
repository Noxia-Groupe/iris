import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Building2, CheckCircle2, TrendingUp, Wallet, Clock3 } from 'lucide-react';
import { apiFetch } from '../api';
import { ProgressMeter } from '../components/ProgressMeter';

const Dashboard = () => {
  const [chantiers, setChantiers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalStats, setGlobalStats] = useState<any>(null);
  const navigate = useNavigate();

  // Rôle réel
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const userRole = user?.role || 'CONDUCTEUR_TRAVAUX';

  useEffect(() => {
    fetchChantiers();
    fetchGlobalStats();
  }, []);

  const fetchChantiers = async () => {
    try {
      const res = await apiFetch('/chantiers');
      const data = await res.json();
      setChantiers(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const fetchGlobalStats = async () => {
    try {
      const res = await apiFetch('/stats/global');
      if (res.ok) setGlobalStats(await res.json());
    } catch (e) {
      console.error(e);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-xl text-muted animate-pulse">Chargement des données...</div>
    </div>
  );

  const enCours = chantiers
    .filter(c => c.statut === 'EN_COURS')
    .sort((a, b) => (b.metrics?.pctHeures ?? 0) - (a.metrics?.pctHeures ?? 0));

  // Un chantier archivé n'a pas toujours de date de fin renseignée : on retombe
  // sur sa dernière modification (le passage au statut archivé la met à jour).
  const archiveDate = (c: any) => new Date(c.dateFin || c.updatedAt).getTime();
  const archives = chantiers
    .filter(c => c.statut !== 'EN_COURS')
    .sort((a, b) => archiveDate(b) - archiveDate(a));

  const fmtDate = (d: string) => new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });

  return (
    <div className="flex flex-col h-full overflow-x-hidden">

      {/* Header global */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-primary-dark m-0 leading-tight">Tableau de Bord</h1>
          <p className="text-sm text-muted mt-1">Suivi financier et opérationnel</p>
        </div>

        <div className="flex gap-1 items-center bg-gray-100 px-3 py-1.5 rounded-lg">
          <span className="text-sm font-semibold text-gray-500">
            Connecté en tant que: <strong className="text-primary-dark">{userRole === 'ADMIN' ? 'Admin' : 'Conducteur'}</strong>
          </span>
        </div>
      </div>

      {/* Bandeau statistiques globales (périmètre selon le rôle, calculé côté serveur) */}
      {globalStats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex items-start gap-3">
            <div className="p-2 rounded-lg bg-blue-50 text-accent"><Building2 size={18} /></div>
            <div>
              <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Chantiers en cours</div>
              <div className="text-2xl font-black text-primary-dark mt-0.5">
                {globalStats.nbEnCours} <span className="text-sm font-semibold text-gray-400">/ {globalStats.nbChantiers}</span>
              </div>
            </div>
          </div>
          <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex items-start gap-3">
            <div className="p-2 rounded-lg bg-purple-50 text-purple-600"><Clock3 size={18} /></div>
            <div>
              <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Remplissage heures</div>
              <div className="text-2xl font-black text-purple-600 mt-0.5">{(globalStats.tauxRemplissageHeures ?? 0).toFixed(0)}%</div>
              <div className="text-xs text-gray-400">{Math.round(globalStats.heuresRealisees)}h / {Math.round(globalStats.heuresVendues)}h</div>
            </div>
          </div>
          {globalStats.caTotal != null && (
            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex items-start gap-3">
              <div className="p-2 rounded-lg bg-blue-50 text-accent"><Wallet size={18} /></div>
              <div>
                <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">CA Vendu (total)</div>
                <div className="text-2xl font-black text-primary-dark mt-0.5">{globalStats.caTotal.toLocaleString()} €</div>
              </div>
            </div>
          )}
          {globalStats.margeTotal != null && (
            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex items-start gap-3">
              <div className={`p-2 rounded-lg ${globalStats.margeTotal >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}><TrendingUp size={18} /></div>
              <div>
                <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Marge totale</div>
                <div className={`text-2xl font-black mt-0.5 ${globalStats.margeTotal >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {globalStats.margeTotal.toLocaleString()} €
                </div>
                <div className="text-xs text-gray-400">{(globalStats.margePct ?? 0).toFixed(1)}%</div>
              </div>
            </div>
          )}
        </div>
      )}

      {chantiers.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
          <div className="text-6xl mb-4">🏗️</div>
          <h2 className="text-2xl font-bold text-gray-700 mb-2">Aucun chantier</h2>
          <p className="text-muted max-w-md">Créez votre premier chantier depuis la liste des chantiers ou l'administration.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">

          {/* Chantiers en cours — classés du plus avancé au moins avancé */}
          <div className="bg-white rounded-2xl shadow-md border border-gray-100 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Building2 size={18} className="text-accent" />
                <h2 className="text-lg font-bold text-primary-dark">Chantiers en cours</h2>
              </div>
              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">{enCours.length} chantier{enCours.length > 1 ? 's' : ''}</span>
            </div>

            {enCours.length === 0 ? (
              <div className="px-6 py-10 text-center text-gray-400 italic">Aucun chantier en cours pour le moment.</div>
            ) : (
              <div className="divide-y divide-gray-100">
                {enCours.map(c => {
                  const pct = c.metrics?.pctHeures ?? 0;
                  return (
                    <button
                      key={c.id}
                      onClick={() => navigate(`/chantiers/${c.id}`)}
                      className="w-full flex items-center gap-4 px-6 py-4 hover:bg-gray-50 transition-colors text-left group"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-gray-800 truncate group-hover:text-accent transition-colors">{c.nom}</div>
                        <div className="text-xs text-gray-400 mt-0.5 flex flex-wrap gap-x-3">
                          <span>{c.client}</span>
                          <span>Devis: {c.numeroDevis || 'N/A'}</span>
                          {c.responsable?.name && <span>Resp: {c.responsable.name}</span>}
                        </div>
                      </div>

                      <div className="hidden sm:flex flex-col items-end w-40 shrink-0">
                        <span className="text-sm font-black text-primary-dark">{pct.toFixed(0)}%</span>
                        <div className="w-full mt-1">
                          <ProgressMeter value={c.metrics?.heuresRealisees ?? 0} max={c.heuresVendues || 1} color="blue" size="sm" />
                        </div>
                      </div>
                      <span className="sm:hidden text-sm font-black text-primary-dark w-12 text-right">{pct.toFixed(0)}%</span>

                      <ChevronRight size={20} className="text-gray-300 group-hover:text-accent transition-colors shrink-0" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Chantiers terminés / archivés — classés du plus récemment archivé au plus ancien */}
          <div className="bg-white rounded-2xl shadow-md border border-gray-100 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={18} className="text-gray-400" />
                <h2 className="text-lg font-bold text-gray-500">Chantiers terminés / archivés</h2>
              </div>
              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">{archives.length} chantier{archives.length > 1 ? 's' : ''}</span>
            </div>

            {archives.length === 0 ? (
              <div className="px-6 py-10 text-center text-gray-400 italic">Aucun chantier archivé pour le moment.</div>
            ) : (
              <div className="divide-y divide-gray-100">
                {archives.map(c => (
                  <button
                    key={c.id}
                    onClick={() => navigate(`/chantiers/${c.id}`)}
                    className="w-full flex items-center gap-4 px-6 py-3.5 hover:bg-gray-50 transition-colors text-left group"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-gray-600 truncate group-hover:text-accent transition-colors">{c.nom}</div>
                      <div className="text-xs text-gray-400 mt-0.5 flex flex-wrap gap-x-3">
                        <span>{c.client}</span>
                        <span>Devis: {c.numeroDevis || 'N/A'}</span>
                      </div>
                    </div>
                    <span className="hidden sm:inline-block text-xs font-semibold text-gray-400 shrink-0">
                      Archivé le {fmtDate(c.dateFin || c.updatedAt)}
                    </span>
                    <span className="text-[11px] font-bold uppercase tracking-wide bg-gray-100 text-gray-500 px-2.5 py-1 rounded-full shrink-0">Terminé</span>
                    <ChevronRight size={20} className="text-gray-300 group-hover:text-accent transition-colors shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
};

export default Dashboard;
