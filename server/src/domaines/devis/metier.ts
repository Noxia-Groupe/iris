import express from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { voitPrixAchatDevis } from '../../droits/visibilite';
import { FUSEAU_HORAIRE_PAR_DEFAUT, anneeEntreprise } from '../../commun/dates';
import { PLAFOND_MONTANT, tauxUtilises, tvaDuTaux, arrondiCommercialLigneHt, centimesTtcLigne, centimes } from '../../commun/montants';
import { nombreDecimalNonNegatif } from '../../commun/validation';
import { getCompanySettings } from '../administration/metier';
import { type CatalogueFamily, catalogueFamily } from '../catalogue/metier';

// Référence d'affaire portée par le chantier : celle du devis Iris dont il est issu
// (A26-0001), attribuée par la séquence annuelle à la création du devis et recopiée
// telle quelle par la conversion. Le format est donc celui qu'Iris émet lui-même —
// `nouveauNumeroDevis()` en est la seule source. La saisie reste normalisée (espaces
// retirés, minuscule acceptée) pour qu'une référence recopiée à la main soit acceptée.
const FORMAT_NUMERO_DEVIS = /^A\d{2}-\d{4,}$/;

export function normaliserNumeroDevis(valeur: unknown): string {
  return String(valeur ?? '').trim().toUpperCase();
}

// Retourne un message d'erreur si la référence est absente ou mal formée, sinon null.
export function erreurNumeroDevis(numeroDevis: string): string | null {
  if (!numeroDevis) return 'Veuillez saisir la référence d’affaire.';
  if (!FORMAT_NUMERO_DEVIS.test(numeroDevis)) {
    return 'La référence d’affaire doit être au format AAA-NNNN : un A, l’année sur deux chiffres, un tiret et le rang (exemple : A26-0001).';
  }
  return null;
}

// Vérifie qu'aucun AUTRE chantier ne porte déjà cette référence. Le contrôle est
// volontairement applicatif et non porté par un index unique en base : un chantier peut
// couvrir deux affaires du même client, et un index rendrait ces cas immodifiables. La
// règle ne s'applique donc qu'aux références nouvellement saisies.
export async function numeroDevisDejaPris(numeroDevis: string, chantierIdExclu?: string): Promise<boolean> {
  const existant = await prisma.chantier.findFirst({ where: { numeroDevis }, select: { id: true } });
  return !!existant && existant.id !== chantierIdExclu;
}

// --- Devis natifs versionnés ---
export class DevisSaisieError extends Error {}
// Refus qui ne vient pas de la saisie mais de l'état de l'affaire : la requête est bien
// formée, c'est le monde qui s'y oppose. 409, pas 400.
export class DevisConflitError extends Error {}
// Requête bien formée, mais réservée à d'autres comptes (prix d'achat prévu) : 403.
export class DevisDroitError extends Error {}

