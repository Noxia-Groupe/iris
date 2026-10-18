import { useState, useEffect, useRef } from 'react';
import { Award } from 'lucide-react';
import { apiFetch } from '../api';
import { decalerReference } from '../lib/dateFormatting';
import { useReferencePeriode } from '../lib/referencePeriode';
import { AvisSansPlanCommercial } from '../components/AvisSansPlanCommercial';
import { useModules } from '../modules';
import { arrondiEuro } from '../lib/montants';

const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const STATUT_LABELS: Record<string, string> = { EN_COURS: 'En cours', TERMINE: 'Terminé' };

type CommPeriod = 'month' | 'quarter' | 'year';

const periodLabelComm = (period: CommPeriod, periodStart: string) => {
  const [y, m] = periodStart.split('-').map(Number);
  if (period === 'year') return `Année ${y}`;
  if (period === 'quarter') return `T${Math.ceil(m / 3)} ${y}`;
  return `${MOIS[m - 1]} ${y}`;
};

const fmtEuro = (n: number) => `${arrondiEuro(n).toLocaleString()} €`;

// Suivi des commerciaux (CA vendu, marge, commission) — page réservée aux administrateurs
// (extraite de l'onglet « Mes Commerciaux » d'Administration pour être son propre menu,
// cf. Sidebar.tsx). Route protégée côté client (PrivateRoute requiredRole) et données
// servies protégées côté serveur (requireAdmin / requireAuth selon la route).
//
// Sans plan commercial, un commercial ne touche aucune commission ni prime (décision du
// 17-10-2026) : aucun plan n'existe encore, la page n'affiche ni barème ni primes. L'admin y
// valide le statut "Encaissé" par chantier, qui conditionne le CA et la marge validés.
const MesCommerciaux = () => {
  // Libellé du barème de commission réduit, configuré dans Administration : aucun nom
  // de société n'est écrit dans l'interface.
  const { libelleBaremeReduit } = useModules();
  const [commerciaux, setCommerciaux] = useState<any[]>([]);
  const [commerciauxMeta, setCommerciauxMeta] = useState<any>(null);
  const [commerciauxPeriod, setCommerciauxPeriod] = useState<CommPeriod>('month');
  const [commerciauxRef, setCommerciauxRef] = useReferencePeriode();
  // Seule la dernière demande s'affiche : une réponse dépassée (période changée, ou fuseau de la
  // société lu entre-temps) est ignorée.
  const requeteCommerciaux = useRef(0);
  const [expandedCommercialId, setExpandedCommercialId] = useState<string | null>(null);

  useEffect(() => {
    fetchCommerciaux();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commerciauxPeriod, commerciauxRef]);

  const fetchCommerciaux = async () => {
    const requete = ++requeteCommerciaux.current;
    try {
      const res = await apiFetch(`/stats/commerciaux?period=${commerciauxPeriod}&ref=${commerciauxRef}`);
      if (res.ok) {
        const data = await res.json();
        if (requete !== requeteCommerciaux.current) return;
        setCommerciaux(data.commerciaux || []);
        setCommerciauxMeta(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Clause de sécurisation : un chantier ne compte dans le CA et la marge validés du mois
  // que s'il est Terminé ET Encaissé.
  const handleToggleEncaisse = async (chantierId: string, current: boolean) => {
    try {
      await apiFetch(`/chantiers/${chantierId}/encaisse`, { method: 'PATCH', body: JSON.stringify({ encaisse: !current }) });
      fetchCommerciaux();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div>
      <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4 mb-6 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-primary-dark m-0 flex items-center gap-2"><Award size={22} /> Mes Commerciaux</h1>
          <p className="text-sm text-muted mt-1">
            Classés par chiffre d'affaires vendu (mois ou année civile en cours, navigable). Visible uniquement par les administrateurs.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 xl:shrink-0">
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
            {(['month', 'quarter', 'year'] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setCommerciauxPeriod(g)}
                className={`text-sm font-semibold px-3 py-1.5 rounded-md transition-colors ${commerciauxPeriod === g ? 'bg-white shadow-sm text-primary-dark' : 'text-gray-500 hover:text-gray-700'}`}
              >
                {g === 'month' ? 'Mois' : g === 'quarter' ? 'Trimestre' : 'Année'}
              </button>
            ))}
          </div>
          {/* Sur un téléphone étroit, le libellé se replie pour garder ‹ › sur la même ligne. */}
          <div className="flex max-w-full items-center gap-2 bg-white border border-gray-200 rounded-lg p-1.5">
            <button type="button" onClick={() => setCommerciauxRef(decalerReference(commerciauxRef, commerciauxPeriod, -1))} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500 font-bold" title="Période précédente">‹</button>
            <span className="min-w-0 flex-1 text-center text-sm font-semibold text-gray-700 px-2 sm:flex-none sm:whitespace-nowrap">
              {commerciauxMeta ? periodLabelComm(commerciauxPeriod, commerciauxMeta.periodStart) : '…'}
            </span>
            <button type="button" onClick={() => setCommerciauxRef(decalerReference(commerciauxRef, commerciauxPeriod, 1))} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500 font-bold" title="Période suivante">›</button>
            <button type="button" onClick={() => setCommerciauxRef(null)} className="ml-1 text-xs font-semibold px-2 py-1.5 rounded-md hover:bg-gray-100 text-accent">Aujourd'hui</button>
          </div>
        </div>
      </div>

      {commerciaux.length === 0 ? (
        <div className="card text-center py-12 text-gray-400 italic">
          Aucun commercial enregistré (menu Administration &gt; Utilisateurs pour en autoriser un).
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {commerciaux.some((c) => c.sansPlanCommercial) && (
            <AvisSansPlanCommercial>
              Le barème général et les primes ne s'appliquent plus ; un commercial n'aura de commissions qu'à partir de
              la date d'attribution de son plan commercial. Le CA et la marge validés restent suivis.
            </AvisSansPlanCommercial>
          )}
          {commerciaux.map((c, i) => {
            const isExpanded = expandedCommercialId === c.id;
            return (
              <div key={c.id} className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
                <div
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 cursor-pointer"
                  onClick={() => setExpandedCommercialId(isExpanded ? null : c.id)}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gray-100 text-gray-500 font-bold text-sm flex items-center justify-center shrink-0">#{i + 1}</div>
                    <div className="min-w-0">
                      <div className="font-bold text-gray-800 break-words">{c.name}</div>
                      <div className="text-xs text-muted break-all">{c.email} · {c.nbChantiers} chantier{c.nbChantiers > 1 ? 's' : ''}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-4">
                    <div className="text-right">
                      <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">CA validé</div>
                      <div className="font-bold text-gray-800">{fmtEuro(c.caTotal)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Marge validée</div>
                      <div className={`font-bold ${arrondiEuro(c.margeTotal) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{fmtEuro(c.margeTotal)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Rémunération variable</div>
                      <div className="font-bold text-purple-600">{fmtEuro(c.commissionTotal)}</div>
                      {c.sansPlanCommercial && <div className="text-[11px] text-gray-400">Sans plan commercial</div>}
                    </div>
                    <span className="text-gray-400 text-xs">{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="mt-4 pt-4 border-t border-gray-100 flex flex-col gap-5">
                    {/* Détail des chantiers rattachés */}
                    {c.chantiers.length === 0 ? (
                      <div className="text-sm text-gray-400 italic">Aucun chantier rattaché.</div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-sm">
                          <thead>
                            <tr className="text-[11px] uppercase text-gray-500 border-b border-gray-100">
                              <th className="py-2 pr-3 font-semibold">Chantier</th>
                              <th className="py-2 pr-3 font-semibold">Statut</th>
                              <th className="py-2 pr-3 font-semibold text-right">Marge</th>
                              <th className="py-2 pr-3 font-semibold text-center">Encaissement</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {c.chantiers.map((ch: any) => (
                              <tr key={ch.id}>
                                <td className="py-2 pr-3">
                                  <strong className="text-gray-800">{ch.nom}</strong>
                                  <span className="text-gray-400"> ({ch.client})</span>
                                  {ch.baremeReduit && <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded-full">{libelleBaremeReduit}</span>}
                                </td>
                                <td className="py-2 pr-3">
                                  <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full ${ch.statut === 'TERMINE' ? 'bg-gray-100 text-gray-500' : 'bg-blue-100 text-accent'}`}>
                                    {STATUT_LABELS[ch.statut] || ch.statut}
                                  </span>
                                </td>
                                <td className={`py-2 pr-3 text-right font-bold ${arrondiEuro(ch.margeCommerciale ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                  {ch.margeCommerciale != null ? fmtEuro(ch.margeCommerciale) : '—'}
                                </td>
                                <td className="py-2 pr-3 text-center">
                                  {ch.statut === 'TERMINE' ? (
                                    <button
                                      type="button"
                                      onClick={() => handleToggleEncaisse(ch.id, !!ch.encaisse)}
                                      className={`text-[11px] font-bold uppercase px-2 py-1 rounded-full transition-colors ${ch.encaisse ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-red-50 text-red-600 hover:bg-red-100'}`}
                                    >
                                      {ch.encaisse ? '✓ Encaissé' : 'Non encaissé'}
                                    </button>
                                  ) : (
                                    <span className="text-gray-300">—</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
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
