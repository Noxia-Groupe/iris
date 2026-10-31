// Lot 6a-4b : PDF du contrat de maintenance (cadrage du lot 6a-4, version 2, section « 6a-4b » ;
// décisions de Nelson du 22-10-2026, point 4, « Tous type de document », et du 31-10-2026, « le
// prochain lot est la fin du lot 6 »). Fichier propre au lot (remarque N10 du contrôle de cohérence) :
// rien n'est ajouté à api.test.mjs.
//
// Base dédiée. `npm test` passe tous les fichiers *.test.mjs à `node --test`, qui les exécute EN
// PARALLÈLE. Sur la base de api.test.mjs, ce fichier subirait son nettoyage (clients « TEST »), ses
// changements de l'identité et du fuseau de la société, et la génération des visites de tous les
// contrats actifs ; et son propre test de l'identité incomplète ferait échouer, au même instant, une
// émission de facture ou une signature de devis de api.test.mjs. Comme les tests de migration,
// TEST_DATABASE_URL ne sert donc ici que de connexion administrative : une base neuve est créée,
// migrée (`prisma migrate deploy`), servie à l'application montée en mémoire, puis supprimée.
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import { PDFParse } from 'pdf-parse';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  describe('PDF du contrat de maintenance (lot 6a-4b)', { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  // --- Base jetable dédiée, sur le PostgreSQL local de TEST_DATABASE_URL ---
  const prismaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../prisma');
  const connexion = new URL(TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(connexion.hostname), 'seul PostgreSQL local est autorisé');
  // Le nom porte « test » comme mot (règle de client/scripts/base-jetable.mjs) et un suffixe tiré au
  // hasard : deux exécutions simultanées ne partagent jamais leur base.
  const nomBase = `iris_test_contrat_pdf_${randomBytes(6).toString('hex')}`;
  assert.notEqual(connexion.pathname.slice(1), nomBase);
  const maintenance = new URL(connexion);
  maintenance.pathname = '/postgres';
  const urlBase = new URL(connexion);
  urlBase.pathname = `/${nomBase}`;
  const administrer = async (sql) => {
    const admin = new pg.Client({ connectionString: maintenance.toString() });
    await admin.connect();
    try { await admin.query(sql); } finally { await admin.end(); }
  };
  const supprimerBase = () => administrer(`DROP DATABASE IF EXISTS "${nomBase}" WITH (FORCE)`);
  await administrer(`CREATE DATABASE "${nomBase}"`);

  let request; let app; let initDb; let ensureSuperAdmins; let jourCivilEntreprise; let appPrisma; let prisma; let jwt;
  try {
    execFileSync(resolve(prismaDir, '../node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', join(prismaDir, 'schema.prisma')], {
      env: { ...process.env, DATABASE_URL: urlBase.toString() }, encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
    });
    process.env.DATABASE_URL = urlBase.toString();
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'secret-de-test-uniquement';
    process.env.BREAK_GLASS_EMAIL = 'secours@iris.test';
    process.env.BREAK_GLASS_TOKEN = 'jeton-de-secours-de-test-au-moins-32-caracteres';
    process.env.SUPERADMIN_EMAILS = 'secours@iris.test';
    request = (await import('supertest')).default;
    ({ app, initDb, ensureSuperAdmins, jourCivilEntreprise, prisma: appPrisma } = await import('../dist/index.js'));
    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient();
    jwt = (await import('jsonwebtoken')).default;
  } catch (erreur) {
    await supprimerBase();
    throw erreur;
  }

  // --- Constantes du cadrage et données de test ---
  // Mention imprimée sous le titre (cadrage, « Nature du document », N15), mot pour mot.
  const MENTION = 'Récapitulatif du contrat enregistré ; ce document ne porte ni prix ni signature.';
  const IDENTITE = {
    raisonSociale: 'TEST Société émettrice contrat 6a4b', nomCommercial: null, siret: '44444444400044', tvaIntra: null,
    adresse: '4 rue du Récapitulatif', codePostal: '14000', ville: 'Caen', fuseauHoraire: 'Europe/Paris',
  };
  // Motif de l'annulation du devis, que le contrat annulé reprend : jamais imprimé (cadrage, « Statuts »).
  const MOTIF_ANNULATION = 'TEST Motif confidentiel de l’annulation 6a4b';
  const ROLES_NON_ADMINISTRATEURS = ['CONDUCTEUR_TRAVAUX', 'COMMERCIAL', 'ASSISTANTE_COMMERCIALE', 'TECHNICIEN', 'COMPTABLE', 'DIRECTEUR_COMMERCIAL', 'RESPONSABLE', 'DIRECTEUR'];
  const TOUS_LES_SCOPES = ['clients:read', 'clients:write', 'catalogue:read', 'catalogue:write', 'equipements:read', 'equipements:write', 'devis:read', 'devis:write', 'company:read', 'chantiers:read', 'chantiers:write', 'chantiers:archive', 'finances:read'];
  const suffixe = `${Date.now()}`;

  // --- Aides ---
  let session = '';
  const admin = () => ({ Authorization: `Bearer ${session}` });
  const jetonDe = (userId) => ({ Authorization: `Bearer ${jwt.sign({ id: userId }, process.env.JWT_SECRET)}` });
  const envoyer = (methode, chemin, corps, enTete = admin()) => request(app)[methode](`/api${chemin}`).set(enTete).send(corps ?? {});
  const ok = async (reponse, statut = 200) => {
    const res = await reponse;
    assert.equal(res.status, statut, `${res.req?.method} ${res.req?.path} : ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const cheminPdf = (id) => `/api/contrats-maintenance/${id}/document.pdf`;
  // Réponse lue en octets : le PDF n'est jamais converti en texte par supertest.
  const pdfBrut = (id, enTete = admin()) => request(app).get(cheminPdf(id)).set(enTete).buffer(true)
    .parse((reponse, fin) => { const morceaux = []; reponse.on('data', (m) => morceaux.push(m)); reponse.on('end', () => fin(null, Buffer.concat(morceaux))); });
  // Texte extrait du PDF, comme les tests du PDF du devis (api.test.mjs).
  const lirePdf = async (id, enTete = admin()) => {
    const res = await pdfBrut(id, enTete);
    assert.equal(res.status, 200, res.body.toString('utf8'));
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.equal(res.body.subarray(0, 5).toString('latin1'), '%PDF-');
    const lecteur = new PDFParse({ data: res.body });
    try {
      return { texte: (await lecteur.getText()).text, disposition: res.headers['content-disposition'] };
    } finally {
      await lecteur.destroy();
    }
  };
  const sansBlancs = (texte) => texte.replace(/\s+/g, '');
  const contient = (texte, attendu) => sansBlancs(texte).includes(sansBlancs(attendu));
  const compter = (texte, motif) => [...texte.matchAll(new RegExp(motif.source, motif.flags.includes('g') ? motif.flags : `${motif.flags}g`))].length;
  // Libellés des statuts du contrat (cadrage : « actif, suspendu, terminé ou annulé »), bornés par des
  // lettres : « Terminée » ou « Annulée », statuts d'une visite, ne sont pas ceux du contrat.
  const LIBELLES_CONTRAT = {
    ACTIF: /(?<!\p{L})actif(?!\p{L})/iu,
    SUSPENDU: /(?<!\p{L})suspendu(?!\p{L})/iu,
    TERMINE: /(?<!\p{L})terminé(?!\p{L})/iu,
    ANNULE: /(?<!\p{L})annulé(?!\p{L})/iu,
  };
  const LIBELLES_VISITE = {
    A_PLANIFIER: /(?<!\p{L})à planifier(?!\p{L})/iu,
    PLANIFIEE: /(?<!\p{L})planifiée(?!\p{L})/iu,
    EN_COURS: /(?<!\p{L})en cours(?!\p{L})/iu,
    TERMINEE: /(?<!\p{L})terminée(?!\p{L})/iu,
    ANNULEE: /(?<!\p{L})annulée(?!\p{L})/iu,
  };
  // Codes techniques : jamais imprimés à la place des libellés français. ACTIF et SUSPENDU s'écrivent
  // comme leur libellé en capitales : seuls les codes qui en diffèrent sont recherchés.
  const CODES_TECHNIQUES = /(?<![\p{L}_])(TERMINE|ANNULE|A_PLANIFIER|PLANIFIEE|EN_COURS|TERMINEE|ANNULEE|HORS_FORFAIT)(?![\p{L}_])/u;
  const verifierStatutContrat = (texte, statut) => {
    assert.match(texte, LIBELLES_CONTRAT[statut], `statut ${statut} en libellé français\n${texte}`);
    for (const [autre, motif] of Object.entries(LIBELLES_CONTRAT)) {
      if (autre !== statut) assert.doesNotMatch(texte, motif, `statut ${autre} imprimé pour un contrat ${statut}\n${texte}`);
    }
    assert.doesNotMatch(texte, CODES_TECHNIQUES, `code technique imprimé\n${texte}`);
  };
  // Aucun montant (cadrage, « Hors périmètre ») : ni symbole monétaire, ni décimale à la française, ni
  // HT/TTC.
  const verifierSansMontant = (texte) => {
    assert.ok(!texte.includes('€') && !/EUR(?!\p{L})/u.test(texte), `symbole monétaire imprimé\n${texte}`);
    assert.doesNotMatch(texte, /\d,\d{2}(?!\d)/, `montant imprimé\n${texte}`);
    assert.doesNotMatch(texte, /(?<!\p{L})(HT|TTC)(?!\p{L})/u, `mention HT/TTC imprimée\n${texte}`);
  };
  // Jour de l'exécution, dans les fuseaux où il peut tomber : seule date de réalisation qu'Iris connaisse
  // d'une visite terminée pendant ce test (journal, compte rendu), et date de demande de la suite.
  const joursDuJour = () => {
    const maintenant = new Date();
    return [...new Set(['UTC', 'Europe/Paris', 'Pacific/Tahiti', 'Pacific/Kiritimati'].map((fuseau) => jourCivilEntreprise(maintenant, fuseau).split('-').reverse().join('-')))];
  };
  // État de la base : une impression, acceptée ou refusée, n'écrit rien.
  const etatBase = async () => ({
    contrats: await prisma.contratMaintenance.findMany({ orderBy: { id: 'asc' } }),
    interventions: await prisma.intervention.findMany({ orderBy: { id: 'asc' }, select: { id: true, statut: true, updatedAt: true } }),
    journalSaisies: await prisma.journalSaisieChantier.count(),
    journalAdministration: await prisma.journalAdministration.count(),
    envois: await prisma.envoiDocument.count(),
    societe: await prisma.companySettings.findUnique({ where: { id: 'singleton' } }),
  });
  const refusSansEcriture = async (appel, statut, contexte) => {
    const avant = await etatBase();
    const res = await appel();
    assert.equal(res.status, statut, `${contexte} : ${res.status} ${res.text}`);
    assert.notEqual(res.headers['content-type'], 'application/pdf', `${contexte} : aucun PDF`);
    assert.deepEqual(await etatBase(), avant, `${contexte} : rien n’est écrit`);
    return res;
  };
  const definirSociete = (donnees) => prisma.companySettings.update({ where: { id: 'singleton' }, data: donnees });

  // Clients, devis, contrats et visites, par les routes de l'application.
  const creerClient = async (raisonSociale) => ok(envoyer('post', '/clients', { raisonSociale, siren: String(randomInt(100_000_000, 1_000_000_000)) }), 201);
  const contratDepuisDevis = async (clientId, objet, prixUnitaireHt, contrat) => {
    const devis = await ok(envoyer('post', '/devis', { clientId, objet, lignes: [{ designation: 'TEST Visite de maintenance', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt, tauxTva: 20 }] }), 201);
    await ok(envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' }));
    await ok(envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'TEST Signataire 6a4b', confirme: true }), 201);
    const cree = await ok(envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CONTRAT', ...contrat }), 201);
    return { devis: await prisma.devis.findUniqueOrThrow({ where: { id: devis.id } }), contrat: cree };
  };
  const genererVisite = (contratId) => ok(envoyer('post', `/contrats-maintenance/${contratId}/generer-intervention`), 201);
  const statutVisite = (id, corps) => ok(envoyer('patch', `/interventions/${id}/statut`, corps));
  const demarrerVisite = async (id) => {
    await statutVisite(id, { statut: 'PLANIFIEE' });
    await statutVisite(id, { statut: 'EN_COURS' });
  };
  const terminerVisite = async (id) => {
    await demarrerVisite(id);
    await ok(envoyer('post', `/interventions/${id}/rapports`, { contenu: 'TEST Compte rendu de la visite 6a4b.', cleEnvoi: randomUUID() }), 201);
    await statutVisite(id, { statut: 'TERMINEE', motifSansSignature: 'CLIENT_ABSENT' });
  };
  const avancerEcheance = (contratId) => ok(envoyer('post', `/contrats-maintenance/${contratId}/avancer-echeance`));
  const statutContrat = (contratId, statut, motif) => ok(envoyer('patch', `/contrats-maintenance/${contratId}/statut`, { statut, motif }));

  describe('PDF du contrat de maintenance (lot 6a-4b)', () => {
    // Jeu de données :
    //  - client principal, trois sites : le site du contrat (Alpha, intervention), le site de
    //    facturation (Zulu) et un site principal (Bravo). L'ordre de la facture retient le site de
    //    facturation ; l'ordre des noms retiendrait Alpha, le site principal Bravo, le site du contrat Alpha ;
    //  - contrat actif issu d'un devis à 987,65 € HT, échéances tous les 3 mois depuis le 01-01-2025 :
    //    visites du 01-01-2025 et du 01-04-2025 terminées, visite du 01-07-2025 à planifier, et une suite
    //    de la première visite (le contrat, sans échéance) ;
    //  - contrat suspendu (client sans site, contrat sans site), sa visite planifiée ;
    //  - contrat terminé, sa visite en cours ;
    //  - contrat annulé avec son devis, sa visite annulée.
    const f = {};

    before(async () => {
      await initDb();
      await ensureSuperAdmins();
      const secours = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      assert.equal(secours.status, 200, JSON.stringify(secours.body));
      session = secours.body.token;
      await prisma.companySettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', ...IDENTITE }, update: IDENTITE });

      f.client = await creerClient(`TEST Client contrat PDF ${suffixe}`);
      f.siteContrat = await prisma.clientSite.create({ data: { clientId: f.client.id, nom: 'TEST Alpha chaufferie', adresse: '10 rue du Site Contrat', codePostal: '14400', ville: 'Bayeux', estSiteIntervention: true } });
      f.siteFacturation = await prisma.clientSite.create({ data: { clientId: f.client.id, nom: 'TEST Zulu facturation', adresse: '20 avenue de la Facturation', complementAdresse: 'Bâtiment B', codePostal: '75002', ville: 'Paris', estSiteFacturation: true } });
      f.sitePrincipal = await prisma.clientSite.create({ data: { clientId: f.client.id, nom: 'TEST Bravo principal', adresse: '30 boulevard Principal', codePostal: '14100', ville: 'Lisieux', principal: true } });

      // Contrat actif, issu d'un devis.
      ({ devis: f.devisActif, contrat: f.actif } = await contratDepuisDevis(f.client.id, 'TEST Devis du contrat actif 6a4b', 987.65, {
        titre: 'TEST Maintenance annuelle chaufferie', siteId: f.siteContrat.id, periodiciteMois: 3, dureePrevisionnelleMinutes: 90, dateDebut: '01-01-2025',
        politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'HORS_FORFAIT', noteCouverture: 'TEST Note : pièces d’usure exclues',
      }));
      f.visite1 = await genererVisite(f.actif.id);
      await terminerVisite(f.visite1.id);
      await avancerEcheance(f.actif.id);
      f.visite2 = await genererVisite(f.actif.id);
      await terminerVisite(f.visite2.id);
      await avancerEcheance(f.actif.id);
      f.visite3 = await genererVisite(f.actif.id);
      f.suite = await ok(envoyer('post', `/interventions/${f.visite1.id}/suites`, { titre: 'TEST Suite non listée 6a4b' }), 201);
      const suite = await prisma.intervention.findUniqueOrThrow({ where: { id: f.suite.id } });
      assert.deepEqual([suite.contratMaintenanceId, suite.echeanceContrat, suite.statut], [f.actif.id, null, 'A_PLANIFIER'], 'la suite porte le contrat sans échéance');
      assert.deepEqual((await prisma.intervention.findMany({ where: { id: { in: [f.visite1.id, f.visite2.id, f.visite3.id] } }, orderBy: { echeanceContrat: 'asc' } })).map((v) => [v.echeanceContrat.toISOString().slice(0, 10), v.statut]),
        [['2025-01-01', 'TERMINEE'], ['2025-04-01', 'TERMINEE'], ['2025-07-01', 'A_PLANIFIER']]);
      assert.equal((await prisma.contratMaintenance.findUniqueOrThrow({ where: { id: f.actif.id } })).prochaineEcheance.toISOString().slice(0, 10), '2025-07-01');

      // Contrat suspendu, créé directement, pour un client sans site.
      f.clientSansSite = await creerClient(`TEST Client sans site contrat PDF ${suffixe}`);
      f.suspendu = await ok(envoyer('post', '/contrats-maintenance', {
        clientId: f.clientSansSite.id, titre: 'TEST Contrat en pause 6a4b', periodiciteMois: 12, dureePrevisionnelleMinutes: 45, dateDebut: '15-02-2025',
        politiqueMainOeuvre: 'HORS_FORFAIT', politiqueMateriel: 'INCLUS',
      }), 201);
      f.visiteSuspendu = await genererVisite(f.suspendu.id);
      await statutVisite(f.visiteSuspendu.id, { statut: 'PLANIFIEE' });
      await statutContrat(f.suspendu.id, 'SUSPENDU', 'TEST Suspension du contrat 6a4b');

      // Contrat terminé, sa visite en cours.
      f.termine = await ok(envoyer('post', '/contrats-maintenance', {
        clientId: f.client.id, siteId: f.siteContrat.id, titre: 'TEST-Contrat-termine-6a4b', periodiciteMois: 6, dureePrevisionnelleMinutes: 120, dateDebut: '10-03-2025',
      }), 201);
      f.visiteTermine = await genererVisite(f.termine.id);
      await demarrerVisite(f.visiteTermine.id);
      await statutContrat(f.termine.id, 'TERMINE', 'TEST Clôture du contrat 6a4b');

      // Contrat annulé avec son devis, sa visite annulée avec lui.
      ({ devis: f.devisAnnule, contrat: f.annule } = await contratDepuisDevis(f.client.id, 'TEST Devis du contrat annulé 6a4b', 432.1, {
        titre: 'TEST Contrat issu du devis 6a4b', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '20-05-2025',
      }));
      f.visiteAnnule = await genererVisite(f.annule.id);
      await ok(envoyer('post', `/devis/${f.devisAnnule.id}/annulation`, { motif: MOTIF_ANNULATION }));
      const annule = await prisma.contratMaintenance.findUniqueOrThrow({ where: { id: f.annule.id } });
      assert.deepEqual([annule.statut, annule.motifAnnulation], ['ANNULE', MOTIF_ANNULATION]);
      assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id: f.visiteAnnule.id } })).statut, 'ANNULEE');
      assert.deepEqual((await prisma.contratMaintenance.findMany({ where: { id: { in: [f.suspendu.id, f.termine.id] } }, orderBy: { titre: 'asc' } })).map((c) => c.statut).sort(), ['SUSPENDU', 'TERMINE']);
      // Aucun intitulé, client ou site ne porte un libellé de statut : sa présence dans le PDF ne vaut que pour le statut.
      for (const nom of [f.actif.titre, f.suspendu.titre, f.termine.titre, f.annule.titre, f.client.raisonSociale, f.clientSansSite.raisonSociale, f.siteContrat.nom]) {
        for (const motif of [...Object.values(LIBELLES_CONTRAT), ...Object.values(LIBELLES_VISITE)]) assert.doesNotMatch(nom, motif, `jeu de données : ${nom}`);
      }
    });

    after(async () => {
      await prisma.$disconnect();
      await appPrisma.$disconnect();
      await supprimerBase();
    });

    // Cadrage, « Nature du document » et « Contenu imprimé » ; choix par défaut : identité actuelle,
    // adresse de facturation imprimée.
    test('contenu : identité de la société, titre et mention « récapitulatif », intitulé, statut, client, site, facturation, échéances, couverture et devis d’origine', async () => {
      const avant = await etatBase();
      const { texte } = await lirePdf(f.actif.id);
      assert.deepEqual(await etatBase(), avant, 'l’impression n’écrit rien');
      // En-tête : l'identité actuelle de la société.
      for (const attendu of [IDENTITE.raisonSociale, `SIRET ${IDENTITE.siret}`, IDENTITE.adresse]) assert.ok(contient(texte, attendu), `absent du PDF : ${attendu}\n${texte}`);
      // Le titre, puis, sous lui, la mention mot pour mot (comparée sans les blancs : elle peut passer à la ligne).
      const compact = sansBlancs(texte);
      const titre = compact.search(/Contratdemaintenance/i);
      assert.ok(titre >= 0, `titre « Contrat de maintenance » absent\n${texte}`);
      assert.ok(compact.indexOf(sansBlancs(MENTION)) > titre, `mention « récapitulatif » absente ou avant le titre\n${texte}`);
      // Intitulé et statut en libellé français.
      assert.ok(texte.includes('TEST Maintenance annuelle chaufferie'), texte);
      verifierStatutContrat(texte, 'ACTIF');
      // Client et site concerné, avec son adresse.
      for (const attendu of [f.client.raisonSociale, 'TEST Alpha chaufferie', '10 rue du Site Contrat', '14400', 'Bayeux']) assert.ok(contient(texte, attendu), `absent du PDF : ${attendu}\n${texte}`);
      // Adresse de facturation, selon l'ordre de la facture : le site de facturation, et non le site
      // principal (ordre écarté : principal d'abord) ni le site du contrat ou le premier par son nom.
      for (const attendu of ['20 avenue de la Facturation', 'Bâtiment B', '75002', 'Paris']) assert.ok(contient(texte, attendu), `adresse de facturation absente : ${attendu}\n${texte}`);
      for (const ecarte of ['TEST Bravo principal', '30 boulevard Principal', 'Lisieux']) assert.ok(!contient(texte, ecarte), `site principal imprimé : ${ecarte}\n${texte}`);
      // Date de début, périodicité « tous les N mois », durée d'une visite en heures et minutes (90 min),
      // prochaine échéance ; dates en JJ-MM-AAAA.
      assert.match(texte, /d[ée]but[^\n]*01-01-2025/iu, texte);
      assert.match(texte, /tous\s+les\s+3\s+mois/i, texte);
      assert.match(texte, /(?<![\d,])1\s?h\s?30\s?min/u, `durée d’une visite (1 h 30 min) absente\n${texte}`);
      assert.match(texte, /échéance[^\n]*01-07-2025/iu, texte);
      // Couverture : main-d'œuvre incluse, matériel hors forfait, et la note.
      assert.match(texte, /main-d[’']\s*œuvre\s*:?\s*incluse/iu, texte);
      assert.match(texte, /matériel\s*:?\s*hors\s+forfait/iu, texte);
      assert.ok(contient(texte, 'TEST Note : pièces d’usure exclues'), texte);
      // Référence du devis d'origine, et pas celle d'un autre devis du client.
      assert.ok(texte.includes(f.devisActif.numero), `devis d’origine absent\n${texte}`);
      assert.ok(!texte.includes(f.devisAnnule.numero), texte);
      // Ni signature ni conditions générales (cadrage, « Hors périmètre ») : pas de cadre « Bon pour accord ».
      assert.doesNotMatch(texte, /bon pour accord|signature du client/iu, texte);
    });

    // Cadrage, « Visites » (N3) : les interventions qui portent une échéance, avec cette échéance et
    // leur statut en libellé français ; ni les suites, ni date de réalisation.
    test('visites : chaque échéance avec son statut en français ; la suite, sans échéance, n’est pas listée ; aucune date de réalisation', async () => {
      const { texte } = await lirePdf(f.actif.id);
      // Le 01-04-2025 n'est l'échéance que de la deuxième visite ; le 01-01-2025 est aussi la date de
      // début, le 01-07-2025 aussi la prochaine échéance : chacun figure donc deux fois au moins.
      assert.ok(texte.includes('01-04-2025'), `échéance de la deuxième visite absente\n${texte}`);
      assert.ok(compter(texte, /01-01-2025/) >= 2, `échéance de la première visite absente\n${texte}`);
      assert.ok(compter(texte, /01-07-2025/) >= 2, `échéance de la troisième visite absente\n${texte}`);
      assert.equal(compter(texte, LIBELLES_VISITE.TERMINEE), 2, `deux visites terminées\n${texte}`);
      // Une seule visite à planifier : la suite, à planifier elle aussi, n'est pas listée.
      assert.equal(compter(texte, LIBELLES_VISITE.A_PLANIFIER), 1, `une seule visite à planifier, sans la suite\n${texte}`);
      assert.ok(!contient(texte, 'TEST Suite non listée 6a4b'), `titre de la suite imprimé\n${texte}`);
      assert.ok(!texte.includes(f.suite.reference), `référence de la suite imprimée\n${texte}`);
      assert.doesNotMatch(texte, CODES_TECHNIQUES, texte);
      // Aucune date de réalisation : ni le mot, ni le jour où les visites ont été terminées pendant ce test.
      assert.doesNotMatch(texte, /réalis/iu, texte);
      for (const jour of joursDuJour()) assert.ok(!texte.includes(jour), `date du jour (${jour}) imprimée\n${texte}`);
    });

    // Cadrage, « Hors périmètre » : un contrat ne porte aucun montant, et le PDF n'en invente aucun. Le
    // devis d'origine en porte (987,65 € HT, 197,53 € de TVA, 1 185,18 € TTC) : aucun n'est repris.
    test('aucun montant : ni les totaux du devis d’origine, ni symbole monétaire, ni HT/TTC', async () => {
      for (const contrat of [f.actif, f.annule]) {
        const { texte } = await lirePdf(contrat.id);
        for (const montant of ['987,65', '197,53', '185,18', '432,10', '86,42', '518,52']) assert.ok(!sansBlancs(texte).includes(montant), `montant ${montant} imprimé\n${texte}`);
        verifierSansMontant(texte);
      }
    });

    // Choix par défaut, à confirmer : l'identité actuelle de la société, et non une copie figée.
    test('identité actuelle : la société renommée s’imprime au tirage suivant', async () => {
      try {
        await definirSociete({ raisonSociale: 'TEST Société renommée 6a4b' });
        const { texte } = await lirePdf(f.actif.id);
        assert.ok(texte.includes('TEST Société renommée 6a4b'), texte);
        assert.ok(!texte.includes(IDENTITE.raisonSociale), `ancienne raison sociale imprimée\n${texte}`);
      } finally {
        await definirSociete({ raisonSociale: IDENTITE.raisonSociale });
      }
    });

    // CLAUDE.md : dates en JJ-MM-AAAA, « fuseau d'entreprise pour la date civile, stockage technique
    // distinct ». Les dates du contrat sont des dates seules, stockées à minuit UTC (commun/dates.ts,
    // dateSeuleEnJourCivil) : relues au fuseau de Tahiti (UTC−10), elles reculeraient d'un jour, et
    // d'une année pour le 01-01-2025. Lecture écartée : conversion au fuseau de la société.
    test('dates : début, échéances et prochaine échéance s’impriment telles que saisies, même au fuseau de Tahiti', async () => {
      try {
        await definirSociete({ fuseauHoraire: 'Pacific/Tahiti' });
        const { texte } = await lirePdf(f.actif.id);
        for (const attendu of ['01-01-2025', '01-04-2025', '01-07-2025']) assert.ok(texte.includes(attendu), `date ${attendu} absente\n${texte}`);
        for (const decale of ['31-12-2024', '31-03-2025', '30-06-2025']) assert.ok(!texte.includes(decale), `date décalée d’un jour (${decale})\n${texte}`);
      } finally {
        await definirSociete({ fuseauHoraire: IDENTITE.fuseauHoraire });
      }
    });

    // Cadrage, « Statuts » : un contrat suspendu ou terminé s'imprime avec son statut.
    test('contrat suspendu : imprimé avec son statut, sa visite planifiée, sa couverture ; client sans site', async () => {
      const { texte } = await lirePdf(f.suspendu.id);
      assert.ok(texte.includes('TEST Contrat en pause 6a4b') && contient(texte, f.clientSansSite.raisonSociale), texte);
      verifierStatutContrat(texte, 'SUSPENDU');
      assert.ok(compter(texte, /15-02-2025/) >= 2, `date de début et échéance de la visite\n${texte}`);
      assert.equal(compter(texte, LIBELLES_VISITE.PLANIFIEE), 1, `visite planifiée\n${texte}`);
      assert.doesNotMatch(texte, LIBELLES_VISITE.A_PLANIFIER, texte);
      assert.match(texte, /(?<![\d,])45\s?min/u, `durée de 45 minutes\n${texte}`);
      assert.match(texte, /main-d[’']\s*œuvre\s*:?\s*hors\s+forfait/iu, texte);
      assert.match(texte, /matériel\s*:?\s*inclus(?!\p{L})/iu, texte);
      // Créé directement, il n'a pas de devis d'origine ; le client n'a aucun site : aucune adresse
      // d'un autre client ne s'imprime.
      for (const ecarte of [f.devisActif.numero, f.devisAnnule.numero, '20 avenue de la Facturation', '10 rue du Site Contrat']) assert.ok(!texte.includes(ecarte), `${ecarte}\n${texte}`);
      assert.ok(!contient(texte, 'TEST Suspension du contrat 6a4b'), `motif de suspension imprimé\n${texte}`);
      verifierSansMontant(texte);
    });

    test('contrat terminé : imprimé avec son statut et sa visite en cours', async () => {
      const { texte } = await lirePdf(f.termine.id);
      assert.ok(texte.includes('TEST-Contrat-termine-6a4b'), texte);
      verifierStatutContrat(texte, 'TERMINE');
      assert.ok(compter(texte, /10-03-2025/) >= 2, `date de début et échéance de la visite\n${texte}`);
      assert.equal(compter(texte, LIBELLES_VISITE.EN_COURS), 1, `visite en cours\n${texte}`);
      assert.match(texte, /(?<![\d,])2\s?h(?![\p{L}\d])/u, `durée de 2 heures\n${texte}`);
      assert.ok(!contient(texte, 'TEST Clôture du contrat 6a4b'), `motif de clôture imprimé\n${texte}`);
      verifierSansMontant(texte);
    });

    // Cadrage, « Statuts » : un contrat annulé s'imprime avec la mention en tête, comme un devis annulé ;
    // le motif d'annulation n'est pas imprimé.
    test('contrat annulé : la mention en tête, avant le client, sans le motif ; sa visite annulée et son devis d’origine', async () => {
      const { texte } = await lirePdf(f.annule.id);
      verifierStatutContrat(texte, 'ANNULE');
      // Le statut (« annulé ») et, en plus, la mention en tête : deux fois au moins, la première avant le client.
      assert.ok(compter(texte, LIBELLES_CONTRAT.ANNULE) >= 2, `statut et mention de l’annulation\n${texte}`);
      const mention = texte.search(LIBELLES_CONTRAT.ANNULE);
      assert.ok(mention >= 0 && mention < texte.indexOf(f.client.raisonSociale), `mention de l’annulation absente ou après le client\n${texte}`);
      assert.ok(!contient(texte, MOTIF_ANNULATION) && !texte.includes('Motif confidentiel'), `motif d’annulation imprimé\n${texte}`);
      assert.ok(compter(texte, /20-05-2025/) >= 2, `date de début et échéance de la visite\n${texte}`);
      assert.equal(compter(texte, LIBELLES_VISITE.ANNULEE), 1, `visite annulée\n${texte}`);
      assert.ok(texte.includes(f.devisAnnule.numero) && !texte.includes(f.devisActif.numero), `devis d’origine\n${texte}`);
      // Un contrat non annulé ne porte pas la mention (verifierStatutContrat l'a vérifié pour chacun).
    });

    // Cadrage, « Route » : réservée à l'administration en session (requireAdmin), ligne `contrats.*` du
    // modèle de droits cible.
    test('droits : 403 pour chaque type de compte non administrateur, même avec tous les droits ; 401 sans session ; l’administrateur imprime', async () => {
      const comptes = [];
      for (const role of ROLES_NON_ADMINISTRATEURS) {
        const email = `contrat-pdf.${role.toLowerCase()}@iris.test`;
        comptes.push([role, await prisma.user.upsert({ where: { email }, update: { role, actif: true, permissions: [] }, create: { email, name: `TEST ${role} 6a4b`, role } })]);
      }
      // Un directeur qui porte tous les droits accordables et l'accès aux finances reste refusé.
      const emailComplet = 'contrat-pdf.directeur-tous-droits@iris.test';
      comptes.push(['DIRECTEUR (tous les droits)', await prisma.user.upsert({ where: { email: emailComplet }, update: {}, create: { email: emailComplet, name: 'TEST Directeur tous droits 6a4b', role: 'DIRECTEUR', permissions: TOUS_LES_SCOPES, accesFinance: true } })]);
      for (const [libelle, compte] of comptes) {
        for (const contrat of [f.actif, f.annule]) {
          const res = await refusSansEcriture(() => request(app).get(cheminPdf(contrat.id)).set(jetonDe(compte.id)), 403, `${libelle}, contrat ${contrat.titre}`);
          assert.equal(res.body.error, 'Accès réservé aux administrateurs', libelle);
        }
      }
      await refusSansEcriture(() => request(app).get(cheminPdf(f.actif.id)), 401, 'sans session');
      const email = 'contrat-pdf.admin@iris.test';
      const administrateur = await prisma.user.upsert({ where: { email }, update: { role: 'ADMIN', actif: true }, create: { email, name: 'TEST Administrateur 6a4b', role: 'ADMIN' } });
      assert.ok((await lirePdf(f.actif.id, jetonDe(administrateur.id))).texte.includes('TEST Maintenance annuelle chaufferie'));
    });

    // Cadrage : « les refus 403 [...] pour une clé » ; il n'y a pas de route /api/v1. Lecture confirmée
    // par Claude Code le 31-10-2026 (imprécision du cadrage) : une clé, qui n'ouvre pas de session, est
    // refusée par requireAuth (401) avant requireAdmin, comme pour le PDF du devis (api.test.mjs), et la
    // route /api/v1 n'existe pas (404).
    test('clé d’intégration : refusée sur la route en session (401), même avec tous les scopes ; aucune route /api/v1 (404)', async () => {
      const cle = await ok(envoyer('post', '/admin/api-keys', { nom: 'TEST clé PDF contrat 6a4b', scopes: TOUS_LES_SCOPES }), 201);
      try {
        const parCle = { Authorization: `Bearer ${cle.apiKey}` };
        assert.equal((await request(app).get('/api/v1/clients').set(parCle)).status, 200, 'la clé est valide');
        await refusSansEcriture(() => request(app).get(cheminPdf(f.actif.id)).set(parCle), 401, 'clé sur la route en session');
        await refusSansEcriture(() => request(app).get(`/api/v1/contrats-maintenance/${f.actif.id}/document.pdf`).set(parCle), 404, 'route /api/v1');
      } finally {
        await prisma.apiAccessKey.deleteMany({ where: { nom: 'TEST clé PDF contrat 6a4b' } });
      }
    });

    test('contrat introuvable : 404 « Contrat de maintenance introuvable. », sans rien écrire', async () => {
      for (const id of [randomUUID(), 'inexistant', f.visite1.id]) {
        const res = await refusSansEcriture(() => request(app).get(cheminPdf(id)).set(admin()), 404, `identifiant ${id}`);
        assert.equal(res.body.error, 'Contrat de maintenance introuvable.');
      }
    });

    // Cadrage, « En-tête » : refus 409 si l'identité de la société est incomplète, pour tout contrat,
    // annulé compris ; message de IdentiteEmetteurIncompleteError, qui nomme les champs manquants.
    test('identité de la société incomplète : 409 qui nomme les champs manquants, sans rien écrire', async () => {
      try {
        await definirSociete({ siret: '', ville: '  ' });
        for (const contrat of [f.actif, f.suspendu, f.termine, f.annule]) {
          const res = await refusSansEcriture(() => request(app).get(cheminPdf(contrat.id)).set(admin()), 409, `contrat ${contrat.titre}`);
          assert.equal(res.body.error, 'Identité de la société incomplète : renseignez SIRET, ville dans l’écran Société avant d’imprimer un contrat.');
        }
      } finally {
        await definirSociete({ siret: IDENTITE.siret, ville: IDENTITE.ville });
      }
      assert.ok((await lirePdf(f.actif.id)).texte.includes(`SIRET ${IDENTITE.siret}`), 'l’identité complétée, le PDF s’imprime');
    });

    // Consigne du code (brief 6a-4b) : `Contrat-<intitulé assaini>.pdf`, ou `Contrat-<id>.pdf` si
    // l'intitulé est vide une fois assaini. Le nom ne doit jamais rompre l'en-tête (guillemet, barre,
    // fin de ligne).
    test('nom du fichier : Contrat-<intitulé assaini>.pdf, l’identifiant si rien n’en reste ; jamais de guillemet ni de barre', async () => {
      assert.equal((await lirePdf(f.termine.id)).disposition, 'inline; filename="Contrat-TEST-Contrat-termine-6a4b.pdf"');
      const sansIntitule = await ok(envoyer('post', '/contrats-maintenance', { clientId: f.clientSansSite.id, titre: '« — »', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-09-2025' }), 201);
      assert.equal((await lirePdf(sansIntitule.id)).disposition, `inline; filename="Contrat-${sansIntitule.id}.pdf"`);
      const piege = await ok(envoyer('post', '/contrats-maintenance', { clientId: f.clientSansSite.id, titre: 'TEST "guillemets" / barre \\ retour\u2028fin 6a4b', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-09-2025' }), 201);
      const { disposition } = await lirePdf(piege.id);
      assert.match(disposition, /^inline; filename="Contrat-[^"\\/\r\n\u2028]+\.pdf"$/u, disposition);
      assert.ok(disposition.includes('guillemets') && disposition.includes('6a4b'), disposition);
    });
  });
}
