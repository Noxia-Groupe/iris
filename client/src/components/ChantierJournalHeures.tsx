import { Hammer, Pencil, Trash2, Search } from 'lucide-react';
import { toDateFrancaise, fmtDate, fmtHeures } from '../lib/formats';

export function ChantierJournalHeures({ pointages, heuresTotal, pointageSearch, setPointageSearch, pointageIntervenantFiltre, setPointageIntervenantFiltre, pointagesIntervenantsDispo, pointageRoleFiltre, setPointageRoleFiltre, pointagesRolesDispo, pointageTri, setPointageTri, pointagesFiltreActif, resetPointagesFiltres, pointagesAffiches, editingPointageId, handlePointageSubmit, intervenants, savingPointage, setEditingPointageId, peutCorrigerTravaux, peutArchiverTravaux, startEditPointage, handleDeletePointage, pointagesAffichesTotal }: {
  pointages: any[];
  heuresTotal: number;
  pointageSearch: string;
  setPointageSearch: React.Dispatch<React.SetStateAction<string>>;
  pointageIntervenantFiltre: string;
  setPointageIntervenantFiltre: React.Dispatch<React.SetStateAction<string>>;
  pointagesIntervenantsDispo: string[];
  pointageRoleFiltre: string;
  setPointageRoleFiltre: React.Dispatch<React.SetStateAction<string>>;
  pointagesRolesDispo: string[];
  pointageTri: 'date-desc' | 'date-asc' | 'heures-desc' | 'heures-asc';
  setPointageTri: React.Dispatch<React.SetStateAction<'date-desc' | 'date-asc' | 'heures-desc' | 'heures-asc'>>;
  pointagesFiltreActif: boolean;
  resetPointagesFiltres: () => void;
  pointagesAffiches: any[];
  editingPointageId: string | null;
  handlePointageSubmit: (e: React.FormEvent, pointageId: string) => void;
  intervenants: any[];
  savingPointage: boolean;
  setEditingPointageId: React.Dispatch<React.SetStateAction<string | null>>;
  peutCorrigerTravaux: boolean;
  peutArchiverTravaux: boolean;
  startEditPointage: (pointageId: string) => void;
  handleDeletePointage: (pointageId: string) => void;
  pointagesAffichesTotal: number;
}) {
  return (
          <div className="bg-white rounded-2xl shadow-md border border-gray-100 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Hammer size={18} className="text-purple-500" />
                <h3 className="text-lg font-bold text-primary-dark m-0">Heures du chantier</h3>
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-purple-50 text-purple-600">
                  {pointages.length} pointage{pointages.length > 1 ? 's' : ''}
                </span>
              </div>
              <div className="text-sm text-muted">
                Total pointé : <strong className="text-primary-dark">{fmtHeures(heuresTotal)}</strong>
              </div>
            </div>

            {pointages.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 px-6 py-3 bg-gray-50 border-b border-gray-100">
                <div className="relative flex-1 min-w-[220px]">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                  <input
                    type="search"
                    value={pointageSearch}
                    onChange={(e) => setPointageSearch(e.target.value)}
                    placeholder="Rechercher (intervenant, rôle, commentaire, date...)"
                    style={{ paddingLeft: '2.25rem' }}
                    className="form-input text-sm"
                  />
                </div>
                <div className="w-full sm:w-52">
                  <select value={pointageIntervenantFiltre} onChange={(e) => setPointageIntervenantFiltre(e.target.value)} className="form-input text-sm">
                    <option value="">Tous les intervenants</option>
                    {pointagesIntervenantsDispo.map((i) => <option key={i} value={i}>{i}</option>)}
                  </select>
                </div>
                <div className="w-full sm:w-52">
                  <select value={pointageRoleFiltre} onChange={(e) => setPointageRoleFiltre(e.target.value)} className="form-input text-sm">
                    <option value="">Tous les rôles</option>
                    {pointagesRolesDispo.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div className="w-full sm:w-60">
                  <select value={pointageTri} onChange={(e) => setPointageTri(e.target.value as typeof pointageTri)} className="form-input text-sm">
                    <option value="date-desc">Du plus récent au plus ancien</option>
                    <option value="date-asc">Du plus ancien au plus récent</option>
                    <option value="heures-desc">Heures décroissantes</option>
                    <option value="heures-asc">Heures croissantes</option>
                  </select>
                </div>
                {pointagesFiltreActif && (
                  <button type="button" onClick={resetPointagesFiltres} className="text-xs font-semibold text-accent hover:underline">
                    Réinitialiser
                  </button>
                )}
              </div>
            )}

            {pointages.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-400 italic">Aucune heure enregistrée.</div>
            ) : pointagesAffiches.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-400 italic">Aucun pointage ne correspond à la recherche.</div>
            ) : (
              <div className="divide-y divide-gray-100 max-h-[32rem] overflow-y-auto">
                {pointagesAffiches.map((p) => (
                  editingPointageId === p.id ? (
                    <form
                      key={p.id}
                      onSubmit={(e) => handlePointageSubmit(e, p.id)}
                      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 px-6 py-3 bg-gray-50"
                    >
                      <input required type="text" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" name="date" defaultValue={toDateFrancaise(p.date)} className="form-input text-sm" />
                      <select required name="intervenantId" defaultValue={p.intervenantId} className="form-input text-sm">
                        {intervenants.length === 0 && <option value={p.intervenantId}>{p.intervenant?.nom}</option>}
                        {intervenants.map((i) => <option key={i.id} value={i.id}>{i.nom} ({i.role})</option>)}
                      </select>
                      <input required type="number" step="0.5" min="0.5" name="nbrHeures" defaultValue={p.nbrHeures} className="form-input text-sm" />
                      <input type="text" name="commentaire" defaultValue={p.commentaire || ''} placeholder="Commentaire" className="form-input text-sm" />
                      <input required minLength={3} maxLength={500} type="text" name="motifCorrection" placeholder="Motif de la correction" className="form-input text-sm sm:col-span-2 lg:col-span-3" />
                      <div className="sm:col-span-2 lg:col-span-4 flex gap-2 justify-end">
                        <button type="button" disabled={savingPointage} onClick={() => setEditingPointageId(null)} className="btn bg-white border text-xs px-3 py-1.5">Annuler</button>
                        <button type="submit" disabled={savingPointage} className="btn btn-primary text-xs px-3 py-1.5">
                          {savingPointage ? 'Enregistrement...' : 'Enregistrer'}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div key={p.id} className="flex items-center justify-between gap-3 px-6 py-3 text-sm hover:bg-gray-50 transition-colors">
                      <div className="min-w-0">
                        <div className="font-semibold text-gray-700">{p.intervenant?.nom}</div>
                        <div className="text-xs text-gray-400">
                          {fmtDate(p.date)} · {p.intervenant?.role}
                          {p.commentaire ? ` · ${p.commentaire}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="font-bold text-gray-800 whitespace-nowrap">{fmtHeures(p.nbrHeures)}</div>
                        {(peutCorrigerTravaux || peutArchiverTravaux) && (
                          <>
                            {peutCorrigerTravaux && <button
                              onClick={() => startEditPointage(p.id)}
                              className="p-1.5 text-gray-400 hover:text-accent hover:bg-blue-50 rounded-lg transition-colors"
                              title="Corriger ce pointage"
                            >
                              <Pencil size={14} />
                            </button>}
                            {peutArchiverTravaux && <button
                              onClick={() => handleDeletePointage(p.id)}
                              disabled={savingPointage}
                              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                              title="Archiver ce pointage"
                            >
                              <Trash2 size={14} />
                            </button>}
                          </>
                        )}
                      </div>
                    </div>
                  )
                ))}
              </div>
            )}
            {pointagesFiltreActif && pointagesAffiches.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 border-t border-gray-100 bg-gray-50 text-xs font-semibold text-gray-500">
                <span>{pointagesAffiches.length} pointage{pointagesAffiches.length > 1 ? 's' : ''} sur {pointages.length}</span>
                <span>Sous-total : <strong className="text-primary-dark">{fmtHeures(pointagesAffichesTotal)}</strong></span>
              </div>
            )}
          </div>
  );
}
