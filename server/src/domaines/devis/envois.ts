import type { Prisma } from '@prisma/client';
import { DEVIS_A_ENVOYER, refusEnvoi, texteEnvoiDevis } from '../documents/envois';
import { verrouillerDevis } from './metier';
import { lireDevisPdf, rendreFichierDevisPdf } from './productionPdf';

// Envoi du devis (lot 6a-3 ; Microsoft 365 depuis le lot 6b-1b, cf. documents/envois.ts et
// documents/envoiMicrosoft365.ts), commun aux deux canaux. Route dans ./routes.ts (envoyerDevis).

// Préparation, sous le verrou du devis : une annulation ou un refus en cours est attendu, puis refuse
// l'envoi (404 « Devis introuvable. » ; 409 pour un devis annulé ou refusé). L'objet et le texte prennent
// la raison sociale que le PDF imprime : un devis non signé exige l'identité complète de la société (409).
export async function preparerEnvoiDevis(tx: Prisma.TransactionClient, id: string) {
  if (!await verrouillerDevis(tx, id)) return refusEnvoi(404, 'Devis introuvable.');
  const devis = await tx.devis.findUniqueOrThrow({ where: { id }, include: DEVIS_A_ENVOYER });
  if (devis.statut === 'ANNULE' || devis.statut === 'REFUSE') return refusEnvoi(409, 'Un devis annulé ou refusé ne s’envoie pas.');
  const { objet, corps } = await texteEnvoiDevis(tx, devis);
  return { journal: { devisId: devis.id }, objet, corps };
}

// Dans la transaction qui note l'envoi, avant la ligne du journal : le devis est verrouillé et son
// statut relu. Un brouillon passe « envoyé » (décision de Nelson du 23-10-2026, lot 6a-3 bis) ; un devis
// dans un autre statut le garde, y compris un devis annulé ou signé entre les deux transactions d'un
// envoi par Microsoft 365 (V1 du cadrage du lot 6b). Un brouillon n'est jamais signé ni converti (la
// signature le fait passer « accepté ») : son passage à « envoyé » est celui du bouton « Marquer
// envoyé » (TRANSITIONS_DEVIS). La réponse porte le statut du devis après l'envoi, que l'écran affiche.
async function statutDevisApresEnvoi(tx: Prisma.TransactionClient, id: string) {
  await verrouillerDevis(tx, id);
  const { statut } = await tx.devis.findUniqueOrThrow({ where: { id }, select: { statut: true } });
  const statutDevis = statut === 'BROUILLON'
    ? (await tx.devis.update({ where: { id }, data: { statut: 'ENVOYE' }, select: { statut: true } })).statut
    : statut;
  return { statutDevis };
}

export const envoiDevis = (id: string) => ({
  preparer: (tx: Prisma.TransactionClient) => preparerEnvoiDevis(tx, id),
  lirePdf: (tx: Prisma.TransactionClient) => lireDevisPdf(tx, id),
  rendrePdf: rendreFichierDevisPdf,
  completer: (tx: Prisma.TransactionClient) => statutDevisApresEnvoi(tx, id),
});
