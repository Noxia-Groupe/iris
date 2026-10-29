/** Totaux des coûts d'une intervention SAV, tels que GET /api/interventions/:id/couts les envoie. */
export type TotauxCoutsIntervention = { totalCoutsHT?: number | null; totalMaterielHT?: number | null };

/**
 * Total affiché à l'encadrement sur une intervention SAV. L'administration reçoit le coût réel,
 * main-d'œuvre comprise ; un conducteur ne reçoit ni le coût de main-d'œuvre ni ce total
 * (lot (d)), et garde le matériel. Rien n'est affiché sans total transmis.
 * Hors contrat, aucun matériel ne se saisit (total matériel null) : le total ne contient que la
 * main-d'œuvre et porte ce nom (décision de Nelson du 20-10-2026, #257).
 */
export function resumeCoutsIntervention(couts: TotauxCoutsIntervention): { libelle: string; montant: number } | null {
  if (couts.totalCoutsHT != null) return { libelle: couts.totalMaterielHT == null ? 'Main-d’œuvre cumulée' : 'Coût réel cumulé', montant: couts.totalCoutsHT };
  if (couts.totalMaterielHT != null) return { libelle: 'Matériel cumulé', montant: couts.totalMaterielHT };
  return null;
}

/**
 * Marge d'une intervention issue d'un devis converti en intervention, sans chantier : total HT du devis
 * moins les coûts de l'intervention et de ses suites (décision de Nelson de la nuit du 26 au 27-10-2026,
 * point 2). Le serveur ne l'envoie qu'à l'administration.
 */
export type MargeDevisIntervention = {
  devis: { id: string; numero: string; version: number };
  totalDevisHT: number; coutsInterventionHT: number; coutsSuitesHT: number; nombreSuites: number; margeHT: number;
};

export const libelleDevisMarge = (marge: MargeDevisIntervention) => marge.devis.version > 1 ? `${marge.devis.numero} (version ${marge.devis.version})` : marge.devis.numero;

/**
 * Marge d'une intervention SAV hors contrat, sans devis ni chantier (lot « marge d'un SAV hors contrat »,
 * décisions de Nelson de la nuit du 26 au 27-10-2026, points 4 à 7, et du 27-10-2026) : les heures de
 * l'intervention et de ses suites, vendues au prix de vente à l'heure de la main d'œuvre de chaque
 * intervenant figé à la saisie, moins leur coût. Le serveur ne l'envoie qu'à l'administration.
 */
export type MargeSavHorsContrat = {
  ventesHT: number; coutsHT: number; margeHT: number; nombreSuites: number;
  heuresNonValorisees: number; intervenantsNonValorises: string[]; heuresSuitesAnnulees: number;
};

const heuresFr = (heures: number) => `${heures.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} h`;

/** Détail de la marge à l'heure, en une phrase ; les montants passent par le format de l'écran. */
export function detailMargeSav(marge: MargeSavHorsContrat, montant: (valeur: number) => string): string {
  const portee = marge.nombreSuites === 0 ? 'de l’intervention' : `de l’intervention et de ${marge.nombreSuites > 1 ? `ses ${marge.nombreSuites} suites` : 'sa suite'}`;
  const annulees = marge.heuresSuitesAnnulees > 0 ? ` Les heures des suites annulées (${heuresFr(marge.heuresSuitesAnnulees)}) comptent dans le coût, sans être vendues.` : '';
  return `Heures ${portee} vendues ${montant(marge.ventesHT)} HT au prix des mains d’œuvre, moins leur coût de ${montant(marge.coutsHT)} HT.${annulees}`;
}

/** Signalement d'une marge incomplète : des heures sans prix de vente figé, dont le coût reste compté. */
export function alerteMargeSav(marge: MargeSavHorsContrat): string | null {
  if (marge.intervenantsNonValorises.length === 0) return null;
  return `Marge incomplète : ${heuresFr(marge.heuresNonValorisees)} sans prix de vente (${marge.intervenantsNonValorises.join(', ')}). Un intervenant sans main d’œuvre le jour de la saisie ne valorise pas ses heures ; leur coût reste compté.`;
}
