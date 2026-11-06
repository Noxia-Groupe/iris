// Lot D1a-5d-1 : factures, avoirs et règlements. Écritures réelles des routes des factures, des avoirs, des règlements, de
// la facture au temps passé et de l'envoi d'une facture ; refus et absence d'effet ; comptes refusés à l'entrée rejoués
// avec chaque corps valide du super administrateur ; montants relus en base ; pièces émises figées ; entrées des journaux
// et qui peut les lire. Tests seuls (cadrage du lot D1a-5d, version 3 du 02-11-2026, contrôlé par le
// controleur-coherence et publié sur #427, sections 3, 4.1 à 4.7, 7, 8 et 9 ; avenant au cadrage du lot D1a pour D1a-5,
// version 2 ; cadrage du lot D1a, version 3 du 01-11-2026).
//
// Tests seuls : ce fichier enregistre le comportement actuel, sans rien corriger. Il reprend les outils, les comptes, le
// jeu de données et la table des routes de D1a-1, l'outil de remise en état de D1a-5a, les outils de lecture des
// journaux de D1a-5c (journaux.mjs, avec l'option `pieces` de nommerEntree), et pose le module partagé de relecture des
// montants (matrice-droits/montants-ecritures.mjs), que D1a-5d-2 et D1a-5d-3 reprendront. Il enregistre :
//  - §4.1 : chaque route des factures, des avoirs et des règlements (toutes réservées à l'administration, aucune en
//    /api/v1), jouée un à un par SA, AD et AD-COM, avec ses cas admis et ses refus ; les écritures indirectes jouées avec
//    le constat des pièces figées (société, client renommé, mentions légales, règles comptables, prix d'une main
//    d'œuvre), par SA et AD, dont seules la ligne « écrit (tables) » et ce constat sont gardés ;
//  - §4.2 : les 12 comptes refusés à l'entrée rejoués avec chaque corps de SA sur ces routes, en lots (une empreinte par
//    lot), un lot qui écrit étant rejoué un à un (empreinte après chaque cas, entrées nommées), comme en D1a-5b ;
//  - §4.3 : après chaque cas, le constat des pièces émises figées (pièce, lignes, ventilation, écritures, règlements et
//    parts comparés à l'instantané, changements de statut nommés) ;
//  - §4.4 : chaque montant écrit relu en base, comparé à l'attendu écrit en dur (lecture écartée en commentaire, test
//    témoin), et pour chaque refus les montants relus inchangés ; le détail des entrées de règlement comparé à la base ;
//  - §4.6 : chaque entrée nouvelle (journal de la pièce, envois) lue par SA, AD, l'auteur hors administration et le
//    directeur, refusé de ces deux routes de lecture.
// Une ligne d'écriture : compte, route, cible, contexte (« défaut, corps <nom> »), réponse (code, et message exact d'un
// refus, montant cité normalisé en « <montant> »), « écrit (tables) » ou « inchangé », puis « entrées : … » ou « aucune
// entrée », le constat des pièces figées et celui des montants. Une ligne de lecture : comme en D1a-5c. Jamais un montant
// (garde lignesAvecMontant d'outils.mjs, options `journaux` et `comptesAChiffre`). Le tout est comparé au caractère près
// à server/tests/matrice-droits/factures.txt.
//
// Rôle PostgreSQL : comme D1a-5a à D1a-5c, la remise pose session_replication_role ; si le rôle de TEST_DATABASE_URL ne
// le peut pas, le test « rôle PostgreSQL » échoue avec un message clair, chacun des autres le cite, et aucune base n'est
// créée. Sans TEST_DATABASE_URL, le fichier s'annonce ignoré comme les autres fichiers de la matrice : un SKIP n'est pas
// une réussite. Ce fichier crée sa propre base jetable (iris_test_matrice_factures_<hex>), la migre, la sert à
// l'application, puis la supprime.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before, describe } from 'node:test';
import { join } from 'node:path';
import {
  DOSSIER_MATRICES, EMAIL_SECOURS, JETON_SECOURS, SANS_CIBLE, SEPARATEUR, appeler, baseJetable, chargerApplication,
  comparerAvecReference, enParallele, formaterReponse, ligneMatrice, lignesAvecMontant, lireReference, tablesChangees,
  tablesDeLaBase,
} from './matrice-droits/outils.mjs';
import { COMPTES_JOUES, creerComptes } from './matrice-droits/comptes.mjs';
import { FAMILLES, SOCIETE, cibleDe, construireJeuDeDonnees, jourSociete } from './matrice-droits/donnees.mjs';
import { creerRemiseEnEtat, exigerRoleReplication } from './matrice-droits/remise-en-etat.mjs';
import { entreesNouvelles, lireVisibilite, nommerEntree, ouvrirConnexionLecture } from './matrice-droits/journaux.mjs';
import {
  MESSAGES_SANS_MONTANT, constatPiecesFigees, etatsMontants, memeValeur, montantsChanges, normaliserMontants, nouveauxReglements,
  nouvellesPieces, pourLaGarde, relirePiece,
} from './matrice-droits/montants-ecritures.mjs';

const TITRE = 'Lot D1a-5d-1 : factures, avoirs et règlements, écritures réelles et refus, comptes hors administration rejoués avec un corps valide, montants relus en base, pièces émises figées, entrées des journaux et qui peut les lire';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const REFERENCE = join(DOSSIER_MATRICES, 'factures.txt');
const SA = 'SA';
// Le directeur en fait partie depuis le lot « Directeur aligné sur l'administration » (décision de Nelson du 24-10-2026, point 14).
const ADMINISTRATION = ['SA', 'AD', 'AD-COM', 'DIR'];
// Les 12 comptes refusés à l'entrée de chaque route des factures (entrees.txt, vérifié par le test de couverture).
const REFUSES = COMPTES_JOUES.filter((c) => !ADMINISTRATION.includes(c));
const REFUS_ENTREE = '403 « Accès réservé aux administrateurs »';
const DESTINATAIRE = 'contact-matrice@iris.test';
// Routes de la section 4.1 du cadrage (factures/routes.ts, factures/routesTempsPasse.ts, reglements/routes.ts).
const ROUTES_DES_FACTURES = [
  'POST /api/factures', 'POST /api/factures/:id/emettre', 'POST /api/factures/:id/regler', 'POST /api/factures/:id/annuler',
  'POST /api/factures/:id/avoirs', 'POST /api/factures/:id/envois', 'POST /api/interventions/:id/facture-temps-passe',
  'POST /api/reglements', 'POST /api/reglements/:id/contrepasser',
];
// Constats des montants (cadrage §3 et §4.4), sans chiffre.
const MONTANTS_INCHANGES = 'montants inchangés en base';
const CONSTATS_CONFORMES = {
  creation: 'montants de la pièce créée relus en base conformes',
  emission: 'écritures et montants de la pièce relus en base conformes',
  annulation: 'avoir total égal à la facture, écritures inversées relues en base conformes',
  avoir: 'montants et écritures de l’avoir relus en base conformes',
  reglement: 'montant, parts, reste dû et statuts relus en base conformes ; montants journalisés identiques',
  contrepassation: 'montant et parts inchangés, reste dû et statuts relus en base conformes ; montants journalisés identiques',
};
// Constat d'un écart, par genre, suivi des champs qui diffèrent (aucun chiffre).
const CONSTATS_ECART = {
  creation: 'montants de la pièce créée différents de l’attendu', emission: 'écritures ou montants de la pièce différents de l’attendu',
  annulation: 'avoir total différent de l’attendu', avoir: 'montants ou écritures de l’avoir différents de l’attendu',
  reglement: 'règlement relu différent de l’attendu', contrepassation: 'règlement relu différent de l’attendu',
};

