import { useState, useEffect } from 'react';
import { Award, CheckCircle2, Circle } from 'lucide-react';
import { apiFetch } from '../api';
import { ObjectifBar } from '../components/ObjectifBar';

const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const STATUT_LABELS: Record<string, string> = { EN_COURS: 'En cours', TERMINE: 'Terminé' };

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

const fmtEuro = (n: number) => `${Math.round(n).toLocaleString()} €`;

// Suivi des commerciaux (CA vendu, marge, commission) — page réservée aux administrateurs
// (extraite de l'onglet « Mes Commerciaux » d'Administration pour être son propre menu,
// cf. Sidebar.tsx). Route protégée côté client (PrivateRoute requiredRole) et données
// servies protégées côté serveur (requireAdmin / requireAuth selon la route).
//
// La commission ne suit plus un taux réglé à la main par chantier : elle applique le
// barème progressif mensuel du "Système de rémunération commerciale" (standard/NOXIA),
// complété par les primes d'objectifs. Cette page permet à l'admin de valider les deux
// leviers qui restent manuels : le statut "Encaissé" par chantier (clause de sécurisation
// des commissions) et la prime "suivi administratif" par commercial et par mois.
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

  // Prime "suivi administratif" : validée à la main par mois, faute de pouvoir être
  // déduite des données de gestion (qualité/rigueur du suivi, pas un montant).
  const handleToggleSuiviAdmin = async (commercialId: string, current: boolean) => {
    if (!commerciauxMeta) return;
    try {
      await apiFetch(`/commerciaux/${commercialId}/prime-mensuelle`, {
        method: 'PUT',
        body: JSON.stringify({ periode: commerciauxMeta.periodStart.slice(0, 7), suiviAdministratif: !current }),
      });
      fetchCommerciaux();
    } catch (e) {
      console.error(e);
    }
  };

  // Clause de sécurisation : une commission n'est comptabilisée dans le barème du mois
  // que si le chantier est Terminé ET Encaissé.
  const handleToggleEncaisse = async (chantierId: string, current: boolean) => {
    try {
      await apiFetch(`/chantiers/${chantierId}/encaisse`, { method: 'PATCH', body: JSON.stringify({ encaisse: !current }) });
      fetchCommerciaux();
    } catch (e) {
      console.error(e);
    }
  };

  const objectifs = commerciauxMeta?.objectifs;

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
                      <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">CA validé</div>
                      <div className="font-bold text-gray-800">{fmtEuro(c.caTotal)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Marge validée</div>
                      <div className={`font-bold ${c.margeTotal >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{fmtEuro(c.margeTotal)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Rémunération variable</div>
                      <div className="font-bold text-purple-600">{fmtEuro(c.commissionTotal)}</div>
                    </div>
                    <span className="text-gray-400 text-xs">{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="mt-4 pt-4 border-t border-gray-100 flex flex-col gap-5">
                    {/* Barème progressif : marge et commission par groupe standard/NOXIA */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="p-4 rounded-lg bg-gray-50 border border-gray-100">
                        <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide mb-2">Barème standard (16 / 20 / 25 %)</div>
                        <div className="flex justify-between text-sm"><span className="text-gray-500">Marge</span><strong className="text-gray-800">{fmtEuro(c.margeStandard)}</strong></div>
                        <div className="flex justify-between text-sm"><span className="text-gray-500">Commission</span><strong className="text-purple-600">{fmtEuro(c.commissionStandard)}</strong></div>
                      </div>
                      <div className="p-4 rounded-lg bg-amber-50 border border-amber-100">
                        <div className="text-[11px] font-bold text-amber-700 uppercase tracking-wide mb-2">Barème NOXIA (8 / 10 / 12,5 %)</div>
                        <div className="flex justify-between text-sm"><span className="text-amber-700/70">Marge</span><strong className="text-gray-800">{fmtEuro(c.margeNoxia)}</strong></div>
                        <div className="flex justify-between text-sm"><span className="text-amber-700/70">Commission</span><strong className="text-purple-600">{fmtEuro(c.commissionNoxia)}</strong></div>
                      </div>
                    </div>

                    {/* Primes sur objectifs mensuels (non pertinent en vue Année) */}
                    {commerciauxPeriod === 'month' && objectifs && (
                      <div className="p-4 rounded-lg bg-gray-50 border border-gray-100 flex flex-col gap-4">
                        <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Primes sur objectifs mensuels</div>
                        <ObjectifBar label={`Objectif CA (${fmtEuro(objectifs.ca)})`} value={c.caTotal} target={objectifs.ca} prime={objectifs.primeCA} />
                        <ObjectifBar label={`Objectif marge (${fmtEuro(objectifs.marge)})`} value={c.margeTotal} target={objectifs.marge} prime={objectifs.primeMarge} />
                        <button
                          type="button"
                          onClick={() => handleToggleSuiviAdmin(c.id, !!c.suiviAdministratif)}
                          className={`flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-lg border w-fit transition-colors ${c.suiviAdministratif ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'}`}
                        >
                          {c.suiviAdministratif ? <CheckCircle2 size={16} /> : <Circle size={16} />}
                          Suivi administratif validé (+{objectifs.primeAdmin} €)
                        </button>
                      </div>
                    )}

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
                              <th className="py-2 pr-3 font-semibold text-right">Commission (quote-part)</th>
                              <th className="py-2 pr-3 font-semibold text-center">Encaissement</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {c.chantiers.map((ch: any) => (
                              <tr key={ch.id}>
                                <td className="py-2 pr-3">
                                  <strong className="text-gray-800">{ch.nom}</strong>
                                  <span className="text-gray-400"> ({ch.client})</span>
                                  {ch.dossierNoxia && <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded-full">NOXIA</span>}
                                </td>
                                <td className="py-2 pr-3">
                                  <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full ${ch.statut === 'TERMINE' ? 'bg-gray-100 text-gray-500' : 'bg-blue-100 text-accent'}`}>
                                    {STATUT_LABELS[ch.statut] || ch.statut}
                                  </span>
                                </td>
                                <td className={`py-2 pr-3 text-right font-bold ${(ch.margeCommerciale ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                  {ch.margeCommerciale != null ? fmtEuro(ch.margeCommerciale) : '—'}
                                </td>
                                <td className="py-2 pr-3 text-right font-bold text-purple-600">
                                  {ch.comptabiliseDansPeriode ? fmtEuro(ch.commissionEstimee ?? 0) : <span className="font-normal text-gray-400 italic">en attente</span>}
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
