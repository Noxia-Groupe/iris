// Correctif #285 et chantier terminé : affaire annulée non encaissable, chantier terminé réservé à l'administration
// (cadrage, version 3 du 02-11-2026, section « Critères observables et tests »).
//
// Décisions appliquées, mot pour mot :
//  - #285, réponse de Nelson du 02-11-2026 : « #285 bien sur que non, une affaire annulé ne peut etre encaissé »
//    (commentaire 6566197980 de #285), puis, à la question fermée, « Corriger maintenant » : refuser l'encaissement
//    d'une affaire annulée et l'annulation d'un chantier déjà encaissé (commentaire 6570975085 de #285) ;
//  - chantier terminé, réponse de Nelson du 02-11-2026 à la question fermée « une fois un chantier terminé, son
//    titulaire (…) doit-il encore pouvoir modifier sa fiche (nom, budgets, heures vendues, dates, titulaire) et changer
//    son commercial ? » : « A. Non, admin seule » (commentaire 6570976812 de #440).
// Choix par défaut du correctif, à confirmer (cadrage, points 2 bis et 3) : le commercial d'une affaire annulée ne change
// plus (409) ; la fiche n'admet plus, de l'administration, d'autre statut que EN_COURS ou TERMINE (400) ; le statut d'une
// affaire annulée pendant l'attente de sa clôture ne change plus (409).
//
// Ces règles touchent un montant (cadrage, « Ordre ») : le CA et la marge validés d'un commercial exigent un chantier
// terminé et encaissé (commissions/metier.ts) ; la fiche (dates, barème réduit, budgets) et le commercial d'un chantier
// terminé les déplacent. Chaque refus est donc prouvé sans aucune écriture : empreinte de toute la base (chaque table du
// schéma public, contenu compris) et journal des saisies du chantier (JournalSaisieChantier) relus après l'appel.
//
// Fichier propre au correctif, avec sa base jetable : `node --test` exécute les fichiers en parallèle, et api.test.mjs,
// qui tourne en même temps sur TEST_DATABASE_URL, purge les données « TEST ». TEST_DATABASE_URL ne sert ici que de
// connexion administrative : une base neuve est créée, migrée (`prisma migrate deploy`), servie à l'application montée
// en mémoire, puis supprimée. Sans TEST_DATABASE_URL, le fichier s'annonce ignoré : un SKIP n'est pas une réussite.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';

const TITRE = 'Correctif #285 : affaire annulée non encaissable, chantier terminé réservé à l’administration';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Refus du cadrage, mot pour mot (apostrophe typographique), et refus existants qu'il range avant eux.
const REFUS = {
  encaissementAnnulee: 'Cette affaire est annulée : elle ne peut pas être encaissée.',
  annulationEncaisse: 'Annulation impossible : ce chantier est déjà encaissé. Une affaire encaissée ne s’annule pas.',
  ficheAnnulee: 'Cette affaire est annulée : elle n’est plus modifiable.',
  commercialAnnulee: 'Cette affaire est annulée : son commercial ne change plus.',
  statutAnnulee: 'Cette affaire est annulée : son statut ne change plus.',
  ficheCloture: 'Ce chantier est clôturé : seul un administrateur peut encore le modifier.',
  commercialCloture: 'Ce chantier est clôturé : seul un administrateur peut encore en changer le commercial.',
  statutInvalide: 'Statut invalide.',
  introuvable: 'Chantier introuvable',
  technicienFiche: 'Un compte technicien n’est pas autorisé à modifier une affaire. Adressez-vous à votre responsable.',
  technicienCommercial: 'Un compte technicien n’est pas autorisé à réattribuer le commercial d’une affaire. Adressez-vous à votre responsable.',
  administration: 'Accès réservé aux administrateurs',
  compteCommercial: 'Accès non autorisé pour un compte commercial.',
  compteDirecteur: 'Accès non autorisé pour un compte directeur.',
  commercialVide: 'Un chantier doit toujours avoir un commercial rattaché.',
  commercialIntrouvable: 'Commercial introuvable.',
  heuresInvalides: 'Les heures vendues doivent être un nombre positif ou nul, d’au plus 8 chiffres avant la virgule et 2 après.',
};
// Cadrage, point 5 : « Le refus vaut pour tout titulaire hors administration : conducteur (CT), responsable (RESP),
// directeur commercial, assistante commerciale et comptable titulaires (DC, AC, CPT). »
const TITULAIRES_HORS_ADMINISTRATION = [
  ['CT', 'CONDUCTEUR_TRAVAUX'], ['RESP', 'RESPONSABLE'], ['DC', 'DIRECTEUR_COMMERCIAL'], ['AC', 'ASSISTANTE_COMMERCIALE'], ['CPT', 'COMPTABLE'],
];

