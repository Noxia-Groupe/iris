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
