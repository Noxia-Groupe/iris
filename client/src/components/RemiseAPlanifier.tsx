import { useId, useState } from 'react';
import { apiFetch } from '../api';
import { MOTIF_REMISE_MAX, MOTIF_REMISE_MIN, motifRemiseValide } from '../lib/remiseAPlanifier';

// ---------------------------------------------------------------------------
// Dialogue de la remise « à planifier » d'une visite de contrat planifiée (décision de Nelson du
// 23-10-2026, nuit, réponse 2) : un motif obligatoire, puis l'appel de l'API. Le créneau est libéré,
// les techniciens sont retirés de la visite et elle revient dans la file des visites à planifier.
// Ouvert depuis l'affectation d'une visite au planning et depuis la fiche de l'intervention.
// ---------------------------------------------------------------------------
export const RemiseAPlanifier = ({ interventionId, reference, onClose, onRemise }: {
  interventionId: string; reference: string; onClose: () => void; onRemise: () => void;
}) => {
  const titreId = useId();
  const motifId = useId();
  const aideId = useId();
  const [motif, setMotif] = useState('');
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);

  const confirmer = async (e: React.FormEvent) => {
    e.preventDefault();
    const valide = motifRemiseValide(motif);
    if (!valide) {
      setErreur(`Le motif doit compter de ${MOTIF_REMISE_MIN} à ${MOTIF_REMISE_MAX} caractères, sans retour à la ligne ni caractère de contrôle.`);
      return;
    }
    setEnvoi(true);
    setErreur('');
    try {
      const res = await apiFetch(`/interventions/${interventionId}/remise-a-planifier`, { method: 'POST', body: JSON.stringify({ motif: valide }) });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErreur(data.error || 'Remise à planifier impossible.');
        return;
      }
      onRemise();
    } catch {
      setErreur('Impossible de joindre le serveur.');
    } finally {
      setEnvoi(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={envoi ? undefined : onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby={titreId} className="bg-white rounded-xl shadow-lg w-full max-w-md max-h-[90vh] overflow-y-auto p-6 break-words" onClick={(e) => e.stopPropagation()}>
        <h2 id={titreId} className="text-lg font-bold text-primary-dark m-0 mb-2">Remettre à planifier la visite {reference}</h2>
        <p id={aideId} className="text-sm text-muted mb-4">Le créneau est libéré et les techniciens sont retirés de la visite, qui revient dans la file des visites à planifier.</p>
        <form onSubmit={confirmer} noValidate className="flex flex-col gap-3">
          <div className="form-group mb-0">
            <label htmlFor={motifId} className="form-label">Motif (obligatoire)</label>
            <input id={motifId} autoFocus aria-required="true" aria-describedby={aideId} className="form-input" value={motif} onChange={(e) => setMotif(e.target.value)} placeholder={`De ${MOTIF_REMISE_MIN} à ${MOTIF_REMISE_MAX} caractères`} />
          </div>
          {erreur && <p role="alert" className="text-sm text-red-700 m-0">{erreur}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={envoi} className="btn btn-primary">{envoi ? 'Remise en cours…' : 'Confirmer la remise'}</button>
            <button type="button" disabled={envoi} onClick={onClose} className="btn bg-white border">Annuler</button>
          </div>
        </form>
      </div>
    </div>
  );
};
