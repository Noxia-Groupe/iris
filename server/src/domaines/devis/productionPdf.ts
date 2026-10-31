import type { Prisma } from '@prisma/client';
import { FUSEAU_HORAIRE_PAR_DEFAUT } from '../../commun/dates';
import { SITE_FACTURATION_ORDRE, formaterAdresseFacturation } from '../factures/metier';
import { type DonneesPdf, type PdfProduit, identiteActuelleOuRefus, refusPdf } from '../documents/productionPdf';
import { rendreDocumentDevisPdf } from './document';

// PDF du devis (lot 6a-2), en deux étapes (lot 6b-1a ; cf. documents/productionPdf.ts), sans droit ni
// verrou : la route garde les siens.
// Un devis signé s'imprime depuis les copies prises à sa signature ; un devis non signé (brouillon,
// envoyé, ou refusé ou annulé avant signature), avec l'identité de la société et la fiche client
// actuelles. Une signature antérieure au lot 6a-2 n'a pas de copie : son devis s'imprime comme un
// devis non signé.
// Refus de la lecture : 404 « Devis introuvable. » ; 409 si l'identité de la société est incomplète
// (« … avant d’imprimer un devis »), pour un devis imprimé sans copie seulement.
export async function lireDevisPdf(tx: Prisma.TransactionClient, id: string) {
  const devis = await tx.devis.findUnique({ where: { id }, include: {
    lignes: { orderBy: { ordre: 'asc' } },
    signature: { include: { identiteEmetteur: { include: { logo: { select: { contenu: true } } } } } },
    client: { select: { raisonSociale: true, sites: { orderBy: SITE_FACTURATION_ORDRE, take: 1 } } },
  } });
  if (!devis) return refusPdf(404, 'Devis introuvable.');
  const copie = devis.signature?.identiteEmetteur ? devis.signature : null;
  const identite = copie?.identiteEmetteur ?? await identiteActuelleOuRefus(tx, 'd’imprimer un devis');
  if ('error' in identite) return identite;
  const client = copie
    ? { raisonSociale: copie.clientRaisonSociale!, adresse: copie.clientAdresse }
    : { raisonSociale: devis.client.raisonSociale, adresse: devis.client.sites[0] ? formaterAdresseFacturation(devis.client.sites[0]) : null };
  // Les dates d'un devis signé (création, signature) se lisent dans le fuseau copié à sa signature.
  const societe = copie ? null : await tx.companySettings.findUnique({ where: { id: 'singleton' }, select: { fuseauHoraire: true } });
  return { devis, identite, client, fuseau: copie?.fuseauHoraire || societe?.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT };
}

export type DevisPdfLu = DonneesPdf<typeof lireDevisPdf>;

export async function rendreFichierDevisPdf(lu: DevisPdfLu): Promise<PdfProduit> {
  const pdf = await rendreDocumentDevisPdf(lu);
  return { pdf, nomFichier: `${lu.devis.numero}-v${lu.devis.version}.pdf` };
}
