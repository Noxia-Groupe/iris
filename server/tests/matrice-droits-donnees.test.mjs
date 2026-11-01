// Lot D1a-3 : matrice des données visibles de chaque lecture, tests seuls (cadrage du lot D1a, version 3 du
// 01-11-2026, §2 et ligne D1a-3 du §3 ; CIBLE §7.1 : « La preuve est donnée rôle par rôle, par une matrice
// enregistrée en exécutant l'API avant tout changement »).
//
// Tests seuls : ce fichier enregistre le comportement actuel, sans rien corriger (cadrage §1 et §7). Pour chaque
// lecture de session (GET), chaque compte (comptes.mjs) et chaque cible de la famille de la route (donnees.mjs, plus
// deux cibles propres à ce fichier, plus bas), il enregistre, pour chaque réponse 200 :
//  - les éléments visibles de chaque liste, par le NOM de leur cible ou de leur compte ; un objet du jeu de données
//    qui n'est pas une cible est nommé par son libellé entre guillemets (« … »), ce qui le signale ;
//  - les clés présentes de chaque type d'objet de la réponse (« ? » : clé que ne portent pas tous les objets) ;
//  - pour chaque objet qui porte un montant de la liste FERMÉE (matrice-droits/montants-masques.mjs, cadrage §6),
//    le statut de chaque montant : « présent », « null » ou « absent ». JAMAIS sa valeur ;
//  - les droits lus par l'écran : permissions de GET /api/me et de GET /api/users, modules de GET /api/modules ;
//  - pour une réponse qui n'est pas du JSON (PDF, CSV, logo), son type, et pour le logo si c'est celui qui a été posé.
// Les réponses non 200 sont dans entrees.txt (D1a-1) et cles.txt (D1a-2) : elles ne sont pas reprises ici.
// S'y ajoutent les lectures /api/v1 par une clé de leur scope, avec et sans finances:read (quels montants une clé
// voit), et les lectures qui lisent un réglage, rejouées avec ce réglage changé (cadrage §2.5) ; dans ce contexte, les
// lignes « clés » et « éléments » n'y sont écrites que si elles diffèrent du contexte par défaut. Le tout est comparé,
// au caractère près, à la référence server/tests/matrice-droits/donnees.txt ; un écart fait échouer le test, écrit
// la matrice obtenue hors du dépôt et imprime les premières lignes du diff (N8).
//
// Deux tests rendent la liste fermée des montants masqués exécutable :
//  - chaque champ de la liste est vu présent par un compte qui le voit, et nul ou absent par un compte qui ne le voit
//    pas (ou sous le réglage qui le masque) ; aucun compte qui ne le voit pas ne l'a présent ;
//  - aucun champ masqué selon le demandeur n'est hors de la liste : un nombre ou un objet présent pour un compte et
//    nul ou absent pour un autre, sur le même objet de la même réponse, doit y figurer (ou parmi les champs masqués
//    qui ne sont pas des montants, avec leur raison).
//
// Jeu de données : celui de D1a-1 (donnees.mjs), construit par l'API, complété ici, par l'API aussi, de ce qu'il faut
// pour qu'un montant masqué ait une valeur à masquer (COMPLEMENTS, plus bas) et d'un logo (note N5 de #428). Comme
// les autres fichiers de la matrice, ce fichier crée sur le serveur de TEST_DATABASE_URL une base jetable qui
// n'appartient qu'à lui, la migre, la sert à l'application, puis la supprime. Sans TEST_DATABASE_URL, il s'annonce
// ignoré : un SKIP n'est pas une réussite.
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { join } from 'node:path';
import {
  CONTEXTE_DEFAUT, DOSSIER_MATRICES, EMAIL_SECOURS, JETON_SECOURS, SEPARATEUR, appeler, baseJetable, chargerApplication, cleRoute,
  comparerAvecReference, empreinteBase, enParallele, routesDeLApplication, tablesChangees, tablesDeLaBase,
} from './matrice-droits/outils.mjs';
import { COMPTES_JOUES, COMPTE_SYSTEME_ID, creerComptes } from './matrice-droits/comptes.mjs';
import { FAMILLES, INEXISTANT, cheminPour, cibleDe, ciblesDe, construireJeuDeDonnees, jourSociete } from './matrice-droits/donnees.mjs';
import { ROUTES_CLES, ROUTES_SESSION } from './matrice-droits/routes.mjs';
import { CHAMPS_MASQUES_HORS_MONTANTS, MONTANTS_MASQUES, MONTANTS_MIS_A_ZERO, TYPES_MONTANTS, VALEURS_DERIVEES } from './matrice-droits/montants-masques.mjs';
import {
  ABSENT, NUL, PRESENT, afficherChemin, cheminGenerique, clesDecrites, comparer, creerRegistre, listeDeNoms, listePremierNiveau, nommer,
  objetsAuChemin, parcourir, parentDe, presences, statut, valeurDecrite,
} from './matrice-droits/formes.mjs';

const TITRE = 'Lot D1a-3 : matrice des données visibles de chaque lecture (listes, champs présents ou masqués, montants masqués)';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const REFERENCE = join(DOSSIER_MATRICES, 'donnees.txt');
// Une ligne : compte, route, cible, contexte, objet décrit, description. Clé : les cinq premiers champs.
const CHAMPS_CLE = 5;
const ROUTE_LOGO = 'GET /api/company/logo';
const SA = 'SA';

// Logo posé dans le jeu de données (note N5 de #428 : sans logo, GET /api/company/logo répondait 404 à tous) : le
// JPEG 1 × 1 pixel minimal d'api.test.mjs (lot 6a-1).
const LOGO = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

// Jour civil AAAA-MM-JJ (paramètre `ref` des statistiques) d'un jour JJ-MM-AAAA.
const isoDe = (jour) => jour.split('-').reverse().join('-');

// Paramètres de requête fixes d'une lecture (la cible reste « — ») :
//  - plage du planning : celle de D1a-1 (sans elle, 400 pour tous les comptes admis) ;
//  - statistiques des intervenants et des fournisseurs : la période qui contient la veille, jour des saisies du jeu de
//    données ; sans `ref`, la semaine ou le mois en cours ne la contient pas toujours (un lundi, un premier du mois),
//    et la liste changerait avec le jour d'exécution ;
//  - assiduité des conducteurs : la semaine qui précède la semaine en cours. La route compte les heures par leur
//    date de saisie (createdAt, l'instant de la construction du jeu de données), du lundi au vendredi de la semaine
//    demandée, la semaine en cours par défaut : un jour ouvré, elle les compterait (tranchesHoraires remplies), un
//    samedi ou un dimanche, non. Une semaine passée n'en contient jamais : la ligne ne dépend plus du jour.
const REQUETES = {
  'GET /api/planning/events': () => ({ start: jourSociete(-3), end: jourSociete(3) }),
  'GET /api/stats/intervenants': () => ({ period: 'week', ref: isoDe(jourSociete(-1)) }),
  'GET /api/stats/fournisseurs': () => ({ period: 'month', ref: isoDe(jourSociete(-1)) }),
  'GET /api/stats/conducteurs/assiduite': () => ({ week: isoDe(jourSociete(-7)) }),
};
// Cibles de plus pour une liste filtrée par un paramètre : la liste des clients désactivés (cadrage §3, ligne
// D1a-3 : « comptes super administrateur, client désactivé »). Un technicien ne la reçoit pas
// (clients/routes.ts:51-55, décision de Nelson du 14-10-2026).
const VARIANTES = {
  'GET /api/clients': [{ nom: 'actif=false', requete: { actif: 'false' } }],
  'GET /api/v1/clients': [{ nom: 'actif=false', requete: { actif: 'false' } }],
};

