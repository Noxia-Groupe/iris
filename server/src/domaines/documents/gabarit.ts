import PDFDocument from 'pdfkit';
import { COULEUR_DOCUMENT_PAR_DEFAUT } from './identite';

// Gabarit commun des documents PDF (lot 6a-1, option B de P5) : en-tête avec le logo et
// l'identité de la société, pied de page et pagination sur chaque page. L'appelant fournit
// l'identité à imprimer : celle figée sur la pièce pour une facture émise, jamais les
// paramètres vivants. Sans identité (pièce émise avant ce lot), le document n'a ni en-tête ni
// pied de société.
export type IdentiteImprimee = {
  raisonSociale: string; nomCommercial: string | null; siret: string; tvaIntra: string | null;
  adresse: string; codePostal: string; ville: string; pays: string | null;
  telephone: string | null; email: string | null; siteWeb: string | null;
  piedDocument: string | null; couleurPrimaire: string;
  logo: { contenu: Uint8Array } | null;
};

export type DocumentPdf = {
  pdf: PDFKit.PDFDocument;
  couleur: string;
  ligne: (texte: string, options?: { taille?: number } & Record<string, unknown>) => PDFKit.PDFDocument;
  terminer: () => Promise<Buffer>;
};

const MARGE = 48;
const MARGE_BAS_MIN = 84;
// Au-delà (une quarantaine de lignes, que seuls des retours à la ligne atteignent sous la limite de
// 2 000 caractères du champ), le pied serait tronqué plutôt que d'écraser le contenu de la page.
const HAUTEUR_PIED_MAX = 300;
const LARGEUR_LOGO = 160;
const HAUTEUR_LOGO = 64;

// Caractères de la page de code 1252 hors Latin-1 que PDFKit sait encoder (€, ’, œ, …, —).
const WIN_ANSI_HORS_LATIN1 = new Set([0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
  0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178]);
const encodableWinAnsi = (code: number) => code === 0x0a || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_HORS_LATIN1.has(code);
// Seules décompositions de compatibilité sans changement de sens : ligatures (ﬁ → fi) et formes
// pleine chasse (Ａ１ → A1). Les autres (10⁶ → 106, ① → 1, ㎡ → m2) changeraient le texte imprimé.
const compatibiliteSansPerte = (code: number) => (code >= 0xfb00 && code <= 0xfb06) || (code >= 0xff01 && code <= 0xff5e);
// Accents combinants, sauf les surimpressions U+0334 à U+0338 et les barres au-dessus U+0305 et
// U+033F, qui ne sont l'accent d'aucune langue : retirer la barre de « ≠ » ou de « ≮ » imprimerait
// « = » ou « < », celle de « A̅ » (non A) ou de « 0,3̅ » (0,333…) imprimerait « A » ou « 0,3 », un
// autre texte que celui saisi.
const ACCENTS_COMBINANTS = /[\u0300-\u0304\u0306-\u0333\u0339-\u033e\u0340-\u036f]/g;

// Équivalents imprimables de même sens : espaces typographiques, traits d'union et signe moins,
// inégalités larges, séparateurs de ligne. Les caractères invisibles (espace sans chasse, liants,
// marque d'ordre des octets, trait d'union conditionnel) ne s'impriment pas : ils n'apparaissent
// pas non plus à la saisie. Une fin de ligne Windows (\r\n) ou ancienne (\r seul) est un saut de
// ligne (texteWinAnsi) : retirer un \r seul collerait deux mots (« 10\r20 » imprimé « 1020 »).
const EQUIVALENTS_WIN_ANSI = new Map<number, string>([
  [0x09, ' '], [0x202f, ' '], [0x205f, ' '], [0x3000, ' '],
  ...Array.from({ length: 11 }, (_, rang): [number, string] => [0x2000 + rang, ' ']),
  [0x2010, '-'], [0x2011, '-'], [0x2012, '-'], [0x2212, '-'],
  [0x2264, '<='], [0x2265, '>='],
  [0x2028, '\n'], [0x2029, '\n'],
  [0xad, ''], [0x200b, ''], [0x200c, ''], [0x200d, ''], [0x2060, ''], [0xfeff, ''],
]);

