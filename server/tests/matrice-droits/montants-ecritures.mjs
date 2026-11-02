// Relecture des montants des matrices d'écritures réelles (lot D1a-5d ; cadrage de D1a-5d, version 3 du 02-11-2026,
// §3 « Montants relus en base », §4.3 et §4.6) : outils partagés, posés par D1a-5d-1 (factures, avoirs et règlements),
// repris par D1a-5d-2 et D1a-5d-3.
//
// Ce fichier n'est pas un fichier de tests (pas de suffixe « .test.mjs »). Il lit la base par une connexion pg en
// lecture seule (ouvrirConnexionLecture de journaux.mjs), distincte de celles de l'application et de la remise, et
// compare à l'instantané de l'outil de remise en état (schéma SCHEMA_INSTANTANE de remise-en-etat.mjs). Ce qu'il rend
// pour une ligne de matrice ne porte jamais de montant :
//  - memeValeur : égalité exacte d'un montant relu en base (texte décimal de PostgreSQL), envoyé ou écrit en dur, sans
//    tolérance ;
//  - relirePiece, nouvellesPieces, nouveauxReglements : une facture ou un avoir relu en base (totaux, lignes, ventilation
//    par taux, écritures comptables), les pièces et les règlements absents de l'instantané ;
//  - constatPiecesFigees : chaque pièce non brouillon de l'instantané (ligne entière hors statut et date de mise à jour),
//    ses lignes, sa ventilation et ses écritures, chaque règlement (hors statut et contre-passation) et chaque part,
//    comparés à l'instantané, et les changements de statut nommés (cadrage §4.3) ;
//  - montantsChanges : tables dont un montant a changé depuis l'instantané, hors des pièces et règlements que le cas
//    relit à part (un refus doit laisser chaque montant inchangé, cadrage §3) ;
//  - normaliserMontants : un montant cité par l'un des trois messages connus (cadrage §3 : factures/routesTempsPasse.ts:56,
//    reglements/routes.ts:72 et :101) remplacé par « <montant> », et non par normaliserTexte d'outils.mjs, partagé par
//    D1a-1 à D1a-3 ; un montant cité par un autre message reste, et la garde « aucun montant » le refuse ;
//  - pourLaGarde : les messages de refus fixes qui portent un chiffre sans être un montant (liste fermée
//    MESSAGES_SANS_MONTANT), masqués à leur texte exact avant la garde « aucun montant » d'outils.mjs, qui refuse tout
//    chiffre d'un message de refus (option propre à 5d, cadrage §3 : « ou option propre si une forme nouvelle le
//    demande ») ; la référence garde le message exact ;
//  - etatMontant, etatsMontants : « présent », « null » ou « absent » d'un montant d'une réponse, jamais sa valeur
//    (statut de formes.mjs, D1a-3).
import assert from 'node:assert/strict';
import { SCHEMA_INSTANTANE } from './remise-en-etat.mjs';
import { statut } from './formes.mjs';

const S = `"${SCHEMA_INSTANTANE}"`;
// Tri au code de caractère près, indépendant de la langue de la machine.
const ORDRE = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// --- Égalité exacte d'un montant ---
// Nombres (envoyés, écrits en dur), textes décimaux (relus en base par pg, sérialisés par row_to_json), tableaux et objets
// (clés triées). Un montant de deux décimales relu « 0.53 » et le littéral 0.53 donnent le même nombre : la comparaison
// est exacte, sans tolérance.
export const canonique = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v))) return Number(v);
  if (Array.isArray(v)) return v.map(canonique);
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonique(v[k])]));
  return v;
};
export const memeValeur = (a, b) => JSON.stringify(canonique(a)) === JSON.stringify(canonique(b));