// --- Montants envoyés et attendus (cadrage §4.4) ---
// Chaque valeur envoyée est choisie pour qu'une autre lecture plausible de la règle donne un autre résultat ; l'attendu
// est écrit en dur, la lecture écartée en commentaire, et le test « témoin des montants » le recalcule en décimal exact
// et vérifie que chaque lecture écartée en diffère. Comptes du paramétrage (donnees.mjs) : 411000 clients, 706000
// prestations, 707000 articles, 445710 TVA à 20 % ; 445711 TVA à 5,5 %, posé par ce fichier.
const LIGNE_A = { designation: 'TEST Ligne A de la matrice des factures', nature: 'PRESTATION', quantite: 1.5, prixUnitaireHt: 0.35, tauxTva: 20 };
const LIGNE_B = { designation: 'TEST Ligne B de la matrice des factures', nature: 'ARTICLE', quantite: 1.5, prixUnitaireHt: 0.35, tauxTva: 20 };
const LIGNE_C = { designation: 'TEST Ligne C de la matrice des factures', nature: 'PRESTATION', quantite: 3, prixUnitaireHt: 33.33, tauxTva: 5.5 };
const ligneAttendue = (ligne, totalHt, totalTtc) => ({ nature: ligne.nature, quantite: ligne.quantite, prixUnitaireHt: ligne.prixUnitaireHt, tauxTva: ligne.tauxTva, totalHt, totalTtc });
const MONTANTS = {
  lignes: [LIGNE_A, LIGNE_B, LIGNE_C],
  // Facture à trois lignes et deux taux :
  //  - ligne A : 1,5 × 0,35 = 0,525, arrondi à 0,53 (moitié vers le haut, exacte) ; un calcul flottant (0,52499…) ou
  //    l'arrondi au pair donnerait 0,52 ; TTC de ligne 0,636, arrondi à 0,64 ;
  //  - ligne B : même calcul, nature article (707 aux écritures) ;
  //  - ligne C : 3 × 33,33 = 99,99 ; TTC de ligne 105,48945, arrondi à 105,49 ;
  //  - ventilation à 20 % sur la base cumulée 1,06 : TVA 0,212, arrondie à 0,21 ; ligne par ligne, 0,11 + 0,11 = 0,22 ;
  //  - ventilation à 5,5 % : TVA 5,49945, arrondie à 5,50 ; un taux recopié à 5 ou 6 % donnerait 5,00 ou 6,00 ;
  //  - totaux : HT 101,05 ; TVA 5,71 ; TTC 106,76 ; la somme des TTC de ligne donnerait 106,77.
  factureDeuxTaux: {
    type: 'FACTURE', statut: 'BROUILLON', totalHt: 101.05, totalTva: 5.71, totalTtc: 106.76,
    lignes: [ligneAttendue(LIGNE_A, 0.53, 0.64), ligneAttendue(LIGNE_B, 0.53, 0.64), ligneAttendue(LIGNE_C, 99.99, 105.49)],
    ventilation: [[5.5, 99.99, 5.5, 105.49], [20, 1.06, 0.21, 1.27]],
  },
  // Écritures de l'émission : 411 débit du TTC ; 706 crédit des prestations (0,53 + 99,99 = 100,52) ; 707 crédit des
  // articles (0,53) ; TVA par taux. Lectures écartées : nature mal ventilée (706 crédit 101,05, sans 707) ; TVA par ligne
  // (0,22 au crédit de 445710).
  ecrituresEmission: [['CLIENT', '411000', 106.76, 0], ['TVA:20', '445710', 0, 0.21], ['TVA:5.5', '445711', 0, 5.5], ['VENTE_ARTICLE', '707000', 0, 0.53], ['VENTE_PRESTATION', '706000', 0, 100.52]],
  // Avoir total de facture-emise-non-reglee (200 HT à 20 %) : égal à la facture, écritures inversées. Lecture écartée :
  // écritures recopiées sans inversion (411 au débit).
  avoirTotal: {
    type: 'AVOIR', statut: 'EMISE', totalHt: 200, totalTva: 40, totalTtc: 240,
    lignes: [{ nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 200, tauxTva: 20, totalHt: 200, totalTtc: 240 }],
    ventilation: [[20, 200, 40, 240]],
    ecritures: [['CLIENT', '411000', 0, 240], ['TVA:20', '445710', 40, 0], ['VENTE_PRESTATION', '706000', 200, 0]],
  },
  // Ligne d'avoir partiel : 1,5 × 0,35 = 0,53 HT, TTC de ligne 0,64.
  ligneAvoir: { designation: 'TEST Avoir partiel de la matrice des factures', nature: 'PRESTATION', quantite: 1.5, prixUnitaireHt: 0.35, tauxTva: 20 },
  // Avoir partiel sur facture-avoir-partiel, dont un premier avoir de 0,53 HT (TVA 0,11) existe : base d'avoirs cumulée
  // 1,06, TVA 0,212 arrondie à 0,21, moins 0,11 déjà créditée : 0,10 ; TTC 0,63. Lecture écartée : TVA de l'avoir seul,
  // 0,106 arrondie à 0,11 (TTC 0,64).
  avoirApresAvoir: {
    type: 'AVOIR', statut: 'EMISE', totalHt: 0.53, totalTva: 0.1, totalTtc: 0.63,
    lignes: [{ nature: 'PRESTATION', quantite: 1.5, prixUnitaireHt: 0.35, tauxTva: 20, totalHt: 0.53, totalTtc: 0.64 }],
    ventilation: [[20, 0.53, 0.1, 0.63]],
    ecritures: [['CLIENT', '411000', 0, 0.63], ['TVA:20', '445710', 0.1, 0], ['VENTE_PRESTATION', '706000', 0.53, 0]],
  },
  // Même ligne sur une facture sans avoir (facture-emise, facture-reglee) : TVA 0,11, TTC 0,64. Ici, la TVA de la base
  // cumulée et celle de l'avoir seul coïncident : ce cas ne départage pas cette lecture, que départage le précédent.
  avoirSeul: {
    type: 'AVOIR', statut: 'EMISE', totalHt: 0.53, totalTva: 0.11, totalTtc: 0.64,
    lignes: [{ nature: 'PRESTATION', quantite: 1.5, prixUnitaireHt: 0.35, tauxTva: 20, totalHt: 0.53, totalTtc: 0.64 }],
    ventilation: [[20, 0.53, 0.11, 0.64]],
    ecritures: [['CLIENT', '411000', 0, 0.64], ['TVA:20', '445710', 0.11, 0], ['VENTE_PRESTATION', '706000', 0.53, 0]],
  },
  // Règlements de facture-emise : 120 TTC, réglée de 50 par le jeu de données, reste 70.
  //  - 69,99 : reste dû 0,01, la facture reste émise ; un arrondi à l'euro (70) la ferait passer réglée ;
  //  - 70,00 : reste dû nul, réglée ;
  //  - 70,01 : surplus admis (décision de Nelson du 17-10-2026, reglements/routes.ts:93), réglée, trop-perçu 0,01 ; un
  //    refus du surplus laisserait la facture émise, sans règlement.
  reglementPartiel: 69.99, reglementSolde: 70, reglementSurplus: 70.01,
  // Deux factures : 70,00 sur facture-emise (soldée) et 239,99 sur facture-emise-non-reglee (240 TTC, reste 0,01). Une
  // part appliquée à la mauvaise facture, ou le total appliqué à chacune, changerait les deux restes et statuts.
  reglementDeuxFactures: [70, 239.99],
  // Surplus sur la première tant que la seconde reste due (409, choix par défaut, reglements/routes.ts:95-96 et :105).
  reglementSurplusEtDue: [70.01, 239.99],
  // Facture d'un client désactivé (40 HT, 48 TTC) : 47,99, reste 0,01, émise ; un arrondi à l'euro la solderait.
  reglementClientDesactive: 47.99,
  // Facture au temps passé : 1,1 h saisies, minimum figé de 60 minutes, pas de 15 minutes, prix figé du devis 61,70 :
  // 66 minutes, au-delà du minimum de 6 minutes, une tranche de 15 commencée, soit 75 minutes, 1,25 h ; 1,25 × 61,70 =
  // 77,125, arrondi à 77,13 (TVA 15,426 arrondie à 15,43 ; TTC 92,56, ligne et ventilation comprises). Lectures écartées :
  // arrondi au pair, 77,12 ; sans le pas (1,1 h), 67,87 ; au pas le plus proche (60 minutes), 61,70 ; prix de la main
  // d'œuvre du catalogue, changé à 99,99 après la signature : 124,99. 1,1 h ne départage pas le minimum de 60 minutes
  // (lu au-dessus) : un mutant qui l'ignore survit à ce fichier ; il est couvert par api.test.mjs (#348).
  // Réglages de la société changés après la signature (pas de 60 minutes, minimum de 120 minutes) : la facture garde le
  // pas et le minimum figés sur le devis. Lectures écartées : pas du jour, 60 + 60 minutes, 2 h, 123,40 ; minimum du
  // jour, 120 minutes, 2 h, 123,40.
  tempsPasse: { heures: 1.1, prixDevis: 61.7, prixApresSignature: 99.99, minimumMinutes: 60, pasMinutes: 15, totalHtAutre: 77.12, pasApresSignature: 60, minimumApresSignature: 120 },
  factureTempsPasse: {
    type: 'FACTURE', statut: 'BROUILLON', totalHt: 77.13, totalTva: 15.43, totalTtc: 92.56,
    lignes: [{ nature: 'PRESTATION', quantite: 1.25, prixUnitaireHt: 61.7, tauxTva: 20, totalHt: 77.13, totalTtc: 92.56 }],
    ventilation: [[20, 77.13, 15.43, 92.56]],
  },
  // Montants HT des cibles propres (une ligne à 20 %) : distincts entre eux et de ceux du jeu de données (10, 100, 80), pour
  // qu'une valeur existante relue à tort ne passe pas.
  cibles: { emiseNonReglee: 200, reglee: 50, annulee: 30, avoirPartiel: 300, soldeeParAvoir: 20, autreClient: 45, clientDesactive: 40 },
  // Prix de la main d'œuvre du temps passé, changé par une écriture indirecte (copie figée : aucune pièce ne change).
  prixMainOeuvreChange: 88.88,
};

