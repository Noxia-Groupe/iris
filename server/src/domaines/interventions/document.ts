import type { Prisma } from '@prisma/client';
import { dateSeuleEnJourCivil } from '../../commun/dates';
import { formaterAdresseFacturation } from '../factures/metier';
import { ouvrirDocumentPdf, type DocumentPdf, type IdentiteImprimee } from '../documents/gabarit';
import { traceSignatureValide, type TraceSignature } from './comptesRendus';
import { dateHeureFrancaiseEntreprise, jourFrancaisEntreprise } from './dateHeure';

// Comptes rendus d'une intervention tels qu'ils s'impriment, dans l'ordre de leur enregistrement :
// le texte, la date, l'auteur et la signature, rien d'autre. Sélection commune au PDF du compte rendu
// (lot 6a-4a) et au rapport de chantier remis au client (lot 6a-4c), qui la reprend telle quelle.
export const RAPPORTS_IMPRIMES = {
  select: {
    contenu: true, createdAt: true, auteur: { select: { name: true } },
    signature: { select: { signataire: true, accepteLe: true, trace: true, empreinte: true } },
  },
  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
} satisfies Prisma.Intervention$rapportsArgs;

export type RapportImprime = Prisma.InterventionRapportGetPayload<{ select: typeof RAPPORTS_IMPRIMES.select }>;

// Statut d'une intervention imprimé en toutes lettres : visites du PDF du contrat (lot 6a-4b) et
// interventions du rapport de chantier (lot 6a-4c).
export const STATUT_INTERVENTION: Record<string, string> = { A_PLANIFIER: 'à planifier', PLANIFIEE: 'planifiée', EN_COURS: 'en cours', TERMINEE: 'terminée', ANNULEE: 'annulée' };

// PDF du compte rendu d'intervention (lot 6a-4a), sur le modèle commun du lot 6a-1. Un seul PDF par
// intervention, avec tous ses comptes rendus, dans l'ordre de leur enregistrement. L'appelant fournit
// l'identité actuelle de la société et son fuseau (choix par défaut, à confirmer) : aucune identité
// n'est copiée à la signature d'un compte rendu, contrairement à un devis.
// Ce qui est lu est ce qui s'imprime : ni le motif d'une clôture sans signature, ni la marque « à
// suivre », ni les heures, le matériel, un montant ou un coût (choix par défaut, le plus restrictif,
// à confirmer), qui ne figurent donc pas dans cette sélection.
export const INTERVENTION_IMPRIMEE = {
  reference: true, titre: true, description: true, statut: true, dateDemande: true,
  client: { select: { raisonSociale: true } },
  site: { select: { nom: true, adresse: true, complementAdresse: true, codePostal: true, ville: true, pays: true } },
  // Le contact par son seul nom, sans téléphone ni courriel (choix le plus restrictif).
  contact: { select: { prenom: true, nom: true } },
  affectations: { select: { intervenant: { select: { nom: true } } } },
  rapports: RAPPORTS_IMPRIMES,
} satisfies Prisma.InterventionSelect;

export type InterventionImprimee = Prisma.InterventionGetPayload<{ select: typeof INTERVENTION_IMPRIMEE }>;

// Cadre du tracé : la hauteur visée, réduite si la largeur qu'elle donne au ratio du tracé dépasse
// la largeur maximale. Le dessin garde ainsi les proportions de la zone de signature.
const HAUTEUR_TRACE = 70;
const LARGEUR_TRACE_MAX = 220;
const cadreTrace = (trace: TraceSignature) => {
  const largeur = Math.min(LARGEUR_TRACE_MAX, trace.ratio * HAUTEUR_TRACE);
  return { largeur, hauteur: largeur / trace.ratio };
};
// Hauteur réservée, en plus du cadre, au signataire et à l'empreinte.
const HAUTEUR_TEXTE_SIGNATURE = 40;

// Reproduit le tracé en vectoriel : chaque trait relie ses points, coordonnées de 0 à 1 mises à
// l'échelle du cadre (même lecture que l'écran, l'ordonnée vers le bas). Un trait d'un seul point
// se dessine comme un très court segment, pour rester visible.
function dessinerTrace(pdf: PDFKit.PDFDocument, trace: TraceSignature) {
  const { largeur, hauteur } = cadreTrace(trace);
  // Un nom de signataire sur plusieurs lignes peut avoir consommé la place réservée : le cadre ne
  // déborde jamais sur le pied de page.
  if (pdf.y + hauteur + 10 > pdf.page.height - pdf.page.margins.bottom) pdf.addPage();
  const gauche = pdf.page.margins.left;
  const haut = pdf.y + 4;
  pdf.save();
  pdf.rect(gauche, haut, largeur, hauteur).lineWidth(0.5).strokeColor('#9ca3af').stroke();
  pdf.lineWidth(1.2).strokeColor('#111827').lineCap('round').lineJoin('round');
  for (const [premier, ...suite] of trace.traits) {
    const point = ([x, y]: number[]): [number, number] => [gauche + x * largeur, haut + y * hauteur];
    const [x0, y0] = point(premier);
    pdf.moveTo(x0, y0);
    if (!suite.length) pdf.lineTo(x0 + 0.1, y0);
    for (const suivant of suite) pdf.lineTo(...point(suivant));
    pdf.stroke();
  }
  pdf.restore();
  pdf.x = gauche;
  pdf.y = haut + hauteur + 6;
}

