// Aperçu d'un avoir partiel, calculé comme le serveur (POST /api/factures/:id/avoirs) pour annoncer
// exactement le document émis (#236). Tout est calculé en entiers : aucun nombre à virgule ne
// participe à un arrondi.
//   - chaque ligne HT est arrondie au centime, moitié vers le haut (quantité au millième × PU HT) ;
//   - les bases HT sont cumulées par taux ;
//   - la TVA de l'avoir, à chaque taux, est la différence entre la TVA (arrondie au centime) des
//     bases HT cumulées des avoirs précédents de la facture avec lui, et sans lui.

export type LigneSaisieAvoir = { quantite: string; prixUnitaireHt: string; tauxTva: string };
type MontantParTaux = { tauxTva: number; totalHt: number };
// Avoir précédent de la facture : sa ventilation enregistrée, ou à défaut (document historique) ses
// lignes, comme ventilationFacture côté serveur.
export type AvoirPrecedent = { ventilationTva?: MontantParTaux[]; lignes?: MontantParTaux[] };
export type TotauxAvoir = { totalHt: number; totalTva: number; totalTtc: number };

// Nombre saisi à la virgule ou au point, tel que l'écran l'envoie au serveur.
export const nombreFr = (valeur: string): number | null => {
  const normalise = valeur.trim().replace(',', '.');
  return /^\d+(\.\d+)?$/.test(normalise) ? Number(normalise) : null;
};
const entierDecimal = (valeur: string, decimales: number): bigint | null => {
  const resultat = new RegExp(`^(\\d+)(?:[,.](\\d{1,${decimales}}))?$`).exec(valeur.trim());
  return resultat ? BigInt(resultat[1]) * 10n ** BigInt(decimales) + BigInt((resultat[2] || '').padEnd(decimales, '0') || '0') : null;
};
// Le serveur relit chaque nombre reçu par son écriture la plus courte : l'aperçu lit la saisie de la
// même façon (« 20,0000 » vaut 20, « 1,5000 » vaut 1,5), et non telle qu'elle est tapée.
const saisieDecimale = (valeur: string, decimales: number): bigint | null => {
  const nombre = nombreFr(valeur);
  return nombre === null ? null : entierDecimal(String(nombre), decimales);
};
// Ligne saisie, en centimes ; une saisie incomplète, ou plus précise que le serveur ne l'accepte,
// compte pour zéro (le serveur la refusera).
const centimesLigne = (quantite: string, prixUnitaireHt: string): bigint => {
  const milliemes = saisieDecimale(quantite, 3), centimesPu = saisieDecimale(prixUnitaireHt, 2);
  return milliemes === null || centimesPu === null ? 0n : (milliemes * centimesPu + 500n) / 1000n;
};
// Taux en millièmes de pour cent ; un taux mal saisi compte pour zéro, comme avant.
const milliemesTaux = (taux: string) => saisieDecimale(taux, 3) ?? 0n;
const milliemesTauxEnregistre = (taux: number) => entierDecimal(String(taux), 3) ?? 0n;
// TVA arrondie au centime d'une base HT à un taux (tvaDuTaux côté serveur).
const tvaCentimes = (baseCentimes: bigint, milliemes: bigint) => (baseCentimes * milliemes + 50000n) / 100000n;
const versCentimes = (montant: number) => BigInt(Math.round(montant * 100));
const versEuros = (centimes: bigint) => Number(centimes) / 100;

export function totauxApercuAvoir(lignes: LigneSaisieAvoir[], avoirsPrecedents: AvoirPrecedent[] = []): TotauxAvoir {
  const htParTaux = new Map<bigint, bigint>();
  for (const ligne of lignes) {
    const taux = milliemesTaux(ligne.tauxTva);
    htParTaux.set(taux, (htParTaux.get(taux) ?? 0n) + centimesLigne(ligne.quantite, ligne.prixUnitaireHt));
  }
  const precedentParTaux = new Map<bigint, bigint>();
  for (const avoir of avoirsPrecedents) {
    const montants = avoir.ventilationTva?.length ? avoir.ventilationTva : (avoir.lignes ?? []);
    for (const { tauxTva, totalHt } of montants) {
      const taux = milliemesTauxEnregistre(tauxTva);
      precedentParTaux.set(taux, (precedentParTaux.get(taux) ?? 0n) + versCentimes(totalHt));
    }
  }
  let totalHt = 0n, totalTva = 0n;
  for (const [taux, ht] of htParTaux) {
    const precedent = precedentParTaux.get(taux) ?? 0n;
    totalHt += ht;
    totalTva += tvaCentimes(precedent + ht, taux) - tvaCentimes(precedent, taux);
  }
  return { totalHt: versEuros(totalHt), totalTva: versEuros(totalTva), totalTtc: versEuros(totalHt + totalTva) };
}