// --- Pièces relues en base ---
const nombre = (v) => (v === null || v === undefined ? null : Number(v));
// Une facture ou un avoir : totaux ; lignes (par ordre : nature, quantité, prix unitaire, taux, total HT, TTC de ligne) ;
// ventilation par taux (base, TVA, TTC) ; écritures comptables (par clé : compte, débit, crédit). null si la pièce
// n'existe pas.
export async function relirePiece(connexion, factureId) {
  const { rows: [f] } = await connexion.query('SELECT type, statut, "totalHt", "totalTva", "totalTtc", "factureOrigineId" FROM public."Facture" WHERE id = $1', [factureId]);
  if (!f) return null;
  const lignes = (await connexion.query('SELECT ordre, nature, quantite, "prixUnitaireHt", "tauxTva", "totalHt", "totalTtc" FROM public."FactureLigne" WHERE "factureId" = $1 ORDER BY ordre', [factureId])).rows
    .map((l) => ({ nature: l.nature, quantite: nombre(l.quantite), prixUnitaireHt: nombre(l.prixUnitaireHt), tauxTva: nombre(l.tauxTva), totalHt: nombre(l.totalHt), totalTtc: nombre(l.totalTtc) }));
  const ventilation = (await connexion.query('SELECT "tauxTva", "totalHt", "totalTva", "totalTtc" FROM public."FactureVentilationTva" WHERE "factureId" = $1 ORDER BY "tauxTva"', [factureId])).rows
    .map((v) => [nombre(v.tauxTva), nombre(v.totalHt), nombre(v.totalTva), nombre(v.totalTtc)]);
  // Écritures triées par clé au code de caractère près (CLIENT, TVA:…, VENTE_…), indépendamment du classement de la base.
  const ecritures = (await connexion.query('SELECT cle, "compteNum", debit, credit FROM public."EcritureFacture" WHERE "factureId" = $1 ORDER BY ordre', [factureId])).rows
    .map((e) => [e.cle, e.compteNum, nombre(e.debit), nombre(e.credit)]).sort(([a], [b]) => ORDRE(a, b));
  return { type: f.type, statut: f.statut, factureOrigineId: f.factureOrigineId, totalHt: nombre(f.totalHt), totalTva: nombre(f.totalTva), totalTtc: nombre(f.totalTtc), lignes, ventilation, ecritures };
}
// Pièces et règlements absents de l'instantané (créés par le cas), dans l'ordre de création.
export async function nouvellesPieces(connexion) {
  return (await connexion.query(`SELECT p.id, p.type FROM public."Facture" p LEFT JOIN ${S}."Facture" s ON s.id = p.id WHERE s.id IS NULL ORDER BY p."createdAt", p.id`)).rows;
}
export async function nouveauxReglements(connexion) {
  return (await connexion.query(`SELECT p.id FROM public."Reglement" p LEFT JOIN ${S}."Reglement" s ON s.id = p.id WHERE s.id IS NULL ORDER BY p."createdAt", p.id`)).rows;
}

