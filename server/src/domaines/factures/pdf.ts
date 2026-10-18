import PDFDocument from 'pdfkit';
import { formatMontantFacture, formatDateFacture, ventilationFacture } from './metier';

export async function rendreDocumentFacturePdf(facture: any, societe: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Facture ${facture.numero}` } });
    const morceaux: Buffer[] = [];
    pdf.on('data', (morceau: Buffer) => morceaux.push(morceau));
    pdf.on('end', () => resolve(Buffer.concat(morceaux)));
    pdf.on('error', reject);
    // Les polices standards PDFKit sont WinAnsi : normaliser les caractères typographiques non encodables avant impression.
    const winAnsi = (texte: string) => [...String(texte)].map((caractere) => {
      const code = caractere.codePointAt(0);
      if (code === 0x2007 || code === 0x2009 || code === 0x202f) return ' ';
      if (code === 0x2011) return '-';
      return caractere;
    }).join('');
    const ligne = (texte: string, options: { taille?: number } & Record<string, unknown> = {}) => {
      const { taille, ...reste } = options;
      if (taille) pdf.fontSize(taille);
      return pdf.text(winAnsi(texte), reste as any);
    };
    const replier = (texte: string, largeur: number) => {
      const lignes: string[] = []; let courante = '';
      for (let mot of String(texte).split(/\s+/).filter(Boolean)) {
        while (mot.length > largeur) { if (courante) { lignes.push(courante); courante = ''; } lignes.push(mot.slice(0, largeur)); mot = mot.slice(largeur); }
        const essai = courante ? `${courante} ${mot}` : mot;
        if (essai.length <= largeur) courante = essai; else { lignes.push(courante); courante = mot; }
      }
      if (courante || !lignes.length) lignes.push(courante); return lignes;
    };
    const legal = facture.mentionsLegalesVersion;
    const couleurPrimaire = /^#[0-9a-f]{6}$/i.test(societe.couleurPrimaire || '') ? societe.couleurPrimaire : '#1e3a8a';
    // Une valeur large ne doit jamais se coller à la colonne précédente : on garde au moins un séparateur.
    const colonne = (valeur: string, largeur: number) => (valeur.length >= largeur ? ` ${valeur}` : valeur.padStart(largeur));
    const colonnes = (a: string, b: string, c: string, d: string, e: string) => a.padEnd(38) + colonne(b, 9) + colonne(c, 16) + colonne(d, 8) + colonne(e, 16);

    // L'identité de l'émetteur est portée par la version légale figée à l'émission, jamais par les paramètres vivants.
    pdf.fillColor(couleurPrimaire);
    const estAvoir = facture.type === 'AVOIR';
    ligne(`${estAvoir ? 'AVOIR' : 'FACTURE'} ${facture.numero}`, { taille: 18 });
    pdf.fillColor('#000000');
    ligne(`Émise le ${formatDateFacture(facture.dateEmission)} · Échéance : ${formatDateFacture(facture.dateEcheance)}`, { taille: 10 });
    if (estAvoir) ligne(`Facture d’origine : ${facture.factureOrigine?.numero || 'référence indisponible'}`, { taille: 10 });
    // Les documents de statuts post-émission doivent expliciter leur situation : un PDF
    // annulé muet serait indistinguable d'une créance toujours due.
    if (facture.statut === 'ANNULEE') { pdf.fillColor('#b91c1c'); ligne('FACTURE ANNULÉE — ce document ne vaut pas justificatif de créance.', { taille: 12 }); pdf.fillColor('#000000'); }
    else if (facture.statut === 'REGLEE') ligne('Facture réglée.', { taille: 10 });
    pdf.moveDown();
    ligne('Émetteur', { taille: 11 });
    ligne(legal.mentions, { taille: 9 });
    pdf.moveDown();
    ligne('Client', { taille: 11 });
    ligne(facture.clientRaisonSociale, { taille: 12 });
    ligne(facture.clientAdresse, { taille: 9 });
    pdf.moveDown();
    pdf.font('Courier');
    ligne(colonnes('Désignation', 'Qté', 'PU HT', 'TVA', 'Total HT'), { taille: 9 });
    for (const item of facture.lignes) {
      const [premiere, ...suite] = replier(String(item.designation), 36);
      ligne(colonnes(premiere, String(item.quantite), formatMontantFacture(item.prixUnitaireHt), `${Number(item.tauxTva)} %`, formatMontantFacture(item.totalHt)), { taille: 9 });
      for (const reste of suite) ligne(reste, { taille: 9 });
    }
    pdf.font('Helvetica');
    pdf.moveDown();
    const tvaParTaux = ventilationFacture(facture).map(ventilation => ({ taux: ventilation.tauxTva, ht: ventilation.totalHt, tva: ventilation.totalTva }));
    ligne(`Total HT : ${formatMontantFacture(facture.totalHt)}`, { taille: 10, align: 'right' });
    for (const cumul of tvaParTaux) ligne(`TVA ${cumul.taux} % sur ${formatMontantFacture(cumul.ht)} : ${formatMontantFacture(cumul.tva)}`, { taille: 10, align: 'right' });
    ligne(`TVA totale : ${formatMontantFacture(facture.totalTva)}`, { taille: 10, align: 'right' });
    ligne(`Total TTC : ${formatMontantFacture(facture.totalTtc)}`, { taille: 13, align: 'right' });
    pdf.moveDown();
    ligne(`Mentions légales et CGV — version ${legal.version}`, { taille: 10 });
    ligne(legal.cgv, { taille: 8 });
    ligne(`Pénalités : ${legal.penalites}`, { taille: 8 });
    if (legal.escompte) ligne(`Escompte : ${legal.escompte}`, { taille: 8 });
    pdf.end();
  });
}
