import { createHash, randomUUID } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { IdentiteImprimee } from './gabarit';

// Identité de l'émetteur copiée et figée à l'émission d'une pièce (décision 6 de la proposition de
// paramétrage, lot 6a-1) et à la signature d'un devis (lot 6a-2). Champs exigés pour émettre :
// choix par défaut, à confirmer par le cabinet, qui confirmera aussi les champs imprimés.
export const CHAMPS_IDENTITE_OBLIGATOIRES = [
  ['raisonSociale', 'raison sociale'],
  ['siret', 'SIRET'],
  ['adresse', 'adresse'],
  ['codePostal', 'code postal'],
  ['ville', 'ville'],
] as const;

export const COULEUR_DOCUMENT_PAR_DEFAUT = '#1e3a8a';

type SocieteLue = {
  raisonSociale: string | null; nomCommercial: string | null; siret: string | null; tvaIntra: string | null;
  adresse: string | null; codePostal: string | null; ville: string | null; pays: string | null;
  telephone: string | null; email: string | null; siteWeb: string | null; piedFacture: string | null;
  couleurPrimaire: string | null; logoDocumentId: string | null;
};

const texte = (valeur: string | null | undefined) => (typeof valeur === 'string' && valeur.trim() ? valeur.trim() : null);

export function champsIdentiteManquants(societe: Partial<SocieteLue> | null | undefined): string[] {
  return CHAMPS_IDENTITE_OBLIGATOIRES.filter(([cle]) => !texte(societe?.[cle])).map(([, libelle]) => libelle);
}

export class IdentiteEmetteurIncompleteError extends Error {
  // `avant` complète le message : « d’émettre » une pièce, « d’imprimer un devis »…
  constructor(readonly manquants: string[], avant = 'd’émettre') {
    super(`Identité de la société incomplète : renseignez ${manquants.join(', ')} dans l’écran Société avant ${avant}.`);
  }
}

// Copie normalisée de l'identité de la société, telle qu'une pièce la fige et qu'un document
// l'imprime. Refusée si un champ exigé manque.
function copieIdentite(societe: SocieteLue | null, avant?: string) {
  const manquants = champsIdentiteManquants(societe);
  if (!societe || manquants.length) throw new IdentiteEmetteurIncompleteError(manquants.length ? manquants : CHAMPS_IDENTITE_OBLIGATOIRES.map(([, libelle]) => libelle), avant);
  const couleur = (societe.couleurPrimaire || '').toLowerCase();
  return {
    raisonSociale: texte(societe.raisonSociale)!,
    nomCommercial: texte(societe.nomCommercial),
    siret: texte(societe.siret)!,
    tvaIntra: texte(societe.tvaIntra),
    adresse: texte(societe.adresse)!,
    codePostal: texte(societe.codePostal)!,
    ville: texte(societe.ville)!,
    pays: texte(societe.pays),
    telephone: texte(societe.telephone),
    email: texte(societe.email),
    siteWeb: texte(societe.siteWeb),
    piedDocument: texte(societe.piedFacture),
    couleurPrimaire: /^#[0-9a-f]{6}$/.test(couleur) ? couleur : COULEUR_DOCUMENT_PAR_DEFAUT,
    logoId: societe.logoDocumentId ?? null,
  };
}

// Identité actuelle, à imprimer sur un document qui n'est pas encore figé (devis non signé,
// lot 6a-2) : mêmes champs exigés et même normalisation que la copie figée, logo compris.
export async function identiteActuelleImprimee(db: Prisma.TransactionClient | PrismaClient, avant: string): Promise<IdentiteImprimee> {
  const societe = await db.companySettings.findUnique({ where: { id: 'singleton' }, include: { logoDocument: { select: { contenu: true } } } });
  const { logoId: _logo, ...copie } = copieIdentite(societe, avant);
  return { ...copie, logo: societe?.logoDocument ? { contenu: societe.logoDocument.contenu } : null };
}

// Lit l'identité de la société dans la transaction de l'émission et retourne la ligne figée qui la
// porte : celle qui existe déjà pour un contenu identique, ou une nouvelle. Deux émissions
// simultanées d'une même identité nouvelle se rejoignent sur l'index unique de l'empreinte : la
// seconde attend la première, puis relit sa ligne.
export async function figerIdentiteEmetteur(tx: Prisma.TransactionClient, avant?: string): Promise<string> {
  // Verrou partagé sur la société : un changement d'identité ou de logo (verrou exclusif de
  // verrouillerReglage) attend la fin de l'émission, et l'émission lit un état déjà validé. Un
  // logo remplacé n'est ainsi jamais supprimé entre sa lecture ici et la copie qui le référence.
  await tx.$queryRaw`SELECT 1 FROM "CompanySettings" WHERE "id" = 'singleton' FOR SHARE`;
  const copie = copieIdentite(await tx.companySettings.findUnique({ where: { id: 'singleton' } }), avant);
  // L'ordre des clés est celui de l'objet de copieIdentite : l'empreinte ne dépend que du contenu.
  const empreinte = createHash('sha256').update(JSON.stringify(Object.entries(copie))).digest('hex');
  await tx.$executeRaw`INSERT INTO "IdentiteEmetteur" ("id", "empreinte", "raisonSociale", "nomCommercial", "siret", "tvaIntra", "adresse", "codePostal", "ville", "pays", "telephone", "email", "siteWeb", "piedDocument", "couleurPrimaire", "logoId")
    VALUES (${randomUUID()}, ${empreinte}, ${copie.raisonSociale}, ${copie.nomCommercial}, ${copie.siret}, ${copie.tvaIntra}, ${copie.adresse}, ${copie.codePostal}, ${copie.ville}, ${copie.pays}, ${copie.telephone}, ${copie.email}, ${copie.siteWeb}, ${copie.piedDocument}, ${copie.couleurPrimaire}, ${copie.logoId})
    ON CONFLICT ("empreinte") DO NOTHING`;
  const ligne = await tx.identiteEmetteur.findUniqueOrThrow({ where: { empreinte }, select: { id: true } });
  return ligne.id;
}
