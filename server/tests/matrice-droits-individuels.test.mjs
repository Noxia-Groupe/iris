// Lot D1a-4 : droits individuels sans gain d'effet, tests seuls (cadrage du lot D1a, version 3 du 01-11-2026, §3,
// ligne D1a-4, et §6 ; CIBLE §8.1, invariant « Migration sans gain d'effet », et décision 2).
//
// CIBLE §8.1 : « Avant D1, un test enregistre, pour un compte de chaque type portant chaque droit individuel possible,
// les cases comme chaque scope seul, ce que ce compte peut lire et faire. » Cadrage §3, ligne D1a-4 : « pour chaque type
// et chaque droit individuel possible (les 13 scopes d'API_SCOPES, plus accesFinance), ce que ce droit ajoute au même
// type sans droit, en entrée (routes de D1a-1) et en données (lectures de D1a-3). La référence ne liste que les gains. »
//
// Tests seuls : ce fichier enregistre le comportement actuel, sans rien corriger (cadrage §1 et §7). Pour chaque type de
// compte (comptes.mjs, les dix types) et chaque droit individuel, le droit est donné au compte du type par la route
// d'administration, comme le fait l'écran (PUT /api/users/:id/permissions, PATCH /api/users/:id/acces-finance, session
// du super administrateur, journalisées), le compte rejoue ses cas, puis le droit lui est retiré, même en cas d'échec.
// Le compte garde ses relations avec les cibles du jeu de données (titulaire, branche, affectation) : chaque type a un
// chantier dans son périmètre (note N2 de l'audit des montants de #433).
//
// Droits joués :
//  - les 13 scopes d'API_SCOPES, relus à l'exécution (GET /api/admin/api-scopes), chacun seul ;
//  - l'accès financier (accesFinance) ;
//  - la case « droit devis » de l'écran, qui pose ensemble devis:read, devis:write et clients:read
//    (client/src/lib/droitDevis.ts, DROITS_DEVIS ; CIBLE §8.1, « les cases comme chaque scope seul ») : seule la case
//    ouvre GET /api/devis/a-convertir, qui exige devis:read et devis:write.
// Le technicien ne reçoit ni devis:read, ni devis:write, ni chantiers:write, ni chantiers:archive, ni finances:read, ni
// l'accès financier (DROITS_INTERDITS_TECHNICIEN, server/src/droits/permissions.ts:33 et :40) : la route d'administration
// le refuse (400), refus enregistré. Le droit est alors posé en base, comme une permission enregistrée avant un
// changement de type (MODELE-DROITS-COMPTES.md : « une permission ou un accès financier déjà enregistrés restent sans
// effet »), et le technicien rejoue ses cas : ce droit ne doit rien lui ajouter.
//
// Cas (réduction du cadrage §3 : « Chaque compte « type + droit » n'est joué que là où le même type sans droit est
// refusé, voit une liste restreinte ou un champ masqué, ou reçoit un 400 marqué validation-avant-droit »), calculés et
// non écrits en dur :
//  - entrée : les cas d'entrees.txt (D1a-1, réglages par défaut) où le type sans droit est refusé (401, 403, 404, 409,
//    410) ou reçoit « 400 validation-avant-droit » ; entrees.txt donne la réponse du type sans droit ;
//  - données : les lectures où le type sans droit reçoit 200 et voit autre chose que le super administrateur sur la
//    même lecture (éléments, clés, statut des montants de la liste fermée, valeurs des droits), ou ne voit pas un
//    montant de la liste fermée qu'un autre compte voit sur le même objet ; décrites par les outils de D1a-3
//    (formes.mjs) dans la base du fichier, avant tout droit.
// Pour limiter la durée (cadrage §4), chaque type rejoue ses cas en trois temps, par des sondes, dont chaque appel
// renseigne sur plusieurs droits à la fois :
//  1. le compte portant TOUS les droits à la fois (posés en base, ce n'est pas un cas de la matrice) joue tous les cas ;
//  2. sur les seuls cas que cette sonde change, le compte portant les droits d'un même groupe (devis et clients ;
//     Travaux ; autres), posés en base de même ;
//  3. chaque droit seul, par la route d'administration, sur les cas que la sonde de son groupe change, plus sa lecture
//     de GET /api/me (ses permissions effectives) et, pour les montants (cadrage §6), une lecture de chaque montant de
//     la liste fermée que le type ne voit pas.
// Raison : dans server/src, un droit ne se lit qu'en positif (permissionsEffectives, requirePermission, `includes`). Un
// droit seul ne peut donc changer une réponse que la sonde de tous les droits, ou celle de son groupe, laisse identique
// à celle du type sans droit. Une route où aucune sonde ne change rien n'est pas rejouée par le compte « type + droit »
// (écart de forme au cadrage §4, déclaré) ; elle l'est par la sonde, sur chaque cas.
//
// Ce qui est enregistré, par rapport au même type sans droit, au caractère près :
//  - matrice-droits/individuels.txt, les GAINS, et eux seuls (cadrage §3) : un refus devenu un 2xx ou un 400 sans
//    validation-avant-droit ; un élément de liste en plus ; un champ en plus, montants compris (statut « présent »,
//    « null » ou « absent », jamais la valeur). Une lecture ouverte par un droit y décrit ses listes et ses montants ;
//  - matrice-droits/individuels-sans-gain.txt, à part : un refus devenu un autre refus ou un « 400
//    validation-avant-droit » (D1a-5 les tranchera par une écriture réelle), un élément ou un champ en moins, une valeur
//    de droit changée (permissions de GET /api/me et de GET /api/users), et l'octroi refusé d'un droit (technicien).
// Attendus (cadrage §3) : le droit devis ; corriger et archiver Travaux là où assertChantierWritable admet le compte ;
// rien pour le technicien ; rien pour les autres droits. Tout autre gain est un écart (cadrage §7), que la référence
// enregistre tel quel.
//
// Aucune écriture par les cas joués : écritures (a) à corps vide, (b) sur un identifiant inexistant, (c) jouées en dernier,
// une à la fois (cadrage §2.4) ; l'empreinte de toute la base, prise après l'octroi d'un droit et avant son retrait,
// prouve qu'aucun cas n'a écrit. L'octroi et le retrait écrivent, eux, le droit et son journal, hors des empreintes.
// Le test qui écrit dans la base (montants mis à zéro) est joué après les comparaisons aux références.
//
// Comme les autres fichiers de la matrice, ce fichier crée sur le serveur de TEST_DATABASE_URL une base jetable qui
// n'appartient qu'à lui, la migre, la sert à l'application, puis la supprime. Sans TEST_DATABASE_URL, il s'annonce
// ignoré : un SKIP n'est pas une réussite.
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { join } from 'node:path';
import {
  CONTEXTE_DEFAUT, DOSSIER_MATRICES, EMAIL_SECOURS, JETON_SECOURS, SEPARATEUR, appeler, baseJetable, chargerApplication,
  comparerAvecReference, empreinteBase, enParallele, formaterReponse, lireReference, normaliserTexte, tablesChangees, tablesDeLaBase, trier,
} from './matrice-droits/outils.mjs';
import { COMPTES_JOUES, COMPTE_SYSTEME_ID, TYPES_DE_COMPTE, creerComptes } from './matrice-droits/comptes.mjs';
import { FAMILLES, INEXISTANT, cheminPour, cibleDe, ciblesDe, construireJeuDeDonnees, jourSociete } from './matrice-droits/donnees.mjs';
import { ROUTES_SESSION } from './matrice-droits/routes.mjs';
import { MONTANTS_MASQUES, MONTANTS_MIS_A_ZERO, TYPES_MONTANTS } from './matrice-droits/montants-masques.mjs';
import {
  ABSENT, NUL, PRESENT, afficherChemin, clesDecrites, comparer, creerRegistre, listeDeNoms, listePremierNiveau, nommer,
  objetsAuChemin, parcourir, statut, valeurDecrite,
} from './matrice-droits/formes.mjs';

const TITRE = 'Lot D1a-4 : droits individuels sans gain d’effet (ce que chaque droit individuel ajoute à chaque type de compte)';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const REFERENCE_GAINS = join(DOSSIER_MATRICES, 'individuels.txt');
const REFERENCE_SANS_GAIN = join(DOSSIER_MATRICES, 'individuels-sans-gain.txt');
const REFERENCE_ENTREES = join(DOSSIER_MATRICES, 'entrees.txt');
// Une ligne : compte (type), droit, route, cible, contexte, objet décrit, changement. Clé : les six premiers champs.
const CHAMPS_CLE = 6;
const SA = 'SA';
const TECH = 'TECH';
const TYPES = TYPES_DE_COMPTE.map((type) => type.cle);
const CODES_REFUS = new Set([401, 403, 404, 409, 410]);
const REPONSE_VAD = '400 validation-avant-droit';
const ENTREE = 'entrée';
const OCTROI = 'octroi';
const ROUTE_ME = 'GET /api/me';

// Case « droit devis » de l'écran d'administration (client/src/lib/droitDevis.ts, DROITS_DEVIS).
const DROIT_DEVIS = { nom: 'droit devis', scopes: ['devis:read', 'devis:write', 'clients:read'] };
const ACCES_FINANCE = { nom: 'accesFinance', accesFinance: true };
// Groupes des sondes intermédiaires : une partition des droits joués, par domaine (le dernier groupe prend le reste).
const GROUPES = [
  { nom: 'devis et clients', droits: ['devis:read', 'devis:write', DROIT_DEVIS.nom, 'clients:read', 'clients:write'] },
  { nom: 'Travaux', droits: ['chantiers:read', 'chantiers:write', 'chantiers:archive'] },
  { nom: 'autres', droits: null },
];

