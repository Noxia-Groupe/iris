import { baseHtDuTaux, tauxUtilises, tvaDuTaux } from '../../commun/montants';
import { jourCivilEntreprise } from '../../commun/dates';
import { formatMontantFacture } from '../factures/metier';
import { ligneColonnes, ouvrirDocumentPdf, replierTexte, type IdentiteImprimee } from '../documents/gabarit';

// PDF du devis (lot 6a-2), sur le modèle commun du lot 6a-1. L'appelant fournit l'identité et le
// client à imprimer : les copies prises à la signature pour un devis signé, les données
// actuelles pour un devis qui ne l'est pas encore. Le prix d'achat prévu n'est jamais imprimé.
export type DevisImprime = {
  numero: string; version: number; objet: string; statut: string; createdAt: Date;
  totalHt: unknown; totalTva: unknown; totalTtc: unknown; acompteExige: boolean; tauxAcompte: unknown;
  lignes: { designation: string; reference: string | null; unite: string | null; quantite: unknown; prixUnitaireHt: unknown; tauxTva: unknown; totalHt: unknown }[];
  signature: { signataire: string; signeLe: Date; empreinte: string } | null;
};

const nombre = (valeur: unknown, decimales: number) => Number(valeur).toLocaleString('fr-FR', { maximumFractionDigits: decimales });

export async function rendreDocumentDevisPdf({ devis, identite, client, fuseau }: {
  devis: DevisImprime;
  identite: IdentiteImprimee;
  client: { raisonSociale: string; adresse: string | null };
  fuseau: string;
}): Promise<Buffer> {
  const document = ouvrirDocumentPdf({ titre: `Devis ${devis.numero} version ${devis.version}`, identite });
  const { pdf, ligne, couleur } = document;
  const jour = (instant: Date) => jourCivilEntreprise(instant, fuseau).split('-').reverse().join('-');
  const colonnes = (...cellules: string[]) => ligneColonnes(cellules, [33, 12, 16, 8, 16]);

  pdf.fillColor(couleur);
  ligne(`DEVIS ${devis.numero}`, { taille: 18 });
  pdf.fillColor('#000000');
  ligne(`Version ${devis.version} · établi le ${jour(devis.createdAt)}`, { taille: 10 });
  // Comme pour une facture annulée : un devis annulé imprimé sans le dire passerait pour une offre valable.
  if (devis.statut === 'ANNULE') { pdf.fillColor('#b91c1c'); ligne('DEVIS ANNULÉ — cette offre n’est plus valable.', { taille: 12 }); pdf.fillColor('#000000'); }
  else if (devis.statut === 'REFUSE') ligne('Devis refusé.', { taille: 10 });
  pdf.moveDown();
  ligne('Client', { taille: 11 });
  ligne(client.raisonSociale, { taille: 12 });
  if (client.adresse) ligne(client.adresse, { taille: 9 });
  pdf.moveDown();
  ligne(`Objet : ${devis.objet}`, { taille: 11 });
  pdf.moveDown();
  pdf.font('Courier');
  ligne(colonnes('Désignation', 'Qté', 'PU HT', 'TVA', 'Total HT'), { taille: 9 });
  for (const item of devis.lignes) {
    const [premiere, ...suite] = replierTexte(item.designation, 31);
    const quantite = `${nombre(item.quantite, 3)}${item.unite ? ` ${item.unite}` : ''}`;
    ligne(colonnes(premiere, quantite, formatMontantFacture(item.prixUnitaireHt), `${nombre(item.tauxTva, 3)} %`, formatMontantFacture(item.totalHt)), { taille: 9 });
    for (const reste of suite) ligne(reste, { taille: 9 });
    // Seule sur sa ligne, la référence peut occuper toute la largeur du tableau.
    if (item.reference) for (const reste of replierTexte(`Réf. ${item.reference}`, 85)) ligne(reste, { taille: 9 });
  }
  pdf.font('Helvetica');
  pdf.moveDown();
  // Ventilation recalculée depuis les lignes, avec l'arrondi qui a donné la TVA du devis :
  // sur la base HT cumulée de chaque taux.
  const lignesTaxables = devis.lignes.map((item) => ({ tauxTva: Number(item.tauxTva), totalHt: Number(item.totalHt) }));
  ligne(`Total HT : ${formatMontantFacture(devis.totalHt)}`, { taille: 10, align: 'right' });
  for (const taux of tauxUtilises(lignesTaxables).sort((a, b) => a - b)) {
    ligne(`TVA ${nombre(taux, 3)} % sur ${formatMontantFacture(baseHtDuTaux(lignesTaxables, taux))} : ${formatMontantFacture(tvaDuTaux(lignesTaxables, taux))}`, { taille: 10, align: 'right' });
  }
  ligne(`TVA totale : ${formatMontantFacture(devis.totalTva)}`, { taille: 10, align: 'right' });
  ligne(`Total TTC : ${formatMontantFacture(devis.totalTtc)}`, { taille: 13, align: 'right' });
  if (devis.acompteExige && devis.tauxAcompte !== null && devis.tauxAcompte !== undefined) {
    pdf.moveDown();
    ligne(`Acompte demandé : ${nombre(devis.tauxAcompte, 2)} %`, { taille: 10 });
  }
  pdf.moveDown();
  if (devis.signature) {
    ligne('Bon pour accord', { taille: 11 });
    ligne(`Accepté par ${devis.signature.signataire} le ${jour(devis.signature.signeLe)}.`, { taille: 10 });
    ligne(`Empreinte du contenu signé (SHA-256) : ${devis.signature.empreinte}`, { taille: 7 });
  } else if (devis.statut !== 'ANNULE' && devis.statut !== 'REFUSE') {
    // Cadre laissé au client : il tient sur la page, sinon il passe à la suivante avec son titre.
    const hauteurCadre = 70;
    if (pdf.y + 40 + hauteurCadre > pdf.page.height - pdf.page.margins.bottom) pdf.addPage();
    ligne('Bon pour accord', { taille: 11 });
    ligne('Date, nom et signature du client :', { taille: 9 });
    const haut = pdf.y + 4;
    pdf.rect(pdf.page.margins.left, haut, 240, hauteurCadre).lineWidth(0.75).strokeColor('#6b7280').stroke();
    pdf.x = pdf.page.margins.left;
    pdf.y = haut + hauteurCadre + 6;
  }
  return document.terminer();
}
