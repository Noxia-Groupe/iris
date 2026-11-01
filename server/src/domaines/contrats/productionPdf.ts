import type { Prisma } from '@prisma/client';
import { SITE_FACTURATION_ORDRE } from '../factures/metier';
import { type DonneesPdf, type PdfProduit, identiteActuelleOuRefus, refusPdf } from '../documents/productionPdf';
import { nomFichierContrat, rendreDocumentContratPdf } from './document';

// PDF du contrat de maintenance (lot 6a-4b), en deux étapes (lot 6b-1a ; cf.
// documents/productionPdf.ts), sans droit ni verrou : la route garde les siens. Récapitulatif du
// contrat, de tout statut, avec ses visites, son devis d'origine, le site de facturation du client et
// l'identité actuelle de la société, logo compris.
// Refus de la lecture : 404 « Contrat de maintenance introuvable. » ; 409 si l'identité de la société
// est incomplète (« … avant d’imprimer un contrat »).
export async function lireContratPdf(tx: Prisma.TransactionClient, id: string) {
  const contrat = await tx.contratMaintenance.findUnique({
    where: { id },
    include: {
      client: { select: { raisonSociale: true, sites: { orderBy: SITE_FACTURATION_ORDRE, take: 1 } } },
      site: true,
      // Les visites seules : les suites portent le contrat sans échéance.
      interventions: { where: { echeanceContrat: { not: null } }, orderBy: [{ echeanceContrat: 'asc' }, { id: 'asc' }], select: { echeanceContrat: true, statut: true } },
    },
  });
  if (!contrat) return refusPdf(404, 'Contrat de maintenance introuvable.');
  const identite = await identiteActuelleOuRefus(tx, 'd’imprimer un contrat');
  if ('error' in identite) return identite;
  // Devis d'origine : celui dont la conversion a créé le contrat (lot pilote 4).
  const conversion = await tx.devisConversion.findFirst({
    where: { cibleType: 'CONTRAT', cibleId: contrat.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { devis: { select: { numero: true, version: true } } },
  });
  return { contrat, identite, devisOrigine: conversion?.devis ?? null };
}

export type ContratPdfLu = DonneesPdf<typeof lireContratPdf>;

export async function rendreFichierContratPdf({ contrat, identite, devisOrigine }: ContratPdfLu): Promise<PdfProduit> {
  const pdf = await rendreDocumentContratPdf({
    identite,
    contrat: {
      ...contrat, siteFacturation: contrat.client.sites[0] ?? null, devisOrigine,
      visites: contrat.interventions.map((visite) => ({ echeanceContrat: visite.echeanceContrat!, statut: visite.statut })),
    },
  });
  return { pdf, nomFichier: nomFichierContrat(contrat) };
}
