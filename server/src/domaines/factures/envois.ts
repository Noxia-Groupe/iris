import type { Prisma } from '@prisma/client';
import { FACTURE_A_ENVOYER, refusEnvoi, texteEnvoiFacture } from '../documents/envois';
import { refusDocumentFacture } from './metier';
import { lireFacturePdf, rendreFichierFacturePdf } from './productionPdf';

// Envoi d'une facture ou d'un avoir émis (lot 6a-3 ; Microsoft 365 depuis le lot 6b-1b, cf.
// documents/envois.ts et documents/envoiMicrosoft365.ts), commun aux deux canaux. Route dans
// ./routes.ts (POST /api/factures/:id/envois).

// Préparation, sous un verrou partagé de la pièce : une annulation ou un avoir en cours est attendu,
// et l'envoi lit la pièce validée. Refus comme son PDF : 404 « Facture introuvable. » ; 409 avec le
// message de refusDocumentFacture (pièce non émise, mentions légales ou adresse de facturation figées
// absentes). L'objet et le texte prennent l'identité figée à l'émission (409 pour une pièce émise avant
// le lot 6a-1 si l'identité actuelle est incomplète).
export async function preparerEnvoiFacture(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "Facture" WHERE "id" = ${id} FOR SHARE`;
  const facture = await tx.facture.findUnique({ where: { id }, select: FACTURE_A_ENVOYER });
  if (!facture) return refusEnvoi(404, 'Facture introuvable.');
  const refus = refusDocumentFacture(facture);
  if (refus) return refusEnvoi(409, refus);
  const { objet, corps } = await texteEnvoiFacture(tx, facture);
  return { journal: { factureId: facture.id }, objet, corps };
}

// Le PDF envoyé par Microsoft 365 est celui de la route « PDF » : la pièce imprimée depuis ses seules
// copies figées (./productionPdf.ts).
export const envoiFacture = (id: string) => ({
  preparer: (tx: Prisma.TransactionClient) => preparerEnvoiFacture(tx, id),
  lirePdf: (tx: Prisma.TransactionClient) => lireFacturePdf(tx, id),
  rendrePdf: rendreFichierFacturePdf,
});
