import { createHash, randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';

// Identité de l'émetteur copiée et figée à l'émission d'une pièce (décision 6 de la proposition de
// paramétrage, lot 6a-1). Champs exigés pour émettre : choix par défaut, à confirmer par le
// cabinet, qui confirmera aussi les champs imprimés.
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
  constructor(readonly manquants: string[]) {
    super(`Identité de la société incomplète : renseignez ${manquants.join(', ')} dans l’écran Société avant d’émettre.`);
  }
}

// Lit l'identité de la société dans la transaction de l'émission et retourne la ligne figée qui la
// porte : celle qui existe déjà pour un contenu identique, ou une nouvelle. Deux émissions
// simultanées d'une même identité nouvelle se rejoignent sur l'index unique de l'empreinte : la
// seconde attend la première, puis relit sa ligne.
export async function figerIdentiteEmetteur(tx: Prisma.TransactionClient): Promise<string> {
  // Verrou partagé sur la société : un changement d'identité ou de logo (verrou exclusif de
  // verrouillerReglage) attend la fin de l'émission, et l'émission lit un état déjà validé. Un
  // logo remplacé n'est ainsi jamais supprimé entre sa lecture ici et la copie qui le référence.
  await tx.$queryRaw`SELECT 1 FROM "CompanySettings" WHERE "id" = 'singleton' FOR SHARE`;
  const societe = await tx.companySettings.findUnique({ where: { id: 'singleton' } });
  const manquants = champsIdentiteManquants(societe);
  if (!societe || manquants.length) throw new IdentiteEmetteurIncompleteError(manquants.length ? manquants : CHAMPS_IDENTITE_OBLIGATOIRES.map(([, libelle]) => libelle));
  const couleur = (societe.couleurPrimaire || '').toLowerCase();
  const copie = {
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
  // L'ordre des clés est celui de l'objet ci-dessus : l'empreinte ne dépend que du contenu.
  const empreinte = createHash('sha256').update(JSON.stringify(Object.entries(copie))).digest('hex');
  await tx.$executeRaw`INSERT INTO "IdentiteEmetteur" ("id", "empreinte", "raisonSociale", "nomCommercial", "siret", "tvaIntra", "adresse", "codePostal", "ville", "pays", "telephone", "email", "siteWeb", "piedDocument", "couleurPrimaire", "logoId")
    VALUES (${randomUUID()}, ${empreinte}, ${copie.raisonSociale}, ${copie.nomCommercial}, ${copie.siret}, ${copie.tvaIntra}, ${copie.adresse}, ${copie.codePostal}, ${copie.ville}, ${copie.pays}, ${copie.telephone}, ${copie.email}, ${copie.siteWeb}, ${copie.piedDocument}, ${copie.couleurPrimaire}, ${copie.logoId})
    ON CONFLICT ("empreinte") DO NOTHING`;
  const ligne = await tx.identiteEmetteur.findUniqueOrThrow({ where: { empreinte }, select: { id: true } });
  return ligne.id;
}
