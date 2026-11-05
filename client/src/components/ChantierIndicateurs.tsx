import { FileDown, Package, Users, Truck, Wallet, Clock3 } from 'lucide-react';
import { ProgressMeter } from './ProgressMeter';
import { BarBreakdown, type BreakdownRow } from './BarBreakdown';
import { isAdminRole } from '../roles';
import { CoutsSuitesChantier } from './CoutsSuitesChantier';
import { hypotheseCoutHoraire, hypotheseMateriel, type EstimationMarge } from '../lib/suiviChantiers';
import { arrondiEuro, arrondiCentime } from '../lib/montants';
import { toDateFrancaise, fmtEuro, fmtHeures } from '../lib/formats';

export type FactureLiee = {
  id: string;
  numero: string;
  type: 'FACTURE' | 'AVOIR';
  statut: string;
  dateEmission: string;
  totalHt: number;
  totalTtc: number;
};

export function ChantierIndicateurs({ showBudgetVendu, chantier, userRole, handleDownloadFacturePdf, showMarge, margeAffichee, metrics, totalDepensesReelles, estimation, isTermine, montantsVisibles, coutMainOeuvreVisible, depenseMaterielReelle, coutMainOeuvreReel, manqueAGagnerMainOeuvre, heuresRealisees, parCategorie, parFournisseur, parIntervenant }: {
  showBudgetVendu: boolean;
  chantier: any;
  userRole: string;
  handleDownloadFacturePdf: (facture: Pick<FactureLiee, 'id' | 'numero'>) => void;
  showMarge: boolean;
  margeAffichee: number;
  metrics: any;
  totalDepensesReelles: number;
  estimation: EstimationMarge | null;
  isTermine: boolean;
  montantsVisibles: boolean;
  coutMainOeuvreVisible: boolean;
  depenseMaterielReelle: number;
  coutMainOeuvreReel: number;
  manqueAGagnerMainOeuvre: number;
  heuresRealisees: number;
  parCategorie: BreakdownRow[];
  parFournisseur: BreakdownRow[];
  parIntervenant: BreakdownRow[];
}) {
  // Affaire annulée (#483, décision de Nelson du 04-11-2026, option 1 : « Masquer ces montants ») :
  // elle ne se facture plus (refus du serveur, factures/routes.ts), si bien que le reste à
  // facturer, la marge et les alertes de budget sont remplacés par « Affaire annulée ». Le
  // statut seul décide, et non `isTermine`, qui couvre aussi le chantier terminé.
  const affaireAnnulee = chantier.statut === 'ANNULE';
  return (
    <>
          {/* Key Metrics */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {showBudgetVendu && (
              <div className="bg-gray-50 p-5 rounded-xl border border-gray-100 flex flex-col justify-center relative overflow-hidden group">
                <div aria-hidden="true" className="absolute top-0 right-0 w-16 h-16 bg-blue-100 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
                <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 z-10">Budget Vendu</div>
                <div className="text-2xl font-black text-primary-dark z-10">{chantier.budgetGlobalVendu.toLocaleString()} €</div>
              </div>
            )}

            {chantier.facturation && (
              <div data-facturation className="bg-emerald-50 p-5 rounded-xl border border-emerald-100 flex flex-col justify-center">
                <div className="text-xs font-bold text-emerald-700 uppercase tracking-widest mb-1">Facturé HT</div>
                <div className="text-2xl font-black text-emerald-800">{fmtEuro(chantier.facturation.totalFactureHt)}</div>
                {affaireAnnulee ? (
                  <div className="mt-1 text-xs text-gray-600">Affaire annulée</div>
                ) : (
                  <div className="mt-1 text-xs text-emerald-700">Reste à facturer : {fmtEuro(chantier.facturation.resteAFacturerHt)}</div>
                )}
              </div>
            )}

            {chantier.facturation?.factures?.length > 0 && (
              <section aria-label="Factures liées" className="lg:col-span-4 overflow-x-auto rounded-xl border border-emerald-100 bg-white">
                <div className="flex items-center gap-2 border-b border-emerald-100 bg-emerald-50 px-5 py-3">
                  <Wallet size={18} className="text-emerald-700" />
                  <h3 className="m-0 text-lg font-bold text-emerald-900">Factures liées</h3>
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs font-bold text-emerald-700">{chantier.facturation.factures.length}</span>
                </div>
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                    <tr><th className="p-3">Numéro</th><th className="p-3">Type</th><th className="p-3">Statut</th><th className="p-3">Émission</th><th className="p-3 text-right">Total HT</th><th className="p-3 text-right">Total TTC</th>{isAdminRole(userRole) && <th className="p-3">Action</th>}</tr>
                  </thead>
                  <tbody>
                    {chantier.facturation.factures.map((facture: FactureLiee) => (
                      <tr key={facture.id} className="border-t border-gray-100">
                        <td className="p-3 font-semibold text-gray-800">{facture.numero}</td>
                        <td className="p-3">{facture.type === 'AVOIR' ? 'Avoir' : 'Facture'}</td>
                        <td className="p-3">{facture.statut}</td>
                        <td className="p-3">{toDateFrancaise(facture.dateEmission)}</td>
                        <td className="p-3 text-right font-semibold">{fmtEuro(facture.totalHt)}</td>
                        <td className="p-3 text-right font-semibold">{fmtEuro(facture.totalTtc)}</td>
                        {isAdminRole(userRole) && <td className="p-3"><button type="button" className="btn btn-secondary" onClick={() => void handleDownloadFacturePdf(facture)}><FileDown size={16} /> PDF</button></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {/* Budgets par poste : non communiqués à un compte technicien (null côté serveur). */}
            {chantier.budgetMaterielVendu != null && (
            <div className="bg-gray-50 p-5 rounded-xl border border-gray-100 flex flex-col justify-center relative overflow-hidden group">
              <div aria-hidden="true" className="absolute top-0 right-0 w-16 h-16 bg-green-100 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
              <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 z-10">Matériel Prévu</div>
              <div className="text-2xl font-black text-accent z-10">{chantier.budgetMaterielVendu.toLocaleString()} €</div>
            </div>
            )}

            <div className="bg-gray-50 p-5 rounded-xl border border-gray-100 flex flex-col justify-center relative overflow-hidden group">
              <div aria-hidden="true" className="absolute top-0 right-0 w-16 h-16 bg-purple-100 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
              <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 z-10">Heures Prévues</div>
              <div className="text-2xl font-black text-purple-600 z-10">{fmtHeures(chantier.heuresVendues)}</div>
            </div>

            {chantier.budgetMainOeuvreVendu != null && (
            <div className="bg-gray-50 p-5 rounded-xl border border-gray-100 flex flex-col justify-center relative overflow-hidden group">
              <div aria-hidden="true" className="absolute top-0 right-0 w-16 h-16 bg-orange-100 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
              <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 z-10">Coût MO Prévu</div>
              <div className="text-2xl font-black text-orange-600 z-10">{chantier.budgetMainOeuvreVendu.toLocaleString()} €</div>
            </div>
            )}
          </div>

          {/* Marge Commerciale (admin, ou conducteur responsable sur sa fiche chantier — cf.
              GET /api/chantiers/:id côté serveur —, si activée dans les paramètres) */}
          {showMarge && (
            <div data-marge-commerciale className={`mb-8 p-6 rounded-xl border-l-8 flex flex-col gap-4 shadow-sm relative overflow-hidden ${affaireAnnulee ? 'bg-gray-50 border-gray-300' : margeAffichee > 0 ? 'bg-emerald-50 border-emerald-500' : 'bg-red-50 border-red-500'}`}>
              <div className="flex flex-col md:flex-row justify-between items-center gap-4">
                <div className="z-10 text-center md:text-left">
                  <div className={`text-xs font-bold uppercase tracking-widest ${affaireAnnulee ? 'text-gray-500' : margeAffichee > 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                    Marge Commerciale
                  </div>
                  {affaireAnnulee ? (
                    <div className="text-2xl font-black mt-2 tracking-tight text-gray-600">Affaire annulée</div>
                  ) : (
                    <>
                      <div className={`text-5xl font-black mt-2 tracking-tight ${margeAffichee > 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                        {margeAffichee.toLocaleString()} €
                      </div>
                      {metrics.margePct != null && (
                        <div className={`text-sm font-bold mt-1 ${margeAffichee > 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                          {metrics.margePct.toFixed(1)}% du budget vendu
                        </div>
                      )}
                    </>
                  )}
                </div>

                {metrics.totalDepenses != null && (
                <div className="z-10 bg-white/60 backdrop-blur-sm p-4 rounded-lg text-right">
                  <div className="text-xs text-gray-500 font-bold uppercase tracking-wider mb-1">Dépenses Réelles Cumulées</div>
                  <div className="font-bold text-2xl text-gray-800">{arrondiCentime(totalDepensesReelles).toLocaleString()} €</div>
                </div>
                )}
              </div>
              {/* Marge estimée en fin de chantier : les hypothèses sont écrites en clair, pour
                  qu'on sache d'où vient le chiffre et ce qui le ferait bouger. */}
              {estimation && metrics.margeEstimee != null && !isTermine && (
                <div className="z-10 bg-white/60 p-4 rounded-lg" data-estimation>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="text-xs text-gray-500 font-bold uppercase tracking-wider">Marge estimée en fin de chantier</div>
                    <div className={`text-2xl font-black ${arrondiEuro(metrics.margeEstimee) >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                      {fmtEuro(metrics.margeEstimee)}
                      <span className="text-sm font-bold ml-2">{(metrics.margeEstimeePct ?? 0).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %</span>
                    </div>
                  </div>
                  <ul className="mt-2 mb-0 pl-4 text-xs text-gray-600 space-y-0.5">
                    <li>Main-d’œuvre attendue : {estimation.coutMainOeuvreAttendu != null && <><strong>{fmtEuro(estimation.coutMainOeuvreAttendu)}</strong> — </>}{hypotheseCoutHoraire(estimation, metrics.coutsSuites?.heures)}.</li>
                    <li>Matériel attendu : <strong>{fmtEuro(estimation.coutMaterielAttendu)}</strong> — {hypotheseMateriel(estimation, metrics.coutsSuites?.materiel, chantier.coutMaterielPrevu)}.</li>
                    <li>Un poste n’est jamais estimé sous ce qui a déjà été dépensé.</li>
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Progress Bars */}
          <div className={`grid grid-cols-1 gap-8 mb-8 ${montantsVisibles && !coutMainOeuvreVisible ? 'lg:grid-cols-2' : 'lg:grid-cols-3'}`}>
            {/* Matériel et coût de main-d'œuvre : montants jamais montrés au technicien. */}
            {montantsVisibles && (<>
            {/* Matériel */}
            <div>
              <div className="flex justify-between items-end mb-2">
                <h3 className="font-bold text-gray-800 flex items-center gap-2 m-0">
                  <Package size={18} className="text-accent" /> Consommation Matériel
                </h3>
                <div className="text-right">
                  <span className="text-xl font-black text-accent">{depenseMaterielReelle.toLocaleString()} €</span>
                  {chantier.budgetMaterielVendu != null && <span className="text-sm font-semibold text-gray-400 ml-1">/ {chantier.budgetMaterielVendu.toLocaleString()} €</span>}
                </div>
              </div>
              {chantier.budgetMaterielVendu != null && (
                <>
                  <ProgressMeter value={depenseMaterielReelle} max={chantier.budgetMaterielVendu} color="blue" striped />
                  <div className="mt-2 text-right text-xs font-bold text-gray-500">
                    {((depenseMaterielReelle / Math.max(1, chantier.budgetMaterielVendu)) * 100).toFixed(1)}%
                  </div>
                </>
              )}
            </div>

            {/* Coût main d'oeuvre (€) — distinct de la barre "Heures" ci-dessous : un
                dépassement d'heures se traduit ici en euros réellement dépensés en salaire,
                avec le manque à gagner correspondant s'il dépasse le budget vendu. Réservé à
                l'administration. */}
            {coutMainOeuvreVisible && (
            <div>
              <div className="flex justify-between items-end mb-2">
                <h3 className="font-bold text-gray-800 flex items-center gap-2 m-0">
                  <Wallet size={18} className="text-orange-500" /> Coût Main d'Œuvre
                </h3>
                <div className="text-right">
                  <span className="text-xl font-black text-orange-600">{arrondiCentime(coutMainOeuvreReel).toLocaleString()} €</span>
                  {chantier.budgetMainOeuvreVendu != null && <span className="text-sm font-semibold text-gray-400 ml-1">/ {chantier.budgetMainOeuvreVendu.toLocaleString()} €</span>}
                </div>
              </div>
              {chantier.budgetMainOeuvreVendu != null && <ProgressMeter value={coutMainOeuvreReel} max={chantier.budgetMainOeuvreVendu} color="orange" striped />}
              <div className="mt-2 flex justify-between items-center text-xs font-bold">
                <span className={arrondiCentime(manqueAGagnerMainOeuvre) > 0 ? 'text-red-600' : 'text-gray-300'}>
                  {arrondiCentime(manqueAGagnerMainOeuvre) > 0 ? `Manque à gagner : -${arrondiCentime(manqueAGagnerMainOeuvre).toLocaleString()} €` : ''}
                </span>
                {chantier.budgetMainOeuvreVendu != null && (
                  <span className="text-gray-500">
                    {((coutMainOeuvreReel / Math.max(1, chantier.budgetMainOeuvreVendu)) * 100).toFixed(1)}%
                  </span>
                )}
              </div>
            </div>
            )}
            </>)}

            {/* Heures */}
            <div>
              <div className="flex justify-between items-end mb-2">
                <h3 className="font-bold text-gray-800 flex items-center gap-2 m-0">
                  <Clock3 size={18} className="text-purple-500" /> Consommation Heures
                </h3>
                <div className="text-right">
                  <span className="text-xl font-black text-purple-600">{fmtHeures(heuresRealisees)}</span>
                  <span className="text-sm font-semibold text-gray-400 ml-1">/ {fmtHeures(chantier.heuresVendues)}</span>
                </div>
              </div>
              <ProgressMeter value={heuresRealisees} max={chantier.heuresVendues} color="purple" striped />
              <div className="mt-2 text-right text-xs font-bold text-gray-500">
                {((heuresRealisees / Math.max(1, chantier.heuresVendues)) * 100).toFixed(1)}%
              </div>
            </div>
          </div>

          <CoutsSuitesChantier couts={metrics.coutsSuites} interventionDevis={metrics.coutsInterventionDevis} />

          {/* Répartitions */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {montantsVisibles && (<>
            <div className="bg-gray-50 rounded-xl border border-gray-100 p-5">
              <h3 className="font-bold text-gray-800 flex items-center gap-2 mb-4 text-sm uppercase tracking-wide">
                <Package size={16} className="text-accent" /> Achats par catégorie
              </h3>
              <BarBreakdown rows={parCategorie} color="#2563eb" formatValue={fmtEuro} emptyLabel="Aucun achat enregistré" />
            </div>
            <div className="bg-gray-50 rounded-xl border border-gray-100 p-5">
              <h3 className="font-bold text-gray-800 flex items-center gap-2 mb-4 text-sm uppercase tracking-wide">
                <Truck size={16} className="text-orange-500" /> Achats par fournisseur
              </h3>
              <BarBreakdown rows={parFournisseur} color="#ea580c" formatValue={fmtEuro} emptyLabel="Aucun achat enregistré" />
            </div>
            </>)}
            <div className="bg-gray-50 rounded-xl border border-gray-100 p-5">
              <h3 className="font-bold text-gray-800 flex items-center gap-2 mb-4 text-sm uppercase tracking-wide">
                <Users size={16} className="text-purple-500" /> Heures par intervenant
              </h3>
              <BarBreakdown rows={parIntervenant} color="#8b5cf6" formatValue={fmtHeures} emptyLabel="Aucune heure enregistrée" />
            </div>
          </div>
    </>
  );
}
