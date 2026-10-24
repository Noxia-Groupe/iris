import { apiFetch } from '../api';
import { designationIntervention } from '../lib/motifIntervention';
import { DialogueMotif } from './DialogueMotif';

// ---------------------------------------------------------------------------
// Dialogue de la remise « à planifier » d'une intervention planifiée, visite de contrat ou curative
// (décisions de Nelson du 23-10-2026, nuit, réponse 2, et du 24-10-2026) : un motif obligatoire, puis
// l'appel de l'API. Le créneau est libéré, les techniciens sont retirés de l'intervention et elle revient
// dans la file des interventions à planifier. Ouvert depuis son affectation au planning et depuis la
// fiche de l'intervention.
// ---------------------------------------------------------------------------
export const RemiseAPlanifier = ({ interventionId, reference, contratMaintenanceId, onClose, onRemise }: {
  interventionId: string; reference: string; contratMaintenanceId?: string | null; onClose: () => void; onRemise: () => void;
}) => {
  const designation = designationIntervention({ contratMaintenanceId });
  return (
    <DialogueMotif
      titre={`Remettre à planifier ${designation} ${reference}`}
      aide={`Le créneau est libéré et les techniciens sont retirés de ${designation}, qui revient dans la file des interventions à planifier.`}
      libelleConfirmer="Confirmer la remise" libelleEnvoi="Remise en cours…" echecParDefaut="Remise à planifier impossible."
      envoyer={(motif) => apiFetch(`/interventions/${interventionId}/remise-a-planifier`, { method: 'POST', body: JSON.stringify({ motif }) })}
      onClose={onClose} onFait={onRemise}
    />
  );
};
