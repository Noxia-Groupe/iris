// Lot D1a-2 : matrice des droits des clés d'intégration (/api/v1), tests seuls (cadrage du lot D1a, version 3 du
// 01-11-2026, §2 et ligne D1a-2 du §3 ; CIBLE §7.1, ligne « Clés d'intégration : chaque scope, seul »).
//
// Tests seuls : ce fichier enregistre le comportement actuel, sans rien corriger (cadrage §1 et §7). Il reprend les
// outils, les comptes, le jeu de données et la table des routes de D1a-1 (server/tests/matrice-droits/), et
// enregistre la réponse à l'ENTRÉE (code, et message exact d'un refus) :
//  - de chaque route /api/v1, pour une clé par scope seul (les 13 d'API_SCOPES), contre chaque cible de la famille de
//    la route (une clé n'a pas de périmètre : les familles des routes /api/v1 n'ont que deux à quatre cibles, dont
//    celles dont l'état change la réponse, client désactivé, devis signé ou converti) ;
//  - de chaque route /api/v1, pour une clé absente, inconnue, inactive, révoquée ou expirée ;
//  - de chaque route /api/v1, pour le jeton de session d'un compte de chaque type (N7 : aucune session n'ouvre /api/v1) ;
//  - de chaque route de session, pour une clé qui porte les 13 scopes (aucune clé n'ouvre une route de session).
// Le tout est comparé, au caractère près, à la référence versionnée server/tests/matrice-droits/cles.txt (même format
// qu'entrees.txt). Un écart fait échouer le test, écrit la matrice obtenue hors du dépôt et imprime les premières
// lignes du diff (N8). Un lot qui change volontairement un droit d'une clé recopie la matrice obtenue sur la
// référence, dans sa propre PR.
//
// Aucune écriture : les écritures sont jouées à corps vide (a) ou sur un identifiant inexistant (b) (cadrage §2.4),
// et l'empreinte de toute la base, prise avant et après chaque route, prouve qu'aucune n'a écrit.
//
// Dernière utilisation d'une clé. La porte /api/v1 la note SANS ATTENTE (server/src/http/cles-api.ts, « sans attente
// ni échec bloquant ») : l'écriture peut tomber après la réponse. Méthode retenue, pour que l'empreinte n'échoue pas à
// tort et ne masque aucune écriture :
//  - l'empreinte des routes /api/v1 retire la seule colonne ApiAccessKey.dernierUsageLe ; toute autre écriture, dans
//    cette table comme ailleurs, la change toujours ;
//  - cette colonne est contrôlée à part, clé par clé, avant et après chaque route : elle doit avoir changé pour la
//    seule clé admise par la porte, et pour aucune clé refusée (401 ou 403) ;
//  - pour qu'aucune écriture différée ne déborde sur la route suivante, chaque clé joue ses cibles l'une après
//    l'autre, et après chaque appel admis on attend, dans un délai borné, que la base porte une dernière utilisation
//    postérieure à l'envoi de l'appel (comme appelAdmisParCle, envoi-microsoft-365.test.mjs, #420). Une seule
//    écriture différée est alors en cours par clé : celle de l'appel qu'on attend. À la fin de la route, il n'en
//    reste aucune ;
//  - un test dédié prouve que l'écriture se fait sans attente (la réponse arrive pendant que la ligne de la clé est
//    verrouillée), qu'un appel admis la note, et qu'un refus 403 ou 401 ne la note pas ; puis, en fin de fichier,
//    que les clés jamais admises n'ont aucune dernière utilisation (une écriture tardive d'un refus s'y verrait).
//
// Comme production-pdf.test.mjs et matrice-droits-entrees.test.mjs, ce fichier crée sur le serveur de
// TEST_DATABASE_URL une base jetable qui n'appartient qu'à lui, la migre, la sert à l'application, puis la supprime.
// Sans TEST_DATABASE_URL, il s'annonce ignoré : un SKIP n'est pas une réussite.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import inspector from 'node:inspector/promises';
import test, { after, before, describe } from 'node:test';
import { join } from 'node:path';
import {
  DOSSIER_MATRICES, EMAIL_SECOURS, JETON_SECOURS, appeler, baseJetable, chargerApplication, cleRoute, comparerAvecReference,
  empreinteBase, enParallele, formaterReponse, ligneMatrice, routesDeLApplication, tablesChangees, tablesDeLaBase,
} from './matrice-droits/outils.mjs';
import { TYPES_DE_COMPTE, creerComptes } from './matrice-droits/comptes.mjs';
import { INEXISTANT, cheminPour, cibleDe, cibleSansFamille, ciblesDe, construireJeuDeDonnees } from './matrice-droits/donnees.mjs';
import { PREFIXE_CLES, ROUTES_CLES, ROUTES_SESSION } from './matrice-droits/routes.mjs';

const TITRE = 'Lot D1a-2 : matrice des droits des clés d’intégration (/api/v1)';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const REFERENCE = join(DOSSIER_MATRICES, 'cles.txt');
// Délai borné de l'écriture différée de la dernière utilisation (même borne qu'appelAdmisParCle).
const DELAI_USAGE_MS = 10_000;
const SANS_USAGE = { colonnesIgnorees: { ApiAccessKey: ['dernierUsageLe'] } };

