import type { Prisma } from '@prisma/client';
import { raisonSocialeActuelleImprimee } from './identite';

// Envoi d'un document par la messagerie de l'utilisateur, et journal des envois (lot 6a-3).
//
// Décision de Nelson du 22-10-2026 : tant que Microsoft 365 n'est pas prêt (lot 6b), la messagerie
// de l'utilisateur s'ouvre avec le destinataire, l'objet et le texte remplis (lien mailto) ; un tel
// lien ne joint aucun fichier : le PDF est téléchargé en même temps et joint à la main. Iris ne
// sait donc pas si le courriel part : le journal dit qu'un envoi a été préparé, à qui, sous quel
// objet et par quel compte (choix par défaut, à confirmer). Il est en ajout seul, garanti en base
// (migration 20261023120000).
//
// Documents concernés : ceux qui ont déjà leur PDF, le devis (lot 6a-2) et la facture ou l'avoir
// émis (lot 6a-1). Les autres documents viendront avec le lot 6a-4.

export const CANAL_MESSAGERIE = 'MESSAGERIE';

export class DestinataireInvalideError extends Error {
  constructor() {
    super('Adresse du destinataire invalide : indiquez une seule adresse électronique, de la forme nom@domaine.fr.');
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

// Objet et texte du courriel (choix par défaut, à confirmer) : aucune mention légale ajoutée, le
// document joint porte les siennes. La raison sociale est celle que le PDF imprime.
type DocumentEnvoye = { nature: 'DEVIS'; numero: string; version: number } | { nature: 'FACTURE' | 'AVOIR'; numero: string };
export function texteEnvoi(document: DocumentEnvoye, raisonSociale: string): { objet: string; corps: string } {
  const designation = document.nature === 'DEVIS' ? `Devis ${document.numero} version ${document.version}`
    : `${document.nature === 'AVOIR' ? 'Avoir' : 'Facture'} ${document.numero}`;
  const joint = document.nature === 'DEVIS' ? `notre devis ${document.numero} (version ${document.version})`
    : `${document.nature === 'AVOIR' ? 'notre avoir' : 'notre facture'} ${document.numero}`;
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

// Une pièce émise s'imprime depuis son identité figée ; une pièce émise avant le lot 6a-1, qui n'en a
// pas, prend l'identité actuelle (sans objet tant qu'aucune donnée réelle n'existe).
export async function texteEnvoiFacture(db: Prisma.TransactionClient, facture: FactureAEnvoyer) {
  const avoir = facture.type === 'AVOIR';
  const raisonSociale = facture.identiteEmetteur?.raisonSociale ?? await raisonSocialeActuelleImprimee(db, avoir ? 'd’envoyer un avoir' : 'd’envoyer une facture');
  return texteEnvoi({ nature: avoir ? 'AVOIR' : 'FACTURE', numero: facture.numero ?? '' }, raisonSociale);
}

// Un envoi exposé : ni l'identifiant du compte ni le document, que l'écran connaît déjà.
const ENVOI_EXPOSE = { id: true, canal: true, destinataire: true, objet: true, auteurNom: true, createdAt: true } as const;
type DocumentDuJournal = { devisId: string } | { factureId: string };

// Envois d'un document, du plus récent au plus ancien.
export function lireEnvois(db: Prisma.TransactionClient, document: DocumentDuJournal) {
  return db.envoiDocument.findMany({ where: document, select: ENVOI_EXPOSE, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
}

// Enregistre l'envoi préparé, au nom du compte de la session. Son nom est copié : à défaut de nom,
// son adresse, pour que le journal nomme toujours son auteur. L'horodatage est celui de la base.
export async function enregistrerEnvoi(db: Prisma.TransactionClient, document: DocumentDuJournal, envoi: { destinataire: string; objet: string }, auteur: { id: string; name: string }) {
  const compte = auteur.name.trim() ? null : await db.user.findUnique({ where: { id: auteur.id }, select: { email: true } });
  const auteurNom = auteur.name.trim() || compte?.email || auteur.id;
  return db.envoiDocument.create({
    data: { ...document, canal: CANAL_MESSAGERIE, destinataire: envoi.destinataire, objet: envoi.objet, auteurId: auteur.id, auteurNom },
    select: ENVOI_EXPOSE,
  });
}
