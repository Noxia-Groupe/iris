import type { Prisma } from '@prisma/client';
import { refusEnvoi, texteEnvoiContrat } from '../documents/envois';
import { lireContratPdf, rendreFichierContratPdf } from './productionPdf';

// Envoi du contrat de maintenance (lot 6a-4d ; Microsoft 365 depuis le lot 6b-1b, cf.
// documents/envois.ts et documents/envoiMicrosoft365.ts), commun aux deux canaux. Route dans
// ./routes.ts (envoyerContrat).

// Préparation, sous un verrou partagé du contrat, pris par une requête directe :
// verrouillerContratMaintenance prend un verrou exclusif, dont un envoi n'a pas besoin. Une annulation
// en cours est attendue, puis refuse l'envoi (409, comme un devis annulé ; choix par défaut, à
// confirmer) ; son PDF reste disponible. Un contrat suspendu ou terminé s'envoie, avec le statut que
// son PDF imprime. Rien n'y est écrit.
export async function preparerEnvoiContrat(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "ContratMaintenance" WHERE "id" = ${id} FOR SHARE`;
  const contrat = await tx.contratMaintenance.findUnique({ where: { id }, select: { id: true, titre: true, statut: true } });
  if (!contrat) return refusEnvoi(404, 'Contrat de maintenance introuvable.');
  if (contrat.statut === 'ANNULE') return refusEnvoi(409, 'Un contrat annulé ne s’envoie pas.');
  const { objet, corps } = await texteEnvoiContrat(tx, contrat);
  return { journal: { contratMaintenanceId: contrat.id }, objet, corps };
}

export const envoiContrat = (id: string) => ({
  preparer: (tx: Prisma.TransactionClient) => preparerEnvoiContrat(tx, id),
  lirePdf: (tx: Prisma.TransactionClient) => lireContratPdf(tx, id),
  rendrePdf: rendreFichierContratPdf,
});
