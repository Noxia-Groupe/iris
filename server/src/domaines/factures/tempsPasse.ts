import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { PLAFOND_MONTANT, arrondiCommercialLigneHt, centimes, centimesTtcLigne } from '../../commun/montants';
import { dateEmissionEstFuture, dateIsoStricte } from '../../commun/dates';
import { ventilationTvaDerivee } from './metier';

// --- Facture au temps passé (lot « facture au temps passé », seconde PR) ---
// Décisions de Nelson de la nuit du 26 au 27-10-2026 (points 3 et 8 à 12) et du 28-10-2026
// (docs/HISTORIQUE-DECISIONS.md) : la facture d'une intervention au temps passé reprend les heures
// saisies sur l'intervention et sur ses suites, au prix figé sur le devis, arrondies au pas au-delà du
// temps minimum figé, avec au moins ce minimum ; c'est une seule facture, le minimum et l'arrondi étant
// appliqués une fois au total des heures (« Une fois au total ») ; un devis fait avant le temps minimum
// (minimum vide) a pour plancher les heures de sa ligne au temps passé (« Les heures de la ligne »).
//
// Lectures et choix par défaut, à confirmer (passation, section 4) :
//  - devis sans minimum figé (fait avant le temps minimum, ou révision d'un tel devis) : son pas joue
//    au-delà de son plancher, les heures de sa ligne, et non de la première heure que nomme sa mention ;
//    les deux lectures coïncident quand la ligne vaut une heure plus un multiple du pas (par exemple,
//    2 h passées sur un devis de 2 h se facturent 2 h, et non 2 h 30 au pas de 45 min) ;
//  - la facture reprend les autres lignes du devis telles que signées, la ligne au temps passé valant les
//    heures facturées ; une fourniture devient un article, une main-d'œuvre une prestation ;
//  - les heures non archivées comptent, celles d'une suite annulée non (« pas d’intervention […] donc pas
//    de facture », décision 14 de la même nuit) ;
//  - la facture attend une intervention terminée, des suites terminées ou annulées, sans marque « à
//    suivre », et au moins une heure saisie ; elle est refusée pour une suite, pour une intervention
//    rattachée au chantier de son affaire, et quand l'intervention ou une de ses suites a déjà une facture
//    vivante (brouillon, émise ou réglée) ;
//  - elle fige les heures du jour de sa création : une heure saisie ensuite, ou une suite créée ensuite,
//    ne la change pas.

export class RefusFactureTempsPasse extends Error {
  constructor(readonly statut: 400 | 404 | 409, message: string) { super(message); }
}

type Db = Prisma.TransactionClient | typeof prisma;

// Grille du temps facturé, en minutes : au moins le plancher, puis, au-delà, toute tranche du pas
// commencée. Le plancher est le minimum figé du devis, ou, sur un devis antérieur au temps minimum, les
// heures de sa ligne au temps passé.
export type GrilleTempsPasse = { plancherMinutes: Prisma.Decimal; pasMinutes: number };

export function grilleTempsPasse(devis: { tempsMinimumMinutes: number | null; pasTempsPasseMinutes: number }, quantiteLigne: Prisma.Decimal.Value): GrilleTempsPasse {
  const plancherMinutes = devis.tempsMinimumMinutes !== null ? new Prisma.Decimal(devis.tempsMinimumMinutes) : new Prisma.Decimal(quantiteLigne).times(60);
  return { plancherMinutes, pasMinutes: devis.pasTempsPasseMinutes };
}

export function minutesFacturees(minutesSaisies: Prisma.Decimal.Value, grille: GrilleTempsPasse): Prisma.Decimal {
  const depassement = new Prisma.Decimal(minutesSaisies).minus(grille.plancherMinutes);
  if (depassement.lte(0)) return grille.plancherMinutes;
  return grille.plancherMinutes.plus(depassement.div(grille.pasMinutes).ceil().times(grille.pasMinutes));
}

// Quantité de la ligne, en heures au millième comme les lignes de facture : exacte pour un devis fait
// depuis le temps minimum (minutes multiples de 15) ; arrondie au plus proche sur un devis antérieur dont
// le pas ne divise pas l'heure.
export const heuresDesMinutes = (minutes: Prisma.Decimal) => minutes.div(60).toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP);

