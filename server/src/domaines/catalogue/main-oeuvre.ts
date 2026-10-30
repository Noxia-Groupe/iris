import express from 'express';
import { Prisma } from '@prisma/client';
import { prisma, transactionVerifiee } from '../../db';
import type { AuthRequest } from '../../http/auth';
import type { ApiRequest } from '../../http/cles-api';
import { nombreDecimalNonNegatif } from '../../commun/validation';
import { changementsJournal, journaliserAdministration } from '../../commun/journal-administration';
import { cataloguePayload, catalogueExtraPayload, champsCommunsCatalogue } from './metier';

// --- Main d'œuvre au catalogue (décisions de Nelson du 24-10-2026) ---
// « Dans le catalogue » : une prestation du catalogue par main d'œuvre, avec quatre prix et la
// distinction contrat / hors contrat ; « Par main d'œuvre » : chaque main d'œuvre porte son nombre
// d'heures par jour. Ces prix sont des PRIX DE VENTE, jamais des coûts : le coût reste le taux
// horaire chargé de l'intervenant (décision 26 du 24-10-2026).
//
// Choix par défaut, à confirmer :
//  - le prix de vente existant (`prixVenteHt`) est le prix à l'heure hors contrat, l'unité l'heure ;
//  - quatre prix obligatoires, positifs ou nuls, au centime ; heures par jour strictement positives,
//    24 au plus, au quart d'heure près ; ni prix d'achat ni durée indicative ;
//  - écriture réservée à l'administration en session (requireAdmin, comme tout le catalogue) :
//    aucune clé d'intégration ne crée, ne modifie, ne désactive ni ne réactive une main d'œuvre, ni ne
//    fait passer une prestation en main d'œuvre ou l'inverse (403) ; la lecture par clé reste possible ;
//  - chaque création, modification, désactivation ou réactivation est écrite au journal des
//    paramètres et des droits, avec l'auteur, l'avant et l'après, dans la même transaction.
// Les autres prestations gardent leur comportement, sans journal.
//
// Lot « budget et heures prévues du chantier », troisième PR (réponse de Nelson du 30-10-2026, « Prix à
// part ») : deux prix de vente de plus, la demi-journée hors contrat et sous contrat, pour la ligne de devis
// à la demi-journée. Choix par défaut, à confirmer (le plus simple) : facultatifs à la création comme à la
// modification ; vides, la main d'œuvre ne se vend pas à la demi-journée (le devis le refuse). Mêmes règles
// de saisie que les quatre autres prix quand ils sont renseignés, même journal, mêmes droits ; refusés pour
// une prestation ordinaire. La modification remplaçant la fiche entière, un prix absent du corps est vidé.

export const UNITE_MAIN_OEUVRE = 'heure';
const CHAMPS_PROPRES_MAIN_OEUVRE = ['prixJourHorsContratHt', 'prixHeureSousContratHt', 'prixJourSousContratHt', 'heuresParJour', 'prixDemiJourneeHorsContratHt', 'prixDemiJourneeSousContratHt'] as const;
type ChampPrix = 'prixVenteHt' | 'prixJourHorsContratHt' | 'prixHeureSousContratHt' | 'prixJourSousContratHt' | 'prixDemiJourneeHorsContratHt' | 'prixDemiJourneeSousContratHt';
const LIBELLES_PRIX: Record<ChampPrix, string> = {
  prixVenteHt: 'Prix de vente HT à l’heure, hors contrat',
  prixJourHorsContratHt: 'Prix de vente HT au forfait jour, hors contrat',
  prixHeureSousContratHt: 'Prix de vente HT à l’heure, sous contrat',
  prixJourSousContratHt: 'Prix de vente HT au forfait jour, sous contrat',
  prixDemiJourneeHorsContratHt: 'Prix de vente HT à la demi-journée, hors contrat',
  prixDemiJourneeSousContratHt: 'Prix de vente HT à la demi-journée, sous contrat',
};
export const REFUS_CLE_MAIN_OEUVRE = 'Une clé d’intégration ne crée, ne modifie, ne désactive ni ne réactive une main d’œuvre, et ne fait pas passer une prestation en main d’œuvre ou l’inverse : réservé à l’administration, en session.';
const REFUS_CHAMPS_ORDINAIRE = 'Ces prix (heure, forfait jour, demi-journée) et ces heures par jour ne concernent qu’une main d’œuvre (« estMainOeuvre »).';

// Refus métier d'une écriture du catalogue, avec son statut HTTP (403, 404, 409). Les autres
// erreurs sans code restent des saisies refusées (400).
export class RefusCatalogue extends Error {
  constructor(readonly statut: number, message: string) { super(message); }
}