// Les polices standards PDFKit sont WinAnsi : normaliser les caractères typographiques non encodables avant impression.
// Un autre caractère (Ω, ⌀, ł, émoji…) serait écrit par PDFKit avec plus ou moins de deux
// chiffres hexadécimaux et décalerait toute la suite de la ligne, montants compris : il devient sa
// lettre de base quand elle existe (č → c), sinon « ? ». Le texte est d'abord recomposé (NFC) : un
// « e » suivi d'un accent combinant, fréquent dans un texte copié, s'imprime « é », et non « e? ».
export function texteWinAnsi(texte: string) {
  return [...String(texte).normalize('NFC').replace(/\r\n?/g, '\n')].map((caractere) => {
    const code = caractere.codePointAt(0)!;
    const equivalent = EQUIVALENTS_WIN_ANSI.get(code);
    if (equivalent !== undefined) return equivalent;
    if (encodableWinAnsi(code)) return caractere;
    const base = caractere.normalize(compatibiliteSansPerte(code) ? 'NFKD' : 'NFD').replace(ACCENTS_COMBINANTS, '');
    // Accent combinant resté seul (sur une lettre sans forme composée) : la lettre est déjà imprimée.
    if (!base) return '';
    return [...base].every((lettre) => encodableWinAnsi(lettre.codePointAt(0)!)) ? base : '?';
  }).join('');
}

// Ligne d'un tableau à chasse fixe : la première cellule calée à gauche, les suivantes à droite,
// chacune mesurée telle qu'elle s'imprime. Une valeur trop large ne se colle jamais à la colonne
// précédente : elle garde au moins un séparateur. Une cellule tient sur sa ligne : un saut de ligne
// saisi (dans une unité, par exemple) y devient une espace, sinon les montants qui le suivent
// passeraient à la ligne suivante.
export function ligneColonnes(cellules: string[], largeurs: number[]) {
  return cellules.map((brute, rang) => {
    const valeur = texteWinAnsi(brute).replace(/\n/g, ' ');
    if (rang === 0) return valeur.padEnd(largeurs[0]);
    return valeur.length >= largeurs[rang] ? ` ${valeur}` : valeur.padStart(largeurs[rang]);
  }).join('');
}

// Coupe un texte en lignes d'au plus `largeur` caractères, pour les colonnes à chasse fixe des
// tableaux de lignes ; un mot trop long est coupé. La largeur se mesure sur le texte tel qu'il
// s'imprime : un accent à recomposer, une ligature ou un émoji ne décalent pas les colonnes.
export function replierTexte(texte: string, largeur: number) {
  const lignes: string[] = []; let courante = '';
  for (let mot of texteWinAnsi(texte).split(/\s+/).filter(Boolean)) {
    while (mot.length > largeur) { if (courante) { lignes.push(courante); courante = ''; } lignes.push(mot.slice(0, largeur)); mot = mot.slice(largeur); }
    const essai = courante ? `${courante} ${mot}` : mot;
    if (essai.length <= largeur) courante = essai; else { lignes.push(courante); courante = mot; }
  }
  if (courante || !lignes.length) lignes.push(courante); return lignes;
}

function lignesIdentite(identite: IdentiteImprimee) {
  const localite = [identite.codePostal, identite.ville].filter(Boolean).join(' ');
  return [
    identite.nomCommercial && identite.nomCommercial !== identite.raisonSociale ? identite.nomCommercial : null,
    identite.adresse,
    localite,
    identite.pays,
    identite.telephone ? `Tél. ${identite.telephone}` : null,
    identite.email,
    identite.siteWeb,
    `SIRET ${identite.siret}`,
    identite.tvaIntra ? `TVA intracommunautaire ${identite.tvaIntra}` : null,
  ].filter((valeur): valeur is string => Boolean(valeur));
}

// Hauteur du pied de page, mesurée dans la police et la largeur où il s'imprime.
function hauteurPied(texte: string) {
  const mesure = new PDFDocument({ size: 'A4', margins: { top: MARGE, left: MARGE, right: MARGE, bottom: MARGE } });
  return mesure.font('Helvetica').fontSize(7).heightOfString(texte, { width: mesure.page.width - 2 * MARGE, align: 'center' });
}

