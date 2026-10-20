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
