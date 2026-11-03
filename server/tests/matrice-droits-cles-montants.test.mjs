// Lot D1a-5d-3 : écritures des clés d'intégration (/api/v1) et leurs montants. Les 18 écritures /api/v1 jouées sur des
// cibles réelles avec un corps valide ; les limites de D1a-2 et les refus selon le corps ; le prix d'achat d'une fiche et
// le prix d'achat prévu d'une ligne de devis par clé ; les groupes 2, 3, 7 et 8 de MONTANTS_MASQUES_ECRITURES côté clé,
// avec et sans finances:read ; aucune entrée de journal pour une écriture par clé ; écriture sur un client désactivé.
// Tests seuls (cadrage du lot D1a-5d, version 3 du 02-11-2026, contrôlé par le controleur-coherence et publié sur #427,
// sections 2 (ligne 5d-3), 3, 6, 7, 8, 9 et 10 ; avenant au cadrage du lot D1a pour D1a-5, version 2, sections 1, 3 et 5 ;
// cadrage du lot D1a, version 3 du 01-11-2026).
//
// Tests seuls : ce fichier enregistre le comportement actuel, sans rien corriger. Il reprend les outils, les comptes, le
// jeu de données et la table des routes /api/v1 de D1a-1 et D1a-2, l'outil de remise en état de D1a-5a, les outils de
// lecture des journaux de D1a-5c (entreesNouvelles ignore désormais la dernière utilisation d'une clé), le module de
// relecture des montants de D1a-5d-1 (etatMontant, memeValeur) et la liste fermée des montants masqués de D1a-3 (dont
// D1a-5d-3 retire les annotations G7 et G8 de D1a-5d-2). Il enregistre :
//  - §6, routes (a) : chacune des 14 routes jouée par la clé de son scope, sur chaque cible de sa famille (cibles réelles
//    et `inexistant`) et sur des cibles propres, avec un corps valide, et par la même clé avec finances:read quand la
//    réponse porte un montant (devis, conversion, catalogue, parc) ; les clés refusées à la porte n'y sont pas rejouées
//    (avenant, section 3 : écart déclaré dans le corps de la PR) ;
//  - §6, actions (b) : les 4 actions jouées par chacune des 13 clés à un scope sur chaque cible réelle de leur famille et
//    sur des cibles propres, la clé du scope un à un (et avec finances:read quand la réponse porte un montant), les 12
//    autres en lots d'une empreinte, un lot qui écrit étant rejoué un à un ;
//  - §6, limites de D1a-2 (conversion en intervention ou en contrat, main d'œuvre existante modifiée ou désactivée) et
//    refus selon le corps (champs d'ouverture du chantier, corps de main d'œuvre, prix d'achat prévu) ;
//  - §6, prix d'achat par clé : écrit en création (écart de documentation connu, question ouverte « Catalogue dans les
//    devis ») ; effacé par un PUT qui l'omet, y compris par une clé sans finances:read qui ne le lit pas (état actuel,
//    question ouverte, cadrage §10 : jamais une règle) ;
//  - §6, groupes 2, 3, 7 et 8 côté clé : état de chaque champ de la réponse (présent, null, absent ou non porté, jamais sa
//    valeur), « présent » pour une clé avec finances:read, masqué sans ; le test de couverture de D1a-5d-2 relit cette
//    référence pour le côté « ne voit pas » de G7 et G8, dont les annotations sont retirées ;
//  - §3 : chaque montant écrit par une clé relu en base, comparé sans tolérance à un attendu écrit en dur (lecture écartée
//    en commentaire, test témoin qui le recalcule en décimal exact), ou à sa source relue dans l'instantané (révision) ;
//    pour chaque refus et chaque écriture sans montant, les montants des chantiers, des devis et de leurs lignes et du
//    catalogue relus inchangés ; chaque source copiée ou figée (fiche, article, main d'œuvre, taux d'acompte, acompte
//    constaté, pas et minimum du temps passé) changée ou posée avant l'instantané, pour qu'une lecture inverse de la
//    copie se distingue ;
//  - §6, journal : « aucune entrée » pour chaque écriture par clé, enregistré tel quel (conversion en chantier « à
//    appliquer », passation section 4 ; devis : question « Journal du cycle de vie d'un devis ») ; une entrée qu'écrirait
//    une clé serait lue par SA, AD et le compte refusé de sa route (outils de D1a-5c) ;
//  - dernière utilisation d'une clé : notée pour la seule clé admise par la porte, jamais pour un refus de la porte ;
//    contrôlée à part, hors de la ligne (« écrit (…) » ne nomme pas ApiAccessKey quand seule elle change).
// Une ligne : clé (« CLE <scope> » ou « CLE <scope>+finances:read »), route, cible, contexte (« défaut, corps <nom> »),
// réponse (code, et message exact d'un refus), « écrit (tables) » ou « inchangé », « aucune entrée » ou « entrées : … »,
// « réponse : <champ> <état> » pour une route des groupes, puis le constat des montants. Jamais un montant (garde
// lignesAvecMontant d'outils.mjs, options `journaux`, `comptesAChiffre` et `routesCles`). Le tout est comparé au caractère
// près à server/tests/matrice-droits/cles-montants.txt.
//
// Rôle PostgreSQL : comme D1a-5a à D1a-5d-2, la remise pose session_replication_role ; si le rôle de TEST_DATABASE_URL
// ne le peut pas, le test « rôle PostgreSQL » échoue avec un message clair, chacun des autres le cite, et aucune base
// n'est créée. Sans TEST_DATABASE_URL, le fichier s'annonce ignoré comme les autres fichiers de la matrice : un SKIP
// n'est pas une réussite. Ce fichier crée sa propre base jetable (iris_test_matrice_clesmontants_<hex>), la migre, la sert
// à l'application, puis la supprime.
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { join } from 'node:path';
import {
  DOSSIER_MATRICES, EMAIL_SECOURS, JETON_SECOURS, SANS_CIBLE, SEPARATEUR, appeler, baseJetable, chargerApplication,
  comparerAvecReference, enParallele, formaterReponse, ligneMatrice, lignesAvecMontant, tablesChangees, tablesDeLaBase,
} from './matrice-droits/outils.mjs';
import { COMPTES_JOUES, creerComptes } from './matrice-droits/comptes.mjs';
import { FAMILLES, INEXISTANT, cibleDe, construireJeuDeDonnees, jourSociete } from './matrice-droits/donnees.mjs';
import { ROUTES_CLES } from './matrice-droits/routes.mjs';
import { SCHEMA_INSTANTANE, creerRemiseEnEtat, exigerRoleReplication } from './matrice-droits/remise-en-etat.mjs';
import {
  COLONNES_HORS_ENTREE, entreesNouvelles, lireExports, lireVisibilite, nommerEntree, ouvrirConnexionLecture, verifierLectureExport,
} from './matrice-droits/journaux.mjs';
import { etatMontant, memeValeur } from './matrice-droits/montants-ecritures.mjs';
import { MONTANTS_MASQUES_ECRITURES, groupeDeRouteEcriture } from './matrice-droits/montants-masques.mjs';

const TITRE = 'Lot D1a-5d-3 : écritures des clés d’intégration, limites de D1a-2 et refus selon le corps, prix d’achat par clé, montants masqués côté clé, montants relus en base, aucune entrée de journal';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const REFERENCE = join(DOSSIER_MATRICES, 'cles-montants.txt');
const SA = 'SA';
const FINANCES = 'finances:read';
// Clés jouées : une par scope seul (les 13 d'API_SCOPES, relus dans GET /api/admin/api-scopes, comme D1a-2), et, pour
// les scopes dont les écritures répondent par un montant masqué (cadrage §6 : « avec et sans finances:read quand la
// réponse porte un montant »), la même clé avec finances:read (nommée comme en D1a-3).
const nomCle = (scope, finances = false) => `CLE ${scope}${finances ? `+${FINANCES}` : ''}`;
const SCOPES_A_MONTANT = ['devis:write', 'catalogue:write', 'equipements:write'];
// Refus de la porte /api/v1 (http/cles-api.ts) : 401, ou 403 « Scope requis : … ». Toute autre réponse vient d'un appel
// admis par la porte, qui note la dernière utilisation de la clé sans attente.
const refuseeParLaPorte = (res) => res.status === 401 || (res.status === 403 && /^Scope requis : /.test(res.body?.error ?? ''));
// Constats des montants (cadrage §3), sans chiffre.
const MONTANTS_INCHANGES = 'montants inchangés en base';
const CONSTATS_CONFORMES = {
  devis: 'montants du devis relus en base conformes',
  copie: 'montants du devis copiés de la source relus en base conformes',
  conversion: 'montants du chantier ouvert relus en base conformes',
  fiche: 'prix de la fiche relus en base conformes',
  effacement: 'prix d’achat de la fiche effacé en base, autres prix relus conformes',
};
const CONSTATS_ECART = {
  devis: 'montants du devis différents de l’attendu', copie: 'montants du devis différents de la source',
  conversion: 'montants du chantier ouvert différents de l’attendu', fiche: 'prix de la fiche différents de l’attendu',
  effacement: 'prix de la fiche différents de l’attendu',
};
// Colonnes de montant relues (cadrage §3 : « pour chaque refus, le montant est relu inchangé ») : chantiers, devis et
// leurs lignes, catalogue. N2 de l'audit des montants de #465 (suivie par #466), versée ici parce que 5d-3 touche ces
// colonnes : le pas et le minimum du temps passé d'un devis (copiés par une révision), la durée indicative d'une
// prestation (écrite par une clé, copiée en minutes prévues par une ligne de devis), et les minutes prévues d'une ligne.
// Une clé n'écrit ni achat, ni heure, ni coût SAV, ni pièce (aucune route /api/v1) : l'empreinte de toute la base les
// couvre. `cle` : colonne qui rattache la ligne à un objet relu à part, exclu.
const MONTANTS_CLES = {
  Chantier: { colonnes: ['budgetGlobalVendu', 'budgetMaterielVendu', 'budgetMainOeuvreVendu', 'heuresVendues', 'coutMaterielPrevu'], cle: 'id' },
  Devis: { colonnes: ['totalHt', 'totalTva', 'totalTtc', 'tauxAcompte', 'acompteMontant', 'pasTempsPasseMinutes', 'tempsMinimumMinutes'], cle: 'id' },
  DevisLigne: { colonnes: ['quantite', 'prixUnitaireHt', 'tauxTva', 'totalHt', 'totalTtc', 'prixAchatUnitaireHt', 'minutesPrevuesUnite'], cle: 'devisId' },
  CataloguePrestation: { colonnes: ['tauxTva', 'prixVenteHt', 'prixAchatHt', 'dureeIndicativeMin', 'prixJourHorsContratHt', 'prixHeureSousContratHt', 'prixJourSousContratHt', 'prixDemiJourneeHorsContratHt', 'prixDemiJourneeSousContratHt', 'heuresParJour'], cle: 'id' },
  CatalogueArticle: { colonnes: ['tauxTva', 'prixVenteHt', 'prixAchatHt'], cle: 'id' },
  CatalogueEquipement: { colonnes: ['tauxTva', 'prixVenteHt', 'prixAchatHt'], cle: 'id' },
};
const TOTAUX_DEVIS = MONTANTS_CLES.Devis.colonnes;
const CHAMPS_LIGNE_DEVIS = MONTANTS_CLES.DevisLigne.colonnes;

