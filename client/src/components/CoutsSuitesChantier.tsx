import type { CoutsSuites } from '../lib/suiviChantiers';
import { arrondiCentime } from '../lib/montants';

const euros = (montant: number) => arrondiCentime(montant).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const heures = (nombre: number) => nombre.toLocaleString('fr-FR', { maximumFractionDigits: 2 });

// Coûts des suites SAV comptés dans le réel d'un chantier (décision de Nelson de la nuit du 26 au
// 27-10-2026, « Les suites seulement ») : l'écran dit d'où vient l'écart avec les journaux du
// chantier. Leurs heures restent hors des heures réalisées (décision du 27-10-2026 à 21:41 UTC,
// « Oui il faut sortir les heures ») : l'écran le dit aussi. L'intervention issue du devis qui a ouvert
// le chantier lui est rattachée (même décision, « Elle vont au chantier… ») et compte comme son travail
// (choix par défaut, à confirmer) : l'écran dit ce qu'elle apporte au réel et aux heures réalisées. Les
// montants arrivent nuls pour qui ne les voit pas, comme le reste du réel.
export const CoutsSuitesChantier = ({ couts, interventionDevis }: { couts?: CoutsSuites | null; interventionDevis?: CoutsSuites | null }) => {
  const devis: string[] = [];
  if (interventionDevis?.heures) devis.push(`${heures(interventionDevis.heures)} h dans les heures réalisées`);
  if (interventionDevis?.coutMainOeuvre) devis.push(`main-d’œuvre ${euros(interventionDevis.coutMainOeuvre)}`);
  if (interventionDevis?.materiel) devis.push(`matériel ${euros(interventionDevis.materiel)}`);
  const suites: string[] = [];
  if (couts && (couts.heures || couts.materiel || couts.coutMainOeuvre)) {
    const montants: string[] = [];
    if (couts.materiel != null) montants.push(`matériel ${euros(couts.materiel)}`);
    if (couts.coutMainOeuvre != null) montants.push(`main-d’œuvre ${euros(couts.coutMainOeuvre)}`);
    if (montants.length) suites.push(`Dont suites SAV de l’affaire, comptées dans le réel : ${montants.join(' · ')}.`);
    if (couts.heures) suites.push(`Heures des suites SAV de l’affaire, hors des heures réalisées : ${heures(couts.heures)} h.`);
  }
  if (!devis.length && !suites.length) return null;
  return (
    <div className="mb-8 -mt-4 space-y-1 text-sm text-gray-600">
      {devis.length > 0 && <p data-couts-intervention-devis>Dont l’intervention issue du devis du chantier, comptée comme son travail : {devis.join(' · ')}.</p>}
      {suites.length > 0 && <p data-couts-suites>{suites.join(' ')}</p>}
    </div>
  );
};