export function ouvrirDocumentPdf({ titre, identite }: { titre: string; identite: IdentiteImprimee | null }): DocumentPdf {
  // Le pied de page (mentions, conditions de règlement) s'imprime en entier sur chaque page : la
  // marge basse lui réserve sa hauteur, au-dessus de la pagination.
  const pied = identite?.piedDocument ? texteWinAnsi(identite.piedDocument) : null;
  const margeBas = Math.max(MARGE_BAS_MIN, pied ? Math.min(HAUTEUR_PIED_MAX, Math.ceil(hauteurPied(pied))) + 54 : 0);
  const pdf = new PDFDocument({ size: 'A4', margins: { top: MARGE, left: MARGE, right: MARGE, bottom: margeBas }, bufferPages: true, info: { Title: texteWinAnsi(titre) } });
  const morceaux: Buffer[] = [];
  const fini = new Promise<Buffer>((resolve, reject) => {
    pdf.on('data', (morceau: Buffer) => morceaux.push(morceau));
    pdf.on('end', () => resolve(Buffer.concat(morceaux)));
    pdf.on('error', reject);
  });
  const couleur = identite?.couleurPrimaire && /^#[0-9a-f]{6}$/i.test(identite.couleurPrimaire) ? identite.couleurPrimaire : COULEUR_DOCUMENT_PAR_DEFAUT;
  const ligne: DocumentPdf['ligne'] = (texte, options = {}) => {
    const { taille, ...reste } = options;
    if (taille) pdf.fontSize(taille);
    return pdf.text(texteWinAnsi(texte), reste as PDFKit.Mixins.TextOptions);
  };

  if (identite) {
    const largeurPage = pdf.page.width - 2 * MARGE;
    let basLogo = MARGE;
    if (identite.logo) {
      pdf.image(Buffer.from(identite.logo.contenu), MARGE, MARGE, { fit: [LARGEUR_LOGO, HAUTEUR_LOGO] });
      basLogo = MARGE + HAUTEUR_LOGO;
    }
    // L'identité s'aligne à droite, à côté du logo ; sans logo, elle occupe la même place.
    const xIdentite = MARGE + LARGEUR_LOGO + 24;
    const largeurIdentite = largeurPage - LARGEUR_LOGO - 24;
    pdf.font('Helvetica-Bold').fontSize(11).fillColor('#000000');
    pdf.text(texteWinAnsi(identite.raisonSociale), xIdentite, MARGE, { width: largeurIdentite, align: 'right' });
    pdf.font('Helvetica').fontSize(8.5).fillColor('#374151');
    for (const valeur of lignesIdentite(identite)) pdf.text(texteWinAnsi(valeur), { width: largeurIdentite, align: 'right' });
    const basEntete = Math.max(basLogo, pdf.y) + 10;
    pdf.moveTo(MARGE, basEntete).lineTo(MARGE + largeurPage, basEntete).lineWidth(1.5).strokeColor(couleur).stroke();
    pdf.fillColor('#000000');
    pdf.x = MARGE;
    pdf.y = basEntete + 14;
  }

  const terminer = () => {
    const pages = pdf.bufferedPageRange();
    const largeurPage = pdf.page.width - 2 * MARGE;
    for (let index = 0; index < pages.count; index++) {
      pdf.switchToPage(pages.start + index);
      // Le pied s'écrit dans la marge basse : la neutraliser le temps de l'écrire évite que PDFKit
      // n'ouvre une nouvelle page.
      const margeBas = pdf.page.margins.bottom;
      pdf.page.margins.bottom = 0;
      const hauteur = pdf.page.height;
      pdf.font('Helvetica').fillColor('#4b5563');
      if (pied) {
        pdf.fontSize(7).text(pied, MARGE, hauteur - margeBas + 18, { width: largeurPage, height: margeBas - 54, ellipsis: true, align: 'center' });
      }
      pdf.fontSize(7.5).text(`Page ${index + 1} / ${pages.count}`, MARGE, hauteur - 34, { width: largeurPage, align: 'right', lineBreak: false });
      pdf.page.margins.bottom = margeBas;
    }
    pdf.fillColor('#000000');
    pdf.end();
    return fini;
  };

  return { pdf, couleur, ligne, terminer };
}
