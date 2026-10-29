import express from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { voitPrixAchatDevis } from '../../droits/visibilite';
import { FUSEAU_HORAIRE_PAR_DEFAUT, anneeEntreprise } from '../../commun/dates';
import { PLAFOND_MONTANT, tauxUtilises, tvaDuTaux, arrondiCommercialLigneHt, centimesTtcLigne, centimes } from '../../commun/montants';
import { nombreDecimalNonNegatif } from '../../commun/validation';
import { estTauxTvaFrancais, REFUS_TAUX_TVA } from '../../commun/tva';
import { getParametres } from '../parametres/metier';
import { getCompanySettings } from '../administration/metier';
import { type CatalogueFamily, catalogueFamily } from '../catalogue/metier';
import { type SaisieTempsPasse, drapeauDevisTempsPasse, lireLigneTempsPasse, resoudreLigneTempsPasse, REFUS_NATURE_LIGNE_EXISTANTE, REFUS_PRIX_ACHAT_TEMPS_PASSE, TempsPasseSaisieError } from './tempsPasse';

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
// Une ligne au temps passé porte en plus sa saisie (`tempsPasse`) : son prix est fixé à la résolution.
type ReferenceLigneDevis = { ligneId: string | null; catalogue: { famille: CatalogueFamily; id: string } | null; prixAchatUnitaireHt: number | null | undefined; tempsPasse?: SaisieTempsPasse };
// Ligne validée : une ligne au temps passé n'a ni prix, ni TVA, ni totaux avant sa résolution.
type LigneDevisValidee = { ordre: number; designation: string; nature: string; quantite: number; prixUnitaireHt: number | null; tauxTva: number | null; totalHt: number | null; totalTtc: number | null; unite: string | null };
// Prix d'achat prévu : facultatif ; `undefined` signifie « non transmis », null « effacé ».
function prixAchatSaisi(item: Record<string, unknown>): number | null | undefined {
  const prixAchatUnitaireHt = item.prixAchatUnitaireHt === undefined ? undefined
    : item.prixAchatUnitaireHt === null || item.prixAchatUnitaireHt === '' ? null
    : nombreDecimalNonNegatif(item.prixAchatUnitaireHt, 10, true);
  if (prixAchatUnitaireHt === null && item.prixAchatUnitaireHt !== null && item.prixAchatUnitaireHt !== '') throw new DevisSaisieError('Prix d’achat prévu invalide.');
  return prixAchatUnitaireHt;
}
// Totaux d'un devis depuis ses lignes chiffrées. Comme les factures et avoirs, la TVA est arrondie sur
// la base HT cumulée de chaque taux.
export function totauxDevis(lignes: { tauxTva: number; totalHt: number }[]) {
  const totalHt = centimes(lignes.reduce((t, l) => t + l.totalHt, 0));
  const totalTva = centimes(tauxUtilises(lignes).reduce((total, taux) => total + tvaDuTaux(lignes, taux), 0));
  const totalTtc = centimes(totalHt + totalTva);
  if (totalTtc > PLAFOND_MONTANT) throw new DevisSaisieError('Montant de devis hors des limites acceptées.');
  return { totalHt, totalTva, totalTtc };
}
export function devisPayload(body: Record<string, unknown>) {
  const clientId = String(body.clientId || '').trim(), objet = String(body.objet || '').trim();
  const lignes = Array.isArray(body.lignes) ? body.lignes : [];
  if (!clientId || !objet || objet.length > 300 || !lignes.length) throw new DevisSaisieError('Client, objet et au moins une ligne sont requis.');
  // Marqueur du devis au temps passé : absent, un PATCH garde celui du devis (cf. modifierDevis).
  const auTempsPasse = drapeauDevisTempsPasse(body.auTempsPasse);
  const references: ReferenceLigneDevis[] = [];
  const lignesCalculees = lignes.map((ligne, ordre): LigneDevisValidee => {
    const item = (ligne && typeof ligne === 'object' ? ligne : {}) as Record<string, unknown>, designation = String(item.designation || '').trim(), nature = String(item.nature || 'MAIN_OEUVRE');
    const ligneId = item.ligneId === undefined || item.ligneId === null ? null : String(item.ligneId);
    const lireCatalogue = (): ReferenceLigneDevis['catalogue'] => {
      if (item.catalogueFamille === undefined || item.catalogueFamille === null) return null;
      const famille = catalogueFamily(String(item.catalogueFamille));
      const id = typeof item.catalogueId === 'string' ? item.catalogueId.trim() : '';
      if (!famille || !id) throw new DevisSaisieError('Fiche catalogue de la ligne invalide.');
      return { famille, id };
    };
    // Ligne « main d'œuvre au temps passé » : son prix, sa TVA et ses totaux viennent de la main
    // d'œuvre, à la résolution (resoudreLignesDevis).
    if (item.tempsPasse !== undefined && item.tempsPasse !== null && item.tempsPasse !== false) {
      const catalogue = lireCatalogue();
      const tempsPasse = lireLigneTempsPasse(item, ligneId, catalogue)!;
      if (!designation || designation.length > 500) throw new DevisSaisieError('Ligne de devis invalide.');
      const prixAchatUnitaireHt = prixAchatSaisi(item);
      if (prixAchatUnitaireHt !== undefined && prixAchatUnitaireHt !== null) throw new TempsPasseSaisieError(REFUS_PRIX_ACHAT_TEMPS_PASSE);
      references.push({ ligneId, catalogue, prixAchatUnitaireHt, tempsPasse: tempsPasse.saisie });
      return { ordre, designation, nature: 'MAIN_OEUVRE', quantite: tempsPasse.quantite, prixUnitaireHt: null, tauxTva: null, totalHt: null, totalTtc: null, unite: null };
    }
    // Mêmes échelles que les factures : le calcul entier ne doit jamais recevoir une précision
    // que ses unités (millièmes / centimes) ne représentent pas.
    const quantite = nombreDecimalNonNegatif(item.quantite, 9, false, 3);
    const prixUnitaireHt = nombreDecimalNonNegatif(item.prixUnitaireHt, 10, true);
    const tauxTva = item.tauxTva === undefined || item.tauxTva === null ? 20 : nombreDecimalNonNegatif(item.tauxTva, 3, true);
    const unite = item.unite === undefined || item.unite === null ? null : String(item.unite).trim() || null;
    if (!['MAIN_OEUVRE', 'FOURNITURE'].includes(nature) || !designation || designation.length > 500 || quantite === null || quantite <= 0 || prixUnitaireHt === null || tauxTva === null || tauxTva > 100 || (unite !== null && unite.length > 40)) throw new DevisSaisieError('Ligne de devis invalide.');
    if (!estTauxTvaFrancais(tauxTva)) throw new DevisSaisieError(REFUS_TAUX_TVA);
    const totalHt = arrondiCommercialLigneHt(quantite, prixUnitaireHt);
    const totalTtc = centimesTtcLigne(totalHt, tauxTva);
    // Même plafond que les factures : au-delà, la colonne Decimal(12, 2) refuserait le montant.
    if (totalTtc > PLAFOND_MONTANT) throw new DevisSaisieError('Montant de ligne hors des limites acceptées.');
    const prixAchatUnitaireHt = prixAchatSaisi(item);
    const catalogue = lireCatalogue();
    references.push({ ligneId, catalogue, prixAchatUnitaireHt });
    return { ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc, unite };
  });
  // Les totaux d'un devis qui porte une ligne au temps passé ne se connaissent qu'une fois son prix
  // fixé par le serveur : les routes les calculent toujours sur les lignes résolues (totauxDevis).
  const totaux = lignesCalculees.some((ligne) => ligne.totalHt === null) ? { totalHt: null, totalTva: null, totalTtc: null }
    : totauxDevis(lignesCalculees as { tauxTva: number; totalHt: number }[]);
  return { clientId, objet, auTempsPasse, lignesCalculees, references, ...totaux };
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

type LigneDevisExistante = {
  id: string; reference: string | null; catalogueFamille: string | null; catalogueId: string | null; prixAchatUnitaireHt: Prisma.Decimal | null;
  tempsPasse: boolean; tarifTempsPasse: string | null; prixUnitaireHt: Prisma.Decimal; tauxTva: Prisma.Decimal;
};
// Résout la copie du catalogue et le prix d'achat prévu de chaque ligne saisie :
//  - une ligne existante du devis (`ligneId`) garde sa fiche d'origine et sa référence, copiées
//    à son ajout : modifier ou désactiver la fiche ensuite n'y change rien ;
//  - une nouvelle ligne reprise du catalogue exige une fiche existante et active, dont la
//    référence est recopiée par le serveur ;
//  - le prix d'achat prévu n'est écrit que par un administrateur. Sinon, une ligne existante
//    garde le sien, et une nouvelle ligne du catalogue reprend celui de la fiche ;
//  - la ligne au temps passé prend le prix, la TVA et la référence de sa main d'œuvre à son ajout,
//    puis les garde (./tempsPasse.ts) ; une ligne existante ne change pas de nature.
// Les lignes rendues sont toutes chiffrées : les totaux du devis se calculent dessus (totauxDevis).
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
    let existante: LigneDevisExistante | null = null;
    if (reference.ligneId) {
      existante = parId.get(reference.ligneId) ?? null;
      if (!existante || vues.has(reference.ligneId)) throw new DevisSaisieError('Ligne de devis inconnue : rechargez le devis.');
      vues.add(reference.ligneId);
      if (existante.tempsPasse !== !!reference.tempsPasse) throw new TempsPasseSaisieError(REFUS_NATURE_LIGNE_EXISTANTE);
    }
    if (reference.tempsPasse) {
      lignes.push(await resoudreLigneTempsPasse(db, ligne, reference.tempsPasse, reference.catalogue, existante));
      continue;
    }
    let copie: { reference: string | null; catalogueFamille: string | null; catalogueId: string | null; prixAchatUnitaireHt: Prisma.Decimal | number | null };
    if (existante) {
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
    // Une ligne ordinaire est déjà chiffrée par devisPayload.
    lignes.push({ ...ligne, prixUnitaireHt: ligne.prixUnitaireHt!, tauxTva: ligne.tauxTva!, totalHt: ligne.totalHt!, totalTtc: ligne.totalTtc!, ...copie, tempsPasse: false, tarifTempsPasse: null });
  }
  return lignes;
}