// Demande de reprise du catalogue, ou de conservation d'une ligne existante, portée par une
// ligne saisie. `devisPayload` ne fait que la valider ; `resoudreLignesDevis` la résout en base.
type ReferenceLigneDevis = { ligneId: string | null; catalogue: { famille: CatalogueFamily; id: string } | null; prixAchatUnitaireHt: number | null | undefined };
export function devisPayload(body: Record<string, unknown>) {
  const clientId = String(body.clientId || '').trim(), objet = String(body.objet || '').trim();
  const lignes = Array.isArray(body.lignes) ? body.lignes : [];
  if (!clientId || !objet || objet.length > 300 || !lignes.length) throw new DevisSaisieError('Client, objet et au moins une ligne sont requis.');
  const references: ReferenceLigneDevis[] = [];
  const lignesCalculees = lignes.map((ligne, ordre) => {
    const item = (ligne && typeof ligne === 'object' ? ligne : {}) as Record<string, unknown>, designation = String(item.designation || '').trim(), nature = String(item.nature || 'MAIN_OEUVRE');
    // Mêmes échelles que les factures : le calcul entier ne doit jamais recevoir une précision
    // que ses unités (millièmes / centimes) ne représentent pas.
    const quantite = nombreDecimalNonNegatif(item.quantite, 9, false, 3);
    const prixUnitaireHt = nombreDecimalNonNegatif(item.prixUnitaireHt, 10, true);
    const tauxTva = item.tauxTva === undefined || item.tauxTva === null ? 20 : nombreDecimalNonNegatif(item.tauxTva, 3, true);
    const unite = item.unite === undefined || item.unite === null ? null : String(item.unite).trim() || null;
    if (!['MAIN_OEUVRE', 'FOURNITURE'].includes(nature) || !designation || designation.length > 500 || quantite === null || quantite <= 0 || prixUnitaireHt === null || tauxTva === null || tauxTva > 100 || (unite !== null && unite.length > 40)) throw new DevisSaisieError('Ligne de devis invalide.');
    const totalHt = arrondiCommercialLigneHt(quantite, prixUnitaireHt);
    const totalTtc = centimesTtcLigne(totalHt, tauxTva);
    // Même plafond que les factures : au-delà, la colonne Decimal(12, 2) refuserait le montant.
    if (totalTtc > PLAFOND_MONTANT) throw new DevisSaisieError('Montant de ligne hors des limites acceptées.');
    // Prix d'achat prévu : facultatif ; `undefined` signifie « non transmis », null « effacé ».
    const prixAchatUnitaireHt = item.prixAchatUnitaireHt === undefined ? undefined
      : item.prixAchatUnitaireHt === null || item.prixAchatUnitaireHt === '' ? null
      : nombreDecimalNonNegatif(item.prixAchatUnitaireHt, 10, true);
    if (prixAchatUnitaireHt === null && item.prixAchatUnitaireHt !== null && item.prixAchatUnitaireHt !== '') throw new DevisSaisieError('Prix d’achat prévu invalide.');
    const ligneId = item.ligneId === undefined || item.ligneId === null ? null : String(item.ligneId);
    let catalogue: ReferenceLigneDevis['catalogue'] = null;
    if (item.catalogueFamille !== undefined && item.catalogueFamille !== null) {
      const famille = catalogueFamily(String(item.catalogueFamille));
      const id = typeof item.catalogueId === 'string' ? item.catalogueId.trim() : '';
      if (!famille || !id) throw new DevisSaisieError('Fiche catalogue de la ligne invalide.');
      catalogue = { famille, id };
    }
    references.push({ ligneId, catalogue, prixAchatUnitaireHt });
    return { ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc, unite };
  });
  const totalHt = centimes(lignesCalculees.reduce((t, l) => t + l.totalHt, 0));
  // Comme les factures et avoirs, la TVA est arrondie sur la base HT cumulée de chaque taux.
  const totalTva = centimes(tauxUtilises(lignesCalculees).reduce((total, taux) => total + tvaDuTaux(lignesCalculees, taux), 0));
  const totalTtc = centimes(totalHt + totalTva);
  if (totalTtc > PLAFOND_MONTANT) throw new DevisSaisieError('Montant de devis hors des limites acceptées.');
  return { clientId, objet, lignesCalculees, references, totalHt, totalTva, totalTtc };
}

// --- Catalogue dans les devis (lot pilote 2, décision A8 du 16-10-2026) ---
// Nature de ligne proposée selon la famille de la fiche (choix par défaut, à confirmer) : une
// prestation est de la main-d'œuvre, un article ou un équipement une fourniture.
export const NATURE_DEVIS_PAR_FAMILLE: Record<CatalogueFamily, 'MAIN_OEUVRE' | 'FOURNITURE'> = { prestations: 'MAIN_OEUVRE', articles: 'FOURNITURE', equipements: 'FOURNITURE' };

// Retire le prix d'achat prévu de toutes les lignes d'un devis, ou d'une liste de devis.
export function devisPourLecteur<T>(req: express.Request, valeur: T): T {
  if (voitPrixAchatDevis(req)) return valeur;
  const masquer = (devis: unknown): unknown => {
    if (!devis || typeof devis !== 'object' || !Array.isArray((devis as { lignes?: unknown }).lignes)) return devis;
    return { ...(devis as object), lignes: (devis as { lignes: Record<string, unknown>[] }).lignes.map(({ prixAchatUnitaireHt: _masque, ...ligne }) => ligne) };
  };
  return (Array.isArray(valeur) ? valeur.map(masquer) : masquer(valeur)) as T;
}

