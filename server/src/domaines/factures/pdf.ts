import { formatMontantFacture, formatDateFacture, ventilationFacture } from './metier';
import { ligneColonnes, ouvrirDocumentPdf, replierTexte, type IdentiteImprimee } from '../documents/gabarit';

// Une facture émise s'imprime uniquement depuis ses copies figées : client, mentions légales et,
// depuis le lot 6a-1, identité de l'émetteur avec son logo, sa couleur et son pied de page. Aucun
// paramètre vivant n'est lu. Une pièce émise avant ce lot n'a pas d'identité figée : son émetteur
// reste celui du texte des mentions légales figées, comme à l'origine.
export async function rendreDocumentFacturePdf(facture: any): Promise<Buffer> {
  const identite: IdentiteImprimee | null = facture.identiteEmetteur ?? null;
  const document = ouvrirDocumentPdf({ titre: `Facture ${facture.numero}`, identite });
  const { pdf, ligne, couleur } = document;
  const legal = facture.mentionsLegalesVersion;
  const colonnes = (...cellules: string[]) => ligneColonnes(cellules, [38, 9, 16, 8, 16]);

  pdf.fillColor(couleur);
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
  if (!identite) {
    ligne('Émetteur', { taille: 11 });
    ligne(legal.mentions, { taille: 9 });
    pdf.moveDown();
  }
  ligne('Client', { taille: 11 });
  ligne(facture.clientRaisonSociale, { taille: 12 });
  ligne(facture.clientAdresse, { taille: 9 });
  pdf.moveDown();
  pdf.font('Courier');
  ligne(colonnes('Désignation', 'Qté', 'PU HT', 'TVA', 'Total HT'), { taille: 9 });
  for (const item of facture.lignes) {
    const [premiere, ...suite] = replierTexte(String(item.designation), 36);
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
  // Avec l'identité figée en en-tête, le texte des mentions garde les autres mentions (décision 6).
  if (identite) ligne(legal.mentions, { taille: 8 });
  ligne(legal.cgv, { taille: 8 });
  ligne(`Pénalités : ${legal.penalites}`, { taille: 8 });
  if (legal.escompte) ligne(`Escompte : ${legal.escompte}`, { taille: 8 });
  return document.terminer();
}
