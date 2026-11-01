// Lot D1a-1 : socle de la matrice de non-régression des droits, et matrice des entrées (cadrage du lot D1a,
// version 3 du 01-11-2026, §2 et ligne D1a-1 du §3 ; CIBLE §7.1 : « La preuve est donnée rôle par rôle, par une
// matrice enregistrée en exécutant l'API avant tout changement »).
//
// Tests seuls : ce fichier enregistre le comportement actuel, sans rien corriger (cadrage §1 et §7). Pour chaque
// route de session, chaque compte (les dix types et leurs variantes, server/tests/matrice-droits/comptes.mjs) et
// chaque cible nommée de la famille de la route (server/tests/matrice-droits/donnees.mjs), il enregistre la réponse
// à l'ENTRÉE : code, et message exact d'un refus. S'y ajoutent les refus à l'authentification (401), les 15 routes
// du planning avec le module désactivé (§2.5), le lien public du planning, et les écritures sans corps ni
// paramètre jouées à la fin (§2.4 (c)). Le tout est comparé, au caractère près, à la référence versionnée
// server/tests/matrice-droits/entrees.txt (une ligne par cas, triée). Un écart fait échouer le test, écrit la
// matrice obtenue hors du dépôt et imprime les premières lignes du diff (N8). Un lot qui change volontairement un
// droit recopie la matrice obtenue sur la référence, dans sa propre PR.
//
// Aucune écriture : les écritures sont jouées à corps vide (a) ou sur un identifiant inexistant (b), et l'empreinte
// de toute la base, prise avant et après chaque route, prouve qu'aucune n'a écrit ; une empreinte qui change fait
// échouer le test en nommant la route et les tables (N9). Les écritures réelles, dans et hors du périmètre,
// relèvent de D1a-5.
//
// Comme production-pdf.test.mjs, ce fichier crée sur le serveur de TEST_DATABASE_URL une base jetable qui
// n'appartient qu'à lui, la migre, la sert à l'application, puis la supprime. Sans TEST_DATABASE_URL, il
// s'annonce ignoré : un SKIP n'est pas une réussite.
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { join } from 'node:path';
import {
  CONTEXTE_DEFAUT, DOSSIER_MATRICES, JETON_SECOURS, EMAIL_SECOURS, SANS_CIBLE, appeler, baseJetable, chargerApplication, cleRoute,
  comparerAvecReference, empreinteBase, enParallele, formaterReponse, ligneMatrice, routesDeLApplication, tablesChangees, tablesDeLaBase,
} from './matrice-droits/outils.mjs';
import { COMPTES_JOUES, REFUS_AUTHENTIFICATION, creerComptes } from './matrice-droits/comptes.mjs';
import { FAMILLES, INEXISTANT, VALEURS_FIXES, cibleDe, construireJeuDeDonnees, jourSociete } from './matrice-droits/donnees.mjs';
import { PREFIXE_CLES, ROUTES_PUBLIQUES, ROUTES_SESSION } from './matrice-droits/routes.mjs';

const TITRE = 'Lot D1a-1 : matrice des droits à l’entrée de chaque route de session';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const REFERENCE = join(DOSSIER_MATRICES, 'entrees.txt');
const CONTEXTE_PLANNING_DESACTIVE = 'planningActif=non';
const ROUTE_PUBLIQUE = 'GET /api/planning/public/:token';

// Paramètres de requête fixes des lectures qui les exigent (nommés, comme les valeurs fixes des chemins).
const REQUETES = {
  plage: () => ({ start: jourSociete(-3), end: jourSociete(3) }),
};