type LigneDevisExistante = { id: string; reference: string | null; catalogueFamille: string | null; catalogueId: string | null; prixAchatUnitaireHt: Prisma.Decimal | null };
// Résout la copie du catalogue et le prix d'achat prévu de chaque ligne saisie :
//  - une ligne existante du devis (`ligneId`) garde sa fiche d'origine et sa référence, copiées
//    à son ajout : modifier ou désactiver la fiche ensuite n'y change rien ;
//  - une nouvelle ligne reprise du catalogue exige une fiche existante et active, dont la
//    référence est recopiée par le serveur ;
//  - le prix d'achat prévu n'est écrit que par un administrateur. Sinon, une ligne existante
//    garde le sien, et une nouvelle ligne du catalogue reprend celui de la fiche.
export async function resoudreLignesDevis(
  db: Prisma.TransactionClient | typeof prisma,
  payload: ReturnType<typeof devisPayload>,
  existantes: LigneDevisExistante[],
  ecritPrixAchat: boolean,
) {
  if (!ecritPrixAchat && payload.references.some((r) => r.prixAchatUnitaireHt !== undefined)) {
    throw new DevisDroitError('Le prix d’achat prévu est réservé aux administrateurs.');
  }
  const parId = new Map(existantes.map((ligne) => [ligne.id, ligne]));
  const vues = new Set<string>();
  const lignes = [];
  for (const [index, ligne] of payload.lignesCalculees.entries()) {
    const reference = payload.references[index];
    let copie: { reference: string | null; catalogueFamille: string | null; catalogueId: string | null; prixAchatUnitaireHt: Prisma.Decimal | number | null };
    if (reference.ligneId) {
      const existante = parId.get(reference.ligneId);
      if (!existante || vues.has(reference.ligneId)) throw new DevisSaisieError('Ligne de devis inconnue : rechargez le devis.');
      vues.add(reference.ligneId);
      copie = { reference: existante.reference, catalogueFamille: existante.catalogueFamille, catalogueId: existante.catalogueId, prixAchatUnitaireHt: existante.prixAchatUnitaireHt };
    } else if (reference.catalogue) {
      // Lue par `db`, donc dans la transaction verrouillée de la modification, et non par le client global.
      const delegues = { prestations: db.cataloguePrestation, articles: db.catalogueArticle, equipements: db.catalogueEquipement };
      const fiche = await (delegues[reference.catalogue.famille] as unknown as { findUnique: (args: unknown) => Promise<{ reference: string; actif: boolean; prixAchatHt: Prisma.Decimal | null } | null> })
        .findUnique({ where: { id: reference.catalogue.id }, select: { reference: true, actif: true, prixAchatHt: true } });
      if (!fiche || !fiche.actif) throw new DevisSaisieError('Fiche catalogue introuvable ou désactivée.');
      copie = { reference: fiche.reference, catalogueFamille: reference.catalogue.famille, catalogueId: reference.catalogue.id, prixAchatUnitaireHt: fiche.prixAchatHt };
    } else {
      copie = { reference: null, catalogueFamille: null, catalogueId: null, prixAchatUnitaireHt: null };
    }
    if (ecritPrixAchat && reference.prixAchatUnitaireHt !== undefined) copie.prixAchatUnitaireHt = reference.prixAchatUnitaireHt;
    lignes.push({ ...ligne, ...copie });
  }
  return lignes;
}