// --- Montants envoyés et attendus (cadrage §3 et §6 ; étude §5) ---
// Chaque valeur envoyée est choisie pour qu'une autre lecture plausible de la règle donne un autre résultat ; l'attendu
// est écrit en dur, la lecture écartée en commentaire, et le test « témoin des montants » le recalcule en décimal exact
// et vérifie que chaque lecture écartée en diffère.
const MONTANTS = {
  // Fiche prestation-prix-achat (cible propre) : prix d'achat 38,62 et durée indicative de 45 minutes à sa création,
  // copiés par la ligne de devis-prix-achat ; puis 41,17 et 50 minutes avant l'instantané (copie figée : la ligne garde
  // 38,62 et 45 ; un devis créé ensuite par une clé copie 41,17 et 50). Prix de vente 100.
  ficheAchatInitial: 38.62, ficheAchat: 41.17, ficheVente: 100, ficheDureeInitiale: 45, ficheDuree: 50,
  // Ligne d'un devis créé ou modifié par une clé : 1,5 × 0,35 = 0,525, arrondi à 0,53 (moitié vers le haut, exacte) ; TVA
  // 0,106, arrondie à 0,11 ; TTC 0,64. Lectures écartées : un calcul flottant (0,52499…) ou l'arrondi au pair, 0,52.
  ligne: { quantite: 1.5, prixUnitaireHt: 0.35, tauxTva: 20 }, ligneHt: 0.53, ligneTtc: 0.64, devisTva: 0.11,
  // Prix d'achat prévu envoyé par une clé (refusé, 403) : 12,34, distinct de tout prix relu.
  prixAchatLigne: 12.34,
  // Fiche article-prix-achat : prix d'achat 0,35 (prix de vente 33,33) à la création de devis-signe-prix-achat, puis 0,40
  // (prix de vente 35,55) après sa signature.
  articleAchatInitial: 0.35, articleVenteInitial: 33.33, articleAchat: 0.4, articleVente: 35.55,
  // Main d'œuvre du devis (main-oeuvre-du-devis) : prix et heures par jour à la signature, puis changés après elle.
  mainOeuvreDuDevisInitial: { prixVenteHt: 58.37, prixJourHorsContratHt: 412.37, prixHeureSousContratHt: 51.13, prixJourSousContratHt: 377.71, heuresParJour: 7.5 },
  mainOeuvreDuDevis: { prixVenteHt: 66.66, prixJourHorsContratHt: 499.99, prixHeureSousContratHt: 59.99, prixJourSousContratHt: 455.55, heuresParJour: 8 },
  // Main d'œuvre du catalogue (main-oeuvre-catalogue), que les clés ne modifient ni ne désactivent (403).
  mainOeuvre: { prixVenteHt: 61.57, prixJourHorsContratHt: 430.45, prixHeureSousContratHt: 57.29, prixJourSousContratHt: 390.13, prixDemiJourneeHorsContratHt: 233.37, prixDemiJourneeSousContratHt: 211.19, heuresParJour: 7.75 },
  // devis-signe-prix-achat, quatre lignes à 20 %, acompte exigé (taux copié du réglage à sa création), signé, acompte
  // constaté avant l'instantané (même lignes que D1a-5d-2) :
  //  - L1, fourniture du catalogue (article-prix-achat) : 1,5 × 33,33 = 49,995, arrondi à 50,00 ; prix d'achat copié 0,35 ;
  //    un article n'a pas de durée : 0 minute par unité ;
  //  - L2, main-d'œuvre libre : 1,5 × 61,50 = 92,25 ; prix d'achat saisi par SA 0,35 ; sans minutes (60 par unité) ;
  //  - L3, fourniture libre : 2 × 10,05 = 20,10 ; sans prix d'achat ;
  //  - L4, main d'œuvre au jour hors contrat (main-oeuvre-du-devis) : 2 jours au prix figé 412,37 = 824,74 ; 450 minutes
  //    par jour (7,5 h × 60).
  devisSigneLignes: [
    { quantite: 1.5, prixUnitaireHt: 33.33, tauxTva: 20, totalHt: 50, totalTtc: 60, prixAchatUnitaireHt: 0.35, minutesPrevuesUnite: 0 },
    { quantite: 1.5, prixUnitaireHt: 61.5, tauxTva: 20, totalHt: 92.25, totalTtc: 110.7, prixAchatUnitaireHt: 0.35, minutesPrevuesUnite: null },
    { quantite: 2, prixUnitaireHt: 10.05, tauxTva: 20, totalHt: 20.1, totalTtc: 24.12, prixAchatUnitaireHt: null, minutesPrevuesUnite: null },
    { quantite: 2, prixUnitaireHt: 412.37, tauxTva: 20, totalHt: 824.74, totalTtc: 989.69, prixAchatUnitaireHt: null, minutesPrevuesUnite: 450 },
  ],
  // Chantier ouvert par la conversion de devis-signe-prix-achat par une clé (devis/routes.ts:401-413) :
  //  - montant vendu : le total HT du devis, 50,00 + 92,25 + 20,10 + 824,74 = 987,09 ; avec le prix du jour de la main
  //    d'œuvre (499,99 × 2), 1 162,33 ;
  //  - budget matériel : les fournitures, 50,00 + 20,10 = 70,10 ; budget main-d'œuvre : le reste, 916,99 ;
  //  - heures vendues : (90 + 2 × 450) / 60 = 16,5 ; avec les heures par jour du jour (8 h), (90 + 960) / 60 = 17,5 ;
  //  - coût matériel prévu : chaque ligne à son prix d'achat × quantité, arrondie au centime (0,525 → 0,53, deux fois),
  //    1,06. Lectures écartées : arrondi du total (1,05) ; fournitures seules (0,53) ; prix d'achat de l'article du jour
  //    (1,5 × 0,40 = 0,60, et 1,13) ; ligne sans prix d'achat comptée à son prix de vente (21,16).
  conversion: { budgetGlobalVendu: 987.09, budgetMaterielVendu: 70.1, budgetMainOeuvreVendu: 916.99, heuresVendues: 16.5, coutMaterielPrevu: 1.06 },
  // Chantier ouvert par la conversion de devis-signe (jeu de données : une ligne de main-d'œuvre libre, 1 × 1 000 HT, sans
  // minutes ni prix d'achat) : montant vendu 1 000 (et non le TTC, 1 200) ; budget matériel 0 ; main-d'œuvre 1 000 ;
  // 1 heure (60 minutes par unité, et non 0) ; coût matériel prévu 0 (« Zéro », réponse du 30-10-2026), et non null.
  conversionSigne: { budgetGlobalVendu: 1000, budgetMaterielVendu: 0, budgetMainOeuvreVendu: 1000, heuresVendues: 1, coutMaterielPrevu: 0 },
  // Acompte constaté sur devis-signe-prix-achat avant l'instantané : 21,37, distinct du taux d'acompte appliqué au TTC et
  // de null. Une révision le reprend (devis/routes.ts:131-132). Lecture écartée : la révision qui ne le reprend pas.
  acompteConstate: 21.37,
  // Taux d'acompte par défaut changé à 37,5 % après la création de devis-signe-prix-achat (copié au taux d'avant) : une
  // révision garde le taux copié (devis/routes.ts:127). Lecture écartée : la révision qui relit le taux du jour.
  tauxAcompteDuJour: 37.5,
  // devis-signe-temps-passe (cible propre, seconde source d'une révision par clé ; N2 de l'audit des montants de #465,
  // suivie par #466, et leçon C1 du même audit) : devis au temps passé, pas de 45 minutes et minimum de 105 minutes figés
  // à sa création (réglages de la société d'alors) ; une ligne au temps passé, à l'heure hors contrat de
  // main-oeuvre-du-devis (prixVenteHt, devis/tempsPasse.ts:218), 2,5 h (105 + 45 minutes) × 58,37 = 145,925, arrondi à
  // 145,93 (lectures écartées : flottant ou arrondi au pair, 145,92), TVA 29,19, TTC 175,12 ; signé ; puis réglages de la
  // société changés à 30 et 90 minutes, et la main d'œuvre à 66,66 (2,5 h : 166,65). Une révision copie le pas et le
  // minimum figés (devis/routes.ts:130) et la ligne. Lectures écartées : la révision qui ne copie pas le minimum (null),
  // qui relit les réglages du jour (30 et 90), ou qui prend le minimum par défaut (60, tempsPasse.ts:44). Les réglages du
  // jour sont choisis pour que la ligne copiée (150 minutes) reste admise par la base sous chacune de ces lectures
  // (90 + 2 × 30 ; 60 + 2 × 45 ; une heure au moins sans minimum, déclencheur verifier_devis_temps_passe) : c'est la
  // relecture des montants, et non une contrainte de la base, qui les distingue. Une révision sans pas est refusée par la
  // base (contrainte Devis_temps_passe_pas_check).
  tempsPasse: { pas: 45, minimum: 105, quantite: 2.5, totalHt: 145.93, totalTva: 29.19, totalTtc: 175.12, pasDuJour: 30, minimumDuJour: 90, minimumParDefaut: 60 },
  // Fiches créées par une clé catalogue:write (§6 : « une clé catalogue:write écrit le prix d'achat d'une fiche en
  // création », écart de documentation connu, question ouverte « Catalogue dans les devis ») :
  //  - prestation : vente 47,13, TVA 10 %, prix d'achat 8,88, durée indicative 35 minutes ; lectures écartées : le prix
  //    d'achat ignoré pour une clé (null), la TVA par défaut (20 %), la durée ignorée (null) ;
  //  - article : vente 23,45, TVA 5,5 %, prix d'achat 17,43 ; lectures écartées : null, 20 % ;
  //  - modèle d'équipement : vente 312,34, TVA 10 %, prix d'achat 129,87 ; lectures écartées : null, 20 %.
  prestationCree: { prixVenteHt: 47.13, tauxTva: 10, prixAchatHt: 8.88, dureeIndicativeMin: 35 },
  articleCree: { prixVenteHt: 23.45, tauxTva: 5.5, prixAchatHt: 17.43 },
  modeleCree: { prixVenteHt: 312.34, tauxTva: 10, prixAchatHt: 129.87 },
  // PUT par une clé (fiche entière, catalogue/metier.ts:81-98) : prestation-catalogue à 104,44, TVA 10 %, durée indicative
  // de 25 minutes (au lieu de 100, 20 % et sans durée ; lecture écartée : un PUT qui garderait l'ancienne valeur) ; prix
  // d'achat de prestation-prix-achat changé à 42,18 (distinct de 41,17 et de 38,62) ; un corps qui omet le prix d'achat
  // l'efface (null), état actuel enregistré (cadrage §10), et non une règle.
  prestationCatalogue: { prixVenteHt: 104.44, tauxTva: 10, dureeIndicativeMin: 25 }, ficheAchatModifie: 42.18,
  // Modèle d'équipement à prix d'achat (G8 côté « voit ») : 123,45.
  modeleAchat: 123.45,
};

