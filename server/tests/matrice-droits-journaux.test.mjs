// Lot D1a-5c : journaux. Entrées écrites par chaque écriture jouée par D1a-5a et D1a-5b, et par les écritures qui
// journalisent sans y avoir été vues ; qui peut les lire ; génération des visites avec son réglage et le compte système ;
// montants relus en base ; base remise à l'état de référence entre deux cas. Tests seuls (cadrage de la sous-PR D1a-5c,
// version 3 du 02-11-2026, contrôlé par le controleur-coherence ; avenant au cadrage du lot D1a pour D1a-5, version 2 ;
// cadrage du lot D1a, version 3 du 01-11-2026).
//
// Tests seuls : ce fichier enregistre le comportement actuel, sans rien corriger (cadrage de 5c, §2.6). Il reprend les
// outils, les comptes, le jeu de données et la table des routes de D1a-1, l'outil de remise en état de D1a-5a, et les
// outils de lecture des journaux de matrice-droits/journaux.mjs (cadrage §3), que D1a-5d reprendra. Il enregistre :
//  - §2.1 : pour chaque couple (route, corps) qui écrit une table de journal dans ecritures-actions.txt ou
//    ecritures-modifications.txt, une écriture rejouée par SA, par AD et par un compte hors administration, choisis
//    parmi les comptes qui écrivent ce couple en 5a ou 5b (un test de couverture relit ces deux références) ; les
//    écritures jamais vues « écrit » en 5a et 5b (partage du planning, retrait du logo posé, accès financier et « aussi
//    commercial » qui changent, avancement de l'échéance d'un contrat dont la visite est terminée, rattachement au
//    chantier de l'intervention d'un devis déjà converti en intervention) ; les écritures sans entrée, enregistrées
//    telles quelles (« aucune entrée ») : écarts connus, état décidé, clôture et réouverture d'un chantier ;
//  - §2.2 : chaque entrée nouvelle lue par SA, par AD, par l'auteur s'il est hors administration, et par un compte
//    refusé par couple (route de lecture, dossier parent) ; l'export CSV du journal d'administration lu par SA et AD,
//    l'entrée y étant comptée par la fin de sa ligne, l'outil vérifiant d'abord qu'il reconnaît l'export du SA
//    (verifierLectureExport, T1 de l'audit des droits de #456, suivi #457, versé par D1a-5d-3) ; les filtres du journal
//    d'administration ;
//  - §2.3 : la génération des visites, réglage vide en témoin (D1a-1 l'enregistre), réglé à trente jours par AD, passage
//    manuel de chaque administrateur, refus des autres comptes, passage automatique au nom du compte système ;
//  - §2.4 : pour chaque écriture d'un achat, d'une heure, d'un coût SAV ou d'un barème de rémunération, le montant relu
//    en base, comparé au montant envoyé ou au taux source au moment de la saisie, et l'instantané de l'entrée comparé ;
//    le constat termine la ligne, sans chiffre.
// Une ligne d'écriture : compte (l'auteur), route, cible, contexte (« défaut, corps <nom> », ou ce qui précède
// l'écriture), réponse (code, et message exact d'un refus), « écrit (tables) » ou « inchangé », puis « entrées : … »
// ou « aucune entrée », et pour un montant le constat. Une ligne de lecture : compte (le lecteur), route de lecture,
// cible « entrée ← auteur route sur cible » (« préalable » devant l'entrée d'une écriture préalable lue), contexte de
// l'écriture, verdict (« 200 visible », « 200 absente », ou le refus). Jamais un montant (garde lignesAvecMontant
// d'outils.mjs, options `journaux` et `comptesAChiffre`, celle-ci versée par D1a-5d-3, N2 de #457). Le tout est comparé
// au caractère près à server/tests/matrice-droits/journaux.txt.
//
// Rôle PostgreSQL : comme D1a-5a et D1a-5b, la remise pose session_replication_role ; si le rôle de TEST_DATABASE_URL ne
// le peut pas, le test « rôle PostgreSQL » échoue avec un message clair, chacun des autres le cite, et aucune base n'est
// créée. Sans TEST_DATABASE_URL, le fichier s'annonce ignoré comme les autres fichiers de la matrice : un SKIP n'est pas
// une réussite. Ce fichier crée sa propre base jetable (iris_test_matrice_journaux_<hex>), la migre, la sert à
// l'application, puis la supprime.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import test, { after, before, describe } from 'node:test';
import { join } from 'node:path';
import {
  DOSSIER_MATRICES, EMAIL_SECOURS, JETON_SECOURS, SANS_CIBLE, SEPARATEUR, appeler, baseJetable, chargerApplication,
  comparerAvecReference, enParallele, formaterReponse, ligneMatrice, lignesAvecMontant, lireReference, tablesChangees,
  tablesDeLaBase,
} from './matrice-droits/outils.mjs';
import { COMPTES_JOUES, creerComptes } from './matrice-droits/comptes.mjs';
import { FAMILLES, SOCIETE, cheminPour, cibleDe, construireJeuDeDonnees, jourSociete } from './matrice-droits/donnees.mjs';
import { ROUTES_SESSION } from './matrice-droits/routes.mjs';
import { SCHEMA_INSTANTANE, creerRemiseEnEtat, exigerRoleReplication } from './matrice-droits/remise-en-etat.mjs';
import {
  AUTEUR_SYSTEME, TABLES_DE_JOURNAL, compterFinDeLigne, entreesNouvelles, finDeLigneCsv, lireExports, lireVisibilite,
  memeEntree, nommerEntree, ouvrirConnexionLecture, verifierLectureExport,
} from './matrice-droits/journaux.mjs';

const TITRE = 'Lot D1a-5c : journaux, entrées écrites par chaque écriture et qui peut les lire, génération des visites, montants relus en base, base remise en état entre deux cas';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const REFERENCE = join(DOSSIER_MATRICES, 'journaux.txt');
const REFERENCES_ECRITURES = [join(DOSSIER_MATRICES, 'ecritures-actions.txt'), join(DOSSIER_MATRICES, 'ecritures-modifications.txt')];
const SA = 'SA';
// Le directeur en fait partie depuis le lot « Directeur aligné sur l'administration » (décision de Nelson du 24-10-2026, point 14).
const ADMINISTRATION = ['SA', 'AD', 'AD-COM', 'DIR'];
// Gestion des contrats, passage manuel de la génération des visites compris : l'administration et l'assistante technique
// depuis AT-2a (cadrage v2, C1 ; réponse 9 du 06-11-2026, « Les gérer », dont la description nomme la génération des
// visites ; requireGestionContrats), dont le
// refus nomme l'une et l'autre. Le réglage de l'anticipation reste à l'administration (PUT /api/parametres).
const GESTION_CONTRATS = [...ADMINISTRATION, 'AT'];
const REFUS_GESTION_CONTRATS = '403 « Accès réservé à l’administration et à l’assistante technique. » inchangé ; aucune entrée';
const DESTINATAIRE = 'contact-matrice@iris.test';
const TRACE = { ratio: 2, traits: [[[0.1, 0.6], [0.25, 0.3], [0.4, 0.7], [0.6, 0.35]]] };
// JPEG 1 × 1 pixel minimal d'api.test.mjs, comme D1a-5b (corps « logo JPEG »).
const LOGO_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
// Logo posé avant l'instantané (cible propre « logo posé », cadrage §2.5) : un PNG 2 × 1, autre que le JPEG du corps de
// 5b, pour que le téléversement de ce JPEG change le logo et écrive son entrée, comme en 5b. Fabriqué comme dans
// api.test.mjs (CRC des morceaux PNG, norme PNG, annexe D).
const crc32 = (octets) => {
  let crc = 0xffffffff;
  for (const octet of octets) { crc ^= octet; for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
};
const morceauPng = (type, donnees) => {
  const longueur = Buffer.alloc(4); longueur.writeUInt32BE(donnees.length);
  const corps = Buffer.concat([Buffer.from(type, 'latin1'), donnees]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(corps));
  return Buffer.concat([longueur, corps, crc]);
};
const LOGO_PNG = (() => {
  const entete = Buffer.alloc(13); entete.writeUInt32BE(2, 0); entete.writeUInt32BE(1, 4); entete[8] = 8; entete[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), morceauPng('IHDR', entete), morceauPng('IDAT', deflateSync(Buffer.from([0, 15, 118, 110, 200, 200, 200]))), morceauPng('IEND', Buffer.alloc(0))]);
})();

// --- Montants des corps (cadrage §2.4) ---
// Chaque montant envoyé, et chaque taux source, est choisi pour qu'une autre lecture plausible de la règle donne un autre
// résultat, relu en base puis dans l'instantané de l'entrée. Valeurs du jeu de données (donnees.mjs) : achats de 100,
// pointages de 2 heures au taux de la fiche libre (35), heures SAV de 1,5 au taux de la fiche du technicien (40), sans
// prix de vente horaire (aucune main d'œuvre à leur saisie), matériel SAV de 30 et de 20.
const MONTANTS = {
  // Achat créé : 12.34 écarte l'achat existant (100), l'arrondi à l'euro (12) et au dixième (12.3).
  achatCree: 12.34,
  // Achat corrigé : 87.65 écarte l'ancien montant (100), le montant créé (12.34), l'arrondi à l'euro (88) et au dixième.
  achatCorrige: 87.65,
  // Pointage créé : 2.75 écarte les pointages existants (2), l'heure entière (3) et le dixième (2.8).
  heuresCreees: 2.75,
  // Pointage corrigé : 3.25 écarte l'ancien nombre (2), l'heure entière (3) et le dixième (3.3).
  heuresCorrigees: 3.25,
  // Taux de la fiche libre, changé après le jeu de données et avant l'instantané : un pointage créé copie 37.5 (taux de
  // la fiche au moment de la saisie), et non 35 (taux des pointages existants) ni 42.5 (fiche du technicien) ; un
  // pointage corrigé garde 35 (copie figée), et non 37.5 (taux recopié à la correction).
  tauxFicheLibre: 37.5,
  // Matériel SAV créé : 23.45 écarte le matériel existant (30 et 20), l'euro (23) et le dixième (23.5).
  materielSavCree: 23.45,
  // Matériel SAV corrigé : 34.56 écarte l'ancien montant (20), l'euro (35) et le dixième (34.6).
  materielSavCorrige: 34.56,
  // Heures SAV créées : 1.75 écarte les heures existantes (1.5), l'heure entière (2) et le dixième (1.8).
  heuresSavCreees: 1.75,
  // Heures SAV corrigées : 2.25 écarte l'ancien nombre (1.5), l'heure entière (2) et le dixième (2.3).
  heuresSavCorrigees: 2.25,
  // Taux de la fiche du technicien, changé après le jeu de données : une heure SAV créée copie 42.5, et non 40 (taux des
  // heures existantes) ni 37.5 (fiche libre) ; une heure SAV corrigée garde 40, et non 42.5.
  tauxFicheTech: 42.5,
  // Main d'œuvre rattachée à la fiche du technicien après le jeu de données : une heure SAV hors contrat créée copie
  // son prix de vente à l'heure hors contrat (61.5), et non le prix à l'heure sous contrat (57.25), ni le prix du jour
  // ramené à l'heure (430 / 7, soit 61.43), ni le prix du jour sous contrat (390) ; une heure SAV corrigée garde son
  // prix vide (saisie avant le rattachement), et non 61.5 (prix recopié à la correction).
  mainOeuvre: { prixVenteHt: 61.5, prixJourHorsContratHt: 430, prixHeureSousContratHt: 57.25, prixJourSousContratHt: 390, heuresParJour: 7 },
  // Barème standard (corps propre à 5c, cadrage §2.4) : un plafond au centime (1234.56) et deux taux décimaux (2.5,
  // 7.25), la dernière tranche sans plafond ; écarte le barème d'avant (vide), un plafond arrondi à l'euro, un taux
  // arrondi à l'unité, une tranche perdue ou un plafond infini écrit autrement que vide.
  baremeStandard: [{ plafond: 1234.56, taux: 2.5 }, { plafond: null, taux: 7.25 }],
};
// Constat d'un montant juste (cadrage §2.4, texte exact).
const CONSTAT_MONTANT = 'montant écrit relu en base ; montant journalisé identique';
// Champs des barèmes et primes de la rémunération (ParametresRemuneration), relus en base.
const CHAMPS_REMUNERATION = ['baremeStandard', 'baremeReduit', 'objectifCaMensuel', 'primeObjectifCa', 'objectifMargeMensuel', 'primeObjectifMarge', 'primeSuiviAdministratif'];

// Valeurs canoniques pour comparer un montant relu en base, un montant envoyé et l'instantané d'une entrée : nombres
// (relus en base par row_to_json, envoyés, ou écrits au journal), tableaux et objets (barèmes, clés triées).
const canonique = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v))) return Number(v);
  if (Array.isArray(v)) return v.map(canonique);
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonique(v[k])]));
  return v;
};
const memeValeur = (a, b) => JSON.stringify(canonique(a)) === JSON.stringify(canonique(b));
const motif = (quoi) => `TEST ${quoi} par la matrice des journaux`;
const LIGNE_DEVIS = (designation) => ({ designation, nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 150, tauxTva: 20 });

