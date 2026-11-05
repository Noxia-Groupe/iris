import { Wallet, Pencil, Trash2, Search } from 'lucide-react';
import { toDateFrancaise, fmtDate, fmtEuro } from '../lib/formats';

export function ChantierJournalAchats({ achats, achatsTotal, achatSearch, setAchatSearch, achatFournisseurFiltre, setAchatFournisseurFiltre, achatsFournisseursDispo, achatCategorieFiltre, setAchatCategorieFiltre, achatsCategoriesDispo, achatTri, setAchatTri, achatsFiltreActif, resetAchatsFiltres, achatsAffiches, editingAchatId, handleAchatSubmit, fournisseurs, categories, savingAchat, setEditingAchatId, peutCorrigerTravaux, peutArchiverTravaux, startEditAchat, handleDeleteAchat, achatsAffichesTotal }: {
  achats: any[];
  achatsTotal: number;
  achatSearch: string;
  setAchatSearch: React.Dispatch<React.SetStateAction<string>>;
  achatFournisseurFiltre: string;
  setAchatFournisseurFiltre: React.Dispatch<React.SetStateAction<string>>;
  achatsFournisseursDispo: string[];
  achatCategorieFiltre: string;
  setAchatCategorieFiltre: React.Dispatch<React.SetStateAction<string>>;
  achatsCategoriesDispo: string[];
  achatTri: 'date-desc' | 'date-asc' | 'montant-desc' | 'montant-asc';
  setAchatTri: React.Dispatch<React.SetStateAction<'date-desc' | 'date-asc' | 'montant-desc' | 'montant-asc'>>;
  achatsFiltreActif: boolean;
  resetAchatsFiltres: () => void;
  achatsAffiches: any[];
  editingAchatId: string | null;
  handleAchatSubmit: (e: React.FormEvent, achatId: string) => void;
  fournisseurs: any[];
  categories: any[];
  savingAchat: boolean;
  setEditingAchatId: React.Dispatch<React.SetStateAction<string | null>>;
  peutCorrigerTravaux: boolean;
  peutArchiverTravaux: boolean;
  startEditAchat: (achatId: string) => void;
  handleDeleteAchat: (achatId: string) => void;
  achatsAffichesTotal: number;
}) {
  return (
          <div className="bg-white rounded-2xl shadow-md border border-gray-100 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Wallet size={18} className="text-accent" />
                <h3 className="text-lg font-bold text-primary-dark m-0">Achats du chantier</h3>
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-blue-50 text-accent">
                  {achats.length} achat{achats.length > 1 ? 's' : ''}
                </span>
              </div>
              <div className="text-sm text-muted">
                Total dépensé : <strong className="text-primary-dark">{fmtEuro(achatsTotal)}</strong>
              </div>
            </div>

            {achats.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 px-6 py-3 bg-gray-50 border-b border-gray-100">
                {/* La place de la loupe est réservée en style inline : .form-input pose son
                    propre padding hors couche Tailwind, un utilitaire pl-* serait ignoré. */}
                <div className="relative flex-1 min-w-[220px]">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                  <input
                    type="search"
                    value={achatSearch}
                    onChange={(e) => setAchatSearch(e.target.value)}
                    placeholder="Rechercher (description, n° de facture, fournisseur, montant...)"
                    style={{ paddingLeft: '2.25rem' }}
                    className="form-input text-sm"
                  />
                </div>
                {/* Largeurs portées par des conteneurs : sur le champ lui-même, les
                    utilitaires Tailwind perdraient contre le width:100% de .form-input. */}
                <div className="w-full sm:w-52">
                  <select value={achatFournisseurFiltre} onChange={(e) => setAchatFournisseurFiltre(e.target.value)} className="form-input text-sm">
                    <option value="">Tous les fournisseurs</option>
                    {achatsFournisseursDispo.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div className="w-full sm:w-52">
                  <select value={achatCategorieFiltre} onChange={(e) => setAchatCategorieFiltre(e.target.value)} className="form-input text-sm">
                    <option value="">Toutes les catégories</option>
                    {achatsCategoriesDispo.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="w-full sm:w-60">
                  <select value={achatTri} onChange={(e) => setAchatTri(e.target.value as typeof achatTri)} className="form-input text-sm">
                    <option value="date-desc">Du plus récent au plus ancien</option>
                    <option value="date-asc">Du plus ancien au plus récent</option>
                    <option value="montant-desc">Montant décroissant</option>
                    <option value="montant-asc">Montant croissant</option>
                  </select>
                </div>
                {achatsFiltreActif && (
                  <button type="button" onClick={resetAchatsFiltres} className="text-xs font-semibold text-accent hover:underline">
                    Réinitialiser
                  </button>
                )}
              </div>
            )}

            {achats.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-400 italic">Aucun achat enregistré.</div>
            ) : achatsAffiches.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-400 italic">Aucun achat ne correspond à la recherche.</div>
            ) : (
              <div className="divide-y divide-gray-100 max-h-[32rem] overflow-y-auto">
                {achatsAffiches.map((a) => (
                  editingAchatId === a.id ? (
                    <form
                      key={a.id}
                      onSubmit={(e) => handleAchatSubmit(e, a.id)}
                      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 px-6 py-3 bg-gray-50"
                    >
                      <input required type="text" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" name="date" defaultValue={toDateFrancaise(a.date)} className="form-input text-sm" />
                      <input required type="number" step="0.01" name="montantHT" defaultValue={a.montantHT} placeholder="Montant HT" className="form-input text-sm" />
                      <select required name="fournisseurId" defaultValue={a.fournisseurId} className="form-input text-sm">
                        {fournisseurs.length === 0 && <option value={a.fournisseurId}>{a.fournisseur?.nom}</option>}
                        {fournisseurs.map((f) => <option key={f.id} value={f.id}>{f.nom}</option>)}
                      </select>
                      <select required name="categorieId" defaultValue={a.categorieId} className="form-input text-sm">
                        {categories.length === 0 && <option value={a.categorieId}>{a.categorie?.nom}</option>}
                        {categories.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
                      </select>
                      <input required type="text" name="description" defaultValue={a.description} placeholder="Description" className="form-input text-sm sm:col-span-2 lg:col-span-3" />
                      <input type="text" name="numeroFacture" defaultValue={a.numeroFacture || ''} placeholder="N° de facture (optionnel)" className="form-input text-sm sm:col-span-2 lg:col-span-1" />
                      <input required minLength={3} maxLength={500} type="text" name="motifCorrection" placeholder="Motif de la correction" className="form-input text-sm sm:col-span-2 lg:col-span-4" />
                      <div className="sm:col-span-2 lg:col-span-4 flex gap-2 justify-end">
                        <button type="button" disabled={savingAchat} onClick={() => setEditingAchatId(null)} className="btn bg-white border text-xs px-3 py-1.5">Annuler</button>
                        <button type="submit" disabled={savingAchat} className="btn btn-primary text-xs px-3 py-1.5">
                          {savingAchat ? 'Enregistrement...' : 'Enregistrer'}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div key={a.id} className="flex items-center justify-between gap-3 px-6 py-3 text-sm hover:bg-gray-50 transition-colors">
                      <div className="min-w-0">
                        <div className="font-semibold text-gray-700">{a.description}</div>
                        <div className="text-xs text-gray-400">
                          {fmtDate(a.date)} · {a.fournisseur?.nom} · {a.categorie?.nom}
                          {a.numeroFacture ? ` · Facture ${a.numeroFacture}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="font-bold text-gray-800 whitespace-nowrap">{fmtEuro(a.montantHT)}</div>
                        {(peutCorrigerTravaux || peutArchiverTravaux) && (
                          <>
                            {peutCorrigerTravaux && <button
                              onClick={() => startEditAchat(a.id)}
                              className="p-1.5 text-gray-400 hover:text-accent hover:bg-blue-50 rounded-lg transition-colors"
                              title="Corriger cet achat"
                            >
                              <Pencil size={14} />
                            </button>}
                            {peutArchiverTravaux && <button
                              onClick={() => handleDeleteAchat(a.id)}
                              disabled={savingAchat}
                              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                              title="Archiver cet achat"
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
            {/* Récapitulatif de la sélection : n'a de sens qu'une fois la liste filtrée,
                sinon il répète le total affiché en en-tête. */}
            {achatsFiltreActif && achatsAffiches.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 border-t border-gray-100 bg-gray-50 text-xs font-semibold text-gray-500">
                <span>{achatsAffiches.length} achat{achatsAffiches.length > 1 ? 's' : ''} sur {achats.length}</span>
                <span>Sous-total : <strong className="text-primary-dark">{fmtEuro(achatsAffichesTotal)}</strong></span>
              </div>
            )}
          </div>
  );
}