// --- Calcul décimal exact du témoin, indépendant de l'application (repris de D1a-5d-1 et D1a-5d-2) ---
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
// Montants du chantier qu'ouvre la conversion d'un devis, recalculés depuis ses lignes relues (devis/routes.ts:401-411 ;
// devis/metier.ts:154-160) : total HT, fournitures, reste, heures prévues (minutes exactes, une division par 60), coût
// matériel prévu (chaque ligne à prix d'achat arrondie au centime).
const conversionDe = (lignes) => {
  const total = lignes.reduce((a, x) => a + enUnites(x.totalHt, 2), 0n);
  const materiel = lignes.filter((x) => x.nature === 'FOURNITURE').reduce((a, x) => a + enUnites(x.totalHt, 2), 0n);
  const minutes = lignes.filter((x) => x.nature === 'MAIN_OEUVRE').reduce((a, x) => a + enUnites(x.quantite, 3) * enUnites(x.minutesPrevuesUnite ?? 60, 2), 0n);
  const cout = lignes.filter((x) => x.prixAchatUnitaireHt !== null).reduce((a, x) => a + exact.ligneHt(x.quantite, x.prixAchatUnitaireHt), 0n);
  return { budgetGlobalVendu: exact.euros(total), budgetMaterielVendu: exact.euros(materiel), budgetMainOeuvreVendu: exact.euros(total - materiel), heuresVendues: exact.euros(auCentime(minutes, 60n * 1000n)), coutMaterielPrevu: exact.euros(cout) };
};

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const base = baseJetable(TEST_DATABASE_URL, 'clesmontants');
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
    // Clés jouées : nom → { id, scopes, autorisation } ; scopes relus à l'administration.
    const cles = {};
    const scopes = [];
    let exportsReference = {};
    const lignes = [];
    const cas = [];
    const lots = [];
    const chiffres = { cas: 0, lectures: 0, remises: 0, montants: 0, lots: 0, refusEnLots: 0, lotsRejoues: [] };
    const diagnostics = [];
    const horsDroits = [];
    const usagesEnEcart = [];

    const api = async (compte, methode, chemin, corps, statut = 200) => {
      const res = await appeler(appli.adresse, methode, chemin, { jeton: jetons[compte], corps: methode === 'GET' ? undefined : corps });
      const admis = Array.isArray(statut) ? statut : [statut];
      assert.ok(admis.includes(res.status), `${methode} ${chemin} (${compte}) : ${res.status} ${JSON.stringify(res.body)?.slice(0, 400)}`);
      return res.body;
    };
    const id = (famille, nom) => cibleDe(famille, nom).ids.id;
    const q = async (texte, valeurs = []) => (await lecture.query(texte, valeurs)).rows;
    const S = `"${SCHEMA_INSTANTANE}"`;

    // --- Relectures (cadrage §3) ---
    const ident = (nom) => { assert.match(nom, /^[A-Za-z]+$/); return `"${nom}"`; };
    const nombre = (v) => (v === null || v === undefined ? null : Number(v));
    // Une ligne relue en base (schéma public), ou dans l'instantané : colonnes demandées, nombres.
    const ligneDe = async (schema, table, ligneId, colonnes) => {
      const [r] = await q(`SELECT ${colonnes.map(ident).join(', ')} FROM ${schema === 'public' ? 'public' : S}.${ident(table)} WHERE id = $1`, [ligneId]);
      return r ? Object.fromEntries(colonnes.map((c) => [c, nombre(r[c])])) : null;
    };
    const lignesCreees = async (table) => (await q(`SELECT t.id FROM public.${ident(table)} t LEFT JOIN ${S}.${ident(table)} s ON s.id = t.id WHERE s.id IS NULL ORDER BY t.id`)).map((r) => r.id);
    // Lignes d'un devis (par ordre), relues en base ou dans l'instantané.
    const lignesDuDevis = async (schema, devisId) => (await q(`SELECT ${CHAMPS_LIGNE_DEVIS.map(ident).join(', ')} FROM ${schema === 'public' ? 'public' : S}."DevisLigne" WHERE "devisId" = $1 ORDER BY ordre`, [devisId]))
      .map((r) => Object.fromEntries(CHAMPS_LIGNE_DEVIS.map((c) => [c, nombre(r[c])])));
    // Tables dont un montant a changé depuis l'instantané, hors des objets relus à part (`exclus` : identifiants, comparés à
    // la colonne `cle` de chaque table).
    const REQUETE_MONTANTS = Object.entries(MONTANTS_CLES).map(([table, def]) => {
      const colonnes = ['id', ...def.colonnes].map((c) => `t."${c}"`).join(', ');
      const hors = `NOT (t."${def.cle}" = ANY($1::text[]))`;
      return `SELECT '${table}' AS t, count(*)::int AS n FROM (
        (SELECT ${colonnes} FROM ${S}."${table}" t WHERE ${hors} EXCEPT SELECT ${colonnes} FROM public."${table}" t WHERE ${hors})
        UNION ALL (SELECT ${colonnes} FROM public."${table}" t WHERE ${hors} EXCEPT SELECT ${colonnes} FROM ${S}."${table}" t WHERE ${hors})) x`;
    }).join(' UNION ALL ');
    const montantsChanges = async (exclus = []) => (await lecture.query({ name: 'montants-cles', text: REQUETE_MONTANTS, values: [exclus] })).rows.filter((r) => r.n > 0).map((r) => r.t).sort();
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
    // Constat des montants d'un cas : relecture propre au cas pour une écriture admise, montants inchangés sinon.
    const constaterMontants = async (c, res, source) => {
      chiffres.montants += 1;
      const m = c.montant;
      if (!m || res.status < 200 || res.status >= 300) {
        const tables = await montantsChanges();
        return tables.length ? `montants changés en base : ${tables.join(', ')}` : MONTANTS_INCHANGES;
      }
      if (m.genre === 'devis') {
        const crees = await lignesCreees('Devis');
        if (!m.devis && crees.length !== 1) return `devis créés : ${crees.length ? 'plusieurs' : 'aucun'}`;
        const devisId = m.devis ?? crees[0];
        return constat('devis', await ecartsDevis(devisId, m.attendu), await hors([devisId], 'du devis'));
      }
      if (m.genre === 'copie') {
        // Révision : un devis créé, dont les totaux (acompte et temps passé compris) et les lignes égalent ceux de la
        // source, relus dans l'instantané (copie à l'identique, devis/routes.ts:124-133).
        const crees = await lignesCreees('Devis');
        if (crees.length !== 1) return `devis créés : ${crees.length ? 'plusieurs' : 'aucun'}`;
        return constat('copie', await ecartsDevis(crees[0], source), await hors([crees[0]], 'du devis créé'));
      }
      if (m.genre === 'conversion') {
        const crees = await lignesCreees('Chantier');
        if (crees.length !== 1) return `chantiers créés : ${crees.length ? 'plusieurs' : 'aucun'}`;
        const lu = await ligneDe('public', 'Chantier', crees[0], MONTANTS_CLES.Chantier.colonnes);
        return constat('conversion', ecartsChamps(lu, m.attendu), await hors([crees[0]], 'du chantier ouvert'));
      }
      // Fiche du catalogue, créée ou modifiée (fiche entière) : prix attendus, les autres égaux à l'instantané (fiche
      // modifiée) ou absents (fiche créée).
      const table = m.table ?? 'CataloguePrestation';
      const creees = m.fiche ? [] : await lignesCreees(table);
      if (!m.fiche && creees.length !== 1) return 'fiche créée introuvable';
      const ficheId = m.fiche ?? creees[0];
      const colonnes = MONTANTS_CLES[table].colonnes;
      const lu = await ligneDe('public', table, ficheId, colonnes);
      const avant = m.fiche ? await ligneDe('instantane', table, ficheId, colonnes) : null;
      const attendu = { ...(avant ?? Object.fromEntries(colonnes.map((c) => [c, null]))), ...m.attendu };
      return constat(m.genre, ecartsChamps(lu, attendu), await hors([ficheId], 'de la fiche'));
    };

    // --- Dernière utilisation d'une clé ---
    // ApiAccessKey change, hors de la dernière utilisation, depuis l'instantané (création, révocation, scopes…) ?
    const REQUETE_CLES_CHANGEES = `SELECT count(*)::int AS n FROM (
      (SELECT to_jsonb(t) - 'dernierUsageLe' AS j FROM public."ApiAccessKey" t EXCEPT SELECT to_jsonb(s) - 'dernierUsageLe' FROM ${S}."ApiAccessKey" s)
      UNION ALL (SELECT to_jsonb(s) - 'dernierUsageLe' FROM ${S}."ApiAccessKey" s EXCEPT SELECT to_jsonb(t) - 'dernierUsageLe' FROM public."ApiAccessKey" t)) x`;
    const REQUETE_USAGES = `SELECT t.id FROM public."ApiAccessKey" t LEFT JOIN ${S}."ApiAccessKey" s ON s.id = t.id
      WHERE s.id IS NULL OR t."dernierUsageLe" IS DISTINCT FROM s."dernierUsageLe" ORDER BY t.id`;
    const nomDeCle = (cleId) => Object.entries(cles).find(([, k]) => k.id === cleId)?.[0] ?? 'autre clé';
    // Tables écrites par un cas : celles de l'empreinte, sans ApiAccessKey quand seule la dernière utilisation y change
    // (la porte /api/v1 la note pour chaque appel admis, http/cles-api.ts:53) ; contrôlée à part : notée pour la seule clé
    // du cas, si et seulement si la porte l'a admise.
    const tablesEcrites = async (c, admise, apres) => {
      const changees = tablesChangees(remise.reference, apres);
      const usages = (await q({ name: 'usages-cles', text: REQUETE_USAGES })).map((r) => r.id);
      const attendus = admise ? [cles[c.compte].id] : [];
      if (!memeValeur(usages, attendus)) usagesEnEcart.push(`${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : dernière utilisation notée pour ${usages.map(nomDeCle).join(', ') || 'aucune clé'}, attendue pour ${attendus.map(nomDeCle).join(', ') || 'aucune clé'}`);
      if (!changees.includes('ApiAccessKey')) return changees;
      const [{ n }] = await q({ name: 'cles-changees', text: REQUETE_CLES_CHANGEES });
      return n > 0 ? changees : changees.filter((table) => table !== 'ApiAccessKey');
    };

    // --- Cas ---
    // { compte (clé), route, cible, contexte, chemin, corps, code (réponse attendue, null si non écrite), groupe (des 8 de
    // MONTANTS_MASQUES_ECRITURES, null hors des groupes), voit (la clé porte finances:read), montant (relecture),
    // action (b) }.
    const ajouter = (compte, route, cible, contexte, chemin, corps, options = {}) => cas.push({
      compte, route, cible, contexte, chemin, corps, code: null, montant: null, groupe: groupeDeRouteEcriture(route), voit: compte.endsWith(`+${FINANCES}`), ...options,
    });
    // Une écriture dont la réponse porte un montant masqué : par la clé du scope, puis par la même avec finances:read.
    const ajouterDeuxCles = (scope, route, cible, contexte, chemin, corps, options = {}) => {
      for (const finances of [false, true]) ajouter(nomCle(scope, finances), route, cible, contexte, chemin, corps, options);
    };
    const releverHorsDroits = (c, res) => {
      // Hors droits (cadrage §3 et §6), pour #426 : une erreur serveur, ou un devis inexistant refusé en 400 « Devis
      // introuvable. » au lieu d'un 404.
      if (res.status >= 500 || (res.status === 400 && res.body?.error === 'Devis introuvable.')) horsDroits.push(`${c.compte} | ${c.route} | ${c.cible} | ${c.contexte} | ${formaterReponse(res, { messageDu400: true })}`);
    };
    const jouer = async (c) => {
      const [methode, chemin] = c.route.split(' ');
      const cle = cles[c.compte];
      const source = c.montant?.source ? await c.montant.source() : null;
      const envoi = Date.now();
      const res = await appeler(appli.adresse, methode, c.chemin, { autorisation: cle.autorisation, corps: c.corps() });
      chiffres.cas += 1;
      releverHorsDroits(c, res);
      // Appel admis par la porte : sa dernière utilisation, écrite sans attente, est attendue avant l'empreinte (comme
      // D1a-2 et la preuve de l'outil de remise, D1a-5a), pour qu'elle ne tombe pas dans le cas suivant.
      const admise = !refuseeParLaPorte(res);
      if (admise) {
        try { await remise.attendreDernierUsage(cle.id, envoi, `${c.compte} ${c.route} sur ${c.cible}`); } catch (erreur) { usagesEnEcart.push(erreur.message); }
      }
      const apres = await remise.empreinte();
      const changees = await tablesEcrites(c, admise, apres);
      const entrees = await entreesNouvelles(lecture);
      const nomsEntrees = entrees.map((e) => nommerEntree(e, noms)).sort();
      assert.equal(new Set(nomsEntrees).size, nomsEntrees.length, `${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : deux entrées de même nom (${nomsEntrees.join(' + ')})`);
      const morceaux = [formaterReponse(res, { messageDu400: true, ecriture: changees.length ? `écrit (${changees.join(',')})` : 'inchangé' })];
      morceaux.push(nomsEntrees.length ? `entrées : ${nomsEntrees.join(' + ')}` : 'aucune entrée');
      // Réponse d'une route des groupes (cadrage §6) : état de chaque champ, jamais sa valeur.
      c.observation = null;
      if (c.groupe && res.status >= 200 && res.status < 300) {
        const champs = MONTANTS_MASQUES_ECRITURES[c.groupe - 1].champs;
        c.observation = Object.fromEntries(champs.map((champ) => [champ, etatMontant(res.body, champ)]));
        morceaux.push(`réponse : ${champs.map((champ) => `${champ} ${c.observation[champ]}`).join(', ')}`);
      }
      morceaux.push(await constaterMontants(c, res, source));
      c.reponse = morceaux.join(' ; ');
      lignes.push(ligneMatrice({ compte: c.compte, methode, chemin, cible: c.cible, contexte: c.contexte, reponse: c.reponse }));
      // Une entrée qu'écrirait une clé est lue par SA, AD et le compte refusé de sa route (outils de D1a-5c) ; une clé
      // n'est pas un lecteur de session (auteur null). Aucune aujourd'hui (cadrage §6) : c'est ce que M5b fait voir.
      const taches = entrees.map((entree) => async () => {
        const nom = `${nommerEntree(entree, noms)} ← ${c.compte} ${c.route} sur ${c.cible}`;
        const verdicts = await lireVisibilite({ appeler, adresse: appli.adresse, jetons, entree, auteur: null, exportsReference, entreesDuCas: entrees, nom, lignesExport: lecture });
        chiffres.lectures += verdicts.length;
        return verdicts.map((v) => ligneMatrice({ compte: v.lecteur, methode: 'GET', chemin: v.route.slice(4), cible: nom, contexte: c.contexte, reponse: v.verdict }));
      });
      for (const groupe of await enParallele(taches, 4)) lignes.push(...groupe);
      assert.deepEqual(tablesChangees(apres, await remise.empreinte()), [], `${c.compte} ${c.route} sur ${c.cible} : une lecture des journaux a écrit`);
      const aRemettre = remise.changees(apres);
      if (aRemettre.length) { await remise.remettre(aRemettre, `${c.compte} ${c.route}, cible ${c.cible}, contexte ${c.contexte}`); chiffres.remises += 1; }
    };
    // Clés refusées à la porte sur une action (b), rejouées par l'avenant, section 3 (R-H non admissible) : en parallèle,
    // une empreinte par lot ; une clé admise à tort voit sa dernière utilisation attendue avant l'empreinte ; un lot qui
    // écrit est remis, puis rejoué un à un, si bien que ses écritures, leurs entrées et leurs montants se lisent dans le
    // diff (comme D1a-5b et D1a-5d-1).
    const jouerLot = async (route, lot) => {
      const envoi = Date.now();
      const resultats = await enParallele(lot.map((c) => () => appeler(appli.adresse, c.route.split(' ')[0], c.chemin, { autorisation: cles[c.compte].autorisation, corps: c.corps() })), 8);
      chiffres.lots += 1;
      for (const [i, res] of resultats.entries()) {
        if (!refuseeParLaPorte(res)) await remise.attendreDernierUsage(cles[lot[i].compte].id, envoi, `lot de ${route}, ${lot[i].compte} admise à tort`).catch(() => {});
      }
      const changees = remise.changees(await remise.empreinte());
      if (changees.length) {
        chiffres.lotsRejoues.push(`${route} (${changees.join(', ')})`);
        await remise.remettre(changees, `lot des clés refusées de ${route}`);
        for (const c of lot) await jouer(c);
        return;
      }
      chiffres.refusEnLots += lot.length;
      assert.deepEqual(await entreesNouvelles(lecture), [], `lot des clés refusées de ${route} : entrée nouvelle sans écriture`);
      const tables = await montantsChanges();
      const montants = tables.length ? `montants changés en base : ${tables.join(', ')}` : MONTANTS_INCHANGES;
      lot.forEach((c, i) => {
        releverHorsDroits(c, resultats[i]);
        const [methode, chemin] = c.route.split(' ');
        c.reponse = `${formaterReponse(resultats[i], { messageDu400: true, ecriture: 'inchangé' })} ; aucune entrée ; ${montants}`;
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
        hier: jourSociete(-1), aujourdhui: jourSociete(0),
        clientActif: id('client', 'client-actif'), siteActif: id('site', 'site-client-actif'), siteDesactive: id('site', 'site-autre-client'),
      });

      // --- Cibles propres (cadrage §3 et §6), construites par l'API, session du super administrateur, avant l'instantané ---
      // Catalogue : prestation à prix d'achat et à durée indicative, article à prix d'achat, main d'œuvre copiée par un
      // devis, main d'œuvre du catalogue (refus des clés).
      const corpsPrestation = (prixAchatHt, dureeIndicativeMin) => ({ reference: 'TEST-CLES-PA', nom: 'TEST Prestation à prix d’achat de la matrice des clés', unite: 'forfait', prixVenteHt: MONTANTS.ficheVente, tauxTva: 20, prixAchatHt, dureeIndicativeMin });
      d.corpsPrestation = corpsPrestation;
      P['prestation-prix-achat'] = (await api(SA, 'POST', '/api/catalogue/prestations', corpsPrestation(MONTANTS.ficheAchatInitial, MONTANTS.ficheDureeInitiale), 201)).id;
      const corpsArticle = (prixVenteHt, prixAchatHt) => ({ reference: 'TEST-CLES-ART', nom: 'TEST Article à prix d’achat de la matrice des clés', prixVenteHt, tauxTva: 20, prixAchatHt });
      d.corpsArticle = corpsArticle;
      P['article-prix-achat'] = (await api(SA, 'POST', '/api/catalogue/articles', corpsArticle(MONTANTS.articleVenteInitial, MONTANTS.articleAchatInitial), 201)).id;
      const corpsMainOeuvre = (reference, nom, prix) => ({ estMainOeuvre: true, reference, nom, tauxTva: 20, ...prix });
      d.corpsMainOeuvre = corpsMainOeuvre;
      P['main-oeuvre-du-devis'] = (await api(SA, 'POST', '/api/catalogue/prestations', corpsMainOeuvre('TEST-CLES-MO-DEVIS', 'TEST Main d’œuvre du devis de la matrice des clés', MONTANTS.mainOeuvreDuDevisInitial), 201)).id;
      P['main-oeuvre-catalogue'] = (await api(SA, 'POST', '/api/catalogue/prestations', corpsMainOeuvre('TEST-CLES-MO', 'TEST Main d’œuvre de la matrice des clés', MONTANTS.mainOeuvre), 201)).id;
      // Devis brouillon : une ligne du catalogue (prestation-prix-achat), prix d'achat (38,62) et minutes (45) copiés.
      const ligneCatalogue = (designation, quantite, prixUnitaireHt) => ({ designation, nature: 'MAIN_OEUVRE', quantite, prixUnitaireHt, tauxTva: 20, catalogueFamille: 'prestations', catalogueId: P['prestation-prix-achat'] });
      d.ligneCatalogue = ligneCatalogue;
      const devisPa = await api(SA, 'POST', '/api/devis', { clientId: d.clientActif, objet: 'TEST Devis au prix d’achat de la matrice des clés', lignes: [ligneCatalogue('TEST Ligne du catalogue de la matrice des clés', 2, 150)] }, 201);
      P['devis-prix-achat'] = devisPa.id; d.ligneDevisPa = devisPa.lignes[0].id;
      // Devis signé à quatre lignes (MONTANTS.devisSigneLignes), acompte exigé (taux copié du réglage du jour), acompte
      // constaté : la source d'une révision par clé, et d'une conversion par clé.
      const ligneLibre = (designation, nature, quantite, prixUnitaireHt, extra = {}) => ({ designation, nature, quantite, prixUnitaireHt, tauxTva: 20, ...extra });
      const lignesSignees = [
        { designation: 'TEST Fourniture du catalogue de la matrice des clés', nature: 'FOURNITURE', quantite: 1.5, prixUnitaireHt: 33.33, tauxTva: 20, catalogueFamille: 'articles', catalogueId: P['article-prix-achat'] },
        ligneLibre('TEST Main-d’œuvre libre de la matrice des clés', 'MAIN_OEUVRE', 1.5, 61.5, { prixAchatUnitaireHt: 0.35 }),
        ligneLibre('TEST Fourniture libre de la matrice des clés', 'FOURNITURE', 2, 10.05),
        { designation: 'TEST Main d’œuvre au jour de la matrice des clés', forfaitMainOeuvre: 'JOUR', tarifForfait: 'HORS_CONTRAT', quantite: 2, catalogueFamille: 'prestations', catalogueId: P['main-oeuvre-du-devis'] },
      ];
      d.tauxAcompteInitial = Number((await appli.prisma.parametres.findUniqueOrThrow({ where: { id: 'singleton' }, select: { tauxAcompteDefaut: true } })).tauxAcompteDefaut);
      P['devis-signe-prix-achat'] = (await api(SA, 'POST', '/api/devis', { clientId: d.clientActif, objet: 'TEST Devis signé au prix d’achat de la matrice des clés', acompteExige: true, lignes: lignesSignees }, 201)).id;
      await api(SA, 'PUT', `/api/devis/${P['devis-signe-prix-achat']}/statut`, { statut: 'ENVOYE' });
      await api(SA, 'POST', `/api/devis/${P['devis-signe-prix-achat']}/signature`, { signataire: 'TEST Signataire de la matrice des clés', confirme: true }, 201);
      await api(SA, 'POST', `/api/devis/${P['devis-signe-prix-achat']}/acompte`, { recuLe: d.hier, montant: MONTANTS.acompteConstate, reference: 'TEST-ACOMPTE-CLES' });
      // Devis au temps passé signé (MONTANTS.tempsPasse) : la source d'une révision par clé dont le pas et le minimum figés
      // ne sont pas nuls (N2 de l'audit des montants de #465, suivie par #466 ; leçon C1 du même audit). Le pas et le
      // minimum sont réglés par l'administration juste avant sa création (devis/tempsPasse.ts, reglagesTempsPasseDuDevis).
      const tp = MONTANTS.tempsPasse;
      await api(SA, 'PUT', '/api/parametres', { pasTempsPasseMinutes: tp.pas, tempsMinimumMinutes: tp.minimum });
      P['devis-signe-temps-passe'] = (await api(SA, 'POST', '/api/devis', { clientId: d.clientActif, objet: 'TEST Devis au temps passé de la matrice des clés', auTempsPasse: true, lignes: [{ tempsPasse: true, designation: 'TEST Main d’œuvre au temps passé de la matrice des clés', quantite: tp.quantite, tarifTempsPasse: 'HORS_CONTRAT', catalogueFamille: 'prestations', catalogueId: P['main-oeuvre-du-devis'] }] }, 201)).id;
      await api(SA, 'PUT', `/api/devis/${P['devis-signe-temps-passe']}/statut`, { statut: 'ENVOYE' });
      await api(SA, 'POST', `/api/devis/${P['devis-signe-temps-passe']}/signature`, { signataire: 'TEST Signataire de la matrice des clés', confirme: true }, 201);
      // Sources changées après coup (copie figée) : taux d'acompte par défaut, pas et minimum du temps passé, fiche (prix
      // d'achat et durée), article et main d'œuvre du devis.
      await api(SA, 'PUT', '/api/parametres', { tauxAcompteDefaut: MONTANTS.tauxAcompteDuJour, pasTempsPasseMinutes: tp.pasDuJour, tempsMinimumMinutes: tp.minimumDuJour });
      await api(SA, 'PUT', `/api/catalogue/prestations/${P['prestation-prix-achat']}`, corpsPrestation(MONTANTS.ficheAchat, MONTANTS.ficheDuree));
      await api(SA, 'PUT', `/api/catalogue/articles/${P['article-prix-achat']}`, corpsArticle(MONTANTS.articleVente, MONTANTS.articleAchat));
      await api(SA, 'PUT', `/api/catalogue/prestations/${P['main-oeuvre-du-devis']}`, corpsMainOeuvre('TEST-CLES-MO-DEVIS', 'TEST Main d’œuvre du devis de la matrice des clés', MONTANTS.mainOeuvreDuDevis));
      // Parc : modèle à prix d'achat (G8 côté « voit »), équipement installé de ce modèle chez client-actif.
      P['modele-prix-achat'] = (await api(SA, 'POST', '/api/catalogue/equipements', { reference: 'TEST-CLES-EQ', nom: 'TEST Modèle à prix d’achat de la matrice des clés', fabricant: 'TEST', prixVenteHt: 300, prixAchatHt: MONTANTS.modeleAchat }, 201)).id;
      P['equipement-prix-achat'] = (await api(SA, 'POST', `/api/clients/${d.clientActif}/equipements`, { catalogueEquipementId: P['modele-prix-achat'], clientSiteId: d.siteActif, numeroSerie: 'TEST-SN-CLES-PA' }, 201)).id;

      // --- Clés d'intégration (cadrage §6), créées par l'API, session du super administrateur ---
      const lues = await api(SA, 'GET', '/api/admin/api-scopes');
      scopes.push(...lues.scopes);
      assert.equal(scopes.length, 13, 'API_SCOPES : 13 scopes');
      assert.ok(scopes.includes(FINANCES) && SCOPES_A_MONTANT.every((s) => scopes.includes(s)), 'scopes joués présents dans API_SCOPES');
      const creerCle = async (nom, scopesCle) => {
        const corps = await api(SA, 'POST', '/api/admin/api-keys', { nom: `TEST Matrice clés montants ${nom}`, scopes: scopesCle }, 201);
        assert.match(corps.apiKey, /^iris_[A-Za-z0-9_-]{43}$/);
        cles[nom] = { id: corps.key.id, scopes: scopesCle, autorisation: `Bearer ${corps.apiKey}` };
      };
      for (const scope of scopes) await creerCle(nomCle(scope), [scope]);
      for (const scope of SCOPES_A_MONTANT) await creerCle(nomCle(scope, true), [scope, FINANCES]);

      // --- Valeurs relues avant l'instantané, pour le témoin des montants ---
      const fiche = async (delegue, ficheId, champs) => {
        const f = await appli.prisma[delegue].findUniqueOrThrow({ where: { id: ficheId } });
        return Object.fromEntries(champs.map((c) => [c, nombre(f[c])]));
      };
      const lignesDe = async (devisId) => (await appli.prisma.devisLigne.findMany({ where: { devisId }, orderBy: { ordre: 'asc' } })).map((l) => ({ ...Object.fromEntries(CHAMPS_LIGNE_DEVIS.map((c) => [c, nombre(l[c])])), nature: l.nature }));
      const devisDe = async (devisId) => {
        const dv = await appli.prisma.devis.findUniqueOrThrow({ where: { id: devisId } });
        return { ...Object.fromEntries(TOTAUX_DEVIS.map((c) => [c, nombre(dv[c])])), statut: dv.statut, acompteExige: dv.acompteExige };
      };
      d.temoin = {
        prestation: await fiche('cataloguePrestation', P['prestation-prix-achat'], ['prixVenteHt', 'prixAchatHt', 'dureeIndicativeMin']),
        prestationCatalogue: await fiche('cataloguePrestation', id('fiche-catalogue', 'prestation-catalogue'), ['prixVenteHt', 'prixAchatHt', 'dureeIndicativeMin', 'tauxTva']),
        article: await fiche('catalogueArticle', P['article-prix-achat'], ['prixVenteHt', 'prixAchatHt']),
        mainOeuvreDuDevis: await fiche('cataloguePrestation', P['main-oeuvre-du-devis'], ['prixJourHorsContratHt', 'heuresParJour']),
        mainOeuvre: await fiche('cataloguePrestation', P['main-oeuvre-catalogue'], Object.keys(MONTANTS.mainOeuvre)),
        modele: await fiche('catalogueEquipement', P['modele-prix-achat'], ['prixAchatHt']),
        devisPa: { ...(await devisDe(P['devis-prix-achat'])), lignes: await lignesDe(P['devis-prix-achat']) },
        devisSigne: { ...(await devisDe(P['devis-signe-prix-achat'])), lignes: await lignesDe(P['devis-signe-prix-achat']) },
        devisSigneJeu: { ...(await devisDe(id('devis', 'devis-signe'))), lignes: await lignesDe(id('devis', 'devis-signe')) },
        devisTempsPasse: { ...(await devisDe(P['devis-signe-temps-passe'])), lignes: await lignesDe(P['devis-signe-temps-passe']), auTempsPasse: (await appli.prisma.devis.findUniqueOrThrow({ where: { id: P['devis-signe-temps-passe'] }, select: { auTempsPasse: true } })).auTempsPasse },
        mainOeuvreDuDevisVente: (await fiche('cataloguePrestation', P['main-oeuvre-du-devis'], ['prixVenteHt'])).prixVenteHt,
        reglagesTempsPasse: await appli.prisma.parametres.findUniqueOrThrow({ where: { id: 'singleton' }, select: { pasTempsPasseMinutes: true, tempsMinimumMinutes: true } }).then((r) => [r.pasTempsPasseMinutes, r.tempsMinimumMinutes]),
        tauxAcompteDuJour: Number((await appli.prisma.parametres.findUniqueOrThrow({ where: { id: 'singleton' }, select: { tauxAcompteDefaut: true } })).tauxAcompteDefaut),
        usages: (await appli.prisma.apiAccessKey.findMany({ select: { dernierUsageLe: true } })).map((k) => k.dernierUsageLe),
      };

      // Instantané et outil de remise en état, une fois tout construit ; connexion de lecture ; exports de référence du
      // journal d'administration, et l'outil de l'export qui vérifie reconnaître celui du SA (#457 T1).
      const tables = await tablesDeLaBase(appli.prisma);
      remise = await creerRemiseEnEtat({ url: base.url, nomBase: base.nom, tables, connexionApplication: appli.serveur.prisma, factureEmiseId: id('facture', 'facture-emise') });
      lecture = await ouvrirConnexionLecture(base.url);
      assert.deepEqual(await entreesNouvelles(lecture), [], 'aucune entrée nouvelle juste après l’instantané');
      exportsReference = await lireExports({ appeler, adresse: appli.adresse, jetons });
      await verifierLectureExport(lecture, exportsReference.SA);
      construireCas();
    });

    after(async () => {
      await lecture?.end().catch(() => {});
      await remise?.fermer();
      await appli?.fermer();
      await base.supprimer();
    });

    // --- Table des cas ---
    function construireCas() {
      const corpsVide = () => ({});
      const client = (nom) => id('client', nom);
      const v1 = (chemin) => `/api/v1${chemin}`;
      const ficheCat = (famille, ficheId) => v1(`/catalogue/${famille}/${ficheId}`);

      // §6, routes (a) des clients, contacts et sites (scope clients:write) : aucun montant dans la réponse, joués par la clé
      // du scope seule ; écriture sur un client désactivé, enregistrée telle quelle (renommage 200, contact et site 201,
      // comme l'administration en session ; question de #438) ; contacts et sites sur un client inexistant : 500, hors droits
      // (#426).
      const CW = nomCle('clients:write');
      ajouter(CW, 'POST /api/v1/clients', SANS_CIBLE, 'défaut, corps raison sociale', v1('/clients'), () => ({ raisonSociale: 'TEST Client créé par la matrice des clés' }), { code: 201 });
      for (const [cible, code] of [['client-actif', 200], ['client-desactive', 200], [INEXISTANT, 404]]) {
        ajouter(CW, 'PUT /api/v1/clients/:id', cible, 'défaut, corps nom commercial', v1(`/clients/${client(cible)}`), () => ({ nomCommercial: 'TEST Nom commercial donné par la matrice des clés' }), { code });
      }
      for (const [cible, code] of [['client-actif', 201], ['client-desactive', 201], [INEXISTANT, 500]]) {
        ajouter(CW, 'POST /api/v1/clients/:clientId/contacts', cible, 'défaut, corps nom du contact', v1(`/clients/${client(cible)}/contacts`), () => ({ nom: 'TEST Contact créé par la matrice des clés' }), { code });
        ajouter(CW, 'POST /api/v1/clients/:clientId/sites', cible, 'défaut, corps site', v1(`/clients/${client(cible)}/sites`), () => ({ nom: 'TEST Site créé par la matrice des clés', adresse: '7 rue des Clés', codePostal: '14000', ville: 'Caen' }), { code });
      }
      for (const [cible, code] of [['contact-client-actif', 200], ['contact-autre-client', 404], [INEXISTANT, 404]]) {
        const ids = cibleDe('contact', cible).ids;
        ajouter(CW, 'PUT /api/v1/clients/:clientId/contacts/:id', cible, 'défaut, corps nom du contact', v1(`/clients/${ids.clientId}/contacts/${ids.id}`), () => ({ nom: 'TEST Contact renommé par la matrice des clés' }), { code });
      }
      for (const [cible, code] of [['site-client-actif', 200], ['site-autre-client', 404], [INEXISTANT, 404]]) {
        const ids = cibleDe('site', cible).ids;
        ajouter(CW, 'PUT /api/v1/clients/:clientId/sites/:id', cible, 'défaut, corps nom du site', v1(`/clients/${ids.clientId}/sites/${ids.id}`), () => ({ nom: 'TEST Site renommé par la matrice des clés' }), { code });
      }

      // §6, route (a) du parc (G8) : modèle à prix d'achat, sur client-actif, sur client-desactive (son propre site) et sur
      // un client inexistant (site d'un autre client : 400).
      for (const [cible, site, code] of [['client-actif', d.siteActif, 201], ['client-desactive', d.siteDesactive, 201], [INEXISTANT, d.siteActif, 400]]) {
        ajouterDeuxCles('equipements:write', 'POST /api/v1/clients/:clientId/equipements', cible, 'défaut, corps modèle à prix d’achat, site du client et numéro de série', v1(`/clients/${client(cible)}/equipements`), () => ({ catalogueEquipementId: P['modele-prix-achat'], clientSiteId: site, numeroSerie: 'TEST-SN-CLES-CREE' }), { code });
      }

      // §6, routes (a) du catalogue (G7). Catégorie : aucun montant, clé seule.
      ajouter(nomCle('catalogue:write'), 'POST /api/v1/catalogue/categories', SANS_CIBLE, 'défaut, corps nom', v1('/catalogue/categories'), () => ({ nom: 'TEST Catégorie créée par la matrice des clés' }), { code: 201 });
      // Création, chaque famille : prix d'achat écrit par une clé (état actuel, question ouverte) ; corps de main d'œuvre
      // refusé à une clé (catalogue/main-oeuvre.ts:180).
      const creation = [
        ['family=prestations', 'prestations', 'corps prestation au prix d’achat et à durée indicative', () => ({ reference: 'TEST-CLES-PRE-CREEE', nom: 'TEST Prestation créée par la matrice des clés', unite: 'forfait', ...MONTANTS.prestationCree }), 201, { genre: 'fiche', table: 'CataloguePrestation', attendu: MONTANTS.prestationCree }],
        ['family=prestations', 'prestations', 'corps main d’œuvre', () => d.corpsMainOeuvre('TEST-CLES-MO-CREEE', 'TEST Main d’œuvre créée par la matrice des clés', MONTANTS.mainOeuvre), 403, null],
        ['family=articles', 'articles', 'corps article au prix d’achat', () => ({ reference: 'TEST-CLES-ART-CREE', nom: 'TEST Article créé par la matrice des clés', ...MONTANTS.articleCree }), 201, { genre: 'fiche', table: 'CatalogueArticle', attendu: MONTANTS.articleCree }],
        ['family=equipements', 'equipements', 'corps modèle au prix d’achat', () => ({ reference: 'TEST-CLES-EQ-CREE', nom: 'TEST Modèle créé par la matrice des clés', fabricant: 'TEST', ...MONTANTS.modeleCree }), 201, { genre: 'fiche', table: 'CatalogueEquipement', attendu: MONTANTS.modeleCree }],
      ];
      for (const [cible, famille, contexte, corps, code, montant] of creation) {
        ajouterDeuxCles('catalogue:write', 'POST /api/v1/catalogue/:family', cible, `défaut, ${contexte}`, v1(`/catalogue/${famille}`), corps, { code, montant });
      }
      // Modification (fiche entière) : prix de vente, TVA et durée indicative changés (N2 de l'audit des montants de #465,
      // suivie par #466) ; prix d'achat omis, donc effacé (catalogue/metier.ts:38-40 et :86, :92 ; état actuel, question
      // ouverte, cadrage §10), y compris par une clé sans finances:read ; prix d'achat changé ; main d'œuvre existante
      // refusée à une clé, corps ordinaire (main-oeuvre.ts:208, limite de D1a-2) ou de main d'œuvre (main-oeuvre.ts:199) ;
      // fiche inexistante (404).
      const prestationCatalogue = id('fiche-catalogue', 'prestation-catalogue');
      const corpsPrestationCatalogue = () => ({ reference: 'TEST-MATRICE-PRE', nom: 'TEST Prestation catalogue matrice', unite: 'forfait', ...MONTANTS.prestationCatalogue });
      const corpsOrdinaireMo = () => ({ reference: 'TEST-CLES-MO', nom: 'TEST Main d’œuvre de la matrice des clés', unite: 'forfait', prixVenteHt: MONTANTS.mainOeuvre.prixVenteHt, tauxTva: 20 });
      const modification = [
        ['prestation-catalogue', ficheCat('prestations', prestationCatalogue), 'corps prix de vente, TVA et durée changés', corpsPrestationCatalogue, 200, { genre: 'fiche', fiche: prestationCatalogue, attendu: MONTANTS.prestationCatalogue }],
        ['prestation-prix-achat', ficheCat('prestations', P['prestation-prix-achat']), 'corps sans prix d’achat', () => d.corpsPrestation(undefined, MONTANTS.ficheDuree), 200, { genre: 'effacement', fiche: P['prestation-prix-achat'], attendu: { prixAchatHt: null } }],
        ['prestation-prix-achat', ficheCat('prestations', P['prestation-prix-achat']), 'corps prix d’achat changé', () => d.corpsPrestation(MONTANTS.ficheAchatModifie, MONTANTS.ficheDuree), 200, { genre: 'fiche', fiche: P['prestation-prix-achat'], attendu: { prixAchatHt: MONTANTS.ficheAchatModifie } }],
        ['article-prix-achat', ficheCat('articles', P['article-prix-achat']), 'corps sans prix d’achat', () => d.corpsArticle(MONTANTS.articleVente, undefined), 200, { genre: 'effacement', table: 'CatalogueArticle', fiche: P['article-prix-achat'], attendu: { prixAchatHt: null } }],
        ['main-oeuvre-catalogue', ficheCat('prestations', P['main-oeuvre-catalogue']), 'corps prestation ordinaire', corpsOrdinaireMo, 403, null],
        ['main-oeuvre-catalogue', ficheCat('prestations', P['main-oeuvre-catalogue']), 'corps main d’œuvre', () => d.corpsMainOeuvre('TEST-CLES-MO', 'TEST Main d’œuvre de la matrice des clés', MONTANTS.mainOeuvre), 403, null],
        [INEXISTANT, ficheCat('prestations', id('fiche-catalogue', INEXISTANT)), 'corps prestation ordinaire', corpsPrestationCatalogue, 404, null],
      ];
      for (const [cible, chemin, contexte, corps, code, montant] of modification) {
        ajouterDeuxCles('catalogue:write', 'PUT /api/v1/catalogue/:family/:id', cible, `défaut, ${contexte}`, chemin, corps, { code, montant });
      }

      // §6, routes (a) des devis (G3) et de la conversion (G2), clé devis:write avec et sans finances:read.
      const ligneCreee = (prixAchatUnitaireHt, minutesPrevuesUnite) => ({ ...MONTANTS.ligne, totalHt: MONTANTS.ligneHt, totalTtc: MONTANTS.ligneTtc, prixAchatUnitaireHt, minutesPrevuesUnite });
      const devisAttendu = (ligne) => ({ totaux: { totalHt: MONTANTS.ligneHt, totalTva: MONTANTS.devisTva, totalTtc: MONTANTS.ligneTtc, tauxAcompte: null, acompteMontant: null, pasTempsPasseMinutes: null, tempsMinimumMinutes: null }, lignes: [ligne] });
      const corpsDevis = (lignesCorps) => () => ({ clientId: d.clientActif, objet: 'TEST Devis écrit par la matrice des clés', lignes: lignesCorps() });
      const ligneDuCatalogue = () => [d.ligneCatalogue('TEST Ligne du catalogue copiée par la matrice des clés', MONTANTS.ligne.quantite, MONTANTS.ligne.prixUnitaireHt)];
      const ligneAuPrixAchat = () => [{ designation: 'TEST Ligne au prix d’achat prévu de la matrice des clés', nature: 'FOURNITURE', ...MONTANTS.ligne, prixAchatUnitaireHt: MONTANTS.prixAchatLigne }];
      const lignesLibres = () => [{ designation: 'TEST Ligne libre de la matrice des clés', nature: 'FOURNITURE', ...MONTANTS.ligne }];
      const ligneExistante = (extra = {}) => () => [{ ligneId: d.ligneDevisPa, designation: 'TEST Ligne du catalogue de la matrice des clés', nature: 'MAIN_OEUVRE', ...MONTANTS.ligne, ...extra }];
      const devis = (nom) => (P[nom] ?? id('devis', nom));
      // Création : ligne du catalogue (prix d'achat et minutes copiés de la fiche du jour, 41,17 et 50, masqué sans
      // finances:read) ; ligne au prix d'achat prévu, refusée à toute clé (devis/metier.ts:203-205).
      ajouterDeuxCles('devis:write', 'POST /api/v1/devis', SANS_CIBLE, 'défaut, corps ligne du catalogue', v1('/devis'), corpsDevis(ligneDuCatalogue), { code: 201, montant: { genre: 'devis', attendu: devisAttendu(ligneCreee(MONTANTS.ficheAchat, MONTANTS.ficheDuree)) } });
      ajouterDeuxCles('devis:write', 'POST /api/v1/devis', SANS_CIBLE, 'défaut, corps ligne au prix d’achat prévu', v1('/devis'), corpsDevis(ligneAuPrixAchat), { code: 403 });
      // Modification : ligne existante sans prix d'achat (gardé, 38,62 et 45 minutes, copie d'origine, la fiche valant 41,17
      // et 50 depuis) ; au prix d'achat prévu (refusée) ; devis du jeu de données, corps ligne libre.
      ajouterDeuxCles('devis:write', 'PATCH /api/v1/devis/:id', 'devis-prix-achat', 'défaut, corps ligne existante sans prix d’achat', v1(`/devis/${devis('devis-prix-achat')}`), corpsDevis(ligneExistante()), { code: 200, montant: { genre: 'devis', devis: devis('devis-prix-achat'), attendu: devisAttendu(ligneCreee(MONTANTS.ficheAchatInitial, MONTANTS.ficheDureeInitiale)) } });
      ajouterDeuxCles('devis:write', 'PATCH /api/v1/devis/:id', 'devis-prix-achat', 'défaut, corps ligne existante au prix d’achat prévu', v1(`/devis/${devis('devis-prix-achat')}`), corpsDevis(ligneExistante({ prixAchatUnitaireHt: MONTANTS.prixAchatLigne })), { code: 403 });
      for (const [cible, code] of [['devis-brouillon', 200], ['devis-signe', 409], ['devis-converti', 409], [INEXISTANT, 400]]) {
        ajouterDeuxCles('devis:write', 'PATCH /api/v1/devis/:id', cible, 'défaut, corps ligne libre', v1(`/devis/${devis(cible)}`), corpsDevis(lignesLibres), { code, montant: code === 200 ? { genre: 'devis', devis: devis(cible), attendu: devisAttendu(ligneCreee(null, null)) } : null });
      }
      // Statut : envoi d'un brouillon (montants inchangés) ; refus selon l'état.
      for (const [cible, code] of [['devis-prix-achat', 200], ['devis-brouillon', 200], ['devis-signe', 400], ['devis-converti', 400], [INEXISTANT, 404]]) {
        ajouterDeuxCles('devis:write', 'PUT /api/v1/devis/:id/statut', cible, 'défaut, corps statut=ENVOYE', v1(`/devis/${devis(cible)}/statut`), () => ({ statut: 'ENVOYE' }), { code });
      }
      // Conversion (G2) : en chantier, montants relus (devis-signe-prix-achat et devis-signe du jeu) ; en intervention ou en
      // contrat, refusée à une clé (devis/routes.ts:321-322, limite de D1a-2) ; en chantier avec un champ d'ouverture
      // (devis/routes.ts:318-319, refus selon le corps) ; devis brouillon, converti, inexistant (400, hors droits, #426).
      const conversion = [
        ['devis-signe-prix-achat', 'corps cible=CHANTIER', () => ({ cible: 'CHANTIER' }), 201, { genre: 'conversion', attendu: MONTANTS.conversion }],
        ['devis-signe-prix-achat', 'corps cible=INTERVENTION', () => ({ cible: 'INTERVENTION' }), 403, null],
        ['devis-signe-prix-achat', 'corps cible=CONTRAT', () => ({ cible: 'CONTRAT' }), 403, null],
        ['devis-signe-prix-achat', 'corps cible=CHANTIER et titulaire', () => ({ cible: 'CHANTIER', responsableId: comptes.CT.id }), 403, null],
        ['devis-signe-prix-achat', 'corps cible=CHANTIER et date de début', () => ({ cible: 'CHANTIER', dateDebut: d.aujourdhui }), 403, null],
        ['devis-signe', 'corps cible=CHANTIER', () => ({ cible: 'CHANTIER' }), 201, { genre: 'conversion', attendu: MONTANTS.conversionSigne }],
        ['devis-brouillon', 'corps cible=CHANTIER', () => ({ cible: 'CHANTIER' }), 400, null],
        ['devis-converti', 'corps cible=CHANTIER', () => ({ cible: 'CHANTIER' }), 409, null],
        [INEXISTANT, 'corps cible=CHANTIER', () => ({ cible: 'CHANTIER' }), 400, null],
      ];
      for (const [cible, contexte, corps, code, montant] of conversion) {
        ajouterDeuxCles('devis:write', 'POST /api/v1/devis/:id/convertir', cible, `défaut, ${contexte}`, v1(`/devis/${devis(cible)}/convertir`), corps, { code, montant });
      }

      // §6, actions (b) : chaque cible réelle de la famille de la route, et des cibles propres. La clé du scope un à un (et
      // avec finances:read quand la réponse porte un montant), les 12 autres clés à un scope en lots.
      const sourceDe = (nom) => async () => ({ totaux: await ligneDe('instantane', 'Devis', devis(nom), TOTAUX_DEVIS), lignes: await lignesDuDevis('instantane', devis(nom)) });
      const equipement = (nom) => (P[nom] ? { clientId: d.clientActif, id: P[nom] } : cibleDe('equipement', nom).ids);
      const ACTIONS = [
        { route: 'DELETE /api/v1/clients/:id', scope: 'clients:write', cibles: [
          ['client-actif', v1(`/clients/${client('client-actif')}`), 200, null],
          ['client-desactive', v1(`/clients/${client('client-desactive')}`), 200, null],
        ] },
        { route: 'POST /api/v1/clients/:clientId/equipements/:id/archiver', scope: 'equipements:write', cibles: ['equipement-client-actif', 'equipement-autre-client', 'equipement-prix-achat'].map((nom) => {
          const ids = equipement(nom);
          return [nom, v1(`/clients/${ids.clientId}/equipements/${ids.id}/archiver`), nom === 'equipement-autre-client' ? 404 : 200, null];
        }) },
        { route: 'DELETE /api/v1/catalogue/:family/:id', scope: 'catalogue:write', cibles: [
          // Désactivation : prix gardés (relus égaux à l'instantané) ; main d'œuvre refusée à une clé (main-oeuvre.ts:241).
          ['prestation-catalogue', ficheCat('prestations', prestationCatalogue), 200, { genre: 'fiche', fiche: prestationCatalogue, attendu: {} }],
          ['prestation-prix-achat', ficheCat('prestations', P['prestation-prix-achat']), 200, { genre: 'fiche', fiche: P['prestation-prix-achat'], attendu: {} }],
          ['main-oeuvre-catalogue', ficheCat('prestations', P['main-oeuvre-catalogue']), 403, null],
        ] },
        { route: 'POST /api/v1/devis/:id/revisions', scope: 'devis:write', cibles: [
          // Révision : copie à l'identique de la source relue dans l'instantané (acompte constaté, taux copié, prix d'achat,
          // prix figé et minutes des lignes ; pas et minimum figés du temps passé, devis/routes.ts:130) ; refus d'un
          // brouillon et d'un devis converti (409).
          ['devis-brouillon', v1(`/devis/${devis('devis-brouillon')}/revisions`), 409, null],
          ['devis-signe', v1(`/devis/${devis('devis-signe')}/revisions`), 201, { genre: 'copie', source: sourceDe('devis-signe') }],
          ['devis-converti', v1(`/devis/${devis('devis-converti')}/revisions`), 409, null],
          ['devis-signe-prix-achat', v1(`/devis/${devis('devis-signe-prix-achat')}/revisions`), 201, { genre: 'copie', source: sourceDe('devis-signe-prix-achat') }],
          ['devis-signe-temps-passe', v1(`/devis/${devis('devis-signe-temps-passe')}/revisions`), 201, { genre: 'copie', source: sourceDe('devis-signe-temps-passe') }],
        ] },
      ];
      for (const { route, scope, cibles } of ACTIONS) {
        const groupe = groupeDeRouteEcriture(route);
        const lot = [];
        for (const [cible, chemin, code, montant] of cibles) {
          if (groupe) ajouterDeuxCles(scope, route, cible, 'défaut', chemin, corpsVide, { code, montant, action: true });
          else ajouter(nomCle(scope), route, cible, 'défaut', chemin, corpsVide, { code, montant, action: true });
          for (const autre of scopes.filter((s) => s !== scope)) lot.push({ compte: nomCle(autre), route, cible, contexte: 'défaut', chemin, corps: corpsVide, code: 403, refusAttendu: `Scope requis : ${scope}`, action: true, groupe, voit: false, montant: null });
        }
        lots.push({ route, lot });
      }
    }

    // Avenant, section 1 : « les fichiers de D1a-5 l'exigent et échouent avec un message clair si le rôle de
    // TEST_DATABASE_URL ne peut pas poser ce paramètre — jamais de SKIP ».
    test('rôle PostgreSQL : le rôle de TEST_DATABASE_URL peut poser session_replication_role, sans quoi la base ne peut pas être remise en état entre deux cas (échec clair, jamais un SKIP)', () => {
      if (refusRole) throw refusRole;
    });

    // Cadrage §3 (« chaque attendu est écrit en dur, avec la lecture écartée en commentaire, et vérifié par un test
    // témoin ») ; leçons de D1a-5d-1 et D1a-5d-2 : chaque attendu relu est recalculé, et chaque copie ou duplication est
    // éprouvée par une lecture inverse que les tests distinguent (C1 de l'audit des montants de #465).
    testPrepare('témoin des montants : chaque attendu recalculé en décimal exact, chaque lecture écartée distincte, sources copiées ou figées changées après coup et relues en base', () => {
      const t = d.temoin;
      // Ligne d'un devis créé ou modifié par une clé : HT, TTC de ligne et totaux du devis.
      const l = MONTANTS.ligne;
      const ht = exact.ligneHt(l.quantite, l.prixUnitaireHt);
      const tva = exact.tva(ht, l.tauxTva);
      assert.deepEqual([MONTANTS.ligneHt, MONTANTS.devisTva, MONTANTS.ligneTtc], [exact.euros(ht), exact.euros(tva), exact.euros(exact.ttcLigne(ht, l.tauxTva))], 'ligne et totaux d’un devis créé ou modifié');
      assert.equal(exact.euros(ht + tva), MONTANTS.ligneTtc, 'TTC du devis égal au TTC de sa ligne unique');
      assert.notEqual(Math.round(l.quantite * l.prixUnitaireHt * 100) / 100, MONTANTS.ligneHt, 'lecture écartée : calcul flottant de la ligne');
      assert.notEqual(exact.euros(arrondiAuPair(enUnites(l.quantite, 3) * enUnites(l.prixUnitaireHt, 2) / 100n)), MONTANTS.ligneHt, 'lecture écartée : arrondi au pair de la ligne');
      // Prix d'achat et minutes d'une ligne : copiés de la fiche du jour (41,17 et 50) par un devis créé par clé ; gardés
      // (38,62 et 45, copie d'origine) quand la ligne existante est modifiée par clé. La fiche, changée après coup, est relue.
      assert.deepEqual(t.prestation, { prixVenteHt: MONTANTS.ficheVente, prixAchatHt: MONTANTS.ficheAchat, dureeIndicativeMin: MONTANTS.ficheDuree }, 'fiche prestation-prix-achat : prix et durée du jour relus en base');
      assert.deepEqual([t.devisPa.lignes[0].prixAchatUnitaireHt, t.devisPa.lignes[0].minutesPrevuesUnite], [MONTANTS.ficheAchatInitial, MONTANTS.ficheDureeInitiale], 'ligne de devis-prix-achat : prix d’achat et minutes copiés de la fiche avant son changement');
      const prixAchat = [MONTANTS.ficheAchat, MONTANTS.ficheAchatInitial, MONTANTS.prixAchatLigne, MONTANTS.ficheVente, null];
      assert.equal(new Set(prixAchat.map(String)).size, prixAchat.length, 'lectures écartées du prix d’achat d’une ligne : fiche du jour, copie d’origine, saisie, prix de vente, non copié, tous distincts');
      const minutes = [MONTANTS.ficheDuree, MONTANTS.ficheDureeInitiale, 0, null];
      assert.equal(new Set(minutes.map(String)).size, minutes.length, 'lectures écartées des minutes prévues d’une ligne : fiche du jour, copie d’origine, sans durée, non copiées, toutes distinctes');
      // devis-signe-prix-achat : lignes relues en base, recalculées en décimal exact ; copies figées distinctes des sources
      // du jour (article et main d'œuvre changés après la signature).
      const s = MONTANTS.devisSigneLignes;
      assert.deepEqual(t.devisSigne.lignes.map(({ nature: _n, ...reste }) => reste), s, 'lignes de devis-signe-prix-achat relues en base');
      assert.deepEqual(s.map((x) => [x.totalHt, x.totalTtc]), s.map((x) => exact.ligneHt(x.quantite, x.prixUnitaireHt)).map((h) => [exact.euros(h), exact.euros(exact.ttcLigne(h, 20))]), 'lignes de devis-signe-prix-achat : HT et TTC recalculés');
      assert.equal(s[3].prixUnitaireHt, MONTANTS.mainOeuvreDuDevisInitial.prixJourHorsContratHt, 'ligne au jour : prix de la main d’œuvre copié à son ajout');
      assert.equal(s[3].minutesPrevuesUnite, MONTANTS.mainOeuvreDuDevisInitial.heuresParJour * 60, 'ligne au jour : heures par jour copiées en minutes');
      assert.deepEqual(t.article, { prixVenteHt: MONTANTS.articleVente, prixAchatHt: MONTANTS.articleAchat }, 'article-prix-achat changé après la signature');
      assert.deepEqual(t.mainOeuvreDuDevis, { prixJourHorsContratHt: MONTANTS.mainOeuvreDuDevis.prixJourHorsContratHt, heuresParJour: MONTANTS.mainOeuvreDuDevis.heuresParJour }, 'main-oeuvre-du-devis changée après la signature');
      // Révision par clé (copie de devis-signe-prix-achat relue dans l'instantané) : chaque lecture inverse de la copie
      // donne une valeur distincte de la source (leçon C1 de l'audit des montants de #465).
      assert.notEqual(s[0].prixAchatUnitaireHt, t.article.prixAchatHt, 'révision, lecture écartée : prix d’achat relu sur l’article du jour');
      assert.notEqual(s[3].prixUnitaireHt, t.mainOeuvreDuDevis.prixJourHorsContratHt, 'révision, lecture écartée : prix de la ligne au jour relu sur la main d’œuvre du jour');
      assert.notEqual(s[3].minutesPrevuesUnite, t.mainOeuvreDuDevis.heuresParJour * 60, 'révision, lecture écartée : minutes relues sur les heures par jour du jour');
      assert.ok(t.devisSigne.acompteExige && t.devisSigne.statut === 'ACCEPTE', 'devis-signe-prix-achat : acompte exigé, accepté et signé');
      assert.equal(t.devisSigne.acompteMontant, MONTANTS.acompteConstate, 'devis-signe-prix-achat : acompte constaté relu en base (lecture écartée : la révision qui ne le reprend pas, null)');
      assert.ok(MONTANTS.acompteConstate !== Math.round(MONTANTS.acompteConstate), 'acompte constaté : pas un nombre d’euros entier');
      assert.notEqual(exact.euros(auCentime(enUnites(t.devisSigne.totalTtc, 2) * enUnites(t.devisSigne.tauxAcompte, 2), 10000n)), MONTANTS.acompteConstate, 'acompte constaté, lecture écartée : taux d’acompte appliqué au TTC');
      assert.equal(t.devisSigne.tauxAcompte, d.tauxAcompteInitial, 'devis-signe-prix-achat : taux d’acompte copié du réglage à sa création');
      assert.equal(t.tauxAcompteDuJour, MONTANTS.tauxAcompteDuJour, 'taux d’acompte par défaut du jour relu en base');
      assert.notEqual(t.devisSigne.tauxAcompte, MONTANTS.tauxAcompteDuJour, 'révision, lecture écartée : taux d’acompte relu du jour');
      // Révision par clé de devis-signe-temps-passe (copie relue dans l'instantané) : pas et minimum figés relus en base,
      // distincts de chaque lecture inverse de la copie (non copiés, réglages du jour, minimum par défaut) ; ligne au prix
      // figé de la main d'œuvre, recalculée en décimal exact, distincte du prix du jour.
      const tp = MONTANTS.tempsPasse;
      const dt = t.devisTempsPasse;
      assert.ok(dt.auTempsPasse && dt.statut === 'ACCEPTE', 'devis-signe-temps-passe : au temps passé, accepté et signé');
      assert.deepEqual([dt.pasTempsPasseMinutes, dt.tempsMinimumMinutes], [tp.pas, tp.minimum], 'devis-signe-temps-passe : pas et minimum figés à sa création, relus en base');
      assert.deepEqual(t.reglagesTempsPasse, [tp.pasDuJour, tp.minimumDuJour], 'pas et minimum du temps passé du jour (réglages de la société), relus en base');
      // Chaque lecture écartée diffère de la source, et la ligne copiée (en minutes) reste admise par la base sous elle
      // (minimum puis tranches du pas ; une heure au moins sans minimum) : la relecture des montants la distingue.
      const minutesTp = tp.quantite * 60;
      for (const [quoi, pas, minimum] of [['minimum non copié', tp.pas, null], ['réglages du jour', tp.pasDuJour, tp.minimumDuJour], ['minimum par défaut', tp.pas, tp.minimumParDefaut]]) {
        assert.ok(pas !== dt.pasTempsPasseMinutes || minimum !== dt.tempsMinimumMinutes, `révision de devis-signe-temps-passe, lecture écartée : ${quoi}`);
        assert.ok(minimum === null ? minutesTp >= 60 : minutesTp >= minimum && (minutesTp - minimum) % pas === 0, `révision de devis-signe-temps-passe, lecture écartée (${quoi}) : ligne copiée admise par la base`);
      }
      assert.ok(tp.pas !== tp.pasDuJour && tp.minimum !== tp.minimumDuJour, 'révision de devis-signe-temps-passe : pas et minimum chacun distincts du réglage du jour');
      assert.equal((tp.minimum + tp.pas) / 60, tp.quantite, 'ligne au temps passé : le minimum puis une tranche du pas, en heures');
      assert.equal(dt.lignes.length, 1, 'devis-signe-temps-passe : une ligne');
      const lt = dt.lignes[0];
      const htTp = exact.ligneHt(tp.quantite, MONTANTS.mainOeuvreDuDevisInitial.prixVenteHt);
      assert.deepEqual([lt.quantite, lt.prixUnitaireHt, lt.tauxTva, lt.totalHt, lt.totalTtc, lt.prixAchatUnitaireHt], [tp.quantite, MONTANTS.mainOeuvreDuDevisInitial.prixVenteHt, 20, exact.euros(htTp), exact.euros(exact.ttcLigne(htTp, 20)), null], 'ligne au temps passé de devis-signe-temps-passe relue en base : prix horaire hors contrat de la main d’œuvre à sa création, HT et TTC recalculés');
      assert.deepEqual([dt.totalHt, dt.totalTva, dt.totalTtc], [tp.totalHt, tp.totalTva, tp.totalTtc], 'devis-signe-temps-passe : totaux relus en base');
      assert.deepEqual([tp.totalHt, tp.totalTva, tp.totalTtc], [exact.euros(htTp), exact.euros(exact.tva(htTp, 20)), exact.euros(exact.ttcLigne(htTp, 20))], 'devis-signe-temps-passe : totaux recalculés en décimal exact');
      assert.notEqual(Math.round(tp.quantite * MONTANTS.mainOeuvreDuDevisInitial.prixVenteHt * 100) / 100, tp.totalHt, 'ligne au temps passé, lecture écartée : calcul flottant');
      assert.notEqual(exact.euros(arrondiAuPair(enUnites(tp.quantite, 3) * enUnites(MONTANTS.mainOeuvreDuDevisInitial.prixVenteHt, 2) / 100n)), tp.totalHt, 'ligne au temps passé, lecture écartée : arrondi au pair');
      assert.equal(t.mainOeuvreDuDevisVente, MONTANTS.mainOeuvreDuDevis.prixVenteHt, 'main-oeuvre-du-devis : prix horaire hors contrat changé après la signature, relu en base');
      assert.notEqual(exact.euros(exact.ligneHt(tp.quantite, t.mainOeuvreDuDevisVente)), lt.totalHt, 'révision de devis-signe-temps-passe, lecture écartée : ligne au prix du jour de la main d’œuvre');
      // Conversions : chaque montant du chantier recalculé depuis les lignes relues (devis/routes.ts:401-411).
      const lignesSignees = t.devisSigne.lignes;
      assert.deepEqual(MONTANTS.conversion, conversionDe(lignesSignees), 'chantier ouvert par la conversion de devis-signe-prix-achat');
      assert.equal(MONTANTS.conversion.budgetGlobalVendu, t.devisSigne.totalHt, 'montant vendu attendu égal au total HT du devis relu');
      const total = lignesSignees.reduce((a, x) => a + enUnites(x.totalHt, 2), 0n);
      const coutGlobal = auCentime(lignesSignees.filter((x) => x.prixAchatUnitaireHt !== null).reduce((a, x) => a + enUnites(x.quantite, 3) * enUnites(x.prixAchatUnitaireHt, 2), 0n), 1000n);
      const c = MONTANTS.conversion;
      for (const [ecartee, champ, quoi] of [
        [exact.euros(coutGlobal), 'coutMaterielPrevu', 'arrondi du total, et non de chaque ligne'],
        [exact.euros(exact.ligneHt(s[0].quantite, s[0].prixAchatUnitaireHt)), 'coutMaterielPrevu', 'fournitures seules'],
        [exact.euros(exact.ligneHt(s[0].quantite, t.article.prixAchatHt) + exact.ligneHt(s[1].quantite, s[1].prixAchatUnitaireHt)), 'coutMaterielPrevu', 'prix d’achat de l’article du jour'],
        [exact.euros(exact.ligneHt(s[0].quantite, s[0].prixAchatUnitaireHt) + exact.ligneHt(s[1].quantite, s[1].prixAchatUnitaireHt) + enUnites(s[2].totalHt, 2)), 'coutMaterielPrevu', 'ligne sans prix d’achat comptée à son prix de vente'],
        [exact.euros(total - enUnites(s[3].totalHt, 2) + exact.ligneHt(s[3].quantite, t.mainOeuvreDuDevis.prixJourHorsContratHt)), 'budgetGlobalVendu', 'prix du jour de la main d’œuvre'],
        [exact.euros(auCentime(enUnites(s[1].quantite, 3) * 6000n + enUnites(s[3].quantite, 3) * enUnites(t.mainOeuvreDuDevis.heuresParJour * 60, 2), 60000n)), 'heuresVendues', 'heures par jour du jour'],
        [exact.euros(enUnites(t.devisSigne.totalTtc, 2)), 'budgetGlobalVendu', 'montant vendu au TTC'],
      ]) assert.notEqual(ecartee, c[champ], `conversion, lecture écartée : ${quoi}`);
      const jeu = t.devisSigneJeu.lignes;
      assert.deepEqual(MONTANTS.conversionSigne, conversionDe(jeu), 'chantier ouvert par la conversion de devis-signe (jeu de données), recalculé depuis ses lignes relues');
      assert.ok(jeu.length === 1 && jeu[0].nature === 'MAIN_OEUVRE' && jeu[0].minutesPrevuesUnite === null && jeu[0].prixAchatUnitaireHt === null, 'devis-signe : une ligne de main-d’œuvre, sans minutes ni prix d’achat');
      assert.notEqual(MONTANTS.conversionSigne.budgetGlobalVendu, t.devisSigneJeu.totalTtc, 'conversion de devis-signe, lecture écartée : montant vendu au TTC');
      assert.notEqual(MONTANTS.conversionSigne.heuresVendues, 0, 'conversion de devis-signe, lecture écartée : ligne sans minutes comptée zéro heure');
      // Fiches écrites par une clé : TVA distincte du taux par défaut, prix d'achat et durée non nuls, prix tous distincts
      // entre eux et des prix existants.
      for (const [quoi, f] of [['prestation', MONTANTS.prestationCree], ['article', MONTANTS.articleCree], ['modèle', MONTANTS.modeleCree]]) assert.notEqual(f.tauxTva, 20, `${quoi} créé par clé, lecture écartée : TVA par défaut`);
      assert.ok([MONTANTS.prestationCree, MONTANTS.articleCree, MONTANTS.modeleCree].every((f) => f.prixAchatHt !== null && f.prixAchatHt !== Math.round(f.prixAchatHt)), 'fiches créées par clé, lecture écartée : prix d’achat ignoré (null) ou arrondi');
      assert.ok(MONTANTS.prestationCree.dureeIndicativeMin !== null && MONTANTS.prestationCree.dureeIndicativeMin !== MONTANTS.ficheDuree, 'prestation créée par clé : durée indicative ni ignorée, ni celle d’une autre fiche');
      const prix = [MONTANTS.prestationCree.prixVenteHt, MONTANTS.prestationCree.prixAchatHt, MONTANTS.articleCree.prixVenteHt, MONTANTS.articleCree.prixAchatHt, MONTANTS.modeleCree.prixVenteHt, MONTANTS.modeleCree.prixAchatHt, MONTANTS.prestationCatalogue.prixVenteHt, MONTANTS.ficheAchatModifie, MONTANTS.ficheAchat, MONTANTS.ficheAchatInitial, MONTANTS.ficheVente, MONTANTS.articleAchat, MONTANTS.articleVente, MONTANTS.modeleAchat];
      assert.equal(new Set(prix).size, prix.length, 'prix des fiches écrits par clé distincts entre eux et des prix existants');
      assert.deepEqual(t.prestationCatalogue, { prixVenteHt: MONTANTS.ficheVente, prixAchatHt: null, dureeIndicativeMin: null, tauxTva: 20 }, 'prestation-catalogue (jeu de données) : prix de vente 100, TVA 20 %, sans prix d’achat ni durée, relue en base');
      for (const champ of ['prixVenteHt', 'tauxTva', 'dureeIndicativeMin']) assert.notEqual(MONTANTS.prestationCatalogue[champ], t.prestationCatalogue[champ], `PUT de prestation-catalogue, lecture écartée : ${champ} gardé`);
      assert.equal(t.modele.prixAchatHt, MONTANTS.modeleAchat, 'modèle à prix d’achat relu en base');
      assert.deepEqual(t.mainOeuvre, MONTANTS.mainOeuvre, 'main-oeuvre-catalogue : prix et heures relus en base');
      // Aucune clé n'a été utilisée avant l'instantané : la dernière utilisation de chacune est vide.
      assert.ok(t.usages.every((u) => u === null), 'aucune clé utilisée avant l’instantané');
    });

    // Cadrage §6 : outils. entreesNouvelles ignore la seule dernière utilisation d'une clé ; garde « aucun montant » qui
    // admet une cible citant une route /api/v1 et le nom d'une clé joué ; annotations G7 et G8 retirées.
    testPrepare('outils : la dernière utilisation d’une clé n’est pas une entrée, une révocation en reste une ; la garde « aucun montant » admet une route /api/v1 citée et le nom d’une clé jouée, et refuse tout montant ; annotations de G7 et G8 retirées', async () => {
      // Dernière utilisation : un appel admis la note, l'empreinte voit ApiAccessKey changer, entreesNouvelles ne rend rien.
      assert.deepEqual(COLONNES_HORS_ENTREE, { ApiAccessKey: ['dernierUsageLe'] }, 'seule la dernière utilisation d’une clé est hors des entrées');
      const lectureClients = cles[nomCle('clients:read')];
      const envoi = Date.now();
      const res = await appeler(appli.adresse, 'GET', '/api/v1/clients', { autorisation: lectureClients.autorisation });
      assert.equal(res.status, 200);
      await remise.attendreDernierUsage(lectureClients.id, envoi, 'témoin de la dernière utilisation');
      assert.deepEqual(remise.changees(await remise.empreinte()), ['ApiAccessKey'], 'témoin : seule ApiAccessKey change, par la dernière utilisation');
      assert.deepEqual(await entreesNouvelles(lecture), [], 'la dernière utilisation d’une clé n’est pas une entrée de l’historique des clés');
      const [{ n }] = await q(`SELECT count(*)::int AS n FROM public."ApiAccessKey" t JOIN ${S}."ApiAccessKey" s ON s.id = t.id WHERE to_jsonb(t) IS DISTINCT FROM to_jsonb(s)`);
      assert.equal(n, 1, 'témoin : la ligne de la clé a bien changé (comparaison entière, sans exclusion)');
      await remise.remettre(remise.changees(await remise.empreinte()), 'témoin de la dernière utilisation');
      // Révocation par le super administrateur : elle reste une entrée de l'historique des clés, avec son journal.
      const revoquee = cles[nomCle('company:read')];
      await api(SA, 'POST', `/api/admin/api-keys/${revoquee.id}/revoke`, {});
      const entrees = (await entreesNouvelles(lecture)).map((e) => nommerEntree(e, noms)).sort();
      assert.deepEqual(entrees.filter((e) => e.startsWith('ApiAccessKey ')), ['ApiAccessKey CLE REVOCATION, créée par SA'], 'une révocation reste une entrée de l’historique des clés');
      await remise.remettre(remise.changees(await remise.empreinte()), 'témoin de la révocation');
      // Garde « aucun montant » (cadrage §3 et §6, #457 N2 et N7) sur les formes de ligne propres à ce fichier.
      const comptesGarde = [...COMPTES_JOUES, ...Object.keys(cles), 'CLE pilote:v2'];
      const garde = (ligne, options = {}) => lignesAvecMontant([ligne], { comptes: comptesGarde, journaux: true, comptesAChiffre: true, routesCles: true, ...options }).length === 1;
      const ecriture = 'CLE catalogue:write | DELETE /api/v1/catalogue/:family/:id | main-oeuvre-catalogue | défaut | 200 écrit (CataloguePrestation,JournalAdministration) ; entrées : JournalAdministration MAIN_OEUVRE DESACTIVATION par DEMARRAGE ; réponse : prixAchatHt absent ; prix de la fiche relus en base conformes';
      const lectureEntree = 'AD | GET /api/journal-administration | JournalAdministration MAIN_OEUVRE DESACTIVATION par DEMARRAGE ← CLE catalogue:write DELETE /api/v1/catalogue/:family/:id sur main-oeuvre-catalogue | défaut | 200 visible';
      const refusPorte = 'CLE company:read | DELETE /api/v1/clients/:id | client-actif | défaut | 403 « Scope requis : clients:write » inchangé ; aucune entrée ; montants inchangés en base';
      const cleAChiffre = 'SA | GET /api/journal-administration | JournalAdministration MAIN_OEUVRE DESACTIVATION par DEMARRAGE ← CLE pilote:v2 DELETE /api/v1/catalogue/:family/:id sur main-oeuvre-catalogue | défaut | 200 visible';
      for (const ligne of [ecriture, lectureEntree, refusPorte, cleAChiffre]) assert.equal(garde(ligne), false, `garde, forme admise : ${ligne}`);
      for (const [ligne, quoi] of [
        [ecriture.replace('prixAchatHt absent', 'prixAchatHt 8.88'), 'montant en chiffres dans la réponse observée'],
        [ecriture.replace('prix de la fiche relus en base conformes', 'prix de la fiche 42,18 €'), 'montant en euros dans le constat'],
        [lectureEntree.replace('/api/v1/', '/api/v2/'), 'autre chiffre qu’un préfixe /api/v1 dans la cible'],
        [lectureEntree.replace('sur main-oeuvre-catalogue', 'sur main-oeuvre-catalogue 12,50'), 'montant dans la cible d’une lecture par clé'],
        [cleAChiffre.replace('CLE pilote:v2', 'CLE pilote:v3'), 'nom d’une clé à chiffre qui n’est pas jouée'],
        [refusPorte.replace('CLE company:read', 'CLE inconnue:read'), 'clé qui n’est pas jouée'],
      ]) assert.equal(garde(ligne), true, `garde, ${quoi} : refusé`);
      // Sans l'option `routesCles`, la garde est celle de D1a-5c à D1a-5d-2 : une route /api/v1 citée y reste refusée.
      assert.equal(garde(lectureEntree, { routesCles: false }), true, 'garde sans l’option routesCles : comportement de D1a-5c à D1a-5d-2 inchangé');
      assert.equal(lignesAvecMontant([lectureEntree], { comptes: comptesGarde }).length, 1, 'comportement par défaut de lignesAvecMontant inchangé');
      // Annotations : celles de G7 et G8 côté « ne voit pas » sont retirées (cadrage §5.2 et §6) ; groupe de chaque route
      // /api/v1 jouée ici.
      const annotations = MONTANTS_MASQUES_ECRITURES.flatMap((g, i) => g.annotations.map((a) => `G${i + 1} ${a.champs.join('+')} ${a.cote}`));
      assert.deepEqual(annotations, ['G1 budgetMaterielVendu+budgetMainOeuvreVendu ne voit pas', 'G4 intervenant.tauxHoraireCharge voit', 'G5 tauxHoraireApplique+prixVenteHoraireApplique voit', 'G6 montantHT ne voit pas'], 'annotations des 8 groupes, sans G7 ni G8');
      const groupes = Object.fromEntries(Object.keys(ROUTES_CLES).filter((r) => !r.startsWith('GET ')).map((r) => [r, groupeDeRouteEcriture(r)]).filter(([, g]) => g));
      assert.deepEqual(groupes, {
        'POST /api/v1/clients/:clientId/equipements': 8, 'POST /api/v1/clients/:clientId/equipements/:id/archiver': 8,
        'POST /api/v1/catalogue/:family': 7, 'PUT /api/v1/catalogue/:family/:id': 7, 'DELETE /api/v1/catalogue/:family/:id': 7,
        'POST /api/v1/devis': 3, 'PATCH /api/v1/devis/:id': 3, 'POST /api/v1/devis/:id/revisions': 3, 'PUT /api/v1/devis/:id/statut': 3,
        'POST /api/v1/devis/:id/convertir': 2,
      }, 'routes /api/v1 des groupes 2, 3, 7 et 8');
    });

    // Cadrage §6 et avenant, section 3 : chaque écriture /api/v1 jouée ; (a) par la clé de son scope sur chaque cible de sa
    // famille ; (b) par chacune des 13 clés à un scope sur chaque cible réelle de sa famille ; avec finances:read pour une
    // route des groupes.
    testPrepare('couverture des cas : chacune des 18 écritures /api/v1 jouée, (a) par la clé de son scope sur chaque cible de sa famille, (b) par chacune des 13 clés à un scope sur chaque cible réelle, et par la clé avec finances:read sur chaque route des groupes 2, 3, 7 et 8', (t) => {
      const ecritures = Object.entries(ROUTES_CLES).filter(([r]) => !r.startsWith('GET '));
      assert.equal(ecritures.length, 18, 'écritures /api/v1 de ROUTES_CLES');
      const joues = [...cas, ...lots.flatMap((l) => l.lot)];
      const manquants = [];
      for (const [route, definition] of ecritures) {
        const deLaRoute = joues.filter((c) => c.route === route);
        const cibles = definition.famille ? FAMILLES[definition.famille].cibles.map((c) => c.nom) : null;
        if (definition.ecriture === 'a') {
          if (!deLaRoute.some((c) => c.compte === nomCle(definition.scope))) manquants.push(`${route} : aucun cas de ${nomCle(definition.scope)}`);
          for (const cible of cibles ?? []) if (!deLaRoute.some((c) => c.compte === nomCle(definition.scope) && c.cible === cible)) manquants.push(`${route} : ${cible} non jouée par ${nomCle(definition.scope)}`);
          if (deLaRoute.some((c) => !cles[c.compte].scopes.includes(definition.scope))) manquants.push(`${route} : jouée par une clé refusée à la porte (R-I)`);
        } else {
          for (const cible of cibles.filter((c) => c !== INEXISTANT)) {
            for (const scope of scopes) if (!deLaRoute.some((c) => c.compte === nomCle(scope) && c.cible === cible)) manquants.push(`${route} : ${cible} non jouée par ${nomCle(scope)}`);
          }
        }
        if (groupeDeRouteEcriture(route)) {
          for (const c of deLaRoute.filter((x) => x.compte === nomCle(definition.scope))) {
            if (!deLaRoute.some((x) => x.compte === nomCle(definition.scope, true) && x.cible === c.cible && x.contexte === c.contexte)) manquants.push(`${route} : ${c.cible} (${c.contexte}) non jouée avec finances:read`);
          }
        }
      }
      assert.deepEqual(manquants, [], 'écritures /api/v1 non couvertes');
      const unAUn = cas.length;
      const enLots = lots.reduce((a, l) => a + l.lot.length, 0);
      diagnostics.push(`cas un à un : ${unAUn} (routes (a) ${cas.filter((c) => !c.action).length}, actions (b) ${cas.filter((c) => c.action).length}, relecture propre d’un montant ${cas.filter((c) => c.montant).length}) ; refus des actions (b) en lots : ${enLots}`);
      t.diagnostic(diagnostics.at(-1));
    });

    // Cadrage §6 : chaque cas, son empreinte, ses entrées (aucune attendue), sa réponse observée, ses montants, la base
    // remise ; les refus des actions (b) en lots.
    testPrepare('écritures : routes (a) par la clé de leur scope, actions (b) par chacune des 13 clés ; entrées nommées, montants relus, base remise en état après chaque cas', async () => {
      for (const c of cas) await jouer(c);
      for (const { route, lot } of lots) await jouerLot(route, lot);
    });

    // Cadrage §6 : réponses attendues (limites de D1a-2, refus selon le corps, prix d'achat prévu, refus de la porte), et
    // chaque refus « inchangé ».
    testPrepare('réponses attendues : limites de D1a-2 (conversion en intervention ou en contrat, main d’œuvre existante), refus selon le corps (ouverture du chantier, main d’œuvre, prix d’achat prévu), refus de la porte « Scope requis », chaque refus inchangé', () => {
      const ecarts = [];
      for (const c of [...cas, ...lots.flatMap((l) => l.lot)].filter((x) => x.code !== null)) {
        const r = c.reponse ?? '';
        if (!r.startsWith(`${c.code} `)) ecarts.push(`${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : attendu ${c.code}, obtenu « ${r} »`);
        else if (c.code >= 300 && !/ inchangé ; aucune entrée( ; |$)/.test(r)) ecarts.push(`${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : refus qui écrit`);
        else if (c.refusAttendu && !r.startsWith(`403 « ${c.refusAttendu} » inchangé`)) ecarts.push(`${c.compte} ${c.route} sur ${c.cible} : refus de la porte attendu (${c.refusAttendu}), obtenu « ${r} »`);
      }
      const REFUS = {
        'conversion en intervention ou en contrat': [/^POST \/api\/v1\/devis\/:id\/convertir$/, /cible=(INTERVENTION|CONTRAT)$/, '403 « Une intervention ou un contrat ne se crée depuis un devis que dans une session de l’application. » inchangé'],
        'main d’œuvre existante, corps ordinaire': [/^PUT \/api\/v1\/catalogue\/:family\/:id$/, /^défaut, corps prestation ordinaire$/, '403 « Une clé d’intégration ne crée, ne modifie, ne désactive ni ne réactive une main d’œuvre, et ne fait pas passer une prestation en main d’œuvre ou l’inverse : réservé à l’administration, en session. » inchangé', 'main-oeuvre-catalogue'],
        'main d’œuvre existante, désactivation': [/^DELETE \/api\/v1\/catalogue\/:family\/:id$/, /^défaut$/, '403 « Une clé d’intégration ne crée, ne modifie, ne désactive ni ne réactive une main d’œuvre, et ne fait pas passer une prestation en main d’œuvre ou l’inverse : réservé à l’administration, en session. » inchangé', 'main-oeuvre-catalogue'],
        'corps de main d’œuvre': [/^(POST|PUT) \/api\/v1\/catalogue\/:family(\/:id)?$/, /corps main d’œuvre$/, '403 « Une clé d’intégration ne crée, ne modifie, ne désactive ni ne réactive une main d’œuvre, et ne fait pas passer une prestation en main d’œuvre ou l’inverse : réservé à l’administration, en session. » inchangé'],
        'champs d’ouverture du chantier': [/^POST \/api\/v1\/devis\/:id\/convertir$/, /cible=CHANTIER et /, '403 « Seule l’administration choisit le titulaire, le commercial, les types et la date de début à l’ouverture du chantier ; ils se modifient ensuite depuis sa fiche. » inchangé'],
        'prix d’achat prévu': [/^(POST|PATCH) \/api\/v1\/devis(\/:id)?$/, /au prix d’achat prévu$/, '403 « Le prix d’achat prévu est réservé aux administrateurs. » inchangé'],
      };
      for (const [quoi, [route, contexte, debut, cible]] of Object.entries(REFUS)) {
        const vises = cas.filter((c) => route.test(c.route) && contexte.test(c.contexte) && (!cible || c.cible === cible));
        if (vises.length < 2) ecarts.push(`${quoi} : ${vises.length} cas, attendu au moins deux (clé avec et sans finances:read)`);
        for (const c of vises) if (!(c.reponse ?? '').startsWith(debut)) ecarts.push(`${quoi} : ${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : « ${c.reponse} »`);
      }
      assert.deepEqual(ecarts, [], 'réponses différentes de l’attendu');
    });

    // Cadrage §3 : chaque écriture de montant admise relue conforme ; chaque refus et chaque écriture sans montant
    // laissent les montants inchangés.
    testPrepare('montants relus en base : écritures de montant admises par clé conformes à l’attendu ou à leur source, refus et écritures sans montant sans changement de montant', () => {
      const ecarts = [];
      for (const c of [...cas, ...lots.flatMap((l) => l.lot)]) {
        const r = c.reponse ?? '';
        const attendu = c.montant && /^2\d\d /.test(r) ? CONSTATS_CONFORMES[c.montant.genre] : MONTANTS_INCHANGES;
        if (!r.endsWith(` ; ${attendu}`)) ecarts.push(`${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : constat des montants « ${r} »`);
      }
      assert.deepEqual(ecarts, [], 'montants différents de l’attendu');
      const relues = cas.filter((c) => c.montant && /^2\d\d /.test(c.reponse ?? '')).length;
      diagnostics.push(`montants relus : ${chiffres.montants} constats un à un, dont ${relues} écritures de montant admises relues à leur attendu et ${chiffres.montants - relues} montants relus inchangés ; ${chiffres.refusEnLots} refus en lots, montants relus inchangés par lot`);
    });

    // Cadrage §6 et §5.2 (classement C) : pour chaque couple (groupe, champ) des groupes 2, 3, 7 et 8, une clé avec
    // finances:read l'a « présent » et une clé sans l'a « null » ou « absent » ; aucune clé sans finances:read ne l'a
    // « présent ». Le côté « ne voit pas » de G7 et G8, sans annotation désormais, est relu par le test de D1a-5d-2.
    testPrepare('montants masqués côté clé : chaque champ des groupes 2, 3, 7 et 8 présent pour une clé avec finances:read, masqué pour une clé sans, jamais présent sans finances:read', () => {
      const ecarts = [];
      const MASQUE = ['null', 'absent', 'non porté'];
      for (const groupe of [2, 3, 7, 8]) {
        const observes = cas.filter((c) => c.groupe === groupe && c.observation);
        for (const champ of MONTANTS_MASQUES_ECRITURES[groupe - 1].champs) {
          const obs = observes.map((c) => ({ c, etat: c.observation[champ] }));
          if (!obs.some((o) => o.c.voit && o.etat === 'présent')) ecarts.push(`G${groupe} ${champ} : aucune clé avec finances:read ne l’a présent`);
          if (!obs.some((o) => !o.c.voit && MASQUE.includes(o.etat))) ecarts.push(`G${groupe} ${champ} : aucune clé sans finances:read ne l’a masqué`);
          for (const o of obs.filter((x) => !x.c.voit && !MASQUE.includes(x.etat))) ecarts.push(`G${groupe} ${champ} : ${o.etat} pour ${o.c.compte} (${o.c.route}, ${o.c.cible}, ${o.c.contexte}), sans finances:read`);
        }
        for (const route of new Set(observes.map((c) => c.route))) {
          if (!observes.some((c) => c.route === route && c.voit) || !observes.some((c) => c.route === route && !c.voit)) ecarts.push(`G${groupe} ${route} : réponse observée pour une seule des deux clés`);
        }
      }
      assert.deepEqual(cas.filter((c) => c.groupe && ![2, 3, 7, 8].includes(c.groupe)).map((c) => c.route), [], 'aucune route /api/v1 hors des groupes 2, 3, 7 et 8');
      assert.deepEqual(ecarts, [], 'champs des groupes côté clé non observés, ou montant vu par une clé sans finances:read');
    });

    // Cadrage §6 : « Journal : aucune entrée pour une écriture par clé, enregistré tel quel » ; dernière utilisation notée
    // pour la seule clé admise par la porte (comme D1a-2), contrôlée à part.
    testPrepare('journal et dernière utilisation : aucune écriture par clé n’écrit d’entrée ; la dernière utilisation est notée pour la seule clé admise par la porte, jamais pour un refus de la porte', () => {
      const avecEntree = [...cas, ...lots.flatMap((l) => l.lot)].filter((c) => !/ ; aucune entrée( ; |$)/.test(c.reponse ?? ''));
      assert.deepEqual(avecEntree.map((c) => `${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : « ${c.reponse} »`), [], 'écritures par clé qui écrivent une entrée');
      assert.deepEqual(usagesEnEcart, [], 'dernière utilisation des clés');
      assert.equal(chiffres.lectures, 0, 'aucune entrée à lire');
    });

    // Cadrage §3 : la matrice obtenue est la référence, au caractère près ; aucune ligne ne porte de montant.
    testPrepare('la matrice obtenue est la référence matrice-droits/cles-montants.txt, chaque cas y a une ligne, aucune ligne ne porte de montant, et la base est revenue à l’état de référence', async (t) => {
      const clesDeLigne = lignes.map((l) => l.split(SEPARATEUR).slice(0, 4).join(SEPARATEUR));
      const doublons = clesDeLigne.filter((c, i) => clesDeLigne.indexOf(c) !== i);
      assert.deepEqual(doublons, [], 'chaque cas et chaque lecture n’ont qu’une ligne');
      assert.deepEqual(lignesAvecMontant(lignes, { comptes: [...COMPTES_JOUES, ...Object.keys(cles)], journaux: true, comptesAChiffre: true, routesCles: true }), [], 'lignes qui portent un montant, ou un nombre hors du code de la réponse et des comptes d’objets d’un refus');
      const etatFinal = remise.changees(await remise.empreinte());
      for (const texte of diagnostics) t.diagnostic(texte);
      t.diagnostic(`lignes : ${lignes.length} ; cas un à un ${chiffres.cas} ; lots ${chiffres.lots} (${chiffres.refusEnLots} refus${chiffres.lotsRejoues.length ? `, rejoués un à un : ${chiffres.lotsRejoues.join(' ; ')}` : ''}) ; lectures ${chiffres.lectures} ; remises ${remise.remises}`);
      t.diagnostic(`hors droits (pour #426) : ${horsDroits.length ? horsDroits.join(' ; ') : 'aucune réponse'}`);
      comparerAvecReference(lignes, REFERENCE, 'cles-montants.txt', { champsResume: 2 });
      assert.deepEqual(etatFinal, [], 'la base n’est pas revenue à l’état de référence après le dernier cas');
    });
  });
}
