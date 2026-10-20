// Tracé de la signature dessinée au doigt (lot pilote 3b-3, décision de Nelson du 19-10-2026) :
// coordonnées normalisées entre 0 et 1, sans horodatage ni pression. Bornes identiques à celles que
// le serveur vérifie (server/src/domaines/interventions/comptesRendus.ts).
export const TRACE_MAX_TRAITS = 50;
export const TRACE_MAX_POINTS = 2000;
// Un point plus proche du précédent que ce pas (en fraction de la largeur) n'apporte rien au dessin :
// il est omis, ce qui garde une signature ordinaire loin des bornes.
const PAS_MINIMAL = 0.004;

export type Point = [number, number];
export type TraceSignature = { ratio: number; traits: Point[][] };

const borner = (valeur: number) => Math.min(1, Math.max(0, valeur));
const arrondir = (valeur: number) => Math.round(valeur * 10_000) / 10_000;

// Position relative d'un point de la zone de dessin, arrondie au dix-millième.
export function pointNormalise(x: number, y: number, largeur: number, hauteur: number): Point {
  return [arrondir(borner(x / largeur)), arrondir(borner(y / hauteur))];
}

export function nombreDePoints(traits: Point[][]): number {
  return traits.reduce((total, trait) => total + trait.length, 0);
}

// Ajoute un point au dernier trait, sauf s'il est trop proche du précédent ou si le tracé atteint sa
// borne. Rend false quand la borne empêche l'ajout.
export function prolongerTrait(traits: Point[][], point: Point, ratio: number): boolean {
  const trait = traits[traits.length - 1];
  if (!trait) return false;
  const dernier = trait[trait.length - 1];
  // L'écart vertical est ramené à l'échelle de la largeur, pour un pas égal dans les deux sens.
  if (dernier && Math.hypot(point[0] - dernier[0], (point[1] - dernier[1]) / ratio) < PAS_MINIMAL) return true;
  if (nombreDePoints(traits) >= TRACE_MAX_POINTS) return false;
  trait.push(point);
  return true;
}

export function commencerTrait(traits: Point[][], point: Point): boolean {
  if (traits.length >= TRACE_MAX_TRAITS || nombreDePoints(traits) >= TRACE_MAX_POINTS) return false;
  traits.push([point]);
  return true;
}

// Une signature relie au moins deux points distincts : un simple appui n'en est pas une.
export function traceSuffisant(traits: Point[][]): boolean {
  return traits.some((trait) => trait.some(([x, y]) => x !== trait[0][0] || y !== trait[0][1]));
}

// Chemins SVG du tracé dans une boîte de largeur ratio × 100 et de hauteur 100.
export function cheminsSvg(trace: TraceSignature): string[] {
  const largeur = trace.ratio * 100;
  return trace.traits.map((trait) => {
    const [premier, ...suite] = trait;
    const debut = `M${(premier[0] * largeur).toFixed(1)} ${(premier[1] * 100).toFixed(1)}`;
    // Un trait d'un seul point se dessine comme un court segment, pour rester visible.
    if (!suite.length) return `${debut} l0.1 0`;
    return `${debut} ${suite.map(([x, y]) => `L${(x * largeur).toFixed(1)} ${(y * 100).toFixed(1)}`).join(' ')}`;
  });
}
