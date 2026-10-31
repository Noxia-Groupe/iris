import type { Prisma } from '@prisma/client';
import { decimalToNumber } from '../../commun/montants';
import { type DonneesPdf, type PdfProduit, refusPdf } from '../documents/productionPdf';
import { factureInclude, refusDocumentFacture } from './metier';
import { rendreDocumentFacturePdf } from './pdf';

// PDF d'une facture ou d'un avoir émis, en deux étapes (lot 6b-1a ; cf. documents/productionPdf.ts),
// sans droit ni verrou : la route garde les siens. La pièce s'imprime depuis ses seules copies figées
// (./pdf.ts), sans identité actuelle à exiger.
// Refus de la lecture : 404 « Facture introuvable. » ; 409 avec le message de refusDocumentFacture
// (pièce non émise, mentions légales ou adresse de facturation figées absentes).
export async function lireFacturePdf(tx: Prisma.TransactionClient, id: string) {
  const facture = await tx.facture.findUnique({ where: { id }, include: { ...factureInclude, identiteEmetteur: { include: { logo: { select: { contenu: true } } } } } });
  if (!facture) return refusPdf(404, 'Facture introuvable.');
  const refus = refusDocumentFacture(facture);
  if (refus) return refusPdf(409, refus);
  return { facture };
}

export type FacturePdfLu = DonneesPdf<typeof lireFacturePdf>;

export async function rendreFichierFacturePdf({ facture }: FacturePdfLu): Promise<PdfProduit> {
  // L'identité figée garde son logo en octets : elle échappe à la conversion des montants.
  const { identiteEmetteur, ...piece } = facture;
  const pdf = await rendreDocumentFacturePdf({ ...decimalToNumber(piece), identiteEmetteur });
  return { pdf, nomFichier: `${facture.numero}.pdf` };
}
