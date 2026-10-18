import { useState, useEffect, useRef } from 'react';
import { Activity } from 'lucide-react';
import { apiFetch } from '../api';
import { decalerReference, jourFrancais } from '../lib/dateFormatting';
import { useReferencePeriode } from '../lib/referencePeriode';
import { arrondiEuro } from '../lib/montants';


// Plage d'heures affichée pour le créneau de saisie habituel (6h -> 19h).
const HOUR_RANGE = Array.from({ length: 14 }, (_, i) => i + 6);

// Performances & assiduité des conducteurs de travaux — page réservée aux administrateurs
// (extraite de l'onglet « Performances » d'Administration pour être son propre menu, cf.
// lib/menu.ts). La route elle-même est protégée côté client (PrivateRoute requiredRoles).
// Côté serveur, les deux routes appelées ici servent aussi un responsable, limité à sa
// branche hiérarchique et, pour le CA et la marge, aux destinataires de la rentabilité.
const Performances = () => {
  const [perf, setPerf] = useState<any[]>([]);
  const [assiduite, setAssiduite] = useState<any>(null);
  // N'importe quelle date de la semaine affichée (le serveur calcule lundi-vendredi).
  const [weekRef, setWeekRef] = useReferencePeriode();
  // Seule la dernière demande d'assiduité s'affiche : une réponse dépassée (semaine changée, ou
  // fuseau de la société lu entre-temps) est ignorée.
  const requeteAssiduite = useRef(0);

  useEffect(() => {
    fetchPerf();
  }, []);

  useEffect(() => {
    fetchAssiduite();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekRef]);

  const fetchPerf = async () => {
    try {
      const res = await apiFetch('/stats/conducteurs');
      if (res.ok) setPerf(await res.json());
    } catch (e) {
      console.error(e);
    }
  };

  const fetchAssiduite = async () => {
    const requete = ++requeteAssiduite.current;
    try {
      const res = await apiFetch(`/stats/conducteurs/assiduite?week=${weekRef}`);
      const donnees = res.ok ? await res.json() : null;
      if (donnees && requete === requeteAssiduite.current) setAssiduite(donnees);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div>
      <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4 mb-6 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-primary-dark m-0 flex items-center gap-2"><Activity size={22} /> Performances</h1>
          <p className="text-sm text-muted mt-1">
            Classées par marge commerciale générée. Visible uniquement par les administrateurs.
          </p>
        </div>
        <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg p-1.5 self-start xl:shrink-0">
          <button type="button" onClick={() => setWeekRef(decalerReference(weekRef, 'week', -1))} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500 font-bold" title="Semaine précédente">‹</button>
          {/* Sur téléphone, le libellé se replie sur deux lignes pour garder ‹ › sur la même ligne. */}
          <span className="min-w-0 flex-1 text-center text-sm font-semibold text-gray-700 px-2 sm:flex-none sm:whitespace-nowrap">
            Semaine du {assiduite ? jourFrancais(assiduite.weekStart) : '…'} au {assiduite ? jourFrancais(assiduite.weekEnd) : '…'}
          </span>
          <button type="button" onClick={() => setWeekRef(decalerReference(weekRef, 'week', 1))} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500 font-bold" title="Semaine suivante">›</button>
          <button type="button" onClick={() => setWeekRef(null)} className="ml-1 text-xs font-semibold px-2 py-1.5 rounded-md hover:bg-gray-100 text-accent">Aujourd'hui</button>
        </div>
      </div>

      {perf.length === 0 ? (
        <div className="card text-center py-12 text-gray-400 italic">
          Aucune donnée (aucun chantier affecté à un conducteur).
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {perf.map((p, i) => {
            const a = assiduite?.conducteurs?.find((c: any) => c.id === p.id);
            const maxSaisies = Math.max(1, ...(a?.tranchesHoraires || []).map((t: any) => t.nbSaisies));
            const tranchesMap = new Map<number, number>((a?.tranchesHoraires || []).map((t: any) => [t.heure, t.nbSaisies] as [number, number]));
            return (
            <div key={p.id} className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-gray-100 text-gray-500 font-bold text-sm flex items-center justify-center shrink-0">#{i + 1}</div>
                  <div className="min-w-0">
                    <div className="font-bold text-gray-800 break-words">{p.name}</div>
                    <div className="text-xs text-muted break-all">{p.email}</div>
                  </div>
                </div>
                <div className="text-right text-xs font-semibold text-gray-500 whitespace-nowrap">
                  {p.nbChantiersEnCours} en cours · {p.nbChantiersTermines} terminé{p.nbChantiersTermines > 1 ? 's' : ''}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">CA vendu</div>
                  <div className="font-bold text-gray-800 mt-0.5">{arrondiEuro(p.caTotal).toLocaleString()} €</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Marge générée</div>
                  <div className={`font-bold mt-0.5 ${p.margeTotal >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{arrondiEuro(p.margeTotal).toLocaleString()} €</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Marge %</div>
                  <div className="font-bold text-gray-800 mt-0.5">{(p.margePct ?? 0).toFixed(1)}%</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-4">
                <div>
                  <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide mb-1.5">Chantiers en cours — heures</div>
                  <div className="flex gap-2">
                    <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full bg-emerald-100 text-emerald-700">{p.nbEnAvanceHeures} en avance</span>
                    <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full bg-red-100 text-red-700">{p.nbEnRetardHeures} en retard</span>
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide mb-1.5">Chantiers en cours — matériel</div>
                  <div className="flex gap-2">
                    <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full bg-emerald-100 text-emerald-700">{p.nbMaterielDansBudget} dans le budget</span>
                    <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full bg-red-100 text-red-700">{p.nbMaterielDepasse} dépassé{p.nbMaterielDepasse > 1 ? 's' : ''}</span>
                  </div>
                </div>
              </div>

              {/* Même chose pour les chantiers TERMINÉS — sans quoi un dépassement disparaît
                  purement et simplement de ces stats dès la clôture du chantier. */}
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div>
                  <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide mb-1.5">Chantiers terminés — heures</div>
                  <div className="flex gap-2">
                    <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full bg-emerald-100 text-emerald-700">{p.nbTermineEnAvanceHeures} dans les clous</span>
                    <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full bg-red-100 text-red-700">{p.nbTermineEnRetardHeures} dépassé{p.nbTermineEnRetardHeures > 1 ? 's' : ''}</span>
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide mb-1.5">Chantiers terminés — matériel</div>
                  <div className="flex gap-2">
                    <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full bg-emerald-100 text-emerald-700">{p.nbTermineMaterielDansBudget} dans le budget</span>
                    <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full bg-red-100 text-red-700">{p.nbTermineMaterielDepasse} dépassé{p.nbTermineMaterielDepasse > 1 ? 's' : ''}</span>
                  </div>
                </div>
              </div>

              {/* Dépassement d'heures sur les seuls chantiers TERMINÉS (résultat définitif —
                  un chantier en cours a encore des heures disponibles, le mélanger fausserait
                  le taux), avec son impact en euros valorisé au taux horaire moyen réellement
                  appliqué (manque à gagner sur les heures en trop, pas sur le budget vendu). */}
              <div className="pt-3 mb-3 border-t border-gray-100 flex items-center justify-between flex-wrap gap-2">
                <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">Dépassement heures (chantiers terminés)</span>
                {p.tauxDepassementHeures == null ? (
                  <span className="text-sm text-gray-400 italic">Aucun chantier terminé</span>
                ) : (
                  <div className="flex items-center gap-3">
                    <span className={`text-sm font-black ${p.tauxDepassementHeures > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                      {p.tauxDepassementHeures.toFixed(1)}%
                    </span>
                    <span className={`text-sm font-black ${p.manqueAGagnerMainOeuvre > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                      {p.manqueAGagnerMainOeuvre > 0 ? `-${arrondiEuro(p.manqueAGagnerMainOeuvre).toLocaleString()} €` : '0 €'}
                    </span>
                  </div>
                )}
              </div>

              <div className="pt-3 mb-3 border-t border-gray-100 flex items-center justify-between">
                <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">Objectifs respectés (chantiers terminés)</span>
                {p.tauxObjectifsRespectes == null ? (
                  <span className="text-sm text-gray-400 italic">Aucun chantier terminé</span>
                ) : (
                  <span className={`text-sm font-black ${p.tauxObjectifsRespectes >= 50 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {p.nbObjectifsRespectes}/{p.nbChantiersTermines} ({p.tauxObjectifsRespectes.toFixed(0)}%)
                  </span>
                )}
              </div>

              {/* Assiduité de saisie : usage réel de l'app cette semaine-là, pas l'avancement des chantiers */}
              <div className="pt-3 border-t border-gray-100">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">Assiduité de saisie (semaine)</span>
                  {a && (
                    <span className={`text-sm font-black ${a.joursActifs >= 4 ? 'text-emerald-600' : a.joursActifs >= 2 ? 'text-amber-600' : 'text-red-600'}`}>
                      {a.joursActifs}/5 jours actifs
                    </span>
                  )}
                </div>

                {!a || a.nbSaisiesTotal === 0 ? (
                  <div className="text-sm text-gray-400 italic py-2">Aucune saisie sur cette semaine.</div>
                ) : (
                  <>
                    <div className="grid grid-cols-5 gap-1.5 mb-3">
                      {a.days.map((d: any) => (
                        <div key={d.date} className={`rounded-lg px-1 py-2 text-center ${d.nbSaisies > 0 ? 'bg-emerald-50' : 'bg-gray-50'}`}>
                          <div className="text-[10px] font-bold text-gray-500 uppercase">{d.label.slice(0, 3)}</div>
                          <div className={`text-sm font-black mt-0.5 ${d.nbSaisies > 0 ? 'text-emerald-700' : 'text-gray-300'}`}>
                            {d.nbSaisies > 0 ? `${d.heuresSaisies.toFixed(1)}h` : '—'}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
                      <span>{a.heuresTotalesSaisies.toFixed(1)}h saisies · {a.nbSaisiesTotal} saisie{a.nbSaisiesTotal > 1 ? 's' : ''}</span>
                      <span>{a.moyenneHeuresParJourActif.toFixed(1)}h / jour actif en moyenne</span>
                    </div>

                    <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide mb-1">
                      Créneau de saisie habituel {a.heurePic != null && <span className="text-accent">— vers {a.heurePic}h-{a.heurePic + 1}h</span>}
                    </div>
                    <div className="flex items-end gap-0.5 h-12">
                      {HOUR_RANGE.map((h) => {
                        const count = tranchesMap.get(h) || 0;
                        const heightPct = count > 0 ? Math.max(12, (count / maxSaisies) * 100) : 4;
                        return (
                          <div key={h} className="flex-1 flex flex-col items-center justify-end h-full" title={`${h}h : ${count} saisie${count > 1 ? 's' : ''}`}>
                            <div
                              className={`w-full rounded-t-sm transition-all ${h === a.heurePic ? 'bg-accent' : count > 0 ? 'bg-purple-300' : 'bg-gray-100'}`}
                              style={{ height: `${heightPct}%` }}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex justify-between text-[9px] text-gray-400 mt-1">
                      <span>{HOUR_RANGE[0]}h</span>
                      <span>{HOUR_RANGE[HOUR_RANGE.length - 1]}h</span>
                    </div>
                  </>
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default Performances;
