import type { Prisma } from '@prisma/client';
import { FUSEAU_HORAIRE_PAR_DEFAUT } from '../../commun/dates';
import { type DonneesPdf, type PdfProduit, identiteActuelleOuRefus, refusPdf } from '../documents/productionPdf';
import { CHANTIER_IMPRIME, nomFichierRapportChantier, rendreRapportChantierPdf } from './document';

// Rapport de chantier remis au client (lot 6a-4c), sans montant ni heures, en deux étapes (lot 6b-1a ;
// cf. documents/productionPdf.ts), sans droit ni verrou : la route garde les siens. Le chantier, ses
// interventions non annulées, leurs comptes rendus et signatures (./document.ts), l'identité actuelle
// de la société et son fuseau. Un chantier annulé s'imprime, avec la mention.
// Refus de la lecture : 404 « Chantier introuvable » (sans point final, comme les autres routes des
// chantiers) ; 409 si l'identité de la société est incomplète (« … avant d’imprimer un rapport de
// chantier »).
export async function lireRapportChantierPdf(tx: Prisma.TransactionClient, id: string) {
  const chantier = await tx.chantier.findUnique({ where: { id }, select: CHANTIER_IMPRIME });
  if (!chantier) return refusPdf(404, 'Chantier introuvable');
  const identite = await identiteActuelleOuRefus(tx, 'd’imprimer un rapport de chantier');
  if ('error' in identite) return identite;
  const societe = await tx.companySettings.findUnique({ where: { id: 'singleton' }, select: { fuseauHoraire: true } });
  return { chantier, identite, fuseau: societe?.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT };
}

export type RapportChantierPdfLu = DonneesPdf<typeof lireRapportChantierPdf>;

export async function rendreFichierRapportChantierPdf(lu: RapportChantierPdfLu): Promise<PdfProduit> {
  const pdf = await rendreRapportChantierPdf(lu);
  return { pdf, nomFichier: nomFichierRapportChantier(lu.chantier) };
}