// --- Calcul décimal exact du témoin, indépendant de l'application ---
// Unités entières (BigInt) et arrondi « moitié vers le haut » des montants positifs.
const enUnites = (valeur, decimales) => {
  const [entier, fraction = ''] = String(valeur).split('.');
  return BigInt(entier) * 10n ** BigInt(decimales) + BigInt(fraction.padEnd(decimales, '0').slice(0, decimales) || '0');
};
const auCentime = (unites, diviseur) => (unites + diviseur / 2n) / diviseur;
const exact = {
  ligneHt: (quantite, prix) => auCentime(enUnites(quantite, 3) * enUnites(prix, 2), 1000n),
  tva: (baseCentimes, taux) => auCentime(baseCentimes * enUnites(taux, 3), 100000n),
  ttcLigne: (htCentimes, taux) => auCentime(htCentimes * (100000n + enUnites(taux, 3)), 100000n),
  euros: (centimes) => Number(centimes) / 100,
};
// Arrondi au pair d'un nombre de demi-centimes exact (lecture écartée).
const arrondiAuPair = (millemes) => { const q = millemes / 10n; const r = millemes % 10n; return r > 5n || (r === 5n && q % 2n === 1n) ? q + 1n : q; };
// Mise en forme d'un montant comme l'application (formatMontantFacture, factures/metier.ts), recopiée ici, et non
// importée de dist, pour que le détail d'une entrée de journal soit comparé à la base par un outil indépendant.
const enEuros = (valeur) => `${Number(valeur).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const soldeTexte = (reste) => (reste < 0 ? `trop-perçu ${enEuros(-reste)}` : `reste dû ${enEuros(reste)}`);
const somme = (montants) => montants.reduce((s, m) => s + Math.round(m * 100), 0) / 100;

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const base = baseJetable(TEST_DATABASE_URL, 'factures');
    let appli; let remise; let lecture;
    let refusRole = null;
    const PREPARATION_INTERROMPUE = 'Préparation interrompue : le contrôle du rôle PostgreSQL de TEST_DATABASE_URL a échoué (voir le test « rôle PostgreSQL » : rôle sans session_replication_role, ou serveur injoignable).';
    const testPrepare = (titre, corps) => test(titre, async (t) => {
      if (refusRole) assert.fail(PREPARATION_INTERROMPUE);
      return corps(t);
    });
    let comptes = {};
    const jetons = {};
    const noms = new Map();
    const d = {};
    // Pièces et règlements suivis (identifiant → nom de la cible) : ceux du jeu de données et les cibles propres. Ils
    // nomment la pièce d'une entrée JournalFacture (option `pieces` de nommerEntree) et le constat des pièces figées.
    const suivis = new Map();
    const idDe = (nom) => {
      const trouve = [...suivis].find(([, n]) => n === nom);
      assert.ok(trouve, `pièce ou règlement inconnu : ${nom}`);
      return trouve[0];
    };
    // L'export CSV du journal d'administration n'est pas lu par 5d-1 (cadrage §4.6 ; sa garde, T1 de #457, vient en 5d-2) :
    // aucune route des factures n'écrit dans ce journal, et une entrée qui y apparaîtrait ferait échouer lireVisibilite
    // avec un message clair (« export CSV de référence absent »).
    const exportsReference = {};
    const lignes = [];
    const cas = [];
    const chiffres = { unAUn: 0, lots: 0, refusEnLots: 0, lotsRejoues: [], lectures: 0, remises: 0, montants: 0 };
    const diagnostics = [];
    // Réponses hors droits relevées en jouant (500 et autres), enregistrées telles quelles, pour #426 (cadrage §3).
    const horsDroits = [];

    const api = async (compte, methode, chemin, corps, statut = 200) => {
      const res = await appeler(appli.adresse, methode, chemin, { jeton: jetons[compte], corps: methode === 'GET' ? undefined : corps });
      const admis = Array.isArray(statut) ? statut : [statut];
      assert.ok(admis.includes(res.status), `${methode} ${chemin} (${compte}) : ${res.status} ${JSON.stringify(res.body)?.slice(0, 400)}`);
      return res.body;
    };
    const id = (famille, nom) => cibleDe(famille, nom).ids.id;

    // --- Relectures (cadrage §3 et §4.4) ---
    // Écarts d'une pièce relue à l'attendu : noms des champs qui diffèrent (aucun chiffre).
    const ecartsPiece = (piece, attendu) => {
      if (!piece) return ['pièce introuvable'];
      const ecarts = [];
      for (const [champ, valeur] of Object.entries(attendu)) {
        if (champ === 'lignes') {
          const lues = piece.lignes.map((l) => Object.fromEntries(Object.keys(valeur[0] ?? {}).map((k) => [k, l[k]])));
          if (!memeValeur(lues, valeur)) ecarts.push('lignes');
        } else if (!memeValeur(piece[champ], valeur)) ecarts.push(champ === 'ecritures' ? 'écritures' : champ);
      }
      return ecarts;
    };
    const autresMontants = async (exclus, quoi) => {
      const tables = await montantsChanges(lecture, exclus);
      return tables.length ? [`montants changés hors ${quoi} : ${tables.join(', ')}`] : [];
    };
    const constat = (genre, ecarts, autres) => [ecarts.length ? `${CONSTATS_ECART[genre]} : ${ecarts.join(', ')}` : CONSTATS_CONFORMES[genre], ...autres].join(' ; ');
    // Soldes relus en base, indépendamment de l'application : TTC, moins les avoirs non brouillons, moins les parts des
    // règlements non contre-passés.
    const soldes = async (ids) => {
      const { rows } = await lecture.query(`SELECT f.id, f.statut,
          f."totalTtc" - coalesce((SELECT sum(a."totalTtc") FROM public."Facture" a WHERE a."factureOrigineId" = f.id AND a.type = 'AVOIR' AND a.statut <> 'BROUILLON'), 0)
            - coalesce((SELECT sum(p.montant) FROM public."AffectationReglement" p JOIN public."Reglement" r ON r.id = p."reglementId" WHERE p."factureId" = f.id AND r.statut = 'ENREGISTRE'), 0) AS reste,
          coalesce((SELECT sum(p.montant) FROM public."AffectationReglement" p JOIN public."Reglement" r ON r.id = p."reglementId" WHERE p."factureId" = f.id AND r.statut = 'ENREGISTRE'), 0) AS regle
        FROM public."Facture" f WHERE f.id = ANY($1::text[])`, [ids]);
      return new Map(rows.map((r) => [r.id, { statut: r.statut, reste: Number(r.reste), regle: Number(r.regle) }]));
    };
    const lireReglement = async (reglementId) => {
      const { rows: [r] } = await lecture.query('SELECT montant, statut FROM public."Reglement" WHERE id = $1', [reglementId]);
      const parts = (await lecture.query('SELECT "factureId", montant FROM public."AffectationReglement" WHERE "reglementId" = $1', [reglementId])).rows;
      return r ? { montant: Number(r.montant), statut: r.statut, parts: new Map(parts.map((p) => [p.factureId, Number(p.montant)])) } : null;
    };
    // Règlement créé ou contre-passé : montant, parts, statut, reste dû et statut des factures, et le détail de chaque
    // entrée qui porte un montant (REGLEMENT_AFFECTE, REGLEMENT_CONTREPASSE, REGLEMENT, RETOUR_EMISE), comparé à la base
    // (cadrage §4.4, dernier alinéa) sans entrer dans la référence.
    const constatReglement = async (m, entrees) => {
      const ecarts = [];
      const [nouveau, ...autres] = await nouveauxReglements(lecture);
      const reglementId = m.genre === 'reglement' ? nouveau?.id : idDe(m.reglement);
      if (m.genre === 'reglement' && (!nouveau || autres.length)) return `règlements créés : ${nouveau ? 'plusieurs' : 'aucun'}`;
      const r = await lireReglement(reglementId);
      if (!memeValeur(r.montant, m.montant)) ecarts.push('montant du règlement');
      if (r.statut !== (m.genre === 'reglement' ? 'ENREGISTRE' : 'CONTREPASSE')) ecarts.push('statut du règlement');
      const parts = [...r.parts].map(([factureId, montant]) => [suivis.get(factureId) ?? 'autre pièce', montant]).sort(([a], [b]) => (a < b ? -1 : 1));
      if (!memeValeur(parts, [...m.parts].sort(([a], [b]) => (a < b ? -1 : 1)))) ecarts.push('parts');
      const lus = await soldes(m.restes.map(([nom]) => idDe(nom)));
      for (const [nom, reste] of m.restes) if (!memeValeur(lus.get(idDe(nom))?.reste, reste)) ecarts.push(`reste dû de ${nom}`);
      for (const [nom, statut] of m.statuts) if (lus.get(idDe(nom))?.statut !== statut) ecarts.push(`statut de ${nom}`);
      // Entrées du journal de la pièce : une par part (affectation ou contre-passation), et une par changement de statut.
      const action = m.genre === 'reglement' ? 'REGLEMENT_AFFECTE' : 'REGLEMENT_CONTREPASSE';
      const journal = entrees.filter((e) => e.table === 'JournalFacture');
      for (const [factureId, part] of r.parts) {
        const nom = suivis.get(factureId) ?? 'autre pièce';
        const solde = lus.get(factureId) ?? (await soldes([factureId])).get(factureId);
        const entree = journal.find((e) => e.ligne.factureId === factureId && e.ligne.action === action);
        if (!entree) { ecarts.push(`entrée ${action} absente pour ${nom}`); continue; }
        const detail = String(entree.ligne.detail ?? '');
        const attendu = action === 'REGLEMENT_AFFECTE'
          ? detail.endsWith(`: ${enEuros(part)} affectés ; ${soldeTexte(solde.reste)}`)
          : detail.includes(` de ${enEuros(r.montant)} : « `) && detail.endsWith(` ; ${enEuros(part)} retirés ; ${soldeTexte(solde.reste)}`);
        if (!attendu) ecarts.push(`montant journalisé différent de la base : ${action} de ${nom}`);
      }
      for (const e of journal.filter((x) => ['REGLEMENT', 'RETOUR_EMISE'].includes(x.ligne.action))) {
        const solde = lus.get(e.ligne.factureId) ?? (await soldes([e.ligne.factureId])).get(e.ligne.factureId);
        if (!String(e.ligne.detail ?? '').endsWith(`: réglé ${enEuros(solde.regle)}, ${soldeTexte(solde.reste)}`)) ecarts.push(`montant journalisé différent de la base : ${e.ligne.action} de ${suivis.get(e.ligne.factureId) ?? 'autre pièce'}`);
      }
      const hors = await autresMontants(m.genre === 'reglement' ? { reglements: [reglementId] } : {}, 'du règlement');
      return constat(m.genre, ecarts, hors);
    };
    // Constat des montants d'un cas : relecture propre au cas pour une écriture admise, montants inchangés sinon.
    const constaterMontants = async (c, res, entrees) => {
      chiffres.montants += 1;
      const m = c.montant;
      if (!m || res.status < 200 || res.status >= 300) {
        const tables = await montantsChanges(lecture);
        return tables.length ? `montants changés en base : ${tables.join(', ')}` : MONTANTS_INCHANGES;
      }
      if (m.genre === 'reglement' || m.genre === 'contrepassation') return constatReglement(m, entrees);
      const nouvelles = await nouvellesPieces(lecture);
      if (m.genre === 'emission') {
        const cibleId = idDe(c.cible);
        const ecarts = ecartsPiece(await relirePiece(lecture, cibleId), m.attendu);
        return constat('emission', [...ecarts, ...(nouvelles.length ? ['pièce créée'] : [])], await autresMontants({ factures: [cibleId] }, 'de la pièce'));
      }
      if (nouvelles.length !== 1) return `pièces créées : ${nouvelles.length ? 'plusieurs' : 'aucune'}`;
      const [creee] = nouvelles;
      const piece = await relirePiece(lecture, creee.id);
      const ecarts = ecartsPiece(piece, m.attendu);
      if (m.genre === 'annulation') {
        // L'avoir total égale la facture source relue en base (totaux, lignes, ventilation), et ses écritures sont
        // celles de la source, débit et crédit inversés.
        const source = await relirePiece(lecture, idDe(c.cible));
        for (const champ of ['totalHt', 'totalTva', 'totalTtc', 'lignes', 'ventilation']) if (!memeValeur(piece?.[champ], source?.[champ])) ecarts.push(`${champ} différent de la facture`);
        if (!memeValeur(piece?.ecritures, source?.ecritures.map(([cle, compte, debit, credit]) => [cle, compte, credit, debit]))) ecarts.push('écritures non inversées');
        if (piece?.factureOrigineId !== idDe(c.cible)) ecarts.push('facture d’origine');
      }
      if (m.genre === 'avoir' && piece?.factureOrigineId !== idDe(c.cible)) ecarts.push('facture d’origine');
      // Facture au temps passé : les heures saisies et facturées de l'entrée CREATION_BROUILLON (routesTempsPasse.ts:24),
      // comparées à l'attendu.
      if (m.heures) {
        const entree = entrees.find((e) => e.table === 'JournalFacture' && e.ligne.factureId === creee.id && e.ligne.action === 'CREATION_BROUILLON');
        const heures = (h) => h.toLocaleString('fr-FR', { maximumFractionDigits: 3 });
        const detail = String(entree?.ligne.detail ?? '');
        if (!detail.includes(`: ${heures(m.heures.saisies)} h saisies `) || !detail.includes(`, ${heures(m.heures.facturees)} h facturées (`)) ecarts.push('heures journalisées');
      }
      return constat(m.genre, ecarts, await autresMontants({ factures: [creee.id] }, 'de la pièce'));
    };

    // --- Cas ---
    // { compte, route, cible, contexte, chemin, corps, code (réponse attendue par le cadrage, null si non écrite), montant,
    // indirect (écriture indirecte : ligne « écrit (tables) » et constat des pièces figées seulement) }.
    const ajouter = (compte, route, cible, contexte, chemin, corps, options = {}) => cas.push({ compte, route, cible, contexte, chemin, corps, code: null, ...options });
    // Noms des pièces pour un cas : les pièces suivies, et les pièces créées par le cas (« nouvelle facture », « nouvel
    // avoir »).
    const piecesDuCas = async () => {
      const pieces = new Map(suivis);
      for (const p of await nouvellesPieces(lecture)) pieces.set(p.id, p.type === 'AVOIR' ? 'nouvel avoir' : 'nouvelle facture');
      return pieces;
    };
    const releverHorsDroits = (c, res) => {
      if (res.status >= 500) horsDroits.push(`${c.compte} | ${c.route} | ${c.cible} | ${c.contexte} | ${formaterReponse(res)}`);
    };
    const reponseDe = (res, ecriture) => normaliserMontants(formaterReponse(res, { messageDu400: true, ecriture }));
    const jouer = async (c) => {
      const [methode, chemin] = c.route.split(' ');
      const res = await appeler(appli.adresse, methode, c.chemin, { jeton: jetons[c.compte], corps: c.corps() });
      chiffres.unAUn += 1;
      releverHorsDroits(c, res);
      const apres = await remise.empreinte();
      const changees = tablesChangees(remise.reference, apres);
      const debut = reponseDe(res, changees.length ? `écrit (${changees.join(',')})` : 'inchangé');
      const figees = await constatPiecesFigees(lecture, suivis);
      c.reponse = null;
      if (c.indirect) {
        c.reponse = `${debut} ; ${figees}`;
        lignes.push(ligneMatrice({ compte: c.compte, methode, chemin, cible: c.cible, contexte: c.contexte, reponse: c.reponse }));
      } else {
        const entrees = await entreesNouvelles(lecture);
        const pieces = await piecesDuCas();
        const nomsEntrees = entrees.map((e) => nommerEntree(e, noms, { pieces })).sort();
        assert.equal(new Set(nomsEntrees).size, nomsEntrees.length, `${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : deux entrées de même nom, que les lignes de lecture ne distingueraient pas (${nomsEntrees.join(' + ')})`);
        const montants = await constaterMontants(c, res, entrees);
        c.reponse = `${debut} ; ${nomsEntrees.length ? `entrées : ${nomsEntrees.join(' + ')}` : 'aucune entrée'} ; ${figees} ; ${montants}`;
        lignes.push(ligneMatrice({ compte: c.compte, methode, chemin, cible: c.cible, contexte: c.contexte, reponse: c.reponse }));
        // Lectures des entrées (cadrage §4.6) : SA, AD, l'auteur hors administration, et le compte refusé de la route.
        const taches = entrees.map((entree) => async () => {
          const nom = `${nommerEntree(entree, noms, { pieces })} ← ${c.compte} ${c.route} sur ${c.cible}`;
          const verdicts = await lireVisibilite({ appeler, adresse: appli.adresse, jetons, entree, auteur: c.compte, exportsReference, entreesDuCas: entrees, nom });
          chiffres.lectures += verdicts.length;
          return verdicts.map((v) => ligneMatrice({ compte: v.lecteur, methode: 'GET', chemin: v.route.slice(4), cible: nom, contexte: c.contexte, reponse: v.verdict }));
        });
        for (const groupe of await enParallele(taches, 4)) lignes.push(...groupe);
        assert.deepEqual(tablesChangees(apres, await remise.empreinte()), [], `${c.compte} ${c.route} sur ${c.cible} : une lecture des journaux a écrit`);
      }
      const aRemettre = remise.changees(apres);
      if (aRemettre.length) { await remise.remettre(aRemettre, `${c.compte} ${c.route}, cible ${c.cible}, contexte ${c.contexte}`); chiffres.remises += 1; }
    };
    // Comptes refusés à l'entrée, rejoués avec chaque corps de SA (cadrage §4.2) : en parallèle, une empreinte par lot
    // de 64 au plus ; un lot qui écrit est remis, puis rejoué un à un (comme D1a-5b), si bien que ses écritures, leurs
    // entrées et leurs lectures se lisent dans le diff.
    const jouerLot = async (route, lot) => {
      const resultats = await enParallele(lot.map((c) => () => appeler(appli.adresse, c.route.split(' ')[0], c.chemin, { jeton: jetons[c.compte], corps: c.corps() })), 8);
      chiffres.lots += 1;
      const changees = remise.changees(await remise.empreinte());
      if (changees.length) {
        chiffres.lotsRejoues.push(`${route} (${changees.join(', ')})`);
        await remise.remettre(changees, `lot des comptes refusés de ${route}`);
        for (const c of lot) await jouer(c);
        return;
      }
      chiffres.refusEnLots += lot.length;
      assert.deepEqual(await entreesNouvelles(lecture), [], `lot des comptes refusés de ${route} : entrée nouvelle sans écriture`);
      const figees = await constatPiecesFigees(lecture, suivis);
      const tables = await montantsChanges(lecture);
      const montants = tables.length ? `montants changés en base : ${tables.join(', ')}` : MONTANTS_INCHANGES;
      lot.forEach((c, i) => {
        releverHorsDroits(c, resultats[i]);
        const [methode, chemin] = c.route.split(' ');
        c.reponse = `${reponseDe(resultats[i], 'inchangé')} ; aucune entrée ; ${figees} ; ${montants}`;
        lignes.push(ligneMatrice({ compte: c.compte, methode, chemin, cible: c.cible, contexte: c.contexte, reponse: c.reponse }));
      });
    };

    before(async () => {
      try {
        await exigerRoleReplication(TEST_DATABASE_URL);
      } catch (erreur) {
        refusRole = erreur;
        return;
      }
      await base.creer();
      appli = await chargerApplication(base);
      const connexion = await appeler(appli.adresse, 'POST', '/api/auth/secours', { corps: { token: JETON_SECOURS } });
      assert.equal(connexion.status, 200, JSON.stringify(connexion.body));
      const secours = await appli.prisma.user.findUniqueOrThrow({ where: { email: EMAIL_SECOURS }, select: { id: true, role: true } });
      assert.equal(secours.role, 'SUPERADMIN');
      const crees = await creerComptes({
        prisma: appli.prisma, signer: appli.signer, signerAutreSecret: (i) => appli.jwt.sign({ id: i }, 'autre-secret-que-celui-de-l-application'),
        secours: { id: secours.id, jeton: connexion.body.token },
        supprimerCompte: async (i) => {
          const res = await appeler(appli.adresse, 'DELETE', `/api/users/${i}`, { jeton: connexion.body.token });
          assert.equal(res.status, 200, JSON.stringify(res.body));
        },
        rattacherCompte: async (i, responsableHierarchiqueId) => {
          const res = await appeler(appli.adresse, 'PATCH', `/api/users/${i}/responsable-hierarchique`, { jeton: connexion.body.token, corps: { responsableHierarchiqueId } });
          assert.equal(res.status, 200, JSON.stringify(res.body));
        },
      });
      comptes = crees.comptes;
      for (const [cle, compte] of Object.entries(comptes)) { jetons[cle] = compte.jeton; noms.set(compte.id, cle); }
      await construireJeuDeDonnees({ prisma: appli.prisma, api, comptes, donnees: crees.donnees });
      Object.assign(d, {
        hier: jourSociete(-1), aujourdhui: jourSociete(0), demain: jourSociete(1),
        clientActif: id('client', 'client-actif'), ficheTech: id('fiche-intervenant', 'fiche-tech'),
      });
      for (const nom of ['facture-brouillon', 'facture-emise', 'avoir-emis']) suivis.set(id('facture', nom), nom);
      suivis.set(id('reglement', 'reglement'), 'reglement');
      const avoirEmis = await appli.prisma.facture.findUniqueOrThrow({ where: { id: id('facture', 'avoir-emis') }, select: { factureOrigineId: true } });
      suivis.set(avoirEmis.factureOrigineId, 'facture-avoir');

      // --- Paramétrage propre à ce fichier (cadrage §4.5) ---
      // Compte 445711 et règle de TVA à 5,5 % (sans eux, l'émission de la facture à deux taux répond 409,
      // comptabilite/metier.ts:58-63) ; second compte client et second compte de TVA, pour les remappages des écritures
      // indirectes.
      const compte = async (code, libelle, nature) => (await api(SA, 'POST', '/api/comptabilite/comptes', { code, libelle, nature }, 201)).id;
      const tva55 = await compte('445711', 'TEST TVA à 5,5 % de la matrice des factures', 'TVA');
      await api(SA, 'PUT', '/api/comptabilite/tva/5.5', { compteId: tva55, motif: 'TEST règle de TVA à 5,5 % de la matrice des factures' }, [200, 201]);
      d.clientsBis = await compte('411100', 'TEST Clients bis de la matrice des factures', 'ACTIF');
      d.tvaBis = await compte('445712', 'TEST TVA bis de la matrice des factures', 'TVA');

      // --- Cibles propres (cadrage §4.5), construites par l'API avant l'instantané ---
      const creerClient = async (raisonSociale, siren) => {
        const client = await api(SA, 'POST', '/api/clients', { raisonSociale, siren }, 201);
        await api(SA, 'POST', `/api/clients/${client.id}/sites`, { nom: `TEST Facturation ${raisonSociale}`, adresse: '7 rue des Factures', codePostal: '14000', ville: 'Caen', estSiteFacturation: true }, 201);
        return client.id;
      };
      const brouillon = (clientId, motif, lignesFacture) => api(SA, 'POST', '/api/factures', { clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: motif, dateEmission: d.aujourdhui, dateEcheance: d.aujourdhui, lignes: lignesFacture }, 201);
      const emettre = async (nom, prix, clientId = d.clientActif) => {
        const creee = await brouillon(clientId, `TEST ${nom} de la matrice des factures`, [{ designation: `TEST Ligne de ${nom}`, quantite: 1, prixUnitaireHt: prix, tauxTva: 20 }]);
        await api(SA, 'POST', `/api/factures/${creee.id}/emettre`, {});
        suivis.set(creee.id, nom);
        return creee.id;
      };
      const regler = async (nom, factureId, montant, clientId = d.clientActif) => {
        const r = await api(SA, 'POST', '/api/reglements', { clientId, dateReglement: d.aujourdhui, montant, moyen: 'VIREMENT', affectations: [{ factureId, montant }] }, 201);
        suivis.set(r.id, nom);
        return r.id;
      };
      const avoir = async (nom, factureId, ligne) => {
        const a = await api(SA, 'POST', `/api/factures/${factureId}/avoirs`, { lignes: [ligne] }, 201);
        suivis.set(a.id, nom);
      };
      // Émise, ni règlement ni avoir : annulable.
      await emettre('facture-emise-non-reglee', MONTANTS.cibles.emiseNonReglee);
      // Émise puis soldée par un règlement de 60 (60 TTC) : réglée ; la contre-passation de ce règlement la rend émise.
      await regler('reglement-solde', await emettre('facture-reglee', MONTANTS.cibles.reglee), 60);
      // Émise puis annulée, avec son avoir total.
      const annulee = await emettre('facture-annulee', MONTANTS.cibles.annulee);
      suivis.set((await api(SA, 'POST', `/api/factures/${annulee}/annuler`, {})).avoir.id, 'avoir-total');
      // Émise, avec un premier avoir partiel de 0,53 HT (TVA 0,11), et un règlement de 10 contre-passé.
      const avecAvoir = await emettre('facture-avoir-partiel', MONTANTS.cibles.avoirPartiel);
      await avoir('avoir-de-facture-avoir-partiel', avecAvoir, MONTANTS.ligneAvoir);
      const aContrepasser = await regler('reglement-contrepasse', avecAvoir, 10);
      await api(SA, 'POST', `/api/reglements/${aContrepasser}/contrepasser`, { motif: 'TEST contre-passation préalable de la matrice des factures' });
      // Soldée par un avoir partiel de son montant, sans règlement : reste émise, reste dû nul (refus « soldée »,
      // reglements/routes.ts:101). Cible ajoutée au §4.5, nécessaire au refus « soldée (409) » du tableau §4.1.
      const soldee = await emettre('facture-soldee-par-avoir', MONTANTS.cibles.soldeeParAvoir);
      await avoir('avoir-de-facture-soldee-par-avoir', soldee, { designation: 'TEST Avoir soldant de la matrice des factures', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: MONTANTS.cibles.soldeeParAvoir, tauxTva: 20 });
      // Facture d'un autre client (refus « autre client ») ; facture d'un client désactivé après l'émission (règlement admis,
      // choix par défaut, à confirmer, appliqué par #155).
      d.clientSecond = await creerClient('TEST Client second de la matrice des factures', '552100562');
      await emettre('facture-autre-client', MONTANTS.cibles.autreClient, d.clientSecond);
      d.clientDesactive = await creerClient('TEST Client désactivé après facture de la matrice des factures', '552100570');
      await emettre('facture-client-desactive', MONTANTS.cibles.clientDesactive, d.clientDesactive);
      await api(SA, 'DELETE', `/api/clients/${d.clientDesactive}`, {});
      // Brouillon à trois lignes et deux taux, émis par la matrice.
      suivis.set((await brouillon(d.clientActif, 'TEST facture à deux taux de la matrice des factures', MONTANTS.lignes)).id, 'facture-brouillon-deux-taux');
      // Intervention au temps passé : main d'œuvre à 61,70, pas de 15 minutes, devis au temps passé signé et converti,
      // placée, démarrée, 1,1 h du technicien, compte rendu, terminée (motif) ; prix de la main d'œuvre changé à 99,99
      // après la signature.
      const corpsMainOeuvre = (prix) => ({ estMainOeuvre: true, reference: 'TEST-FACTURES-MO-TP', nom: 'TEST Main d’œuvre au temps passé de la matrice des factures', tauxTva: 20, prixVenteHt: prix, prixJourHorsContratHt: 430, prixHeureSousContratHt: 57.25, prixJourSousContratHt: 390, heuresParJour: 7 });
      d.mainOeuvre = (await api(SA, 'POST', '/api/catalogue/prestations', corpsMainOeuvre(MONTANTS.tempsPasse.prixDevis), 201)).id;
      d.corpsMainOeuvre = corpsMainOeuvre;
      await api(SA, 'PUT', '/api/parametres', { pasTempsPasseMinutes: MONTANTS.tempsPasse.pasMinutes });
      const devis = await api(SA, 'POST', '/api/devis', { clientId: d.clientActif, objet: 'TEST Devis au temps passé de la matrice des factures', auTempsPasse: true, lignes: [{ tempsPasse: true, designation: 'TEST Main d’œuvre au temps passé', quantite: 1, tarifTempsPasse: 'HORS_CONTRAT', catalogueFamille: 'prestations', catalogueId: d.mainOeuvre }] }, 201);
      await api(SA, 'PUT', `/api/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
      await api(SA, 'POST', `/api/devis/${devis.id}/signature`, { signataire: 'TEST Signataire de la matrice des factures', confirme: true }, 201);
      const intervention = await api(SA, 'POST', `/api/devis/${devis.id}/convertir`, { cible: 'INTERVENTION' }, 201);
      await api(SA, 'PUT', `/api/interventions/${intervention.id}/planning`, { dateDebut: d.hier, creneau: 'JOURNEE', intervenantIds: [d.ficheTech] }, [200, 201]);
      if ((await appli.prisma.intervention.findUniqueOrThrow({ where: { id: intervention.id } })).statut === 'A_PLANIFIER') await api(SA, 'PATCH', `/api/interventions/${intervention.id}/statut`, { statut: 'PLANIFIEE' });
      await api(SA, 'PATCH', `/api/interventions/${intervention.id}/statut`, { statut: 'EN_COURS' });
      await api('TECH', 'POST', `/api/interventions/${intervention.id}/couts/heures`, { date: d.hier, nbrHeures: MONTANTS.tempsPasse.heures }, 201);
      await api('TECH', 'POST', `/api/interventions/${intervention.id}/rapports`, { contenu: 'TEST Compte rendu au temps passé de la matrice des factures', cleEnvoi: randomUUID() }, 201);
      await api(SA, 'PATCH', `/api/interventions/${intervention.id}/statut`, { statut: 'TERMINEE', motifSansSignature: 'CLIENT_ABSENT' });
      await api(SA, 'PUT', `/api/catalogue/prestations/${d.mainOeuvre}`, corpsMainOeuvre(MONTANTS.tempsPasse.prixApresSignature));
      await api(SA, 'PUT', '/api/parametres', { pasTempsPasseMinutes: MONTANTS.tempsPasse.pasApresSignature, tempsMinimumMinutes: MONTANTS.tempsPasse.minimumApresSignature });
      d.interventionTempsPasse = intervention.id;
      d.devisTempsPasse = devis.id;
      d.apercu = await api(SA, 'GET', `/api/interventions/${intervention.id}/facture-temps-passe`);
      // Version brouillon des mentions légales, publiée par une écriture indirecte.
      d.versionBrouillon = (await api(SA, 'POST', '/api/mentions-legales', { mentions: 'TEST mentions de la matrice des factures v2', cgv: 'TEST CGV v2', penalites: 'TEST pénalités v2' }, 201)).version;
      // Versions des règles comptables, relues en base pour les remappages.
      const regleClient = await appli.prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'CLIENT' } });
      const regleTva = await appli.prisma.regleTvaComptable.findFirstOrThrow({ where: { taux: 20 } });
      Object.assign(d, { regleClientValeur: regleClient.compteId, regleClientMaj: regleClient.updatedAt.toISOString(), regleTvaCompte: regleTva.compteId, regleTvaMaj: regleTva.updatedAt.toISOString() });

      // --- Valeurs relues avant l'instantané, pour le témoin des montants ---
      const facture = async (factureId) => {
        const f = await appli.prisma.facture.findUniqueOrThrow({ where: { id: factureId }, select: { totalHt: true, totalTtc: true, statut: true } });
        return [Number(f.totalHt), Number(f.totalTtc), f.statut];
      };
      const ligneDevis = await appli.prisma.devisLigne.findFirstOrThrow({ where: { devisId: devis.id, tempsPasse: true } });
      const devisFige = await appli.prisma.devis.findUniqueOrThrow({ where: { id: devis.id }, select: { tempsMinimumMinutes: true, pasTempsPasseMinutes: true } });
      const heures = await appli.prisma.coutInterventionHeure.findMany({ where: { interventionId: intervention.id } });
      const reglages = await appli.prisma.parametres.findUniqueOrThrow({ where: { id: 'singleton' }, select: { pasTempsPasseMinutes: true, tempsMinimumMinutes: true } });
      d.temoin = {
        jeu: Object.fromEntries(await Promise.all(['facture-brouillon', 'facture-emise', 'avoir-emis', 'facture-avoir'].map(async (nom) => [nom, await facture(idDe(nom))]))),
        reglementJeu: Number((await appli.prisma.reglement.findUniqueOrThrow({ where: { id: id('reglement', 'reglement') } })).montant),
        reglementSolde: Number((await appli.prisma.reglement.findUniqueOrThrow({ where: { id: idDe('reglement-solde') } })).montant),
        cibles: Object.fromEntries(await Promise.all(['facture-emise-non-reglee', 'facture-reglee', 'facture-annulee', 'avoir-total', 'facture-avoir-partiel', 'avoir-de-facture-avoir-partiel', 'facture-soldee-par-avoir', 'avoir-de-facture-soldee-par-avoir', 'facture-autre-client', 'facture-client-desactive', 'facture-brouillon-deux-taux'].map(async (nom) => [nom, await facture(idDe(nom))]))),
        clients: [(await appli.prisma.client.findUniqueOrThrow({ where: { id: d.clientDesactive } })).actif, (await appli.prisma.client.findUniqueOrThrow({ where: { id: d.clientSecond } })).actif],
        tempsPasse: {
          heures: heures.map((h) => Number(h.nbrHeures)), prixDevis: Number(ligneDevis.prixUnitaireHt), minimum: devisFige.tempsMinimumMinutes, pas: devisFige.pasTempsPasseMinutes,
          prixCatalogue: Number((await appli.prisma.cataloguePrestation.findUniqueOrThrow({ where: { id: d.mainOeuvre } })).prixVenteHt), apercu: d.apercu.totalHt,
          reglagesDuJour: [reglages.pasTempsPasseMinutes, reglages.tempsMinimumMinutes],
        },
      };

      // Instantané et outil de remise en état, une fois tout construit ; connexion de lecture.
      const tables = await tablesDeLaBase(appli.prisma);
      remise = await creerRemiseEnEtat({ url: base.url, nomBase: base.nom, tables, connexionApplication: appli.serveur.prisma, factureEmiseId: id('facture', 'facture-emise') });
      lecture = await ouvrirConnexionLecture(base.url);
      assert.deepEqual(await entreesNouvelles(lecture), [], 'aucune entrée nouvelle juste après l’instantané');
      construireCas();
    });

    after(async () => {
      await lecture?.end().catch(() => {});
      await remise?.fermer();
      await appli?.fermer();
      await base.supprimer();
    });

    // --- Table des cas (cadrage §4.1 et §4.4) ---
    function construireCas() {
      const corpsVide = () => ({});
      const piece = (route, nom) => route.split(' ')[1].replace(':id', idDe(nom));
      for (const compte of ADMINISTRATION) {
        // POST /api/factures : les quatre origines, avec les trois lignes à deux taux ; refus.
        const corpsFacture = (extra = {}) => () => ({ clientId: d.clientActif, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST facture de la matrice des factures', dateEmission: d.aujourdhui, dateEcheance: d.aujourdhui, lignes: MONTANTS.lignes, ...extra });
        const origine = (champ, valeur, nomOrigine) => ({ origine: nomOrigine, motifHorsAffaire: undefined, [champ]: valeur });
        const facture = (cible, contexte, corps, options) => ajouter(compte, 'POST /api/factures', cible, contexte, '/api/factures', corps, options);
        const deuxTaux = 'défaut, corps trois lignes à deux taux';
        const creation = { genre: 'creation', attendu: MONTANTS.factureDeuxTaux };
        facture('clientId=client-actif', deuxTaux, corpsFacture(), { code: 201, montant: creation });
        facture('chantierId=chantier-ct', deuxTaux, corpsFacture(origine('chantierId', id('chantier', 'chantier-ct'), 'CHANTIER')), { code: 201, montant: creation });
        facture('interventionId=intervention-terminee-motif', deuxTaux, corpsFacture(origine('interventionId', id('intervention', 'intervention-terminee-motif'), 'INTERVENTION')), { code: 201, montant: creation });
        facture('contratMaintenanceId=contrat-actif', deuxTaux, corpsFacture(origine('contratMaintenanceId', id('contrat', 'contrat-actif'), 'CONTRAT')), { code: 201, montant: creation });
        facture('clientId=client-actif', 'défaut, corps date d’émission future', corpsFacture({ dateEmission: d.demain, dateEcheance: d.demain }), { code: 400 });
        facture('clientId=client-actif', 'défaut, corps échéance avant l’émission', corpsFacture({ dateEcheance: d.hier }), { code: 400 });
        facture('clientId=client-actif', 'défaut, corps taux non français', corpsFacture({ lignes: [{ ...LIGNE_A, tauxTva: 7 }] }), { code: 400 });
        facture('clientId=client-actif', 'défaut, corps origine hors affaire avec un chantier', corpsFacture({ chantierId: id('chantier', 'chantier-ct') }), { code: 400 });
        facture('clientId=client-desactive', deuxTaux, corpsFacture({ clientId: id('client', 'client-desactive') }), { code: 404 });
        facture('chantierId=chantier-annule', deuxTaux, corpsFacture(origine('chantierId', id('chantier', 'chantier-annule'), 'CHANTIER')), { code: 409 });
        facture('interventionId=intervention-temps-passe', deuxTaux, corpsFacture(origine('interventionId', d.interventionTempsPasse, 'INTERVENTION')), { code: 409 });

        // Émission du brouillon à deux taux, écritures relues (les refus de l'émission sont joués en 5a).
        const emission = 'POST /api/factures/:id/emettre';
        ajouter(compte, emission, 'facture-brouillon-deux-taux', 'défaut', piece(emission, 'facture-brouillon-deux-taux'), corpsVide, {
          code: 200, montant: { genre: 'emission', attendu: { ...MONTANTS.factureDeuxTaux, statut: 'EMISE', ecritures: MONTANTS.ecrituresEmission } },
        });
        // « Réglée » à la main : 410 (D1a-1 l'enregistre à corps vide), inchangé.
        ajouter(compte, 'POST /api/factures/:id/regler', 'facture-emise', 'défaut', piece('POST /api/factures/:id/regler', 'facture-emise'), corpsVide, { code: 410 });

        // Annulation : avoir total de facture-emise-non-reglee ; refus.
        const annuler = 'POST /api/factures/:id/annuler';
        ajouter(compte, annuler, 'facture-emise-non-reglee', 'défaut', piece(annuler, 'facture-emise-non-reglee'), corpsVide, { code: 200, montant: { genre: 'annulation', attendu: MONTANTS.avoirTotal } });
        for (const nom of ['facture-brouillon', 'avoir-emis', 'facture-reglee', 'facture-annulee', 'facture-emise', 'facture-avoir-partiel']) ajouter(compte, annuler, nom, 'défaut', piece(annuler, nom), corpsVide, { code: 409 });

        // Avoirs partiels : émise, réglée, avec avoir partiel ; refus.
        const avoirs = 'POST /api/factures/:id/avoirs';
        const uneLigne = 'défaut, corps une ligne';
        const corpsAvoir = (ligne = MONTANTS.ligneAvoir) => () => ({ lignes: [ligne] });
        ajouter(compte, avoirs, 'facture-emise', uneLigne, piece(avoirs, 'facture-emise'), corpsAvoir(), { code: 201, montant: { genre: 'avoir', attendu: MONTANTS.avoirSeul } });
        ajouter(compte, avoirs, 'facture-reglee', uneLigne, piece(avoirs, 'facture-reglee'), corpsAvoir(), { code: 201, montant: { genre: 'avoir', attendu: MONTANTS.avoirSeul } });
        ajouter(compte, avoirs, 'facture-avoir-partiel', uneLigne, piece(avoirs, 'facture-avoir-partiel'), corpsAvoir(), { code: 201, montant: { genre: 'avoir', attendu: MONTANTS.avoirApresAvoir } });
        // Refus : 1 × 1 000 HT dépasse le reste à créditer de facture-emise (100 HT) ; taux de 5,5 %, absent de la facture.
        // Seule l'absence d'écriture est attendue : montants relus inchangés.
        ajouter(compte, avoirs, 'facture-emise', 'défaut, corps au-delà du reste à créditer', piece(avoirs, 'facture-emise'), corpsAvoir({ ...MONTANTS.ligneAvoir, quantite: 1, prixUnitaireHt: 1000 }), { code: 409 });
        ajouter(compte, avoirs, 'facture-emise', 'défaut, corps taux absent de la facture', piece(avoirs, 'facture-emise'), corpsAvoir({ ...MONTANTS.ligneAvoir, tauxTva: 5.5 }), { code: 400 });
        for (const nom of ['facture-brouillon', 'avoir-emis', 'facture-annulee']) ajouter(compte, avoirs, nom, uneLigne, piece(avoirs, nom), corpsAvoir(), { code: 409 });

        // Envoi d'une facture par la messagerie (jamais Microsoft 365, avenant §2). La facture annulée garde son document, et
        // son envoi est admis (201) : passation, section 4, bloc « Envoi des documents par la messagerie et journal des
        // envois » (lot 6a-3), « toute facture ou tout avoir émis (émis, réglé ou annulé) » ; STATUTS_DOCUMENT_FACTURE,
        // factures/metier.ts:27 (N4 de l'audit des droits et N1 de l'audit des montants de #460).
        const envois = 'POST /api/factures/:id/envois';
        for (const [nom, code] of [['facture-emise', 201], ['avoir-emis', 201], ['facture-brouillon', 409], ['facture-annulee', 201]]) {
          ajouter(compte, envois, nom, 'défaut, corps destinataire, messagerie', piece(envois, nom), () => ({ destinataire: DESTINATAIRE }), { code });
        }

        // Facture au temps passé : total de l'aperçu lu avant l'instantané ; autre total (77,12, l'arrondi au pair) ;
        // chaque cible de la famille intervention.
        const tempsPasse = 'POST /api/interventions/:id/facture-temps-passe';
        const corpsTempsPasse = (total) => () => ({ dateEmission: d.aujourdhui, dateEcheance: d.aujourdhui, totalHtAttendu: total });
        const cheminTempsPasse = (interventionId) => `/api/interventions/${interventionId}/facture-temps-passe`;
        ajouter(compte, tempsPasse, 'intervention-temps-passe', 'défaut, corps dates et total de l’aperçu', cheminTempsPasse(d.interventionTempsPasse), corpsTempsPasse(d.apercu.totalHt), {
          code: 201, montant: { genre: 'creation', attendu: MONTANTS.factureTempsPasse, heures: { saisies: MONTANTS.tempsPasse.heures, facturees: MONTANTS.factureTempsPasse.lignes[0].quantite } },
        });
        ajouter(compte, tempsPasse, 'intervention-temps-passe', 'défaut, corps dates et autre total', cheminTempsPasse(d.interventionTempsPasse), corpsTempsPasse(MONTANTS.tempsPasse.totalHtAutre), { code: 409 });
        for (const c of FAMILLES.intervention.cibles) {
          ajouter(compte, tempsPasse, c.nom, 'défaut, corps dates et total de l’aperçu', cheminTempsPasse(c.ids.id), corpsTempsPasse(d.apercu.totalHt), { code: c.nom === 'inexistant' ? 404 : 409 });
        }

        // Règlements (cible portée par le corps : factureId).
        const reglements = 'POST /api/reglements';
        const corpsReglement = (parts, { clientId = d.clientActif, date = d.aujourdhui, montant = somme(parts.map(([, m]) => m)) } = {}) => () => ({
          clientId, dateReglement: date, montant, moyen: 'VIREMENT', affectations: parts.map(([nom, m]) => ({ factureId: idDe(nom), montant: m })),
        });
        const reglement = (cible, contexte, parts, options, attendu) => ajouter(compte, reglements, cible, contexte, '/api/reglements', corpsReglement(parts, options), attendu);
        const cree = (parts, restes, statuts) => ({ genre: 'reglement', montant: somme(parts.map(([, m]) => m)), parts, restes, statuts });
        reglement('factureId=facture-emise', 'défaut, corps reste dû moins un centime', [['facture-emise', MONTANTS.reglementPartiel]], {},
          { code: 201, montant: cree([['facture-emise', MONTANTS.reglementPartiel]], [['facture-emise', 0.01]], [['facture-emise', 'EMISE']]) });
        reglement('factureId=facture-emise', 'défaut, corps reste dû', [['facture-emise', MONTANTS.reglementSolde]], {},
          { code: 201, montant: cree([['facture-emise', MONTANTS.reglementSolde]], [['facture-emise', 0]], [['facture-emise', 'REGLEE']]) });
        reglement('factureId=facture-emise', 'défaut, corps surplus d’un centime', [['facture-emise', MONTANTS.reglementSurplus]], {},
          { code: 201, montant: cree([['facture-emise', MONTANTS.reglementSurplus]], [['facture-emise', -0.01]], [['facture-emise', 'REGLEE']]) });
        const deux = [['facture-emise', MONTANTS.reglementDeuxFactures[0]], ['facture-emise-non-reglee', MONTANTS.reglementDeuxFactures[1]]];
        reglement('factureId=facture-emise et facture-emise-non-reglee', 'défaut, corps deux factures, la première soldée, la seconde encore due', deux, {},
          { code: 201, montant: cree(deux, [['facture-emise', 0], ['facture-emise-non-reglee', 0.01]], [['facture-emise', 'REGLEE'], ['facture-emise-non-reglee', 'EMISE']]) });
        const desactive = [['facture-client-desactive', MONTANTS.reglementClientDesactive]];
        reglement('factureId=facture-client-desactive', 'défaut, corps client désactivé, reste dû moins un centime', desactive, { clientId: d.clientDesactive },
          { code: 201, montant: cree(desactive, [['facture-client-desactive', 0.01]], [['facture-client-desactive', 'EMISE']]) });
        reglement('factureId=facture-emise', 'défaut, corps non affecté en entier', [['facture-emise', MONTANTS.reglementPartiel]], { montant: MONTANTS.reglementSolde }, { code: 400 });
        reglement('factureId=facture-emise', 'défaut, corps date future', [['facture-emise', MONTANTS.reglementSolde]], { date: d.demain }, { code: 400 });
        reglement('factureId=facture-emise', 'défaut, corps date avant l’émission', [['facture-emise', MONTANTS.reglementSolde]], { date: d.hier }, { code: 409 });
        // Refus selon la pièce : un règlement de 10, dont seule l'absence d'écriture est attendue (montants relus inchangés).
        for (const nom of ['facture-brouillon', 'facture-reglee', 'avoir-emis', 'facture-annulee', 'facture-autre-client', 'facture-soldee-par-avoir']) {
          reglement(`factureId=${nom}`, 'défaut, corps règlement de la facture', [[nom, 10]], {}, { code: 409 });
        }
        reglement('factureId=facture-emise et facture-emise-non-reglee', 'défaut, corps surplus sur la première, la seconde encore due', [['facture-emise', MONTANTS.reglementSurplusEtDue[0]], ['facture-emise-non-reglee', MONTANTS.reglementSurplusEtDue[1]]], {}, { code: 409 });

        // Contre-passation : règlement partiel, règlement qui soldait ; déjà contre-passé ; sans motif.
        const contrepasser = 'POST /api/reglements/:id/contrepasser';
        const motif = () => ({ motif: 'TEST contre-passation par la matrice des factures' });
        ajouter(compte, contrepasser, 'reglement', 'défaut, corps motif', piece(contrepasser, 'reglement'), motif, {
          code: 200, montant: { genre: 'contrepassation', reglement: 'reglement', montant: 50, parts: [['facture-emise', 50]], restes: [['facture-emise', 120]], statuts: [['facture-emise', 'EMISE']] },
        });
        ajouter(compte, contrepasser, 'reglement-solde', 'défaut, corps motif', piece(contrepasser, 'reglement-solde'), motif, {
          code: 200, montant: { genre: 'contrepassation', reglement: 'reglement-solde', montant: 60, parts: [['facture-reglee', 60]], restes: [['facture-reglee', 60]], statuts: [['facture-reglee', 'EMISE']] },
        });
        ajouter(compte, contrepasser, 'reglement-contrepasse', 'défaut, corps motif', piece(contrepasser, 'reglement-contrepasse'), motif, { code: 409 });
        ajouter(compte, contrepasser, 'reglement', 'défaut, corps sans motif', piece(contrepasser, 'reglement'), corpsVide, { code: 400 });
      }
      // Comptes refusés à l'entrée : chaque cas de SA sur ces routes, rejoué par chacun (cadrage §4.2).
      const casDeSa = cas.filter((c) => c.compte === SA);
      for (const compte of REFUSES) for (const c of casDeSa) cas.push({ ...c, compte, code: 403, montant: null, enLot: true });

      // Écritures indirectes jouées avec le constat des pièces figées (cadrage §4.1), par SA, AD et DIR (droits de
      // l'administration, comme AD).
      for (const compte of [SA, 'AD', 'DIR']) {
        const indirect = (route, cible, contexte, chemin, corps) => ajouter(compte, route, cible, contexte, chemin, corps, { indirect: true });
        indirect('PUT /api/company', SANS_CIBLE, 'défaut, corps raison sociale changée', '/api/company', () => ({ ...SOCIETE, raisonSociale: 'TEST Société matrice des droits renommée' }));
        indirect('PUT /api/clients/:id', 'client-actif', 'défaut, corps raison sociale changée', `/api/clients/${d.clientActif}`, () => ({ raisonSociale: 'TEST Client actif matrice renommé' }));
        indirect('POST /api/mentions-legales', SANS_CIBLE, 'défaut, corps mentions, CGV et pénalités', '/api/mentions-legales', () => ({ mentions: 'TEST mentions de la matrice des factures v3', cgv: 'TEST CGV v3', penalites: 'TEST pénalités v3' }));
        indirect('POST /api/mentions-legales/:version/publier', 'version-brouillon', 'défaut', `/api/mentions-legales/${d.versionBrouillon}/publier`, () => ({}));
        indirect('PUT /api/comptabilite/regles/:cle', 'cle=CLIENT', 'défaut, corps autre compte client, version et motif', '/api/comptabilite/regles/CLIENT', () => ({ compteId: d.clientsBis, expectedValeur: d.regleClientValeur, expectedUpdatedAt: d.regleClientMaj, motif: 'TEST remappage par la matrice des factures' }));
        indirect('PUT /api/comptabilite/tva/:taux', 'taux=20', 'défaut, corps autre compte de TVA, version et motif', '/api/comptabilite/tva/20', () => ({ compteId: d.tvaBis, expectedCompteId: d.regleTvaCompte, expectedUpdatedAt: d.regleTvaMaj, motif: 'TEST remappage par la matrice des factures' }));
        indirect('PUT /api/catalogue/:family/:id', 'main-oeuvre-temps-passe', 'défaut, corps main d’œuvre, prix horaire changé', `/api/catalogue/prestations/${d.mainOeuvre}`, () => d.corpsMainOeuvre(MONTANTS.prixMainOeuvreChange));
      }
    }

    // Avenant, section 1 : « les fichiers de D1a-5 l'exigent et échouent avec un message clair si le rôle de
    // TEST_DATABASE_URL ne peut pas poser ce paramètre — jamais de SKIP ».
    test('rôle PostgreSQL : le rôle de TEST_DATABASE_URL peut poser session_replication_role, sans quoi la base ne peut pas être remise en état entre deux cas (échec clair, jamais un SKIP)', () => {
      if (refusRole) throw refusRole;
    });

    // Cadrage §3 (« chaque attendu est écrit en dur, avec la lecture écartée en commentaire, et vérifié par un test
    // témoin ») et §4.4 ; règle des montants du rédacteur des tests : chaque attendu recalculé en décimal exact, chaque
    // lecture écartée calculée et distincte de l'attendu, les valeurs du jeu de données et des cibles relues en base.
    testPrepare('témoin des montants : attendus du tableau 4.4 recalculés en décimal exact, chaque lecture écartée distincte, valeurs du jeu de données et des cibles relues en base', () => {
      const [a, b, c] = MONTANTS.lignes;
      const ht = [a, b, c].map((l) => exact.ligneHt(l.quantite, l.prixUnitaireHt));
      const ttc = [a, b, c].map((l, i) => exact.ttcLigne(ht[i], l.tauxTva));
      const base20 = ht[0] + ht[1]; const tva20 = exact.tva(base20, 20); const tva55 = exact.tva(ht[2], 5.5);
      const totalHt = ht[0] + ht[1] + ht[2]; const totalTva = tva20 + tva55;
      const f = MONTANTS.factureDeuxTaux;
      assert.deepEqual(f.lignes.map((l) => [l.totalHt, l.totalTtc]), ht.map((h, i) => [exact.euros(h), exact.euros(ttc[i])]), 'lignes : HT et TTC de ligne');
      assert.deepEqual(f.ventilation, [[5.5, exact.euros(ht[2]), exact.euros(tva55), exact.euros(ht[2] + tva55)], [20, exact.euros(base20), exact.euros(tva20), exact.euros(base20 + tva20)]], 'ventilation par taux');
      assert.deepEqual([f.totalHt, f.totalTva, f.totalTtc], [exact.euros(totalHt), exact.euros(totalTva), exact.euros(totalHt + totalTva)], 'totaux');
      assert.deepEqual(MONTANTS.ecrituresEmission, [['CLIENT', '411000', exact.euros(totalHt + totalTva), 0], ['TVA:20', '445710', 0, exact.euros(tva20)], ['TVA:5.5', '445711', 0, exact.euros(tva55)], ['VENTE_ARTICLE', '707000', 0, exact.euros(ht[1])], ['VENTE_PRESTATION', '706000', 0, exact.euros(ht[0] + ht[2])]], 'écritures de l’émission');
      // Lectures écartées de la facture.
      assert.notEqual(Math.round(a.quantite * a.prixUnitaireHt * 100) / 100, f.lignes[0].totalHt, 'calcul flottant de la ligne A');
      assert.notEqual(exact.euros(arrondiAuPair(enUnites(a.quantite, 3) * enUnites(a.prixUnitaireHt, 2) / 100n)), f.lignes[0].totalHt, 'arrondi au pair de la ligne A');
      assert.notEqual(exact.euros(exact.tva(ht[0], 20) + exact.tva(ht[1], 20)), f.ventilation[1][2], 'TVA ligne par ligne');
      for (const taux of [5, 6]) assert.notEqual(exact.euros(exact.tva(ht[2], taux)), f.ventilation[0][2], `taux recopié à ${taux} %`);
      assert.notEqual(exact.euros(ttc[0] + ttc[1] + ttc[2]), f.totalTtc, 'TTC par ligne');
      assert.notEqual(exact.euros(ht[0] + ht[1] + ht[2]), MONTANTS.ecrituresEmission[4][3], 'nature mal ventilée (706 crédit de tout le HT)');
      // Avoirs partiels : base cumulée, et avoir seul.
      const htAvoir = exact.ligneHt(MONTANTS.ligneAvoir.quantite, MONTANTS.ligneAvoir.prixUnitaireHt);
      const tvaApres = exact.tva(htAvoir * 2n, 20) - exact.tva(htAvoir, 20);
      assert.deepEqual([MONTANTS.avoirApresAvoir.totalHt, MONTANTS.avoirApresAvoir.totalTva, MONTANTS.avoirApresAvoir.totalTtc, MONTANTS.avoirApresAvoir.lignes[0].totalTtc], [exact.euros(htAvoir), exact.euros(tvaApres), exact.euros(htAvoir + tvaApres), exact.euros(exact.ttcLigne(htAvoir, 20))], 'avoir après un premier avoir');
      assert.deepEqual([MONTANTS.avoirSeul.totalTva, MONTANTS.avoirSeul.totalTtc], [exact.euros(exact.tva(htAvoir, 20)), exact.euros(htAvoir + exact.tva(htAvoir, 20))], 'avoir sans avoir précédent');
      assert.notEqual(MONTANTS.avoirSeul.totalTva, MONTANTS.avoirApresAvoir.totalTva, 'TVA de l’avoir seul');
      // Facture au temps passé.
      const tp = MONTANTS.tempsPasse;
      const minutesSaisies = Math.round(tp.heures * 60);
      const minutes = tp.minimumMinutes + Math.ceil(Math.max(0, minutesSaisies - tp.minimumMinutes) / tp.pasMinutes) * tp.pasMinutes;
      const htTp = exact.ligneHt(minutes / 60, tp.prixDevis);
      const tvaTp = exact.tva(htTp, 20);
      const ft = MONTANTS.factureTempsPasse;
      assert.deepEqual([ft.lignes[0].quantite, ft.totalHt, ft.totalTva, ft.totalTtc, ft.lignes[0].totalTtc, ft.ventilation[0]], [minutes / 60, exact.euros(htTp), exact.euros(tvaTp), exact.euros(htTp + tvaTp), exact.euros(exact.ttcLigne(htTp, 20)), [20, exact.euros(htTp), exact.euros(tvaTp), exact.euros(htTp + tvaTp)]], 'facture au temps passé');
      for (const [ecartee, quoi] of [
        [exact.euros(arrondiAuPair(enUnites(minutes / 60, 3) * enUnites(tp.prixDevis, 2) / 100n)), 'arrondi au pair'],
        [exact.euros(exact.ligneHt(tp.heures, tp.prixDevis)), 'sans le pas'],
        [exact.euros(exact.ligneHt(Math.round(minutesSaisies / tp.pasMinutes) * tp.pasMinutes / 60, tp.prixDevis)), 'au pas le plus proche'],
        [exact.euros(exact.ligneHt(minutes / 60, tp.prixApresSignature)), 'prix du catalogue après la signature'],
        [exact.euros(exact.ligneHt((tp.minimumMinutes + Math.ceil(Math.max(0, minutesSaisies - tp.minimumMinutes) / tp.pasApresSignature) * tp.pasApresSignature) / 60, tp.prixDevis)), 'pas du jour après la signature'],
        [exact.euros(exact.ligneHt((tp.minimumApresSignature + Math.ceil(Math.max(0, minutesSaisies - tp.minimumApresSignature) / tp.pasMinutes) * tp.pasMinutes) / 60, tp.prixDevis)), 'minimum du jour après la signature'],
      ]) assert.notEqual(ecartee, ft.totalHt, `facture au temps passé, lecture écartée : ${quoi}`);
      // Règlements : un arrondi à l'euro ou au dixième changerait le statut ou le reste dû.
      for (const m of [MONTANTS.reglementPartiel, MONTANTS.reglementSurplus, MONTANTS.reglementDeuxFactures[1], MONTANTS.reglementClientDesactive]) {
        assert.ok(m !== Math.round(m) && m !== Math.round(m * 10) / 10, `règlement ${m} : ni l’euro, ni le dixième`);
      }
      // Valeurs relues en base avant l'instantané.
      const t = d.temoin;
      assert.deepEqual(t.jeu, { 'facture-brouillon': [10, 12, 'BROUILLON'], 'facture-emise': [100, 120, 'EMISE'], 'avoir-emis': [10, 12, 'EMISE'], 'facture-avoir': [80, 96, 'EMISE'] }, 'pièces du jeu de données');
      assert.equal(t.reglementJeu, 50, 'règlement du jeu de données : facture-emise reste due de 70');
      assert.deepEqual(t.cibles, {
        'facture-emise-non-reglee': [200, 240, 'EMISE'], 'facture-reglee': [50, 60, 'REGLEE'], 'facture-annulee': [30, 36, 'ANNULEE'], 'avoir-total': [30, 36, 'EMISE'],
        'facture-avoir-partiel': [300, 360, 'EMISE'], 'avoir-de-facture-avoir-partiel': [0.53, 0.64, 'EMISE'], 'facture-soldee-par-avoir': [20, 24, 'EMISE'], 'avoir-de-facture-soldee-par-avoir': [20, 24, 'EMISE'],
        'facture-autre-client': [45, 54, 'EMISE'], 'facture-client-desactive': [40, 48, 'EMISE'], 'facture-brouillon-deux-taux': [101.05, 106.76, 'BROUILLON'],
      }, 'cibles propres');
      assert.deepEqual(t.clients, [false, true], 'client désactivé après l’émission de sa facture ; client second actif');
      const htJeu = [10, 100, 80];
      for (const [nom, ht] of Object.entries(MONTANTS.cibles)) assert.ok(!htJeu.includes(ht), `cible ${nom} : montant distinct du jeu de données`);
      assert.equal(new Set(Object.values(MONTANTS.cibles)).size, Object.values(MONTANTS.cibles).length, 'montants des cibles distincts entre eux');
      assert.deepEqual(t.tempsPasse, { heures: [tp.heures], prixDevis: tp.prixDevis, minimum: tp.minimumMinutes, pas: tp.pasMinutes, prixCatalogue: tp.prixApresSignature, apercu: ft.totalHt, reglagesDuJour: [tp.pasApresSignature, tp.minimumApresSignature] }, 'facture au temps passé : heures, prix figé du devis, minimum et pas figés, prix du catalogue et réglages changés après la signature, aperçu');
      // Avoir total de facture-emise-non-reglee : totaux, ligne, ventilation et écritures recalculés en décimal exact depuis
      // le HT relu en base ; les écritures sont celles de l'émission, débit et crédit inversés. Lecture écartée : écritures
      // recopiées sans inversion.
      const htAnnulee = enUnites(t.cibles['facture-emise-non-reglee'][0], 2);
      const tvaAnnulee = exact.tva(htAnnulee, 20);
      const at = MONTANTS.avoirTotal;
      assert.deepEqual([at.totalHt, at.totalTva, at.totalTtc, at.lignes[0].totalHt, at.lignes[0].totalTtc, at.ventilation], [exact.euros(htAnnulee), exact.euros(tvaAnnulee), exact.euros(htAnnulee + tvaAnnulee), exact.euros(htAnnulee), exact.euros(exact.ttcLigne(htAnnulee, 20)), [[20, exact.euros(htAnnulee), exact.euros(tvaAnnulee), exact.euros(htAnnulee + tvaAnnulee)]]], 'avoir total : totaux, ligne et ventilation');
      const ecrituresAnnulee = [['CLIENT', '411000', exact.euros(htAnnulee + tvaAnnulee), 0], ['TVA:20', '445710', 0, exact.euros(tvaAnnulee)], ['VENTE_PRESTATION', '706000', 0, exact.euros(htAnnulee)]];
      assert.deepEqual(at.ecritures, ecrituresAnnulee.map(([cle, compte, debit, credit]) => [cle, compte, credit, debit]), 'avoir total : écritures de la facture inversées');
      assert.notDeepEqual(at.ecritures, ecrituresAnnulee, 'avoir total, lecture écartée : écritures sans inversion');
      // Règlements et contre-passations (cas de SA, que reprennent AD et AD-COM) : montant égal à la somme des parts ;
      // chaque reste dû attendu recalculé en centimes exacts (TTC relu en base, moins ce que réglaient déjà le règlement du
      // jeu de données et celui de facture-reglee, plus ou moins la part du cas) ; chaque statut attendu en découle
      // (réglée si le reste est nul ou négatif et qu'un règlement reste affecté, reglements/metier.ts:51-60). Lectures
      // écartées : part arrondie à l'euro ; part non retirée à la contre-passation.
      const centimesDe = (euros) => (euros < 0 ? -enUnites(-euros, 2) : enUnites(euros, 2));
      const ttcDe = (nom) => centimesDe((t.cibles[nom] ?? t.jeu[nom])[1]);
      const regleAvant = new Map([['facture-emise', centimesDe(t.reglementJeu)], ['facture-reglee', centimesDe(t.reglementSolde)]]);
      const reglementsDeSa = cas.filter((c) => c.compte === SA && ['reglement', 'contrepassation'].includes(c.montant?.genre));
      assert.equal(reglementsDeSa.length, 7, 'cinq règlements et deux contre-passations relus');
      for (const { cible, contexte, montant: m } of reglementsDeSa) {
        const quoi = `${cible} (${contexte})`;
        const partDe = (nom) => centimesDe(m.parts.find(([n]) => n === nom)?.[1] ?? 0);
        assert.equal(m.montant, exact.euros(m.parts.reduce((s, [, p]) => s + centimesDe(p), 0n)), `${quoi} : montant égal à la somme des parts`);
        assert.deepEqual(m.statuts.map(([nom]) => nom), m.restes.map(([nom]) => nom), `${quoi} : un statut attendu par reste dû attendu`);
        for (const [nom, reste] of m.restes) {
          const avant = regleAvant.get(nom) ?? 0n;
          const regle = avant + (m.genre === 'reglement' ? partDe(nom) : -partDe(nom));
          const calcule = ttcDe(nom) - regle;
          assert.equal(reste, exact.euros(calcule), `${quoi} : reste dû de ${nom}`);
          assert.equal(m.statuts.find(([n]) => n === nom)[1], calcule <= 0n && regle > 0n ? 'REGLEE' : 'EMISE', `${quoi} : statut de ${nom}`);
          if (m.genre === 'reglement' && partDe(nom) % 100n !== 0n) {
            assert.notEqual(exact.euros(ttcDe(nom) - avant - ((partDe(nom) + 50n) / 100n) * 100n), reste, `${quoi}, lecture écartée : part de ${nom} arrondie à l’euro`);
          }
          if (m.genre === 'contrepassation') assert.notEqual(exact.euros(ttcDe(nom) - avant), reste, `${quoi}, lecture écartée : part non retirée de ${nom}`);
        }
      }
    });

    // Outils propres à 5d (cadrage §3, §4.2 et §4.6) : normalisation des trois messages qui citent un montant, garde
    // « aucun montant » et noms de comptes à chiffre (patch joint à #457, trois témoins), nature d'une entrée JournalFacture
    // par l'option `pieces`, état d'un montant d'une réponse. Chaque outil est éprouvé sur un échantillon, et son
    // comportement par défaut, celui de 5a à 5c, est vérifié inchangé.
    testPrepare('outils de 5d : montants des trois messages normalisés et aucun autre, garde « aucun montant » et noms de comptes à chiffre, nature de l’entrée JournalFacture par option, état d’un montant d’une réponse', () => {
      const n = (texte) => normaliserMontants(`409 « ${texte} » inchangé`);
      assert.equal(n('La facture au temps passé a changé depuis l’aperçu (total HT 77,13 € au lieu de 77,12 €) : relisez l’aperçu avant de la créer.'), '409 « La facture au temps passé a changé depuis l’aperçu (total HT <montant> au lieu de <montant>) : relisez l’aperçu avant de la créer. » inchangé');
      assert.equal(n('Le règlement doit être entièrement affecté : 1 234,56 € répartis pour un montant de 70,00 €.'), '409 « Le règlement doit être entièrement affecté : <montant> répartis pour un montant de <montant>. » inchangé');
      assert.equal(n('La facture <numéro> est déjà soldée (reste dû 0,00 €) : elle ne reçoit plus de règlement.'), '409 « La facture <numéro> est déjà soldée (reste dû <montant>) : elle ne reçoit plus de règlement. » inchangé');
      assert.equal(n('Un autre message à 12,50 €.'), '409 « Un autre message à 12,50 €. » inchangé', 'un montant d’un autre message n’est pas normalisé');
      // Garde « aucun montant » : option `comptesAChiffre` (patch de #457, trois témoins), et comportement par défaut.
      const comptesAdmis = [...COMPTES_JOUES];
      const garde = (ligne, options = {}) => lignesAvecMontant([ligne], { comptes: comptesAdmis, ciblesAdmises: ['taux=20'], journaux: true, ...options }).length === 1;
      const ecritureCtN1 = 'CT-N1 | POST /api/reglements | factureId=facture-emise | défaut, corps reste dû | 201 écrit (AffectationReglement,JournalFacture,Reglement) ; entrées : JournalFacture facture-emise REGLEMENT_AFFECTE par CT-N1 ; pièces émises figées ; montants inchangés en base';
      const lectureCtN1 = 'SA | GET /api/factures/:id/journal | JournalFacture facture-emise REGLEMENT_AFFECTE par CT-N1 ← CT-N1 POST /api/reglements sur factureId=facture-emise | défaut, corps reste dû | 200 visible';
      const lectureCtN2 = lectureCtN1.replaceAll('CT-N1', 'CT-N2');
      assert.equal(garde(ecritureCtN1, { comptesAChiffre: true }), false, 'écriture par CT-N1 : son nom n’est pas un montant');
      assert.equal(garde(lectureCtN1, { comptesAChiffre: true }), false, 'lecture d’une entrée de CT-N1 : son nom n’est pas un montant');
      assert.equal(garde(lectureCtN2, { comptesAChiffre: true }), true, 'nom inconnu à chiffre : refusé');
      assert.equal(garde(ecritureCtN1), true, 'sans l’option, comportement de 5c inchangé : le nom de CT-N1 est refusé');
      assert.equal(garde(`${ecritureCtN1.replace(' ; montants inchangés en base', '')} ; montant 12,50 €`, { comptesAChiffre: true }), true, 'montant en euros refusé');
      assert.equal(garde('SA | POST /api/reglements | factureId=facture-emise | défaut | 201 écrit (Reglement) ; aucune entrée ; montant 69.99', { comptesAChiffre: true }), true, 'montant en chiffres refusé');
      // Seul le nom d'un compte joué est masqué : un montant sans « € » dans une ligne qui nomme CT-N1 reste refusé, dans
      // la réponse d'une écriture comme dans la cible d'une lecture (audit des droits de #460, T1).
      assert.equal(garde(ecritureCtN1.replace(' ; montants inchangés en base', ' ; montant 69,99'), { comptesAChiffre: true }), true, 'écriture par CT-N1 qui porte un montant sans « € » : refusée');
      assert.equal(garde(lectureCtN1.replace('REGLEMENT_AFFECTE par CT-N1', 'REGLEMENT_AFFECTE de 69,99 par CT-N1'), { comptesAChiffre: true }), true, 'lecture d’une entrée de CT-N1 dont la cible porte un montant : refusée');
      // Messages de refus fixes à chiffre sans montant : admis à leur texte exact, une variante reste refusée.
      for (const message of MESSAGES_SANS_MONTANT) {
        const ligne = `SA | POST /api/factures | clientId=client-actif | défaut | 400 « ${message} » inchangé ; aucune entrée ; pièces émises figées ; montants inchangés en base`;
        assert.equal(garde(ligne), true, `sans masque, le message à chiffre est refusé : ${message}`);
        assert.equal(garde(pourLaGarde(ligne)), false, `message fixe admis : ${message}`);
        assert.equal(garde(pourLaGarde(ligne.replace(message, message.replace(/\p{Nd}/u, '9')))), true, `variante du message refusée : ${message}`);
      }
      // Nature d'une entrée JournalFacture : la pièce, avec l'option ; rien sans elle (journaux.txt de 5c inchangé).
      const entree = { table: 'JournalFacture', ligne: { id: 'x', factureId: 'piece-1', acteurId: comptes.SA.id, action: 'REGLEMENT_AFFECTE' }, avant: null };
      assert.equal(nommerEntree(entree, noms), 'JournalFacture REGLEMENT_AFFECTE par SA');
      assert.equal(nommerEntree(entree, noms, { pieces: new Map([['piece-1', 'facture-emise']]) }), 'JournalFacture facture-emise REGLEMENT_AFFECTE par SA');
      assert.equal(nommerEntree(entree, noms, { pieces: new Map() }), 'JournalFacture autre pièce REGLEMENT_AFFECTE par SA');
      // État d'un montant d'une réponse, jamais sa valeur.
      assert.equal(etatsMontants({ a: 1, b: null, l: [{ m: 2 }, {}] }, ['a', 'b', 'c', 'l[].m', 'x.y']), 'a présent, b null, c absent, l[].m absent/présent, x.y non porté');
    });

    // Cadrage §4.1 et §4.2 : chaque route des factures a ses cas pour SA, AD et AD-COM, avec les mêmes cibles et corps ;
    // chaque compte refusé à l'entrée (entrees.txt) rejoue chaque cas de SA ; chaque écriture de montant admise a sa
    // relecture (cadrage §3, classement C).
    testPrepare('couverture : chaque route des factures jouée par SA, AD et AD-COM sur les mêmes cas, chaque cas de SA rejoué par les 12 comptes refusés à l’entrée (entrees.txt), chaque écriture de montant admise relue', (t) => {
      const cle = (c) => [c.route, c.cible, c.contexte].join(SEPARATEUR);
      const deSa = cas.filter((c) => c.compte === SA && !c.indirect).map(cle).sort();
      for (const route of ROUTES_DES_FACTURES) assert.ok(cas.some((c) => c.route === route && c.compte === SA), `${route} : aucun cas`);
      for (const compte of [...ADMINISTRATION, ...REFUSES]) assert.deepEqual(cas.filter((c) => c.compte === compte && !c.indirect).map(cle).sort(), deSa, `${compte} : cas différents de ceux de SA`);
      assert.ok(cas.filter((c) => !c.indirect).every((c) => ROUTES_DES_FACTURES.includes(c.route)), 'cas hors des routes des factures');
      // Les comptes refusés le sont à l'entrée de chaque route, par la garde de l'administration (D1a-1).
      const entrees = lireReference(join(DOSSIER_MATRICES, 'entrees.txt'));
      assert.ok(entrees, 'entrees.txt absent');
      const parCouple = new Map();
      for (const ligne of entrees.split('\n').filter(Boolean)) {
        const [compte, route, , , reponse] = ligne.split(SEPARATEUR);
        if (!ROUTES_DES_FACTURES.includes(route)) continue;
        if (!parCouple.has(`${compte} ${route}`)) parCouple.set(`${compte} ${route}`, new Set());
        parCouple.get(`${compte} ${route}`).add(reponse);
      }
      for (const route of ROUTES_DES_FACTURES) {
        for (const compte of REFUSES) assert.deepEqual([...(parCouple.get(`${compte} ${route}`) ?? [])], [REFUS_ENTREE], `${compte} sur ${route} dans entrees.txt`);
        for (const compte of ADMINISTRATION) assert.ok(![...(parCouple.get(`${compte} ${route}`) ?? [])].includes(REFUS_ENTREE), `${compte} admis sur ${route}`);
      }
      // Écritures de montant admises : chacune relue (classement C du cadrage §3).
      const admises = cas.filter((c) => !c.enLot && !c.indirect && [200, 201].includes(c.code) && c.route !== 'POST /api/factures/:id/envois');
      for (const c of admises) assert.ok(c.montant, `${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : écriture de montant admise sans relecture`);
      const parRoute = {};
      for (const c of cas) parRoute[c.route] = (parRoute[c.route] ?? 0) + 1;
      diagnostics.push(`cas : ${cas.length} (un à un des administrateurs ${cas.filter((c) => !c.enLot && !c.indirect).length}, comptes refusés ${cas.filter((c) => c.enLot).length}, écritures indirectes ${cas.filter((c) => c.indirect).length}) ; par route : ${Object.entries(parRoute).map(([r, n]) => `${r} ${n}`).join(', ')}`);
      t.diagnostic(diagnostics[diagnostics.length - 1]);
    });

    // Cadrage §4.1 à §4.6 : chaque cas, ses entrées et leurs lectures, ses constats, la base remise après chaque cas ; les
    // comptes refusés en lots, rejoués un à un si un lot écrit.
    testPrepare('écritures des factures, avoirs et règlements : cas des administrateurs un à un, comptes refusés en lots (rejoués un à un si un lot écrit), écritures indirectes, entrées lues, montants relus, pièces émises figées, base remise en état après chaque cas', async () => {
      for (const route of ROUTES_DES_FACTURES) {
        for (const c of cas.filter((x) => x.route === route && !x.enLot && !x.indirect)) await jouer(c);
        const refuses = cas.filter((x) => x.route === route && x.enLot);
        for (let i = 0; i < refuses.length; i += 64) await jouerLot(route, refuses.slice(i, i + 64));
      }
      for (const c of cas.filter((x) => x.indirect)) await jouer(c);
    });

    // Cadrage §4.1 : la réponse de chaque cas est celle du tableau (code), et chaque refus est « inchangé ».
    testPrepare('réponses du tableau 4.1 : cas admis écrits, refus sans écriture, comptes hors administration refusés à l’entrée, « réglée » à la main 410', () => {
      const ecarts = [];
      for (const c of cas.filter((x) => x.code !== null && !x.indirect)) {
        if (!c.reponse?.startsWith(`${c.code} `)) ecarts.push(`${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : attendu ${c.code}, obtenu « ${c.reponse} »`);
        else if (c.code >= 300 && !c.reponse.includes(' inchangé ; aucune entrée ; ')) ecarts.push(`${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : refus qui écrit`);
        else if (c.enLot && !c.reponse.startsWith(`${REFUS_ENTREE} inchangé ; `)) ecarts.push(`${c.compte} ${c.route} sur ${c.cible} : refus à l’entrée attendu`);
      }
      assert.deepEqual(ecarts, [], 'réponses différentes du tableau 4.1');
    });

    // Cadrage §3, §4.3 et §4.4 : chaque écriture de montant admise relue conforme, chaque refus et chaque écriture sans
    // montant laissent les montants inchangés, et les pièces émises restent figées après chaque cas.
    testPrepare('montants relus en base et pièces émises figées : écritures admises conformes à l’attendu, refus et autres écritures sans changement de montant, aucune pièce émise modifiée', () => {
      const ecarts = [];
      for (const c of cas) {
        const r = c.reponse ?? '';
        if (!/ ; pièces émises figées( ; |$)/.test(r)) ecarts.push(`${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : pièce émise modifiée (« ${r} »)`);
        if (c.indirect) continue;
        const attendu = c.montant && r.startsWith(`${c.code} `) && c.code < 300 ? CONSTATS_CONFORMES[c.montant.genre] : MONTANTS_INCHANGES;
        if (!r.endsWith(` ; ${attendu}`)) ecarts.push(`${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : constat des montants « ${r} »`);
      }
      assert.deepEqual(ecarts, [], 'montants ou pièces émises différents de l’attendu');
      diagnostics.push(`montants relus : ${chiffres.montants} constats, dont ${cas.filter((c) => c.montant && !c.enLot).length} écritures de montant admises`);
    });

    // Cadrage §3 et §4.6 : la matrice obtenue est la référence, au caractère près ; aucune ligne ne porte de montant.
    testPrepare('la matrice obtenue est la référence matrice-droits/factures.txt, chaque cas et chaque lecture y ont une ligne, aucune ligne ne porte de montant, et la base est revenue à l’état de référence', async (t) => {
      const cles = lignes.map((l) => l.split(SEPARATEUR).slice(0, 4).join(SEPARATEUR));
      const doublons = cles.filter((c, i) => cles.indexOf(c) !== i);
      assert.deepEqual(doublons, [], 'chaque cas et chaque lecture n’ont qu’une ligne');
      assert.deepEqual(lignesAvecMontant(lignes.map(pourLaGarde), { comptes: COMPTES_JOUES, ciblesAdmises: ['taux=20'], journaux: true, comptesAChiffre: true }), [], 'lignes qui portent un montant, ou un nombre hors du code de la réponse et des comptes d’objets d’un refus');
      const etatFinal = remise.changees(await remise.empreinte());
      const ecritures = lignes.filter((l) => !l.split(SEPARATEUR)[2].includes(' ← '));
      for (const texte of diagnostics) t.diagnostic(texte);
      t.diagnostic(`lignes : ${lignes.length} (écritures ${ecritures.length}, lectures ${lignes.length - ecritures.length}) ; cas un à un ${chiffres.unAUn} ; lots ${chiffres.lots} (${chiffres.refusEnLots} refus) ; lots rejoués un à un ${chiffres.lotsRejoues.length ? chiffres.lotsRejoues.join(' ; ') : 'aucun'} ; lectures ${chiffres.lectures} ; remises ${remise.remises}`);
      t.diagnostic(`hors droits (pour #426) : ${horsDroits.length ? horsDroits.join(' ; ') : 'aucune réponse'}`);
      comparerAvecReference(lignes, REFERENCE, 'factures.txt', { champsResume: 2 });
      assert.deepEqual(etatFinal, [], 'la base n’est pas revenue à l’état de référence après le dernier cas');
    });
  });
}
