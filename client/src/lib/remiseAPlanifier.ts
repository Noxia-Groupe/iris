// Remise « à planifier » d'une intervention planifiée, visite de contrat ou curative, son créneau libéré
// (décisions de Nelson du 23-10-2026, nuit, réponse 2, et du 24-10-2026). Le serveur décide (statut,
// saisies, droits) ; cette règle ne sert qu'à proposer l'action. Le motif suit lib/motifIntervention.ts.

// Toute intervention « planifiée », visite de contrat ou curative (décision de Nelson du 24-10-2026,
// point 1), se remet « à planifier ». Une intervention qui porte des heures ou du matériel est refusée
// par le serveur, qui le dit.
export function interventionRemettable(intervention: { statut: string } | null | undefined): boolean {
  return intervention?.statut === 'PLANIFIEE';
}
