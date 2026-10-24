// Motif obligatoire d'une action sur une intervention : remise « à planifier » et annulation depuis sa
// fiche (décisions de Nelson du 24-10-2026 : « on doit garder une tracabilité », « Oui un motif pour une
// annulation depuis sa fiche »). Le serveur décide ; ces règles ne servent qu'à signaler un motif invalide
// avant l'envoi et à nommer l'intervention.

// De 3 à 500 caractères, sans caractère de contrôle, comme le statut d'un contrat. Un emoji compte pour
// un caractère, comme pour PostgreSQL.
export const MOTIF_INTERVENTION_MIN = 3;
export const MOTIF_INTERVENTION_MAX = 500;

export function motifInterventionValide(saisie: string): string | null {
  const motif = saisie.trim();
  const longueur = [...motif].length;
  if (longueur < MOTIF_INTERVENTION_MIN || longueur > MOTIF_INTERVENTION_MAX) return null;
  return /[\p{Cc}\p{Cf}\p{Cs}]/u.test(motif) ? null : motif;
}

// Ce que l'écran nomme : « la visite » d'un contrat, « l’intervention » curative.
export function designationIntervention(intervention: { contratMaintenanceId?: string | null }): string {
  return intervention.contratMaintenanceId ? 'la visite' : 'l’intervention';
}