// Valeurs enregistrées (droits, et non montants) : permissions et modules lus par l'écran (cadrage §3, D1a-3,
// « permissions de GET /api/me et de GET /api/users »), et portées des clés.
const VALEURS = {
  'GET /api/me': { chemin: '.', champs: ['role', 'accesFinance', 'permissions'] },
  'GET /api/users': { chemin: '[]', champs: ['role', 'actif', 'estCommercial', 'accesFinance', 'permissions', 'permissionsIndividuelles'] },
  'GET /api/modules': { chemin: '.', champs: ['planningActif', 'planningActifGlobal'] },
  'GET /api/admin/api-keys': { chemin: '[]', champs: ['actif', 'scopes'] },
};

// Lectures qui lisent un réglage (cadrage §2.5 ; relevé du code, inventaire §6), rejouées pour tous les comptes, le
// réglage changé seul, sur les cibles qui leur répondent 200 par défaut (au moins une par compte et par route : voir
// jouerLectures). Une combinaison de deux réglages n'ajoute rien : chaque destinataire de
// la rentabilité décide pour un couple (compte, chantier) que les autres ne touchent pas (chantiers/droits.ts:23-35),
// et margeCommercialeActive coupe la marge de tous (chantiers/suivi.ts:139).
//  - margeCommercialeActive : la liste et la fiche des chantiers, et la jumelle /api/v1/chantiers
//    (chantiers/routes.ts:77 et :166, suivi.ts:139) ; le tableau de bord (statistiques/routes.ts:94) ; les
//    statistiques des conducteurs (:172 et :187) et la répartition des chantiers (:346, computeChantierMetrics) ; le résultat
//    commercial (commissions/routes.ts:66, commissions/metier.ts:71) ; les paramètres eux-mêmes ;
//  - rentabiliteConducteur, rentabiliteHierarchie, rentabiliteDirecteurs (voitRentabilite) : la liste et la fiche des
//    chantiers (chantiers/routes.ts:76 et :161), les statistiques des conducteurs (statistiques/routes.ts:184) ; les
//    paramètres eux-mêmes. La jumelle /api/v1/chantiers lit les paramètres, mais voitRentabilite décide d'une clé par
//    son seul scope (chantiers/droits.ts:24-25) : elle n'est pas rejouée ;
//  - planningActif : GET /api/modules (administration/routes.ts:141-147), et les lectures qui portent
//    requirePlanningActif (planning/metier.ts:17), dont le super administrateur, exempté, lit encore les données ; le
//    refus des autres comptes est dans entrees.txt.
const LECTURES_MARGE = ['GET /api/chantiers', 'GET /api/chantiers/:id', 'GET /api/v1/chantiers', 'GET /api/stats/global', 'GET /api/stats/conducteurs', 'GET /api/stats/chantiers-repartition', 'GET /api/stats/commerciaux', 'GET /api/parametres'];
const LECTURES_RENTABILITE = ['GET /api/chantiers', 'GET /api/chantiers/:id', 'GET /api/stats/conducteurs', 'GET /api/parametres'];
const CONTEXTES_REGLAGE = [
  { contexte: 'margeCommercialeActive=non', route: '/api/parametres', corps: { margeCommercialeActive: false }, retour: { margeCommercialeActive: true }, lectures: LECTURES_MARGE },
  { contexte: 'rentabiliteConducteur=non', route: '/api/parametres', corps: { rentabiliteConducteur: false }, retour: { rentabiliteConducteur: true }, lectures: LECTURES_RENTABILITE },
  { contexte: 'rentabiliteHierarchie=non', route: '/api/parametres', corps: { rentabiliteHierarchie: false }, retour: { rentabiliteHierarchie: true }, lectures: LECTURES_RENTABILITE },
  { contexte: 'rentabiliteDirecteurs=non', route: '/api/parametres', corps: { rentabiliteDirecteurs: false }, retour: { rentabiliteDirecteurs: true }, lectures: LECTURES_RENTABILITE },
  { contexte: 'planningActif=non', route: '/api/modules', corps: { planningActif: false }, retour: { planningActif: true }, lectures: null },
];

// Cibles propres à ce fichier, de la famille « intervention », créées par l'API après le jeu de données de D1a-1
// (COMPLEMENTS) : elles portent des montants que les cibles de D1a-1 n'ont pas. Elles ne sont jouées que par les
// lectures de leur famille ; entrees.txt ne les connaît pas.
const CIBLES_COMPLEMENTAIRES = {
  intervention: [
    { nom: 'intervention-chantier-ct-heures', description: 'en cours, chantier chantier-ct, affectée à TECH, heures du technicien au prix de vente figé', relations: { CT: 'titulaire du chantier lié', TECH: 'affecté' } },
    { nom: 'intervention-issue-devis', description: 'en cours, issue d’un devis converti en intervention, sans chantier, affectée à TECH', relations: { TECH: 'affecté' } },
  ],
};