const STATUTS_SUITE_CLOSE = ['TERMINEE', 'ANNULEE'];
const libelles = (references: string[]) => references.join(', ');

// L'intervention, ou celle dont elle est une suite, est-elle au temps passé ? Le marqueur et le lien d'une
// suite sont figés en base : la réponse ne change pas, et la facture saisie ligne par ligne peut se
// refuser sans verrou.
export async function referenceTempsPasse(db: Db, interventionId: string): Promise<string | null> {
  const lignes = await db.$queryRaw<Array<{ reference: string }>>(Prisma.sql`
    WITH RECURSIVE ascendance AS (
      SELECT "id", "reference", "interventionInitialeId", "auTempsPasse" FROM "Intervention" WHERE "id" = ${interventionId}
      UNION
      SELECT i."id", i."reference", i."interventionInitialeId", i."auTempsPasse" FROM "Intervention" i JOIN ascendance a ON i."id" = a."interventionInitialeId"
    )
    SELECT "reference" FROM ascendance WHERE "auTempsPasse" LIMIT 1`);
  return lignes[0]?.reference ?? null;
}

async function idsDesSuites(db: Db, interventionId: string): Promise<string[]> {
  // Le lien d'une suite est figé et ne boucle pas (garde en base) ; UNION écarte tout doublon.
  const suites = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH RECURSIVE chaine AS (
      SELECT "id" FROM "Intervention" WHERE "interventionInitialeId" = ${interventionId}
      UNION
      SELECT i."id" FROM "Intervention" i JOIN chaine c ON i."interventionInitialeId" = c."id"
    )
    SELECT "id" FROM chaine ORDER BY "id"`);
  return suites.map((suite) => suite.id);
}

// Verrouille l'intervention et toutes ses suites, dans cet ordre : une heure saisie, une suite créée, une
// clôture ou une annulation concurrentes attendent la facture, ou la précèdent et sont relues. Une suite
// créée pendant la lecture de la chaîne (sous une suite non encore verrouillée) est rattrapée par la
// relecture, jusqu'à une chaîne stable.
async function verrouillerChaine(db: Db, interventionId: string): Promise<string[]> {
  await db.$queryRaw(Prisma.sql`SELECT "id" FROM "Intervention" WHERE "id" = ${interventionId} FOR UPDATE`);
  let ids = await idsDesSuites(db, interventionId);
  for (let essai = 0; essai < 5; essai += 1) {
    if (ids.length) await db.$queryRaw(Prisma.sql`SELECT "id" FROM "Intervention" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`);
    const relus = await idsDesSuites(db, interventionId);
    if (relus.length === ids.length && relus.every((id, index) => id === ids[index])) return ids;
    ids = relus;
  }
  throw new RefusFactureTempsPasse(409, 'Les suites de cette intervention changent en ce moment : réessayez.');
}

export type LigneFactureTempsPasse = {
  ordre: number; designation: string; nature: string; quantite: number; prixUnitaireHt: number; tauxTva: number;
  totalHt: number; totalTtc: number; tempsPasse: boolean;
};

export async function preparerFactureTempsPasse(db: Db, interventionId: string, verrouiller: boolean) {
  const idsSuites = verrouiller ? await verrouillerChaine(db, interventionId) : null;
  const intervention = await db.intervention.findUnique({
    where: { id: interventionId },
    select: {
      id: true, reference: true, titre: true, statut: true, clientId: true, auTempsPasse: true, interventionInitialeId: true, aSuivre: true, chantierId: true,
      client: { select: { raisonSociale: true, actif: true } },
    },
  });
  if (!intervention) throw new RefusFactureTempsPasse(404, 'Intervention introuvable.');
  if (intervention.interventionInitialeId) {
    const reference = await referenceTempsPasse(db, intervention.id);
    throw new RefusFactureTempsPasse(409, reference
      ? `Cette intervention est une suite : ses heures se facturent sur la facture au temps passé de l’intervention ${reference}.`
      : 'Cette intervention n’est pas au temps passé : sa facture se saisit ligne par ligne.');
  }
  if (!intervention.auTempsPasse) throw new RefusFactureTempsPasse(409, 'Cette intervention n’est pas au temps passé : sa facture se saisit ligne par ligne.');
  if (!intervention.client.actif) throw new RefusFactureTempsPasse(404, 'Client introuvable.');
  if (intervention.statut === 'ANNULEE') throw new RefusFactureTempsPasse(409, 'Une intervention annulée n’est pas facturée.');
  if (intervention.statut !== 'TERMINEE') throw new RefusFactureTempsPasse(409, 'La facture au temps passé attend la fin de l’intervention : terminez-la d’abord.');
  if (intervention.chantierId) throw new RefusFactureTempsPasse(409, 'Cette intervention est rattachée au chantier de son affaire : elle se facture avec le chantier, et non au temps passé.');

  const suites = await db.intervention.findMany({
    where: { id: { in: idsSuites ?? await idsDesSuites(db, intervention.id) } },
    select: { id: true, reference: true, statut: true, aSuivre: true },
    orderBy: { reference: 'asc' },
  });
  const enCours = suites.filter((suite) => !STATUTS_SUITE_CLOSE.includes(suite.statut));
  if (enCours.length) {
    throw new RefusFactureTempsPasse(409, `La facture au temps passé attend la fin de toutes les suites de l’intervention : ${libelles(enCours.map((s) => s.reference))} ${enCours.length > 1 ? 'ne sont ni terminées ni annulées' : 'n’est ni terminée ni annulée'}.`);
  }
  const aSuivre = [intervention, ...suites].filter((i) => i.aSuivre);
  if (aSuivre.length) {
    throw new RefusFactureTempsPasse(409, `${libelles(aSuivre.map((i) => i.reference))} ${aSuivre.length > 1 ? 'sont marquées' : 'est marquée'} « à suivre » : créez la suite ou retirez la marque avant la facture au temps passé.`);
  }

  const conversion = await db.devisConversion.findFirst({
    where: { cibleType: 'INTERVENTION', cibleId: intervention.id },
    select: { devis: { select: {
      id: true, numero: true, version: true, statut: true, auTempsPasse: true, tempsMinimumMinutes: true, pasTempsPasseMinutes: true,
      lignes: { orderBy: { ordre: 'asc' } }, conversions: { where: { cibleType: 'CHANTIER' }, select: { id: true } },
    } } },
  });
  const devis = conversion?.devis;
  const ligneTempsPasse = devis?.lignes.find((ligne) => ligne.tempsPasse);
  if (!devis || !devis.auTempsPasse || !ligneTempsPasse || devis.pasTempsPasseMinutes === null) {
    throw new RefusFactureTempsPasse(409, 'Le devis au temps passé de cette intervention est introuvable.');
  }
  if (devis.statut === 'ANNULE') throw new RefusFactureTempsPasse(409, 'Le devis de cette intervention est annulé : elle n’est pas facturée.');
  if (devis.conversions.length) throw new RefusFactureTempsPasse(409, 'Le devis de cette intervention a aussi ouvert un chantier : elle se facture avec le chantier, et non au temps passé.');

  const chaine = [intervention.id, ...suites.map((suite) => suite.id)];
  const existantes = await db.facture.findMany({
    where: { type: 'FACTURE', statut: { not: 'ANNULEE' }, interventionId: { in: chaine } },
    select: { numero: true }, orderBy: { createdAt: 'asc' },
  });
  if (existantes.length) {
    throw new RefusFactureTempsPasse(409, `Cette intervention ou l’une de ses suites a déjà une facture (${libelles(existantes.map((f) => f.numero ?? 'brouillon'))}) : la facture au temps passé est unique. Pour la refaire, annulez d’abord la facture émise par son avoir total.`);
  }

  const facturables = [intervention.id, ...suites.filter((suite) => suite.statut !== 'ANNULEE').map((suite) => suite.id)];
  const heures = await db.coutInterventionHeure.findMany({ where: { interventionId: { in: facturables }, archivedAt: null }, select: { interventionId: true, nbrHeures: true } });
  if (!heures.length) throw new RefusFactureTempsPasse(409, 'Aucune heure n’est saisie sur cette intervention ni sur ses suites : la facture au temps passé reprend les heures saisies.');
  const heuresDe = (id: string) => heures.filter((h) => h.interventionId === id).reduce((total, h) => total.plus(h.nbrHeures), new Prisma.Decimal(0));
  const heuresSaisies = heures.reduce((total, h) => total.plus(h.nbrHeures), new Prisma.Decimal(0));
  const grille = grilleTempsPasse({ tempsMinimumMinutes: devis.tempsMinimumMinutes, pasTempsPasseMinutes: devis.pasTempsPasseMinutes }, ligneTempsPasse.quantite);
  const facturees = minutesFacturees(heuresSaisies.times(60), grille);
  const quantiteFacturee = heuresDesMinutes(facturees);

  const lignes: LigneFactureTempsPasse[] = devis.lignes.map((ligne, ordre) => {
    const quantite = ligne.tempsPasse ? quantiteFacturee : ligne.quantite;
    const totalHt = arrondiCommercialLigneHt(quantite.toString(), ligne.prixUnitaireHt.toString());
    const totalTtc = centimesTtcLigne(totalHt, ligne.tauxTva.toString());
    if (totalTtc > PLAFOND_MONTANT) throw new RefusFactureTempsPasse(409, 'Montant de ligne hors des limites acceptées.');
    return {
      ordre, designation: ligne.designation, nature: ligne.nature === 'FOURNITURE' ? 'ARTICLE' : 'PRESTATION',
      quantite: quantite.toNumber(), prixUnitaireHt: ligne.prixUnitaireHt.toNumber(), tauxTva: ligne.tauxTva.toNumber(), totalHt, totalTtc, tempsPasse: ligne.tempsPasse,
    };
  });
  const totalHt = centimes(lignes.reduce((somme, ligne) => somme + ligne.totalHt, 0));
  // La TVA légale s'arrondit sur la base HT cumulée de chaque taux, comme pour toute facture.
  const ventilationTva = ventilationTvaDerivee(lignes);
  const totalTva = centimes(ventilationTva.reduce((somme, ventilation) => somme + ventilation.totalTva, 0));
  const totalTtc = centimes(totalHt + totalTva);
  if (totalTtc > PLAFOND_MONTANT) throw new RefusFactureTempsPasse(409, 'Montant de facture hors des limites acceptées.');

  return {
    intervention: { id: intervention.id, reference: intervention.reference, titre: intervention.titre, clientId: intervention.clientId, clientRaisonSociale: intervention.client.raisonSociale },
    devis: { id: devis.id, numero: devis.numero, version: devis.version },
    heures: {
      intervention: heuresDe(intervention.id).toNumber(),
      suites: suites.map((suite) => ({ id: suite.id, reference: suite.reference, statut: suite.statut, heures: suite.statut === 'ANNULEE' ? null : heuresDe(suite.id).toNumber() })),
      saisies: heuresSaisies.toNumber(),
      minutesSaisies: heuresSaisies.times(60).toNumber(),
      minimumFige: devis.tempsMinimumMinutes !== null,
      plancherMinutes: grille.plancherMinutes.toNumber(),
      pasMinutes: grille.pasMinutes,
      minutesFacturees: facturees.toNumber(),
      facturees: quantiteFacturee.toNumber(),
    },
    lignes, ventilationTva, totalHt, totalTva, totalTtc,
  };
}

export type FactureTempsPassePreparee = Awaited<ReturnType<typeof preparerFactureTempsPasse>>;

// Dates d'une facture, comme pour la saisie ligne par ligne : au format JJ-MM-AAAA, l'échéance après
// l'émission, l'émission jamais future au jour de la société.
export function lireDatesFacture(corps: { dateEmission?: unknown; dateEcheance?: unknown } | undefined, fuseauHoraire: string): { dateEmission: Date; dateEcheance: Date } {
  const dateEmission = dateIsoStricte(corps?.dateEmission);
  const dateEcheance = dateIsoStricte(corps?.dateEcheance);
  if (!dateEmission || !dateEcheance) throw new RefusFactureTempsPasse(400, 'Les dates doivent être valides au format JJ-MM-AAAA.');
  if (dateEcheance < dateEmission) throw new RefusFactureTempsPasse(400, 'L’échéance ne peut pas précéder la date d’émission.');
  if (dateEmissionEstFuture(dateEmission, fuseauHoraire)) throw new RefusFactureTempsPasse(400, 'La date d’émission ne peut pas être future.');
  return { dateEmission: new Date(dateEmission), dateEcheance: new Date(dateEcheance) };
}
