// Taux de TVA acceptés à la saisie : les taux français décidés par Nelson (nuit du 26 au 27-10-2026,
// point 13 : « Il faut les tva francaise que ce soit l’autoliquidation a 0%, 5,5%, ou 10% ou 20% » ;
// « Catalogue, devis, factures »). Règle légale : elle reste dans le code, sans paramètre (règle
// permanente 1). Réponses de Nelson du 29-10-2026 : la liste vaut pour toute saisie nouvelle ou
// modifiée (fiches du catalogue, lignes de devis, factures, facture au temps passé) ; les pièces déjà
// saisies gardent leur taux ; un avoir suit les taux de la facture qu'il corrige ; le 0 % ne porte
// aucune mention tant que le cabinet ne l'a pas fixée.
export const TAUX_TVA_FRANCAIS: readonly number[] = [0, 5.5, 10, 20];
export const REFUS_TAUX_TVA = 'Taux de TVA non accepté : 0 %, 5,5 %, 10 % ou 20 %.';

// Un nombre, une chaîne ou un Decimal de Prisma : comparé à sa valeur numérique.
export function estTauxTvaFrancais(taux: unknown): boolean {
  if (taux === null || taux === undefined || (typeof taux === 'string' && taux.trim() === '')) return false;
  return TAUX_TVA_FRANCAIS.includes(Number(taux));
}
