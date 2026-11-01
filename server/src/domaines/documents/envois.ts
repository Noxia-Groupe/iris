import type { Response } from 'express';
import type { Prisma } from '@prisma/client';
import { transactionVerifiee } from '../../db';
import { raisonSocialeActuelleImprimee } from './identite';
import type { PdfProduit, RefusPdf } from './productionPdf';

// Envoi d'un document et journal des envois (lots 6a-3, 6a-4d, 6a-4e et 6b-1b), par l'un de deux
// canaux, que la requête d'envoi choisit (`canal`) :
//
// - MESSAGERIE (absent ou MESSAGERIE). Décision de Nelson du 22-10-2026 : la messagerie de
//   l'utilisateur s'ouvre avec le destinataire, l'objet et le texte remplis (lien mailto) ; un tel lien
//   ne joint aucun fichier : le PDF est téléchargé en même temps et joint à la main. Iris ne sait donc
//   pas si le courriel part : le journal dit qu'un envoi a été préparé, à qui, sous quel objet et par
//   quel compte (choix par défaut, à confirmer). C'est le repli décidé (« un replit du style mailto ») :
//   il reste toujours disponible, quel que soit le mode d'envoi (lecture retenue, à confirmer).
// - MICROSOFT_365 (lot 6b-1b, ./envoiMicrosoft365.ts) : Iris produit le PDF et envoie le courriel depuis
//   la boîte Microsoft de l'utilisateur, avec son jeton délégué (en-tête X-Jeton-Microsoft, jamais
//   gardé), puis note l'envoi avec l'expéditeur, l'empreinte du PDF et le texte envoyé.
//
// Le journal est en ajout seul, garanti en base (migration 20261023120000). Les deux canaux partagent
// la préparation de chaque document : verrous, relectures et refus de l'envoi (introuvable, annulé,
// refus propres au document, identité de la société incomplète), puis objet et texte ; seule la suite
// diffère. Une même permission couvre les deux canaux : les gardes de chaque route ne changent pas.
//
// Documents concernés : ceux qui ont leur PDF. Le devis (lot 6a-2) et la facture ou l'avoir émis
// (lot 6a-1), depuis le lot 6a-3 ; le compte rendu d'une intervention (lot 6a-4a) et le contrat de
// maintenance (lot 6a-4b), depuis le lot 6a-4d (migration 20261031120000) ; le rapport de chantier
// remis au client, sans montant ni heures (lot 6a-4c), depuis le lot 6a-4e (migration 20261031200000).
// Microsoft 365 les envoie tous depuis le lot 6b-1b (migration 20261101120000).

export const CANAL_MESSAGERIE = 'MESSAGERIE';
export const CANAL_MICROSOFT_365 = 'MICROSOFT_365';
export type CanalEnvoi = typeof CANAL_MESSAGERIE | typeof CANAL_MICROSOFT_365;

// Refus de la saisie d'un envoi (400) : destinataire invalide, ou canal inconnu.
export class SaisieEnvoiInvalideError extends Error {}

export class DestinataireInvalideError extends SaisieEnvoiInvalideError {
  constructor() {
    super('Adresse du destinataire invalide : indiquez une seule adresse électronique, de la forme nom@domaine.fr.');
  }
}

export class CanalInconnuError extends SaisieEnvoiInvalideError {
  constructor() {
    super('Canal d’envoi inconnu.');
  }
}

// Une seule adresse, de la forme x@y.z, de 254 caractères au plus (longueur maximale d'une adresse
// utilisable, RFC 5321), sans espace (même insécable), virgule, point-virgule, chevron ni caractère
// de contrôle : le lien mailto ne doit viser personne d'autre que le destinataire affiché. Les blancs
// qui l'entourent, fréquents dans un copier-coller, sont retirés.
const LONGUEUR_MAX_DESTINATAIRE = 254;
const FORME_ADRESSE = /^[^@]+@[^@]+\.[^@]+$/;
const CARACTERES_REFUSES = /[\s,;<>\u0000-\u001f\u007f-\u009f]/;

export function validerDestinataire(valeur: unknown): string {
  const adresse = typeof valeur === 'string' ? valeur.trim() : '';
  if (!adresse || adresse.length > LONGUEUR_MAX_DESTINATAIRE || CARACTERES_REFUSES.test(adresse) || !FORME_ADRESSE.test(adresse)) {
    throw new DestinataireInvalideError();
  }
  return adresse;
}