export const devisInclude = { lignes: { orderBy: { ordre: 'asc' as const } }, client: true, conversion: true, signature: true };
function montantDevisFige(value: Prisma.Decimal | number | string | null, decimales: number): string | null {
  return value === null ? null : new Prisma.Decimal(value).toFixed(decimales);
}
export function contenuDevisSigne(devis: {
  id: string; dossierId: string; numero: string; version: number; clientId: string; objet: string;
  acompteExige: boolean; tauxAcompte: Prisma.Decimal | null; totalHt: Prisma.Decimal; totalTva: Prisma.Decimal; totalTtc: Prisma.Decimal;
  lignes: { ordre: number; designation: string; nature: string; reference: string | null; unite: string | null; quantite: Prisma.Decimal; prixUnitaireHt: Prisma.Decimal; tauxTva: Prisma.Decimal; totalHt: Prisma.Decimal; totalTtc: Prisma.Decimal }[];
}) {
  // Le prix d'achat prévu, donnée interne, n'entre jamais dans ce que le client signe.
  return {
    devisId: devis.id, dossierId: devis.dossierId, numero: devis.numero, version: devis.version,
    clientId: devis.clientId, objet: devis.objet, acompteExige: devis.acompteExige,
    tauxAcompte: montantDevisFige(devis.tauxAcompte, 2), totalHt: montantDevisFige(devis.totalHt, 2),
    totalTva: montantDevisFige(devis.totalTva, 2), totalTtc: montantDevisFige(devis.totalTtc, 2),
    lignes: devis.lignes.map(ligne => ({
      ordre: ligne.ordre, designation: ligne.designation, nature: ligne.nature, reference: ligne.reference, unite: ligne.unite,
      quantite: montantDevisFige(ligne.quantite, 3), prixUnitaireHt: montantDevisFige(ligne.prixUnitaireHt, 2),
      tauxTva: montantDevisFige(ligne.tauxTva, 2), totalHt: montantDevisFige(ligne.totalHt, 2), totalTtc: montantDevisFige(ligne.totalTtc, 2),
    })),
  };
}
// Copie à l'identique d'une ligne (révision, duplication) : la copie du catalogue et le prix
// d'achat prévu suivent, comme les montants.
export function copieLigneDevis({ ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc, unite, reference, catalogueFamille, catalogueId, prixAchatUnitaireHt }: {
  ordre: number; designation: string; nature: string; quantite: Prisma.Decimal; prixUnitaireHt: Prisma.Decimal; tauxTva: Prisma.Decimal; totalHt: Prisma.Decimal; totalTtc: Prisma.Decimal;
  unite: string | null; reference: string | null; catalogueFamille: string | null; catalogueId: string | null; prixAchatUnitaireHt: Prisma.Decimal | null;
}) {
  return { ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc, unite, reference, catalogueFamille, catalogueId, prixAchatUnitaireHt };
}
export async function verrouillerDevis(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
  const lignes = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "Devis" WHERE "id" = ${id} FOR UPDATE`);
  return lignes.length === 1;
}
// Le taux par défaut est lu par l'appelant avant sa transaction (#240) : lu pendant celle-ci par le
// client global, il réclamait une seconde connexion du pool en gardant la première, et des
// modifications simultanées l'épuisaient jusqu'à l'expiration.
export function acompteDevisPayload(body: Record<string, unknown>, tauxAcompteDefaut: number, precedent?: { acompteExige: boolean; tauxAcompte: Prisma.Decimal | null; acompteRecuLe: Date | null }) {
  // Après encaissement, les conditions qui ont déclenché celui-ci constituent une preuve :
  // elles sont reprises telles quelles, même si le formulaire réémet des valeurs différentes.
  if (precedent?.acompteRecuLe) return { acompteExige: precedent.acompteExige, tauxAcompte: precedent.tauxAcompte };
  const acompteExige = precedent && !Object.hasOwn(body, 'acompteExige') ? precedent.acompteExige : !!body.acompteExige;
  const tauxAcompte = acompteExige
    // Un PATCH portant sur les lignes ou l'objet ne renégocie pas silencieusement le taux.
    ? (Object.hasOwn(body, 'tauxAcompte')
      ? (nombreDecimalNonNegatif(body.tauxAcompte, 3) ?? Number(tauxAcompteDefaut))
      : (precedent?.acompteExige ? precedent.tauxAcompte : null) ?? Number(tauxAcompteDefaut))
    : null;
  if (tauxAcompte !== null && Number(tauxAcompte) > 100) throw new DevisSaisieError('Le taux d’acompte ne peut pas dépasser 100 %.');
  return { acompteExige, tauxAcompte };
}
export async function nouveauNumeroDevis() {
  const societe = await getCompanySettings();
  const annee = anneeEntreprise(new Date(), societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);
  const [sequence] = await prisma.$queryRaw<{ dernierNumero: number }[]>(Prisma.sql`INSERT INTO "SequenceAffaire" ("annee", "dernierNumero") VALUES (${annee}, 1) ON CONFLICT ("annee") DO UPDATE SET "dernierNumero" = "SequenceAffaire"."dernierNumero" + 1 RETURNING "dernierNumero"`);
  return `A${String(annee).slice(-2)}-${String(sequence.dernierNumero).padStart(4, '0')}`;
}
