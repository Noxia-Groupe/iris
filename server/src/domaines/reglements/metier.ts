import { Prisma, PrismaClient } from '@prisma/client';
import { formatMontantFacture } from '../factures/metier';

// --- Règlements clients (décision A3 du 16-10-2026) ---
// Saisie manuelle des encaissements, entièrement affectés aux factures émises d'un même client.
// La banque et le rapprochement viendront plus tard ; aucun règlement n'est déduit d'un statut.
export const MOYENS_REGLEMENT = ['VIREMENT', 'CHEQUE', 'CARTE', 'PRELEVEMENT', 'ESPECES'] as const;
export const LIBELLES_MOYEN_REGLEMENT: Record<string, string> = { VIREMENT: 'virement', CHEQUE: 'chèque', CARTE: 'carte', PRELEVEMENT: 'prélèvement', ESPECES: 'espèces' };
export const MAX_AFFECTATIONS_REGLEMENT = 100;
export class ReglementRefuse extends Error {
  statut: number;
  constructor(statut: number, message: string) { super(message); this.statut = statut; }
}
export const reglementInclude = {
  client: { select: { id: true, raisonSociale: true } },
  affectations: { select: { id: true, montant: true, facture: { select: { id: true, numero: true, dateEmission: true, totalTtc: true } } }, orderBy: { facture: { numero: 'asc' as const } } },
  createdBy: { select: { id: true, name: true } },
  contrepassePar: { select: { id: true, name: true } },
};

type SoldeFacture = { montantAvoirs: number; montantRegle: number; resteDu: number };
// Reste dû d'une facture émise ou réglée : TTC, moins ses avoirs émis, moins les parts des
// règlements non contre-passés. Même calcul que la fonction SQL `reste_du_facture`, qui garde
// les écritures faites hors de l'API. Il peut devenir négatif (trop-perçu) quand un avoir suit
// un règlement. Calcul en Decimal : aucun arrondi binaire sur un montant.
export async function soldesFactures(db: PrismaClient | Prisma.TransactionClient, factures: { id: string; type: string; statut: string; totalTtc: Prisma.Decimal | number }[]): Promise<Map<string, SoldeFacture>> {
  const concernees = factures.filter(facture => facture.type === 'FACTURE' && (facture.statut === 'EMISE' || facture.statut === 'REGLEE'));
  const soldes = new Map<string, SoldeFacture>();
  if (!concernees.length) return soldes;
  const ids = concernees.map(facture => facture.id);
  const [avoirs, affectations] = await Promise.all([
    db.facture.groupBy({ by: ['factureOrigineId'], where: { factureOrigineId: { in: ids }, type: 'AVOIR', statut: { not: 'BROUILLON' } }, _sum: { totalTtc: true } }),
    db.affectationReglement.groupBy({ by: ['factureId'], where: { factureId: { in: ids }, reglement: { statut: 'ENREGISTRE' } }, _sum: { montant: true } }),
  ]);
  const sommeAvoirs = new Map(avoirs.map(ligne => [ligne.factureOrigineId, ligne._sum.totalTtc ?? new Prisma.Decimal(0)]));
  const sommeRegle = new Map(affectations.map(ligne => [ligne.factureId, ligne._sum.montant ?? new Prisma.Decimal(0)]));
  for (const facture of concernees) {
    const montantAvoirs = sommeAvoirs.get(facture.id) ?? new Prisma.Decimal(0);
    const montantRegle = sommeRegle.get(facture.id) ?? new Prisma.Decimal(0);
    const resteDu = new Prisma.Decimal(facture.totalTtc).minus(montantAvoirs).minus(montantRegle);
    soldes.set(facture.id, { montantAvoirs: montantAvoirs.toNumber(), montantRegle: montantRegle.toNumber(), resteDu: resteDu.toNumber() });
  }
  return soldes;
}

export async function avecSoldes<T extends { id: string; type: string; statut: string; totalTtc: Prisma.Decimal | number }>(db: PrismaClient | Prisma.TransactionClient, factures: T[]) {
  const soldes = await soldesFactures(db, factures);
  return factures.map(facture => ({ ...facture, ...(soldes.get(facture.id) ?? { montantAvoirs: null, montantRegle: null, resteDu: null }) }));
}

// « Réglée » se déduit (choix par défaut, à confirmer) : reste dû nul ou négatif ET au moins un
// règlement non contre-passé ; une facture soldée par ses seuls avoirs reste « émise ». Recalculé
// après chaque événement qui change le reste dû (règlement, contre-passation, avoir partiel),
// sous le verrou de la facture déjà pris par l'appelant ; le trigger `facture_statut_reglements`
// refuse toute autre transition.
export async function synchroniserStatutReglement(tx: Prisma.TransactionClient, factureId: string, acteurId: string, cause: string) {
  const facture = await tx.facture.findUnique({ where: { id: factureId }, select: { id: true, type: true, statut: true, totalTtc: true } });
  if (!facture || facture.type !== 'FACTURE' || (facture.statut !== 'EMISE' && facture.statut !== 'REGLEE')) return;
  const solde = (await soldesFactures(tx, [facture])).get(facture.id)!;
  const cible = solde.resteDu <= 0 && solde.montantRegle > 0 ? 'REGLEE' : 'EMISE';
  if (cible === facture.statut) return;
  const maj = await tx.facture.updateMany({ where: { id: facture.id, type: 'FACTURE', statut: facture.statut }, data: { statut: cible } });
  if (maj.count !== 1) throw new Error('Statut de facture modifié pendant la transaction.');
  const reste = solde.resteDu < 0 ? `trop-perçu ${formatMontantFacture(-solde.resteDu)}` : `reste dû ${formatMontantFacture(solde.resteDu)}`;
  await tx.journalFacture.create({ data: { factureId: facture.id, acteurId, action: cible === 'REGLEE' ? 'REGLEMENT' : 'RETOUR_EMISE', detail: `Transition ${facture.statut} → ${cible} (${cause}) : réglé ${formatMontantFacture(solde.montantRegle)}, ${reste}` } });
}

// Centimes entiers : la somme des affectations se compare au montant sans erreur binaire.
export const centimesEntiers = (montant: number) => Math.round(montant * 100);

export function referenceReglementValide(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const reference = value.trim();
  if (!reference) return null;
  // Même métrique que PostgreSQL (char_length) et aucun caractère de contrôle.
  return [...reference].length <= 200 && !/[\u0000-\u001f\u007f]/.test(reference) ? reference : undefined;
}
