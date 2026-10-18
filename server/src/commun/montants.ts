import { Prisma } from '@prisma/client';

// Convertit récursivement les Decimal Prisma en nombres pour la sérialisation JSON
// (sinon ils seraient sérialisés en chaînes côté client). Les montants sont stockés
// en Decimal (précis) en base, et exposés en `number` à l'API.
export function decimalToNumber(value: any): any {
  if (value === null || value === undefined) return value;
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).toNumber();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(decimalToNumber);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = decimalToNumber(value[key]);
    }
    return out;
  }
  return value;
}

export const PLAFOND_MONTANT = 9_999_999_999.99;
export class FactureInvalideError extends Error {}

export type LigneTaxable = { tauxTva: unknown; totalHt: unknown };
export const tauxUtilises = (lignes: LigneTaxable[]) => [...new Set(lignes.map(ligne => Number(ligne.tauxTva)))];
export const baseHtDuTaux = (lignes: LigneTaxable[], taux: number) => centimes(lignes.filter(ligne => Number(ligne.tauxTva) === taux).reduce((somme, ligne) => somme + Number(ligne.totalHt), 0));
export const tvaDuTaux = (lignes: LigneTaxable[], taux: number) => {
  const baseCentimes = entierDecimal(baseHtDuTaux(lignes, taux), 2);
  const millièmesTaux = entierDecimal(taux, 3);
  return Number((baseCentimes * millièmesTaux + 50000n) / 100000n) / 100;
};

// Arrondi commercial exact au centime d’une ligne : quantité (au millième) × PU HT
// (au centime). Les montants de facture et d’avoir sont toujours positifs ; leur sens est
// porté par le type du document. Aucun flottant ne participe à ce calcul.
function entierDecimal(value: unknown, decimales: number): bigint {
  const texte = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  const expression = new RegExp(`^(\\d+)(?:[,.](\\d{1,${decimales}}))?$`);
  const resultat = expression.exec(texte);
  if (!resultat) throw new FactureInvalideError('Montant de ligne invalide.');
  return BigInt(resultat[1]) * 10n ** BigInt(decimales) + BigInt((resultat[2] || '').padEnd(decimales, '0') || '0');
}

export function arrondiCommercialLigneHt(quantite: unknown, prixUnitaireHt: unknown): number {
  const milliemes = entierDecimal(quantite, 3);
  const centimesPu = entierDecimal(prixUnitaireHt, 2);
  // Le produit est exprimé en millièmes de centime. Ajouter 500 puis diviser par 1 000
  // applique exactement « moitié vers le haut » pour les valeurs positives.
  return Number((milliemes * centimesPu + 500n) / 1000n) / 100;
}

export function centimesTtcLigne(totalHt: number, tauxTva: unknown): number {
  const centimesHt = entierDecimal(totalHt, 2);
  const millièmesTaux = entierDecimal(tauxTva, 3);
  // (100 % + taux) est exprimé en millièmes de pourcentage. L'arrondi final est
  // commercial, identique à la ligne HT, y compris aux taux 10 % et 5,5 %.
  return Number((centimesHt * (100000n + millièmesTaux) + 50000n) / 100000n) / 100;
}

export const centimes = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Sommes exactes de montants et de quantités (#198). Additionner des nombres à virgule
// dépend de l'ordre des termes et peut s'écarter de la somme exacte : 12,50 € devient
// 12,4999…, s'affiche 12 € une fois arrondi à l'euro, ou déclenche à tort une alerte de
// dépassement. Montants, heures et taux ont deux décimales en base ; l'écriture la plus
// courte de leur nombre, que lit Prisma.Decimal, redonne exactement ces décimales. Le
// calcul se fait donc en décimal exact. Un total partiel garde au plus quatre décimales et
// bien moins de quinze chiffres : repassé en nombre, il se relit exactement, ce qui permet
// de cumuler terme à terme (`total = sommeExacte(total, terme)`).
export const sommeExacte = (...termes: unknown[]): number =>
  termes.reduce<Prisma.Decimal>((somme, terme) => somme.plus(Number(terme)), new Prisma.Decimal(0)).toNumber();
export const differenceExacte = (a: unknown, b: unknown): number => new Prisma.Decimal(Number(a)).minus(Number(b)).toNumber();
// Heures × taux horaire : quatre décimales au plus, calculées exactement.
export const produitExact = (a: unknown, b: unknown): number => new Prisma.Decimal(Number(a)).times(Number(b)).toNumber();
// Quotient en décimal (précision 20) : a × b ÷ c retombe exactement sur a quand b = c.
export const quotientExact = (a: unknown, b: unknown): number => new Prisma.Decimal(Number(a)).div(Number(b)).toNumber();
