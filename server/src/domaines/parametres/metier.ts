import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { decimalToNumber } from '../../commun/montants';

// --- Paramètres globaux (singleton) ---
export interface Parametres {
  margeCommercialeActive: boolean; planningActif: boolean; tauxAcompteDefaut: number; seuilMargeFaible: number | null; joursSansSaisie: number | null;
  rentabiliteConducteur: boolean; rentabiliteHierarchie: boolean; rentabiliteDirecteurs: boolean;
  journalConservationJours: number;
}

// Réglage unique (singleton) créé à sa première lecture. Avec un `update` vide, Prisma
// n'exécute pas l'upsert comme un INSERT … ON CONFLICT atomique : il lit, puis crée. Deux
// premières requêtes simultanées peuvent donc toutes deux tenter la création ; celle qui perd
// (violation d'unicité, P2002) rejoue l'upsert, qui trouve alors la ligne créée par l'autre.
export async function upsertSingleton<T>(upsert: () => Promise<T>): Promise<T> {
  try {
    return await upsert();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return upsert();
    throw error;
  }
}

// Retourne les paramètres avec les Decimal convertis en nombres.
export async function getParametres(): Promise<Parametres> {
  const p = await upsertSingleton(() => prisma.parametres.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  }));
  return decimalToNumber(p) as Parametres;
}

// Valide un barème envoyé par le client. Un barème vide est accepté (aucune commission) ;
// ce qui est refusé, c'est un barème incohérent, qui produirait des montants faux en
// silence : taux hors de [0, 100], plafonds non croissants, ou plusieurs tranches non
// plafonnées — seule la dernière peut l'être, sinon les suivantes ne servent à rien.
export function validerBareme(valeur: unknown, champ: string): TrancheBareme[] {
  if (!Array.isArray(valeur)) throw new Error(`${champ} : un tableau de tranches est attendu.`);
  if (valeur.length > 20) throw new Error(`${champ} : 20 tranches au maximum.`);
  const tranches: TrancheBareme[] = valeur.map((t: any, i: number) => {
    const taux = Number(t?.taux);
    if (!Number.isFinite(taux) || taux < 0 || taux > 100) {
      throw new Error(`${champ}, tranche ${i + 1} : le taux doit être compris entre 0 et 100.`);
    }
    const brut = t?.plafond;
    const plafond = brut === null || brut === undefined || brut === '' ? Infinity : Number(brut);
    if (plafond !== Infinity && (!Number.isFinite(plafond) || plafond <= 0)) {
      throw new Error(`${champ}, tranche ${i + 1} : le plafond doit être un montant positif, ou vide pour la dernière tranche.`);
    }
    return { plafond, taux };
  });
  // Ce contrôle passe AVANT celui de la croissance : deux tranches sans plafond valent
  // toutes deux Infinity, donc « non croissantes » — un message exact mais incompréhensible
  // pour qui vient simplement de laisser deux plafonds vides.
  if (tranches.filter((t) => t.plafond === Infinity).length > 1) {
    throw new Error(`${champ} : une seule tranche peut être sans plafond, et ce doit être la dernière.`);
  }
  for (let i = 1; i < tranches.length; i++) {
    if (tranches[i].plafond <= tranches[i - 1].plafond) {
      throw new Error(`${champ} : les plafonds doivent être strictement croissants.`);
    }
  }
  return tranches;
}

export function montantPositif(valeur: unknown, champ: string): number {
  const n = Number(valeur ?? 0);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${champ} : montant invalide.`);
  return n;
}

// --- Système de rémunération commerciale : barème progressif mensuel ---
// Chaque tranche de marge du MOIS est commissionnée à son propre taux, comme un barème
// d'impôt progressif : atteindre la tranche haute ne fait pas basculer toute la marge à
// son taux, seule la fraction qui la dépasse l'est.
//
// Les taux, seuils et primes NE SONT PLUS ÉCRITS ICI : ils vivent en base
// (ParametresRemuneration) et s'éditent depuis Administration > Rémunération commerciale.
// Les inscrire dans le code revenait à livrer à chaque client les règles de rémunération
// d'une autre société, et à exiger un redéploiement pour changer un taux. Depuis la
// décision du 17-10-2026, ces règles générales ne sont plus appliquées : sans plan
// commercial, aucune commission ni prime (cf. computeCommissionsParCommercial).
interface TrancheBareme { plafond: number; taux: number }

interface ReglesRemuneration {
  baremeStandard: TrancheBareme[];
  baremeReduit: TrancheBareme[];
  libelleBaremeReduit: string;
  objectifCaMensuel: number;
  primeObjectifCa: number;
  objectifMargeMensuel: number;
  primeObjectifMarge: number;
  primeSuiviAdministratif: number;
}

// Valeurs NEUTRES : aucune commission, aucune prime. Repli de lecture si la ligne de
// paramètres n'existe pas encore (base créée avant la migration, ou vidée à la main), et
// règles appliquées à un commercial sans plan commercial (cf. computeCommissionsParCommercial).
// Mieux vaut un montant nul, visible, qu'un barème arbitraire qui ferait calculer de
// fausses rémunérations sans que personne ne s'en aperçoive. Un objet neuf à chaque appel :
// aucun appelant ne peut, en le modifiant, rouvrir les commissions des autres.
export function remunerationNeutre(): ReglesRemuneration {
  return {
    baremeStandard: [],
    baremeReduit: [],
    libelleBaremeReduit: 'Barème réduit',
    objectifCaMensuel: 0,
    primeObjectifCa: 0,
    objectifMargeMensuel: 0,
    primeObjectifMarge: 0,
    primeSuiviAdministratif: 0,
  };
}

// Une tranche stockée avec `plafond: null` est la tranche non plafonnée : JSON ne sait pas
// représenter Infinity, on le rétablit à la lecture. Les tranches sont triées par plafond
// croissant, le calcul progressif en dépendant.
export function parseBareme(valeur: unknown): TrancheBareme[] {
  if (!Array.isArray(valeur)) return [];
  return valeur
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      plafond: t.plafond === null || t.plafond === undefined ? Infinity : Number(t.plafond),
      taux: Number(t.taux),
    }))
    .filter((t) => Number.isFinite(t.taux) && t.taux >= 0 && (t.plafond === Infinity || Number.isFinite(t.plafond)))
    .sort((a, b) => a.plafond - b.plafond);
}

export async function getReglesRemuneration(): Promise<ReglesRemuneration> {
  const p = await prisma.parametresRemuneration.findUnique({ where: { id: 'singleton' } });
  if (!p) return remunerationNeutre();
  const n = decimalToNumber(p);
  return {
    baremeStandard: parseBareme(p.baremeStandard),
    baremeReduit: parseBareme(p.baremeReduit),
    libelleBaremeReduit: p.libelleBaremeReduit,
    objectifCaMensuel: n.objectifCaMensuel,
    primeObjectifCa: n.primeObjectifCa,
    objectifMargeMensuel: n.objectifMargeMensuel,
    primeObjectifMarge: n.primeObjectifMarge,
    primeSuiviAdministratif: n.primeSuiviAdministratif,
  };
}

// Sérialisation inverse, pour l'écriture : Infinity redevient null.
export function serialiseBareme(bareme: TrancheBareme[]) {
  return bareme.map((t) => ({ plafond: t.plafond === Infinity ? null : t.plafond, taux: t.taux }));
}
