import { useState, useEffect } from 'react';
import { Award } from 'lucide-react';
import { apiFetch } from '../api';

const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

const periodLabelComm = (period: 'month' | 'year', periodStart: string) => {
  const [y, m] = periodStart.split('-').map(Number);
  return period === 'year' ? `Année ${y}` : `${MOIS[m - 1]} ${y}`;
};

const shiftCommRef = (ref: string, period: 'month' | 'year', dir: 1 | -1): string => {
  const d = new Date(ref + 'T00:00:00Z');
  if (period === 'month') d.setUTCMonth(d.getUTCMonth() + dir);
  else d.setUTCFullYear(d.getUTCFullYear() + dir);
  return d.toISOString().slice(0, 10);
};

// Suivi des commerciaux (CA vendu, marge, commission) — page réservée aux administrateurs
// (extraite de l'onglet « Mes Commerciaux » d'Administration pour être son propre menu,
// cf. Sidebar.tsx). Route protégée côté client (PrivateRoute requiredRole) et données
// servies protégées côté serveur (requireAdmin / requireAuth selon la route).
const MesCommerciaux = () => {
  const [commerciaux, setCommerciaux] = useState<any[]>([]);
  const [commerciauxMeta, setCommerciauxMeta] = useState<any>(null);
  const [commerciauxPeriod, setCommerciauxPeriod] = useState<'month' | 'year'>('month');
  const [commerciauxRef, setCommerciauxRef] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [expandedCommercialId, setExpandedCommercialId] = useState<string | null>(null);

  useEffect(() => {
    fetchCommerciaux();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commerciauxPeriod, commerciauxRef]);

  const fetchCommerciaux = async () => {
    try {
      const res = await apiFetch(`/stats/commerciaux?period=${commerciauxPeriod}&ref=${commerciauxRef}`);
      if (res.ok) {
        const data = await res.json();
        setCommerciaux(data.commerciaux || []);
        setCommerciauxMeta(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleCommissionCommercialSubmit = async (e: React.FormEvent, chantierId: string) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    const data = Object.fromEntries(formData.entries());

    const payload = {
      mode: data.mode,
      tauxFixe: parseFloat(data.tauxFixe as string) || 0,
      bonusHeure: parseFloat(data.bonusHeure as string) || 0,
      malusHeure: parseFloat(data.malusHeure as string) || 0
    };

    await apiFetch(`/chantiers/${chantierId}/commissionnement-commercial`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    alert('Règles de commission commerciale mises à jour');
    fetchCommerciaux();
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-primary-dark m-0 flex items-center gap-2"><Award size={22} /> Mes Commerciaux</h1>
          <p className="text-sm text-muted mt-1">
            Classés par chiffre d'affaires vendu (mois ou année civile en cours, navigable). Visible uniquement par les administrateurs.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
            {(['month', 'year'] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setCommerciauxPeriod(g)}
                className={`text-sm font-semibold px-3 py-1.5 rounded-md transition-colors ${commerciauxPeriod === g ? 'bg-white shadow-sm text-primary-dark' : 'text-gray-500 hover:text-gray-700'}`}
              >
                {g === 'month' ? 'Mois' : 'Année'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg p-1.5">
            <button type="button" onClick={() => setCommerciauxRef(shiftCommRef(commerciauxRef, commerciauxPeriod, -1))} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500 font-bold" title="Période précédente">‹</button>
            <span className="text-sm font-semibold text-gray-700 px-2 whitespace-nowrap">
              {commerciauxMeta ? periodLabelComm(commerciauxPeriod, commerciauxMeta.periodStart) : '…'}
            </span>
            <button type="button" onClick={() => setCommerciauxRef(shiftCommRef(commerciauxRef, commerciauxPeriod, 1))} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500 font-bold" title="Période suivante">›</button>
            <button type="button" onClick={() => setCommerciauxRef(new Date().toISOString().slice(0, 10))} className="ml-1 text-xs font-semibold px-2 py-1.5 rounded-md hover:bg-gray-100 text-accent">Aujourd'hui</button>
          </div>
        </div>
      </div>

      {commerciaux.length === 0 ? (
        <div className="card text-center py-12 text-gray-400 italic">
          Aucun commercial enregistré (menu Administration &gt; Utilisateurs pour en autoriser un).
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {commerciaux.map((c, i) => {
            const isExpanded = expandedCommercialId === c.id;
            return (
              <div key={c.id} className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
                <div
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 cursor-pointer"
                  onClick={() => setExpandedCommercialId(isExpanded ? null : c.id)}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gray-100 text-gray-500 font-bold text-sm flex items-center justify-center shrink-0">#{i + 1}</div>
                    <div>
                      <div className="font-bold text-gray-800">{c.name}</div>
                      <div className="text-xs text-muted">{c.email} · {c.nbChantiers} chantier{c.nbChantiers > 1 ? 's' : ''}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">CA vendu</div>
                      <div className="font-bold text-gray-800">{Math.round(c.caTotal).toLocaleString()} €</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Marge</div>
                      <div className={`font-bold ${c.margeTotal >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{Math.round(c.margeTotal).toLocaleString()} €</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Commission</div>
                      <div className="font-bold text-purple-600">{Math.round(c.commissionTotal).toLocaleString()} €</div>
                    </div>
                    <span className="text-gray-400 text-xs">{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="mt-4 pt-4 border-t border-gray-100 flex flex-col gap-4">
                    {c.chantiers.length === 0 ? (
                      <div className="text-sm text-gray-400 italic">Aucun chantier rattaché.</div>
                    ) : c.chantiers.map((ch: any) => {
                      const comm = ch.commissionnementCommercial || { mode: 'FIXE', tauxFixe: 0, bonusHeure: 0, malusHeure: 0 };
                      return (
                        <div key={ch.id} className="p-4 border rounded bg-gray-50">
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="font-bold text-gray-800 m-0">{ch.nom} <span className="text-sm font-normal text-muted">({ch.client})</span></h4>
                            <span className="text-xs font-bold uppercase px-2 py-1 rounded-full bg-gray-100 text-gray-500">{ch.statut === 'TERMINE' ? 'Terminé' : 'En cours'}</span>
                          </div>
                          <div className="grid grid-cols-3 gap-3 mb-4 text-sm">
                            <div><span className="text-gray-400">CA vendu : </span><strong className="text-gray-800">{Math.round(ch.budgetGlobalVendu).toLocaleString()} €</strong></div>
                            <div><span className="text-gray-400">Marge : </span><strong className={(ch.margeCommerciale ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}>{ch.margeCommerciale != null ? `${Math.round(ch.margeCommerciale).toLocaleString()} €` : '—'}</strong></div>
                            <div><span className="text-gray-400">Commission : </span><strong className="text-purple-600">{ch.commissionCommercial != null ? `${Math.round(ch.commissionCommercial).toLocaleString()} €` : '—'}</strong></div>
                          </div>
                          <form onSubmit={(e) => handleCommissionCommercialSubmit(e, ch.id)} className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
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
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default MesCommerciaux;
