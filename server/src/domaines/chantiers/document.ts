import type { Prisma } from '@prisma/client';
import { dateSeuleEnJourCivil } from '../../commun/dates';
import { nomFichierPdf, ouvrirDocumentPdf, type IdentiteImprimee } from '../documents/gabarit';
import { RAPPORTS_IMPRIMES, STATUT_INTERVENTION, rendreComptesRendus } from '../interventions/document';
import { jourCivilDeDebut } from './suivi';

// Rapport de chantier remis au client (lot 6a-4c), sur le modèle commun du lot 6a-1, avec l'identité
// actuelle de la société. Réponse de Nelson du 31-10-2026 : « il ne doit pas y avoir de montant ni de
// heures ». Ce qui est lu est ce qui s'imprime : cette sélection ne porte ni montant (vendu, budgets,
// coût prévu, achats, factures, marges, coûts), ni heures (vendues, réalisées, pointées, saisies sur
// les interventions), ni matériel, ni le commercial ou le conducteur du chantier, ni le motif d'une
// annulation ou d'une clôture. Les interventions imprimées sont celles rattachées au chantier, sauf
// les annulées, par date de la demande (une intervention sans date en dernier), puis date de création
// et identifiant ; de chacune, seuls la référence, le titre, la date de la demande, le statut et les
// comptes rendus, jamais la description, le site, le contact ni les intervenants (choix le plus
// restrictif, à confirmer).
export const CHANTIER_IMPRIME = {
  id: true, nom: true, numeroDevis: true, client: true, adresse: true, types: true, dateDebut: true, dateFin: true, statut: true,
  clientFiche: { select: { raisonSociale: true } },
  interventions: {
    where: { statut: { not: 'ANNULEE' } },
    orderBy: [{ dateDemande: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { reference: true, titre: true, dateDemande: true, statut: true, rapports: RAPPORTS_IMPRIMES },
  },
} satisfies Prisma.ChantierSelect;

export type ChantierImprime = Prisma.ChantierGetPayload<{ select: typeof CHANTIER_IMPRIME }>;

const STATUT_CHANTIER: Record<string, string> = { EN_COURS: 'en cours', TERMINE: 'terminé', ANNULE: 'annulé' };

// JJ-MM-AAAA d'un jour civil AAAA-MM-JJ.
const jourFrancais = (jour: string) => jour.split('-').reverse().join('-');

// Nom du fichier : `Rapport-chantier-<nom>.pdf`, le nom réduit comme l'intitulé d'un contrat
// (nomFichierPdf), ou `Rapport-chantier-<identifiant>.pdf` si rien n'en reste. Le même calcul nomme le
// fichier téléchargé à l'écran (client/src/lib/documentPdf.ts).
export function nomFichierRapportChantier(chantier: { id: string; nom: string }) {
  return nomFichierPdf('Rapport-chantier', chantier.nom, chantier.id);
}

export async function rendreRapportChantierPdf({ chantier, identite, fuseau }: {
  chantier: ChantierImprime;
  identite: IdentiteImprimee;
  fuseau: string;
}): Promise<Buffer> {
  const document = ouvrirDocumentPdf({ titre: `Rapport de chantier ${chantier.nom}`, identite });
  const { pdf, ligne, couleur } = document;

  pdf.fillColor(couleur);
  ligne('Rapport de chantier', { taille: 18 });
  pdf.fillColor('#000000');
  ligne(chantier.nom, { taille: 12 });
  // Comme un contrat annulé : imprimé sans le dire, un chantier annulé passerait pour un chantier en
  // cours. Le motif de l'annulation n'est pas lu.
  if (chantier.statut === 'ANNULE') { pdf.fillColor('#b91c1c'); ligne('CHANTIER ANNULÉ', { taille: 12 }); pdf.fillColor('#000000'); }
  pdf.moveDown();
  if (chantier.numeroDevis) ligne(`Référence de l'affaire : ${chantier.numeroDevis}`, { taille: 10 });
  // La fiche client liée, à défaut le libellé historique du chantier.
  ligne(`Client : ${chantier.clientFiche?.raisonSociale ?? chantier.client}`, { taille: 10 });
  if (chantier.adresse) ligne(`Adresse du chantier : ${chantier.adresse}`, { taille: 10 });
  if (chantier.types.length) ligne(`Nature des travaux : ${chantier.types.join(', ')}`, { taille: 10 });
  // Dates seules, stockées à minuit UTC, lues telles quelles comme à l'écran (jourCivilDeDebut, qui
  // ne relit au fuseau que le début d'un chantier converti avant #130, enregistré comme un instant).
  ligne(`Début : ${jourFrancais(jourCivilDeDebut(chantier.dateDebut, fuseau))}`, { taille: 10 });
  if (chantier.dateFin) ligne(`Fin : ${jourFrancais(jourCivilDeDebut(chantier.dateFin, fuseau))}`, { taille: 10 });
  // Le statut seul, sans avancement : les jauges de la fiche sont en montants ou en heures.
  ligne(`Statut : ${STATUT_CHANTIER[chantier.statut] ?? chantier.statut}`, { taille: 10 });

  pdf.moveDown();
  pdf.fillColor(couleur);
  ligne('Interventions', { taille: 13 });
  pdf.fillColor('#000000');
  if (!chantier.interventions.length) ligne('Aucune intervention rattachée.', { taille: 10 });
  for (const intervention of chantier.interventions) {
    pdf.moveDown();
    ligne(`Intervention ${intervention.reference}`, { taille: 12 });
    ligne(`Demande : ${intervention.titre}`, { taille: 11 });
    // Date seule, stockée à minuit UTC : elle se lit telle quelle, comme sur le PDF du compte rendu.
    if (intervention.dateDemande) ligne(`Date de la demande : ${jourFrancais(dateSeuleEnJourCivil(intervention.dateDemande))}`, { taille: 10 });
    ligne(`Statut : ${STATUT_INTERVENTION[intervention.statut] ?? intervention.statut}`, { taille: 10 });
    if (!intervention.rapports.length) ligne('Aucun compte rendu.', { taille: 10 });
    // Rendus exactement comme sur le PDF du compte rendu (lot 6a-4a), « Non signé par le client »
    // compris, jamais le motif d'une clôture sans signature.
    rendreComptesRendus({ pdf, ligne, rapports: intervention.rapports, statut: intervention.statut, fuseau });
  }
  return document.terminer();
}