// Couples (route, corps) qui écrivent une table de journal dans les références de 5a et 5b, hors des contextes « droit
// … » de 5b (droits individuels sans gain, rejoués avec un droit posé) : route et contexte → comptes qui l'écrivent.
function couplesQuiJournalisent() {
  const tables = new Set(Object.keys(TABLES_DE_JOURNAL));
  const couples = new Map();
  for (const chemin of REFERENCES_ECRITURES) {
    const texte = lireReference(chemin);
    assert.ok(texte, `référence absente : ${chemin}`);
    for (const ligne of texte.split('\n').filter(Boolean)) {
      const [compte, route, , contexte, reponse] = ligne.split(SEPARATEUR);
      if (contexte.startsWith('droit')) continue;
      const ecrit = reponse.match(/ écrit \(([^)]*)\)/);
      if (!ecrit || !ecrit[1].split(',').some((t) => tables.has(t))) continue;
      const cle = `${route}${SEPARATEUR}${contexte}`;
      if (!couples.has(cle)) couples.set(cle, new Set());
      couples.get(cle).add(compte);
    }
  }
  return couples;
}

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const base = baseJetable(TEST_DATABASE_URL, 'journaux');
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
    // Cibles propres à ce fichier (cadrage §2.5), construites par l'API avant l'instantané : nom → identifiants.
    const CIBLES_PROPRES = {};
    let exportsReference = {};
    const lignes = [];
    const cas = [];
    const chiffres = { ecritures: 0, lectures: 0, remises: 0, entrees: 0, montants: 0 };
    const diagnostics = [];

    const api = async (compte, methode, chemin, corps, statut = 200) => {
      const res = await appeler(appli.adresse, methode, chemin, { jeton: jetons[compte], corps: methode === 'GET' ? undefined : corps });
      const admis = Array.isArray(statut) ? statut : [statut];
      assert.ok(admis.includes(res.status), `${methode} ${chemin} (${compte}) : ${res.status} ${JSON.stringify(res.body)?.slice(0, 400)}`);
      return res.body;
    };
    const id = (famille, nom) => cibleDe(famille, nom).ids.id;

    // Chemin d'une route pour une cible : cible propre, cible d'une famille du jeu de données, ou cible portée par le
    // corps et route sans dossier (paramètres fixes de donnees.mjs).
    const cheminDe = (route, cible) => {
      const modele = route.split(' ')[1];
      if (CIBLES_PROPRES[cible]) return cheminPour(modele, 'propre', CIBLES_PROPRES[cible]);
      const famille = ROUTES_SESSION[route]?.famille;
      if (famille && FAMILLES[famille].cibles.some((c) => c.nom === cible)) return cheminPour(modele, famille, cibleDe(famille, cible));
      return cheminPour(modele, null, null);
    };
    // Un cas d'écriture. `source` : « couple » (couple de 5a ou 5b, dont `couple` est le contexte), « nouvelle »
    // (jamais vue écrire en 5a et 5b), « sans entrée » (écart connu ou état décidé), « génération ». `prealables` :
    // écritures faites avant le cas, sans ligne ; `lirePrealables` : leurs entrées sont lues aussi ; `refuses` : compte
    // refusé d'une route de lecture, quand l'écriture fait entrer le refusé par défaut dans le périmètre ; `montant` :
    // relecture en base (§2.4).
    const ajouter = (compte, route, cible, contexte, corps, options = {}) => cas.push({
      compte, route, cible, contexte, corps, source: 'couple', couple: contexte, ...options,
      chemin: options.chemin ?? cheminDe(route, cible),
    });
    const corpsVide = () => ({});

    // --- Montants (cadrage §2.4) ---
    const lireLigne = async (table, ligneId) => (await lecture.query(`SELECT row_to_json(t) AS l FROM public."${table}" t WHERE t.id = $1`, [ligneId])).rows[0]?.l ?? null;
    const lignesCreees = async (table) => (await lecture.query(`SELECT row_to_json(t) AS l FROM public."${table}" t LEFT JOIN "${SCHEMA_INSTANTANE}"."${table}" s ON s.id = t.id WHERE s.id IS NULL`)).rows.map((r) => r.l);
    // Relecture d'un montant : la ligne écrite (créée, ou la cible), comparée au montant attendu (envoyé, taux source au
    // moment de la saisie, ou montant d'avant pour une correction sans montant, dont le changement de chantier que
    // l'application ignore, un archivage ou une restauration) ; l'entrée qui la journalise, comparée à la ligne relue
    // (« après ») et à la ligne d'avant (« avant »). Journal d'administration : seuls les champs qui changent y sont
    // gardés (commun/journal-administration.ts) ; un champ absent de l'entrée doit donc être inchangé en base, et un
    // montant inchangé en base doit en être absent.
    const constaterMontant = async (m, avant, attendu, entrees) => {
      chiffres.montants += 1;
      let ligne;
      if (m.ligne) ligne = await lireLigne(m.table, m.ligne);
      else {
        const creees = await lignesCreees(m.table);
        if (creees.length !== 1) return 'ligne du montant introuvable';
        [ligne] = creees;
      }
      if (!ligne) return 'ligne du montant introuvable';
      const ecarts = [];
      for (const champ of m.champs) if (!memeValeur(ligne[champ], attendu[champ])) ecarts.push(`montant écrit différent du montant envoyé ou de sa source : ${champ}`);
      const entree = m.partiel
        ? entrees.find((e) => e.table === 'JournalAdministration' && e.ligne.type === m.type)
        : entrees.find((e) => e.table === 'JournalSaisieChantier' && e.ligne.cibleId === ligne.id);
      if (!entree) {
        if (!m.partiel || m.champs.some((champ) => !memeValeur(ligne[champ], avant?.[champ]))) ecarts.push('montant écrit sans entrée de journal');
      } else {
        const apres = entree.ligne.apres ?? {};
        const avantEntree = entree.ligne.avant ?? {};
        for (const champ of m.champs) {
          if (m.partiel && !(champ in apres)) {
            if (!memeValeur(ligne[champ], avant?.[champ])) ecarts.push(`montant changé non journalisé : ${champ}`);
            continue;
          }
          if (m.partiel && memeValeur(ligne[champ], avant?.[champ])) ecarts.push(`montant inchangé journalisé : ${champ}`);
          if (!memeValeur(apres[champ], ligne[champ])) ecarts.push(`montant journalisé différent du montant écrit : après ${champ}`);
          if (avant && !memeValeur(avantEntree[champ], avant[champ])) ecarts.push(`montant journalisé différent du montant d’avant : avant ${champ}`);
        }
      }
      return ecarts.length ? ecarts.join(' ; ') : CONSTAT_MONTANT;
    };
    // Descripteurs de montant : ligne créée (`ligne: null`) ou cible ; `attendu` (async) rend les valeurs attendues, à
    // partir de la ligne d'avant et des sources lues avant l'écriture.
    const inchange = (champs) => async (avant) => Object.fromEntries(champs.map((c) => [c, avant?.[c] ?? null]));
    const montantTravaux = (table, ligne, champs, attendu) => ({ table, ligne, champs, attendu });

    // --- Un cas d'écriture : préalables, écriture, entrées, montant, ligne, lectures, remise ---
    const nomLecture = (entree, c, prealable) => `${prealable ? 'préalable ' : ''}${nommerEntree(entree, noms)} ← ${c.compte} ${c.route} sur ${c.cible}`;
    const lireEntrees = async (c, entrees, entreesDuCas, prealables) => {
      const taches = [...entrees.map((e) => [e, false]), ...prealables.map((e) => [e, true])].map(([entree, prealable]) => async () => {
        const nom = nomLecture(entree, c, prealable);
        const verdicts = await lireVisibilite({ appeler, adresse: appli.adresse, jetons, entree, auteur: c.compte, exportsReference, entreesDuCas, refuses: c.refuses, nom });
        chiffres.lectures += verdicts.length;
        return verdicts.map(({ lecteur, route, verdict }) => ligneMatrice({ compte: lecteur, methode: 'GET', chemin: route.slice(4), cible: nom, contexte: c.contexte, reponse: verdict }));
      });
      for (const groupe of await enParallele(taches, 4)) lignes.push(...groupe);
    };
    const reponseEcriture = (debut, entrees, constat) => {
      const nomsEntrees = entrees.map((e) => nommerEntree(e, noms)).sort();
      return `${debut} ; ${nomsEntrees.length ? `entrées : ${nomsEntrees.join(' + ')}` : 'aucune entrée'}${constat ? ` ; ${constat}` : ''}`;
    };
    const jouer = async (c) => {
      // Préalables : un préalable refusé est enregistré dans la ligne du cas (diff lisible, limité au cas), qui n'est pas
      // joué ; la base est remise.
      for (const p of c.prealables ?? []) {
        const res = await appeler(appli.adresse, p.methode, p.chemin, { jeton: jetons[p.compte], corps: p.corps() });
        if (res.status >= 200 && res.status < 300) continue;
        const [methode, chemin] = c.route.split(' ');
        lignes.push(ligneMatrice({ compte: c.compte, methode, chemin, cible: c.cible, contexte: c.contexte, reponse: `${formaterReponse(res, { messageDu400: true })} au préalable de ${p.compte} ; écriture non jouée` }));
        const aRemettre = remise.changees(await remise.empreinte());
        if (aRemettre.length) await remise.remettre(aRemettre, `préalable refusé de ${c.compte} ${c.route}, cible ${c.cible}`);
        return;
      }
      const etatAvant = c.prealables?.length ? await remise.empreinte() : remise.reference;
      const entreesPrealables = c.prealables?.length ? await entreesNouvelles(lecture) : [];
      let avantMontant = null; let attendu = null;
      if (c.montant) {
        avantMontant = c.montant.ligne ? await lireLigne(c.montant.table, c.montant.ligne) : null;
        attendu = await c.montant.attendu(avantMontant);
      }
      const [methode, chemin] = c.route.split(' ');
      const res = await appeler(appli.adresse, methode, c.chemin, { jeton: jetons[c.compte], corps: c.corps() });
      chiffres.ecritures += 1;
      const apresEcriture = await remise.empreinte();
      const changees = tablesChangees(etatAvant, apresEcriture);
      const entrees = (await entreesNouvelles(lecture)).filter((e) => !entreesPrealables.some((p) => memeEntree(p, e)));
      chiffres.entrees += entrees.length;
      const constat = c.montant ? await constaterMontant(c.montant, avantMontant, attendu, entrees) : null;
      const debut = formaterReponse(res, { messageDu400: true, ecriture: changees.length ? `écrit (${changees.join(',')})` : 'inchangé' });
      lignes.push(ligneMatrice({ compte: c.compte, methode, chemin, cible: c.cible, contexte: c.contexte, reponse: reponseEcriture(debut, entrees, constat) }));
      const nomsDuCas = entrees.map((e) => nommerEntree(e, noms));
      assert.equal(new Set(nomsDuCas).size, nomsDuCas.length, `${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : deux entrées de même nom, que les lignes de lecture ne distingueraient pas (${nomsDuCas.join(' + ')})`);
      await lireEntrees(c, entrees, [...entreesPrealables, ...entrees], c.lirePrealables ? entreesPrealables : []);
      // Les lectures n'écrivent rien (la purge du journal d'administration n'y trouve aucune entrée échue).
      assert.deepEqual(tablesChangees(apresEcriture, await remise.empreinte()), [], `${c.compte} ${c.route} sur ${c.cible} : une lecture des journaux a écrit`);
      const aRemettre = remise.changees(apresEcriture);
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
        clientActif: id('client', 'client-actif'), categorie: id('categorie', 'categorie'), fournisseur: id('fournisseur', 'fournisseur'),
        ficheLibre: id('fiche-intervenant', 'fiche-libre'), ficheTech: id('fiche-intervenant', 'fiche-tech'), chantierAutre: id('chantier', 'chantier-autre'),
      });

      // --- Objets des corps, construits par l'API avant l'instantané (comme D1a-5b) ---
      // Second client actif (changement de client d'un chantier), second compte client et second compte de TVA
      // (remappage des règles), main d'œuvre « main-oeuvre-matrice » (rattachement d'une fiche).
      d.clientSecond = (await api(SA, 'POST', '/api/clients', { raisonSociale: 'TEST Client second de la matrice des journaux' }, 201)).id;
      const comptaBis = async (code, libelle, nature) => (await api(SA, 'POST', '/api/comptabilite/comptes', { code, libelle, nature }, 201)).id;
      const clientsBis = await comptaBis('411100', 'TEST Clients bis matrice des journaux', 'ACTIF');
      const tvaBis = await comptaBis('445711', 'TEST TVA bis matrice des journaux', 'TVA');
      d.mainOeuvre = (await api(SA, 'POST', '/api/catalogue/prestations', {
        estMainOeuvre: true, reference: 'TEST-MATRICE-MO-JOURNAUX', nom: 'TEST Main d’œuvre de la matrice des journaux', tauxTva: 20, ...MONTANTS.mainOeuvre,
      }, 201)).id;
      // Sources des taux copiés à la saisie (§2.4), changées après le jeu de données : la fiche du technicien est
      // rattachée à la main d'œuvre, et les taux des deux fiches changent. Les heures existantes gardent leurs taux.
      await api(SA, 'PUT', `/api/intervenants/${d.ficheTech}/main-oeuvre`, { mainOeuvreId: d.mainOeuvre });
      await api(SA, 'PUT', `/api/intervenants/${d.ficheLibre}`, { tauxHoraireCharge: MONTANTS.tauxFicheLibre });
      await api(SA, 'PUT', `/api/intervenants/${d.ficheTech}`, { tauxHoraireCharge: MONTANTS.tauxFicheTech });
      d.remuneration = await api(SA, 'GET', '/api/parametres/remuneration');

      // --- Cibles propres (cadrage §2.5) ---
      // Contrat sans visite, dont l'échéance tombe dans l'anticipation de trente jours (dans dix jours).
      CIBLES_PROPRES['contrat-sans-visite'] = { ids: { id: (await api(SA, 'POST', '/api/contrats-maintenance', { clientId: d.clientActif, titre: 'TEST Contrat sans visite de la matrice des journaux', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: jourSociete(10) }, 201)).id } };
      // Contrat dont la visite de l'échéance est terminée : visite générée, placée sur la fiche du technicien, démarrée,
      // compte rendu du technicien, terminée sans signature (motif).
      const contratTermine = await api(SA, 'POST', '/api/contrats-maintenance', { clientId: d.clientActif, titre: 'TEST Contrat à visite terminée de la matrice des journaux', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: d.aujourdhui }, 201);
      const visite = await api(SA, 'POST', `/api/contrats-maintenance/${contratTermine.id}/generer-intervention`, {}, 201);
      const terminer = async (interventionId, contenu) => {
        await api(SA, 'PUT', `/api/interventions/${interventionId}/planning`, { dateDebut: d.hier, creneau: 'JOURNEE', intervenantIds: [d.ficheTech] }, [200, 201]);
        if ((await appli.prisma.intervention.findUniqueOrThrow({ where: { id: interventionId }, select: { statut: true } })).statut === 'A_PLANIFIER') await api(SA, 'PATCH', `/api/interventions/${interventionId}/statut`, { statut: 'PLANIFIEE' });
        await api(SA, 'PATCH', `/api/interventions/${interventionId}/statut`, { statut: 'EN_COURS' });
        await api('TECH', 'POST', `/api/interventions/${interventionId}/rapports`, { contenu, cleEnvoi: randomUUID() }, 201);
        await api(SA, 'PATCH', `/api/interventions/${interventionId}/statut`, { statut: 'TERMINEE', motifSansSignature: 'CLIENT_ABSENT' });
      };
      await terminer(visite.id, 'TEST Compte rendu de la visite terminée.');
      CIBLES_PROPRES['contrat-visite-terminee'] = { ids: { id: contratTermine.id } };
      // Intervention terminée marquée « à suivre » (retrait de la marque), comme D1a-5b.
      const aSuivre = await api(SA, 'POST', '/api/interventions', { clientId: d.clientActif, titre: 'TEST Intervention à suivre de la matrice des journaux' }, 201);
      await terminer(aSuivre.id, 'TEST Compte rendu de l’intervention à suivre.');
      await api(SA, 'PUT', `/api/interventions/${aSuivre.id}/a-suivre`, { aSuivre: true });
      CIBLES_PROPRES['intervention-a-suivre'] = { ids: { id: aSuivre.id } };
      // Version brouillon des mentions légales (publication).
      const brouillon = await api(SA, 'POST', '/api/mentions-legales', { mentions: 'TEST mentions matrice des journaux v2', cgv: 'TEST CGV v2', penalites: 'TEST pénalités v2' }, 201);
      d.cheminPublication = `/api/mentions-legales/${brouillon.version}/publier`;
      // Logo posé (retrait du logo, qui n'écrit son entrée que si un logo est posé).
      await api(SA, 'PUT', '/api/company/logo', { fichier: `data:image/png;base64,${LOGO_PNG.toString('base64')}` });
      // Second super administrateur (suppression d'un SA), avec un collaborateur, détaché à sa suppression (second terme
      // de comptes.ts, l. 297).
      const secondSa = await api(SA, 'POST', '/api/users', { email: 'matrice.sa-second@iris.test', name: 'TEST Super administrateur second', role: 'SUPERADMIN' }, 201);
      const collaborateur = await api(SA, 'POST', '/api/users', { email: 'matrice.collaborateur-sa-second@iris.test', name: 'TEST Collaborateur du second super administrateur', role: 'COMMERCIAL' }, 201);
      await api(SA, 'PATCH', `/api/users/${collaborateur.id}/responsable-hierarchique`, { responsableHierarchiqueId: secondSa.id });
      CIBLES_PROPRES['compte-superadmin-second'] = { ids: { id: secondSa.id } };
      // Devis converti en intervention, que sa conversion en chantier rattache (devis/rattachement.ts).
      const devisIntervention = await api(SA, 'POST', '/api/devis', { clientId: d.clientActif, objet: 'TEST Devis converti en intervention de la matrice des journaux', lignes: [LIGNE_DEVIS('TEST Ligne du devis converti en intervention')] }, 201);
      await api(SA, 'PUT', `/api/devis/${devisIntervention.id}/statut`, { statut: 'ENVOYE' });
      await api(SA, 'POST', `/api/devis/${devisIntervention.id}/signature`, { signataire: 'TEST Signataire matrice', confirme: true }, 201);
      await api(SA, 'POST', `/api/devis/${devisIntervention.id}/convertir`, { cible: 'INTERVENTION' }, 201);
      CIBLES_PROPRES['devis-converti-intervention'] = { ids: { id: devisIntervention.id } };

      // Versions de la comptabilité, relues en base (la remise les rend identiques à chaque cas).
      const regleClient = await appli.prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'CLIENT' } });
      const regleTva = await appli.prisma.regleTvaComptable.findFirstOrThrow({ where: { taux: 20 } });
      const compteClients = await appli.prisma.compteComptable.findUniqueOrThrow({ where: { id: id('compte-comptable', 'compte-comptable-clients') } });
      d.compta = {
        clientsBis, tvaBis, regleClientValeur: regleClient.compteId, regleClientMaj: regleClient.updatedAt.toISOString(),
        regleTvaCompte: regleTva.compteId, regleTvaMaj: regleTva.updatedAt.toISOString(), compteClientsMaj: compteClients.updatedAt.toISOString(),
      };

      // Valeurs du jeu de données relues avant l'instantané, pour le témoin des montants (test « témoin des montants »).
      const nombre = (v) => (v === null ? null : Number(v));
      const heuresSav = await appli.prisma.coutInterventionHeure.findUniqueOrThrow({ where: { id: cibleDe('cout-sav', 'heures-tech-intervention-affectee').ids.coutId } });
      d.temoin = {
        achats: await Promise.all(['achat-chantier-ct', 'achat-archive-chantier-ct'].map(async (nom) => nombre((await appli.prisma.achatReel.findUniqueOrThrow({ where: { id: id('achat', nom) } })).montantHT))),
        heures: await Promise.all(['heure-chantier-ct', 'heure-archivee-chantier-ct'].map(async (nom) => {
          const heure = await appli.prisma.pointageHeure.findUniqueOrThrow({ where: { id: id('heure', nom) } });
          return [nombre(heure.nbrHeures), nombre(heure.tauxHoraireApplique)];
        })),
        heuresSav: [nombre(heuresSav.nbrHeures), nombre(heuresSav.tauxHoraireApplique), heuresSav.prixVenteHoraireApplique],
        materielSav: nombre((await appli.prisma.coutInterventionAchat.findUniqueOrThrow({ where: { id: cibleDe('cout-sav', 'materiel-intervention-chantier-ct').ids.coutId } })).montantHT),
        taux: [nombre((await appli.prisma.intervenant.findUniqueOrThrow({ where: { id: d.ficheLibre } })).tauxHoraireCharge), nombre((await appli.prisma.intervenant.findUniqueOrThrow({ where: { id: d.ficheTech } })).tauxHoraireCharge)],
        prixVente: nombre((await appli.prisma.cataloguePrestation.findUniqueOrThrow({ where: { id: d.mainOeuvre } })).prixVenteHt),
        baremeStandard: d.remuneration.baremeStandard,
      };

      // Instantané et outil de remise en état, une fois tout construit ; connexion de lecture des journaux ; exports CSV
      // de référence du journal d'administration, lus par SA et AD.
      const tables = await tablesDeLaBase(appli.prisma);
      remise = await creerRemiseEnEtat({ url: base.url, nomBase: base.nom, tables, connexionApplication: appli.serveur.prisma, factureEmiseId: id('facture', 'facture-emise') });
      lecture = await ouvrirConnexionLecture(base.url);
      assert.deepEqual(await entreesNouvelles(lecture), [], 'aucune entrée nouvelle juste après l’instantané');
      exportsReference = await lireExports({ appeler, adresse: appli.adresse, jetons });
      // L'outil de l'export vérifie qu'il reconnaît l'export du super administrateur avant de conclure (T1 de l'audit des
      // droits de #456, suivi #457, versé par D1a-5d-3) : sinon, la préparation s'arrête avec un message clair, au lieu de
      // conclure « absente » pour chaque lecture de l'export.
      await verifierLectureExport(lecture, exportsReference.SA);
      construireCas();
    });

    after(async () => {
      await lecture?.end().catch(() => {});
      await remise?.fermer();
      await appli?.fermer();
      await base.supprimer();
    });

    // --- Table des cas (cadrage §2.1 ; corps de 5a et 5b repris, avec les montants de MONTANTS) ---
    function construireCas() {
      const u = (nom) => id('compte', nom);
      const C = comptes;
      const corpsUser = (extra) => () => ({ email: 'matrice.journaux-cree@iris.test', name: 'TEST Compte créé par la matrice des journaux', role: 'COMMERCIAL', ...extra });
      const responsable = (cle) => () => ({ responsableHierarchiqueId: C[cle].id });
      const prealable = (compte, methode, chemin, corps) => ({ compte, methode, chemin, corps: () => corps });

      // Journal d'administration : comptes. Entrées fermées à un simple administrateur (§2.2) : PERMISSIONS,
      // ACCES_FINANCE et AUSSI_COMMERCIAL sur le SA, TYPE_COMPTE vers SUPERADMIN, RATTACHEMENT à un SA, création et
      // suppression d'un SA. Écarts connus de visibilité : entrées d'un SA sur un compte ordinaire, compte devenu SA.
      for (const compte of [SA, 'AD', 'DIR']) {
        ajouter(compte, 'POST /api/users', SANS_CIBLE, 'défaut, corps compte commercial', corpsUser({}));
        ajouter(compte, 'POST /api/users', SANS_CIBLE, 'défaut, corps compte commercial, accesFinance=oui', corpsUser({ accesFinance: true }));
        ajouter(compte, 'PUT /api/commerciaux/:id/prime-mensuelle', 'compte-commercial', 'défaut, corps période et suivi administratif', () => ({ periode: '2026-09', suiviAdministratif: true }));
        ajouter(compte, 'PUT /api/intervenants/:id/compte', 'fiche-libre', 'défaut, corps compte=TECH-SANS-FICHE', () => ({ userId: C['TECH-SANS-FICHE'].id }));
        ajouter(compte, 'PUT /api/intervenants/:id/main-oeuvre', 'fiche-libre', 'défaut, corps mainOeuvreId=main-oeuvre-matrice', () => ({ mainOeuvreId: d.mainOeuvre }));
        ajouter(compte, 'PUT /api/parametres', SANS_CIBLE, 'défaut, corps margeCommercialeActive=non', () => ({ margeCommercialeActive: false }));
        // Partage du planning (routes (c), jamais vues « écrit » en 5a et 5b, cadrage §2.1) : nouveau lien, désactivation.
        ajouter(compte, 'POST /api/planning/share', SANS_CIBLE, 'défaut', corpsVide, { source: 'nouvelle' });
        ajouter(compte, 'PATCH /api/planning/share', SANS_CIBLE, 'défaut', corpsVide, { source: 'nouvelle' });
      }
      ajouter(SA, 'POST /api/users', SANS_CIBLE, 'défaut, corps role=SUPERADMIN', corpsUser({ role: 'SUPERADMIN' }));
      ajouter(SA, 'DELETE /api/users/:id', 'compte-superadmin-second', 'défaut', corpsVide);
      for (const compte of ['AD', 'DIR']) ajouter(compte, 'DELETE /api/users/:id', 'compte-commercial', 'défaut', corpsVide);
      ajouter(SA, 'PATCH /api/users/:id/actif', 'compte-commercial', 'défaut', corpsVide);
      for (const compte of ['AD', 'DIR']) ajouter(compte, 'PATCH /api/users/:id/actif', 'compte-technicien', 'défaut', corpsVide);
      ajouter(SA, 'PATCH /api/users/:id/responsable-hierarchique', 'compte-superadmin', 'défaut, corps responsable=RESP', responsable('RESP'));
      for (const compte of ['AD', 'DIR']) ajouter(compte, 'PATCH /api/users/:id/responsable-hierarchique', 'compte-commercial', 'défaut, corps responsable=RESP', responsable('RESP'));
      ajouter(SA, 'PATCH /api/users/:id/responsable-hierarchique', 'compte-commercial', 'défaut, corps responsable=SA', responsable(SA));
      ajouter(SA, 'PATCH /api/users/:id/role', 'compte-commercial', 'défaut, corps role=DIRECTEUR', () => ({ role: 'DIRECTEUR' }));
      for (const compte of ['AD', 'DIR']) ajouter(compte, 'PATCH /api/users/:id/role', 'compte-technicien', 'défaut, corps role=DIRECTEUR', () => ({ role: 'DIRECTEUR' }));
      // Promotion d'un technicien relié : la fiche déliée (comptes.ts, l. 66) concerne aussi un SA.
      ajouter(SA, 'PATCH /api/users/:id/role', 'compte-technicien', 'défaut, corps role=SUPERADMIN', () => ({ role: 'SUPERADMIN' }));
      // Compte devenu SA depuis l'entrée (écart connu, « à appliquer », passation section 4) : AD rattache COM à RESP,
      // puis SA promeut COM ; l'entrée d'AD, écrite sur un compte ordinaire, est lue après la promotion.
      ajouter(SA, 'PATCH /api/users/:id/role', 'compte-commercial', 'rattaché à RESP par AD, puis corps role=SUPERADMIN', () => ({ role: 'SUPERADMIN' }), {
        source: 'nouvelle', lirePrealables: true, prealables: [prealable('AD', 'PATCH', `/api/users/${u('compte-commercial')}/responsable-hierarchique`, { responsableHierarchiqueId: C.RESP.id })],
      });
      ajouter(SA, 'PUT /api/users/:id/permissions', 'compte-superadmin', 'défaut, corps permissions=clients:read', () => ({ permissions: ['clients:read'] }));
      ajouter(SA, 'PUT /api/users/:id/permissions', 'compte-commercial', 'défaut, corps permissions=finances:read', () => ({ permissions: ['finances:read'] }));
      // Accès financier et « aussi commercial » : avec un corps qui change la valeur (jamais vus « écrit » avec leur
      // entrée en 5a, joués à corps vide), et à corps vide (« un enregistrement sans changement n'écrit rien »).
      ajouter(SA, 'PATCH /api/users/:id/acces-finance', 'compte-superadmin', 'défaut, corps accesFinance=oui', () => ({ accesFinance: true }), { source: 'nouvelle' });
      ajouter(SA, 'PATCH /api/users/:id/acces-finance', 'compte-commercial', 'défaut, corps accesFinance=oui', () => ({ accesFinance: true }), { source: 'nouvelle' });
      ajouter(SA, 'PATCH /api/users/:id/acces-finance', 'compte-commercial', 'défaut, corps vide', corpsVide, { source: 'sans entrée' });
      ajouter(SA, 'PATCH /api/users/:id/est-commercial', 'compte-superadmin', 'défaut, corps estCommercial=oui', () => ({ estCommercial: true }), { source: 'nouvelle' });
      for (const compte of ['AD', 'DIR']) ajouter(compte, 'PATCH /api/users/:id/est-commercial', 'compte-administrateur', 'défaut, corps estCommercial=oui', () => ({ estCommercial: true }), { source: 'nouvelle' });
      for (const compte of [SA, 'AD', 'DIR']) ajouter(compte, 'PATCH /api/users/:id/est-commercial', compte === SA ? 'compte-superadmin' : 'compte-administrateur', 'défaut, corps vide', corpsVide, { source: 'sans entrée' });

      // Clés d'intégration (réservées au SA) : l'entrée du journal et l'historique des clés.
      ajouter(SA, 'POST /api/admin/api-keys', SANS_CIBLE, 'défaut, corps nom et scope', () => ({ nom: 'TEST Clé créée par la matrice des journaux', scopes: ['clients:read'] }));
      ajouter(SA, 'POST /api/admin/api-keys/:id/revoke', 'cle-active', 'défaut', corpsVide);

      // Réglages réservés au SA. Rémunération : le corps de 5b (barèmes relus, libellé changé) n'écrit aucun montant au
      // journal ; le corps propre à 5c change le barème standard (cadrage §2.4). Les deux sont relus en base.
      const remuneration = (extra) => ({ table: 'ParametresRemuneration', ligne: 'singleton', partiel: true, type: 'REMUNERATION', champs: CHAMPS_REMUNERATION, attendu: async () => ({ ...Object.fromEntries(CHAMPS_REMUNERATION.map((c) => [c, d.remuneration[c]])), ...extra }) });
      ajouter(SA, 'PUT /api/parametres/remuneration', SANS_CIBLE, 'défaut, corps barèmes relus, libellé changé', () => ({ ...d.remuneration, libelleBaremeReduit: 'TEST Barème réduit de la matrice des journaux' }), { montant: remuneration({}) });
      ajouter(SA, 'PUT /api/parametres/remuneration', SANS_CIBLE, 'défaut, corps barème standard changé', () => ({ ...d.remuneration, baremeStandard: MONTANTS.baremeStandard }), { source: 'montant', montant: remuneration({ baremeStandard: MONTANTS.baremeStandard }) });
      ajouter(SA, 'PUT /api/modules', SANS_CIBLE, 'défaut, corps modeEnvoi=MESSAGERIE', () => ({ modeEnvoi: 'MESSAGERIE' }));
      ajouter(SA, 'PUT /api/company', SANS_CIBLE, 'défaut, corps identité, téléphone changé', () => ({ ...SOCIETE, telephone: '02 31 00 00 09' }));
      ajouter(SA, 'PUT /api/company/logo', SANS_CIBLE, 'défaut, corps logo JPEG', () => ({ fichier: `data:image/jpeg;base64,${LOGO_JPEG.toString('base64')}` }));
      ajouter(SA, 'DELETE /api/company/logo', SANS_CIBLE, 'défaut, logo posé', corpsVide, { source: 'nouvelle' });
      ajouter(SA, 'PUT /api/journal-administration/conservation', SANS_CIBLE, 'défaut, corps durée de conservation changée', () => ({ jours: 30 }));

      // Chantier : client, titulaire, commercial, encaissement (journal des saisies du chantier), envoi du rapport.
      for (const compte of [SA, 'AD', 'DIR']) {
        ajouter(compte, 'PATCH /api/chantiers/:id', 'chantier-autre', 'défaut, corps clientId=client-second seul', () => ({ clientId: d.clientSecond }));
        ajouter(compte, 'PATCH /api/chantiers/:id/encaisse', 'chantier-ct', 'défaut, corps encaisse=oui', () => ({ encaisse: true }));
        // Retrait de l'encaissement : chantier-ct encaissé juste avant par SA (préalable, sans cible propre).
        ajouter(compte, 'PATCH /api/chantiers/:id/encaisse', 'chantier-ct', 'encaissé par SA, puis corps encaisse=non', () => ({ encaisse: false }), {
          couple: 'défaut, corps encaisse=non', prealables: [prealable(SA, 'PATCH', `/api/chantiers/${id('chantier', 'chantier-ct')}/encaisse`, { encaisse: true })],
        });
        ajouter(compte, 'POST /api/chantiers/:id/envois', 'chantier-ct', 'défaut, corps destinataire, messagerie', () => ({ destinataire: DESTINATAIRE }));
      }
      for (const compte of [SA, 'AD', 'DIR', 'CT']) {
        ajouter(compte, 'PATCH /api/chantiers/:id', 'chantier-ct', 'défaut, corps responsableId=autre conducteur', () => ({ responsableId: C['CT-N1'].id }));
        // Le commercial devient COM : le compte refusé du journal du chantier est alors le technicien.
        ajouter(compte, 'PATCH /api/chantiers/:id/commercial', 'chantier-ct', 'défaut, corps commercialId=COM', () => ({ commercialId: C.COM.id }), { refuses: { 'GET /api/chantiers/:id/journal-saisies': 'TECH' } });
        // Clôture d'un chantier : aucune entrée, sans décision (N1 de l'audit des droits de #453), question à Nelson.
        ajouter(compte, 'PATCH /api/chantiers/:id/statut', 'chantier-ct', 'défaut, corps statut=TERMINE', () => ({ statut: 'TERMINE' }), { source: 'sans entrée' });
      }
      for (const compte of [SA, 'AD', 'DIR']) ajouter(compte, 'PATCH /api/chantiers/:id/statut', 'chantier-termine', 'défaut, corps statut=EN_COURS', () => ({ statut: 'EN_COURS' }), { source: 'sans entrée' });

      // Saisies Travaux (montants relus en base, §2.4).
      const achat = (nom) => id('achat', nom);
      const heure = (nom) => id('heure', nom);
      for (const compte of [SA, 'AD', 'DIR', 'CT']) {
        ajouter(compte, 'POST /api/achats', 'chantierId=chantier-ct', 'défaut, corps achat', () => ({ chantierId: id('chantier', 'chantier-ct'), categorieId: d.categorie, fournisseurId: d.fournisseur, date: d.hier, description: 'TEST Achat de la matrice des journaux', montantHT: MONTANTS.achatCree }), {
          montant: montantTravaux('AchatReel', null, ['montantHT'], async () => ({ montantHT: MONTANTS.achatCree })),
        });
        ajouter(compte, 'PATCH /api/achats/:id', 'achat-chantier-ct', 'défaut, corps description, montantHT et motif', () => ({ motifCorrection: motif('correction'), description: 'TEST Achat corrigé par la matrice des journaux', montantHT: MONTANTS.achatCorrige }), {
          montant: montantTravaux('AchatReel', achat('achat-chantier-ct'), ['montantHT'], async () => ({ montantHT: MONTANTS.achatCorrige })),
        });
        ajouter(compte, 'PATCH /api/achats/:id', 'achat-chantier-ct', 'défaut, corps chantierId=chantier-autre et motif', () => ({ motifCorrection: motif('correction'), chantierId: d.chantierAutre }), {
          montant: montantTravaux('AchatReel', achat('achat-chantier-ct'), ['montantHT'], inchange(['montantHT'])),
        });
        ajouter(compte, 'POST /api/heures', 'chantierId=chantier-ct', 'défaut, corps heures', () => ({ chantierId: id('chantier', 'chantier-ct'), intervenantId: d.ficheLibre, date: d.hier, nbrHeures: MONTANTS.heuresCreees }), {
          montant: montantTravaux('PointageHeure', null, ['nbrHeures', 'tauxHoraireApplique'], async () => ({ nbrHeures: MONTANTS.heuresCreees, tauxHoraireApplique: (await lireLigne('Intervenant', d.ficheLibre)).tauxHoraireCharge })),
        });
        ajouter(compte, 'PATCH /api/heures/:id', 'heure-chantier-ct', 'défaut, corps commentaire, heures et motif', () => ({ motifCorrection: motif('correction'), commentaire: 'TEST Pointage corrigé par la matrice des journaux', nbrHeures: MONTANTS.heuresCorrigees }), {
          montant: montantTravaux('PointageHeure', heure('heure-chantier-ct'), ['nbrHeures', 'tauxHoraireApplique'], async (avant) => ({ nbrHeures: MONTANTS.heuresCorrigees, tauxHoraireApplique: avant.tauxHoraireApplique })),
        });
        ajouter(compte, 'PATCH /api/heures/:id', 'heure-chantier-ct', 'défaut, corps chantierId=chantier-autre et motif', () => ({ motifCorrection: motif('correction'), chantierId: d.chantierAutre }), {
          montant: montantTravaux('PointageHeure', heure('heure-chantier-ct'), ['nbrHeures', 'tauxHoraireApplique'], inchange(['nbrHeures', 'tauxHoraireApplique'])),
        });
      }
      // Archivage : par l'administration, et par le responsable sur le chantier de sa branche (le conducteur n'archive pas).
      for (const [compte, nomAchat, nomHeure] of [[SA, 'achat-chantier-ct', 'heure-chantier-ct'], ['AD', 'achat-chantier-ct', 'heure-chantier-ct'], ['DIR', 'achat-chantier-ct', 'heure-chantier-ct'], ['RESP', 'achat-chantier-ct-branche-resp', 'heure-chantier-ct-branche-resp']]) {
        ajouter(compte, 'DELETE /api/achats/:id', nomAchat, 'défaut, corps motif d’archivage', () => ({ motifArchivage: motif('archivage') }), { montant: montantTravaux('AchatReel', achat(nomAchat), ['montantHT'], inchange(['montantHT'])) });
        ajouter(compte, 'DELETE /api/heures/:id', nomHeure, 'défaut, corps motif d’archivage', () => ({ motifArchivage: motif('archivage') }), { montant: montantTravaux('PointageHeure', heure(nomHeure), ['nbrHeures', 'tauxHoraireApplique'], inchange(['nbrHeures', 'tauxHoraireApplique'])) });
      }
      for (const compte of [SA, 'AD', 'DIR']) {
        ajouter(compte, 'POST /api/achats/:id/restaurer', 'achat-archive-chantier-ct', 'défaut, corps motif de restauration', () => ({ motifRestauration: motif('restauration') }), { montant: montantTravaux('AchatReel', achat('achat-archive-chantier-ct'), ['montantHT'], inchange(['montantHT'])) });
        ajouter(compte, 'POST /api/heures/:id/restaurer', 'heure-archivee-chantier-ct', 'défaut, corps motif de restauration', () => ({ motifRestauration: motif('restauration') }), { montant: montantTravaux('PointageHeure', heure('heure-archivee-chantier-ct'), ['nbrHeures', 'tauxHoraireApplique'], inchange(['nbrHeures', 'tauxHoraireApplique'])) });
      }

      // Interventions SAV : journal des saisies de l'intervention. L'assistante technique (lot « Assistante technique », PR
      // AT-1, cadrage v2.1 : « ouvertures testées par écriture et journal à son nom ») est jouée comme le conducteur, sur
      // les mêmes cibles : création, statut, suite, marque « à suivre », planning et envoi du compte rendu.
      for (const compte of [SA, 'AD', 'DIR', 'CT', 'AT']) {
        ajouter(compte, 'POST /api/interventions', 'chantierId=chantier-ct', 'défaut, corps client, titre et chantier', () => ({ clientId: d.clientActif, titre: 'TEST Intervention créée par la matrice des journaux', chantierId: id('chantier', 'chantier-ct') }));
        ajouter(compte, 'PATCH /api/interventions/:id/statut', 'intervention-creee-ct', 'défaut, corps statut=ANNULEE et motif', () => ({ statut: 'ANNULEE', motif: motif('annulation') }));
        ajouter(compte, 'PATCH /api/interventions/:id/statut', 'intervention-chantier-ct', 'défaut, corps statut=EN_COURS', () => ({ statut: 'EN_COURS' }));
        ajouter(compte, 'PATCH /api/interventions/:id/statut', 'intervention-creee-ct', 'défaut, corps statut=PLANIFIEE', () => ({ statut: 'PLANIFIEE' }));
        ajouter(compte, 'POST /api/interventions/:id/suites', 'intervention-chantier-ct', 'défaut', corpsVide);
        ajouter(compte, 'PUT /api/interventions/:id/a-suivre', 'intervention-terminee-signee', 'défaut, corps aSuivre=oui', () => ({ aSuivre: true }));
        ajouter(compte, 'PUT /api/interventions/:id/planning', 'intervention-creee-ct', 'défaut, corps jour, créneau et fiche libre', () => ({ dateDebut: d.demain, creneau: 'JOURNEE', intervenantIds: [d.ficheLibre] }));
        ajouter(compte, 'POST /api/interventions/:id/envois', 'intervention-terminee-signee', 'défaut, corps destinataire, messagerie', () => ({ destinataire: DESTINATAIRE }));
      }
      for (const compte of [SA, 'AD', 'DIR', 'TECH']) {
        ajouter(compte, 'PATCH /api/interventions/:id/statut', 'intervention-affectee-tech', 'défaut, corps statut=TERMINEE et motif sans signature', () => ({ statut: 'TERMINEE', motifSansSignature: 'CLIENT_ABSENT' }));
        ajouter(compte, 'POST /api/interventions/:id/rapports', 'intervention-affectee-tech', 'défaut, corps contenu et clé d’envoi', () => ({ contenu: 'TEST Compte rendu de la matrice des journaux.', cleEnvoi: randomUUID() }));
        ajouter(compte, 'POST /api/interventions/rapports/:rapportId/signature', 'rapport-non-signe', 'défaut, corps signataire, confirmation et tracé', () => ({ signataire: 'TEST Signataire de la matrice', confirme: true, trace: TRACE }));
        ajouter(compte, 'PUT /api/interventions/:id/a-suivre', 'intervention-a-suivre', 'défaut, corps aSuivre=non', () => ({ aSuivre: false }));
      }
      // L'assistante technique remet à planifier une curative hors de toute relation (SAV de toute la société, lot AT-1).
      for (const compte of [SA, 'AD', 'DIR', 'AT']) ajouter(compte, 'POST /api/interventions/:id/remise-a-planifier', 'curative-sans-chantier-branche', 'défaut, corps motif', () => ({ motif: motif('remise à planifier') }));

      // Coûts SAV (montants relus en base, §2.4) : matériel de l'encadrement, heures du technicien affecté.
      const cout = (nom) => cibleDe('cout-sav', nom).ids;
      const CHAMPS_HEURES_SAV = ['nbrHeures', 'tauxHoraireApplique', 'prixVenteHoraireApplique'];
      // Matériel SAV saisi et corrigé par l'assistante technique comme par le conducteur (réponse 7 de Nelson du 06-11-2026,
      // « Oui, comme le conducteur » ; lot AT-1, C6 du contrôle) : montant relu en base, entrée à son nom.
      for (const compte of [SA, 'AD', 'DIR', 'CT', 'AT']) {
        ajouter(compte, 'POST /api/interventions/:id/couts/achats', 'intervention-chantier-ct', 'défaut, corps date, description, montantHT et fournisseur', () => ({ date: d.aujourdhui, description: 'TEST Matériel SAV de la matrice des journaux', montantHT: MONTANTS.materielSavCree, fournisseurId: d.fournisseur }), {
          montant: montantTravaux('CoutInterventionAchat', null, ['montantHT'], async () => ({ montantHT: MONTANTS.materielSavCree })),
        });
        ajouter(compte, 'PATCH /api/interventions/:id/couts/:type/:coutId', 'materiel-intervention-chantier-ct', 'défaut, corps montantHT et motif', () => ({ motifCorrection: motif('correction du matériel'), montantHT: MONTANTS.materielSavCorrige }), {
          montant: montantTravaux('CoutInterventionAchat', cout('materiel-intervention-chantier-ct').coutId, ['montantHT'], async () => ({ montantHT: MONTANTS.materielSavCorrige })),
        });
      }
      ajouter('TECH', 'POST /api/interventions/:id/couts/heures', 'intervention-affectee-tech', 'défaut, corps date et heures', () => ({ date: d.aujourdhui, nbrHeures: MONTANTS.heuresSavCreees }), {
        montant: montantTravaux('CoutInterventionHeure', null, CHAMPS_HEURES_SAV, async () => ({
          nbrHeures: MONTANTS.heuresSavCreees, tauxHoraireApplique: (await lireLigne('Intervenant', d.ficheTech)).tauxHoraireCharge,
          prixVenteHoraireApplique: (await lireLigne('CataloguePrestation', d.mainOeuvre)).prixVenteHt,
        })),
      });
      ajouter('TECH', 'PATCH /api/interventions/:id/couts/:type/:coutId', 'heures-tech-intervention-affectee', 'défaut, corps nbrHeures et motif', () => ({ motifCorrection: motif('correction des heures'), nbrHeures: MONTANTS.heuresSavCorrigees }), {
        montant: montantTravaux('CoutInterventionHeure', cout('heures-tech-intervention-affectee').coutId, CHAMPS_HEURES_SAV, async (avant) => ({ nbrHeures: MONTANTS.heuresSavCorrigees, tauxHoraireApplique: avant.tauxHoraireApplique, prixVenteHoraireApplique: avant.prixVenteHoraireApplique })),
      });
      // Archivage d'un coût SAV (action « archiver » des cibles de donnees.mjs), puis restauration d'un coût archivé juste
      // avant (préalable) : les montants relus en base sont inchangés.
      const ROUTE_ACTION = 'POST /api/interventions/:id/couts/:type/:coutId/:action';
      const montantCout = (nom) => (cout(nom).type === 'achats'
        ? montantTravaux('CoutInterventionAchat', cout(nom).coutId, ['montantHT'], inchange(['montantHT']))
        : montantTravaux('CoutInterventionHeure', cout(nom).coutId, CHAMPS_HEURES_SAV, inchange(CHAMPS_HEURES_SAV)));
      for (const [compte, nom] of [[SA, 'heures-tech-intervention-affectee'], ['AD', 'materiel-intervention-affectee'], ['DIR', 'materiel-intervention-affectee'], ['CT', 'materiel-intervention-chantier-ct'], ['AT', 'materiel-intervention-affectee']]) {
        // Lot AT-1 : l'assistante technique archive le matériel d'une intervention hors de toute relation.
        ajouter(compte, ROUTE_ACTION, nom, 'défaut, corps motif', () => ({ motif: motif('archivage') }), { montant: montantCout(nom) });
      }
      // Lot AT-1 : l'assistante technique restaure le matériel d'une intervention hors de toute relation, archivé par AD.
      for (const [compte, nom, auteurArchivage] of [['AD', 'heures-tech-intervention-affectee', SA], ['DIR', 'heures-tech-intervention-affectee', SA], [SA, 'materiel-intervention-affectee', 'AD'], ['AT', 'materiel-intervention-affectee', 'AD']]) {
        const { id: interventionId, coutId, type } = cout(nom);
        const cheminCout = `/api/interventions/${interventionId}/couts/${type ?? 'heures'}/${coutId}`;
        ajouter(compte, ROUTE_ACTION, `${nom}, restauration`, `archivé par ${auteurArchivage}, puis corps motif`, () => ({ motif: motif('restauration') }), {
          couple: 'défaut, corps motif', chemin: `${cheminCout}/restaurer`, montant: montantCout(nom),
          prealables: [prealable(auteurArchivage, 'POST', `${cheminCout}/archiver`, { motif: motif('archivage avant la restauration') })],
        });
      }

      // Contrats de maintenance : journal des saisies du contrat, envoi, génération d'une visite, avancement de
      // l'échéance d'un contrat dont la visite est terminée (T1 de l'audit des montants de #440, N5 de son audit des
      // droits).
      for (const compte of [SA, 'AD', 'DIR']) {
        ajouter(compte, 'POST /api/contrats-maintenance', 'clientId=client-actif', 'défaut, corps titre, périodicité, durée et début', () => ({ clientId: d.clientActif, titre: 'TEST Contrat créé par la matrice des journaux', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: d.aujourdhui }));
        ajouter(compte, 'PATCH /api/contrats-maintenance/:id', 'contrat-actif', 'défaut, corps note de couverture et motif', () => ({ noteCouverture: 'TEST Note de couverture de la matrice des journaux', motif: motif('couverture') }));
        ajouter(compte, 'PATCH /api/contrats-maintenance/:id/statut', 'contrat-actif', 'défaut, corps statut=SUSPENDU et motif', () => ({ statut: 'SUSPENDU', motif: motif('suspension') }));
        ajouter(compte, 'POST /api/contrats-maintenance/:id/envois', 'contrat-actif', 'défaut, corps destinataire, messagerie', () => ({ destinataire: DESTINATAIRE }));
        ajouter(compte, 'POST /api/contrats-maintenance/:id/generer-intervention', 'contrat-sans-visite', 'défaut', corpsVide);
        ajouter(compte, 'POST /api/contrats-maintenance/:id/avancer-echeance', 'contrat-visite-terminee', 'défaut, corps sans corps', corpsVide, { source: 'nouvelle' });
      }
      // Lot « Assistante technique », PR AT-2a (cadrage v2, C1 ; réponses 3 et 9 du 06-11-2026) : la gestion des contrats,
      // jouée par l'assistante technique, entrées à son nom ; la création hors devis et la couverture restent à
      // l'administration (choix par défaut, à confirmer), refusées en 5a et 5b.
      ajouter('AT', 'PATCH /api/contrats-maintenance/:id/statut', 'contrat-actif', 'défaut, corps statut=SUSPENDU et motif', () => ({ statut: 'SUSPENDU', motif: motif('suspension') }));
      ajouter('AT', 'POST /api/contrats-maintenance/:id/envois', 'contrat-actif', 'défaut, corps destinataire, messagerie', () => ({ destinataire: DESTINATAIRE }));
      ajouter('AT', 'POST /api/contrats-maintenance/:id/generer-intervention', 'contrat-sans-visite', 'défaut', corpsVide);
      ajouter('AT', 'POST /api/contrats-maintenance/:id/avancer-echeance', 'contrat-visite-terminee', 'défaut, corps sans corps', corpsVide, { source: 'nouvelle' });

      // Devis : conversions (le chantier n'écrit aucune entrée, écart connu ; l'intervention déjà issue du devis est
      // rattachée au chantier, avec son entrée), envoi.
      for (const compte of [SA, 'AD', 'DIR']) {
        ajouter(compte, 'POST /api/devis/:id/convertir', 'devis-signe', 'défaut, corps cible=CONTRAT', () => ({ cible: 'CONTRAT', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: d.aujourdhui }));
        ajouter(compte, 'POST /api/devis/:id/convertir', 'devis-signe', 'défaut, corps cible=INTERVENTION', () => ({ cible: 'INTERVENTION' }));
        ajouter(compte, 'POST /api/devis/:id/convertir', 'devis-signe', 'défaut, corps cible=CHANTIER', () => ({ cible: 'CHANTIER' }), { source: 'sans entrée' });
        ajouter(compte, 'POST /api/devis/:id/convertir', 'devis-converti-intervention', 'défaut, corps cible=CHANTIER', () => ({ cible: 'CHANTIER' }), { source: 'nouvelle' });
      }
      // AT-2a : l'assistante technique convertit en contrat (gereLesContrats), en intervention (encadrement SAV, ouvert depuis
      // AT-1 mais sans le droit devis jusqu'ici) et en chantier, entrées à son nom.
      ajouter('AT', 'POST /api/devis/:id/convertir', 'devis-signe', 'défaut, corps cible=CONTRAT', () => ({ cible: 'CONTRAT', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: d.aujourdhui }));
      ajouter('AT', 'POST /api/devis/:id/convertir', 'devis-signe', 'défaut, corps cible=INTERVENTION', () => ({ cible: 'INTERVENTION' }));
      ajouter('AT', 'POST /api/devis/:id/convertir', 'devis-converti-intervention', 'défaut, corps cible=CHANTIER', () => ({ cible: 'CHANTIER' }), { source: 'nouvelle' });
      for (const compte of [SA, 'AD', 'DIR', 'COM']) ajouter(compte, 'POST /api/devis/:id/envois', 'devis-brouillon', 'défaut, corps destinataire, messagerie', () => ({ destinataire: DESTINATAIRE }));

      // Facture : l'entrée de l'émission, jouée en 5a, lue ici (cadrage §2.1).
      for (const compte of [SA, 'AD', 'DIR']) ajouter(compte, 'POST /api/factures/:id/emettre', 'facture-brouillon', 'défaut', corpsVide);

      // Comptabilité : journal d'un compte, journal des règles ; création et import de comptes sans entrée (écart connu).
      for (const compte of [SA, 'AD', 'DIR']) {
        ajouter(compte, 'PATCH /api/comptabilite/comptes/:id', 'compte-comptable-clients', 'défaut, corps libellé, motif et version', () => ({ libelle: 'TEST Clients matrice des journaux renommé', motif: motif('renommage'), expectedUpdatedAt: d.compta.compteClientsMaj }));
        ajouter(compte, 'PUT /api/comptabilite/regles/:cle', 'cle=CLIENT', 'défaut, corps autre compte client, version et motif', () => ({ compteId: d.compta.clientsBis, expectedValeur: d.compta.regleClientValeur, expectedUpdatedAt: d.compta.regleClientMaj, motif: motif('remappage') }));
        ajouter(compte, 'DELETE /api/comptabilite/regles/:cle', 'cle=CLIENT', 'défaut, corps version et motif', () => ({ expectedValeur: d.compta.regleClientValeur, expectedUpdatedAt: d.compta.regleClientMaj, motif: motif('retrait') }));
        ajouter(compte, 'PUT /api/comptabilite/tva/:taux', 'taux=20', 'défaut, corps autre compte de TVA, version et motif', () => ({ compteId: d.compta.tvaBis, expectedCompteId: d.compta.regleTvaCompte, expectedUpdatedAt: d.compta.regleTvaMaj, motif: motif('remappage') }));
        ajouter(compte, 'DELETE /api/comptabilite/tva/:taux', 'taux=20', 'défaut, corps confirmation, version et motif', () => ({ confirmation: '20', expectedCompteId: d.compta.regleTvaCompte, expectedUpdatedAt: d.compta.regleTvaMaj, motif: motif('retrait') }));
        ajouter(compte, 'POST /api/comptabilite/comptes', SANS_CIBLE, 'défaut, corps compte de fournisseurs', () => ({ code: '401000', libelle: 'TEST Fournisseurs matrice des journaux', nature: 'PASSIF' }), { source: 'sans entrée' });
        ajouter(compte, 'POST /api/comptabilite/importer', SANS_CIBLE, 'défaut, corps une ligne', () => ({ lignes: [{ code: '402000', libelle: 'TEST Fournisseurs importés matrice des journaux', nature: 'PASSIF' }] }), { source: 'sans entrée' });
        // Mentions légales : version créée ou publiée, sans auteur (écart connu).
        ajouter(compte, 'POST /api/mentions-legales', SANS_CIBLE, 'défaut, corps mentions, CGV et pénalités', () => ({ mentions: 'TEST mentions de la matrice des journaux', cgv: 'TEST CGV', penalites: 'TEST pénalités' }));
        ajouter(compte, 'POST /api/mentions-legales/:version/publier', 'version-brouillon', 'défaut', corpsVide, { chemin: d.cheminPublication });
        // Taux horaire d'une fiche : aucune entrée (écart connu, « à appliquer »).
        ajouter(compte, 'PUT /api/intervenants/:id', 'fiche-libre', 'défaut, corps nom et taux horaire', () => ({ nom: 'TEST Fiche modifiée par la matrice des journaux', tauxHoraireCharge: 45 }), { source: 'sans entrée' });
      }

      // Génération des visites (§2.3) : l'anticipation réglée à trente jours par AD (son entrée, lue ici), puis le
      // passage manuel de chaque administrateur, le réglage posé par AD en préalable. Témoin du réglage vide : AD et DIR,
      // administrateurs (409), et CT, compte refusé (403), qui remplace le directeur depuis qu'il a les droits de
      // l'administration (lot « Directeur aligné sur l'administration »). Depuis AT-2a, l'assistante technique lance aussi le
      // passage manuel (GESTION_CONTRATS), à son nom, et reçoit le 409 du réglage vide.
      for (const compte of ['AD', 'DIR']) ajouter(compte, 'PUT /api/parametres', SANS_CIBLE, 'défaut, corps anticipationVisitesJours=trente', () => ({ anticipationVisitesJours: 30 }), { source: 'génération' });
      for (const compte of ['AD', 'DIR', 'AT', 'CT']) ajouter(compte, 'POST /api/contrats-maintenance/generation-visites', SANS_CIBLE, 'anticipation vide, témoin de la matrice des entrées', corpsVide, { source: 'génération' });
      for (const compte of GESTION_CONTRATS) {
        ajouter(compte, 'POST /api/contrats-maintenance/generation-visites', SANS_CIBLE, CONTEXTE_GENERATION, corpsVide, { source: 'génération', prealables: [REGLAGE_GENERATION()] });
      }
    }
    const CONTEXTE_GENERATION = 'anticipation de trente jours réglée par AD';
    const REGLAGE_GENERATION = () => ({ compte: 'AD', methode: 'PUT', chemin: '/api/parametres', corps: () => ({ anticipationVisitesJours: 30 }) });

    // Avenant, section 1 : « les fichiers de D1a-5 l'exigent et échouent avec un message clair si le rôle de
    // TEST_DATABASE_URL ne peut pas poser ce paramètre — jamais de SKIP ».
    test('rôle PostgreSQL : le rôle de TEST_DATABASE_URL peut poser session_replication_role, sans quoi la base ne peut pas être remise en état entre deux cas (échec clair, jamais un SKIP)', () => {
      if (refusRole) throw refusRole;
    });

    // Cadrage §2.4 et règle des montants du rédacteur des tests (« choisis des valeurs telles que chaque autre lecture
    // plausible de la règle donne un résultat différent ») : les valeurs du jeu de données, et les sources des taux copiés
    // changées avant l'instantané, sont bien celles que les commentaires de MONTANTS écartent. Un test à part, et non une
    // assertion de la préparation, pour qu'un montant mal écrit dès le jeu de données laisse jouer la matrice, dont le
    // diff nomme alors chaque cas.
    testPrepare('témoin des montants : valeurs du jeu de données et sources des taux copiés, distinctes des montants envoyés par la matrice', () => {
      assert.deepEqual(d.temoin.achats, [100, 100], 'achats du jeu de données');
      assert.deepEqual(d.temoin.heures, [[2, 35], [2, 35]], 'pointages du jeu de données : nombre d’heures et taux copié de la fiche libre');
      assert.deepEqual(d.temoin.heuresSav, [1.5, 40, null], 'heures SAV du jeu de données : nombre, taux copié de la fiche du technicien, sans prix de vente');
      assert.equal(d.temoin.materielSav, 20, 'matériel SAV du jeu de données');
      assert.deepEqual(d.temoin.taux, [MONTANTS.tauxFicheLibre, MONTANTS.tauxFicheTech], 'taux des fiches, changés après le jeu de données');
      assert.equal(d.temoin.prixVente, MONTANTS.mainOeuvre.prixVenteHt, 'prix de vente à l’heure de la main d’œuvre de la fiche du technicien');
      assert.deepEqual(d.temoin.baremeStandard, [], 'barème standard du jeu de données : vide');
      for (const [envoye, existants] of [[MONTANTS.achatCree, [100]], [MONTANTS.achatCorrige, [100, MONTANTS.achatCree]], [MONTANTS.heuresCreees, [2]], [MONTANTS.heuresCorrigees, [2, MONTANTS.heuresCreees]], [MONTANTS.materielSavCree, [20, 30]], [MONTANTS.materielSavCorrige, [20, MONTANTS.materielSavCree]], [MONTANTS.heuresSavCreees, [1.5]], [MONTANTS.heuresSavCorrigees, [1.5, MONTANTS.heuresSavCreees]]]) {
        assert.ok(!existants.includes(envoye) && envoye !== Math.round(envoye) && envoye !== Math.round(envoye * 10) / 10, `montant envoyé ${envoye} : ni une valeur existante, ni un arrondi`);
      }
    });

    // Le directeur, qui a les droits de l'administration depuis le lot « Directeur aligné sur l'administration », est joué
    // comme AD, à chacun de ses cas : la colonne DIR de journaux.txt est celle d'AD.
    // Cadrage de 5c, §3 : « Un test de couverture relit ecritures-actions.txt et ecritures-modifications.txt : chaque
    // couple (route, corps) qui y écrit une table de journal doit avoir son cas en 5c. Une route qui commencerait à
    // journaliser serait ainsi signalée. » ; §2.1 : « Les auteurs sont SA, AD et un compte hors administration, choisis
    // parmi les comptes qui écrivent ce couple en 5a ou 5b ».
    testPrepare('couverture : chaque couple (route, corps) qui écrit une table de journal dans ecritures-actions.txt ou ecritures-modifications.txt a son cas, joué par SA, par AD et par un compte hors administration parmi ceux qui l’y écrivent', (t) => {
      const couples = couplesQuiJournalisent();
      const manquants = [];
      for (const [cle, ecrivains] of [...couples].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const [route, contexte] = cle.split(SEPARATEUR);
        const joues = cas.filter((c) => c.route === route && c.couple === contexte);
        const auteurs = new Set(joues.map((c) => c.compte));
        for (const compte of [SA, 'AD', 'DIR']) if (ecrivains.has(compte) && !auteurs.has(compte)) manquants.push(`${cle} : ${compte}`);
        const horsAdministration = [...ecrivains].filter((c) => !ADMINISTRATION.includes(c));
        if (horsAdministration.length && !horsAdministration.some((c) => auteurs.has(c))) manquants.push(`${cle} : un compte parmi ${horsAdministration.join(', ')}`);
        for (const c of joues) if (!ecrivains.has(c.compte)) manquants.push(`${cle} : ${c.compte} n’écrit pas ce couple en 5a ou 5b`);
      }
      assert.deepEqual(manquants, [], 'couples qui journalisent sans leur cas en 5c');
      // Chaque cas déclaré « couple » couvre un couple qui journalise encore : un couple qui cesserait de journaliser est
      // signalé aussi.
      const orphelins = cas.filter((c) => c.source === 'couple' && !couples.has(`${c.route}${SEPARATEUR}${c.couple}`)).map((c) => `${c.compte} ${c.route} (${c.couple})`);
      assert.deepEqual(orphelins, [], 'cas « couple » sans couple qui journalise dans 5a ou 5b');
      const parSource = {};
      for (const c of cas) parSource[c.source] = (parSource[c.source] ?? 0) + 1;
      diagnostics.push(`couples (route, corps) qui journalisent dans 5a et 5b : ${couples.size} ; cas d’écriture : ${cas.length} (${Object.entries(parSource).map(([s, n]) => `${s} ${n}`).join(', ')})`);
      t.diagnostic(diagnostics[diagnostics.length - 1]);
    });

    // Cadrage §2.1, §2.2 et §2.4 : chaque cas, ses entrées et leurs lectures, base remise en état après chaque cas.
    testPrepare('écritures journalisées : chaque cas écrit, ses entrées nommées ou « aucune entrée », chacune lue par SA, AD, l’auteur hors administration et un compte refusé, l’export CSV par SA et AD, montants relus en base, base remise en état après chaque cas', async () => {
      for (const c of cas) await jouer(c);
    });

    // Cadrage §2.3 : les comptes hors administration reçoivent 403 sans écriture, le réglage posé ; passage automatique au
    // nom du compte système, réglage vide puis réglé. Aucune route HTTP ne lance le passage automatique, et son minuteur
    // ne démarre qu'au lancement du serveur (server/index.ts), pas quand les tests l'importent : la fonction exportée
    // executerGenerationVisites({ type: 'AUTOMATIQUE' }) est donc appelée, comme api.test.mjs (l. 14643 et 14673). Écart de
    // forme, déclaré : la ligne porte le compte SYSTEME et la route « passage automatique ».
    testPrepare('génération des visites : comptes hors administration refusés sans écriture, le réglage posé ; passage automatique au nom du compte système, réglage vide puis réglé, et ses entrées lues', async () => {
      const route = 'POST /api/contrats-maintenance/generation-visites';
      const [methode, chemin] = route.split(' ');
      const refuses = COMPTES_JOUES.filter((c) => !GESTION_CONTRATS.includes(c));
      // Réglage posé, puis les comptes refusés en parallèle, une empreinte pour le lot ; rejoués un à un si le lot écrit.
      const regler = async () => { const p = REGLAGE_GENERATION(); await api(p.compte, p.methode, p.chemin, p.corps()); return remise.empreinte(); };
      let etat = await regler();
      const resultats = await enParallele(refuses.map((compte) => async () => ({ compte, res: await appeler(appli.adresse, methode, chemin, { jeton: jetons[compte], corps: {} }) })), 8);
      if (tablesChangees(etat, await remise.empreinte()).length) {
        await remise.remettre(remise.changees(await remise.empreinte()), 'lot des comptes refusés de la génération');
        for (const compte of refuses) await jouer({ compte, route, cible: SANS_CIBLE, contexte: CONTEXTE_GENERATION, corps: corpsVide, chemin, prealables: [REGLAGE_GENERATION()] });
      } else {
        for (const { compte, res } of resultats) lignes.push(ligneMatrice({ compte, methode, chemin, cible: SANS_CIBLE, contexte: CONTEXTE_GENERATION, reponse: reponseEcriture(formaterReponse(res, { ecriture: 'inchangé' }), [], null) }));
        await remise.remettre(remise.changees(await remise.empreinte()), 'réglage de la génération');
      }
      // Passage automatique : réglage vide (défaut), puis réglé à trente jours par AD.
      for (const [contexte, reglage] of [['anticipation vide', false], [CONTEXTE_GENERATION, true]]) {
        etat = reglage ? await regler() : remise.reference;
        const passage = await appli.serveur.executerGenerationVisites({ type: 'AUTOMATIQUE' });
        const apres = await remise.empreinte();
        const changees = tablesChangees(etat, apres);
        const entrees = await entreesNouvelles(lecture);
        const c = { compte: AUTEUR_SYSTEME, route: 'passage automatique', cible: SANS_CIBLE, contexte };
        const debut = `${passage ? 'passage' : 'aucun passage'} ${changees.length ? `écrit (${changees.join(',')})` : 'inchangé'}`;
        const sansReglage = entrees.filter((e) => !(e.table === 'JournalAdministration' && e.ligne.type === 'PARAMETRES'));
        lignes.push(ligneMatrice({ compte: AUTEUR_SYSTEME, methode: 'passage', chemin: 'automatique', cible: SANS_CIBLE, contexte, reponse: reponseEcriture(debut, sansReglage, null) }));
        await lireEntrees(c, sansReglage, entrees, []);
        assert.deepEqual(tablesChangees(apres, await remise.empreinte()), [], 'passage automatique : une lecture des journaux a écrit');
        const aRemettre = remise.changees(apres);
        if (aRemettre.length) await remise.remettre(aRemettre, `passage automatique, ${contexte}`);
      }
    });

    // Cadrage §2.2 : « Filtres du journal d'administration (liste et export), pour SA et AD, sur un petit lot d'entrées
    // écrites sans remise entre elles : type=CLE_INTEGRATION, type=COMPTE, cible=<SA>, auteur=<SA>, auteur=DEMARRAGE. »
    testPrepare('filtres du journal d’administration : liste et export, lus par SA et AD, sur quatre écritures sans remise entre elles ; entrées nouvelles visibles, entrées anciennes présentes ou non, filtre respecté, export identique à la liste', async () => {
      const filtres = [
        ['type=CLE_INTEGRATION', { type: 'CLE_INTEGRATION' }, (e) => e.type === 'CLE_INTEGRATION'],
        ['type=COMPTE', { type: 'COMPTE' }, (e) => e.type === 'COMPTE'],
        ['cible=compte-superadmin', { cible: comptes.SA.id }, (e) => e.cibleId === comptes.SA.id],
        ['auteur=SA', { auteur: comptes.SA.id }, (e) => e.auteurId === comptes.SA.id],
        ['auteur=DEMARRAGE', { auteur: 'DEMARRAGE' }, (e) => e.auteurId === null],
      ];
      const contexte = 'quatre écritures sans remise entre elles';
      // Exports filtrés de référence (base à l'état de référence), puis le lot.
      const references = {};
      for (const [nom, requete] of filtres) references[nom] = await lireExports({ appeler, adresse: appli.adresse, jetons, requete });
      // La base est remise quoi qu'il arrive (finally), pour que la comparaison à la référence reste lisible ; le nombre
      // d'entrées du lot n'est vérifié qu'après la remise.
      let nouvelles = [];
      try {
        await api(SA, 'PUT', `/api/users/${comptes.SA.id}/permissions`, { permissions: ['clients:read'] });
        await api(SA, 'POST', `/api/admin/api-keys/${id('cle', 'cle-active')}/revoke`, {});
        await api('AD', 'PATCH', `/api/users/${comptes.COM.id}/actif`, { actif: false });
        await api(SA, 'PATCH', `/api/users/${comptes.COM.id}/acces-finance`, { accesFinance: true });
        const apres = await remise.empreinte();
        nouvelles = await entreesNouvelles(lecture, { tables: ['JournalAdministration'] });
        for (const [nom, requete, predicat] of filtres) {
          for (const lecteur of ['SA', 'AD']) {
            const liste = await appeler(appli.adresse, 'GET', '/api/journal-administration', { jeton: jetons[lecteur], requete });
            const elements = liste.body?.entrees ?? [];
            const visibles = nouvelles.filter((e) => elements.some((x) => x.id === e.ligne.id)).map((e) => nommerEntree(e, noms)).sort();
            const anciennes = elements.some((x) => !nouvelles.some((e) => e.ligne.id === x.id));
            const paginee = liste.body?.total !== elements.length;
            lignes.push(ligneMatrice({ compte: lecteur, methode: 'GET', chemin: '/api/journal-administration', cible: nom, contexte, reponse: `${liste.status} ; nouvelles : ${visibles.join(' + ') || 'aucune'} ; anciennes : ${anciennes ? 'présentes' : 'aucune'} ; filtre ${elements.every(predicat) ? 'respecté' : 'non respecté'}${paginee ? ' ; liste paginée' : ''}` }));
            const exportCsv = await appeler(appli.adresse, 'GET', '/api/journal-administration/export.csv', { jeton: jetons[lecteur], requete, octets: true });
            const texte = exportCsv.octets.toString('utf8').replace(/^\uFEFF/, '');
            const visiblesCsv = nouvelles.filter((e) => {
              const fin = finDeLigneCsv(e.ligne);
              const ecart = compterFinDeLigne(texte, fin) - compterFinDeLigne(references[nom][lecteur], fin);
              const memes = nouvelles.filter((x) => finDeLigneCsv(x.ligne) === fin).length;
              assert.ok(ecart === 0 || ecart === memes, `export filtré ${nom} lu par ${lecteur} : impossible de conclure sur « ${nommerEntree(e, noms)} »`);
              return ecart > 0;
            }).map((e) => nommerEntree(e, noms)).sort();
            // Mêmes entrées que la liste (page entière) : la fin de ligne de chaque entrée de la liste, comptée dans l'export.
            const lignesExport = texte.split('\n').filter(Boolean).slice(1);
            const memesEntrees = lignesExport.length === elements.length
              && elements.every((x) => compterFinDeLigne(texte, finDeLigneCsv(x)) === elements.filter((y) => finDeLigneCsv(y) === finDeLigneCsv(x)).length);
            const anciennesCsv = lignesExport.length > visiblesCsv.length;
            const comparaison = paginee ? 'liste paginée, export non comparé' : memesEntrees ? 'mêmes entrées que la liste' : 'entrées différentes de la liste';
            lignes.push(ligneMatrice({ compte: lecteur, methode: 'GET', chemin: '/api/journal-administration/export.csv', cible: nom, contexte, reponse: `${exportCsv.status} ; nouvelles : ${visiblesCsv.join(' + ') || 'aucune'} ; anciennes : ${anciennesCsv ? 'présentes' : 'aucune'} ; ${comparaison}` }));
          }
        }
        assert.deepEqual(tablesChangees(apres, await remise.empreinte()), [], 'filtres : une lecture a écrit');
      } finally {
        const aRemettre = remise.changees(await remise.empreinte());
        if (aRemettre.length) await remise.remettre(aRemettre, 'filtres du journal d’administration');
      }
      assert.equal(nouvelles.length, 4, 'quatre entrées écrites par le lot des filtres');
    });

    // Lecture des lignes enregistrées, pour les tests qui suivent.
    const reponseDe = (compte, route, cible, contexte) => {
      const debut = [compte, route, cible, contexte].join(SEPARATEUR) + SEPARATEUR;
      const trouvees = lignes.filter((l) => l.startsWith(debut));
      assert.equal(trouvees.length, 1, `ligne attendue : ${debut}`);
      return trouvees[0].slice(debut.length);
    };
    // Verdicts des lectures des entrées d'un cas : [{ lecteur, route, entree, verdict }].
    const lecturesDuCas = (auteur, route, cible, contexte) => lignes
      .map((l) => l.split(SEPARATEUR))
      .filter(([, , cibleLecture, ctx]) => ctx === contexte && cibleLecture.endsWith(` ← ${auteur} ${route} sur ${cible}`))
      .map(([lecteur, routeLecture, cibleLecture, , verdict]) => ({ lecteur, route: routeLecture, entree: cibleLecture.split(' ← ')[0], verdict }));

    // Cadrage §2.2 : « Entrées fermées à un simple administrateur (concernent un SA, ou réservées au SA), écrites par une
    // action […]. Pour chacune, SA « visible » et AD « absente » sont attendus. » ; écarts connus de visibilité, « à
    // appliquer » (passation, section 4 ; #133) : entrées d'un SA sur un compte ordinaire, et compte devenu SA, lues par AD.
    testPrepare('visibilité : entrées fermées à un simple administrateur visibles du seul SA (liste et export), historique des clés refusé à AD ; écarts connus lus par AD (entrée d’un SA sur un compte ordinaire, compte devenu SA)', () => {
      const JA = ['GET /api/journal-administration', 'GET /api/journal-administration/export.csv'];
      const fermees = [
        [SA, 'PUT /api/users/:id/permissions', 'compte-superadmin', 'défaut, corps permissions=clients:read', ['COMPTE PERMISSIONS']],
        [SA, 'PATCH /api/users/:id/acces-finance', 'compte-superadmin', 'défaut, corps accesFinance=oui', ['COMPTE ACCES_FINANCE']],
        [SA, 'PATCH /api/users/:id/est-commercial', 'compte-superadmin', 'défaut, corps estCommercial=oui', ['COMPTE AUSSI_COMMERCIAL']],
        [SA, 'PATCH /api/users/:id/role', 'compte-technicien', 'défaut, corps role=SUPERADMIN', ['COMPTE TYPE_COMPTE', 'COMPTE FICHE_INTERVENANT']],
        [SA, 'PATCH /api/users/:id/role', 'compte-commercial', 'rattaché à RESP par AD, puis corps role=SUPERADMIN', ['COMPTE TYPE_COMPTE']],
        [SA, 'PATCH /api/users/:id/responsable-hierarchique', 'compte-commercial', 'défaut, corps responsable=SA', ['COMPTE RATTACHEMENT']],
        [SA, 'POST /api/users', SANS_CIBLE, 'défaut, corps role=SUPERADMIN', ['COMPTE CREATION']],
        [SA, 'DELETE /api/users/:id', 'compte-superadmin-second', 'défaut', ['COMPTE SUPPRESSION', 'COMPTE RATTACHEMENT']],
        [SA, 'POST /api/admin/api-keys', SANS_CIBLE, 'défaut, corps nom et scope', ['CLE_INTEGRATION CREATION']],
        [SA, 'POST /api/admin/api-keys/:id/revoke', 'cle-active', 'défaut', ['CLE_INTEGRATION REVOCATION']],
      ];
      for (const [auteur, route, cible, contexte, natures] of fermees) {
        const lues = lecturesDuCas(auteur, route, cible, contexte).filter((l) => l.entree.startsWith('JournalAdministration '));
        for (const nature of natures) {
          const deLEntree = lues.filter((l) => l.entree.startsWith(`JournalAdministration ${nature} par `));
          assert.ok(deLEntree.length, `${route} sur ${cible} : entrée ${nature} absente`);
          for (const l of deLEntree) assert.match(l.entree, /, (concerne un SA|réservée au SA)/, `${route} sur ${cible} : ${l.entree} sans marque`);
          for (const routeLecture of JA) {
            assert.deepEqual(deLEntree.filter((l) => l.route === routeLecture).map((l) => `${l.lecteur} ${l.verdict}`).sort(), [...(routeLecture === JA[0] ? ['CT 403 « Accès réservé aux administrateurs »'] : []), 'AD 200 absente', 'SA 200 visible'].sort(), `${route} sur ${cible}, ${nature}, ${routeLecture}`);
          }
        }
      }
      // Historique des clés : SA lit la clé créée et la clé révoquée ; AD est refusé.
      for (const [route, cible, contexte, action] of [['POST /api/admin/api-keys', SANS_CIBLE, 'défaut, corps nom et scope', 'CREATION'], ['POST /api/admin/api-keys/:id/revoke', 'cle-active', 'défaut', 'REVOCATION']]) {
        const cles = lecturesDuCas(SA, route, cible, contexte).filter((l) => l.route === 'GET /api/admin/api-keys');
        assert.deepEqual(cles.map((l) => `${l.entree} : ${l.lecteur} ${l.verdict}`).sort(), [`ApiAccessKey CLE ${action}${action === 'CREATION' ? ' par SA' : ', créée par SA'} : AD 403 « Accès réservé au super administrateur »`, `ApiAccessKey CLE ${action}${action === 'CREATION' ? ' par SA' : ', créée par SA'} : SA 200 visible`].sort());
      }
      // Écarts connus, enregistrés tels quels : l'entrée d'un SA sur un compte ordinaire est lue par AD ; l'entrée écrite
      // sur un compte devenu SA depuis l'est aussi.
      for (const [route, cible, contexte, nature] of [['PUT /api/users/:id/permissions', 'compte-commercial', 'défaut, corps permissions=finances:read', 'COMPTE PERMISSIONS'], ['PATCH /api/users/:id/acces-finance', 'compte-commercial', 'défaut, corps accesFinance=oui', 'COMPTE ACCES_FINANCE']]) {
        const lues = lecturesDuCas(SA, route, cible, contexte).filter((l) => l.entree === `JournalAdministration ${nature} par SA` && l.lecteur === 'AD');
        assert.deepEqual(lues.map((l) => l.verdict), ['200 visible', '200 visible'], `${route} sur ${cible} : écart connu, entrée d’un SA sur un compte ordinaire lue par AD`);
      }
      const devenuSa = lecturesDuCas(SA, 'PATCH /api/users/:id/role', 'compte-commercial', 'rattaché à RESP par AD, puis corps role=SUPERADMIN').filter((l) => l.entree === 'préalable JournalAdministration COMPTE RATTACHEMENT par AD' && l.lecteur === 'AD');
      assert.deepEqual(devenuSa.map((l) => l.verdict), ['200 visible', '200 visible'], 'écart connu : l’entrée écrite sur un compte devenu SA depuis reste lue par AD');
    });

    // Cadrage §2.1 : « Écritures sans entrée, enregistrées telles quelles (« aucune entrée »), chacune reliée à sa source
    // dans le corps de la PR » ; écritures jamais vues « écrit » en 5a et 5b, jouées ici.
    testPrepare('écritures sans entrée enregistrées telles quelles (conversion en chantier, comptes comptables, taux horaire, clôture et réouverture d’un chantier, corps vides) ; mentions légales sans auteur ; écritures jamais vues en 5a et 5b, avec leur entrée', () => {
      const sansEntree = cas.filter((c) => c.source === 'sans entrée');
      assert.ok(sansEntree.length >= 14, `cas « sans entrée » : ${sansEntree.length}`);
      for (const c of sansEntree) assert.match(reponseDe(c.compte, c.route, c.cible, c.contexte), /^20\d écrit \([^)]*\) ; aucune entrée$/, `${c.compte} ${c.route} sur ${c.cible} (${c.contexte})`);
      for (const compte of [SA, 'AD']) {
        assert.match(reponseDe(compte, 'POST /api/mentions-legales', SANS_CIBLE, 'défaut, corps mentions, CGV et pénalités'), / ; entrées : MentionsLegalesVersion VERSION CREATION, sans auteur$/);
        assert.match(reponseDe(compte, 'POST /api/mentions-legales/:version/publier', 'version-brouillon', 'défaut'), / ; entrées : MentionsLegalesVersion VERSION PUBLICATION, sans auteur \+ MentionsLegalesVersion VERSION RETRAIT, sans auteur$/);
        assert.match(reponseDe(compte, 'POST /api/devis/:id/convertir', 'devis-converti-intervention', 'défaut, corps cible=CHANTIER'), new RegExp(` ; entrées : JournalSaisieChantier INTERVENTION RATTACHEMENT_CHANTIER par ${compte}$`));
        assert.match(reponseDe(compte, 'POST /api/contrats-maintenance/:id/avancer-echeance', 'contrat-visite-terminee', 'défaut, corps sans corps'), new RegExp(`^200 écrit \\(.*\\) ; entrées : JournalSaisieChantier CONTRAT AVANCEMENT_ECHEANCE par ${compte}$`));
        assert.match(reponseDe(compte, 'POST /api/planning/share', SANS_CIBLE, 'défaut'), new RegExp(` ; entrées : JournalAdministration PARTAGE_PLANNING [A-Z_]+ par ${compte}$`));
        assert.match(reponseDe(compte, 'PATCH /api/planning/share', SANS_CIBLE, 'défaut'), new RegExp(` ; entrées : JournalAdministration PARTAGE_PLANNING DESACTIVATION par ${compte}$`));
      }
      assert.match(reponseDe(SA, 'DELETE /api/company/logo', SANS_CIBLE, 'défaut, logo posé'), / ; entrées : JournalAdministration SOCIETE LOGO_DOCUMENTS_RETIRE par SA$/);
      assert.match(reponseDe(SA, 'PATCH /api/users/:id/acces-finance', 'compte-commercial', 'défaut, corps accesFinance=oui'), / ; entrées : JournalAdministration COMPTE ACCES_FINANCE par SA$/);
      assert.match(reponseDe('AD', 'PATCH /api/users/:id/est-commercial', 'compte-administrateur', 'défaut, corps estCommercial=oui'), / ; entrées : JournalAdministration COMPTE AUSSI_COMMERCIAL par AD$/);
    });

    // Cadrage §2.3 : « Chaque administrateur obtient 201 et écrit le passage, la visite et son entrée, au nom de
    // l'administrateur. Les 12 autres comptes reçoivent 403, sans écriture. » ; passage automatique au nom du compte
    // système ; réglage vide : 409 aux administrateurs, 403 aux autres (témoin), et le passage automatique n'écrit rien.
    testPrepare('génération des visites : passage manuel au nom de chaque administrateur et de l’assistante technique (AT-2a), refus des autres comptes sans écriture, passage automatique au nom du compte système, rien sans réglage', () => {
      const route = 'POST /api/contrats-maintenance/generation-visites';
      for (const compte of GESTION_CONTRATS) {
        const reponse = reponseDe(compte, route, SANS_CIBLE, CONTEXTE_GENERATION);
        assert.match(reponse, /^201 écrit \(/, compte);
        for (const entree of [`ExecutionGenerationVisites MANUEL REUSSIE par ${compte}`, `JournalSaisieChantier INTERVENTION CREATION_CONTRAT par ${compte}`, `JournalSaisieChantier CONTRAT AVANCEMENT_ECHEANCE par ${compte}`]) assert.ok(reponse.includes(entree), `${compte} : ${entree} absente de « ${reponse} »`);
      }
      for (const compte of COMPTES_JOUES.filter((c) => !GESTION_CONTRATS.includes(c))) assert.equal(reponseDe(compte, route, SANS_CIBLE, CONTEXTE_GENERATION), REFUS_GESTION_CONTRATS, compte);
      assert.equal(reponseDe('AD', route, SANS_CIBLE, 'anticipation vide, témoin de la matrice des entrées'), '409 « La génération automatique des visites est désactivée : réglez d’abord son anticipation. » inchangé ; aucune entrée');
      assert.equal(reponseDe('DIR', route, SANS_CIBLE, 'anticipation vide, témoin de la matrice des entrées'), '409 « La génération automatique des visites est désactivée : réglez d’abord son anticipation. » inchangé ; aucune entrée');
      assert.equal(reponseDe('AT', route, SANS_CIBLE, 'anticipation vide, témoin de la matrice des entrées'), '409 « La génération automatique des visites est désactivée : réglez d’abord son anticipation. » inchangé ; aucune entrée');
      assert.equal(reponseDe('CT', route, SANS_CIBLE, 'anticipation vide, témoin de la matrice des entrées'), REFUS_GESTION_CONTRATS);
      assert.equal(reponseDe(AUTEUR_SYSTEME, 'passage automatique', SANS_CIBLE, 'anticipation vide'), 'aucun passage inchangé ; aucune entrée');
      const automatique = reponseDe(AUTEUR_SYSTEME, 'passage automatique', SANS_CIBLE, CONTEXTE_GENERATION);
      for (const entree of ['ExecutionGenerationVisites AUTOMATIQUE REUSSIE par SYSTEME', 'JournalSaisieChantier INTERVENTION CREATION_CONTRAT par SYSTEME', 'JournalSaisieChantier CONTRAT AVANCEMENT_ECHEANCE par SYSTEME']) assert.ok(automatique.includes(entree), `passage automatique : ${entree} absente de « ${automatique} »`);
      // Les entrées du compte système sont lues par SA et AD, et refusées au compte témoin de chaque lecture (CT, ou COM
      // pour l'intervention), qui remplace le directeur depuis le lot « Directeur aligné sur l'administration ».
      const lues = lecturesDuCas(AUTEUR_SYSTEME, 'passage automatique', SANS_CIBLE, CONTEXTE_GENERATION);
      assert.ok(lues.length >= 9, `lectures des entrées du passage automatique : ${lues.length}`);
      for (const l of lues) {
        if (!['SA', 'AD'].includes(l.lecteur)) assert.match(l.verdict, /^403 « /, `${l.lecteur} ${l.route} ${l.entree}`);
        else assert.equal(l.verdict, '200 visible', `${l.lecteur} ${l.route} ${l.entree}`);
      }
    });

    // Cadrage §2.4 : « Le montant relu en base est égal au montant envoyé, ou, pour un taux copié, à celui de sa source au
    // moment de la saisie. L'instantané de l'entrée porte le même montant […]. Le constat termine la ligne, sans
    // chiffre. » Un cas de ces couples sans relecture, ou une relecture fausse, est classé C par l'auditeur-montants.
    testPrepare('montants relus en base : achats et pointages (créés, corrigés, dont la demande de changement de chantier, ignorée, archivés, restaurés), coûts SAV (créés, corrigés, archivés, restaurés) et barèmes de rémunération, chaque compte qui les écrit, montant écrit égal au montant envoyé ou au taux source et montant journalisé identique', () => {
      const avecMontant = cas.filter((c) => c.montant);
      // Chaque route d'un montant (§2.4) a sa relecture, pour chaque compte qui la joue.
      const routes = ['POST /api/achats', 'PATCH /api/achats/:id', 'DELETE /api/achats/:id', 'POST /api/achats/:id/restaurer', 'POST /api/heures', 'PATCH /api/heures/:id', 'DELETE /api/heures/:id', 'POST /api/heures/:id/restaurer',
        'POST /api/interventions/:id/couts/achats', 'POST /api/interventions/:id/couts/heures', 'PATCH /api/interventions/:id/couts/:type/:coutId', 'POST /api/interventions/:id/couts/:type/:coutId/:action', 'PUT /api/parametres/remuneration'];
      for (const route of routes) {
        const deLaRoute = cas.filter((c) => c.route === route);
        assert.ok(deLaRoute.length, `${route} : aucun cas`);
        for (const c of deLaRoute) assert.ok(c.montant, `${c.compte} ${route} (${c.contexte}) : aucune relecture du montant`);
      }
      for (const c of avecMontant) assert.ok(reponseDe(c.compte, c.route, c.cible, c.contexte).endsWith(` ; ${CONSTAT_MONTANT}`), `${c.compte} ${c.route} sur ${c.cible} (${c.contexte}) : ${reponseDe(c.compte, c.route, c.cible, c.contexte)}`);
      diagnostics.push(`montants relus en base : ${avecMontant.length} cas`);
    });

    // Cadrage de 5c, §3 et §2.4 (« Hors de la référence ») : la matrice obtenue est la référence, au caractère près ;
    // aucune ligne, d'écriture ou de lecture, ne porte de montant (garde du test 7 de 5a et 5b, N6 du contrôle de #437,
    // étendue aux lignes de lecture et au compte système, chiffres lus par \p{Nd}, N1 de l'audit des montants de #440).
    testPrepare('la matrice obtenue est la référence matrice-droits/journaux.txt, chaque cas et chaque lecture y ont une ligne, aucune ligne ne porte de montant, et la base est revenue à l’état de référence', async (t) => {
      const cles = lignes.map((l) => l.split(SEPARATEUR).slice(0, 4).join(SEPARATEUR));
      const doublons = cles.filter((c, i) => cles.indexOf(c) !== i);
      assert.deepEqual(doublons, [], 'chaque cas et chaque lecture n’ont qu’une ligne');
      const comptesAdmis = [...COMPTES_JOUES, AUTEUR_SYSTEME];
      const ciblesAdmises = ['taux=20'];
      // Témoin de la garde : chaque forme de montant est refusée, une ligne juste est admise.
      const temoins = [
        ['SA | POST /api/achats | — | défaut | 200 écrit (AchatReel) ; aucune entrée', false],
        ['SA | GET /api/journal-administration | JournalAdministration COMPTE CREATION par SA ← SA POST /api/users sur — | défaut | 200 visible', false],
        ['AD | GET /api/journal-administration | JournalRegleComptable TVA REMAPPAGE par AD ← AD PUT /api/comptabilite/tva/:taux sur taux=20 | défaut | 200 absente', false],
        ['SYSTEME | passage automatique | — | anticipation vide | aucun passage inchangé ; aucune entrée', false],
        ['SA | POST /api/achats | — | défaut | 200 écrit (AchatReel) ; montant 12.5', true],
        ['SA | POST /api/achats | — | défaut | 200 écrit (AchatReel) ; montant 12,50 €', true],
        ['SA | POST /api/achats | — | défaut | 200 écrit (AchatReel) ; montant ١٢', true],
        ['SA | GET /api/journal-administration | entrée ← SA PUT /api/x sur taux=20 | défaut | 200 visible 150', true],
        ['SA | GET /api/journal-administration | entrée 87 ← SA PUT /api/x sur — | défaut | 200 visible', true],
        ['SYSTEME | passage automatique | — | anticipation de 30 jours | aucun passage inchangé', true],
      ];
      for (const [ligne, refusee] of temoins) assert.equal(lignesAvecMontant([ligne], { comptes: comptesAdmis, ciblesAdmises, journaux: true }).length === 1, refusee, `garde « aucun montant », témoin : ${ligne}`);
      // Le comportement par défaut d'outils.mjs (5a et 5b) ne change pas : une ligne de lecture n'y est pas admise.
      assert.equal(lignesAvecMontant([temoins[1][0]], { comptes: COMPTES_JOUES }).length, 1, 'comportement par défaut de lignesAvecMontant');
      // Option `comptesAChiffre` (posée par D1a-5d-1) : un mutant qui fait écrire CT-N1 imprime son diff au lieu d'échouer sur
      // la garde (N2 de l'audit des droits de #456, suivi #457).
      assert.deepEqual(lignesAvecMontant(lignes, { comptes: comptesAdmis, ciblesAdmises, journaux: true, comptesAChiffre: true }), [], 'lignes qui portent un montant, ou un nombre hors du code de la réponse et des comptes d’objets d’un refus');
      // Remise (cadrage §5) : la base est revenue à l'état de référence après le dernier cas, filtres compris ; vérifié
      // après la comparaison à la référence, dont le diff nomme mieux un écart.
      const etatFinal = remise.changees(await remise.empreinte());
      const ecritures = lignes.filter((l) => !l.split(SEPARATEUR)[2].includes(' ← ') && !l.split(SEPARATEUR)[1].startsWith('GET '));
      for (const texte of diagnostics) t.diagnostic(texte);
      t.diagnostic(`lignes : ${lignes.length} (écritures ${ecritures.length}, lectures ${lignes.length - ecritures.length}) ; écritures jouées ${chiffres.ecritures} ; entrées nouvelles ${chiffres.entrees} ; lectures ${chiffres.lectures} ; remises ${remise.remises} ; montants relus ${chiffres.montants}`);
      comparerAvecReference(lignes, REFERENCE, 'journaux.txt', { champsResume: 2 });
      assert.deepEqual(etatFinal, [], 'la base n’est pas revenue à l’état de référence après le dernier cas');
    });
  });
}
