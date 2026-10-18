import { useState, useEffect } from 'react';
import { TrendingUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { apiFetch } from '../api';
import { decalerReference, jourCivilChantier } from '../lib/dateFormatting';
import { useReferencePeriode } from '../lib/referencePeriode';
import { useCompanyTimezone } from '../companyTimezoneContext';
import { AvisSansPlanCommercial } from '../components/AvisSansPlanCommercial';
import { arrondiEuro } from '../lib/montants';

type Period = 'month' | 'quarter' | 'year';

const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

const periodLabel = (period: Period, periodStart: string) => {
  const [y, m] = periodStart.split('-').map(Number);
  if (period === 'year') return `Année ${y}`;
  if (period === 'quarter') return `T${Math.ceil(m / 3)} ${y}`;
  return `${MOIS[m - 1]} ${y}`;
};

const fmtEuro = (n: number) => `${arrondiEuro(n).toLocaleString()} €`;

const STATUT_LABELS: Record<string, string> = { EN_COURS: 'En cours', TERMINE: 'Terminé' };

const ResultatCommercial = () => {
  const fuseau = useCompanyTimezone();
  const [period, setPeriod] = useState<Period>('month');
  const [ref, setRef] = useReferencePeriode();
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    // Une réponse dépassée (période changée, ou fuseau de la société lu entre-temps) est ignorée.
    let actuelle = true;
    apiFetch(`/stats/commerciaux?period=${period}&ref=${ref}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((donnees) => { if (actuelle) setData(donnees); })
      .catch(() => { if (actuelle) setData(null); });
    return () => { actuelle = false; };
  }, [period, ref]);

  const moi = data?.commerciaux?.[0] || null;
  const chantiers = moi?.chantiers || [];

  return (
    <div>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-4 gap-4">
        <div>
          <h1 className="text-primary font-bold m-0 flex items-center gap-2"><TrendingUp size={24} /> Résultat Commercial</h1>
          <p className="text-sm text-muted mt-1">Chiffre d'affaires, marge et rémunération variable de vos chantiers vendus.</p>
        </div>
      </div>

      <div className="card">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
            {(['month', 'quarter', 'year'] as Period[]).map((g) => (
              <button
                key={g}
                onClick={() => setPeriod(g)}
                className={`text-sm font-semibold px-3 py-1.5 rounded-md transition-colors ${period === g ? 'bg-white shadow-sm text-primary-dark' : 'text-gray-500 hover:text-gray-700'}`}
              >
                {g === 'month' ? 'Mois' : g === 'quarter' ? 'Trimestre' : 'Année'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg p-1.5">
            <button type="button" onClick={() => setRef(decalerReference(ref, period, -1))} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500" title="Période précédente">
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-semibold text-gray-700 px-2 whitespace-nowrap min-w-[10rem] text-center">
              {data ? periodLabel(period, data.periodStart) : '…'}
            </span>
            <button type="button" onClick={() => setRef(decalerReference(ref, period, 1))} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500" title="Période suivante">
              <ChevronRight size={16} />
            </button>
            <button type="button" onClick={() => setRef(null)} className="ml-1 text-xs font-semibold px-2 py-1.5 rounded-md hover:bg-gray-100 text-accent">
              Aujourd'hui
            </button>
          </div>
        </div>

        {!moi ? (
          <div className="text-center py-16 text-gray-400 italic">Chargement...</div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
              <div className="bg-gray-50 rounded-xl border border-gray-100 p-5">
                <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">CA vendu (validé, période)</div>
                <div className="text-2xl font-black text-primary-dark">{fmtEuro(moi.caTotal)}</div>
              </div>
              <div className="bg-gray-50 rounded-xl border border-gray-100 p-5">
                <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">Marge commerciale (validée, période)</div>
                <div className={`text-2xl font-black ${moi.margeTotal >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{fmtEuro(moi.margeTotal)}</div>
              </div>
              <div className="bg-gray-50 rounded-xl border border-gray-100 p-5">
                <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">Rémunération variable (période)</div>
                <div className="text-2xl font-black text-purple-600">{fmtEuro(moi.commissionTotal)}</div>
                {moi.sansPlanCommercial && <div className="text-xs text-gray-400">Aucun plan commercial attribué</div>}
              </div>
            </div>

            <p className="text-xs text-gray-400 mb-6 italic">
              Seuls les chantiers Terminés et Encaissés comptent dans ces totaux —
              cf. colonne « Statut » ci-dessous.
            </p>

            {/* Sans plan commercial, ni barème ni primes : le serveur n'en applique aucun. */}
            {moi.sansPlanCommercial && (
              <AvisSansPlanCommercial className="mb-8">
                Le barème et les primes ne s'appliquent pas ; vos commissions courront à partir de la date
                d'attribution d'un plan commercial. Le chiffre d'affaires et la marge restent suivis.
              </AvisSansPlanCommercial>
            )}

            <h3 className="mb-4 text-primary-dark">Mes chantiers</h3>
            {chantiers.length === 0 ? (
              <div className="text-center py-16">
                <div className="text-4xl mb-3 opacity-50">📋</div>
                <div className="text-gray-500 font-medium">Aucun chantier ne vous est rattaché pour le moment.</div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table style={{ width: '100%', minWidth: '640px', textAlign: 'left', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <th style={{ padding: '8px' }}>Chantier</th>
                      <th style={{ padding: '8px' }}>Client</th>
                      <th style={{ padding: '8px' }}>Statut</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>CA vendu</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Marge commerciale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chantiers.map((c: any) => (
                      <tr key={c.id} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '8px' }}>
                          <strong className="text-gray-800">{c.nom}</strong>
                          <div className="text-xs text-gray-400">{jourCivilChantier(c.dateDebut, fuseau)}</div>
                        </td>
                        <td style={{ padding: '8px' }} className="text-gray-600">{c.client}</td>
                        <td style={{ padding: '8px' }}>
                          <span className={`text-xs font-bold uppercase tracking-wide px-2 py-1 rounded-full ${c.statut === 'TERMINE' ? 'bg-gray-100 text-gray-500' : 'bg-blue-100 text-accent'}`}>
                            {STATUT_LABELS[c.statut] || c.statut}
                          </span>
                          {c.statut === 'TERMINE' && !c.encaisse && (
                            <span className="ml-1 text-[10px] font-semibold px-1.5 py-0.5 bg-red-50 text-red-600 rounded-full">Non encaissé</span>
                          )}
                        </td>
                        <td style={{ padding: '8px', textAlign: 'right' }} className="font-bold text-gray-800">{fmtEuro(c.budgetGlobalVendu)}</td>
                        <td style={{ padding: '8px', textAlign: 'right' }} className={`font-bold ${(c.margeCommerciale ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                          {c.margeCommerciale != null ? fmtEuro(c.margeCommerciale) : '—'}
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
