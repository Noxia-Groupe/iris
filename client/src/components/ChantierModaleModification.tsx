import type { RefObject } from 'react';
import { X } from 'lucide-react';
import { SelecteurClient, type ClientActuel } from './SelecteurClient';
import { TYPES_CHANTIER } from '../chantierTypes';
import { isAdminRole } from '../roles';
import { jourCivilChantier } from '../lib/dateFormatting';

export function ChantierModaleModification({ setEditingChantier, handleChantierSubmit, chantier, userRole, editClientId, setEditClientId, clientActuel, editChantierAdresseRef, editResponsableId, setEditResponsableId, conducteurs, commerciaux, editCommercialId, setEditCommercialId, companyTimezone, fuseauConnu, editChantierBudgetRef, libelleBaremeReduit, savingChantier }: {
  setEditingChantier: React.Dispatch<React.SetStateAction<boolean>>;
  handleChantierSubmit: (e: React.FormEvent) => void;
  chantier: any;
  userRole: string;
  editClientId: string;
  setEditClientId: React.Dispatch<React.SetStateAction<string>>;
  clientActuel: ClientActuel | null;
  editChantierAdresseRef: RefObject<HTMLInputElement | null>;
  editResponsableId: string;
  setEditResponsableId: React.Dispatch<React.SetStateAction<string>>;
  conducteurs: any[];
  commerciaux: any[];
  editCommercialId: string;
  setEditCommercialId: React.Dispatch<React.SetStateAction<string>>;
  companyTimezone: string;
  fuseauConnu: boolean;
  editChantierBudgetRef: RefObject<HTMLInputElement | null>;
  libelleBaremeReduit: string;
  savingChantier: boolean;
}) {
  return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setEditingChantier(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 sm:p-8" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold text-primary-dark m-0">Modifier le chantier</h3>
              <button type="button" onClick={() => setEditingChantier(false)} className="text-gray-400 hover:text-gray-600">
                <X size={22} />
              </button>
            </div>
            <form onSubmit={handleChantierSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group mb-0">
                <label className="form-label">Nom du Chantier</label>
                <input required name="nom" defaultValue={chantier.nom} className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label" htmlFor={isAdminRole(userRole) ? 'client-chantier' : undefined}>Client</label>
                {isAdminRole(userRole) ? (
                  <SelecteurClient id="client-chantier" name="clientId" label="Client du chantier" required valeur={editClientId} onChange={(client) => setEditClientId(client?.id ?? '')} clientActuel={clientActuel} />
                ) : <input readOnly value={chantier.client} className="form-input bg-gray-50" />}
              </div>
              <div className="form-group mb-0">
                <label className="form-label">N° de Devis</label>
                {/* Obligatoire, sauf sur un chantier antérieur créé sans devis : l'exiger
                    ici interdirait toute autre correction sur sa fiche. */}
                <input
                  required={!!chantier.numeroDevis}
                  name="numeroDevis"
                  defaultValue={chantier.numeroDevis || ''}
                  className="form-input"
                  placeholder="Référence d'affaire (ex : A26-0001)"
                />
              </div>
              <div className="form-group mb-0 md:col-span-2">
                <label className="form-label">Adresse du site (optionnel)</label>
                <input ref={editChantierAdresseRef} name="adresse" defaultValue={chantier.adresse || ''} className="form-input" placeholder="Adresse du site" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Responsable Chantier</label>
                <select required name="responsableId" className="form-input" value={editResponsableId} onChange={(e) => setEditResponsableId(e.target.value)}>
                  <option value="" disabled>Sélectionner un conducteur...</option>
                  {/* Un titulaire absent de la liste d'attribution (compte désactivé au départ d'un
                      conducteur, ou titulaire qui n'est pas conducteur) y est rajouté, pour ne pas
                      forcer une réaffectation à l'occasion d'une correction sans rapport. Choisir
                      un autre conducteur le remplace. La raison n'est pas connue ici : le libellé
                      ne la présume pas. */}
                  {chantier.responsable && !conducteurs.some(c => c.id === chantier.responsable.id) && (
                    <option value={chantier.responsable.id}>{chantier.responsable.name} (hors des conducteurs actifs)</option>
                  )}
                  {conducteurs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Commercial rattaché{commerciaux.length > 0 ? '' : ' (aucun disponible)'}</label>
                <select required={commerciaux.length > 0} name="commercialId" className="form-input" value={editCommercialId} onChange={(e) => setEditCommercialId(e.target.value)}>
                  <option value="" disabled>Sélectionner un commercial...</option>
                  {chantier.commercial && !commerciaux.some(c => c.id === chantier.commercial.id) && (
                    <option value={chantier.commercial.id}>{chantier.commercial.name} (hors des commerciaux actifs)</option>
                  )}
                  {commerciaux.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Date Début</label>
                {/* Dates lues au jour de la société : non modifiables tant que son fuseau n'est pas lu,
                    pour ne pas effacer une saisie au moment où le champ se recale. Désactivées, elles
                    ne partent pas avec la fiche, qui garde alors ses dates. */}
                <input required type="text" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" name="dateDebut" key={`debut-${companyTimezone}`} defaultValue={jourCivilChantier(chantier.dateDebut, companyTimezone)} disabled={!fuseauConnu} className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Date Fin</label>
                <input type="text" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" name="dateFin" key={`fin-${companyTimezone}`} defaultValue={chantier.dateFin ? jourCivilChantier(chantier.dateFin, companyTimezone) : ''} disabled={!fuseauConnu} className="form-input" />
              </div>
              {/* Montant vendu : seulement pour qui le voit (le serveur refuse qu'un autre le
                  modifie) ; sinon le champ arriverait vide et l'enregistrer l'écraserait. */}
              {chantier.budgetGlobalVendu != null && (
                <div className="form-group mb-0">
                  <label className="form-label font-bold text-primary">Budget Global (€ HT)</label>
                  <input ref={editChantierBudgetRef} required type="number" min="0" step="0.01" name="budgetGlobalVendu" defaultValue={chantier.budgetGlobalVendu} className="form-input" />
                </div>
              )}
              <div className="form-group mb-0">
                <label className="form-label">Total Heures Vendues (h)</label>
                <input required type="number" min="0" step="0.01" name="heuresVendues" defaultValue={chantier.heuresVendues} className="form-input" />
              </div>
              {/* Budgets par poste : seulement pour qui les voit (le serveur refuse qu'un technicien les modifie). */}
              {chantier.budgetMaterielVendu != null && (
                <div className="form-group mb-0">
                  <label className="form-label">Dont Matériel (€ HT)</label>
                  <input required type="number" min="0" step="0.01" name="budgetMaterielVendu" defaultValue={chantier.budgetMaterielVendu} className="form-input" />
                </div>
              )}
              {chantier.budgetMainOeuvreVendu != null && (
                <div className="form-group mb-0">
                  <label className="form-label">Dont Main d'Œuvre (€ HT)</label>
                  <input required type="number" min="0" step="0.01" name="budgetMainOeuvreVendu" defaultValue={chantier.budgetMainOeuvreVendu} className="form-input" />
                </div>
              )}
              <div className="form-group mb-0 md:col-span-2">
                <label className="form-label">Type(s) de chantier</label>
                <div className="flex flex-wrap gap-2">
                  {TYPES_CHANTIER.map((t) => (
                    <label key={t} className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors">
                      <input type="checkbox" name="types" value={t} defaultChecked={chantier.types?.includes(t)} className="w-4 h-4" />
                      {t}
                    </label>
                  ))}
                </div>
              </div>
              <div className="form-group mb-0 md:col-span-2">
                <label className="flex items-center gap-2 text-sm font-medium px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors w-fit">
                  <input type="checkbox" name="baremeReduit" value="true" defaultChecked={!!chantier.baremeReduit} className="w-4 h-4" />
                  {libelleBaremeReduit} (sans effet tant qu'aucun plan commercial n'est attribué)
                </label>
              </div>
              <div className="md:col-span-2 flex gap-2 mt-2">
                <button type="submit" disabled={savingChantier} className="btn btn-primary px-8">
                  {savingChantier ? 'Enregistrement...' : 'Enregistrer les modifications'}
                </button>
                <button type="button" onClick={() => setEditingChantier(false)} className="btn bg-white border">Annuler</button>
              </div>
            </form>
          </div>
        </div>
  );
}
