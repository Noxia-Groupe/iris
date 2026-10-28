import type { CoutsSuites } from '../lib/suiviChantiers';
import { arrondiCentime } from '../lib/montants';

const euros = (montant: number) => arrondiCentime(montant).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

// Coûts des suites SAV comptés dans le réel d'un chantier (décision de Nelson de la nuit du 26 au
// 27-10-2026, « Les suites seulement ») : l'écran dit d'où vient l'écart avec les journaux du
// chantier. Leurs heures restent hors des heures réalisées (décision du 27-10-2026 à 21:41 UTC,
// « Oui il faut sortir les heures ») : l'écran le dit aussi. Les montants arrivent nuls pour qui ne
// les voit pas, comme le reste du réel.
export const CoutsSuitesChantier = ({ couts }: { couts?: CoutsSuites | null }) => {
  if (!couts || (!couts.heures && !couts.materiel && !couts.coutMainOeuvre)) return null;
  const montants: string[] = [];
  if (couts.materiel != null) montants.push(`matériel ${euros(couts.materiel)}`);
  if (couts.coutMainOeuvre != null) montants.push(`main-d’œuvre ${euros(couts.coutMainOeuvre)}`);
  const phrases: string[] = [];
  if (montants.length) phrases.push(`Dont suites SAV de l’affaire, comptées dans le réel : ${montants.join(' · ')}.`);
  if (couts.heures) phrases.push(`Heures des suites SAV de l’affaire, hors des heures réalisées : ${couts.heures.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} h.`);
  return <p data-couts-suites className="mb-8 -mt-4 text-sm text-gray-600">{phrases.join(' ')}</p>;
};
