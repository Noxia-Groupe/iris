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
const MARGE_BAS = 84;
const LARGEUR_LOGO = 160;
const HAUTEUR_LOGO = 64;

// Les polices standards PDFKit sont WinAnsi : normaliser les caractères typographiques non encodables avant impression.
export function texteWinAnsi(texte: string) {
  return [...String(texte)].map((caractere) => {
    const code = caractere.codePointAt(0);
    if (code === 0x2007 || code === 0x2009 || code === 0x202f) return ' ';
    if (code === 0x2011) return '-';
    return caractere;
  }).join('');
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

export function ouvrirDocumentPdf({ titre, identite }: { titre: string; identite: IdentiteImprimee | null }): DocumentPdf {
  const pdf = new PDFDocument({ size: 'A4', margins: { top: MARGE, left: MARGE, right: MARGE, bottom: MARGE_BAS }, bufferPages: true, info: { Title: texteWinAnsi(titre) } });
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
      if (identite?.piedDocument) {
        pdf.fontSize(7).text(texteWinAnsi(identite.piedDocument), MARGE, hauteur - MARGE_BAS + 18, { width: largeurPage, height: 30, ellipsis: true, align: 'center' });
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
