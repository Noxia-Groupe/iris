// Lot 6a-4d : envoi du compte rendu d'intervention et du contrat de maintenance par la messagerie de
// l'utilisateur (cadrage du lot 6a-4, version 4 du 31-10-2026, section « 6a-4d » ; décisions de Nelson
// du 22-10-2026, point 4, « Tous type de document », et repli « du style mailto » ; du 31-10-2026, « le
// prochain lot est la fin du lot 6 »). Sur le modèle du lot 6a-3 (api.test.mjs, « Lot 6a-3 : envoi d’un
// devis ou d’une facture par la messagerie, journal des envois »).
//
// Fichier propre au lot (remarque N8 du contrôle de cohérence) : rien n'est ajouté à api.test.mjs.
// `node --test` exécute les fichiers en parallèle, et api.test.mjs, qui tourne en même temps sur
// TEST_DATABASE_URL, purge les données « TEST » et change l'identité de la société en cours de route.
// Ce fichier crée donc, sur le même serveur PostgreSQL, une base jetable qui n'appartient qu'à lui, la
// migre, la sert à l'application montée en mémoire, puis la supprime ; TEST_DATABASE_URL ne sert que de
// connexion administrative. Sans elle, il s'annonce ignoré : un SKIP n'est pas une réussite.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import { PDFParse } from 'pdf-parse';

const TITRE = 'Lot 6a-4d : envoi du compte rendu d’intervention et du contrat de maintenance par la messagerie';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const dossierServeur = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dossierPrisma = resolve(dossierServeur, 'prisma');
const binairePrisma = resolve(dossierServeur, 'node_modules/.bin/prisma');
// Dernière migration de `main` (4e0a903) avant ce lot : celles qui la suivent sont celles de la PR.
const DERNIERE_MIGRATION_MAIN = '20261030230000_forfait_main_oeuvre_devis';
// Migration de ce lot. Celle du lot 6a-4e (20261031200000_journal_envois_rapport_chantier), qui la suit et porte la
// contrainte à cinq colonnes, est prouvée par envoi-rapport-chantier.test.mjs : ce fichier rejoue la sienne seule.
const MIGRATION_DU_LOT = '20261031120000_journal_envois_compte_rendu_contrat';

