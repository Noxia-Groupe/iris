import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { totalHeuresInterventionAuCentime } from './metier';

// --- Marge de l'intervention initiale issue d'un devis, sans chantier ---
// Décision de Nelson de la nuit du 26 au 27-10-2026 (point 2, « Je suis ta proposition »,
// docs/HISTORIQUE-DECISIONS.md) : la suite d'une intervention issue d'un devis converti en
// intervention, sans chantier, n'est pas facturée en plus ; ses coûts pèsent sur « une marge de
// l'intervention initiale, égale au total HT du devis moins les coûts de l'intervention et de ses
// suites, visible de l'administration ». Lectures retenues, à confirmer : les suites de ses suites
// comptent ; les coûts sont les heures non archivées, chaque ligne au taux horaire chargé figé et
// arrondie au centime comme la main-d'œuvre cumulée d'une intervention, et le matériel non archivé,
// celui d'une suite annulée compris ; une intervention au temps passé n'a pas cette marge (elle se
// facture au temps passé), ni une intervention rattachée à un chantier. Pas de marge non plus, faute de
// recette, pour une intervention annulée ou issue d'un devis annulé (« pas d’intervention ou contrat donc
// pas de facture », décision 14 de la même nuit ; choix par défaut, à confirmer, pour une intervention
// annulée depuis sa fiche), ni pour celle d'un devis converti aussi en chantier : son total HT est déjà
// le vendu du chantier, et le point 2 ne vise que l'intervention « sans chantier ». Ses coûts et ceux de
// ses suites vont alors au chantier, auquel elle est rattachée (décision de Nelson du 27-10-2026 à 21:41
// UTC, devis/rattachement.ts).
export type MargeDevisIntervention = {
  devis: { id: string; numero: string; version: number };
  totalDevisHT: Prisma.Decimal;
  coutsInterventionHT: Prisma.Decimal;
  coutsSuitesHT: Prisma.Decimal;
  nombreSuites: number;
  margeHT: Prisma.Decimal;
};

const auCentime = (montant: Prisma.Decimal) => montant.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export async function margeDevisIntervention(intervention: { id: string; chantierId: string | null; auTempsPasse: boolean; statut: string }): Promise<MargeDevisIntervention | null> {
  if (intervention.chantierId || intervention.auTempsPasse || intervention.statut === 'ANNULEE') return null;
  const conversion = await prisma.devisConversion.findFirst({
    where: { cibleType: 'INTERVENTION', cibleId: intervention.id },
    select: { devis: { select: { id: true, numero: true, version: true, totalHt: true, statut: true, conversions: { where: { cibleType: 'CHANTIER' }, select: { id: true } } } } },
  });
  if (!conversion || conversion.devis.statut === 'ANNULE' || conversion.devis.conversions.length > 0) return null;
  // Le lien d'une suite est figé et ne boucle pas (garde en base) ; UNION écarte tout doublon.
  const suites = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH RECURSIVE chaine AS (
      SELECT "id" FROM "Intervention" WHERE "interventionInitialeId" = ${intervention.id}
      UNION
      SELECT i."id" FROM "Intervention" i JOIN chaine c ON i."interventionInitialeId" = c."id"
    )
    SELECT "id" FROM chaine`);
  const idsSuites = suites.map((suite) => suite.id);
  const [heures, achats] = await Promise.all([
    prisma.coutInterventionHeure.findMany({ where: { interventionId: { in: [intervention.id, ...idsSuites] }, archivedAt: null }, select: { interventionId: true, nbrHeures: true, tauxHoraireApplique: true } }),
    prisma.coutInterventionAchat.findMany({ where: { interventionId: { in: [intervention.id, ...idsSuites] }, archivedAt: null }, select: { interventionId: true, montantHT: true } }),
  ]);
  const couts = (deLIntervention: boolean) => {
    const garder = (ligne: { interventionId: string }) => (ligne.interventionId === intervention.id) === deLIntervention;
    const materiel = achats.filter(garder).reduce((total, achat) => total.plus(achat.montantHT), new Prisma.Decimal(0));
    return auCentime(totalHeuresInterventionAuCentime(heures.filter(garder)).plus(materiel));
  };
  const totalDevisHT = conversion.devis.totalHt;
  const coutsInterventionHT = couts(true);
  const coutsSuitesHT = couts(false);
  return {
    devis: { id: conversion.devis.id, numero: conversion.devis.numero, version: conversion.devis.version },
    totalDevisHT,
    coutsInterventionHT,
    coutsSuitesHT,
    nombreSuites: idsSuites.length,
    margeHT: auCentime(totalDevisHT.minus(coutsInterventionHT).minus(coutsSuitesHT)),
  };
}
