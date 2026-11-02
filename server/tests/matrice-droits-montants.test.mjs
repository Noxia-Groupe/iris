// Lot D1a-5d-2 : montants des écritures de session et réglages. Montant vendu d'un chantier sous les trois
// destinataires de la rentabilité ; montants masqués dans les réponses d'écriture (les 8 groupes de
// MONTANTS_MASQUES_ECRITURES, en session) ; prix d'achat prévu d'une ligne de devis et prix d'achat d'une fiche du
// catalogue ; mains d'œuvre du catalogue et leur journal ; N1 du contrôle de #435 (lectures des achats et des heures par
// le commercial, l'assistante, le directeur commercial et le comptable) ; planningActif=non pour le super
// administrateur ; outil de l'export du journal d'administration (#457 T1 et N4). Tests seuls (cadrage du lot D1a-5d,
// version 3 du 02-11-2026, contrôlé par le controleur-coherence et publié sur #427, sections 2, 3, 5.1 à 5.5, 7, 8, 9
// et 10 ; avenant au cadrage du lot D1a pour D1a-5, version 2 ; cadrage du lot D1a, version 3 du 01-11-2026).
//
// Tests seuls : ce fichier enregistre le comportement actuel, sans rien corriger. Il reprend les outils, les comptes, le
// jeu de données de D1a-1, l'outil de remise en état de D1a-5a, les outils de lecture des journaux de D1a-5c (avec
// verifierLectureExport et l'option `lignesExport` de lireVisibilite, posées ici), le module de relecture des montants
// de D1a-5d-1 (etatsMontants, memeValeur) et la liste fermée des montants masqués de D1a-3 (annotations posées ici).
// Il enregistre :
//  - §5.1 : PATCH /api/chantiers/:id (fiche), …/statut et …/commercial par chaque compte admis sur ses chantiers, sous
//    les quatre contextes de la rentabilité (défaut, et chacun de ses trois destinataires coupé) ; la fiche avec le
//    montant vendu (12 345,67), relu écrit ou inchangé en base, et avec un nom pour DC, AC et CPT ; le chantier terminé
//    (CT refusé, SA et AD écrivent) ; les refus de la hiérarchie et du directeur, état décrit ;
//  - §5.2 : chaque couple (route, compte) des réponses 2xx de 5a et 5b sur les routes des 8 groupes, et chaque triplet
//    (compte, route, droit) des contextes « droit … », joué une fois (réduction R-A, déclarée), la réponse lue (état de
//    chaque champ : présent, null, absent, jamais sa valeur) ; test de couverture par (groupe, champ), annotations en
//    liste fermée dans matrice-droits/montants-masques.mjs ;
//  - §5.3 : prix d'achat prévu d'une ligne de devis (refusé hors administration, copié d'une fiche, gardé quand la ligne
//    est modifiée), prix d'achat d'une fiche (écrit en création ; un PUT qui l'omet l'efface : état actuel enregistré),
//    mains d'œuvre (création avec tous leurs prix, modification, désactivation, passage d'une prestation, retour, refus
//    du retour si rattachée, réactivation), entrées MAIN_OEUVRE relues partiellement, comme les barèmes de 5c ;
//  - §3 : chaque montant écrit relu en base, comparé sans tolérance à l'attendu écrit en dur (lecture écartée en
//    commentaire, test témoin qui le recalcule), ou à sa source au moment de l'écriture (lignes copiées par une
//    révision ou une duplication, relues dans l'instantané) ; pour chaque refus et chaque écriture sans montant, les
//    montants des chantiers, des devis et du catalogue relus inchangés ; chaque source copiée ou figée (fiche, main
//    d'œuvre, article) changée après coup, avant l'instantané ;
//  - §5.4 : N1 de #435 ; les 10 écritures du planning sous planningActif=non, SA écrit, AD refusé en témoin ; l'outil de
//    l'export (#457 T1 : il reconnaît l'export du SA avant de conclure ; N4 : chaque ligne de l'export lu reconnue) ;
//  - chaque entrée nouvelle lue par SA, AD, l'auteur hors administration et un compte refusé, et l'export CSV du journal
//    d'administration par SA et AD (outils de D1a-5c).
// Une ligne d'écriture : compte, route, cible, contexte (« défaut, corps <nom> », « <réglage>=non, corps <nom> »,
// « droit <droit>, corps <nom> », « planningActif=non, corps <nom> »), réponse (code, et message exact d'un refus),
// « écrit (tables) » ou « inchangé », « entrées : … » ou « aucune entrée », puis « réponse : <champ> <état>, … » pour une
// route des 8 groupes, et le constat des montants. Jamais un montant (garde lignesAvecMontant d'outils.mjs, options
// `journaux` et `comptesAChiffre`). Le tout est comparé au caractère près à server/tests/matrice-droits/montants.txt.
//
// Rôle PostgreSQL : comme D1a-5a à D1a-5d-1, la remise pose session_replication_role ; si le rôle de TEST_DATABASE_URL
// ne le peut pas, le test « rôle PostgreSQL » échoue avec un message clair, chacun des autres le cite, et aucune base
// n'est créée. Sans TEST_DATABASE_URL, le fichier s'annonce ignoré comme les autres fichiers de la matrice : un SKIP
// n'est pas une réussite. Ce fichier crée sa propre base jetable (iris_test_matrice_montants_<hex>), la migre, la sert
// à l'application, puis la supprime.
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
import { cheminPour, cibleDe, construireJeuDeDonnees, jourSociete } from './matrice-droits/donnees.mjs';
import { SCHEMA_INSTANTANE, creerRemiseEnEtat, exigerRoleReplication } from './matrice-droits/remise-en-etat.mjs';
import {
  compterFinDeLigne, entreesNouvelles, finDeLigneCsv, lignesNonReconnues, lireExports, lireVisibilite, memeEntree,
  nommerEntree, ouvrirConnexionLecture, verifierLectureExport,
} from './matrice-droits/journaux.mjs';
import { etatMontant, memeValeur } from './matrice-droits/montants-ecritures.mjs';
import { MONTANTS_MASQUES_ECRITURES } from './matrice-droits/montants-masques.mjs';

const TITRE = 'Lot D1a-5d-2 : montants des écritures de session et réglages, montant vendu sous les trois destinataires de la rentabilité, montants masqués des réponses d’écriture, prix d’achat et mains d’œuvre, montants relus en base, N1 de #435, planning désactivé, outil de l’export';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const REFERENCE = join(DOSSIER_MATRICES, 'montants.txt');
const SA = 'SA';
const ADMINISTRATION = ['SA', 'AD', 'AD-COM'];
// Porteurs du droit devis par leur type (5a et 5b : 2xx sur les routes des devis au contexte « défaut »).
const DEVIS_HORS_ADMINISTRATION = ['COM', 'DC', 'AC', 'CPT', 'CPT-FINANCE'];
// Réglages de la rentabilité (chantiers/droits.ts:23-35), coupés un à un par SA en préalable (cadrage §5.1).
const CONTEXTES_RENTABILITE = [
  ['défaut', null],
  ['rentabiliteConducteur=non', { rentabiliteConducteur: false }],
  ['rentabiliteHierarchie=non', { rentabiliteHierarchie: false }],
  ['rentabiliteDirecteurs=non', { rentabiliteDirecteurs: false }],
];
// Droits individuels des triplets « droit … » de 5b (case « droit devis » de l'écran, ou un scope seul), donnés par SA
// en préalable par la route d'administration, retirés par la remise en état.
const SCOPES_DU_DROIT = { 'droit devis': ['devis:read', 'devis:write', 'clients:read'], 'droit devis:write': ['devis:write'], 'droit chantiers:archive': ['chantiers:archive'] };
// Titulaires des chantiers du jeu de données, et chantiers de la branche de RESP (donnees.mjs), pour la règle de la
// rentabilité.
const TITULAIRE = { 'chantier-ct': 'CT', 'chantier-termine': 'CT', 'chantier-resp': 'RESP', 'chantier-dc': 'DC', 'chantier-ac': 'AC', 'chantier-cpt': 'CPT', 'chantier-dir': 'DIR' };
const BRANCHE_DE_RESP = ['chantier-ct-branche-resp', 'chantier-tech-branche-resp'];
// Constats des montants (cadrage §3), sans chiffre.
const MONTANTS_INCHANGES = 'montants inchangés en base';
const CONSTATS_CONFORMES = {
  vendu: 'montant vendu écrit relu en base',
  devis: 'montants du devis relus en base conformes',
  copie: 'montants du devis copiés de la source relus en base conformes',
  conversion: 'montants du chantier ouvert relus en base conformes',
  acompte: 'montant de l’acompte relu en base conforme',
  fiche: 'prix de la fiche relus en base conformes',
  effacement: 'prix d’achat de la fiche effacé en base, autres prix relus conformes',
  mainOeuvre: 'prix de la main d’œuvre relus en base conformes ; montants journalisés identiques',
};
const CONSTATS_ECART = {
  vendu: 'montants du chantier différents de l’attendu', devis: 'montants du devis différents de l’attendu',
  copie: 'montants du devis différents de la source', conversion: 'montants du chantier ouvert différents de l’attendu',
  acompte: 'montants de l’acompte différents de l’attendu', fiche: 'prix de la fiche différents de l’attendu',
  effacement: 'prix de la fiche différents de l’attendu', mainOeuvre: 'prix ou journal de la main d’œuvre différents de l’attendu',
};
// Colonnes de montant relues inchangées (cadrage §3 : « pour chaque refus, le montant est relu inchangé ») : chantiers,
// devis et leurs lignes, catalogue. Les saisies (achats, heures, coûts SAV), relues par 5c, n'y sont pas (cadrage §3 :
// « sauf ce que 5b ou 5c relisent déjà »). `cle` : colonne qui rattache la ligne à un objet relu à part, exclu.
const MONTANTS_SESSION = {
  Chantier: { colonnes: ['budgetGlobalVendu', 'budgetMaterielVendu', 'budgetMainOeuvreVendu', 'heuresVendues', 'coutMaterielPrevu'], cle: 'id' },
  Devis: { colonnes: ['totalHt', 'totalTva', 'totalTtc', 'tauxAcompte', 'acompteMontant'], cle: 'id' },
  DevisLigne: { colonnes: ['quantite', 'prixUnitaireHt', 'tauxTva', 'totalHt', 'totalTtc', 'prixAchatUnitaireHt', 'minutesPrevuesUnite'], cle: 'devisId' },
  CataloguePrestation: { colonnes: ['tauxTva', 'prixVenteHt', 'prixAchatHt', 'prixJourHorsContratHt', 'prixHeureSousContratHt', 'prixJourSousContratHt', 'prixDemiJourneeHorsContratHt', 'prixDemiJourneeSousContratHt', 'heuresParJour'], cle: 'id' },
  CatalogueArticle: { colonnes: ['tauxTva', 'prixVenteHt', 'prixAchatHt'], cle: 'id' },
  CatalogueEquipement: { colonnes: ['tauxTva', 'prixVenteHt', 'prixAchatHt'], cle: 'id' },
};
const PRIX_MAIN_OEUVRE = ['prixVenteHt', 'prixJourHorsContratHt', 'prixHeureSousContratHt', 'prixJourSousContratHt', 'prixDemiJourneeHorsContratHt', 'prixDemiJourneeSousContratHt', 'heuresParJour'];
const CHAMPS_LIGNE_DEVIS = ['quantite', 'prixUnitaireHt', 'tauxTva', 'totalHt', 'totalTtc', 'prixAchatUnitaireHt', 'minutesPrevuesUnite'];