// Objet et texte du cadrage (« Objet et texte », choix par défaut, à confirmer), mot pour mot :
// apostrophe typographique (’) et tiret demi-cadratin (–), comme ceux du lot 6a-3 validés par Nelson.
const objetCompteRendu = (reference, raisonSociale) => `Compte rendu d’intervention ${reference} – ${raisonSociale}`;
const corpsCompteRendu = (reference, raisonSociale) => `Bonjour,\n\nVeuillez trouver ci-joint le compte rendu de l’intervention ${reference}.\n\nCordialement,\n${raisonSociale}`;
const objetContrat = (intitule, raisonSociale) => `Contrat de maintenance ${intitule} – ${raisonSociale}`;
const corpsContrat = (intitule, raisonSociale) => `Bonjour,\n\nVeuillez trouver ci-joint le récapitulatif de votre contrat de maintenance ${intitule}.\n\nCordialement,\n${raisonSociale}`;
// Refus du cadrage, mot pour mot.
const AUCUN_COMPTE_RENDU = 'Aucun compte rendu à envoyer.';
const INTERVENTION_ANNULEE = 'Une intervention annulée ne s’envoie pas.';
const CONTRAT_ANNULE = 'Un contrat annulé ne s’envoie pas.';
const identiteIncomplete = (champs, document) => `Identité de la société incomplète : renseignez ${champs} dans l’écran Société avant d’envoyer ${document}.`;
// Lot 6a-3, inchangés : validerDestinataire et les champs exposés d'un envoi.
const REFUS_DESTINATAIRE = 'Adresse du destinataire invalide : indiquez une seule adresse électronique, de la forme nom@domaine.fr.';
const CHAMPS_ENVOI = ['auteurNom', 'canal', 'createdAt', 'destinataire', 'id', 'objet'];
const TOUS_LES_SCOPES = ['clients:read', 'clients:write', 'catalogue:read', 'catalogue:write', 'equipements:read', 'equipements:write', 'devis:read', 'devis:write', 'company:read', 'chantiers:read', 'chantiers:write', 'chantiers:archive', 'finances:read'];

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const source = new URL(TEST_DATABASE_URL);
    // « test » comme mot (règle de client/scripts/base-jetable.mjs) et un suffixe tiré au hasard.
    const nomBase = `iris_test_envoi6a4d_${randomBytes(6).toString('hex')}`;
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
    const jetonDe = (compte) => jwt.sign({ id: compte.id }, process.env.JWT_SECRET);
    const parCompte = (compte) => entete(jetonDe(compte));
    let rang = 0;
    const suffixe = () => `${Date.now()}${(rang += 1)}`;

    // Identité de la société, complète.
    const SOCIETE = {
      raisonSociale: 'TEST Émetteur envoi 6a4d', nomCommercial: '', siret: '77777777700077', tvaIntra: '',
      adresse: '7 rue de l’Envoi', codePostal: '14000', ville: 'Caen', pays: 'France', telephone: '02 31 00 00 07',
      email: 'emetteur-6a4d@iris.test', siteWeb: '', piedFacture: 'TEST Pied 6a4d', fuseauHoraire: 'Europe/Paris',
    };

    // --- Aides HTTP ---
    const appeler = (methode, chemin, corps, auth = admin()) => {
      const requete = request(app)[methode](`/api${chemin}`);
      const avecAuth = auth ? requete.set(auth) : requete;
      return methode === 'get' ? avecAuth : avecAuth.send(corps ?? {});
    };
    const ok = async (reponse, statut = 200) => {
      const res = await reponse;
      assert.equal(res.status, statut, `${res.req?.method} ${res.req?.path} : ${JSON.stringify(res.body)}`);
      return res.body;
    };
    const cheminCompteRendu = (id) => `/interventions/${id}`;
    const cheminContrat = (id) => `/contrats-maintenance/${id}`;
    const lire = (chemin, auth = admin()) => appeler('get', `${chemin}/envois`, null, auth);
    const envoyer = (chemin, destinataire, auth = admin()) => appeler('post', `${chemin}/envois`, { destinataire }, auth);
    const definirSociete = async (champs) => ok(appeler('put', '/company', champs));

    // --- Données ---
    const creerCompte = (role, cle, s, extra = {}) => prisma.user.create({ data: { email: `envoi6a4d.${cle}.${s}@iris.test`, name: `TEST ${cle} ${s}`, role, ...extra } });
    // Technicien : un compte et sa fiche d'intervenant reliée.
    const compteTechnicien = async (cle, s) => {
      const compte = await prisma.user.create({ data: { email: `envoi6a4d.technicien.${cle}.${s}@iris.test`, name: `TEST Technicien ${cle} ${s}`, role: 'TECHNICIEN' } });
      const intervenant = await prisma.intervenant.create({ data: { nom: `TEST Intervenant ${cle} ${s}`, role: 'Technicien', tauxHoraireCharge: 40, userId: compte.id } });
      return { compte, intervenantId: intervenant.id };
    };
    // Client professionnel identifié (lot 6a-2 bis : un devis ne se signe que pour lui) : SIREN libre,
    // site de facturation ; courriel de la fiche si donné.
    const creerClient = async (raisonSociale, { email } = {}) => {
      let client;
      for (let essai = 1; ; essai += 1) {
        const res = await appeler('post', '/clients', { raisonSociale, siren: String(randomInt(100_000_000, 1_000_000_000)), ...(email ? { email } : {}) });
        if (res.status === 409 && essai < 5) continue;
        assert.equal(res.status, 201, JSON.stringify(res.body));
        client = res.body;
        break;
      }
      await ok(appeler('post', `/clients/${client.id}/sites`, { nom: 'TEST Facturation 6a4d', adresse: '8 rue du Destinataire', codePostal: '75003', ville: 'Paris', estSiteFacturation: true }), 201);
      return client;
    };
    const ajouterContact = (clientId, donnees) => ok(appeler('post', `/clients/${clientId}/contacts`, donnees), 201);
    const creerIntervention = (donnees) => ok(appeler('post', '/interventions', donnees), 201);
    const changerStatut = (id, statut, extra = {}) => ok(appeler('patch', `/interventions/${id}/statut`, { statut, ...extra }));
    const planifier = (id, intervenantIds) => ok(appeler('put', `/interventions/${id}/planning`, { dateDebut: new Date().toISOString().slice(0, 10), creneau: 'JOURNEE', intervenantIds }));
    const demarrer = async (id) => {
      const { statut } = await prisma.intervention.findUniqueOrThrow({ where: { id }, select: { statut: true } });
      if (statut === 'A_PLANIFIER') await changerStatut(id, 'PLANIFIEE');
      await changerStatut(id, 'EN_COURS');
    };
    const ajouterCompteRendu = (id, contenu) => ok(appeler('post', `/interventions/${id}/rapports`, { contenu, cleEnvoi: randomUUID() }), 201);
    // Intervention en cours, avec un compte rendu si un texte est donné.
    const interventionEnCours = async (clientId, titre, compteRendu, extra = {}) => {
      const intervention = await creerIntervention({ clientId, titre, ...extra });
      await demarrer(intervention.id);
      if (compteRendu) await ajouterCompteRendu(intervention.id, compteRendu);
      return intervention;
    };
    const annulerIntervention = (id) => changerStatut(id, 'ANNULEE', { motif: 'TEST motif d’annulation 6a4d' });
    const creerContrat = (clientId, titre, extra = {}) => ok(appeler('post', '/contrats-maintenance', { clientId, titre, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-10-2030', ...extra }), 201);
    const statutContrat = (id, statut) => ok(appeler('patch', `/contrats-maintenance/${id}/statut`, { statut, motif: `TEST motif ${statut} 6a4d` }));
    // Contrat issu d'un devis signé : seul un tel contrat s'annule, avec son devis (lot 4 suite).
    const contratDeDevis = async (clientId, titre) => {
      const devis = await ok(appeler('post', '/devis', { clientId, objet: `TEST Devis de ${titre}`, lignes: [{ designation: 'TEST Visite annuelle', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }), 201);
      await ok(appeler('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' }));
      await ok(appeler('post', `/devis/${devis.id}/signature`, { signataire: 'TEST Signataire 6a4d', confirme: true }), 201);
      const contrat = await ok(appeler('post', `/devis/${devis.id}/convertir`, { cible: 'CONTRAT', titre, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-11-2030' }), 201);
      const annuler = async () => {
        await ok(appeler('post', `/devis/${devis.id}/annulation`, { motif: 'TEST annulation du devis du contrat 6a4d' }));
        assert.equal((await prisma.contratMaintenance.findUniqueOrThrow({ where: { id: contrat.id } })).statut, 'ANNULE');
      };
      return { devis, contrat, annuler };
    };

    // --- État de la base : un refus n'écrit rien, un envoi n'écrit que sa ligne du journal ---
    const etatBase = async () => ({
      envois: await prisma.envoiDocument.findMany({ orderBy: { id: 'asc' } }),
      interventions: await prisma.intervention.findMany({ orderBy: { id: 'asc' } }),
      contrats: await prisma.contratMaintenance.findMany({ orderBy: { id: 'asc' } }),
      rapports: await prisma.interventionRapport.count(),
      journalSaisies: await prisma.journalSaisieChantier.count(),
      journalAdministration: await prisma.journalAdministration.count(),
      societe: await prisma.companySettings.findUnique({ where: { id: 'singleton' } }),
    });
    // Un appel refusé (ou une lecture) : le statut attendu, le message s'il est donné, rien d'écrit.
    const sansEcriture = async (appel, statut, contexte, message) => {
      const avant = await etatBase();
      const res = await appel();
      assert.equal(res.status, statut, `${contexte} : ${res.status} ${JSON.stringify(res.body)}`);
      if (message !== undefined) assert.equal(res.body.error, message, contexte);
      assert.deepEqual(await etatBase(), avant, `${contexte} : rien n’est écrit`);
      return res;
    };
    // Un enregistrement accepté : 201, une seule ligne ajoutée au journal, celle de la réponse ; ni
    // intervention ni contrat modifiés (« Envoyer ne change aucun statut »).
    const enregistre = async (appel, contexte) => {
      const avant = await etatBase();
      const res = await appel();
      assert.equal(res.status, 201, `${contexte} : ${res.status} ${JSON.stringify(res.body)}`);
      const apres = await etatBase();
      const nouvelles = apres.envois.filter((ligne) => !avant.envois.some((ancienne) => ancienne.id === ligne.id));
      assert.deepEqual(nouvelles.map((ligne) => ligne.id), [res.body.envoi.id], `${contexte} : une seule ligne au journal`);
      assert.deepEqual(apres.envois.filter((ligne) => ligne.id !== res.body.envoi.id), avant.envois, `${contexte} : le journal existant est intact`);
      assert.deepEqual(apres.interventions, avant.interventions, `${contexte} : aucune intervention modifiée`);
      assert.deepEqual(apres.contrats, avant.contrats, `${contexte} : aucun contrat modifié`);
      return { res, ligne: nouvelles[0] };
    };
    // Texte extrait d'un PDF.
    const textePdf = async (chemin) => {
      const res = await request(app).get(`/api${chemin}/document.pdf`).set(admin()).buffer(true)
        .parse((reponse, fin) => { const morceaux = []; reponse.on('data', (m) => morceaux.push(m)); reponse.on('end', () => fin(null, Buffer.concat(morceaux))); });
      assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
      assert.equal(res.headers['content-type'], 'application/pdf');
      const lecteur = new PDFParse({ data: res.body });
      try { return (await lecteur.getText()).text.replace(/\s+/g, ' '); } finally { await lecteur.destroy(); }
    };
    // Le verrou tenu par une transaction : attend que la requête lancée s'y bloque.
    const attendreBlocage = async (pidTenant) => {
      for (let essai = 0; essai < 1000; essai++) {
        const [{ n }] = await prisma.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pidTenant}::int = ANY(pg_blocking_pids(pid))`;
        if (n > 0) return true;
        await new Promise((resolveAttente) => setTimeout(resolveAttente, 20));
      }
      return false;
    };

    before(async () => {
      assert.ok(['127.0.0.1', 'localhost'].includes(source.hostname), 'seul un PostgreSQL local est autorisé');
      assert.notEqual(source.pathname.slice(1), nomBase);
      await administrationPg.connect();
      await administrationPg.query(`CREATE DATABASE "${nomBase}"`);
      baseCreee = true;
      execFileSync(binairePrisma, ['migrate', 'deploy', '--schema', resolve(dossierPrisma, 'schema.prisma')], {
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
      secours = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' }, select: { id: true, name: true } });
      assert.ok(secours.name.trim(), 'le compte de secours porte un nom');
      await definirSociete(SOCIETE);
    });

    after(async () => {
      await prisma?.$disconnect().catch(() => {});
      await appPrisma?.$disconnect().catch(() => {});
      if (baseCreee) await administrationPg.query(`DROP DATABASE IF EXISTS "${nomBase}" WITH (FORCE)`);
      await administrationPg.end().catch(() => {});
    });

    // ------------------------------------------------------------------------------------------------
    // Lecture : proposition, objet et texte, journal.
    // ------------------------------------------------------------------------------------------------

    // Cadrage, « Destinataire proposé » : la règle du lot 6a-3, inchangée (propositionDestinataire) : le
    // courriel du contact principal du client, sinon celui de la fiche client, sinon rien (choix par
    // défaut, à confirmer). Lecture écartée (« non retenue ») : le courriel du contact de l'intervention
    // d'abord ; chaque cas donne un courriel à ce contact pour que cette lecture se distingue.
    test('compte rendu, lecture : contact principal, sinon fiche client, sinon rien, jamais le contact de l’intervention ; objet et texte mot pour mot ; journal vide', async () => {
      const s = suffixe();
      // Contact principal avec courriel : il l'emporte sur la fiche et sur le contact de l'intervention.
      const avecPrincipal = await creerClient(`TEST Client CR principal ${s}`, { email: 'fiche@client-6a4d.test' });
      await ajouterContact(avecPrincipal.id, { nom: 'TEST Principal', email: 'principal@client-6a4d.test', principal: true });
      const contactA = await ajouterContact(avecPrincipal.id, { nom: 'TEST Contact de la demande', email: 'demande@client-6a4d.test' });
      const interventionA = await interventionEnCours(avecPrincipal.id, `TEST Demande A ${s}`, 'TEST Compte rendu A.', { contactId: contactA.id });
      const luA = await sansEcriture(() => lire(cheminCompteRendu(interventionA.id)), 200, 'lecture A');
      assert.deepEqual(luA.body, {
        proposition: { destinataire: 'principal@client-6a4d.test', objet: objetCompteRendu(interventionA.reference, SOCIETE.raisonSociale), corps: corpsCompteRendu(interventionA.reference, SOCIETE.raisonSociale) },
        envois: [],
      });
      // Contact principal sans courriel : la fiche client, et non le contact de l'intervention.
      const repli = await creerClient(`TEST Client CR fiche ${s}`, { email: 'fiche@client-6a4d.test' });
      await ajouterContact(repli.id, { nom: 'TEST Principal sans courriel', principal: true });
      const contactB = await ajouterContact(repli.id, { nom: 'TEST Contact de la demande', email: 'demande@client-6a4d.test' });
      const interventionB = await interventionEnCours(repli.id, `TEST Demande B ${s}`, 'TEST Compte rendu B.', { contactId: contactB.id });
      assert.equal((await lire(cheminCompteRendu(interventionB.id))).body.proposition.destinataire, 'fiche@client-6a4d.test');
      // Ni l'un ni l'autre : rien, même si le contact de l'intervention a un courriel.
      const vide = await creerClient(`TEST Client CR sans courriel ${s}`);
      const contactC = await ajouterContact(vide.id, { nom: 'TEST Contact de la demande', email: 'demande@client-6a4d.test' });
      const interventionC = await interventionEnCours(vide.id, `TEST Demande C ${s}`, 'TEST Compte rendu C.', { contactId: contactC.id });
      assert.equal((await lire(cheminCompteRendu(interventionC.id))).body.proposition.destinataire, '');
      // La proposition suit la fiche actuelle du client.
      const principal = await prisma.clientContact.findFirstOrThrow({ where: { clientId: avecPrincipal.id, principal: true } });
      await ok(appeler('put', `/clients/${avecPrincipal.id}/contacts/${principal.id}`, { email: 'nouveau@client-6a4d.test' }));
      assert.equal((await lire(cheminCompteRendu(interventionA.id))).body.proposition.destinataire, 'nouveau@client-6a4d.test');
    });

    test('contrat, lecture : même règle du destinataire, objet et texte mot pour mot (« récapitulatif ») ; journal vide', async () => {
      const s = suffixe();
      const avecPrincipal = await creerClient(`TEST Client contrat principal ${s}`, { email: 'fiche@client-6a4d.test' });
      await ajouterContact(avecPrincipal.id, { nom: 'TEST Principal', email: 'principal@client-6a4d.test', principal: true });
      const contrat = await creerContrat(avecPrincipal.id, `TEST Maintenance chaudière ${s}`);
      const lu = await sansEcriture(() => lire(cheminContrat(contrat.id)), 200, 'lecture du contrat');
      assert.deepEqual(lu.body, {
        proposition: { destinataire: 'principal@client-6a4d.test', objet: objetContrat(contrat.titre, SOCIETE.raisonSociale), corps: corpsContrat(contrat.titre, SOCIETE.raisonSociale) },
        envois: [],
      });
      assert.equal(contrat.titre, `TEST Maintenance chaudière ${s}`);
      const repli = await creerClient(`TEST Client contrat fiche ${s}`, { email: 'fiche@client-6a4d.test' });
      await ajouterContact(repli.id, { nom: 'TEST Principal sans courriel', principal: true });
      assert.equal((await lire(cheminContrat((await creerContrat(repli.id, `TEST Contrat fiche ${s}`)).id))).body.proposition.destinataire, 'fiche@client-6a4d.test');
      const vide = await creerClient(`TEST Client contrat sans courriel ${s}`);
      await ajouterContact(vide.id, { nom: 'TEST Secondaire', email: 'secondaire@client-6a4d.test' });
      assert.equal((await lire(cheminContrat((await creerContrat(vide.id, `TEST Contrat vide ${s}`)).id))).body.proposition.destinataire, '');
    });

    // Cadrage : « La raison sociale est celle que le PDF imprime : l'identité actuelle de la société,
    // refusée si elle est incomplète, avec le même contrôle que l'impression. » Lecture écartée : une
    // raison sociale copiée à la création, à la signature d'un compte rendu ou à la conversion du devis
    // d'un contrat (devis signé sous l'ancienne raison sociale). La normalisation est celle de
    // l'impression (blancs retirés).
    test('objet et texte : la raison sociale actuelle, telle que le PDF l’imprime, pour le compte rendu comme pour le contrat', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client raison sociale ${s}`);
      const intervention = await interventionEnCours(client.id, `TEST Demande raison sociale ${s}`, 'TEST Compte rendu signé.');
      const rapport = await prisma.interventionRapport.findFirstOrThrow({ where: { interventionId: intervention.id } });
      await ok(appeler('post', `/interventions/rapports/${rapport.id}/signature`, { signataire: 'TEST Signataire', confirme: true, trace: { ratio: 2, traits: [[[0.1, 0.6], [0.25, 0.3], [0.4, 0.7], [0.6, 0.35]]] } }), 201);
      const { contrat } = await contratDeDevis(client.id, `TEST Contrat raison sociale ${s}`);
      const RENOMMEE = 'TEST Émetteur renommé 6a4d';
      try {
        // Écrite en base avec ses blancs : l'écran Société les retire déjà ; seule la normalisation de
        // l'impression peut les retirer ici.
        await prisma.companySettings.update({ where: { id: 'singleton' }, data: { raisonSociale: `  ${RENOMMEE}  ` } });
        for (const [chemin, objet, corps] of [
          [cheminCompteRendu(intervention.id), objetCompteRendu(intervention.reference, RENOMMEE), corpsCompteRendu(intervention.reference, RENOMMEE)],
          [cheminContrat(contrat.id), objetContrat(contrat.titre, RENOMMEE), corpsContrat(contrat.titre, RENOMMEE)],
        ]) {
          assert.deepEqual((await lire(chemin)).body.proposition, { destinataire: '', objet, corps }, chemin);
          const { res, ligne } = await enregistre(() => envoyer(chemin, 'client@envoi-6a4d.test'), chemin);
          assert.equal(res.body.objet, objet);
          assert.equal(res.body.corps, corps);
          assert.equal(res.body.envoi.objet, objet);
          assert.equal(ligne.objet, objet);
          // C'est bien la raison sociale que le PDF imprime.
          const texte = await textePdf(chemin);
          assert.ok(texte.includes(RENOMMEE) && !texte.includes(SOCIETE.raisonSociale), texte);
        }
      } finally {
        await definirSociete(SOCIETE);
      }
    });

    // ------------------------------------------------------------------------------------------------
    // Enregistrement.
    // ------------------------------------------------------------------------------------------------

    // Cadrage, « Tests » : « l'enregistrement (201, ligne au journal avec l'auteur et l'horodatage de la
    // base, réponse sans identifiant de compte) » ; « journal du plus récent au plus ancien » ; « aucun
    // statut changé par un envoi » ; « Une intervention en cours qui porte un compte rendu s'envoie ».
    test('compte rendu, enregistrement : 201, journal du plus récent au plus ancien, auteur et horodatage de la base, sans identifiant de compte ; en cours ou terminée, l’intervention ne change pas', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client CR journal ${s}`);
      // Les deux interventions sont dans l'affaire d'un conducteur, second auteur admis.
      const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur-journal', s, { name: `TEST Conducteur journal ${s}` });
      const chantier = await prisma.chantier.create({ data: { nom: `TEST Chantier journal ${s}`, client: client.raisonSociale, clientId: client.id, dateDebut: new Date(), budgetGlobalVendu: 1000, responsableId: conducteur.id } });
      const enCours = await interventionEnCours(client.id, `TEST Demande en cours ${s}`, 'TEST Compte rendu en cours.', { chantierId: chantier.id });
      const terminee = await interventionEnCours(client.id, `TEST Demande terminée ${s}`, 'TEST Compte rendu terminé.', { chantierId: chantier.id });
      await changerStatut(terminee.id, 'TERMINEE', { motifSansSignature: 'CLIENT_ABSENT' });
      const [{ debut }] = await prisma.$queryRaw`SELECT now() AS debut`;

      const premier = await enregistre(() => envoyer(cheminCompteRendu(enCours.id), '  premier@client-6a4d.test\n'), 'premier envoi');
      assert.deepEqual(Object.keys(premier.res.body.envoi).sort(), CHAMPS_ENVOI);
      assert.deepEqual(premier.res.body.envoi, {
        id: premier.ligne.id, canal: 'MESSAGERIE', destinataire: 'premier@client-6a4d.test', objet: objetCompteRendu(enCours.reference, SOCIETE.raisonSociale),
        auteurNom: secours.name, createdAt: premier.ligne.createdAt.toISOString(),
      });
      assert.equal(premier.res.body.objet, objetCompteRendu(enCours.reference, SOCIETE.raisonSociale));
      assert.equal(premier.res.body.corps, corpsCompteRendu(enCours.reference, SOCIETE.raisonSociale));
      assert.ok(!JSON.stringify(premier.res.body).includes(secours.id), 'identifiant du compte exposé');
      // En base : l'intervention seule, le compte, son nom et l'horodatage de la base.
      assert.deepEqual(
        { interventionId: premier.ligne.interventionId, contratMaintenanceId: premier.ligne.contratMaintenanceId, devisId: premier.ligne.devisId, factureId: premier.ligne.factureId, auteurId: premier.ligne.auteurId, auteurNom: premier.ligne.auteurNom, canal: premier.ligne.canal },
        { interventionId: enCours.id, contratMaintenanceId: null, devisId: null, factureId: null, auteurId: secours.id, auteurNom: secours.name, canal: 'MESSAGERIE' },
      );
      assert.ok(premier.ligne.createdAt.getTime() >= debut.getTime() - 1000, `${premier.ligne.createdAt.toISOString()} < ${debut.toISOString()}`);

      // Un second envoi, par un autre compte admis (le conducteur de l'affaire), passe en tête.
      const second = await enregistre(() => envoyer(cheminCompteRendu(enCours.id), 'second@client-6a4d.test', parCompte(conducteur)), 'second envoi');
      assert.equal(second.ligne.auteurId, conducteur.id);
      assert.equal(second.res.body.envoi.auteurNom, `TEST Conducteur journal ${s}`);
      assert.ok(!JSON.stringify(second.res.body).includes(conducteur.id), 'identifiant du compte exposé');
      const lu = await lire(cheminCompteRendu(enCours.id));
      assert.equal(lu.status, 200);
      assert.deepEqual(lu.body.envois, [second.res.body.envoi, premier.res.body.envoi]);
      for (const envoi of lu.body.envois) assert.deepEqual(Object.keys(envoi).sort(), CHAMPS_ENVOI);
      assert.ok(!JSON.stringify(lu.body).includes(secours.id) && !JSON.stringify(lu.body).includes(conducteur.id), 'identifiant de compte exposé');
      assert.ok(Date.parse(lu.body.envois[0].createdAt) >= Date.parse(lu.body.envois[1].createdAt));

      // Une intervention terminée s'envoie aussi, par le conducteur de son affaire, sans changer de statut.
      await enregistre(() => envoyer(cheminCompteRendu(terminee.id), 'termine@client-6a4d.test', parCompte(conducteur)), 'intervention terminée');
      assert.deepEqual((await prisma.intervention.findMany({ where: { id: { in: [enCours.id, terminee.id] } }, orderBy: { createdAt: 'asc' } })).map((i) => i.statut), ['EN_COURS', 'TERMINEE']);
      // Le journal d'une intervention ne montre que les siens.
      assert.deepEqual((await lire(cheminCompteRendu(terminee.id))).body.envois.map((e) => e.destinataire), ['termine@client-6a4d.test']);
    });

    // Cadrage : « Un contrat suspendu ou terminé s'envoie, avec le statut que son PDF imprime (N6) » ;
    // « Envoyer ne change aucun statut, ni de l'intervention ni du contrat ».
    test('contrat, enregistrement : 201 pour un contrat actif, suspendu ou terminé, journal du plus récent au plus ancien, sans identifiant de compte ; le contrat ne change pas', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client contrat journal ${s}`);
      const actif = await creerContrat(client.id, `TEST Contrat actif ${s}`);
      const suspendu = await creerContrat(client.id, `TEST Contrat suspendu ${s}`);
      await statutContrat(suspendu.id, 'SUSPENDU');
      const termine = await creerContrat(client.id, `TEST Contrat clos ${s}`);
      await statutContrat(termine.id, 'TERMINE');
      const administrateur = await creerCompte('ADMIN', 'admin-contrat', s);
      const [{ debut }] = await prisma.$queryRaw`SELECT now() AS debut`;

      const premier = await enregistre(() => envoyer(cheminContrat(actif.id), ' premier@client-6a4d.test '), 'premier envoi');
      assert.deepEqual(premier.res.body.envoi, {
        id: premier.ligne.id, canal: 'MESSAGERIE', destinataire: 'premier@client-6a4d.test', objet: objetContrat(actif.titre, SOCIETE.raisonSociale),
        auteurNom: secours.name, createdAt: premier.ligne.createdAt.toISOString(),
      });
      assert.equal(premier.res.body.corps, corpsContrat(actif.titre, SOCIETE.raisonSociale));
      assert.deepEqual(
        { interventionId: premier.ligne.interventionId, contratMaintenanceId: premier.ligne.contratMaintenanceId, devisId: premier.ligne.devisId, factureId: premier.ligne.factureId, auteurId: premier.ligne.auteurId },
        { interventionId: null, contratMaintenanceId: actif.id, devisId: null, factureId: null, auteurId: secours.id },
      );
      assert.ok(premier.ligne.createdAt.getTime() >= debut.getTime() - 1000);
      const second = await enregistre(() => envoyer(cheminContrat(actif.id), 'second@client-6a4d.test', parCompte(administrateur)), 'second envoi');
      assert.equal(second.ligne.auteurId, administrateur.id);
      assert.equal(second.res.body.envoi.auteurNom, administrateur.name);
      const lu = await lire(cheminContrat(actif.id));
      assert.deepEqual(lu.body.envois, [second.res.body.envoi, premier.res.body.envoi]);
      assert.ok(!JSON.stringify(lu.body).includes(secours.id) && !JSON.stringify(lu.body).includes(administrateur.id), 'identifiant de compte exposé');

      for (const contrat of [suspendu, termine]) {
        const { res } = await enregistre(() => envoyer(cheminContrat(contrat.id), 'client@envoi-6a4d.test'), contrat.titre);
        assert.equal(res.body.objet, objetContrat(contrat.titre, SOCIETE.raisonSociale));
      }
      assert.deepEqual((await prisma.contratMaintenance.findMany({ where: { id: { in: [actif.id, suspendu.id, termine.id] } }, orderBy: { createdAt: 'asc' } })).map((c) => c.statut), ['ACTIF', 'SUSPENDU', 'TERMINE']);
    });

    // Cadrage : « 400 pour un destinataire invalide (validerDestinataire du lot 6a-3, inchangé) ».
    test('destinataire invalide : 400 avec le message du lot 6a-3, pour les deux documents, sans rien écrire', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client destinataire ${s}`);
      const intervention = await interventionEnCours(client.id, `TEST Demande destinataire ${s}`, 'TEST Compte rendu destinataire.');
      const contrat = await creerContrat(client.id, `TEST Contrat destinataire ${s}`);
      for (const chemin of [cheminCompteRendu(intervention.id), cheminContrat(contrat.id)]) {
        for (const valeur of [undefined, null, 42, ['a@b.fr'], '', '   ', 'sans-arobase.fr', 'a@b', 'a@b.fr,c@d.fr', 'a@b.fr;c@d.fr', 'Nom <a@b.fr>', 'a b@c.fr', `${'a'.repeat(250)}@b.fr`]) {
          await sansEcriture(() => appeler('post', `${chemin}/envois`, valeur === undefined ? {} : { destinataire: valeur }), 400, `${chemin} ← ${JSON.stringify(valeur)}`, REFUS_DESTINATAIRE);
        }
      }
    });

    // ------------------------------------------------------------------------------------------------
    // Droits.
    // ------------------------------------------------------------------------------------------------

    // Cadrage, « Routes » : mêmes gardes que le PDF du compte rendu (requireAuth, blockCommercial, refus
    // du technicien avant le périmètre, puis le périmètre SAV), lecture et enregistrement ouverts aux
    // mêmes comptes, sous la condition de clients:read (B3) ; « jamais pour le technicien ». Le
    // directeur commercial, l'assistante commerciale et le comptable, qui portent clients:read, ne voient
    // aucune intervention : 404, comme pour la fiche et le PDF. B4 : une intervention annulée garde son
    // journal et sa proposition lisibles ; son enregistrement est refusé (409).
    test('droits du compte rendu : matrice des types de compte, technicien affecté compris, en lecture et en enregistrement', async () => {
      const s = suffixe();
      const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur', s);
      const responsable = await creerCompte('RESPONSABLE', 'responsable', s);
      await prisma.user.update({ where: { id: conducteur.id }, data: { responsableHierarchiqueId: responsable.id } });
      const comptes = {
        admin: await creerCompte('ADMIN', 'admin', s),
        conducteur, responsable,
        conducteurTiers: await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur-tiers', s),
        responsableTiers: await creerCompte('RESPONSABLE', 'responsable-tiers', s),
        commercial: await creerCompte('COMMERCIAL', 'commercial', s),
        directeur: await creerCompte('DIRECTEUR', 'directeur', s),
        directeurCommercial: await creerCompte('DIRECTEUR_COMMERCIAL', 'directeur-commercial', s),
        assistanteCommerciale: await creerCompte('ASSISTANTE_COMMERCIALE', 'assistante-commerciale', s),
        comptable: await creerCompte('COMPTABLE', 'comptable', s),
      };
      const affecte = await compteTechnicien('affecte', s);
      const nonAffecte = await compteTechnicien('non-affecte', s);
      const client = await creerClient(`TEST Client CR droits ${s}`, { email: 'droits@client-6a4d.test' });
      const chantier = await prisma.chantier.create({ data: { nom: `TEST Chantier CR droits ${s}`, client: client.raisonSociale, clientId: client.id, dateDebut: new Date(), budgetGlobalVendu: 1000, responsableId: conducteur.id } });
      const nouvelle = async (titre, compteRendu) => {
        const intervention = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `${titre} ${s}` });
        await planifier(intervention.id, [affecte.intervenantId]);
        await demarrer(intervention.id);
        if (compteRendu) await ajouterCompteRendu(intervention.id, compteRendu);
        return intervention;
      };
      const avecCompteRendu = await nouvelle('TEST Droits avec compte rendu', 'TEST Compte rendu des droits.');
      const sansCompteRendu = await nouvelle('TEST Droits sans compte rendu');
      const annulee = await nouvelle('TEST Droits annulée', 'TEST Compte rendu d’une annulée.');
      await annulerIntervention(annulee.id);
      // Le technicien affecté et les deux techniciens portent clients:read : seul leur type les refuse.
      assert.equal((await appeler('get', `/interventions/${avecCompteRendu.id}`, null, parCompte(affecte.compte))).status, 200, 'le technicien affecté lit la fiche');
      const meAffecte = await ok(appeler('get', '/me', null, parCompte(affecte.compte)));
      assert.ok(meAffecte.permissions.includes('clients:read'), 'le technicien porte clients:read');
      const meResponsable = await ok(appeler('get', '/me', null, parCompte(responsable)));
      assert.ok(!meResponsable.permissions.includes('clients:read'), 'le responsable ne porte pas clients:read (B3)');

      const cibles = [avecCompteRendu.id, sansCompteRendu.id, annulee.id, randomUUID()];
      const nomsCibles = ['avec compte rendu', 'sans compte rendu', 'annulée', 'introuvable'];
      //                         avec CR, sans CR, annulée, introuvable
      const lecture = {
        superadmin: [200, 409, 200, 404],
        admin: [200, 409, 200, 404],
        conducteur: [200, 409, 200, 404],
        responsable: [403, 403, 403, 403],
        conducteurTiers: [404, 404, 404, 404],
        responsableTiers: [403, 403, 403, 403],
        technicienAffecte: [403, 403, 403, 403],
        technicienNonAffecte: [403, 403, 403, 403],
        commercial: [403, 403, 403, 403],
        directeur: [403, 403, 403, 403],
        directeurCommercial: [404, 404, 404, 404],
        assistanteCommerciale: [404, 404, 404, 404],
        comptable: [404, 404, 404, 404],
      };
      const enregistrement = {
        ...lecture,
        superadmin: [201, 409, 409, 404],
        admin: [201, 409, 409, 404],
        conducteur: [201, 409, 409, 404],
      };
      const MESSAGES_409 = { lecture: [null, AUCUN_COMPTE_RENDU, null, null], enregistrement: [null, AUCUN_COMPTE_RENDU, INTERVENTION_ANNULEE, null] };
      const jetons = {
        superadmin: admin(), technicienAffecte: parCompte(affecte.compte), technicienNonAffecte: parCompte(nonAffecte.compte),
        ...Object.fromEntries(Object.entries(comptes).map(([cle, compte]) => [cle, parCompte(compte)])),
      };
      for (const [cle, statuts] of Object.entries(lecture)) {
        for (const [rangCible, id] of cibles.entries()) {
          const res = await sansEcriture(() => lire(cheminCompteRendu(id), jetons[cle]), statuts[rangCible], `lecture, ${cle}, ${nomsCibles[rangCible]}`);
          if (res.status === 409) assert.equal(res.body.error, MESSAGES_409.lecture[rangCible], `${cle}, ${nomsCibles[rangCible]}`);
          if (res.status === 200) {
            const reference = [avecCompteRendu, sansCompteRendu, annulee][rangCible].reference;
            assert.deepEqual(res.body.proposition, { destinataire: 'droits@client-6a4d.test', objet: objetCompteRendu(reference, SOCIETE.raisonSociale), corps: corpsCompteRendu(reference, SOCIETE.raisonSociale) });
          }
        }
      }
      for (const [cle, statuts] of Object.entries(enregistrement)) {
        for (const [rangCible, id] of cibles.entries()) {
          const contexte = `enregistrement, ${cle}, ${nomsCibles[rangCible]}`;
          if (statuts[rangCible] === 201) {
            const { res } = await enregistre(() => envoyer(cheminCompteRendu(id), 'droits@client-6a4d.test', jetons[cle]), contexte);
            assert.equal(res.body.envoi.objet, objetCompteRendu(avecCompteRendu.reference, SOCIETE.raisonSociale));
          } else {
            const res = await sansEcriture(() => envoyer(cheminCompteRendu(id), 'droits@client-6a4d.test', jetons[cle]), statuts[rangCible], contexte);
            if (res.status === 409) assert.equal(res.body.error, MESSAGES_409.enregistrement[rangCible], contexte);
          }
        }
      }
      // Les trois envois admis sont au journal de l'intervention, du plus récent au plus ancien.
      assert.deepEqual((await lire(cheminCompteRendu(avecCompteRendu.id))).body.envois.map((e) => e.auteurNom), [conducteur.name, comptes.admin.name, secours.name]);
      assert.equal(await prisma.envoiDocument.count({ where: { interventionId: { in: [sansCompteRendu.id, annulee.id] } } }), 0);
    });

    // Cadrage, « Données du client » (B3, option A) : lecture et enregistrement exigent aussi clients:read
    // en permission effective ; le responsable ne l'a pas par son type de compte ; « Un droit accordé
    // individuellement le lui rouvre ». Le périmètre s'applique toujours ensuite.
    test('B3 : le responsable sans clients:read est refusé (403) en lecture comme en enregistrement, sans rien écrire ; le droit accordé individuellement les lui ouvre, dans son périmètre seulement', async () => {
      const s = suffixe();
      const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur-b3', s);
      const responsable = await creerCompte('RESPONSABLE', 'responsable-b3', s);
      const responsableTiers = await creerCompte('RESPONSABLE', 'responsable-tiers-b3', s);
      await prisma.user.update({ where: { id: conducteur.id }, data: { responsableHierarchiqueId: responsable.id } });
      const client = await creerClient(`TEST Client B3 ${s}`, { email: 'b3@client-6a4d.test' });
      const chantier = await prisma.chantier.create({ data: { nom: `TEST Chantier B3 ${s}`, client: client.raisonSociale, clientId: client.id, dateDebut: new Date(), budgetGlobalVendu: 1000, responsableId: conducteur.id } });
      const intervention = await interventionEnCours(client.id, `TEST Demande B3 ${s}`, 'TEST Compte rendu B3.', { chantierId: chantier.id });
      // Le responsable lit le PDF du compte rendu (6a-4a) : seul clients:read lui manque.
      const pdf = await request(app).get(`/api/interventions/${intervention.id}/document.pdf`).set(parCompte(responsable));
      assert.equal(pdf.status, 200, 'le responsable lit le PDF');
      await sansEcriture(() => lire(cheminCompteRendu(intervention.id), parCompte(responsable)), 403, 'lecture sans clients:read');
      await sansEcriture(() => envoyer(cheminCompteRendu(intervention.id), 'b3@client-6a4d.test', parCompte(responsable)), 403, 'enregistrement sans clients:read');

      // Droit accordé individuellement, par la route de l'administration (super administrateur).
      for (const compte of [responsable, responsableTiers]) await ok(appeler('put', `/users/${compte.id}/permissions`, { permissions: ['clients:read'] }));
      assert.ok((await ok(appeler('get', '/me', null, parCompte(responsable)))).permissions.includes('clients:read'));
      const lu = await sansEcriture(() => lire(cheminCompteRendu(intervention.id), parCompte(responsable)), 200, 'lecture avec clients:read');
      assert.equal(lu.body.proposition.destinataire, 'b3@client-6a4d.test');
      const { ligne } = await enregistre(() => envoyer(cheminCompteRendu(intervention.id), 'b3@client-6a4d.test', parCompte(responsable)), 'enregistrement avec clients:read');
      assert.equal(ligne.auteurId, responsable.id);
      // Hors de son périmètre, le droit ne suffit pas : 404.
      await sansEcriture(() => lire(cheminCompteRendu(intervention.id), parCompte(responsableTiers)), 404, 'lecture hors périmètre');
      await sansEcriture(() => envoyer(cheminCompteRendu(intervention.id), 'b3@client-6a4d.test', parCompte(responsableTiers)), 404, 'enregistrement hors périmètre');
      // Le droit retiré, le refus revient.
      await ok(appeler('put', `/users/${responsable.id}/permissions`, { permissions: [] }));
      await sansEcriture(() => envoyer(cheminCompteRendu(intervention.id), 'b3@client-6a4d.test', parCompte(responsable)), 403, 'droit retiré');
    });

    // Cadrage : « GET et POST /api/contrats-maintenance/:id/envois : administration seule (requireAdmin),
    // comme toutes les routes des contrats ».
    test('droits du contrat : administration seule, 403 pour tout autre type de compte même avec tous les droits, en lecture comme en enregistrement', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client contrat droits ${s}`);
      const contrat = await creerContrat(client.id, `TEST Contrat droits ${s}`);
      const refuses = [];
      for (const role of ['CONDUCTEUR_TRAVAUX', 'COMMERCIAL', 'ASSISTANTE_COMMERCIALE', 'TECHNICIEN', 'COMPTABLE', 'DIRECTEUR_COMMERCIAL', 'RESPONSABLE', 'DIRECTEUR']) {
        refuses.push([role, await creerCompte(role, `contrat-${role.toLowerCase()}`, s)]);
      }
      refuses.push(['DIRECTEUR (tous les droits)', await creerCompte('DIRECTEUR', 'contrat-directeur-complet', s, { permissions: TOUS_LES_SCOPES, accesFinance: true })]);
      for (const [libelle, compte] of refuses) {
        const lu = await sansEcriture(() => lire(cheminContrat(contrat.id), parCompte(compte)), 403, `lecture, ${libelle}`);
        assert.equal(lu.body.error, 'Accès réservé aux administrateurs', libelle);
        await sansEcriture(() => envoyer(cheminContrat(contrat.id), 'client@envoi-6a4d.test', parCompte(compte)), 403, `enregistrement, ${libelle}`);
      }
      const administrateur = await creerCompte('ADMIN', 'contrat-admin', s);
      for (const auth of [admin(), parCompte(administrateur)]) {
        await sansEcriture(() => lire(cheminContrat(contrat.id), auth), 200, 'lecture par l’administration');
        await enregistre(() => envoyer(cheminContrat(contrat.id), 'client@envoi-6a4d.test', auth), 'enregistrement par l’administration');
      }
    });

    // Cadrage : « en session seulement, sans clé d'intégration ni route /api/v1 » ; « 401 sans session et
    // pour une clé d'intégration ; aucune route /api/v1 (404) ».
    test('session seulement : 401 sans session et pour une clé d’intégration, même de tous les scopes ; aucune route /api/v1 (404), pour les quatre routes', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client session ${s}`);
      const intervention = await interventionEnCours(client.id, `TEST Demande session ${s}`, 'TEST Compte rendu session.');
      const contrat = await creerContrat(client.id, `TEST Contrat session ${s}`);
      const cle = await ok(appeler('post', '/admin/api-keys', { nom: `TEST clé envoi 6a4d ${s}`, scopes: TOUS_LES_SCOPES }), 201);
      const parCle = entete(cle.apiKey);
      assert.equal((await appeler('get', '/v1/clients', null, parCle)).status, 200, 'la clé est valide');
      for (const chemin of [cheminCompteRendu(intervention.id), cheminContrat(contrat.id)]) {
        await sansEcriture(() => lire(chemin, null), 401, `${chemin}, lecture sans session`);
        await sansEcriture(() => envoyer(chemin, 'client@envoi-6a4d.test', null), 401, `${chemin}, enregistrement sans session`);
        await sansEcriture(() => lire(chemin, parCle), 401, `${chemin}, lecture par une clé`);
        await sansEcriture(() => envoyer(chemin, 'client@envoi-6a4d.test', parCle), 401, `${chemin}, enregistrement par une clé`);
        await sansEcriture(() => appeler('get', `/v1${chemin}/envois`, null, parCle), 404, `${chemin}, lecture /api/v1`);
        await sansEcriture(() => appeler('post', `/v1${chemin}/envois`, { destinataire: 'client@envoi-6a4d.test' }, parCle), 404, `${chemin}, enregistrement /api/v1`);
      }
    });

    // ------------------------------------------------------------------------------------------------
    // Refus et ordre des contrôles.
    // ------------------------------------------------------------------------------------------------

    // Cadrage, B4 : « un envoi enregistré, puis l'annulation de l'intervention ; la lecture du journal rend
    // cet envoi ; l'enregistrement est refusé (409) sans rien écrire ; de même pour un contrat annulé » ;
    // contrat : « 409 « Un contrat annulé ne s’envoie pas. », comme un devis annulé ; son PDF reste
    // disponible ».
    test('B4 : envoi puis annulation ; le journal et la proposition restent lisibles, l’enregistrement est refusé (409) sans rien écrire ; intervention et contrat', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client B4 ${s}`, { email: 'b4@client-6a4d.test' });
      const intervention = await interventionEnCours(client.id, `TEST Demande B4 ${s}`, 'TEST Compte rendu B4.');
      const envoiIntervention = (await enregistre(() => envoyer(cheminCompteRendu(intervention.id), 'b4@client-6a4d.test'), 'envoi avant annulation')).res.body.envoi;
      await annulerIntervention(intervention.id);
      assert.equal((await appeler('get', `/interventions/${intervention.id}`)).status, 404, 'la fiche de l’annulée est introuvable');
      const luIntervention = await sansEcriture(() => lire(cheminCompteRendu(intervention.id)), 200, 'lecture de l’annulée');
      assert.deepEqual(luIntervention.body, {
        proposition: { destinataire: 'b4@client-6a4d.test', objet: objetCompteRendu(intervention.reference, SOCIETE.raisonSociale), corps: corpsCompteRendu(intervention.reference, SOCIETE.raisonSociale) },
        envois: [envoiIntervention],
      });
      await sansEcriture(() => envoyer(cheminCompteRendu(intervention.id), 'b4@client-6a4d.test'), 409, 'enregistrement sur l’annulée', INTERVENTION_ANNULEE);

      const { contrat, annuler } = await contratDeDevis(client.id, `TEST Contrat B4 ${s}`);
      const envoiContrat = (await enregistre(() => envoyer(cheminContrat(contrat.id), 'b4@client-6a4d.test'), 'envoi du contrat avant annulation')).res.body.envoi;
      await annuler();
      const luContrat = await sansEcriture(() => lire(cheminContrat(contrat.id)), 200, 'lecture du contrat annulé');
      assert.deepEqual(luContrat.body, {
        proposition: { destinataire: 'b4@client-6a4d.test', objet: objetContrat(contrat.titre, SOCIETE.raisonSociale), corps: corpsContrat(contrat.titre, SOCIETE.raisonSociale) },
        envois: [envoiContrat],
      });
      await sansEcriture(() => envoyer(cheminContrat(contrat.id), 'b4@client-6a4d.test'), 409, 'enregistrement sur le contrat annulé', CONTRAT_ANNULE);
      // Son PDF reste disponible.
      assert.ok((await textePdf(cheminContrat(contrat.id))).includes(contrat.titre));
    });

    // Cadrage, « Refus du compte rendu » et « Refus du contrat » : 404 hors du périmètre ou introuvable,
    // 409 « Aucun compte rendu à envoyer. », 409 si l'identité est incomplète (« … avant d’envoyer un
    // compte rendu », « … avant d’envoyer un contrat »), en lecture comme en enregistrement, sans rien
    // écrire. L'identité complétée, l'envoi passe.
    test('refus sans rien écrire : introuvable (404), sans compte rendu (409), identité incomplète (409) qui nomme les champs manquants, pour les deux documents', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client refus ${s}`);
      const intervention = await interventionEnCours(client.id, `TEST Demande refus ${s}`, 'TEST Compte rendu refus.');
      const vide = await interventionEnCours(client.id, `TEST Demande vide ${s}`);
      const contrat = await creerContrat(client.id, `TEST Contrat refus ${s}`);
      for (const id of [randomUUID(), 'inexistant']) {
        for (const chemin of [cheminCompteRendu(id), cheminContrat(id)]) {
          await sansEcriture(() => lire(chemin), 404, `lecture, ${chemin}`);
          await sansEcriture(() => envoyer(chemin, 'client@envoi-6a4d.test'), 404, `enregistrement, ${chemin}`);
        }
      }
      // Une intervention n'est pas un contrat, ni l'inverse.
      await sansEcriture(() => envoyer(cheminContrat(intervention.id), 'client@envoi-6a4d.test'), 404, 'intervention par la route du contrat');
      await sansEcriture(() => envoyer(cheminCompteRendu(contrat.id), 'client@envoi-6a4d.test'), 404, 'contrat par la route de l’intervention');
      await sansEcriture(() => lire(cheminCompteRendu(vide.id)), 409, 'lecture sans compte rendu', AUCUN_COMPTE_RENDU);
      await sansEcriture(() => envoyer(cheminCompteRendu(vide.id), 'client@envoi-6a4d.test'), 409, 'enregistrement sans compte rendu', AUCUN_COMPTE_RENDU);
      try {
        await definirSociete({ siret: '', ville: '  ' });
        for (const [chemin, document] of [[cheminCompteRendu(intervention.id), 'un compte rendu'], [cheminContrat(contrat.id), 'un contrat']]) {
          await sansEcriture(() => lire(chemin), 409, `lecture, ${document}`, identiteIncomplete('SIRET, ville', document));
          await sansEcriture(() => envoyer(chemin, 'client@envoi-6a4d.test'), 409, `enregistrement, ${document}`, identiteIncomplete('SIRET, ville', document));
        }
        await definirSociete({ siret: SOCIETE.siret, ville: SOCIETE.ville, raisonSociale: '' });
        await sansEcriture(() => envoyer(cheminCompteRendu(intervention.id), 'client@envoi-6a4d.test'), 409, 'raison sociale absente', identiteIncomplete('raison sociale', 'un compte rendu'));
        await sansEcriture(() => lire(cheminContrat(contrat.id)), 409, 'raison sociale absente, contrat', identiteIncomplete('raison sociale', 'un contrat'));
      } finally {
        await definirSociete(SOCIETE);
      }
      await enregistre(() => envoyer(cheminCompteRendu(intervention.id), 'client@envoi-6a4d.test'), 'identité complétée, compte rendu');
      await enregistre(() => envoyer(cheminContrat(contrat.id), 'client@envoi-6a4d.test'), 'identité complétée, contrat');
    });

    // Cadrage, « Ordre des contrôles, comme le lot 6a-3 et le PDF : gardes et refus du technicien (403),
    // droit clients:read (403), destinataire (400), introuvable ou hors périmètre (404), annulée (409),
    // sans compte rendu (409), identité (409) ». Chaque paire d'appels réunit deux refus : le premier dans
    // l'ordre l'emporte.
    test('ordre des contrôles du compte rendu : technicien, clients:read, destinataire, périmètre, annulée, sans compte rendu, identité', async () => {
      const s = suffixe();
      const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur-ordre', s);
      const responsable = await creerCompte('RESPONSABLE', 'responsable-ordre', s);
      await prisma.user.update({ where: { id: conducteur.id }, data: { responsableHierarchiqueId: responsable.id } });
      const conducteurTiers = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur-tiers-ordre', s);
      const commercial = await creerCompte('COMMERCIAL', 'commercial-ordre', s);
      const affecte = await compteTechnicien('ordre', s);
      const client = await creerClient(`TEST Client ordre ${s}`);
      const chantier = await prisma.chantier.create({ data: { nom: `TEST Chantier ordre ${s}`, client: client.raisonSociale, clientId: client.id, dateDebut: new Date(), budgetGlobalVendu: 1000, responsableId: conducteur.id } });
      const avec = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `TEST Ordre avec compte rendu ${s}` });
      await planifier(avec.id, [affecte.intervenantId]);
      await demarrer(avec.id);
      await ajouterCompteRendu(avec.id, 'TEST Compte rendu de l’ordre.');
      const sans = await interventionEnCours(client.id, `TEST Ordre sans compte rendu ${s}`, null, { chantierId: chantier.id });
      const annuleeAvec = await interventionEnCours(client.id, `TEST Ordre annulée avec compte rendu ${s}`, 'TEST Compte rendu annulé.', { chantierId: chantier.id });
      await annulerIntervention(annuleeAvec.id);
      const annuleeSans = await interventionEnCours(client.id, `TEST Ordre annulée sans compte rendu ${s}`, null, { chantierId: chantier.id });
      await annulerIntervention(annuleeSans.id);
      const introuvable = randomUUID();
      const INVALIDE = 'pas-une-adresse';
      const VALIDE = 'client@envoi-6a4d.test';

      // Gardes et technicien avant clients:read, destinataire et périmètre.
      for (const [compte, libelle] of [[affecte.compte, 'technicien affecté'], [commercial, 'commercial']]) {
        await sansEcriture(() => envoyer(cheminCompteRendu(avec.id), INVALIDE, parCompte(compte)), 403, `${libelle}, destinataire invalide`);
        await sansEcriture(() => envoyer(cheminCompteRendu(introuvable), VALIDE, parCompte(compte)), 403, `${libelle}, introuvable`);
        await sansEcriture(() => lire(cheminCompteRendu(introuvable), parCompte(compte)), 403, `${libelle}, lecture introuvable`);
      }
      // clients:read avant destinataire et périmètre.
      await sansEcriture(() => envoyer(cheminCompteRendu(avec.id), INVALIDE, parCompte(responsable)), 403, 'clients:read, destinataire invalide');
      await sansEcriture(() => envoyer(cheminCompteRendu(introuvable), VALIDE, parCompte(responsable)), 403, 'clients:read, introuvable');
      await sansEcriture(() => lire(cheminCompteRendu(introuvable), parCompte(responsable)), 403, 'clients:read, lecture introuvable');
      // Destinataire avant périmètre, annulée, sans compte rendu.
      await sansEcriture(() => envoyer(cheminCompteRendu(introuvable), INVALIDE), 400, 'destinataire, introuvable', REFUS_DESTINATAIRE);
      await sansEcriture(() => envoyer(cheminCompteRendu(avec.id), INVALIDE, parCompte(conducteurTiers)), 400, 'destinataire, hors périmètre', REFUS_DESTINATAIRE);
      await sansEcriture(() => envoyer(cheminCompteRendu(annuleeAvec.id), INVALIDE), 400, 'destinataire, annulée', REFUS_DESTINATAIRE);
      await sansEcriture(() => envoyer(cheminCompteRendu(sans.id), INVALIDE), 400, 'destinataire, sans compte rendu', REFUS_DESTINATAIRE);
      // Périmètre avant annulée et sans compte rendu.
      await sansEcriture(() => envoyer(cheminCompteRendu(annuleeAvec.id), VALIDE, parCompte(conducteurTiers)), 404, 'hors périmètre, annulée');
      await sansEcriture(() => envoyer(cheminCompteRendu(sans.id), VALIDE, parCompte(conducteurTiers)), 404, 'hors périmètre, sans compte rendu');
      await sansEcriture(() => lire(cheminCompteRendu(sans.id), parCompte(conducteurTiers)), 404, 'hors périmètre, lecture sans compte rendu');
      // Annulée avant sans compte rendu.
      await sansEcriture(() => envoyer(cheminCompteRendu(annuleeSans.id), VALIDE), 409, 'annulée sans compte rendu', INTERVENTION_ANNULEE);
      await sansEcriture(() => envoyer(cheminCompteRendu(annuleeSans.id), VALIDE, parCompte(conducteur)), 409, 'annulée sans compte rendu, conducteur', INTERVENTION_ANNULEE);
      // Identité en dernier.
      try {
        await definirSociete({ siret: '' });
        await sansEcriture(() => envoyer(cheminCompteRendu(annuleeAvec.id), VALIDE), 409, 'annulée, identité incomplète', INTERVENTION_ANNULEE);
        await sansEcriture(() => envoyer(cheminCompteRendu(sans.id), VALIDE), 409, 'sans compte rendu, identité incomplète', AUCUN_COMPTE_RENDU);
        await sansEcriture(() => lire(cheminCompteRendu(sans.id)), 409, 'lecture sans compte rendu, identité incomplète', AUCUN_COMPTE_RENDU);
        await sansEcriture(() => envoyer(cheminCompteRendu(introuvable), VALIDE), 404, 'introuvable, identité incomplète');
        await sansEcriture(() => lire(cheminCompteRendu(introuvable)), 404, 'lecture introuvable, identité incomplète');
        await sansEcriture(() => lire(cheminCompteRendu(avec.id), parCompte(conducteurTiers)), 404, 'hors périmètre, identité incomplète');
        await sansEcriture(() => envoyer(cheminCompteRendu(avec.id), INVALIDE), 400, 'destinataire, identité incomplète', REFUS_DESTINATAIRE);
        await sansEcriture(() => envoyer(cheminCompteRendu(avec.id), VALIDE, parCompte(affecte.compte)), 403, 'technicien, identité incomplète');
        await sansEcriture(() => envoyer(cheminCompteRendu(avec.id), VALIDE), 409, 'identité incomplète', identiteIncomplete('SIRET', 'un compte rendu'));
      } finally {
        await definirSociete(SOCIETE);
      }
    });

    // Cadrage, « Refus du contrat », enregistrement : 400 destinataire, 404 introuvable, 409 annulé, 409
    // identité, dans l'ordre du lot 6a-3 (le destinataire contrôlé avant le document, un devis annulé
    // refusé comme tel même sans identité) ; l'administration d'abord, comme toutes les routes des
    // contrats.
    test('ordre des contrôles du contrat : administration, destinataire, introuvable, annulé, identité', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client ordre contrat ${s}`);
      const actif = await creerContrat(client.id, `TEST Contrat ordre ${s}`);
      const { contrat: annule, annuler } = await contratDeDevis(client.id, `TEST Contrat ordre annulé ${s}`);
      await annuler();
      const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur-ordre-contrat', s);
      const introuvable = randomUUID();
      await sansEcriture(() => envoyer(cheminContrat(introuvable), 'pas-une-adresse', parCompte(conducteur)), 403, 'administration avant destinataire');
      await sansEcriture(() => lire(cheminContrat(introuvable), parCompte(conducteur)), 403, 'administration avant introuvable');
      await sansEcriture(() => envoyer(cheminContrat(introuvable), 'pas-une-adresse'), 400, 'destinataire avant introuvable', REFUS_DESTINATAIRE);
      await sansEcriture(() => envoyer(cheminContrat(annule.id), 'pas-une-adresse'), 400, 'destinataire avant annulé', REFUS_DESTINATAIRE);
      try {
        await definirSociete({ ville: '' });
        await sansEcriture(() => envoyer(cheminContrat(introuvable), 'client@envoi-6a4d.test'), 404, 'introuvable avant identité');
        await sansEcriture(() => lire(cheminContrat(introuvable)), 404, 'lecture, introuvable avant identité');
        await sansEcriture(() => envoyer(cheminContrat(annule.id), 'client@envoi-6a4d.test'), 409, 'annulé avant identité', CONTRAT_ANNULE);
        await sansEcriture(() => envoyer(cheminContrat(actif.id), 'client@envoi-6a4d.test'), 409, 'identité', identiteIncomplete('ville', 'un contrat'));
      } finally {
        await definirSociete(SOCIETE);
      }
    });

    // Cadrage, « Verrous » (N1) et « Tests », facultatif (T) : « une annulation en cours est attendue par
    // l'envoi, puis le fait refuser ». L'intervention se verrouille en FOR SHARE avant de relire son
    // statut ; le contrat en FOR SHARE par une requête directe. L'annulation est tenue ici par une
    // transaction qui met à jour la ligne (verrou exclusif), puis validée.
    test('verrous : l’envoi attend l’annulation en cours de l’intervention ou du contrat, puis est refusé (409) sans rien écrire', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client verrou ${s}`);
      const intervention = await interventionEnCours(client.id, `TEST Demande verrou ${s}`, 'TEST Compte rendu verrou.');
      const contrat = await creerContrat(client.id, `TEST Contrat verrou ${s}`);
      for (const [chemin, tenir, message] of [
        [cheminCompteRendu(intervention.id), (tx) => tx.$executeRaw`UPDATE "Intervention" SET "statut" = 'ANNULEE' WHERE "id" = ${intervention.id}`, INTERVENTION_ANNULEE],
        [cheminContrat(contrat.id), (tx) => tx.$executeRaw`UPDATE "ContratMaintenance" SET "statut" = 'ANNULE', "annuleLe" = now(), "annuleParId" = ${secours.id}, "motifAnnulation" = 'TEST annulation concurrente 6a4d' WHERE "id" = ${contrat.id}`, CONTRAT_ANNULE],
      ]) {
        let liberer;
        const retenue = new Promise((resolveRetenue) => { liberer = resolveRetenue; });
        let pidTenant = null;
        const avant = await prisma.envoiDocument.count();
        const tenant = prisma.$transaction(async (tx) => {
          [{ pid: pidTenant }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
          await tenir(tx);
          await retenue;
        }, { timeout: 40_000 });
        try {
          while (pidTenant === null) await new Promise((resolveAttente) => setTimeout(resolveAttente, 10));
          const envoi = envoyer(chemin, 'client@envoi-6a4d.test').then((reponse) => reponse);
          const bloque = await attendreBlocage(pidTenant);
          liberer();
          await tenant;
          const reponse = await envoi;
          assert.equal(bloque, true, `l’envoi doit attendre le verrou (${chemin})`);
          assert.equal(reponse.status, 409, `${chemin} : ${JSON.stringify(reponse.body)}`);
          assert.equal(reponse.body.error, message);
        } finally {
          liberer();
          await tenant.catch(() => undefined);
        }
        assert.equal(await prisma.envoiDocument.count(), avant, `${chemin} : rien n’est écrit`);
      }
    });

    // ------------------------------------------------------------------------------------------------
    // Migration du journal (cadrage, « Migration du journal », et N8).
    // ------------------------------------------------------------------------------------------------

    // « les trois déclencheurs du journal restent en place et s'appliquent aux nouvelles lignes :
    // envoi_document_ajout_seul (ni modification ni suppression), envoi_document_sans_vidage (ni vidage)
    // et envoi_document_horodatage (horodatage imposé par la base) ».
    test('migration : les trois déclencheurs, actifs, refusent la modification et la suppression d’un envoi d’intervention ou de contrat, le vidage de la table, et imposent l’horodatage', async () => {
      const s = suffixe();
      const declencheurs = await prisma.$queryRaw`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = '"EnvoiDocument"'::regclass AND NOT tgisinternal ORDER BY tgname`;
      assert.deepEqual(declencheurs, [
        { tgname: 'envoi_document_ajout_seul', tgenabled: 'O' },
        { tgname: 'envoi_document_horodatage', tgenabled: 'O' },
        { tgname: 'envoi_document_sans_vidage', tgenabled: 'O' },
      ]);
      const client = await creerClient(`TEST Client déclencheurs ${s}`);
      const intervention = await interventionEnCours(client.id, `TEST Demande déclencheurs ${s}`, 'TEST Compte rendu déclencheurs.');
      const contrat = await creerContrat(client.id, `TEST Contrat déclencheurs ${s}`);
      const autreContrat = await creerContrat(client.id, `TEST Autre contrat déclencheurs ${s}`);
      const parIntervention = (await enregistre(() => envoyer(cheminCompteRendu(intervention.id), 'client@envoi-6a4d.test'), 'envoi d’intervention')).ligne;
      const parContrat = (await enregistre(() => envoyer(cheminContrat(contrat.id), 'client@envoi-6a4d.test'), 'envoi de contrat')).ligne;
      for (const [ligne, deplacement] of [
        [parIntervention, { interventionId: null, contratMaintenanceId: contrat.id }],
        [parContrat, { contratMaintenanceId: autreContrat.id }],
      ]) {
        for (const data of [{ destinataire: 'autre@envoi-6a4d.test' }, { objet: 'TEST autre objet' }, { auteurNom: 'TEST Autre' }, { createdAt: new Date('2020-01-01T00:00:00Z') }, deplacement]) {
          await assert.rejects(prisma.envoiDocument.update({ where: { id: ligne.id }, data }), /Journal des envois : ajout seul/, JSON.stringify(data));
        }
        await assert.rejects(prisma.envoiDocument.delete({ where: { id: ligne.id } }), /Journal des envois : ajout seul/);
      }
      await assert.rejects(prisma.envoiDocument.deleteMany({ where: { interventionId: intervention.id } }), /Journal des envois : ajout seul/);
      await assert.rejects(prisma.envoiDocument.deleteMany({ where: { contratMaintenanceId: contrat.id } }), /Journal des envois : ajout seul/);
      await assert.rejects(prisma.$executeRawUnsafe('TRUNCATE "EnvoiDocument"'), /Vidage de « EnvoiDocument » interdit/);
      assert.deepEqual(await prisma.envoiDocument.findMany({ where: { id: { in: [parIntervention.id, parContrat.id] } }, orderBy: { createdAt: 'asc' } }), [parIntervention, parContrat]);
      // Horodatage imposé par la base, quelle que soit la date fournie, pour les deux nouveaux documents.
      const [{ maintenant }] = await prisma.$queryRaw`SELECT now() AS maintenant`;
      for (const colonne of ['interventionId', 'contratMaintenanceId']) {
        const id = randomUUID();
        await prisma.$executeRawUnsafe(`INSERT INTO "EnvoiDocument" ("id", "${colonne}", "canal", "destinataire", "objet", "auteurId", "auteurNom", "createdAt") VALUES ($1, $2, 'MESSAGERIE', 'client@envoi-6a4d.test', 'TEST Objet', $3, 'TEST Auteur', '2020-01-01T00:00:00Z')`,
          id, colonne === 'interventionId' ? intervention.id : contrat.id, secours.id);
        const { createdAt } = await prisma.envoiDocument.findUniqueOrThrow({ where: { id } });
        assert.ok(Math.abs(createdAt.getTime() - maintenant.getTime()) < 60_000, `${colonne} : ${createdAt.toISOString()}`);
      }
    });

    // « la contrainte est supprimée puis recréée sous le même nom, EnvoiDocument_un_document :
    // num_nonnulls("devisId", "factureId", "interventionId", "contratMaintenanceId") = 1 », recréée à son tour sur
    // cinq colonnes, avec "chantierId", par le lot 6a-4e (envoi-rapport-chantier.test.mjs) ; « deux
    // index : (interventionId, createdAt) et (contratMaintenanceId, createdAt) » ; « le canal reste
    // MESSAGERIE seul ».
    test('migration : EnvoiDocument_un_document refuse une ligne sans document et une ligne à deux documents, sur les quatre colonnes ; canal MESSAGERIE seul ; deux index', async () => {
      const s = suffixe();
      const [contrainte] = await prisma.$queryRaw`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = '"EnvoiDocument"'::regclass AND conname = 'EnvoiDocument_un_document'`;
      assert.equal(contrainte?.definition, 'CHECK ((num_nonnulls("devisId", "factureId", "interventionId", "contratMaintenanceId", "chantierId") = 1))');
      const index = (await prisma.$queryRaw`SELECT indexdef FROM pg_indexes WHERE tablename = 'EnvoiDocument'`).map((ligne) => ligne.indexdef.replace(/^.* USING btree /, ''));
      for (const colonnes of ['("interventionId", "createdAt")', '("contratMaintenanceId", "createdAt")', '("devisId", "createdAt")', '("factureId", "createdAt")']) {
        assert.ok(index.includes(colonnes), `index ${colonnes} absent : ${index.join(' ; ')}`);
      }
      const client = await creerClient(`TEST Client contrainte ${s}`);
      const intervention = await interventionEnCours(client.id, `TEST Demande contrainte ${s}`);
      const contrat = await creerContrat(client.id, `TEST Contrat contrainte ${s}`);
      const devis = await ok(appeler('post', '/devis', { clientId: client.id, objet: `TEST Devis contrainte ${s}`, lignes: [{ designation: 'TEST Ligne', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] }), 201);
      const factureId = randomUUID();
      await prisma.$executeRaw`INSERT INTO "Facture" ("id", "clientId", "clientRaisonSociale", "dateEcheance", "dateEmission", "origine", "motifHorsAffaire", "totalHt", "totalTtc", "totalTva", "updatedAt")
        VALUES (${factureId}, ${client.id}, ${client.raisonSociale}, now(), now(), 'HORS_AFFAIRE', 'TEST motif 6a4d', 0, 0, 0, now())`;
      const inserer = ({ devisId = null, factureId: facture = null, interventionId = null, contratMaintenanceId = null, canal = 'MESSAGERIE' } = {}) => prisma.$executeRaw`
        INSERT INTO "EnvoiDocument" ("id", "devisId", "factureId", "interventionId", "contratMaintenanceId", "canal", "destinataire", "objet", "auteurId", "auteurNom")
        VALUES (${randomUUID()}, ${devisId}, ${facture}, ${interventionId}, ${contratMaintenanceId}, ${canal}, 'client@envoi-6a4d.test', 'TEST Objet', ${secours.id}, 'TEST Auteur')`;
      const avant = await prisma.envoiDocument.count();
      for (const [donnees, nom] of [
        [{}, 'EnvoiDocument_un_document'],
        [{ interventionId: intervention.id, contratMaintenanceId: contrat.id }, 'EnvoiDocument_un_document'],
        [{ interventionId: intervention.id, devisId: devis.id }, 'EnvoiDocument_un_document'],
        [{ interventionId: intervention.id, factureId }, 'EnvoiDocument_un_document'],
        [{ contratMaintenanceId: contrat.id, devisId: devis.id }, 'EnvoiDocument_un_document'],
        [{ contratMaintenanceId: contrat.id, factureId }, 'EnvoiDocument_un_document'],
        [{ devisId: devis.id, factureId }, 'EnvoiDocument_un_document'],
        [{ devisId: devis.id, factureId, interventionId: intervention.id, contratMaintenanceId: contrat.id }, 'EnvoiDocument_un_document'],
        [{ interventionId: intervention.id, canal: 'MICROSOFT_365' }, 'EnvoiDocument_canal'],
        [{ contratMaintenanceId: contrat.id, canal: 'messagerie' }, 'EnvoiDocument_canal'],
      ]) await assert.rejects(inserer(donnees), new RegExp(`violates check constraint \\\\?"${nom}\\\\?"`), JSON.stringify(donnees));
      assert.equal(await prisma.envoiDocument.count(), avant, 'aucune ligne refusée n’est écrite');
      // Témoins : un seul document, quel qu'il soit, s'insère.
      for (const donnees of [{ interventionId: intervention.id }, { contratMaintenanceId: contrat.id }, { devisId: devis.id }, { factureId }]) {
        assert.equal(await inserer(donnees), 1, JSON.stringify(donnees));
      }
      assert.equal(await prisma.envoiDocument.count(), avant + 4);
    });

    // N8 : « la clé étrangère refuse la suppression d'une intervention ou d'un contrat qui porte un envoi,
    // prouvée sur une intervention sans compte rendu et un contrat sans visite (envoi inséré en SQL),
    // l'erreur nommant EnvoiDocument_interventionId_fkey et EnvoiDocument_contratMaintenanceId_fkey ».
    // Intervention et contrat sont créés directement, sans journal ni enfant : seule la clé du journal des
    // envois peut retenir leur suppression, ce que montrent les témoins, supprimés, eux.
    test('migration : clés étrangères ON DELETE RESTRICT ON UPDATE CASCADE ; une intervention sans compte rendu et un contrat sans visite qui portent un envoi ne se suppriment pas', async () => {
      const s = suffixe();
      const cles = await prisma.$queryRaw`SELECT conname, confrelid::regclass::text AS cible, confdeltype, confupdtype FROM pg_constraint
        WHERE conrelid = '"EnvoiDocument"'::regclass AND conname IN ('EnvoiDocument_interventionId_fkey', 'EnvoiDocument_contratMaintenanceId_fkey') ORDER BY conname`;
      assert.deepEqual(cles, [
        { conname: 'EnvoiDocument_contratMaintenanceId_fkey', cible: '"ContratMaintenance"', confdeltype: 'r', confupdtype: 'c' },
        { conname: 'EnvoiDocument_interventionId_fkey', cible: '"Intervention"', confdeltype: 'r', confupdtype: 'c' },
      ]);
      const client = await creerClient(`TEST Client clés ${s}`);
      const nouvelleIntervention = (rangTemoin) => prisma.intervention.create({ data: { reference: `TEST-FK-${s}-${rangTemoin}`, clientId: client.id, titre: `TEST Intervention clé ${s}` } });
      const nouveauContrat = () => prisma.contratMaintenance.create({ data: { clientId: client.id, titre: `TEST Contrat clé ${s}`, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: new Date('2030-01-01T00:00:00Z'), prochaineEcheance: new Date('2030-01-01T00:00:00Z') } });
      const intervention = await nouvelleIntervention('a');
      const interventionTemoin = await nouvelleIntervention('b');
      const contrat = await nouveauContrat();
      const contratTemoin = await nouveauContrat();
      assert.equal(await prisma.interventionRapport.count({ where: { interventionId: intervention.id } }), 0);
      assert.equal(await prisma.intervention.count({ where: { contratMaintenanceId: contrat.id } }), 0);
      for (const [colonne, id] of [['interventionId', intervention.id], ['contratMaintenanceId', contrat.id]]) {
        await prisma.$executeRawUnsafe(`INSERT INTO "EnvoiDocument" ("id", "${colonne}", "canal", "destinataire", "objet", "auteurId", "auteurNom") VALUES ($1, $2, 'MESSAGERIE', 'client@envoi-6a4d.test', 'TEST Objet', $3, 'TEST Auteur')`, randomUUID(), id, secours.id);
      }
      await assert.rejects(prisma.$executeRaw`DELETE FROM "Intervention" WHERE "id" = ${intervention.id}`, /EnvoiDocument_interventionId_fkey/);
      await assert.rejects(prisma.$executeRaw`DELETE FROM "ContratMaintenance" WHERE "id" = ${contrat.id}`, /EnvoiDocument_contratMaintenanceId_fkey/);
      assert.ok(await prisma.intervention.findUnique({ where: { id: intervention.id } }), 'l’intervention est gardée');
      assert.ok(await prisma.contratMaintenance.findUnique({ where: { id: contrat.id } }), 'le contrat est gardé');
      // Témoins sans envoi : la suppression passe.
      assert.equal(await prisma.$executeRaw`DELETE FROM "Intervention" WHERE "id" = ${interventionTemoin.id}`, 1);
      assert.equal(await prisma.$executeRaw`DELETE FROM "ContratMaintenance" WHERE "id" = ${contratTemoin.id}`, 1);
    });

    // « les envois de devis et de factures restent inchangés ». La migration de la PR est rejouée sur une
    // base arrêtée à la dernière migration de main (lot 6a-3 en place), qui porte déjà des envois de devis
    // et de factures : ces lignes ressortent identiques, les deux colonnes ajoutées vides ; les trois
    // déclencheurs sont les mêmes objets (mêmes identifiants), ni supprimés ni recréés (« La migration ne
    // les supprime ni ne les recrée »), et refusent toujours la modification d'une ligne ancienne.
    test('migration : appliquée sur le journal du lot 6a-3, elle garde ses envois de devis et de factures tels quels, et ses déclencheurs sans les recréer', async () => {
      const nomBaseEtape = `${nomBase}_etape`;
      const urlEtape = new URL(source);
      urlEtape.pathname = `/${nomBaseEtape}`;
      const dossier = mkdtempSync(join(tmpdir(), 'iris-envoi6a4d-migration-'));
      const migrations = join(dossier, 'migrations');
      const schema = join(dossier, 'schema.prisma');
      let creee = false;
      let db;
      try {
        await administrationPg.query(`CREATE DATABASE "${nomBaseEtape}"`);
        creee = true;
        copyFileSync(join(dossierPrisma, 'schema.prisma'), schema);
        mkdirSync(migrations);
        copyFileSync(join(dossierPrisma, 'migrations/migration_lock.toml'), join(migrations, 'migration_lock.toml'));
        const toutes = readdirSync(join(dossierPrisma, 'migrations')).filter((nom) => nom !== 'migration_lock.toml').sort();
        assert.ok(toutes.includes(DERNIERE_MIGRATION_MAIN), 'dernière migration de main absente');
        const deMain = toutes.filter((nom) => nom <= DERNIERE_MIGRATION_MAIN);
        const duLot = toutes.filter((nom) => nom > DERNIERE_MIGRATION_MAIN && nom <= MIGRATION_DU_LOT);
        assert.deepEqual(duLot, [MIGRATION_DU_LOT], 'migration du lot');
        for (const nom of deMain) cpSync(join(dossierPrisma, 'migrations', nom), join(migrations, nom), { recursive: true });
        const deployer = () => execFileSync(binairePrisma, ['migrate', 'deploy', '--schema', schema], {
          env: { ...process.env, DATABASE_URL: urlEtape.toString() }, encoding: 'utf8', stdio: 'pipe', timeout: 180_000,
        });
        deployer();
        db = new pg.Client({ connectionString: urlEtape.toString() });
        await db.connect();
        await db.query(`INSERT INTO "Client" ("id", "raisonSociale", "updatedAt") VALUES ('client-6a3', 'TEST Client du lot 6a-3', now())`);
        await db.query(`INSERT INTO "Devis" ("id", "clientId", "dossierId", "numero", "objet", "totalHt", "totalTtc", "totalTva", "updatedAt", "version") VALUES ('devis-6a3', 'client-6a3', 'dossier-6a3', 'D-6A3', 'TEST Devis du lot 6a-3', 0, 0, 0, now(), 1)`);
        await db.query(`INSERT INTO "Facture" ("id", "clientId", "clientRaisonSociale", "dateEcheance", "dateEmission", "origine", "motifHorsAffaire", "totalHt", "totalTtc", "totalTva", "updatedAt") VALUES ('facture-6a3', 'client-6a3', 'TEST Client du lot 6a-3', now(), now(), 'HORS_AFFAIRE', 'TEST motif 6a-3', 0, 0, 0, now())`);
        for (const [id, colonne, document, destinataire] of [['envoi-devis-1', 'devisId', 'devis-6a3', 'un@client-6a3.test'], ['envoi-devis-2', 'devisId', 'devis-6a3', 'deux@client-6a3.test'], ['envoi-facture', 'factureId', 'facture-6a3', 'compta@client-6a3.test']]) {
          await db.query(`INSERT INTO "EnvoiDocument" ("id", "${colonne}", "canal", "destinataire", "objet", "auteurId", "auteurNom") VALUES ($1, $2, 'MESSAGERIE', $3, 'TEST Objet du lot 6a-3', 'compte-6a3', 'TEST Auteur 6a-3')`, [id, document, destinataire]);
        }
        const lignes = async () => (await db.query('SELECT row_to_json(e) AS ligne FROM "EnvoiDocument" e ORDER BY "id"')).rows.map((r) => r.ligne);
        const declencheurs = async () => (await db.query(`SELECT tgname, oid::text AS oid, tgfoid::text AS fonction, tgenabled FROM pg_trigger WHERE tgrelid = '"EnvoiDocument"'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows;
        const avant = await lignes();
        const declencheursAvant = await declencheurs();
        assert.equal(avant.length, 3);
        assert.deepEqual(declencheursAvant.map((d) => d.tgname), ['envoi_document_ajout_seul', 'envoi_document_horodatage', 'envoi_document_sans_vidage']);

        for (const nom of duLot) cpSync(join(dossierPrisma, 'migrations', nom), join(migrations, nom), { recursive: true });
        deployer();
        const appliquees = (await db.query('SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL')).rows.map((r) => r.migration_name);
        for (const nom of duLot) assert.ok(appliquees.includes(nom), `migration ${nom} non appliquée`);
        assert.deepEqual(await lignes(), avant.map((ligne) => ({ ...ligne, interventionId: null, contratMaintenanceId: null })));
        assert.deepEqual(await declencheurs(), declencheursAvant, 'déclencheurs supprimés ou recréés');
        const { rows: [{ definition }] } = await db.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = '"EnvoiDocument"'::regclass AND conname = 'EnvoiDocument_un_document'`);
        assert.equal(definition, 'CHECK ((num_nonnulls("devisId", "factureId", "interventionId", "contratMaintenanceId") = 1))');
        await assert.rejects(db.query(`UPDATE "EnvoiDocument" SET "destinataire" = 'autre@client-6a3.test' WHERE "id" = 'envoi-facture'`), /Journal des envois : ajout seul/);
        await assert.rejects(db.query(`DELETE FROM "EnvoiDocument" WHERE "id" = 'envoi-devis-1'`), /Journal des envois : ajout seul/);
        await assert.rejects(db.query('DELETE FROM "Devis" WHERE "id" = \'devis-6a3\''), /EnvoiDocument_devisId_fkey/);
        assert.deepEqual(await lignes(), avant.map((ligne) => ({ ...ligne, interventionId: null, contratMaintenanceId: null })));
      } finally {
        await db?.end().catch(() => {});
        if (creee) await administrationPg.query(`DROP DATABASE IF EXISTS "${nomBaseEtape}" WITH (FORCE)`);
        rmSync(dossier, { recursive: true, force: true });
      }
    });

    // Cadrage, « Hors périmètre » : « Toute modification de l'envoi des devis, factures et avoirs ». Sur la
    // base migrée, l'envoi d'un devis s'enregistre comme au lot 6a-3 (réponse, journal, brouillon passé
    // « envoyé »), sans intervention ni contrat. La suite du lot 6a-3 (api.test.mjs) le prouve en entier.
    test('envoi d’un devis inchangé sur la base migrée : même réponse, même ligne au journal, sans intervention ni contrat', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client devis ${s}`);
      const devis = await ok(appeler('post', '/devis', { clientId: client.id, objet: `TEST Devis envoyé ${s}`, lignes: [{ designation: 'TEST Prestation', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }), 201);
      const res = await envoyer(`/devis/${devis.id}`, 'client@envoi-6a4d.test');
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.deepEqual(Object.keys(res.body).sort(), ['corps', 'envoi', 'objet', 'statutDevis']);
      assert.equal(res.body.statutDevis, 'ENVOYE');
      assert.equal(res.body.objet, `Devis ${devis.numero} version 1 – ${SOCIETE.raisonSociale}`);
      assert.equal(res.body.corps, `Bonjour,\n\nVeuillez trouver ci-joint notre devis ${devis.numero} (version 1).\n\nCordialement,\n${SOCIETE.raisonSociale}`);
      const ligne = await prisma.envoiDocument.findUniqueOrThrow({ where: { id: res.body.envoi.id } });
      assert.deepEqual([ligne.devisId, ligne.factureId, ligne.interventionId, ligne.contratMaintenanceId], [devis.id, null, null, null]);
      assert.deepEqual((await lire(`/devis/${devis.id}`)).body.envois, [res.body.envoi]);
    });
  });
}