// Clés jouées. Une clé par scope seul, nommée « CLE <scope> » dans la référence ; la clé qui porte les 13 scopes ;
// les états d'une clé (cadrage §3, D1a-2 : « clé absente, révoquée, expirée, inactive »), dont trois formes de clé
// absente : l'en-tête manque, ou ne commence pas par « Bearer iris_ » (cles-api.ts). Les clés inactive, révoquée et
// expirée portent les 13 scopes : leur refus ne peut venir que de leur état. La révocation par l'API pose à la fois
// `actif` faux et la date de révocation ; une clé qui ne porte que la date (CLE-REVOQUEE-ACTIVE) isole le contrôle de
// cette date, comme CLE-INACTIVE isole celui d'`actif`.
const nomCleScope = (scope) => `CLE ${scope}`;
const CLE_TOUS_SCOPES = 'CLE-TOUS-SCOPES';
const ETATS_CLE = [
  { cle: 'CLE-ABSENTE', libelle: 'sans en-tête Authorization' },
  { cle: 'CLE-SANS-PREFIXE', libelle: '« Bearer » et le secret valide de CLE-TOUS-SCOPES privé de son préfixe « iris_ »' },
  { cle: 'CLE-AUTRE-SCHEMA', libelle: '« Basic » et le secret valide de CLE-TOUS-SCOPES' },
  { cle: 'CLE-INCONNUE', libelle: 'secret de forme valide (« iris_ » et 43 caractères), absent de la base' },
  { cle: 'CLE-INACTIVE', libelle: 'actif faux, sans révocation, 13 scopes' },
  { cle: 'CLE-REVOQUEE', libelle: 'révoquée par l’API (actif faux et date de révocation), 13 scopes' },
  { cle: 'CLE-REVOQUEE-ACTIVE', libelle: 'date de révocation, actif vrai (isole le contrôle de la révocation), 13 scopes' },
  { cle: 'CLE-EXPIREE', libelle: 'expireLe passé, posé à la création par l’API, 13 scopes' },
];
// Refus de la porte /api/v1 (cles-api.ts) : 401 (clé absente, inconnue, inactive, révoquée ou expirée), ou 403
// « Scope requis : … ». Toute autre réponse vient d'un appel admis par la porte.
const refuseeParLaPorte = (res) => res.status === 401 || (res.status === 403 && /^Scope requis : /.test(res.body?.error ?? ''));
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Valeurs simples de la portée de chaque fonction nommée qui enferme `fonction` (lues par l'inspecteur de V8, comme
// server/scripts/routes.mjs relève « {scope="…"} ») : [{ fabrique, variables }].
async function porteesDe(session, fonction) {
  globalThis.__porteMatriceCles = fonction;
  try {
    const { result } = await session.post('Runtime.evaluate', { expression: 'globalThis.__porteMatriceCles', objectGroup: 'matrice-cles' });
    const { internalProperties = [] } = await session.post('Runtime.getProperties', { objectId: result.objectId, ownProperties: true });
    const portees = internalProperties.find((propriete) => propriete.name === '[[Scopes]]');
    if (!portees) return [];
    const { result: liste } = await session.post('Runtime.getProperties', { objectId: portees.value.objectId, ownProperties: true });
    const sortie = [];
    for (const portee of liste) {
      const fabrique = /^Closure \((.+)\)$/.exec(portee.value?.description ?? '')?.[1];
      if (!fabrique) continue;
      const { result: variables } = await session.post('Runtime.getProperties', { objectId: portee.value.objectId, ownProperties: true });
      const simples = variables.filter((v) => ['string', 'number', 'boolean'].includes(v.value?.type)).map((v) => [v.name, v.value.value]);
      sortie.push({ fabrique, variables: Object.fromEntries(simples) });
    }
    return sortie;
  } finally {
    delete globalThis.__porteMatriceCles;
    await session.post('Runtime.releaseObjectGroup', { objectGroup: 'matrice-cles' });
  }
}

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const base = baseJetable(TEST_DATABASE_URL, 'cles');
    let appli; let tables = [];
    let comptes = {};
    let moduleCles = null;
    let routesApplication = [];
    // Clés jouées : nom de la référence → { id (null si absente de la base), autorisation (en-tête, ou null) }.
    const cles = {};
    let clesParScope = [];
    // Clés admises au moins une fois par la porte, au fil du fichier (contrôle final de la dernière utilisation).
    const admisesAuMoinsUneFois = new Set();
    const lignes = [];

    const empreinte = () => empreinteBase(appli.prisma, tables);
    const empreinteSansUsage = () => empreinteBase(appli.prisma, tables, SANS_USAGE);
    const usages = async () => Object.fromEntries((await appli.prisma.apiAccessKey.findMany({ select: { id: true, dernierUsageLe: true } }))
      .map((cle) => [cle.id, cle.dernierUsageLe?.getTime() ?? null]));
    const usageDe = async (id) => (await appli.prisma.apiAccessKey.findUniqueOrThrow({ where: { id }, select: { dernierUsageLe: true } })).dernierUsageLe?.getTime() ?? null;
    // Attente bornée de l'écriture différée : la base porte une dernière utilisation postérieure à l'envoi de l'appel
    // (l'application tourne dans ce processus : même horloge ; la colonne garde la milliseconde).
    const attendreUsage = async (id, envoi, contexte) => {
      const debut = Date.now();
      for (;;) {
        const instant = await usageDe(id);
        if (instant !== null && instant >= envoi) return instant;
        if (Date.now() - debut > DELAI_USAGE_MS) assert.fail(`${contexte} : la dernière utilisation de la clé n’est pas notée en base en ${DELAI_USAGE_MS / 1000} s`);
        await pause(10);
      }
    };
    // Appel d'une route pour une cible, avec un en-tête Authorization donné tel quel ; rend la réponse et sa ligne.
    const jouer = async ({ compte, autorisation, methode, chemin, definition, cible }) => {
      const res = await appeler(appli.adresse, methode, cheminPour(chemin, definition.famille, cible.ids ? cible : null), {
        autorisation, corps: methode === 'GET' ? undefined : {},
      });
      return { res, ligne: ligneMatrice({ compte, methode, chemin, cible: cible.nom, reponse: formaterReponse(res, { validationAvantDroit: !!definition.validationAvantDroit }) }) };
    };
    // Cible unique d'un refus joué avant toute garde de dossier : `inexistant`, ou aucune (comme D1a-1).
    const cibleUnique = (definition, chemin) => (definition.famille ? cibleDe(definition.famille, INEXISTANT) : { nom: cibleSansFamille(chemin) });
    // Lot de cas qui doivent tous répondre 401, joués en parallèle. Chaque ligne est gardée, même quand un cas n'est
    // pas refusé : le diff de la référence le montre (aucune assertion ne coupe le lot en route). Si la porte a admis
    // une clé à tort, l'écriture différée de sa dernière utilisation est attendue avant l'empreinte « après », pour ne
    // pas tomber dans le test suivant. Rend les cas non refusés et les tables changées.
    const jouerRefus = async (cas) => {
      const debut = Date.now();
      const avant = await empreinte();
      const resultats = await enParallele(cas.map((c) => async () => ({ ...c, ...(await jouer(c)) })), 8);
      lignes.push(...resultats.map((r) => r.ligne));
      const admisesATort = new Set(resultats.filter((r) => !refuseeParLaPorte(r.res) && cles[r.compte]?.id).map((r) => cles[r.compte].id));
      for (const id of admisesATort) await attendreUsage(id, debut, 'clé admise à tort').catch(() => {});
      return {
        nonRefuses: resultats.filter((r) => r.res.status !== 401).map((r) => `${r.compte} sur ${r.methode} ${r.chemin} : ${r.res.status} ${JSON.stringify(r.res.body)}`),
        changees: tablesChangees(avant, await empreinte()),
      };
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
      const api = async (compte, methode, chemin, corps, statut = 200) => {
        const res = await appeler(appli.adresse, methode, chemin, { jeton: comptes[compte].jeton, corps: methode === 'GET' ? undefined : corps });
        const admis = Array.isArray(statut) ? statut : [statut];
        assert.ok(admis.includes(res.status), `${methode} ${chemin} (${compte}) : ${res.status} ${JSON.stringify(res.body)?.slice(0, 400)}`);
        return res.body;
      };
      await construireJeuDeDonnees({ prisma: appli.prisma, api, comptes, donnees: crees.donnees });

      // Porte /api/v1, relue dans l'application compilée déjà chargée (même module) : témoin du test de couverture.
      moduleCles = (await import('../dist/src/http/cles-api.js')).default;
      // Scopes : la liste servie à l'écran d'administration est celle d'API_SCOPES (une clé par scope seul).
      const { scopes } = await api('SA', 'GET', '/api/admin/api-scopes');
      assert.deepEqual(scopes, [...moduleCles.API_SCOPES], 'GET /api/admin/api-scopes rend API_SCOPES');

      // Clés créées par l'API, session du super administrateur (cadrage §2.3 : « par l'API quand une route existe »).
      const creerCle = async (nom, scopesCle, extra = {}) => {
        const corps = await api('SA', 'POST', '/api/admin/api-keys', { nom: `TEST Matrice ${nom}`, scopes: scopesCle, ...extra }, 201);
        assert.match(corps.apiKey, /^iris_[A-Za-z0-9_-]{43}$/);
        return { id: corps.key.id, secret: corps.apiKey };
      };
      for (const scope of scopes) {
        const { id, secret } = await creerCle(nomCleScope(scope), [scope]);
        cles[nomCleScope(scope)] = { id, scope, autorisation: `Bearer ${secret}` };
      }
      clesParScope = scopes.map((scope) => ({ nom: nomCleScope(scope), ...cles[nomCleScope(scope)] }));
      const tous = await creerCle(CLE_TOUS_SCOPES, scopes);
      cles[CLE_TOUS_SCOPES] = { id: tous.id, autorisation: `Bearer ${tous.secret}` };
      cles['CLE-ABSENTE'] = { id: null, autorisation: null };
      cles['CLE-SANS-PREFIXE'] = { id: null, autorisation: `Bearer ${tous.secret.slice('iris_'.length)}` };
      cles['CLE-AUTRE-SCHEMA'] = { id: null, autorisation: `Basic ${tous.secret}` };
      cles['CLE-INCONNUE'] = { id: null, autorisation: `Bearer iris_${randomBytes(32).toString('base64url')}` };
      // Inactive sans révocation : aucune route ne pose `actif` faux sans poser aussi la date de révocation
      // (POST /api/admin/api-keys/:id/revoke pose les deux) ; l'état est donc écrit en base.
      const inactive = await creerCle('CLE-INACTIVE', scopes);
      await appli.prisma.apiAccessKey.update({ where: { id: inactive.id }, data: { actif: false } });
      cles['CLE-INACTIVE'] = { id: inactive.id, autorisation: `Bearer ${inactive.secret}` };
      const revoquee = await creerCle('CLE-REVOQUEE', scopes);
      await api('SA', 'POST', `/api/admin/api-keys/${revoquee.id}/revoke`, {});
      cles['CLE-REVOQUEE'] = { id: revoquee.id, autorisation: `Bearer ${revoquee.secret}` };
      // Date de révocation sans `actif` faux : aucune route ne l'écrit (la révocation pose les deux) ; écrite en base.
      const revoqueeActive = await creerCle('CLE-REVOQUEE-ACTIVE', scopes);
      await appli.prisma.apiAccessKey.update({ where: { id: revoqueeActive.id }, data: { revoqueLe: new Date() } });
      cles['CLE-REVOQUEE-ACTIVE'] = { id: revoqueeActive.id, autorisation: `Bearer ${revoqueeActive.secret}` };
      // L'API accepte une échéance passée (seule une date illisible est refusée).
      const expiree = await creerCle('CLE-EXPIREE', scopes, { expireLe: new Date(Date.now() - 86_400_000).toISOString() });
      cles['CLE-EXPIREE'] = { id: expiree.id, autorisation: `Bearer ${expiree.secret}` };

      // Les faits qui portent les noms des clés, relus en base.
      const lue = async (nom) => appli.prisma.apiAccessKey.findUniqueOrThrow({ where: { id: cles[nom].id } });
      for (const { nom, scope } of clesParScope) {
        const cle = await lue(nom);
        assert.deepEqual({ scopes: cle.scopes, actif: cle.actif, revoqueLe: cle.revoqueLe, expireLe: cle.expireLe, dernierUsageLe: cle.dernierUsageLe }, { scopes: [scope], actif: true, revoqueLe: null, expireLe: null, dernierUsageLe: null }, nom);
      }
      const etat = async (nom) => { const c = await lue(nom); return { scopes: c.scopes, actif: c.actif, revoquee: c.revoqueLe !== null, expiree: c.expireLe !== null && c.expireLe <= new Date(), dernierUsageLe: c.dernierUsageLe }; };
      assert.deepEqual(await etat(CLE_TOUS_SCOPES), { scopes, actif: true, revoquee: false, expiree: false, dernierUsageLe: null });
      assert.deepEqual(await etat('CLE-INACTIVE'), { scopes, actif: false, revoquee: false, expiree: false, dernierUsageLe: null });
      assert.deepEqual(await etat('CLE-REVOQUEE'), { scopes, actif: false, revoquee: true, expiree: false, dernierUsageLe: null });
      assert.deepEqual(await etat('CLE-REVOQUEE-ACTIVE'), { scopes, actif: true, revoquee: true, expiree: false, dernierUsageLe: null });
      assert.deepEqual(await etat('CLE-EXPIREE'), { scopes, actif: true, revoquee: false, expiree: true, dernierUsageLe: null });
      assert.equal(Object.keys(cles).length, scopes.length + 1 + ETATS_CLE.length);

      routesApplication = routesDeLApplication(appli.app);
      // Empreinte prise APRÈS la construction : getParametres crée ses lignes à la première lecture (N9).
      tables = await tablesDeLaBase(appli.prisma);
      assert.ok(tables.includes('ApiAccessKey') && tables.includes('JournalAdministration'), tables.join(', '));
      await empreinte();
    });

    after(async () => {
      await appli?.fermer();
      await base.supprimer();
    });

    // Cadrage §3, D1a-2 et note N5 de l'audit de #427 : chaque route /api/v1 a son entrée (famille, nature, scope
    // attendu) ; le scope relevé sur la route est celui de la table ; requireApiKey garde chaque route /api/v1. Une
    // route /api/v1 ajoutée sans entrée fait échouer le test.
    test('couverture : chaque route /api/v1 a son entrée, sa porte en tête est requireApiKey avec le scope de la table, et une route de routeMixte a le gestionnaire et le classement de sa jumelle de session', async () => {
      // Un sous-routeur (app.use(chemin, routeur)) cacherait ses routes au relevé (T2 de #428).
      const sousRouteurs = appli.app.router.stack.filter((couche) => !couche.route && Array.isArray(couche.handle?.stack));
      assert.deepEqual(sousRouteurs.map((couche) => couche.name), [], 'sous-routeur monté : ses routes échappent à la matrice');
      const v1 = routesApplication.filter((route) => route.chemin.startsWith(PREFIXE_CLES)).map((route) => cleRoute(route.methode, route.chemin));
      assert.equal(new Set(v1).size, v1.length, 'une route /api/v1 n’est montée qu’une fois');
      assert.deepEqual(v1.filter((cle) => !Object.hasOwn(ROUTES_CLES, cle)), [], 'routes /api/v1 sans entrée dans ROUTES_CLES (server/tests/matrice-droits/routes.mjs)');
      assert.deepEqual(Object.keys(ROUTES_CLES).filter((cle) => !v1.includes(cle)), [], 'entrées de ROUTES_CLES sans route dans l’application');
      assert.equal(v1.length, 28, `routes /api/v1 : ${v1.join(', ')}`);

      const temoin = Function.prototype.toString.call(moduleCles.requireApiKey(moduleCles.API_SCOPES[0]));
      const couches = new Map();
      for (const couche of appli.app.router.stack) {
        if (!couche.route) continue;
        for (const methode of Object.keys(couche.route.methods)) couches.set(cleRoute(methode.toUpperCase(), couche.route.path), couche);
      }
      const session = new inspector.Session();
      session.connect();
      await session.post('Runtime.enable');
      const ecarts = [];
      const sansJumelle = [];
      try {
        for (const cle of Object.keys(ROUTES_CLES).sort()) {
          const definition = ROUTES_CLES[cle];
          const [methode, chemin] = cle.split(' ');
          const pile = couches.get(cle).route.stack;
          // Porte : la fermeture fabriquée par requireApiKey, en tête, sans autre garde (« La porte /api/v1 ne prend
          // jamais de garde de rôle », routes-mixtes.ts) : la porte et le gestionnaire, rien d'autre.
          if (Function.prototype.toString.call(pile[0].handle) !== temoin) ecarts.push(`${cle} : la première couche n’est pas la porte de requireApiKey`);
          if (pile.length !== 2) ecarts.push(`${cle} : ${pile.length} couches (${pile.map((g) => g.name).join(' > ')}), au lieu de la porte et du gestionnaire`);
          const fabrique = (await porteesDe(session, pile[0].handle)).find((portee) => portee.fabrique === 'requireApiKey');
          if (!fabrique) ecarts.push(`${cle} : porte qui n’est pas fabriquée par requireApiKey`);
          else if (fabrique.variables.scope !== definition.scope) ecarts.push(`${cle} : scope relevé « ${fabrique.variables.scope} », attendu « ${definition.scope} »`);
          if (!moduleCles.API_SCOPES.includes(definition.scope)) ecarts.push(`${cle} : scope « ${definition.scope} » absent d’API_SCOPES`);
          // Jumelle de session montée par routeMixte : même gestionnaire, donc même famille et même classement.
          const jumelle = cleRoute(methode, chemin.replace(PREFIXE_CLES, '/api/'));
          const pileJumelle = couches.get(jumelle)?.route.stack;
          if (!pileJumelle || pileJumelle.at(-1).handle !== pile.at(-1).handle) { sansJumelle.push(cle); continue; }
          const resume = (d) => ({ famille: d.famille, lecture: !!d.lecture, ecriture: d.ecriture ?? null, validationAvantDroit: !!d.validationAvantDroit });
          if (JSON.stringify(resume(definition)) !== JSON.stringify(resume(ROUTES_SESSION[jumelle]))) ecarts.push(`${cle} : classement différent de sa jumelle ${jumelle}`);
        }
      } finally {
        session.disconnect();
      }
      assert.deepEqual(ecarts, [], 'portes et classement des routes /api/v1');
      // Seule GET /api/v1/company a son propre gestionnaire (administration/routes.ts) ; les 27 autres sont montées
      // par routeMixte.
      assert.deepEqual(sansJumelle, ['GET /api/v1/company'], 'routes /api/v1 sans jumelle de session au même gestionnaire');
      for (const cle of Object.keys(ROUTES_CLES)) {
        const definition = ROUTES_CLES[cle];
        if (cle.startsWith('GET ')) assert.ok(definition.lecture && !definition.ecriture, `${cle} : une lecture`);
        else assert.ok(['a', 'b'].includes(definition.ecriture), `${cle} : écriture classée (a) ou (b) (aucune route /api/v1 n’est sans paramètre ni corps)`);
      }
    });

    // Cadrage §3, D1a-2 : « Les 28 routes /api/v1 × chaque scope seul (13) » ; §2.4 : écritures (a) à corps vide, (b)
    // sur un identifiant inexistant, empreinte par route. CIBLE §4.2 : « Clés d'intégration : chaque scope, seul ».
    test('portées : chaque clé à un seul scope, sur chaque route /api/v1 et chaque cible de sa famille ; seule la clé du scope de la route passe la porte, sans écrire, et la dernière utilisation n’est notée que pour elle', async () => {
      const ecritures = [];
      const scopesEnEcart = [];
      const usagesEnEcart = [];
      // Une attente échouée est notée, sans couper la chaîne (toutes les lignes restent comparées à la référence) ;
      // après la première, les suivantes sont abandonnées, pour ne pas attendre le délai à chaque appel admis.
      let usageEnPanne = false;
      const attendreSansCouper = async (id, envoi, contexte) => {
        if (usageEnPanne) return;
        try { await attendreUsage(id, envoi, contexte); } catch (erreur) { usageEnPanne = true; usagesEnEcart.push(erreur.message); }
      };
      for (const cle of Object.keys(ROUTES_CLES).sort()) {
        const [methode, chemin] = cle.split(' ');
        const definition = ROUTES_CLES[cle];
        const cibles = ciblesDe(definition, chemin);
        const avant = await empreinteSansUsage();
        const usagesAvant = await usages();
        const admises = new Set();
        // Une chaîne par clé : ses cibles l'une après l'autre, et après chaque appel admis, l'attente bornée de
        // l'écriture différée de la dernière utilisation. Les chaînes des 13 clés tournent en parallèle.
        const parCle = await enParallele(clesParScope.map((k) => async () => {
          const sorties = [];
          for (const cible of cibles) {
            const envoi = Date.now();
            const { res, ligne } = await jouer({ compte: k.nom, autorisation: k.autorisation, methode, chemin, definition, cible });
            sorties.push(ligne);
            if (refuseeParLaPorte(res)) {
              if (res.status !== 403 || res.body?.error !== `Scope requis : ${definition.scope}`) scopesEnEcart.push(`${cle} ${cible.nom} (${k.nom}) : ${res.status} ${JSON.stringify(res.body)}`);
            } else {
              admises.add(k.id);
              admisesAuMoinsUneFois.add(k.id);
              await attendreSansCouper(k.id, envoi, `${cle} ${cible.nom} (${k.nom}, ${res.status})`);
            }
          }
          return sorties;
        }), 8);
        lignes.push(...parCle.flat());
        // Scope relevé par le comportement : la seule clé admise est celle du scope de la table.
        const admisesNoms = clesParScope.filter((k) => admises.has(k.id)).map((k) => k.scope);
        if (JSON.stringify(admisesNoms) !== JSON.stringify([definition.scope])) scopesEnEcart.push(`${cle} : clés admises par la porte ${JSON.stringify(admisesNoms)}, attendu ["${definition.scope}"]`);
        const changees = tablesChangees(avant, await empreinteSansUsage());
        if (changees.length) ecritures.push(`${cle} : ${changees.join(', ')}`);
        const usagesApres = await usages();
        for (const id of new Set([...Object.keys(usagesAvant), ...Object.keys(usagesApres)])) {
          const change = usagesAvant[id] !== usagesApres[id];
          if (admises.has(id) && !change && !usageEnPanne) usagesEnEcart.push(`${cle} : dernière utilisation non notée pour la clé admise ${id}`);
          if (!admises.has(id) && change) usagesEnEcart.push(`${cle} : dernière utilisation notée pour une clé refusée ou non jouée (${Object.entries(cles).find(([, c]) => c.id === id)?.[0] ?? id})`);
        }
      }
      assert.deepEqual(ecritures, [], 'routes /api/v1 jouées en lecture, en (a) ou en (b) qui ont écrit, hors dernière utilisation (route : tables changées)');
      assert.deepEqual(usagesEnEcart, [], 'dernière utilisation des clés, route par route');
      assert.deepEqual(scopesEnEcart, [], 'scope exigé par la porte de chaque route /api/v1, relevé par le comportement');
    });

    // Cadrage §3, D1a-2 : « clé absente, révoquée, expirée, inactive » ; cles-api.ts : 401 sans clé (en-tête absent
    // ou qui ne commence pas par « Bearer iris_ »), et pour une clé inconnue, inactive, révoquée ou expirée. Une seule
    // cible par route : la porte précède le gestionnaire (vérifié par le test de couverture).
    test('états d’une clé : absente, sans le préfixe « iris_ », d’un autre schéma, inconnue, inactive, révoquée (par l’API, ou par sa seule date) ou expirée, chaque route /api/v1 répond 401, sans rien écrire', async () => {
      const cas = [];
      for (const cle of Object.keys(ROUTES_CLES)) {
        const [methode, chemin] = cle.split(' ');
        const definition = ROUTES_CLES[cle];
        for (const { cle: compte } of ETATS_CLE) cas.push({ compte, autorisation: cles[compte].autorisation, methode, chemin, definition, cible: cibleUnique(definition, chemin) });
      }
      const { nonRefuses, changees } = await jouerRefus(cas);
      assert.deepEqual(nonRefuses, [], 'états d’une clé admis par la porte /api/v1');
      assert.deepEqual(changees, [], 'un refus de la porte /api/v1 n’écrit rien, dernière utilisation comprise');
    });

    // Cadrage §3, D1a-2, N7 : « aucune session n'ouvre une route /api/v1 ». Le jeton de session d'un compte de chaque
    // type (le super administrateur par l'accès de secours) ne commence pas par « iris_ » : 401 sur chaque route.
    test('aucune session n’ouvre une route /api/v1 : le jeton de session d’un compte de chaque type reçoit 401 sur chaque route /api/v1, sans rien écrire', async () => {
      const cas = [];
      for (const cle of Object.keys(ROUTES_CLES)) {
        const [methode, chemin] = cle.split(' ');
        const definition = ROUTES_CLES[cle];
        for (const { cle: compte } of TYPES_DE_COMPTE) cas.push({ compte, autorisation: `Bearer ${comptes[compte].jeton}`, methode, chemin, definition, cible: cibleUnique(definition, chemin) });
      }
      const { nonRefuses, changees } = await jouerRefus(cas);
      assert.deepEqual(nonRefuses, [], 'sessions admises sur une route /api/v1');
      assert.deepEqual(changees, [], 'une session refusée sur /api/v1 n’écrit rien');
    });

    // Cadrage §3, D1a-2 : « aucune clé n'ouvre une route de session ». La clé qui porte les 13 scopes, sur chacune des
    // routes de session de la table de D1a-1 : requireAuth, en tête de chacune (test de couverture de D1a-1), refuse
    // tout jeton qui n'est pas un jeton de session signé.
    test('aucune clé n’ouvre une route de session : la clé qui porte les 13 scopes reçoit 401 sur chaque route de session, sans rien écrire', async () => {
      const routesSession = Object.keys(ROUTES_SESSION);
      assert.equal(routesSession.length, 191, 'routes de session de la table de D1a-1');
      const cas = routesSession.map((cle) => {
        const [methode, chemin] = cle.split(' ');
        const definition = ROUTES_SESSION[cle];
        return { compte: CLE_TOUS_SCOPES, autorisation: cles[CLE_TOUS_SCOPES].autorisation, methode, chemin, definition, cible: cibleUnique(definition, chemin) };
      });
      const { nonRefuses, changees } = await jouerRefus(cas);
      assert.deepEqual(nonRefuses, [], 'clé admise sur une route de session');
      assert.deepEqual(changees, [], 'une clé refusée sur une route de session n’écrit rien');
    });

    // Cadrage §3, D1a-2 : « appelAdmisParCle (#420) pour l'écriture différée de dernierUsageLe ». cles-api.ts : après
    // un appel admis, la dernière utilisation est écrite « sans attente ni échec bloquant ». Preuves :
    //  - sans attente : la ligne de la clé est verrouillée (SELECT … FOR UPDATE) dans une transaction du test ; un
    //    appel admis reçoit sa réponse pendant le verrou, sans dernière utilisation nouvelle ; elle est écrite dès le
    //    verrou levé. Une porte qui attendrait l'écriture ne répondrait pas tant que dure le verrou : passé le délai
    //    borné, le verrou est levé et le test échoue en le disant ;
    //  - un refus 403 (scope manquant, sur une clé jamais admise puis sur une clé déjà utilisée) et un refus 401 (clé
    //    inactive, révoquée, expirée) ne la notent pas ; un appel admis d'une autre clé, attendu, sert de barrière ;
    //  - en fin de fichier, chaque clé jamais admise par la porte n'a aucune dernière utilisation, et chaque clé
    //    admise en a une : une écriture tardive d'un refus des tests précédents s'y verrait.
    test('dernière utilisation : un appel admis la note sans que la réponse l’attende ; un refus 403 ou 401 ne la note pas ; les clés jamais admises n’en ont aucune', async () => {
      const lecture = cles[nomCleScope('clients:read')];
      const route = '/api/v1/clients';
      // Sans attente.
      const usageAvantVerrou = await usageDe(lecture.id);
      assert.notEqual(usageAvantVerrou, null, 'la clé clients:read a été admise par le test des portées');
      let envoi = 0;
      let reponse = null;
      let res = null;
      let usagePendantVerrou;
      await appli.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "ApiAccessKey" WHERE "id" = ${lecture.id} FOR UPDATE`;
        envoi = Date.now();
        reponse = appeler(appli.adresse, 'GET', route, { autorisation: lecture.autorisation });
        let minuterie;
        const delai = new Promise((ok) => { minuterie = setTimeout(() => ok(null), DELAI_USAGE_MS); });
        res = await Promise.race([reponse, delai]);
        clearTimeout(minuterie);
        // Relue hors de la transaction : l'écriture différée attend le verrou.
        if (res) usagePendantVerrou = await usageDe(lecture.id);
      }, { maxWait: 10_000, timeout: DELAI_USAGE_MS + 20_000 });
      admisesAuMoinsUneFois.add(lecture.id);
      if (!res) {
        await reponse;
        assert.fail(`GET ${route} (clé clients:read) : pas de réponse en ${DELAI_USAGE_MS / 1000} s tant que la ligne de la clé est verrouillée, la réponse attend l’écriture de la dernière utilisation`);
      }
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(usagePendantVerrou, usageAvantVerrou, 'la dernière utilisation n’est pas écrite tant que la ligne est verrouillée');
      assert.ok(await attendreUsage(lecture.id, envoi, `GET ${route} (clé clients:read), verrou levé`) > usageAvantVerrou);

      // Refus 403 et 401, puis barrière.
      const jamaisAdmise = cles[nomCleScope('finances:read')];
      const dejaUtilisee = cles[nomCleScope('company:read')];
      const usagesAvant = await usages();
      assert.equal(usagesAvant[jamaisAdmise.id], null, 'la clé finances:read n’a jamais été admise');
      assert.notEqual(usagesAvant[dejaUtilisee.id], null, 'la clé company:read a été admise sur GET /api/v1/company');
      const empreinteAvant = await empreinte();
      const empreinteSansUsageAvant = await empreinteSansUsage();
      for (const [nom, statut] of [[nomCleScope('finances:read'), 403], [nomCleScope('company:read'), 403], ['CLE-INACTIVE', 401], ['CLE-REVOQUEE', 401], ['CLE-REVOQUEE-ACTIVE', 401], ['CLE-EXPIREE', 401]]) {
        const res = await appeler(appli.adresse, 'GET', route, { autorisation: cles[nom].autorisation });
        assert.equal(res.status, statut, `${nom} sur GET ${route} : ${res.status} ${JSON.stringify(res.body)}`);
      }
      const envoiBarriere = Date.now();
      const barriere = await appeler(appli.adresse, 'GET', route, { autorisation: lecture.autorisation });
      assert.equal(barriere.status, 200, JSON.stringify(barriere.body));
      await attendreUsage(lecture.id, envoiBarriere, `GET ${route} (clé clients:read), barrière`);
      const usagesApres = await usages();
      for (const id of Object.keys(usagesAvant)) {
        if (id === lecture.id) assert.ok(usagesApres[id] > usagesAvant[id], 'la barrière, admise, note sa dernière utilisation');
        else assert.equal(usagesApres[id], usagesAvant[id], `un refus ne note aucune dernière utilisation (${Object.entries(cles).find(([, c]) => c.id === id)?.[0] ?? id})`);
      }
      assert.deepEqual(tablesChangees(empreinteAvant, await empreinte()), ['ApiAccessKey'], 'seule la dernière utilisation de la barrière est écrite');
      assert.deepEqual(tablesChangees(empreinteSansUsageAvant, await empreinteSansUsage()), [], 'rien d’autre n’est écrit');

      // Fin de fichier : clés jamais admises sans dernière utilisation, clés admises avec la leur.
      const finales = await usages();
      const jamais = Object.keys(finales).filter((id) => !admisesAuMoinsUneFois.has(id));
      assert.deepEqual(jamais.filter((id) => finales[id] !== null), [], 'clés jamais admises par la porte, avec une dernière utilisation');
      assert.deepEqual([...admisesAuMoinsUneFois].filter((id) => finales[id] === null), [], 'clés admises sans dernière utilisation');
      // Clés jamais admises : les scopes qui n'ouvrent aucune route /api/v1, la clé aux 13 scopes (jouée sur les
      // routes de session), les clés inactive, révoquées et expirée, et la clé du jeu de données (jamais jouée).
      const nomsJamais = Object.entries(cles).filter(([, c]) => c.id && jamais.includes(c.id)).map(([nom]) => nom).sort();
      assert.deepEqual(nomsJamais, [CLE_TOUS_SCOPES, 'CLE-EXPIREE', 'CLE-INACTIVE', 'CLE-REVOQUEE', 'CLE-REVOQUEE-ACTIVE', nomCleScope('chantiers:archive'), nomCleScope('chantiers:write'), nomCleScope('finances:read')].sort());
      assert.equal(jamais.length, nomsJamais.length + 1, 'plus la clé cle-active du jeu de données');
    });

    // Cadrage §2.1 et §3, D1a-2 : chaque route /api/v1 a ses lignes ; la matrice obtenue est la référence, au
    // caractère près (N8 : diff imprimé, matrice obtenue écrite hors du dépôt).
    test('la matrice obtenue est la référence matrice-droits/cles.txt, et chaque route /api/v1 et chaque route de session y ont leurs lignes', () => {
      const routesVues = new Set(lignes.map((ligne) => ligne.split(' | ')[1]));
      assert.deepEqual([...Object.keys(ROUTES_CLES), ...Object.keys(ROUTES_SESSION)].filter((cle) => !routesVues.has(cle)), [], 'routes sans ligne dans la matrice');
      const comptesVus = new Set(lignes.map((ligne) => ligne.split(' | ')[0]));
      const attendus = [...clesParScope.map((k) => k.nom), CLE_TOUS_SCOPES, ...ETATS_CLE.map((e) => e.cle), ...TYPES_DE_COMPTE.map((t) => t.cle)];
      assert.deepEqual(attendus.filter((compte) => !comptesVus.has(compte)), [], 'clés ou comptes sans ligne');
      const clesDeLigne = lignes.map((ligne) => ligne.split(' | ').slice(0, 4).join(' | '));
      assert.equal(new Set(clesDeLigne).size, clesDeLigne.length, 'chaque cas n’a qu’une ligne');
      comparerAvecReference(lignes, REFERENCE, 'cles.txt');
    });
  });
}