// Paramètres de requête fixes des lectures (la cible reste « — »), mêmes raisons que D1a-3
// (matrice-droits-donnees.test.mjs, REQUETES) : la plage du planning, sans laquelle la route répond 400 ; les
// statistiques datées sur la période qui contient la veille, jour des saisies du jeu de données ; l'assiduité sur la
// semaine qui précède la semaine en cours, qui ne contient aucune heure saisie. Le tableau de bord est lu, lui aussi,
// sur le mois de la veille (note N8 de l'audit des montants de #433, suivie dans #428) : rien ne dépend du jour.
const isoDe = (jour) => jour.split('-').reverse().join('-');
const REQUETES = {
  'GET /api/planning/events': () => ({ start: jourSociete(-3), end: jourSociete(3) }),
  'GET /api/stats/global': () => ({ period: 'month', ref: isoDe(jourSociete(-1)) }),
  'GET /api/stats/intervenants': () => ({ period: 'week', ref: isoDe(jourSociete(-1)) }),
  'GET /api/stats/fournisseurs': () => ({ period: 'month', ref: isoDe(jourSociete(-1)) }),
  'GET /api/stats/conducteurs/assiduite': () => ({ week: isoDe(jourSociete(-7)) }),
};
// Entrée : la plage du planning, comme entrees.txt (matrice-droits-entrees.test.mjs, REQUETES.plage).
const requeteEntree = (route) => (ROUTES_SESSION[route].requete === 'plage' ? REQUETES['GET /api/planning/events']() : undefined);
// Liste des clients désactivés (cible « actif=false » de D1a-3) : un technicien ne la reçoit pas.
const VARIANTES = { 'GET /api/clients': [{ nom: 'actif=false', requete: { actif: 'false' } }] };
// Valeurs de droits relevées (et non des montants) : les permissions effectives que lit l'écran.
const VALEURS = {
  'GET /api/me': { chemin: '.', champs: ['role', 'accesFinance', 'permissions'] },
  'GET /api/users': { chemin: '[]', champs: ['role', 'accesFinance', 'permissions', 'permissionsIndividuelles'] },
};
// Lecture dont les données ne sont pas comparées, avec sa raison (écart de forme déclaré) : le journal
// d'administration enregistre chaque octroi et chaque retrait de ce fichier, si bien que la liste de l'administrateur
// grandit d'un passage à l'autre sans rapport avec son droit. Son entrée, elle, reste jouée.
const LECTURES_NON_COMPAREES = {
  'GET /api/journal-administration': 'le journal d’administration grandit à chaque octroi et chaque retrait d’un droit par ce fichier',
};
// Cibles propres à ce fichier, de la famille « intervention » (compléments, plus bas), jouées par les lectures de leur
// famille ; entrees.txt ne les connaît pas.
const CIBLES_COMPLEMENTAIRES = {
  intervention: [
    { nom: 'intervention-chantier-ct-heures', description: 'en cours, chantier chantier-ct, affectée à TECH, heures du technicien au prix de vente figé' },
    { nom: 'intervention-issue-devis', description: 'en cours, issue d’un devis converti en intervention, sans chantier, affectée à TECH' },
    { nom: 'intervention-issue-devis-ct', description: 'à planifier, issue d’un devis converti en intervention, sans chantier, créée par CT (posé en base)' },
  ],
};

