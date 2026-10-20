import { prisma } from '../../db';
import { AFFAIRE_NON_ANNULEE } from '../../droits/perimetres';
import { decimalToNumber, sommeExacte } from '../../commun/montants';
import { type Parametres, remunerationNeutre } from '../parametres/metier';
import { computeChantierMetrics } from '../chantiers/suivi';

export function commissionBaremeProgressif(marge: number, bareme: { plafond: number; taux: number }[]): number {
  if (marge <= 0) return 0;
  let commission = 0;
  let plancher = 0;
  for (const { plafond, taux } of bareme) {
    if (marge <= plancher) break;
    commission += (Math.min(marge, plafond) - plancher) * (taux / 100);
    plancher = plafond;
  }
  return commission;
}

// Clés "YYYY-MM" (UTC) de chaque mois civil couvert par [start, endExclusive[.
function moisKeysDansPeriode(start: Date, endExclusive: Date): string[] {
  const keys: string[] = [];
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur < endExclusive) {
    keys.push(cur.toISOString().slice(0, 7));
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return keys;
}

// Date de rattachement mensuel d'un chantier pour le calcul des commissions : celle où
// sa marge est réputée acquise. On retient la date de clôture (dateFin, auto-renseignée
// au passage en Terminé — cf. PATCH /chantiers/:id/statut), avec repli sur updatedAt pour
// les chantiers déjà clôturés avant l'introduction de ce champ. Un chantier En cours n'a
// pas encore de date de clôture : sa marge n'est pas rattachable à un mois.
export function dateClotureChantier(c: any): Date | null {
  if (c.statut !== 'TERMINE') return null;
  return c.dateFin ? new Date(c.dateFin) : new Date(c.updatedAt);
}

// Calcule marge/commission (barème progressif + primes d'objectifs et de suivi
// administratif) par commercial sur [start, endExclusive[, mois par mois (cf. commentaire
// de /api/stats/commerciaux). Réutilisé par cette route (détail par chantier) ET par
// /api/stats/global (total agrégé pour les cartes du tableau de bord).
//
// Plan commercial (lot (i)) : un commercial sans plan commercial ne touche aucune commission
// ni prime, jusqu'à ce qu'un plan lui soit attribué à date (décision de Nelson du
// 17-10-2026). Aucun plan n'existe encore : le barème global (ParametresRemuneration) n'est
// plus appliqué, chaque commercial reçoit les règles neutres et seuls le CA et la marge
// restent calculés.
export async function computeCommissionsParCommercial(commercialIds: string[], start: Date, endExclusive: Date, params: Parametres) {
  const regles = remunerationNeutre();
  const commercialIdSet = new Set(commercialIds);
  const chantiers = decimalToNumber(await prisma.chantier.findMany({
    // Une affaire annulée n'a jamais existé commercialement : ni CA, ni marge, ni commission.
    where: { ...AFFAIRE_NON_ANNULEE, commercialId: { in: commercialIds } },
    include: { achats: { where: { archivedAt: null } }, pointages: { where: { archivedAt: null } } },
  }));

  const moisPeriode = moisKeysDansPeriode(start, endExclusive);
  const primesAdmin = await prisma.primeMensuelleCommercial.findMany({
    where: { commercialId: { in: commercialIds }, periode: { in: moisPeriode } },
  });
  const suiviAdminSet = new Set(primesAdmin.filter((p) => p.suiviAdministratif).map((p) => `${p.commercialId}:${p.periode}`));

  const buckets: Record<string, Record<string, { ca: number; margeStandard: number; margeReduite: number }>> = {};
  for (const c of chantiers) {
    if (!c.commercialId || !commercialIdSet.has(c.commercialId)) continue;
    const dateCloture = dateClotureChantier(c);
    if (!c.encaisse || !dateCloture || dateCloture < start || dateCloture >= endExclusive) continue;
    const m = computeChantierMetrics(c, params, true);
    const moisKey = dateCloture.toISOString().slice(0, 7);
    buckets[c.commercialId] ??= {};
    buckets[c.commercialId][moisKey] ??= { ca: 0, margeStandard: 0, margeReduite: 0 };
    const b = buckets[c.commercialId][moisKey];
    // Sommes exactes, indépendantes de l'ordre des chantiers (#198).
    b.ca = sommeExacte(b.ca, c.budgetGlobalVendu);
    if (c.baremeReduit) b.margeReduite = sommeExacte(b.margeReduite, m.margeCommerciale ?? 0);
    else b.margeStandard = sommeExacte(b.margeStandard, m.margeCommerciale ?? 0);
  }

  const commissionsParMoisGroupe: Record<string, { standard: number; reduit: number }> = {};
  const byCommercial: Record<string, any> = {};
  for (const id of commercialIds) {
    const buck = buckets[id] || {};
    let commissionStandard = 0, commissionReduite = 0, primeCA = 0, primeMarge = 0, primeAdmin = 0, caTotal = 0, margeTotal = 0, margeStandard = 0, margeReduite = 0;
    for (const [moisKey, b] of Object.entries(buck)) {
      const cStandard = commissionBaremeProgressif(b.margeStandard, regles.baremeStandard);
      const cReduit = commissionBaremeProgressif(b.margeReduite, regles.baremeReduit);
      commissionsParMoisGroupe[`${id}:${moisKey}`] = { standard: cStandard, reduit: cReduit };
      commissionStandard = sommeExacte(commissionStandard, cStandard);
      commissionReduite = sommeExacte(commissionReduite, cReduit);
      caTotal = sommeExacte(caTotal, b.ca);
      margeStandard = sommeExacte(margeStandard, b.margeStandard);
      margeReduite = sommeExacte(margeReduite, b.margeReduite);
      margeTotal = sommeExacte(margeTotal, b.margeStandard, b.margeReduite);
      // Un objectif à 0 n'est pas un objectif atteint d'office : sans seuil défini,
      // aucune prime n'est due.
      if (regles.objectifCaMensuel > 0 && b.ca >= regles.objectifCaMensuel) primeCA = sommeExacte(primeCA, regles.primeObjectifCa);
      if (regles.objectifMargeMensuel > 0 && sommeExacte(b.margeStandard, b.margeReduite) >= regles.objectifMargeMensuel) primeMarge = sommeExacte(primeMarge, regles.primeObjectifMarge);
      if (suiviAdminSet.has(`${id}:${moisKey}`)) primeAdmin = sommeExacte(primeAdmin, regles.primeSuiviAdministratif);
    }
    const commissionBareme = sommeExacte(commissionStandard, commissionReduite);
    byCommercial[id] = {
      caTotal, margeTotal, margeStandard, margeReduite,
      commissionBareme, commissionStandard, commissionReduite, primeCA, primeMarge, primeAdmin,
      commissionTotal: sommeExacte(commissionBareme, primeCA, primeMarge, primeAdmin),
      sansPlanCommercial: true,
    };
  }

  return { byCommercial, chantiers, buckets, commissionsParMoisGroupe, moisPeriode, suiviAdminSet };
}