const renseigne = (valeur: unknown) => valeur !== undefined && valeur !== null && !(typeof valeur === 'string' && valeur.trim() === '');
const estCleIntegration = (req: express.Request) => !!(req as ApiRequest).apiKey;

// Le corps vise-t-il une main d'œuvre ? Drapeau autre qu'absent ou faux, ou l'un de ses champs propres
// renseigné. Sert au refus des clés d'intégration, avant toute validation.
function corpsMainOeuvre(body: Record<string, unknown>) {
  const drapeau = body.estMainOeuvre;
  return (drapeau !== undefined && drapeau !== null && drapeau !== false) || champsPropresRenseignes(body);
}
function champsPropresRenseignes(body: Record<string, unknown>) {
  return CHAMPS_PROPRES_MAIN_OEUVRE.some((champ) => renseigne(body[champ]));
}

// Drapeau demandé : absent (garder la nature actuelle), vrai ou faux ; toute autre valeur est refusée.
function estMainOeuvreDemande(body: Record<string, unknown>): boolean | undefined {
  const valeur = body.estMainOeuvre;
  if (valeur === undefined || valeur === null) return undefined;
  if (typeof valeur !== 'boolean') throw new Error('« estMainOeuvre » doit valoir true ou false.');
  return valeur;
}

function prixMainOeuvre(valeur: unknown, champ: ChampPrix): number {
  // Dix chiffres avant la virgule, deux après au plus, comme la colonne : PostgreSQL n'arrondit rien.
  const prix = nombreDecimalNonNegatif(valeur, 10, true);
  if (prix === null) throw new Error(`${LIBELLES_PRIX[champ]} : montant obligatoire, positif ou nul, au centime (deux décimales au plus).`);
  return prix;
}

// Prix de la demi-journée : vide (absent, null ou chaîne de blancs) pour ne pas la vendre, sinon la règle
// des quatre autres prix.
function prixDemiJourneeMainOeuvre(valeur: unknown, champ: ChampPrix): number | null {
  if (!renseigne(valeur)) return null;
  const prix = nombreDecimalNonNegatif(valeur, 10, true);
  if (prix === null) throw new Error(`${LIBELLES_PRIX[champ]} : montant facultatif, positif ou nul, au centime (deux décimales au plus) ; laissez-le vide pour ne pas vendre cette main d’œuvre à la demi-journée.`);
  return prix;
}

function heuresParJourMainOeuvre(valeur: unknown): number {
  const heures = nombreDecimalNonNegatif(valeur, 2, false);
  // Au plus deux décimales : en centièmes, le compte est exact. Un quart d'heure vaut 25 centièmes.
  if (heures === null || heures > 24 || Math.round(heures * 100) % 25 !== 0) {
    throw new Error('Heures par jour : nombre obligatoire, strictement positif, 24 au plus, au quart d’heure près (par exemple 7, 7,5 ou 7,75).');
  }
  return heures;
}

// Données d'une main d'œuvre : identité commune des prestations (référence unique, nom, description,
// catégorie, TVA) selon leurs règles actuelles, puis les quatre prix, les deux prix facultatifs de la
// demi-journée et les heures par jour.
export function payloadMainOeuvre(body: Record<string, unknown>) {
  const commun = champsCommunsCatalogue(body);
  const prix = {
    prixVenteHt: prixMainOeuvre(body.prixVenteHt, 'prixVenteHt'),
    prixJourHorsContratHt: prixMainOeuvre(body.prixJourHorsContratHt, 'prixJourHorsContratHt'),
    prixHeureSousContratHt: prixMainOeuvre(body.prixHeureSousContratHt, 'prixHeureSousContratHt'),
    prixJourSousContratHt: prixMainOeuvre(body.prixJourSousContratHt, 'prixJourSousContratHt'),
    prixDemiJourneeHorsContratHt: prixDemiJourneeMainOeuvre(body.prixDemiJourneeHorsContratHt, 'prixDemiJourneeHorsContratHt'),
    prixDemiJourneeSousContratHt: prixDemiJourneeMainOeuvre(body.prixDemiJourneeSousContratHt, 'prixDemiJourneeSousContratHt'),
  };
  const heuresParJour = heuresParJourMainOeuvre(body.heuresParJour);
  if (renseigne(body.unite) && String(body.unite).trim() !== UNITE_MAIN_OEUVRE) throw new Error('L’unité d’une main d’œuvre est l’heure.');
  if (renseigne(body.prixAchatHt)) throw new Error('Une main d’œuvre ne porte pas de prix d’achat : son coût est le taux horaire chargé de l’intervenant.');
  if (renseigne(body.dureeIndicativeMin)) throw new Error('Une main d’œuvre n’a pas de durée indicative : elle se vend à l’heure, au forfait jour ou à la demi-journée.');
  return { ...commun, ...prix, heuresParJour, estMainOeuvre: true, unite: UNITE_MAIN_OEUVRE, prixAchatHt: null, dureeIndicativeMin: null };
}

