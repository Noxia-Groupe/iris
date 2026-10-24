import { useId, useState } from 'react';
import { CalendarX2, Trash2, X } from 'lucide-react';
import { apiFetch } from '../api';
import type { Intervenant, ChantierLite, PlanningType, PlanningEvent } from '../planningUtils';
import { jourFrancais } from '../lib/dateFormatting';
import { interventionRemettable } from '../lib/remiseAPlanifier';
import { RemiseAPlanifier } from './RemiseAPlanifier';

export type ModalState =
  | { mode: 'create'; date: string; intervenantId?: string }
  | { mode: 'edit'; event: PlanningEvent };

const CATEGORIES: { value: PlanningEvent['categorie']; label: string }[] = [
  { value: 'CHANTIER', label: 'Chantier suivi' },
  { value: 'HORS_CHANTIER', label: 'Hors suivi (SAV…)' },
  { value: 'EVENEMENT', label: 'Événement' },
];

const CRENEAUX: { value: PlanningEvent['creneau']; label: string }[] = [
  { value: 'JOURNEE', label: 'Journée' },
  { value: 'MATIN', label: 'Matin' },
  { value: 'APRES_MIDI', label: 'Après-midi' },
  { value: 'HEURES', label: 'Heures précises' },
];

// ---------------------------------------------------------------------------
// Modale de création / édition d'une affectation.
// Champs texte/dates non contrôlés (FormData, comme le reste de l'appli) ; seuls la
// catégorie, le créneau et le choix de type (pour afficher/masquer les sections
// correspondantes) sont contrôlés.
// ---------------------------------------------------------------------------
export const EventModal = ({
  modal,
  intervenants,
  chantiers,
  types,
  onClose,
  onSaved,
  onDelete,
  onTypesChanged,
  onRemise,
}: {
  modal: ModalState;
  intervenants: Intervenant[];
  chantiers: ChantierLite[];
  types: PlanningType[];
  onClose: () => void;
  onSaved: () => void;
  onDelete: (ev: PlanningEvent) => void;
  onTypesChanged: () => void;
  // Intervention (visite de contrat ou curative) remise « à planifier » depuis son affectation : créneau libéré.
  onRemise: () => void;
}) => {
  const isEdit = modal.mode === 'edit';
  const event = isEdit ? modal.event : null;
  const linkedIntervention = !!event?.interventionId;
  // Remise « à planifier » d'une intervention planifiée, visite de contrat ou curative (décisions de Nelson
  // du 23-10-2026, nuit, et du 24-10-2026, point 1).
  const remettable = !!event?.interventionId && interventionRemettable(event.intervention);
  const [remiseOuverte, setRemiseOuverte] = useState(false);
  const titreId = useId();
  const [categorie, setCategorie] = useState<PlanningEvent['categorie']>(event?.categorie || 'CHANTIER');
  const [creneau, setCreneau] = useState<PlanningEvent['creneau']>(event?.creneau || 'JOURNEE');
  const [typeSel, setTypeSel] = useState<string>(event?.typeEventId || '');
  const [saving, setSaving] = useState(false);

  // On ne propose que les chantiers en cours (c'est le sens du module) ; si une
  // affectation existante pointe un chantier depuis clôturé, on le garde en option
  // pour ne pas casser l'édition.
  const chantiersEnCours = chantiers
    .filter((c) => c.statut === 'EN_COURS' || (event?.chantierId === c.id))
    .sort((a, b) => a.nom.localeCompare(b.nom));

  // Saisie au format JJ-MM-AAAA (décision de Nelson du 14-10-2026) ; le serveur lit aussi AAAA-MM-JJ.
  const enSaisie = (jourIso: string) => (jourIso ? jourFrancais(jourIso) : '');
  const defaultDebut = enSaisie(isEdit ? event!.dateDebut.slice(0, 10) : modal.date);
  const defaultFin = enSaisie(isEdit ? event!.dateFin.slice(0, 10) : modal.date);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);

    const intervenantIds = fd.getAll('intervenantIds').map(String);
    if (intervenantIds.length === 0) {
      alert('Sélectionnez au moins un technicien.');
      return;
    }

    setSaving(true);
    try {
      // Création d'un nouveau type d'événement à la volée si demandé.
      let typeEventId = typeSel;
      if (categorie === 'EVENEMENT' && typeSel === '__new__') {
        const nom = String(fd.get('nouveauTypeNom') || '').trim();
        if (!nom) {
          alert("Saisissez le libellé du nouveau type d'événement.");
          setSaving(false);
          return;
        }
        const resType = await apiFetch('/planning/types', {
          method: 'POST',
          body: JSON.stringify({ nom, couleur: fd.get('nouveauTypeCouleur') }),
        });
        const dType = await resType.json();
        if (!resType.ok) {
          alert(dType.error || 'Erreur lors de la création du type.');
          setSaving(false);
          return;
        }
        typeEventId = dType.id;
        onTypesChanged();
      }

      const payload = {
        categorie,
        creneau,
        dateDebut: String(fd.get('dateDebut') || ''),
        dateFin: String(fd.get('dateFin') || '') || String(fd.get('dateDebut') || ''),
        heureDebut: String(fd.get('heureDebut') || '') || null,
        heureFin: String(fd.get('heureFin') || '') || null,
        chantierId: String(fd.get('chantierId') || '') || null,
        titre: String(fd.get('titre') || '') || null,
        client: String(fd.get('client') || '') || null,
        adresse: String(fd.get('adresse') || '') || null,
        typeEventId: typeEventId || null,
        commentaire: String(fd.get('commentaire') || '') || null,
        intervenantIds,
      };

      const res = isEdit
        ? await apiFetch(`/planning/events/${event!.id}`, { method: 'PATCH', body: JSON.stringify(linkedIntervention ? {
          dateDebut: payload.dateDebut, dateFin: payload.dateFin, creneau: payload.creneau,
          heureDebut: payload.heureDebut, heureFin: payload.heureFin, intervenantIds: payload.intervenantIds,
          adresse: payload.adresse, commentaire: payload.commentaire,
        } : payload) })
        : await apiFetch('/planning/events', { method: 'POST', body: JSON.stringify(payload) });
      if (res.ok) {
        onSaved();
      } else {
        const d = await res.json();
        alert(d.error || "Erreur lors de l'enregistrement de l'affectation.");
      }
    } catch {
      alert('Impossible de joindre le serveur.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby={titreId} className="bg-white rounded-xl shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-4">
          <h2 id={titreId} className="text-lg font-bold text-primary-dark m-0">{isEdit ? "Modifier l'affectation" : 'Nouvelle affectation'}</h2>
          <button onClick={onClose} className="p-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors" title="Fermer">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Nature de l'affectation */}
          {!linkedIntervention && <div>
            <label className="form-label">Nature</label>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setCategorie(c.value)}
                  className={`text-sm font-semibold px-3 py-1.5 rounded-lg border transition-colors ${categorie === c.value ? 'bg-primary text-white border-primary' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>}

          {categorie === 'CHANTIER' && (
            <div className="form-group mb-0">
              <label className="form-label">Chantier (en cours)</label>
              <select required name="chantierId" className="form-input" defaultValue={event?.chantierId || ''}>
                <option value="" disabled>Sélectionner un chantier...</option>
                {chantiersEnCours.map((c) => (
                  <option key={c.id} value={c.id}>{c.nom} — {c.client}{c.statut === 'TERMINE' ? ' (Terminé)' : ''}</option>
                ))}
              </select>
            </div>
          )}

          {categorie === 'HORS_CHANTIER' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group mb-0">
                <label className="form-label">Nom du chantier / intervention</label>
                <input required name="titre" readOnly={linkedIntervention} className="form-input" placeholder="Ex: SAV alarme entrepôt" defaultValue={event?.titre || ''} />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Client (optionnel)</label>
                <input name="client" readOnly={linkedIntervention} className="form-input" defaultValue={event?.client || ''} placeholder="Nom du client" />
              </div>
              <div className="form-group mb-0 md:col-span-2">
                <label className="form-label">Adresse du site (optionnel)</label>
                <input name="adresse" className="form-input" defaultValue={event?.adresse || ''} placeholder="Adresse du site" />
              </div>
            </div>
          )}

          {categorie === 'EVENEMENT' && (
            <div className="form-group mb-0">
              <label className="form-label">Type d'événement</label>
              <select required name="typeEventId" className="form-input" value={typeSel} onChange={(e) => setTypeSel(e.target.value)}>
                <option value="" disabled>Sélectionner un type...</option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>{t.nom}</option>
                ))}
                <option value="__new__">+ Créer un nouveau type…</option>
              </select>
              {typeSel === '__new__' && (
                <div className="flex gap-2 mt-2 items-center">
                  <input name="nouveauTypeNom" className="form-input flex-1" placeholder="Libellé (ex: Congés, Formation...)" />
                  <input type="color" name="nouveauTypeCouleur" defaultValue="#f59e0b" className="h-9 w-14 p-0.5 border border-gray-200 rounded cursor-pointer" title="Couleur du type" />
                </div>
              )}
            </div>
          )}

          {/* Techniciens */}
          <div>
            <label className="form-label">Technicien(s)</label>
            <div className="flex flex-wrap gap-2">
              {intervenants.map((i) => (
                <label key={i.id} className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors">
                  <input
                    type="checkbox"
                    name="intervenantIds"
                    value={i.id}
                    className="w-4 h-4"
                    defaultChecked={isEdit ? event!.intervenants.some((x) => x.id === i.id) : modal.intervenantId === i.id}
                  />
                  {i.nom}
                </label>
              ))}
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="form-group mb-0">
              <label className="form-label">Du</label>
              <input required type="text" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" name="dateDebut" className="form-input" defaultValue={defaultDebut} />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">Au (inclus)</label>
              <input type="text" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" name="dateFin" className="form-input" defaultValue={defaultFin} />
            </div>
          </div>

          {/* Créneau */}
          <div>
            <label className="form-label">Créneau</label>
            <div className="flex flex-wrap gap-2">
              {CRENEAUX.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setCreneau(c.value)}
                  className={`text-sm font-semibold px-3 py-1.5 rounded-lg border transition-colors ${creneau === c.value ? 'bg-primary text-white border-primary' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            {creneau === 'HEURES' && (
              <div className="flex gap-4 mt-2">
                <div className="form-group mb-0 flex-1">
                  <label className="form-label">De</label>
                  <input required type="time" name="heureDebut" className="form-input" defaultValue={event?.heureDebut || '08:00'} />
                </div>
                <div className="form-group mb-0 flex-1">
                  <label className="form-label">À</label>
                  <input required type="time" name="heureFin" className="form-input" defaultValue={event?.heureFin || '12:00'} />
                </div>
              </div>
            )}
          </div>

          <div className="form-group mb-0">
            <label className="form-label">Commentaire (optionnel)</label>
            <input name="commentaire" className="form-input" placeholder="Consignes, matériel à prévoir..." defaultValue={event?.commentaire || ''} />
          </div>

          <div className="flex flex-wrap gap-2 mt-2">
            <button disabled={saving} className="btn btn-primary px-8">{saving ? 'Enregistrement…' : isEdit ? 'Enregistrer' : 'Ajouter au planning'}</button>
            <button type="button" onClick={onClose} className="btn bg-white border">Annuler</button>
            {isEdit && !linkedIntervention && (
              <button type="button" onClick={() => onDelete(event!)} className="btn ml-auto flex items-center gap-1.5 bg-red-100 hover:bg-red-200 text-red-700">
                <Trash2 size={15} /> Supprimer
              </button>
            )}
            {remettable && (
              <button type="button" onClick={() => setRemiseOuverte(true)} className="btn ml-auto flex items-center gap-1.5 bg-amber-100 hover:bg-amber-200 text-amber-900">
                <CalendarX2 size={15} /> Remettre à planifier
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
    {remiseOuverte && event?.interventionId && (
      <RemiseAPlanifier interventionId={event.interventionId} reference={event.intervention?.reference || ''} contratMaintenanceId={event.intervention?.contratMaintenanceId} onClose={() => setRemiseOuverte(false)} onRemise={onRemise} />
    )}
    </>
  );
};