// Ligne de la matrice des données : six champs, sans « | » ni espace en bord de champ.
function ligneDonnees({ compte, route, cible, contexte, objet, description }) {
  const champs = [compte, route, cible, contexte, objet, description];
  for (const champ of champs) assert.ok(String(champ) && !String(champ).includes('|') && String(champ) === String(champ).trim() && !/\n/.test(champ), `champ de ligne invalide : « ${champ} »`);
  return champs.join(SEPARATEUR);
}

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const base = baseJetable(TEST_DATABASE_URL, 'donnees');
    let appli; let tables = [];
    let comptes = {};
    const registre = creerRegistre();
    // Clés d'intégration jouées : nom de la référence → en-tête Authorization.
    const cles = {};
    let routesApplication = [];
    let lecturesPlanning = [];
    const lignes = [];
    // Observations des montants de la liste fermée : { entree, compte, contexte, route, cible, element, statuts }.
    const observations = [];
    // Présences par objet, pour le test « aucun champ masqué hors de la liste » : groupe (route, cible, contexte,
    // objet) → compte → { champs, vus }.
    const groupes = new Map();
    // Routes jouées par contexte, et cas qui ont répondu 200 ; statut de chaque cas joué par défaut (compte, route,
    // cible), qui choisit les cas rejoués sous un réglage.
    const jouees = new Map();
    const statutsParDefaut = new Map();

    const authDe = (compte) => (Object.hasOwn(cles, compte) ? { autorisation: cles[compte] } : { jeton: comptes[compte].jeton });
    const api = async (compte, methode, chemin, corps, statut = 200) => {
      const res = await appeler(appli.adresse, methode, chemin, { jeton: comptes[compte].jeton, corps: methode === 'GET' ? undefined : corps });
      const admis = Array.isArray(statut) ? statut : [statut];
      assert.ok(admis.includes(res.status), `${methode} ${chemin} (${compte}) : ${res.status} ${JSON.stringify(res.body)?.slice(0, 400)}`);
      return res.body;
    };
    const definitionDe = (route) => ROUTES_SESSION[route] ?? ROUTES_CLES[route];
    // Cibles lues d'une route : celles de sa famille (D1a-1), les cibles complémentaires de sa famille, et les
    // variantes de requête d'une liste.
    const ciblesLues = (route) => {
      const definition = definitionDe(route);
      const chemin = route.split(' ')[1];
      const cibles = ciblesDe(definition, chemin).map((cible) => ({ ...cible, requete: REQUETES[route]?.() }));
      if (definition.famille && CIBLES_COMPLEMENTAIRES[definition.famille]) cibles.push(...CIBLES_COMPLEMENTAIRES[definition.famille]);
      for (const variante of VARIANTES[route] ?? []) cibles.push({ nom: variante.nom, requete: variante.requete });
      return cibles;
    };

    // Lignes « clés » et « éléments » du contexte par défaut, pour n'écrire dans un contexte de réglage que celles qui
    // en diffèrent.
    const parDefaut = new Map();
    // Description d'une réponse 200 : lignes, observations des montants, présences. Dans un contexte de réglage, les
    // lignes « clés » et « éléments » ne sont écrites que si elles diffèrent de celles du contexte par défaut pour le
    // même compte, la même route et la même cible ; les lignes « montants », « valeurs » et « réponse » le sont toujours.
    const decrire = ({ compte, route, cible, contexte, res }) => {
      const L = (objet, description) => {
        const cle = [compte, route, cible, objet].join(SEPARATEUR);
        if (contexte === CONTEXTE_DEFAUT) parDefaut.set(cle, description);
        else if ((objet.startsWith('clés ') || objet.startsWith('éléments ')) && parDefaut.get(cle) === description) return;
        lignes.push(ligneDonnees({ compte, route, cible, contexte, objet, description }));
      };
      const type = String(res.type ?? '').split(';')[0].trim();
      if (type !== 'application/json') {
        if (route === ROUTE_LOGO) L('réponse', `200 ${type}, ${res.octets?.equals(LOGO) ? 'contenu identique au logo posé' : 'contenu différent du logo posé'}`);
        else L('réponse', `200 ${type || '(sans type)'}`);
        return;
      }
      const corps = res.body;
      const { objets, listes } = parcourir(corps, registre);
      for (const [chemin, noms] of listes) {
        const nommes = noms.filter((nom) => typeof nom === 'string');
        if (!nommes.length && !(listePremierNiveau(chemin) && noms.length === 0)) continue;
        const sansIdentifiant = noms.filter((nom) => nom === null).length;
        L(`éléments ${chemin}`, `${listeDeNoms(nommes)}${sansIdentifiant ? ` + ${sansIdentifiant} sans identifiant` : ''}`);
      }
      for (const [chemin, objet] of objets) L(`clés ${afficherChemin(chemin)}`, clesDecrites(objet));

      // Montants de la liste fermée, objet par objet.
      for (const [nomType, type] of Object.entries(TYPES_MONTANTS)) {
        const cheminType = type.routes[route];
        if (!cheminType) continue;
        const decrits = [];
        for (const objet of objetsAuChemin(corps, cheminType)) {
          const entrees = MONTANTS_MASQUES.filter((entree) => entree.type === nomType && (!entree.routes || entree.routes.includes(route)) && (!type.selon || entree.cible === objet[type.selon]));
          if (!entrees.length) continue;
          const element = cheminType === '.' ? null : nommer(objet, registre) ?? '(sans identifiant)';
          const morceaux = [];
          const decrit = new Set();
          for (const entree of entrees) {
            for (const champ of entree.chemins) {
              const statuts = statut(objet, champ);
              if (!statuts.length) continue;
              observations.push({ entree, compte, contexte, route, cible, element, statuts });
              if (!decrit.has(champ)) { decrit.add(champ); morceaux.push(`${champ}=${statuts.join('/')}`); }
            }
          }
          for (const champ of VALEURS_DERIVEES[nomType] ?? []) {
            const valeur = valeurDecrite(objet, champ);
            if (valeur !== null) morceaux.push(`${champ}=${valeur}`);
          }
          decrits.push({ element, description: morceaux.length ? morceaux.join(', ') : '(aucun montant porté)' });
        }
        for (const { element, description } of sansDoublon(decrits)) L(element === null ? 'montants' : `montants ${element}`, description);
      }

      // Valeurs de droits.
      const valeurs = VALEURS[route];
      if (valeurs) {
        const decrits = objetsAuChemin(corps, valeurs.chemin).map((objet) => ({
          element: valeurs.chemin === '.' ? null : nommer(objet, registre) ?? '(sans identifiant)',
          description: valeurs.champs.map((champ) => `${champ}=${valeurDecrite(objet, champ) ?? ABSENT}`).join(' ; '),
        }));
        for (const { element, description } of sansDoublon(decrits)) L(element === null ? 'valeurs' : `valeurs ${element}`, description);
      }

      // Présences : la réponse entière, ou chaque élément nommé de la liste racine.
      const noter = (element, objet) => {
        const cle = [route, cible, contexte, element].join(SEPARATEUR);
        if (!groupes.has(cle)) groupes.set(cle, new Map());
        groupes.get(cle).set(compte, presences(objet, registre));
      };
      if (Array.isArray(corps)) {
        for (const objet of corps) {
          const nom = nommer(objet, registre);
          if (nom) noter(`[${nom}]`, objet);
        }
      } else if (corps && typeof corps === 'object') noter('.', corps);
    };
    // Un même nom porté par deux objets (libellés égaux hors des cibles) : numérotés après tri de leur description,
    // pour que la ligne ne dépende pas de l'ordre de la liste.
    function sansDoublon(decrits) {
      const parNom = new Map();
      for (const decrit of decrits) {
        if (!parNom.has(decrit.element)) parNom.set(decrit.element, []);
        parNom.get(decrit.element).push(decrit);
      }
      const sortie = [];
      for (const [element, liste] of parNom) {
        if (liste.length === 1) { sortie.push(liste[0]); continue; }
        liste.map((d) => d.description).sort(comparer).forEach((description, rang) => sortie.push({ element: `${element} #${rang + 1}`, description }));
      }
      return sortie;
    }

    // Joue les lectures données pour les comptes donnés, dans un contexte ; chaque réponse 200 est décrite. Sous un
    // réglage (`selonDefaut`), un compte ne rejoue que les cibles qui lui ont répondu 200 par défaut, ou, s'il n'en a
    // aucune, la première cible de la route : au moins un cas par compte et par route lue (cadrage §4). Les autres
    // cas sont des refus à l'entrée, que ces réglages ne changent pas (entrees.txt les joue par défaut, et module
    // Planning coupé).
    const jouerLectures = async (routes, comptesJoues, contexte, { selonDefaut = false } = {}) => {
      const taches = [];
      for (const route of routes) {
        const [, chemin] = route.split(' ');
        const definition = definitionDe(route);
        for (const compte of comptesJoues) {
          let cibles = ciblesLues(route);
          if (selonDefaut) {
            const admises = cibles.filter((cible) => statutsParDefaut.get([compte, route, cible.nom].join(SEPARATEUR)) === 200);
            cibles = admises.length ? admises : cibles.slice(0, 1);
          }
          for (const cible of cibles) {
            taches.push(async () => {
              const res = await appeler(appli.adresse, 'GET', cheminPour(chemin, definition.famille, cible.ids ? cible : null), {
                ...authDe(compte), requete: cible.requete, octets: route === ROUTE_LOGO,
              });
              if (!jouees.has(contexte)) jouees.set(contexte, new Map());
              const parRoute = jouees.get(contexte);
              if (!parRoute.has(route)) parRoute.set(route, { cas: 0, admis: 0 });
              parRoute.get(route).cas += 1;
              if (contexte === CONTEXTE_DEFAUT) statutsParDefaut.set([compte, route, cible.nom].join(SEPARATEUR), res.status);
              if (res.status !== 200) return;
              parRoute.get(route).admis += 1;
              decrire({ compte, route, cible: cible.nom, contexte, res });
            });
          }
        }
      }
      await enParallele(taches, 8);
    };
    const regler = async (route, corps) => {
      const res = await appeler(appli.adresse, 'PUT', route, { jeton: comptes.SA.jeton, corps });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    };
    const lecturesSession = Object.keys(ROUTES_SESSION).filter((route) => ROUTES_SESSION[route].lecture).sort();
    const lecturesCles = Object.keys(ROUTES_CLES).filter((route) => ROUTES_CLES[route].lecture).sort();
    const scopesLus = [...new Set(lecturesCles.map((route) => ROUTES_CLES[route].scope))].sort();
    const clesDuScope = (scope) => [`CLE ${scope}`, `CLE ${scope}+finances:read`];

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

      // --- Compléments propres à D1a-3, par l'API (session du super administrateur, sauf mention) ---
      // Chacun donne une valeur à un montant masqué que le jeu de D1a-1 laisse vide ou ne montre à aucun compte qui
      // ne le voit pas ; aucun ne change une relation des cibles de donnees.mjs.
      const id = (famille, nom) => cibleDe(famille, nom).ids.id;
      const aujourdhui = jourSociete(0);
      const hier = jourSociete(-1);
      const ficheTech = id('fiche-intervenant', 'fiche-tech');
      // (1) Main d'œuvre du catalogue, rattachée à la fiche du technicien : le rattachement (mainOeuvre) et le prix de
      //     vente à l'heure figé sur une heure SAV (prixVenteHoraireApplique) ont une valeur.
      const mainOeuvre = await api(SA, 'POST', '/api/catalogue/prestations', {
        estMainOeuvre: true, reference: 'TEST-MATRICE-MO', nom: 'TEST Main d’œuvre matrice', tauxTva: 20,
        prixVenteHt: 60, prixJourHorsContratHt: 420, prixHeureSousContratHt: 55, prixJourSousContratHt: 385, heuresParJour: 7,
      }, 201);
      await api(SA, 'PUT', `/api/intervenants/${ficheTech}/main-oeuvre`, { mainOeuvreId: mainOeuvre.id });
      // (2) Prix d'achat de la prestation et du modèle d'équipement du parc (catalogue, devis, parc).
      await api(SA, 'PUT', `/api/catalogue/prestations/${id('fiche-catalogue', 'prestation-catalogue')}`, {
        reference: 'TEST-MATRICE-PRE', nom: 'TEST Prestation catalogue matrice', unite: 'forfait', prixVenteHt: '100', tauxTva: '20', prixAchatHt: '40',
      });
      const equipements = await api(SA, 'GET', '/api/catalogue/equipements');
      const modele = equipements.find((fiche) => fiche.reference === 'TEST-MATRICE-EQ');
      assert.ok(modele, 'modèle d’équipement du jeu de données');
      await api(SA, 'PUT', `/api/catalogue/equipements/${modele.id}`, { reference: 'TEST-MATRICE-EQ', nom: 'TEST Modèle d’équipement', fabricant: 'TEST', prixVenteHt: '100', prixAchatHt: '60', tauxTva: '20' });
      // (3) Un achat et des heures sur le chantier du technicien : il a enfin un montant à ne pas voir (fiche, liste,
      //     journaux des achats, des heures et des saisies).
      const chantierTech = id('chantier', 'chantier-tech-branche-resp');
      const achatTech = await api(SA, 'POST', '/api/achats', { chantierId: chantierTech, categorieId: id('categorie', 'categorie'), fournisseurId: id('fournisseur', 'fournisseur'), date: hier, description: 'TEST Achat du chantier du technicien', montantHT: 100 });
      const heureTech = await api(SA, 'POST', '/api/heures', { chantierId: chantierTech, intervenantId: id('fiche-intervenant', 'fiche-libre'), date: hier, nbrHeures: 2 });
      // (4) Heures du technicien sur son intervention, après le rattachement : prix de vente à l'heure figé.
      const affecteeTech = id('intervention', 'intervention-affectee-tech');
      const heuresValorisees = await api('TECH', 'POST', `/api/interventions/${affecteeTech}/couts/heures`, { date: aujourdhui, nbrHeures: 1 }, 201);
      // (5) Intervention du chantier du conducteur, affectée au technicien, avec ses heures : le conducteur voit des
      //     heures SAV sans leur taux ni leur prix de vente (coûts, journal des saisies).
      const placerEtDemarrer = async (interventionId) => {
        await api(SA, 'PUT', `/api/interventions/${interventionId}/planning`, { dateDebut: hier, creneau: 'JOURNEE', intervenantIds: [ficheTech] }, [200, 201]);
        const lue = await api(SA, 'GET', `/api/interventions/${interventionId}`);
        if (lue.statut === 'A_PLANIFIER') await api(SA, 'PATCH', `/api/interventions/${interventionId}/statut`, { statut: 'PLANIFIEE' });
        await api(SA, 'PATCH', `/api/interventions/${interventionId}/statut`, { statut: 'EN_COURS' });
      };
      const clientActif = id('client', 'client-actif');
      const interventionCt = await api(SA, 'POST', '/api/interventions', { clientId: clientActif, titre: 'TEST Intervention du chantier du conducteur, heures du technicien', chantierId: id('chantier', 'chantier-ct') }, 201);
      await placerEtDemarrer(interventionCt.id);
      const heuresCt = await api('TECH', 'POST', `/api/interventions/${interventionCt.id}/couts/heures`, { date: hier, nbrHeures: 1 }, 201);
      // (6) Intervention issue d'un devis, sans chantier (marge du devis), affectée au technicien.
      const signer = async (devis) => {
        await api(SA, 'PUT', `/api/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
        await api(SA, 'POST', `/api/devis/${devis.id}/signature`, { signataire: 'TEST Signataire matrice', confirme: true }, 201);
        return devis;
      };
      const devisIntervention = await signer(await api(SA, 'POST', '/api/devis', { clientId: clientActif, objet: 'TEST Devis converti en intervention', lignes: [{ designation: 'TEST Ligne de l’intervention', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 300, tauxTva: 20 }] }, 201));
      const interventionDevis = await api(SA, 'POST', `/api/devis/${devisIntervention.id}/convertir`, { cible: 'INTERVENTION' }, 201);
      assert.ok(interventionDevis.id, JSON.stringify(interventionDevis).slice(0, 300));
      await placerEtDemarrer(interventionDevis.id);
      // (7) Devis dont une ligne porte un prix d'achat prévu (écrit par l'administration seule).
      const devisPrixAchat = await api(SA, 'POST', '/api/devis', { clientId: clientActif, objet: 'TEST Devis avec prix d’achat prévu', lignes: [{ designation: 'TEST Fourniture avec prix d’achat', nature: 'FOURNITURE', quantite: 2, prixUnitaireHt: 50, tauxTva: 20, prixAchatUnitaireHt: 30 }] }, 201);
      // (8) Logo de la société (note N5 de #428).
      await api(SA, 'PUT', '/api/company/logo', { fichier: `data:image/jpeg;base64,${LOGO.toString('base64')}` });
      const cibleIntervention = (nom, interventionId) => { CIBLES_COMPLEMENTAIRES.intervention.find((c) => c.nom === nom).ids = { id: interventionId }; };
      cibleIntervention('intervention-chantier-ct-heures', interventionCt.id);
      cibleIntervention('intervention-issue-devis', interventionDevis.id);
      // Les faits qui portent ces compléments, relus en base, comme le fait donnees.mjs pour ses cibles.
      const faits = async (interventionId) => {
        const lue = await appli.prisma.intervention.findUniqueOrThrow({ where: { id: interventionId }, select: { statut: true, chantierId: true, affectations: { select: { intervenantId: true } } } });
        return { statut: lue.statut, chantierId: lue.chantierId, affectes: lue.affectations.map((a) => a.intervenantId) };
      };
      assert.deepEqual(await faits(interventionCt.id), { statut: 'EN_COURS', chantierId: id('chantier', 'chantier-ct'), affectes: [ficheTech] }, 'faits de intervention-chantier-ct-heures');
      assert.deepEqual(await faits(interventionDevis.id), { statut: 'EN_COURS', chantierId: null, affectes: [ficheTech] }, 'faits de intervention-issue-devis');
      assert.equal(await appli.prisma.devisConversion.count({ where: { devisId: devisIntervention.id, cibleType: 'INTERVENTION', cibleId: interventionDevis.id } }), 1, 'intervention-issue-devis issue de devis-intervention');
      assert.equal((await appli.prisma.intervenantMainOeuvre.findUniqueOrThrow({ where: { intervenantId: ficheTech } })).prestationId, mainOeuvre.id, 'fiche-tech rattachée à la main d’œuvre');
      for (const heureId of [heuresValorisees.id, heuresCt.id]) {
        assert.notEqual((await appli.prisma.coutInterventionHeure.findUniqueOrThrow({ where: { id: heureId } })).prixVenteHoraireApplique, null, 'heure SAV au prix de vente figé');
      }

      // --- Registre des noms ---
      for (const cle of COMPTES_JOUES) registre.ajouter(comptes[cle].id, cle);
      registre.ajouter(crees.donnees.CT_BRANCHE.id, 'CT-BRANCHE');
      registre.ajouter(crees.donnees.CT_TIERS.id, 'CT-TIERS');
      registre.ajouter((await appli.prisma.user.findUniqueOrThrow({ where: { email: 'matrice.desactive@iris.test' }, select: { id: true } })).id, 'DESACTIVE');
      registre.ajouter(COMPTE_SYSTEME_ID, 'SYSTEME');
      // Couples incohérents (un objet d'un client sous un autre client) : l'objet garde le nom de ce qu'il est.
      const RENOMMES = { 'contact-autre-client': 'contact-client-desactive', 'site-autre-client': 'site-client-desactive', 'equipement-autre-client': 'equipement-client-desactive' };
      for (const { cibles } of Object.values(FAMILLES)) {
        for (const cible of cibles) {
          if (cible.nom === INEXISTANT || cible.nom === 'heures-tech-sous-intervention-autre') continue;
          registre.ajouter(cible.ids.coutId ?? cible.ids.id, RENOMMES[cible.nom] ?? cible.nom);
        }
      }
      for (const cible of CIBLES_COMPLEMENTAIRES.intervention) registre.ajouter(cible.ids.id, cible.nom);
      registre.ajouter(mainOeuvre.id, 'main-oeuvre-matrice');
      registre.ajouter(modele.id, 'modele-equipement');
      registre.ajouter(achatTech.id, 'achat-chantier-tech-branche-resp');
      registre.ajouter(heureTech.id, 'heure-chantier-tech-branche-resp');
      registre.ajouter(heuresValorisees.id, 'heures-tech-valorisees-intervention-affectee');
      registre.ajouter(heuresCt.id, 'heures-tech-intervention-chantier-ct-heures');
      registre.ajouter(devisIntervention.id, 'devis-intervention');
      registre.ajouter(devisPrixAchat.id, 'devis-prix-achat');

      // --- Clés d'intégration : pour chaque scope qui ouvre une lecture /api/v1, la clé de ce scope seul et la même
      //     avec finances:read, pour savoir quels montants une clé voit (CIBLE §7.1, lignes « Données renvoyées » et
      //     « Clés d'intégration »).
      for (const scope of scopesLus) {
        const [seule, avecFinances] = clesDuScope(scope);
        for (const [nom, scopes] of [[seule, [scope]], [avecFinances, [scope, 'finances:read']]]) {
          const cree = await api(SA, 'POST', '/api/admin/api-keys', { nom: `TEST Matrice données ${nom}`, scopes }, 201);
          cles[nom] = `Bearer ${cree.apiKey}`;
          registre.ajouter(cree.key.id, nom);
        }
      }

      routesApplication = routesDeLApplication(appli.app);
      lecturesPlanning = routesApplication.filter((r) => r.methode === 'GET' && r.gestionnaires.includes('requirePlanningActif')).map((r) => cleRoute(r.methode, r.chemin)).sort();
      tables = await tablesDeLaBase(appli.prisma);
    });

    after(async () => {
      await appli?.fermer();
      await base.supprimer();
    });

    // Cadrage §3, D1a-3, et §2.5 : chaque lecture est jouée ; chaque route d'un type de montant, d'une valeur, d'un
    // réglage ou d'une variante est une lecture de l'application ; la liste fermée ne nomme que des types connus.
    test('couverture : chaque lecture de session et /api/v1 est une route de l’application, et chaque table du fichier (types de montants, valeurs, réglages, variantes) ne nomme que des lectures', () => {
      const lectures = new Set(routesApplication.filter((r) => r.methode === 'GET').map((r) => cleRoute(r.methode, r.chemin)));
      for (const route of [...lecturesSession, ...lecturesCles]) assert.ok(lectures.has(route), `${route} : lecture de la table absente de l’application`);
      const sessionEtCles = new Set([...lecturesSession, ...lecturesCles]);
      const nommees = [
        ...Object.values(TYPES_MONTANTS).flatMap((type) => Object.keys(type.routes)), ...Object.keys(VALEURS), ...Object.keys(REQUETES), ...Object.keys(VARIANTES),
        ...LECTURES_MARGE, ...LECTURES_RENTABILITE, ROUTE_LOGO,
      ];
      assert.deepEqual(nommees.filter((route) => !sessionEtCles.has(route)), [], 'routes nommées par une table du fichier qui ne sont pas des lectures');
      for (const entree of MONTANTS_MASQUES) {
        assert.ok(TYPES_MONTANTS[entree.type], `type inconnu : ${entree.type}`);
        assert.ok(entree.voit.length, `${entree.type} ${entree.chemins.join(', ')} : aucun compte qui le voit`);
        assert.ok(entree.masque.length || entree.reglages.length || entree.inatteignable, `${entree.type} ${entree.chemins.join(', ')} : ni compte qui ne le voit pas, ni réglage, ni raison`);
        if (TYPES_MONTANTS[entree.type].selon) assert.ok(entree.cible, `${entree.type} ${entree.chemins.join(', ')} : cible de l’entrée attendue`);
        for (const route of entree.routes ?? []) assert.ok(TYPES_MONTANTS[entree.type].routes[route], `${entree.type} ${entree.chemins.join(', ')} : ${route} n’est pas une route du type`);
      }
      for (const entree of MONTANTS_MASQUES) for (const reglage of entree.reglages) assert.ok(CONTEXTES_REGLAGE.some((c) => c.contexte === reglage), `${reglage} : contexte de réglage inconnu`);
      // Lectures du planning (requirePlanningActif) : celles qu'entrees.txt joue module coupé.
      assert.ok(lecturesPlanning.length >= 5 && lecturesPlanning.every((route) => lecturesSession.includes(route)), lecturesPlanning.join(', '));
      assert.ok(Object.keys(cles).length === scopesLus.length * 2 && scopesLus.length === 6, `scopes lus par /api/v1 : ${scopesLus.join(', ')}`);
    });

    // Cadrage §3, D1a-3 : « Pour chaque lecture : éléments visibles d'une liste (par cible), champs présents ou
    // masqués, permissions de /api/me et de /api/users, comptes super administrateur, client désactivé ».
    test('lectures de session, réglages par défaut : chaque compte, chaque cible ; éléments visibles, clés, montants, permissions et logo, sans rien écrire', async () => {
      const avant = await empreinteBase(appli.prisma, tables);
      await jouerLectures(lecturesSession, COMPTES_JOUES, CONTEXTE_DEFAUT);
      assert.deepEqual(tablesChangees(avant, await empreinteBase(appli.prisma, tables)), [], 'une lecture a écrit');
      const parRoute = jouees.get(CONTEXTE_DEFAUT);
      assert.deepEqual(lecturesSession.filter((route) => !parRoute.has(route)), [], 'lectures de session non jouées');
      // Le logo posé se lit, et c'est bien lui (note N5 de #428).
      const logo = lignes.filter((ligne) => ligne.includes(` | ${ROUTE_LOGO} | `));
      assert.equal(logo.length, COMPTES_JOUES.length, logo.join('\n'));
      assert.ok(logo.every((ligne) => ligne.endsWith('| 200 image/jpeg, contenu identique au logo posé')), logo.join('\n'));
    });

    // Lectures /api/v1, avec et sans finances:read, pour savoir quels montants une clé voit (CIBLE §7.1, lignes
    // « Données renvoyées » et « Clés d'intégration ») : le démasquage par finances:read touche un montant.
    test('clés d’intégration : chaque lecture /api/v1, par la clé de son scope seule puis avec finances:read', async () => {
      for (const scope of scopesLus) {
        await jouerLectures(lecturesCles.filter((route) => ROUTES_CLES[route].scope === scope), clesDuScope(scope), CONTEXTE_DEFAUT);
      }
      const parRoute = jouees.get(CONTEXTE_DEFAUT);
      assert.deepEqual(lecturesCles.filter((route) => !parRoute.get(route)?.admis), [], 'lectures /api/v1 jamais admises par la clé de leur scope');
    });

    // Cadrage §2.5 : « D1a-3 rejoue les lectures qui dépendent d'un réglage (margeCommercialeActive, les trois
    // destinataires de la rentabilité, planningActif) pour chaque combinaison utile, sur les seules routes qui lisent le
    // réglage ». Chaque réglage est changé seul, puis remis.
    test('réglages : les lectures qui lisent margeCommercialeActive, un destinataire de la rentabilité ou planningActif, rejouées pour tous les comptes le réglage changé seul', async () => {
      for (const reglage of CONTEXTES_REGLAGE) {
        const lectures = reglage.lectures ?? ['GET /api/modules', ...lecturesPlanning];
        await regler(reglage.route, reglage.corps);
        try {
          const session = lectures.filter((route) => ROUTES_SESSION[route]);
          await jouerLectures(session, COMPTES_JOUES, reglage.contexte, { selonDefaut: true });
          for (const route of lectures.filter((r) => ROUTES_CLES[r])) await jouerLectures([route], clesDuScope(ROUTES_CLES[route].scope), reglage.contexte, { selonDefaut: true });
        } finally {
          await regler(reglage.route, reglage.retour);
        }
        assert.deepEqual(lectures.filter((route) => !jouees.get(reglage.contexte)?.has(route)), [], `${reglage.contexte} : lectures non jouées`);
        // Au moins un cas par compte (ou clé) et par route lue.
        for (const route of lectures) {
          const comptesDeLaRoute = ROUTES_CLES[route] ? clesDuScope(ROUTES_CLES[route].scope) : COMPTES_JOUES;
          assert.ok(jouees.get(reglage.contexte).get(route).cas >= comptesDeLaRoute.length, `${reglage.contexte} : ${route} jouée moins d’une fois par compte`);
        }
      }
    });

    // Cadrage §3, ligne D1a-3, et §6 : la liste fermée est rendue exécutable. Chaque champ de la liste est observé au
    // moins une fois, sur un objet qui le porte, pour un compte qui le voit et pour un compte qui ne le voit pas. La
    // règle de chaque champ est aussi éprouvée dans l'autre sens : un compte qui ne le voit pas ne l'a jamais présent,
    // réglages par défaut.
    test('liste fermée des montants masqués : chaque champ est vu présent par un compte qui le voit, nul ou absent par un compte qui ne le voit pas ou sous le réglage qui le masque, et jamais présent pour un compte qui ne le voit pas', () => {
      const manques = [];
      const nomEntree = (entree) => `${entree.type}${entree.cible ? ` (${entree.cible})` : ''} ${entree.chemins.join(' / ')}`;
      const masque = (o) => o.statuts.every((s) => s === NUL || s === ABSENT);
      for (const entree of MONTANTS_MASQUES) {
        const vues = observations.filter((o) => o.entree === entree);
        if (!vues.some((o) => o.statuts.includes(PRESENT) && entree.voit.includes(o.compte))) manques.push(`${nomEntree(entree)} : jamais présent pour un compte qui le voit (${entree.voit.join(', ')})`);
        if (entree.masque.length && !vues.some((o) => o.contexte === CONTEXTE_DEFAUT && entree.masque.includes(o.compte) && masque(o))) {
          manques.push(`${nomEntree(entree)} : jamais nul ni absent, sur un objet qui le porte, pour un compte qui ne le voit pas (${entree.masque.join(', ')})`);
        }
        for (const reglage of entree.reglages) {
          if (!vues.some((o) => o.contexte === reglage && entree.voit.includes(o.compte) && masque(o))) manques.push(`${nomEntree(entree)} : jamais masqué, avec ${reglage}, pour un compte qui le voit par défaut`);
        }
        const fuites = vues.filter((o) => o.contexte === CONTEXTE_DEFAUT && entree.masque.includes(o.compte) && o.statuts.includes(PRESENT));
        for (const o of fuites) manques.push(`${nomEntree(entree)} : présent pour ${o.compte}, qui ne le voit pas (${o.route}, ${o.cible}${o.element ? `, ${o.element}` : ''})`);
      }
      assert.deepEqual(manques, [], 'liste fermée des montants masqués (matrice-droits/montants-masques.mjs)');
    });

    // Cadrage §6 : un champ de montant masqué absent de la liste fermée est classé C. Ce test cherche, dans toutes les
    // réponses enregistrées, un champ masqué selon le demandeur : un nombre, un objet ou une liste présent pour un
    // compte, et nul ou absent (son parent présent) pour un autre, sur le même objet de la même réponse (route, cible,
    // contexte). Chacun doit figurer dans la liste fermée, ou parmi les champs masqués qui ne sont pas des montants.
    test('aucun champ masqué selon le demandeur hors de la liste fermée des montants masqués', () => {
      const connus = new Set(Object.keys(CHAMPS_MASQUES_HORS_MONTANTS));
      const dansLaListe = (route, element, champ) => {
        if (connus.has(`${route} ${element === '.' ? '.' : '[]'} ${champ}`)) return true;
        return Object.entries(TYPES_MONTANTS).some(([nomType, type]) => {
          const cheminType = type.routes[route];
          if (!cheminType) return false;
          const prefixe = cheminType === '.' || cheminType === '[]' ? '' : `${cheminType.slice(1)}.`;
          if ((cheminType === '[]') !== (element !== '.') || !champ.startsWith(prefixe)) return false;
          return MONTANTS_MASQUES.some((entree) => entree.type === nomType && entree.chemins.includes(champ.slice(prefixe.length)));
        });
      };
      const horsListe = new Map();
      for (const [cle, parCompte] of groupes) {
        if (parCompte.size < 2) continue;
        const [route, cible, contexte, element] = cle.split(SEPARATEUR);
        const champs = new Set();
        for (const { champs: c } of parCompte.values()) for (const champ of c.keys()) champs.add(champ);
        for (const champ of champs) {
          const voient = [...parCompte].filter(([, p]) => p.champs.get(champ)?.has(PRESENT)).map(([compte]) => compte);
          if (!voient.length) continue;
          const masquent = [...parCompte].filter(([, p]) => {
            const valeurs = p.champs.get(champ);
            return valeurs ? valeurs.size === 1 && valeurs.has(NUL) : p.vus.has(parentDe(champ));
          }).map(([compte]) => compte);
          if (!masquent.length) continue;
          const generique = cheminGenerique(champ);
          if (dansLaListe(route, element === '.' ? '.' : '[]', generique)) continue;
          const id = `${route} ${element === '.' ? '.' : '[]'} ${generique}`;
          if (!horsListe.has(id)) horsListe.set(id, `${id} (présent pour ${voient.slice(0, 3).join(', ')} ; masqué pour ${masquent.slice(0, 3).join(', ')} ; ${cible}, ${contexte})`);
        }
      }
      assert.deepEqual([...horsListe.values()].sort(comparer), [], 'champs masqués selon le demandeur absents de la liste fermée (matrice-droits/montants-masques.mjs)');
    });

    // Cadrage §2.1 et §3, D1a-3 : la matrice obtenue est la référence, au caractère près (N8 : diff imprimé, matrice
    // obtenue écrite hors du dépôt).
    test('la matrice obtenue est la référence matrice-droits/donnees.txt', () => {
      const clesDeLigne = lignes.map((ligne) => ligne.split(SEPARATEUR).slice(0, CHAMPS_CLE).join(SEPARATEUR));
      const doublons = clesDeLigne.filter((cle, rang) => clesDeLigne.indexOf(cle) !== rang);
      assert.deepEqual(doublons, [], 'chaque objet décrit n’a qu’une ligne');
      // Aucune ligne de montants ne porte de chiffre : un montant n'y sort que par son statut.
      assert.deepEqual(lignes.filter((ligne) => ligne.split(SEPARATEUR)[4].startsWith('montants') && /\d/.test(ligne.split(SEPARATEUR)[5])), [], 'lignes de montants qui portent un chiffre');
      // Une ligne changée se lit en une seule : ce qu'elle perd, puis ce qu'elle gagne (statuts, clés, éléments).
      const morceaux = (ligne) => ligne.split(SEPARATEUR).slice(CHAMPS_CLE).join(SEPARATEUR).split(/, | ; /);
      const resumer = (avant, apres) => {
        const [a, b] = [morceaux(avant), morceaux(apres)];
        return `${a.filter((m) => !b.includes(m)).join(', ') || '(rien)'} → ${b.filter((m) => !a.includes(m)).join(', ') || '(rien)'}`;
      };
      comparerAvecReference(lignes, REFERENCE, 'donnees.txt', { champsCle: CHAMPS_CLE, resumer });
    });

    // Cadrage §2.2 : « accesFinance (sans effet en session, à prouver) ». CPT-FINANCE n'est titulaire d'aucun chantier :
    // il ne lit aucune rentabilité et ne peut donc pas prouver que l'accès financier ne l'ouvre pas. Le comptable CPT,
    // titulaire de chantier-cpt, reçoit ici l'accès financier le temps de rejouer ses lectures (super administrateur,
    // PATCH /api/users/:id/acces-finance, remis même en cas d'échec) : chacune doit décrire exactement ce qu'elle décrit
    // sans lui, hors GET /api/me (ses permissions). Placé après la comparaison à la référence : les lignes de ce
    // contexte n'y entrent pas ; et avant tout test qui écrit dans la base, puisque ses lignes attendues sont celles du
    // test 2. Dans un contexte autre que « défaut », une ligne « clés » ou « éléments » n'est écrite
    // que si elle change : toute ligne de ce genre est donc un écart.
    test('accès financier sans effet en session : le comptable titulaire qui le reçoit lit les mêmes données, montants compris', async () => {
      const CONTEXTE = 'accesFinance=oui';
      const acces = async (valeur) => {
        const res = await appeler(appli.adresse, 'PATCH', `/api/users/${comptes.CPT.id}/acces-finance`, { jeton: comptes.SA.jeton, corps: { accesFinance: valeur } });
        assert.equal(res.status, 200, JSON.stringify(res.body));
      };
      const depart = lignes.length;
      await acces(true);
      try {
        await jouerLectures(lecturesSession, ['CPT'], CONTEXTE, { selonDefaut: true });
      } finally {
        await acces(false);
      }
      const sansContexte = (ligne) => { const champs = ligne.split(SEPARATEUR); champs.splice(3, 1); return champs.join(SEPARATEUR); };
      const obtenues = lignes.slice(depart).filter((ligne) => ligne.split(SEPARATEUR)[1] !== 'GET /api/me').map(sansContexte).sort(comparer);
      const attendues = lignes.slice(0, depart).filter((ligne) => {
        const [compte, route, , contexte, objet] = ligne.split(SEPARATEUR);
        return compte === 'CPT' && contexte === CONTEXTE_DEFAUT && route !== 'GET /api/me' && !/^(clés|éléments) /.test(objet);
      }).map(sansContexte).sort(comparer);
      assert.ok(attendues.some((ligne) => ligne.includes(' | montants chantier-cpt | ')), 'CPT lit chantier-cpt et ses montants');
      assert.deepEqual(obtenues, attendues, 'lectures du comptable avec l’accès financier');
    });

    // Cadrage §6 : un montant masqué par une MISE À ZÉRO, et non par null ou absent, échappe aux statuts de la matrice
    // (un zéro est « présent ») et au test « aucun champ masqué hors de la liste » (un zéro est un nombre). Ces montants
    // sont listés à part (MONTANTS_MIS_A_ZERO) et observés ici, APRÈS la matrice, qu'ils ne changent pas : deux affaires
    // du commercial COM, l'une au barème standard, l'autre au barème réduit, ouvertes, clôturées et encaissées par
    // l'administration, donnent à chaque total une valeur non nulle par défaut, que le réglage remet à zéro. Aucune
    // valeur n'est écrite ni comparée : seulement « non nul », « zéro », « null » ou « absent ».
    test('montants mis à zéro par un réglage (MONTANTS_MIS_A_ZERO) : non nuls par défaut pour chaque compte qui les lit, zéro sous le réglage, jamais null ni absent', async () => {
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
      // Mois de la clôture (jour AAAA-MM-JJ de la première), et non le mois en cours : la lecture ne dépend pas de
      // l'heure d'exécution.
      const ref = String(clotures[0]).slice(0, 10);
      assert.equal(String(clotures[1]).slice(0, 7), ref.slice(0, 7), 'les deux affaires sont clôturées le même mois');
      const decrire = (valeur, present) => (!present ? ABSENT : valeur === null ? NUL : typeof valeur !== 'number' ? `${typeof valeur}` : valeur === 0 ? 'zéro' : 'non nul');
      for (const entree of MONTANTS_MIS_A_ZERO) {
        assert.ok(lecturesSession.includes(entree.route), `${entree.route} : lecture de session de la matrice`);
        const reglage = CONTEXTES_REGLAGE.find((c) => c.contexte === entree.reglage);
        assert.ok(reglage, `${entree.reglage} : contexte de réglage connu`);
        const lire = async (compte) => {
          const res = await appeler(appli.adresse, 'GET', entree.route.split(' ')[1], { ...authDe(compte), requete: { period: 'month', ref } });
          assert.equal(res.status, 200, `${compte} : ${res.status} ${JSON.stringify(res.body)?.slice(0, 300)}`);
          const ligne = res.body.commerciaux.find((c) => c.id === comptes.COM.id);
          assert.ok(ligne, `${compte} : ligne du commercial COM`);
          return Object.fromEntries(entree.champs.map((champ) => [champ, decrire(ligne[champ], champ in ligne)]));
        };
        const attendu = (statut) => Object.fromEntries(entree.champs.map((champ) => [champ, statut]));
        for (const compte of entree.voit) assert.deepEqual(await lire(compte), attendu('non nul'), `${compte}, réglages par défaut`);
        await regler(reglage.route, reglage.corps);
        try {
          for (const compte of entree.voit) assert.deepEqual(await lire(compte), attendu('zéro'), `${compte}, ${entree.reglage}`);
        } finally {
          await regler(reglage.route, reglage.retour);
        }
      }
    });

    // GET /api/interventions/:id/facture-temps-passe ne répond 200 sur aucune cible du jeu de données (aucune
    // intervention au temps passé : 409 partout dans entrees.txt) : sa réponse n'est décrite pour aucun compte. Une
    // intervention au temps passé, terminée, est créée ici, après la comparaison à la référence : l'aperçu, réservé à
    // l'administration, doit avoir la même forme (clés, montants présents ou nuls) pour chaque administrateur, et être
    // refusé (403) à tout autre compte. Le statut « terminée » est écrit en base : terminer par l'API exige un compte
    // rendu signé, sans rapport avec ce qui est lu ici. Le pas du temps passé, vide par défaut, est réglé puis remis ;
    // l'aperçu reprend les heures saisies : le technicien affecté en saisit une.
    test('aperçu de la facture au temps passé : même réponse pour chaque administrateur, refus pour les autres comptes', async () => {
      const prestations = await api(SA, 'GET', '/api/catalogue/prestations');
      const mainOeuvre = prestations.find((fiche) => fiche.reference === 'TEST-MATRICE-MO');
      assert.ok(mainOeuvre, 'main d’œuvre du jeu de données');
      const { pasTempsPasseMinutes } = await api(SA, 'GET', '/api/parametres');
      await regler('/api/parametres', { pasTempsPasseMinutes: 15 });
      let intervention;
      try {
        const devis = await api(SA, 'POST', '/api/devis', { clientId: cibleDe('client', 'client-actif').ids.id, objet: 'TEST Devis au temps passé matrice', auTempsPasse: true, lignes: [
          { tempsPasse: true, designation: 'TEST Main d’œuvre au temps passé', quantite: 1, tarifTempsPasse: 'HORS_CONTRAT', catalogueFamille: 'prestations', catalogueId: mainOeuvre.id },
        ] }, 201);
        await api(SA, 'PUT', `/api/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
        await api(SA, 'POST', `/api/devis/${devis.id}/signature`, { signataire: 'TEST Signataire temps passé', confirme: true }, 201);
        intervention = await api(SA, 'POST', `/api/devis/${devis.id}/convertir`, { cible: 'INTERVENTION' }, 201);
      } finally {
        await regler('/api/parametres', { pasTempsPasseMinutes });
      }
      assert.equal(intervention.auTempsPasse, true);
      // Une heure du technicien, saisie par lui (l'aperçu reprend les heures saisies), puis la fin en base.
      const ficheTech = cibleDe('fiche-intervenant', 'fiche-tech').ids.id;
      await api(SA, 'PUT', `/api/interventions/${intervention.id}/planning`, { dateDebut: jourSociete(-1), creneau: 'JOURNEE', intervenantIds: [ficheTech] }, [200, 201]);
      if ((await api(SA, 'GET', `/api/interventions/${intervention.id}`)).statut === 'A_PLANIFIER') await api(SA, 'PATCH', `/api/interventions/${intervention.id}/statut`, { statut: 'PLANIFIEE' });
      await api(SA, 'PATCH', `/api/interventions/${intervention.id}/statut`, { statut: 'EN_COURS' });
      await api('TECH', 'POST', `/api/interventions/${intervention.id}/couts/heures`, { date: jourSociete(-1), nbrHeures: 1 }, 201);
      await appli.prisma.intervention.update({ where: { id: intervention.id }, data: { statut: 'TERMINEE' } });
      const formes = new Map();
      for (const compte of COMPTES_JOUES) {
        const res = await appeler(appli.adresse, 'GET', `/api/interventions/${intervention.id}/facture-temps-passe`, { jeton: comptes[compte].jeton });
        if (!['SA', 'AD', 'AD-COM'].includes(compte)) { assert.equal(res.status, 403, `${compte} : ${res.status}`); continue; }
        assert.equal(res.status, 200, `${compte} : ${res.status} ${JSON.stringify(res.body)?.slice(0, 200)}`);
        const { objets } = parcourir(res.body, registre);
        const { champs } = presences(res.body, registre);
        formes.set(compte, JSON.stringify({
          cles: [...objets].map(([chemin, objet]) => `${chemin} ${clesDecrites(objet)}`).sort(comparer),
          presences: [...champs].map(([chemin, statuts]) => `${chemin}=${[...statuts].sort(comparer).join('/')}`).sort(comparer),
        }));
      }
      assert.equal(new Set(formes.values()).size, 1, 'l’aperçu diffère d’un administrateur à l’autre');
      assert.ok(JSON.parse(formes.get('SA')).cles.length > 0, 'aperçu décrit');
    });
  });
}