// Données d'une prestation ordinaire : règles inchangées, et aucun champ propre à la main d'œuvre.
function payloadPrestationOrdinaire(body: Record<string, unknown>) {
  const data = { ...cataloguePayload(body), ...catalogueExtraPayload('prestations', body) };
  if (champsPropresRenseignes(body)) throw new Error(REFUS_CHAMPS_ORDINAIRE);
  return data;
}

// --- Journal ---
type FichePrestation = Prisma.CataloguePrestationGetPayload<{ include: { categorie: true } }>;
const CHAMPS_JOURNAL = ['estMainOeuvre', 'reference', 'nom', 'description', 'categorie', 'tauxTva', 'prixVenteHt', 'prixJourHorsContratHt', 'prixHeureSousContratHt', 'prixJourSousContratHt', 'prixDemiJourneeHorsContratHt', 'prixDemiJourneeSousContratHt', 'heuresParJour', 'unite', 'prixAchatHt', 'dureeIndicativeMin', 'actif'] as const;
const CHAMPS_CREATION = ['reference', 'nom', 'description', 'categorie', 'tauxTva', 'prixVenteHt', 'prixJourHorsContratHt', 'prixHeureSousContratHt', 'prixJourSousContratHt', 'prixDemiJourneeHorsContratHt', 'prixDemiJourneeSousContratHt', 'heuresParJour', 'unite', 'actif'] as const;

// État journalisé : la catégorie par son nom, lisible dans le journal, plutôt que par son identifiant.
function etatJournal(fiche: FichePrestation): Record<string, unknown> {
  return { ...fiche, categorie: fiche.categorie?.nom ?? null };
}

function actionJournal(avant: FichePrestation | null, apres: FichePrestation) {
  if (!avant) return 'CREATION';
  if (!avant.estMainOeuvre && apres.estMainOeuvre) return 'PASSAGE_MAIN_OEUVRE';
  if (avant.estMainOeuvre && !apres.estMainOeuvre) return 'RETRAIT_MAIN_OEUVRE';
  if (avant.actif && !apres.actif) return 'DESACTIVATION';
  if (!avant.actif && apres.actif) return 'REACTIVATION';
  return 'MODIFICATION';
}

// Une entrée par écriture qui change une main d'œuvre (avant ou après) : création, modification,
// désactivation, réactivation, passage en main d'œuvre ou retour en prestation ordinaire. Seuls les
// champs qui changent sont gardés ; un enregistrement à l'identique n'écrit rien.
async function journaliserMainOeuvre(tx: Prisma.TransactionClient, req: express.Request, avant: FichePrestation | null, apres: FichePrestation) {
  let valeurs: { avant: Record<string, unknown> | null; apres: Record<string, unknown> } | null;
  if (avant) {
    valeurs = changementsJournal(etatJournal(avant), etatJournal(apres), CHAMPS_JOURNAL);
  } else {
    const etat = etatJournal(apres);
    valeurs = { avant: null, apres: Object.fromEntries(CHAMPS_CREATION.map((champ) => [champ, etat[champ] ?? null])) };
  }
  if (!valeurs) return;
  await journaliserAdministration(tx, req as AuthRequest, {
    domaine: 'REGLAGES', type: 'MAIN_OEUVRE', action: actionJournal(avant, apres),
    cibleId: apres.id, cibleLibelle: `${apres.reference} — ${apres.nom}`, ...valeurs,
  });
}

