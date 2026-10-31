// Correctif #387 : heures vendues et budgets du chantier validés à l'enregistrement (cadrage, version 2 du
// 31-10-2026, section « Tests (B5) »). Issue ouverte par la note N1 de l'audit n° 1 de #384
// (`auditeur-montants`). Il touche un montant : les heures vendues entrent dans la main-d'œuvre attendue de la
// marge estimée, les budgets dans la marge du jour ; l'ordre du pilote décidé par Nelson le 19-10-2026 l'admet
// (« un correctif ne passe avant un lot que s'il est bloquant ou s'il touche un montant »).
//
// Avant ce correctif, PATCH /api/chantiers/:id lisait les quatre champs par `parseFloat(...) || 0` : « -5 »
// donnait -5, « 18,75 » donnait 18, « abc » ou « » donnaient 0, « 18.755 » était arrondi à 18,76 par
// PostgreSQL, et un dépassement de la colonne finissait en erreur 500. Chaque champ passe désormais par la règle
// commune `nombreDecimalNonNegatif` (B1) : budgets à 10 chiffres avant la virgule (Decimal(12,2)), heures à 8
// (Decimal(10,2)), deux décimales au plus, virgule lue comme un point ; tout le reste est refusé (400), avec le
// message du champ (B2), sans rien écrire.
//
// Fichier propre au correctif, avec sa base jetable (consigne de Claude Code) : `node --test` exécute les
// fichiers de tests en parallèle, et api.test.mjs, qui tourne en même temps sur TEST_DATABASE_URL, purge les
// données « TEST » et change les réglages de la société, dont la rentabilité du conducteur, que ce fichier coupe
// lui aussi. TEST_DATABASE_URL ne sert donc ici que de connexion administrative : une base neuve est créée,
// migrée (`prisma migrate deploy`), servie à l'application montée en mémoire, puis supprimée. Sans
// TEST_DATABASE_URL, le fichier s'annonce ignoré : un SKIP n'est pas une réussite.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';

const TITRE = 'Correctif #387 : heures vendues et budgets du chantier validés à l’enregistrement';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Les quatre champs, dans l'ordre de `numericFields` (cadrage, « Place de la validation »), avec le plafond de
// leur colonne, ce plafond plus un centime, et leur message (cadrage, « Choix par défaut », B2 : apostrophe
// typographique, le champ nommé comme l'étiquette du formulaire « Modifier »).
const CHAMPS = [
  {
    champ: 'budgetGlobalVendu', plafond: '9999999999.99', depassement: '10000000000.00', tropDeZeros: '00000000001',
    message: 'Le budget global doit être un montant positif ou nul, d’au plus 10 chiffres avant la virgule et 2 après.',
  },
  {
    champ: 'budgetMaterielVendu', plafond: '9999999999.99', depassement: '10000000000.00', tropDeZeros: '00000000001',
    message: 'Le budget matériel doit être un montant positif ou nul, d’au plus 10 chiffres avant la virgule et 2 après.',
  },
  {
    champ: 'budgetMainOeuvreVendu', plafond: '9999999999.99', depassement: '10000000000.00', tropDeZeros: '00000000001',
    message: 'Le budget de main-d’œuvre doit être un montant positif ou nul, d’au plus 10 chiffres avant la virgule et 2 après.',
  },
  {
    champ: 'heuresVendues', plafond: '99999999.99', depassement: '100000000.00', tropDeZeros: '000000001',
    message: 'Les heures vendues doivent être un nombre positif ou nul, d’au plus 8 chiffres avant la virgule et 2 après.',
  },
];
const NOMS_CHAMPS = CHAMPS.map(({ champ }) => champ);
const MESSAGE = Object.fromEntries(CHAMPS.map(({ champ, message }) => [champ, message]));
const REFUS_RENTABILITE = 'Le montant vendu n’est modifiable que par qui suit la rentabilité de ce chantier.';

// Valeurs de départ de chaque chantier de test : distinctes entre elles et de toute valeur envoyée, si bien
// qu'une écriture, même partielle, se voit en base.
const DEPART = { budgetGlobalVendu: '1234.56', budgetMaterielVendu: '345.67', budgetMainOeuvreVendu: '456.78', heuresVendues: '12.34' };
// Valeur posée en base avant chaque forme admise : la relecture prouve que l'enregistrement a bien eu lieu, même
// quand deux formes successives donnent la même valeur (« 18.75 » puis « 18,75 »).
const SENTINELLE = '4321.09';