// Chemin d'une route pour une cible : chaque paramètre de dossier reçoit l'identifiant de la cible, chaque autre
// paramètre sa valeur fixe (cadrage §2.3).
function cheminPour(chemin, famille, cible) {
  return chemin.replace(/:([A-Za-z]+)/g, (_, nom) => {
    if (famille && cible) {
      const ids = cible.ids;
      if (nom === 'coutId') return ids.coutId;
      if (nom === 'clientId') return ids.clientId ?? ids.id;
      if (nom === 'id' || nom === 'rapportId') return ids.id;
    }
    assert.ok(Object.hasOwn(VALEURS_FIXES, nom), `paramètre sans valeur : ${nom} (${chemin})`);
    return VALEURS_FIXES[nom];
  });
}
// Cible d'une route sans paramètre de dossier : « — », ou ses valeurs fixes (par exemple « cle=CLIENT »).
function cibleSansFamille(chemin) {
  const noms = [...chemin.matchAll(/:([A-Za-z]+)/g)].map(([, nom]) => nom);
  return noms.length ? noms.map((nom) => `${nom}=${VALEURS_FIXES[nom]}`).join(',') : SANS_CIBLE;
}
// Cibles jouées pour une route : toutes celles de sa famille (lecture, écriture (a)), la seule cible `inexistant`
// (écriture (b)), aucune cible nommée pour une route sans paramètre de dossier.
function ciblesDe(definition, chemin) {
  if (!definition.famille) return [{ nom: cibleSansFamille(chemin) }];
  const cibles = FAMILLES[definition.famille].cibles;
  return definition.ecriture === 'b' ? cibles.filter((c) => c.nom === INEXISTANT) : cibles;
}

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const base = baseJetable(TEST_DATABASE_URL, 'entrees');
    let appli; let tables = [];
    let comptes = {}; let refus = {};
    let partage = null;
    const lignes = [];
    const ecrituresInattendues = [];
    let routesApplication = [];

    const jetonDe = (cle) => (Object.hasOwn(comptes, cle) ? comptes[cle].jeton : refus[cle].jeton);
    const empreinte = () => empreinteBase(appli.prisma, tables);
    // Appel d'un compte sur une route et une cible, enregistré comme une ligne de la matrice.
    const jouer = async ({ compte, methode, chemin, definition, cible, contexte = CONTEXTE_DEFAUT, ecriture = null }) => {
      const res = await appeler(appli.adresse, methode, cheminPour(chemin, definition.famille, cible.ids ? cible : null), {
        jeton: jetonDe(compte),
        corps: methode === 'GET' ? undefined : {},
        requete: definition.requete ? REQUETES[definition.requete]() : undefined,
      });
      return { res, ligne: (ecritureNotee = ecriture) => ligneMatrice({
        compte, methode, chemin, cible: cible.nom, contexte,
        reponse: formaterReponse(res, { validationAvantDroit: !!definition.validationAvantDroit, ecriture: ecritureNotee }),
      }) };
    };
    // Une route lue ou écrite en (a) ou (b) : tous les comptes contre ses cibles, en parallèle (aucune n'écrit),
    // puis l'empreinte de toute la base comparée à celle d'avant la route.
    const jouerRoute = async (cle, comptesJoues, contexte) => {
      const [methode, chemin] = cle.split(' ');
      const definition = ROUTES_SESSION[cle];
      const avant = await empreinte();
      const taches = [];
      for (const compte of comptesJoues) for (const cible of ciblesDe(definition, chemin)) {
        taches.push(async () => (await jouer({ compte, methode, chemin, definition, cible, contexte })).ligne());
      }
      lignes.push(...await enParallele(taches, 8));
      const apres = await empreinte();
      const changees = tablesChangees(avant, apres);
      if (changees.length) ecrituresInattendues.push(`${cle} (${contexte}) : ${changees.join(', ')}`);
    };
    // Une écriture (c) : un appel à la fois, empreinte avant et après chacun ; « écrit » ou « inchangé ».
    const jouerRouteC = async (cle, comptesJoues, contexte) => {
      const [methode, chemin] = cle.split(' ');
      const definition = ROUTES_SESSION[cle];
      for (const compte of comptesJoues) {
        const avant = await empreinte();
        const { ligne } = await jouer({ compte, methode, chemin, definition, cible: { nom: SANS_CIBLE }, contexte });
        const apres = await empreinte();
        lignes.push(ligne(tablesChangees(avant, apres).length ? 'écrit' : 'inchangé'));
      }
    };
    const regler = async (corps) => {
      const res = await appeler(appli.adresse, 'PUT', '/api/modules', { jeton: comptes.SA.jeton, corps });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    };

    before(async () => {
      await base.creer();
      appli = await chargerApplication(base);
      const connexion = await appeler(appli.adresse, 'POST', '/api/auth/secours', { corps: { token: JETON_SECOURS } });
      assert.equal(connexion.status, 200, JSON.stringify(connexion.body));
      const secours = await appli.prisma.user.findUniqueOrThrow({ where: { email: EMAIL_SECOURS }, select: { id: true, role: true } });
      assert.equal(secours.role, 'SUPERADMIN');
      const jwtAutre = (id) => appli.jwt.sign({ id }, 'autre-secret-que-celui-de-l-application');
      const crees = await creerComptes({
        prisma: appli.prisma, signer: appli.signer, signerAutreSecret: jwtAutre,
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
      comptes = crees.comptes; refus = crees.refus;
      // Appel du jeu de données : session d'un compte joué, statut exigé.
      const api = async (compte, methode, chemin, corps, statut = 200) => {
        const res = await appeler(appli.adresse, methode, chemin, { jeton: comptes[compte].jeton, corps: methode === 'GET' ? undefined : corps });
        const admis = Array.isArray(statut) ? statut : [statut];
        assert.ok(admis.includes(res.status), `${methode} ${chemin} (${compte}) : ${res.status} ${JSON.stringify(res.body)?.slice(0, 400)}`);
        return res.body;
      };
      const jeu = await construireJeuDeDonnees({ prisma: appli.prisma, api, comptes, donnees: crees.donnees });
      partage = jeu.partage;
      routesApplication = routesDeLApplication(appli.app);
      // Empreinte prise APRÈS la construction : getParametres crée ses lignes à la première lecture (N9).
      tables = await tablesDeLaBase(appli.prisma);
      assert.ok(tables.includes('Parametres') && tables.includes('JournalAdministration') && tables.includes('User'), tables.join(', '));
      await empreinte();
    });

    after(async () => {
      await appli?.fermer();
      await base.supprimer();
    });

    // Cadrage §2.1 : « un test vérifie que chaque route de app.router.stack (application importée) a au moins une
    // ligne, ou figure dans une liste d'exclusions justifiées » ; §2.4 : « Une route d'écriture qui ne figure ni en
    // (a), ni en (b), ni en (c) fait échouer le test de couverture. »
    test('couverture : chaque route de session a son entrée dans la table, chaque écriture est classée (a), (b) ou (c), et la table ne nomme aucune route absente', () => {
      const cles = routesApplication.map((r) => cleRoute(r.methode, r.chemin));
      assert.equal(new Set(cles).size, cles.length, 'une route n’est montée qu’une fois');
      const publiques = cles.filter((cle) => ROUTES_PUBLIQUES.includes(cle));
      assert.deepEqual([...publiques].sort(), [...ROUTES_PUBLIQUES].sort(), 'les 6 routes publiques exclues existent');
      for (const route of routesApplication) {
        const cle = cleRoute(route.methode, route.chemin);
        if (ROUTES_PUBLIQUES.includes(cle)) {
          assert.ok(!route.gestionnaires.includes('requireAuth'), `${cle} : exclue comme publique, elle porte requireAuth`);
        } else if (route.chemin.startsWith(PREFIXE_CLES)) {
          assert.ok(!route.gestionnaires.includes('requireAuth'), `${cle} : route /api/v1 ouverte à une session`);
        } else {
          assert.equal(route.gestionnaires[0], 'requireAuth', `${cle} : route de session sans requireAuth en tête`);
        }
      }
      const session = cles.filter((cle) => !ROUTES_PUBLIQUES.includes(cle) && !cle.split(' ')[1].startsWith(PREFIXE_CLES));
      const sansEntree = session.filter((cle) => !Object.hasOwn(ROUTES_SESSION, cle));
      assert.deepEqual(sansEntree, [], 'routes de session sans entrée dans server/tests/matrice-droits/routes.mjs');
      const sansRoute = Object.keys(ROUTES_SESSION).filter((cle) => !session.includes(cle));
      assert.deepEqual(sansRoute, [], 'entrées de la table sans route dans l’application');
      for (const cle of session) {
        const definition = ROUTES_SESSION[cle];
        if (cle.startsWith('GET ')) {
          assert.ok(definition.lecture && !definition.ecriture, `${cle} : une lecture`);
        } else {
          assert.ok(['a', 'b', 'c'].includes(definition.ecriture), `${cle} : écriture non classée (a), (b) ou (c)`);
          if (definition.ecriture === 'b') assert.ok(definition.famille || /:[A-Za-z]/.test(cle), `${cle} : une écriture (b) a un paramètre, qui vise un identifiant inexistant`);
          if (definition.ecriture === 'c') assert.ok(!/:[A-Za-z]/.test(cle), `${cle} : une écriture (c) n’a pas de paramètre`);
        }
        if (definition.famille) assert.ok(FAMILLES[definition.famille], `${cle} : famille inconnue ${definition.famille}`);
      }
    });

    // Cadrage §2.2 : « Refus à l'authentification : sans session (401) ; compte désactivé (401 COMPTE_DESACTIVE) ;
    // compte système (401 « Compte introuvable ou révoqué ») ; jeton d'un compte supprimé (N7). » Chaque refus est
    // joué sur chaque route de session, contre une seule cible (`inexistant`, ou aucune) : requireAuth précède tout
    // gestionnaire (vérifié par le test de couverture), la cible ne peut donc pas changer sa réponse.
    test('refus à l’authentification : chaque route de session répond 401 sans session, avec un jeton invalide, d’un compte désactivé, système ou supprimé, sans rien écrire', async () => {
      const avant = await empreinte();
      const taches = [];
      for (const cle of Object.keys(ROUTES_SESSION)) {
        const [methode, chemin] = cle.split(' ');
        const definition = ROUTES_SESSION[cle];
        const cible = definition.famille ? cibleDe(definition.famille, INEXISTANT) : { nom: cibleSansFamille(chemin) };
        for (const { cle: compte } of REFUS_AUTHENTIFICATION) {
          taches.push(async () => {
            const { res, ligne } = await jouer({ compte, methode, chemin, definition, cible });
            assert.equal(res.status, 401, `${compte} sur ${cle} : ${res.status} ${JSON.stringify(res.body)}`);
            return ligne();
          });
        }
      }
      lignes.push(...await enParallele(taches, 8));
      assert.deepEqual(tablesChangees(avant, await empreinte()), [], 'un refus à l’authentification n’écrit rien');
    });

    // Cadrage §3, D1a-1 : « Pour chaque route de session × chaque compte × chaque cible de sa famille : réponse à
    // l'entrée » ; §2.4 : écritures (a) à corps vide, (b) sur un identifiant inexistant, empreinte par route.
    test('entrées : chaque compte sur chaque route de session (lectures, écritures (a) et (b)) et chaque cible de sa famille, sans qu’aucun appel n’écrive', async () => {
      for (const cle of Object.keys(ROUTES_SESSION).sort()) {
        if (ROUTES_SESSION[cle].ecriture === 'c') continue;
        await jouerRoute(cle, COMPTES_JOUES, CONTEXTE_DEFAUT);
      }
      assert.deepEqual(ecrituresInattendues, [], 'routes jouées en lecture, en (a) ou en (b) qui ont écrit (route : tables changées)');
    });

    // Cadrage §2.5 : « D1a-1 rejoue aussi les 15 routes qui portent requirePlanningActif avec planningActif désactivé :
    // l'entrée seulement, pour tous les comptes (refus PLANNING_DESACTIVE, exemption du super administrateur). Ce
    // passage suit le classement (a), (b), (c) et l'empreinte du §2.4. »
    test('module Planning désactivé : les routes qui portent requirePlanningActif refusent PLANNING_DESACTIVE à tous, sauf au super administrateur', async () => {
      const routesPlanning = routesApplication.filter((r) => r.gestionnaires.includes('requirePlanningActif')).map((r) => cleRoute(r.methode, r.chemin)).sort();
      assert.equal(routesPlanning.length, 15, `routes portant requirePlanningActif : ${routesPlanning.join(', ')}`);
      const debut = ecrituresInattendues.length;
      await regler({ planningActif: false });
      try {
        for (const cle of routesPlanning) if (ROUTES_SESSION[cle].ecriture !== 'c') await jouerRoute(cle, COMPTES_JOUES, CONTEXTE_PLANNING_DESACTIVE);
        for (const cle of routesPlanning) if (ROUTES_SESSION[cle].ecriture === 'c') await jouerRouteC(cle, COMPTES_JOUES, CONTEXTE_PLANNING_DESACTIVE);
      } finally {
        await regler({ planningActif: true });
      }
      assert.deepEqual(ecrituresInattendues.slice(debut), [], 'routes du planning jouées en lecture, en (a) ou en (b) qui ont écrit');
    });

    // Cadrage §2.1 (N5) : « une petite table enregistre à part le lien public du planning : jeton valide, invalide,
    // partage inactif, planningActif ». Le lien public garde son propre interrupteur (planning/metier.ts).
    test('lien public du planning : jeton valide, jeton invalide, partage inactif, module désactivé', async () => {
      assert.ok(partage?.token, 'le jeu de données publie le planning');
      // État de départ explicite : le passage « module désactivé » a joué les écritures (c) du partage, que le super
      // administrateur exempté a exécutées (nouveau lien, partage coupé). Le partage est donc réactivé et son jeton
      // relu avant la table.
      const basculer = async (active) => {
        const res = await appeler(appli.adresse, 'PATCH', '/api/planning/share', { jeton: comptes.SA.jeton, corps: { active } });
        assert.equal(res.status, 200, JSON.stringify(res.body));
      };
      await basculer(true);
      const lu = await appeler(appli.adresse, 'GET', '/api/planning/share', { jeton: comptes.SA.jeton });
      assert.equal(lu.status, 200, JSON.stringify(lu.body));
      assert.equal(lu.body.active, true);
      const token = lu.body.token;
      assert.ok(token);
      const jouerPublic = async (cibleNom, jeton, contexte) => {
        const res = await appeler(appli.adresse, 'GET', `/api/planning/public/${encodeURIComponent(jeton)}`);
        lignes.push(ligneMatrice({ compte: 'PUBLIC', methode: 'GET', chemin: '/api/planning/public/:token', cible: cibleNom, contexte, reponse: formaterReponse(res) }));
      };
      const avant = await empreinte();
      await jouerPublic('jeton-valide', token, 'partage actif');
      await jouerPublic('jeton-invalide', `${token.slice(0, -4)}xxxx`, 'partage actif');
      assert.deepEqual(tablesChangees(avant, await empreinte()), [], 'la lecture publique n’écrit rien');
      await basculer(false);
      await jouerPublic('jeton-valide', token, 'partage inactif');
      await basculer(true);
      await regler({ planningActif: false });
      try { await jouerPublic('jeton-valide', token, CONTEXTE_PLANNING_DESACTIVE); } finally { await regler({ planningActif: true }); }
      assert.ok(lignes.some((l) => l.includes(ROUTE_PUBLIQUE)));
    });

    // Cadrage §2.4 (c) : « jouées à la fin, une route à la fois, avec une empreinte avant et après ; pour un compte
    // admis, la référence enregistre « écrit » ». Les comptes jouent dans l'ordre fixe de COMPTES_JOUES.
    test('écritures sans corps ni paramètre (c), jouées à la fin, une à la fois : « écrit » ou « inchangé » pour chaque compte', async () => {
      for (const cle of Object.keys(ROUTES_SESSION).sort()) {
        if (ROUTES_SESSION[cle].ecriture === 'c') await jouerRouteC(cle, COMPTES_JOUES, CONTEXTE_DEFAUT);
      }
    });

    // Cadrage §2.1 : chaque route de session a au moins une ligne ; la matrice obtenue est la référence, au
    // caractère près (N8 : diff imprimé, matrice obtenue écrite hors du dépôt).
    test('la matrice obtenue est la référence matrice-droits/entrees.txt, et chaque route de session y a ses lignes', () => {
      const routesVues = new Set(lignes.map((ligne) => ligne.split(' | ')[1]));
      const sansLigne = Object.keys(ROUTES_SESSION).filter((cle) => !routesVues.has(cle));
      assert.deepEqual(sansLigne, [], 'routes de session sans ligne dans la matrice');
      const cles = lignes.map((ligne) => ligne.split(' | ').slice(0, 4).join(' | '));
      assert.equal(new Set(cles).size, cles.length, 'chaque cas n’a qu’une ligne');
      comparerAvecReference(lignes, REFERENCE, 'entrees.txt');
    });
  });
}
