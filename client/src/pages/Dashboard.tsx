import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight, Building2, CheckCircle2, TrendingUp, Wallet, Clock3, ShoppingCart, Award, AlertTriangle, FileText } from 'lucide-react';
import { apiFetch } from '../api';
import { ProgressMeter } from '../components/ProgressMeter';
import { SectionRepliable } from '../components/SectionRepliable';
import { AlertesChantier } from '../components/AlertesChantier';
import { MESSAGE_SANS_PLAN_COMMERCIAL } from '../components/AvisSansPlanCommercial';
import { isAdminRole, peutAccederAuxDevis, roleLabel, useCurrentUser } from '../roles';
import { estASurveiller, trierChantiers } from '../lib/suiviChantiers';
import { useCompanyTimezone } from '../companyTimezoneContext';
import { companyDateInputValue, jourCivilChantier } from '../lib/dateFormatting';

type Period = 'month' | 'quarter' | 'year';

const Dashboard = () => {
  const companyTimezone = useCompanyTimezone();
  const [chantiers, setChantiers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalStats, setGlobalStats] = useState<any>(null);
  // Résultats du mois civil ou de l'année civile EN COURS uniquement — pas de navigation
  // vers une période passée ici (contrairement aux pages Résultat Commercial / Mes
  // Commerciaux). Les listes de chantiers ci-dessous ne suivent pas ce choix.
  const [period, setPeriod] = useState<Period>('month');
  const navigate = useNavigate();
  const utilisateur = useCurrentUser();

  // Rôle réel
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const userRole = user?.role || 'CONDUCTEUR_TRAVAUX';

  useEffect(() => {
    fetchChantiers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchGlobalStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

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
      const res = await apiFetch(`/stats/global?period=${period}`);
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
  // Dérives signalées par le serveur (dépassements, perte si la marge est visible) : les
  // cinq premières dans l'ordre où il faut les regarder, la suite sur la liste filtrée.
  const aSurveiller = trierChantiers(enCours.filter(estASurveiller), 'PRIORITE');
  const NB_A_SURVEILLER_AFFICHES = 5;
  // Rentabilité du portefeuille en cours : la marge estimée n'arrive que pour qui voit la
  // marge (serveur), l'encart n'existe donc que pour ces profils.
  const portefeuille = enCours.filter(c => c.metrics?.margeEstimee != null);
  const venduEnCours = portefeuille.reduce((s, c) => s + (c.budgetGlobalVendu ?? 0), 0);
  // Dépenses (main-d'œuvre comprise) : réservées à l'administration ; le serveur envoie null aux
  // autres destinataires de la rentabilité, qui gardent le vendu et la marge estimée.
  const depensesVisibles = portefeuille.every(c => c.metrics?.totalDepenses != null);
  const depenseEnCours = portefeuille.reduce((s, c) => s + (c.metrics?.totalDepenses ?? 0), 0);
  const margeEstimeeEnCours = portefeuille.reduce((s, c) => s + c.metrics.margeEstimee, 0);
  const margeEstimeeEnCoursPct = venduEnCours > 0 ? (margeEstimeeEnCours / venduEnCours) * 100 : 0;
  const euros = (n: number) => `${Math.round(n).toLocaleString('fr-FR')} €`;

  // Un chantier archivé n'a pas toujours de date de fin renseignée : on retombe
  // sur sa dernière modification (le passage au statut archivé la met à jour).
  const archiveDate = (c: any) => new Date(c.dateFin || c.updatedAt).getTime();
  const archives = chantiers
    .filter(c => c.statut !== 'EN_COURS')
    .sort((a, b) => archiveDate(b) - archiveDate(a));

  const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  const periodLabel = (() => {
    if (!globalStats?.periodStart) return '';
    const [y, m] = globalStats.periodStart.split('-').map(Number);
    if (period === 'year') return `Année ${y}`;
    if (period === 'quarter') return `T${Math.ceil(m / 3)} ${y}`;
    return `${MOIS[m - 1]} ${y}`;
  })();

  const commissionCommerciale = globalStats?.commissionCommercialeTotal ?? globalStats?.commissionTotal;

  return (
    <div className="flex flex-col h-full overflow-x-hidden">

      {/* Header global */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-primary-dark m-0 leading-tight">Tableau de Bord</h1>
          <p className="text-sm text-muted mt-1">Suivi financier et opérationnel</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Résultats du mois/trimestre/année civil(e) EN COURS uniquement — pas de
              navigation vers une période passée (à la différence des autres pages stats). */}
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
            {(['month', 'quarter', 'year'] as Period[]).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setPeriod(g)}
                className={`text-sm font-semibold px-3 py-1.5 rounded-md transition-colors ${period === g ? 'bg-white shadow-sm text-primary-dark' : 'text-gray-500 hover:text-gray-700'}`}
              >
                {g === 'month' ? 'Mois en cours' : g === 'quarter' ? 'Trimestre en cours' : 'Année en cours'}
              </button>
            ))}
          </div>
          <div className="flex gap-1 items-center bg-gray-100 px-3 py-1.5 rounded-lg">
            <span className="text-sm font-semibold text-gray-500">
              Connecté en tant que: <strong className="text-primary-dark">{roleLabel(userRole)}</strong>
            </span>
          </div>
        </div>
      </div>

      {/* Bandeau statistiques (périmètre selon le rôle, calculé côté serveur). "Chantiers
          en cours" est un instantané, indépendant de la période ; le reste porte sur le
          mois/l'année sélectionné ci-dessus (periodLabel). */}
      {globalStats && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
            <div className="p-2 rounded-lg bg-blue-50 text-accent"><Building2 size={18} /></div>
            <div>
              <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Chantiers en cours</div>
              <div className="text-2xl font-black text-primary-dark mt-0.5">
                {globalStats.nbEnCours} <span className="text-sm font-semibold text-gray-400">/ {globalStats.nbChantiers}</span>
              </div>
            </div>
          </div>

          {/* Instantané indépendant de la période, comme "Chantiers en cours" — visible
              par tous les rôles (périmètre déjà filtré côté serveur selon le rôle). */}
          <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
            <div className="p-2 rounded-lg bg-gray-100 text-gray-500"><CheckCircle2 size={18} /></div>
            <div>
              <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Chantiers terminés</div>
              <div className="text-2xl font-black text-primary-dark mt-0.5">{globalStats.nbTermines}</div>
            </div>
          </div>

          {/* Réservé aux admins : ce sont eux qui valident l'encaissement (cf. bouton sur
              la fiche chantier), clause de sécurisation qui conditionne le résultat
              commercial du mois de clôture. */}
          {globalStats.nbTerminesNonEncaisses != null && (
            <div className={`bg-white p-4 rounded-xl shadow-sm border flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3 ${globalStats.nbTerminesNonEncaisses > 0 ? 'border-amber-200' : 'border-gray-100'}`}>
              <div className={`p-2 rounded-lg ${globalStats.nbTerminesNonEncaisses > 0 ? 'bg-amber-50 text-amber-600' : 'bg-gray-100 text-gray-400'}`}><AlertTriangle size={18} /></div>
              <div>
                <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">En attente d'encaissement</div>
                <div className={`text-2xl font-black mt-0.5 ${globalStats.nbTerminesNonEncaisses > 0 ? 'text-amber-600' : 'text-primary-dark'}`}>
                  {globalStats.nbTerminesNonEncaisses}
                </div>
              </div>
            </div>
          )}

          {globalStats.achatsTotal != null && (
            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
              <div className="p-2 rounded-lg bg-orange-50 text-orange-600"><ShoppingCart size={18} /></div>
              <div>
                <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Total des achats</div>
                <div className="text-2xl font-black text-orange-600 mt-0.5">{Math.round(globalStats.achatsTotal).toLocaleString()} €</div>
                <div className="text-xs text-gray-400">{periodLabel}</div>
              </div>
            </div>
          )}

          {globalStats.heuresTotal != null && (
            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
              <div className="p-2 rounded-lg bg-purple-50 text-purple-600"><Clock3 size={18} /></div>
              <div>
                <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Heures enregistrées</div>
                <div className="text-2xl font-black text-purple-600 mt-0.5">{Math.round(globalStats.heuresTotal).toLocaleString()} h</div>
                <div className="text-xs text-gray-400">{periodLabel}</div>
              </div>
            </div>
          )}

          {globalStats.caTotal != null && (
            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
              <div className="p-2 rounded-lg bg-blue-50 text-accent"><Wallet size={18} /></div>
              <div>
                <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">CA Vendu</div>
                <div className="text-2xl font-black text-primary-dark mt-0.5">{Math.round(globalStats.caTotal).toLocaleString()} €</div>
                <div className="text-xs text-gray-400">{periodLabel}</div>
              </div>
            </div>
          )}

          {globalStats.margeTotal != null && (
            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
              <div className={`p-2 rounded-lg ${globalStats.margeTotal >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}><TrendingUp size={18} /></div>
              <div>
                <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Marge totale</div>
                <div className={`text-2xl font-black mt-0.5 ${globalStats.margeTotal >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {Math.round(globalStats.margeTotal).toLocaleString()} €
                </div>
                <div className="text-xs text-gray-400">
                  {globalStats.margePct != null ? `${globalStats.margePct.toFixed(1)}% · ` : ''}{periodLabel}
                </div>
              </div>
            </div>
          )}

          {commissionCommerciale != null && (
            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
              <div className="p-2 rounded-lg bg-emerald-50 text-emerald-600"><Award size={18} /></div>
              <div>
                {/* Sans plan commercial, aucune commission (décision du 17-10-2026) : ni « versée »
                    ni « gagnée », et le message de l'absence de plan. */}
                <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                  {isAdminRole(userRole) ? 'Commission commerciale' : 'Ma commission'}
                </div>
                <div className="text-2xl font-black text-emerald-600 mt-0.5">{Math.round(commissionCommerciale).toLocaleString()} €</div>
                <div className="text-xs text-gray-400">{globalStats.sansPlanCommercial ? MESSAGE_SANS_PLAN_COMMERCIAL : periodLabel}</div>
              </div>
            </div>
          )}
        </div>
      )}

      {chantiers.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
          <div className="text-6xl mb-4">🏗️</div>
          <h2 className="text-2xl font-bold text-gray-700 mb-2">Aucun chantier</h2>
          {/* Un chantier n'a pas d'autre porte d'entrée que la conversion d'un devis accepté. */}
          <p className="text-muted max-w-md">Un chantier s'ouvre en convertissant un devis accepté par le client.</p>
          {peutAccederAuxDevis(utilisateur) && (
            <Link to="/devis" className="btn btn-primary flex items-center gap-2 no-underline mt-6">
              <FileText size={16} /> Aller aux devis
            </Link>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-6">

          {portefeuille.length > 0 && (
            <section aria-label="Rentabilité des chantiers en cours" className="bg-white rounded-2xl shadow-md border border-gray-100 p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
                <h2 className="text-lg font-bold text-primary-dark m-0 flex items-center gap-2"><TrendingUp size={18} className="text-accent" /> Rentabilité des chantiers en cours</h2>
                <span className="text-xs text-gray-400">{portefeuille.length} chantier{portefeuille.length > 1 ? 's' : ''} · estimation : réel engagé + reste à faire au coût attendu</span>
              </div>
              <div className={`grid grid-cols-1 gap-4 ${depensesVisibles ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
                <div>
                  <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Vendu</div>
                  <div className="text-2xl font-black text-primary-dark mt-0.5">{euros(venduEnCours)}</div>
                </div>
                {depensesVisibles && (
                <div>
                  <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Dépensé à ce jour</div>
                  <div className="text-2xl font-black text-orange-600 mt-0.5">{euros(depenseEnCours)}</div>
                  <div className="mt-1.5"><ProgressMeter value={depenseEnCours} max={venduEnCours || 1} color="orange" size="sm" /></div>
                </div>
                )}
                <div>
                  <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Marge estimée en fin de chantier</div>
                  <div className={`text-2xl font-black mt-0.5 ${margeEstimeeEnCours >= 0 ? 'text-emerald-600' : 'text-red-600'}`} data-marge-portefeuille>
                    {euros(margeEstimeeEnCours)}
                  </div>
                  <div className={`text-xs font-semibold ${margeEstimeeEnCours >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                    {margeEstimeeEnCoursPct.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} % du vendu
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* À surveiller : les chantiers en cours dont le réel dépasse le vendu, sans saisie
              récente, ou — pour qui voit la marge — en perte ou à marge estimée faible. Le
              bloc reste affiché quand tout va bien : c'est aussi une information. */}
          {enCours.length > 0 && (
            <section aria-label="Chantiers à surveiller" className={`bg-white rounded-2xl shadow-md border overflow-hidden ${aSurveiller.length > 0 ? 'border-red-200' : 'border-gray-100'}`}>
              <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-gray-100">
                <div className="flex items-center gap-2">
                  {aSurveiller.length > 0
                    ? <AlertTriangle size={18} className="text-red-600" />
                    : <CheckCircle2 size={18} className="text-emerald-600" />}
                  <h2 className="text-lg font-bold text-primary-dark m-0">À surveiller</h2>
                </div>
                {aSurveiller.length > 0 && (
                  <Link to="/chantiers?filtre=A_SURVEILLER" className="text-xs font-bold text-accent hover:underline no-underline">
                    {aSurveiller.length > NB_A_SURVEILLER_AFFICHES ? `Voir les ${aSurveiller.length} chantiers` : 'Ouvrir dans la liste'}
                  </Link>
                )}
              </div>
              {aSurveiller.length === 0 ? (
                <div className="px-6 py-5 text-sm font-semibold text-emerald-700">
                  Aucune alerte : vos chantiers en cours restent dans le vendu et sont saisis régulièrement.
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {aSurveiller.slice(0, NB_A_SURVEILLER_AFFICHES).map(c => (
                    <button
                      key={c.id}
                      onClick={() => navigate(`/chantiers/${c.id}`)}
                      className="w-full flex items-center gap-4 px-6 py-3.5 hover:bg-gray-50 transition-colors text-left group"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-gray-800 truncate group-hover:text-accent transition-colors">{c.nom}</div>
                        <div className="text-xs text-gray-400 mt-0.5">{c.client}{c.responsable?.name ? ` · Resp. : ${c.responsable.name}` : ''}</div>
                        <div className="mt-1.5"><AlertesChantier chantier={c} /></div>
                      </div>
                      <ChevronRight size={20} className="text-gray-300 group-hover:text-accent transition-colors shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

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
                        <div className="mt-1.5 empty:hidden"><AlertesChantier chantier={c} /></div>
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

          {/* Chantiers terminés / archivés — repliés par défaut : ils ne doivent pas noyer
              les chantiers en cours, mais restent consultables d'un clic. Classés du plus
              récemment archivé au plus ancien. */}
          <div className="bg-white rounded-2xl shadow-md border border-gray-100 overflow-hidden">
            <SectionRepliable
              headerClassName="px-6 py-4"
              titre={
                <>
                  <CheckCircle2 size={18} className="text-gray-400 shrink-0" />
                  <h2 className="text-lg font-bold text-gray-500 m-0">Chantiers terminés / archivés</h2>
                </>
              }
              resume={
                <span className="text-xs font-bold text-gray-400 uppercase tracking-wider shrink-0">
                  {archives.length} chantier{archives.length > 1 ? 's' : ''}
                </span>
              }
            >
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
                      {/* Jour civil de la société, au format JJ-MM-AAAA : une date de fin horodatée
                          (clôtures antérieures au 16-09-2026) se lit dans son fuseau, une date-seule
                          telle quelle ; la dernière modification, toujours un instant, se lit dans son
                          fuseau, même à minuit UTC pile. */}
                      Archivé le {c.dateFin ? jourCivilChantier(c.dateFin, companyTimezone) : companyDateInputValue(companyTimezone, new Date(c.updatedAt))}
                    </span>
                    <span className="text-[11px] font-bold uppercase tracking-wide bg-gray-100 text-gray-500 px-2.5 py-1 rounded-full shrink-0">Terminé</span>
                    <ChevronRight size={20} className="text-gray-300 group-hover:text-accent transition-colors shrink-0" />
                  </button>
                ))}
              </div>
            )}
            </SectionRepliable>
          </div>

        </div>
      )}
    </div>
  );
};

export default Dashboard;
