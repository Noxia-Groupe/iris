import { useState } from 'react';
import { apiFetch } from '../api';
import { dureeTempsPasse } from '../lib/tempsPasse';

// Réglages du temps passé (lot « devis au temps passé », décisions de Nelson des 24 et 25-10-2026, puis
// lot « facture au temps passé », décisions de la nuit du 26 au 27-10-2026, points 8 et 9) :
//  - le temps minimum facturé, en minutes, par multiples de 15, de 15 minutes à 8 heures ; une heure à
//    l'installation ; vidé, il revient à une heure ;
//  - le pas, au-delà de ce minimum : 15, 30, 45 ou 60 minutes, toujours arrondi au pas supérieur ; vide au
//    démarrage (« Aucune, à régler ») : un devis au temps passé est refusé tant qu'il n'est pas fixé.
// Le serveur contrôle les deux valeurs ; chaque changement est journalisé. Chaque devis au temps passé garde
// le minimum et le pas en vigueur à sa création.
const PAS_ADMIS = [15, 30, 45, 60];

export type ReglagesTempsPasseSociete = { pasTempsPasseMinutes: number | null; tempsMinimumMinutes: number };

export function ReglageTempsPasse({ pasTempsPasseMinutes, tempsMinimumMinutes, onEnregistre }: ReglagesTempsPasseSociete & {
  onEnregistre: (reglages: ReglagesTempsPasseSociete) => void;
}) {
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');
  const [succes, setSucces] = useState('');
  // Un pas réglé avant le lot, hors de 15, 30, 45 ou 60 minutes, reste affiché tant qu'il n'est pas changé.
  const pasAncien = pasTempsPasseMinutes !== null && !PAS_ADMIS.includes(pasTempsPasseMinutes);

  const enregistrer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formulaire = new FormData(event.currentTarget);
    const pas = String(formulaire.get('pasTempsPasseMinutes') ?? '').trim();
    const minimum = String(formulaire.get('tempsMinimumMinutes') ?? '').trim();
    setEnCours(true); setErreur(''); setSucces('');
    try {
      const res = await apiFetch('/parametres', { method: 'PUT', body: JSON.stringify({ pasTempsPasseMinutes: pas, tempsMinimumMinutes: minimum }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setErreur(data.error || 'Enregistrement des réglages du temps passé impossible.');
      const reglages = { pasTempsPasseMinutes: data.pasTempsPasseMinutes ?? null, tempsMinimumMinutes: data.tempsMinimumMinutes };
      onEnregistre(reglages);
      setSucces(reglages.pasTempsPasseMinutes === null
        ? `Temps minimum facturé : ${dureeTempsPasse(reglages.tempsMinimumMinutes)}. Pas du temps passé retiré : les devis au temps passé sont refusés jusqu’à son réglage.`
        : `Réglages du temps passé enregistrés : minimum de ${dureeTempsPasse(reglages.tempsMinimumMinutes)}, puis tranches de ${reglages.pasTempsPasseMinutes} minutes.`);
    } catch {
      setErreur('Impossible de joindre le serveur.');
    } finally {
      setEnCours(false);
    }
  };

  return <section aria-labelledby="titre-temps-passe" className="card mb-4">
    <h2 id="titre-temps-passe" className="mb-2 text-primary-dark">Devis au temps passé</h2>
    <p className="text-sm text-muted mb-4">
      Le temps passé se facture avec un minimum, puis par le pas au-delà, toujours arrondi au pas supérieur. Tant que le
      pas est vide, un devis au temps passé est refusé. Chaque devis au temps passé garde le minimum et le pas en vigueur à
      sa création.
    </p>
    {erreur && <p role="alert" className="text-red-600 mb-2">{erreur}</p>}
    {succes && <p role="status" className="text-emerald-700 mb-2">{succes}</p>}
    {/* Le minimum n'est pas borné côté navigateur : le serveur refuse hors des multiples de 15 minutes de 15 minutes à 8 heures, avec un message clair. */}
    <form key={`${pasTempsPasseMinutes}-${tempsMinimumMinutes}`} onSubmit={enregistrer} className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <label className="text-sm font-semibold text-gray-700">Temps minimum facturé (minutes)
        <input name="tempsMinimumMinutes" type="number" inputMode="numeric" defaultValue={tempsMinimumMinutes} className="form-input mt-1 w-40" placeholder="Vide : 60" />
      </label>
      <label className="text-sm font-semibold text-gray-700">Pas du temps passé (minutes)
        <select name="pasTempsPasseMinutes" defaultValue={pasTempsPasseMinutes ?? ''} className="form-input mt-1 w-48">
          <option value="">Vide : à régler</option>
          {pasAncien && <option value={pasTempsPasseMinutes!}>{pasTempsPasseMinutes} (n’est plus admis)</option>}
          {PAS_ADMIS.map((pas) => <option key={pas} value={pas}>{pas}</option>)}
        </select>
      </label>
      <button type="submit" className="btn btn-primary" disabled={enCours}>{enCours ? 'Enregistrement…' : 'Enregistrer les réglages'}</button>
    </form>
    {pasTempsPasseMinutes === null && <p className="text-sm text-amber-700 mt-2">Pas non réglé : les devis au temps passé sont refusés.</p>}
    {pasAncien && <p className="text-sm text-amber-700 mt-2">Le pas réglé ({pasTempsPasseMinutes} minutes) n’est plus admis : les nouveaux devis au temps passé sont refusés tant qu’il n’est pas réglé à 15, 30, 45 ou 60 minutes.</p>}
  </section>;
}