// La signature exposée par les réponses JSON (session et clés d'intégration) garde les champs
// d'avant le lot 6a-2 : les copies prises à la signature (identité, client, adresse de
// facturation, fuseau) ne servent qu'au PDF, réservé aux sessions. Une clé « devis:read » ne
// lit pas ainsi l'adresse d'un client, que seul le scope « clients:read » lui ouvre.
const SIGNATURE_DEVIS_EXPOSEE = { id: true, devisId: true, enregistreParId: true, signataire: true, empreinte: true, signeLe: true } as const;
// Les conversions du devis (lot 4 suite : deux au plus, de types différents), dans leur ordre.
export const devisInclude = { lignes: { orderBy: { ordre: 'asc' as const } }, client: true, conversions: { orderBy: { rang: 'asc' as const } }, signature: { select: SIGNATURE_DEVIS_EXPOSEE } };
function montantDevisFige(value: Prisma.Decimal | number | string | null, decimales: number): string | null {
  return value === null ? null : new Prisma.Decimal(value).toFixed(decimales);
}
export function contenuDevisSigne(devis: {
  id: string; dossierId: string; numero: string; version: number; clientId: string; objet: string;
  acompteExige: boolean; tauxAcompte: Prisma.Decimal | null; totalHt: Prisma.Decimal; totalTva: Prisma.Decimal; totalTtc: Prisma.Decimal;
  auTempsPasse: boolean; pasTempsPasseMinutes: number | null; tempsMinimumMinutes: number | null;
  lignes: { ordre: number; designation: string; nature: string; reference: string | null; unite: string | null; quantite: Prisma.Decimal; prixUnitaireHt: Prisma.Decimal; tauxTva: Prisma.Decimal; totalHt: Prisma.Decimal; totalTtc: Prisma.Decimal; tempsPasse: boolean; tarifTempsPasse: string | null }[];
}) {
  // Le prix d'achat prévu, donnée interne, n'entre jamais dans ce que le client signe. Le marqueur et
  // le pas d'un devis au temps passé, et le tarif de sa ligne au temps passé, y entrent ; ils ne
  // figurent pas dans le contenu d'un devis ordinaire, dont l'empreinte reste celle d'avant ce lot. Le
  // temps minimum facturé y entre depuis le lot « facture au temps passé », sauf sur un devis antérieur
  // (minimum vide), dont le contenu reste celui d'alors.
  return {
    devisId: devis.id, dossierId: devis.dossierId, numero: devis.numero, version: devis.version,
    clientId: devis.clientId, objet: devis.objet, acompteExige: devis.acompteExige,
    tauxAcompte: montantDevisFige(devis.tauxAcompte, 2), totalHt: montantDevisFige(devis.totalHt, 2),
    totalTva: montantDevisFige(devis.totalTva, 2), totalTtc: montantDevisFige(devis.totalTtc, 2),
    ...(devis.auTempsPasse ? { auTempsPasse: true, pasTempsPasseMinutes: devis.pasTempsPasseMinutes } : {}),
    ...(devis.auTempsPasse && devis.tempsMinimumMinutes !== null ? { tempsMinimumMinutes: devis.tempsMinimumMinutes } : {}),
    lignes: devis.lignes.map(ligne => ({
      ordre: ligne.ordre, designation: ligne.designation, nature: ligne.nature, reference: ligne.reference, unite: ligne.unite,
      quantite: montantDevisFige(ligne.quantite, 3), prixUnitaireHt: montantDevisFige(ligne.prixUnitaireHt, 2),
      tauxTva: montantDevisFige(ligne.tauxTva, 2), totalHt: montantDevisFige(ligne.totalHt, 2), totalTtc: montantDevisFige(ligne.totalTtc, 2),
      ...(ligne.tempsPasse ? { tempsPasse: true, tarifTempsPasse: ligne.tarifTempsPasse } : {}),
    })),
  };
}
// Copie à l'identique d'une ligne (révision, duplication) : la copie du catalogue, le prix
// d'achat prévu et la ligne au temps passé (son tarif et son prix figés) suivent, comme les montants.
export function copieLigneDevis({ ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc, unite, reference, catalogueFamille, catalogueId, prixAchatUnitaireHt, tempsPasse, tarifTempsPasse }: {
  ordre: number; designation: string; nature: string; quantite: Prisma.Decimal; prixUnitaireHt: Prisma.Decimal; tauxTva: Prisma.Decimal; totalHt: Prisma.Decimal; totalTtc: Prisma.Decimal;
  unite: string | null; reference: string | null; catalogueFamille: string | null; catalogueId: string | null; prixAchatUnitaireHt: Prisma.Decimal | null;
  tempsPasse: boolean; tarifTempsPasse: string | null;
}) {
  return { ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc, unite, reference, catalogueFamille, catalogueId, prixAchatUnitaireHt, tempsPasse, tarifTempsPasse };
}
export async function verrouillerDevis(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
  const lignes = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "Devis" WHERE "id" = ${id} FOR UPDATE`);
  return lignes.length === 1;
}
export async function acompteDevisPayload(body: Record<string, unknown>, precedent?: { acompteExige: boolean; tauxAcompte: Prisma.Decimal | null; acompteRecuLe: Date | null }) {
  // Après encaissement, les conditions qui ont déclenché celui-ci constituent une preuve :
  // elles sont reprises telles quelles, même si le formulaire réémet des valeurs différentes.
  if (precedent?.acompteRecuLe) return { acompteExige: precedent.acompteExige, tauxAcompte: precedent.tauxAcompte };
  const acompteExige = precedent && !Object.hasOwn(body, 'acompteExige') ? precedent.acompteExige : !!body.acompteExige;
  const { tauxAcompteDefaut } = await getParametres();
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
