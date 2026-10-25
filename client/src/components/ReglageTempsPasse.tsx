import { useState } from 'react';
import { apiFetch } from '../api';

// Pas du temps passé (lot « devis au temps passé », décisions de Nelson des 24 et 25-10-2026) : au-delà de
// la première heure, le temps passé se facture par ce pas, toujours arrondi au pas supérieur. Vide au
// démarrage (« Aucune, à régler ») : un devis au temps passé est refusé tant que l'administration ne l'a
// pas fixé. De 1 à 60 minutes (choix par défaut, à confirmer), contrôlé par le serveur ; chaque
// changement est journalisé. Les devis déjà au temps passé gardent leur pas figé.
export function ReglageTempsPasse({ pasTempsPasseMinutes, onEnregistre }: {
  pasTempsPasseMinutes: number | null;
  onEnregistre: (pas: number | null) => void;
}) {
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');
  const [succes, setSucces] = useState('');

  const enregistrer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const valeur = String(new FormData(event.currentTarget).get('pasTempsPasseMinutes') ?? '').trim();
    setEnCours(true); setErreur(''); setSucces('');
    try {
      const res = await apiFetch('/parametres', { method: 'PUT', body: JSON.stringify({ pasTempsPasseMinutes: valeur }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setErreur(data.error || 'Enregistrement du pas du temps passé impossible.');
      const pas = data.pasTempsPasseMinutes ?? null;
      onEnregistre(pas);
      setSucces(pas === null ? 'Pas du temps passé retiré : les devis au temps passé sont refusés jusqu’à son réglage.' : `Pas du temps passé enregistré : ${pas} minute${pas > 1 ? 's' : ''}.`);
    } catch {
      setErreur('Impossible de joindre le serveur.');
    } finally {
      setEnCours(false);
    }
  };

  return <section aria-labelledby="titre-temps-passe" className="card mb-4">
    <h2 id="titre-temps-passe" className="mb-2 text-primary-dark">Devis au temps passé</h2>
    <p className="text-sm text-muted mb-4">
      Au-delà de la première heure, le temps passé se facture par ce pas, toujours arrondi au pas supérieur. Tant qu’il
      est vide, un devis au temps passé est refusé. Chaque devis au temps passé garde le pas en vigueur à sa création.
    </p>
    {erreur && <p role="alert" className="text-red-600 mb-2">{erreur}</p>}
    {succes && <p role="status" className="text-emerald-700 mb-2">{succes}</p>}
    {/* Sans bornes côté navigateur : le serveur refuse hors de 1 à 60 minutes, avec un message clair. */}
    <form key={String(pasTempsPasseMinutes)} onSubmit={enregistrer} className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <label className="text-sm font-semibold text-gray-700">Pas du temps passé (minutes)
        <input name="pasTempsPasseMinutes" type="number" inputMode="numeric" defaultValue={pasTempsPasseMinutes ?? ''} className="form-input mt-1 w-40" placeholder="Vide : à régler" />
      </label>
      <button type="submit" className="btn btn-primary" disabled={enCours}>{enCours ? 'Enregistrement…' : 'Enregistrer le pas'}</button>
    </form>
    {pasTempsPasseMinutes === null && <p className="text-sm text-amber-700 mt-2">Pas non réglé : les devis au temps passé sont refusés.</p>}
  </section>;
}