// Formes refusées (cadrage, « Tests », « Formes refusées »), communes aux quatre champs. Le commentaire de chacune
// dit la lecture qu'elle écarte, celle du code d'avant le correctif (`parseFloat(...) || 0`, puis arrondi de
// PostgreSQL) ou une autre lecture plausible de la règle.
const FORMES_REFUSEES = [
  ['« -5 »', '-5'], // avant : -5 enregistré ; écarte aussi une lecture en valeur absolue (5).
  ['-5 (nombre)', -5], // idem, en nombre JSON.
  ['« -0.01 »', '-0.01'], // avant : -0,01 enregistré ; écarte un contrôle « ≥ -1 centime » ou un arrondi à 0.
  ['« abc »', 'abc'], // avant : 0 enregistré (NaN || 0).
  ['« » (chaîne vide)', ''], // avant : 0 ; choix par défaut : la chaîne vide est refusée, au lieu de valoir 0.
  ['chaîne de blancs', '   '], // avant : 0 ; le `trim` ne la rend pas valide.
  ['null', null], // avant : 0 ; choix par défaut : `null` est refusé, au lieu de valoir 0.
  ['true', true], // avant : 0 ; écarte une lecture booléen = 1.
  ['[] (tableau vide)', []], // avant : 0.
  ['["5"] (tableau)', ['5']], // avant : 5 (`parseFloat` d'un tableau, constat du cadrage).
  ['{} (objet)', {}], // avant : 0.
  ['« 18.755 »', '18.755'], // avant : 18,76 (arrondi de PostgreSQL) ; écarte aussi une troncature à 18,75.
  ['18.755 (nombre)', 18.755], // idem, en nombre JSON, jugé sur son écriture décimale.
  ['« 0.005 » (demi-centime)', '0.005'], // avant : 0,01 (arrondi au demi supérieur, constat) ; écarte aussi 0 (arrondi au pair).
  ['« 1e3 »', '1e3'], // avant : 1 000 (`parseFloat` lit la notation scientifique) ; notation refusée.
  ['1e21 (nombre)', 1e21], // écrit « 1e+21 » : notation scientifique ; avant : erreur 500 (dépassement).
  ['1e-7 (nombre)', 1e-7], // écrit « 1e-7 » (cadrage, « Formes admises ») ; avant : 0 (arrondi de PostgreSQL au centime).
  ['« .5 »', '.5'], // avant : 0,5 ; au moins un chiffre avant la virgule.
  ['« 5. »', '5.'], // avant : 5 ; au moins une décimale après le séparateur.
  ['« 1 000 »', '1 000'], // avant : 1 (lecture arrêtée à l'espace) ; écarte aussi une lecture en milliers (1 000).
  ['« +5 »', '+5'], // avant : 5 ; aucun signe, même positif.
];

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const source = new URL(TEST_DATABASE_URL);
    const nomBase = `iris_test_saisie387_${randomBytes(6).toString('hex')}`;
    const maintenance = new URL(source);
    maintenance.pathname = '/postgres';
    const cible = new URL(source);
    cible.pathname = `/${nomBase}`;
    const administrationPg = new pg.Client({ connectionString: maintenance.toString() });
    let baseCreee = false;

    let request; let app; let prisma; let appPrisma; let jwt;
    let session = '';
    const entete = (jeton) => ({ Authorization: `Bearer ${jeton}` });
    const admin = () => entete(session);
    const jetonDe = (compte) => jwt.sign({ id: compte.id }, process.env.JWT_SECRET);
    let rang = 0;
    const suffixe = () => `${Date.now()}${(rang += 1)}`;

    const creerCompte = async (role, cle) => {
      const s = suffixe();
      const compte = await prisma.user.create({ data: { email: `saisie387.${cle}.${s}@iris.test`, name: `TEST ${cle} ${s}`, role } });
      return { ...compte, auth: entete(jetonDe(compte)) };
    };
    // Un chantier aux valeurs de départ, chargé du compte donné (titulaire), créé directement en base : le
    // correctif ne porte que sur sa modification.
    const creerChantier = async (responsableId, extra = {}) => prisma.chantier.create({ data: {
      nom: `TEST Saisie 387 ${suffixe()}`, client: 'TEST Client saisie 387', dateDebut: new Date('2026-10-01T00:00:00Z'),
      ...DEPART, responsableId, ...extra,
    } });
    const modifier = (chantierId, corps, auth = admin()) => request(app).patch(`/api/chantiers/${chantierId}`).set(auth).send(corps);
    // Ligne du chantier telle qu'en base, montants en écriture exacte du Decimal (`toString()`), avec le nombre
    // d'entrées de son journal des changements : un refus ne doit rien y changer, pas même `updatedAt`.
    const etat = async (chantierId) => {
      const c = await prisma.chantier.findUniqueOrThrow({ where: { id: chantierId } });
      return {
        nom: c.nom, numeroDevis: c.numeroDevis, clientId: c.clientId, responsableId: c.responsableId, statut: c.statut,
        dateDebut: c.dateDebut.toISOString(), dateFin: c.dateFin?.toISOString() ?? null,
        ...Object.fromEntries(NOMS_CHAMPS.map((champ) => [champ, c[champ].toString()])),
        updatedAt: c.updatedAt.toISOString(),
        journal: await prisma.journalSaisieChantier.count({ where: { chantierId } }),
      };
    };
    const enBase = async (chantierId, champ) => (await prisma.chantier.findUniqueOrThrow({ where: { id: chantierId } }))[champ].toString();
    const reglerRentabiliteConducteur = async (valeur) => {
      const res = await request(app).put('/api/parametres').set(admin()).send({ rentabiliteConducteur: valeur });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.rentabiliteConducteur, valeur);
    };
    // Un refus : statut et message attendus, et la ligne (montants, autres champs, `updatedAt`, journal) inchangée.
    const refuse = async (chantierId, corps, statut, message, auth = admin(), quoi = JSON.stringify(corps)) => {
      const avant = await etat(chantierId);
      const res = await modifier(chantierId, corps, auth);
      assert.equal(res.status, statut, `${quoi} : ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, message, quoi);
      assert.deepEqual(await etat(chantierId), avant, `${quoi} : rien ne doit être écrit`);
    };

    before(async () => {
      assert.ok(['127.0.0.1', 'localhost'].includes(source.hostname), 'seul un PostgreSQL local est autorisé');
      await administrationPg.connect();
      await administrationPg.query(`CREATE DATABASE "${nomBase}"`);
      baseCreee = true;
      const dossierServeur = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      execFileSync(resolve(dossierServeur, 'node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', resolve(dossierServeur, 'prisma/schema.prisma')], {
        env: { ...process.env, DATABASE_URL: cible.toString() }, encoding: 'utf8', stdio: 'pipe', timeout: 180_000,
      });
      process.env.DATABASE_URL = cible.toString();
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'secret-de-test-uniquement';
      process.env.BREAK_GLASS_EMAIL = 'secours@iris.test';
      process.env.BREAK_GLASS_TOKEN = 'jeton-de-secours-de-test-au-moins-32-caracteres';
      process.env.SUPERADMIN_EMAILS = 'secours@iris.test';
      request = (await import('supertest')).default;
      const serveur = await import('../dist/index.js');
      app = serveur.app;
      appPrisma = serveur.prisma;
      const { PrismaClient } = await import('@prisma/client');
      prisma = new PrismaClient({ datasources: { db: { url: cible.toString() } } });
      jwt = (await import('jsonwebtoken')).default;
      await serveur.initDb();
      await serveur.ensureSuperAdmins();
      const connexion = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      assert.equal(connexion.status, 200, JSON.stringify(connexion.body));
      session = connexion.body.token;
      // L'administration suit toujours la rentabilité : chacun des quatre champs se teste par elle (cadrage).
      const secours = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' }, select: { role: true } });
      assert.ok(['ADMIN', 'SUPERADMIN'].includes(secours.role), secours.role);
    });

    after(async () => {
      await prisma?.$disconnect().catch(() => {});
      await appPrisma?.$disconnect().catch(() => {});
      if (baseCreee) await administrationPg.query(`DROP DATABASE IF EXISTS "${nomBase}" WITH (FORCE)`);
      await administrationPg.end().catch(() => {});
    });

    // Cadrage, « Formes admises » : « 18.75 », « 18,75 », « 18.75 » entouré de blancs, 18.75 ; « 0 » et 0 ; relus
    // exactement en base (`toString()` du Decimal) et dans la réponse. Choix par défaut : la virgule est admise.
    // 18,75 écarte : la troncature du code d'avant (« 18,75 » donnait 18), une virgule lue comme séparateur de
    // milliers (1 875), un arrondi à l'unité (19) ou au dixième (18,8). « 0 » écarte un refus du zéro
    // (`zeroAutorise` à false) : la valeur d'avant, non nulle, doit devenir 0.
    test('formes admises : chacun des quatre champs enregistre exactement « 18.75 », « 18,75 », « 18.75 » entouré de blancs et 18.75, puis « 0 » et 0, sans toucher aux trois autres', async () => {
      const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur-admises');
      const chantier = await creerChantier(conducteur.id);
      for (const { champ } of CHAMPS) {
        for (const [quoi, valeur, attendu] of [
          ['« 18.75 »', '18.75', '18.75'],
          ['« 18,75 »', '18,75', '18.75'],
          ['« 18.75 » entouré de blancs', ' \t18.75  ', '18.75'],
          ['18.75 (nombre)', 18.75, '18.75'],
          ['« 0 »', '0', '0'],
          ['0 (nombre)', 0, '0'],
        ]) {
          await prisma.chantier.update({ where: { id: chantier.id }, data: { [champ]: SENTINELLE } });
          const avant = await etat(chantier.id);
          const res = await modifier(chantier.id, { [champ]: valeur });
          assert.equal(res.status, 200, `${champ} ${quoi} : ${JSON.stringify(res.body)}`);
          assert.equal(String(res.body[champ]), attendu, `${champ} ${quoi} : réponse`);
          const apres = await etat(chantier.id);
          assert.equal(apres[champ], attendu, `${champ} ${quoi} : en base`);
          // Les trois autres champs, le reste de la fiche et le journal ne bougent pas.
          for (const autre of NOMS_CHAMPS.filter((nom) => nom !== champ)) assert.equal(apres[autre], avant[autre], `${champ} ${quoi} : ${autre}`);
          assert.deepEqual([apres.nom, apres.responsableId, apres.journal], [avant.nom, avant.responsableId, avant.journal]);
        }
        await prisma.chantier.update({ where: { id: chantier.id }, data: { [champ]: DEPART[champ] } });
      }
    });

    // Cadrage, « Formes admises » : le plafond de la colonne, en chaîne et en nombre : « 9999999999.99 » pour les
    // budgets (Decimal(12,2), PLAFOND_MONTANT), « 99999999.99 » pour les heures (Decimal(10,2),
    // PLAFOND_HEURES_PREVUES) ; « Les budgets admettent [« 100000000.00 »] ». Écarte : un plafond des budgets aligné
    // sur celui des heures (8 chiffres, qui refuserait 9 999 999 999,99 et 100 000 000,00), un plafond arrondi
    // (9 999 999 999 ou 10 000 000 000), et une écriture par un flottant qui perdrait le dernier centime
    // (9 999 999 999,99 a 12 chiffres significatifs, écrits exactement).
    test('plafond de la colonne admis, en chaîne et en nombre : 9 999 999 999,99 pour un budget, 99 999 999,99 pour les heures ; un budget admet aussi 100 000 000,00', async () => {
      const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur-plafond');
      const chantier = await creerChantier(conducteur.id);
      for (const { champ, plafond } of CHAMPS) {
        const essais = [['chaîne', plafond], ['nombre', Number(plafond)]];
        if (champ !== 'heuresVendues') essais.push(['« 100000000.00 »', '100000000.00']);
        for (const [quoi, valeur] of essais) {
          await prisma.chantier.update({ where: { id: chantier.id }, data: { [champ]: SENTINELLE } });
          const res = await modifier(chantier.id, { [champ]: valeur });
          assert.equal(res.status, 200, `${champ} ${quoi} : ${JSON.stringify(res.body)}`);
          const attendu = quoi === '« 100000000.00 »' ? '100000000' : plafond;
          assert.equal(String(res.body[champ]), attendu, `${champ} ${quoi} : réponse`);
          assert.equal(await enBase(chantier.id, champ), attendu, `${champ} ${quoi} : en base`);
        }
        await prisma.chantier.update({ where: { id: chantier.id }, data: { [champ]: DEPART[champ] } });
      }
    });

    // Cadrage, « Formes refusées » : 400, avec le message du champ (B2), et la ligne inchangée en base (« Un refus
    // n'écrit rien : ni le chantier, ni le journal des changements »). Chaque valeur, et la lecture qu'elle écarte,
    // est commentée dans FORMES_REFUSEES. Le message exact écarte un message commun aux quatre champs, ou celui
    // d'un autre champ.
    test('formes refusées : signe, texte, vide, null, booléen, tableau, objet, trois décimales, notation scientifique, « .5 », « 5. », « 1 000 », « +5 » : 400 avec le message du champ, sans rien écrire', async () => {
      const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur-refus');
      const chantier = await creerChantier(conducteur.id);
      for (const { champ, message } of CHAMPS) {
        for (const [quoi, valeur] of FORMES_REFUSEES) {
          await refuse(chantier.id, { [champ]: valeur }, 400, message, admin(), `${champ} ${quoi}`);
        }
      }
      // Rien n'a bougé depuis la création.
      const final = await etat(chantier.id);
      assert.deepEqual(NOMS_CHAMPS.map((champ) => final[champ]), NOMS_CHAMPS.map((champ) => DEPART[champ]));
      assert.equal(final.journal, 0);
    });

    // Cadrage, « Formes refusées » : « le plafond plus 0,01 : « 10000000000.00 » pour les budgets, « 100000000.00 »
    // pour les heures » ; « Refus » : « plus de chiffres que la colonne, zéros de tête compris ». Avant le
    // correctif, un dépassement donnait une erreur 500 (« Error updating chantier ») : le 400 et son message
    // l'écartent. Les zéros de tête écartent une lecture qui compterait les chiffres de la valeur (1) et non ceux
    // de la saisie (11 pour un budget, 9 pour les heures).
    test('plafond plus un centime refusé : « 10000000000.00 » pour un budget, « 100000000.00 » pour les heures, et trop de chiffres, zéros de tête compris : 400 avec le message du champ, sans rien écrire', async () => {
      const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur-depassement');
      const chantier = await creerChantier(conducteur.id);
      for (const { champ, message, depassement, tropDeZeros } of CHAMPS) {
        for (const [quoi, valeur] of [
          ['plafond plus un centime, en chaîne', depassement],
          ['plafond plus un centime, en nombre', Number(depassement)],
          ['zéros de tête au-delà de la colonne', tropDeZeros],
        ]) await refuse(chantier.id, { [champ]: valeur }, 400, message, admin(), `${champ} ${quoi} (${valeur})`);
      }
      assert.equal((await etat(chantier.id)).journal, 0);
    });

    // Cadrage, « Requête mêlée » : « Une requête qui mêle un nom valide, un changement de titulaire et une valeur
    // invalide n'écrit rien : ni le chantier, ni le journal des changements. » Témoin : la même requête avec une
    // valeur valide écrit le nom, le titulaire et la valeur, et journalise le changement de titulaire (#181) ; sans
    // lui, un refus qui n'écrirait rien pour une autre raison passerait.
    test('requête mêlée : un nom valide, un changement de titulaire et une valeur invalide n’écrivent rien, ni le chantier ni le journal ; avec une valeur valide, les trois sont écrits et le titulaire journalisé', async () => {
      const titulaire = await creerCompte('CONDUCTEUR_TRAVAUX', 'titulaire-melee');
      const repreneur = await creerCompte('CONDUCTEUR_TRAVAUX', 'repreneur-melee');
      for (const { champ, message } of CHAMPS) {
        const chantier = await creerChantier(titulaire.id);
        const nom = `TEST Renommé 387 ${suffixe()}`;
        await refuse(chantier.id, { nom, responsableId: repreneur.id, [champ]: '-5' }, 400, message, admin(), `${champ} : requête mêlée`);
        const final = await etat(chantier.id);
        assert.notEqual(final.nom, nom);
        assert.equal(final.responsableId, titulaire.id);
        assert.equal(await prisma.journalSaisieChantier.count({ where: { chantierId: chantier.id, action: 'CHANGEMENT_TITULAIRE' } }), 0);

        const valide = await modifier(chantier.id, { nom, responsableId: repreneur.id, [champ]: '18,75' });
        assert.equal(valide.status, 200, JSON.stringify(valide.body));
        const ecrit = await etat(chantier.id);
        assert.deepEqual([ecrit.nom, ecrit.responsableId, ecrit[champ]], [nom, repreneur.id, '18.75'], champ);
        const journal = await prisma.journalSaisieChantier.findMany({ where: { chantierId: chantier.id } });
        assert.deepEqual(journal.map((entree) => [entree.action, entree.avant.responsableId, entree.apres.responsableId]), [['CHANGEMENT_TITULAIRE', titulaire.id, repreneur.id]]);
      }
    });

    // Cadrage, « Place de la validation (N2) » : « Si plusieurs champs sont invalides, le message est celui du
    // premier dans l'ordre de numericFields : budget global, matériel, main-d'œuvre, heures » ; « Elle vient avant
    // le contrôle des dates ». Un champ valide envoyé avec un champ invalide n'est pas écrit non plus. Écarte : une
    // validation qui s'arrêterait au dernier champ invalide, qui écrirait les champs valides, ou qui viendrait
    // après les dates (le message serait celui de la date).
    test('plusieurs champs invalides : le message est celui du premier dans l’ordre budget global, matériel, main-d’œuvre, heures ; un champ valide n’est pas écrit avec eux, et la validation passe avant les dates', async () => {
      const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur-ordre-champs');
      const chantier = await creerChantier(conducteur.id);
      // Les champs invalides à partir du rang i, ceux d'avant étant valides (« 18,75 ») : le message est celui du
      // rang i, et aucun des champs valides n'est écrit. Corps écrits dans l'ordre inverse, pour que l'ordre des
      // clés JSON ne décide pas du message.
      for (let i = 0; i < CHAMPS.length; i += 1) {
        const corps = {};
        for (let j = CHAMPS.length - 1; j >= 0; j -= 1) corps[CHAMPS[j].champ] = j >= i ? 'abc' : '18,75';
        await refuse(chantier.id, corps, 400, CHAMPS[i].message, admin(), `invalides à partir de ${CHAMPS[i].champ}`);
      }
      // Seul le dernier champ invalide, les trois premiers valides : rien n'est écrit, pas même les valides.
      await refuse(chantier.id, { budgetGlobalVendu: '18,75', budgetMaterielVendu: '18,75', budgetMainOeuvreVendu: '18,75', heuresVendues: '18.755' }, 400, MESSAGE.heuresVendues);
      // Avant les dates : une date invalide et une valeur invalide donnent le message de la valeur.
      await refuse(chantier.id, { dateDebut: '31-02-2026', heuresVendues: '-5' }, 400, MESSAGE.heuresVendues);
      await refuse(chantier.id, { dateFin: 'demain', budgetMaterielVendu: '1 000' }, 400, MESSAGE.budgetMaterielVendu);
      // Témoin : la date invalide seule, ou avec une valeur valide, est bien refusée par son propre contrôle.
      await refuse(chantier.id, { dateDebut: '31-02-2026', heuresVendues: '18,75' }, 400, 'La date de début doit être valide au format JJ-MM-AAAA.');
    });

    // Cadrage, « Ordre des contrôles » : « Un conducteur titulaire sans rentabilité (`rentabiliteConducteur` coupé)
    // qui envoie un budget global invalide (« abc ») garde son 403 et son message. La base reste inchangée. »
    // (« Inchangé » : le 403 du montant vendu reste rendu avant la validation.) Le conducteur reste soumis à la
    // validation sur ce qu'il peut modifier (heures, budgets par poste), et, destinataire de la rentabilité, sur le
    // budget global. Écarte une validation placée avant le 403, ou réservée à l'administration.
    test('ordre des contrôles : un conducteur titulaire sans rentabilité qui envoie un budget global « abc » garde son 403 et son message, sans rien écrire ; ses heures et ses budgets par poste restent validés', async () => {
      const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur-sans-rentabilite');
      const chantier = await creerChantier(conducteur.id);
      await reglerRentabiliteConducteur(false);
      try {
        await refuse(chantier.id, { budgetGlobalVendu: 'abc' }, 403, REFUS_RENTABILITE, conducteur.auth, 'budget global « abc », sans rentabilité');
        // Le 403 passe aussi avant le message d'un autre champ invalide.
        await refuse(chantier.id, { budgetGlobalVendu: 'abc', heuresVendues: '-5' }, 403, REFUS_RENTABILITE, conducteur.auth, 'budget global et heures invalides, sans rentabilité');
        // Les heures et les budgets par poste, qu'il peut modifier, sont validés pour lui aussi.
        for (const champ of ['budgetMaterielVendu', 'budgetMainOeuvreVendu', 'heuresVendues']) {
          await refuse(chantier.id, { [champ]: 'abc' }, 400, MESSAGE[champ], conducteur.auth, `${champ} « abc », conducteur`);
          const res = await modifier(chantier.id, { [champ]: '18,75' }, conducteur.auth);
          assert.equal(res.status, 200, `${champ} : ${JSON.stringify(res.body)}`);
          assert.equal(await enBase(chantier.id, champ), '18.75', champ);
        }
        assert.equal(await enBase(chantier.id, 'budgetGlobalVendu'), DEPART.budgetGlobalVendu);
      } finally {
        await reglerRentabiliteConducteur(true);
      }
      // Destinataire de la rentabilité, il passe le 403 et tombe sur la validation ; une forme admise s'enregistre.
      await refuse(chantier.id, { budgetGlobalVendu: 'abc' }, 400, MESSAGE.budgetGlobalVendu, conducteur.auth, 'budget global « abc », avec rentabilité');
      const res = await modifier(chantier.id, { budgetGlobalVendu: '18,75' }, conducteur.auth);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(await enBase(chantier.id, 'budgetGlobalVendu'), '18.75');
    });

    // Cadrage, « Place de la validation (N2) » : elle vient « après les refus existants : 404, 403 du technicien,
    // 409 de l'affaire annulée, client, référence, titulaire ». Chacun garde son statut et son message devant une
    // valeur invalide, sans rien écrire. Écarte une validation déplacée en tête de la route.
    test('ordre des contrôles existants : chantier hors périmètre (404), technicien (403), affaire annulée (409), client introuvable, référence et titulaire passent avant la validation, sans rien écrire', async () => {
      const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur-ordre');
      const autreConducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'autre-conducteur-ordre');
      const technicien = await creerCompte('TECHNICIEN', 'technicien-ordre');
      const chantier = await creerChantier(conducteur.id);
      const chantierTechnicien = await creerChantier(technicien.id);
      const annule = await creerChantier(conducteur.id, { statut: 'ANNULE' });
      const invalide = { heuresVendues: 'abc', budgetMaterielVendu: '-5' };

      await refuse(chantier.id, invalide, 404, 'Chantier introuvable', autreConducteur.auth, 'conducteur hors périmètre');
      await refuse(chantierTechnicien.id, invalide, 403, 'Un compte technicien n’est pas autorisé à modifier une affaire. Adressez-vous à votre responsable.', technicien.auth, 'technicien titulaire');
      await refuse(annule.id, invalide, 409, 'Cette affaire est annulée : elle n’est plus modifiable.', admin(), 'affaire annulée');
      await refuse(chantier.id, { ...invalide, clientId: randomUUID() }, 404, 'Client introuvable.', admin(), 'client introuvable');
      await refuse(chantier.id, { ...invalide, numeroDevis: 'XYZ' }, 400, 'La référence d’affaire doit être au format AAA-NNNN : un A, l’année sur deux chiffres, un tiret et le rang (exemple : A26-0001).', admin(), 'référence hors format');
      await refuse(chantier.id, { ...invalide, responsableId: '' }, 400, 'Un chantier doit toujours avoir un conducteur responsable.', admin(), 'titulaire vidé');
      // Témoin : sans ces refus, la même saisie tombe sur la validation, au message du premier champ invalide
      // dans l'ordre de numericFields (matériel avant heures).
      await refuse(chantier.id, invalide, 400, MESSAGE.budgetMaterielVendu, admin(), 'validation seule');
    });
  });
}
