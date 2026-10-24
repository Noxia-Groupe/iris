import { useId, useState } from 'react';
import { MOTIF_INTERVENTION_MAX, MOTIF_INTERVENTION_MIN, motifInterventionValide } from '../lib/motifIntervention';

// ---------------------------------------------------------------------------
// Dialogue titré qui demande le motif obligatoire d'une action sur une intervention, puis l'envoie :
// remise « à planifier » et annulation depuis la fiche (décisions de Nelson du 24-10-2026). Un motif
// invalide est signalé sans requête ; un refus du serveur s'affiche dans le dialogue, qui reste ouvert
// avec la saisie.
// ---------------------------------------------------------------------------
export const DialogueMotif = ({ titre, aide, libelleConfirmer, libelleEnvoi, libelleFermer = 'Annuler', echecParDefaut, envoyer, onClose, onFait }: {
  titre: string; aide: string; libelleConfirmer: string; libelleEnvoi: string; libelleFermer?: string; echecParDefaut: string;
  envoyer: (motif: string) => Promise<Response>; onClose: () => void; onFait: () => void;
}) => {
  const titreId = useId();
  const motifId = useId();
  const aideId = useId();
  const [motif, setMotif] = useState('');
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);

  const confirmer = async (e: React.FormEvent) => {
    e.preventDefault();
    const valide = motifInterventionValide(motif);
    if (!valide) {
      setErreur(`Le motif doit compter de ${MOTIF_INTERVENTION_MIN} à ${MOTIF_INTERVENTION_MAX} caractères, sans retour à la ligne ni caractère de contrôle.`);
      return;
    }
    setEnvoi(true);
    setErreur('');
    try {
      const res = await envoyer(valide);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErreur(data.error || echecParDefaut);
        return;
      }
      onFait();
    } catch {
      setErreur('Impossible de joindre le serveur.');
    } finally {
      setEnvoi(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={envoi ? undefined : onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby={titreId} className="bg-white rounded-xl shadow-lg w-full max-w-md max-h-[90vh] overflow-y-auto p-6 break-words" onClick={(e) => e.stopPropagation()}>
        <h2 id={titreId} className="text-lg font-bold text-primary-dark m-0 mb-2">{titre}</h2>
        <p id={aideId} className="text-sm text-muted mb-4">{aide}</p>
        <form onSubmit={confirmer} noValidate className="flex flex-col gap-3">
          <div className="form-group mb-0">
            <label htmlFor={motifId} className="form-label">Motif (obligatoire)</label>
            <input id={motifId} autoFocus aria-required="true" aria-describedby={aideId} className="form-input" value={motif} onChange={(e) => setMotif(e.target.value)} placeholder={`De ${MOTIF_INTERVENTION_MIN} à ${MOTIF_INTERVENTION_MAX} caractères`} />
          </div>
          {erreur && <p role="alert" className="text-sm text-red-700 m-0">{erreur}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={envoi} className="btn btn-primary">{envoi ? libelleEnvoi : libelleConfirmer}</button>
            <button type="button" disabled={envoi} onClick={onClose} className="btn bg-white border">{libelleFermer}</button>
          </div>
        </form>
      </div>
    </div>
  );
};