// --- Montants envoyés et attendus (cadrage §3, §5.1, §5.3 ; étude §5) ---
// Chaque valeur envoyée est choisie pour qu'une autre lecture plausible de la règle donne un autre résultat ; l'attendu
// est écrit en dur, la lecture écartée en commentaire, et le test « témoin des montants » le recalcule en décimal exact
// et vérifie que chaque lecture écartée en diffère.
const ligneLibre = (designation, nature, quantite, prixUnitaireHt, extra = {}) => ({ designation, nature, quantite, prixUnitaireHt, tauxTva: 20, ...extra });
const MONTANTS = {
  // §5.1 : montant vendu envoyé. Lectures écartées : la valeur existante (1 000, chaque chantier du jeu de données
  // naissant d'un devis de 1 000 HT, donnees.mjs), l'arrondi à l'euro (12 346) ou au dixième (12 345,7).
  vendu: 12345.67,
  // Fiche prestation-prix-achat : prix d'achat 38,62 à la création, copié par la ligne de devis-prix-achat, puis changé
  // à 41,17 avant l'instantané (copie figée : la ligne garde 38,62). Prix de vente 100.
  ficheAchatInitial: 38.62, ficheAchat: 41.17, ficheVente: 100,
  // Ligne d'un devis créé ou modifié : 1,5 × 0,35 = 0,525, arrondi à 0,53 (moitié vers le haut, exacte) ; TVA 0,106,
  // arrondie à 0,11 ; TTC 0,64. Lectures écartées : un calcul flottant (0,52499…) ou l'arrondi au pair, 0,52.
  ligne: { quantite: 1.5, prixUnitaireHt: 0.35, tauxTva: 20 }, ligneHt: 0.53, ligneTtc: 0.64, devisTva: 0.11,
  // Prix d'achat prévu saisi par un administrateur sur une ligne libre (§5.3) : 12,34, distinct du prix de la fiche du
  // jour (41,17), de son prix d'origine (38,62) et du prix de vente.
  prixAchatLigne: 12.34,
  // Fiche article-prix-achat : prix d'achat 0,35 (prix de vente 33,33) à la création de devis-signe-prix-achat, puis 0,40
  // (prix de vente 35,55) après sa signature.
  articleAchatInitial: 0.35, articleVenteInitial: 33.33, articleAchat: 0.4, articleVente: 35.55,
  // Main d'œuvre du devis (main-oeuvre-du-devis) : prix et heures par jour à la signature, puis changés après la
  // signature (le devis garde sa copie : prix figé de la ligne au jour, minutes prévues).
  mainOeuvreDuDevisInitial: { prixVenteHt: 58.37, prixJourHorsContratHt: 412.37, prixHeureSousContratHt: 51.13, prixJourSousContratHt: 377.71, heuresParJour: 7.5 },
  mainOeuvreDuDevis: { prixVenteHt: 66.66, prixJourHorsContratHt: 499.99, prixHeureSousContratHt: 59.99, prixJourSousContratHt: 455.55, heuresParJour: 8 },
  // devis-signe-prix-achat, quatre lignes à 20 % :
  //  - L1, fourniture du catalogue (article-prix-achat) : 1,5 × 33,33 = 49,995, arrondi à 50,00 ; prix d'achat copié 0,35 ;
  //  - L2, main-d'œuvre libre : 1,5 × 61,50 = 92,25 ; prix d'achat saisi par SA 0,35 ; 90 minutes (aucune durée : 60 par
  //    unité, devis/metier.ts:155-161) ;
  //  - L3, fourniture libre : 2 × 10,05 = 20,10 ; sans prix d'achat ;
  //  - L4, main d'œuvre au jour hors contrat (main-oeuvre-du-devis) : 2 jours au prix figé 412,37 = 824,74 ; 450 minutes
  //    par jour (7,5 h × 60).
  devisSigneLignes: [
    { quantite: 1.5, prixUnitaireHt: 33.33, tauxTva: 20, totalHt: 50, totalTtc: 60, prixAchatUnitaireHt: 0.35, minutesPrevuesUnite: 0 },
    { quantite: 1.5, prixUnitaireHt: 61.5, tauxTva: 20, totalHt: 92.25, totalTtc: 110.7, prixAchatUnitaireHt: 0.35, minutesPrevuesUnite: null },
    { quantite: 2, prixUnitaireHt: 10.05, tauxTva: 20, totalHt: 20.1, totalTtc: 24.12, prixAchatUnitaireHt: null, minutesPrevuesUnite: null },
    { quantite: 2, prixUnitaireHt: 412.37, tauxTva: 20, totalHt: 824.74, totalTtc: 989.69, prixAchatUnitaireHt: null, minutesPrevuesUnite: 450 },
  ],
  // Chantier ouvert par la conversion de devis-signe-prix-achat (devis/routes.ts:401-413) :
  //  - montant vendu : le total HT du devis, 50,00 + 92,25 + 20,10 + 824,74 = 987,09 ; avec le prix du jour de la main
  //    d'œuvre (499,99 × 2), 1 162,33 ;
  //  - budget matériel : les fournitures, 50,00 + 20,10 = 70,10 ; budget main-d'œuvre : le reste, 916,99 ;
  //  - heures vendues : (90 + 2 × 450) / 60 = 16,5 ; avec les heures par jour du jour (8 h), (90 + 960) / 60 = 17,5 ;
  //  - coût matériel prévu : chaque ligne à son prix d'achat × quantité, arrondie au centime (0,525 → 0,53, deux fois),
  //    1,06. Lectures écartées : arrondi du total (1,05) ; fournitures seules (0,53) ; prix d'achat de la fiche du jour
  //    (1,5 × 0,40 = 0,60, et 1,13) ; ligne sans prix d'achat comptée à son prix de vente (21,16).
  conversion: { budgetGlobalVendu: 987.09, budgetMaterielVendu: 70.1, budgetMainOeuvreVendu: 916.99, heuresVendues: 16.5, coutMaterielPrevu: 1.06 },
  // Acompte constaté sur devis-acompte-prix-achat : 98,76, distinct du taux d'acompte par défaut (30 %) appliqué au TTC.
  acompte: 98.76,
  // Acompte reçu sur devis-acompte-recu, constaté avant l'instantané : 3 × 17,29 = 51,87 HT, TVA 10,374 arrondie à 10,37,
  // TTC 62,24 ; acompte 21,37, distinct du taux d'acompte (30 %) appliqué au TTC (18,67) et de l'acompte du jeu (98,76).
  // Une révision le reprend (devis/routes.ts:131-132) ; une duplication, devis neuf en brouillon, ne le reprend pas
  // (devis/routes.ts:632-644). Lecture écartée : la duplication qui reprend l'acompte reçu, comme une révision.
  acompteRecu: 21.37,
  // Taux d'acompte par défaut changé à 37,5 % après la création de devis-acompte-prix-achat (copié à 30 %) : une révision
  // garde 30 (copie), une duplication relit 37,5 (réglage du jour). Lectures écartées : l'une pour l'autre.
  tauxAcompteDuJour: 37.5,
  // Fiches du catalogue écrites par l'administration (§5.3) : article créé (prix de vente 23,45, prix d'achat 17,43) ;
  // prestation-prix-achat modifiée avec un prix d'achat de 42,18, distinct de son prix du jour (41,17) et d'origine.
  articleCree: { prixVenteHt: 23.45, prixAchatHt: 17.43, tauxTva: 20 }, ficheAchatModifie: 42.18,
  // Modèle d'équipement à prix d'achat (G8 côté « voit », cadrage §5.2) : 123,45.
  modeleAchat: 123.45,
  // Mains d'œuvre (§5.3) : six prix et les heures par jour, tous distincts. Lectures écartées : le prix du jour ramené à
  // l'heure (430,45 / 7,75 = 55,54) ; la demi-journée comptée pour la moitié du jour (215,23 et 195,07) ; les heures
  // arrondies à l'heure (8) ; un prix hors contrat recopié sous contrat. Modification du prix horaire : 63,25 (cadrage
  // §5.3), distinct de 61,57 et de son arrondi au dixième.
  mainOeuvre: { prixVenteHt: 61.57, prixJourHorsContratHt: 430.45, prixHeureSousContratHt: 57.29, prixJourSousContratHt: 390.13, prixDemiJourneeHorsContratHt: 233.37, prixDemiJourneeSousContratHt: 211.19, heuresParJour: 7.75 },
  mainOeuvreModifiee: 63.25,
  // Main d'œuvre rattachée à la fiche du technicien (prix de vente à l'heure figé sur ses heures SAV, G5 et G6).
  mainOeuvreRattachee: { prixVenteHt: 64.44, prixJourHorsContratHt: 444.44, prixHeureSousContratHt: 54.44, prixJourSousContratHt: 404.44, heuresParJour: 7 },
  // Retour d'une main d'œuvre en prestation ordinaire : prix de vente 70,05 ; ses prix propres et ses heures sont vidés.
  prestationRetour: 70.05,
};

