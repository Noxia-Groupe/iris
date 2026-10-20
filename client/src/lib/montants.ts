// Sommes et arrondis exacts des montants affichés (#198).
//
// Additionner des nombres à virgule dépend de l'ordre des termes et s'écarte parfois de la
// somme exacte : 12,50 € devient 12,4999…, puis s'affiche 12 € une fois arrondi à l'euro.
// Montants, heures et taux ont deux décimales en base ; les coûts de main-d'œuvre et les
// dépenses qu'envoie le serveur en ont quatre au plus (heures × taux). On additionne donc
// des entiers (centièmes ou dix-millièmes), et l'on ne divise qu'une fois.

export function sommeExacte(valeurs: Iterable<number>, decimales = 2): number {
  const facteur = 10 ** decimales;
  let total = 0;
  for (const valeur of valeurs) total += Math.round(valeur * facteur);
  return total / facteur;
}

export function differenceExacte(a: number, b: number, decimales = 4): number {
  const facteur = 10 ** decimales;
  return (Math.round(a * facteur) - Math.round(b * facteur)) / facteur;
}

// Arrondi à `decimales`, moitié vers l'extérieur, comme l'arrondi commercial et
// `toLocaleString` : -12,5 € donne -13 € (et non -12 € comme `Math.round`), et un montant
// arrondi à zéro ne s'affiche jamais « -0 € ». Deux cas, pour n'arrondir qu'une fois :
//  - un montant à quatre décimales au plus (somme de montants, heures × taux) passe d'abord en
//    dix-millièmes entiers, où une moitié est exacte : 1,005 × 100 vaut 100,4999… en flottant,
//    mais 1,005 € est bien une moitié de centime ;
//  - un rapport (taux moyen, estimation) a d'autres décimales : il est arrondi directement, sur
//    sa valeur exacte en binaire (`toFixed`). Le faire passer par les dix-millièmes l'arrondirait
//    deux fois : 104,034996 € deviendrait 104,0350 €, puis 104,04 € au lieu de 104,03 €.
// Un montant est tenu pour « à quatre décimales » s'il tombe sur un dix-millième à l'erreur
// d'arrondi binaire près (quelques unités du dernier chiffre significatif).
function arrondiExterieur(montant: number, decimales: number): number {
  const dixMilliemes = Math.abs(montant) * 10_000;
  const entier = Math.round(dixMilliemes);
  const surLaGrille = Math.abs(dixMilliemes - entier) <= 8 * Number.EPSILON * Math.max(1, dixMilliemes);
  const absolu = surLaGrille
    ? Math.round(entier / 10 ** (4 - decimales)) / 10 ** decimales
    : Number(Math.abs(montant).toFixed(decimales));
  const arrondi = Math.sign(montant) * absolu;
  return arrondi === 0 ? 0 : arrondi;
}

export const arrondiEuro = (montant: number): number => arrondiExterieur(montant, 0);

// Pour afficher au centime un montant calculé (marge, dépenses, coût de main-d'œuvre, manque
// à gagner) sans troisième décimale.
export const arrondiCentime = (montant: number): number => arrondiExterieur(montant, 2);

// Coût d'une ligne d'heures : heures × taux, arrondi au centime, moitié vers le haut, sans
// produit flottant (2,5 h × 0,41 € = 1,025 € donne 1,03 €, alors que `toFixed(2)` donne 1,02 €).
export function coutLigneHeures(heures: number, taux: number): number {
  const dixMilliemes = Math.round(heures * 100) * Math.round(taux * 100);
  return Math.round(dixMilliemes / 100) / 100;
}
