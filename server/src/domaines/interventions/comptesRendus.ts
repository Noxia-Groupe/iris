import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import type { AuthRequest } from '../../http/auth';
import { valeurJournal } from '../../commun/journal-administration';

// --- Comptes rendus, signatures dessinées et clôture des interventions (lot pilote 3b-3) ---

// Tracé de la signature (décision de Nelson du 19-10-2026) : vectoriel, coordonnées normalisées
// entre 0 et 1, sans horodatage ni pression, taille bornée. Bornes : choix par défaut, à confirmer.
// Une signature à main levée compte quelques centaines de points ; 2 000 points arrondis au
// dix-millième tiennent en une quarantaine de kilo-octets, sous la limite du corps JSON (100 ko).
export const TRACE_MAX_TRAITS = 50;
export const TRACE_MAX_POINTS = 2000;
const TRACE_DECIMALES = 4;
// Rapport largeur / hauteur de la zone de signature, pour redessiner le tracé sans le déformer.
const TRACE_RATIO_MIN = 0.5;
const TRACE_RATIO_MAX = 10;

export type TraceSignature = { ratio: number; traits: number[][][] };

const arrondir = (valeur: number, decimales: number) => {
  const facteur = 10 ** decimales;
  return Math.round(valeur * facteur) / facteur;
};
const coordonneeValide = (valeur: unknown): valeur is number => typeof valeur === 'number' && Number.isFinite(valeur) && valeur >= 0 && valeur <= 1;

// Rend la forme canonique du tracé (clés et arrondis fixes), ou null s'il est invalide. C'est elle
// qui est enregistrée et qui entre dans l'empreinte : un même dessin donne toujours la même empreinte.
export function traceSignatureValide(valeur: unknown): TraceSignature | null {
  if (!valeur || typeof valeur !== 'object' || Array.isArray(valeur)) return null;
  const { ratio, traits } = valeur as { ratio?: unknown; traits?: unknown };
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < TRACE_RATIO_MIN || ratio > TRACE_RATIO_MAX) return null;
  if (!Array.isArray(traits) || traits.length === 0 || traits.length > TRACE_MAX_TRAITS) return null;
  let points = 0;
  const canoniques: number[][][] = [];
  for (const trait of traits) {
    if (!Array.isArray(trait) || trait.length === 0) return null;
    points += trait.length;
    if (points > TRACE_MAX_POINTS) return null;
    const pointsDuTrait: number[][] = [];
    for (const point of trait) {
      if (!Array.isArray(point) || point.length !== 2 || !coordonneeValide(point[0]) || !coordonneeValide(point[1])) return null;
      pointsDuTrait.push([arrondir(point[0], TRACE_DECIMALES), arrondir(point[1], TRACE_DECIMALES)]);
    }
    canoniques.push(pointsDuTrait);
  }
  // Un point isolé n'est pas une signature : au moins un trait doit relier deux points distincts.
  const dessine = canoniques.some((trait) => trait.some(([x, y]) => x !== trait[0][0] || y !== trait[0][1]));
  return dessine ? { ratio: arrondir(ratio, 3), traits: canoniques } : null;
}

// L'empreinte SHA-256 identifie le texte signé, le signataire et le tracé. Elle n'est pas à elle seule
// une preuve cryptographique d'intégrité ni une signature qualifiée.
export function empreinteSignature(rapport: { id: string; contenu: string }, signataire: string, trace: TraceSignature): string {
  return crypto.createHash('sha256').update(`${rapport.id}\n${rapport.contenu}\n${signataire}\n${JSON.stringify(trace)}`, 'utf8').digest('hex');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function cleEnvoiValide(valeur: unknown): string | null {
  return typeof valeur === 'string' && UUID.test(valeur) ? valeur.toLowerCase() : null;
}

// Clôture sans signature du client (décisions de Nelson des 19 et 20-10-2026) : un motif parmi
// quatre, et une précision écrite courte pour « autre », consignés au journal.
export const MOTIFS_CLOTURE_SANS_SIGNATURE: Record<string, string> = {
  CLIENT_ABSENT: 'Client absent',
  REFUS_SIGNATURE: 'Refus de signer',
  SIGNATURE_IMPOSSIBLE: 'Signature impossible',
  AUTRE: 'Autre',
};
// Longueur de la précision : choix par défaut, à confirmer.
export const PRECISION_MOTIF_MIN = 3;
export const PRECISION_MOTIF_MAX = 200;

export type MotifCloture = { texte: string | null } | { erreur: string };

// Lit le motif d'une clôture sans signature. Absent, il rend { texte: null } : la route décide
// ensuite, sous verrou, s'il en fallait un.
export function motifClotureValide(motif: unknown, precision: unknown): MotifCloture {
  const precisionTexte = typeof precision === 'string' ? precision.trim() : '';
  if (motif === undefined || motif === null || motif === '') {
    return precisionTexte ? { erreur: 'Une précision accompagne seulement le motif « Autre ».' } : { texte: null };
  }
  if (typeof motif !== 'string' || !Object.prototype.hasOwnProperty.call(MOTIFS_CLOTURE_SANS_SIGNATURE, motif)) return { erreur: 'Motif de clôture sans signature invalide.' };
  if (precision !== undefined && precision !== null && typeof precision !== 'string') return { erreur: 'La précision du motif doit être un texte.' };
  if (motif !== 'AUTRE') {
    return precisionTexte ? { erreur: 'Une précision accompagne seulement le motif « Autre ».' } : { texte: `Clôture sans signature du client : ${MOTIFS_CLOTURE_SANS_SIGNATURE[motif]}` };
  }
  if (precisionTexte.length < PRECISION_MOTIF_MIN || precisionTexte.length > PRECISION_MOTIF_MAX) {
    return { erreur: `Le motif « Autre » exige une précision de ${PRECISION_MOTIF_MIN} à ${PRECISION_MOTIF_MAX} caractères.` };
  }
  return { texte: `Clôture sans signature du client : Autre — ${precisionTexte}` };
}

// Verrou de la ligne de l'intervention, relu avec son statut. Les ajouts (compte rendu, signature)
// le prennent en partage : ils ne se bloquent pas entre eux, mais attendent une clôture ou une
// annulation en cours, qui le prend en exclusif et relit les comptes rendus après eux.
export async function verrouillerIntervention(tx: Prisma.TransactionClient, interventionId: string, mode: 'FOR SHARE' | 'FOR UPDATE'): Promise<string | null> {
  const lignes = await tx.$queryRaw<Array<{ statut: string }>>(Prisma.sql`SELECT "statut" FROM "Intervention" WHERE "id" = ${interventionId} ${Prisma.raw(mode)}`);
  return lignes[0]?.statut ?? null;
}

export async function journaliserCompteRendu(tx: Prisma.TransactionClient, req: AuthRequest, cible: 'INTERVENTION_RAPPORT' | 'INTERVENTION_SIGNATURE', cibleId: string, interventionId: string, apres: unknown) {
  await tx.journalSaisieChantier.create({ data: {
    interventionId, cible, cibleId, action: 'CREATION', auteurId: req.user!.id, auteurNom: req.user!.name,
    apres: valeurJournal(apres) as Prisma.InputJsonValue,
  } });
}

export const RAPPORT_SELECT = { id: true, contenu: true, createdAt: true, auteur: { select: { name: true } } } as const;
export const SIGNATURE_SELECT = { id: true, signataire: true, empreinte: true, accepteLe: true, trace: true, enregistrePar: { select: { name: true } } } as const;
