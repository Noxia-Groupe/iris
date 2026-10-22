import { createHash } from 'crypto';
import { inflateSync } from 'zlib';
import PDFDocument from 'pdfkit';

// Logo des documents (lot 6a-1). Choix par défaut, à confirmer : PNG ou JPEG, les deux formats
// que le moteur PDF sait imprimer, 500 Ko et 2 000 pixels de côté au plus.
export const TAILLE_MAX_LOGO = 500 * 1024;
export const COTE_MAX_LOGO = 2000;

export class LogoInvalideError extends Error {}

export type LogoValide = { contenu: Buffer; typeMime: 'image/png' | 'image/jpeg'; empreinte: string; taille: number };

const SIGNATURE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ILLISIBLE = 'Ce fichier image est illisible : enregistrez-le de nouveau en PNG ou JPEG.';
// Canaux par type de couleur PNG, et profondeurs admises pour chacun (norme PNG, section 11.2.2).
const CANAUX_PNG: Record<number, { canaux: number; profondeurs: number[] }> = {
  0: { canaux: 1, profondeurs: [1, 2, 4, 8, 16] },
  2: { canaux: 3, profondeurs: [8, 16] },
  3: { canaux: 1, profondeurs: [1, 2, 4, 8] },
  4: { canaux: 2, profondeurs: [8, 16] },
  6: { canaux: 4, profondeurs: [8, 16] },
};
// Les sept passes de l'entrelacement Adam7 : colonne et ligne de départ, pas horizontal et vertical.
const PASSES_ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

// Le moteur PDF décompresse les pixels d'un PNG transparent ou entrelacé de façon asynchrone, et une
// donnée corrompue y lève une exception hors de toute requête, qui arrêterait le serveur à
// l'impression. Les pixels sont donc décompressés ici, à l'envoi du fichier, leur volume vérifié et
// leurs lignes parcourues comme le moteur les parcourt.
function verifierPixelsPng(contenu: Buffer) {
  let position = 8;
  let entete: Buffer | null = null;
  let palette = false;
  let fin = false;
  const donnees: Buffer[] = [];
  while (position + 12 <= contenu.length && !fin) {
    const longueur = contenu.readUInt32BE(position);
    const type = contenu.toString('latin1', position + 4, position + 8);
    const debut = position + 8;
    if (debut + longueur + 4 > contenu.length) throw new LogoInvalideError(ILLISIBLE);
    const morceau = contenu.subarray(debut, debut + longueur);
    if (!entete && type !== 'IHDR') throw new LogoInvalideError(ILLISIBLE);
    // Le moteur (png-js) ne lit pas le contenu d'un tRNS sous un type autre que 0, 2 ou 3 (la norme
    // l'y interdit) : il se désaligne alors sur la suite du fichier, jusqu'à boucler sans fin.
    if (type === 'tRNS' && ![0, 2, 3].includes(entete![9])) throw new LogoInvalideError(ILLISIBLE);
    if (type === 'IHDR') entete = morceau;
    else if (type === 'PLTE') palette = true;
    else if (type === 'IDAT') donnees.push(morceau);
    else if (type === 'IEND') fin = true;
    position = debut + longueur + 4;
  }
  if (!entete || entete.length !== 13 || !fin || !donnees.length) throw new LogoInvalideError(ILLISIBLE);
  const largeur = entete.readUInt32BE(0);
  const hauteur = entete.readUInt32BE(4);
  const [profondeur, couleur, compression, filtre, entrelacement] = [entete[8], entete[9], entete[10], entete[11], entete[12]];
  const format = CANAUX_PNG[couleur];
  if (!format || !format.profondeurs.includes(profondeur) || compression !== 0 || filtre !== 0 || entrelacement > 1 || (couleur === 3 && !palette)) {
    throw new LogoInvalideError(ILLISIBLE);
  }
  if (!largeur || !hauteur || largeur > COTE_MAX_LOGO || hauteur > COTE_MAX_LOGO) {
    throw new LogoInvalideError('Le logo doit mesurer au plus 2 000 pixels de côté.');
  }
  const octetsPasse = (l: number, h: number) => (l > 0 && h > 0 ? h * (1 + Math.ceil((l * format.canaux * profondeur) / 8)) : 0);
  const attendu = entrelacement
    ? PASSES_ADAM7.reduce((somme, [x, y, pasX, pasY]) => somme + octetsPasse(Math.ceil((largeur - x) / pasX), Math.ceil((hauteur - y) / pasY)), 0)
    : octetsPasse(largeur, hauteur);
  let pixels: Buffer;
  try {
    pixels = inflateSync(Buffer.concat(donnees), { maxOutputLength: attendu + 1 });
  } catch {
    throw new LogoInvalideError(ILLISIBLE);
  }
  if (pixels.length !== attendu) throw new LogoInvalideError(ILLISIBLE);
  // Chaque ligne commence par son filtre (0 à 4) : le moteur lève l'exception asynchrone sur tout
  // autre octet. Il lit aussi, contre la norme, un octet de filtre par ligne d'une passe Adam7 vide
  // (image entrelacée de moins de 5 pixels de large) : ce parcours reproduit sa lecture.
  const octetsPixel = (format.canaux * profondeur) / 8;
  let curseur = 0;
  for (const [x, y, pasX, pasY] of entrelacement ? PASSES_ADAM7 : [[0, 0, 1, 1]]) {
    const largeurPasse = Math.ceil((largeur - x) / pasX);
    const hauteurPasse = Math.ceil((hauteur - y) / pasY);
    for (let ligne = 0; ligne < hauteurPasse && curseur < pixels.length; ligne++) {
      if (pixels[curseur] > 4) throw new LogoInvalideError(ILLISIBLE);
      curseur += 1 + Math.max(0, Math.ceil(octetsPixel * largeurPasse));
    }
  }
}

