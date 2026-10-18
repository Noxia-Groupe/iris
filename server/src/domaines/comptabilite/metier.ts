import { Prisma } from '@prisma/client';
import { centimes } from '../../commun/montants';
import { ventilationFacture } from '../factures/metier';

// Paramétrage comptable : aucun compte n'est préchargé. L'export devra refuser toute règle absente.
export const CLES_COMPTABLES = ['CLIENT', 'VENTE_PRESTATION', 'VENTE_ARTICLE', 'JOURNAL_VENTES'];
export const NATURES_ATTENDUES: Record<string, string[]> = { CLIENT: ['ACTIF'], VENTE_PRESTATION: ['PRODUIT'], VENTE_ARTICLE: ['PRODUIT'] };

// Toutes les mutations de compte/règle prennent d'abord le verrou du compte cible.
// Le compte source d'un remappage n'est jamais verrouillé : sa désactivation vérifie
// les références sous son propre verrou, sans cycle de verrous entre deux comptes.
// Même ordre de verrou partout : périmètre comptable, puis compte cible, puis
// règles. L'émission relit les règles après ce verrou pour figer un état cohérent.
export async function verrouillerParametrageComptable(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(814086)::text`;
}

export class ImputationIncompletError extends Error {}

type PieceComptable = { totalTtc: unknown; lignes: { nature: string; totalHt: unknown; tauxTva: unknown }[]; ventilationTva?: { tauxTva: unknown; totalHt: unknown; totalTva: unknown; totalTtc: unknown }[] };

// Construire les écritures avant la numérotation, puis les écrire dans la même transaction.
// Un avoir reprend les comptes ET le journal de l'origine, jamais les règles actuelles.
export async function ecrituresPourPiece(tx: Prisma.TransactionClient, piece: PieceComptable, origineId?: string) {
  const montants = new Map<string, { debit: number; credit: number; tauxTva?: number }>();
  montants.set('CLIENT', { debit: Number(piece.totalTtc), credit: 0 });
  for (const nature of ['PRESTATION', 'ARTICLE']) {
    const ht = centimes(piece.lignes.filter(l => l.nature === nature).reduce((s, l) => s + Number(l.totalHt), 0));
    if (ht) montants.set(`VENTE_${nature}`, { debit: 0, credit: ht });
  }
  for (const v of ventilationFacture(piece)) if (v.totalTva) montants.set(`TVA:${v.tauxTva}`, { debit: 0, credit: v.totalTva, tauxTva: v.tauxTva });
  const cles = [...montants.keys()];
  const origine = origineId ? await tx.ecritureFacture.findMany({ where: { factureId: origineId }, orderBy: { ordre: 'asc' } }) : [];
  if (origineId && !origine.length) throw new ImputationIncompletError('La facture d’origine ne possède pas d’imputation comptable figée.');
  let journal: string;
  const comptes = new Map<string, { code: string; libelle: string }>();
  if (origineId) {
    journal = origine[0].journalCode;
    for (const e of origine) comptes.set(e.cle, { code: e.compteNum, libelle: e.compteLib });
  } else {
    // La lecture et la mutation des règles utilisent le même verrou global.
    // FOR SHARE seul ne protège pas les règles créées après la lecture.
    const [regles, reglesTva] = await Promise.all([
      tx.regleComptable.findMany({ include: { compte: true } }),
      tx.regleTvaComptable.findMany({ include: { compte: true } }),
    ]);
    const parCle = new Map(regles.map(r => [r.cle, r]));
    journal = parCle.get('JOURNAL_VENTES')?.journal || '';
    for (const cle of CLES_COMPTABLES.filter(c => c !== 'JOURNAL_VENTES')) {
      const compte = parCle.get(cle)?.compte;
      if (compte?.actif && NATURES_ATTENDUES[cle]?.includes(compte.nature)) comptes.set(cle, { code: compte.code, libelle: compte.libelle });
    }
    for (const cle of cles.filter(c => c.startsWith('TVA:'))) {
      const compte = reglesTva.find(r => Number(r.taux) === Number(cle.slice(4)))?.compte;
      if (compte?.actif && compte.nature === 'TVA') comptes.set(cle, { code: compte.code, libelle: compte.libelle });
    }
  }
  const requises = origineId ? cles : [...CLES_COMPTABLES.filter(c => c !== 'JOURNAL_VENTES'), ...cles.filter(c => c.startsWith('TVA:'))];
  if (origineId) {
    const absentes = requises.filter(cle => !comptes.has(cle));
    if (absentes.length) throw new ImputationIncompletError(`L’avoir crédite une nature ou un taux absent de la facture d’origine (${absentes.join(', ')}).`);
  } else if (!journal || requises.some(cle => !comptes.has(cle))) {
    throw new ImputationIncompletError(`Paramétrage comptable incomplet : ${[...(!journal ? ['JOURNAL_VENTES'] : []), ...requises.filter(cle => !comptes.has(cle))].join(', ')}.`);
  }
  const ecritures = cles.map((cle, ordre) => {
    const montant = montants.get(cle)!;
    const compte = comptes.get(cle)!;
    return { ordre, cle, tauxTva: montant.tauxTva ?? null, journalCode: journal, compteNum: compte.code, compteLib: compte.libelle,
      debit: origineId ? montant.credit : montant.debit, credit: origineId ? montant.debit : montant.credit };
  });
  const difference = ecritures.reduce((s, e) => s + Math.round(e.debit * 100) - Math.round(e.credit * 100), 0);
  if (difference !== 0) throw new ImputationIncompletError('Écriture comptable déséquilibrée.');
  return ecritures;
}

export function libelleComptableValide(libelle: string): boolean { return !/[\p{Cc}\p{Cf}]/u.test(libelle); }