// Lecture verrouillée (FOR UPDATE) de la prestation : deux écritures simultanées ne journalisent pas
// le même « avant », et un rattachement en cours (verrou partagé) est attendu.
async function prestationVerrouillee(tx: Prisma.TransactionClient, id: string): Promise<FichePrestation | null> {
  const lignes = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "CataloguePrestation" WHERE "id" = ${id} FOR UPDATE`);
  if (!lignes.length) return null;
  return tx.cataloguePrestation.findUnique({ where: { id }, include: { categorie: true } });
}

// READ COMMITTED explicite, comme les routes de droits (#226) : la ligne relue sous verrou est celle
// du moment, quel que soit le réglage de la base.
const ISOLATION_CATALOGUE = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };

// --- Écritures d'une prestation (famille « prestations » seulement) ---

export async function creerPrestation(req: express.Request): Promise<FichePrestation> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (estCleIntegration(req) && corpsMainOeuvre(body)) throw new RefusCatalogue(403, REFUS_CLE_MAIN_OEUVRE);
  if (!estMainOeuvreDemande(body)) {
    // Prestation ordinaire : création inchangée, sans journal.
    return prisma.cataloguePrestation.create({ data: payloadPrestationOrdinaire(body), include: { categorie: true } });
  }
  const data = payloadMainOeuvre(body);
  return transactionVerifiee(async (tx) => {
    const fiche = await tx.cataloguePrestation.create({ data, include: { categorie: true } });
    await journaliserMainOeuvre(tx, req, null, fiche);
    return fiche;
  }, ISOLATION_CATALOGUE);
}

// Modification (fiche entière, comme pour les autres familles) : la nature demandée
// (`estMainOeuvre`) ou, à défaut, la nature actuelle décide des règles. Les saisies qui ne dépendent
// pas de la fiche sont contrôlées avant de la lire, comme avant ce lot (400 avant 404).
export async function modifierPrestation(req: express.Request, id: string): Promise<FichePrestation> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const cle = estCleIntegration(req);
  if (cle && corpsMainOeuvre(body)) throw new RefusCatalogue(403, REFUS_CLE_MAIN_OEUVRE);
  const demande = estMainOeuvreDemande(body);
  const dataMainOeuvre = demande === true ? payloadMainOeuvre(body) : null;
  const dataOrdinaire = demande === true || (demande === undefined && champsPropresRenseignes(body)) ? null : payloadPrestationOrdinaire(body);
  const actif = body.actif !== undefined ? { actif: !!body.actif } : {};
  return transactionVerifiee(async (tx) => {
    const avant = await prestationVerrouillee(tx, id);
    if (!avant) throw new RefusCatalogue(404, 'Fiche catalogue introuvable.');
    // Une clé d'intégration ne touche pas à une main d'œuvre existante, même sans champ qui lui soit propre.
    if (cle && avant.estMainOeuvre) throw new RefusCatalogue(403, REFUS_CLE_MAIN_OEUVRE);
    const cible = demande ?? avant.estMainOeuvre;
    if (cible) {
      const data = { ...(dataMainOeuvre ?? payloadMainOeuvre(body)), ...actif };
      const apres = await tx.cataloguePrestation.update({ where: { id }, data, include: { categorie: true } });
      await journaliserMainOeuvre(tx, req, avant, apres);
      return apres;
    }
    if (!dataOrdinaire) throw new Error(REFUS_CHAMPS_ORDINAIRE);
    if (!avant.estMainOeuvre) {
      return tx.cataloguePrestation.update({ where: { id }, data: { ...dataOrdinaire, ...actif }, include: { categorie: true } });
    }
    // Retour d'une main d'œuvre en prestation ordinaire : refusé tant qu'un intervenant lui est
    // rattaché (la clé étrangère composite le refuse aussi en base).
    const rattaches = await tx.intervenantMainOeuvre.count({ where: { prestationId: id } });
    if (rattaches > 0) throw new RefusCatalogue(409, `Cette main d’œuvre est rattachée à ${rattaches} intervenant(s) : retirez d’abord ces rattachements dans Administration > Intervenants.`);
    const apres = await tx.cataloguePrestation.update({
      where: { id },
      data: { ...dataOrdinaire, ...actif, estMainOeuvre: false, prixJourHorsContratHt: null, prixHeureSousContratHt: null, prixJourSousContratHt: null, heuresParJour: null, prixDemiJourneeHorsContratHt: null, prixDemiJourneeSousContratHt: null },
      include: { categorie: true },
    });
    await journaliserMainOeuvre(tx, req, avant, apres);
    return apres;
  }, ISOLATION_CATALOGUE);
}

// Désactivation (jamais de suppression). Une main d'œuvre désactivée garde ses rattachements (choix
// par défaut, à confirmer) ; elle n'en reçoit plus de nouveaux.
export async function desactiverPrestation(req: express.Request, id: string) {
  const cle = estCleIntegration(req);
  return transactionVerifiee(async (tx) => {
    const avant = await prestationVerrouillee(tx, id);
    if (!avant) throw new RefusCatalogue(404, 'Fiche catalogue introuvable.');
    if (cle && avant.estMainOeuvre) throw new RefusCatalogue(403, REFUS_CLE_MAIN_OEUVRE);
    const fiche = await tx.cataloguePrestation.update({ where: { id }, data: { actif: false } });
    if (avant.estMainOeuvre) await journaliserMainOeuvre(tx, req, avant, { ...fiche, categorie: avant.categorie });
    return fiche;
  }, ISOLATION_CATALOGUE);
}
