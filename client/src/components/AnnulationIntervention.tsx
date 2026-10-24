import { apiFetch } from '../api';
import { designationIntervention } from '../lib/motifIntervention';
import { DialogueMotif } from './DialogueMotif';

// ---------------------------------------------------------------------------
// Dialogue de l'annulation d'une intervention depuis sa fiche ou la liste (décisions de Nelson du
// 24-10-2026 : « Oui un motif pour une annulation depuis sa fiche », « Retirer du planning ») : un motif
// obligatoire, écrit au journal SAV, puis le passage à « annulée », qui retire aussi son créneau du
// planning et ses techniciens.
// ---------------------------------------------------------------------------
export const AnnulationIntervention = ({ interventionId, reference, contratMaintenanceId, onClose, onAnnulee }: {
  interventionId: string; reference: string; contratMaintenanceId?: string | null; onClose: () => void; onAnnulee: () => void;
}) => {
  const designation = designationIntervention({ contratMaintenanceId });
  return (
    <DialogueMotif
      titre={`Annuler ${designation} ${reference}`}
      aide={`L’annulation est définitive : le créneau est retiré du planning et les techniciens sont retirés de ${designation}.`}
      libelleConfirmer="Confirmer l’annulation" libelleEnvoi="Annulation en cours…" libelleFermer="Fermer" echecParDefaut="Annulation impossible."
      envoyer={(motif) => apiFetch(`/interventions/${interventionId}/statut`, { method: 'PATCH', body: JSON.stringify({ statut: 'ANNULEE', motif }) })}
      onClose={onClose} onFait={onAnnulee}
    />
  );
};
