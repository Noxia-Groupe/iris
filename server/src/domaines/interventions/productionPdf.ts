import type { Prisma } from '@prisma/client';
import { FUSEAU_HORAIRE_PAR_DEFAUT } from '../../commun/dates';
import { type DonneesPdf, type PdfProduit, identiteActuelleOuRefus, refusPdf } from '../documents/productionPdf';
import { INTERVENTION_IMPRIMEE, rendreCompteRenduPdf } from './document';

// PDF du compte rendu d'intervention (lot 6a-4a), en deux étapes (lot 6b-1a ; cf.
// documents/productionPdf.ts), sans droit ni verrou. L'intervention lue est celle que désigne `filtre`,
// avec le périmètre et les exclusions que l'appelant y met : la lecture n'en ajoute aucun. La route
// « PDF » y met l'identifiant, le périmètre SAV de la fiche et l'exclusion des interventions annulées,
// après avoir refusé le technicien.
// Refus de la lecture : 404 « Intervention introuvable. » ; 409 « Aucun compte rendu à imprimer. » ;
// 409 si l'identité de la société est incomplète (« … avant d’imprimer un compte rendu »).
export async function lireCompteRenduPdf(tx: Prisma.TransactionClient, filtre: Prisma.InterventionWhereInput) {
  const intervention = await tx.intervention.findFirst({ where: filtre, select: INTERVENTION_IMPRIMEE });
  if (!intervention) return refusPdf(404, 'Intervention introuvable.');
  if (!intervention.rapports.length) return refusPdf(409, 'Aucun compte rendu à imprimer.');
  const identite = await identiteActuelleOuRefus(tx, 'd’imprimer un compte rendu');
  if ('error' in identite) return identite;
  const societe = await tx.companySettings.findUnique({ where: { id: 'singleton' }, select: { fuseauHoraire: true } });
  return { intervention, identite, fuseau: societe?.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT };
}

export type CompteRenduPdfLu = DonneesPdf<typeof lireCompteRenduPdf>;

export async function rendreFichierCompteRenduPdf(lu: CompteRenduPdfLu): Promise<PdfProduit> {
  const pdf = await rendreCompteRenduPdf(lu);
  return { pdf, nomFichier: `Compte-rendu-${lu.intervention.reference}.pdf` };
}