// --- Pièces émises figées (cadrage §4.3) ---
// `noms` : identifiant de pièce ou de règlement → nom de la cible (une pièce inconnue se nomme « autre pièce », un
// règlement inconnu « autre règlement »). Rend « pièces émises figées » ou « pièce émise modifiée : <cible> (<tables>) »
// et « règlement modifié : <cible> (<tables>) », puis « statut de <cible> <avant> → <après> » pour chaque pièce ou
// règlement de l'instantané dont le statut a changé (brouillon émis compris). Il double les gardes en base
// (figer_identite_facture_emise, interdire_modification_origine_facture_emise, facture_ligne_figee,
// FactureVentilationTva_immutabilite_emise, ecriture_facture_immutable, reglement_immuable,
// affectation_reglement_immuable, facture_statut_transitions) : une garde retirée ne passerait pas inaperçue.
const ENFANTS_DE_PIECE = ['FactureLigne', 'FactureVentilationTva', 'EcritureFacture'];
const HORS_CONTREPASSATION = `- 'statut' - 'motifContrepassation' - 'contrepasseLe' - 'contrepasseParId'`;
const REQUETE_FIGEES = [
  // Pièce non brouillon de l'instantané, supprimée ou changée hors statut et date de mise à jour.
  `SELECT 'Facture' AS partie, s.id AS piece FROM ${S}."Facture" s LEFT JOIN public."Facture" p ON p.id = s.id
     WHERE s.statut <> 'BROUILLON' AND (p.id IS NULL OR (to_jsonb(s) - 'statut' - 'updatedAt') IS DISTINCT FROM (to_jsonb(p) - 'statut' - 'updatedAt'))`,
  // Ligne, ventilation ou écriture d'une pièce non brouillon de l'instantané : retirée, changée ou ajoutée.
  ...ENFANTS_DE_PIECE.map((table) => `SELECT DISTINCT '${table}' AS partie, x."factureId" AS piece FROM (
     (SELECT to_jsonb(e) AS j, e."factureId" FROM ${S}."${table}" e EXCEPT SELECT to_jsonb(e), e."factureId" FROM public."${table}" e)
     UNION ALL (SELECT to_jsonb(e), e."factureId" FROM public."${table}" e EXCEPT SELECT to_jsonb(e), e."factureId" FROM ${S}."${table}" e)
   ) x JOIN ${S}."Facture" f ON f.id = x."factureId" WHERE f.statut <> 'BROUILLON'`),
  // Règlement de l'instantané supprimé ou changé hors statut et contre-passation.
  `SELECT 'Reglement' AS partie, s.id AS piece FROM ${S}."Reglement" s LEFT JOIN public."Reglement" p ON p.id = s.id
     WHERE p.id IS NULL OR (to_jsonb(s) ${HORS_CONTREPASSATION}) IS DISTINCT FROM (to_jsonb(p) ${HORS_CONTREPASSATION})`,
  // Part d'un règlement de l'instantané : retirée, changée ou ajoutée.
  `SELECT DISTINCT 'AffectationReglement' AS partie, x."reglementId" AS piece FROM (
     (SELECT to_jsonb(a) AS j, a."reglementId" FROM ${S}."AffectationReglement" a EXCEPT SELECT to_jsonb(a), a."reglementId" FROM public."AffectationReglement" a)
     UNION ALL (SELECT to_jsonb(a), a."reglementId" FROM public."AffectationReglement" a EXCEPT SELECT to_jsonb(a), a."reglementId" FROM ${S}."AffectationReglement" a)
   ) x JOIN ${S}."Reglement" r ON r.id = x."reglementId"`,
].join(' UNION ALL ');
const REQUETE_STATUTS = `SELECT 'pièce' AS genre, s.id, s.statut AS avant, p.statut AS apres FROM ${S}."Facture" s JOIN public."Facture" p ON p.id = s.id WHERE s.statut <> p.statut
  UNION ALL SELECT 'règlement', s.id, s.statut, p.statut FROM ${S}."Reglement" s JOIN public."Reglement" p ON p.id = s.id WHERE s.statut <> p.statut`;
export async function constatPiecesFigees(connexion, noms) {
  const { rows } = await connexion.query({ name: 'pieces-emises-figees', text: REQUETE_FIGEES });
  const { rows: statuts } = await connexion.query({ name: 'statuts-des-pieces', text: REQUETE_STATUTS });
  const grouper = (parties, defaut) => {
    const parPiece = new Map();
    for (const { partie, piece } of rows.filter((r) => parties.includes(r.partie))) {
      const nom = noms.get(piece) ?? defaut;
      if (!parPiece.has(nom)) parPiece.set(nom, new Set());
      parPiece.get(nom).add(partie);
    }
    return [...parPiece].sort(([a], [b]) => ORDRE(a, b)).map(([nom, tables]) => `${nom} (${[...tables].sort(ORDRE).join(', ')})`);
  };
  const morceaux = [];
  const pieces = grouper(['Facture', ...ENFANTS_DE_PIECE], 'autre pièce');
  const reglements = grouper(['Reglement', 'AffectationReglement'], 'autre règlement');
  if (pieces.length) morceaux.push(`pièce émise modifiée : ${pieces.join(', ')}`);
  if (reglements.length) morceaux.push(`règlement modifié : ${reglements.join(', ')}`);
  if (!morceaux.length) morceaux.push('pièces émises figées');
  const changements = statuts.map((s) => `statut de ${noms.get(s.id) ?? (s.genre === 'pièce' ? 'autre pièce' : 'autre règlement')} ${s.avant} → ${s.apres}`).sort(ORDRE);
  return [...morceaux, ...changements].join(' ; ');
}