export async function rendreCompteRenduPdf({ intervention, identite, fuseau }: {
  intervention: InterventionImprimee;
  identite: IdentiteImprimee;
  fuseau: string;
}): Promise<Buffer> {
  const document = ouvrirDocumentPdf({ titre: `Compte rendu d'intervention ${intervention.reference}`, identite });
  const { pdf, ligne, couleur } = document;

  pdf.fillColor(couleur);
  ligne("Compte rendu d'intervention", { taille: 18 });
  pdf.fillColor('#000000');
  ligne(`Intervention ${intervention.reference}`, { taille: 12 });
  ligne(`Demande : ${intervention.titre}`, { taille: 11 });
  if (intervention.description) ligne(intervention.description, { taille: 10 });
  pdf.moveDown();
  ligne('Client', { taille: 11 });
  ligne(intervention.client.raisonSociale, { taille: 12 });
  if (intervention.site) {
    ligne(`Site : ${intervention.site.nom}`, { taille: 10 });
    ligne(formaterAdresseFacturation(intervention.site), { taille: 9 });
  }
  if (intervention.contact) ligne(`Contact : ${[intervention.contact.prenom, intervention.contact.nom].filter(Boolean).join(' ')}`, { taille: 10 });
  pdf.moveDown();
  const intervenants = intervention.affectations.map((affectation) => affectation.intervenant.nom).sort((a, b) => a.localeCompare(b, 'fr'));
  if (intervenants.length) ligne(`Intervenants : ${intervenants.join(', ')}`, { taille: 10 });
  // Date-seule, stockée à minuit UTC : elle se lit telle quelle, sans fuseau.
  if (intervention.dateDemande) ligne(`Date de la demande : ${dateSeuleEnJourCivil(intervention.dateDemande).split('-').reverse().join('-')}`, { taille: 10 });
  pdf.moveDown();

  pdf.fillColor(couleur);
  ligne('Comptes rendus', { taille: 13 });
  pdf.fillColor('#000000');
  rendreComptesRendus({ pdf, ligne, rapports: intervention.rapports, statut: intervention.statut, fuseau });
  return document.terminer();
}

// Comptes rendus d'une intervention, dans l'ordre reçu : date et heure au fuseau de la société,
// auteur, texte, et signature (signataire, date d'acceptation, tracé vectoriel, empreinte) ; puis,
// pour une intervention terminée dont aucun compte rendu n'est signé, « Non signé par le client ».
// Rendu commun au PDF du compte rendu (lot 6a-4a) et au rapport de chantier (lot 6a-4c) : chacun
// imprime son propre titre avant.
export function rendreComptesRendus({ pdf, ligne, rapports, statut, fuseau }: {
  pdf: PDFKit.PDFDocument;
  ligne: DocumentPdf['ligne'];
  rapports: RapportImprime[];
  statut: string;
  fuseau: string;
}): void {
  for (const rapport of rapports) {
    pdf.moveDown(0.5);
    pdf.font('Helvetica-Bold');
    ligne(`${dateHeureFrancaiseEntreprise(rapport.createdAt, fuseau)} — ${rapport.auteur.name}`, { taille: 10 });
    pdf.font('Helvetica');
    ligne(rapport.contenu, { taille: 10 });
    const signature = rapport.signature;
    if (signature) {
      // Le tracé est enregistré sous sa forme canonique (comptesRendus.ts) ; relu ici, un tracé que
      // l'API n'aurait pas accepté n'est pas dessiné, et le PDF le dit.
      const trace = traceSignatureValide(signature.trace);
      pdf.moveDown(0.3);
      // Le bloc de la signature (signataire, tracé, empreinte) tient sur la page, sinon il passe à la suivante.
      if (pdf.y + (trace ? cadreTrace(trace).hauteur : 0) + HAUTEUR_TEXTE_SIGNATURE > pdf.page.height - pdf.page.margins.bottom) pdf.addPage();
      ligne(`Signé par ${signature.signataire} le ${jourFrancaisEntreprise(signature.accepteLe, fuseau)}.`, { taille: 10 });
      if (trace) dessinerTrace(pdf, trace);
      else ligne('Tracé de la signature illisible.', { taille: 9 });
      ligne(`Empreinte de la signature (SHA-256) : ${signature.empreinte}`, { taille: 7 });
    }
  }
  // Au niveau de l'intervention, et non de chaque compte rendu ; le motif de la clôture sans
  // signature, texte libre du journal SAV, n'est pas imprimé.
  if (statut === 'TERMINEE' && !rapports.some((rapport) => rapport.signature)) {
    pdf.moveDown();
    ligne('Non signé par le client', { taille: 11 });
  }
}
