// Règlements clients (décision A3 du 16-10-2026) : calculs d'affichage et de saisie. Le serveur
// reste seul juge du reste dû : il refuse toute part qui le dépasse et tout total incomplet.

export const MOYENS_REGLEMENT = [
  { valeur: 'VIREMENT', libelle: 'Virement' },
  { valeur: 'CHEQUE', libelle: 'Chèque' },
  { valeur: 'CARTE', libelle: 'Carte' },
  { valeur: 'PRELEVEMENT', libelle: 'Prélèvement' },
  { valeur: 'ESPECES', libelle: 'Espèces' },
] as const;

export function libelleMoyen(moyen: string): string {
  return MOYENS_REGLEMENT.find((item) => item.valeur === moyen)?.libelle ?? moyen;
}

// Montant saisi à la française (virgule ou point, deux décimales au plus, espaces de milliers
// tolérés) converti en centimes entiers ; null pour toute autre saisie. Les sommes se font en
// centimes : 0,10 + 0,20 vaut exactement 0,30.
export function centimesSaisis(saisie: string): number | null {
  const resultat = /^(\d{1,10})(?:[,.](\d{1,2}))?$/.exec(saisie.replace(/[\s  ]/g, ''));
  if (!resultat) return null;
  return Number(resultat[1]) * 100 + Number((resultat[2] || '').padEnd(2, '0'));
}

export const centimesDe = (montant: number) => Math.round(montant * 100);
export const saisieDeCentimes = (centimes: number) => (centimes / 100).toFixed(2).replace('.', ',');

// Répartit un montant sur les factures dans l'ordre reçu (échéance la plus ancienne d'abord),
// chacune jusqu'à son reste dû. Un reliquat reste non affecté : le formulaire le signale et
// n'envoie rien tant qu'il subsiste.
export function repartirReglement(montantCentimes: number, factures: { id: string; resteDu: number }[]): Record<string, number> {
  const parts: Record<string, number> = {};
  let reste = Math.max(0, montantCentimes);
  for (const facture of factures) {
    const part = Math.min(reste, Math.max(0, centimesDe(facture.resteDu)));
    parts[facture.id] = part;
    reste -= part;
  }
  return parts;
}

type SoldeAffiche = { type: string; statut: string; montantRegle?: number | null; resteDu?: number | null };

// Précision affichée sous le statut stocké : elle se déduit des règlements et des avoirs.
export function situationReglement(facture: SoldeAffiche, formatMontant: (montant: number) => string): string {
  if (facture.type !== 'FACTURE' || facture.resteDu === null || facture.resteDu === undefined) return '';
  if (facture.resteDu < 0) return `Trop-perçu : ${formatMontant(-facture.resteDu)}`;
  if (facture.statut === 'EMISE' && facture.resteDu === 0) return 'Soldée par avoir';
  if (facture.statut === 'EMISE' && (facture.montantRegle ?? 0) > 0) return 'Partiellement réglée';
  return '';
}
