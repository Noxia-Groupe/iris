import { useState, useEffect } from 'react';
import { TrendingUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { apiFetch } from '../api';

type Period = 'month' | 'year';

const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

const fmtJourMois = (isoDate: string) => {
  const [, m, d] = isoDate.split('-');
  return `${d}/${m}`;
};

const shiftRef = (ref: string, period: Period, dir: 1 | -1): string => {
  const d = new Date(ref + 'T00:00:00Z');
  if (period === 'month') d.setUTCMonth(d.getUTCMonth() + dir);
  else d.setUTCFullYear(d.getUTCFullYear() + dir);
  return d.toISOString().slice(0, 10);
};

const periodLabel = (period: Period, periodStart: string) => {
  const [y, m] = periodStart.split('-').map(Number);
  return period === 'year' ? `Année ${y}` : `${MOIS[m - 1]} ${y}`;
};

const STATUT_LABELS: Record<string, string> = { EN_COURS: 'En cours', TERMINE: 'Terminé' };

const ResultatCommercial = () => {
  const [period, setPeriod] = useState<Period>('month');
  const [ref, setRef] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    apiFetch(`/stats/commerciaux?period=${period}&ref=${ref}`)
      .then((res) => (res.ok ? res.json() : null))
      .then(setData)
      .catch(() => setData(null));
  }, [period, ref]);

  const moi = data?.commerciaux?.[0] || null;
  const chantiers = moi?.chantiers || [];

  return (
    <div>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-4 gap-4">
        <div>
          <h1 className="text-primary font-bold m-0 flex items-center gap-2"><TrendingUp size={24} /> Résultat Commercial</h1>
          <p className="text-sm text-muted mt-1">Chiffre d'affaires et marge commerciale de vos chantiers vendus.</p>
        </div>
      </div>

      <div className="card">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
            {(['month', 'year'] as Period[]).map((g) => (
              <button
                key={g}
                onClick={() => setPeriod(g)}
                className={`text-sm font-semibold px-3 py-1.5 rounded-md transition-colors ${period === g ? 'bg-white shadow-sm text-primary-dark' : 'text-gray-500 hover:text-gray-700'}`}
              >
                {g === 'month' ? 'Mois' : 'Année'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg p-1.5">
            <button type="button" onClick={() => setRef(shiftRef(ref, period, -1))} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500" title="Période précédente">
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-semibold text-gray-700 px-2 whitespace-nowrap min-w-[10rem] text-center">
              {data ? periodLabel(period, data.periodStart) : '…'}
            </span>
            <button type="button" onClick={() => setRef(shiftRef(ref, period, 1))} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500" title="Période suivante">
              <ChevronRight size={16} />
            </button>
            <button type="button" onClick={() => setRef(new Date().toISOString().slice(0, 10))} className="ml-1 text-xs font-semibold px-2 py-1.5 rounded-md hover:bg-gray-100 text-accent">
              Aujourd'hui
            </button>
          </div>
        </div>

        {!moi ? (
          <div className="text-center py-16 text-gray-400 italic">Chargement...</div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
              <div className="bg-gray-50 rounded-xl border border-gray-100 p-5">
                <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">CA vendu (période)</div>
                <div className="text-2xl font-black text-primary-dark">{Math.round(moi.caTotal).toLocaleString()} €</div>
              </div>
              <div className="bg-gray-50 rounded-xl border border-gray-100 p-5">
                <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">Marge commerciale (période)</div>
                <div className={`text-2xl font-black ${moi.margeTotal >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{Math.round(moi.margeTotal).toLocaleString()} €</div>
              </div>
              <div className="bg-gray-50 rounded-xl border border-gray-100 p-5">
                <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">Commission gagnée (période)</div>
                <div className="text-2xl font-black text-purple-600">{Math.round(moi.commissionTotal).toLocaleString()} €</div>
              </div>
            </div>

            <h3 className="mb-4 text-primary-dark">Mes chantiers</h3>
            {chantiers.length === 0 ? (
              <div className="text-center py-16">
                <div className="text-4xl mb-3 opacity-50">📋</div>
                <div className="text-gray-500 font-medium">Aucun chantier ne vous est rattaché pour le moment.</div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table style={{ width: '100%', minWidth: '700px', textAlign: 'left', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <th style={{ padding: '8px' }}>Chantier</th>
                      <th style={{ padding: '8px' }}>Client</th>
                      <th style={{ padding: '8px' }}>Statut</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>CA vendu</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Marge commerciale</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Commission</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chantiers.map((c: any) => (
                      <tr key={c.id} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '8px' }}>
                          <strong className="text-gray-800">{c.nom}</strong>
                          <div className="text-xs text-gray-400">{fmtJourMois(String(c.dateDebut).slice(0, 10))}</div>
                        </td>
                        <td style={{ padding: '8px' }} className="text-gray-600">{c.client}</td>
                        <td style={{ padding: '8px' }}>
                          <span className={`text-xs font-bold uppercase tracking-wide px-2 py-1 rounded-full ${c.statut === 'TERMINE' ? 'bg-gray-100 text-gray-500' : 'bg-blue-100 text-accent'}`}>
                            {STATUT_LABELS[c.statut] || c.statut}
                          </span>
                        </td>
                        <td style={{ padding: '8px', textAlign: 'right' }} className="font-bold text-gray-800">{Math.round(c.budgetGlobalVendu).toLocaleString()} €</td>
                        <td style={{ padding: '8px', textAlign: 'right' }} className={`font-bold ${(c.margeCommerciale ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                          {c.margeCommerciale != null ? `${Math.round(c.margeCommerciale).toLocaleString()} €` : '—'}
                        </td>
                        <td style={{ padding: '8px', textAlign: 'right' }} className="font-bold text-purple-600">
                          {c.commissionCommercial != null ? `${Math.round(c.commissionCommercial).toLocaleString()} €` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default ResultatCommercial;