// Le fichier arrive en `data:` URL (le corps JSON de l'API). Le type déclaré doit correspondre au
// contenu, et le moteur PDF doit savoir le lire : un fichier qu'il refuse ne serait découvert qu'à
// l'impression d'une facture déjà émise.
export function validerLogo(fichier: unknown): LogoValide {
  if (typeof fichier !== 'string') throw new LogoInvalideError('Joignez un fichier PNG ou JPEG.');
  const correspondance = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(fichier);
  if (!correspondance) throw new LogoInvalideError('Le logo doit être un fichier PNG ou JPEG.');
  const typeMime = correspondance[1] as LogoValide['typeMime'];
  const contenu = Buffer.from(correspondance[2], 'base64');
  if (!contenu.length) throw new LogoInvalideError('Le fichier du logo est vide.');
  if (contenu.length > TAILLE_MAX_LOGO) throw new LogoInvalideError('Logo trop volumineux (limite : 500 Ko).');
  const estPng = contenu.subarray(0, 8).equals(SIGNATURE_PNG);
  const estJpeg = contenu.length > 3 && contenu[0] === 0xff && contenu[1] === 0xd8 && contenu[2] === 0xff;
  if ((typeMime === 'image/png' && !estPng) || (typeMime === 'image/jpeg' && !estJpeg)) {
    throw new LogoInvalideError('Le contenu du fichier ne correspond pas à son format (PNG ou JPEG).');
  }
  if (estPng) verifierPixelsPng(contenu);
  let image: { width: number; height: number };
  try {
    // `openImage` lit l'image comme à l'impression ; il n'est pas déclaré dans les types de PDFKit.
    const moteur = new PDFDocument({ autoFirstPage: false }) as unknown as { openImage(source: Buffer): { width: number; height: number } };
    image = moteur.openImage(contenu);
  } catch {
    throw new LogoInvalideError(ILLISIBLE);
  }
  if (!(image.width > 0 && image.height > 0) || image.width > COTE_MAX_LOGO || image.height > COTE_MAX_LOGO) {
    throw new LogoInvalideError('Le logo doit mesurer au plus 2 000 pixels de côté.');
  }
  return { contenu, typeMime, empreinte: createHash('sha256').update(contenu).digest('hex'), taille: contenu.length };
}