// --- Montants changés depuis l'instantané ---
// Colonnes de montant de chaque table des pièces et des règlements, et ce qui rattache une ligne à une pièce ou à un
// règlement relu à part (`factures`, `reglements` : identifiants exclus de la comparaison).
export const MONTANTS_DES_PIECES = {
  Facture: { colonnes: ['totalHt', 'totalTva', 'totalTtc'], piece: 'id' },
  FactureLigne: { colonnes: ['quantite', 'prixUnitaireHt', 'tauxTva', 'totalHt', 'totalTtc'], piece: 'factureId' },
  FactureVentilationTva: { colonnes: ['tauxTva', 'totalHt', 'totalTva', 'totalTtc'], piece: 'factureId' },
  EcritureFacture: { colonnes: ['cle', 'compteNum', 'debit', 'credit'], piece: 'factureId' },
  Reglement: { colonnes: ['montant'], reglement: 'id' },
  AffectationReglement: { colonnes: ['factureId', 'montant'], reglement: 'reglementId' },
};
const REQUETE_MONTANTS = Object.entries(MONTANTS_DES_PIECES).map(([table, d]) => {
  const colonnes = ['id', ...d.colonnes].map((c) => `t."${c}"`).join(', ');
  const exclusion = d.piece ? `NOT (t."${d.piece}" = ANY($1::text[]))` : `NOT (t."${d.reglement}" = ANY($2::text[]))`;
  return `SELECT '${table}' AS t, count(*)::int AS n FROM (
    (SELECT ${colonnes} FROM ${S}."${table}" t WHERE ${exclusion} EXCEPT SELECT ${colonnes} FROM public."${table}" t WHERE ${exclusion})
    UNION ALL (SELECT ${colonnes} FROM public."${table}" t WHERE ${exclusion} EXCEPT SELECT ${colonnes} FROM ${S}."${table}" t WHERE ${exclusion})) x`;
}).join(' UNION ALL ');
export async function montantsChanges(connexion, { factures = [], reglements = [] } = {}) {
  const { rows } = await connexion.query({ name: 'montants-changes', text: REQUETE_MONTANTS, values: [factures, reglements] });
  return rows.filter((r) => r.n > 0).map((r) => r.t).sort(ORDRE);
}

// --- Montants cités par un message de refus (cadrage §3) ---
// Les trois messages connus, reconnus par leur début, une fois le message normalisé par normaliserTexte (outils.mjs) :
// espaces insécables ramenées à des espaces. Un montant de l'application s'écrit « 1 234,56 € » (formatMontantFacture,
// factures/metier.ts : séparateur des milliers, virgule, deux décimales, espace, euro).
export const MESSAGES_A_MONTANT = [
  // factures/routesTempsPasse.ts:56
  /« La facture au temps passé a changé depuis l’aperçu \(total HT /,
  // reglements/routes.ts:72
  /« Le règlement doit être entièrement affecté : /,
  // reglements/routes.ts:101
  /« La facture \S+ est déjà soldée \(reste dû /,
];
const MONTANT_FRANCAIS = /\p{Nd}+(?:[ \u00a0\u202f]\p{Nd}{3})*,\p{Nd}{2}[ \u00a0\u202f]?€/gu;
export function normaliserMontants(texte) {
  const chaine = String(texte);
  return MESSAGES_A_MONTANT.some((motif) => motif.test(chaine)) ? chaine.replace(MONTANT_FRANCAIS, '<montant>') : chaine;
}

// --- Messages de refus fixes qui portent un chiffre sans être un montant ---
// Liste fermée, au texte exact de l'application (une variante, ou un autre chiffre, reste refusé par la garde) :
//  - commun/tva.ts:9 (REFUS_TAUX_TVA) : les taux de TVA acceptés sur une facture ;
//  - reglements/routes.ts:132 : la longueur d'un motif de contre-passation.
export const MESSAGES_SANS_MONTANT = [
  'Taux de TVA non accepté : 0 %, 5,5 %, 10 % ou 20 %.',
  'Un motif de 3 à 500 caractères, sans caractère de contrôle, est obligatoire.',
];
// Une ligne de matrice, ces messages masqués (« « <message sans montant> » »), pour la seule garde : la ligne enregistrée
// dans la référence n'est pas changée.
export function pourLaGarde(ligne) {
  return MESSAGES_SANS_MONTANT.reduce((l, message) => l.split(`« ${message} »`).join('« <message sans montant> »'), ligne);
}

// --- État d'un montant dans une réponse ---
// « présent », « null » ou « absent » (plusieurs états séparés par « / » pour un chemin de liste), « non porté » si
// aucun objet du chemin n'existe ; jamais la valeur.
export function etatMontant(objet, chemin) {
  const etats = statut(objet, chemin);
  return etats.length ? etats.join('/') : 'non porté';
}
export function etatsMontants(objet, chemins) {
  assert.ok(Array.isArray(chemins) && chemins.length, 'etatsMontants : au moins un chemin');
  return chemins.map((chemin) => `${chemin} ${etatMontant(objet, chemin)}`).join(', ');
}
