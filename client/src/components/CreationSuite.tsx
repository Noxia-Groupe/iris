import { useId, useState } from 'react';
import { apiFetch } from '../api';
import { INFORMATION_SUITE_HORS_CONTRAT } from '../lib/suiteIntervention';

const PRIORITES: Record<string, string> = { BASSE: 'Basse', NORMALE: 'Normale', HAUTE: 'Haute', URGENTE: 'Urgente' };

// Titre proposé, comme le serveur : celui de l'intervention initiale, précédé de « Suite — », 200
// caractères au plus.
const titreSuite = (titreInitial: string) => `Suite — ${titreInitial}`.slice(0, 200).trim();

// ---------------------------------------------------------------------------
// Dialogue de création d'une suite (intervention de suivi liée, décisions de Nelson des 24 et 26-10-2026) :
// une nouvelle intervention liée à l'intervention initiale, dont elle reprend le client, le site, le
// contact, l'affaire et, pour une visite, le contrat. Le titre, la date souhaitée, la priorité et la
// description se choisissent ; la suite entre dans la file des interventions à planifier, et la marque
// « à suivre » de l'intervention initiale disparaît. Ouvert depuis la fiche, la liste et la file du
// planning, par l'encadrement du SAV. Un refus du serveur s'affiche dans le dialogue, qui reste ouvert.
// Pour une intervention hors contrat, le dialogue rappelle d'informer le client (points 13 et 23).
// ---------------------------------------------------------------------------
export const CreationSuite = ({ intervention, onClose, onCreee }: {
  intervention: { id: string; reference: string; titre: string; priorite?: string | null; horsContrat?: boolean };
  onClose: () => void; onCreee: (suite: { id: string; reference: string }) => void;
}) => {
  const titreId = useId();
  const aideId = useId();
  const rappelId = useId();
  const [titre, setTitre] = useState(() => titreSuite(intervention.titre));
  const [dateSouhaitee, setDateSouhaitee] = useState('');
  const [priorite, setPriorite] = useState(intervention.priorite && PRIORITES[intervention.priorite] ? intervention.priorite : 'NORMALE');
  const [description, setDescription] = useState('');
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);

  const fermer = () => { if (!envoi) onClose(); };

  const confirmer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!titre.trim()) return setErreur('Le titre de la suite est obligatoire.');
    if (dateSouhaitee && !/^\d{2}-\d{2}-\d{4}$/.test(dateSouhaitee.trim())) return setErreur('La date souhaitée s’écrit au format JJ-MM-AAAA.');
    setEnvoi(true);
    setErreur('');
    try {
      const res = await apiFetch(`/interventions/${intervention.id}/suites`, { method: 'POST', body: JSON.stringify({
        titre: titre.trim(), priorite, ...(dateSouhaitee.trim() ? { dateSouhaitee: dateSouhaitee.trim() } : {}), ...(description.trim() ? { description: description.trim() } : {}),
      }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErreur(data.error || 'Création de la suite impossible.');
        return;
      }
      onCreee({ id: data.id, reference: data.reference });
    } catch {
      setErreur('Impossible de joindre le serveur.');
    } finally {
      setEnvoi(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={fermer} onKeyDown={(e) => { if (e.key === 'Escape') fermer(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby={titreId} aria-describedby={intervention.horsContrat ? `${aideId} ${rappelId}` : aideId} className="bg-white rounded-xl shadow-lg w-full max-w-md max-h-[90vh] overflow-y-auto p-6 break-words" onClick={(e) => e.stopPropagation()}>
        <h2 id={titreId} className="text-lg font-bold text-primary-dark m-0 mb-2">Créer la suite de {intervention.reference}</h2>
        <p id={aideId} className="text-sm text-muted mb-4">La suite reprend le client, le site, le contact, l’affaire et, pour une visite, le contrat de {intervention.reference}. Elle entre dans la file des interventions à planifier.</p>
        {intervention.horsContrat && <p id={rappelId} role="note" className="text-sm rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 mb-4">{INFORMATION_SUITE_HORS_CONTRAT}</p>}
        <form onSubmit={confirmer} noValidate className="flex flex-col gap-3">
          <label className="form-label mb-0">Titre de la suite
            <input autoFocus required maxLength={200} className="form-input mt-1" value={titre} onChange={(e) => setTitre(e.target.value)} />
          </label>
          <label className="form-label mb-0">Date souhaitée (JJ-MM-AAAA, facultative)
            <input inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" className="form-input mt-1" value={dateSouhaitee} onChange={(e) => setDateSouhaitee(e.target.value)} />
          </label>
          <label className="form-label mb-0">Priorité
            <select className="form-input mt-1" value={priorite} onChange={(e) => setPriorite(e.target.value)}>{Object.entries(PRIORITES).map(([valeur, libelle]) => <option key={valeur} value={valeur}>{libelle}</option>)}</select>
          </label>
          <label className="form-label mb-0">Description (facultative)
            <textarea className="form-input mt-1" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          {erreur && <p role="alert" className="text-sm text-red-700 m-0">{erreur}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={envoi} className="btn btn-primary">{envoi ? 'Création en cours…' : 'Créer la suite'}</button>
            <button type="button" disabled={envoi} onClick={onClose} className="btn bg-white border">Annuler</button>
          </div>
        </form>
      </div>
    </div>
  );
};
