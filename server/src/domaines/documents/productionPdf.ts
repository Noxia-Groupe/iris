import type { Response } from 'express';
import type { Prisma } from '@prisma/client';
import { transactionVerifiee } from '../../db';
import type { IdentiteImprimee } from './gabarit';
import { IdentiteEmetteurIncompleteError, identiteActuelleImprimee } from './identite';

// Production commune des PDF (lot 6b-1a), sans changement de comportement. Chaque domaine expose, pour
// son document, deux étapes :
// - lire…Pdf(tx, …) lit, dans la transaction que lui donne l'appelant, ce que le PDF imprime (document,
//   identité, fuseau), ou rend le refus du PDF, avec le statut et le message exacts de la route ;
// - rendreFichier…Pdf(lu) rend, hors de toute transaction, le PDF et le nom de son fichier.
// Documents : devis (devis/productionPdf.ts), facture ou avoir (factures/productionPdf.ts), compte
// rendu (interventions/productionPdf.ts), contrat de maintenance (contrats/productionPdf.ts) et rapport
// de chantier remis au client (chantiers/productionPdf.ts). La route « PDF » de chaque document les
// enchaîne par produirePdf ; l'envoi par Microsoft 365 (lot 6b-1b) reprendra la lecture dans sa propre
// transaction et le rendu après elle, pour joindre au courriel le PDF que produit Iris.
//
// Une lecture n'applique ni droit, ni périmètre, ni verrou : les gardes, le périmètre et les exclusions
// restent dans la route, qui les applique avant ou les passe à la lecture.

export type PdfProduit = { pdf: Buffer; nomFichier: string };
export type RefusPdf = { statut: 404 | 409; error: string };
export type ProductionPdf = PdfProduit | RefusPdf;

export const refusPdf = (statut: RefusPdf['statut'], error: string): RefusPdf => ({ statut, error });

// Une lecture rend un refus ou ce que le rendu attend : les données lues sont tout le reste.
export const estRefusPdf = <T>(lu: T | RefusPdf): lu is RefusPdf => typeof lu === 'object' && lu !== null && 'error' in lu;
export type DonneesPdf<F extends (...args: never[]) => Promise<unknown>> = Exclude<Awaited<ReturnType<F>>, RefusPdf>;

// Identité actuelle de la société, à imprimer sur un document qui n'est pas figé, ou le refus (409)
// qui nomme ses champs manquants : « … avant d’imprimer un devis », « … un compte rendu »…
export async function identiteActuelleOuRefus(tx: Prisma.TransactionClient, avant: string): Promise<IdentiteImprimee | RefusPdf> {
  try {
    return await identiteActuelleImprimee(tx, avant);
  } catch (error) {
    if (error instanceof IdentiteEmetteurIncompleteError) return refusPdf(409, error.message);
    throw error;
  }
}

// Route « PDF » : la lecture dans une transaction, aux options de la route, puis le rendu une fois la
// transaction validée, comme avant le lot 6b-1a : aucune connexion n'est tenue pendant le rendu, qui
// n'est pas soumis au délai de la transaction.
export async function produirePdf<T>(
  lecture: (tx: Prisma.TransactionClient) => Promise<T | RefusPdf>,
  rendu: (lu: T) => Promise<PdfProduit>,
  options: Parameters<typeof transactionVerifiee>[1],
): Promise<ProductionPdf> {
  const lu = await transactionVerifiee(lecture, options);
  if (estRefusPdf(lu)) return lu;
  return rendu(lu);
}

// Réponse de la route « PDF » : le refus en JSON, ou le PDF affiché dans le navigateur, sous son nom de
// fichier, avec les mêmes en-têtes pour les cinq documents.
export function repondrePdf(res: Response, production: ProductionPdf): void {
  if ('error' in production) {
    res.status(production.statut).json({ error: production.error });
    return;
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${production.nomFichier}"`);
  res.setHeader('Content-Length', production.pdf.length);
  res.send(production.pdf);
}