// --- Calcul décimal exact du témoin, indépendant de l'application (repris de D1a-5d-1) ---
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
const arrondiAuPair = (millemes) => { const q = millemes / 10n; const r = millemes % 10n; return r > 5n || (r === 5n && q % 2n === 1n) ? q + 1n : q; };

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const base = baseJetable(TEST_DATABASE_URL, 'montants');
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
    // Cibles propres (nom → identifiant), construites par l'API avant l'instantané (cadrage §3).
    const P = {};
    let exportsReference = {};
    const lignes = [];
    const cas = [];
    const chiffres = { cas: 0, lectures: 0, remises: 0, montants: 0, prealablesRefuses: 0 };
    const diagnostics = [];
    const horsDroits = [];

    const api = async (compte, methode, chemin, corps, statut = 200) => {
      const res = await appeler(appli.adresse, methode, chemin, { jeton: jetons[compte], corps: methode === 'GET' ? undefined : corps });
      const admis = Array.isArray(statut) ? statut : [statut];
      assert.ok(admis.includes(res.status), `${methode} ${chemin} (${compte}) : ${res.status} ${JSON.stringify(res.body)?.slice(0, 400)}`);
      return res.body;
    };
    const id = (famille, nom) => cibleDe(famille, nom).ids.id;
    const q = async (texte, valeurs = []) => (await lecture.query(texte, valeurs)).rows;

    // --- Relectures (cadrage §3) ---
    const ident = (nom) => { assert.match(nom, /^[A-Za-z]+$/); return `"${nom}"`; };
    // Une ligne relue en base (schéma public), ou dans l'instantané : colonnes demandées, nombres.
    const ligneDe = async (schema, table, ligneId, colonnes) => {
      const [r] = await q(`SELECT ${colonnes.map(ident).join(', ')} FROM ${schema === 'public' ? 'public' : `"${SCHEMA_INSTANTANE}"`}.${ident(table)} WHERE id = $1`, [ligneId]);
      return r ? Object.fromEntries(colonnes.map((c) => [c, r[c] === null ? null : Number(r[c])])) : null;
    };
    const lignesCreees = async (table) => (await q(`SELECT t.id FROM public.${ident(table)} t LEFT JOIN "${SCHEMA_INSTANTANE}".${ident(table)} s ON s.id = t.id WHERE s.id IS NULL`)).map((r) => r.id);
    // Lignes d'un devis (par ordre), relues en base ou dans l'instantané.
    const lignesDuDevis = async (schema, devisId) => (await q(`SELECT ${CHAMPS_LIGNE_DEVIS.map(ident).join(', ')} FROM ${schema === 'public' ? 'public' : `"${SCHEMA_INSTANTANE}"`}."DevisLigne" WHERE "devisId" = $1 ORDER BY ordre`, [devisId]))
      .map((r) => Object.fromEntries(CHAMPS_LIGNE_DEVIS.map((c) => [c, r[c] === null ? null : Number(r[c])])));
    // Tables dont un montant a changé depuis l'instantané, hors des objets relus à part (`exclus` : identifiants, comparés à
    // la colonne `cle` de chaque table).
    const REQUETE_MONTANTS = Object.entries(MONTANTS_SESSION).map(([table, def]) => {
      const colonnes = ['id', ...def.colonnes].map((c) => `t."${c}"`).join(', ');
      const hors = `NOT (t."${def.cle}" = ANY($1::text[]))`;
      return `SELECT '${table}' AS t, count(*)::int AS n FROM (
        (SELECT ${colonnes} FROM "${SCHEMA_INSTANTANE}"."${table}" t WHERE ${hors} EXCEPT SELECT ${colonnes} FROM public."${table}" t WHERE ${hors})
        UNION ALL (SELECT ${colonnes} FROM public."${table}" t WHERE ${hors} EXCEPT SELECT ${colonnes} FROM "${SCHEMA_INSTANTANE}"."${table}" t WHERE ${hors})) x`;
    }).join(' UNION ALL ');
    const montantsChanges = async (exclus = []) => (await lecture.query({ name: 'montants-session', text: REQUETE_MONTANTS, values: [exclus] })).rows.filter((r) => r.n > 0).map((r) => r.t).sort();
    const hors = async (exclus, quoi) => {
      const tables = await montantsChanges(exclus);
      return tables.length ? [`montants changés hors ${quoi} : ${tables.join(', ')}`] : [];
    };
    const constat = (genre, ecarts, autres) => [ecarts.length ? `${CONSTATS_ECART[genre]} : ${ecarts.join(', ')}` : CONSTATS_CONFORMES[genre], ...autres].join(' ; ');
    const ecartsChamps = (lu, attendu, prefixe = '') => Object.keys(attendu).filter((c) => !memeValeur(lu?.[c], attendu[c])).map((c) => `${prefixe}${c}`);
    // Devis relu (totaux et lignes) comparé à l'attendu.
    const ecartsDevis = async (devisId, attendu) => {
      const totaux = await ligneDe('public', 'Devis', devisId, Object.keys(attendu.totaux));
      const ecarts = ecartsChamps(totaux, attendu.totaux);
      const lues = await lignesDuDevis('public', devisId);
      if (lues.length !== attendu.lignes.length) ecarts.push('nombre de lignes');
      else attendu.lignes.forEach((l, i) => ecarts.push(...ecartsChamps(lues[i], l, `ligne ${'ABCDEFGH'[i]} `)));
      return ecarts;
    };
    // Journal d'administration d'une main d'œuvre (cadrage §5.3 : « relecture partielle comme les barèmes de 5c ») : seuls
    // les champs qui changent sont journalisés (catalogue/main-oeuvre.ts:149-162) ; un prix absent de l'entrée doit être
    // inchangé en base, et un prix inchangé en être absent ; un prix journalisé égale la base (après) et l'instantané
    // (avant). Chaque écriture admise d'une main d'œuvre change la fiche (création, prix, activité ou nature), et l'entrée
    // est exigée (catalogue/main-oeuvre.ts:146 : « Une entrée par écriture qui change une main d'œuvre »).
    const ecartsJournalMainOeuvre = (entrees, ligne, avant) => {
      const entree = entrees.find((e) => e.table === 'JournalAdministration' && e.ligne.type === 'MAIN_OEUVRE');
      const ecarts = [];
      if (!entree) {
        ecarts.push('entrée MAIN_OEUVRE absente');
        if (PRIX_MAIN_OEUVRE.some((c) => !memeValeur(ligne[c], avant?.[c]))) ecarts.push('montant écrit sans entrée de journal');
        return ecarts;
      }
      const apres = entree.ligne.apres ?? {};
      const avantEntree = entree.ligne.avant ?? {};
      const creation = !avant;
      for (const c of PRIX_MAIN_OEUVRE) {
        if (!creation && !(c in apres)) {
          if (!memeValeur(ligne[c], avant[c])) ecarts.push(`montant changé non journalisé : ${c}`);
          continue;
        }
        if (!creation && memeValeur(ligne[c], avant[c])) ecarts.push(`montant inchangé journalisé : ${c}`);
        if (!memeValeur(apres[c] ?? null, ligne[c])) ecarts.push(`montant journalisé différent du montant écrit : après ${c}`);
        if (!creation && !memeValeur(avantEntree[c] ?? null, avant[c])) ecarts.push(`montant journalisé différent du montant d’avant : avant ${c}`);
      }
      return ecarts;
    };
    // Constat des montants d'un cas : relecture propre au cas pour une écriture admise, montants inchangés sinon.
    const constaterMontants = async (c, res, entrees, source) => {
      chiffres.montants += 1;
      const m = c.montant;
      if (!m || res.status < 200 || res.status >= 300) {
        const tables = await montantsChanges();
        return tables.length ? `montants changés en base : ${tables.join(', ')}` : MONTANTS_INCHANGES;
      }
      if (m.genre === 'vendu') {
        // La fiche du chantier : montant vendu envoyé, autres montants du chantier inchangés.
        const colonnes = MONTANTS_SESSION.Chantier.colonnes;
        const lu = await ligneDe('public', 'Chantier', m.chantier, colonnes);
        const avant = await ligneDe('instantane', 'Chantier', m.chantier, colonnes);
        return constat('vendu', ecartsChamps(lu, { ...avant, budgetGlobalVendu: MONTANTS.vendu }), await hors([m.chantier], 'du chantier'));
      }
      if (m.genre === 'devis') {
        const devisId = m.devis ?? (await lignesCreees('Devis'))[0];
        const crees = await lignesCreees('Devis');
        if (!m.devis && crees.length !== 1) return `devis créés : ${crees.length ? 'plusieurs' : 'aucun'}`;
        return constat('devis', await ecartsDevis(devisId, m.attendu), await hors([devisId], 'du devis'));
      }
      if (m.genre === 'copie') {
        // Révision ou duplication : un devis créé, dont les totaux et les lignes égalent ceux de la source, relus dans
        // l'instantané (copie à l'identique, devis/metier.ts:291-301).
        const crees = await lignesCreees('Devis');
        if (crees.length !== 1) return `devis créés : ${crees.length ? 'plusieurs' : 'aucun'}`;
        return constat('copie', await ecartsDevis(crees[0], source), await hors([crees[0]], 'du devis créé'));
      }
      if (m.genre === 'conversion') {
        const crees = await lignesCreees('Chantier');
        if (crees.length !== 1) return `chantiers créés : ${crees.length ? 'plusieurs' : 'aucun'}`;
        const lu = await ligneDe('public', 'Chantier', crees[0], MONTANTS_SESSION.Chantier.colonnes);
        return constat('conversion', ecartsChamps(lu, MONTANTS.conversion), await hors([crees[0]], 'du chantier ouvert'));
      }
      if (m.genre === 'acompte') {
        const colonnes = MONTANTS_SESSION.Devis.colonnes;
        const lu = await ligneDe('public', 'Devis', m.devis, colonnes);
        const avant = await ligneDe('instantane', 'Devis', m.devis, colonnes);
        const ecarts = ecartsChamps(lu, { ...avant, acompteMontant: MONTANTS.acompte });
        if (!memeValeur(await lignesDuDevis('public', m.devis), await lignesDuDevis('instantane', m.devis))) ecarts.push('lignes');
        return constat('acompte', ecarts, await hors([m.devis], 'du devis'));
      }
      // Fiche du catalogue, créée ou modifiée : prix attendus, autres prix inchangés (fiche modifiée) ; main d'œuvre :
      // entrée de journal relue partiellement.
      const table = m.table ?? 'CataloguePrestation';
      const ficheId = m.fiche ?? (await lignesCreees(table))[0];
      if (!m.fiche && (await lignesCreees(table)).length !== 1) return 'fiche créée introuvable';
      const colonnes = MONTANTS_SESSION[table].colonnes;
      const lu = await ligneDe('public', table, ficheId, colonnes);
      const avant = m.fiche ? await ligneDe('instantane', table, ficheId, colonnes) : null;
      const attendu = { ...(avant ?? Object.fromEntries(colonnes.map((c) => [c, null]))), ...m.attendu };
      const ecarts = ecartsChamps(lu, attendu);
      if (m.genre === 'mainOeuvre') ecarts.push(...ecartsJournalMainOeuvre(entrees, lu, avant));
      return constat(m.genre, ecarts, await hors([ficheId], 'de la fiche'));
    };

    // --- Cas ---
    // { compte, route, cible, contexte, chemin, corps, prealables, code (réponse attendue, null si non écrite ; « 2xx »
    // pour une écriture admise sans code fixé), groupe (1 à 8 : réponse observée, cadrage §5.2), voit (champ → le compte
    // le voit-il, règle du code), montant (relecture), refuses (compte refusé d'une route de lecture) }.
    const ajouter = (compte, route, cible, contexte, chemin, corps, options = {}) => cas.push({ compte, route, cible, contexte, chemin, corps, prealables: [], code: null, ...options });
    const releverHorsDroits = (c, res) => {
      if (res.status >= 500) horsDroits.push(`${c.compte} | ${c.route} | ${c.cible} | ${c.contexte} | ${formaterReponse(res)}`);
    };
    const jouer = async (c) => {
      const [methode, chemin] = c.route.split(' ');
      // Préalables : un préalable refusé est enregistré dans la ligne du cas (diff lisible), qui n'est pas joué.
      for (const p of c.prealables) {
        const res = await appeler(appli.adresse, p.methode, p.chemin, { jeton: jetons[p.compte], corps: p.corps });
        if (res.status >= 200 && res.status < 300) continue;
        chiffres.prealablesRefuses += 1;
        c.reponse = `${formaterReponse(res, { messageDu400: true })} au préalable de ${p.compte} ; écriture non jouée`;
        lignes.push(ligneMatrice({ compte: c.compte, methode, chemin, cible: c.cible, contexte: c.contexte, reponse: c.reponse }));
        const aRemettre = remise.changees(await remise.empreinte());
        if (aRemettre.length) await remise.remettre(aRemettre, `préalable refusé de ${c.compte} ${c.route}, cible ${c.cible}`);
        return;
      }
      const etatAvant = c.prealables.length ? await remise.empreinte() : remise.reference;
      const entreesPrealables = c.prealables.length ? await entreesNouvelles(lecture) : [];
      const source = c.montant?.source ? await c.montant.source() : null;
      const res = await appeler(appli.adresse, methode, c.chemin, { jeton: jetons[c.compte], corps: c.corps() });
      chiffres.cas += 1;
      releverHorsDroits(c, res);
      const apres = await remise.empreinte();
      const changees = tablesChangees(etatAvant, apres);
      const entrees = (await entreesNouvelles(lecture)).filter((e) => !entreesPrealables.some((p) => memeEntree(p, e)));
      const nomsEntrees = entrees.map((e) => nommerEntree(e, noms)).sort();
      assert.equal(new Set(nomsEntrees).size, nomsEntrees.length, `${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : deux entrées de même nom (${nomsEntrees.join(' + ')})`);
      const morceaux = [formaterReponse(res, { messageDu400: true, ecriture: changees.length ? `écrit (${changees.join(',')})` : 'inchangé' })];
      morceaux.push(nomsEntrees.length ? `entrées : ${nomsEntrees.join(' + ')}` : 'aucune entrée');
      // Réponse d'une route des 8 groupes (cadrage §5.2) : état de chaque champ, jamais sa valeur.
      c.observation = null;
      if (c.groupe && res.status >= 200 && res.status < 300) {
        const champs = MONTANTS_MASQUES_ECRITURES[c.groupe - 1].champs;
        // `racine` : la réponse porte l'objet sous une clé (annulation d’un devis : { devis, … }, devis/routes.ts:582).
        const objet = c.racine ? res.body?.[c.racine] : res.body;
        c.observation = Object.fromEntries(champs.map((champ) => [champ, etatMontant(objet, champ)]));
        morceaux.push(`réponse : ${champs.map((champ) => `${c.racine ? `${c.racine}.` : ''}${champ} ${c.observation[champ]}`).join(', ')}`);
      }
      if (c.montant !== undefined) morceaux.push(await constaterMontants(c, res, entrees, source));
      c.reponse = morceaux.join(' ; ');
      lignes.push(ligneMatrice({ compte: c.compte, methode, chemin, cible: c.cible, contexte: c.contexte, reponse: c.reponse }));
      // Lectures des entrées (outils de 5c) : SA, AD, l'auteur hors administration, le compte refusé de la route ; l'export
      // CSV par SA et AD, chaque ligne de l'export lu reconnue (#457 N4).
      const taches = entrees.map((entree) => async () => {
        const nom = `${nommerEntree(entree, noms)} ← ${c.compte} ${c.route} sur ${c.cible}`;
        const verdicts = await lireVisibilite({ appeler, adresse: appli.adresse, jetons, entree, auteur: c.compte, exportsReference, entreesDuCas: [...entreesPrealables, ...entrees], refuses: c.refuses, nom, lignesExport: lecture });
        chiffres.lectures += verdicts.length;
        return verdicts.map((v) => ligneMatrice({ compte: v.lecteur, methode: 'GET', chemin: v.route.slice(4), cible: nom, contexte: c.contexte, reponse: v.verdict }));
      });
      for (const groupe of await enParallele(taches, 4)) lignes.push(...groupe);
      assert.deepEqual(tablesChangees(apres, await remise.empreinte()), [], `${c.compte} ${c.route} sur ${c.cible} : une lecture des journaux a écrit`);
      const aRemettre = remise.changees(apres);
      if (aRemettre.length) { await remise.remettre(aRemettre, `${c.compte} ${c.route}, cible ${c.cible}, contexte ${c.contexte}`); chiffres.remises += 1; }
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
        clientActif: id('client', 'client-actif'), ficheTech: id('fiche-intervenant', 'fiche-tech'), ficheLibre: id('fiche-intervenant', 'fiche-libre'),
        categorie: id('categorie', 'categorie'), fournisseur: id('fournisseur', 'fournisseur'), siteActif: id('site', 'site-client-actif'),
      });

      // --- Cibles propres (cadrage §3, §5.2 à §5.4), construites par l'API avant l'instantané ---
      // Catalogue : prestation à prix d'achat, article à prix d'achat, main d'œuvre copiée par un devis.
      const corpsPrestation = (prixAchatHt) => ({ reference: 'TEST-MONTANTS-PA', nom: 'TEST Prestation à prix d’achat de la matrice des montants', unite: 'forfait', prixVenteHt: MONTANTS.ficheVente, tauxTva: 20, prixAchatHt });
      P['prestation-prix-achat'] = (await api(SA, 'POST', '/api/catalogue/prestations', corpsPrestation(MONTANTS.ficheAchatInitial), 201)).id;
      const corpsArticle = (prixVenteHt, prixAchatHt) => ({ reference: 'TEST-MONTANTS-ART', nom: 'TEST Article à prix d’achat de la matrice des montants', prixVenteHt, tauxTva: 20, prixAchatHt });
      P['article-prix-achat'] = (await api(SA, 'POST', '/api/catalogue/articles', corpsArticle(MONTANTS.articleVenteInitial, MONTANTS.articleAchatInitial), 201)).id;
      const corpsMainOeuvre = (reference, nom, prix) => ({ estMainOeuvre: true, reference, nom, tauxTva: 20, ...prix });
      d.corpsMainOeuvre = corpsMainOeuvre;
      P['main-oeuvre-du-devis'] = (await api(SA, 'POST', '/api/catalogue/prestations', corpsMainOeuvre('TEST-MONTANTS-MO-DEVIS', 'TEST Main d’œuvre du devis de la matrice des montants', MONTANTS.mainOeuvreDuDevisInitial), 201)).id;
      // Devis brouillon : une ligne du catalogue (prestation-prix-achat), prix d'achat copié de la fiche (38,62).
      const ligneCatalogue = (designation, quantite, prixUnitaireHt) => ({ designation, nature: 'MAIN_OEUVRE', quantite, prixUnitaireHt, tauxTva: 20, catalogueFamille: 'prestations', catalogueId: P['prestation-prix-achat'] });
      d.ligneCatalogue = ligneCatalogue;
      const devisPa = await api(SA, 'POST', '/api/devis', { clientId: d.clientActif, objet: 'TEST Devis au prix d’achat de la matrice des montants', lignes: [ligneCatalogue('TEST Ligne du catalogue de la matrice des montants', 2, 150)] }, 201);
      P['devis-prix-achat'] = devisPa.id; d.ligneDevisPa = devisPa.lignes[0].id;
      // Devis signé à quatre lignes (MONTANTS.devisSigneLignes).
      const lignesSignees = [
        { designation: 'TEST Fourniture du catalogue de la matrice des montants', nature: 'FOURNITURE', quantite: 1.5, prixUnitaireHt: 33.33, tauxTva: 20, catalogueFamille: 'articles', catalogueId: P['article-prix-achat'] },
        ligneLibre('TEST Main-d’œuvre libre de la matrice des montants', 'MAIN_OEUVRE', 1.5, 61.5, { prixAchatUnitaireHt: 0.35 }),
        ligneLibre('TEST Fourniture libre de la matrice des montants', 'FOURNITURE', 2, 10.05),
        { designation: 'TEST Main d’œuvre au jour de la matrice des montants', forfaitMainOeuvre: 'JOUR', tarifForfait: 'HORS_CONTRAT', quantite: 2, catalogueFamille: 'prestations', catalogueId: P['main-oeuvre-du-devis'] },
      ];
      const signer = async (devisId) => {
        await api(SA, 'PUT', `/api/devis/${devisId}/statut`, { statut: 'ENVOYE' });
        await api(SA, 'POST', `/api/devis/${devisId}/signature`, { signataire: 'TEST Signataire de la matrice des montants', confirme: true }, 201);
      };
      P['devis-signe-prix-achat'] = (await api(SA, 'POST', '/api/devis', { clientId: d.clientActif, objet: 'TEST Devis signé au prix d’achat de la matrice des montants', lignes: lignesSignees }, 201)).id;
      await signer(P['devis-signe-prix-achat']);
      // Devis signé dont l'acompte est attendu, une ligne au prix d'achat prévu.
      P['devis-acompte-prix-achat'] = (await api(SA, 'POST', '/api/devis', { clientId: d.clientActif, objet: 'TEST Devis à acompte de la matrice des montants', acompteExige: true, lignes: [ligneLibre('TEST Ligne du devis à acompte', 'FOURNITURE', 3, 41.11, { prixAchatUnitaireHt: MONTANTS.prixAchatLigne })] }, 201)).id;
      await signer(P['devis-acompte-prix-achat']);
      // Devis signé dont l'acompte est reçu avant l'instantané : la copie de l'acompte par une révision, et non par une
      // duplication.
      P['devis-acompte-recu'] = (await api(SA, 'POST', '/api/devis', { clientId: d.clientActif, objet: 'TEST Devis à acompte reçu de la matrice des montants', acompteExige: true, lignes: [ligneLibre('TEST Ligne du devis à acompte reçu', 'FOURNITURE', 3, 17.29, { prixAchatUnitaireHt: MONTANTS.prixAchatLigne })] }, 201)).id;
      await signer(P['devis-acompte-recu']);
      await api(SA, 'POST', `/api/devis/${P['devis-acompte-recu']}/acompte`, { recuLe: d.hier, montant: MONTANTS.acompteRecu, reference: 'TEST-ACOMPTE-RECU-MONTANTS' });
      // Sources changées après coup (copie figée) : taux d'acompte par défaut, fiche, article et main d'œuvre du devis.
      d.tauxAcompteInitial = Number((await appli.prisma.parametres.findUniqueOrThrow({ where: { id: 'singleton' }, select: { tauxAcompteDefaut: true } })).tauxAcompteDefaut);
      await api(SA, 'PUT', '/api/parametres', { tauxAcompteDefaut: MONTANTS.tauxAcompteDuJour });
      await api(SA, 'PUT', `/api/catalogue/prestations/${P['prestation-prix-achat']}`, corpsPrestation(MONTANTS.ficheAchat));
      await api(SA, 'PUT', `/api/catalogue/articles/${P['article-prix-achat']}`, corpsArticle(MONTANTS.articleVente, MONTANTS.articleAchat));
      await api(SA, 'PUT', `/api/catalogue/prestations/${P['main-oeuvre-du-devis']}`, corpsMainOeuvre('TEST-MONTANTS-MO-DEVIS', 'TEST Main d’œuvre du devis de la matrice des montants', MONTANTS.mainOeuvreDuDevis));
      // Mains d'œuvre du catalogue (§5.3) : modifiée, désactivée, rendue prestation ; rattachée à la fiche du technicien ;
      // désactivée (réactivation) ; prestation ordinaire (passage en main d'œuvre).
      P['main-oeuvre-catalogue'] = (await api(SA, 'POST', '/api/catalogue/prestations', corpsMainOeuvre('TEST-MONTANTS-MO', 'TEST Main d’œuvre de la matrice des montants', MONTANTS.mainOeuvre), 201)).id;
      P['main-oeuvre-rattachee'] = (await api(SA, 'POST', '/api/catalogue/prestations', corpsMainOeuvre('TEST-MONTANTS-MO-RAT', 'TEST Main d’œuvre rattachée de la matrice des montants', MONTANTS.mainOeuvreRattachee), 201)).id;
      await api(SA, 'PUT', `/api/intervenants/${d.ficheTech}/main-oeuvre`, { mainOeuvreId: P['main-oeuvre-rattachee'] });
      P['main-oeuvre-desactivee'] = (await api(SA, 'POST', '/api/catalogue/prestations', corpsMainOeuvre('TEST-MONTANTS-MO-DES', 'TEST Main d’œuvre désactivée de la matrice des montants', MONTANTS.mainOeuvre), 201)).id;
      await api(SA, 'DELETE', `/api/catalogue/prestations/${P['main-oeuvre-desactivee']}`, {});
      P['prestation-ordinaire'] = (await api(SA, 'POST', '/api/catalogue/prestations', { reference: 'TEST-MONTANTS-ORD', nom: 'TEST Prestation ordinaire de la matrice des montants', unite: 'forfait', prixVenteHt: 55.55, tauxTva: 20 }, 201)).id;
      // Parc : modèle à prix d'achat (G8 côté « voit »), équipement installé de ce modèle.
      P['modele-prix-achat'] = (await api(SA, 'POST', '/api/catalogue/equipements', { reference: 'TEST-MONTANTS-EQ', nom: 'TEST Modèle à prix d’achat de la matrice des montants', fabricant: 'TEST', prixVenteHt: 300, prixAchatHt: MONTANTS.modeleAchat }, 201)).id;
      P['equipement-prix-achat'] = (await api(SA, 'POST', `/api/clients/${d.clientActif}/equipements`, { catalogueEquipementId: P['modele-prix-achat'], clientSiteId: d.siteActif, numeroSerie: 'TEST-SN-MONTANTS-PA' }, 201)).id;
      // Heures SAV saisies par le technicien après le rattachement de sa fiche (prix de vente à l'heure figé, G6 côté
      // « voit ») : sur intervention-affectee-tech ; et sur une intervention du chantier de CT, que CT archive (G6 côté
      // « ne voit pas »).
      P['heures-tech-prix-vente'] = (await api('TECH', 'POST', `/api/interventions/${id('intervention', 'intervention-affectee-tech')}/couts/heures`, { date: d.aujourdhui, nbrHeures: 1.25 }, 201)).id;
      const chantierCt = await appli.prisma.chantier.findUniqueOrThrow({ where: { id: id('chantier', 'chantier-ct') }, select: { clientId: true } });
      const interCt = await api(SA, 'POST', '/api/interventions', { clientId: chantierCt.clientId, titre: 'TEST Intervention du chantier de CT de la matrice des montants', chantierId: id('chantier', 'chantier-ct') }, 201);
      P['intervention-chantier-ct-tech'] = interCt.id;
      await api(SA, 'PUT', `/api/interventions/${interCt.id}/planning`, { dateDebut: d.hier, creneau: 'JOURNEE', intervenantIds: [d.ficheTech] }, [200, 201]);
      if ((await appli.prisma.intervention.findUniqueOrThrow({ where: { id: interCt.id } })).statut === 'A_PLANIFIER') await api(SA, 'PATCH', `/api/interventions/${interCt.id}/statut`, { statut: 'PLANIFIEE' });
      await api(SA, 'PATCH', `/api/interventions/${interCt.id}/statut`, { statut: 'EN_COURS' });
      P['heures-tech-chantier-ct'] = (await api('TECH', 'POST', `/api/interventions/${interCt.id}/couts/heures`, { date: d.hier, nbrHeures: 1.5 }, 201)).id;
      // N1 de #435 : un achat et un pointage posés par l'administration sur les chantiers de COM, AC, DC et CPT.
      for (const nom of ['chantier-com', 'chantier-com-titulaire', 'chantier-ac', 'chantier-dc', 'chantier-cpt']) {
        await api(SA, 'POST', '/api/achats', { chantierId: id('chantier', nom), categorieId: d.categorie, fournisseurId: d.fournisseur, date: d.hier, description: `TEST Achat de ${nom} de la matrice des montants`, montantHT: 100 }, [200, 201]);
        await api(SA, 'POST', '/api/heures', { chantierId: id('chantier', nom), intervenantId: d.ficheLibre, date: d.hier, nbrHeures: 2 }, [200, 201]);
      }
      // Planning : type sans affectation, supprimable.
      P['type-planning-libre'] = (await api(SA, 'POST', '/api/planning/types', { nom: 'TEST Type libre de la matrice des montants', couleur: '#345678' }, 201)).id;

      // --- Valeurs relues avant l'instantané, pour le témoin des montants ---
      const nombre = (v) => (v === null || v === undefined ? null : Number(v));
      const fiche = async (delegue, ficheId, champs) => {
        const f = await appli.prisma[delegue].findUniqueOrThrow({ where: { id: ficheId } });
        return Object.fromEntries(champs.map((c) => [c, nombre(f[c])]));
      };
      const lignesDe = async (devisId) => (await appli.prisma.devisLigne.findMany({ where: { devisId }, orderBy: { ordre: 'asc' } })).map((l) => ({ ...Object.fromEntries(CHAMPS_LIGNE_DEVIS.map((c) => [c, nombre(l[c])])), nature: l.nature }));
      const devisDe = async (devisId) => {
        const dv = await appli.prisma.devis.findUniqueOrThrow({ where: { id: devisId } });
        return { totalHt: nombre(dv.totalHt), totalTva: nombre(dv.totalTva), totalTtc: nombre(dv.totalTtc), tauxAcompte: nombre(dv.tauxAcompte), acompteMontant: nombre(dv.acompteMontant), statut: dv.statut };
      };
      d.temoin = {
        chantiers: await Promise.all(Object.keys(TITULAIRE).concat(BRANCHE_DE_RESP).map(async (nom) => nombre((await appli.prisma.chantier.findUniqueOrThrow({ where: { id: id('chantier', nom) } })).budgetGlobalVendu))),
        prestation: await fiche('cataloguePrestation', P['prestation-prix-achat'], ['prixVenteHt', 'prixAchatHt']),
        article: await fiche('catalogueArticle', P['article-prix-achat'], ['prixVenteHt', 'prixAchatHt']),
        mainOeuvreDuDevis: await fiche('cataloguePrestation', P['main-oeuvre-du-devis'], ['prixJourHorsContratHt', 'heuresParJour']),
        mainOeuvre: await fiche('cataloguePrestation', P['main-oeuvre-catalogue'], PRIX_MAIN_OEUVRE),
        modele: await fiche('catalogueEquipement', P['modele-prix-achat'], ['prixAchatHt']),
        devisPa: { ...(await devisDe(P['devis-prix-achat'])), lignes: await lignesDe(P['devis-prix-achat']) },
        devisSigne: { ...(await devisDe(P['devis-signe-prix-achat'])), lignes: await lignesDe(P['devis-signe-prix-achat']) },
        devisAcompte: await devisDe(P['devis-acompte-prix-achat']),
        devisAcompteRecu: await devisDe(P['devis-acompte-recu']),
        tauxAcompteDuJour: Number((await appli.prisma.parametres.findUniqueOrThrow({ where: { id: 'singleton' }, select: { tauxAcompteDefaut: true } })).tauxAcompteDefaut),
      };

      // Instantané et outil de remise en état, une fois tout construit ; connexion de lecture ; exports de référence du
      // journal d'administration, et l'outil de l'export qui vérifie reconnaître celui du SA (#457 T1) : sans quoi la
      // préparation s'arrête avec un message clair.
      const tables = await tablesDeLaBase(appli.prisma);
      remise = await creerRemiseEnEtat({ url: base.url, nomBase: base.nom, tables, connexionApplication: appli.serveur.prisma, factureEmiseId: id('facture', 'facture-emise') });
      lecture = await ouvrirConnexionLecture(base.url);
      assert.deepEqual(await entreesNouvelles(lecture), [], 'aucune entrée nouvelle juste après l’instantané');
      exportsReference = await lireExports({ appeler, adresse: appli.adresse, jetons });
      d.entreesJournalAdministration = await verifierLectureExport(lecture, exportsReference.SA);
      construireCas();
    });

    after(async () => {
      await lecture?.end().catch(() => {});
      await remise?.fermer();
      await appli?.fermer();
      await base.supprimer();
    });

    // --- Règles de visibilité des 8 groupes (attendus du code : chantiers/droits.ts:23-35 et :133-139,
    // droits/visibilite.ts:11-14, :36-57 et :63-70) ---
    const voitRentabilite = (compte, chantier, contexte) => {
      if (ADMINISTRATION.includes(compte)) return true;
      if (compte === 'DIR') return !contexte.startsWith('rentabiliteDirecteurs=non');
      if (['CT', 'RESP'].includes(compte) && TITULAIRE[chantier] === compte) return !contexte.startsWith('rentabiliteConducteur=non');
      if (compte === 'RESP' && BRANCHE_DE_RESP.includes(chantier)) return !contexte.startsWith('rentabiliteHierarchie=non');
      return false;
    };
    const VOIT = {
      1: (c) => (champ) => {
        if (champ === 'budgetGlobalVendu') return voitRentabilite(c.compte, c.cible, c.contexte);
        if (champ === 'coutMaterielPrevu') return ADMINISTRATION.includes(c.compte) || voitRentabilite(c.compte, c.cible, c.contexte);
        return c.compte !== 'TECH';
      },
      2: (c) => () => ADMINISTRATION.includes(c.compte),
      3: (c) => () => ADMINISTRATION.includes(c.compte),
      4: (c) => () => ADMINISTRATION.includes(c.compte),
      5: () => () => false,
      6: (c) => (champ) => (champ === 'montantHT' ? c.compte !== 'TECH' : ADMINISTRATION.includes(c.compte)),
      7: (c) => () => ADMINISTRATION.includes(c.compte),
      8: (c) => () => ADMINISTRATION.includes(c.compte),
    };

    // --- Table des cas ---
    function construireCas() {
      const corpsVide = () => ({});
      const prealableReglage = (reglage) => (reglage ? [{ compte: SA, methode: 'PUT', chemin: '/api/parametres', corps: reglage }] : []);
      const prealableDroit = (compte, droit) => [{ compte: SA, methode: 'PUT', chemin: `/api/users/${comptes[compte].id}/permissions`, corps: { permissions: SCOPES_DU_DROIT[droit] } }];
      const chantier = (nom) => id('chantier', nom);
      const avecVoit = (options) => ({ ...options, voit: null });
      const ajouterGroupe = (groupe, compte, route, cible, contexte, chemin, corps, options = {}) => {
        const c = { compte, route, cible, contexte, chemin, corps, prealables: [], code: null, groupe, ...avecVoit(options) };
        c.voit = VOIT[groupe](c);
        cas.push(c);
      };
      const motif = (quoi) => `TEST motif de ${quoi} par la matrice des montants`;

      // §5.1 : montant vendu et réponses des trois routes de chantier, sous les quatre contextes de la rentabilité.
      const refusesCommercial = { 'GET /api/chantiers/:id/journal-saisies': 'TECH' };
      for (const [contexte, reglage] of CONTEXTES_RENTABILITE) {
        const prealables = prealableReglage(reglage);
        const ctx = (corps) => `${contexte}, corps ${corps}`;
        // Fiche, corps montant vendu : chaque compte admis sur son chantier ; la hiérarchie (404) et le directeur (403),
        // état décrit (cadrage §5.1) ; le chantier terminé : CT refusé (403), SA et AD écrivent.
        const vendu = [['SA', 'chantier-ct'], ['AD', 'chantier-ct'], ['AD-COM', 'chantier-ct'], ['CT', 'chantier-ct'], ['RESP', 'chantier-resp'], ['RESP', 'chantier-ct-branche-resp'], ['DC', 'chantier-dc'], ['AC', 'chantier-ac'], ['CPT', 'chantier-cpt'], ['DIR', 'chantier-dir'], ['CT', 'chantier-termine'], ['SA', 'chantier-termine'], ['AD', 'chantier-termine']];
        for (const [compte, nom] of vendu) {
          let code = 403;
          if (ADMINISTRATION.includes(compte)) code = 200;
          else if (nom === 'chantier-ct-branche-resp') code = 404;
          else if (['CT', 'RESP'].includes(compte) && nom !== 'chantier-termine' && voitRentabilite(compte, nom, contexte)) code = 200;
          ajouterGroupe(1, compte, 'PATCH /api/chantiers/:id', nom, ctx('montant vendu'), `/api/chantiers/${chantier(nom)}`, () => ({ budgetGlobalVendu: MONTANTS.vendu }), { prealables, code, montant: { genre: 'vendu', chantier: chantier(nom) } });
        }
        // Fiche, corps nom : DC, AC et CPT, dont la réponse masque le montant vendu (cadrage §5.1).
        for (const [compte, nom] of [['DC', 'chantier-dc'], ['AC', 'chantier-ac'], ['CPT', 'chantier-cpt']]) {
          ajouterGroupe(1, compte, 'PATCH /api/chantiers/:id', nom, ctx('nom'), `/api/chantiers/${chantier(nom)}`, () => ({ nom: `TEST ${nom} renommé par la matrice des montants` }), { prealables, code: 200, montant: null });
        }
        // Statut : chaque compte admis sur son chantier (5a), dont DIR et RESP par sa branche.
        for (const [compte, nom] of [['SA', 'chantier-ct'], ['AD', 'chantier-ct'], ['AD-COM', 'chantier-ct'], ['CT', 'chantier-ct'], ['DIR', 'chantier-ct'], ['RESP', 'chantier-resp'], ['RESP', 'chantier-tech-branche-resp'], ['DC', 'chantier-dc'], ['AC', 'chantier-ac'], ['CPT', 'chantier-cpt']]) {
          ajouterGroupe(1, compte, 'PATCH /api/chantiers/:id/statut', nom, ctx('statut=TERMINE'), `/api/chantiers/${chantier(nom)}/statut`, () => ({ statut: 'TERMINE' }), { prealables, code: 200, montant: null });
        }
        // Commercial : chaque compte admis sur son chantier (5b).
        for (const [compte, nom] of [['SA', 'chantier-ct'], ['AD', 'chantier-ct'], ['AD-COM', 'chantier-ct'], ['CT', 'chantier-ct'], ['RESP', 'chantier-resp'], ['DC', 'chantier-dc'], ['AC', 'chantier-ac'], ['CPT', 'chantier-cpt']]) {
          ajouterGroupe(1, compte, 'PATCH /api/chantiers/:id/commercial', nom, ctx('commercialId=COM'), `/api/chantiers/${chantier(nom)}/commercial`, () => ({ commercialId: comptes.COM.id }), { prealables, code: 200, montant: null, refuses: refusesCommercial });
        }
      }

      // §5.2, G2 : conversion en chantier de devis-signe-prix-achat (un cas par couple ; triplets « droit … »).
      const conversion = (compte, contexte, prealables = []) => ajouterGroupe(2, compte, 'POST /api/devis/:id/convertir', 'devis-signe-prix-achat', `${contexte}, corps cible=CHANTIER`, `/api/devis/${P['devis-signe-prix-achat']}/convertir`, () => ({ cible: 'CHANTIER' }), { prealables, code: 201, montant: { genre: 'conversion' } });
      for (const compte of [...ADMINISTRATION, ...DEVIS_HORS_ADMINISTRATION]) conversion(compte, 'défaut');
      // §5.2, G3 : les sept routes des devis.
      const devisCree = (prixAchatUnitaireHt) => ({ totaux: { totalHt: MONTANTS.ligneHt, totalTva: MONTANTS.devisTva, totalTtc: MONTANTS.ligneTtc }, lignes: [{ ...MONTANTS.ligne, totalHt: MONTANTS.ligneHt, totalTtc: MONTANTS.ligneTtc, prixAchatUnitaireHt }] });
      const corpsDevisCatalogue = () => ({ clientId: d.clientActif, objet: 'TEST Devis du catalogue de la matrice des montants', lignes: [d.ligneCatalogue('TEST Ligne du catalogue copiée par la matrice des montants', MONTANTS.ligne.quantite, MONTANTS.ligne.prixUnitaireHt)] });
      const corpsDevisModifie = (extra = {}) => () => ({ clientId: d.clientActif, objet: 'TEST Devis au prix d’achat modifié par la matrice des montants', lignes: [{ ligneId: d.ligneDevisPa, designation: 'TEST Ligne du catalogue de la matrice des montants', nature: 'MAIN_OEUVRE', ...MONTANTS.ligne, ...extra }] });
      const sourceSignee = async () => ({ totaux: await ligneDe('instantane', 'Devis', P['devis-signe-prix-achat'], ['totalHt', 'totalTva', 'totalTtc', 'tauxAcompte', 'acompteMontant']), lignes: await lignesDuDevis('instantane', P['devis-signe-prix-achat']) });
      const devisG3 = (compte, contexte, prealables = []) => {
        ajouterGroupe(3, compte, 'POST /api/devis', 'clientId=client-actif', `${contexte}, corps ligne du catalogue`, '/api/devis', corpsDevisCatalogue, { prealables, code: 201, montant: { genre: 'devis', attendu: devisCree(MONTANTS.ficheAchat) } });
        ajouterGroupe(3, compte, 'PATCH /api/devis/:id', 'devis-prix-achat', `${contexte}, corps ligne existante sans prix d’achat`, `/api/devis/${P['devis-prix-achat']}`, corpsDevisModifie(), { prealables, code: 200, montant: { genre: 'devis', devis: P['devis-prix-achat'], attendu: devisCree(MONTANTS.ficheAchatInitial) } });
        ajouterGroupe(3, compte, 'PUT /api/devis/:id/statut', 'devis-prix-achat', `${contexte}, corps statut=ENVOYE`, `/api/devis/${P['devis-prix-achat']}/statut`, () => ({ statut: 'ENVOYE' }), { prealables, code: 200, montant: null });
        ajouterGroupe(3, compte, 'POST /api/devis/:id/duplication', 'devis-signe-prix-achat', `${contexte}, corps sans corps`, `/api/devis/${P['devis-signe-prix-achat']}/duplication`, corpsVide, { prealables, code: 201, montant: { genre: 'copie', source: sourceSignee } });
      };
      for (const compte of [...ADMINISTRATION, ...DEVIS_HORS_ADMINISTRATION]) {
        devisG3(compte, 'défaut');
        ajouterGroupe(3, compte, 'POST /api/devis/:id/revisions', 'devis-signe-prix-achat', 'défaut, corps sans corps', `/api/devis/${P['devis-signe-prix-achat']}/revisions`, corpsVide, { code: 201, montant: { genre: 'copie', source: sourceSignee } });
      }
      for (const compte of ADMINISTRATION) {
        ajouterGroupe(3, compte, 'POST /api/devis/:id/acompte', 'devis-acompte-prix-achat', 'défaut, corps date, montant et référence', `/api/devis/${P['devis-acompte-prix-achat']}/acompte`, () => ({ recuLe: d.hier, montant: MONTANTS.acompte, reference: 'TEST-ACOMPTE-MONTANTS' }), { code: 200, montant: { genre: 'acompte', devis: P['devis-acompte-prix-achat'] } });
        ajouterGroupe(3, compte, 'POST /api/devis/:id/annulation', 'devis-prix-achat', 'défaut, corps motif', `/api/devis/${P['devis-prix-achat']}/annulation`, () => ({ motif: motif('l’annulation') }), { code: 200, montant: null, racine: 'devis' });
      }
      // Copie figée du taux d'acompte (cadrage §3) : une révision copie le taux du devis qu'elle révise
      // (devis/routes.ts:127) ; une duplication relit le taux d'acompte par défaut du jour (devis/routes.ts:600-601
      // et :638), changé après la création de devis-acompte-prix-achat.
      // Acompte reçu (devis-acompte-recu, constaté avant l'instantané) : une révision le reprend (devis/routes.ts:131-132) ;
      // une duplication, devis neuf en brouillon, ne le reprend pas (devis/routes.ts:632-644), enregistré tel quel.
      const sourceAcompte = (cible, duplication) => async () => {
        const totaux = await ligneDe('instantane', 'Devis', P[cible], ['totalHt', 'totalTva', 'totalTtc', 'tauxAcompte', 'acompteMontant']);
        return { totaux: duplication ? { ...totaux, tauxAcompte: MONTANTS.tauxAcompteDuJour, acompteMontant: null } : totaux, lignes: await lignesDuDevis('instantane', P[cible]) };
      };
      for (const cible of ['devis-acompte-prix-achat', 'devis-acompte-recu']) {
        for (const compte of [SA, 'AD']) {
          ajouterGroupe(3, compte, 'POST /api/devis/:id/revisions', cible, 'défaut, corps sans corps', `/api/devis/${P[cible]}/revisions`, corpsVide, { code: 201, montant: { genre: 'copie', source: sourceAcompte(cible, false) } });
          ajouterGroupe(3, compte, 'POST /api/devis/:id/duplication', cible, 'défaut, corps sans corps', `/api/devis/${P[cible]}/duplication`, corpsVide, { code: 201, montant: { genre: 'copie', source: sourceAcompte(cible, true) } });
        }
      }
      // Triplets « droit … » de 5b (R-B non appliquée) : CT, DIR et RESP avec le droit devis ou le scope devis:write.
      for (const compte of ['CT', 'DIR', 'RESP']) {
        for (const droit of ['droit devis', 'droit devis:write']) {
          devisG3(compte, droit, prealableDroit(compte, droit));
          conversion(compte, droit, prealableDroit(compte, droit));
        }
      }
      // §5.3 : prix d'achat prévu saisi sur une ligne. Administration : écrit, relu ; tout autre compte : refusé (403),
      // inchangé (devis/metier.ts:203-205), dont CT, DIR et RESP avec le droit devis.
      const corpsDevisPrixAchat = () => ({ clientId: d.clientActif, objet: 'TEST Devis au prix d’achat saisi par la matrice des montants', lignes: [ligneLibre('TEST Ligne au prix d’achat saisi par la matrice des montants', 'FOURNITURE', MONTANTS.ligne.quantite, MONTANTS.ligne.prixUnitaireHt, { prixAchatUnitaireHt: MONTANTS.prixAchatLigne })] });
      const auteursPrixAchat = [...ADMINISTRATION.map((c) => [c, 'défaut', []]), ...DEVIS_HORS_ADMINISTRATION.map((c) => [c, 'défaut', []]), ...['CT', 'DIR', 'RESP'].map((c) => [c, 'droit devis', prealableDroit(c, 'droit devis')])];
      for (const [compte, contexte, prealables] of auteursPrixAchat) {
        const admis = ADMINISTRATION.includes(compte);
        ajouterGroupe(3, compte, 'POST /api/devis', 'clientId=client-actif', `${contexte}, corps ligne au prix d’achat prévu`, '/api/devis', corpsDevisPrixAchat, { prealables, code: admis ? 201 : 403, montant: admis ? { genre: 'devis', attendu: devisCree(MONTANTS.prixAchatLigne) } : null });
        if (contexte === 'défaut') {
          ajouterGroupe(3, compte, 'PATCH /api/devis/:id', 'devis-prix-achat', `${contexte}, corps ligne existante au prix d’achat prévu`, `/api/devis/${P['devis-prix-achat']}`, corpsDevisModifie({ prixAchatUnitaireHt: MONTANTS.prixAchatLigne }), { prealables, code: admis ? 200 : 403, montant: admis ? { genre: 'devis', devis: P['devis-prix-achat'], attendu: devisCree(MONTANTS.prixAchatLigne) } : null });
        }
      }

      // §5.2, G4 : heures d'un chantier (création, correction, restauration) ; montants relus par 5c.
      const corpsHeures = (nom) => () => ({ chantierId: chantier(nom), intervenantId: d.ficheLibre, date: d.hier, nbrHeures: 2.75 });
      for (const [compte, nom] of [['SA', 'chantier-ct'], ['AD', 'chantier-ct'], ['AD-COM', 'chantier-ct'], ['CT', 'chantier-ct'], ['RESP', 'chantier-resp']]) {
        ajouterGroupe(4, compte, 'POST /api/heures', `chantierId=${nom}`, 'défaut, corps heures', '/api/heures', corpsHeures(nom), { code: 200, montant: null });
      }
      for (const [compte, nom] of [['SA', 'heure-chantier-ct'], ['AD', 'heure-chantier-ct'], ['AD-COM', 'heure-chantier-ct'], ['CT', 'heure-chantier-ct'], ['RESP', 'heure-chantier-ct-branche-resp']]) {
        ajouterGroupe(4, compte, 'PATCH /api/heures/:id', nom, 'défaut, corps commentaire, heures et motif', `/api/heures/${id('heure', nom)}`, () => ({ motifCorrection: motif('correction'), commentaire: 'TEST Pointage corrigé par la matrice des montants', nbrHeures: 3.25 }), { code: 200, montant: null });
      }
      const restaurer = (compte, contexte, prealables = []) => ajouterGroupe(4, compte, 'POST /api/heures/:id/restaurer', 'heure-archivee-chantier-ct', `${contexte}, corps motif de restauration`, `/api/heures/${id('heure', 'heure-archivee-chantier-ct')}/restaurer`, () => ({ motifRestauration: motif('restauration') }), { prealables, code: 200, montant: null });
      for (const compte of ADMINISTRATION) restaurer(compte, 'défaut');
      restaurer('CT', 'droit chantiers:archive', prealableDroit('CT', 'droit chantiers:archive'));
      // §5.2, G5 : heures SAV du technicien affecté (création, correction).
      ajouterGroupe(5, 'TECH', 'POST /api/interventions/:id/couts/heures', 'intervention-affectee-tech', 'défaut, corps date et heures', `/api/interventions/${id('intervention', 'intervention-affectee-tech')}/couts/heures`, () => ({ date: d.aujourdhui, nbrHeures: 1.75 }), { code: 201, montant: null });
      ajouterGroupe(5, 'TECH', 'PATCH /api/interventions/:id/couts/:type/:coutId', 'heures-tech-intervention-affectee', 'défaut, corps nbrHeures et motif', cheminPour('/api/interventions/:id/couts/:type/:coutId', 'cout-sav', cibleDe('cout-sav', 'heures-tech-intervention-affectee')), () => ({ motifCorrection: motif('correction des heures'), nbrHeures: 2.25 }), { code: 200, montant: null });
      // §5.2, G6 : archivage d'un coût SAV : heures à prix de vente figé (administration), matériel (AD), heures du chantier
      // de CT (CT).
      const action = (interventionId, type, coutId) => `/api/interventions/${interventionId}/couts/${type}/${coutId}/archiver`;
      const coutMateriel = cibleDe('cout-sav', 'materiel-intervention-affectee').ids;
      for (const [compte, cible, chemin] of [
        ['SA', 'heures-tech-prix-vente', action(id('intervention', 'intervention-affectee-tech'), 'heures', P['heures-tech-prix-vente'])],
        ['AD', 'materiel-intervention-affectee', action(coutMateriel.id, 'achats', coutMateriel.coutId)],
        ['AD-COM', 'heures-tech-prix-vente', action(id('intervention', 'intervention-affectee-tech'), 'heures', P['heures-tech-prix-vente'])],
        ['CT', 'heures-tech-chantier-ct', action(P['intervention-chantier-ct-tech'], 'heures', P['heures-tech-chantier-ct'])],
      ]) ajouterGroupe(6, compte, 'POST /api/interventions/:id/couts/:type/:coutId/:action', cible, 'défaut, corps motif', chemin, () => ({ motif: motif('l’archivage') }), { code: 200, montant: null });

      // §5.2, G7 et §5.3 : fiches du catalogue écrites par l'administration ; un PUT qui omet le prix d'achat l'efface
      // (catalogue/metier.ts:38-40 et :86), enregistré tel quel (cadrage §10).
      const pa = `/api/catalogue/prestations/${P['prestation-prix-achat']}`;
      const corpsPa = (extra = {}) => () => ({ reference: 'TEST-MONTANTS-PA', nom: 'TEST Prestation à prix d’achat de la matrice des montants', unite: 'forfait', prixVenteHt: MONTANTS.ficheVente, tauxTva: 20, ...extra });
      for (const compte of ADMINISTRATION) {
        ajouterGroupe(7, compte, 'POST /api/catalogue/:family', 'family=articles', 'défaut, corps article au prix d’achat', '/api/catalogue/articles', () => ({ reference: 'TEST-MONTANTS-ART-CREE', nom: 'TEST Article créé par la matrice des montants', ...MONTANTS.articleCree }), { code: 201, montant: { genre: 'fiche', table: 'CatalogueArticle', attendu: MONTANTS.articleCree } });
        ajouterGroupe(7, compte, 'PUT /api/catalogue/:family/:id', 'prestation-prix-achat', 'défaut, corps sans prix d’achat', pa, corpsPa(), { code: 200, montant: { genre: 'effacement', fiche: P['prestation-prix-achat'], attendu: { prixAchatHt: null } } });
        ajouterGroupe(7, compte, 'PUT /api/catalogue/:family/:id', 'prestation-prix-achat', 'défaut, corps prix d’achat changé', pa, corpsPa({ prixAchatHt: MONTANTS.ficheAchatModifie }), { code: 200, montant: { genre: 'fiche', fiche: P['prestation-prix-achat'], attendu: { prixAchatHt: MONTANTS.ficheAchatModifie } } });
        ajouterGroupe(7, compte, 'DELETE /api/catalogue/:family/:id', 'prestation-prix-achat', 'défaut', pa, corpsVide, { code: 200, montant: { genre: 'fiche', fiche: P['prestation-prix-achat'], attendu: {} } });
      }
      // §5.3 : mains d'œuvre, par SA et AD (catalogue/main-oeuvre.ts).
      const mo = (nom) => `/api/catalogue/prestations/${P[nom]}`;
      const corpsMo = (nom, prix = MONTANTS.mainOeuvre, extra = {}) => () => ({ ...d.corpsMainOeuvre(nom === 'creee' ? 'TEST-MONTANTS-MO-CREEE' : 'TEST-MONTANTS-MO', `TEST Main d’œuvre ${nom === 'creee' ? 'créée' : ''} de la matrice des montants`.replace('  ', ' '), prix), ...extra });
      const corpsRetour = (reference) => () => ({ estMainOeuvre: false, reference, nom: 'TEST Main d’œuvre rendue prestation par la matrice des montants', unite: 'forfait', prixVenteHt: MONTANTS.prestationRetour, tauxTva: 20 });
      const retourAttendu = { prixVenteHt: MONTANTS.prestationRetour, ...Object.fromEntries(PRIX_MAIN_OEUVRE.slice(1).map((c) => [c, null])) };
      for (const compte of [SA, 'AD']) {
        const moCas = (route, cible, contexte, chemin, corps, options) => ajouterGroupe(7, compte, route, cible, contexte, chemin, corps, options);
        moCas('POST /api/catalogue/:family', 'family=prestations', 'défaut, corps main d’œuvre, six prix et heures par jour', '/api/catalogue/prestations', corpsMo('creee'), { code: 201, montant: { genre: 'mainOeuvre', attendu: { tauxTva: 20, ...MONTANTS.mainOeuvre } } });
        moCas('POST /api/catalogue/:family', 'family=prestations', 'défaut, corps main d’œuvre avec une durée indicative', '/api/catalogue/prestations', corpsMo('creee', MONTANTS.mainOeuvre, { dureeIndicativeMin: 30 }), { code: 400, montant: null });
        moCas('POST /api/catalogue/:family', 'family=prestations', 'défaut, corps main d’œuvre avec un prix d’achat', '/api/catalogue/prestations', corpsMo('creee', MONTANTS.mainOeuvre, { prixAchatHt: MONTANTS.prixAchatLigne }), { code: 400, montant: null });
        moCas('PUT /api/catalogue/:family/:id', 'main-oeuvre-catalogue', 'défaut, corps main d’œuvre, prix horaire changé', mo('main-oeuvre-catalogue'), corpsMo('catalogue', { ...MONTANTS.mainOeuvre, prixVenteHt: MONTANTS.mainOeuvreModifiee }), { code: 200, montant: { genre: 'mainOeuvre', fiche: P['main-oeuvre-catalogue'], attendu: { prixVenteHt: MONTANTS.mainOeuvreModifiee } } });
        moCas('DELETE /api/catalogue/:family/:id', 'main-oeuvre-catalogue', 'défaut', mo('main-oeuvre-catalogue'), corpsVide, { code: 200, montant: { genre: 'mainOeuvre', fiche: P['main-oeuvre-catalogue'], attendu: {} } });
        moCas('PUT /api/catalogue/:family/:id', 'main-oeuvre-catalogue', 'défaut, corps prestation ordinaire, retour', mo('main-oeuvre-catalogue'), corpsRetour('TEST-MONTANTS-MO'), { code: 200, montant: { genre: 'mainOeuvre', fiche: P['main-oeuvre-catalogue'], attendu: retourAttendu } });
        moCas('PUT /api/catalogue/:family/:id', 'main-oeuvre-rattachee', 'défaut, corps prestation ordinaire, retour', mo('main-oeuvre-rattachee'), corpsRetour('TEST-MONTANTS-MO-RAT'), { code: 409, montant: null });
        moCas('PUT /api/catalogue/:family/:id', 'prestation-ordinaire', 'défaut, corps main d’œuvre, passage', mo('prestation-ordinaire'), () => ({ ...d.corpsMainOeuvre('TEST-MONTANTS-ORD', 'TEST Prestation ordinaire de la matrice des montants', MONTANTS.mainOeuvre), unite: 'heure' }), { code: 200, montant: { genre: 'mainOeuvre', fiche: P['prestation-ordinaire'], attendu: MONTANTS.mainOeuvre } });
        moCas('PUT /api/catalogue/:family/:id', 'main-oeuvre-desactivee', 'défaut, corps main d’œuvre, réactivation', mo('main-oeuvre-desactivee'), () => ({ ...d.corpsMainOeuvre('TEST-MONTANTS-MO-DES', 'TEST Main d’œuvre désactivée de la matrice des montants', MONTANTS.mainOeuvre), actif: true }), { code: 200, montant: { genre: 'mainOeuvre', fiche: P['main-oeuvre-desactivee'], attendu: {} } });
      }
      // §5.2, G8 : parc d'un client, modèle à prix d'achat.
      for (const compte of ADMINISTRATION) {
        ajouterGroupe(8, compte, 'POST /api/clients/:clientId/equipements', 'clientId=client-actif', 'défaut, corps modèle à prix d’achat, site du client et numéro de série', `/api/clients/${d.clientActif}/equipements`, () => ({ catalogueEquipementId: P['modele-prix-achat'], clientSiteId: d.siteActif, numeroSerie: 'TEST-SN-MONTANTS-CREE' }), { code: 201, montant: null });
        ajouterGroupe(8, compte, 'POST /api/clients/:clientId/equipements/:id/archiver', 'equipement-prix-achat', 'défaut', `/api/clients/${d.clientActif}/equipements/${P['equipement-prix-achat']}/archiver`, corpsVide, { code: 200, montant: null });
      }

      // §5.4 : planningActif=non posé par SA en préalable ; les 10 écritures du planning, SA écrit, AD refusé en témoin.
      const planning = [
        ['POST /api/planning/events', SANS_CIBLE, '/api/planning/events', 'événement libre', () => ({ categorie: 'EVENEMENT', typeEventId: id('type-planning', 'type-planning'), dateDebut: d.demain, intervenantIds: [d.ficheLibre] })],
        ['PATCH /api/planning/events/:id', 'affectation-evenement', `/api/planning/events/${id('affectation', 'affectation-evenement')}`, 'dates', () => ({ dateDebut: d.demain, dateFin: d.demain })],
        ['DELETE /api/planning/events/:id', 'affectation-evenement', `/api/planning/events/${id('affectation', 'affectation-evenement')}`, 'sans corps', corpsVide],
        ['POST /api/planning/types', SANS_CIBLE, '/api/planning/types', 'libellé et couleur', () => ({ nom: 'TEST Type créé par la matrice des montants', couleur: '#654321' })],
        ['PUT /api/planning/types/:id', 'type-planning', `/api/planning/types/${id('type-planning', 'type-planning')}`, 'libellé', () => ({ nom: 'TEST Type renommé par la matrice des montants' })],
        ['DELETE /api/planning/types/:id', 'type-planning-libre', `/api/planning/types/${P['type-planning-libre']}`, 'sans corps', corpsVide],
        ['POST /api/planning/share', SANS_CIBLE, '/api/planning/share', 'sans corps', corpsVide],
        ['PATCH /api/planning/share', SANS_CIBLE, '/api/planning/share', 'sans corps', corpsVide],
        ['PUT /api/interventions/:id/planning', 'intervention-creee-ct', `/api/interventions/${id('intervention', 'intervention-creee-ct')}/planning`, 'jour, créneau et fiche libre', () => ({ dateDebut: d.demain, creneau: 'JOURNEE', intervenantIds: [d.ficheLibre] })],
        ['POST /api/interventions/:id/remise-a-planifier', 'curative-sans-chantier-branche', `/api/interventions/${id('intervention', 'curative-sans-chantier-branche')}/remise-a-planifier`, 'motif', () => ({ motif: motif('la remise à planifier') })],
      ];
      for (const [route, cible, chemin, corpsNom, corps] of planning) {
        for (const compte of [SA, 'AD']) {
          ajouter(compte, route, cible, `planningActif=non, corps ${corpsNom}`, chemin, corps, { prealables: [{ compte: SA, methode: 'PUT', chemin: '/api/modules', corps: { planningActif: false } }], code: compte === SA ? '2xx' : 403, planning: true });
        }
      }
    }

    // Avenant, section 1 : « les fichiers de D1a-5 l'exigent et échouent avec un message clair si le rôle de
    // TEST_DATABASE_URL ne peut pas poser ce paramètre — jamais de SKIP ».
    test('rôle PostgreSQL : le rôle de TEST_DATABASE_URL peut poser session_replication_role, sans quoi la base ne peut pas être remise en état entre deux cas (échec clair, jamais un SKIP)', () => {
      if (refusRole) throw refusRole;
    });

    // Cadrage §3 (« chaque attendu est écrit en dur, avec la lecture écartée en commentaire, et vérifié par un test
    // témoin ») ; leçon C1 de l'audit des montants de #460 : chaque attendu relu est recalculé, sans littéral non vérifié ;
    // C2 : chaque montant copié ou figé est éprouvé par sa source changée après coup, relue ici.
    testPrepare('témoin des montants : chaque attendu recalculé en décimal exact, chaque lecture écartée distincte, sources copiées ou figées changées après coup et relues en base', () => {
      const t = d.temoin;
      // Montant vendu : ni l'euro, ni le dixième, ni le montant des chantiers relus (1 000).
      const v = MONTANTS.vendu;
      assert.ok(v !== Math.round(v) && v !== Math.round(v * 10) / 10, 'montant vendu : ni l’euro, ni le dixième');
      assert.ok(t.chantiers.length === 9 && t.chantiers.every((m) => m === 1000 && m !== v), 'montant vendu des chantiers joués : 1 000 en base, distinct du montant envoyé');
      // Ligne d'un devis créé ou modifié : HT, TTC de ligne et totaux du devis.
      const l = MONTANTS.ligne;
      const ht = exact.ligneHt(l.quantite, l.prixUnitaireHt);
      const tva = exact.tva(ht, l.tauxTva);
      assert.deepEqual([MONTANTS.ligneHt, MONTANTS.devisTva, MONTANTS.ligneTtc], [exact.euros(ht), exact.euros(tva), exact.euros(exact.ttcLigne(ht, l.tauxTva))], 'ligne et totaux d’un devis créé ou modifié');
      assert.equal(exact.euros(ht + tva), MONTANTS.ligneTtc, 'TTC du devis égal au TTC de sa ligne unique');
      assert.notEqual(Math.round(l.quantite * l.prixUnitaireHt * 100) / 100, MONTANTS.ligneHt, 'lecture écartée : calcul flottant de la ligne');
      assert.notEqual(exact.euros(arrondiAuPair(enUnites(l.quantite, 3) * enUnites(l.prixUnitaireHt, 2) / 100n)), MONTANTS.ligneHt, 'lecture écartée : arrondi au pair de la ligne');
      // Prix d'achat d'une ligne : copié de la fiche du jour (41,17) à la création ; gardé (38,62, copie de devis-prix-achat)
      // quand la ligne est modifiée ; saisi (12,34) par l'administration. La fiche, changée après coup, est relue.
      assert.deepEqual(t.prestation, { prixVenteHt: MONTANTS.ficheVente, prixAchatHt: MONTANTS.ficheAchat }, 'fiche prestation-prix-achat : prix du jour relus en base');
      assert.equal(t.devisPa.lignes[0].prixAchatUnitaireHt, MONTANTS.ficheAchatInitial, 'ligne de devis-prix-achat : prix d’achat copié de la fiche avant son changement');
      const prixAchat = [MONTANTS.ficheAchat, MONTANTS.ficheAchatInitial, MONTANTS.prixAchatLigne, MONTANTS.ficheVente, null];
      assert.equal(new Set(prixAchat.map(String)).size, prixAchat.length, 'lectures écartées du prix d’achat d’une ligne : fiche du jour, copie d’origine, saisie, prix de vente, effacé, tous distincts');
      // devis-signe-prix-achat : lignes relues en base, recalculées en décimal exact ; copies figées distinctes des sources
      // du jour (article et main d'œuvre changés après la signature).
      const s = MONTANTS.devisSigneLignes;
      assert.deepEqual(t.devisSigne.lignes.map(({ nature: _n, ...reste }) => reste), s, 'lignes de devis-signe-prix-achat relues en base');
      const htL = s.map((x) => exact.ligneHt(x.quantite, x.prixUnitaireHt));
      assert.deepEqual(s.map((x) => [x.totalHt, x.totalTtc]), htL.map((h) => [exact.euros(h), exact.euros(exact.ttcLigne(h, 20))]), 'lignes de devis-signe-prix-achat : HT et TTC recalculés');
      assert.equal(s[3].prixUnitaireHt, MONTANTS.mainOeuvreDuDevisInitial.prixJourHorsContratHt, 'ligne au jour : prix de la main d’œuvre copié à son ajout');
      assert.equal(s[3].minutesPrevuesUnite, MONTANTS.mainOeuvreDuDevisInitial.heuresParJour * 60, 'ligne au jour : heures par jour copiées en minutes');
      assert.deepEqual(t.article, { prixVenteHt: MONTANTS.articleVente, prixAchatHt: MONTANTS.articleAchat }, 'article-prix-achat changé après la signature');
      assert.deepEqual(t.mainOeuvreDuDevis, { prixJourHorsContratHt: MONTANTS.mainOeuvreDuDevis.prixJourHorsContratHt, heuresParJour: MONTANTS.mainOeuvreDuDevis.heuresParJour }, 'main-oeuvre-du-devis changée après la signature');
      assert.notEqual(s[0].prixAchatUnitaireHt, t.article.prixAchatHt, 'copie figée : prix d’achat de la ligne distinct de celui de l’article du jour');
      assert.notEqual(s[3].prixUnitaireHt, t.mainOeuvreDuDevis.prixJourHorsContratHt, 'copie figée : prix de la ligne au jour distinct de celui de la main d’œuvre du jour');
      assert.notEqual(s[3].minutesPrevuesUnite, t.mainOeuvreDuDevis.heuresParJour * 60, 'copie figée : minutes de la ligne au jour distinctes des heures par jour du jour');
      // Conversion : chaque montant du chantier recalculé depuis les lignes relues (devis/routes.ts:401-411).
      const lignes = t.devisSigne.lignes;
      const total = lignes.reduce((a, x) => a + enUnites(x.totalHt, 2), 0n);
      const materiel = lignes.filter((x) => x.nature === 'FOURNITURE').reduce((a, x) => a + enUnites(x.totalHt, 2), 0n);
      const minutes = lignes.filter((x) => x.nature === 'MAIN_OEUVRE').reduce((a, x) => a + enUnites(x.quantite, 3) * enUnites(x.minutesPrevuesUnite ?? 60, 2), 0n);
      const heures = auCentime(minutes, 60n * 1000n);
      const cout = lignes.filter((x) => x.prixAchatUnitaireHt !== null).reduce((a, x) => a + exact.ligneHt(x.quantite, x.prixAchatUnitaireHt), 0n);
      assert.deepEqual(MONTANTS.conversion, { budgetGlobalVendu: exact.euros(total), budgetMaterielVendu: exact.euros(materiel), budgetMainOeuvreVendu: exact.euros(total - materiel), heuresVendues: exact.euros(heures), coutMaterielPrevu: exact.euros(cout) }, 'chantier ouvert par la conversion');
      assert.equal(exact.euros(total), t.devisSigne.totalHt, 'montant vendu attendu égal au total HT du devis relu');
      const c = MONTANTS.conversion;
      const coutGlobal = auCentime(lignes.filter((x) => x.prixAchatUnitaireHt !== null).reduce((a, x) => a + enUnites(x.quantite, 3) * enUnites(x.prixAchatUnitaireHt, 2), 0n), 1000n);
      for (const [ecartee, champ, quoi] of [
        [exact.euros(coutGlobal), 'coutMaterielPrevu', 'arrondi du total, et non de chaque ligne'],
        [exact.euros(exact.ligneHt(s[0].quantite, s[0].prixAchatUnitaireHt)), 'coutMaterielPrevu', 'fournitures seules'],
        [exact.euros(exact.ligneHt(s[0].quantite, t.article.prixAchatHt) + exact.ligneHt(s[1].quantite, s[1].prixAchatUnitaireHt)), 'coutMaterielPrevu', 'prix d’achat de l’article du jour'],
        [exact.euros(cout + enUnites(s[2].totalHt, 2)), 'coutMaterielPrevu', 'ligne sans prix d’achat comptée à son prix de vente'],
        [exact.euros(total - enUnites(s[3].totalHt, 2) + exact.ligneHt(s[3].quantite, t.mainOeuvreDuDevis.prixJourHorsContratHt)), 'budgetGlobalVendu', 'prix du jour de la main d’œuvre'],
        [exact.euros(auCentime(enUnites(s[1].quantite, 3) * 6000n + enUnites(s[3].quantite, 3) * enUnites(t.mainOeuvreDuDevis.heuresParJour * 60, 2), 60000n)), 'heuresVendues', 'heures par jour du jour'],
      ]) assert.notEqual(ecartee, c[champ], `conversion, lecture écartée : ${quoi}`);
      // Acompte : ni l'euro, ni le taux d'acompte appliqué au TTC du devis relu.
      assert.ok(MONTANTS.acompte !== Math.round(MONTANTS.acompte), 'acompte : pas un nombre d’euros entier');
      assert.equal(t.devisAcompte.acompteMontant, null, 'devis-acompte-prix-achat : acompte non encore constaté');
      assert.notEqual(exact.euros(auCentime(enUnites(t.devisAcompte.totalTtc, 2) * enUnites(t.devisAcompte.tauxAcompte, 2), 10000n)), MONTANTS.acompte, 'acompte, lecture écartée : taux d’acompte appliqué au TTC');
      // Acompte reçu (devis-acompte-recu) : relu en base, ni un nombre d'euros entier, ni le taux d'acompte appliqué au TTC ;
      // non nul, donc distinct de l'acompte absent d'un duplicata (lecture écartée : la duplication qui le reprend).
      const r = t.devisAcompteRecu;
      assert.deepEqual([r.totalHt, r.totalTva, r.totalTtc], [exact.euros(exact.ligneHt(3, 17.29)), exact.euros(exact.tva(exact.ligneHt(3, 17.29), 20)), exact.euros(exact.ligneHt(3, 17.29) + exact.tva(exact.ligneHt(3, 17.29), 20))], 'devis-acompte-recu : totaux relus en base, recalculés');
      assert.equal(r.acompteMontant, MONTANTS.acompteRecu, 'devis-acompte-recu : acompte reçu relu en base');
      assert.ok(MONTANTS.acompteRecu !== Math.round(MONTANTS.acompteRecu) && MONTANTS.acompteRecu !== MONTANTS.acompte, 'acompte reçu : ni un nombre d’euros entier, ni l’acompte du jeu');
      assert.notEqual(exact.euros(auCentime(enUnites(r.totalTtc, 2) * enUnites(r.tauxAcompte, 2), 10000n)), MONTANTS.acompteRecu, 'acompte reçu, lecture écartée : taux d’acompte appliqué au TTC');
      assert.equal(r.tauxAcompte, d.tauxAcompteInitial, 'devis-acompte-recu : taux d’acompte copié du réglage à sa création');
      // Taux d'acompte : copié à la création (taux d'avant), relu du jour par une duplication ; distincts.
      assert.equal(t.devisAcompte.tauxAcompte, d.tauxAcompteInitial, 'devis-acompte-prix-achat : taux d’acompte copié du réglage à sa création');
      assert.equal(t.tauxAcompteDuJour, MONTANTS.tauxAcompteDuJour, 'taux d’acompte par défaut du jour relu en base');
      assert.notEqual(t.devisAcompte.tauxAcompte, MONTANTS.tauxAcompteDuJour, 'lecture écartée : taux d’acompte du jour pour une révision, ou copié pour une duplication');
      // Fiches : prix écrits distincts entre eux et des prix existants.
      assert.equal(t.modele.prixAchatHt, MONTANTS.modeleAchat, 'modèle à prix d’achat relu en base');
      const prixFiches = [MONTANTS.articleCree.prixVenteHt, MONTANTS.articleCree.prixAchatHt, MONTANTS.ficheAchatModifie, MONTANTS.ficheAchat, MONTANTS.ficheAchatInitial, MONTANTS.ficheVente];
      assert.equal(new Set(prixFiches).size, prixFiches.length, 'prix des fiches écrits distincts des prix existants');
      // Mains d'œuvre : prix distincts ; ni le jour ramené à l'heure, ni la demi-journée comptée pour la moitié du jour,
      // ni les heures arrondies.
      const m = MONTANTS.mainOeuvre;
      assert.deepEqual(t.mainOeuvre, m, 'main-oeuvre-catalogue : prix et heures relus en base');
      assert.equal(new Set(Object.values(m)).size, Object.values(m).length, 'prix et heures d’une main d’œuvre distincts');
      assert.notEqual(Math.round((m.prixJourHorsContratHt / m.heuresParJour) * 100) / 100, m.prixVenteHt, 'lecture écartée : prix du jour ramené à l’heure');
      assert.notEqual(Math.round(m.prixJourHorsContratHt * 50) / 100, m.prixDemiJourneeHorsContratHt, 'lecture écartée : demi-journée hors contrat pour la moitié du jour');
      assert.notEqual(Math.round(m.prixJourSousContratHt * 50) / 100, m.prixDemiJourneeSousContratHt, 'lecture écartée : demi-journée sous contrat pour la moitié du jour');
      assert.notEqual(Math.round(m.heuresParJour), m.heuresParJour, 'lecture écartée : heures par jour arrondies');
      assert.ok(MONTANTS.mainOeuvreModifiee !== m.prixVenteHt && MONTANTS.mainOeuvreModifiee !== Math.round(m.prixVenteHt * 10) / 10, 'prix horaire modifié distinct de l’ancien et de son dixième');
      // Retour en prestation ordinaire (catalogue/main-oeuvre.ts:224-227) : prix de vente envoyé, prix propres et heures
      // vidés. Lecture écartée : prix propres gardés, tous non nuls avant le retour.
      assert.ok(PRIX_MAIN_OEUVRE.slice(1).every((c) => t.mainOeuvre[c] !== null) && MONTANTS.prestationRetour !== m.prixVenteHt, 'retour en prestation : prix propres non nuls avant, prix de vente changé');
    });

    // Outils (cadrage §5.2 et §5.4) : #457 T1 et N4 ; annotations de la liste fermée des montants masqués.
    testPrepare('outils : l’outil de l’export reconnaît l’export du super administrateur et chaque ligne de l’export de référence de l’administrateur (#457 T1 et N4), annotations des 8 groupes en liste fermée', async () => {
      assert.ok(d.entreesJournalAdministration > 0, 'journal d’administration : des entrées à reconnaître dans l’export de référence');
      for (const lecteur of ['SA', 'AD']) assert.equal(await lignesNonReconnues(lecture, exportsReference[lecteur]), 0, `export de référence de ${lecteur} : chaque ligne reconnue comme une entrée de la base`);
      // Témoins de lignesNonReconnues : une ligne ajoutée sous un libellé changé n'est pas reconnue ; une ligne retirée
      // n'en crée pas.
      const lignesSa = exportsReference.SA.split('\n');
      const changee = lignesSa[1].replace(/;"[^"]*";"[^"]*"$/, ';"x";"y"');
      assert.equal(await lignesNonReconnues(lecture, `${exportsReference.SA}${changee}\n`), 1, 'témoin : une ligne sous un libellé changé n’est pas reconnue');
      assert.equal(await lignesNonReconnues(lecture, `${[lignesSa[0], ...lignesSa.slice(2)].join('\n')}`), 0, 'témoin : une ligne retirée ne crée pas de ligne non reconnue');
      // verifierLectureExport : un export dont deux colonnes sont interverties n'est pas reconnu (mutant MX de #457).
      const { rows: [entree] } = await lecture.query('SELECT to_jsonb(j) AS ligne FROM public."JournalAdministration" j LIMIT 1');
      const fin = finDeLigneCsv(entree.ligne);
      assert.ok(compterFinDeLigne(exportsReference.SA, fin) > 0, 'une entrée de la base se lit dans l’export du SA');
      await assert.rejects(verifierLectureExport(lecture, exportsReference.SA.split(fin).join('autre')), /ne peut pas conclure/, 'témoin : un export non reconnu fait échouer l’outil');
      // Garde « aucun montant » (cadrage §3), sur les formes de ligne propres à ce fichier : réponse observée, constat de
      // relecture, verdict de l'export (#457 N4), lecture de N1 ; un montant, sous toute forme, reste refusé ; le nom de
      // CT-N1 n'est pas un montant, mais un montant sans « € » dans une ligne qui le nomme reste refusé (T1 de l'audit des
      // droits de #460).
      const garde = (ligne) => lignesAvecMontant([ligne], { comptes: COMPTES_JOUES, journaux: true, comptesAChiffre: true }).length === 1;
      const ecriture = 'SA | PATCH /api/chantiers/:id | chantier-ct | défaut, corps montant vendu | 200 écrit (Chantier) ; aucune entrée ; réponse : budgetGlobalVendu présent, coutMaterielPrevu null ; montant vendu écrit relu en base';
      const lectureExport = 'AD | GET /api/journal-administration/export.csv | JournalAdministration MAIN_OEUVRE CREATION par SA ← SA POST /api/catalogue/:family sur family=prestations | défaut, corps main d’œuvre | 200 ; visible, lignes de l’export non reconnues';
      const lectureN1 = 'COM | GET /api/achats | — | défaut | 200 ; montantHT présent';
      const ecritureCtN1 = 'CT-N1 | PATCH /api/chantiers/:id | chantier-ct | défaut, corps montant vendu | 200 écrit (Chantier) ; aucune entrée ; réponse : budgetGlobalVendu présent ; montant vendu écrit relu en base';
      for (const ligne of [ecriture, lectureExport, lectureN1, ecritureCtN1]) assert.equal(garde(ligne), false, `garde, forme admise : ${ligne}`);
      for (const [ligne, quoi] of [
        [ecriture.replace('budgetGlobalVendu présent', 'budgetGlobalVendu 12345.67'), 'montant en chiffres dans la réponse observée'],
        [ecriture.replace('montant vendu écrit relu en base', 'montant vendu écrit 12 345,67 €'), 'montant en euros dans le constat'],
        [lectureExport.replace('lignes de l’export non reconnues', 'lignes de l’export non reconnues : 3'), 'nombre dans le verdict de l’export'],
        [lectureN1.replace('montantHT présent', 'montantHT 100'), 'montant dans une lecture de N1'],
        [ecritureCtN1.replace('montant vendu écrit relu en base', 'montant vendu 12345,67'), 'montant sans « € » dans une ligne qui nomme CT-N1'],
        [ecritureCtN1.replace('chantier-ct |', 'chantier-ct 12,50 |'), 'montant dans la cible d’une ligne de CT-N1'],
      ]) assert.equal(garde(ligne), true, `garde, ${quoi} : refusé`);
      // Annotations : liste fermée du cadrage §5.2, chacune avec sa raison.
      const annotations = MONTANTS_MASQUES_ECRITURES.flatMap((g, i) => g.annotations.map((a) => `G${i + 1} ${a.champs.join('+')} ${a.cote}${a.nonPorte ? ', non porté' : ''}${a.jusqua ? ` jusqu’à ${a.jusqua}` : ''}`));
      assert.deepEqual(annotations, [
        'G1 budgetMaterielVendu+budgetMainOeuvreVendu ne voit pas', 'G4 intervenant.tauxHoraireCharge voit, non porté',
        'G5 tauxHoraireApplique+prixVenteHoraireApplique voit', 'G6 montantHT ne voit pas',
        'G7 prixAchatHt ne voit pas jusqu’à D1a-5d-3', 'G8 catalogueEquipement.prixAchatHt ne voit pas jusqu’à D1a-5d-3',
      ], 'annotations des 8 groupes : liste fermée du cadrage §5.2');
      for (const [i, g] of MONTANTS_MASQUES_ECRITURES.entries()) {
        for (const a of g.annotations) {
          assert.ok(a.raison && a.champs.every((champ) => g.champs.includes(champ)) && ['voit', 'ne voit pas'].includes(a.cote), `G${i + 1} : annotation sans raison ou hors des champs du groupe`);
        }
      }
    });

    // Cadrage §5.2 (R-A) : chaque couple (route, compte) des réponses 2xx de 5a et 5b sur les routes des 8 groupes, et
    // chaque triplet (compte, route, droit) des contextes « droit … », a un cas ici.
    testPrepare('couverture des cas : chaque couple (route, compte) et chaque triplet (compte, route, droit) des réponses 2xx de 5a et 5b sur les routes des 8 groupes joué ici (réduction R-A déclarée)', (t) => {
      // Routes réelles des 8 groupes : les jumelles /api/v1 relèvent de 5d-3 ; la correction d'une heure SAV est la route
      // PATCH /api/interventions/:id/couts/:type/:coutId, type « heures » (cible heures-…), son matériel n'étant pas du G5.
      const ALIAS = { 'PATCH /api/interventions/:id/couts/heures/:coutId': 'PATCH /api/interventions/:id/couts/:type/:coutId' };
      const groupeDe = new Map();
      MONTANTS_MASQUES_ECRITURES.forEach((g, i) => { for (const r of g.routes) if (!r.startsWith('et ') && !r.includes('/api/v1/')) groupeDe.set(ALIAS[r] ?? r, i + 1); });
      const couples = new Map(); const triplets = new Set();
      for (const fichier of ['ecritures-actions.txt', 'ecritures-modifications.txt']) {
        const texte = lireReference(join(DOSSIER_MATRICES, fichier));
        assert.ok(texte, `${fichier} absent`);
        for (const ligne of texte.split('\n').filter(Boolean)) {
          const [compte, route, cible, contexte, reponse] = ligne.split(SEPARATEUR);
          if (!groupeDe.has(route) || !/^2\d\d /.test(reponse)) continue;
          if (route === 'PATCH /api/interventions/:id/couts/:type/:coutId' && !cible.startsWith('heures-')) continue;
          if (contexte.startsWith('droit ')) triplets.add([compte, route, contexte.split(',')[0]].join(SEPARATEUR));
          else couples.set([route, compte].join(SEPARATEUR), groupeDe.get(route));
        }
      }
      const manquants = [];
      for (const cle of couples.keys()) {
        const [route, compte] = cle.split(SEPARATEUR);
        if (!cas.some((c) => c.route === route && c.compte === compte && !c.contexte.startsWith('droit ') && (c.code === null || (typeof c.code === 'number' && c.code < 300)))) manquants.push(cle);
      }
      for (const cle of triplets) {
        const [compte, route, droit] = cle.split(SEPARATEUR);
        if (!cas.some((c) => c.route === route && c.compte === compte && c.contexte.startsWith(`${droit},`) && c.code !== null && c.code < 300)) manquants.push(cle);
      }
      assert.deepEqual(manquants, [], 'couples et triplets des 8 groupes sans cas');
      assert.equal(triplets.size, 31, 'triplets « droit … » de 5b sur les routes des 8 groupes');
      const parGroupe = [...couples.values()].reduce((a, g) => ({ ...a, [g]: (a[g] ?? 0) + 1 }), {});
      diagnostics.push(`couples (route, compte) des 8 groupes : ${couples.size} (${Object.entries(parGroupe).map(([g, n]) => `G${g} ${n}`).join(', ')}) ; triplets « droit … » : ${triplets.size}`);
      diagnostics.push(`cas : ${cas.length} (groupes ${cas.filter((c) => c.groupe).length}, planning ${cas.filter((c) => c.planning).length}, relecture propre d’un montant ${cas.filter((c) => c.montant).length}, refus du montant vendu compris)`);
      t.diagnostic(diagnostics.slice(-2).join(' ; '));
    });

    // Cadrage §5.1 à §5.4 : chaque cas, ses entrées et leurs lectures, sa réponse observée, ses montants, la base remise.
    testPrepare('écritures : montant vendu, réponses des 8 groupes, prix d’achat, mains d’œuvre, planning désactivé ; entrées lues, montants relus, base remise en état après chaque cas', async () => {
      for (const c of cas) await jouer(c);
    });

    // Cadrage §5.4 (N1 du contrôle de #435, classée C) : achats et pointages posés par l'administration sur les chantiers
    // de COM, AC, DC et CPT, lus par COM, AC, DC, CPT et CPT-FINANCE ; présence ou absence des montants, enregistrée.
    testPrepare('N1 de #435 : achats et heures des chantiers de COM, AC, DC et CPT lus par COM, AC, DC, CPT et CPT-FINANCE, montantHT et tauxHoraireApplique présents ou absents', async () => {
      const LECTEURS = { COM: ['chantier-com', 'chantier-com-titulaire'], AC: ['chantier-ac'], DC: ['chantier-dc'], CPT: ['chantier-cpt'], 'CPT-FINANCE': ['chantier-cpt'] };
      const etats = (liste, chemin) => [...new Set(liste.map((x) => etatMontant(x, chemin)))].sort().join('/') || 'aucun objet';
      const elements = (corps) => (Array.isArray(corps) ? corps : corps?.items ?? []);
      const lire = async (compte, chantiers) => {
        const lues = [];
        const achats = await appeler(appli.adresse, 'GET', '/api/achats', { jeton: jetons[compte] });
        const heures = await appeler(appli.adresse, 'GET', '/api/heures', { jeton: jetons[compte] });
        lues.push(ligneMatrice({ compte, methode: 'GET', chemin: '/api/achats', cible: SANS_CIBLE, contexte: 'défaut', reponse: achats.status === 200 ? `200 ; montantHT ${etats(elements(achats.body), 'montantHT')}` : formaterReponse(achats) }));
        lues.push(ligneMatrice({ compte, methode: 'GET', chemin: '/api/heures', cible: SANS_CIBLE, contexte: 'défaut', reponse: heures.status === 200 ? `200 ; tauxHoraireApplique ${etats(elements(heures.body), 'tauxHoraireApplique')}, intervenant.tauxHoraireCharge ${etats(elements(heures.body), 'intervenant.tauxHoraireCharge')}` : formaterReponse(heures) }));
        for (const nom of chantiers) {
          const fiche = await appeler(appli.adresse, 'GET', `/api/chantiers/${id('chantier', nom)}`, { jeton: jetons[compte] });
          const journal = await appeler(appli.adresse, 'GET', `/api/chantiers/${id('chantier', nom)}/journal-saisies`, { jeton: jetons[compte] });
          lues.push(ligneMatrice({ compte, methode: 'GET', chemin: '/api/chantiers/:id', cible: nom, contexte: 'défaut', reponse: fiche.status === 200 ? `200 ; achats[].montantHT ${etatMontant(fiche.body, 'achats[].montantHT')}, pointages[].tauxHoraireApplique ${etatMontant(fiche.body, 'pointages[].tauxHoraireApplique')}` : formaterReponse(fiche) }));
          const entrees = Array.isArray(journal.body) ? journal.body : [];
          lues.push(ligneMatrice({ compte, methode: 'GET', chemin: '/api/chantiers/:id/journal-saisies', cible: nom, contexte: 'défaut', reponse: journal.status === 200 ? `200 ; ACHAT apres.montantHT ${etats(entrees.filter((e) => e.cible === 'ACHAT'), 'apres.montantHT')}, HEURE apres.tauxHoraireApplique ${etats(entrees.filter((e) => e.cible === 'HEURE'), 'apres.tauxHoraireApplique')}` : formaterReponse(journal) }));
        }
        return lues;
      };
      for (const [compte, chantiers] of Object.entries(LECTEURS)) lignes.push(...await lire(compte, chantiers));
      assert.deepEqual(remise.changees(await remise.empreinte()), [], 'les lectures de N1 n’écrivent rien');
      // CPT-FINANCE n'est titulaire d'aucun chantier : ses lectures n'observent ni achat ni heure (« aucun objet »), et ne
      // prouvent donc pas que l'accès financier n'ouvre ni montant ni taux (cadrage §5.4). Comme D1a-3 (« accès financier
      // sans effet en session »), le comptable CPT, titulaire de chantier-cpt, reçoit l'accès financier le temps de
      // rejouer ses lectures de N1 (super administrateur, PATCH /api/users/:id/acces-finance) ; la base est remise en état
      // ensuite, même en cas d'échec. Ses lectures doivent être identiques ; elles n'entrent pas dans la référence.
      const attendues = await lire('CPT', LECTEURS.CPT);
      assert.ok(attendues.some((l) => l.endsWith('200 ; montantHT présent')) && attendues.some((l) => l.includes('tauxHoraireApplique absent')), 'N1, CPT : un montant présent et un taux absent à comparer');
      let obtenues = [];
      await api(SA, 'PATCH', `/api/users/${comptes.CPT.id}/acces-finance`, { accesFinance: true });
      try {
        obtenues = await lire('CPT', LECTEURS.CPT);
      } finally {
        const aRemettre = remise.changees(await remise.empreinte());
        if (aRemettre.length) await remise.remettre(aRemettre, 'accès financier de CPT, N1 de #435');
      }
      assert.deepEqual(obtenues, attendues, 'N1 de #435 : le comptable titulaire qui reçoit l’accès financier lit les mêmes achats et heures, montants et taux compris');
    });

    // Cadrage §5.1, §5.3 et §5.4 : la réponse de chaque cas dont le code est écrit (attendus du cadrage et du code), et
    // chaque refus « inchangé ».
    testPrepare('réponses attendues : montant vendu écrit par l’administration et le titulaire qui suit la rentabilité, refusé ailleurs ; prix d’achat prévu refusé hors administration ; mains d’œuvre ; planning désactivé, SA écrit et AD refusé', () => {
      const ecarts = [];
      for (const c of cas.filter((x) => x.code !== null)) {
        const r = c.reponse ?? '';
        const ok = c.code === '2xx' ? /^2\d\d /.test(r) : r.startsWith(`${c.code} `);
        if (!ok) ecarts.push(`${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : attendu ${c.code}, obtenu « ${r} »`);
        else if (typeof c.code === 'number' && c.code >= 300 && !/ inchangé ; aucune entrée( ; |$)/.test(r)) ecarts.push(`${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : refus qui écrit`);
        else if (c.planning && c.compte === 'AD' && !r.startsWith('403 PLANNING_DESACTIVE ')) ecarts.push(`${c.compte} ${c.route} : refus PLANNING_DESACTIVE attendu`);
      }
      assert.deepEqual(ecarts, [], 'réponses différentes de l’attendu');
      assert.equal(chiffres.prealablesRefuses, 0, 'aucun préalable refusé');
    });

    // Cadrage §3 : chaque écriture de montant admise relue conforme ; chaque refus et chaque écriture sans montant laissent
    // les montants inchangés.
    testPrepare('montants relus en base : écritures admises conformes à l’attendu ou à leur source, refus et écritures sans montant sans changement de montant', () => {
      const ecarts = [];
      for (const c of cas.filter((x) => x.montant !== undefined)) {
        const r = c.reponse ?? '';
        const attendu = c.montant && /^2\d\d /.test(r) ? CONSTATS_CONFORMES[c.montant.genre] : MONTANTS_INCHANGES;
        if (!r.endsWith(` ; ${attendu}`)) ecarts.push(`${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : constat des montants « ${r} »`);
      }
      assert.deepEqual(ecarts, [], 'montants différents de l’attendu');
      // Écritures admises relues à leur attendu ; les autres constats (refus, dont ceux du montant vendu, et écritures sans
      // montant) relisent les montants inchangés.
      const relues = cas.filter((c) => c.montant && /^2\d\d /.test(c.reponse ?? '')).length;
      diagnostics.push(`montants relus : ${chiffres.montants} constats, dont ${relues} écritures de montant admises relues à leur attendu et ${chiffres.montants - relues} montants relus inchangés`);
    });

    // Cadrage §5.2 et §3 (classement C) : pour chaque couple (groupe, champ) de MONTANTS_MASQUES_ECRITURES, un compte qui le
    // voit l'a « présent » et un compte qui ne le voit pas l'a « null » ou « absent », sauf côté annoté ; aucun compte qui
    // ne le voit pas ne l'a « présent » ; un champ non porté ne l'est pour aucun compte.
    testPrepare('montants masqués des réponses d’écriture : chaque champ des 8 groupes vu présent par un compte qui le voit, masqué pour un compte qui ne le voit pas, jamais présent pour un compte qui ne le voit pas (annotations en liste fermée)', () => {
      const ecarts = [];
      const MASQUE = ['null', 'absent', 'non porté'];
      for (const [i, g] of MONTANTS_MASQUES_ECRITURES.entries()) {
        const groupe = i + 1;
        const observes = cas.filter((c) => c.groupe === groupe && c.observation);
        for (const champ of g.champs) {
          const annote = (cote) => g.annotations.some((a) => a.cote === cote && a.champs.includes(champ));
          const obs = observes.map((c) => ({ c, voit: c.voit(champ), etat: c.observation[champ] }));
          if (!annote('voit') && !obs.some((o) => o.voit && o.etat === 'présent')) ecarts.push(`G${groupe} ${champ} : aucun compte qui le voit ne l’a présent`);
          if (!annote('ne voit pas') && !obs.some((o) => !o.voit && MASQUE.includes(o.etat))) ecarts.push(`G${groupe} ${champ} : aucun compte qui ne le voit pas ne l’a masqué`);
          for (const o of obs.filter((x) => !x.voit && !MASQUE.includes(x.etat))) ecarts.push(`G${groupe} ${champ} : ${o.etat} pour ${o.c.compte} (${o.c.route}, ${o.c.cible}, ${o.c.contexte}), qui ne le voit pas`);
          if (annote('voit') && annote('ne voit pas')) ecarts.push(`G${groupe} ${champ} : annoté des deux côtés`);
          if (g.annotations.some((a) => a.nonPorte && a.champs.includes(champ))) for (const o of obs.filter((x) => !['absent', 'non porté'].includes(x.etat))) ecarts.push(`G${groupe} ${champ} : non porté selon l’annotation, mais ${o.etat} pour ${o.c.compte} (${o.c.route})`);
        }
        if (!observes.length) ecarts.push(`G${groupe} : aucune réponse observée`);
      }
      assert.deepEqual(ecarts, [], 'champs des 8 groupes non observés, ou montant vu par un compte qui ne le voit pas');
    });

    // Cadrage §3 : la matrice obtenue est la référence, au caractère près ; aucune ligne ne porte de montant.
    testPrepare('la matrice obtenue est la référence matrice-droits/montants.txt, chaque cas et chaque lecture y ont une ligne, aucune ligne ne porte de montant, et la base est revenue à l’état de référence', async (t) => {
      const cles = lignes.map((l) => l.split(SEPARATEUR).slice(0, 4).join(SEPARATEUR));
      const doublons = cles.filter((c, i) => cles.indexOf(c) !== i);
      assert.deepEqual(doublons, [], 'chaque cas et chaque lecture n’ont qu’une ligne');
      assert.deepEqual(lignesAvecMontant(lignes, { comptes: COMPTES_JOUES, journaux: true, comptesAChiffre: true }), [], 'lignes qui portent un montant, ou un nombre hors du code de la réponse et des comptes d’objets d’un refus');
      const etatFinal = remise.changees(await remise.empreinte());
      const ecritures = lignes.filter((l) => !l.split(SEPARATEUR)[2].includes(' ← '));
      for (const texte of diagnostics) t.diagnostic(texte);
      t.diagnostic(`lignes : ${lignes.length} (écritures et lectures N1 ${ecritures.length}, lectures d’entrées ${lignes.length - ecritures.length}) ; cas ${chiffres.cas} ; lectures ${chiffres.lectures} ; remises ${remise.remises}`);
      t.diagnostic(`hors droits (pour #426) : ${horsDroits.length ? horsDroits.join(' ; ') : 'aucune réponse'}`);
      comparerAvecReference(lignes, REFERENCE, 'montants.txt', { champsResume: 2 });
      assert.deepEqual(etatFinal, [], 'la base n’est pas revenue à l’état de référence après le dernier cas');
    });
  });
}
