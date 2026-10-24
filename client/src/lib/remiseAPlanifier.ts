// Remise « à planifier » d'une visite de contrat planifiée, son créneau libéré (décision de Nelson du
// 23-10-2026, nuit, réponse 2). Le serveur décide (statut, contrat, saisies, droits) ; ces règles ne
// servent qu'à proposer l'action et à signaler un motif invalide avant l'envoi.

// Motif obligatoire : de 3 à 500 caractères, sans caractère de contrôle, comme le statut d'un contrat
// (choix par défaut, à confirmer). Un emoji compte pour un caractère, comme pour PostgreSQL.
export const MOTIF_REMISE_MIN = 3;
export const MOTIF_REMISE_MAX = 500;

export function motifRemiseValide(saisie: string): string | null {
  const motif = saisie.trim();
  const longueur = [...motif].length;
  if (longueur < MOTIF_REMISE_MIN || longueur > MOTIF_REMISE_MAX) return null;
  return /[\p{Cc}\p{Cf}\p{Cs}]/u.test(motif) ? null : motif;
}

// Seule une visite de contrat (contratMaintenanceId) au statut « planifiée » se remet « à planifier ».
export function visiteRemettable(intervention: { statut: string; contratMaintenanceId?: string | null } | null | undefined): boolean {
  return !!intervention?.contratMaintenanceId && intervention.statut === 'PLANIFIEE';
}