// Canal de l'envoi : absent ou MESSAGERIE, la messagerie, comme avant le lot 6b-1b ; MICROSOFT_365 ;
// toute autre valeur, null compris, est refusée (400).
export function lireCanal(valeur: unknown): CanalEnvoi {
  if (valeur === undefined || valeur === CANAL_MESSAGERIE) return CANAL_MESSAGERIE;
  if (valeur === CANAL_MICROSOFT_365) return CANAL_MICROSOFT_365;
  throw new CanalInconnuError();
}

// Saisie d'un envoi : le destinataire, puis le canal (refus 400, avant tout accès à la base).
export function lireDemandeEnvoi(corps: { destinataire?: unknown; canal?: unknown } | undefined) {
  const destinataire = validerDestinataire(corps?.destinataire);
  return { destinataire, canal: lireCanal(corps?.canal) };
}

// Destinataire proposé (modifiable à l'écran) : le courriel du contact principal du client s'il en a
// un, sinon celui de la fiche client, sinon rien. Un contact principal sans courriel laisse la place
// à celui de la fiche client.
export async function propositionDestinataire(db: Prisma.TransactionClient, clientId: string): Promise<string> {
  const client = await db.client.findUnique({
    where: { id: clientId },
    select: { email: true, contacts: { where: { principal: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { email: true } } },
  });
  const courrielContact = client?.contacts.map((contact) => contact.email?.trim() ?? '').find(Boolean);
  return courrielContact || client?.email?.trim() || '';
}

// Objet et texte du courriel : ceux du devis, de la facture et de l'avoir ont été validés par Nelson
// le 23-10-2026 (lot 6a-3 bis) ; ceux du compte rendu et du contrat (lot 6a-4d), et du rapport de
// chantier (lot 6a-4e), sont des choix par défaut, à confirmer. Aucune mention légale ajoutée, le
// document joint porte les siennes. La raison sociale est celle que le PDF imprime, sauf pour une
// pièce émise avant le lot 6a-1 (texteEnvoiFacture).
type DocumentEnvoye = { nature: 'DEVIS'; numero: string; version: number } | { nature: 'FACTURE' | 'AVOIR'; numero: string }
  | { nature: 'COMPTE_RENDU'; reference: string } | { nature: 'CONTRAT'; intitule: string } | { nature: 'RAPPORT_CHANTIER'; nom: string };
function designations(document: DocumentEnvoye): { designation: string; joint: string } {
  switch (document.nature) {
    case 'DEVIS': return { designation: `Devis ${document.numero} version ${document.version}`, joint: `notre devis ${document.numero} (version ${document.version})` };
    case 'FACTURE': return { designation: `Facture ${document.numero}`, joint: `notre facture ${document.numero}` };
    case 'AVOIR': return { designation: `Avoir ${document.numero}`, joint: `notre avoir ${document.numero}` };
    case 'COMPTE_RENDU': return { designation: `Compte rendu d’intervention ${document.reference}`, joint: `le compte rendu de l’intervention ${document.reference}` };
    case 'CONTRAT': return { designation: `Contrat de maintenance ${document.intitule}`, joint: `le récapitulatif de votre contrat de maintenance ${document.intitule}` };
    case 'RAPPORT_CHANTIER': return { designation: `Rapport de chantier ${document.nom}`, joint: `le rapport de chantier ${document.nom}` };
  }
}
export function texteEnvoi(document: DocumentEnvoye, raisonSociale: string): { objet: string; corps: string } {
  const { designation, joint } = designations(document);
  return {
    objet: `${designation} – ${raisonSociale}`,
    corps: `Bonjour,\n\nVeuillez trouver ci-joint ${joint}.\n\nCordialement,\n${raisonSociale}`,
  };
}

// Lecture d'un devis à envoyer : la raison sociale copiée à sa signature (lot 6a-2), s'il en a une.
export const DEVIS_A_ENVOYER = { signature: { select: { identiteEmetteur: { select: { raisonSociale: true } } } } } as const;
type DevisAEnvoyer = { numero: string; version: number; signature: { identiteEmetteur: { raisonSociale: string } | null } | null };

// Un devis signé s'imprime depuis l'identité copiée à sa signature ; un devis non signé, ou signé
// avant le lot 6a-2, depuis l'identité actuelle, refusée si elle est incomplète, comme son PDF.
export async function texteEnvoiDevis(db: Prisma.TransactionClient, devis: DevisAEnvoyer) {
  const raisonSociale = devis.signature?.identiteEmetteur?.raisonSociale ?? await raisonSocialeActuelleImprimee(db, 'd’envoyer un devis');
  return texteEnvoi({ nature: 'DEVIS', numero: devis.numero, version: devis.version }, raisonSociale);
}

// Lecture d'une pièce à envoyer : les champs des refus de son document, son type, son numéro et
// l'identité de l'émetteur figée à son émission (lot 6a-1).
export const FACTURE_A_ENVOYER = {
  id: true, type: true, numero: true, statut: true, clientId: true, clientAdresse: true,
  mentionsLegalesVersion: { select: { id: true } }, identiteEmetteur: { select: { raisonSociale: true } },
} as const;
type FactureAEnvoyer = { type: string; numero: string | null; identiteEmetteur: { raisonSociale: string } | null };

// Une pièce émise s'imprime depuis son identité figée. Une pièce émise avant le lot 6a-1 n'en a pas :
// son PDF tire l'émetteur des mentions légales figées, mais l'objet et le texte prennent l'identité
// actuelle, refusée si elle est incomplète (sans objet tant qu'aucune donnée réelle n'existe).
export async function texteEnvoiFacture(db: Prisma.TransactionClient, facture: FactureAEnvoyer) {
  const avoir = facture.type === 'AVOIR';
  const raisonSociale = facture.identiteEmetteur?.raisonSociale ?? await raisonSocialeActuelleImprimee(db, avoir ? 'd’envoyer un avoir' : 'd’envoyer une facture');
  return texteEnvoi({ nature: avoir ? 'AVOIR' : 'FACTURE', numero: facture.numero ?? '' }, raisonSociale);
}

// Le compte rendu d'une intervention et le contrat de maintenance s'impriment avec l'identité actuelle
// de la société (lots 6a-4a et 6a-4b) : l'objet et le texte de leur envoi aussi, refusés comme leur
// PDF si elle est incomplète (lot 6a-4d).
export async function texteEnvoiCompteRendu(db: Prisma.TransactionClient, intervention: { reference: string }) {
  const raisonSociale = await raisonSocialeActuelleImprimee(db, 'd’envoyer un compte rendu');
  return texteEnvoi({ nature: 'COMPTE_RENDU', reference: intervention.reference }, raisonSociale);
}

export async function texteEnvoiContrat(db: Prisma.TransactionClient, contrat: { titre: string }) {
  const raisonSociale = await raisonSocialeActuelleImprimee(db, 'd’envoyer un contrat');
  return texteEnvoi({ nature: 'CONTRAT', intitule: contrat.titre }, raisonSociale);
}

// Le rapport de chantier remis au client s'imprime lui aussi avec l'identité actuelle (lot 6a-4c) :
// l'objet et le texte de son envoi aussi, refusés comme son PDF si elle est incomplète (lot 6a-4e). La
// désignation est le titre du PDF, avec le nom du chantier qu'il imprime ; ni montant ni heures.
export async function texteEnvoiRapportChantier(db: Prisma.TransactionClient, chantier: { nom: string }) {
  const raisonSociale = await raisonSocialeActuelleImprimee(db, 'd’envoyer un rapport de chantier');
  return texteEnvoi({ nature: 'RAPPORT_CHANTIER', nom: chantier.nom }, raisonSociale);
}

// Un envoi exposé : ni l'identifiant du compte ni le document, que l'écran connaît déjà. L'expéditeur
// (la boîte Microsoft d'un envoi par Microsoft 365, null pour la messagerie) s'y ajoute depuis le lot
// 6b-1b ; ni l'empreinte du PDF ni le texte envoyé ne sont exposés.
const ENVOI_EXPOSE = { id: true, canal: true, destinataire: true, objet: true, expediteur: true, auteurNom: true, createdAt: true } as const;
// Document d'un envoi : un devis, une facture (avoir compris), une intervention (son compte rendu), un
// contrat de maintenance ou un chantier (son rapport remis au client) ; la base en exige exactement un
// (contrainte EnvoiDocument_un_document).
export type DocumentDuJournal = { devisId: string } | { factureId: string } | { interventionId: string } | { contratMaintenanceId: string } | { chantierId: string };

// Envois d'un document, du plus récent au plus ancien.
export function lireEnvois(db: Prisma.TransactionClient, document: DocumentDuJournal) {
  return db.envoiDocument.findMany({ where: document, select: ENVOI_EXPOSE, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
}

// Ce qu'un envoi par Microsoft 365 note en plus (lot 6b-1b) : l'identifiant de la ligne, généré avant
// l'envoi et porté par l'en-tête x-iris-envoi du courriel, l'expéditeur, l'empreinte du PDF et le texte.
export type NoteMicrosoft365 = { id: string; expediteur: string; empreintePdf: string; corps: string };

// Enregistre l'envoi, au nom du compte de la session : préparé par la messagerie, ou fait par
// Microsoft 365 avec sa note. Son nom est copié : à défaut de nom, son adresse, pour que le journal
// nomme toujours son auteur. L'horodatage est celui de la base.
export async function enregistrerEnvoi(
  db: Prisma.TransactionClient, document: DocumentDuJournal, envoi: { destinataire: string; objet: string }, auteur: { id: string; name: string },
  microsoft365?: NoteMicrosoft365,
) {
  const compte = auteur.name.trim() ? null : await db.user.findUnique({ where: { id: auteur.id }, select: { email: true } });
  const auteurNom = auteur.name.trim() || compte?.email || auteur.id;
  const canal = microsoft365 ? { canal: CANAL_MICROSOFT_365, ...microsoft365 } : { canal: CANAL_MESSAGERIE };
  return db.envoiDocument.create({
    data: { ...document, ...canal, destinataire: envoi.destinataire, objet: envoi.objet, auteurId: auteur.id, auteurNom },
    select: ENVOI_EXPOSE,
  });
}

// --- Envoi commun aux deux canaux (lot 6b-1b) ---
//
// Chaque document décrit son envoi (DocumentAEnvoyer) :
// - preparer : dans la transaction de l'envoi, les verrous, les relectures et les refus de l'envoi
//   par la messagerie, dans leur ordre (introuvable ou hors périmètre, 404 ; annulé, 409 ; refus
//   propres au document, 409), puis l'objet et le texte, qui exigent l'identité de la société (409,
//   IdentiteEmetteurIncompleteError, que la route traduit). Rien n'y est écrit ;
// - lirePdf et rendrePdf : la lecture et le rendu du PDF du lot 6b-1a, pour Microsoft 365 seulement ;
// - completer (facultatif) : dans la transaction qui note l'envoi, avant la ligne du journal, ce que
//   le document y ajoute ; pour un devis, son passage « envoyé » s'il est encore brouillon.
export type RefusEnvoi = { statut: number; error: string };
export const refusEnvoi = (statut: number, error: string): RefusEnvoi => ({ statut, error });
export const estRefusEnvoi = <T extends object>(valeur: T | RefusEnvoi): valeur is RefusEnvoi => 'error' in valeur;

export type EnvoiPrepare = { journal: DocumentDuJournal; objet: string; corps: string };
export type DocumentAEnvoyer<P extends EnvoiPrepare, L> = {
  preparer: (tx: Prisma.TransactionClient) => Promise<P | RefusEnvoi>;
  lirePdf: (tx: Prisma.TransactionClient, prepare: P) => Promise<L | RefusPdf>;
  rendrePdf: (lu: L) => Promise<PdfProduit>;
  completer?: (tx: Prisma.TransactionClient, prepare: P) => Promise<Record<string, unknown>>;
};

// Issue d'un envoi : le refus, avec son statut et son message exacts, ou la réponse 201.
export type IssueEnvoi = RefusEnvoi | { statut: 201; reponse: Record<string, unknown> };

export function repondreEnvoi(res: Response, issue: IssueEnvoi): void {
  res.status(issue.statut).json('error' in issue ? { error: issue.error } : issue.reponse);
}

// Envoi préparé par la messagerie : la préparation, puis ce que le document y ajoute et la ligne du
// journal, dans une seule transaction, à l'isolement par défaut de la base, comme avant le lot 6b-1b.
// Un refus n'écrit rien. Réponse : la ligne, l'objet et le texte, et ce que le document y ajoute
// (devis : son statut après l'envoi).
export async function envoyerParMessagerie<P extends EnvoiPrepare, L>(
  auteur: { id: string; name: string }, destinataire: string, document: DocumentAEnvoyer<P, L>,
): Promise<IssueEnvoi> {
  return transactionVerifiee(async (tx) => {
    const prepare = await document.preparer(tx);
    if (estRefusEnvoi(prepare)) return prepare;
    const complement = await document.completer?.(tx, prepare);
    const envoi = await enregistrerEnvoi(tx, prepare.journal, { destinataire, objet: prepare.objet }, auteur);
    return { statut: 201 as const, reponse: { envoi, objet: prepare.objet, corps: prepare.corps, ...complement } };
  });
}