// Valeurs de départ d'un chantier de test, distinctes de toute valeur envoyée : une écriture, même partielle, se voit.
const DEPART = {
  budgetGlobalVendu: '1234.56', budgetMaterielVendu: '345.67', budgetMainOeuvreVendu: '456.78', heuresVendues: '12.34',
  dateDebut: new Date('2026-09-01T00:00:00.000Z'), adresse: 'TEST 1 rue de départ', types: ['Alarme'],
};
const DATE_FIN = new Date('2026-10-15T00:00:00.000Z');

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const source = new URL(TEST_DATABASE_URL);
    // « test » comme mot (règle de client/scripts/base-jetable.mjs) et un suffixe tiré au hasard.
    const nomBase = `iris_test_c285_${randomBytes(6).toString('hex')}`;
    const maintenance = new URL(source);
    maintenance.pathname = '/postgres';
    const cible = new URL(source);
    cible.pathname = `/${nomBase}`;
    const administrationPg = new pg.Client({ connectionString: maintenance.toString() });
    let baseCreee = false;

    let request; let app; let prisma; let appPrisma; let jwt;
    let session = '';
    let secours = { id: '', name: '' };
    const entete = (jeton) => ({ Authorization: `Bearer ${jeton}` });
    const admin = () => entete(session);
    let rang = 0;
    const suffixe = () => `${Date.now()}${(rang += 1)}`;
    const comptes = {};

    const creerCompte = async (role, cle, extra = {}) => {
      const s = suffixe();
      const compte = await prisma.user.create({ data: { email: `c285.${cle.toLowerCase()}.${s}@iris.test`, name: `TEST ${cle} ${s}`, role, ...extra } });
      return { ...compte, auth: entete(jwt.sign({ id: compte.id }, process.env.JWT_SECRET)) };
    };
    // Les trois comptes de l'administration de la matrice : super administrateur (secours), administrateur, et
    // administrateur commercial (estCommercial).
    const ADMINISTRATION = () => [['SA', admin()], ['AD', comptes.AD.auth], ['AD-COM', comptes['AD-COM'].auth]];

    // --- Appels ---
    const appeler = (methode, chemin, corps, auth = admin()) => request(app)[methode](`/api${chemin}`).set(auth).send(corps ?? {});
    const ok = async (reponse, statut = 200) => {
      const res = await reponse;
      assert.equal(res.status, statut, `${res.req?.method} ${res.req?.path} : ${JSON.stringify(res.body)}`);
      return res.body;
    };
    const modifierFiche = (id, corps, auth = admin()) => appeler('patch', `/chantiers/${id}`, corps, auth);
    const changerCommercial = (id, corps, auth = admin()) => appeler('patch', `/chantiers/${id}/commercial`, corps, auth);
    const encaisser = (id, corps, auth = admin()) => appeler('patch', `/chantiers/${id}/encaisse`, corps, auth);
    const changerStatut = (id, corps, auth = admin()) => appeler('patch', `/chantiers/${id}/statut`, corps, auth);
    const annulerDevis = (devisId, auth = admin()) => appeler('post', `/devis/${devisId}/annulation`, { motif: 'TEST annulation du correctif 285' }, auth);

    // --- État de la base ---
    // Empreinte de toute la base : chaque table du schéma public (hors historique des migrations), nombre de lignes et
    // empreinte de leur contenu. Un refus ne doit rien y changer, pas même un `updatedAt` ou une entrée de journal.
    // Une seule requête pour toutes les tables (relevées une fois : le schéma ne change pas pendant les tests).
    const sqlEmpreinte = (table) => `SELECT '${table}' AS t, count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${table}" x`;
    const empreinteTable = async (client, table) => {
      const [{ n, h }] = await client.$queryRawUnsafe(sqlEmpreinte(table));
      return `${n}:${h}`;
    };
    let requeteEmpreinte = null;
    const empreinte = async (client = prisma) => {
      if (!requeteEmpreinte) {
        const tables = (await client.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`).map((t) => t.tablename);
        assert.ok(tables.includes('Chantier') && tables.includes('JournalSaisieChantier') && tables.length > 40, `tables relevées : ${tables.join(', ')}`);
        assert.ok(tables.every((table) => /^[A-Za-z_]+$/.test(table)), 'noms de tables sans guillemet');
        requeteEmpreinte = tables.map(sqlEmpreinte).join(' UNION ALL ');
      }
      return Object.fromEntries((await client.$queryRawUnsafe(requeteEmpreinte)).map(({ t, n, h }) => [t, `${n}:${h}`]));
    };
    const tablesChangees = (avant, apres) => Object.keys({ ...avant, ...apres }).filter((t) => avant[t] !== apres[t]);
    const journal = (chantierId) => prisma.journalSaisieChantier.findMany({ where: { chantierId }, orderBy: { createdAt: 'asc' } });
    const ligne = (id) => prisma.chantier.findUniqueOrThrow({ where: { id } });
    // Un refus : statut et message attendus, empreinte de toute la base et journal du chantier inchangés. Sans message
    // (`undefined`), un appel admis qui ne doit rien écrire (enregistrement à l'identique).
    const refuse = async (appel, statut, message, quoi, chantierId) => {
      const avant = await empreinte();
      const journalAvant = chantierId ? (await journal(chantierId)).length : 0;
      const res = await appel();
      assert.equal(res.status, statut, `${quoi} : ${res.status} ${JSON.stringify(res.body)}`);
      if (message !== undefined) assert.equal(res.body.error, message, quoi);
      const apres = await empreinte();
      assert.deepEqual(tablesChangees(avant, apres), [], `${quoi} : rien ne doit être écrit`);
      if (chantierId) assert.equal((await journal(chantierId)).length, journalAvant, `${quoi} : aucune entrée de journal`);
      return res;
    };

    // --- Données ---
    // Chantier posé en base, aux valeurs de départ, titulaire et commercial donnés : la plupart des règles portent sur
    // sa modification, et non sur son ouverture.
    const creerChantier = (extra = {}) => prisma.chantier.create({ data: {
      nom: `TEST Chantier 285 ${suffixe()}`, client: 'TEST Client 285', ...DEPART,
      responsableId: comptes.CT.id, commercialId: comptes.COM.id, ...extra,
    } });
    const ANNULATION = () => ({ statut: 'ANNULE', annuleLe: new Date('2026-10-20T08:00:00.000Z'), annuleParId: secours.id, motifAnnulation: 'TEST annulation posée en base' });
    const TERMINAISON = { statut: 'TERMINE', dateFin: DATE_FIN };
    const creerAnnule = (extra = {}) => creerChantier({ ...ANNULATION(), ...extra });
    const creerTermine = (extra = {}) => creerChantier({ ...TERMINAISON, ...extra });

    // Client identifié (un devis ne se signe que pour lui) : SIREN tiré au hasard, site de facturation.
    const creerClient = async (libelle) => {
      let client;
      for (let essai = 1; ; essai += 1) {
        const res = await appeler('post', '/clients', { raisonSociale: `TEST Client 285 ${libelle} ${suffixe()}`, siren: String(randomInt(100_000_000, 1_000_000_000)) });
        if (res.status === 409 && essai < 5) continue;
        assert.equal(res.status, 201, JSON.stringify(res.body));
        client = res.body;
        break;
      }
      await ok(appeler('post', `/clients/${client.id}/sites`, { nom: 'TEST Facturation 285', adresse: '8 rue du Correctif', codePostal: '14000', ville: 'Caen', estSiteFacturation: true }), 201);
      return client;
    };
    // Chantier ouvert par la conversion d'un devis signé (seule porte d'ouverture d'une affaire), titulaire CT et
    // commercial COM ; `seconde` : 'CONTRAT' ou 'INTERVENTION', seconde conversion du même devis (une affaire se
    // convertit au plus deux fois), pour prouver que l'annulation refusée n'écrit ni le contrat ni l'intervention.
    const chantierConverti = async (libelle, { seconde = null } = {}) => {
      const client = await creerClient(libelle);
      const devis = await ok(appeler('post', '/devis', { clientId: client.id, objet: `TEST Devis 285 ${libelle}`, lignes: [{ designation: 'TEST Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }), 201);
      await ok(appeler('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' }));
      await ok(appeler('post', `/devis/${devis.id}/signature`, { signataire: 'TEST Signataire 285', confirme: true }), 201);
      const ouverture = await ok(appeler('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER', responsableId: comptes.CT.id, commercialId: comptes.COM.id }), 201);
      const chantierId = ouverture.chantier?.id ?? ouverture.chantierId ?? ouverture.id;
      let contratId = null; let interventionId = null;
      if (seconde === 'CONTRAT') contratId = (await ok(appeler('post', `/devis/${devis.id}/convertir`, { cible: 'CONTRAT', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-01-2099' }), 201)).id;
      if (seconde === 'INTERVENTION') interventionId = (await ok(appeler('post', `/devis/${devis.id}/convertir`, { cible: 'INTERVENTION' }), 201)).id;
      const conversions = await prisma.devisConversion.findMany({ where: { devisId: devis.id }, orderBy: { rang: 'asc' } });
      assert.deepEqual(conversions.map((c) => c.cibleType), ['CHANTIER', ...(seconde ? [seconde] : [])]);
      assert.equal(conversions[0].cibleId, chantierId);
      return { devis, chantierId, contratId, interventionId };
    };

    // Une transaction de test tient la ligne du chantier (FOR UPDATE) : la requête part, attend ce verrou (constaté par
    // pg_blocking_pids, quel que soit le verrou qu'elle demande : FOR UPDATE, ou FOR NO KEY UPDATE pour l'annulation
    // d'un devis), puis la transaction change la ligne directement en base et valide. L'état attendu après la réponse
    // est relevé dans la transaction : toute la base avant le départ de la requête, puis la table des chantiers, seule
    // changée, une fois le changement fait ; la requête, si elle refuse, n'y change rien. Relevé court pendant l'attente :
    // la transaction de la requête expire au bout de 5 s (défaut de Prisma). Modèle : `sousVerrouTiers` d'api.test.mjs
    // (#181).
    const sousVerrou = async (chantierId, lancer, changer) => {
      let reponse; let attendu;
      await prisma.$transaction(async (tx) => {
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT "id" FROM "Chantier" WHERE "id" = ${chantierId} FOR UPDATE`;
        attendu = await empreinte(tx);
        reponse = lancer().then((r) => r);
        let attente = false;
        for (let tour = 0; tour < 300 && !attente; tour += 1) {
          attente = (await prisma.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`)[0].n > 0;
          if (!attente) await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(attente, true, 'la requête attend la ligne du chantier');
        await changer(tx);
        attendu.Chantier = await empreinteTable(tx, 'Chantier');
      }, { timeout: 30_000, maxWait: 10_000 });
      return { res: await reponse, attendu };
    };
    // Course refusée : statut et message, et la base telle que la transaction de test l'a laissée.
    const courseRefusee = async ({ res, attendu }, statut, message, quoi) => {
      assert.equal(res.status, statut, `${quoi} : ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, message, quoi);
      assert.deepEqual(tablesChangees(attendu, await empreinte()), [], `${quoi} : la requête refusée ne doit rien écrire`);
    };

    before(async () => {
      assert.ok(['127.0.0.1', 'localhost'].includes(source.hostname), 'seul un PostgreSQL local est autorisé');
      assert.notEqual(source.pathname.slice(1), nomBase);
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
      secours = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' }, select: { id: true, name: true, role: true } });
      assert.equal(secours.role, 'SUPERADMIN', 'le compte de secours est super administrateur');
      // Identité de la société : un devis ne se signe qu'avec elle (lot 6a-1), et la signature précède la conversion.
      await ok(appeler('put', '/company', { raisonSociale: 'TEST Émetteur correctif 285', siret: '28528528500028', adresse: '28 rue du Correctif', codePostal: '14000', ville: 'Caen', fuseauHoraire: 'Europe/Paris' }));
      comptes.AD = await creerCompte('ADMIN', 'AD');
      comptes['AD-COM'] = await creerCompte('ADMIN', 'AD-COM', { estCommercial: true });
      for (const [cle, role] of [...TITULAIRES_HORS_ADMINISTRATION, ['CT2', 'CONDUCTEUR_TRAVAUX'], ['TECH', 'TECHNICIEN'], ['COM', 'COMMERCIAL'], ['COM2', 'COMMERCIAL'], ['DIR', 'DIRECTEUR']]) {
        comptes[cle] = await creerCompte(role, cle);
      }
    });

    after(async () => {
      await prisma?.$disconnect().catch(() => {});
      await appPrisma?.$disconnect().catch(() => {});
      if (baseCreee) await administrationPg.query(`DROP DATABASE IF EXISTS "${nomBase}" WITH (FORCE)`);
      await administrationPg.end().catch(() => {});
    });

    // ------------------------------------------------------------------------------------------------------------------
    // Point 1 : encaissement d'une affaire annulée (décision de Nelson du 02-11-2026, #285).
    // ------------------------------------------------------------------------------------------------------------------

    // Cadrage, point 1 : « Réponse 409 : « Cette affaire est annulée : elle ne peut pas être encaissée. » Le refus vaut
    // quel que soit le corps, l'enregistrement à l'identique compris » ; critère : « 409, que ce soit pour encaisser,
    // désencaisser ou réenregistrer à l'identique ; aucune écriture ni entrée de journal ». Écarte un refus limité à
    // `encaisse=true` (désencaisser ou réenregistrer à l'identique resteraient 200) et un refus par un seul compte
    // d'administration.
    test('encaissement d’une affaire annulée : 409 pour encaisser, désencaisser ou réenregistrer à l’identique, par chaque compte de l’administration, sans écriture ni journal', async () => {
      // Affaire annulée par l'annulation de son devis, comme dans l'application.
      const { devis, chantierId } = await chantierConverti('encaissement annulée');
      await ok(annulerDevis(devis.id));
      assert.equal((await ligne(chantierId)).statut, 'ANNULE');
      // Affaire annulée et encaissée, posée en base : aucun chemin de l'API n'y mène plus (points 1, 2 et 2 bis), mais
      // la désencaisser ou la réenregistrer reste refusé, quel que soit le corps.
      const encaissee = await creerAnnule({ encaisse: true, dateEncaissement: new Date('2026-10-10T09:00:00.000Z') });
      for (const [compte, auth] of ADMINISTRATION()) {
        for (const [quoi, corps] of [['encaisser', { encaisse: true }], ['réenregistrer non encaissée à l’identique', { encaisse: false }], ['corps vide', {}], ['encaisse « oui » en texte', { encaisse: 'oui' }]]) {
          await refuse(() => encaisser(chantierId, corps, auth), 409, REFUS.encaissementAnnulee, `${compte}, affaire annulée, ${quoi}`, chantierId);
        }
        for (const [quoi, corps] of [['désencaisser', { encaisse: false }], ['réenregistrer encaissée à l’identique', { encaisse: true }]]) {
          await refuse(() => encaisser(encaissee.id, corps, auth), 409, REFUS.encaissementAnnulee, `${compte}, affaire annulée et encaissée, ${quoi}`, encaissee.id);
        }
      }
      const relue = await ligne(chantierId);
      assert.deepEqual([relue.encaisse, relue.dateEncaissement], [false, null]);
      const relueEncaissee = await ligne(encaissee.id);
      assert.deepEqual([relueEncaissee.encaisse, relueEncaissee.dateEncaissement?.toISOString()], [true, '2026-10-10T09:00:00.000Z']);
      // Hors administration, la garde de la route répond d'abord, comme avant (403), titulaire compris ; un chantier
      // inexistant reste 404.
      for (const cle of ['CT', 'RESP', 'DC', 'AC', 'CPT', 'TECH', 'COM', 'DIR']) {
        await refuse(() => encaisser(chantierId, { encaisse: true }, comptes[cle].auth), 403, REFUS.administration, `${cle}, affaire annulée`, chantierId);
      }
      await refuse(() => encaisser('00000000-0000-0000-0000-000000000000', { encaisse: true }), 404, REFUS.introuvable, 'chantier inexistant');
    });

    // Cadrage, critère : « l'encaissement d'une affaire en cours ou terminée est inchangé ». Témoin du refus précédent :
    // écarte un refus étendu à tout chantier non terminé, ou à tout chantier terminé.
    test('encaissement d’une affaire en cours ou terminée inchangé : coché puis décoché par l’administration, journalisé ; à l’identique, ni écriture ni journal', async () => {
      for (const [quoi, creer] of [['en cours', () => creerChantier()], ['terminée', () => creerTermine()]]) {
        for (const [compte, auth] of ADMINISTRATION()) {
          const chantier = await creer();
          const coche = await encaisser(chantier.id, { encaisse: true }, auth);
          assert.equal(coche.status, 200, `${compte}, ${quoi} : ${JSON.stringify(coche.body)}`);
          let relu = await ligne(chantier.id);
          assert.equal(relu.encaisse, true, `${compte}, ${quoi} : encaissée`);
          assert.ok(relu.dateEncaissement, `${compte}, ${quoi} : date d’encaissement posée`);
          assert.equal(relu.statut, chantier.statut, `${compte}, ${quoi} : le statut ne change pas`);
          assert.deepEqual((await journal(chantier.id)).map((e) => e.action), ['CHANGEMENT_ENCAISSEMENT']);
          await refuse(() => encaisser(chantier.id, { encaisse: true }, auth), 200, undefined, `${compte}, ${quoi}, à l’identique`, chantier.id);
          assert.equal((await encaisser(chantier.id, { encaisse: false }, auth)).status, 200);
          relu = await ligne(chantier.id);
          assert.deepEqual([relu.encaisse, relu.dateEncaissement], [false, null]);
          assert.deepEqual((await journal(chantier.id)).map((e) => e.action), ['CHANGEMENT_ENCAISSEMENT', 'CHANGEMENT_ENCAISSEMENT']);
        }
      }
    });

    // ------------------------------------------------------------------------------------------------------------------
    // Point 2 : annulation d'un chantier encaissé (réponse fermée de Nelson, « Corriger maintenant »).
    // ------------------------------------------------------------------------------------------------------------------

    // Cadrage, point 2 : « Réponse 409 : « Annulation impossible : ce chantier est déjà encaissé. Une affaire encaissée ne
    // s'annule pas. » » ; critère : « 409, sans aucune écriture (devis, chantier, contrat, intervention) ». Un chantier
    // encaissé en cours (l'encaissement ne dépend pas du statut) ou terminé, ouvert avec un contrat ou une intervention
    // du même devis. Écarte un refus limité au chantier terminé et encaissé (seul état qui porte un CA validé).
    test('annulation d’un devis dont le chantier est encaissé, en cours ou terminé : 409, sans écriture du devis, du chantier, du contrat ni de l’intervention', async () => {
      for (const [quoi, seconde, terminer] of [['en cours, avec contrat', 'CONTRAT', false], ['terminé, avec intervention', 'INTERVENTION', true], ['en cours, avec intervention', 'INTERVENTION', false], ['terminé, avec contrat', 'CONTRAT', true]]) {
        const { devis, chantierId, contratId, interventionId } = await chantierConverti(`annulation encaissé ${quoi}`, { seconde });
        if (terminer) await ok(changerStatut(chantierId, { statut: 'TERMINE' }));
        await ok(encaisser(chantierId, { encaisse: true }));
        for (const [compte, auth] of [['SA', admin()], ['AD', comptes.AD.auth]]) {
          await refuse(() => annulerDevis(devis.id, auth), 409, REFUS.annulationEncaisse, `${compte}, chantier ${quoi}, encaissé`, chantierId);
        }
        assert.equal((await prisma.devis.findUniqueOrThrow({ where: { id: devis.id } })).statut, 'ACCEPTE');
        const relu = await ligne(chantierId);
        assert.deepEqual([relu.statut, relu.encaisse, relu.annuleLe], [terminer ? 'TERMINE' : 'EN_COURS', true, null]);
        if (contratId) assert.notEqual((await prisma.contratMaintenance.findUniqueOrThrow({ where: { id: contratId } })).statut, 'ANNULE');
        if (interventionId) assert.notEqual((await prisma.intervention.findUniqueOrThrow({ where: { id: interventionId } })).statut, 'ANNULEE');
      }
    });

    // Cadrage, critère : « un chantier non encaissé s'annule comme avant ». Encaissé puis désencaissé, il s'annule aussi :
    // le refus lit la case telle qu'elle est (relue sous le verrou), et non une trace d'encaissement passée (journal,
    // date). Écarte un refus de toute annulation de chantier, ou de tout chantier terminé.
    test('un chantier non encaissé s’annule comme avant, avec son contrat ou son intervention ; encaissé puis désencaissé aussi', async () => {
      for (const [quoi, seconde, avant] of [['jamais encaissé, avec contrat', 'CONTRAT', null], ['terminé, jamais encaissé, avec intervention', 'INTERVENTION', 'TERMINE'], ['encaissé puis désencaissé, avec intervention', 'INTERVENTION', 'DESENCAISSE']]) {
        const { devis, chantierId, contratId, interventionId } = await chantierConverti(`annulation admise ${quoi}`, { seconde });
        if (avant === 'TERMINE') await ok(changerStatut(chantierId, { statut: 'TERMINE' }));
        if (avant === 'DESENCAISSE') {
          await ok(encaisser(chantierId, { encaisse: true }));
          await ok(encaisser(chantierId, { encaisse: false }));
        }
        const res = await annulerDevis(devis.id);
        assert.equal(res.status, 200, `${quoi} : ${JSON.stringify(res.body)}`);
        assert.equal(res.body.chantierArchive, chantierId);
        const relu = await ligne(chantierId);
        assert.deepEqual([relu.statut, relu.encaisse, relu.dateEncaissement], ['ANNULE', false, null], quoi);
        assert.ok(relu.annuleLe, `${quoi} : date d’annulation`);
        assert.equal((await prisma.devis.findUniqueOrThrow({ where: { id: devis.id } })).statut, 'ANNULE');
        if (contratId) assert.equal((await prisma.contratMaintenance.findUniqueOrThrow({ where: { id: contratId } })).statut, 'ANNULE');
        if (interventionId) assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id: interventionId } })).statut, 'ANNULEE');
      }
    });

    // Cadrage, point 2 : « Le refus vient après ceux d'une affaire commencée (…), pour que leurs messages ne changent pas » ;
    // critère : « un devis converti reste « 409 … Une affaire commencée ne s'annule pas. » ». Ordre précisé par la réponse
    // de Claude Code du 02-11-2026 à la question 1 du rapport des tests : le refus « déjà encaissé » vient après TOUS les
    // autres refus de l'annulation. Ici, côté chantier : un chantier encaissé qui porte des heures, ou un achat, garde le
    // message de l'affaire commencée, mot pour mot. Écarte le refus de l'encaissement placé avant ceux-là (mutant M13).
    test('chantier encaissé qui porte des heures ou un achat : l’annulation garde le refus de l’affaire commencée, sans écriture', async () => {
      const intervenant = await prisma.intervenant.create({ data: { nom: `TEST Intervenant 285 ${suffixe()}`, role: 'Technicien', tauxHoraireCharge: '40' } });
      const fournisseur = await prisma.fournisseur.create({ data: { nom: `TEST Fournisseur 285 ${suffixe()}` } });
      const categorie = await prisma.categorie.create({ data: { nom: `TEST Catégorie 285 ${suffixe()}` } });
      for (const [quoi, saisir, message] of [
        ['un pointage d’heures', (chantierId) => prisma.pointageHeure.create({ data: { chantierId, intervenantId: intervenant.id, date: new Date('2026-09-02T00:00:00.000Z'), nbrHeures: '2', tauxHoraireApplique: '40', createdById: secours.id, updatedById: secours.id } }),
          'Annulation impossible : ce chantier porte déjà 1 pointage(s) d’heures et 0 achat(s). Une affaire commencée ne s’annule pas.'],
        ['un achat', (chantierId) => prisma.achatReel.create({ data: { chantierId, fournisseurId: fournisseur.id, categorieId: categorie.id, date: new Date('2026-09-02T00:00:00.000Z'), description: 'TEST Achat 285', montantHT: '10', createdById: secours.id, updatedById: secours.id } }),
          'Annulation impossible : ce chantier porte déjà 0 pointage(s) d’heures et 1 achat(s). Une affaire commencée ne s’annule pas.'],
      ]) {
        const { devis, chantierId } = await chantierConverti(`commencé ${quoi}`);
        await saisir(chantierId);
        await ok(encaisser(chantierId, { encaisse: true }));
        await refuse(() => annulerDevis(devis.id), 409, message, `chantier encaissé portant ${quoi}`, chantierId);
      }
    });

    // Réponse de Claude Code du 02-11-2026 à la question 1 du rapport des tests : « Le refus « déjà encaissé » vient
    // désormais après TOUS les autres refus : ceux d'une affaire commencée côté chantier, l'intervention du devis en cours
    // ou terminée, une suite commencée, une visite en cours (…). Leurs messages ne changent pas, comme le voulait le
    // cadrage. » Un chantier encaissé dont l'intervention du devis, une suite de celle-ci ou une visite du contrat du devis
    // est commencée reçoit le message de cette intervention, mot pour mot, et non « déjà encaissé » ; témoin : la même
    // affaire, désencaissée, reçoit le même message. Écarte le refus placé à son ancien emplacement, juste après les coûts
    // des suites, avant les refus SAV (mutant M17), et tout refus de l'encaissement placé avant l'un d'eux.
    test('chantier encaissé dont l’intervention du devis, une suite ou une visite du contrat est commencée : l’annulation garde le message de cette intervention, et non « déjà encaissé », sans écriture ni journal', async () => {
      const passerA = (id, statut, extra = {}) => ok(appeler('patch', `/interventions/${id}/statut`, { statut, ...extra }));
      const demarrer = async (id) => { await passerA(id, 'PLANIFIEE'); await passerA(id, 'EN_COURS'); };
      const terminer = async (id) => {
        await demarrer(id);
        await ok(appeler('post', `/interventions/${id}/rapports`, { contenu: 'TEST Compte rendu du correctif 285.', cleEnvoi: randomUUID() }), 201);
        await passerA(id, 'TERMINEE', { motifSansSignature: 'CLIENT_ABSENT' });
      };
      const reference = async (id) => (await prisma.intervention.findUniqueOrThrow({ where: { id }, select: { reference: true } })).reference;
      const creerSuite = (interventionId) => ok(appeler('post', `/interventions/${interventionId}/suites`, {}), 201);
      const intervention = (ref, etat) => `Annulation impossible : l’intervention ${ref} issue de ce devis est ${etat}. Une affaire commencée ne s’annule pas.`;
      const suite = (refSuite, ref, etat) => `Annulation impossible : la suite ${refSuite} de l’intervention ${ref} est ${etat}. Une affaire commencée ne s’annule pas.`;
      for (const [quoi, seconde, commencer] of [
        ['intervention du devis en cours', 'INTERVENTION', async ({ interventionId }) => { await demarrer(interventionId); return intervention(await reference(interventionId), 'en cours'); }],
        ['intervention du devis terminée', 'INTERVENTION', async ({ interventionId }) => { await terminer(interventionId); return intervention(await reference(interventionId), 'terminée'); }],
        ['suite en cours', 'INTERVENTION', async ({ interventionId }) => {
          const creee = await creerSuite(interventionId);
          await demarrer(creee.id);
          return suite(creee.reference, await reference(interventionId), 'en cours');
        }],
        ['suite terminée', 'INTERVENTION', async ({ interventionId }) => {
          const creee = await creerSuite(interventionId);
          await terminer(creee.id);
          return suite(creee.reference, await reference(interventionId), 'terminée');
        }],
        ['visite du contrat en cours', 'CONTRAT', async ({ contratId }) => {
          const visite = await ok(appeler('post', `/contrats-maintenance/${contratId}/generer-intervention`, {}), 201);
          await demarrer(visite.id);
          return `Annulation impossible : la visite ${visite.reference} du contrat issu de ce devis est en cours. Terminez-la ou annulez-la d’abord depuis sa fiche.`;
        }],
      ]) {
        const affaire = await chantierConverti(`encaissé, ${quoi}`, { seconde });
        const message = await commencer(affaire);
        await ok(encaisser(affaire.chantierId, { encaisse: true }));
        await refuse(() => annulerDevis(affaire.devis.id), 409, message, `chantier encaissé, ${quoi}`, affaire.chantierId);
        // Témoin : désencaissée, la même affaire reçoit le même refus, celui d'avant le correctif.
        await ok(encaisser(affaire.chantierId, { encaisse: false }));
        await refuse(() => annulerDevis(affaire.devis.id), 409, message, `chantier désencaissé, ${quoi}`, affaire.chantierId);
        const relu = await ligne(affaire.chantierId);
        assert.deepEqual([relu.statut, relu.annuleLe], ['EN_COURS', null], quoi);
        assert.equal((await prisma.devis.findUniqueOrThrow({ where: { id: affaire.devis.id } })).statut, 'ACCEPTE', quoi);
      }
    });

    // ------------------------------------------------------------------------------------------------------------------
    // Point 3 : commercial d'une affaire annulée (choix par défaut le plus restrictif, à confirmer).
    // ------------------------------------------------------------------------------------------------------------------

    // Cadrage, point 3 : « Réponse 409 : « Cette affaire est annulée : son commercial ne change plus. » » ; « Le statut est
    // lu sous le verrou existant, après la validation du corps » ; « Les lignes …/commercial | chantier-annule | défaut |
    // 400 d'entrees.txt ne changent pas : à corps vide, la validation répond la première » ; critère : « 409 pour
    // l'administration et pour le titulaire, sans écriture ». Le refus porte sur l'affaire : le commercial renvoyé à
    // l'identique est refusé de même. Écarte un refus réservé aux non-administrateurs, ou placé avant la validation.
    test('commercial d’une affaire annulée : 409 pour l’administration et pour le titulaire, sans écriture ni journal ; corps invalide : 400 d’abord ; hors titulaire 404, technicien 403', async () => {
      const { devis, chantierId } = await chantierConverti('commercial annulée');
      await ok(annulerDevis(devis.id));
      for (const [compte, auth] of [...ADMINISTRATION(), ['CT titulaire', comptes.CT.auth]]) {
        await refuse(() => changerCommercial(chantierId, { commercialId: comptes.COM2.id }, auth), 409, REFUS.commercialAnnulee, `${compte}, nouveau commercial`, chantierId);
        await refuse(() => changerCommercial(chantierId, { commercialId: comptes.COM.id }, auth), 409, REFUS.commercialAnnulee, `${compte}, commercial à l’identique`, chantierId);
        await refuse(() => changerCommercial(chantierId, {}, auth), 400, REFUS.commercialVide, `${compte}, corps vide`, chantierId);
        await refuse(() => changerCommercial(chantierId, { commercialId: comptes.CT2.id }, auth), 400, REFUS.commercialIntrouvable, `${compte}, commercial qui n’en est pas un`, chantierId);
      }
      assert.equal((await ligne(chantierId)).commercialId, comptes.COM.id);
      // Ordre : hors titulaire 404, technicien titulaire 403, avant l'affaire annulée.
      await refuse(() => changerCommercial(chantierId, { commercialId: comptes.COM2.id }, comptes.CT2.auth), 404, REFUS.introuvable, 'autre conducteur', chantierId);
      const deTechnicien = await creerAnnule({ responsableId: comptes.TECH.id });
      await refuse(() => changerCommercial(deTechnicien.id, { commercialId: comptes.COM2.id }, comptes.TECH.auth), 403, REFUS.technicienCommercial, 'technicien titulaire', deTechnicien.id);
      await refuse(() => changerCommercial(chantierId, { commercialId: comptes.COM2.id }, comptes.COM.auth), 403, REFUS.compteCommercial, 'commercial', chantierId);
      await refuse(() => changerCommercial(chantierId, { commercialId: comptes.COM2.id }, comptes.DIR.auth), 403, REFUS.compteDirecteur, 'directeur', chantierId);
    });

    // ------------------------------------------------------------------------------------------------------------------
    // Point 2 bis : statut envoyé à la fiche (lecture retenue de la décision, à confirmer).
    // ------------------------------------------------------------------------------------------------------------------

    // Cadrage, point 2 bis : « PATCH /api/chantiers/:id refuse un statut autre que EN_COURS ou TERMINE, par 400 « Statut
    // invalide. », le message de /statut. Un chantier ne s'annule ainsi que par son devis » ; critère : « statut=ANNULE
    // par l'administration donne 400, sans écriture ». Écarte un contrôle limité à la valeur ANNULE, ou insensible à la
    // casse, et un statut écrit avec les autres champs du même corps.
    test('statut envoyé à la fiche par l’administration : tout autre que EN_COURS ou TERMINE donne 400 « Statut invalide. », sans écriture, même avec d’autres champs ; EN_COURS et TERMINE restent admis', async () => {
      const enCours = await creerChantier();
      const termine = await creerTermine();
      for (const [compte, auth] of ADMINISTRATION()) {
        for (const [quoi, corps] of [
          ['ANNULE', { statut: 'ANNULE' }], ['ANNULE avec un nom', { statut: 'ANNULE', nom: 'TEST nom glissé avec le statut' }],
          ['annule en minuscules', { statut: 'annule' }], ['TERMINE suivi d’une espace', { statut: 'TERMINE ' }], ['chaîne vide', { statut: '' }],
          ['null', { statut: null }], ['ARCHIVE', { statut: 'ARCHIVE' }], ['tableau', { statut: ['TERMINE'] }],
        ]) {
          await refuse(() => modifierFiche(enCours.id, corps, auth), 400, REFUS.statutInvalide, `${compte}, chantier en cours, statut ${quoi}`, enCours.id);
          await refuse(() => modifierFiche(termine.id, corps, auth), 400, REFUS.statutInvalide, `${compte}, chantier terminé, statut ${quoi}`, termine.id);
        }
      }
      assert.deepEqual([(await ligne(enCours.id)).statut, (await ligne(termine.id)).statut], ['EN_COURS', 'TERMINE']);
      // Sur une affaire annulée, le refus de l'affaire annulée (409) passe avant ; sur un chantier inexistant, 404.
      const annule = await creerAnnule();
      await refuse(() => modifierFiche(annule.id, { statut: 'ANNULE' }), 409, REFUS.ficheAnnulee, 'affaire annulée, statut ANNULE', annule.id);
      await refuse(() => modifierFiche(annule.id, { statut: 'EN_COURS' }), 409, REFUS.ficheAnnulee, 'affaire annulée, réouverture', annule.id);
      await refuse(() => modifierFiche('00000000-0000-0000-0000-000000000000', { statut: 'ANNULE' }), 404, REFUS.introuvable, 'chantier inexistant');
      // Témoins : EN_COURS et TERMINE restent admis par l'administration.
      const aClore = await creerChantier();
      assert.equal((await modifierFiche(aClore.id, { statut: 'TERMINE' })).status, 200);
      assert.equal((await ligne(aClore.id)).statut, 'TERMINE');
      assert.equal((await modifierFiche(aClore.id, { statut: 'EN_COURS' }, comptes.AD.auth)).status, 200);
      assert.equal((await ligne(aClore.id)).statut, 'EN_COURS');
      // Hors administration, le statut reste un champ ignoré (bloc S de D1a-5b) : l'affaire ne passe pas à ANNULE.
      const duConducteur = await creerChantier();
      const res = await modifierFiche(duConducteur.id, { statut: 'ANNULE', nom: 'TEST nom du conducteur 285' }, comptes.CT.auth);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const relu = await ligne(duConducteur.id);
      assert.deepEqual([relu.statut, relu.nom], ['EN_COURS', 'TEST nom du conducteur 285']);
    });

    // ------------------------------------------------------------------------------------------------------------------
    // Point 5 : chantier terminé (réponse fermée de Nelson, « A. Non, admin seule »).
    // ------------------------------------------------------------------------------------------------------------------

    // Corps de la fiche, champ par champ (cadrage, point 5 : « tous les champs de la fiche » ; décision : « nom, budgets,
    // heures vendues, dates, titulaire »), plus le corps vide et un corps invalide : le refus du chantier clôturé passe
    // avant la validation (ordre du cadrage, point 5).
    const corpsDeLaFiche = () => [
      ['nom seul', { nom: 'TEST nom changé après clôture' }],
      ['budget global seul', { budgetGlobalVendu: '2222.22' }],
      ['budget matériel seul', { budgetMaterielVendu: '333.33' }],
      ['budget de main-d’œuvre seul', { budgetMainOeuvreVendu: '444.44' }],
      ['heures vendues seules', { heuresVendues: '55.5' }],
      ['nom, budgets par poste et heures vendues', { nom: 'TEST nom et budgets après clôture', budgetMaterielVendu: '333.33', budgetMainOeuvreVendu: '444.44', heuresVendues: '55.5' }],
      ['date de début seule', { dateDebut: '02-09-2026' }],
      ['date de fin seule', { dateFin: '31-10-2026' }],
      ['date de fin vidée', { dateFin: '' }],
      ['barème réduit seul', { baremeReduit: true }],
      ['titulaire seul', { responsableId: comptes.CT2.id }],
      ['référence seule', { numeroDevis: 'A26-9285' }],
      ['adresse seule', { adresse: 'TEST 2 rue changée' }],
      ['types seuls', { types: ['Vidéo'] }],
      ['statut EN_COURS seul (réouverture)', { statut: 'EN_COURS' }],
      ['corps vide', {}],
      ['heures vendues invalides', { heuresVendues: 'abc' }],
    ];

    // Cadrage, critère : « refus pour CT, RESP, DC, AC et CPT titulaires, sur la fiche (nom, budgets, heures vendues,
    // dates, barème réduit, titulaire) (…), sans écriture » ; réponse 403 « Ce chantier est clôturé : seul un
    // administrateur peut encore le modifier. ». Écarte un refus limité au conducteur, un filtrage par champ (un champ
    // oublié resterait écrit) et une validation du corps placée avant le refus.
    test('chantier terminé : la fiche est refusée (403) à chaque titulaire hors administration (CT, RESP, DC, AC, CPT), champ par champ, sans écriture ni journal', async () => {
      for (const [cle] of TITULAIRES_HORS_ADMINISTRATION) {
        const chantier = await creerTermine({ responsableId: comptes[cle].id });
        for (const [quoi, corps] of corpsDeLaFiche()) {
          await refuse(() => modifierFiche(chantier.id, corps, comptes[cle].auth), 403, REFUS.ficheCloture, `${cle} titulaire, chantier terminé, ${quoi}`, chantier.id);
        }
        const relu = await ligne(chantier.id);
        assert.deepEqual([relu.nom, relu.responsableId, relu.statut, relu.dateFin?.toISOString(), relu.baremeReduit], [chantier.nom, comptes[cle].id, 'TERMINE', DATE_FIN.toISOString(), false]);
      }
    });

    // Note N2 du contrôle de cohérence de #440 : « À garder : un corps « dateFin seul » et un corps « baremeReduit seul »
    // sur chantier-termine, pour qu'un futur filtrage par champ ne rouvre pas ces deux montants » : `dateFin` fixe le mois
    // de la commission (commissions/metier.ts), `baremeReduit` choisit son barème. Un chantier terminé ET encaissé, seul
    // état qui porte un CA validé, puis un chantier terminé non encaissé. Écarte un refus limité aux budgets.
    test('chantier terminé, encaissé ou non : « date de fin seule » et « barème réduit seul » refusés au titulaire (403), sans écriture : ni le mois ni le barème de la commission ne bougent', async () => {
      for (const encaisse of [true, false]) {
        const chantier = await creerTermine({ encaisse, dateEncaissement: encaisse ? new Date('2026-10-16T10:00:00.000Z') : null });
        for (const [quoi, corps] of [['date de fin seule', { dateFin: '01-11-2026' }], ['date de fin vidée', { dateFin: null }], ['barème réduit seul', { baremeReduit: true }]]) {
          await refuse(() => modifierFiche(chantier.id, corps, comptes.CT.auth), 403, REFUS.ficheCloture, `CT titulaire, terminé ${encaisse ? 'et encaissé' : 'non encaissé'}, ${quoi}`, chantier.id);
        }
        const relu = await ligne(chantier.id);
        assert.deepEqual([relu.dateFin.toISOString(), relu.baremeReduit, relu.encaisse], [DATE_FIN.toISOString(), false, encaisse]);
      }
    });

    // Cadrage, critère : « refus pour CT, RESP, DC, AC et CPT titulaires (…) sur le commercial, sans écriture » ; réponse
    // 403 « Ce chantier est clôturé : seul un administrateur peut encore en changer le commercial. » ; le statut est relu
    // sous le verrou, après la validation du corps (point 3) : un corps invalide reste 400. Un chantier terminé non
    // encaissé et un chantier terminé et encaissé (CA et marge validés du commercial). Écarte un refus limité au chantier
    // encaissé, ou au conducteur.
    test('chantier terminé, encaissé ou non : le commercial n’est plus réattribué par ses titulaires hors administration (403), sans écriture ni journal ; corps invalide : 400 d’abord', async () => {
      for (const encaisse of [false, true]) {
        for (const [cle] of TITULAIRES_HORS_ADMINISTRATION) {
          const chantier = await creerTermine({ responsableId: comptes[cle].id, encaisse, dateEncaissement: encaisse ? new Date('2026-10-16T10:00:00.000Z') : null });
          const quoi = `${cle} titulaire, terminé ${encaisse ? 'et encaissé' : 'non encaissé'}`;
          await refuse(() => changerCommercial(chantier.id, { commercialId: comptes.COM2.id }, comptes[cle].auth), 403, REFUS.commercialCloture, `${quoi}, nouveau commercial`, chantier.id);
          await refuse(() => changerCommercial(chantier.id, { commercialId: comptes.COM.id }, comptes[cle].auth), 403, REFUS.commercialCloture, `${quoi}, commercial à l’identique`, chantier.id);
          await refuse(() => changerCommercial(chantier.id, {}, comptes[cle].auth), 400, REFUS.commercialVide, `${quoi}, corps vide`, chantier.id);
          await refuse(() => changerCommercial(chantier.id, { commercialId: comptes.CT2.id }, comptes[cle].auth), 400, REFUS.commercialIntrouvable, `${quoi}, commercial qui n’en est pas un`, chantier.id);
          assert.equal((await ligne(chantier.id)).commercialId, comptes.COM.id);
        }
      }
    });

    // Cadrage, point 5 : « Ordre des contrôles : 404 hors titulaire, 403 technicien, 409 affaire annulée, puis 403
    // chantier clôturé hors administration. » Joué avec un corps invalide, qui prouve aussi que ces refus précèdent la
    // validation. Écarte chaque permutation de deux contrôles voisins.
    test('ordre des contrôles de la fiche et du commercial : 404 hors titulaire, 403 technicien, 409 affaire annulée, puis 403 chantier clôturé', async () => {
      const invalide = { heuresVendues: 'abc' };
      const termine = await creerTermine();
      const annule = await creerAnnule();
      const termineTechnicien = await creerTermine({ responsableId: comptes.TECH.id });
      const annuleTechnicien = await creerAnnule({ responsableId: comptes.TECH.id });
      // Fiche.
      await refuse(() => modifierFiche(termine.id, invalide, comptes.CT2.auth), 404, REFUS.introuvable, 'fiche, autre conducteur, terminé', termine.id);
      await refuse(() => modifierFiche(annule.id, invalide, comptes.CT2.auth), 404, REFUS.introuvable, 'fiche, autre conducteur, annulée', annule.id);
      await refuse(() => modifierFiche(termineTechnicien.id, invalide, comptes.TECH.auth), 403, REFUS.technicienFiche, 'fiche, technicien titulaire, terminé', termineTechnicien.id);
      await refuse(() => modifierFiche(annuleTechnicien.id, invalide, comptes.TECH.auth), 403, REFUS.technicienFiche, 'fiche, technicien titulaire, annulée', annuleTechnicien.id);
      await refuse(() => modifierFiche(annule.id, invalide, comptes.CT.auth), 409, REFUS.ficheAnnulee, 'fiche, conducteur titulaire, annulée', annule.id);
      await refuse(() => modifierFiche(termine.id, invalide, comptes.CT.auth), 403, REFUS.ficheCloture, 'fiche, conducteur titulaire, terminé', termine.id);
      // Témoin : l'administration, que le chantier clôturé ne refuse pas, tombe sur la validation du corps.
      await refuse(() => modifierFiche(termine.id, invalide), 400, REFUS.heuresInvalides, 'fiche, administration, terminé, heures invalides', termine.id);
      // Commercial, avec un corps valide (la validation passe avant les refus relus sous le verrou).
      const corps = { commercialId: comptes.COM2.id };
      await refuse(() => changerCommercial(termine.id, corps, comptes.CT2.auth), 404, REFUS.introuvable, 'commercial, autre conducteur, terminé', termine.id);
      await refuse(() => changerCommercial(termineTechnicien.id, corps, comptes.TECH.auth), 403, REFUS.technicienCommercial, 'commercial, technicien titulaire, terminé', termineTechnicien.id);
      await refuse(() => changerCommercial(annuleTechnicien.id, corps, comptes.TECH.auth), 403, REFUS.technicienCommercial, 'commercial, technicien titulaire, annulée', annuleTechnicien.id);
      await refuse(() => changerCommercial(annule.id, corps, comptes.CT.auth), 409, REFUS.commercialAnnulee, 'commercial, conducteur titulaire, annulée', annule.id);
      await refuse(() => changerCommercial(termine.id, corps, comptes.CT.auth), 403, REFUS.commercialCloture, 'commercial, conducteur titulaire, terminé', termine.id);
    });

    // Cadrage, point 5 : « L'administration n'est pas touchée : elle seule rouvre un chantier » ; critère : « l'administration
    // écrit toujours ». Chaque champ de la fiche et le commercial d'un chantier terminé, relus en base, par chacun des
    // trois comptes de l'administration ; un chantier terminé et encaissé aussi. Écarte un refus étendu à l'administration.
    test('chantier terminé, encaissé ou non : l’administration écrit toujours chaque champ de la fiche et le commercial, journalisés comme avant', async () => {
      for (const [compte, auth] of ADMINISTRATION()) {
        for (const encaisse of [false, true]) {
          const chantier = await creerTermine({ encaisse, dateEncaissement: encaisse ? new Date('2026-10-16T10:00:00.000Z') : null });
          const quoi = `${compte}, terminé ${encaisse ? 'et encaissé' : 'non encaissé'}`;
          const corps = {
            nom: `TEST nom par ${compte} 285 ${suffixe()}`, budgetGlobalVendu: '2222.22', budgetMaterielVendu: '333.33', budgetMainOeuvreVendu: '444.44', heuresVendues: '55.5',
            dateDebut: '02-09-2026', dateFin: '31-10-2026', baremeReduit: true, adresse: 'TEST 2 rue changée', types: ['Vidéo'], responsableId: comptes.CT2.id,
          };
          const res = await modifierFiche(chantier.id, corps, auth);
          assert.equal(res.status, 200, `${quoi} : ${JSON.stringify(res.body)}`);
          const relu = await ligne(chantier.id);
          assert.deepEqual(
            [relu.nom, relu.budgetGlobalVendu.toString(), relu.budgetMaterielVendu.toString(), relu.budgetMainOeuvreVendu.toString(), relu.heuresVendues.toString(), relu.dateDebut.toISOString(), relu.dateFin.toISOString(), relu.baremeReduit, relu.adresse, relu.types, relu.responsableId, relu.statut, relu.encaisse],
            [corps.nom, '2222.22', '333.33', '444.44', '55.5', '2026-09-02T00:00:00.000Z', '2026-10-31T00:00:00.000Z', true, 'TEST 2 rue changée', ['Vidéo'], comptes.CT2.id, 'TERMINE', encaisse],
            quoi,
          );
          const commercial = await changerCommercial(chantier.id, { commercialId: comptes.COM2.id }, auth);
          assert.equal(commercial.status, 200, `${quoi}, commercial : ${JSON.stringify(commercial.body)}`);
          assert.equal((await ligne(chantier.id)).commercialId, comptes.COM2.id);
          assert.deepEqual((await journal(chantier.id)).map((e) => e.action), ['CHANGEMENT_TITULAIRE', 'CHANGEMENT_COMMERCIAL'], quoi);
        }
      }
      // Elle seule rouvre ; rouvert, le chantier est de nouveau modifiable par son titulaire.
      const chantier = await creerTermine();
      assert.equal((await changerStatut(chantier.id, { statut: 'EN_COURS' }, comptes.AD.auth)).status, 200);
      const res = await modifierFiche(chantier.id, { nom: 'TEST nom après réouverture 285' }, comptes.CT.auth);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await ligne(chantier.id)).nom, 'TEST nom après réouverture 285');
    });

    // Témoin de la règle : sur un chantier en cours, chaque titulaire hors administration modifie toujours sa fiche et
    // son commercial (cadrage, hors périmètre : rien d'autre ne change). Écarte un refus étendu à tout chantier.
    test('chantier en cours : chaque titulaire hors administration modifie toujours sa fiche et son commercial', async () => {
      for (const [cle] of TITULAIRES_HORS_ADMINISTRATION) {
        const chantier = await creerChantier({ responsableId: comptes[cle].id });
        const res = await modifierFiche(chantier.id, { nom: `TEST nom par ${cle} 285`, budgetMaterielVendu: '333.33', budgetMainOeuvreVendu: '444.44', heuresVendues: '55.5', dateFin: '31-10-2026', baremeReduit: true }, comptes[cle].auth);
        assert.equal(res.status, 200, `${cle} : ${JSON.stringify(res.body)}`);
        const relu = await ligne(chantier.id);
        assert.deepEqual([relu.nom, relu.budgetMaterielVendu.toString(), relu.budgetMainOeuvreVendu.toString(), relu.heuresVendues.toString(), relu.dateFin.toISOString(), relu.baremeReduit],
          [`TEST nom par ${cle} 285`, '333.33', '444.44', '55.5', '2026-10-31T00:00:00.000Z', true], cle);
        const commercial = await changerCommercial(chantier.id, { commercialId: comptes.COM2.id }, comptes[cle].auth);
        assert.equal(commercial.status, 200, `${cle}, commercial : ${JSON.stringify(commercial.body)}`);
        assert.equal((await ligne(chantier.id)).commercialId, comptes.COM2.id);
      }
    });

    // ------------------------------------------------------------------------------------------------------------------
    // Courses (cadrage, point 4 et critère « courses, sur le modèle de sousVerrouTiers »).
    // ------------------------------------------------------------------------------------------------------------------

    // Critère : « annulation contre encaissement, dans les deux ordres. Un encaissement validé pendant que l'annulation
    // attend : 409 à l'annulation. (…) Dans les deux cas, ni écriture ni journal. » Cadrage, point 2 : « encaisse est
    // relu après le verrou du chantier ». Écarte une lecture de la case avant le verrou (la requête l'aurait lue non
    // encaissée, puis aurait annulé un chantier encaissé).
    test('course : un encaissement validé pendant que l’annulation du devis attend la ligne du chantier fait refuser l’annulation (409), sans écriture ni journal', async () => {
      const { devis, chantierId, contratId } = await chantierConverti('course encaissement d’abord', { seconde: 'CONTRAT' });
      const course = await sousVerrou(chantierId, () => annulerDevis(devis.id), (tx) => tx.chantier.update({ where: { id: chantierId }, data: { encaisse: true, dateEncaissement: new Date('2026-10-21T10:00:00.000Z') } }));
      await courseRefusee(course, 409, REFUS.annulationEncaisse, 'annulation après un encaissement concurrent');
      const relu = await ligne(chantierId);
      assert.deepEqual([relu.statut, relu.encaisse], ['EN_COURS', true]);
      assert.equal((await prisma.devis.findUniqueOrThrow({ where: { id: devis.id } })).statut, 'ACCEPTE');
      assert.notEqual((await prisma.contratMaintenance.findUniqueOrThrow({ where: { id: contratId } })).statut, 'ANNULE');
      assert.equal((await journal(chantierId)).length, 0);
    });

    // Critère : « Une annulation validée pendant que l'encaissement attend : 409 à l'encaissement. » Cadrage, point 1 : « Le
    // statut est lu dans le SELECT … FOR UPDATE existant. » L'annulation est tenue par une transaction qui écrit le chantier
    // annulé, comme l'annulation du devis. Écarte une lecture du statut avant la transaction de l'encaissement.
    test('course : une annulation validée pendant que l’encaissement attend la ligne du chantier fait refuser l’encaissement (409), sans écriture ni journal', async () => {
      for (const [compte, auth] of ADMINISTRATION()) {
        const chantier = await creerChantier();
        const course = await sousVerrou(chantier.id, () => encaisser(chantier.id, { encaisse: true }, auth), (tx) => tx.chantier.update({ where: { id: chantier.id }, data: ANNULATION() }));
        await courseRefusee(course, 409, REFUS.encaissementAnnulee, `${compte}, encaissement après une annulation concurrente`);
        const relu = await ligne(chantier.id);
        assert.deepEqual([relu.statut, relu.encaisse, relu.dateEncaissement], ['ANNULE', false, null]);
        assert.equal((await journal(chantier.id)).length, 0);
      }
    });

    // Les deux requêtes réelles, lancées ensemble sur un même chantier : elles se suivent sur la ligne du chantier, et
    // l'une des deux est refusée, quel que soit l'ordre que le hasard leur donne. Jamais une affaire annulée et encaissée.
    test('course réelle : annulation du devis et encaissement lancés ensemble ; l’un passe, l’autre est refusé (409), jamais une affaire annulée et encaissée', async () => {
      const affaires = [];
      for (let i = 0; i < 6; i += 1) affaires.push(await chantierConverti(`course réelle ${i}`));
      const resultats = await Promise.all(affaires.map(async ({ devis, chantierId }, i) => {
        const [annulation, encaissement] = i % 2
          ? await Promise.all([annulerDevis(devis.id), encaisser(chantierId, { encaisse: true })])
          : (await Promise.all([encaisser(chantierId, { encaisse: true }), annulerDevis(devis.id)])).reverse();
        return { chantierId, annulation, encaissement };
      }));
      for (const { chantierId, annulation, encaissement } of resultats) {
        const relu = await ligne(chantierId);
        const quoi = `${annulation.status}/${encaissement.status} ${JSON.stringify([annulation.body.error, encaissement.body.error])}`;
        assert.ok(!(relu.statut === 'ANNULE' && relu.encaisse), `affaire annulée et encaissée : ${quoi}`);
        if (relu.statut === 'ANNULE') {
          assert.deepEqual([annulation.status, encaissement.status, encaissement.body.error, relu.encaisse], [200, 409, REFUS.encaissementAnnulee, false], quoi);
          assert.equal((await journal(chantierId)).length, 0, quoi);
        } else {
          assert.deepEqual([annulation.status, annulation.body.error, encaissement.status, relu.encaisse], [409, REFUS.annulationEncaisse, 200, true], quoi);
          assert.deepEqual((await journal(chantierId)).map((e) => e.action), ['CHANGEMENT_ENCAISSEMENT'], quoi);
        }
      }
    });

    // Critère : « sur la fiche, avec un corps « nom, budgets par poste et heures vendues », et non le seul titulaire :
    // changement de titulaire pendant l'attente (404), passage à ANNULE (409), passage à TERMINE (403) » ; cadrage, point
    // 4 : « la transaction commence, pour toute requête, par un seul SELECT … FOR UPDATE de la ligne (…) quels que soient
    // les champs envoyés ». Écarte une relecture limitée aux corps qui portent le client ou le titulaire, et la lecture
    // d'avant la transaction.
    test('course sur la fiche, corps « nom, budgets par poste et heures vendues » du titulaire : titulaire changé pendant l’attente (404), affaire annulée (409), chantier clôturé (403), sans écriture ni journal', async () => {
      const corps = { nom: 'TEST nom envoyé pendant la course 285', budgetMaterielVendu: '333.33', budgetMainOeuvreVendu: '444.44', heuresVendues: '55.5' };
      for (const [quoi, changement, statut, message] of [
        ['titulaire changé', { responsableId: comptes.CT2.id }, 404, REFUS.introuvable],
        ['affaire annulée', ANNULATION(), 409, REFUS.ficheAnnulee],
        ['chantier clôturé', { statut: 'TERMINE', dateFin: new Date('2026-10-30T00:00:00.000Z') }, 403, REFUS.ficheCloture],
      ]) {
        const chantier = await creerChantier();
        const course = await sousVerrou(chantier.id, () => modifierFiche(chantier.id, corps, comptes.CT.auth), (tx) => tx.chantier.update({ where: { id: chantier.id }, data: changement }));
        await courseRefusee(course, statut, message, `fiche du titulaire, ${quoi} pendant l’attente`);
        const relu = await ligne(chantier.id);
        assert.deepEqual([relu.nom, relu.budgetMaterielVendu.toString(), relu.heuresVendues.toString()], [chantier.nom, DEPART.budgetMaterielVendu, DEPART.heuresVendues], quoi);
        assert.equal((await journal(chantier.id)).length, 0, quoi);
      }
      // L'administration : une annulation pendant l'attente la refuse aussi (409) ; une clôture, non (témoin, 200).
      const annulee = await creerChantier();
      await courseRefusee(await sousVerrou(annulee.id, () => modifierFiche(annulee.id, corps), (tx) => tx.chantier.update({ where: { id: annulee.id }, data: ANNULATION() })), 409, REFUS.ficheAnnulee, 'fiche de l’administration, affaire annulée pendant l’attente');
      const close = await creerChantier();
      const { res } = await sousVerrou(close.id, () => modifierFiche(close.id, corps), (tx) => tx.chantier.update({ where: { id: close.id }, data: TERMINAISON }));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const relu = await ligne(close.id);
      assert.deepEqual([relu.statut, relu.nom, relu.heuresVendues.toString()], ['TERMINE', corps.nom, '55.5']);
    });

    // Critère : « sur le commercial : changement de titulaire (404), passage à ANNULE (409), passage à TERMINE (403) » ;
    // cadrage, point 4 : « le statut et le titulaire courant sont relus dans le SELECT … FOR UPDATE existant ». Écarte la
    // lecture d'avant la transaction.
    test('course sur le commercial du titulaire : titulaire changé pendant l’attente (404), affaire annulée (409), chantier clôturé (403), sans écriture ni journal', async () => {
      for (const [quoi, changement, statut, message] of [
        ['titulaire changé', { responsableId: comptes.CT2.id }, 404, REFUS.introuvable],
        ['affaire annulée', ANNULATION(), 409, REFUS.commercialAnnulee],
        ['chantier clôturé', { statut: 'TERMINE', dateFin: new Date('2026-10-30T00:00:00.000Z') }, 403, REFUS.commercialCloture],
      ]) {
        const chantier = await creerChantier();
        const course = await sousVerrou(chantier.id, () => changerCommercial(chantier.id, { commercialId: comptes.COM2.id }, comptes.CT.auth), (tx) => tx.chantier.update({ where: { id: chantier.id }, data: changement }));
        await courseRefusee(course, statut, message, `commercial du titulaire, ${quoi} pendant l’attente`);
        assert.equal((await ligne(chantier.id)).commercialId, comptes.COM.id, quoi);
        assert.equal((await journal(chantier.id)).length, 0, quoi);
      }
      const annulee = await creerChantier();
      await courseRefusee(await sousVerrou(annulee.id, () => changerCommercial(annulee.id, { commercialId: comptes.COM2.id }), (tx) => tx.chantier.update({ where: { id: annulee.id }, data: ANNULATION() })), 409, REFUS.commercialAnnulee, 'commercial de l’administration, affaire annulée pendant l’attente');
    });

    // Critère : « clôture contre annulation du devis : 409, et le chantier reste ANNULE » ; cadrage, point 2 bis :
    // « PATCH /api/chantiers/:id/statut relit le statut sous le verrou de la ligne, dans une transaction (#345, note N3).
    // Une affaire annulée pendant l'attente reçoit 409 « Cette affaire est annulée : son statut ne change plus. », au lieu
    // de finir terminée avec une date d'annulation. » Clôture par le titulaire et par l'administration, réouverture par
    // l'administration. Écarte la lecture d'avant la transaction.
    test('course : clôture ou réouverture pendant l’annulation de l’affaire : 409, le chantier reste ANNULE, sans date de fin ni journal', async () => {
      for (const [quoi, depart, statutEnvoye, auth] of [
        ['clôture par le titulaire', {}, 'TERMINE', () => comptes.CT.auth],
        ['clôture par l’administration', {}, 'TERMINE', () => admin()],
        ['réouverture par l’administration', TERMINAISON, 'EN_COURS', () => comptes.AD.auth],
      ]) {
        const chantier = await creerChantier(depart);
        const course = await sousVerrou(chantier.id, () => changerStatut(chantier.id, { statut: statutEnvoye }, auth()), (tx) => tx.chantier.update({ where: { id: chantier.id }, data: ANNULATION() }));
        await courseRefusee(course, 409, REFUS.statutAnnulee, `${quoi}, affaire annulée pendant l’attente`);
        const relu = await ligne(chantier.id);
        assert.deepEqual([relu.statut, relu.dateFin?.toISOString() ?? null, relu.motifAnnulation], ['ANNULE', depart.dateFin?.toISOString() ?? null, 'TEST annulation posée en base'], quoi);
        assert.equal((await journal(chantier.id)).length, 0, quoi);
      }
      // Témoin : sans annulation concurrente, la clôture du titulaire passe et pose la date de fin.
      const temoin = await creerChantier();
      assert.equal((await changerStatut(temoin.id, { statut: 'TERMINE' }, comptes.CT.auth)).status, 200);
      const relu = await ligne(temoin.id);
      assert.equal(relu.statut, 'TERMINE');
      assert.ok(relu.dateFin);
    });

    // Mois du CA et de la marge validés (commissions/metier.ts, dateClotureChantier) : la clôture date le chantier du jour
    // de la société, « si elle n'a pas déjà été saisie à la main » (PATCH /api/chantiers/:id/statut). Le correctif relit
    // cette date sous le verrou de la ligne, avec le statut : une date de fin saisie avant la clôture, ou pendant son
    // attente (fiche modifiée par le titulaire ou l'administration), est gardée. Écarte une clôture qui écrase toujours
    // la date de fin (mutant A8 de l'audit des montants) et une date de fin lue avant le verrou, comme avant le correctif
    // (mutant A7). La date saisie est antérieure au jour de tout passage : elle ne peut pas se confondre avec lui.
    test('clôture : une date de fin déjà saisie est gardée, y compris saisie pendant l’attente de la clôture (relue sous le verrou) ; le mois du CA validé ne bouge pas', async () => {
      const SAISIE = new Date('2025-12-15T00:00:00.000Z');
      for (const [quoi, auth] of [['titulaire', () => comptes.CT.auth], ['administration', () => admin()]]) {
        const avant = await creerChantier({ dateFin: SAISIE });
        const cloture = await changerStatut(avant.id, { statut: 'TERMINE' }, auth());
        assert.equal(cloture.status, 200, `${quoi} : ${JSON.stringify(cloture.body)}`);
        let relu = await ligne(avant.id);
        assert.deepEqual([relu.statut, relu.dateFin.toISOString()], ['TERMINE', SAISIE.toISOString()], `${quoi}, date de fin saisie avant la clôture`);
        const pendant = await creerChantier();
        const { res } = await sousVerrou(pendant.id, () => changerStatut(pendant.id, { statut: 'TERMINE' }, auth()), (tx) => tx.chantier.update({ where: { id: pendant.id }, data: { dateFin: SAISIE } }));
        assert.equal(res.status, 200, `${quoi} : ${JSON.stringify(res.body)}`);
        relu = await ligne(pendant.id);
        assert.deepEqual([relu.statut, relu.dateFin.toISOString()], ['TERMINE', SAISIE.toISOString()], `${quoi}, date de fin saisie pendant l’attente de la clôture`);
      }
      // Témoin : sans date saisie, la clôture pose une date de fin, distincte de la date saisie plus haut.
      const sansDate = await creerChantier();
      assert.equal((await changerStatut(sansDate.id, { statut: 'TERMINE' }, comptes.CT.auth)).status, 200);
      const relu = await ligne(sansDate.id);
      assert.ok(relu.dateFin && relu.dateFin.toISOString() !== SAISIE.toISOString(), 'date de fin posée à la clôture');
    });

    // Décision « A. Non, admin seule » : un chantier clôturé pendant que son titulaire le clôture aussi ne reçoit plus
    // rien de lui. Relue sous le verrou, la règle « seul un administrateur rouvre un chantier clôturé » vaut pour tout
    // chantier qui n'est plus en cours, et pas seulement pour une affaire annulée : sans elle, la clôture du titulaire
    // écrirait le chantier terminé, dont sa date de fin, mois du CA validé, quand elle est vide (clôture par la fiche,
    // réservée à l'administration). Écarte une relecture limitée à l'affaire annulée (mutant A9 de l'audit des montants).
    test('course : chantier clôturé pendant l’attente de la clôture de son titulaire : 403, sans écriture ni date de fin', async () => {
      const chantier = await creerChantier();
      const course = await sousVerrou(chantier.id, () => changerStatut(chantier.id, { statut: 'TERMINE' }, comptes.CT.auth), (tx) => tx.chantier.update({ where: { id: chantier.id }, data: { statut: 'TERMINE' } }));
      await courseRefusee(course, 403, 'Seul un administrateur peut réouvrir un chantier clôturé.', 'clôture du titulaire, chantier clôturé pendant l’attente');
      const relu = await ligne(chantier.id);
      assert.deepEqual([relu.statut, relu.dateFin], ['TERMINE', null]);
      assert.equal((await journal(chantier.id)).length, 0);
    });

    // Note N1 de l'audit des droits de #449 (défaut préexistant, hors du cadrage, signalé par le corps de la PR) : la clôture
    // relit le titulaire sous le verrou de la ligne, comme la fiche et le commercial (#285, point 1). Un ancien titulaire,
    // ou le responsable de la branche d'un technicien qui n'est plus titulaire, ne clôture plus l'affaire réattribuée
    // pendant l'attente (404, sans écriture ni journal) ; le directeur, qui clôture tout chantier en cours, si (témoin).
    test('course : clôture par un compte qui n’en a plus le droit, titulaire changé pendant l’attente : 404, sans écriture ni journal ; le directeur clôture toujours', async () => {
      const technicien = await creerCompte('TECHNICIEN', 'TECH-BRANCHE', { responsableHierarchiqueId: comptes.RESP.id });
      for (const [quoi, depart, auth] of [
        ['ancien titulaire', {}, () => comptes.CT.auth],
        ['responsable de la branche de l’ancien titulaire technicien', { responsableId: technicien.id }, () => comptes.RESP.auth],
      ]) {
        const chantier = await creerChantier(depart);
        const course = await sousVerrou(chantier.id, () => changerStatut(chantier.id, { statut: 'TERMINE' }, auth()), (tx) => tx.chantier.update({ where: { id: chantier.id }, data: { responsableId: comptes.CT2.id } }));
        await courseRefusee(course, 404, REFUS.introuvable, `clôture par le ${quoi}, titulaire changé pendant l’attente`);
        const relu = await ligne(chantier.id);
        assert.deepEqual([relu.statut, relu.dateFin, relu.responsableId], ['EN_COURS', null, comptes.CT2.id], quoi);
        assert.equal((await journal(chantier.id)).length, 0, quoi);
      }
      const temoin = await creerChantier();
      const { res } = await sousVerrou(temoin.id, () => changerStatut(temoin.id, { statut: 'TERMINE' }, comptes.DIR.auth), (tx) => tx.chantier.update({ where: { id: temoin.id }, data: { responsableId: comptes.CT2.id } }));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await ligne(temoin.id)).statut, 'TERMINE');
    });

    // #451 : quand le titulaire change pendant l'attente, le droit de clôturer, donc de poser la date de fin (mois du CA
    // validé, commissions/metier.ts), est refait « avec le rôle du nouveau titulaire » (corps de la PR #453). Le
    // responsable de la branche d'un technicien clôture l'affaire confiée pendant l'attente à un autre technicien de sa
    // branche (200, date de fin posée), mais plus celle confiée à un conducteur de sa branche, que seul ce conducteur
    // clôture (404, sans écriture ni journal). Écarte un droit refait sans les tiers hors directeur (mutant B3 de l'audit
    // des montants de #453) et un droit refait avec le rôle de l'ancien titulaire, lu avant le verrou (mutant B4).
    test('course : responsable de branche, titulaire changé pendant l’attente : le droit de clôturer est refait avec le rôle du nouveau titulaire', async () => {
      const technicien = await creerCompte('TECHNICIEN', 'TECH-BRANCHE-A', { responsableHierarchiqueId: comptes.RESP.id });
      const autreTechnicien = await creerCompte('TECHNICIEN', 'TECH-BRANCHE-B', { responsableHierarchiqueId: comptes.RESP.id });
      const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'CT-BRANCHE', { responsableHierarchiqueId: comptes.RESP.id });
      const confie = await creerChantier({ responsableId: technicien.id });
      const { res } = await sousVerrou(confie.id, () => changerStatut(confie.id, { statut: 'TERMINE' }, comptes.RESP.auth), (tx) => tx.chantier.update({ where: { id: confie.id }, data: { responsableId: autreTechnicien.id } }));
      assert.equal(res.status, 200, `confiée à un autre technicien de la branche : ${JSON.stringify(res.body)}`);
      const close = await ligne(confie.id);
      assert.deepEqual([close.statut, close.responsableId, !!close.dateFin], ['TERMINE', autreTechnicien.id, true], 'confiée à un autre technicien de la branche');
      const chantier = await creerChantier({ responsableId: technicien.id });
      const course = await sousVerrou(chantier.id, () => changerStatut(chantier.id, { statut: 'TERMINE' }, comptes.RESP.auth), (tx) => tx.chantier.update({ where: { id: chantier.id }, data: { responsableId: conducteur.id } }));
      await courseRefusee(course, 404, REFUS.introuvable, 'clôture par le responsable de branche, affaire confiée pendant l’attente à un conducteur de sa branche');
      const relu = await ligne(chantier.id);
      assert.deepEqual([relu.statut, relu.dateFin, relu.responsableId], ['EN_COURS', null, conducteur.id]);
      assert.equal((await journal(chantier.id)).length, 0);
    });

    // Audit des droits de #453 : cas limites du droit de clôturer relu sous le verrou. Refus (404, sans écriture ni date
    // de fin) : chantier laissé sans titulaire ; technicien de la branche du responsable remplacé par un conducteur de
    // cette branche (le responsable ne clôture, en tiers, que l'affaire d'un technicien) ; affaire d'un conducteur confiée
    // à un technicien dont il est le N+1 (lecture retenue : un conducteur ne clôture que l'affaire dont il est chargé). Un
    // titulaire et un statut changés ensemble rendent 404 avant 409 ou 403, sans rien révéler du statut. Écarte un
    // contrôle sauté quand le chantier n'a plus de titulaire, le rôle de l'ancien titulaire relu à la place de celui du
    // nouveau, et un contrôle du titulaire placé après celui du statut.
    test('course : clôture, titulaire changé pendant l’attente, cas limites refusés : 404 avant le statut, sans écriture ni date de fin', async () => {
      const techBranche = await creerCompte('TECHNICIEN', 'TECH-BRANCHE-A', { responsableHierarchiqueId: comptes.RESP.id });
      const ctBranche = await creerCompte('CONDUCTEUR_TRAVAUX', 'CT-BRANCHE', { responsableHierarchiqueId: comptes.RESP.id });
      const techDuCt = await creerCompte('TECHNICIEN', 'TECH-CT', { responsableHierarchiqueId: comptes.CT.id });
      for (const [quoi, depart, auth, changement] of [
        ['ancien titulaire, chantier laissé sans titulaire', {}, () => comptes.CT.auth, () => ({ responsableId: null })],
        ['responsable, technicien de sa branche remplacé par aucun titulaire', { responsableId: techBranche.id }, () => comptes.RESP.auth, () => ({ responsableId: null })],
        ['responsable, technicien de sa branche remplacé par un conducteur de sa branche', { responsableId: techBranche.id }, () => comptes.RESP.auth, () => ({ responsableId: ctBranche.id })],
        ['conducteur, son affaire confiée à un technicien dont il est le N+1', {}, () => comptes.CT.auth, () => ({ responsableId: techDuCt.id })],
        ['ancien titulaire, affaire aussi annulée', {}, () => comptes.CT.auth, () => ({ responsableId: comptes.CT2.id, ...ANNULATION() })],
        ['ancien titulaire, chantier aussi clôturé', {}, () => comptes.CT.auth, () => ({ responsableId: comptes.CT2.id, statut: 'TERMINE' })],
      ]) {
        const chantier = await creerChantier(depart);
        const course = await sousVerrou(chantier.id, () => changerStatut(chantier.id, { statut: 'TERMINE' }, auth()), (tx) => tx.chantier.update({ where: { id: chantier.id }, data: changement() }));
        await courseRefusee(course, 404, REFUS.introuvable, `clôture par le ${quoi}`);
        const relu = await ligne(chantier.id);
        assert.deepEqual([relu.responsableId, relu.dateFin], [changement().responsableId, null], quoi);
        assert.equal((await journal(chantier.id)).length, 0, quoi);
      }
    });

    // Cas limites admis : relu sous le verrou, le droit de clôturer suit le nouveau titulaire sans rien retirer à qui le
    // garde. Le responsable clôture l'affaire de son technicien qui lui est confiée pendant l'attente, celle qui passe à
    // un autre technicien de sa branche, et la sienne confiée à un technicien de sa branche ; le directeur clôture un
    // chantier laissé sans titulaire. Écarte un contrôle qui ne lit pas le rôle du nouveau titulaire, ou qui refuse tout
    // changement de titulaire hors direction. La date de fin posée n'est pas comparée au jour : le test n'en dépend pas.
    test('course : clôture, titulaire changé pendant l’attente, droit gardé : 200, chantier terminé et daté', async () => {
      const tech1 = await creerCompte('TECHNICIEN', 'TECH-BRANCHE-B1', { responsableHierarchiqueId: comptes.RESP.id });
      const tech2 = await creerCompte('TECHNICIEN', 'TECH-BRANCHE-B2', { responsableHierarchiqueId: comptes.RESP.id });
      for (const [quoi, depart, auth, nouveau] of [
        ['responsable, l’affaire de son technicien lui est confiée', { responsableId: tech1.id }, () => comptes.RESP.auth, () => comptes.RESP.id],
        ['responsable, l’affaire de son technicien passe à un autre technicien de sa branche', { responsableId: tech1.id }, () => comptes.RESP.auth, () => tech2.id],
        ['responsable, son affaire passe à un technicien de sa branche', { responsableId: comptes.RESP.id }, () => comptes.RESP.auth, () => tech1.id],
        ['directeur, chantier laissé sans titulaire', {}, () => comptes.DIR.auth, () => null],
      ]) {
        const chantier = await creerChantier(depart);
        const { res } = await sousVerrou(chantier.id, () => changerStatut(chantier.id, { statut: 'TERMINE' }, auth()), (tx) => tx.chantier.update({ where: { id: chantier.id }, data: { responsableId: nouveau() } }));
        assert.equal(res.status, 200, `${quoi} : ${JSON.stringify(res.body)}`);
        const relu = await ligne(chantier.id);
        assert.deepEqual([relu.statut, relu.responsableId, relu.dateFin instanceof Date], ['TERMINE', nouveau(), true], quoi);
      }
    });

    // Verrous : le rôle du nouveau titulaire est relu par une lecture simple, qui n'attend aucun verrou de son compte. Un
    // compte tenu par une écriture en cours (FOR NO KEY UPDATE, comme le changement de son type) ne retient pas la
    // clôture, qui garde la ligne du chantier : aucune attente croisée avec une route qui tiendrait le compte puis
    // attendrait le chantier. Écarte une lecture verrouillante (FOR SHARE ou FOR UPDATE) du compte sous le verrou.
    test('course : clôture, titulaire changé pendant l’attente, compte du nouveau titulaire tenu par une écriture : la clôture ne l’attend pas', async () => {
      const chantier = await creerChantier();
      let liberer; const fin = new Promise((r) => { liberer = r; });
      let tenu; const pose = new Promise((r) => { tenu = r; });
      const ecriture = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${comptes.CT2.id} FOR NO KEY UPDATE`;
        tenu();
        await fin;
      }, { timeout: 30_000, maxWait: 10_000 });
      await pose;
      try {
        const { res } = await sousVerrou(chantier.id, () => changerStatut(chantier.id, { statut: 'TERMINE' }, comptes.DIR.auth), (tx) => tx.chantier.update({ where: { id: chantier.id }, data: { responsableId: comptes.CT2.id } }));
        assert.equal(res.status, 200, JSON.stringify(res.body));
      } finally {
        liberer();
        await ecriture;
      }
      assert.equal((await ligne(chantier.id)).statut, 'TERMINE');
    });

    // Point 2 bis, par le chemin réel : l'annulation du devis d'un chantier clôturé non encaissé passe ; la clôture
    // ou la réouverture de cette affaire annulée sont ensuite refusées (409), sans écriture.
    test('affaire annulée par son devis : ni clôture, ni réouverture, ni fiche, ni commercial, ni encaissement ; chacun 409 sans écriture', async () => {
      const { devis, chantierId } = await chantierConverti('affaire close');
      await ok(changerStatut(chantierId, { statut: 'TERMINE' }));
      await ok(annulerDevis(devis.id));
      assert.equal((await ligne(chantierId)).statut, 'ANNULE');
      await refuse(() => changerStatut(chantierId, { statut: 'EN_COURS' }), 409, REFUS.statutAnnulee, 'réouverture', chantierId);
      await refuse(() => changerStatut(chantierId, { statut: 'TERMINE' }), 409, REFUS.statutAnnulee, 'clôture', chantierId);
      await refuse(() => modifierFiche(chantierId, { nom: 'TEST nom d’une affaire annulée' }), 409, REFUS.ficheAnnulee, 'fiche', chantierId);
      await refuse(() => changerCommercial(chantierId, { commercialId: comptes.COM2.id }), 409, REFUS.commercialAnnulee, 'commercial', chantierId);
      await refuse(() => encaisser(chantierId, { encaisse: true }), 409, REFUS.encaissementAnnulee, 'encaissement', chantierId);
    });
  });
}
