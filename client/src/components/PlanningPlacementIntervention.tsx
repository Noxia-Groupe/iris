import { useState } from 'react';
import { apiFetch } from '../api';
import type { Intervenant } from '../planningUtils';
import { planningDayToIso } from '../lib/contractPlanningDate';
import { type ContractQueueItem, dateDue } from '../lib/fileAPlanifier';

// Durée proposée pour placer une curative, modifiable avant de confirmer (choix par défaut).
const DUREE_CURATIVE_MINUTES = 60;

export const ContractPlacement = ({ item, intervenants, onClose, onSaved }: {
  item: ContractQueueItem; intervenants: Intervenant[]; onClose: () => void; onSaved: () => void;
}) => {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const dateDebut = planningDayToIso(String(fd.get('jour')));
    if (!dateDebut) {
      setError('Date invalide : saisissez un jour réel au format JJ-MM-AAAA.');
      return;
    }
    const heureDebut = String(fd.get('heureDebut'));
    const duree = Number(fd.get('duree'));
    const depart = Number(heureDebut.slice(0, 2)) * 60 + Number(heureDebut.slice(3));
    if (!Number.isInteger(duree) || duree < 1 || depart + duree >= 1440) {
      setError('La durée doit être positive et se terminer le même jour.');
      return;
    }
    const fin = depart + duree;
    const heureFin = `${String(Math.floor(fin / 60)).padStart(2, '0')}:${String(fin % 60).padStart(2, '0')}`;
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch(`/interventions/${item.id}/planning`, { method: 'PUT', body: JSON.stringify({
        dateDebut, creneau: 'HEURES', heureDebut, heureFin,
        intervenantIds: [String(fd.get('technicienId'))],
      }) });
      if (!res.ok) { const data = await res.json(); setError(data.error || 'Placement impossible.'); return; }
      onSaved();
    } catch { setError('Impossible de joindre le serveur.'); }
    finally { setSaving(false); }
  };
  return <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
    <div role="dialog" aria-label={`Planifier ${item.reference}`} className="bg-white rounded-xl p-6 w-full max-w-md">
      <h2 className="font-bold mb-2">Planifier {item.reference}</h2>
      <p className="text-sm mb-4">{item.titre} — {item.client.raisonSociale}</p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label>Technicien<select required name="technicienId" className="form-input" defaultValue=""><option value="" disabled>Choisir</option>{intervenants.map(i => <option key={i.id} value={i.id}>{i.nom}</option>)}</select></label>
        <label>Jour<input required type="text" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" name="jour" className="form-input" defaultValue={dateDue(item)} /></label>
        <label>Heure de début<input required type="time" name="heureDebut" className="form-input" defaultValue="09:00" /></label>
        <label>Durée (minutes)<input required type="number" name="duree" min="1" max="1439" className="form-input" defaultValue={item.dureePrevisionnelleMinutes ?? DUREE_CURATIVE_MINUTES} /></label>
        {error && <p role="alert" className="text-red-700">{error}</p>}
        <div className="flex gap-2"><button disabled={saving} className="btn btn-primary">Confirmer le placement</button><button type="button" className="btn" onClick={onClose}>Annuler</button></div>
      </form>
    </div>
  </div>;
};
