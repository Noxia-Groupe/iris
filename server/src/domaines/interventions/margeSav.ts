import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { totalHeuresInterventionAuCentime } from './metier';

// --- Marge d'une intervention SAV hors contrat, sans devis ni chantier ---
// Décisions de Nelson de la nuit du 26 au 27-10-2026 (points 4 à 7, docs/HISTORIQUE-DECISIONS.md) et du
// 27-10-2026 à 10:27 UTC (« Oui prix du catalogue, continue ») : la marge se calcule à l'heure, jamais au
// forfait jour, au prix de vente à l'heure hors contrat de la main d'œuvre de chaque intervenant, copié
// sur l'heure le jour de sa saisie comme le taux horaire chargé ; une main d'œuvre désactivée valorise
// encore les heures ; celles d'un intervenant sans main d'œuvre ne sont pas valorisées et sont signalées.
// Choix par défaut, à confirmer :
// - comme la marge d'une intervention issue d'un devis (margeDevis.ts), celle-ci est portée par
//   l'intervention initiale et comprend ses suites, suites de suites comprises ; une suite n'a pas de
//   marge propre ; une intervention annulée n'en a pas ;
// - le coût est celui de toutes les heures non archivées, au taux chargé figé, arrondi ligne par ligne
//   comme la main-d'œuvre cumulée ; une heure sans prix de vente figé (intervenant sans main d'œuvre le
//   jour de la saisie, ou heure saisie avant le lot) garde son coût et rend la marge incomplète ;
// - les heures d'une suite annulée gardent leur coût sans être vendues (« pas d’intervention […] donc pas
//   de facture », décision 14 de la même nuit) ;
// - le matériel de l'intervention et de ses suites, non archivé, compte à son coût HT, sans prix de vente
//   (décision de Nelson du 29-10-2026, « Au coût seul (Recommandé) », lot « matériel d'une intervention
//   curative ») ; celui d'une suite annulée aussi, comme ses heures (choix par défaut, à confirmer).
// coutsHT est le coût des heures ; materielHT celui du matériel ; margeHT, les ventes moins les deux.
export type MargeSavHorsContrat = {
  ventesHT: Prisma.Decimal;
  coutsHT: Prisma.Decimal;
  materielHT: Prisma.Decimal;
  margeHT: Prisma.Decimal;
  nombreSuites: number;
  heuresNonValorisees: Prisma.Decimal;
  intervenantsNonValorises: string[];
  heuresSuitesAnnulees: Prisma.Decimal;
};

const auCentime = (montant: Prisma.Decimal) => montant.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

// Prix à copier sur une heure saisie hors contrat : le prix de vente à l'heure hors contrat de la main
// d'œuvre rattachée à l'intervenant, même désactivée (le rattachement est gardé) ; null sans rattachement.
// L'appelant tient le verrou de la fiche intervenant (verrouillerContexteCout). Le rattachement (pose,
// changement ou retrait) prend ce verrou et réécrit la fiche : il attend une saisie qui le tient ; validé
// avant l'instantané de la saisie (sa première lecture), il est lu ; validé après, qu'elle attende ou non
// ce verrou, il la fait refuser (conflit, 409, à relancer), comme un changement de taux, la saisie,
// sérialisable, lisant sinon le rattachement de son instantané.
export async function prixVenteHoraireHorsContrat(tx: Prisma.TransactionClient, intervenantId: string): Promise<Prisma.Decimal | null> {
  const rattachement = await tx.intervenantMainOeuvre.findUnique({ where: { intervenantId }, select: { prestation: { select: { prixVenteHt: true } } } });
  return rattachement?.prestation.prixVenteHt ?? null;
}

export async function margeSavHorsContrat(intervention: { id: string; contratMaintenanceId: string | null; chantierId: string | null; auTempsPasse: boolean; interventionInitialeId: string | null; statut: string }): Promise<MargeSavHorsContrat | null> {
  if (intervention.contratMaintenanceId || intervention.chantierId || intervention.auTempsPasse || intervention.interventionInitialeId || intervention.statut === 'ANNULEE') return null;
  // Une intervention issue d'un devis a la marge de son devis (margeDevis.ts), ou se facture avec son chantier.
  if (await prisma.devisConversion.findFirst({ where: { cibleType: 'INTERVENTION', cibleId: intervention.id }, select: { id: true } })) return null;
  // Le lien d'une suite est figé et ne boucle pas (garde en base) ; UNION écarte tout doublon.
  const suites = await prisma.$queryRaw<Array<{ id: string; statut: string }>>(Prisma.sql`
    WITH RECURSIVE chaine AS (
      SELECT "id", "statut" FROM "Intervention" WHERE "interventionInitialeId" = ${intervention.id}
      UNION
      SELECT i."id", i."statut" FROM "Intervention" i JOIN chaine c ON i."interventionInitialeId" = c."id"
    )
    SELECT "id", "statut"::text AS "statut" FROM chaine`);
  const suitesAnnulees = new Set(suites.filter((suite) => suite.statut === 'ANNULEE').map((suite) => suite.id));
  const deLaChaine = { interventionId: { in: [intervention.id, ...suites.map((suite) => suite.id)] }, archivedAt: null };
  const [heures, achats] = await Promise.all([
    prisma.coutInterventionHeure.findMany({
      where: deLaChaine,
      select: { interventionId: true, nbrHeures: true, tauxHoraireApplique: true, prixVenteHoraireApplique: true, intervenant: { select: { nom: true } } },
    }),
    prisma.coutInterventionAchat.findMany({ where: deLaChaine, select: { montantHT: true } }),
  ]);
  const vendues = heures.filter((heure) => !suitesAnnulees.has(heure.interventionId));
  const nonValorisees = vendues.filter((heure) => heure.prixVenteHoraireApplique === null);
  const somme = (lignes: typeof heures, montant: (heure: (typeof heures)[number]) => Prisma.Decimal) => lignes.reduce((total, heure) => total.plus(montant(heure)), new Prisma.Decimal(0));
  const ventesHT = auCentime(somme(vendues.filter((heure) => heure.prixVenteHoraireApplique !== null), (heure) => auCentime(heure.nbrHeures.mul(heure.prixVenteHoraireApplique!))));
  const coutsHT = totalHeuresInterventionAuCentime(heures);
  const materielHT = auCentime(achats.reduce((total, achat) => total.plus(achat.montantHT), new Prisma.Decimal(0)));
  return {
    ventesHT,
    coutsHT,
    materielHT,
    margeHT: auCentime(ventesHT.minus(coutsHT).minus(materielHT)),
    nombreSuites: suites.length,
    heuresNonValorisees: somme(nonValorisees, (heure) => heure.nbrHeures),
    intervenantsNonValorises: [...new Set(nonValorisees.map((heure) => heure.intervenant.nom))].sort((a, b) => a.localeCompare(b, 'fr')),
    heuresSuitesAnnulees: somme(heures.filter((heure) => suitesAnnulees.has(heure.interventionId)), (heure) => heure.nbrHeures),
  };
}