// Ligne d'une référence de ce fichier : sept champs, sans « | » ni espace en bord de champ.
function ligneIndividuelle({ type, droit, route, cible, contexte, objet, changement }) {
  const champs = [type, droit, route, cible, contexte, objet, changement];
  for (const champ of champs) assert.ok(String(champ) && !String(champ).includes('|') && String(champ) === String(champ).trim() && !/\n/.test(champ), `champ de ligne invalide : « ${champ} »`);
  return champs.join(SEPARATEUR);
}
const codeDe = (reponse) => Number(String(reponse).split(' ')[0]);
const estRefus = (reponse) => CODES_REFUS.has(codeDe(reponse));
const estAdmis = (reponse) => (codeDe(reponse) >= 200 && codeDe(reponse) < 300) || (codeDe(reponse) === 400 && reponse !== REPONSE_VAD);
// Cadrage §3 : « Un gain est le passage d'un refus (401, 403, 404, 409, 410) à un 2xx ou à un 400 sans
// validation-avant-droit ». Un 400 marqué validation-avant-droit masque un refus : son passage à un 2xx est un gain.
const genreEntree = (avant, apres) => ((estRefus(avant) || avant === REPONSE_VAD) && estAdmis(apres) ? 'gain' : 'sans gain');
const sansDoublon = (liste) => [...new Set(liste)];

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const base = baseJetable(TEST_DATABASE_URL, 'individuels');
    let appli; let tables = [];
    let comptes = {};
    let droits = [];
    let scopes = [];
    const registre = creerRegistre();
    const lignesGains = [];
    const lignesSansGain = [];
    // Réponse de la route d'administration à l'octroi de chaque droit : type | droit → réponse.
    const octrois = new Map();
    const ecrituresInattendues = [];
    // Entrée : toutes les lignes d'entrees.txt de chaque type (réglages par défaut), puis les seuls cas réduits.
    const toutesLesEntrees = new Map();
    const casEntree = new Map();
    // Routes à refus uniforme de chaque type : type → route → premier cas (voir le calcul, plus bas).
    const routesUniformes = new Map();
    // Données : lectures de chaque type sans droit (réglages par défaut), lectures restreintes, lecture témoin
    // (GET /api/me), lectures qui couvrent les montants de la liste fermée qu'il ne voit pas.
    const lecturesParType = new Map();
    const casDonnees = new Map();
    const temoins = new Map();
    const couvertures = new Map();
    // Comptes « type + droit » joués (type | droit), et routes d'entrée qu'ils ont jouées (type | droit | route).
    const comptesJoues = new Set();
    const routesJoueesEntree = new Set();
    // Montants de la liste fermée qu'aucun type sans droit ne lit masqués, sans réglage qui les masque : rang → couples
    // (type, route) d'une route du montant refusée au type sur toutes ses cibles ; et, par type, le premier cas de
    // chacune de ces routes, joué par chaque compte « type + droit ».
    const montantsALEntree = new Map();
    const casMontantsEntree = new Map();
    const appels = { sondeTous: 0, sondesGroupes: 0, droitsSeuls: 0 };
    // Montants de la liste fermée (cadrage §6) : objets qui le portent (un compte sans droit l'y voit présent :
    // route | cible | élément | rang de l'entrée) ; montant nul ou absent pour un type sans droit (type | contexte |
    // route | cible | élément | rang) ; montant lu par un compte « type + droit » (type | droit | contexte | route |
    // cible | élément | rang).
    const portes = new Set();
    const masquesSansDroit = new Set();
    const jouesAvecDroit = new Set();
    const montantsOuverts = [];

    const jetonSA = () => comptes[SA].jeton;
    const empreinte = () => empreinteBase(appli.prisma, tables);
    const api = async (compte, methode, chemin, corps, statut = 200) => {
      const res = await appeler(appli.adresse, methode, chemin, { jeton: comptes[compte].jeton, corps: methode === 'GET' ? undefined : corps });
      const admis = Array.isArray(statut) ? statut : [statut];
      assert.ok(admis.includes(res.status), `${methode} ${chemin} (${compte}) : ${res.status} ${JSON.stringify(res.body)?.slice(0, 400)}`);
      return res.body;
    };
    const droitNomme = (nom) => {
      const droit = droits.find((d) => d.nom === nom);
      assert.ok(droit, `droit inconnu : ${nom}`);
      return droit;
    };
    const cleMontant = (...parties) => parties.join(SEPARATEUR);
    const routesDuMontant = (entree) => Object.keys(TYPES_MONTANTS[entree.type].routes).filter((route) => ROUTES_SESSION[route] && (!entree.routes || entree.routes.includes(route)));
    const rangsMasquesSansDroit = () => new Set([...masquesSansDroit].map((cle) => cle.split(SEPARATEUR)).filter((p) => portes.has(cleMontant(p[2], p[3], p[4], p[5]))).map((p) => Number(p[5])));

    // --- Droits : octroi et retrait ---
    // Octroi par la route d'administration (session du super administrateur), comme l'écran. Refusé (technicien) :
    // réponse notée, puis droit posé en base. Le droit est relu en base dans les deux cas.
    const octroyer = async (type, droit) => {
      const compte = comptes[type];
      const res = droit.accesFinance
        ? await appeler(appli.adresse, 'PATCH', `/api/users/${compte.id}/acces-finance`, { jeton: jetonSA(), corps: { accesFinance: true } })
        : await appeler(appli.adresse, 'PUT', `/api/users/${compte.id}/permissions`, { jeton: jetonSA(), corps: { permissions: droit.scopes } });
      // Le refus d'un octroi est un 400 de droit, et non de validation : son message est gardé.
      const reponse = res.status === 200 ? '200' : `${res.status} « ${normaliserTexte(res.body?.error ?? res.body?.message ?? '')} »`;
      const cle = [type, droit.nom].join(SEPARATEUR);
      if (octrois.has(cle)) assert.equal(reponse, octrois.get(cle), `${cle} : octroi différent d’un passage à l’autre`);
      octrois.set(cle, reponse);
      if (res.status !== 200) await appli.prisma.user.update({ where: { id: compte.id }, data: droit.accesFinance ? { accesFinance: true } : { permissions: droit.scopes } });
      const lu = await appli.prisma.user.findUniqueOrThrow({ where: { id: compte.id }, select: { permissions: true, accesFinance: true } });
      assert.deepEqual(lu, droit.accesFinance ? { permissions: [], accesFinance: true } : { permissions: [...droit.scopes], accesFinance: false }, `${cle} : droit enregistré`);
    };
    // Retrait par la même route (un droit se retire toujours, même à un technicien) ; le compte revient sans droit.
    const retirer = async (type, droit) => {
      const compte = comptes[type];
      const res = droit.accesFinance
        ? await appeler(appli.adresse, 'PATCH', `/api/users/${compte.id}/acces-finance`, { jeton: jetonSA(), corps: { accesFinance: false } })
        : await appeler(appli.adresse, 'PUT', `/api/users/${compte.id}/permissions`, { jeton: jetonSA(), corps: { permissions: [] } });
      assert.equal(res.status, 200, `${type}, retrait de ${droit.nom} : ${res.status} ${JSON.stringify(res.body)}`);
      await verifierSansDroit(type);
    };
    const verifierSansDroit = async (type) => {
      const lu = await appli.prisma.user.findUniqueOrThrow({ where: { id: comptes[type].id }, select: { permissions: true, accesFinance: true } });
      assert.deepEqual(lu, { permissions: [], accesFinance: false }, `${type} : sans droit individuel`);
    };
    // Joue `jouer` le droit donné, et le retire même en cas d'échec ; l'empreinte de toute la base est prise après
    // l'octroi et avant le retrait : l'écriture du droit et de son journal n'y entre pas.
    const avecDroit = async (type, droit, jouer) => {
      await octroyer(type, droit);
      try {
        return await sousEmpreinte(`${type} + ${droit.nom}`, jouer);
      } finally {
        await retirer(type, droit);
      }
    };
    // Sonde : plusieurs droits à la fois, posés en base (ce n'est pas un cas de la matrice), puis retirés en base.
    const avecSonde = async (type, liste, etiquette, jouer) => {
      const permissions = sansDoublon(liste.flatMap((droit) => droit.scopes ?? []));
      await appli.prisma.user.update({ where: { id: comptes[type].id }, data: { permissions, accesFinance: liste.some((droit) => droit.accesFinance) } });
      try {
        return await sousEmpreinte(`${type} + ${etiquette} (sonde)`, jouer);
      } finally {
        await appli.prisma.user.update({ where: { id: comptes[type].id }, data: { permissions: [], accesFinance: false } });
        await verifierSansDroit(type);
      }
    };
    // Empreinte avant et après : une écriture est notée, avec le compte, les tables et les écritures admises (2xx ou
    // 400) jouées par ce compte, seules à pouvoir avoir écrit ; le test de la phase échoue.
    const sousEmpreinte = async (etiquette, jouer) => {
      const avant = await empreinte();
      const { resultat, admises } = await jouer();
      const changees = tablesChangees(avant, await empreinte());
      if (changees.length) ecrituresInattendues.push(`${etiquette} : ${changees.join(', ')} ; écritures admises : ${admises.join(' ; ') || '(aucune)'}`);
      return resultat;
    };

    // --- Appels ---
    const jouerEntree = async (type, cas) => {
      const [methode, chemin] = cas.route.split(' ');
      const definition = ROUTES_SESSION[cas.route];
      const res = await appeler(appli.adresse, methode, cheminPour(chemin, definition.famille, cas.cible.ids ? cas.cible : null), {
        jeton: comptes[type].jeton, corps: methode === 'GET' ? undefined : {}, requete: requeteEntree(cas.route),
      });
      return { res, reponse: formaterReponse(res, { validationAvantDroit: !!definition.validationAvantDroit }) };
    };
    const lire = async (compte, cas) => {
      const chemin = cas.route.split(' ')[1];
      const definition = ROUTES_SESSION[cas.route];
      return appeler(appli.adresse, 'GET', cheminPour(chemin, definition.famille, cas.cible.ids ? cas.cible : null), { jeton: comptes[compte].jeton, requete: cas.requete });
    };
    // Un lot : des cas d'entrée et des lectures. Les écritures (c) de l'entrée sont jouées en dernier, une à la fois
    // (cadrage §2.4) ; tout le reste en parallèle.
    const jouerLot = async (type, entrees, lectures) => {
      const reponses = new Array(entrees.length);
      const lues = new Array(lectures.length);
      const enC = (cas) => ROUTES_SESSION[cas.route].ecriture === 'c';
      await enParallele([
        ...entrees.map((cas, rang) => (enC(cas) ? null : async () => { reponses[rang] = await jouerEntree(type, cas); })).filter(Boolean),
        ...lectures.map(({ cas }, rang) => async () => { lues[rang] = await lire(type, cas); }),
      ], 8);
      for (const [rang, cas] of entrees.entries()) if (enC(cas)) reponses[rang] = await jouerEntree(type, cas);
      const admises = entrees.filter((cas, rang) => !cas.route.startsWith('GET ') && estAdmis(reponses[rang].reponse)).map((cas) => `${cas.route} (${cas.nomCible})`);
      return { resultat: { entrees: reponses, lectures: lues }, admises };
    };

    // --- Description d'une lecture ---
    // Cibles lues d'une route : celles de sa famille (D1a-1), les cibles propres à ce fichier, les variantes de requête.
    const casDeLecture = (route) => {
      const definition = ROUTES_SESSION[route];
      const chemin = route.split(' ')[1];
      const cas = ciblesDe(definition, chemin).map((cible) => ({ route, nomCible: cible.nom, cible, requete: REQUETES[route]?.(), propre: false }));
      if (definition.famille && CIBLES_COMPLEMENTAIRES[definition.famille]) {
        for (const cible of CIBLES_COMPLEMENTAIRES[definition.famille]) cas.push({ route, nomCible: cible.nom, cible, requete: REQUETES[route]?.(), propre: true });
      }
      for (const variante of VARIANTES[route] ?? []) cas.push({ route, nomCible: variante.nom, cible: { nom: variante.nom }, requete: variante.requete, propre: true });
      return cas;
    };
    // Description d'une réponse 200, avec les outils de D1a-3 (formes.mjs) : objet décrit → { genre, texte, … }, et
    // statut des montants de la liste fermée (jamais leur valeur).
    const decrire = (route, res) => {
      const objets = new Map();
      const montants = [];
      const type = String(res.type ?? '').split(';')[0].trim();
      if (type !== 'application/json') {
        objets.set('réponse', { genre: 'réponse', texte: `200 ${type || '(sans type)'}` });
        return { objets, montants };
      }
      const corps = res.body;
      const { objets: formes, listes } = parcourir(corps, registre);
      for (const [chemin, noms] of listes) {
        const nommes = noms.filter((nom) => typeof nom === 'string');
        if (!nommes.length && !(listePremierNiveau(chemin) && noms.length === 0)) continue;
        const sansIdentifiant = noms.filter((nom) => nom === null).length;
        objets.set(`éléments ${chemin}`, { genre: 'éléments', chemin, noms: nommes, sansIdentifiant, texte: `${listeDeNoms(nommes)}${sansIdentifiant ? ` + ${sansIdentifiant} sans identifiant` : ''}` });
      }
      for (const [chemin, forme] of formes) objets.set(`clés ${afficherChemin(chemin)}`, { genre: 'clés', forme, texte: clesDecrites(forme) });
      for (const [nomType, typeMontant] of Object.entries(TYPES_MONTANTS)) {
        const cheminType = typeMontant.routes[route];
        if (!cheminType) continue;
        for (const objet of objetsAuChemin(corps, cheminType)) {
          const entrees = MONTANTS_MASQUES.map((entree, rang) => ({ entree, rang })).filter(({ entree }) => entree.type === nomType && (!entree.routes || entree.routes.includes(route)) && (!typeMontant.selon || entree.cible === objet[typeMontant.selon]));
          if (!entrees.length) continue;
          const element = cheminType === '.' ? '.' : nommer(objet, registre) ?? '(sans identifiant)';
          const cle = `montants ${element}`;
          if (!objets.has(cle)) objets.set(cle, { genre: 'montants', champs: new Map() });
          const champs = objets.get(cle).champs;
          for (const { entree, rang } of entrees) {
            for (const champ of entree.chemins) {
              const statuts = statut(objet, champ);
              if (!statuts.length) continue;
              montants.push({ rang, champ, element, statuts });
              champs.set(champ, trier(new Set([...(champs.get(champ) ?? []), ...statuts])));
            }
          }
        }
      }
      for (const [cle, objet] of objets) {
        if (objet.genre !== 'montants') continue;
        if (!objet.champs.size) { objets.delete(cle); continue; }
        objet.texte = [...objet.champs].map(([champ, statuts]) => `${champ}=${statuts.join('/')}`).join(', ');
      }
      const valeurs = VALEURS[route];
      if (valeurs) {
        for (const objet of objetsAuChemin(corps, valeurs.chemin)) {
          const element = valeurs.chemin === '.' ? '.' : nommer(objet, registre) ?? '(sans identifiant)';
          const champs = new Map(valeurs.champs.map((champ) => [champ, valeurDecrite(objet, champ) ?? ABSENT]));
          objets.set(`valeurs ${element}`, { genre: 'valeurs', champs, texte: [...champs].map(([champ, valeur]) => `${champ}=${valeur}`).join(' ; ') });
        }
      }
      return { objets, montants };
    };
    const signature = (description) => [...description.objets].map(([objet, { texte }]) => `${objet}=${texte}`).sort(comparer).join('\n');
    const memeLecture = (lecture, res) => res.status === 200 && signature(decrire(lecture.cas.route, res)) === lecture.signature;

    // Ce qu'un compte « type + droit » voit de plus (gain) ou de moins ou d'autre (sans gain) que le type sans droit.
    // `avant` null : lecture ouverte par le droit (refusée sans lui) ; seuls ses listes de premier niveau et ses
    // montants, réunis en une ligne (statuts de chaque champ, tous éléments confondus), sont décrits.
    const ecart = (avant, apres) => {
      const sorties = [];
      if (avant === null) {
        for (const [objet, b] of apres.objets) {
          if (b.genre === 'éléments' && listePremierNiveau(b.chemin)) sorties.push({ objet, genre: 'gain', texte: `+ ${b.texte}` });
        }
        const champs = new Map();
        for (const { champ, statuts } of apres.montants) champs.set(champ, trier(new Set([...(champs.get(champ) ?? []), ...statuts])));
        if (champs.size) sorties.push({ objet: 'montants', genre: 'gain', texte: `+ ${[...champs].sort(([a], [b]) => comparer(a, b)).map(([champ, statuts]) => `${champ}=${statuts.join('/')}`).join(', ')}` });
        return sorties;
      }
      for (const objet of trier(new Set([...avant.objets.keys(), ...apres.objets.keys()]))) {
        const a = avant.objets.get(objet);
        const b = apres.objets.get(objet);
        if (a && b && a.texte === b.texte) continue;
        if (!b) { sorties.push({ objet, genre: 'sans gain', texte: `- ${a.texte}` }); continue; }
        if (!a) { sorties.push({ objet, genre: 'gain', texte: `+ ${b.texte}` }); continue; }
        if (b.genre === 'éléments') {
          const compter = (liste) => liste.reduce((m, nom) => m.set(nom, (m.get(nom) ?? 0) + 1), new Map());
          const [ca, cb] = [compter(a.noms), compter(b.noms)];
          const plus = []; const moins = [];
          for (const [nom, n] of cb) for (let k = ca.get(nom) ?? 0; k < n; k += 1) plus.push(nom);
          for (const [nom, n] of ca) for (let k = cb.get(nom) ?? 0; k < n; k += 1) moins.push(nom);
          const plusSansId = Math.max(0, b.sansIdentifiant - a.sansIdentifiant);
          const moinsSansId = Math.max(0, a.sansIdentifiant - b.sansIdentifiant);
          if (plus.length || plusSansId) sorties.push({ objet, genre: 'gain', texte: `+ ${[plus.length ? listeDeNoms(plus) : null, plusSansId ? `${plusSansId} sans identifiant` : null].filter(Boolean).join(' + ')}` });
          if (moins.length || moinsSansId) sorties.push({ objet, genre: 'sans gain', texte: `- ${[moins.length ? listeDeNoms(moins) : null, moinsSansId ? `${moinsSansId} sans identifiant` : null].filter(Boolean).join(' + ')}` });
        } else if (b.genre === 'clés') {
          // « ? » : clé que ne portent pas tous les objets du chemin ; « k? → k » est un champ en plus.
          const partielles = (forme) => new Map([...forme.cles].map(([cle, n]) => [cle, n < forme.n]));
          const [pa, pb] = [partielles(a.forme), partielles(b.forme)];
          const plus = [...pb.keys()].filter((cle) => !pa.has(cle) || (pa.get(cle) && !pb.get(cle))).map((cle) => (pa.has(cle) ? `${cle}? → ${cle}` : cle));
          const moins = [...pa.keys()].filter((cle) => !pb.has(cle) || (!pa.get(cle) && pb.get(cle))).map((cle) => (pb.has(cle) ? `${cle} → ${cle}?` : cle));
          if (plus.length) sorties.push({ objet, genre: 'gain', texte: `+ ${plus.sort(comparer).join(', ')}` });
          if (moins.length) sorties.push({ objet, genre: 'sans gain', texte: `- ${moins.sort(comparer).join(', ')}` });
        } else if (b.genre === 'montants') {
          // Gain : un montant nul ou absent sans le droit, présent avec lui. Tout autre changement de statut : sans gain.
          const gagnes = []; const autres = [];
          for (const champ of trier(new Set([...a.champs.keys(), ...b.champs.keys()]))) {
            const sa = a.champs.get(champ)?.join('/') ?? '(non porté)';
            const sb = b.champs.get(champ)?.join('/') ?? '(non porté)';
            if (sa === sb) continue;
            const ouvert = (b.champs.get(champ) ?? []).includes(PRESENT) && !(a.champs.get(champ) ?? []).includes(PRESENT);
            (ouvert ? gagnes : autres).push(`${champ} : ${sa} → ${sb}`);
          }
          if (gagnes.length) sorties.push({ objet, genre: 'gain', texte: gagnes.join(', ') });
          if (autres.length) sorties.push({ objet, genre: 'sans gain', texte: autres.join(', ') });
        } else if (b.genre === 'valeurs') {
          // Une liste (permissions) se lit par ce qu'elle gagne et perd ; une autre valeur, avant → après.
          const elements = (valeur) => (valeur === '(aucune)' ? [] : valeur.split('+'));
          const changes = [...b.champs].filter(([champ, valeur]) => a.champs.get(champ) !== valeur).map(([champ, valeur]) => {
            const avantValeur = a.champs.get(champ);
            if (!/^(permissions|permissionsIndividuelles)$/.test(champ)) return `${champ} : ${avantValeur} → ${valeur}`;
            const [ea, eb] = [elements(avantValeur), elements(valeur)];
            return `${champ} : ${[...eb.filter((x) => !ea.includes(x)).map((x) => `+ ${x}`), ...ea.filter((x) => !eb.includes(x)).map((x) => `- ${x}`)].join(', ')}`;
          });
          sorties.push({ objet, genre: 'sans gain', texte: changes.join(' ; ') });
        } else {
          sorties.push({ objet, genre: 'sans gain', texte: `${a.texte} → ${b.texte}` });
        }
      }
      return sorties;
    };
    const enregistrer = (genre, champs) => (genre === 'gain' ? lignesGains : lignesSansGain).push(ligneIndividuelle(champs));

    // Une lecture rejouée avec le droit, comparée à la même lecture sans le droit (`avant`), ou ouverte par lui à
    // l'entrée (`avant` null).
    const comparerLecture = ({ type, droit, contexte, cas, avant, res }) => {
      if (res.status !== 200) {
        enregistrer('sans gain', { type, droit: droit.nom, route: cas.route, cible: cas.nomCible, contexte, objet: ENTREE, changement: `200 → ${formaterReponse(res)}` });
        return;
      }
      const apres = decrire(cas.route, res);
      for (const { rang, element, statuts } of apres.montants) {
        jouesAvecDroit.add(cleMontant(type, droit.nom, contexte, cas.route, cas.nomCible, element, rang));
        if (statuts.includes(PRESENT) && (avant === null || masquesSansDroit.has(cleMontant(type, contexte, cas.route, cas.nomCible, element, rang)))) {
          montantsOuverts.push(`${type} + ${droit.nom}, ${contexte} : ${cas.route} (${cas.nomCible}), ${element}, ${MONTANTS_MASQUES[rang].chemins.join(' / ')}`);
        }
      }
      for (const { objet, genre, texte } of ecart(avant?.description ?? null, apres)) {
        enregistrer(genre, { type, droit: droit.nom, route: cas.route, cible: cas.nomCible, contexte, objet, changement: texte });
      }
    };
    // Un cas d'entrée rejoué avec le droit : changement de réponse noté ; une lecture ouverte est décrite.
    const comparerEntree = ({ type, droit, cas, joue }) => {
      if (joue.reponse === cas.base) return;
      const genre = genreEntree(cas.base, joue.reponse);
      enregistrer(genre, { type, droit: droit.nom, route: cas.route, cible: cas.nomCible, contexte: CONTEXTE_DEFAUT, objet: ENTREE, changement: `${cas.base} → ${joue.reponse}` });
      if (genre === 'gain' && cas.route.startsWith('GET ') && joue.res.status === 200) {
        comparerLecture({ type, droit, contexte: CONTEXTE_DEFAUT, cas, avant: null, res: joue.res });
      }
    };

    // Compléments du jeu de données, par l'API (session du super administrateur, sauf mention), dans la base du
    // fichier. Ils reprennent ceux de D1a-3 (matrice-droits-donnees.test.mjs, « Compléments propres à D1a-3 ») et y
    // ajoutent ce que la note N5 du contrôle de #433 relevait : un achat et des heures sur les chantiers du commercial,
    // de l'assistante commerciale, du directeur commercial et du comptable, et une intervention issue d'un devis dans le
    // périmètre du conducteur (margeDevis). Aucun ne change une relation des cibles de donnees.mjs ; la matrice vérifie
    // en outre, sur chaque cas d'entrée qu'un droit pourrait changer, que le type sans droit répond toujours comme
    // entrees.txt.
    const completerJeuDeDonnees = async () => {
      const id = (famille, nom) => cibleDe(famille, nom).ids.id;
      const aujourdhui = jourSociete(0);
      const hier = jourSociete(-1);
      const ficheTech = id('fiche-intervenant', 'fiche-tech');
      const ficheLibre = id('fiche-intervenant', 'fiche-libre');
      const clientActif = id('client', 'client-actif');
      // (1) Main d'œuvre du catalogue rattachée à la fiche du technicien (rattachement, prix de vente à l'heure figé).
      const mainOeuvre = await api(SA, 'POST', '/api/catalogue/prestations', {
        estMainOeuvre: true, reference: 'TEST-MATRICE-MO', nom: 'TEST Main d’œuvre matrice', tauxTva: 20,
        prixVenteHt: 60, prixJourHorsContratHt: 420, prixHeureSousContratHt: 55, prixJourSousContratHt: 385, heuresParJour: 7,
      }, 201);
      await api(SA, 'PUT', `/api/intervenants/${ficheTech}/main-oeuvre`, { mainOeuvreId: mainOeuvre.id });
      registre.ajouter(mainOeuvre.id, 'main-oeuvre-matrice');
      // (2) Prix d'achat de la prestation et du modèle d'équipement du parc.
      await api(SA, 'PUT', `/api/catalogue/prestations/${id('fiche-catalogue', 'prestation-catalogue')}`, {
        reference: 'TEST-MATRICE-PRE', nom: 'TEST Prestation catalogue matrice', unite: 'forfait', prixVenteHt: '100', tauxTva: '20', prixAchatHt: '40',
      });
      const modele = (await api(SA, 'GET', '/api/catalogue/equipements')).find((fiche) => fiche.reference === 'TEST-MATRICE-EQ');
      assert.ok(modele, 'modèle d’équipement du jeu de données');
      await api(SA, 'PUT', `/api/catalogue/equipements/${modele.id}`, { reference: 'TEST-MATRICE-EQ', nom: 'TEST Modèle d’équipement', fabricant: 'TEST', prixVenteHt: '100', prixAchatHt: '60', tauxTva: '20' });
      registre.ajouter(modele.id, 'modele-equipement');
      // (3) Un achat et des heures sur les chantiers qui n'en portent pas : celui du technicien (D1a-3), et ceux du
      //     commercial, de l'assistante commerciale, du directeur commercial et du comptable (N5).
      for (const nom of ['chantier-tech-branche-resp', 'chantier-com', 'chantier-com-titulaire', 'chantier-dc', 'chantier-ac', 'chantier-cpt']) {
        const achat = await api(SA, 'POST', '/api/achats', { chantierId: id('chantier', nom), categorieId: id('categorie', 'categorie'), fournisseurId: id('fournisseur', 'fournisseur'), date: hier, description: `TEST Achat de ${nom}`, montantHT: 100 });
        const heure = await api(SA, 'POST', '/api/heures', { chantierId: id('chantier', nom), intervenantId: ficheLibre, date: hier, nbrHeures: 2 });
        registre.ajouter(achat.id, `achat-${nom}`);
        registre.ajouter(heure.id, `heure-${nom}`);
      }
      // (4) Heures du technicien sur son intervention, après le rattachement : prix de vente à l'heure figé.
      const heuresValorisees = await api(TECH, 'POST', `/api/interventions/${id('intervention', 'intervention-affectee-tech')}/couts/heures`, { date: aujourdhui, nbrHeures: 1 }, 201);
      registre.ajouter(heuresValorisees.id, 'heures-tech-valorisees-intervention-affectee');
      const placerEtDemarrer = async (interventionId, ficheId) => {
        await api(SA, 'PUT', `/api/interventions/${interventionId}/planning`, { dateDebut: hier, creneau: 'JOURNEE', intervenantIds: [ficheId] }, [200, 201]);
        if ((await api(SA, 'GET', `/api/interventions/${interventionId}`)).statut === 'A_PLANIFIER') await api(SA, 'PATCH', `/api/interventions/${interventionId}/statut`, { statut: 'PLANIFIEE' });
        await api(SA, 'PATCH', `/api/interventions/${interventionId}/statut`, { statut: 'EN_COURS' });
      };
      // (5) Intervention du chantier du conducteur, affectée au technicien, avec ses heures.
      const interventionCt = await api(SA, 'POST', '/api/interventions', { clientId: clientActif, titre: 'TEST Intervention du chantier du conducteur, heures du technicien', chantierId: id('chantier', 'chantier-ct') }, 201);
      await placerEtDemarrer(interventionCt.id, ficheTech);
      const heuresCt = await api(TECH, 'POST', `/api/interventions/${interventionCt.id}/couts/heures`, { date: hier, nbrHeures: 1 }, 201);
      registre.ajouter(heuresCt.id, 'heures-tech-intervention-chantier-ct-heures');
      // (6) Intervention issue d'un devis, sans chantier, affectée au technicien (marge du devis).
      const signer = async (objet, prix) => {
        const devis = await api(SA, 'POST', '/api/devis', { clientId: clientActif, objet, lignes: [{ designation: `TEST Ligne ${objet}`, nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: prix, tauxTva: 20 }] }, 201);
        await api(SA, 'PUT', `/api/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
        await api(SA, 'POST', `/api/devis/${devis.id}/signature`, { signataire: 'TEST Signataire matrice', confirme: true }, 201);
        return devis;
      };
      const devisIntervention = await signer('TEST Devis converti en intervention', 300);
      const interventionDevis = await api(SA, 'POST', `/api/devis/${devisIntervention.id}/convertir`, { cible: 'INTERVENTION' }, 201);
      await placerEtDemarrer(interventionDevis.id, ficheTech);
      registre.ajouter(devisIntervention.id, 'devis-intervention');
      // (7) N5 : intervention issue d'un devis, sans chantier, dans le périmètre du conducteur (margeDevis). Le
      //     conducteur ne voit une intervention sans chantier que s'il l'a créée (interventions/metier.ts:124), et il ne
      //     la crée par la conversion d'un devis qu'avec le droit devis (MODELE-DROITS-COMPTES.md : « Le conducteur n'a le
      //     droit devis que si un super administrateur le lui accorde individuellement ; il crée alors l'intervention d'un
      //     devis par l'API »). Pour que le jeu de données ne dépende pas du droit que ce fichier éprouve, la conversion
      //     est faite par l'administration, et le créateur posé en base.
      const devisCt = await signer('TEST Devis converti en intervention pour le conducteur', 400);
      const interventionDevisCt = await api(SA, 'POST', `/api/devis/${devisCt.id}/convertir`, { cible: 'INTERVENTION' }, 201);
      await appli.prisma.intervention.update({ where: { id: interventionDevisCt.id }, data: { createdById: comptes.CT.id } });
      registre.ajouter(devisCt.id, 'devis-intervention-ct');
      // (8) Devis dont une ligne porte un prix d'achat prévu (écrit par l'administration seule).
      const devisPrixAchat = await api(SA, 'POST', '/api/devis', { clientId: clientActif, objet: 'TEST Devis avec prix d’achat prévu', lignes: [{ designation: 'TEST Fourniture avec prix d’achat', nature: 'FOURNITURE', quantite: 2, prixUnitaireHt: 50, tauxTva: 20, prixAchatUnitaireHt: 30 }] }, 201);
      registre.ajouter(devisPrixAchat.id, 'devis-prix-achat');
      const cibleIntervention = (nom, interventionId) => {
        const cible = CIBLES_COMPLEMENTAIRES.intervention.find((c) => c.nom === nom);
        cible.ids = { id: interventionId };
        registre.ajouter(interventionId, nom);
      };
      cibleIntervention('intervention-chantier-ct-heures', interventionCt.id);
      cibleIntervention('intervention-issue-devis', interventionDevis.id);
      cibleIntervention('intervention-issue-devis-ct', interventionDevisCt.id);
      // Les faits qui portent ces compléments, relus en base.
      const faits = async (interventionId) => {
        const lue = await appli.prisma.intervention.findUniqueOrThrow({ where: { id: interventionId }, select: { statut: true, chantierId: true, affectations: { select: { intervenantId: true } } } });
        return { statut: lue.statut, chantierId: lue.chantierId, affectes: lue.affectations.map((a) => a.intervenantId) };
      };
      assert.deepEqual(await faits(interventionCt.id), { statut: 'EN_COURS', chantierId: id('chantier', 'chantier-ct'), affectes: [ficheTech] }, 'faits de intervention-chantier-ct-heures');
      assert.deepEqual(await faits(interventionDevis.id), { statut: 'EN_COURS', chantierId: null, affectes: [ficheTech] }, 'faits de intervention-issue-devis');
      assert.deepEqual(await faits(interventionDevisCt.id), { statut: 'A_PLANIFIER', chantierId: null, affectes: [] }, 'faits de intervention-issue-devis-ct');
      assert.equal((await appli.prisma.intervention.findUniqueOrThrow({ where: { id: interventionDevisCt.id }, select: { createdById: true } })).createdById, comptes.CT.id, 'intervention-issue-devis-ct créée par CT');
      for (const heureId of [heuresValorisees.id, heuresCt.id]) {
        assert.notEqual((await appli.prisma.coutInterventionHeure.findUniqueOrThrow({ where: { id: heureId } })).prixVenteHoraireApplique, null, 'heure SAV au prix de vente figé');
      }
    };
    const reglerParametre = async (corps) => {
      const res = await appeler(appli.adresse, 'PUT', '/api/parametres', { jeton: jetonSA(), corps });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    };

    before(async () => {
      await base.creer();
      appli = await chargerApplication(base);
      const connexion = await appeler(appli.adresse, 'POST', '/api/auth/secours', { corps: { token: JETON_SECOURS } });
      assert.equal(connexion.status, 200, JSON.stringify(connexion.body));
      const secours = await appli.prisma.user.findUniqueOrThrow({ where: { email: EMAIL_SECOURS }, select: { id: true, role: true } });
      assert.equal(secours.role, 'SUPERADMIN');
      const crees = await creerComptes({
        prisma: appli.prisma, signer: appli.signer, signerAutreSecret: (id) => appli.jwt.sign({ id }, 'autre-secret-que-celui-de-l-application'),
        secours: { id: secours.id, jeton: connexion.body.token },
        supprimerCompte: async (id) => {
          const res = await appeler(appli.adresse, 'DELETE', `/api/users/${id}`, { jeton: connexion.body.token });
          assert.equal(res.status, 200, JSON.stringify(res.body));
        },
        rattacherCompte: async (id, responsableHierarchiqueId) => {
          const res = await appeler(appli.adresse, 'PATCH', `/api/users/${id}/responsable-hierarchique`, { jeton: connexion.body.token, corps: { responsableHierarchiqueId } });
          assert.equal(res.status, 200, JSON.stringify(res.body));
        },
      });
      comptes = crees.comptes;
      await construireJeuDeDonnees({ prisma: appli.prisma, api, comptes, donnees: crees.donnees });

      // Droits joués : les scopes relus à l'exécution, l'accès financier, la case « droit devis ».
      scopes = (await api(SA, 'GET', '/api/admin/api-scopes')).scopes;
      droits = [...scopes.map((scope) => ({ nom: scope, scopes: [scope] })), ACCES_FINANCE, DROIT_DEVIS];
      const dansUnGroupe = GROUPES.flatMap((groupe) => groupe.droits ?? []);
      GROUPES.find((groupe) => groupe.droits === null).droits = droits.map((droit) => droit.nom).filter((nom) => !dansUnGroupe.includes(nom));

      // Registre des noms (comme D1a-3) : comptes et cibles ; les compléments s'y ajoutent.
      for (const cle of COMPTES_JOUES) registre.ajouter(comptes[cle].id, cle);
      registre.ajouter(crees.donnees.CT_BRANCHE.id, 'CT-BRANCHE');
      registre.ajouter(crees.donnees.CT_TIERS.id, 'CT-TIERS');
      registre.ajouter((await appli.prisma.user.findUniqueOrThrow({ where: { email: 'matrice.desactive@iris.test' }, select: { id: true } })).id, 'DESACTIVE');
      registre.ajouter(COMPTE_SYSTEME_ID, 'SYSTEME');
      const RENOMMES = { 'contact-autre-client': 'contact-client-desactive', 'site-autre-client': 'site-client-desactive', 'equipement-autre-client': 'equipement-client-desactive' };
      for (const { cibles } of Object.values(FAMILLES)) {
        for (const cible of cibles) {
          if (cible.nom === INEXISTANT || cible.nom === 'heures-tech-sous-intervention-autre') continue;
          registre.ajouter(cible.ids.coutId ?? cible.ids.id, RENOMMES[cible.nom] ?? cible.nom);
        }
      }
      await completerJeuDeDonnees();

      // Cas d'entrée de chaque type, relus dans entrees.txt (réglages par défaut).
      const texte = lireReference(REFERENCE_ENTREES);
      assert.ok(texte, `référence absente : ${REFERENCE_ENTREES}`);
      for (const type of TYPES) toutesLesEntrees.set(type, []);
      for (const ligne of texte.split('\n')) {
        if (!ligne) continue;
        const [compte, route, nomCible, contexte, reponse] = ligne.split(SEPARATEUR);
        if (contexte !== CONTEXTE_DEFAUT || !toutesLesEntrees.has(compte)) continue;
        const definition = ROUTES_SESSION[route];
        assert.ok(definition, `${route} : route d’entrees.txt absente de matrice-droits/routes.mjs`);
        // Une écriture (c) porte « écrit » ou « inchangé » : ce n'est pas la réponse.
        const sansEcriture = definition.ecriture === 'c' ? reponse.replace(/ (écrit|inchangé)$/, '') : reponse;
        toutesLesEntrees.get(compte).push({ route, nomCible, cible: definition.famille ? cibleDe(definition.famille, nomCible) : { nom: nomCible }, base: sansEcriture });
      }
      // Réduction du cadrage §3 : seuls les refus et les « 400 validation-avant-droit » sont rejoués à l'entrée.
      for (const type of TYPES) casEntree.set(type, toutesLesEntrees.get(type).filter((cas) => estRefus(cas.base) || cas.base === REPONSE_VAD));
      // Route à refus uniforme : le type sans droit y reçoit le même refus 401, 403, 409 ou 410 sur chaque cible de la
      // famille, `inexistant` comprise. Ce refus ne dépend donc pas de la cible, qu'il précède : la sonde n'en joue
      // qu'une, et toutes les autres dès qu'elle change sa réponse. Un 404 n'en est jamais un : hors du périmètre, une
      // cible réelle reçoit le même 404 qu'une cible absente (chantiers/saisies.ts : « afin de ne pas révéler une affaire
      // hors périmètre »).
      for (const type of TYPES) {
        const parRoute = new Map();
        for (const cas of toutesLesEntrees.get(type)) {
          if (!parRoute.has(cas.route)) parRoute.set(cas.route, []);
          parRoute.get(cas.route).push(cas);
        }
        const uniformes = new Map();
        for (const [route, liste] of parRoute) {
          const reponses = new Set(liste.map((cas) => cas.base));
          const [reponse] = reponses;
          const avecInexistant = !ROUTES_SESSION[route].famille || liste.some((cas) => cas.nomCible === INEXISTANT);
          if (reponses.size === 1 && avecInexistant && estRefus(reponse) && codeDe(reponse) !== 404) uniformes.set(route, liste[0]);
        }
        routesUniformes.set(type, uniformes);
      }

      tables = await tablesDeLaBase(appli.prisma);
      assert.ok(tables.includes('JournalAdministration') && tables.includes('User'), tables.join(', '));
    });

    after(async () => {
      await appli?.fermer();
      await base.supprimer();
    });

    // Cadrage §3, ligne D1a-4 : « pour chaque type et chaque droit individuel possible (les 13 scopes d'API_SCOPES, plus
    // accesFinance) » ; « en entrée (routes de D1a-1) » : entrees.txt donne, pour chaque type, la réponse de chaque route
    // de session sans droit individuel.
    test('préalables : 13 scopes, l’accès financier et la case « droit devis », en trois groupes ; chaque type part sans droit individuel ; entrees.txt donne la réponse de chaque type sans droit sur chaque route de session', async () => {
      assert.equal(scopes.length, 13, `API_SCOPES : ${scopes.join(', ')}`);
      for (const scope of DROIT_DEVIS.scopes) assert.ok(scopes.includes(scope), `droit devis : ${scope} est un scope`);
      assert.equal(droits.length, 15);
      const groupes = GROUPES.flatMap((groupe) => groupe.droits);
      assert.deepEqual([...groupes].sort(), droits.map((droit) => droit.nom).sort(), 'les groupes des sondes partagent les droits joués, chacun une fois');
      for (const type of TYPES) await verifierSansDroit(type);
      const routesSession = Object.keys(ROUTES_SESSION).sort();
      for (const type of TYPES) {
        const vues = new Set(toutesLesEntrees.get(type).map((cas) => cas.route));
        assert.deepEqual(routesSession.filter((route) => !vues.has(route)), [], `${type} : routes de session sans ligne dans entrees.txt`);
        assert.ok(casEntree.get(type).length > 0, `${type} : aucun cas refusé`);
      }
    });

    // Cadrage §3, ligne D1a-4 : « en données (lectures de D1a-3) » ; « Chaque compte « type + droit » n'est joué que là
    // où le même type sans droit […] voit une liste restreinte ou un champ masqué ». Relevé des lectures sans droit : le
    // super administrateur et chaque type, sur chaque lecture qu'il obtient (200 dans entrees.txt, ou rejouée pour les
    // cibles propres à ce fichier) ; lectures restreintes ; objets qui portent un montant de la liste fermée.
    test('lectures sans droit : chaque type sur chaque lecture qu’il obtient, comparée à celle du super administrateur, sans rien écrire', async () => {
      const lectures = Object.keys(ROUTES_SESSION).filter((route) => ROUTES_SESSION[route].lecture && !LECTURES_NON_COMPAREES[route]).sort();
      const tousLesCas = lectures.flatMap(casDeLecture);
      const admis = new Set();
      for (const type of TYPES) for (const cas of toutesLesEntrees.get(type)) if (cas.base === '200' && cas.route.startsWith('GET ')) admis.add([type, cas.route, cas.nomCible].join(SEPARATEUR));
      const avant = await empreinte();
      for (const type of TYPES) {
        const liste = [];
        await enParallele(tousLesCas.filter((cas) => cas.propre || admis.has([type, cas.route, cas.nomCible].join(SEPARATEUR))).map((cas) => async () => {
          const res = await lire(type, cas);
          if (res.status !== 200) {
            assert.ok(cas.propre, `${type} ${cas.route} ${cas.nomCible} : ${res.status}, 200 dans entrees.txt`);
            return;
          }
          const description = decrire(cas.route, res);
          liste.push({ cas, description, signature: signature(description) });
        }), 8);
        liste.sort((a, b) => comparer(`${a.cas.route} ${a.cas.nomCible}`, `${b.cas.route} ${b.cas.nomCible}`));
        lecturesParType.set(type, liste);
        for (const { cas, description } of liste) {
          for (const { rang, element, statuts } of description.montants) {
            if (statuts.includes(PRESENT)) portes.add(cleMontant(cas.route, cas.nomCible, element, rang));
            else masquesSansDroit.add(cleMontant(type, CONTEXTE_DEFAUT, cas.route, cas.nomCible, element, rang));
          }
        }
      }
      assert.deepEqual(tablesChangees(avant, await empreinte()), [], 'une lecture a écrit');
      // Lecture restreinte : le type y voit autre chose que le super administrateur, ou un montant de la liste fermée
      // y est masqué pour lui alors qu'un autre compte sans droit le voit sur le même objet (la commission du
      // commercial au tableau de bord, que l'administration ne reçoit pas).
      const duSA = new Map(lecturesParType.get(SA).map((lecture) => [`${lecture.cas.route} | ${lecture.cas.nomCible}`, lecture]));
      const montantMasque = (lecture) => lecture.description.montants.some(({ rang, element, statuts }) => !statuts.includes(PRESENT) && portes.has(cleMontant(lecture.cas.route, lecture.cas.nomCible, element, rang)));
      for (const type of TYPES) {
        casDonnees.set(type, lecturesParType.get(type).filter((lecture) => duSA.get(`${lecture.cas.route} | ${lecture.cas.nomCible}`)?.signature !== lecture.signature || montantMasque(lecture)));
        const temoin = lecturesParType.get(type).find((lecture) => lecture.cas.route === ROUTE_ME);
        assert.ok(temoin, `${type} : lecture de ${ROUTE_ME}`);
        temoins.set(type, temoin);
        // Lectures qui couvrent les montants de la liste fermée que le type ne voit pas, sur un objet qui les porte :
        // pour chaque montant, une lecture restreinte qui le montre masqué, en préférant une lecture déjà retenue.
        const couverts = new Map(casDonnees.get(type).map((lecture) => [lecture, new Set(lecture.description.montants
          .filter(({ rang, element, statuts }) => !statuts.includes(PRESENT) && portes.has(cleMontant(lecture.cas.route, lecture.cas.nomCible, element, rang)))
          .map(({ rang }) => rang))]));
        const restants = new Set([...couverts.values()].flatMap((rangs) => [...rangs]));
        const retenues = [];
        while (restants.size) {
          // La lecture qui couvre le plus de montants restants ; à égalité, la première (ordre des lectures).
          let meilleure = null; let nombre = 0;
          for (const [lecture, rangs] of couverts) {
            const n = [...rangs].filter((rang) => restants.has(rang)).length;
            if (n > nombre) { meilleure = lecture; nombre = n; }
          }
          retenues.push(meilleure);
          for (const rang of couverts.get(meilleure)) restants.delete(rang);
        }
        couvertures.set(type, retenues);
      }
      assert.deepEqual(casDonnees.get(SA).filter((lecture) => !montantMasque(lecture)), [], 'le super administrateur n’a de lecture restreinte que par un montant que voit un autre compte');
      // Montants qu'aucun type sans droit ne lit masqués et qu'aucun réglage ne masque : joués à l'entrée, sur chaque
      // route du montant, par chaque type à qui cette route est refusée sur toutes ses cibles.
      const vus = rangsMasquesSansDroit();
      for (const type of TYPES) casMontantsEntree.set(type, []);
      MONTANTS_MASQUES.forEach((entree, rang) => {
        if (vus.has(rang) || entree.reglages.length) return;
        const plan = [];
        for (const route of routesDuMontant(entree)) {
          for (const type of TYPES) {
            const cas = toutesLesEntrees.get(type).filter((c) => c.route === route);
            if (!cas.length || cas.some((c) => !estRefus(c.base) && c.base !== REPONSE_VAD)) continue;
            const premier = casEntree.get(type).find((c) => c.route === route);
            plan.push({ type, route });
            if (!casMontantsEntree.get(type).includes(premier)) casMontantsEntree.get(type).push(premier);
          }
        }
        montantsALEntree.set(rang, plan);
      });
    });

    // Cadrage §3, ligne D1a-4, et §4 : chaque type, chaque droit ; sondes, puis droits seuls (voir l'en-tête).
    test('matrice : chaque type avec chaque droit individuel, à l’entrée (refus et 400 validation-avant-droit du type sans droit) et en données (lectures restreintes), sans qu’aucun cas n’écrive', async () => {
      for (const type of TYPES) {
        const entrees = casEntree.get(type);
        const lectures = sansDoublon([...casDonnees.get(type), temoins.get(type)]);
        // 1. Sonde de tous les droits, sur tous les cas ; sur une route à refus uniforme, une cible d'abord, puis les
        //    autres si la sonde change sa réponse.
        const uniformes = routesUniformes.get(type);
        const premiers = entrees.filter((cas) => !uniformes.has(cas.route) || uniformes.get(cas.route) === cas);
        const reponsesSonde = new Map();
        const lecturesChangees = await avecSonde(type, droits, 'tous les droits', async () => {
          const lot = await jouerLot(type, premiers, lectures);
          premiers.forEach((cas, rang) => reponsesSonde.set(cas, lot.resultat.entrees[rang].reponse));
          const routesOuvertes = new Set(premiers.filter((cas) => uniformes.get(cas.route) === cas && reponsesSonde.get(cas) !== cas.base).map((cas) => cas.route));
          const suite = entrees.filter((cas) => routesOuvertes.has(cas.route) && !reponsesSonde.has(cas));
          const lotSuite = await jouerLot(type, suite, []);
          suite.forEach((cas, rang) => reponsesSonde.set(cas, lotSuite.resultat.entrees[rang].reponse));
          appels.sondeTous += premiers.length + suite.length + lectures.length;
          return { resultat: lectures.filter((lecture, rang) => !memeLecture(lecture, lot.resultat.lectures[rang])), admises: [...lot.admises, ...lotSuite.admises] };
        });
        const entreesChangees = entrees.filter((cas) => reponsesSonde.has(cas) && reponsesSonde.get(cas) !== cas.base);
        // Le type sans droit, rejoué sur les cas d'entrée que la sonde change, répond toujours comme entrees.txt : ni les
        // compléments du jeu de données ni l'ordre des tests ne faussent la comparaison.
        if (entreesChangees.length) {
          const sansDroit = await sousEmpreinte(`${type} sans droit`, () => jouerLot(type, entreesChangees, []));
          assert.deepEqual(entreesChangees.map((cas, rang) => `${cas.route} (${cas.nomCible}) : ${sansDroit.entrees[rang].reponse}`), entreesChangees.map((cas) => `${cas.route} (${cas.nomCible}) : ${cas.base}`), `${type} sans droit : réponses d’entrees.txt`);
        }
        for (const groupe of GROUPES) {
          const droitsDuGroupe = groupe.droits.map(droitNomme);
          // 2. Sonde du groupe, sur les cas que la sonde de tous les droits change.
          let entreesDuGroupe = []; let lecturesDuGroupe = [];
          if (entreesChangees.length || lecturesChangees.length) {
            const parGroupe = await avecSonde(type, droitsDuGroupe, `groupe ${groupe.nom}`, () => jouerLot(type, entreesChangees, lecturesChangees));
            appels.sondesGroupes += entreesChangees.length + lecturesChangees.length;
            entreesDuGroupe = entreesChangees.filter((cas, rang) => parGroupe.entrees[rang].reponse !== cas.base);
            lecturesDuGroupe = lecturesChangees.filter((lecture, rang) => !memeLecture(lecture, parGroupe.lectures[rang]));
          }
          // 3. Chaque droit seul : les cas que la sonde de son groupe change, la lecture témoin, les montants.
          for (const droit of droitsDuGroupe) {
            const entreesDuDroit = sansDoublon([...entreesDuGroupe, ...casMontantsEntree.get(type)]);
            const lecturesDuDroit = sansDoublon([...lecturesDuGroupe, temoins.get(type), ...couvertures.get(type)]);
            const joue = await avecDroit(type, droit, () => jouerLot(type, entreesDuDroit, lecturesDuDroit));
            appels.droitsSeuls += entreesDuDroit.length + lecturesDuDroit.length;
            comptesJoues.add([type, droit.nom].join(SEPARATEUR));
            entreesDuDroit.forEach((cas, rang) => {
              routesJoueesEntree.add([type, droit.nom, cas.route].join(SEPARATEUR));
              comparerEntree({ type, droit, cas, joue: joue.entrees[rang] });
            });
            lecturesDuDroit.forEach((lecture, rang) => comparerLecture({ type, droit, contexte: CONTEXTE_DEFAUT, cas: lecture.cas, avant: lecture, res: joue.lectures[rang] }));
          }
        }
      }
      // Chaque compte « type + droit » est joué, au moins sur sa lecture de GET /api/me.
      assert.equal(comptesJoues.size, TYPES.length * droits.length, 'comptes « type + droit » joués');
      assert.deepEqual(ecrituresInattendues, [], 'cas qui ont écrit (compte : tables changées ; écritures admises)');
    });

    // Cadrage §6 : un droit individuel doit être joué sur chaque montant de la liste fermée, y compris ceux qu'un réglage
    // seul masque (MONTANTS_MASQUES, `reglages`). Les montants qu'aucun type sans droit ne lit masqués par défaut le sont
    // sous leur réglage : chaque réglage concerné est changé seul, puis remis ; chaque type rejoue les lectures de ces
    // montants qu'il obtient, et celles où le réglage change ce qu'il voit sont rejouées avec chaque droit, comparées à la
    // même lecture sans droit, sous le même réglage.
    // Les trois destinataires de la rentabilité sont joués aussi pour leurs montants qu'un autre type lit masqués par
    // défaut : chacun coupe une branche de voitRentabilite (directeur, titulaire, responsable de la branche ;
    // chantiers/droits.ts:29-33) qui reste ouverte par défaut. Par défaut, ces montants ne sont joués avec un droit que
    // sur des types que voitRentabilite écarte toujours (commercial, comptable, assistante, directeur commercial,
    // technicien) : un droit qui rendrait la rentabilité au directeur ou au titulaire que la société en a retiré n'y
    // serait pas vu (CIBLE §8.1 : « Un droit enregistré sans effet, comme `finances:read` sur un compte, ne doit pas en
    // gagner un, par exemple les marges »). Ces lectures-là sont jouées comme au test de la matrice : la sonde de tous
    // les droits d'abord, puis chaque droit seul sur les lectures qu'elle change. Chaque branche doit être sondée par le
    // type qu'elle concerne.
    const DESTINATAIRES_RENTABILITE = { 'rentabiliteDirecteurs=non': 'DIR', 'rentabiliteConducteur=non': 'CT', 'rentabiliteHierarchie=non': 'RESP' };
    // La marge commerciale coupée retire de même les marges d'un chantier à tous ceux qui les lisent par défaut
    // (administration, directeur, titulaire, responsable de la branche ; chantiers/suivi.ts:139) : elle est sondée de
    // même, par le directeur au moins.
    const REGLAGES_SONDES = { ...DESTINATAIRES_RENTABILITE, 'margeCommercialeActive=non': 'DIR' };
    test('réglages : les montants de la liste fermée qu’un réglage seul masque, et ceux des destinataires de la rentabilité, joués sous ce réglage par chaque type avec chaque droit individuel', async (t) => {
      const masquesParDefaut = rangsMasquesSansDroit();
      const aJouer = MONTANTS_MASQUES.map((entree, rang) => ({ entree, rang, reglages: entree.reglages.filter((reglage) => !masquesParDefaut.has(rang) || reglage in REGLAGES_SONDES) })).filter(({ reglages }) => reglages.length);
      const contextes = trier(new Set(aJouer.flatMap(({ reglages }) => reglages)));
      assert.deepEqual(Object.keys(REGLAGES_SONDES).filter((contexte) => !contextes.includes(contexte)), [], 'destinataires de la rentabilité et marge commerciale joués sous leur réglage');
      const sondes = new Map(contextes.map((contexte) => [contexte, []]));
      for (const contexte of contextes) {
        const [, cleReglage] = /^([A-Za-z]+)=non$/.exec(contexte) ?? [];
        assert.ok(cleReglage, `contexte de réglage : ${contexte}`);
        const routes = new Set(aJouer.filter(({ reglages }) => reglages.includes(contexte)).flatMap(({ entree }) => routesDuMontant(entree)));
        // Routes des montants qu'aucun type ne lit masqués par défaut : leurs lectures sont rejouées droit par droit.
        const routesDirectes = new Set(aJouer.filter(({ rang, reglages }) => !masquesParDefaut.has(rang) && reglages.includes(contexte)).flatMap(({ entree }) => routesDuMontant(entree)));
        assert.equal((await api(SA, 'GET', '/api/parametres'))[cleReglage], true, `${cleReglage} : valeur par défaut`);
        await reglerParametre({ [cleReglage]: false });
        try {
          for (const type of TYPES) {
            const candidates = lecturesParType.get(type).filter(({ cas }) => routes.has(cas.route));
            const sousReglage = [];
            await enParallele(candidates.map((lecture) => async () => {
              const res = await lire(type, lecture.cas);
              assert.equal(res.status, 200, `${type} ${lecture.cas.route} ${lecture.cas.nomCible}, ${contexte} : ${res.status}`);
              const description = decrire(lecture.cas.route, res);
              if (signature(description) !== lecture.signature) sousReglage.push({ cas: lecture.cas, description, signature: signature(description) });
            }), 8);
            if (!sousReglage.length) continue;
            sousReglage.sort((a, b) => comparer(`${a.cas.route} ${a.cas.nomCible}`, `${b.cas.route} ${b.cas.nomCible}`));
            for (const { cas, description } of sousReglage) {
              for (const { rang, element, statuts } of description.montants) if (!statuts.includes(PRESENT)) masquesSansDroit.add(cleMontant(type, contexte, cas.route, cas.nomCible, element, rang));
            }
            const directes = sousReglage.filter(({ cas }) => routesDirectes.has(cas.route));
            let parSonde = sousReglage.filter(({ cas }) => !routesDirectes.has(cas.route));
            if (parSonde.length) {
              const sonde = await avecSonde(type, droits, `tous les droits, ${contexte}`, () => jouerLot(type, [], parSonde));
              sondes.get(contexte).push(`${type} (${parSonde.length} lecture(s))`);
              parSonde = parSonde.filter((lecture, rang) => !memeLecture(lecture, sonde.lectures[rang]));
            }
            const rejouees = [...directes, ...parSonde];
            if (!rejouees.length) continue;
            for (const droit of droits) {
              const joue = await avecDroit(type, droit, () => jouerLot(type, [], rejouees));
              rejouees.forEach((lecture, rang) => comparerLecture({ type, droit, contexte, cas: lecture.cas, avant: lecture, res: joue.lectures[rang] }));
            }
          }
        } finally {
          await reglerParametre({ [cleReglage]: true });
        }
      }
      t.diagnostic(`types sondés avec tous les droits, par réglage :\n${[...sondes].map(([contexte, types]) => `${contexte} : ${types.join(', ') || 'aucun'}`).join('\n')}`);
      for (const [contexte, type] of Object.entries(REGLAGES_SONDES)) {
        assert.ok(sondes.get(contexte).some((sonde) => sonde.startsWith(`${type} (`)), `${contexte} : ${type}, que ce réglage prive de la rentabilité, sondé avec tous les droits (${sondes.get(contexte).join(', ') || 'aucun'})`);
      }
      assert.deepEqual(ecrituresInattendues, [], 'lectures qui ont écrit');
    });

    // Cadrage §6 : « en D1a-4, un droit individuel (dont finances:read et accesFinance) non joué sur un champ de la liste
    // fermée de D1a-3 » est classé C ; le droit est joué sur un objet qui porte le montant, pour un compte qui a cet objet
    // dans son périmètre (note N2 de l'audit des montants de #433). Pour chaque montant de la liste fermée et chaque
    // droit : un compte « type + droit » a lu un objet qui porte ce montant (un compte sans droit l'y voit présent), que
    // le type sans droit lit sans le voir (nul ou absent), par défaut ou sous le réglage qui le masque. Un montant
    // qu'aucun type de session ne lit sans le voir, ni par défaut ni sous un réglage, est joué à l'entrée : chaque type à
    // qui une route du montant est refusée sur toutes ses cibles l'y a rejouée avec chaque droit.
    test('montants : chaque droit individuel, accès financier et finances:read compris, est joué sur chaque montant de la liste fermée, sur un objet qui le porte, dans le périmètre d’un type qui ne le voit pas', (t) => {
      const manques = [];
      const resume = [];
      MONTANTS_MASQUES.forEach((entree, rang) => {
        const nom = `${entree.type}${entree.cible ? ` (${entree.cible})` : ''} ${entree.chemins.join(' / ')}`;
        const situations = [...masquesSansDroit].map((cle) => cle.split(SEPARATEUR)).filter((p) => Number(p[5]) === rang && portes.has(cleMontant(p[2], p[3], p[4], rang)));
        const plan = montantsALEntree.get(rang) ?? [];
        for (const droit of droits) {
          if (situations.some(([type, contexte, route, cible, element]) => jouesAvecDroit.has(cleMontant(type, droit.nom, contexte, route, cible, element, rang)))) continue;
          if (!situations.length && plan.length && plan.every(({ type, route }) => routesJoueesEntree.has([type, droit.nom, route].join(SEPARATEUR)))) continue;
          manques.push(`${nom} : ${droit.nom} non joué (${situations.length} situation(s) sans droit ; ${plan.length} cas d’entrée)`);
        }
        resume.push(`${nom} : ${situations.length ? `données, ${trier(new Set(situations.map((p) => `${p[0]} ${p[1]}`))).join(', ')}` : `entrée, ${trier(new Set(plan.map((c) => `${c.type} ${c.route}`))).join(', ')}`}`);
      });
      t.diagnostic(`montants de la liste fermée, où chaque droit est joué :\n${resume.join('\n')}`);
      assert.deepEqual(manques, [], 'montants de la liste fermée non joués avec chaque droit');
    });

    // Cadrage §2.1 et §3, ligne D1a-4 : « La référence ne liste que les gains. » Comparée au caractère près (N8 : diff
    // imprimé, matrice obtenue écrite hors du dépôt).
    test('la matrice des gains est la référence matrice-droits/individuels.txt', (t) => {
      verifierLignes(lignesGains);
      t.diagnostic(`montants de la liste fermée ouverts par un droit individuel : ${montantsOuverts.length ? `\n${sansDoublon(montantsOuverts).sort(comparer).join('\n')}` : 'aucun'}`);
      t.diagnostic(`appels : sonde de tous les droits ${appels.sondeTous}, sondes des groupes ${appels.sondesGroupes}, comptes « type + droit » ${appels.droitsSeuls}`);
      comparerAvecReference(lignesGains, REFERENCE_GAINS, 'individuels.txt', { champsCle: CHAMPS_CLE, champsResume: 3 });
    });

    // Cadrage §3, ligne D1a-4 : « Le passage d'un refus à un autre refus, ou à un 400 marqué validation-avant-droit, est
    // enregistré à part, sans être un gain ; D1a-5 le tranche par une écriture réelle. » Le refus d'octroyer un droit à un
    // type (DROITS_INTERDITS_TECHNICIEN, cadrage §3 : « rien pour le technicien ») y figure aussi, avec son message.
    test('les changements sans gain et les octrois refusés sont la référence matrice-droits/individuels-sans-gain.txt', () => {
      const lignes = [...lignesSansGain];
      for (const [cle, reponse] of octrois) {
        if (reponse === '200') continue;
        const [type, droit] = cle.split(SEPARATEUR);
        const route = droit === ACCES_FINANCE.nom ? 'PATCH /api/users/:id/acces-finance' : 'PUT /api/users/:id/permissions';
        lignes.push(ligneIndividuelle({ type, droit, route, cible: `compte-${type}`, contexte: CONTEXTE_DEFAUT, objet: OCTROI, changement: `${reponse} ; droit posé en base` }));
      }
      verifierLignes(lignes);
      comparerAvecReference(lignes, REFERENCE_SANS_GAIN, 'individuels-sans-gain.txt', { champsCle: CHAMPS_CLE, champsResume: 3 });
    });
    const verifierLignes = (lignes) => {
      const cles = lignes.map((ligne) => ligne.split(SEPARATEUR).slice(0, CHAMPS_CLE).join(SEPARATEUR));
      assert.deepEqual(cles.filter((cle, rang) => cles.indexOf(cle) !== rang), [], 'chaque cas n’a qu’une ligne');
      // Aucune ligne de montants ne porte de chiffre : un montant n'y sort que par son statut.
      assert.deepEqual(lignes.filter((ligne) => ligne.split(SEPARATEUR)[5].startsWith('montants') && /\d/.test(ligne.split(SEPARATEUR)[6])), [], 'lignes de montants qui portent un chiffre');
    };

    // Cadrage §6 : les montants masqués par une MISE À ZÉRO (MONTANTS_MIS_A_ZERO), qu'un statut ne distingue pas (un zéro
    // est « présent »), sont joués ici avec chaque droit, APRÈS les comparaisons aux références : deux affaires du
    // commercial COM, ouvertes, clôturées et encaissées par l'administration (comme le test des montants mis à zéro de
    // D1a-3), leur donnent une valeur non nulle par défaut. Sous le réglage, chaque type qui lit la route, avec chaque
    // droit, doit les lire à zéro, jamais non nuls, null ni absents. Aucune valeur n'est écrite ni comparée. Les types
    // refusés sur la route y ont été rejoués à l'entrée, avec tous les droits.
    test('montants mis à zéro par un réglage : aucun droit individuel ne les rend non nuls, null ni absents', async () => {
      const id = (famille, nom) => cibleDe(famille, nom).ids.id;
      const clotures = [];
      for (const baremeReduit of [false, true]) {
        const devis = await api(SA, 'POST', '/api/devis', { clientId: id('client', 'client-actif'), objet: `TEST Affaire encaissée de COM${baremeReduit ? ', barème réduit' : ''}`, lignes: [{ designation: 'TEST Ligne de l’affaire encaissée', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 1000, tauxTva: 20 }] }, 201);
        await api(SA, 'PUT', `/api/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
        await api(SA, 'POST', `/api/devis/${devis.id}/signature`, { signataire: 'TEST Signataire matrice', confirme: true }, 201);
        const conversion = await api(SA, 'POST', `/api/devis/${devis.id}/convertir`, { cible: 'CHANTIER', responsableId: comptes.CT.id, commercialId: comptes.COM.id, dateDebut: jourSociete(-1) }, 201);
        const chantierId = conversion.chantier?.id ?? conversion.chantierId ?? conversion.id;
        assert.ok(chantierId, JSON.stringify(conversion).slice(0, 300));
        if (baremeReduit) await api(SA, 'PATCH', `/api/chantiers/${chantierId}`, { baremeReduit: true });
        clotures.push((await api(SA, 'PATCH', `/api/chantiers/${chantierId}/statut`, { statut: 'TERMINE' })).dateFin);
        await api(SA, 'PATCH', `/api/chantiers/${chantierId}/encaisse`, { encaisse: true });
      }
      // Mois de la clôture, et non le mois en cours : la lecture ne dépend pas de l'heure d'exécution.
      const ref = String(clotures[0]).slice(0, 10);
      assert.equal(String(clotures[1]).slice(0, 7), ref.slice(0, 7), 'les deux affaires sont clôturées le même mois');
      const decrireValeur = (valeur, present) => (!present ? ABSENT : valeur === null ? NUL : typeof valeur !== 'number' ? `${typeof valeur}` : valeur === 0 ? 'zéro' : 'non nul');
      const ecarts = [];
      for (const entree of MONTANTS_MIS_A_ZERO) {
        // Types qui lisent la route sans droit (entrees.txt) ; les autres y sont refusés.
        const lecteurs = TYPES.filter((type) => !casEntree.get(type).some((cas) => cas.route === entree.route));
        assert.ok(lecteurs.includes('COM') && lecteurs.includes(SA), `lecteurs de ${entree.route} : ${lecteurs.join(', ')}`);
        const lireLigne = async (type) => {
          const res = await appeler(appli.adresse, 'GET', entree.route.split(' ')[1], { jeton: comptes[type].jeton, requete: { period: 'month', ref } });
          assert.equal(res.status, 200, `${type} : ${res.status} ${JSON.stringify(res.body)?.slice(0, 300)}`);
          const ligne = res.body.commerciaux.find((c) => c.id === comptes.COM.id);
          assert.ok(ligne, `${type} : ligne du commercial COM`);
          return entree.champs.map((champ) => `${champ}=${decrireValeur(ligne[champ], champ in ligne)}`).join(', ');
        };
        const attendu = (valeur) => entree.champs.map((champ) => `${champ}=${valeur}`).join(', ');
        for (const type of lecteurs) assert.equal(await lireLigne(type), attendu('non nul'), `${type}, réglages par défaut, sans droit`);
        const [, cleReglage] = /^([A-Za-z]+)=non$/.exec(entree.reglage);
        await reglerParametre({ [cleReglage]: false });
        try {
          for (const type of lecteurs) {
            assert.equal(await lireLigne(type), attendu('zéro'), `${type}, ${entree.reglage}, sans droit`);
            for (const droit of droits) {
              const lu = await avecDroit(type, droit, async () => ({ resultat: await lireLigne(type), admises: [] }));
              if (lu !== attendu('zéro')) ecarts.push(`${type} + ${droit.nom}, ${entree.reglage} : ${lu}`);
            }
          }
        } finally {
          await reglerParametre({ [cleReglage]: true });
        }
      }
      assert.deepEqual(ecarts, [], 'montants mis à zéro par le réglage que lit un compte « type + droit »');
      assert.deepEqual(ecrituresInattendues, [], 'lectures qui ont écrit');
    });
  });
}
