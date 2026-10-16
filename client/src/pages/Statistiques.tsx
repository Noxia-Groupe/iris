import { useState, useEffect } from 'react';
import { PieChart, Users, Truck, Tags, ChevronLeft, ChevronRight } from 'lucide-react';
import { apiFetch } from '../api';
import { decalerReference, jourFrancais } from '../lib/dateFormatting';
import { useReferencePeriode } from '../lib/referencePeriode';
import { isAdminRole, roleLabel } from '../roles';

type Period = 'week' | 'month' | 'year';

const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

const periodLabel = (period: Period, periodStart: string, periodEnd: string) => {
  const [y, m] = periodStart.split('-').map(Number);
  if (period === 'year') return `Année ${y}`;
  if (period === 'month') return `${MOIS[m - 1]} ${y}`;
  return `Semaine du ${jourFrancais(periodStart)} au ${jourFrancais(periodEnd)}`;
};

// Sélecteur de période générique (granularité + navigation précédent/suivant/aujourd'hui),
// réutilisé par les onglets Intervenants et Fournisseurs.
function PeriodNav({
  period, granularities, onPeriodChange, refDate, onRefChange, label,
}: {
  period: Period;
  granularities: Period[];
  onPeriodChange: (p: Period) => void;
  refDate: string;
  onRefChange: (r: string | null) => void;
  label: string;
}) {
  const GRANULARITY_LABELS: Record<Period, string> = { week: 'Semaine', month: 'Mois', year: 'Année' };
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
      {granularities.length > 1 && (
        <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
          {granularities.map((g) => (
            <button
              key={g}
              onClick={() => onPeriodChange(g)}
              className={`text-sm font-semibold px-3 py-1.5 rounded-md transition-colors ${period === g ? 'bg-white shadow-sm text-primary-dark' : 'text-gray-500 hover:text-gray-700'}`}
            >
              {GRANULARITY_LABELS[g]}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg p-1.5">
        <button type="button" onClick={() => onRefChange(decalerReference(refDate, period, -1))} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500" title="Période précédente">
          <ChevronLeft size={16} />
        </button>
        <span className="text-sm font-semibold text-gray-700 px-2 whitespace-nowrap min-w-[10rem] text-center">{label}</span>
        <button type="button" onClick={() => onRefChange(decalerReference(refDate, period, 1))} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500" title="Période suivante">
          <ChevronRight size={16} />
        </button>
        <button type="button" onClick={() => onRefChange(null)} className="ml-1 text-xs font-semibold px-2 py-1.5 rounded-md hover:bg-gray-100 text-accent">
          Aujourd'hui
        </button>
      </div>
    </div>
  );
}

const CHANTIER_COLORS: Record<string, string> = {
  positif: '#10b981',
  tempsSeul: '#f59e0b',
  materielSeul: '#0251a1',
  lesDeux: '#ef4444',
};
const CHANTIER_SHORT_LABELS: Record<string, string> = {
  positif: 'Tout positif',
  tempsSeul: 'Dépassement temps seul',
  materielSeul: 'Dépassement matériel seul',
  lesDeux: 'Dépassement des deux',
};

function ChantiersTab() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    apiFetch('/stats/chantiers-repartition')
      .then((res) => (res.ok ? res.json() : null))
      .then(setData)
      .catch(() => setData(null));
  }, []);

  if (!data) return <div className="text-center py-16 text-gray-400 italic">Chargement...</div>;
  if (data.total === 0) {
    return (
      <div className="text-center py-16">
        <div className="text-4xl mb-3 opacity-50">🥧</div>
        <div className="text-gray-500 font-medium">Aucun chantier terminé pour le moment.</div>
        <div className="text-sm text-gray-400 mt-1">La répartition apparaîtra dès qu'un chantier sera clôturé.</div>
      </div>
    );
  }

  let cumulative = 0;
  const stops = data.categories
    .map((c: any) => {
      const from = cumulative;
      cumulative += c.pct;
      return `${CHANTIER_COLORS[c.key]} ${from}% ${cumulative}%`;
    })
    .join(', ');

  return (
    <div className="flex flex-col lg:flex-row items-center gap-10 py-4">
      <div className="relative w-64 h-64 shrink-0">
        <div className="w-full h-full rounded-full" style={{ background: `conic-gradient(${stops})` }} />
        <div className="absolute inset-[17%] bg-white rounded-full flex flex-col items-center justify-center shadow-inner">
          <div className="text-4xl font-black text-primary-dark">{data.total}</div>
          <div className="text-xs text-gray-500 font-semibold uppercase tracking-wide text-center px-4">Chantiers terminés</div>
        </div>
      </div>

      <div className="flex-1 w-full grid grid-cols-1 sm:grid-cols-2 gap-4">
        {data.categories.map((c: any) => (
          <div key={c.key} className="bg-gray-50 rounded-xl border border-gray-100 p-4">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: CHANTIER_COLORS[c.key] }} />
              <span className="text-sm font-bold text-gray-700">{CHANTIER_SHORT_LABELS[c.key]}</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-black text-gray-800">{c.count}</span>
              <span className="text-sm font-semibold text-gray-400">({c.pct.toFixed(0)}%)</span>
            </div>
            <div className="text-xs text-gray-400 mt-1">{c.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Lit une statistique pour la période affichée. Une réponse dépassée (période changée, ou fuseau
// de la société lu entre-temps) est ignorée, même arrivée la dernière.
function useStatistique(chemin: string, period: Period, ref: string) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    let actuelle = true;
    apiFetch(`${chemin}?period=${period}&ref=${ref}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((donnees) => { if (actuelle) setData(donnees); })
      .catch(() => { if (actuelle) setData(null); });
    return () => { actuelle = false; };
  }, [chemin, period, ref]);
  return data;
}

function IntervenantsTab() {
  const [period, setPeriod] = useState<Period>('week');
  const [ref, setRef] = useReferencePeriode();
  const data = useStatistique('/stats/intervenants', period, ref);

  const list = data?.intervenants || [];
  const maxHeures = Math.max(1, ...list.map((i: any) => i.heures));

  return (
    <div>
      <PeriodNav
        period={period}
        granularities={['week', 'month', 'year']}
        onPeriodChange={setPeriod}
        refDate={ref}
        onRefChange={setRef}
        label={data ? periodLabel(period, data.periodStart, data.periodEnd) : '…'}
      />

      {!data ? (
        <div className="text-center py-16 text-gray-400 italic">Chargement...</div>
      ) : list.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-3 opacity-50">⏱️</div>
          <div className="text-gray-500 font-medium">Aucune heure saisie sur cette période.</div>
        </div>
      ) : (
        <div className="divide-y divide-gray-100">
          {list.map((iv: any, i: number) => (
            <div key={iv.id} className="flex items-center gap-4 py-3.5">
              <div className="w-7 h-7 rounded-full bg-gray-100 text-gray-500 font-bold text-xs flex items-center justify-center shrink-0">#{i + 1}</div>
              <div className="min-w-0 flex-1">
                <div className="font-bold text-gray-800 truncate">{iv.nom}</div>
                <div className="text-xs text-gray-400">{iv.role}</div>
              </div>
              <div className="hidden sm:block w-40 shrink-0">
                <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-purple-500" style={{ width: `${(iv.heures / maxHeures) * 100}%` }} />
                </div>
              </div>
              <div className="text-right w-28 shrink-0">
                <div className="font-black text-purple-600">{iv.heures.toFixed(1)} h</div>
                {/* Coût d'un intervenant : réservé à l'administration (le serveur envoie null aux autres). */}
                {iv.cout != null && <div className="text-xs text-gray-400">{Math.round(iv.cout).toLocaleString()} €</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FournisseursTab() {
  const [period, setPeriod] = useState<Period>('month');
  const [ref, setRef] = useReferencePeriode();
  const data = useStatistique('/stats/fournisseurs', period, ref);

  const list = data?.fournisseurs || [];
  const maxTotal = Math.max(1, ...list.map((f: any) => f.total));

  return (
    <div>
      <PeriodNav
        period={period}
        granularities={['month', 'year']}
        onPeriodChange={setPeriod}
        refDate={ref}
        onRefChange={setRef}
        label={data ? periodLabel(period, data.periodStart, data.periodEnd) : '…'}
      />

      {!data ? (
        <div className="text-center py-16 text-gray-400 italic">Chargement...</div>
      ) : list.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-3 opacity-50">📦</div>
          <div className="text-gray-500 font-medium">Aucun achat sur cette période.</div>
        </div>
      ) : (
        <div className="divide-y divide-gray-100">
          {list.map((f: any, i: number) => (
            <div key={f.id} className="flex items-center gap-4 py-3.5">
              <div className="w-7 h-7 rounded-full bg-gray-100 text-gray-500 font-bold text-xs flex items-center justify-center shrink-0">#{i + 1}</div>
              <div className="min-w-0 flex-1">
                <div className="font-bold text-gray-800 truncate">{f.nom}</div>
                <div className="text-xs text-gray-400">{f.nbAchats} achat{f.nbAchats > 1 ? 's' : ''}</div>
              </div>
              <div className="hidden sm:block w-40 shrink-0">
                <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-orange-500" style={{ width: `${(f.total / maxTotal) * 100}%` }} />
                </div>
              </div>
              <div className="text-right w-28 shrink-0">
                <div className="font-black text-orange-600">{Math.round(f.total).toLocaleString()} €</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TypesChantiersTab() {
  const [period, setPeriod] = useState<Period>('month');
  const [ref, setRef] = useReferencePeriode();
  const data = useStatistique('/stats/types-chantiers', period, ref);

  const list = data?.types || [];
  const totalChantiers = data?.totalChantiers || 0;
  const maxCount = Math.max(1, ...list.map((t: any) => t.count));

  return (
    <div>
      <PeriodNav
        period={period}
        granularities={['month', 'year']}
        onPeriodChange={setPeriod}
        refDate={ref}
        onRefChange={setRef}
        label={data ? periodLabel(period, data.periodStart, data.periodEnd) : '…'}
      />

      {!data ? (
        <div className="text-center py-16 text-gray-400 italic">Chargement...</div>
      ) : totalChantiers === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-3 opacity-50">🏗️</div>
          <div className="text-gray-500 font-medium">Aucun chantier démarré sur cette période.</div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table style={{ width: '100%', minWidth: '500px', textAlign: 'left', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                <th style={{ padding: '8px' }}>Type de chantier</th>
                <th style={{ padding: '8px', textAlign: 'right' }}>Nombre de chantiers</th>
                <th style={{ padding: '8px', textAlign: 'right' }}>% du total</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t: any) => (
                <tr key={t.type} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '8px' }}>
                    <div className="flex items-center gap-3">
                      <strong className="text-gray-800 whitespace-nowrap">{t.type}</strong>
                      <div className="hidden sm:block flex-1 h-2 bg-gray-100 rounded-full overflow-hidden min-w-[4rem]">
                        <div className="h-full rounded-full bg-indigo-500" style={{ width: `${(t.count / maxCount) * 100}%` }} />
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '8px', textAlign: 'right' }} className="font-black text-indigo-600">{t.count}</td>
                  <td style={{ padding: '8px', textAlign: 'right' }} className="text-gray-500 font-semibold">{t.pct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-xs text-gray-400 mt-3">
            {totalChantiers} chantier{totalChantiers > 1 ? 's' : ''} démarré{totalChantiers > 1 ? 's' : ''} sur la période
            (un chantier peut compter dans plusieurs types).
          </div>
        </div>
      )}
    </div>
  );
}

const Statistiques = () => {
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const userRole = user?.role || 'CONDUCTEUR_TRAVAUX';

  const [activeTab, setActiveTab] = useState(isAdminRole(userRole) ? 'chantiers' : 'intervenants');

  return (
    <div>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-4 gap-4">
        <div>
          <h1 className="text-primary font-bold m-0">Statistiques</h1>
          <p className="text-sm text-muted mt-1">Vue d'ensemble des chantiers, intervenants et fournisseurs.</p>
        </div>
        <div className="flex gap-1 items-center bg-gray-100 p-2 rounded">
          <span className="text-sm font-semibold text-gray-500">
            Connecté en tant que: <strong className="text-primary-dark">{roleLabel(userRole)}</strong>
          </span>
        </div>
      </div>

      <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
        {isAdminRole(userRole) && (
          <button className={`btn flex items-center gap-2 ${activeTab === 'chantiers' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('chantiers')}>
            <PieChart size={16} /> Chantiers
          </button>
        )}
        <button className={`btn flex items-center gap-2 ${activeTab === 'intervenants' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('intervenants')}>
          <Users size={16} /> Intervenants
        </button>
        <button className={`btn flex items-center gap-2 ${activeTab === 'fournisseurs' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('fournisseurs')}>
          <Truck size={16} /> Fournisseurs
        </button>
        <button className={`btn flex items-center gap-2 ${activeTab === 'types' ? 'btn-primary' : 'bg-white'}`} onClick={() => setActiveTab('types')}>
          <Tags size={16} /> Types de chantiers
        </button>
      </div>

      <div className="card">
        {activeTab === 'chantiers' && isAdminRole(userRole) && (
          <>
            <h2 className="mb-1 text-primary-dark">Répartition des chantiers terminés</h2>
            <p className="text-sm text-muted mb-2">
              Selon l'avance/dépassement sur les heures et le coût de main d'œuvre (« temps »), et sur le budget matériel. Visible uniquement par les administrateurs.
            </p>
            <ChantiersTab />
          </>
        )}
        {activeTab === 'intervenants' && (
          <>
            <h2 className="mb-1 text-primary-dark">Classement des intervenants par heures travaillées</h2>
            <p className="text-sm text-muted mb-4">Toutes affectations confondues, sur la période sélectionnée.</p>
            <IntervenantsTab />
          </>
        )}
        {activeTab === 'fournisseurs' && (
          <>
            <h2 className="mb-1 text-primary-dark">Total des achats par fournisseur</h2>
            <p className="text-sm text-muted mb-4">Sur la période sélectionnée.</p>
            <FournisseursTab />
          </>
        )}
        {activeTab === 'types' && (
          <>
            <h2 className="mb-1 text-primary-dark">Répartition des chantiers par type</h2>
            <p className="text-sm text-muted mb-4">
              Nombre de chantiers démarrés sur la période, classé par ordre décroissant (un chantier peut avoir plusieurs types).
            </p>
            <TypesChantiersTab />
          </>
        )}
      </div>
    </div>
  );
};

export default Statistiques;
