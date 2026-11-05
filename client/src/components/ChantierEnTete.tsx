import { Calendar, User, Clock3, Briefcase, MapPin } from 'lucide-react';
import { isAdminRole } from '../roles';
import { jourCivilChantier } from '../lib/dateFormatting';
import { AlertesChantier } from './AlertesChantier';
import { ancienneteSaisie } from '../lib/suiviChantiers';
import { toDateFrancaise } from '../lib/formatsChantier';

const STATUT_LABELS: Record<string, string> = { EN_COURS: 'En cours', TERMINE: 'Terminé', ANNULE: 'Annulé' };

export function ChantierEnTete({ chantier, isTermine, libelleBaremeReduit, userRole, handleToggleEncaisse, savingEncaisse, companyTimezone, joursEcoules, metrics, editingCommercial, savingCommercial, handleAssignCommercial, setEditingCommercial, commerciaux, canEditCommercial, startEditCommercial }: {
  chantier: any;
  isTermine: boolean;
  libelleBaremeReduit: string;
  userRole: string;
  handleToggleEncaisse: () => void;
  savingEncaisse: boolean;
  companyTimezone: string;
  joursEcoules: number;
  metrics: any;
  editingCommercial: boolean;
  savingCommercial: boolean;
  handleAssignCommercial: (commercialId: string) => void;
  setEditingCommercial: React.Dispatch<React.SetStateAction<boolean>>;
  commerciaux: any[];
  canEditCommercial: boolean;
  startEditCommercial: () => void;
}) {
  return (
    <>
          <div className="mb-8">
            <div className="flex items-center gap-3 flex-wrap mb-2">
              <h2 className="text-3xl font-extrabold text-primary-dark tracking-tight m-0">{chantier.nom}</h2>
              <span className={`text-xs font-bold uppercase tracking-wide px-2.5 py-1 rounded-full ${isTermine ? 'bg-gray-100 text-gray-500' : 'bg-blue-100 text-accent'}`}>
                {STATUT_LABELS[chantier.statut] || chantier.statut}
              </span>
              {chantier.types?.map((t: string) => (
                <span key={t} className="text-[11px] font-semibold px-2.5 py-1 bg-indigo-50 text-indigo-700 rounded-full">{t}</span>
              ))}
              {chantier.baremeReduit && (
                <span className="text-[11px] font-semibold px-2.5 py-1 bg-amber-50 text-amber-700 rounded-full">{libelleBaremeReduit}</span>
              )}
              {chantier.statut === 'TERMINE' && (isAdminRole(userRole) ? (
                <button
                  type="button"
                  onClick={handleToggleEncaisse}
                  disabled={savingEncaisse}
                  title="Réservé aux admins : conditionne le résultat commercial du mois de clôture"
                  className={`text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full transition-colors ${chantier.encaisse ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-red-50 text-red-600 hover:bg-red-100'}`}
                >
                  {chantier.encaisse ? '✓ Encaissé' : 'Non encaissé'}
                </button>
              ) : (
                <span className={`text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full ${chantier.encaisse ? 'bg-emerald-100 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                  {chantier.encaisse ? '✓ Encaissé' : 'Non encaissé'}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-gray-600">
              <span className="flex items-center gap-1.5"><strong className="text-gray-800">Client:</strong> {chantier.client}</span>
              <span className="flex items-center gap-1.5"><strong className="text-gray-800">Devis:</strong> {chantier.numeroDevis || 'N/A'}</span>
              {chantier.adresse && (
                <span className="flex items-center gap-1.5"><MapPin size={14} className="text-gray-400" /> {chantier.adresse}</span>
              )}
              {chantier.responsable?.name && (
                <span className="flex items-center gap-1.5"><User size={14} className="text-gray-400" /> {chantier.responsable.name}</span>
              )}
              <span className="flex items-center gap-1.5">
                <Calendar size={14} className="text-gray-400" />
                Démarré le {jourCivilChantier(chantier.dateDebut, companyTimezone)}
                {isTermine && chantier.dateFin ? ` — terminé le ${jourCivilChantier(chantier.dateFin, companyTimezone)} (${joursEcoules} j)` : ` (il y a ${joursEcoules} j)`}
              </span>
              {metrics.joursSansSaisie != null && (
                <span className="flex items-center gap-1.5" data-derniere-saisie>
                  <Clock3 size={14} className="text-gray-400" />
                  Dernière saisie : {metrics.derniereSaisie ? `${toDateFrancaise(metrics.derniereSaisie)} (${ancienneteSaisie(metrics.joursSansSaisie)})` : 'aucune depuis le démarrage'}
                </span>
              )}
              {editingCommercial ? (
                <span className="flex items-center gap-1.5">
                  <Briefcase size={14} className="text-gray-400" />
                  <select
                    autoFocus
                    disabled={savingCommercial}
                    defaultValue={chantier.commercial?.id || ''}
                    onChange={(e) => handleAssignCommercial(e.target.value)}
                    onBlur={() => setEditingCommercial(false)}
                    className="text-sm border border-gray-200 rounded-md px-2 py-0.5"
                  >
                    <option value="" disabled>Sélectionner un commercial...</option>
                    {commerciaux.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <Briefcase size={14} className="text-gray-400" />
                  {chantier.commercial?.name || <span className="italic text-gray-400">Aucun commercial</span>}
                  {canEditCommercial && (
                    <button type="button" onClick={startEditCommercial} className="text-xs font-semibold text-accent hover:underline ml-1">
                      Modifier
                    </button>
                  )}
                </span>
              )}
            </div>
          </div>

          {/* Alertes de suivi, calculées par le serveur : une fiche saine le dit aussi. */}
          <div className="-mt-4 mb-6" data-alertes-fiche>
            {/* Affaire annulée (#483) : ni « Dans le budget » ni alerte, mais « Affaire annulée ». */}
            {chantier.statut === 'ANNULE' ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                Affaire annulée
              </span>
            ) : (
              <AlertesChantier chantier={chantier} afficherSiSain />
            )}
          </div>

          {/* Bannière de rappel : un chantier Terminé mais Non encaissé ne compte pas dans
              le résultat commercial du mois (CA et marge validés).
              Le badge ci-dessus permet déjà de basculer ce statut, mais reste discret parmi
              les autres badges — cette bannière rend l'action impossible à manquer. */}
          {chantier.statut === 'TERMINE' && !chantier.encaisse && isAdminRole(userRole) && (
            <div className="mb-6 p-4 rounded-xl border-l-8 border-amber-500 bg-amber-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="font-bold text-amber-800">Chantier terminé, en attente d'encaissement</div>
                <div className="text-sm text-amber-700">
                  Tant que l'encaissement n'est pas validé, ce chantier ne compte pas dans le CA et la marge validés du commercial.
                </div>
              </div>
              <button
                type="button"
                onClick={handleToggleEncaisse}
                disabled={savingEncaisse}
                className="shrink-0 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-semibold text-sm transition-colors"
              >
                {savingEncaisse ? 'Validation...' : "Valider l'encaissement"}
              </button>
            </div>
          )}
    </>
  );
}
