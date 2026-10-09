// Tests d'intégration : l'application Express est montée en mémoire et interrogée par
// de vraies requêtes HTTP, contre une vraie base PostgreSQL. Ce sont ces tests qui
// prouvent que les règles d'accès s'appliquent — pas la lecture du code source.
//
// Ils ont besoin d'une base JETABLE, indiquée par TEST_DATABASE_URL (cf. tests/README.md).
// Sans elle, la suite s'annonce ignorée : mieux vaut un « skip » visible qu'un vert obtenu
// sans avoir rien vérifié.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test, { after, before, describe } from 'node:test';
import { PDFParse } from 'pdf-parse';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  describe('API HTTP', { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  process.env.BREAK_GLASS_EMAIL = 'secours@iris.test';
  process.env.BREAK_GLASS_TOKEN = 'jeton-de-secours-de-test-au-moins-32-caracteres';
  process.env.SUPERADMIN_EMAILS = 'secours@iris.test';

  const request = (await import('supertest')).default;
  const { app, initDb, ensureSuperAdmins, jourCivilEntreprise } = await import('../dist/index.js');
  const { PrismaClient } = await import('@prisma/client');
  const jwt = (await import('jsonwebtoken')).default;
  const prisma = new PrismaClient();
  const configurerTva55 = async () => {
    const compte = await prisma.compteComptable.findUniqueOrThrow({ where: { code: '445710' } });
    await prisma.regleTvaComptable.upsert({ where: { taux: 5.5 }, create: { taux: 5.5, compteId: compte.id }, update: { compteId: compte.id } });
  };
  const purgerEcrituresJetables = async id => {
    try {
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" DISABLE TRIGGER "ecriture_facture_immutable"');
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" DISABLE TRIGGER "ecriture_facture_equilibre"');
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" DISABLE TRIGGER "ecriture_facture_equilibre_immediat"');
      await prisma.ecritureFacture.deleteMany({ where: { factureId: id } });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" ENABLE TRIGGER "ecriture_facture_equilibre_immediat"');
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" ENABLE TRIGGER "ecriture_facture_equilibre"');
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" ENABLE TRIGGER "ecriture_facture_immutable"');
    }
  };

  let cleApi = '';

  const nettoyer = async () => {
    // La signature dépend du devis : elle part avant le devis pour garder ce teardown explicite.
    await prisma.devisSignature.deleteMany({ where: { devis: { client: { raisonSociale: { startsWith: 'TEST ' } } } } });
    // Une conversion garde le lien vers le devis : elle part avant le devis et sa fiche client.
    await prisma.devisConversion.deleteMany({ where: { devis: { client: { raisonSociale: { startsWith: 'TEST ' } } } } });
    // Les devis dépendent du client ; ils doivent être retirés avant la fiche client.
    await prisma.devis.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
    // Le parc dépend à la fois du client/site et du catalogue : il part donc en premier.
    await prisma.equipementInstalle.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
    // Les attestations dépendent des rapports ; elles partent avant les interventions.
    await prisma.interventionSignature.deleteMany({ where: { rapport: { intervention: { client: { raisonSociale: { startsWith: 'TEST ' } } } } } });
    // Les interventions SAV portent éventuellement un site/contact : elles partent avant
    // ces fiches afin de respecter les clés étrangères RESTRICT.
    // Les snapshots ont une FK RESTRICT et sont append-only : purge uniquement sur la base jetable.
    try {
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" DISABLE TRIGGER "ecriture_facture_immutable"');
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" DISABLE TRIGGER "ecriture_facture_equilibre"');
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" DISABLE TRIGGER "ecriture_facture_equilibre_immediat"');
      await prisma.ecritureFacture.deleteMany({ where: { facture: { client: { raisonSociale: { startsWith: 'TEST ' } } } } });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" ENABLE TRIGGER "ecriture_facture_equilibre_immediat"');
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" ENABLE TRIGGER "ecriture_facture_equilibre"');
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" ENABLE TRIGGER "ecriture_facture_immutable"');
    }
    await prisma.factureLigne.deleteMany({ where: { facture: { client: { raisonSociale: { startsWith: 'TEST ' } } } } });
    await prisma.journalFacture.deleteMany({ where: { facture: { client: { raisonSociale: { startsWith: 'TEST ' } } } } });
    // Les avoirs référencent leur facture source par RESTRICT : les documents enfants partent
    // donc avant les factures de test. Ceci conserve le teardown rejouable avec plusieurs avoirs.
    await prisma.facture.deleteMany({ where: { type: 'AVOIR', client: { raisonSociale: { startsWith: 'TEST ' } } } });
    await prisma.facture.deleteMany({ where: { type: 'FACTURE', client: { raisonSociale: { startsWith: 'TEST ' } } } });
    await prisma.mentionsLegalesVersion.deleteMany({});
    await prisma.regleComptable.deleteMany({});
    await prisma.regleTvaComptable.deleteMany({});
    await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" DROP CONSTRAINT IF EXISTS "journal_test_refus_insertion"');
    // Le journal est append-only : le nettoyage de la base jetable désactive le trigger
    // uniquement le temps de purger les fixtures, puis le réactive même en cas d'échec.
    try {
      await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" DISABLE TRIGGER "journal_compte_append_only"');
      await prisma.journalCompteComptable.deleteMany({});
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" ENABLE TRIGGER "journal_compte_append_only"');
    }
    await prisma.compteComptable.deleteMany({});
    await prisma.sequenceFacture.deleteMany({});
    await prisma.sequenceAvoir.deleteMany({});
    const interventionIds = (await prisma.intervention.findMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } }, select: { id: true } })).map((intervention) => intervention.id);
    await prisma.journalSaisieChantier.deleteMany({ where: { interventionId: { in: interventionIds } } });
    await prisma.coutInterventionHeure.deleteMany({ where: { interventionId: { in: interventionIds } } });
    await prisma.coutInterventionAchat.deleteMany({ where: { interventionId: { in: interventionIds } } });
    await prisma.intervention.deleteMany({ where: { id: { in: interventionIds } } });
    const contratIds = (await prisma.contratMaintenance.findMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } }, select: { id: true } })).map((contrat) => contrat.id);
    await prisma.journalSaisieChantier.deleteMany({ where: { contratMaintenanceId: { in: contratIds } } });
    await prisma.contratMaintenance.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
    await prisma.clientSite.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
    await prisma.clientContact.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
    await prisma.cataloguePrestation.deleteMany({ where: { reference: { startsWith: 'TEST-' } } });
    await prisma.catalogueArticle.deleteMany({ where: { reference: { startsWith: 'TEST-' } } });
    await prisma.catalogueEquipement.deleteMany({ where: { reference: { startsWith: 'TEST-' } } });
    await prisma.apiAccessKey.deleteMany({ where: { nom: { startsWith: 'TEST ' } } });
    // Domaine chantier : l'ordre suit les clés étrangères — les lignes rattachées d'abord.
    const chantierIds = (await prisma.chantier.findMany({ where: { nom: { startsWith: 'TEST ' } }, select: { id: true } })).map((chantier) => chantier.id);
    await prisma.journalSaisieChantier.deleteMany({ where: { chantierId: { in: chantierIds } } });
    await prisma.achatReel.deleteMany({ where: { chantier: { nom: { startsWith: 'TEST ' } } } });
    await prisma.pointageHeure.deleteMany({ where: { chantier: { nom: { startsWith: 'TEST ' } } } });
    await prisma.chantier.deleteMany({ where: { nom: { startsWith: 'TEST ' } } });
    // Un chantier né d'une conversion porte la raison sociale du client dans `client` ; son
    // `nom` reprend l'objet du devis et n'a donc pas le préfixe TEST. Sans cette ligne,
    // chaque exécution en laisserait un derrière elle. Elle vient APRÈS les achats et les
    // heures, qui référencent le chantier.
    await prisma.chantier.deleteMany({ where: { client: { startsWith: 'TEST ' } } });
    await prisma.client.deleteMany({ where: { raisonSociale: { startsWith: 'TEST ' } } });
    await prisma.intervenant.deleteMany({ where: { nom: { startsWith: 'TEST ' } } });
    await prisma.categorie.deleteMany({ where: { nom: { startsWith: 'TEST ' } } });
    await prisma.fournisseur.deleteMany({ where: { nom: { startsWith: 'TEST ' } } });
    const emailsUtilisateursTest = [
      'cycle.conducteur@iris.test', 'conducteur.test@iris.test', 'correcteur.test@iris.test', 'auteur.journal@iris.test', 'permissions@iris.test', 'commercial.permissions@iris.test',
      'sav.non-affecte@iris.test', 'sav.premier@iris.test', 'sav.second@iris.test', 'sav.journal@iris.test', 'sav.rapport@iris.test', 'sav.intrus@iris.test', 'sav.conducteur@iris.test', 'sav.responsable@iris.test', 'sav.tiers@iris.test', 'sav.cout.heures@iris.test', 'sav.cout.second@iris.test', 'sav.cout.confidentiel@iris.test', 'sav.cout.garde.technicien@iris.test', 'sav.cout.garde.collegue@iris.test', 'sav.cout.garde.conducteur@iris.test', 'sav.cout.garde.commercial@iris.test', 'sav.cout.garde.taux@iris.test', 'sav.cout.garde.responsable@iris.test', 'contrat.conducteur@iris.test', 'contrat.couverture.technicien@iris.test', 'contrat.couverture.lecteur@iris.test', 'facture.conducteur@iris.test', 'comptabilite.conducteur@iris.test', 'comptabilite.modification.conducteur@iris.test', 'comptabilite.modification.admin@iris.test', 'comptabilite.import.autre.admin@iris.test', 'comptabilite.admin@iris.test', 'journal.comptable.sql@iris.test', 'journal.comptable.auteur@iris.test', 'phase8bis.conducteur@iris.test', 'phase8bis.commercial@iris.test',
    ];
    // Les journaux sont maintenant référentiellement reliés à leurs auteurs : ils partent
    // avant les comptes afin que le harnais reste rejouable après une interruption.
    await prisma.journalSaisieChantier.deleteMany({ where: { auteur: { email: { in: emailsUtilisateursTest } } } });
    await prisma.user.deleteMany({ where: { email: { in: emailsUtilisateursTest } } });
  };

  before(async () => {
    await initDb();
    await ensureSuperAdmins();
    // Une exécution précédente interrompue a pu laisser des enregistrements : on part
    // toujours d'un état propre, sinon la suite n'est rejouable qu'une fois.
    await nettoyer();
    await prisma.mentionsLegalesVersion.create({ data: { version: 1, mentions: 'TEST Mentions légales', cgv: 'TEST Conditions générales', penalites: 'TEST Pénalités de retard', actif: true, publieeLe: new Date() } });
  });

  after(async () => {
    await nettoyer();
    await prisma.$disconnect();
  });

  describe('Accès de secours', () => {
    test('annonce sa disponibilité sans révéler le jeton', async () => {
      const res = await request(app).get('/api/auth/secours/etat');
      assert.equal(res.status, 200);
      assert.equal(res.body.disponible, true);
      assert.equal(JSON.stringify(res.body).includes('jeton-de-secours'), false);
    });

    test('refuse un jeton erroné', async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: 'mauvais-jeton' });
      assert.equal(res.status, 401);
      assert.equal(res.body.token, undefined);
    });

    test('refuse une requête sans jeton', async () => {
      const res = await request(app).post('/api/auth/secours').send({});
      assert.equal(res.status, 401);
    });

    test('ouvre une session d’une heure pour le bon jeton', async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.token, 'un jeton de session doit être émis');
      assert.equal(res.body.user.role, 'SUPERADMIN');
      assert.equal(res.body.expiresIn, 3600);
    });
  });

  describe('Protection des routes', () => {
    test('sans jeton, le référentiel client est fermé', async () => {
      assert.equal((await request(app).get('/api/clients')).status, 401);
      assert.equal((await request(app).get('/api/catalogue/articles')).status, 401);
      assert.equal((await request(app).get('/api/company')).status, 401);
    });

    test('un jeton fabriqué avec une autre clé est rejeté', async () => {
      const jwt = (await import('jsonwebtoken')).default;
      const faux = jwt.sign({ id: 'nimporte-quoi', role: 'SUPERADMIN' }, 'la-mauvaise-cle');
      const res = await request(app).get('/api/clients').set('Authorization', `Bearer ${faux}`);
      assert.equal(res.status, 401);
    });

    test('un jeton signé pour un compte inexistant est rejeté', async () => {
      // Le rôle est relu en base à chaque requête : un jeton bien signé mais orphelin
      // ne doit ouvrir aucune porte, même s'il se prétend SUPERADMIN.
      const jwt = (await import('jsonwebtoken')).default;
      const orphelin = jwt.sign({ id: 'compte-supprime', role: 'SUPERADMIN' }, process.env.JWT_SECRET);
      const res = await request(app).get('/api/clients').set('Authorization', `Bearer ${orphelin}`);
      assert.equal(res.status, 401);
    });

    test("l'API d'intégration refuse une clé inconnue", async () => {
      const res = await request(app).get('/api/v1/clients').set('Authorization', 'Bearer iris_cle_inventee');
      assert.equal(res.status, 401);
    });
  });

  describe('Référentiel client via une session humaine', () => {
    let session = '';
    let clientId = '';

    before(async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = res.body.token;
    });

    test('crée un client puis le relit', async () => {
      const creation = await request(app).post('/api/clients')
        .set('Authorization', `Bearer ${session}`)
        .send({ raisonSociale: 'TEST Boulangerie Martin', siren: '552 100 554' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      assert.equal(creation.body.siren, '552100554', 'le SIREN doit être normalisé');
      clientId = creation.body.id;

      const lecture = await request(app).get(`/api/clients/${clientId}`).set('Authorization', `Bearer ${session}`);
      assert.equal(lecture.status, 200);
      assert.equal(lecture.body.raisonSociale, 'TEST Boulangerie Martin');
    });

    test('refuse une saisie invalide avec un message utile', async () => {
      const res = await request(app).post('/api/clients')
        .set('Authorization', `Bearer ${session}`)
        .send({ raisonSociale: 'TEST Siren faux', siren: '42' });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /SIREN/);
    });

    test('un seul site de facturation par client', async () => {
      const site = (nom, facturation) => request(app).post(`/api/clients/${clientId}/sites`)
        .set('Authorization', `Bearer ${session}`)
        .send({ nom, adresse: '1 rue des Tests', codePostal: '14000', ville: 'Caen', estSiteFacturation: facturation });

      assert.equal((await site('Siège', true)).status, 201);
      assert.equal((await site('Dépôt', true)).status, 201);

      const client = await request(app).get(`/api/clients/${clientId}`).set('Authorization', `Bearer ${session}`);
      const facturation = client.body.sites.filter((s) => s.estSiteFacturation);
      assert.equal(facturation.length, 1, 'poser le drapeau doit retirer le précédent');
      assert.equal(facturation[0].nom, 'Dépôt');
    });

    test('la désactivation retire le client des listes sans le supprimer', async () => {
      assert.equal((await request(app).delete(`/api/clients/${clientId}`).set('Authorization', `Bearer ${session}`)).status, 200);
      const liste = await request(app).get('/api/clients').set('Authorization', `Bearer ${session}`);
      assert.equal(liste.body.clients.some((c) => c.id === clientId), false);
      assert.ok(await prisma.client.findUnique({ where: { id: clientId } }), 'la fiche doit rester en base');
    });
  });

  describe('API d’intégration (agent)', () => {
    let session = '';

    before(async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = res.body.token;
      const cle = await request(app).post('/api/admin/api-keys')
        .set('Authorization', `Bearer ${session}`)
        .send({ nom: 'TEST agent lecture', scopes: ['clients:read'] });
      cleApi = cle.body.apiKey;
    });

    test('le secret n’est révélé qu’à la création', async () => {
      assert.match(cleApi, /^iris_/);
      const liste = await request(app).get('/api/admin/api-keys').set('Authorization', `Bearer ${session}`);
      const creee = liste.body.find((k) => k.nom === 'TEST agent lecture');
      assert.ok(creee, 'la clé doit apparaître dans la liste');
      assert.equal(creee.secretHash, undefined, 'la liste ne doit jamais exposer l’empreinte');
      assert.equal(JSON.stringify(liste.body).includes(cleApi), false, 'le secret ne doit jamais ressortir');
    });

    test('la clé ouvre les routes de son scope', async () => {
      const res = await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${cleApi}`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.clients));
    });

    test('elle est refusée sur un scope qu’elle n’a pas', async () => {
      // Lecture seule : l'écriture doit renvoyer 403, pas 401 — la clé est valide, c'est
      // le droit qui manque.
      const res = await request(app).post('/api/v1/clients')
        .set('Authorization', `Bearer ${cleApi}`)
        .send({ raisonSociale: 'TEST Interdit' });
      assert.equal(res.status, 403);
      assert.match(res.body.error, /clients:write/);
    });

    test('une clé révoquée cesse immédiatement de fonctionner', async () => {
      const liste = await request(app).get('/api/admin/api-keys').set('Authorization', `Bearer ${session}`);
      const cible = liste.body.find((k) => k.nom === 'TEST agent lecture');
      await request(app).post(`/api/admin/api-keys/${cible.id}/revoke`).set('Authorization', `Bearer ${session}`);
      const res = await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${cleApi}`);
      assert.equal(res.status, 401);
    });

    test('un agent en écriture applique les mêmes règles qu’un humain', async () => {
      const cle = await request(app).post('/api/admin/api-keys')
        .set('Authorization', `Bearer ${session}`)
        .send({ nom: 'TEST agent ecriture', scopes: ['clients:write', 'catalogue:write'] });
      const secret = cle.body.apiKey;

      // Même validation que par l'interface : c'est le même handler.
      const invalide = await request(app).post('/api/v1/clients').set('Authorization', `Bearer ${secret}`).send({});
      assert.equal(invalide.status, 400);
      assert.match(invalide.body.error, /raison sociale/);

      const valide = await request(app).post('/api/v1/clients')
        .set('Authorization', `Bearer ${secret}`)
        .send({ raisonSociale: 'TEST Client créé par un agent' });
      assert.equal(valide.status, 201);

      const fiche = await request(app).post('/api/v1/catalogue/prestations')
        .set('Authorization', `Bearer ${secret}`)
        .send({ reference: 'TEST-POSE-01', nom: 'Pose de caméra', prixVenteHt: '250', tauxTva: '20' });
      assert.equal(fiche.status, 201, JSON.stringify(fiche.body));
      assert.equal(fiche.body.prixVenteHt, 250);
    });
  });

  // Cœur de la correction : ces journaux renvoyaient TOUS les achats et TOUTES les heures
  // de TOUS les chantiers, chacun avec son chantier complet — budgets vendus compris — à
  // n'importe quel compte connecté. Les tests ci-dessous vérifient les deux moitiés du
  // défaut : le périmètre (qui voit quoi) et le contenu (ce que porte chaque ligne).
  describe('Journaux d’achats et d’heures : périmètre et montants', () => {
    let session = '';
    let sessionConducteur = '';
    let sessionCorrecteur = '';
    let idConducteur = '';
    let idCorrecteur = '';
    let idChantierA = '';
    let idChantierB = '';
    let idCategorie = '';
    let idFournisseur = '';
    let idIntervenant = '';

    // Remplace temporairement les permissions ; les permissions initiales sont restaurées ensuite.
    async function avecDelegation(userId, permissions, corps) {
      const avant = (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { permissions: true } })).permissions;
      await prisma.user.update({ where: { id: userId }, data: { permissions } });
      try {
        return await corps();
      } finally {
        await prisma.user.update({ where: { id: userId }, data: { permissions: avant } });
      }
    }

    before(async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = res.body.token;

      // Un conducteur, responsable d'un seul des deux chantiers.
      const conducteur = await prisma.user.upsert({
        where: { email: 'conducteur.test@iris.test' },
        update: { role: 'CONDUCTEUR_TRAVAUX', actif: true },
        create: { email: 'conducteur.test@iris.test', name: 'TEST Conducteur', role: 'CONDUCTEUR_TRAVAUX' },
      });
      idConducteur = conducteur.id;
      const correcteur = await prisma.user.upsert({
        where: { email: 'correcteur.test@iris.test' },
        update: { role: 'ADMIN', actif: true },
        create: { email: 'correcteur.test@iris.test', name: 'TEST Correcteur', role: 'ADMIN' },
      });
      idCorrecteur = correcteur.id;
      const jwt = (await import('jsonwebtoken')).default;
      sessionConducteur = jwt.sign({ id: conducteur.id, role: 'CONDUCTEUR_TRAVAUX' }, process.env.JWT_SECRET);
      sessionCorrecteur = jwt.sign({ id: correcteur.id, role: 'ADMIN' }, process.env.JWT_SECRET);

      const chantier = (nom, responsableId) => prisma.chantier.create({
        data: { nom, client: 'TEST Client', dateDebut: new Date(), budgetGlobalVendu: 100000, responsableId },
      });
      idChantierA = (await chantier('TEST Chantier du conducteur', conducteur.id)).id;
      idChantierB = (await chantier('TEST Chantier d’un autre', null)).id;

      const categorie = await prisma.categorie.upsert({
        where: { nom: 'TEST Catégorie' }, update: {}, create: { nom: 'TEST Catégorie' },
      });
      const fournisseur = await prisma.fournisseur.upsert({
        where: { nom: 'TEST Fournisseur' }, update: {}, create: { nom: 'TEST Fournisseur' },
      });
      const intervenant = await prisma.intervenant.create({
        data: { nom: 'TEST Intervenant', role: 'Technicien', tauxHoraireCharge: 40 },
      });

      idCategorie = categorie.id;
      idFournisseur = fournisseur.id;
      idIntervenant = intervenant.id;

      for (const chantierId of [idChantierA, idChantierB]) {
        await prisma.achatReel.create({
          data: { date: new Date(), description: 'TEST achat', montantHT: 1000, chantierId, categorieId: categorie.id, fournisseurId: fournisseur.id, createdById: idConducteur, updatedById: idConducteur },
        });
        await prisma.pointageHeure.create({
          data: { date: new Date(), nbrHeures: 7, tauxHoraireApplique: 40, chantierId, intervenantId: intervenant.id, createdById: idConducteur, updatedById: idConducteur },
        });
      }
    });

    test('un conducteur ne reçoit que les lignes de SES chantiers', async () => {
      const achats = await request(app).get('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`);
      assert.equal(achats.status, 200);
      const chantiersVus = new Set(achats.body.map((a) => a.chantier?.id));
      assert.ok(chantiersVus.has(idChantierA), 'son propre chantier doit être visible');
      assert.equal(chantiersVus.has(idChantierB), false, 'le chantier d’un autre ne doit pas apparaître');

      const heures = await request(app).get('/api/heures').set('Authorization', `Bearer ${sessionConducteur}`);
      assert.equal(heures.status, 200);
      const chantiersHeures = new Set(heures.body.map((h) => h.chantier?.id));
      assert.equal(chantiersHeures.has(idChantierB), false);
    });

    test('un conducteur ne peut écrire que dans son chantier et avec des valeurs positives', async () => {
      const achatInterdit = await request(app).post('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`).send({
        chantierId: idChantierB, categorieId: idCategorie, fournisseurId: idFournisseur, date: '2026-09-05', description: 'TEST interdit', montantHT: 10,
      });
      assert.equal(achatInterdit.status, 404);
      const achatNegatif = await request(app).post('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`).send({
        chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date: '2026-09-05', description: 'TEST négatif', montantHT: -10,
      });
      assert.equal(achatNegatif.status, 400);
      for (const date of ['', 'not-a-date', '2026-02-31', '31-02-2026', '2026-13-01']) {
        const invalide = await request(app).post('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`).send({
          chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date, description: 'TEST date', montantHT: 10,
        });
        assert.equal(invalide.status, 400, `date ${date} doit être refusée`);
      }
      const dateFrancaise = await request(app).post('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`).send({
        chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date: '06-09-2026', description: 'TEST date française', montantHT: 10,
      });
      assert.equal(dateFrancaise.status, 200);
      const achatGratuit = await request(app).post('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`).send({
        chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date: '06-09-2026', description: 'TEST remplacement sous garantie', montantHT: 0,
      });
      assert.equal(achatGratuit.status, 200);
      for (const montantHT of ['0.001', '1.999', '1e-3', '99999999999']) {
        const invalide = await request(app).post('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`).send({
          chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date: '2026-09-05', description: 'TEST précision', montantHT,
        });
        assert.equal(invalide.status, 400, `montant ${montantHT} doit être refusé`);
      }
      const heuresInterdites = await request(app).post('/api/heures').set('Authorization', `Bearer ${sessionConducteur}`).send({
        chantierId: idChantierB, intervenantId: idIntervenant, date: '2026-09-05', nbrHeures: 2,
      });
      assert.equal(heuresInterdites.status, 404);
    });

    test('la création et la correction conservent leurs auteurs distincts', async () => {
      const scenarios = [
        { nom: 'achat', chemin: '/api/achats', creation: { chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date: '06-09-2026', description: 'TEST auteurs achat', montantHT: 10 }, correction: { montantHT: 11, motifCorrection: 'Correction de montant' }, modele: prisma.achatReel },
        { nom: 'pointage', chemin: '/api/heures', creation: { chantierId: idChantierA, intervenantId: idIntervenant, date: '06-09-2026', nbrHeures: 2 }, correction: { nbrHeures: 3, motifCorrection: 'Correction des heures' }, modele: prisma.pointageHeure },
      ];
      for (const scenario of scenarios) {
        const creation = await request(app).post(scenario.chemin).set('Authorization', `Bearer ${sessionConducteur}`).send(scenario.creation);
        assert.equal(creation.status, 200, `${scenario.nom} créé`);
        const cree = await scenario.modele.findUniqueOrThrow({ where: { id: creation.body.id } });
        assert.equal(cree.createdById, idConducteur, `${scenario.nom} : auteur de création`);
        assert.equal(cree.updatedById, idConducteur, `${scenario.nom} : dernier auteur initial`);
        const correction = await request(app).patch(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${sessionCorrecteur}`).send(scenario.correction);
        assert.equal(correction.status, 200, `${scenario.nom} corrigé`);
        const corrige = await scenario.modele.findUniqueOrThrow({ where: { id: creation.body.id } });
        assert.equal(corrige.createdById, idConducteur, `${scenario.nom} : l’auteur de création est immuable`);
        assert.equal(corrige.updatedById, idCorrecteur, `${scenario.nom} : le dernier correcteur est conservé`);
      }
    });

    test('une correction exige un motif et le conserve avec ses snapshots', async () => {
      const scenarios = [
        { nom: 'achat', chemin: '/api/achats', creation: { chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date: '06-09-2026', description: 'TEST motif achat', montantHT: 10 }, correction: { montantHT: 11 } },
        { nom: 'pointage', chemin: '/api/heures', creation: { chantierId: idChantierA, intervenantId: idIntervenant, date: '06-09-2026', nbrHeures: 2 }, correction: { nbrHeures: 3 } },
      ];
      for (const scenario of scenarios) {
        const creation = await request(app).post(scenario.chemin).set('Authorization', `Bearer ${sessionConducteur}`).send(scenario.creation);
        assert.equal(creation.status, 200, `${scenario.nom} créé`);
        for (const motifCorrection of ['', 'x', 'x'.repeat(501), '😀😀']) {
          const refus = await request(app).patch(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${sessionConducteur}`)
            .send({ ...scenario.correction, motifCorrection });
          assert.equal(refus.status, 400, `${scenario.nom} : motif de correction invalide refusé`);
        }
        const motifCorrection = 'Valeur de saisie rectifiée';
        const correction = await request(app).patch(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${sessionConducteur}`)
          .send({ ...scenario.correction, motifCorrection });
        assert.equal(correction.status, 200, `${scenario.nom} corrigé`);
        const trace = await prisma.journalSaisieChantier.findFirstOrThrow({ where: { cibleId: creation.body.id, action: 'CORRECTION' } });
        assert.equal(trace.motif, motifCorrection, `${scenario.nom} : motif conservé dans le journal`);
        assert.ok(trace.avant && trace.apres, `${scenario.nom} : snapshots conservés`);
      }
    });

    test('aucune ligne ne transporte les montants vendus du chantier', async () => {
      // Le défaut d'origine : `include: { chantier: true }` renvoyait l'enregistrement
      // entier. Un administrateur y a droit ailleurs, mais pas ici — ces journaux n'ont
      // aucune raison de véhiculer un budget.
      for (const chemin of ['/api/achats', '/api/heures']) {
        const res = await request(app).get(chemin).set('Authorization', `Bearer ${session}`);
        assert.equal(res.status, 200);
        assert.ok(res.body.length > 0, `${chemin} doit renvoyer des lignes`);
        for (const ligne of res.body) {
          assert.equal(ligne.chantier?.budgetGlobalVendu, undefined, `${chemin} expose budgetGlobalVendu`);
          assert.equal(ligne.chantier?.budgetMaterielVendu, undefined, `${chemin} expose budgetMaterielVendu`);
          assert.equal(ligne.chantier?.budgetMainOeuvreVendu, undefined, `${chemin} expose budgetMainOeuvreVendu`);
          assert.equal(ligne.chantier?.heuresVendues, undefined, `${chemin} expose heuresVendues`);
        }
      }
    });

    test('un archivage sort une écriture des journaux et laisse une trace immutable', async () => {
      const creation = await request(app).post('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`).send({
        chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date: '2026-09-05', description: 'TEST archive', montantHT: 500,
      });
      assert.equal(creation.status, 200);
      const correction = await request(app).patch(`/api/achats/${creation.body.id}`).set('Authorization', `Bearer ${sessionConducteur}`).send({ montantHT: 50, motifCorrection: 'Montant facturé erroné' });
      assert.equal(correction.status, 200);
      const archiveConducteur = await request(app).delete(`/api/achats/${creation.body.id}`).set('Authorization', `Bearer ${sessionConducteur}`).send({ motifArchivage: 'Saisie en double' });
      assert.equal(archiveConducteur.status, 403, 'un conducteur ne peut pas archiver sans délégation');

      await avecDelegation(idConducteur, ['chantiers:archive'], async () => {
        const archive = await request(app).delete(`/api/achats/${creation.body.id}`).set('Authorization', `Bearer ${sessionConducteur}`).send({ motifArchivage: 'Saisie en double' });
        assert.equal(archive.status, 200, 'la délégation individuelle d’archivage est effective');
        const journal = await request(app).get('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`);
        assert.equal(journal.body.some((a) => a.id === creation.body.id), false);
        const traces = await prisma.journalSaisieChantier.findMany({ where: { cibleId: creation.body.id }, orderBy: { createdAt: 'asc' } });
        assert.equal(traces.length, 3);
        assert.equal(Number(traces.find((t) => t.action === 'CORRECTION').avant.montantHT), 500);
        assert.equal(Number(traces.find((t) => t.action === 'CORRECTION').apres.montantHT), 50);
      });
    });

    test('un archivage se restaure avec un motif et réintègre les coûts actifs', async () => {
      const scenarios = [
        { nom: 'achat', chemin: '/api/achats', cible: 'ACHAT', creation: { chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date: '06-09-2026', description: 'TEST achat restauré', montantHT: 42 } },
        { nom: 'pointage', chemin: '/api/heures', cible: 'HEURE', creation: { chantierId: idChantierA, intervenantId: idIntervenant, date: '06-09-2026', nbrHeures: 2 } },
      ];
      for (const scenario of scenarios) {
        const creation = await request(app).post(scenario.chemin).set('Authorization', `Bearer ${sessionConducteur}`).send(scenario.creation);
        assert.equal(creation.status, 200, `${scenario.nom} créé`);
        const archivage = await request(app).delete(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${session}`)
          .send({ motifArchivage: 'Saisie suspendue à vérifier' });
        assert.equal(archivage.status, 200, `${scenario.nom} archivé`);

        const motifRestauration = 'Saisie vérifiée et rétablie';
        const restauration = await request(app).post(`${scenario.chemin}/${creation.body.id}/restaurer`).set('Authorization', `Bearer ${session}`)
          .send({ motifRestauration });
        assert.equal(restauration.status, 200, `${scenario.nom} restauré`);
        const actif = await request(app).get(scenario.chemin).set('Authorization', `Bearer ${sessionConducteur}`);
        assert.ok(actif.body.some((ligne) => ligne.id === creation.body.id), `${scenario.nom} restauré réintègre le journal actif`);
        const trace = await prisma.journalSaisieChantier.findFirstOrThrow({ where: { cible: scenario.cible, cibleId: creation.body.id, action: 'RESTAURATION' } });
        assert.equal(trace.motif, motifRestauration, `${scenario.nom} : motif de restauration tracé`);
        assert.equal(trace.avant.archivedAt === null, false, `${scenario.nom} : snapshot avant archivé`);
        assert.equal(trace.apres.archivedAt, null, `${scenario.nom} : snapshot après actif`);
      }
    });

    test('la restauration exige la délégation d’archivage, le périmètre, une archive et un motif', async () => {
      // Les deux routes de restauration portent chacune leurs gardes : celles de l'achat ne
      // couvrent pas celles du pointage. Chaque refus est épinglé séparément sur les deux.
      const scenarios = [
        { nom: 'achat', chemin: '/api/achats', creation: (chantierId) => ({ chantierId, categorieId: idCategorie, fournisseurId: idFournisseur, date: '06-09-2026', description: 'TEST restauration gardée', montantHT: 12 }) },
        { nom: 'pointage', chemin: '/api/heures', creation: (chantierId) => ({ chantierId, intervenantId: idIntervenant, date: '06-09-2026', nbrHeures: 1 }) },
      ];
      const motifRestauration = 'Saisie vérifiée et rétablie';
      for (const scenario of scenarios) {
        const restaurer = (ecritureId, jeton, corps = { motifRestauration }) => request(app).post(`${scenario.chemin}/${ecritureId}/restaurer`)
          .set('Authorization', `Bearer ${jeton}`).send(corps);
        const dansA = await request(app).post(scenario.chemin).set('Authorization', `Bearer ${session}`).send(scenario.creation(idChantierA));
        const dansB = await request(app).post(scenario.chemin).set('Authorization', `Bearer ${session}`).send(scenario.creation(idChantierB));
        assert.equal(dansA.status, 200, `${scenario.nom} créé dans le chantier du conducteur`);
        assert.equal(dansB.status, 200, `${scenario.nom} créé hors de son périmètre`);
        assert.equal((await restaurer(dansA.body.id, session)).status, 409, `${scenario.nom} actif : rien à restaurer`);

        for (const ecritureId of [dansA.body.id, dansB.body.id]) {
          const archivage = await request(app).delete(`${scenario.chemin}/${ecritureId}`).set('Authorization', `Bearer ${session}`)
            .send({ motifArchivage: 'Saisie à vérifier' });
          assert.equal(archivage.status, 200, `${scenario.nom} archivé`);
        }
        assert.equal((await restaurer(dansA.body.id, sessionConducteur)).status, 403, `${scenario.nom} : chantiers:write ne suffit pas`);
        await avecDelegation(idConducteur, ['chantiers:archive'], async () => {
          assert.equal((await restaurer(dansB.body.id, sessionConducteur)).status, 404, `${scenario.nom} hors périmètre : même réponse qu’une affaire absente`);
          assert.equal((await restaurer(dansA.body.id, sessionConducteur, {})).status, 400, `${scenario.nom} sans motif`);
          assert.equal((await restaurer(dansA.body.id, sessionConducteur, { motifRestauration: ' ok ' })).status, 400, `${scenario.nom} motif trop court`);
          assert.equal((await restaurer(dansA.body.id, sessionConducteur)).status, 200, `${scenario.nom} restauré avec la délégation`);
        });
        assert.equal((await restaurer(dansA.body.id, session)).status, 409, `${scenario.nom} déjà restauré`);

        const statuts = (await Promise.all([restaurer(dansB.body.id, session), restaurer(dansB.body.id, session)])).map((res) => res.status).sort();
        assert.deepEqual(statuts, [200, 409], `${scenario.nom} : une seule restauration concurrente aboutit`);
        for (const ecritureId of [dansA.body.id, dansB.body.id]) {
          const traces = await prisma.journalSaisieChantier.count({ where: { cibleId: ecritureId, action: 'RESTAURATION' } });
          assert.equal(traces, 1, `${scenario.nom} : une seule restauration tracée`);
        }
      }
    });

    test('l’archivage d’un pointage exige la même délégation que celui d’un achat', async () => {
      // Les deux DELETE ont des gardes indépendantes : protéger un achat ne protège pas un
      // pointage. Ce compte dédié évite de dépendre de la délégation d'une fixture partagée.
      const email = 'archiviste.pointage@iris.test';
      const residu = await prisma.user.findUnique({ where: { email } });
      if (residu) {
        await prisma.journalSaisieChantier.deleteMany({ where: { auteurId: residu.id } });
        await prisma.pointageHeure.deleteMany({ where: { OR: [{ createdById: residu.id }, { updatedById: residu.id }, { archivedById: residu.id }] } });
        await prisma.user.delete({ where: { id: residu.id } });
      }
      const archiviste = await prisma.user.create({ data: { email, name: 'TEST Archiviste pointage', role: 'CONDUCTEUR_TRAVAUX', permissions: [] } });
      await prisma.chantier.update({ where: { id: idChantierA }, data: { responsableId: archiviste.id } });
      const jetonArchiviste = jwt.sign({ id: archiviste.id, role: 'CONDUCTEUR_TRAVAUX' }, process.env.JWT_SECRET);
      try {
        const creation = await request(app).post('/api/heures').set('Authorization', `Bearer ${jetonArchiviste}`)
          .send({ chantierId: idChantierA, intervenantId: idIntervenant, date: '06-09-2026', nbrHeures: 2 });
        assert.equal(creation.status, 200, 'chantiers:write suffit pour saisir un pointage');
        const refus = await request(app).delete(`/api/heures/${creation.body.id}`).set('Authorization', `Bearer ${jetonArchiviste}`)
          .send({ motifArchivage: 'Saisie en double' });
        assert.equal(refus.status, 403, 'archiver un pointage exige chantiers:archive');
        await prisma.user.update({ where: { id: archiviste.id }, data: { permissions: ['chantiers:archive'] } });
        const archive = await request(app).delete(`/api/heures/${creation.body.id}`).set('Authorization', `Bearer ${jetonArchiviste}`)
          .send({ motifArchivage: 'Saisie en double' });
        assert.equal(archive.status, 200, 'la délégation rend l’archivage du pointage possible');
      } finally {
        await prisma.chantier.update({ where: { id: idChantierA }, data: { responsableId: idConducteur } });
        await prisma.journalSaisieChantier.deleteMany({ where: { auteurId: archiviste.id } });
        await prisma.pointageHeure.deleteMany({ where: { OR: [{ createdById: archiviste.id }, { updatedById: archiviste.id }, { archivedById: archiviste.id }] } });
        await prisma.user.delete({ where: { id: archiviste.id } });
      }
    });

    test('une écriture archivée ne peut plus être corrigée ni archivée une seconde fois', async () => {
      const scenarios = [
        {
          nom: 'achat', chemin: '/api/achats', creation: {
            chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur,
            date: '06-09-2026', description: 'TEST achat figé', montantHT: 25,
          },
          correction: { montantHT: 30, motifCorrection: 'Correction nécessaire' }, cible: 'ACHAT',
        },
        {
          nom: 'pointage', chemin: '/api/heures', creation: {
            chantierId: idChantierA, intervenantId: idIntervenant,
            date: '06-09-2026', nbrHeures: 2,
          },
          correction: { nbrHeures: 3, motifCorrection: 'Correction nécessaire' }, cible: 'HEURE',
        },
      ];
      for (const scenario of scenarios) {
        const creation = await request(app).post(scenario.chemin).set('Authorization', `Bearer ${sessionConducteur}`).send(scenario.creation);
        assert.equal(creation.status, 200, `${scenario.nom} créé`);
        // PostgreSQL compte les caractères (char_length), JavaScript .length compte les unités
        // UTF-16 : les emoji doivent suivre la même règle à la frontière API.
        for (const motifArchivage of ['', 'x', 'x'.repeat(501), '😀😀']) {
          const invalide = await request(app).delete(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${session}`).send({ motifArchivage });
          assert.equal(invalide.status, 400, `${scenario.nom} : motif invalide refusé (${[...motifArchivage].length} caractère(s))`);
        }
        const motifLong = '😀'.repeat(300);
        const archiveLongue = await request(app).delete(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${session}`).send({ motifArchivage: motifLong });
        assert.equal(archiveLongue.status, 200, `${scenario.nom} : 300 caractères doivent être acceptés`);
        const modele = scenario.nom === 'achat' ? prisma.achatReel : prisma.pointageHeure;
        await modele.update({ where: { id: creation.body.id }, data: { archivedAt: null, archivedById: null, motifArchivage: null } });
        await prisma.journalSaisieChantier.deleteMany({ where: { cibleId: creation.body.id, action: 'ARCHIVAGE' } });
        const archive = await request(app).delete(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${session}`).send({ motifArchivage: 'Saisie en double' });
        assert.equal(archive.status, 200, `${scenario.nom} archivé`);
        const correction = await request(app).patch(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${sessionConducteur}`).send(scenario.correction);
        assert.equal(correction.status, 409, `${scenario.nom} archivé ne doit plus être corrigible`);
        const secondeArchive = await request(app).delete(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${session}`).send({ motifArchivage: 'Deuxième demande' });
        assert.equal(secondeArchive.status, 409, `${scenario.nom} archivé ne doit plus être archivable`);
        const traces = await prisma.journalSaisieChantier.findMany({ where: { cible: scenario.cible, cibleId: creation.body.id } });
        assert.equal(traces.length, 2, `${scenario.nom} ne crée aucune trace après archivage`);
      }
    });

    test('la base refuse un archivage incomplet', async () => {
      await assert.rejects(() => prisma.achatReel.create({ data: {
        date: new Date(), description: 'TEST archivage incomplet', montantHT: 1,
        chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur,
        createdById: idConducteur, updatedById: idConducteur,
        archivedAt: new Date(), motifArchivage: 'Motif sans auteur',
      } }));
      await assert.rejects(() => prisma.pointageHeure.create({ data: {
        date: new Date(), nbrHeures: 1, tauxHoraireApplique: 40,
        chantierId: idChantierA, intervenantId: idIntervenant,
        createdById: idConducteur, updatedById: idConducteur,
        archivedAt: new Date(), archivedById: idConducteur,
      } }));
      await assert.rejects(() => prisma.achatReel.create({ data: {
        date: new Date(), description: 'TEST auteur d’archivage inconnu', montantHT: 1,
        chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur,
        createdById: idConducteur, updatedById: idConducteur,
        archivedAt: new Date(), archivedById: 'compte-inexistant', motifArchivage: 'Auteur inconnu',
      } }));
      await assert.rejects(() => prisma.pointageHeure.create({ data: {
        date: new Date(), nbrHeures: 1, tauxHoraireApplique: 40,
        chantierId: idChantierA, intervenantId: idIntervenant,
        createdById: idConducteur, updatedById: idConducteur,
        archivedAt: new Date(), archivedById: 'compte-inexistant', motifArchivage: 'Auteur inconnu',
      } }));
    });

    test('la base relie les auteurs de saisie et fige l’auteur de création', async () => {
      const scenarios = [
        {
          nom: 'achat', modele: prisma.achatReel,
          creation: { date: new Date(), description: 'TEST auteurs achat SQL', montantHT: 1, chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, createdById: idConducteur, updatedById: idConducteur },
        },
        {
          nom: 'pointage', modele: prisma.pointageHeure,
          creation: { date: new Date(), nbrHeures: 1, tauxHoraireApplique: 40, chantierId: idChantierA, intervenantId: idIntervenant, createdById: idConducteur, updatedById: idConducteur },
        },
      ];
      for (const scenario of scenarios) {
        await assert.rejects(() => scenario.modele.create({ data: { ...scenario.creation, createdById: 'compte-inexistant' } }), `${scenario.nom} : auteur de création inconnu refusé`);
        await assert.rejects(() => scenario.modele.create({ data: { ...scenario.creation, updatedById: 'compte-inexistant' } }), `${scenario.nom} : dernier auteur inconnu refusé`);
        const ecriture = await scenario.modele.create({ data: scenario.creation });
        await assert.rejects(() => scenario.modele.update({ where: { id: ecriture.id }, data: { createdById: idCorrecteur } }), `${scenario.nom} : auteur de création immuable en base`);
        assert.equal((await scenario.modele.findUniqueOrThrow({ where: { id: ecriture.id } })).createdById, idConducteur);
      }
    });

    test('un compte ayant archivé une écriture n’est pas supprimable', async () => {
      const scenarios = ['achat', 'pointage'];
      for (const nom of scenarios) {
        const email = `archiveur.${nom}.protege@iris.test`;
        const residu = await prisma.user.findUnique({ where: { email } });
        if (residu) {
          const referencesAuteur = { OR: [{ createdById: residu.id }, { updatedById: residu.id }, { archivedById: residu.id }] };
          await prisma.achatReel.deleteMany({ where: referencesAuteur });
          await prisma.pointageHeure.deleteMany({ where: referencesAuteur });
          await prisma.user.delete({ where: { id: residu.id } });
        }
        const auteur = await prisma.user.create({ data: { email, name: 'TEST Archiveur protégé', role: 'ADMIN' } });
        const ecriture = nom === 'achat'
          ? await prisma.achatReel.create({ data: { date: new Date(), description: 'TEST achat auteur protégé', montantHT: 1, chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, createdById: auteur.id, updatedById: auteur.id, archivedAt: new Date(), archivedById: auteur.id, motifArchivage: 'Saisie en double' } })
          : await prisma.pointageHeure.create({ data: { date: new Date(), nbrHeures: 1, tauxHoraireApplique: 40, chantierId: idChantierA, intervenantId: idIntervenant, createdById: auteur.id, updatedById: auteur.id, archivedAt: new Date(), archivedById: auteur.id, motifArchivage: 'Saisie en double' } });
        const suppression = await request(app).delete(`/api/users/${auteur.id}`).set('Authorization', `Bearer ${session}`);
        assert.equal(suppression.status, 409, `${nom} : la suppression doit expliquer la protection de la preuve`);
        assert.match(suppression.body.error, /preuve de traçabilité/);
        assert.match(suppression.body.error, /Désactivez-le plutôt/);
        assert.ok(await prisma.user.findUnique({ where: { id: auteur.id } }));
        if (nom === 'achat') await prisma.achatReel.delete({ where: { id: ecriture.id } });
        else await prisma.pointageHeure.delete({ where: { id: ecriture.id } });
        await prisma.user.delete({ where: { id: auteur.id } });
      }
    });

    test('un compte auteur de saisie n’est pas supprimable', async () => {
      const scenarios = [
        { nom: 'achat créé', modele: prisma.achatReel, creation: (auteurId) => ({ date: new Date(), description: 'TEST achat auteur de saisie', montantHT: 1, chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, createdById: auteurId, updatedById: idConducteur }) },
        { nom: 'achat corrigé', modele: prisma.achatReel, creation: (auteurId) => ({ date: new Date(), description: 'TEST achat correcteur protégé', montantHT: 1, chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, createdById: idConducteur, updatedById: auteurId }) },
        { nom: 'pointage créé', modele: prisma.pointageHeure, creation: (auteurId) => ({ date: new Date(), nbrHeures: 1, tauxHoraireApplique: 40, chantierId: idChantierA, intervenantId: idIntervenant, createdById: auteurId, updatedById: idConducteur }) },
        { nom: 'pointage corrigé', modele: prisma.pointageHeure, creation: (auteurId) => ({ date: new Date(), nbrHeures: 1, tauxHoraireApplique: 40, chantierId: idChantierA, intervenantId: idIntervenant, createdById: idConducteur, updatedById: auteurId }) },
      ];
      for (const [index, scenario] of scenarios.entries()) {
        const auteur = await prisma.user.create({ data: { email: `auteur.saisie.${index}@iris.test`, name: 'TEST Auteur de saisie', role: 'ADMIN' } });
        const ecriture = await scenario.modele.create({ data: scenario.creation(auteur.id) });
        const suppression = await request(app).delete(`/api/users/${auteur.id}`).set('Authorization', `Bearer ${session}`);
        assert.equal(suppression.status, 409, `${scenario.nom} : suppression refusée`);
        assert.match(suppression.body.error, /preuve de traçabilité/);
        assert.match(suppression.body.error, /Désactivez-le plutôt/);
        assert.ok(await prisma.user.findUnique({ where: { id: auteur.id } }));
        await scenario.modele.delete({ where: { id: ecriture.id } });
        await prisma.user.delete({ where: { id: auteur.id } });
      }
    });

    test('une écriture archivée hors périmètre reste invisible', async () => {
      await avecDelegation(idConducteur, ['chantiers:archive'], async () => {
        // Le 409 « déjà archivé » ne doit jamais précéder le contrôle de périmètre : il révélerait
        // l’existence et l’état d’une écriture sur une affaire que l’appelant ne peut pas voir.
        const archivees = {
          achat: await prisma.achatReel.create({ data: {
            date: new Date(), description: 'TEST achat archivé hors périmètre', montantHT: 10,
            chantierId: idChantierB, categorieId: idCategorie, fournisseurId: idFournisseur,
            createdById: idConducteur, updatedById: idConducteur,
            archivedAt: new Date(), archivedById: idConducteur, motifArchivage: 'Test de confidentialité',
          } }),
          heure: await prisma.pointageHeure.create({ data: {
            date: new Date(), nbrHeures: 2, tauxHoraireApplique: 40,
            chantierId: idChantierB, intervenantId: idIntervenant,
            createdById: idConducteur, updatedById: idConducteur,
            archivedAt: new Date(), archivedById: idConducteur, motifArchivage: 'Test de confidentialité',
          } }),
        };
        const scenarios = [
          { nom: 'achat', chemin: '/api/achats', correction: { montantHT: 20 } },
          { nom: 'heure', chemin: '/api/heures', correction: { nbrHeures: 3 } },
        ];
        for (const scenario of scenarios) {
          const id = archivees[scenario.nom].id;
          const correction = await request(app).patch(`${scenario.chemin}/${id}`)
            .set('Authorization', `Bearer ${sessionConducteur}`).send(scenario.correction);
          assert.equal(correction.status, 404, `${scenario.nom} archivé hors périmètre : correction invisible`);
          const archivage = await request(app).delete(`${scenario.chemin}/${id}`)
            .set('Authorization', `Bearer ${sessionConducteur}`).send({ motifArchivage: 'Deuxième demande' });
          assert.equal(archivage.status, 404, `${scenario.nom} archivé hors périmètre : archivage invisible`);
        }
      });
    });

    test('deux archivages simultanés n’en retiennent qu’un seul', async () => {
      await avecDelegation(idConducteur, ['chantiers:archive'], async () => {
        // Sans le filtre archivedAt: null dans l’UPDATE, deux requêtes concurrentes écrasent la
        // première trace. Les deux modèles portent le même verrou, donc les deux sont couverts.
        const scenarios = [
          { nom: 'achat', chemin: '/api/achats', cible: 'ACHAT', creation: {
            chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur,
            date: '06-09-2026', description: 'TEST archivage concurrent', montantHT: 25,
          } },
          { nom: 'pointage', chemin: '/api/heures', cible: 'HEURE', creation: {
            chantierId: idChantierA, intervenantId: idIntervenant, date: '06-09-2026', nbrHeures: 2,
          } },
        ];
        for (const scenario of scenarios) {
          const creation = await request(app).post(scenario.chemin).set('Authorization', `Bearer ${sessionConducteur}`).send(scenario.creation);
          assert.equal(creation.status, 200, `${scenario.nom} créé`);
          const supprimer = () => request(app).delete(`${scenario.chemin}/${creation.body.id}`)
            .set('Authorization', `Bearer ${sessionConducteur}`).send({ motifArchivage: 'Saisie en double' });
          const resultats = await Promise.all([supprimer(), supprimer()]);
          assert.deepEqual(resultats.map((res) => res.status).sort(), [200, 409], `${scenario.nom} : un seul archivage doit réussir`);
          const traces = await prisma.journalSaisieChantier.findMany({ where: { cible: scenario.cible, cibleId: creation.body.id, action: 'ARCHIVAGE' } });
          assert.equal(traces.length, 1, `${scenario.nom} : un seul archivage doit être journalisé`);
        }
      });
    });

    test('le journal d’audit respecte le périmètre du conducteur', async () => {
      // Une trace ne doit pas devenir une porte latérale vers un chantier non rattaché.
      await prisma.journalSaisieChantier.create({
        data: { chantierId: idChantierB, cible: 'ACHAT', cibleId: 'test-hors-perimetre', action: 'CREATION', auteurId: idConducteur, auteurNom: 'TEST Conducteur' },
      });
      const interdit = await request(app).get(`/api/chantiers/${idChantierB}/journal-saisies`).set('Authorization', `Bearer ${sessionConducteur}`);
      assert.equal(interdit.status, 404);
      const autorise = await request(app).get(`/api/chantiers/${idChantierA}/journal-saisies`).set('Authorization', `Bearer ${sessionConducteur}`);
      assert.equal(autorise.status, 200);
    });

    test('le journal d’audit référence un auteur réel et protège son compte', async () => {
      // En SQL brut : Prisma refuse un auteurId absent avant PostgreSQL. Cette insertion
      // prouve donc réellement que la contrainte NOT NULL existe encore dans la base.
      await assert.rejects(() => prisma.$executeRawUnsafe(
        `INSERT INTO "JournalSaisieChantier" (id, "chantierId", cible, "cibleId", action, "auteurNom", "createdAt")
         VALUES (gen_random_uuid()::text, $1, 'ACHAT', 'test-auteur-absent', 'CREATION', 'Sans auteur', now())`,
        idChantierA,
      ), 'une trace sans auteur doit être refusée par la base');
      await assert.rejects(() => prisma.journalSaisieChantier.create({
        data: { chantierId: idChantierA, cible: 'ACHAT', cibleId: 'test-auteur-inconnu', action: 'CREATION', auteurId: 'compte-inexistant', auteurNom: 'Auteur inconnu' },
      }));
      const auteur = await prisma.user.create({ data: { email: 'auteur.journal@iris.test', name: 'TEST Auteur journal', role: 'ADMIN' } });
      const trace = await prisma.journalSaisieChantier.create({
        data: { chantierId: idChantierA, cible: 'ACHAT', cibleId: 'test-auteur-journal', action: 'CREATION', auteurId: auteur.id, auteurNom: auteur.name },
      });
      const suppression = await request(app).delete(`/api/users/${auteur.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppression.status, 409);
      assert.match(suppression.body.error, /preuve de traçabilité/);
      assert.ok(await prisma.user.findUnique({ where: { id: auteur.id } }));
      await prisma.journalSaisieChantier.delete({ where: { id: trace.id } });
      await prisma.user.delete({ where: { id: auteur.id } });
    });

    test('un administrateur voit bien toutes les lignes', async () => {
      // Le filtrage ne doit pas amputer ceux qui ont légitimement la vue complète.
      const achats = await request(app).get('/api/achats').set('Authorization', `Bearer ${session}`);
      const vus = new Set(achats.body.map((a) => a.chantier?.id));
      assert.ok(vus.has(idChantierA) && vus.has(idChantierB));
    });
  });

  describe('Domaine chantier ouvert à un agent', () => {
    let session = '';
    let cleChantiers = '';
    let cleAvecFinances = '';

    before(async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = res.body.token;
      const creer = async (nom, scopes) => {
        const r = await request(app).post('/api/admin/api-keys')
          .set('Authorization', `Bearer ${session}`).send({ nom, scopes });
        return r.body.apiKey;
      };
      cleChantiers = await creer('TEST agent chantiers', ['chantiers:read']);
      cleAvecFinances = await creer('TEST agent finances', ['chantiers:read', 'finances:read']);
    });

    test('une clé chantiers:read lit chantiers, achats et heures', async () => {
      for (const chemin of ['/api/v1/chantiers', '/api/v1/achats', '/api/v1/heures']) {
        const res = await request(app).get(chemin).set('Authorization', `Bearer ${cleChantiers}`);
        assert.equal(res.status, 200, `${chemin} → ${res.status}`);
        assert.ok(Array.isArray(res.body));
      }
    });

    test('elle voit tout le parc : une clé n’a pas de rôle qui la restreindrait', async () => {
      const res = await request(app).get('/api/v1/achats').set('Authorization', `Bearer ${cleChantiers}`);
      const vus = new Set(res.body.map((a) => a.chantier?.id));
      assert.ok(vus.size >= 2, 'un agent autorisé sur le domaine voit l’ensemble des chantiers');
    });

    test('sans finances:read, les montants vendus restent masqués', async () => {
      const res = await request(app).get('/api/v1/chantiers').set('Authorization', `Bearer ${cleChantiers}`);
      assert.equal(res.status, 200);
      const chantier = res.body.find((c) => String(c.nom).startsWith('TEST Chantier'));
      assert.ok(chantier, 'les chantiers de test doivent être visibles');
      assert.equal(chantier.budgetGlobalVendu, null, 'le budget vendu ne doit pas sortir sans finances:read');
      assert.equal(chantier.metrics.margeCommerciale, null, 'la marge ne doit pas sortir sans finances:read');
    });

    test('avec finances:read, ils sortent', async () => {
      const res = await request(app).get('/api/v1/chantiers').set('Authorization', `Bearer ${cleAvecFinances}`);
      const chantier = res.body.find((c) => String(c.nom).startsWith('TEST Chantier'));
      assert.equal(chantier.budgetGlobalVendu, 100000);
      assert.notEqual(chantier.metrics.margeCommerciale, null);
    });

    test('une clé d’un autre domaine reste refusée', async () => {
      const r = await request(app).post('/api/admin/api-keys')
        .set('Authorization', `Bearer ${session}`).send({ nom: 'TEST agent clients', scopes: ['clients:read'] });
      const res = await request(app).get('/api/v1/achats').set('Authorization', `Bearer ${r.body.apiKey}`);
      assert.equal(res.status, 403);
      assert.match(res.body.error, /chantiers:read/);
    });
  });

  describe('Catalogue', () => {
    let session = '';
    before(async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = res.body.token;
    });

    test('une famille inconnue renvoie 404', async () => {
      const res = await request(app).get('/api/catalogue/voitures').set('Authorization', `Bearer ${session}`);
      assert.equal(res.status, 404);
    });

    test('une référence en double est refusée par un 409', async () => {
      const envoi = () => request(app).post('/api/catalogue/articles')
        .set('Authorization', `Bearer ${session}`)
        .send({ reference: 'TEST-DOUBLON', nom: 'Article', prixVenteHt: '10' });
      assert.equal((await envoi()).status, 201);
      assert.equal((await envoi()).status, 409);
    });

    test('la désactivation conserve la fiche', async () => {
      const creation = await request(app).post('/api/catalogue/equipements')
        .set('Authorization', `Bearer ${session}`)
        .send({ reference: 'TEST-CAM-01', nom: 'Caméra dôme', fabricant: 'Hikvision', prixVenteHt: '199' });
      assert.equal(creation.status, 201);
      const res = await request(app).delete(`/api/catalogue/equipements/${creation.body.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.actif, false);
    });
  });

  describe('Parc d’équipements installés', () => {
    let session = '';
    let clientId = '';
    let siteId = '';
    let modeleId = '';
    let equipementId = '';

    before(async () => {
      const secours = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = secours.body.token;
      const client = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`)
        .send({ raisonSociale: 'TEST Parc client' });
      clientId = client.body.id;
      const site = await request(app).post(`/api/clients/${clientId}/sites`).set('Authorization', `Bearer ${session}`)
        .send({ nom: 'TEST Site parc', adresse: '1 rue du Parc', codePostal: '14000', ville: 'Caen', estSiteIntervention: true });
      siteId = site.body.id;
      const modele = await request(app).post('/api/catalogue/equipements').set('Authorization', `Bearer ${session}`)
        .send({ reference: 'TEST-PARC-CAM', nom: 'Caméra parc', fabricant: 'Iris', prixVenteHt: 250 });
      modeleId = modele.body.id;
    });

    test('installe un équipement sérialisé chez un client et le relit avec sa garantie', async () => {
      const creation = await request(app).post(`/api/clients/${clientId}/equipements`).set('Authorization', `Bearer ${session}`)
        .send({ catalogueEquipementId: modeleId, clientSiteId: siteId, numeroSerie: 'TEST-SN-001', garantieJusquAu: '2028-09-01', notes: 'Baie principale' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      assert.equal(creation.body.numeroSerie, 'TEST-SN-001');
      assert.equal(creation.body.statut, 'INSTALLE');
      assert.equal(creation.body.catalogueEquipement.reference, 'TEST-PARC-CAM');
      equipementId = creation.body.id;

      const parc = await request(app).get(`/api/clients/${clientId}/equipements`).set('Authorization', `Bearer ${session}`);
      assert.equal(parc.status, 200);
      assert.equal(parc.body.length, 1);
      assert.equal(parc.body[0].clientSite.id, siteId);
      assert.equal(parc.body[0].garantieJusquAu.slice(0, 10), '2028-09-01');
    });

    test('refuse un équipement rattaché au site d’un autre client', async () => {
      const autre = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`)
        .send({ raisonSociale: 'TEST Autre client parc' });
      const autreSite = await request(app).post(`/api/clients/${autre.body.id}/sites`).set('Authorization', `Bearer ${session}`)
        .send({ nom: 'TEST Site autre client', adresse: '2 rue des Tests', codePostal: '14000', ville: 'Caen' });
      const res = await request(app).post(`/api/clients/${clientId}/equipements`).set('Authorization', `Bearer ${session}`)
        .send({ catalogueEquipementId: modeleId, clientSiteId: autreSite.body.id, numeroSerie: 'TEST-SN-002' });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /site/i);
    });

    test('archive sans supprimer l’équipement ni son numéro de série', async () => {
      const archive = await request(app).post(`/api/clients/${clientId}/equipements/${equipementId}/archiver`).set('Authorization', `Bearer ${session}`);
      assert.equal(archive.status, 200);
      assert.equal(archive.body.statut, 'ARCHIVE');
      assert.equal(archive.body.numeroSerie, 'TEST-SN-001');

      const parc = await request(app).get(`/api/clients/${clientId}/equipements?inclureArchives=true`).set('Authorization', `Bearer ${session}`);
      assert.equal(parc.status, 200);
      assert.equal(parc.body.some((e) => e.id === equipementId && e.statut === 'ARCHIVE'), true);
    });
  });

  describe('Devis versionnés', () => {
    let session = '';
    let clientId = '';
    let devisId = '';
    let dossierId = '';
    let numero = '';

    before(async () => {
      const secours = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = secours.body.token;
      const client = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`)
        .send({ raisonSociale: 'TEST Client devis' });
      clientId = client.body.id;
    });

    test('crée un brouillon de devis avec ses lignes et ses totaux calculés', async () => {
      const res = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'Installation contrôle d’accès',
        lignes: [{ designation: 'Pose lecteur', quantite: 2, prixUnitaireHt: 120, tauxTva: 20 }],
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.version, 1);
      assert.equal(res.body.statut, 'BROUILLON');
      assert.equal(res.body.totalHt, 240);
      assert.equal(res.body.totalTtc, 288);
      assert.match(res.body.numero, /^A\d{2}-\d{4,}$/);
      devisId = res.body.id;
      dossierId = res.body.dossierId;
      numero = res.body.numero;
    });

    test('modifie un devis non signé et recalcule ses totaux côté serveur', async () => {
      const res = await request(app).patch(`/api/devis/${devisId}`).set('Authorization', `Bearer ${session}`).send({
        clientId,
        objet: 'Installation contrôle d’accès révisée',
        acompteExige: true,
        tauxAcompte: 30,
        lignes: [{ designation: 'Pose lecteur révisée', nature: 'MAIN_OEUVRE', quantite: 3, prixUnitaireHt: 100, tauxTva: 20 }],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.objet, 'Installation contrôle d’accès révisée');
      assert.equal(res.body.acompteExige, true);
      assert.equal(res.body.tauxAcompte, 30);
      assert.equal(res.body.lignes[0].designation, 'Pose lecteur révisée');
      assert.equal(res.body.totalHt, 300);
      assert.equal(res.body.totalTva, 60);
      assert.equal(res.body.totalTtc, 360);
    });

    // Témoin d'audit : ces refus ne sont pas des variantes du parcours nominal. Ils
    // séparent explicitement la révision (qui exige une signature), la conversion (qui
    // la rend ensuite irréversible), l'identité du client externe et l'auteur interne.
    test('préserve les invariants de signature, révision, conversion et acompte', async () => {
      const lignes = [{ designation: 'Pose témoin', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }];
      const clientInvalide = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId: 'client-inexistant', objet: 'Client invalide', lignes,
      });
      assert.equal(clientInvalide.status, 400, JSON.stringify(clientInvalide.body));
      assert.match(clientInvalide.body.error, /client introuvable/i);

      const brouillon = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'Témoin invariants', acompteExige: true, tauxAcompte: 35, lignes,
      });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const revisionNonSignee = await request(app).post(`/api/devis/${brouillon.body.id}/revisions`).set('Authorization', `Bearer ${session}`);
      assert.equal(revisionNonSignee.status, 409, JSON.stringify(revisionNonSignee.body));
      assert.match(revisionNonSignee.body.error, /signé/i);

      const patchOmis = await request(app).patch(`/api/devis/${brouillon.body.id}`).set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'Témoin invariants modifié', lignes: [{ ...lignes[0], designation: 'Pose témoin modifiée' }],
      });
      assert.equal(patchOmis.status, 200, JSON.stringify(patchOmis.body));
      assert.equal(patchOmis.body.acompteExige, true, 'un PATCH sans acompteExige conserve la condition négociée');
      assert.equal(patchOmis.body.tauxAcompte, 35, 'un PATCH sans tauxAcompte conserve le taux négocié');

      const signataireInvalide = await request(app).post(`/api/devis/${brouillon.body.id}/signature`).set('Authorization', `Bearer ${session}`)
        .send({ signataire: 'A', confirme: true });
      assert.equal(signataireInvalide.status, 400, JSON.stringify(signataireInvalide.body));
      assert.match(signataireInvalide.body.error, /signataire/i);

      const signature = await request(app).post(`/api/devis/${brouillon.body.id}/signature`).set('Authorization', `Bearer ${session}`)
        .send({ signataire: 'Claire Cliente', confirme: true });
      assert.equal(signature.status, 201, JSON.stringify(signature.body));
      assert.ok(signature.body.enregistreParId, 'l’employé de la session est le seul auteur interne enregistré');
      const acompte = await request(app).post(`/api/devis/${brouillon.body.id}/acompte`).set('Authorization', `Bearer ${session}`)
        .send({ recuLe: '01-09-2026', montant: 42, reference: 'VIR TÉMOIN' });
      assert.equal(acompte.status, 200, JSON.stringify(acompte.body));
      const conversion = await request(app).post(`/api/devis/${brouillon.body.id}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });
      assert.equal(conversion.status, 201, JSON.stringify(conversion.body));
      const revisionConvertie = await request(app).post(`/api/devis/${brouillon.body.id}/revisions`).set('Authorization', `Bearer ${session}`);
      assert.equal(revisionConvertie.status, 409, JSON.stringify(revisionConvertie.body));
      assert.match(revisionConvertie.body.error, /converti/i);

      for (const statut of ['REFUSE', 'ANNULE']) {
        const devisTerminal = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({ clientId, objet: `Signature ${statut}`, lignes });
        assert.equal(devisTerminal.status, 201, JSON.stringify(devisTerminal.body));
        if (statut === 'REFUSE') {
          const envoi = await request(app).put(`/api/devis/${devisTerminal.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ENVOYE' });
          assert.equal(envoi.status, 200, JSON.stringify(envoi.body));
          const refus = await request(app).put(`/api/devis/${devisTerminal.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut });
          assert.equal(refus.status, 200, JSON.stringify(refus.body));
        } else {
          const annulation = await request(app).post(`/api/devis/${devisTerminal.body.id}/annulation`).set('Authorization', `Bearer ${session}`).send({ motif: 'Témoin audit' });
          assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
        }
        const signatureTerminale = await request(app).post(`/api/devis/${devisTerminal.body.id}/signature`).set('Authorization', `Bearer ${session}`)
          .send({ signataire: 'Claire Cliente', confirme: true });
        assert.equal(signatureTerminale.status, 409, JSON.stringify(signatureTerminale.body));
        assert.match(signatureTerminale.body.error, /ne peut plus être signé/i);
      }
    });

    test('garantit HT + TVA = TTC avec un taux réduit', async () => {
      const res = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({ clientId, objet: 'Rénovation', lignes: [{ designation: 'Fourniture posée', quantite: 1, prixUnitaireHt: 5, tauxTva: 5.5 }] });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.totalHt + res.body.totalTva, res.body.totalTtc);
      assert.equal(res.body.totalTtc, 5.28);
    });

    test('refuse les précisions incompatibles avec les unités monétaires sans erreur interne', async () => {
      const res = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'Précision invalide',
        lignes: [{ designation: 'Quantité à quatre décimales', quantite: '0.3333', prixUnitaireHt: '4.27', tauxTva: '5.5' }],
      });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error, 'Ligne de devis invalide.');
    });

    test('fige un devis signé avec confirmation, signataire et empreinte déterministe', async () => {
      const sansConfirmation = await request(app).post(`/api/devis/${devisId}/signature`).set('Authorization', `Bearer ${session}`)
        .send({ signataire: 'Alice Martin', confirme: false });
      assert.equal(sansConfirmation.status, 400, JSON.stringify(sansConfirmation.body));

      const signature = await request(app).post(`/api/devis/${devisId}/signature`).set('Authorization', `Bearer ${session}`)
        .send({ signataire: 'Alice Martin', confirme: true });
      assert.equal(signature.status, 201, JSON.stringify(signature.body));
      assert.equal(signature.body.signataire, 'Alice Martin');
      assert.ok(signature.body.enregistreParId, 'la session humaine qui enregistre la signature est conservée');
      assert.ok(signature.body.signeLe);
      const devisSigne = await request(app).get('/api/devis').set('Authorization', `Bearer ${session}`);
      assert.equal(devisSigne.status, 200, JSON.stringify(devisSigne.body));
      assert.equal(devisSigne.body.find((devis) => devis.id === devisId).statut, 'ACCEPTE');
      const contenu = {
        devisId,
        dossierId,
        numero,
        version: 1,
        clientId,
        objet: 'Installation contrôle d’accès révisée',
        acompteExige: true,
        tauxAcompte: '30.00',
        totalHt: '300.00',
        totalTva: '60.00',
        totalTtc: '360.00',
        lignes: [{ ordre: 0, designation: 'Pose lecteur révisée', nature: 'MAIN_OEUVRE', quantite: '3.000', prixUnitaireHt: '100.00', tauxTva: '20.00', totalHt: '300.00', totalTtc: '360.00' }],
      };
      assert.equal(signature.body.empreinte, createHash('sha256').update(JSON.stringify(contenu), 'utf8').digest('hex'));
    });

    test('refuse de modifier la révision signée et crée une révision brouillon distincte', async () => {
      const interdit = await request(app).patch(`/api/devis/${devisId}`).set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'Modification interdite', lignes: [{ designation: 'Interdit', quantite: 1, prixUnitaireHt: 1, tauxTva: 20 }],
      });
      assert.equal(interdit.status, 409, JSON.stringify(interdit.body));
      assert.match(interdit.body.error, /signé/i);

      const res = await request(app).post(`/api/devis/${devisId}/revisions`).set('Authorization', `Bearer ${session}`);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.version, 2);
      assert.equal(res.body.statut, 'BROUILLON');
      assert.equal(res.body.dossierId, dossierId);
      assert.equal(res.body.numero, numero);
      const modifie = await request(app).patch(`/api/devis/${res.body.id}`).set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'Installation contrôle d’accès v2', acompteExige: false,
        lignes: [{ designation: 'Pose v2', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 200, tauxTva: 20 }],
      });
      assert.equal(modifie.status, 200, JSON.stringify(modifie.body));
      assert.equal(modifie.body.totalTtc, 240);
      const original = await request(app).get('/api/devis').set('Authorization', `Bearer ${session}`);
      assert.equal(original.body.find((d) => d.id === devisId).objet, 'Installation contrôle d’accès révisée');
    });

    test('fige l’acompte encaissé, le reporte dans la révision et protège la dernière version', async () => {
      const initial = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'TEST Acompte versionné', acompteExige: true, tauxAcompte: 25,
        lignes: [{ designation: 'Pose', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }],
      });
      assert.equal(initial.status, 201, JSON.stringify(initial.body));
      const envoi = await request(app).put(`/api/devis/${initial.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ENVOYE' });
      assert.equal(envoi.status, 200, JSON.stringify(envoi.body));
      const acceptationDirecte = await request(app).put(`/api/devis/${initial.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ACCEPTE' });
      assert.equal(acceptationDirecte.status, 400, 'la signature est l’unique transition vers ACCEPTE');
      const signature = await request(app).post(`/api/devis/${initial.body.id}/signature`).set('Authorization', `Bearer ${session}`).send({ signataire: 'Alice Martin', confirme: true });
      assert.equal(signature.status, 201, JSON.stringify(signature.body));
      assert.equal(signature.body.enregistreParId, (await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' } })).id);
      const signatureMachine = await request(app).post(`/api/v1/devis/${initial.body.id}/signature`).set('Authorization', `Bearer ${cleApi}`).send({ signataire: 'Automate', confirme: true });
      assert.equal(signatureMachine.status, 404, 'une clé d’intégration ne peut pas signer un devis');
      const patchSigne = await request(app).patch(`/api/devis/${initial.body.id}`).set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'Modification signée interdite', lignes: [{ designation: 'Interdit', quantite: 1, prixUnitaireHt: 1, tauxTva: 20 }],
      });
      assert.equal(patchSigne.status, 409, 'un devis signé ne reste jamais éditable');
      const acompte = await request(app).post(`/api/devis/${initial.body.id}/acompte`).set('Authorization', `Bearer ${session}`)
        .send({ recuLe: '24-09-2026', montant: 30, reference: 'TEST-ACOMPTE-REVISION' });
      assert.equal(acompte.status, 200, JSON.stringify(acompte.body));
      const revision = await request(app).post(`/api/devis/${initial.body.id}/revisions`).set('Authorization', `Bearer ${session}`);
      assert.equal(revision.status, 201, JSON.stringify(revision.body));
      assert.equal(revision.body.acompteExige, true);
      assert.equal(revision.body.tauxAcompte, 25);
      assert.equal(revision.body.acompteMontant, 30);
      assert.equal(revision.body.acompteReference, 'TEST-ACOMPTE-REVISION');

      const patchSansTaux = await request(app).patch(`/api/devis/${revision.body.id}`).set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'TEST Acompte versionné corrigé', acompteExige: false,
        lignes: [{ designation: 'Pose corrigée', quantite: 2, prixUnitaireHt: 100, tauxTva: 20 }],
      });
      assert.equal(patchSansTaux.status, 200, JSON.stringify(patchSansTaux.body));
      assert.equal(patchSansTaux.body.acompteExige, true, 'un acompte encaissé ne peut plus être retiré');
      assert.equal(patchSansTaux.body.tauxAcompte, 25, 'un PATCH sans taux conserve le taux négocié');

      const revisionDeAncienne = await request(app).post(`/api/devis/${initial.body.id}/revisions`).set('Authorization', `Bearer ${session}`);
      assert.equal(revisionDeAncienne.status, 409, 'une version antérieure ne peut plus rouvrir une négociation');
      const conversionAncienne = await request(app).post(`/api/devis/${initial.body.id}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });
      assert.equal(conversionAncienne.status, 409, 'une version remplacée ne peut pas ouvrir une affaire');

      const refuse = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'TEST Devis refusé figé', lignes: [{ designation: 'Pose', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }],
      });
      assert.equal(refuse.status, 201, JSON.stringify(refuse.body));
      await request(app).put(`/api/devis/${refuse.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ENVOYE' });
      await request(app).put(`/api/devis/${refuse.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'REFUSE' });
      const patchRefuse = await request(app).patch(`/api/devis/${refuse.body.id}`).set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'Modification refusée interdite', lignes: [{ designation: 'Interdit', quantite: 1, prixUnitaireHt: 1, tauxTva: 20 }],
      });
      assert.equal(patchRefuse.status, 409, 'un devis refusé ne reste jamais éditable');
    });

    test('sérialise une seule signature concurrente', async () => {
      const devis = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'TEST Signature concurrente', lignes: [{ designation: 'Pose', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }],
      });
      const reponses = await Promise.all(['Bob', 'Carole'].map(signataire => request(app).post(`/api/devis/${devis.body.id}/signature`)
        .set('Authorization', `Bearer ${session}`).send({ signataire, confirme: true })));
      assert.deepEqual(reponses.map(r => r.status).sort(), [201, 409]);
      assert.equal(await prisma.devisSignature.count({ where: { devisId: devis.body.id } }), 1);
    });

    test('sérialise la création concurrente d’une seule révision brouillon', async () => {
      const devis = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'TEST Révision concurrente', lignes: [{ designation: 'Pose', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }],
      });
      await request(app).post(`/api/devis/${devis.body.id}/signature`).set('Authorization', `Bearer ${session}`).send({ signataire: 'Alice', confirme: true });
      const reponses = await Promise.all([1, 2].map(() => request(app).post(`/api/devis/${devis.body.id}/revisions`).set('Authorization', `Bearer ${session}`)));
      assert.deepEqual(reponses.map(r => r.status).sort(), [201, 409]);
      assert.equal(await prisma.devis.count({ where: { dossierId: devis.body.dossierId } }), 2);
    });

    test('ne crée un chantier qu’après signature humaine, avec la même référence affaire', async () => {
      const nonSigne = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'TEST devis non signé', lignes: [{ designation: 'Ligne', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }],
      });
      assert.equal(nonSigne.status, 201, JSON.stringify(nonSigne.body));
      const avant = await request(app).post(`/api/devis/${nonSigne.body.id}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });
      assert.equal(avant.status, 400);
      const signature = await request(app).post(`/api/devis/${nonSigne.body.id}/signature`).set('Authorization', `Bearer ${session}`)
        .send({ signataire: 'Alice Martin', confirme: true });
      assert.equal(signature.status, 201, JSON.stringify(signature.body));
      const conversion = await request(app).post(`/api/devis/${nonSigne.body.id}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });
      assert.equal(conversion.status, 201, JSON.stringify(conversion.body));
      assert.equal(conversion.body.numeroDevis, nonSigne.body.numero);
      assert.ok((await prisma.chantier.findUnique({ where: { id: conversion.body.id } })).clientId, 'la conversion doit rattacher l’affaire à son client');
      const doublon = await request(app).post(`/api/devis/${nonSigne.body.id}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });
      assert.equal(doublon.status, 400);
    });

    test('refuse la création directe historique d’un chantier', async () => {
      const res = await request(app).post('/api/chantiers').set('Authorization', `Bearer ${session}`).send({ nom: 'TEST interdit' });
      assert.equal(res.status, 410);
    });

    // La référence d'affaire d'un chantier issu d'une conversion est celle qu'Iris émet
    // (A26-0001). Tant que la validation exigeait le format de l'ERP tiers (SXXXXX), ce
    // champ n'acceptait plus aucune valeur qu'Iris sache produire : le corriger était
    // impossible sur les chantiers créés par conversion.
    test('la référence d’affaire se corrige au format qu’Iris émet', async () => {
      // Affaire dédiée : le test modifie la référence, il ne peut donc pas emprunter
      // celle d'un autre test sans le rendre dépendant de l'ordre d'exécution.
      const devis = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`)
        .send({ clientId, objet: 'TEST Référence', lignes: [{ designation: 'L', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] });
      await request(app).put(`/api/devis/${devis.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ENVOYE' });
      await request(app).post(`/api/devis/${devis.body.id}/signature`).set('Authorization', `Bearer ${session}`).send({ signataire: 'TEST Signataire interne', confirme: true });
      const conversion = await request(app).post(`/api/devis/${devis.body.id}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });
      assert.equal(conversion.status, 201, JSON.stringify(conversion.body));
      const chantier = conversion.body;
      assert.match(chantier.numeroDevis, /^A\d{2}-\d{4,}$/);

      const ancienFormat = await request(app).patch(`/api/chantiers/${chantier.id}`)
        .set('Authorization', `Bearer ${session}`).send({ numeroDevis: 'S00700' });
      assert.equal(ancienFormat.status, 400);

      const nouveau = `A${String(new Date().getFullYear()).slice(-2)}-9999`;
      const accepte = await request(app).patch(`/api/chantiers/${chantier.id}`)
        .set('Authorization', `Bearer ${session}`).send({ numeroDevis: nouveau });
      assert.equal(accepte.status, 200, JSON.stringify(accepte.body));
      assert.equal(accepte.body.numeroDevis, nouveau);
    });
  });

  // Iris n'interroge plus aucun ERP tiers : ces routes ont été retirées avec le module de
  // lecture externe et l'écran de rapprochement qu'elles alimentaient. Le test échoue si
  // l'une d'elles réapparaît par mégarde.
  describe('Retrait de l’intégration ERP tierce', () => {
    let session = '';
    before(async () => {
      const secours = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = secours.body.token;
    });

    for (const route of [
      '/api/odoo/clients',
      '/api/odoo/devis',
      '/api/odoo/devis/1/materiel',
      '/api/odoo/devis/1/adresse',
      '/api/suivi-financier',
      '/api/suivi-financier/anciens',
    ]) {
      test(`${route} n’existe plus`, async () => {
        const res = await request(app).get(route).set('Authorization', `Bearer ${session}`);
        assert.equal(res.status, 404, `${route} répond encore ${res.status}`);
      });
    }
  });

  describe('Permissions individuelles', () => {
    let superSession = '', conducteurSession = '', conducteurId = '', clientId = '';
    before(async () => {
      const jwt = (await import('jsonwebtoken')).default;
      await prisma.user.deleteMany({ where: { email: 'permissions@iris.test' } });
      const conducteur = await prisma.user.create({ data: { email: 'permissions@iris.test', name: 'TEST Permissions', role: 'CONDUCTEUR_TRAVAUX' } });
      conducteurId = conducteur.id;
      conducteurSession = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      superSession = (await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN })).body.token;
      clientId = (await request(app).post('/api/clients').set('Authorization', `Bearer ${superSession}`).send({ raisonSociale: 'TEST Client permissions' })).body.id;
    });

    test('refuse un devis sans permission, puis l’autorise après attribution individuelle', async () => {
      const corps = { clientId, objet: 'TEST Devis permission', lignes: [{ designation: 'Test', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] };
      assert.equal((await request(app).post('/api/devis').set('Authorization', `Bearer ${conducteurSession}`).send(corps)).status, 403);
      assert.equal((await request(app).get(`/api/clients/${clientId}`).set('Authorization', `Bearer ${conducteurSession}`)).status, 403);
      const avant = await request(app).get('/api/me').set('Authorization', `Bearer ${conducteurSession}`);
      assert.equal(avant.status, 200);
      assert.equal(avant.body.permissions.includes('devis:read'), false);
      const attribution = await request(app).put(`/api/users/${conducteurId}/permissions`).set('Authorization', `Bearer ${superSession}`).send({ permissions: ['devis:read', 'devis:write', 'clients:read'] });
      assert.equal(attribution.status, 200);
      const apres = await request(app).get('/api/me').set('Authorization', `Bearer ${conducteurSession}`);
      assert.equal(apres.body.permissions.includes('devis:read'), true);
      assert.equal((await request(app).get(`/api/clients/${clientId}`).set('Authorization', `Bearer ${conducteurSession}`)).status, 200);
      assert.equal((await request(app).post('/api/devis').set('Authorization', `Bearer ${conducteurSession}`).send(corps)).status, 201);
    });

    test('/api/me expose les droits hérités du type de compte, pas seulement les individuels', async () => {
      const jwt = (await import('jsonwebtoken')).default;
      const commercial = await prisma.user.create({ data: { email: 'commercial.permissions@iris.test', name: 'TEST Commercial permissions', role: 'COMMERCIAL' } });
      const session = jwt.sign({ id: commercial.id }, process.env.JWT_SECRET);
      const me = await request(app).get('/api/me').set('Authorization', `Bearer ${session}`);
      assert.equal(me.status, 200);
      // La colonne individuelle est vide : ces droits viennent obligatoirement du type.
      assert.deepEqual(me.body.permissions, ['chantiers:read', 'clients:read', 'devis:read', 'devis:write']);
    });

    test('refuse une permission hors du vocabulaire', async () => {
      const res = await request(app).put(`/api/users/${conducteurId}/permissions`).set('Authorization', `Bearer ${superSession}`).send({ permissions: ['invente:write'] });
      assert.equal(res.status, 400);
    });
  });

  // Cycle de vie d'une affaire : c'est la conversion d'un devis accepté qui ouvre le
  // chantier, et l'annulation du devis qui revient dessus. Un chantier ne se supprime plus.
  describe('Cycle de vie du devis : acompte, annulation, duplication', () => {
    let session = '';
    let clientId = '';
    let categorieId = '';
    let fournisseurId = '';
    let intervenantId = '';

    // Amène un devis neuf jusqu'au statut ACCEPTE, avec ou sans acompte exigé.
    const devisAccepte = async (objet, extra = {}) => {
      const cree = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: 100, tauxTva: 20 }], ...extra,
      });
      assert.equal(cree.status, 201, JSON.stringify(cree.body));
      const envoi = await request(app).put(`/api/devis/${cree.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ENVOYE' });
      assert.equal(envoi.status, 200, JSON.stringify(envoi.body));
      const signature = await request(app).post(`/api/devis/${cree.body.id}/signature`).set('Authorization', `Bearer ${session}`)
        .send({ signataire: 'TEST Signataire interne', confirme: true });
      assert.equal(signature.status, 201, JSON.stringify(signature.body));
      return cree.body;
    };
    const convertir = (id) => request(app).post(`/api/devis/${id}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });

    before(async () => {
      session = (await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN })).body.token;
      clientId = (await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST Client cycle' })).body.id;
      categorieId = (await prisma.categorie.upsert({ where: { nom: 'TEST Catégorie cycle' }, update: {}, create: { nom: 'TEST Catégorie cycle' } })).id;
      fournisseurId = (await prisma.fournisseur.upsert({ where: { nom: 'TEST Fournisseur cycle' }, update: {}, create: { nom: 'TEST Fournisseur cycle' } })).id;
      intervenantId = (await prisma.intervenant.create({ data: { nom: 'TEST Intervenant cycle', role: 'Technicien', tauxHoraireCharge: 40 } })).id;
    });

    test('un chantier ne se crée ni ne se supprime directement', async () => {
      const creation = await request(app).post('/api/chantiers').set('Authorization', `Bearer ${session}`)
        .send({ nom: 'TEST direct', client: 'TEST', dateDebut: '2026-09-01' });
      assert.equal(creation.status, 410, 'la création directe reste fermée');

      const devis = await devisAccepte('TEST Affaire supprimable');
      const chantier = await convertir(devis.id);
      assert.equal(chantier.status, 201, JSON.stringify(chantier.body));
      const suppression = await request(app).delete(`/api/chantiers/${chantier.body.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppression.status, 410, 'la suppression d’un chantier n’existe plus');
      assert.ok(await prisma.chantier.findUnique({ where: { id: chantier.body.id } }), 'le chantier est toujours là');
    });

    test('l’acompte exigé retient l’ouverture du chantier jusqu’à sa constatation', async () => {
      const devis = await devisAccepte('TEST Affaire avec acompte', { acompteExige: true });
      assert.equal(devis.acompteExige, true);
      assert.equal(devis.tauxAcompte, 30, 'le taux par défaut du paramétrage est figé sur le devis');

      const trop_tot = await convertir(devis.id);
      assert.equal(trop_tot.status, 400, 'pas de chantier tant que l’acompte n’est pas là');

      const attente = await request(app).put(`/api/devis/${devis.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'EN_ATTENTE_ACOMPTE' });
      assert.equal(attente.status, 200);
      assert.equal(attente.body.statut, 'EN_ATTENTE_ACOMPTE');

      for (const corps of [{}, { recuLe: 'hier', montant: 60, reference: 'VIR-1' }, { recuLe: '01-09-2026', montant: -60, reference: 'VIR-1' }, { recuLe: '01-09-2026', montant: 60, reference: '  ' }]) {
        const refus = await request(app).post(`/api/devis/${devis.id}/acompte`).set('Authorization', `Bearer ${session}`).send(corps);
        assert.equal(refus.status, 400, `constatation acceptée à tort : ${JSON.stringify(corps)}`);
      }

      const acompte = await request(app).post(`/api/devis/${devis.id}/acompte`).set('Authorization', `Bearer ${session}`)
        .send({ recuLe: '01-09-2026', montant: 72, reference: 'VIR-2026-09' });
      assert.equal(acompte.status, 200, JSON.stringify(acompte.body));
      assert.equal(acompte.body.statut, 'ACCEPTE', 'la constatation remet le devis en état d’être converti');
      assert.equal(acompte.body.acompteMontant, 72);

      const ouvert = await convertir(devis.id);
      assert.equal(ouvert.status, 201, JSON.stringify(ouvert.body));

      const rejoue = await request(app).post(`/api/devis/${devis.id}/acompte`).set('Authorization', `Bearer ${session}`)
        .send({ recuLe: '02-09-2026', montant: 10, reference: 'VIR-DOUBLON' });
      assert.equal(rejoue.status, 400, 'un acompte ne se constate pas deux fois');
    });

    test('changer le taux par défaut ne réécrit aucun devis déjà émis', async () => {
      const avant = await devisAccepte('TEST Affaire taux figé', { acompteExige: true });
      assert.equal(avant.tauxAcompte, 30);
      const maj = await request(app).put('/api/parametres').set('Authorization', `Bearer ${session}`)
        .send({ margeCommercialeActive: true, tauxAcompteDefaut: 50 });
      assert.equal(maj.status, 200);
      assert.equal(maj.body.tauxAcompteDefaut, 50);

      const apres = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'TEST Affaire taux neuf', acompteExige: true,
        lignes: [{ designation: 'Pose', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }],
      });
      assert.equal(apres.body.tauxAcompte, 50, 'un devis neuf suit la politique du jour');
      const inchange = await prisma.devis.findUnique({ where: { id: avant.id } });
      assert.equal(Number(inchange.tauxAcompte), 30, 'le devis déjà émis garde son taux');

      const hors_bornes = await request(app).put('/api/parametres').set('Authorization', `Bearer ${session}`)
        .send({ margeCommercialeActive: true, tauxAcompteDefaut: 140 });
      assert.equal(hors_bornes.status, 400);
      await request(app).put('/api/parametres').set('Authorization', `Bearer ${session}`).send({ margeCommercialeActive: true, tauxAcompteDefaut: 30 });
    });

    test('une affaire commencée ne s’annule pas', async () => {
      const devis = await devisAccepte('TEST Affaire commencée');
      const chantier = (await convertir(devis.id)).body;
      const auteur = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' } });
      await prisma.pointageHeure.create({ data: { date: new Date(), nbrHeures: 3, tauxHoraireApplique: 40, chantierId: chantier.id, intervenantId, createdById: auteur.id, updatedById: auteur.id } });

      const refus = await request(app).post(`/api/devis/${devis.id}/annulation`).set('Authorization', `Bearer ${session}`).send({ motif: 'erreur de saisie' });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.match(refus.body.error, /pointage/);
      assert.equal((await prisma.devis.findUnique({ where: { id: devis.id } })).statut, 'ACCEPTE', 'le devis n’a pas bougé');
      assert.equal((await prisma.chantier.findUnique({ where: { id: chantier.id } })).statut, 'EN_COURS');
    });

    test('un achat suffit lui aussi à verrouiller l’annulation', async () => {
      const devis = await devisAccepte('TEST Affaire approvisionnée');
      const chantier = (await convertir(devis.id)).body;
      const auteur = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' } });
      await prisma.achatReel.create({ data: { date: new Date(), description: 'TEST matériel', montantHT: 500, chantierId: chantier.id, categorieId, fournisseurId, createdById: auteur.id, updatedById: auteur.id } });

      const refus = await request(app).post(`/api/devis/${devis.id}/annulation`).set('Authorization', `Bearer ${session}`).send({ motif: 'client renonce' });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.match(refus.body.error, /achat/);
    });

    test('annuler un devis archive son chantier et conserve le motif', async () => {
      const devis = await devisAccepte('TEST Affaire annulable');
      const chantier = (await convertir(devis.id)).body;

      const sansMotif = await request(app).post(`/api/devis/${devis.id}/annulation`).set('Authorization', `Bearer ${session}`).send({});
      assert.equal(sansMotif.status, 400, 'le motif est obligatoire');

      const annulation = await request(app).post(`/api/devis/${devis.id}/annulation`).set('Authorization', `Bearer ${session}`)
        .send({ motif: 'affaire ouverte sur le mauvais client' });
      assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
      assert.equal(annulation.body.devis.statut, 'ANNULE');
      assert.equal(annulation.body.chantierArchive, chantier.id);

      const archive = await prisma.chantier.findUnique({ where: { id: chantier.id } });
      assert.equal(archive.statut, 'ANNULE');
      assert.equal(archive.motifAnnulation, 'affaire ouverte sur le mauvais client');
      assert.ok(archive.annuleParId, 'l’auteur de l’annulation est conservé');

      // L'affaire sort des listes et des statistiques, mais reste consultable.
      const liste = await request(app).get('/api/chantiers').set('Authorization', `Bearer ${session}`);
      assert.equal(liste.body.some((c) => c.id === chantier.id), false, 'une affaire annulée quitte la liste');
      const fiche = await request(app).get(`/api/chantiers/${chantier.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(fiche.status, 200, 'la fiche reste lisible pour comprendre l’annulation');
      assert.equal(fiche.body.motifAnnulation, 'affaire ouverte sur le mauvais client');

      // Plus rien ne s'écrit dessus, et le devis est figé.
      const saisie = await request(app).post('/api/achats').set('Authorization', `Bearer ${session}`)
        .send({ chantierId: chantier.id, categorieId, fournisseurId, date: '01-09-2026', description: 'TEST tardif', montantHT: 10 });
      assert.equal(saisie.status, 409, JSON.stringify(saisie.body));
      const reconversion = await convertir(devis.id);
      assert.equal(reconversion.status, 400, 'un devis annulé n’ouvre plus de chantier');
      const doubleAnnulation = await request(app).post(`/api/devis/${devis.id}/annulation`).set('Authorization', `Bearer ${session}`).send({ motif: 'encore' });
      assert.equal(doubleAnnulation.status, 400, 'on n’annule pas une annulation');

      // La reprise passe par une duplication : même contenu, numéro neuf, brouillon.
      const duplicata = await request(app).post(`/api/devis/${devis.id}/duplication`).set('Authorization', `Bearer ${session}`);
      assert.equal(duplicata.status, 201, JSON.stringify(duplicata.body));
      assert.equal(duplicata.body.statut, 'BROUILLON');
      assert.equal(duplicata.body.version, 1);
      assert.equal(duplicata.body.objet, 'TEST Affaire annulable');
      assert.equal(duplicata.body.totalTtc, 240);
      assert.equal(duplicata.body.lignes.length, 1);
      assert.notEqual(duplicata.body.numero, devis.numero, 'le duplicata a son propre numéro d’affaire');
      assert.notEqual(duplicata.body.dossierId, devis.dossierId);
      assert.equal(duplicata.body.origineDevisId, devis.id, 'le lien vers l’origine est conservé');
    });

    test('le journal de saisie expose les valeurs avant/après sur le chantier autorisé', async () => {
      const devis = await devisAccepte('TEST Affaire journal Travaux');
      const chantier = (await convertir(devis.id)).body;
      const achat = await request(app).post('/api/achats').set('Authorization', `Bearer ${session}`)
        .send({ chantierId: chantier.id, categorieId, fournisseurId, date: '01-09-2026', description: 'TEST achat journal', montantHT: 500 });
      assert.equal(achat.status, 200, JSON.stringify(achat.body));
      const correction = await request(app).patch(`/api/achats/${achat.body.id}`).set('Authorization', `Bearer ${session}`)
        .send({ montantHT: 50, motifCorrection: 'Montant initial incorrect' });
      assert.equal(correction.status, 200, JSON.stringify(correction.body));

      const journal = await request(app).get(`/api/chantiers/${chantier.id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      assert.equal(journal.body.length, 2);
      const correctionJournal = journal.body.find((entree) => entree.action === 'CORRECTION');
      assert.equal(correctionJournal.avant.montantHT, 500);
      assert.equal(correctionJournal.apres.montantHT, 50);
      assert.equal(correctionJournal.motif, 'Montant initial incorrect');
      assert.equal(correctionJournal.auteurNom, 'Secours');
    });

    test('seul un administrateur annule un devis ou constate un acompte', async () => {
      const jwt = (await import('jsonwebtoken')).default;
      const conducteur = await prisma.user.upsert({
        where: { email: 'cycle.conducteur@iris.test' },
        update: { role: 'CONDUCTEUR_TRAVAUX', actif: true, permissions: ['devis:read', 'devis:write', 'clients:read'] },
        create: { email: 'cycle.conducteur@iris.test', name: 'TEST Conducteur cycle', role: 'CONDUCTEUR_TRAVAUX', permissions: ['devis:read', 'devis:write', 'clients:read'] },
      });
      const sessionConducteur = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const devis = await devisAccepte('TEST Affaire droits', { acompteExige: true });

      const annulation = await request(app).post(`/api/devis/${devis.id}/annulation`).set('Authorization', `Bearer ${sessionConducteur}`).send({ motif: 'essai' });
      assert.equal(annulation.status, 403);
      const acompte = await request(app).post(`/api/devis/${devis.id}/acompte`).set('Authorization', `Bearer ${sessionConducteur}`)
        .send({ recuLe: '01-09-2026', montant: 10, reference: 'X' });
      assert.equal(acompte.status, 403);
      // La duplication, elle, relève du droit devis et non de l'administration.
      const duplicata = await request(app).post(`/api/devis/${devis.id}/duplication`).set('Authorization', `Bearer ${sessionConducteur}`);
      assert.equal(duplicata.status, 201, JSON.stringify(duplicata.body));
    });
  });

  describe('Interventions SAV', () => {
    let session = '';
    let clientId = '';
    const compteTechnicienSav = async (email, nom) => {
      const compte = await prisma.user.create({ data: { email, name: nom, role: 'TECHNICIEN' } });
      const intervenant = await prisma.intervenant.create({ data: { nom, role: 'Technicien', tauxHoraireCharge: 42, userId: compte.id } });
      return { jeton: jwt.sign({ id: compte.id }, process.env.JWT_SECRET), intervenantId: intervenant.id };
    };
    const voitLeDossier = async (jeton, interventionId) => {
      const liste = await request(app).get('/api/interventions').set('Authorization', `Bearer ${jeton}`);
      assert.equal(liste.status, 200, JSON.stringify(liste.body));
      return liste.body.some((item) => item.id === interventionId);
    };

    before(async () => {
      session = (await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN })).body.token;
      clientId = (await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`)
        .send({ raisonSociale: 'TEST Client intervention' })).body.id;
    });

    test('ne laisse pas un technicien non affecté modifier un dossier invisible', async () => {
      const technicien = await compteTechnicienSav('sav.non-affecte@iris.test', 'TEST Intervenant SAV non affecté');
      const creation = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`).send({ clientId, titre: 'TEST Dossier privé SAV' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      assert.equal(await voitLeDossier(technicien.jeton, creation.body.id), false);
      const mutation = await request(app).patch(`/api/interventions/${creation.body.id}/statut`).set('Authorization', `Bearer ${technicien.jeton}`).send({ statut: 'PLANIFIEE' });
      assert.equal(mutation.status, 404, JSON.stringify(mutation.body));
    });

    test('journalise de façon immuable chaque changement de statut SAV', async () => {
      const creation = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, titre: 'TEST Journal SAV' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const transition = await request(app).patch(`/api/interventions/${creation.body.id}/statut`).set('Authorization', `Bearer ${session}`)
        .send({ statut: 'PLANIFIEE' });
      assert.equal(transition.status, 200, JSON.stringify(transition.body));

      const journal = await request(app).get(`/api/interventions/${creation.body.id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      assert.equal(journal.body.some((entree) => entree.action === 'CREATION' && entree.apres?.reference === creation.body.reference), true);
      const changement = journal.body.find((entree) => entree.action === 'CHANGEMENT_STATUT');
      assert.equal(changement.avant.statut, 'A_PLANIFIER');
      assert.equal(changement.apres.statut, 'PLANIFIEE');
      // Les deux instantanés sont contractuels et doivent rester comparables : une forme
      // différente ferait lire une transition comme un ajout de données au dossier.
      assert.deepEqual(Object.keys(changement.avant).sort(), Object.keys(changement.apres).sort());
      assert.equal(changement.auteurId, creation.body.createdById);
    });

    test('la base impose un unique parent pour chaque trace de journal', async () => {
      const auteur = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' } });
      await assert.rejects(() => prisma.journalSaisieChantier.create({ data: {
        chantierId: null, interventionId: null, cible: 'INTERVENTION', cibleId: 'TEST-parent-absent', action: 'CREATION', auteurId: auteur.id, auteurNom: 'TEST',
      } }));
      await assert.rejects(() => prisma.journalSaisieChantier.create({ data: {
        chantierId: 'TEST-chantier-inexistant', interventionId: 'TEST-intervention-inexistante', cible: 'INTERVENTION', cibleId: 'TEST-double-parent', action: 'CREATION', auteurId: auteur.id, auteurNom: 'TEST',
      } }));
    });

    test('ferme le journal d’un dossier à un technicien non affecté', async () => {
      const technicien = await compteTechnicienSav('sav.journal@iris.test', 'TEST Intervenant SAV journal');
      const dossier = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, titre: 'TEST Dossier journal fermé', description: 'Détail confidentiel.' });
      assert.equal(dossier.status, 201, JSON.stringify(dossier.body));
      assert.equal(await voitLeDossier(technicien.jeton, dossier.body.id), false);
      // Le journal porte l'instantané complet d'un dossier : il ne doit jamais révéler les
      // données d'une intervention que le technicien ne peut pas voir dans sa liste.
      const journal = await request(app).get(`/api/interventions/${dossier.body.id}/journal-saisies`).set('Authorization', `Bearer ${technicien.jeton}`);
      assert.equal(journal.status, 404, JSON.stringify(journal.body));
    });

    test('rattache un site et un contact appartenant au client du dossier SAV', async () => {
      const site = await prisma.clientSite.create({ data: { clientId, nom: 'TEST Site SAV', adresse: '1 rue du Test', codePostal: '75001', ville: 'Paris' } });
      const contact = await prisma.clientContact.create({ data: { clientId, nom: 'TEST Contact SAV' } });
      const creation = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, siteId: site.id, contactId: contact.id, titre: 'TEST Rattachements SAV' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      assert.equal(creation.body.site.id, site.id);
      assert.equal(creation.body.contact.id, contact.id);
    });

    test('refuse un site ou contact rattaché à un autre client', async () => {
      const autreClient = await prisma.client.create({ data: { raisonSociale: 'TEST Client étranger SAV', actif: true } });
      const siteEtranger = await prisma.clientSite.create({ data: { clientId: autreClient.id, nom: 'TEST Site étranger', adresse: '2 rue du Test', codePostal: '69001', ville: 'Lyon' } });
      const creation = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, siteId: siteEtranger.id, titre: 'TEST Cloisonnement client SAV' });
      assert.equal(creation.status, 404, JSON.stringify(creation.body));
    });

    test('rattache un chantier appartenant au même client que le dossier SAV', async () => {
      const client = await prisma.client.findUnique({ where: { id: clientId }, select: { raisonSociale: true } });
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Chantier SAV lié', client: client.raisonSociale, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      const creation = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, chantierId: chantier.id, titre: 'TEST Intervention liée à affaire' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      assert.equal(creation.body.chantier.id, chantier.id);
    });

    test('refuse un chantier d’un autre client', async () => {
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Chantier SAV étranger', client: 'TEST Autre client SAV', dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      const creation = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, chantierId: chantier.id, titre: 'TEST Cloisonnement affaire SAV' });
      assert.equal(creation.status, 404, JSON.stringify(creation.body));
    });

    test('permet au technicien affecté de consigner un compte rendu terrain', async () => {
      const technicien = await compteTechnicienSav('sav.rapport@iris.test', 'TEST Intervenant SAV rapport');
      const dossier = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, titre: 'TEST Rapport terrain SAV' });
      assert.equal(dossier.status, 201, JSON.stringify(dossier.body));
      await prisma.interventionAffectation.create({ data: { interventionId: dossier.body.id, intervenantId: technicien.intervenantId } });
      await request(app).patch(`/api/interventions/${dossier.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'PLANIFIEE' });
      await request(app).patch(`/api/interventions/${dossier.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'EN_COURS' });
      const rapport = await request(app).post(`/api/interventions/${dossier.body.id}/rapports`).set('Authorization', `Bearer ${technicien.jeton}`)
        .send({ contenu: 'TEST Intervention réalisée : détecteur repositionné et essai concluant.' });
      assert.equal(rapport.status, 201, JSON.stringify(rapport.body));
      assert.equal(rapport.body.auteurId, undefined); // l’API n’expose pas l’identifiant interne de l’auteur
      assert.equal(rapport.body.contenu, 'TEST Intervention réalisée : détecteur repositionné et essai concluant.');
      const intrus = await compteTechnicienSav('sav.intrus@iris.test', 'TEST Intervenant SAV intrus');
      assert.equal(await voitLeDossier(intrus.jeton, dossier.body.id), false);
      assert.equal((await request(app).post(`/api/interventions/${dossier.body.id}/rapports`).set('Authorization', `Bearer ${intrus.jeton}`).send({ contenu: 'TEST Rapport hors périmètre.' })).status, 404);
      assert.equal((await request(app).post(`/api/interventions/rapports/${rapport.body.id}/signature`).set('Authorization', `Bearer ${intrus.jeton}`).send({ signataire: 'TEST Usurpation', confirme: true })).status, 404);
      // La signature demeure possible après clôture : le client peut signer après le départ du technicien.
      assert.equal((await request(app).patch(`/api/interventions/${dossier.body.id}/statut`).set('Authorization', `Bearer ${technicien.jeton}`).send({ statut: 'TERMINEE' })).status, 200);
      const signature = await request(app).post(`/api/interventions/rapports/${rapport.body.id}/signature`).set('Authorization', `Bearer ${technicien.jeton}`)
        .send({ signataire: 'TEST Client signataire', confirme: true });
      assert.equal(signature.status, 201, JSON.stringify(signature.body));
      assert.match(signature.body.empreinte, /^[a-f0-9]{64}$/);
      assert.equal((await request(app).post(`/api/interventions/rapports/${rapport.body.id}/signature`).set('Authorization', `Bearer ${technicien.jeton}`).send({ signataire: 'TEST Client signataire', confirme: true })).status, 409);
      const liste = await request(app).get('/api/interventions').set('Authorization', `Bearer ${technicien.jeton}`);
      const relu = liste.body.find((item) => item.id === dossier.body.id);
      assert.equal(relu.rapports.length, 1);
      assert.equal(relu.rapports[0].contenu, rapport.body.contenu);
      assert.equal(relu.rapports[0].signature.signataire, 'TEST Client signataire');
    });

    test('applique le périmètre hiérarchique aux interventions rattachées à une affaire', async () => {
      const conducteur = await prisma.user.create({ data: { email: 'sav.conducteur@iris.test', name: 'TEST Conducteur SAV', role: 'CONDUCTEUR_TRAVAUX' } });
      const responsable = await prisma.user.create({ data: { email: 'sav.responsable@iris.test', name: 'TEST Responsable SAV', role: 'RESPONSABLE' } });
      await prisma.user.update({ where: { id: conducteur.id }, data: { responsableHierarchiqueId: responsable.id } });
      const client = await prisma.client.findUnique({ where: { id: clientId }, select: { raisonSociale: true } });
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Chantier périmètre SAV', client: client.raisonSociale, dateDebut: new Date(), budgetGlobalVendu: 1000, responsableId: conducteur.id } });
      const dossier = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, chantierId: chantier.id, titre: 'TEST Intervention périmètre équipe' });
      assert.equal(dossier.status, 201, JSON.stringify(dossier.body));
      const sessionConducteur = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const sessionResponsable = jwt.sign({ id: responsable.id }, process.env.JWT_SECRET);
      assert.equal(await voitLeDossier(sessionConducteur, dossier.body.id), true);
      assert.equal(await voitLeDossier(sessionResponsable, dossier.body.id), true);
      const tiers = await prisma.user.create({ data: { email: 'sav.tiers@iris.test', name: 'TEST Conducteur SAV tiers', role: 'CONDUCTEUR_TRAVAUX' } });
      assert.equal(await voitLeDossier(jwt.sign({ id: tiers.id }, process.env.JWT_SECRET), dossier.body.id), false);
    });

    test('la projection planning ouvre et referme l’accès au dossier SAV', async () => {
      const jour = new Date().toISOString().slice(0, 10);
      const dossier = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`).send({ clientId, titre: 'TEST Dossier planifié SAV' });
      assert.equal(dossier.status, 201, JSON.stringify(dossier.body));
      const premier = await compteTechnicienSav('sav.premier@iris.test', 'TEST Intervenant SAV premier');
      const second = await compteTechnicienSav('sav.second@iris.test', 'TEST Intervenant SAV second');
      const planification = await request(app).put(`/api/interventions/${dossier.body.id}/planning`).set('Authorization', `Bearer ${session}`).send({ dateDebut: jour, creneau: 'JOURNEE', intervenantIds: [premier.intervenantId] });
      assert.equal(planification.status, 200, JSON.stringify(planification.body));
      assert.equal(await voitLeDossier(premier.jeton, dossier.body.id), true);
      assert.equal(await voitLeDossier(second.jeton, dossier.body.id), false);
      const remplacement = await request(app).patch(`/api/planning/events/${planification.body.id}`).set('Authorization', `Bearer ${session}`).send({ intervenantIds: [second.intervenantId] });
      assert.equal(remplacement.status, 200, JSON.stringify(remplacement.body));
      assert.equal(await voitLeDossier(premier.jeton, dossier.body.id), false);
      assert.equal(await voitLeDossier(second.jeton, dossier.body.id), true);
      const suppression = await request(app).delete(`/api/planning/events/${planification.body.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppression.status, 409, JSON.stringify(suppression.body));
      assert.equal(await voitLeDossier(second.jeton, dossier.body.id), true);
      const suppressionIntervenant = await request(app).delete(`/api/intervenants/${second.intervenantId}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppressionIntervenant.status, 409, JSON.stringify(suppressionIntervenant.body));
    });

    test('liste les interventions sans exposer les dossiers annulés par défaut', async () => {
      const active = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, titre: 'TEST Liste active' });
      const cancelled = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, titre: 'TEST Liste annulée' });
      await request(app).patch(`/api/interventions/${cancelled.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ANNULEE' });

      const liste = await request(app).get('/api/interventions').set('Authorization', `Bearer ${session}`);
      assert.equal(liste.status, 200, JSON.stringify(liste.body));
      assert.equal(liste.body.some((item) => item.id === active.body.id), true);
      assert.equal(liste.body.some((item) => item.id === cancelled.body.id), false);
    });

    test('bloque les transitions de statut incohérentes', async () => {
      const creation = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`).send({
        clientId, titre: 'TEST Transition SAV', priorite: 'NORMALE',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));

      const planification = await request(app).patch(`/api/interventions/${creation.body.id}/statut`).set('Authorization', `Bearer ${session}`)
        .send({ statut: 'PLANIFIEE' });
      assert.equal(planification.status, 200, JSON.stringify(planification.body));
      assert.equal(planification.body.statut, 'PLANIFIEE');

      const annulation = await request(app).patch(`/api/interventions/${creation.body.id}/statut`).set('Authorization', `Bearer ${session}`)
        .send({ statut: 'ANNULEE' });
      assert.equal(annulation.status, 200, JSON.stringify(annulation.body));

      const reprise = await request(app).patch(`/api/interventions/${creation.body.id}/statut`).set('Authorization', `Bearer ${session}`)
        .send({ statut: 'EN_COURS' });
      assert.equal(reprise.status, 409, JSON.stringify(reprise.body));
    });

    test('crée une intervention SAV avec une référence annuelle stable', async () => {
      const creation = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`).send({
        clientId, titre: 'TEST Alarme déclenchée', description: 'Le client signale un déclenchement intempestif.', priorite: 'HAUTE', dateDemande: '06-09-2026', dateSouhaitee: '06-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      assert.match(creation.body.reference, /^I\d{2}-\d{4,}$/);
      assert.equal(creation.body.statut, 'A_PLANIFIER');
      assert.equal(creation.body.priorite, 'HAUTE');
      assert.equal(creation.body.client.id, clientId);
    });

    test('permet au technicien affecté de saisir ses heures sur une intervention de contrat', async () => {
      const technicien = await compteTechnicienSav('sav.cout.heures@iris.test', 'TEST Technicien coût SAV');
      const contrat = await prisma.contratMaintenance.create({ data: {
        clientId, titre: 'TEST Contrat coûts SAV', periodiciteMois: 12, dureePrevisionnelleMinutes: 60,
        dateDebut: new Date('2026-01-01T00:00:00.000Z'), prochaineEcheance: new Date('2026-12-01T00:00:00.000Z'),
      } });
      const intervention = await prisma.intervention.create({ data: {
        reference: `I26-COUT-${Date.now()}`, clientId, contratMaintenanceId: contrat.id, dateDemande: contrat.prochaineEcheance,
        titre: 'TEST Intervention contrat sans chantier',
      } });
      await prisma.interventionAffectation.create({ data: { interventionId: intervention.id, intervenantId: technicien.intervenantId } });

      const saisie = await request(app).post(`/api/interventions/${intervention.id}/couts/heures`)
        .set('Authorization', `Bearer ${technicien.jeton}`)
        .send({ date: '06-09-2026', nbrHeures: 1.5 });

      assert.equal(saisie.status, 201, JSON.stringify(saisie.body));
      assert.equal(saisie.body.intervenantId, undefined, 'la réponse technicien ne doit exposer aucun rattachement ni taux financier');
      assert.equal(saisie.body.tauxHoraireApplique, undefined, 'le taux horaire direction ne doit jamais être exposé au technicien');
      assert.equal(saisie.body.interventionId, undefined);
    });

    test('réserve les coûts à un technicien et fige son taux à la saisie', async () => {
      const technicien = await compteTechnicienSav('sav.cout.garde.taux@iris.test', 'TEST Garde taux technicien');
      const responsable = await prisma.user.create({ data: { email: 'sav.cout.garde.responsable@iris.test', name: 'TEST Garde taux responsable', role: 'RESPONSABLE' } });
      const intervenantResponsable = await prisma.intervenant.create({ data: { nom: 'TEST Garde taux intervenant responsable', role: 'Responsable', tauxHoraireCharge: 42, userId: responsable.id } });
      const jetonResponsable = jwt.sign({ id: responsable.id }, process.env.JWT_SECRET);
      const contrat = await prisma.contratMaintenance.create({ data: {
        clientId, titre: 'TEST Contrat garde taux', statut: 'ACTIF', periodiciteMois: 12, dureePrevisionnelleMinutes: 60,
        dateDebut: new Date('2026-01-01T00:00:00.000Z'), prochaineEcheance: new Date('2026-12-01T00:00:00.000Z'),
      } });
      const intervention = await prisma.intervention.create({ data: {
        reference: `I26-GARDE-TAUX-${Date.now()}`, clientId, contratMaintenanceId: contrat.id, dateDemande: contrat.prochaineEcheance, titre: 'TEST Intervention garde taux',
      } });
      await prisma.interventionAffectation.createMany({ data: [
        { interventionId: intervention.id, intervenantId: technicien.intervenantId },
        { interventionId: intervention.id, intervenantId: intervenantResponsable.id },
      ] });

      const lectureResponsable = await request(app).get(`/api/interventions/${intervention.id}/couts`)
        .set('Authorization', `Bearer ${jetonResponsable}`);
      assert.equal(lectureResponsable.status, 403, JSON.stringify(lectureResponsable.body));
      assert.equal(lectureResponsable.body.error, 'Accès non autorisé.');

      const saisie = await request(app).post(`/api/interventions/${intervention.id}/couts/heures`)
        .set('Authorization', `Bearer ${technicien.jeton}`).send({ date: '06-09-2026', nbrHeures: 2 });
      assert.equal(saisie.status, 201, JSON.stringify(saisie.body));

      await prisma.intervenant.update({ where: { id: technicien.intervenantId }, data: { tauxHoraireCharge: 99 } });
      const lectureEncadrement = await request(app).get(`/api/interventions/${intervention.id}/couts`)
        .set('Authorization', `Bearer ${session}`);
      assert.equal(lectureEncadrement.status, 200, JSON.stringify(lectureEncadrement.body));
      assert.equal(lectureEncadrement.body.heures.length, 1);
      assert.equal(lectureEncadrement.body.heures[0].tauxHoraireApplique, 42);
      assert.equal(lectureEncadrement.body.totalMainOeuvreHT, 84);
    });

    test('témoin des gardes des coûts SAV', async () => {
      const technicien = await compteTechnicienSav('sav.cout.garde.technicien@iris.test', 'TEST Garde coûts technicien');
      const collegue = await compteTechnicienSav('sav.cout.garde.collegue@iris.test', 'TEST Garde coûts collègue');
      const conducteur = await prisma.user.create({ data: { email: 'sav.cout.garde.conducteur@iris.test', name: 'TEST Garde coûts conducteur', role: 'CONDUCTEUR_TRAVAUX' } });
      const commercial = await prisma.user.create({ data: { email: 'sav.cout.garde.commercial@iris.test', name: 'TEST Garde coûts commercial', role: 'COMMERCIAL' } });
      const jetonConducteur = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const jetonCommercial = jwt.sign({ id: commercial.id }, process.env.JWT_SECRET);
      const contrat = await prisma.contratMaintenance.create({ data: { clientId, titre: 'TEST Contrat gardes coûts', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: new Date('2026-01-01'), prochaineEcheance: new Date('2026-12-01') } });
      const intervention = await prisma.intervention.create({ data: { reference: `I26-GARDES-${Date.now()}`, clientId, contratMaintenanceId: contrat.id, dateDemande: contrat.prochaineEcheance, titre: 'TEST Intervention gardes coûts' } });
      const sansContrat = await prisma.intervention.create({ data: { reference: `I26-SANS-CONTRAT-${Date.now()}`, clientId, titre: 'TEST Intervention sans contrat' } });
      const fournisseur = await prisma.fournisseur.create({ data: { nom: `TEST Fournisseur gardes ${Date.now()}` } });
      await prisma.interventionAffectation.createMany({ data: [{ interventionId: intervention.id, intervenantId: technicien.intervenantId }, { interventionId: intervention.id, intervenantId: collegue.intervenantId }] });
      const heure = await prisma.coutInterventionHeure.create({ data: { interventionId: intervention.id, intervenantId: technicien.intervenantId, date: new Date('2026-09-06'), nbrHeures: 1, tauxHoraireApplique: 42, createdById: (await prisma.user.findUniqueOrThrow({ where: { email: 'sav.cout.garde.technicien@iris.test' } })).id } });
      const achat = await prisma.coutInterventionAchat.create({ data: { interventionId: intervention.id, fournisseurId: fournisseur.id, date: new Date('2026-09-06'), description: 'TEST Achat garde', montantHT: 1, createdById: conducteur.id } });
      await prisma.interventionAffectation.create({ data: { interventionId: intervention.id, intervenantId: (await prisma.intervenant.create({ data: { nom: 'TEST Garde commercial', role: 'Commercial', tauxHoraireCharge: 0, userId: commercial.id } })).id } });

      assert.equal((await request(app).get(`/api/interventions/${intervention.id}/couts`).set('Authorization', `Bearer ${jetonCommercial}`)).status, 403, 'un rôle affecté non autorisé ne lit pas les coûts');
      assert.equal((await request(app).get(`/api/interventions/${sansContrat.id}/couts`).set('Authorization', `Bearer ${session}`)).status, 409, 'sans contrat, la lecture des coûts est refusée');
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/heures`).set('Authorization', `Bearer ${session}`).send({ date: '06-09-2026', nbrHeures: 1 })).status, 403, 'l’encadrement ne saisit pas les heures');
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/heures`).set('Authorization', `Bearer ${technicien.jeton}`).send({ date: '06-09-2026', nbrHeures: 0 })).status, 400, 'zéro heure exige un motif');
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/achats`).set('Authorization', `Bearer ${technicien.jeton}`).send({ date: '06-09-2026', fournisseurId: fournisseur.id, description: 'TEST', montantHT: 1 })).status, 403, 'un technicien ne saisit pas un achat');
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/achats`).set('Authorization', `Bearer ${session}`).send({ date: '06-09-2026', fournisseurId: fournisseur.id, description: 'TEST', montantHT: 0 })).status, 400, 'zéro achat exige un motif');
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/achats`).set('Authorization', `Bearer ${session}`).send({ date: '06-09-2026', fournisseurId: fournisseur.id, montantHT: 1 })).status, 400, 'un achat exige une description');
      assert.equal((await request(app).patch(`/api/interventions/${intervention.id}/couts/heures/${heure.id}`).set('Authorization', `Bearer ${session}`).send({ commentaire: 'TEST', motifCorrection: 'Motif correction' })).status, 403, 'le mauvais rôle ne corrige pas les heures');
      assert.equal((await request(app).patch(`/api/interventions/${intervention.id}/couts/heures/${heure.id}`).set('Authorization', `Bearer ${collegue.jeton}`).send({ commentaire: 'TEST', motifCorrection: 'Motif correction' })).status, 404, 'un technicien ne corrige pas l’heure du collègue');
      assert.equal((await request(app).patch(`/api/interventions/${intervention.id}/couts/heures/${heure.id}`).set('Authorization', `Bearer ${technicien.jeton}`).send({ commentaire: 'TEST' })).status, 400, 'une correction exige un motif');
      const sansChamp = await request(app).patch(`/api/interventions/${intervention.id}/couts/heures/${heure.id}`).set('Authorization', `Bearer ${technicien.jeton}`).send({ motifCorrection: 'Motif sans modification' });
      assert.equal(sansChamp.status, 400); assert.equal(sansChamp.body.error, 'Aucun champ à corriger.');
      const achatSansChamp = await request(app).patch(`/api/interventions/${intervention.id}/couts/achats/${achat.id}`).set('Authorization', `Bearer ${session}`).send({ motifCorrection: 'Motif sans modification' });
      assert.equal(achatSansChamp.status, 400); assert.equal(achatSansChamp.body.error, 'Aucun champ à corriger.');
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/achats/${achat.id}/archiver`).set('Authorization', `Bearer ${technicien.jeton}`).send({ motif: 'Archivage interdit' })).status, 403, 'un technicien n’archive pas');
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/achats/${achat.id}/archiver`).set('Authorization', `Bearer ${session}`).send({})).status, 400, 'un archivage exige un motif');
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/achats/${achat.id}/archiver`).set('Authorization', `Bearer ${session}`).send({ motif: 'Archivage justifié' })).status, 200);
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/achats/${achat.id}/archiver`).set('Authorization', `Bearer ${session}`).send({ motif: 'Double archivage' })).status, 409);
      assert.equal((await request(app).post(`/api/interventions/${sansContrat.id}/couts/heures/${heure.id}/archiver`).set('Authorization', `Bearer ${session}`).send({ motif: 'Hors contrat' })).status, 409);
      assert.equal((await request(app).get(`/api/interventions/${intervention.id}/journal-saisies`).set('Authorization', `Bearer ${technicien.jeton}`)).status, 403, 'le journal financier reste fermé au technicien');
      assert.equal((await request(app).post('/api/interventions').set('Authorization', `Bearer ${technicien.jeton}`).send({ clientId, titre: 'TEST Création technicien refusée' })).status, 403, 'la création est réservée à l’encadrement');
      const creationConducteur = await request(app).post('/api/interventions').set('Authorization', `Bearer ${jetonConducteur}`).send({ clientId, titre: 'TEST Création conducteur visible' });
      assert.equal(creationConducteur.status, 201, JSON.stringify(creationConducteur.body));
      assert.equal((await request(app).get('/api/interventions').set('Authorization', `Bearer ${jetonConducteur}`)).body.some((item) => item.id === creationConducteur.body.id), true, 'le conducteur voit l’intervention qu’il a créée');
      const suppressionIntervenant = await request(app).delete(`/api/intervenants/${technicien.intervenantId}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppressionIntervenant.status, 409); assert.match(suppressionIntervenant.body.error, /coût\(s\) d'heures SAV/);
    });

    test('protège la confidentialité technicien, restitue l’historique encadrant et arrondit chaque ligne au centime', async () => {
      const premier = await compteTechnicienSav('sav.cout.second@iris.test', 'TEST Technicien coût second');
      const second = await compteTechnicienSav('sav.cout.confidentiel@iris.test', 'TEST Technicien coût confidentiel');
      const contrat = await prisma.contratMaintenance.create({ data: {
        clientId, titre: 'TEST Contrat confidentialité coûts', periodiciteMois: 12, dureePrevisionnelleMinutes: 60,
        dateDebut: new Date('2026-01-01T00:00:00.000Z'), prochaineEcheance: new Date('2026-12-01T00:00:00.000Z'),
      } });
      const intervention = await prisma.intervention.create({ data: {
        reference: `I26-COUT-PRIVE-${Date.now()}`, clientId, contratMaintenanceId: contrat.id, dateDemande: contrat.prochaineEcheance, titre: 'TEST Intervention coûts privés',
      } });
      const fournisseur = await prisma.fournisseur.create({ data: { nom: `TEST Fournisseur coûts ${Date.now()}` } });
      await prisma.interventionAffectation.createMany({ data: [
        { interventionId: intervention.id, intervenantId: premier.intervenantId },
        { interventionId: intervention.id, intervenantId: second.intervenantId },
      ] });
      const heurePremier = await prisma.coutInterventionHeure.create({ data: { interventionId: intervention.id, intervenantId: premier.intervenantId, date: new Date('2026-09-06'), nbrHeures: 1.11, tauxHoraireApplique: 42.42, createdById: (await prisma.user.findUniqueOrThrow({ where: { email: 'sav.cout.second@iris.test' } })).id } });
      await prisma.coutInterventionHeure.create({ data: { interventionId: intervention.id, intervenantId: second.intervenantId, date: new Date('2026-09-06'), nbrHeures: 2.22, tauxHoraireApplique: 42.42, createdById: (await prisma.user.findUniqueOrThrow({ where: { email: 'sav.cout.confidentiel@iris.test' } })).id } });
      await prisma.coutInterventionAchat.create({ data: { interventionId: intervention.id, fournisseurId: fournisseur.id, date: new Date('2026-09-06'), description: 'TEST matériel confidentiel', montantHT: 10.01, createdById: (await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' } })).id } });

      const lectureTechnicien = await request(app).get(`/api/interventions/${intervention.id}/couts`).set('Authorization', `Bearer ${premier.jeton}`);
      assert.equal(lectureTechnicien.status, 200, JSON.stringify(lectureTechnicien.body));
      assert.deepEqual(Object.keys(lectureTechnicien.body).sort(), ['heures']);
      assert.equal(lectureTechnicien.body.heures.length, 1);
      assert.deepEqual(Object.keys(lectureTechnicien.body.heures[0]).sort(), ['commentaire', 'createdAt', 'date', 'id', 'nbrHeures']);
      assert.equal(lectureTechnicien.body.heures[0].nbrHeures, 1.11);
      assert.equal('tauxHoraireApplique' in lectureTechnicien.body.heures[0], false);
      assert.equal('intervenantId' in lectureTechnicien.body.heures[0], false);
      assert.equal('totalMainOeuvreHT' in lectureTechnicien.body, false);
      assert.equal('achats' in lectureTechnicien.body, false);
      assert.equal('totalMaterielHT' in lectureTechnicien.body, false);
      assert.equal('totalCoutsHT' in lectureTechnicien.body, false);

      const lectureEncadrement = await request(app).get(`/api/interventions/${intervention.id}/couts`).set('Authorization', `Bearer ${session}`);
      assert.equal(lectureEncadrement.status, 200, JSON.stringify(lectureEncadrement.body));
      assert.equal(lectureEncadrement.body.totalMainOeuvreHT, 141.26, '1,11 × 42,42 = 47,09 et 2,22 × 42,42 = 94,17, arrondis par ligne');
      assert.equal(lectureEncadrement.body.totalMaterielHT, 10.01);
      assert.equal(lectureEncadrement.body.totalCoutsHT, 151.27);

      const correctionZero = await request(app).patch(`/api/interventions/${intervention.id}/couts/heures/${heurePremier.id}`)
        .set('Authorization', `Bearer ${premier.jeton}`).send({ nbrHeures: 0, motifCorrection: 'Erreur de pointage initial' });
      assert.equal(correctionZero.status, 200, JSON.stringify(correctionZero.body));
      assert.equal(correctionZero.body.nbrHeures, 0, 'motifCorrection seul autorise la correction vers zéro');
      assert.equal('tauxHoraireApplique' in correctionZero.body, false, 'une correction technicien ne révèle jamais le taux appliqué');
      assert.equal('intervenantId' in correctionZero.body, false);
      assert.equal((await request(app).get(`/api/interventions/${intervention.id}/journal-saisies`).set('Authorization', `Bearer ${premier.jeton}`)).status, 403, 'le journal contient des instantanés financiers et reste fermé au technicien');
      const trace = await prisma.journalSaisieChantier.findFirstOrThrow({ where: { cibleId: heurePremier.id, action: 'CORRECTION' }, orderBy: { createdAt: 'desc' } });
      assert.equal(trace.motif, 'Erreur de pointage initial');

      const [heuresAvantRefus, achatsAvantRefus, journalAvantRefus] = await Promise.all([
        prisma.coutInterventionHeure.count({ where: { interventionId: intervention.id } }),
        prisma.coutInterventionAchat.count({ where: { interventionId: intervention.id } }),
        prisma.journalSaisieChantier.count({ where: { interventionId: intervention.id } }),
      ]);
      await prisma.contratMaintenance.update({ where: { id: contrat.id }, data: { statut: 'SUSPENDU' } });
      const ajoutRefuse = await request(app).post(`/api/interventions/${intervention.id}/couts/heures`).set('Authorization', `Bearer ${premier.jeton}`).send({ date: '06-09-2026', nbrHeures: 1 });
      assert.equal(ajoutRefuse.status, 409, JSON.stringify(ajoutRefuse.body));
      const achatRefuse = await request(app).post(`/api/interventions/${intervention.id}/couts/achats`).set('Authorization', `Bearer ${session}`).send({ date: '06-09-2026', description: 'Achat refusé après suspension', montantHT: 12, fournisseurId: fournisseur.id });
      assert.equal(achatRefuse.status, 409, JSON.stringify(achatRefuse.body));
      assert.equal(await prisma.coutInterventionHeure.count({ where: { interventionId: intervention.id } }), heuresAvantRefus, 'le refus ne crée aucune heure');
      assert.equal(await prisma.coutInterventionAchat.count({ where: { interventionId: intervention.id } }), achatsAvantRefus, 'le refus ne crée aucun achat');
      assert.equal(await prisma.journalSaisieChantier.count({ where: { interventionId: intervention.id } }), journalAvantRefus, 'le refus ne journalise aucune trace');
      assert.equal((await request(app).get(`/api/interventions/${intervention.id}/couts`).set('Authorization', `Bearer ${premier.jeton}`)).status, 409, 'hors état saisissable, le technicien ne reçoit plus de surface d’écriture');

      const archivageSuspendu = await request(app).post(`/api/interventions/${intervention.id}/couts/heures/${heurePremier.id}/archiver`).set('Authorization', `Bearer ${session}`).send({ motif: 'Archivage après suspension' });
      assert.equal(archivageSuspendu.status, 200, JSON.stringify(archivageSuspendu.body));
      const historiqueSuspendu = await request(app).get(`/api/interventions/${intervention.id}/couts`).set('Authorization', `Bearer ${session}`);
      assert.equal(historiqueSuspendu.status, 200, JSON.stringify(historiqueSuspendu.body));
      assert.equal(historiqueSuspendu.body.heures.find((heure) => heure.id === heurePremier.id)?.archivedAt !== null, true);
      const restaurationSuspendue = await request(app).post(`/api/interventions/${intervention.id}/couts/heures/${heurePremier.id}/restaurer`).set('Authorization', `Bearer ${session}`).send({ motif: 'Restauration après suspension' });
      assert.equal(restaurationSuspendue.status, 200, JSON.stringify(restaurationSuspendue.body));

      await prisma.contratMaintenance.update({ where: { id: contrat.id }, data: { statut: 'TERMINE' } });
      await prisma.intervention.update({ where: { id: intervention.id }, data: { statut: 'ANNULEE' } });
      const historiqueCloture = await request(app).get(`/api/interventions/${intervention.id}/couts`).set('Authorization', `Bearer ${session}`);
      assert.equal(historiqueCloture.status, 200, JSON.stringify(historiqueCloture.body));
      const archivageCloture = await request(app).post(`/api/interventions/${intervention.id}/couts/heures/${heurePremier.id}/archiver`).set('Authorization', `Bearer ${session}`).send({ motif: 'Archivage après clôture' });
      assert.equal(archivageCloture.status, 200, JSON.stringify(archivageCloture.body));
      const restaurationCloture = await request(app).post(`/api/interventions/${intervention.id}/couts/heures/${heurePremier.id}/restaurer`).set('Authorization', `Bearer ${session}`).send({ motif: 'Restauration après clôture' });
      assert.equal(restaurationCloture.status, 200, JSON.stringify(restaurationCloture.body));

      const suppressionFournisseur = await request(app).delete(`/api/fournisseurs/${fournisseur.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppressionFournisseur.status, 409, JSON.stringify(suppressionFournisseur.body));
      const suppressionCreateur = await request(app).delete(`/${'api/users'}/${(await prisma.user.findUniqueOrThrow({ where: { email: 'sav.cout.second@iris.test' } })).id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppressionCreateur.status, 409, JSON.stringify(suppressionCreateur.body));
    });
  });

  describe('Contrats de maintenance cyclique', () => {
    test('date demandée curative : saisie française stricte, défaut civil et refus futur', async () => {
      const token = (await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN })).body.token;
      const client = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`).send({ raisonSociale: 'TEST Client date demande' });
      assert.equal(client.status, 201, JSON.stringify(client.body));
      const creer = (data) => request(app).post('/api/interventions').set('Authorization', `Bearer ${token}`).send({ clientId: client.body.id, titre: 'TEST Demande client', ...data });
      for (const dateDemande of ['2026-01-01', '2026-01-01T00:00:00Z', '31-02-2026', '01/01/2026', '01-01-9999']) {
        const refuse = await creer({ dateDemande });
        assert.equal(refuse.status, 400, `${dateDemande}: ${JSON.stringify(refuse.body)}`);
      }
      const explicite = await creer({ dateDemande: '02-01-2026' });
      assert.equal(explicite.status, 201, JSON.stringify(explicite.body));
      assert.equal(explicite.body.dateDemande, '2026-01-02T00:00:00.000Z');
      const implicite = await creer({});
      assert.equal(implicite.status, 201, JSON.stringify(implicite.body));
      assert.equal(implicite.body.dateDemande?.slice(0, 10), jourCivilEntreprise(new Date(), (await prisma.companySettings.findUnique({ where: { id: 'singleton' } }))?.fuseauHoraire || 'Europe/Paris'));
    });

    test('date souhaitée curative : jamais avant la demande explicite ou le jour civil implicite', async () => {
      const token = (await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN })).body.token;
      const client = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`).send({ raisonSociale: 'TEST Client cohérence dates' });
      assert.equal(client.status, 201, JSON.stringify(client.body));
      const creer = (data) => request(app).post('/api/interventions').set('Authorization', `Bearer ${token}`).send({ clientId: client.body.id, titre: 'TEST Cohérence planning', ...data });
      const refuse = await creer({ dateDemande: '10-01-2026', dateSouhaitee: '09-01-2026' });
      assert.equal(refuse.status, 400, JSON.stringify(refuse.body));
      assert.match(refuse.body.error, /date souhaitée.*date de demande/i);
      const fuseau = (await prisma.companySettings.findUnique({ where: { id: 'singleton' } }))?.fuseauHoraire || 'Europe/Paris';
      const aujourdHui = jourCivilEntreprise(new Date(), fuseau);
      const hier = new Date(`${aujourdHui}T00:00:00.000Z`);
      hier.setUTCDate(hier.getUTCDate() - 1);
      const dateHier = `${String(hier.getUTCDate()).padStart(2, '0')}-${String(hier.getUTCMonth() + 1).padStart(2, '0')}-${hier.getUTCFullYear()}`;
      const impliciteRefuse = await creer({ dateSouhaitee: dateHier });
      assert.equal(impliciteRefuse.status, 400, JSON.stringify(impliciteRefuse.body));
      assert.match(impliciteRefuse.body.error, /date souhaitée.*date de demande/i);
      const egale = await creer({ dateDemande: '10-01-2026', dateSouhaitee: '10-01-2026' });
      assert.equal(egale.status, 201, JSON.stringify(egale.body));
      const sansSouhait = await creer({ dateDemande: '10-01-2026' });
      assert.equal(sansSouhait.status, 201, JSON.stringify(sansSouhait.body));
      assert.equal(sansSouhait.body.dateSouhaitee, null);
    });

    test('date demandée contractuelle : échéance future, bornes et gel SQL', async () => {
      const token = (await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN })).body.token;
      const client = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`).send({ raisonSociale: 'TEST Client date effet' });
      assert.equal(client.status, 201, JSON.stringify(client.body));
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${token}`).send({ clientId: client.body.id, titre: 'TEST Contrat date effet', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-01-2099' });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const intervention = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set('Authorization', `Bearer ${token}`);
      assert.equal(intervention.status, 201, JSON.stringify(intervention.body));
      assert.equal(intervention.body.dateDemande, contrat.body.prochaineEcheance);
      await assert.rejects(prisma.$executeRaw`UPDATE "Intervention" SET "dateDemande" = '2099-01-02' WHERE "id" = ${intervention.body.id}`);
      await assert.rejects(prisma.$executeRaw`UPDATE "Intervention" SET "dateDemande" = NULL WHERE "id" = ${intervention.body.id}`);
      await assert.rejects(prisma.$executeRaw`UPDATE "ContratMaintenance" SET "dateDebut" = '2100-01-01' WHERE "id" = ${contrat.body.id}`);
      await assert.rejects(prisma.$executeRaw`INSERT INTO "Intervention" ("id", "reference", "clientId", "titre", "contratMaintenanceId", "updatedAt") VALUES ('test-date-effet-sans-date', 'TEST-I-SANS-DATE', ${client.body.id}, 'TEST sans date', ${contrat.body.id}, now())`);
      await assert.rejects(prisma.$executeRaw`INSERT INTO "Intervention" ("id", "reference", "clientId", "titre", "contratMaintenanceId", "dateDemande", "echeanceContrat", "updatedAt") VALUES ('test-date-effet-avant', 'TEST-I-AVANT-EFFET', ${client.body.id}, 'TEST avant', ${contrat.body.id}, '2098-12-31', '2099-01-01', now())`);
      const libre = await prisma.intervention.create({ data: { reference: `TEST-I-LIBRE-${Date.now()}`, clientId: client.body.id, titre: 'TEST à rattacher', dateDemande: new Date('2026-01-01') } });
      await assert.rejects(prisma.$executeRaw`UPDATE "Intervention" SET "contratMaintenanceId" = ${contrat.body.id} WHERE "id" = ${libre.id}`);
      assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id: libre.id } })).contratMaintenanceId, null);
    });
    let session = '';
    let clientId = '';
    let siteId = '';
    let contratId = '';

    before(async () => {
      session = (await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN })).body.token;
      const client = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`)
        .send({ raisonSociale: 'TEST Client contrat maintenance' });
      assert.equal(client.status, 201, JSON.stringify(client.body));
      clientId = client.body.id;
      const site = await request(app).post(`/api/clients/${clientId}/sites`).set('Authorization', `Bearer ${session}`)
        .send({ nom: 'TEST Site maintenance', adresse: '1 rue des Tests', codePostal: '75001', ville: 'Paris', estSiteIntervention: true });
      assert.equal(site.status, 201, JSON.stringify(site.body));
      siteId = site.body.id;
    });

    test('crée un contrat actif rattaché à son client et son site', async () => {
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST Maintenance incendie', periodiciteMois: 6, dureePrevisionnelleMinutes: 120, dateDebut: '08-09-2026',
      });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      contratId = contrat.body.id;
      assert.equal(contrat.body.statut, 'ACTIF');
      assert.equal(contrat.body.client.id, clientId);
      assert.equal(contrat.body.site.id, siteId);
      assert.equal(contrat.body.periodiciteMois, 6);
      assert.equal(contrat.body.dureePrevisionnelleMinutes, 120);
    });

    test('enregistre une politique de couverture bornée avec les deux postes explicites', async () => {
      const note = 'Couverture préventive, hors pièces d’usure.';
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST Contrat couverture création', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '09-09-2026',
        politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'HORS_FORFAIT', noteCouverture: note,
      });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      assert.deepEqual({
        politiqueMainOeuvre: contrat.body.politiqueMainOeuvre,
        politiqueMateriel: contrat.body.politiqueMateriel,
        noteCouverture: contrat.body.noteCouverture,
      }, {
        politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'HORS_FORFAIT', noteCouverture: note,
      });
      const journalCreation = await request(app).get(`/api/contrats-maintenance/${contrat.body.id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journalCreation.status, 200, JSON.stringify(journalCreation.body));
      assert.equal(journalCreation.body.length, 1);
      assert.equal(journalCreation.body[0].action, 'CREATION');
      assert.equal(journalCreation.body[0].avant, null, 'la création stocke explicitement un état antérieur NULL');
      assert.equal(journalCreation.body[0].apres.id, contrat.body.id);

      for (const corps of [
        { politiqueMainOeuvre: 'FORFAIT_TOTAL' },
        { politiqueMateriel: 'OPTIONNEL' },
        { noteCouverture: 'x'.repeat(1001) },
      ]) {
        const refus = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
          clientId, siteId, titre: 'TEST Contrat couverture invalide', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '09-09-2026',
          politiqueMainOeuvre: 'HORS_FORFAIT', politiqueMateriel: 'INCLUS', ...corps,
        });
        assert.equal(refus.status, 400, `${JSON.stringify(corps)} → ${JSON.stringify(refus.body)}`);
      }
    });

    test('réserve la modification de couverture à l’administration et ne crée ni devis ni facture', async () => {
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST Contrat couverture modifiable', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '10-09-2026',
        politiqueMainOeuvre: 'HORS_FORFAIT', politiqueMateriel: 'INCLUS',
      });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const conducteur = await prisma.user.create({ data: { email: 'contrat.couverture.technicien@iris.test', name: 'TEST Technicien couverture', role: 'TECHNICIEN' } });
      const jetonTechnicien = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const factureAvant = await prisma.facture.count({ where: { contratMaintenanceId: contrat.body.id } });
      const devisAvant = await prisma.devis.count({ where: { clientId } });
      const politique = { politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'HORS_FORFAIT', noteCouverture: 'Déplacement inclus, consommables hors forfait.', motif: 'Renégociation annuelle de la couverture' };

      const refus = await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}`).set('Authorization', `Bearer ${jetonTechnicien}`).send(politique);
      assert.equal(refus.status, 403, JSON.stringify(refus.body));
      for (const corps of [{}, { titre: 'Modification hors politique' }]) {
        const sansPolitique = await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}`).set('Authorization', `Bearer ${session}`).send(corps);
        assert.equal(sansPolitique.status, 400, 'une requête sans champ de couverture est refusée');
      }
      const tracesAvantModification = await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: contrat.body.id } });
      assert.equal(tracesAvantModification, 1, 'aucun refus ne crée de journal');
      const miseAJour = await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}`).set('Authorization', `Bearer ${session}`).send(politique);
      assert.equal(miseAJour.status, 200, JSON.stringify(miseAJour.body));
      assert.deepEqual(Object.fromEntries(Object.keys(politique).filter((cle) => cle !== 'motif').map((cle) => [cle, miseAJour.body[cle]])), {
        politiqueMainOeuvre: politique.politiqueMainOeuvre, politiqueMateriel: politique.politiqueMateriel, noteCouverture: politique.noteCouverture,
      });
      const journal = await request(app).get(`/api/contrats-maintenance/${contrat.body.id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      const modification = journal.body.find((entree) => entree.action === 'MODIFICATION_COUVERTURE');
      assert.equal(modification.motif, politique.motif);
      assert.deepEqual(Object.fromEntries(Object.keys(politique).filter((cle) => cle !== 'motif').map((cle) => [cle, modification.avant[cle]])), {
        politiqueMainOeuvre: 'HORS_FORFAIT', politiqueMateriel: 'INCLUS', noteCouverture: null,
      });
      assert.deepEqual(Object.fromEntries(Object.keys(politique).filter((cle) => cle !== 'motif').map((cle) => [cle, modification.apres[cle]])), {
        politiqueMainOeuvre: politique.politiqueMainOeuvre, politiqueMateriel: politique.politiqueMateriel, noteCouverture: politique.noteCouverture,
      });
      const tracesAvantRefus = journal.body.length;
      assert.equal(await prisma.facture.count({ where: { contratMaintenanceId: contrat.body.id } }), factureAvant, 'la politique ne crée aucune facture');
      assert.equal(await prisma.devis.count({ where: { clientId } }), devisAvant, 'la politique ne crée aucun devis');

      const cloture = await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'TERMINE', motif: 'Fin du contrat de test' });
      assert.equal(cloture.status, 200, JSON.stringify(cloture.body));
      const mutationApresCloture = await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}`).set('Authorization', `Bearer ${session}`).send({ noteCouverture: 'Tentative interdite', motif: 'Contrat déjà clos' });
      assert.equal(mutationApresCloture.status, 409, JSON.stringify(mutationApresCloture.body));
      const journalApresRefus = await request(app).get(`/api/contrats-maintenance/${contrat.body.id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journalApresRefus.body.length, tracesAvantRefus + 1, 'seule la clôture autorisée est tracée ; le refus ne crée aucune trace');
      const generationApresCloture = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(generationApresCloture.status, 404, JSON.stringify(generationApresCloture.body));
    });

    test('refuse les motifs invalides de couverture sans modifier le contrat ni son journal', async () => {
      const creation = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, titre: 'TEST Motifs couverture', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '10-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const id = creation.body.id;
      for (const motif of [undefined, null, 123, '', '  ab  ', 'x'.repeat(501), '🔧'.repeat(501), 'Avant\naprès', 'Avant\taprès', 'Avant\u007faprès', 'Avant\u0085après', 'Avant\u200baprès', 'Avant\u202eaprès']) {
        const refus = await request(app).patch(`/api/contrats-maintenance/${id}`).set('Authorization', `Bearer ${session}`)
          .send({ politiqueMainOeuvre: 'INCLUSE', ...(motif === undefined ? {} : { motif }) });
        assert.equal(refus.status, 400, `${JSON.stringify(motif)} → ${JSON.stringify(refus.body)}`);
      }
      const journal = await request(app).get(`/api/contrats-maintenance/${id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.body.length, 1);
      assert.equal((await prisma.contratMaintenance.findUniqueOrThrow({ where: { id } })).politiqueMainOeuvre, creation.body.politiqueMainOeuvre);
      const accepte = await request(app).patch(`/api/contrats-maintenance/${id}`).set('Authorization', `Bearer ${session}`)
        .send({ politiqueMainOeuvre: 'INCLUSE', motif: '  🔧évolution  ' });
      assert.equal(accepte.status, 200, JSON.stringify(accepte.body));
      const trace = await request(app).get(`/api/contrats-maintenance/${id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(trace.body[0].motif, '🔧évolution');
      const borneUnicode = await request(app).patch(`/api/contrats-maintenance/${id}`).set('Authorization', `Bearer ${session}`)
        .send({ politiqueMateriel: 'INCLUS', motif: '🔧'.repeat(500) });
      assert.equal(borneUnicode.status, 200, JSON.stringify(borneUnicode.body));
    });

    test('refuse la version périmée après une modification concurrente sans écraser ni journaliser', async () => {
      const creation = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, titre: 'TEST Concurrence couverture', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '10-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const url = `/api/contrats-maintenance/${creation.body.id}`;
      const version = creation.body.updatedAt;
      const premier = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ politiqueMainOeuvre: 'INCLUSE', motif: 'Premier changement', expectedUpdatedAt: version });
      assert.equal(premier.status, 200, JSON.stringify(premier.body));
      assert.notEqual(premier.body.updatedAt, version);
      const perime = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ politiqueMateriel: 'INCLUS', motif: 'Éditeur périmé', expectedUpdatedAt: version });
      assert.equal(perime.status, 409, JSON.stringify(perime.body));
      assert.match(perime.body.error, /actualis|modifi|périm/i);
      const relu = await prisma.contratMaintenance.findUniqueOrThrow({ where: { id: creation.body.id } });
      assert.equal(relu.politiqueMainOeuvre, 'INCLUSE');
      assert.equal(relu.politiqueMateriel, 'HORS_FORFAIT');
      assert.equal(await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: creation.body.id } }), 2);
    });

    test('refuse la couverture inchangée et suspendue, puis autorise la modification après réactivation motivée', async () => {
      const creation = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, titre: 'TEST Contrat suspendu couverture', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '10-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const id = creation.body.id;
      const couverture = `/api/contrats-maintenance/${id}`;
      const statut = `${couverture}/statut`;
      const inchangée = await request(app).patch(couverture).set('Authorization', `Bearer ${session}`)
        .send({ politiqueMainOeuvre: creation.body.politiqueMainOeuvre, noteCouverture: '  ', motif: 'Contrôle sans changement' });
      assert.equal(inchangée.status, 409, JSON.stringify(inchangée.body));
      const suspension = await request(app).patch(statut).set('Authorization', `Bearer ${session}`).send({ statut: 'SUSPENDU', motif: 'Pause contractuelle' });
      assert.equal(suspension.status, 200, JSON.stringify(suspension.body));
      const refus = await request(app).patch(couverture).set('Authorization', `Bearer ${session}`)
        .send({ politiqueMainOeuvre: 'INCLUSE', motif: 'Changement durant la pause' });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.match(refus.body.error, /réactiv/i);
      assert.equal((await prisma.contratMaintenance.findUniqueOrThrow({ where: { id } })).politiqueMainOeuvre, creation.body.politiqueMainOeuvre);
      const avant = await request(app).get(`${couverture}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.deepEqual(avant.body.map((entree) => entree.action).sort(), ['CREATION', 'SUSPENSION']);
      const reactivation = await request(app).patch(statut).set('Authorization', `Bearer ${session}`).send({ statut: 'ACTIF', motif: 'Reprise du service' });
      assert.equal(reactivation.status, 200, JSON.stringify(reactivation.body));
      const modification = await request(app).patch(couverture).set('Authorization', `Bearer ${session}`)
        .send({ politiqueMainOeuvre: 'INCLUSE', motif: 'Nouvelle couverture applicable' });
      assert.equal(modification.status, 200, JSON.stringify(modification.body));
      const journal = await request(app).get(`${couverture}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.body.find((entree) => entree.action === 'REACTIVATION')?.motif, 'Reprise du service');
      assert.equal(journal.body.find((entree) => entree.action === 'MODIFICATION_COUVERTURE')?.motif, 'Nouvelle couverture applicable');
      assert.equal(journal.body.length, 4, 'aucun refus ne crée de trace');
    });

    test('impose le même motif borné sans contrôles à chaque transition de statut', async () => {
      const creation = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, titre: 'TEST Motifs statut', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '10-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const id = creation.body.id;
      const url = `/api/contrats-maintenance/${id}/statut`;
      const refuser = async (cible) => {
        for (const motif of [undefined, null, '', ' ab ', 'x'.repeat(501), '🔧'.repeat(501), 'Avant\naprès', 'Avant\u0000après', 'Avant\u007faprès', 'Avant\u0085après', 'Avant\u200baprès', 'Avant\u202eaprès']) {
          const refus = await request(app).patch(url).set('Authorization', `Bearer ${session}`)
            .send({ statut: cible, ...(motif === undefined ? {} : { motif }) });
          assert.equal(refus.status, 400, `${cible} ${JSON.stringify(motif)} → ${JSON.stringify(refus.body)}`);
        }
      };
      await refuser('SUSPENDU');
      const suspension = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ statut: 'SUSPENDU', motif: '  Pause demandée  ' });
      assert.equal(suspension.status, 200, JSON.stringify(suspension.body));
      await refuser('ACTIF');
      const reactivation = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ statut: 'ACTIF', motif: '🔧évolution' });
      assert.equal(reactivation.status, 200, JSON.stringify(reactivation.body));
      await refuser('TERMINE');
      const cloture = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ statut: 'TERMINE', motif: 'x'.repeat(500) });
      assert.equal(cloture.status, 200, JSON.stringify(cloture.body));
      const journal = await request(app).get(`/api/contrats-maintenance/${id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.body.length, 4);
      assert.equal(journal.body.find((entree) => entree.action === 'SUSPENSION')?.motif, 'Pause demandée');
      assert.equal(journal.body.find((entree) => entree.action === 'REACTIVATION')?.motif, '🔧évolution');
      assert.equal(journal.body.find((entree) => entree.action === 'CLOTURE')?.motif, 'x'.repeat(500));
    });

    test('CHECK SQL : motif NULL interdit pour une transition CONTRAT, permis pour CREATION', async () => {
      const creation = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, titre: 'TEST Contrainte motif journal', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '10-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const original = await prisma.journalSaisieChantier.findFirstOrThrow({ where: { contratMaintenanceId: creation.body.id } });
      assert.equal(original.action, 'CREATION');
      assert.equal(original.motif, null, 'la création historique reste compatible');
      for (const action of ['SUSPENSION', 'AVANCEMENT_ECHEANCE', 'MODIFICATION_COUVERTURE']) {
        await assert.rejects(() => prisma.$executeRawUnsafe(
          'INSERT INTO "JournalSaisieChantier" ("id", "contratMaintenanceId", "cible", "cibleId", "action", "auteurId", "auteurNom", "motif") VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NULL)',
          creation.body.id, 'CONTRAT', creation.body.id, action, original.auteurId, original.auteurNom,
        ), `motif NULL interdit pour ${action}`);
      }
      const creationDirecte = await prisma.$executeRawUnsafe(
        'INSERT INTO "JournalSaisieChantier" ("id", "contratMaintenanceId", "cible", "cibleId", "action", "auteurId", "auteurNom", "motif") VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NULL)',
        creation.body.id, 'CONTRAT', creation.body.id, 'CREATION', original.auteurId, original.auteurNom,
      );
      assert.equal(creationDirecte, 1);
      assert.equal(await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: creation.body.id } }), 2);
      const intervention = await prisma.intervention.create({ data: {
        clientId, reference: `TEST-MOTIF-SAV-${Date.now()}`, titre: 'TEST Motif SAV distinct',
      } });
      assert.equal(await prisma.$executeRawUnsafe(
        'INSERT INTO "JournalSaisieChantier" ("id", "interventionId", "cible", "cibleId", "action", "auteurId", "auteurNom", "motif") VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NULL)',
        intervention.id, 'INTERVENTION', intervention.id, 'CHANGEMENT_STATUT', original.auteurId, original.auteurNom,
      ), 1, 'une cible non-contrat reste hors du CHECK');
    });

    test('avancement : succès journalisé avec référence et échéances, refus sans nouvelle trace', async () => {
      const creation = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST Journal échéance', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '10-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const id = creation.body.id;
      const url = `/api/contrats-maintenance/${id}/avancer-echeance`;
      const generation = await request(app).post(`/api/contrats-maintenance/${id}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(generation.status, 201, JSON.stringify(generation.body));
      const journalAvant = await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: id } });
      assert.equal((await request(app).post(url).set('Authorization', `Bearer ${session}`)).status, 409);
      assert.equal(await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: id } }), journalAvant);
      for (const statut of ['PLANIFIEE', 'EN_COURS', 'TERMINEE']) {
        const transition = await request(app).patch(`/api/interventions/${generation.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut });
        assert.equal(transition.status, 200, JSON.stringify(transition.body));
      }
      const avance = await request(app).post(url).set('Authorization', `Bearer ${session}`);
      assert.equal(avance.status, 200, JSON.stringify(avance.body));
      const traces = await prisma.journalSaisieChantier.findMany({ where: { contratMaintenanceId: id, action: 'AVANCEMENT_ECHEANCE' } });
      assert.equal(traces.length, 1);
      const trace = traces[0];
      assert.equal(trace.cible, 'CONTRAT');
      assert.equal(trace.cibleId, id);
      assert.equal(trace.auteurNom, (await prisma.user.findUniqueOrThrow({ where: { id: trace.auteurId } })).name);
      assert.match(trace.motif, new RegExp(generation.body.reference));
      assert.equal(trace.avant.prochaineEcheance, creation.body.prochaineEcheance);
      assert.equal(trace.apres.prochaineEcheance, avance.body.prochaineEcheance);
      assert.equal((await request(app).post(url).set('Authorization', `Bearer ${session}`)).status, 409);
      assert.equal(await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: id } }), journalAvant + 1);
    });

    test('échec de journalisation : l’avancement est annulé atomiquement', async () => {
      const creation = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, titre: 'TEST Atomicité journal échéance', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '10-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const id = creation.body.id;
      const intervention = await prisma.intervention.create({ data: {
        clientId, contratMaintenanceId: id, echeanceContrat: new Date(creation.body.prochaineEcheance), dateDemande: new Date(creation.body.prochaineEcheance),
        reference: `TEST-ATOMICITE-${Date.now()}`, titre: 'TEST Intervention terminée', statut: 'TERMINEE',
      } });
      const avant = await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: id } });
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "test_refuser_avancement_journal"()
        RETURNS TRIGGER AS $$ BEGIN
          IF NEW."action" = 'AVANCEMENT_ECHEANCE' AND NEW."cibleId" = '${id}' THEN
            RAISE EXCEPTION 'journal refusé pour le test';
          END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql;`);
      await prisma.$executeRawUnsafe('CREATE TRIGGER "test_refuser_avancement_journal" BEFORE INSERT ON "JournalSaisieChantier" FOR EACH ROW EXECUTE FUNCTION "test_refuser_avancement_journal"()');
      try {
        const refus = await request(app).post(`/api/contrats-maintenance/${id}/avancer-echeance`).set('Authorization', `Bearer ${session}`);
        assert.equal(refus.status, 500, JSON.stringify(refus.body));
        assert.equal((await prisma.contratMaintenance.findUniqueOrThrow({ where: { id } })).prochaineEcheance.toISOString(), creation.body.prochaineEcheance);
        assert.equal(await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: id } }), avant);
        assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id: intervention.id } })).statut, 'TERMINEE');
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "test_refuser_avancement_journal" ON "JournalSaisieChantier"');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS "test_refuser_avancement_journal"()');
      }
    });

    test('fige la couverture dans l’intervention générée et la rend lisible au technicien affecté', async () => {
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST Contrat instantané couverture', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '11-09-2026',
        politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'HORS_FORFAIT', noteCouverture: 'Main-d’œuvre incluse, matériel refacturable.',
      });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const generation = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(generation.status, 201, JSON.stringify(generation.body));
      assert.deepEqual(generation.body.couvertureContrat, {
        politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'HORS_FORFAIT', noteCouverture: 'Main-d’œuvre incluse, matériel refacturable.',
      });

      const technicien = await prisma.user.create({ data: { email: 'contrat.couverture.lecteur@iris.test', name: 'TEST Technicien lecteur couverture', role: 'TECHNICIEN' } });
      const intervenant = await prisma.intervenant.create({ data: { userId: technicien.id, nom: 'TEST Intervenant couverture', role: 'TECHNICIEN', tauxHoraireCharge: 42 } });
      await prisma.interventionAffectation.create({ data: { interventionId: generation.body.id, intervenantId: intervenant.id } });
      const jetonTechnicien = jwt.sign({ id: technicien.id }, process.env.JWT_SECRET);
      const lectureTechnicien = await request(app).get('/api/interventions').set('Authorization', `Bearer ${jetonTechnicien}`);
      assert.equal(lectureTechnicien.status, 200, JSON.stringify(lectureTechnicien.body));
      const interventionTechnicien = lectureTechnicien.body.find((intervention) => intervention.id === generation.body.id);
      assert.deepEqual(interventionTechnicien?.couvertureContrat, generation.body.couvertureContrat);

      const mutation = await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}`).set('Authorization', `Bearer ${session}`).send({
        politiqueMainOeuvre: 'HORS_FORFAIT', politiqueMateriel: 'INCLUS', noteCouverture: 'Nouvelle politique pour les prochaines échéances.', motif: 'Evolution pour les prochaines échéances',
      });
      assert.equal(mutation.status, 200, JSON.stringify(mutation.body));
      const relue = await request(app).get('/api/interventions').set('Authorization', `Bearer ${session}`);
      assert.equal(relue.status, 200, JSON.stringify(relue.body));
      const interventionRelue = relue.body.find((intervention) => intervention.id === generation.body.id);
      assert.deepEqual(interventionRelue?.couvertureContrat, generation.body.couvertureContrat, 'une modification ultérieure du contrat ne réécrit pas l’instantané pour l’encadrement autorisé');
    });

    test('la base refuse toute donnée commerciale ou note structurée dans un instantané de couverture', async () => {
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST Contrat contrainte JSON', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '12-09-2026',
        politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'INCLUS',
      });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const generation = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(generation.status, 201, JSON.stringify(generation.body));

      for (const [index, couvertureInvalide] of [
        { politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'INCLUS', montant: 1 },
        { politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'INCLUS', noteCouverture: { texte: 'pas une chaîne' } },
      ].entries()) {
        await assert.rejects(() => prisma.$executeRawUnsafe(
          'INSERT INTO "Intervention" ("id", "reference", "clientId", "contratMaintenanceId", "titre", "couvertureContrat", "createdAt", "updatedAt") VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5::jsonb, now(), now())',
          `TEST-CONTRAINTE-COUVERTURE-${Date.now()}-${index}`, clientId, contrat.body.id, 'TEST Instantané SQL invalide', JSON.stringify(couvertureInvalide),
        ), `PostgreSQL doit refuser ${JSON.stringify(couvertureInvalide)}`);
      }
      await assert.rejects(() => prisma.$executeRawUnsafe(
        'INSERT INTO "Intervention" ("id", "reference", "clientId", "titre", "couvertureContrat", "createdAt", "updatedAt") VALUES (gen_random_uuid()::text, $1, $2, $3, $4::jsonb, now(), now())',
        `TEST-CONTRAINTE-COUVERTURE-SANS-CONTRAT-${Date.now()}`, clientId, 'TEST Instantané SQL sans contrat', JSON.stringify({ politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'INCLUS' }),
      ), 'PostgreSQL doit refuser une couverture sans contrat de maintenance');
    });

    test('la base interdit toute réécriture Prisma de l’instantané de couverture', async () => {
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST Contrat snapshot immuable', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '13-09-2026',
        politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'HORS_FORFAIT',
      });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const generation = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(generation.status, 201, JSON.stringify(generation.body));
      await assert.rejects(() => prisma.$executeRawUnsafe(
        'UPDATE "Intervention" SET "couvertureContrat" = $1::jsonb WHERE "id" = $2',
        JSON.stringify({ politiqueMainOeuvre: 'HORS_FORFAIT', politiqueMateriel: 'INCLUS' }), generation.body.id,
      ), 'l’instantané ne doit pas être réécrivable par SQL direct');
      await assert.rejects(() => prisma.intervention.update({
        where: { id: generation.body.id },
        data: { couvertureContrat: { politiqueMainOeuvre: 'HORS_FORFAIT', politiqueMateriel: 'INCLUS' } },
      }), 'l’instantané ne doit être modifiable ni via Prisma ni par SQL direct');
    });

    test('réserve toutes les routes contrat à l’administration et ferme les contournements', async () => {
      const conducteur = await prisma.user.create({ data: { email: 'contrat.conducteur@iris.test', name: 'TEST Conducteur contrat', role: 'CONDUCTEUR_TRAVAUX' } });
      const sessionConducteur = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const routesProtegees = [
        request(app).get('/api/contrats-maintenance'),
        request(app).post('/api/contrats-maintenance').send({ clientId, titre: 'TEST Contrat interdit', periodiciteMois: 6, dureePrevisionnelleMinutes: 120, dateDebut: '08-09-2026' }),
        request(app).patch(`/api/contrats-maintenance/${contratId}/statut`).send({ statut: 'SUSPENDU' }),
        request(app).post(`/api/contrats-maintenance/${contratId}/generer-intervention`),
        request(app).post(`/api/contrats-maintenance/${contratId}/avancer-echeance`),
      ];
      for (const route of routesProtegees) assert.equal((await route.set('Authorization', `Bearer ${sessionConducteur}`)).status, 403);

      const autreClient = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST Client contrat étranger' });
      const siteEtranger = await request(app).post(`/api/clients/${autreClient.body.id}/sites`).set('Authorization', `Bearer ${session}`)
        .send({ nom: 'TEST Site étranger contrat', adresse: '2 rue du Test', codePostal: '69001', ville: 'Lyon' });
      const refusSite = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`)
        .send({ clientId, siteId: siteEtranger.body.id, titre: 'TEST Contrat site étranger', periodiciteMois: 6, dureePrevisionnelleMinutes: 120, dateDebut: '08-09-2026' });
      assert.equal(refusSite.status, 404, JSON.stringify(refusSite.body));

      for (const invalide of [{ periodiciteMois: 0 }, { periodiciteMois: 61 }, { dureePrevisionnelleMinutes: 5 }, { dureePrevisionnelleMinutes: 2000 }, { titre: 'ab' }]) {
        const refus = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`)
          .send({ clientId, titre: 'TEST Contrat bornes', periodiciteMois: 6, dureePrevisionnelleMinutes: 120, dateDebut: '08-09-2026', ...invalide });
        assert.equal(refus.status, 400, `${JSON.stringify(invalide)} → ${JSON.stringify(refus.body)}`);
      }

      const clientInactif = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST Client contrat inactif' });
      await prisma.client.update({ where: { id: clientInactif.body.id }, data: { actif: false } });
      const refusInactif = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`)
        .send({ clientId: clientInactif.body.id, titre: 'TEST Contrat client inactif', periodiciteMois: 6, dureePrevisionnelleMinutes: 120, dateDebut: '08-09-2026' });
      assert.equal(refusInactif.status, 404, JSON.stringify(refusInactif.body));
    });

    test('TVA #92 : supprime seulement le taux ciblé, refuse les taux et corps invalides, protège la route', async () => {
      const auth = `Bearer ${session}`;
      const cible = await prisma.compteComptable.create({ data: { code: '445792', libelle: 'TVA #92', nature: 'TVA' } });
      const autre = await prisma.compteComptable.create({ data: { code: '445793', libelle: 'Autre TVA #92', nature: 'TVA' } });
      for (const [taux, compteId] of [[7.7, cible.id], [10, autre.id]]) {
        const r = await request(app).put(`/api/comptabilite/tva/${taux}`).set('Authorization', auth).send({ compteId });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      }
      const conducteur = await prisma.user.upsert({ where: { email: 'tva92.conducteur@iris.test' }, create: { email: 'tva92.conducteur@iris.test', name: 'TEST TVA #92', role: 'CONDUCTEUR_TRAVAUX' }, update: {} });
      const nonAdmin = `Bearer ${jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET)}`;
      const url = '/api/comptabilite/tva/7.7';
      const snapshot = (await request(app).get('/api/comptabilite').set('Authorization', auth)).body.reglesTva;
      const attendu = taux => {
        const regle = snapshot.find(r => r.taux === taux);
        return { confirmation: String(taux), expectedCompteId: regle.compteId, expectedUpdatedAt: regle.updatedAt };
      };
      assert.equal((await request(app).delete(url)).status, 401);
      assert.equal((await request(app).delete(url).set('Authorization', nonAdmin).send(attendu(7.7))).status, 403);
      const valide = attendu(7.7);
      for (const [chemin, body] of [
        ['/api/comptabilite/tva/invalide', valide],
        [url, {}],
        [url, { ...valide, confirmation: '10' }],
        [url, { ...valide, confirmation: 7.7 }],
        [url, { ...valide, champImprevu: true }],
        ['/api/comptabilite/tva/100.01', { ...valide, confirmation: '100.01' }],
      ]) {
        const refus = await request(app).delete(chemin).set('Authorization', auth).send(body);
        assert.equal(refus.status, 400, `${chemin} ${JSON.stringify(body)} → ${JSON.stringify(refus.body)}`);
        assert.equal(await prisma.regleTvaComptable.count({ where: { taux: 7.7 } }), 1, 'un corps invalide ne retire pas le taux ciblé');
        assert.equal(await prisma.regleTvaComptable.count({ where: { taux: 10 } }), 1, 'un corps invalide ne retire pas les autres taux');
      }
      assert.equal(await prisma.regleTvaComptable.count({ where: { taux: 7.7 } }), 1);
      assert.equal(await prisma.regleTvaComptable.count({ where: { taux: 10 } }), 1);
      assert.equal((await request(app).delete(url).set('Authorization', auth).send(attendu(7.7))).status, 204);
      assert.equal(await prisma.regleTvaComptable.findUnique({ where: { taux: 7.7 } }), null);
      assert.equal((await prisma.regleTvaComptable.findUniqueOrThrow({ where: { taux: 10 } })).compteId, autre.id);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: cible.id } })).actif, true);
      assert.equal((await request(app).delete(url).set('Authorization', auth).send(attendu(7.7))).status, 404);
      assert.equal((await request(app).delete('/api/comptabilite/tva/10').set('Authorization', auth).send(attendu(10))).status, 204);
    });

    test('TVA #92 : confirmation décimale française exacte 5,5 retire la règle sans accepter un autre taux', async () => {
      const auth = `Bearer ${session}`;
      const compte = await prisma.compteComptable.create({ data: { code: '445797', libelle: 'TVA virgule #92', nature: 'TVA' } });
      const url = '/api/comptabilite/tva/5.5';
      assert.equal((await request(app).put(url).set('Authorization', auth).send({ compteId: compte.id })).status, 200);
      const regle = (await request(app).get('/api/comptabilite').set('Authorization', auth)).body.reglesTva.find(r => r.taux === 5.5);
      const attendu = { expectedCompteId: regle.compteId, expectedUpdatedAt: regle.updatedAt };
      assert.equal((await request(app).delete(url).set('Authorization', auth).send({ ...attendu, confirmation: '5,6' })).status, 400);
      assert.equal(await prisma.regleTvaComptable.count({ where: { taux: 5.5 } }), 1);
      assert.equal((await request(app).delete(url).set('Authorization', auth).send({ ...attendu, confirmation: '5,5' })).status, 204);
      assert.equal(await prisma.regleTvaComptable.count({ where: { taux: 5.5 } }), 0);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).actif, true);
    });

    test('TVA #92 : retrait périmé après remappage refuse 409 sans effacer le nouveau compte', async () => {
      const auth = `Bearer ${session}`;
      const ancien = await prisma.compteComptable.create({ data: { code: '445795', libelle: 'TVA initiale #92', nature: 'TVA' } });
      const nouveau = await prisma.compteComptable.create({ data: { code: '445796', libelle: 'TVA nouvelle #92', nature: 'TVA' } });
      const url = '/api/comptabilite/tva/8.8';
      assert.equal((await request(app).put(url).set('Authorization', auth).send({ compteId: ancien.id })).status, 200);
      const photographie = (await request(app).get('/api/comptabilite').set('Authorization', auth)).body.reglesTva.find(r => r.taux === 8.8);
      assert.equal(photographie.compteId, ancien.id);
      assert.equal((await request(app).put(url).set('Authorization', auth).send({ compteId: nouveau.id })).status, 200);
      const refus = await request(app).delete(url).set('Authorization', auth).send({ confirmation: '8.8', expectedCompteId: photographie.compteId, expectedUpdatedAt: photographie.updatedAt });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.equal((await prisma.regleTvaComptable.findUniqueOrThrow({ where: { id: photographie.id } })).compteId, nouveau.id);
      assert.equal((await request(app).delete(url).set('Authorization', auth).send({ confirmation: '8.8', expectedCompteId: nouveau.id, expectedUpdatedAt: photographie.updatedAt })).status, 409, 'la version périmée est aussi refusée');
      const actuelle = (await request(app).get('/api/comptabilite').set('Authorization', auth)).body.reglesTva.find(r => r.taux === 8.8);
      const mauvaisCompte = await request(app).delete(url).set('Authorization', auth).send({ confirmation: '8.8', expectedCompteId: ancien.id, expectedUpdatedAt: actuelle.updatedAt });
      assert.equal(mauvaisCompte.status, 409, JSON.stringify(mauvaisCompte.body));
      assert.equal((await prisma.regleTvaComptable.findUniqueOrThrow({ where: { id: photographie.id } })).compteId, nouveau.id);
      assert.equal((await request(app).delete(url).set('Authorization', auth).send({ confirmation: '8.8', expectedCompteId: actuelle.compteId, expectedUpdatedAt: actuelle.updatedAt })).status, 204);
    });

    test('TVA #92 : le retrait attend le verrou global comptable puis ne retire que la règle', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: '445794', libelle: 'TVA verrou #92', nature: 'TVA' } });
      assert.equal((await request(app).put('/api/comptabilite/tva/6.6').set('Authorization', `Bearer ${session}`).send({ compteId: compte.id })).status, 200);
      const snapshot = (await request(app).get('/api/comptabilite').set('Authorization', `Bearer ${session}`)).body.reglesTva.find(r => r.taux === 6.6);
      let liberer;
      let annoncer;
      const pose = new Promise(resolve => { annoncer = resolve; });
      const attente = new Promise(resolve => { liberer = resolve; });
      const transaction = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(814086)::text`;
        annoncer();
        await attente;
      }, { timeout: 10_000 });
      await pose;
      const retrait = request(app).delete('/api/comptabilite/tva/6.6').set('Authorization', `Bearer ${session}`).send({ confirmation: '6.6', expectedCompteId: snapshot.compteId, expectedUpdatedAt: snapshot.updatedAt }).then(r => r);
      let bloquee = false;
      try {
        for (let i = 0; i < 60; i++) {
          const [etat] = await prisma.$queryRaw`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock(814086)%') AS attente`;
          if (etat.attente) { bloquee = true; break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(await prisma.regleTvaComptable.count({ where: { taux: 6.6 } }), 1);
      } finally { liberer(); await transaction; }
      assert.equal(bloquee, true, 'le retrait doit attendre le verrou partagé avec les émissions');
      assert.equal((await retrait).status, 204);
      assert.equal(await prisma.regleTvaComptable.count({ where: { taux: 6.6 } }), 0);
    });

    test('refuse une facture sans origine métier déclarée', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST origine absente', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(facture.status, 400, JSON.stringify(facture.body));
    });

    test('ne divulgue pas un contrat rattaché à un autre client', async () => {
      const autreClient = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST Client origine étrangère' });
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({ clientId: autreClient.body.id, titre: 'TEST Contrat étranger', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '08-09-2026' });
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'CONTRAT', contratMaintenanceId: contrat.body.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST origine étrangère', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(facture.status, 404, JSON.stringify(facture.body));
    });

    test('refuse de facturer une affaire annulée', async () => {
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Affaire annulée', client: 'TEST Client', clientId, dateDebut: new Date('2026-09-01T00:00:00.000Z'), statut: 'ANNULE', budgetGlobalVendu: 100 } });
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'CHANTIER', chantierId: chantier.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST affaire annulée', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(facture.status, 409, JSON.stringify(facture.body));
    });

    test('expose la traçabilité d’une facture hors affaire motivée', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Refacturation de frais', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST frais', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(facture.status, 201, JSON.stringify(facture.body));
      const trace = await request(app).get(`/api/factures/${facture.body.id}/tracabilite`).set('Authorization', `Bearer ${session}`);
      assert.equal(trace.status, 200, JSON.stringify(trace.body));
      assert.equal(trace.body.facture.origine, 'HORS_AFFAIRE');
      assert.equal(trace.body.facture.motifHorsAffaire, 'Refacturation de frais');
    });

    test('crée une facture brouillon avec des lignes fiscales figées', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [{ designation: 'TEST Maintenance', quantite: 2, prixUnitaireHt: 100, tauxTva: 20 }],
      });
      assert.equal(facture.status, 201, JSON.stringify(facture.body));
      assert.equal(facture.body.statut, 'BROUILLON');
      assert.equal(facture.body.numero, null, 'La numérotation légale est attribuée à l’émission, pas au brouillon.');
      assert.equal(facture.body.totalHt, 200);
      assert.equal(facture.body.totalTva, 40);
      assert.equal(facture.body.totalTtc, 240);
    });

    test('crée une facture à deux lignes, dont un article', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Facturation mixte', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [
          { designation: 'TEST Pose', nature: 'PRESTATION', quantite: 2, prixUnitaireHt: 100, tauxTva: 20 },
          { designation: 'TEST Détecteur', nature: 'ARTICLE', quantite: 3, prixUnitaireHt: 50, tauxTva: 10 },
        ],
      });
      assert.equal(facture.status, 201, JSON.stringify(facture.body));
      assert.equal(facture.body.lignes.length, 2);
      assert.deepEqual(facture.body.lignes.map((ligne) => ({ designation: ligne.designation, nature: ligne.nature, ordre: ligne.ordre })), [
        { designation: 'TEST Pose', nature: 'PRESTATION', ordre: 0 },
        { designation: 'TEST Détecteur', nature: 'ARTICLE', ordre: 1 },
      ]);
      assert.equal(facture.body.totalHt, 350);
      assert.equal(facture.body.totalTva, 55);
      assert.equal(facture.body.totalTtc, 405);
    });

    test('expose à l’administration les prérequis pour facturer', async () => {
      const reponse = await request(app).get('/api/facturation/prete-a-facturer').set('Authorization', `Bearer ${session}`);
      assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
      assert.equal(reponse.body.pret, false);
      const plan = reponse.body.controles.find((controle) => controle.cle === 'PLAN_COMPTABLE');
      assert.equal(plan.bloquant, true); assert.equal(plan.route, '/comptabilite');
      const mentions = reponse.body.controles.find((controle) => controle.cle === 'MENTIONS_LEGALES');
      assert.equal(mentions.route, '/mentions-legales');
      const prefixe = reponse.body.controles.find((controle) => controle.cle === 'PREFIXE_FACTURE');
      assert.equal(prefixe.bloquant, false); assert.equal(prefixe.route, null);
      const tva = reponse.body.controles.find((controle) => controle.cle === 'TVA');
      assert.equal(tva.pret, false); assert.equal(tva.bloquant, false, 'Sans taux facturé non couvert, le manque de compte TVA ne bloque pas.');
      assert.match(tva.detail, /0 %/);
      assert.ok(reponse.body.controles.some((controle) => controle.cle === 'ADRESSES_CLIENTS' && controle.bloquant === false));
    });

    test('paramètre un compte comptable sans imposer de plan préchargé', async () => {
      const compte = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code: '706100', libelle: 'Prestations techniques', nature: 'PRODUIT' });
      assert.equal(compte.status, 201, JSON.stringify(compte.body));
      assert.equal(compte.body.code, '706100');
      const regle = await request(app).put('/api/comptabilite/regles/VENTE_PRESTATION').set('Authorization', `Bearer ${session}`).send({ compteId: compte.body.id });
      assert.equal(regle.status, 200, JSON.stringify(regle.body));
      assert.equal(regle.body.compteId, compte.body.id);
    });

    test('désactive et réactive un compte libre sans modifier son identité', async () => {
      const code = `898${String(Date.now()).slice(-9)}`;
      const creation = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code, libelle: 'Compte temporaire', nature: 'CHARGE' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const url = `/api/comptabilite/comptes/${creation.body.id}/activation`;
      const desactivation = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ actif: false, motif: 'Compte devenu inutile' });
      assert.equal(desactivation.status, 200, JSON.stringify(desactivation.body));
      assert.equal(desactivation.body.actif, false);
      assert.equal(desactivation.body.code, code);
      assert.equal(desactivation.body.libelle, 'Compte temporaire');
      assert.equal((await request(app).get('/api/comptabilite').set('Authorization', `Bearer ${session}`)).body.comptes.find(c => c.id === creation.body.id)?.actif, false);
      assert.equal((await request(app).put('/api/comptabilite/regles/CLIENT').set('Authorization', `Bearer ${session}`).send({ compteId: creation.body.id })).status, 404);
      const reactivation = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ actif: true, motif: 'Retour en service' });
      assert.equal(reactivation.status, 200, JSON.stringify(reactivation.body));
      assert.equal(reactivation.body.actif, true);
      assert.equal((await prisma.compteComptable.findUnique({ where: { id: creation.body.id } })).code, code);
    });

    test('refuse de désactiver un compte utilisé par une règle standard jusqu’à son remappage', async () => {
      const premier = await prisma.compteComptable.create({ data: { code: `897${String(Date.now()).slice(-9)}`, libelle: 'Prestations liées', nature: 'PRODUIT' } });
      const second = await prisma.compteComptable.create({ data: { code: `896${String(Date.now()).slice(-9)}`, libelle: 'Prestations remplacement', nature: 'PRODUIT' } });
      const url = `/api/comptabilite/comptes/${premier.id}/activation`;
      assert.equal((await request(app).put('/api/comptabilite/regles/VENTE_PRESTATION').set('Authorization', `Bearer ${session}`).send({ compteId: premier.id })).status, 200);
      const conflit = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ actif: false, motif: 'Compte devenu inutile' });
      assert.equal(conflit.status, 409, JSON.stringify(conflit.body));
      assert.equal((await prisma.compteComptable.findUnique({ where: { id: premier.id } })).actif, true);
      assert.equal((await request(app).put('/api/comptabilite/regles/VENTE_PRESTATION').set('Authorization', `Bearer ${session}`).send({ compteId: second.id })).status, 200);
      assert.equal((await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ actif: false, motif: 'Compte devenu inutile' })).status, 200);
    });

    test('refuse de désactiver un compte TVA utilisé jusqu’à son remappage', async () => {
      const premier = await prisma.compteComptable.create({ data: { code: `895${String(Date.now()).slice(-9)}`, libelle: 'TVA liée', nature: 'TVA' } });
      const second = await prisma.compteComptable.create({ data: { code: `894${String(Date.now()).slice(-9)}`, libelle: 'TVA remplacement', nature: 'TVA' } });
      const url = `/api/comptabilite/comptes/${premier.id}/activation`;
      assert.equal((await request(app).put('/api/comptabilite/tva/5.5').set('Authorization', `Bearer ${session}`).send({ compteId: premier.id })).status, 200);
      const conflit = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ actif: false, motif: 'Compte devenu inutile' });
      assert.equal(conflit.status, 409, JSON.stringify(conflit.body));
      assert.equal((await prisma.compteComptable.findUnique({ where: { id: premier.id } })).actif, true);
      assert.equal((await request(app).put('/api/comptabilite/tva/5.5').set('Authorization', `Bearer ${session}`).send({ compteId: second.id })).status, 200);
      assert.equal((await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ actif: false, motif: 'Compte devenu inutile' })).status, 200);
    });

    test('une règle attend le verrou du compte puis refuse un compte désactivé entre-temps', async () => {
      for (const { nature, chemin, lire } of [
        { nature: 'PRODUIT', chemin: '/api/comptabilite/regles/VENTE_ARTICLE', lire: () => prisma.regleComptable.findUnique({ where: { cle: 'VENTE_ARTICLE' } }) },
        { nature: 'TVA', chemin: '/api/comptabilite/tva/7.7', lire: () => prisma.regleTvaComptable.findUnique({ where: { taux: 7.7 } }) },
      ]) {
        const compte = await prisma.compteComptable.create({ data: { code: `${nature === 'TVA' ? '890' : '891'}${String(Date.now()).slice(-9)}`, libelle: 'Course activation', nature } });
        const source = await prisma.compteComptable.create({ data: { code: `${nature === 'TVA' ? '888' : '889'}${String(Date.now()).slice(-9)}`, libelle: 'Source du remappage', nature } });
        if (nature === 'TVA') await prisma.regleTvaComptable.upsert({ where: { taux: 7.7 }, create: { taux: 7.7, compteId: source.id }, update: { compteId: source.id } });
        else await prisma.regleComptable.upsert({ where: { cle: 'VENTE_ARTICLE' }, create: { cle: 'VENTE_ARTICLE', compteId: source.id }, update: { compteId: source.id } });
        let liberer;
        let annoncer;
        const verrouPose = new Promise(resolve => { annoncer = resolve; });
        const libere = new Promise(resolve => { liberer = resolve; });
        const transaction = prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT "id" FROM "CompteComptable" WHERE "id" = ${compte.id} FOR UPDATE`;
          annoncer();
          await libere;
          await tx.compteComptable.update({ where: { id: compte.id }, data: { actif: false } });
        }, { timeout: 10_000 });
        await verrouPose;
        const requete = request(app).put(chemin).set('Authorization', `Bearer ${session}`).send({ compteId: compte.id });
        // Le serveur doit réellement attendre le verrou SQL, pas simplement être lent à démarrer.
        const reponsePromise = requete.then(reponse => reponse);
        let attenteObservee = false;
        try {
          for (let tentative = 0; tentative < 60; tentative++) {
            const [etat] = await prisma.$queryRaw`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%CompteComptable%' AND query LIKE '%FOR UPDATE%') AS attente`;
            if (etat.attente) { attenteObservee = true; break; }
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        } finally { liberer(); await transaction; }
        const reponse = await reponsePromise;
        assert.equal(attenteObservee, true, `${chemin} doit attendre le verrou du compte`);
        assert.equal(reponse.status, 404, JSON.stringify(reponse.body));
        assert.equal((await lire())?.compteId, source.id, 'le remappage refusé conserve le compte source actif');
        assert.equal((await prisma.compteComptable.findUnique({ where: { id: source.id } })).actif, true);
      }
    });

    test('la désactivation attend le remappage vers son compte et refuse sans journal', async () => {
      for (const { nature, cle, taux, prefixe } of [
        { nature: 'PRODUIT', cle: 'VENTE_ARTICLE', prefixe: '885' },
        { nature: 'TVA', taux: 7.7, prefixe: '884' },
      ]) {
        const cible = await prisma.compteComptable.create({ data: { code: `${prefixe}${String(Date.now()).slice(-9)}`, libelle: 'Cible course symétrique', nature } });
        let liberer;
        let annoncer;
        const verrouPose = new Promise(resolve => { annoncer = resolve; });
        const libere = new Promise(resolve => { liberer = resolve; });
        const remappage = prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT "id" FROM "CompteComptable" WHERE "id" = ${cible.id} FOR UPDATE`;
          if (cle) await tx.regleComptable.upsert({ where: { cle }, create: { cle, compteId: cible.id }, update: { compteId: cible.id } });
          else await tx.regleTvaComptable.upsert({ where: { taux }, create: { taux, compteId: cible.id }, update: { compteId: cible.id } });
          annoncer();
          await libere;
        }, { timeout: 10_000 });
        await verrouPose;
        const reponsePromise = request(app).patch(`/api/comptabilite/comptes/${cible.id}/activation`)
          .set('Authorization', `Bearer ${session}`).send({ actif: false, motif: 'Remappage concurrent' })
          .timeout({ deadline: 12_000 }).then(r => r, e => ({ status: 0, body: { error: String(e) } }));
        let attenteObservee = false;
        try {
          for (let tentative = 0; tentative < 60; tentative++) {
            const [etat] = await prisma.$queryRaw`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%CompteComptable%' AND query LIKE '%FOR UPDATE%') AS attente`;
            if (etat.attente) { attenteObservee = true; break; }
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        } finally { liberer(); await remappage; }
        const reponse = await reponsePromise;
        assert.equal(attenteObservee, true, `${nature} : désactivation bloquée par le verrou du compte cible`);
        assert.equal(reponse.status, 409, JSON.stringify(reponse.body));
        assert.equal((await prisma.compteComptable.findUnique({ where: { id: cible.id } })).actif, true);
        const regle = cle ? await prisma.regleComptable.findUnique({ where: { cle } }) : await prisma.regleTvaComptable.findUnique({ where: { taux } });
        assert.equal(regle.compteId, cible.id);
        assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: cible.id } }), 0);
      }
    });

    test('valide strictement la transition de compte et protège la route', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `893${String(Date.now()).slice(-9)}`, libelle: 'Compte protégé', nature: 'CHARGE' } });
      const url = `/api/comptabilite/comptes/${compte.id}/activation`;
      assert.equal((await request(app).patch(url).send({ actif: false, motif: 'Compte devenu inutile' })).status, 401);
      const conducteur = await prisma.user.create({ data: { email: 'comptabilite.conducteur@iris.test', name: 'TEST Conducteur comptabilité', role: 'CONDUCTEUR_TRAVAUX' } });
      const nonAdmin = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      assert.equal((await request(app).patch(url).set('Authorization', `Bearer ${nonAdmin}`).send({ actif: false, motif: 'Compte devenu inutile' })).status, 403);
      for (const body of [{}, { actif: 'false' }, { actif: null }, { actif: false, libelle: 'Injection' }, { actif: false }, { actif: false, motif: '  ' }, { actif: false, motif: 'ab' }, { actif: false, motif: 'Motif\ninvalide' }, { actif: false, motif: 'Motif\tinvalide' }, { actif: false, motif: 'Motif\u0000invalide' }, { actif: false, motif: 'x'.repeat(501) }, { actif: false, motif: 42 }, { actif: false, motif: 'Valide', code: '999' }]) {
        assert.equal((await request(app).patch(url).set('Authorization', `Bearer ${session}`).send(body)).status, 400);
      }
      assert.equal((await request(app).patch('/api/comptabilite/comptes/inexistant/activation').set('Authorization', `Bearer ${session}`).send({ actif: false, motif: 'Compte devenu inutile' })).status, 404);
      assert.equal((await prisma.compteComptable.findUnique({ where: { id: compte.id } })).actif, true);
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
      assert.equal((await request(app).get(`/api/comptabilite/comptes/${compte.id}/journal`)).status, 401);
      assert.equal((await request(app).get(`/api/comptabilite/comptes/${compte.id}/journal`).set('Authorization', `Bearer ${nonAdmin}`)).status, 403);
      assert.equal((await request(app).get('/api/comptabilite/comptes/inexistant/journal').set('Authorization', `Bearer ${session}`)).status, 404);
    });

    test('modifie un compte avec motif et instantanés auditables sans changer son code', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `878${String(Date.now()).slice(-9)}`, libelle: 'Avant', nature: 'CHARGE' } });
      const url = `/api/comptabilite/comptes/${compte.id}`;
      const reponse = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ libelle: 'Après', nature: 'ACTIF', motif: 'Correction de classification', expectedUpdatedAt: compte.updatedAt.toISOString() });
      assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
      assert.deepEqual([reponse.body.code, reponse.body.libelle, reponse.body.nature], [compte.code, 'Après', 'ACTIF']);
      const journal = await request(app).get(`${url}/journal`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.status, 200);
      assert.equal(journal.body.length, 1);
      assert.deepEqual([journal.body[0].action, journal.body[0].avantLibelle, journal.body[0].apresLibelle, journal.body[0].avantNature, journal.body[0].apresNature, journal.body[0].motif], ['MODIFICATION', 'Avant', 'Après', 'CHARGE', 'ACTIF', 'Correction de classification']);
      assert.equal(journal.body[0].auteurId, (await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' } })).id);
    });

    test('un ADMIN modifie un compte inactif sans le réactiver et signe son journal', async () => {
      const admin = await prisma.user.create({ data: { email: 'comptabilite.modification.admin@iris.test', name: 'TEST Admin modification', role: 'ADMIN' } });
      const compte = await prisma.compteComptable.create({ data: { code: `869${String(Date.now()).slice(-9)}`, libelle: 'Libellé inactif', nature: 'CHARGE', actif: false } });
      const token = jwt.sign({ id: admin.id }, process.env.JWT_SECRET);
      const reponse = await request(app).patch(`/api/comptabilite/comptes/${compte.id}`).set('Authorization', `Bearer ${token}`).send({ libelle: 'Libellé rectifié', motif: 'Correction historique', expectedUpdatedAt: compte.updatedAt.toISOString() });
      assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
      assert.equal(reponse.body.actif, false);
      const [trace] = await prisma.journalCompteComptable.findMany({ where: { compteId: compte.id } });
      assert.deepEqual([trace.auteurId, trace.auteurNom, trace.avantNature, trace.apresNature], [admin.id, admin.name, 'CHARGE', 'CHARGE']);
    });

    test('une version périmée ou absente ne modifie rien et ne journalise rien', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `868${String(Date.now()).slice(-9)}`, libelle: 'Initial', nature: 'CHARGE' } });
      const url = `/api/comptabilite/comptes/${compte.id}`;
      const premier = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ libelle: 'Premier', motif: 'Premier éditeur', expectedUpdatedAt: compte.updatedAt.toISOString() });
      assert.equal(premier.status, 200, JSON.stringify(premier.body));
      for (const body of [
        { libelle: 'Écrasement', nature: 'ACTIF', motif: 'Éditeur périmé', expectedUpdatedAt: compte.updatedAt.toISOString() },
        { libelle: 'Écrasement', motif: 'Version manquante' },
      ]) {
        const reponse = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send(body);
        assert.equal(reponse.status, body.expectedUpdatedAt ? 409 : 400, JSON.stringify(reponse.body));
      }
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Premier');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 1);
    });

    test('refuse les rôles non admin, les champs étrangers et les motifs invalides sans trace', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `877${String(Date.now()).slice(-9)}`, libelle: 'Initial', nature: 'CHARGE' } });
      const url = `/api/comptabilite/comptes/${compte.id}`;
      const valide = { libelle: 'Révisé', nature: 'PRODUIT', motif: 'Correction motivée', expectedUpdatedAt: compte.updatedAt.toISOString() };
      assert.equal((await request(app).patch(url).send(valide)).status, 401);
      const conducteur = await prisma.user.create({ data: { email: 'comptabilite.modification.conducteur@iris.test', name: 'TEST Conducteur modification', role: 'CONDUCTEUR_TRAVAUX' } });
      const nonAdmin = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      assert.equal((await request(app).patch(url).set('Authorization', `Bearer ${nonAdmin}`).send(valide)).status, 403);
      for (const body of [{ ...valide, code: '999' }, { ...valide, libelle: '   ' }, { ...valide, libelle: 'Ligne\nbrisée' }, { ...valide, libelle: 'Compte\u0085invalide' }, { ...valide, libelle: 42 }, { ...valide, nature: 'INCONNU' }, { ...valide, motif: 'ab' }, { ...valide, motif: 'x'.repeat(501) }, { ...valide, motif: 'Motif\tinterdit' }, { ...valide, motif: 'Motif\u007finterdit' }, { ...valide, motif: 'Motif\u0085interdit' }, { ...valide, motif: '\u200B'.repeat(3) }, { ...valide, motif: 'Motif \u202E inversé' }, { ...valide, libelle: 'Compte \u202E inversé' }]) {
        const r = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send(body);
        assert.equal(r.status, 400, JSON.stringify({ body, reponse: r.body }));
        assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
      }
      assert.equal((await request(app).patch('/api/comptabilite/comptes/inexistant').set('Authorization', `Bearer ${session}`).send(valide)).status, 404);
      assert.deepEqual([(await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, await prisma.journalCompteComptable.count({ where: { compteId: compte.id } })], ['Initial', 0]);
      assert.equal((await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ libelle: 'Initial', motif: 'Sans changement', expectedUpdatedAt: compte.updatedAt.toISOString() })).status, 400);
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    test('création et import refusent le libellé bidi sans aucun compte créé', async () => {
      const code = `864${String(Date.now()).slice(-9)}`;
      const autreCode = `863${String(Date.now()).slice(-9)}`;
      const libelle = 'Compte \u202E inversé';
      const creation = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code, libelle, nature: 'CHARGE' });
      assert.equal(creation.status, 400, JSON.stringify(creation.body));
      const importation = await request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ lignes: [{ code, libelle: 'Compte autorisé', nature: 'CHARGE' }, { code: autreCode, libelle, nature: 'CHARGE' }] });
      assert.equal(importation.status, 400, JSON.stringify(importation.body));
      assert.deepEqual(importation.body.erreurs.map(e => e.ligne), [2]);
      assert.equal(await prisma.compteComptable.count({ where: { code: { in: [code, autreCode] } } }), 0);
    });

    test('activation et modification refusent le même motif invisible sans journal', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `862${String(Date.now()).slice(-9)}`, libelle: 'Compte sans trace', nature: 'CHARGE' } });
      const url = `/api/comptabilite/comptes/${compte.id}`;
      for (const motif of ['\u200B'.repeat(3), 'Motif \u202E inversé']) {
        const modification = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ libelle: 'Tentative', motif, expectedUpdatedAt: compte.updatedAt.toISOString() });
        const activation = await request(app).patch(`${url}/activation`).set('Authorization', `Bearer ${session}`).send({ actif: false, motif });
        assert.equal(modification.status, 400, JSON.stringify(modification.body));
        assert.equal(activation.status, 400, JSON.stringify(activation.body));
      }
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, compte.libelle);
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    test('les deux actions acceptent 500 emoji comptés en points de code', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `865${String(Date.now()).slice(-9)}`, libelle: 'Compte emoji', nature: 'CHARGE' } });
      const motif = '🔧'.repeat(500);
      const url = `/api/comptabilite/comptes/${compte.id}`;
      const modification = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ libelle: 'Compte corrigé', motif, expectedUpdatedAt: compte.updatedAt.toISOString() });
      assert.equal(modification.status, 200, JSON.stringify(modification.body));
      const activation = await request(app).patch(`${url}/activation`).set('Authorization', `Bearer ${session}`).send({ actif: false, motif });
      assert.equal(activation.status, 200, JSON.stringify(activation.body));
      assert.deepEqual((await prisma.journalCompteComptable.findMany({ where: { compteId: compte.id }, orderBy: { createdAt: 'asc' } })).map(j => j.motif), [motif, motif]);
    });

    test('corrige un libellé hérité C1 en conservant son instantané avant sans 500', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `861${String(Date.now()).slice(-9)}`, libelle: 'Ancien\u0085libellé', nature: 'CHARGE' } });
      const reponse = await request(app).patch(`/api/comptabilite/comptes/${compte.id}`).set('Authorization', `Bearer ${session}`).send({ libelle: 'Libellé corrigé', motif: 'Correction historique', expectedUpdatedAt: compte.updatedAt.toISOString() });
      assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
      const [trace] = await prisma.journalCompteComptable.findMany({ where: { compteId: compte.id } });
      assert.deepEqual([trace.avantLibelle, trace.apresLibelle], ['Ancien\u0085libellé', 'Libellé corrigé']);
    });

    test('refuse une nature incompatible avec une règle client, vente ou TVA sans effet', async () => {
      const client = await prisma.compteComptable.create({ data: { code: `876${String(Date.now()).slice(-9)}`, libelle: 'Clients liés', nature: 'ACTIF' } });
      const vente = await prisma.compteComptable.create({ data: { code: `875${String(Date.now()).slice(-9)}`, libelle: 'Ventes liées', nature: 'PRODUIT' } });
      const tva = await prisma.compteComptable.create({ data: { code: `874${String(Date.now()).slice(-9)}`, libelle: 'TVA liée', nature: 'TVA' } });
      for (const [cle, compteId] of [['CLIENT', client.id], ['VENTE_PRESTATION', vente.id], ['VENTE_ARTICLE', vente.id]]) {
        assert.equal((await request(app).put(`/api/comptabilite/regles/${cle}`).set('Authorization', `Bearer ${session}`).send({ compteId })).status, 200);
      }
      assert.equal((await request(app).put('/api/comptabilite/tva/17').set('Authorization', `Bearer ${session}`).send({ compteId: tva.id })).status, 200);
      for (const compte of [client, vente, tva]) {
        const r = await request(app).patch(`/api/comptabilite/comptes/${compte.id}`).set('Authorization', `Bearer ${session}`).send({ libelle: 'Tentative', nature: 'CHARGE', motif: 'Changement de nature', expectedUpdatedAt: compte.updatedAt.toISOString() });
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, compte.libelle);
        assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
      }
    });

    test('les contraintes SQL protègent code et journal de modification', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `873${String(Date.now()).slice(-9)}`, libelle: 'Origine SQL', nature: 'CHARGE' } });
      await assert.rejects(prisma.compteComptable.update({ where: { id: compte.id }, data: { code: '999123' } }), /Code du compte comptable immuable/);
      const r = await request(app).patch(`/api/comptabilite/comptes/${compte.id}`).set('Authorization', `Bearer ${session}`).send({ libelle: 'Destination SQL', motif: 'Correction SQL', expectedUpdatedAt: compte.updatedAt.toISOString() });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const trace = await prisma.journalCompteComptable.findFirstOrThrow({ where: { compteId: compte.id } });
      for (const data of [{ motif: 'Falsifié' }, { avantLibelle: 'Falsifié' }]) await assert.rejects(prisma.journalCompteComptable.update({ where: { id: trace.id }, data }), /Journal comptable immuable/);
      await assert.rejects(prisma.journalCompteComptable.delete({ where: { id: trace.id } }), /Journal comptable immuable/);
      const auteur = await prisma.user.findUniqueOrThrow({ where: { id: trace.auteurId } });
      for (const [id, avantLibelle, apresLibelle, avantNature, apresNature, motif] of [
        ['test-modification-identique', 'Même', 'Même', 'CHARGE', 'CHARGE', 'Motif correct'],
        ['test-modification-vide', '', 'Après', 'CHARGE', 'ACTIF', 'Motif correct'],
        ['test-modification-nature', 'Avant', 'Après', 'INCONNU', 'ACTIF', 'Motif correct'],
        ['test-modification-motif', 'Avant', 'Après', 'CHARGE', 'ACTIF', 'Non\nvalide'],
        ['test-modification-apres-controle', 'Avant', 'Après\u0005', 'CHARGE', 'ACTIF', 'Motif correct'],
        ['test-modification-apres-espace', 'Avant', ' Après', 'CHARGE', 'ACTIF', 'Motif correct'],
        ['test-modification-apres-bidi', 'Avant', 'Après\u202E', 'CHARGE', 'ACTIF', 'Motif correct'],
        ['test-modification-motif-invisible', 'Avant', 'Après', 'CHARGE', 'ACTIF', '\u200B'.repeat(3)],
      ]) {
        await assert.rejects(prisma.$executeRaw`INSERT INTO "JournalCompteComptable" ("id", "compteId", "auteurId", "auteurNom", "action", "avantLibelle", "apresLibelle", "avantNature", "apresNature", "motif") VALUES (${id}, ${compte.id}, ${auteur.id}, ${auteur.name}, 'MODIFICATION', ${avantLibelle}, ${apresLibelle}, ${avantNature}, ${apresNature}, ${motif})`, /constraint|check/i);
      }
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 1);
    });

    test('SQL direct sans journal motivé est rejeté à la validation de transaction', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `867${String(Date.now()).slice(-9)}`, libelle: 'Original SQL', nature: 'CHARGE' } });
      await assert.rejects(prisma.compteComptable.update({ where: { id: compte.id }, data: { libelle: 'Fraude SQL' } }), /journal|motif|transition/i);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Original SQL');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    test('SQL avance la version même si un UPDATE remet le même instant milliseconde', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `860${String(Date.now()).slice(-9)}`, libelle: 'Version SQL', nature: 'CHARGE' } });
      await prisma.$executeRaw`UPDATE "CompteComptable" SET "updatedAt" = ${compte.updatedAt} WHERE "id" = ${compte.id}`;
      const apres = await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } });
      assert.ok(apres.updatedAt.getTime() >= compte.updatedAt.getTime() + 1);
    });

    test('SQL accepte une transition avec journal dans la même transaction, pas un journal antérieur', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `866${String(Date.now()).slice(-9)}`, libelle: 'Avant SQL', nature: 'CHARGE' } });
      const auteur = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' } });
      await prisma.$transaction(async tx => {
        await tx.compteComptable.update({ where: { id: compte.id }, data: { libelle: 'Après SQL' } });
        await tx.journalCompteComptable.create({ data: { compteId: compte.id, auteurId: auteur.id, auteurNom: auteur.name, action: 'MODIFICATION', avantLibelle: 'Avant SQL', apresLibelle: 'Après SQL', avantNature: 'CHARGE', apresNature: 'CHARGE', motif: 'Correction SQL motivée' } });
      });
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Après SQL');
      await assert.rejects(prisma.compteComptable.update({ where: { id: compte.id }, data: { libelle: 'Avant SQL' } }), /journal|motif|transition/i);
      await prisma.$transaction(async tx => {
        await tx.compteComptable.update({ where: { id: compte.id }, data: { libelle: 'Avant SQL' } });
        await tx.journalCompteComptable.create({ data: { compteId: compte.id, auteurId: auteur.id, auteurNom: auteur.name, action: 'MODIFICATION', avantLibelle: 'Après SQL', apresLibelle: 'Avant SQL', avantNature: 'CHARGE', apresNature: 'CHARGE', motif: 'Retour motivé' } });
      });
      // Le premier journal A→B existe, mais une troisième transition A→B
      // doit exiger une nouvelle écriture créée dans cette transaction.
      await assert.rejects(prisma.compteComptable.update({ where: { id: compte.id }, data: { libelle: 'Après SQL' } }), /journal|motif|transition/i);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Avant SQL');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 2);
    });

    test('attend le verrou global puis relit les règles avant une modification de nature', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `872${String(Date.now()).slice(-9)}`, libelle: 'Compte concurrent', nature: 'PRODUIT' } });
      const url = `/api/comptabilite/comptes/${compte.id}`;
      let signalerVerrou;
      const verrouPris = new Promise(resolve => { signalerVerrou = resolve; });
      let liberer;
      const barriere = new Promise(resolve => { liberer = resolve; });
      const transaction = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(814086)::text`;
        await tx.regleComptable.upsert({ where: { cle: 'VENTE_ARTICLE' }, create: { cle: 'VENTE_ARTICLE', compteId: compte.id }, update: { compteId: compte.id } });
        signalerVerrou();
        await barriere;
      }, { timeout: 20_000 });
      await verrouPris;
      const demande = request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ libelle: 'Changé', nature: 'CHARGE', motif: 'Concurrence de remappage', expectedUpdatedAt: compte.updatedAt.toISOString() });
      const resultat = demande.then(r => r);
      try {
        let attente = false;
        for (let i = 0; i < 30 && !attente; i++) {
          const [etat] = await prisma.$queryRaw`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%') AS attente`;
          attente = etat.attente;
          if (!attente) await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(attente, true, 'la modification doit attendre le verrou du paramétrage');
      } finally { liberer(); await transaction; }
      const reponse = await resultat;
      assert.equal(reponse.status, 409, JSON.stringify(reponse.body));
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).nature, 'PRODUIT');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    test('deux modifications simultanées journalisent une chaîne avant/après cohérente', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `870${String(Date.now()).slice(-9)}`, libelle: 'Départ', nature: 'CHARGE' } });
      const url = `/api/comptabilite/comptes/${compte.id}`;
      const requetes = await Promise.all(['Premier', 'Second'].map(libelle => request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ libelle, motif: `Correction ${libelle}`, expectedUpdatedAt: compte.updatedAt.toISOString() })));
      assert.deepEqual(requetes.map(r => r.status).sort(), [200, 409]);
      const traces = await prisma.journalCompteComptable.findMany({ where: { compteId: compte.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      assert.equal(traces.length, 1);
      assert.equal(traces[0].avantLibelle, 'Départ');
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, traces[0].apresLibelle);
    });

    test('une insertion du journal refusée annule la modification du compte', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `871${String(Date.now()).slice(-9)}`, libelle: 'Avant rollback', nature: 'CHARGE' } });
      await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" ADD CONSTRAINT "journal_test_refus_insertion" CHECK ("motif" <> \'TEST refus atomique\')');
      try {
        const reponse = await request(app).patch(`/api/comptabilite/comptes/${compte.id}`).set('Authorization', `Bearer ${session}`).send({ libelle: 'Après rollback', motif: 'TEST refus atomique', expectedUpdatedAt: compte.updatedAt.toISOString() });
        assert.equal(reponse.status, 500, JSON.stringify(reponse.body));
        assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Avant rollback');
        assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
      } finally { await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" DROP CONSTRAINT "journal_test_refus_insertion"'); }
    });

    test('autorise un ADMIN ordinaire à changer le statut d’un compte', async () => {
      const admin = await prisma.user.create({ data: { email: 'comptabilite.admin@iris.test', name: 'TEST Admin comptabilité', role: 'ADMIN' } });
      const token = jwt.sign({ id: admin.id }, process.env.JWT_SECRET);
      const compte = await prisma.compteComptable.create({ data: { code: `892${String(Date.now()).slice(-9)}`, libelle: 'Compte admin', nature: 'CHARGE' } });
      const reponse = await request(app).patch(`/api/comptabilite/comptes/${compte.id}/activation`).set('Authorization', `Bearer ${token}`).send({ actif: false, motif: 'Compte devenu inutile' });
      assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
      assert.equal(reponse.body.actif, false);
      const journal = await request(app).get(`/api/comptabilite/comptes/${compte.id}/journal`).set('Authorization', `Bearer ${token}`);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      assert.equal(journal.body.length, 1);
      const { compteId, auteurId, auteurNom, action, avant, apres, motif } = journal.body[0];
      assert.deepEqual({ compteId, auteurId, auteurNom, action, avant, apres, motif }, {
        compteId: compte.id, auteurId: admin.id, auteurNom: admin.name, action: 'DESACTIVATION', avant: true, apres: false, motif: 'Compte devenu inutile',
      });
      assert.ok(journal.body[0].createdAt);
      const url = `/api/comptabilite/comptes/${compte.id}/activation`;
      assert.equal((await request(app).patch(url).set('Authorization', `Bearer ${token}`).send({ actif: false, motif: 'Doublon injustifié' })).status, 409);
      assert.equal((await prisma.journalCompteComptable.count({ where: { compteId: compte.id } })), 1);
      assert.equal((await request(app).patch(url).set('Authorization', `Bearer ${token}`).send({ actif: true, motif: '  Retour en service  ' })).status, 200);
      const traces = await prisma.journalCompteComptable.findMany({ where: { compteId: compte.id } });
      assert.equal(traces.length, 2);
      const retour = traces.find(trace => trace.action === 'REACTIVATION');
      assert.ok(retour);
      assert.deepEqual([retour.avant, retour.apres, retour.motif], [false, true, 'Retour en service']);
      await assert.rejects(prisma.journalCompteComptable.update({ where: { id: journal.body[0].id }, data: { motif: 'Altéré' } }), /Journal comptable immuable/);
      await assert.rejects(prisma.journalCompteComptable.delete({ where: { id: journal.body[0].id } }), /Journal comptable immuable/);
      assert.equal((await prisma.journalCompteComptable.count({ where: { compteId: compte.id } })), 2);
    });

    test('les CHECK SQL refusent transitions et motifs incohérents dans le journal comptable', async () => {
      const auteur = await prisma.user.create({ data: { email: 'journal.comptable.sql@iris.test', name: 'TEST Journal SQL', role: 'ADMIN' } });
      const compte = await prisma.compteComptable.create({ data: { code: `880${String(Date.now()).slice(-9)}`, libelle: 'Contrôles SQL', nature: 'CHARGE' } });
      for (const { id, action, avant, apres, motif } of [
        { id: 'test-journal-transition-invalide', action: 'DESACTIVATION', avant: false, apres: false, motif: 'Correction métier' },
        { id: 'test-journal-motif-vide', action: 'DESACTIVATION', avant: true, apres: false, motif: '' },
        { id: 'test-journal-motif-controle', action: 'DESACTIVATION', avant: true, apres: false, motif: 'Motif\ninvalide' },
        { id: 'test-journal-motif-invisible', action: 'DESACTIVATION', avant: true, apres: false, motif: '\u200B'.repeat(3) },
      ]) {
        await assert.rejects(prisma.$executeRaw`INSERT INTO "JournalCompteComptable" ("id", "compteId", "auteurId", "auteurNom", "action", "avant", "apres", "motif") VALUES (${id}, ${compte.id}, ${auteur.id}, ${auteur.name}, ${action}, ${avant}, ${apres}, ${motif})`);
      }
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    test('la suppression de l’auteur d’un journal comptable explique la preuve à conserver', async () => {
      const auteur = await prisma.user.create({ data: { email: 'journal.comptable.auteur@iris.test', name: 'TEST Auteur comptable', role: 'ADMIN' } });
      const compte = await prisma.compteComptable.create({ data: { code: `879${String(Date.now()).slice(-9)}`, libelle: 'Compte auteur protégé', nature: 'CHARGE' } });
      const token = jwt.sign({ id: auteur.id }, process.env.JWT_SECRET);
      assert.equal((await request(app).patch(`/api/comptabilite/comptes/${compte.id}/activation`).set('Authorization', `Bearer ${token}`).send({ actif: false, motif: 'Fin utilisation' })).status, 200);
      const suppression = await request(app).delete(`/api/users/${auteur.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppression.status, 409, JSON.stringify(suppression.body));
      assert.match(suppression.body.error, /preuve de traçabilité/);
      assert.match(suppression.body.error, /Désactivez-le plutôt/);
      assert.ok(await prisma.user.findUnique({ where: { id: auteur.id } }));
      assert.equal(await prisma.journalCompteComptable.count({ where: { auteurId: auteur.id } }), 1);
    });

    test('une écriture du journal refusée par la base annule aussi le statut', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `881${String(Date.now()).slice(-9)}`, libelle: 'Rollback journal', nature: 'CHARGE' } });
      await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" DROP CONSTRAINT IF EXISTS "journal_test_refus_insertion"');
      await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" ADD CONSTRAINT "journal_test_refus_insertion" CHECK ("motif" <> \'TEST refus atomique\')');
      try {
        const reponse = await request(app).patch(`/api/comptabilite/comptes/${compte.id}/activation`).set('Authorization', `Bearer ${session}`).send({ actif: false, motif: 'TEST refus atomique' });
        assert.equal(reponse.status, 500, JSON.stringify(reponse.body));
        assert.equal((await prisma.compteComptable.findUnique({ where: { id: compte.id } })).actif, true);
        assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" DROP CONSTRAINT "journal_test_refus_insertion"');
      }
    });

    test('signale un code inactif lors de la création et refuse un import atomiquement', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `887${String(Date.now()).slice(-9)}`, libelle: 'Compte inactif import', nature: 'CHARGE', actif: false } });
      const codeLibre = `886${String(Date.now()).slice(-9)}`;
      const creation = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code: compte.code, libelle: compte.libelle, nature: compte.nature });
      assert.equal(creation.status, 409);
      assert.match(creation.body.error, /inactif/);
      const importation = await request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ lignes: [{ code: codeLibre, libelle: 'Nouveau', nature: 'CHARGE' }, { code: compte.code, libelle: compte.libelle, nature: compte.nature }] });
      assert.equal(importation.status, 409, JSON.stringify(importation.body));
      assert.deepEqual(importation.body.erreurs.map(e => e.ligne), [2]);
      assert.match(importation.body.erreurs[0].erreur, /inactif/);
      assert.equal(await prisma.compteComptable.count({ where: { code: codeLibre } }), 0);
      assert.equal((await prisma.compteComptable.findUnique({ where: { id: compte.id } })).actif, false);
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    test('aperçu de 4 900 modifications liées : lectures bornées et règles respectées', async () => {
      const lignes = Array.from({ length: 4900 }, (_, i) => ({ code: String(880000 + i), libelle: `Modifié ${i}`, nature: 'ACTIF' }));
      await prisma.compteComptable.createMany({ data: lignes.map(c => ({ ...c, libelle: `Initial ${c.code}`, nature: 'CHARGE' })) });
      const lie = await prisma.compteComptable.findUniqueOrThrow({ where: { code: lignes[0].code } });
      await prisma.regleComptable.upsert({ where: { cle: 'CLIENT' }, create: { cle: 'CLIENT', compteId: lie.id }, update: { compteId: lie.id } });
      // Compter les lectures applicatives (pas le temps machine) distingue un préchargement
      // borné d'une requête par compte, même sur une CI lente.
      const { prisma: prismaApp } = await import('../dist/index.js');
      let lectures = 0;
      let enCours = true;
      prismaApp.$use(async (params, next) => {
        if (enCours && ['CompteComptable', 'RegleComptable', 'RegleTvaComptable'].includes(params.model) && ['findMany', 'count'].includes(params.action)) lectures++;
        return next(params);
      });
      let reponse;
      try {
        reponse = await request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', phase: 'apercu', lignes });
      } finally { enCours = false; }
      assert.equal(reponse.status, 200, JSON.stringify(reponse.body).slice(0, 300));
      assert.equal(reponse.body.actions.length, lignes.length);
      assert.ok(lectures <= 4, `préchargement borné attendu, ${lectures} lectures observées pour 4 900 comptes`);
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: lie.id } }), 0);
    });

    test('aperçu puis confirmation de mise à jour CSV : aucun effet avant confirmation, journal par compte', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: '899851', libelle: 'Ancien', nature: 'CHARGE' } });
      const lignes = [{ code: compte.code, libelle: 'Nouveau', nature: 'ACTIF' }, { code: '899852', libelle: 'Création', nature: 'CHARGE' }];
      const url = '/api/comptabilite/importer';
      const apercu = await request(app).post(url).set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', phase: 'apercu', lignes });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      assert.deepEqual(apercu.body.actions.map(({ code, action }) => [code, action]), [['899851', 'modifier'], ['899852', 'creer']]);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Ancien');
      assert.equal(await prisma.compteComptable.count({ where: { code: '899852' } }), 0);
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
      const confirmation = await request(app).post(url).set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', phase: 'confirmer', lignes, motif: 'Correction du référentiel', apercuId: apercu.body.apercuId });
      assert.equal(confirmation.status, 200, JSON.stringify(confirmation.body));
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Nouveau');
      assert.equal(await prisma.compteComptable.count({ where: { code: '899852' } }), 1);
      const traces = await prisma.journalCompteComptable.findMany({ where: { compteId: compte.id } });
      assert.deepEqual(traces.map(t => [t.action, t.motif, t.avantNature, t.apresNature]), [['MODIFICATION', 'Correction du référentiel', 'CHARGE', 'ACTIF']]);
    });

    test('aperçu périmé après PATCH, motif invalide et jeton falsifié : aucune écriture du lot', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: '899853', libelle: 'Original', nature: 'CHARGE' } });
      const lignes = [{ code: '899854', libelle: 'Nouveau', nature: 'ACTIF' }, { code: compte.code, libelle: 'Import', nature: 'ACTIF' }];
      const url = '/api/comptabilite/importer';
      const envoyer = body => request(app).post(url).set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', lignes, ...body });
      const apercu = await envoyer({ phase: 'apercu' });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      for (const motif of [undefined, 'ab', '\u200B'.repeat(3)]) {
        const refus = await envoyer({ phase: 'confirmer', motif, apercuId: apercu.body.apercuId });
        assert.equal(refus.status, 400, JSON.stringify(refus.body));
      }
      assert.equal((await envoyer({ phase: 'confirmer', motif: 'Motif valable', apercuId: apercu.body.apercuId + 'x' })).status, 409);
      const patch = await request(app).patch(`/api/comptabilite/comptes/${compte.id}`).set('Authorization', `Bearer ${session}`).send({ libelle: 'Intermédiaire', motif: 'Autre éditeur', expectedUpdatedAt: compte.updatedAt.toISOString() });
      assert.equal(patch.status, 200, JSON.stringify(patch.body));
      const refuse = await envoyer({ phase: 'confirmer', motif: 'Motif valable', apercuId: apercu.body.apercuId });
      assert.equal(refuse.status, 409, JSON.stringify(refuse.body));
      assert.equal(await prisma.compteComptable.count({ where: { code: '899854' } }), 0);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Intermédiaire');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 1);
    });

    test('aperçu lié au fichier : substitution des lignes rejetée sans création ni journal', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: '899863', libelle: 'Original', nature: 'CHARGE' } });
      const lignes = [{ code: '899864', libelle: 'Création', nature: 'CHARGE' }, { code: compte.code, libelle: 'Révision', nature: 'CHARGE' }];
      const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', ...body });
      const apercu = await envoyer({ phase: 'apercu', lignes });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      const substitution = await envoyer({ phase: 'confirmer', lignes: [{ ...lignes[0], libelle: 'Substitué' }, lignes[1]], motif: 'Correction motivée', apercuId: apercu.body.apercuId });
      assert.equal(substitution.status, 409, JSON.stringify(substitution.body));
      assert.equal(await prisma.compteComptable.count({ where: { code: '899864' } }), 0);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Original');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    test('aperçu réservé à son auteur : autre administrateur refusé sans effet', async () => {
      const admin = await prisma.user.create({ data: { email: 'comptabilite.import.autre.admin@iris.test', name: 'TEST Autre admin import', role: 'ADMIN' } });
      const lignes = [{ code: '899865', libelle: 'À créer', nature: 'CHARGE' }];
      const envoyer = token => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${token}`);
      const apercu = await envoyer(session).send({ mode: 'mettre_a_jour', phase: 'apercu', lignes });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      const refus = await envoyer(jwt.sign({ id: admin.id }, process.env.JWT_SECRET)).send({ mode: 'mettre_a_jour', phase: 'confirmer', lignes, motif: 'Correction motivée', apercuId: apercu.body.apercuId });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.equal(await prisma.compteComptable.count({ where: { code: lignes[0].code } }), 0);
      assert.equal(await prisma.journalCompteComptable.count({ where: { auteurId: admin.id } }), 0);
    });

    test('aperçu expiré après dix minutes : horloge restaurée même en cas d’échec', async () => {
      const lignes = [{ code: '899866', libelle: 'À créer', nature: 'CHARGE' }];
      const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', lignes, ...body });
      const apercu = await envoyer({ phase: 'apercu' });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      const horloge = Date.now;
      try {
        Date.now = () => horloge() + 10 * 60_000 + 1_000;
        const refus = await envoyer({ phase: 'confirmer', motif: 'Correction motivée', apercuId: apercu.body.apercuId });
        assert.equal(refus.status, 409, JSON.stringify(refus.body));
        assert.match(refus.body.error, /périmé/i);
      } finally { Date.now = horloge; }
      assert.equal(await prisma.compteComptable.count({ where: { code: lignes[0].code } }), 0);
    });

    test('signature HMAC de l’ancien domaine rejetée, vraie signature acceptée', async () => {
      const lignes = [{ code: '899867', libelle: 'À créer', nature: 'CHARGE' }];
      const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', lignes, ...body });
      const apercu = await envoyer({ phase: 'apercu' });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      const [contenu] = apercu.body.apercuId.split('.');
      const signatureAncienne = createHmac('sha256', process.env.JWT_SECRET).update(contenu).digest('base64url');
      const refus = await envoyer({ phase: 'confirmer', motif: 'Correction motivée', apercuId: `${contenu}.${signatureAncienne}` });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.equal(await prisma.compteComptable.count({ where: { code: lignes[0].code } }), 0);
      const succes = await envoyer({ phase: 'confirmer', motif: 'Correction motivée', apercuId: apercu.body.apercuId });
      assert.equal(succes.status, 200, JSON.stringify(succes.body));
      assert.equal(await prisma.compteComptable.count({ where: { code: lignes[0].code } }), 1);
    });

    test('remappage comptable après aperçu : 409 sans écriture du lot', async () => {
      const source = await prisma.compteComptable.create({ data: { code: '899868', libelle: 'Source', nature: 'PRODUIT' } });
      const cible = await prisma.compteComptable.create({ data: { code: '899869', libelle: 'Cible', nature: 'PRODUIT' } });
      const lignes = [{ code: '899870', libelle: 'Ne pas créer', nature: 'CHARGE' }, { code: source.code, libelle: 'Révisé', nature: 'PRODUIT' }];
      const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', lignes, ...body });
      const regle = '/api/comptabilite/regles/VENTE_ARTICLE';
      assert.equal((await request(app).put(regle).set('Authorization', `Bearer ${session}`).send({ compteId: source.id })).status, 200);
      const apercu = await envoyer({ phase: 'apercu' });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      assert.equal((await request(app).put(regle).set('Authorization', `Bearer ${session}`).send({ compteId: cible.id })).status, 200);
      const refus = await envoyer({ phase: 'confirmer', motif: 'Correction motivée', apercuId: apercu.body.apercuId });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.equal(await prisma.compteComptable.count({ where: { code: lignes[0].code } }), 0);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: source.id } })).libelle, 'Source');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: source.id } }), 0);
    });

    test('remappage TVA après aperçu : 409 sans écriture du lot', async () => {
      const source = await prisma.compteComptable.create({ data: { code: '899871', libelle: 'TVA source', nature: 'TVA' } });
      const cible = await prisma.compteComptable.create({ data: { code: '899872', libelle: 'TVA cible', nature: 'TVA' } });
      const lignes = [{ code: '899873', libelle: 'Ne pas créer', nature: 'CHARGE' }, { code: source.code, libelle: 'Révisé', nature: 'TVA' }];
      const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', lignes, ...body });
      const regle = '/api/comptabilite/tva/20';
      assert.equal((await request(app).put(regle).set('Authorization', `Bearer ${session}`).send({ compteId: source.id })).status, 200);
      const apercu = await envoyer({ phase: 'apercu' });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      assert.equal((await request(app).put(regle).set('Authorization', `Bearer ${session}`).send({ compteId: cible.id })).status, 200);
      const refus = await envoyer({ phase: 'confirmer', motif: 'Correction motivée', apercuId: apercu.body.apercuId });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.equal(await prisma.compteComptable.count({ where: { code: lignes[0].code } }), 0);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: source.id } })).libelle, 'TVA source');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: source.id } }), 0);
    });

    test('modes et phases inconnus refusés atomiquement', async () => {
      const lignes = [{ code: '899874', libelle: 'Ne pas créer', nature: 'CHARGE' }];
      const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ lignes, ...body });
      for (const body of [{ mode: 'inconnu' }, { mode: 'mettre_a_jour', phase: 'inconnue' }, { mode: 'mettre_a_jour' }, { phase: 'apercu' }]) {
        const refus = await envoyer(body);
        assert.equal(refus.status, 400, JSON.stringify({ body, reponse: refus.body }));
        assert.equal(await prisma.compteComptable.count({ where: { code: lignes[0].code } }), 0);
      }
    });

    test('mise à jour CSV refuse les inactifs et natures liées à des règles sans effet partiel', async () => {
      const inactif = await prisma.compteComptable.create({ data: { code: '899855', libelle: 'Inactif', nature: 'CHARGE', actif: false } });
      const lie = await prisma.compteComptable.create({ data: { code: '899856', libelle: 'Vente', nature: 'PRODUIT' } });
      await prisma.regleComptable.upsert({ where: { cle: 'VENTE_ARTICLE' }, create: { cle: 'VENTE_ARTICLE', compteId: lie.id }, update: { compteId: lie.id } });
      const url = '/api/comptabilite/importer';
      for (const [compte, attendu] of [[inactif, /inactif/], [lie, /nature incompatible/i]]) {
        const reponse = await request(app).post(url).set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', phase: 'apercu', lignes: [{ code: '899857', libelle: 'Ne pas créer', nature: 'CHARGE' }, { code: compte.code, libelle: 'Changé', nature: 'ACTIF' }] });
        assert.equal(reponse.status, 409, JSON.stringify(reponse.body));
        assert.deepEqual(reponse.body.erreurs.map(e => e.ligne), [2]);
        assert.match(reponse.body.erreurs[0].erreur, attendu);
      }
      assert.equal(await prisma.compteComptable.count({ where: { code: '899857' } }), 0);
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: { in: [inactif.id, lie.id] } } }), 0);
    });

    test('mise à jour CSV annule les modifications si le journal du lot échoue', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: '899858', libelle: 'Original', nature: 'CHARGE' } });
      const lignes = [{ code: '899859', libelle: 'Création', nature: 'CHARGE' }, { code: compte.code, libelle: 'Corrigé', nature: 'CHARGE' }];
      const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', lignes, ...body });
      const apercu = await envoyer({ phase: 'apercu' });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" ADD CONSTRAINT "journal_test_refus_insertion" CHECK ("motif" <> \'TEST refus atomique\')');
      try {
        const reponse = await envoyer({ phase: 'confirmer', motif: 'TEST refus atomique', apercuId: apercu.body.apercuId });
        assert.equal(reponse.status, 500, JSON.stringify(reponse.body));
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" DROP CONSTRAINT "journal_test_refus_insertion"');
      }
      assert.equal(await prisma.compteComptable.count({ where: { code: '899859' } }), 0);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Original');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    test('confirmation attend le verrou global puis refuse un aperçu devenu périmé', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: '899860', libelle: 'Original', nature: 'CHARGE' } });
      const lignes = [{ code: compte.code, libelle: 'Import', nature: 'ACTIF' }];
      const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', lignes, ...body });
      const apercu = await envoyer({ phase: 'apercu' });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      let liberer;
      const barriere = new Promise(resolve => { liberer = resolve; });
      let verrouPris;
      const signal = new Promise(resolve => { verrouPris = resolve; });
      const concurrent = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(814086)::text`;
        verrouPris();
        await barriere;
        await tx.compteComptable.update({ where: { id: compte.id }, data: { actif: false } });
      });
      await signal;
      const requete = envoyer({ phase: 'confirmer', motif: 'Correction motivée', apercuId: apercu.body.apercuId }).then(reponse => reponse);
      let attenteObservee = false;
      try {
        for (let i = 0; i < 40; i++) {
          const activites = await prisma.$queryRaw`SELECT "wait_event" FROM pg_stat_activity WHERE "wait_event" = 'advisory'`;
          if (activites.length) { attenteObservee = true; break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } finally { liberer(); await concurrent; }
      const refus = await requete;
      assert.equal(attenteObservee, true, 'la confirmation doit attendre le verrou du périmètre');
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).actif, false);
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    for (const ordre of ['creation', 'confirmation']) {
      test(`course création / confirmation CSV : ${ordre} prend le verrou en premier`, async () => {
        const code = ordre === 'creation' ? '899861' : '899862';
        const lignes = [{ code, libelle: 'Import CSV', nature: 'CHARGE' }];
        const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', lignes, ...body });
        const apercu = await envoyer({ phase: 'apercu' });
        assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
        const creer = () => request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code, libelle: 'Création unitaire', nature: 'CHARGE' }).then(r => r);
        const confirmer = () => envoyer({ phase: 'confirmer', motif: 'Correction motivée', apercuId: apercu.body.apercuId }).then(r => r);
        let liberer, verrouPris;
        const barriere = new Promise(resolve => { liberer = resolve; });
        const signal = new Promise(resolve => { verrouPris = resolve; });
        const verrou = prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(814086)::text`;
          verrouPris();
          await barriere;
        });
        await signal;
        const premier = ordre === 'creation' ? creer() : confirmer();
        const attendre = async (nombre) => {
          for (let i = 0; i < 80; i++) {
            const activites = await prisma.$queryRaw`SELECT "pid" FROM pg_stat_activity WHERE "wait_event" = 'advisory'`;
            if (activites.length >= nombre) return;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          assert.fail(`${nombre} requête(s) attendue(s) sur le verrou comptable`);
        };
        let second;
        try {
          await attendre(1);
          second = ordre === 'creation' ? confirmer() : creer();
          await attendre(2);
        } finally { liberer(); await verrou; }
        const [reponsePremier, reponseSecond] = await Promise.all([premier, second]);
        assert.equal(reponsePremier.status, ordre === 'creation' ? 201 : 200, JSON.stringify(reponsePremier.body));
        assert.equal(reponseSecond.status, 409, JSON.stringify(reponseSecond.body));
        const compte = await prisma.compteComptable.findUniqueOrThrow({ where: { code } });
        assert.equal(compte.libelle, ordre === 'creation' ? 'Création unitaire' : 'Import CSV');
        assert.equal(await prisma.compteComptable.count({ where: { code } }), 1);
      });
    }

    test('importe un plan comptable contrôlé ligne par ligne', async () => {
      const importation = await request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ lignes: [{ code: '411000', libelle: 'Clients', nature: 'ACTIF' }, { code: '445710', libelle: 'TVA collectée', nature: 'TVA' }] });
      assert.equal(importation.status, 201, JSON.stringify(importation.body));
      assert.equal(importation.body.importes, 2);
    });

    test('refuse les caractères de contrôle dans un compte créé directement, sans écriture', async () => {
      for (const [index, libelle] of ['Clients\nFrance', 'Clients\tFrance', 'Clients\rFrance', 'Clients\u0000France', 'Clients\u007fFrance', 'Clients\t'].entries()) {
        const code = String(899970 + index);
        const reponse = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code, libelle, nature: 'ACTIF' });
        assert.equal(reponse.status, 400, JSON.stringify(reponse.body));
        assert.equal(await prisma.compteComptable.count({ where: { code } }), 0);
      }
    });

    test('refuse un lot avec libellé contenant retour ou tabulation sans écriture partielle', async () => {
      for (const [index, libelle] of ['Clients\nFrance', 'Clients\tFrance', 'Clients\rFrance', 'Clients\u0000France', 'Clients\u007fFrance', 'Clients\t'].entries()) {
        const code = String(899980 + index * 2);
        const reponse = await request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ lignes: [
          { code, libelle: 'Valide', nature: 'ACTIF' },
          { code: String(Number(code) + 1), libelle, nature: 'ACTIF' },
        ] });
        assert.equal(reponse.status, 400, JSON.stringify(reponse.body));
        assert.deepEqual(reponse.body.erreurs.map(({ ligne }) => ligne), [2]);
        assert.equal(await prisma.compteComptable.count({ where: { code: { in: [code, String(Number(code) + 1)] } } }), 0);
      }
    });

    test('importe 5 000 comptes au-delà des 100 Ko par défaut et réimporte sans doublons', async () => {
      const lignes = Array.from({ length: 5000 }, (_, index) => ({ code: String(800000 + index), libelle: `Compte de test ${index} ${'x'.repeat(65)}`, nature: 'CHARGE' }));
      assert.ok(Buffer.byteLength(JSON.stringify({ lignes })) > 100 * 1024);
      const importer = () => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ lignes });
      const premier = await importer();
      assert.equal(premier.status, 201, JSON.stringify(premier.body));
      assert.equal(premier.body.importes, lignes.length);
      const second = await importer();
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.equal(second.body.ignores, lignes.length);
    });

    test('refuse en JSON un corps de plus de 5 Mo sans écrire de compte', async () => {
      const reponse = await request(app).post('/api/comptabilite/importer').set('Content-Type', 'application/json')
        .send(JSON.stringify({ lignes: [{ code: '899990', libelle: 'X'.repeat(5 * 1024 * 1024), nature: 'ACTIF' }] }));
      assert.equal(reponse.status, 413);
      assert.match(reponse.headers['content-type'], /application\/json/);
      assert.match(reponse.body.error, /volumineux|taille/i);
      assert.equal(await prisma.compteComptable.count({ where: { code: '899990' } }), 0);
    });

    test('refuse 409 et annule tout le lot si un code existant diffère', async () => {
      const lignes = [{ code: '899991', libelle: 'Nouveau', nature: 'ACTIF' }, { code: '411000', libelle: 'Autre libellé', nature: 'PASSIF' }];
      const reponse = await request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ lignes });
      assert.equal(reponse.status, 409, JSON.stringify(reponse.body));
      assert.deepEqual(reponse.body.erreurs.map(({ ligne }) => ligne), [2]);
      assert.equal(await prisma.compteComptable.count({ where: { code: '899991' } }), 0);
      assert.equal((await prisma.compteComptable.findUnique({ where: { code: '411000' } })).libelle, 'Clients');
    });

    test('deux imports concurrents divergents ne peuvent pas masquer un conflit', async () => {
      const envoyer = (libelle) => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`)
        .send({ lignes: [{ code: '899992', libelle, nature: 'ACTIF' }] });
      const reponses = await Promise.all([envoyer('Premier'), envoyer('Second')]);
      assert.deepEqual(reponses.map(reponse => reponse.status).sort(), [201, 409], reponses.map(reponse => JSON.stringify(reponse.body)).join(' / '));
      assert.equal(await prisma.compteComptable.count({ where: { code: '899992' } }), 1);
    });

    test('réserve factures et comptabilité à l’administration', async () => {
      const conducteur = await prisma.user.create({ data: { email: 'facture.conducteur@iris.test', name: 'TEST Conducteur facture', role: 'CONDUCTEUR_TRAVAUX' } });
      const token = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const routes = [() => request(app).get('/api/factures'), () => request(app).post('/api/factures').send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] }), () => request(app).get('/api/factures/export-comptable.csv'), () => request(app).get('/api/facturation/prete-a-facturer'), () => request(app).get('/api/comptabilite'), () => request(app).post('/api/comptabilite/comptes').send({ code: '999999', libelle: 'TEST interdit', nature: 'PRODUIT' }), () => request(app).post('/api/comptabilite/importer').send({ lignes: [{ code: '999998', libelle: 'TEST interdit', nature: 'PRODUIT' }] }), () => request(app).post('/api/factures/inexistante/emettre'), () => request(app).post('/api/factures/inexistante/regler'), () => request(app).post('/api/factures/inexistante/annuler'), () => request(app).put('/api/comptabilite/regles/CLIENT').send({ compteId: 'peu-importe' }), () => request(app).put('/api/comptabilite/tva/20').send({ compteId: 'peu-importe' })];
      for (const route of routes) assert.equal((await route().set('Authorization', `Bearer ${token}`)).status, 403);
    });

    test('refuse une date d’émission future', async () => {
      const reponse = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '01-01-2099', dateEcheance: '01-02-2099', lignes: [{ designation: 'TEST future', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(reponse.status, 400); assert.match(reponse.body.error, /future/i);
    });

    test('crée une version légale brouillon distincte', async () => {
      const reponse = await request(app).post('/api/mentions-legales').set('Authorization', `Bearer ${session}`).send({ mentions: 'TEST Mentions version 2', cgv: 'TEST CGV version 2', penalites: 'TEST Pénalités version 2', escompte: 'Sans escompte' });
      assert.equal(reponse.status, 201, JSON.stringify(reponse.body));
      assert.equal(reponse.body.version, 2);
      assert.equal(reponse.body.actif, false);
    });

    test('publie une version légale et remplace l’active', async () => {
      const reponse = await request(app).post('/api/mentions-legales/2/publier').set('Authorization', `Bearer ${session}`);
      assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
      assert.equal(reponse.body.actif, true);
      assert.ok(reponse.body.publieeLe);
      const versions = await request(app).get('/api/mentions-legales').set('Authorization', `Bearer ${session}`);
      assert.equal(versions.body.filter((version) => version.actif).length, 1);
      assert.equal(versions.body.find((version) => version.actif)?.version, 2);
    });

    test('interdit de modifier le contenu d’une version publiée', async () => {
      await assert.rejects(() => prisma.mentionsLegalesVersion.update({ where: { version: 2 }, data: { cgv: 'TEST tentative de modification interdite' } }));
      const version = await prisma.mentionsLegalesVersion.findUnique({ where: { version: 2 } });
      assert.equal(version.cgv, 'TEST CGV version 2');
    });

    test('liste les versions légales pour l’administration', async () => {
      const reponse = await request(app).get('/api/mentions-legales').set('Authorization', `Bearer ${session}`);
      assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
      assert.equal(reponse.body.length, 2);
      assert.equal(reponse.body.find((version) => version.actif)?.version, 2);
    });

    test('refuse l’émission sans mentions légales publiées', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Facture en attente de paramétrage', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST mentions absentes', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      await prisma.mentionsLegalesVersion.deleteMany({});
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 409, JSON.stringify(emission.body));
      await prisma.mentionsLegalesVersion.create({ data: { version: 1, mentions: 'TEST Mentions légales', cgv: 'TEST Conditions générales', penalites: 'TEST Pénalités de retard', actif: true, publieeLe: new Date() } });
    });

    test('refuse une imputation incomplète à l’émission sans consommer de numéro', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST compte requis', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST compte requis', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201);
      const avant = await prisma.sequenceFacture.findUnique({ where: { annee: 2026 } });
      const refus = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.match(refus.body.error, /comptable/i);
      assert.equal((await prisma.facture.findUnique({ where: { id: brouillon.body.id } })).numero, null);
      assert.deepEqual(await prisma.sequenceFacture.findUnique({ where: { annee: 2026 } }), avant);
      const compte = async code => (await prisma.compteComptable.findUnique({ where: { code } })).id;
      for (const [cle, code] of [['CLIENT', '411000'], ['VENTE_PRESTATION', '706100'], ['VENTE_ARTICLE', '706100']]) {
        assert.equal((await request(app).put(`/api/comptabilite/regles/${cle}`).set('Authorization', `Bearer ${session}`).send({ compteId: await compte(code) })).status, 200);
      }
      assert.equal((await request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', `Bearer ${session}`).send({ journal: 'VTE' })).status, 200);
      assert.equal((await request(app).put('/api/comptabilite/tva/20').set('Authorization', `Bearer ${session}`).send({ compteId: await compte('445710') })).status, 200);
      assert.equal((await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
    });

    test('refuse à l’émission un taux de TVA sans compte, sans consommer de séquence', async () => {
      const compteTva = await prisma.compteComptable.findUniqueOrThrow({ where: { code: '445710' } });
      assert.equal((await request(app).put('/api/comptabilite/tva/5.5').set('Authorization', `Bearer ${session}`).send({ compteId: compteTva.id })).status, 200);
      const mapping55 = (await request(app).get('/api/comptabilite').set('Authorization', `Bearer ${session}`)).body.reglesTva.find(r => r.taux === 5.5);
      assert.equal((await request(app).delete('/api/comptabilite/tva/5.5').set('Authorization', `Bearer ${session}`).send({ confirmation: '5.5', expectedCompteId: mapping55.compteId, expectedUpdatedAt: mapping55.updatedAt })).status, 204);
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST TVA absente', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST taux réduit', quantite: 1, prixUnitaireHt: 9, tauxTva: 5.5 }] });
      assert.equal(brouillon.status, 201);
      const avant = await prisma.sequenceFacture.findUniqueOrThrow({ where: { annee: 2026 } });
      const refus = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.match(refus.body.error, /TVA:5\.5/);
      assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: brouillon.body.id } })).numero, null);
      assert.deepEqual(await prisma.sequenceFacture.findUniqueOrThrow({ where: { annee: 2026 } }), avant);
    });

    test('exige VENTE_ARTICLE même pour une facture sans ligne article', async () => {
      const article = await prisma.compteComptable.findUniqueOrThrow({ where: { code: '706100' } });
      await prisma.regleComptable.upsert({ where: { cle: 'VENTE_ARTICLE' }, create: { cle: 'VENTE_ARTICLE', compteId: article.id }, update: { compteId: article.id } });
      const regle = await prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'VENTE_ARTICLE' } });
      await prisma.regleComptable.delete({ where: { cle: 'VENTE_ARTICLE' } });
      try {
        const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST règle article obligatoire', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST prestation', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
        assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
        const refus = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
        assert.equal(refus.status, 409, JSON.stringify(refus.body));
        assert.match(refus.body.error, /VENTE_ARTICLE/);
        assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: brouillon.body.id } })).numero, null);
      } finally {
        await prisma.regleComptable.create({ data: { cle: regle.cle, compteId: regle.compteId, journal: regle.journal } });
      }
    });

    test('attribue un numéro annuel seulement lors de l’émission', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST Émission facture', quantite: 1, prixUnitaireHt: 50, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      assert.equal(emission.body.statut, 'EMISE');
      assert.equal(emission.body.mentionsLegalesVersion?.version, 1);
      assert.equal(emission.body.mentionsLegalesVersion?.mentions, 'TEST Mentions légales');
      const journalFacture = await request(app).get(`/api/factures/${brouillon.body.id}/journal`).set('Authorization', `Bearer ${session}`);
      assert.equal(journalFacture.status, 200, JSON.stringify(journalFacture.body));
      assert.deepEqual(journalFacture.body.map((entree) => entree.action), ['CREATION_BROUILLON', 'EMISSION']);
      await assert.rejects(() => prisma.facture.update({ where: { id: brouillon.body.id }, data: { motifHorsAffaire: 'TEST tentative de modification' } }));
      assert.match(emission.body.numero, /\d{4}/, 'Une facture émise porte une numérotation annuelle.');
      const reemission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(reemission.status, 409, JSON.stringify(reemission.body));
      assert.equal((await prisma.facture.findUnique({ where: { id: brouillon.body.id } })).numero, emission.body.numero);
      const configuration = await request(app).get('/api/comptabilite').set('Authorization', `Bearer ${session}`);
      assert.equal(configuration.status, 200, JSON.stringify(configuration.body));
      const compte = (code) => configuration.body.comptes.find((c) => c.code === code);
      await Promise.all([
        request(app).put('/api/comptabilite/regles/CLIENT').set('Authorization', `Bearer ${session}`).send({ compteId: compte('411000').id }),
        request(app).put('/api/comptabilite/regles/TVA_COLLECTEE').set('Authorization', `Bearer ${session}`).send({ compteId: compte('445710').id }),
        request(app).put('/api/comptabilite/tva/20').set('Authorization', `Bearer ${session}`).send({ compteId: compte('445710').id }),
        request(app).put('/api/comptabilite/regles/VENTE_PRESTATION').set('Authorization', `Bearer ${session}`).send({ compteId: compte('706100').id }),
        request(app).put('/api/comptabilite/regles/VENTE_ARTICLE').set('Authorization', `Bearer ${session}`).send({ compteId: compte('706100').id }),
        request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', `Bearer ${session}`).send({ journal: 'VTE' }),
      ]);
      await Promise.all([
        request(app).put('/api/comptabilite/regles/CLIENT').set('Authorization', `Bearer ${session}`).send({ compteId: compte('706100').id }).then(r => assert.equal(r.status, 400)),
        request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', `Bearer ${session}`).send({ journal: 'X'.repeat(300) }).then(r => assert.equal(r.status, 400)),
      ]);
      const exportComptable = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportComptable.status, 200, exportComptable.text);
      assert.match(exportComptable.text, /JournalCode;EcritureDate/);
      assert.match(exportComptable.text, /706100/);
      const lignesPiece = exportComptable.text.split('\n').filter(ligne => ligne.includes(emission.body.numero));
      const montant = (ligne, index) => Number(ligne.split(';')[index].replace(/"/g, ''));
      assert.equal(lignesPiece.reduce((somme, ligne) => somme + montant(ligne, 6), 0).toFixed(2), lignesPiece.reduce((somme, ligne) => somme + montant(ligne, 7), 0).toFixed(2));
      assert.ok(exportComptable.text.split('\n').some(ligne => ligne.includes('445710')), 'une ligne de TVA doit être exportée');
      const journal = await prisma.regleComptable.findUnique({ where: { cle: 'JOURNAL_VENTES' } });
      await prisma.regleComptable.delete({ where: { cle: 'JOURNAL_VENTES' } });
      const exportIncomplet = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportIncomplet.status, 200);
      assert.equal(exportIncomplet.text, exportComptable.text, 'retirer le journal courant ne réécrit pas les pièces émises');
      await prisma.regleComptable.create({ data: { cle: 'JOURNAL_VENTES', journal: journal.journal } });
      const mapping20 = (await request(app).get('/api/comptabilite').set('Authorization', `Bearer ${session}`)).body.reglesTva.find(r => r.taux === 20);
      assert.equal((await request(app).delete('/api/comptabilite/tva/20').set('Authorization', `Bearer ${session}`).send({ confirmation: '20', expectedCompteId: mapping20.compteId, expectedUpdatedAt: mapping20.updatedAt })).status, 204);
      const exportSansTva = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportSansTva.status, 200); assert.equal(exportSansTva.text, exportComptable.text);
      assert.equal((await request(app).put('/api/comptabilite/tva/5.5').set('Authorization', `Bearer ${session}`).send({ compteId: compte('445710').id })).status, 200);
      const diagSansTva = await request(app).get('/api/facturation/prete-a-facturer').set('Authorization', `Bearer ${session}`);
      const tvaDecouverte = diagSansTva.body.controles.find((controle) => controle.cle === 'TVA');
      assert.equal(tvaDecouverte.pret, false, JSON.stringify(tvaDecouverte));
      assert.equal(tvaDecouverte.bloquant, true, 'Un taux historique sans compte signale un risque pour les nouvelles émissions de ce taux.');
      assert.match(tvaDecouverte.detail, /20 %/);
      assert.match(tvaDecouverte.detail, /émission.*refusée/i);
      assert.doesNotMatch(tvaDecouverte.detail, /export.*refusé/i);
      assert.equal(diagSansTva.body.pret, false, JSON.stringify(diagSansTva.body.controles));
      await prisma.regleTvaComptable.deleteMany({ where: { taux: 5.5 } });
      await request(app).put('/api/comptabilite/tva/20').set('Authorization', `Bearer ${session}`).send({ compteId: compte('445710').id });
      const diagAvecTva = await request(app).get('/api/facturation/prete-a-facturer').set('Authorization', `Bearer ${session}`);
      const tvaCouverte = diagAvecTva.body.controles.find((controle) => controle.cle === 'TVA');
      assert.equal(tvaCouverte.pret, true, JSON.stringify(tvaCouverte)); assert.equal(tvaCouverte.bloquant, false);
      await prisma.client.update({ where: { id: clientId }, data: { raisonSociale: 'TEST Client contrat maintenance renommé' } });
      const exportFige = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportFige.status, 200); assert.match(exportFige.text, /TEST Client contrat maintenance/); assert.doesNotMatch(exportFige.text, /renommé/);
      await prisma.client.update({ where: { id: clientId }, data: { raisonSociale: 'TEST Client contrat maintenance' } });
      const piege = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code: '707999', libelle: '=1+1', nature: 'PRODUIT' }); assert.equal(piege.status, 201);
      await request(app).put('/api/comptabilite/regles/VENTE_ARTICLE').set('Authorization', `Bearer ${session}`).send({ compteId: piege.body.id });
      const article = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST article CSV', nature: 'ARTICLE', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      const articleEmis = await request(app).post(`/api/factures/${article.body.id}/emettre`).set('Authorization', `Bearer ${session}`); const csvPiege = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(articleEmis.status, 200); assert.match(csvPiege.text, /;"'=1\+1";/);
    });

    test('fige les écritures à l’émission malgré un remappage puis inverse celles des avoirs', async () => {
      const exporter = () => request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      const creer = (designation) => request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST gel imputation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation, nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] });
      const emettre = id => request(app).post(`/api/factures/${id}/emettre`).set('Authorization', `Bearer ${session}`);
      const piece = (csv, numero) => csv.split('\n').filter(ligne => ligne.split(';')[2] === `"${numero}"`);
      const premier = await creer('TEST gel premier');
      assert.equal(premier.status, 201);
      const emis = await emettre(premier.body.id);
      assert.equal(emis.status, 200, JSON.stringify(emis.body));
      assert.equal(emis.body.ecrituresScellees, true, 'la réponse d’émission reflète le scellement commité');
      const numeroAvantRefus = await prisma.sequenceAvoir.findFirst({ orderBy: { annee: 'desc' } });
      const avoirNatureAbsente = await request(app).post(`/api/factures/${premier.body.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({ lignes: [{ designation: 'TEST article absent de la source', nature: 'ARTICLE', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(avoirNatureAbsente.status, 409, JSON.stringify(avoirNatureAbsente.body));
      assert.match(avoirNatureAbsente.body.error, /nature ou un taux absent de la facture d’origine.*VENTE_ARTICLE/i);
      assert.doesNotMatch(avoirNatureAbsente.body.error, /paramétrage comptable incomplet/i);
      assert.equal(await prisma.facture.count({ where: { factureOrigineId: premier.body.id } }), 0);
      assert.deepEqual(await prisma.sequenceAvoir.findFirst({ orderBy: { annee: 'desc' } }), numeroAvantRefus);
      const avant = piece((await exporter()).text, emis.body.numero);
      assert.equal(avant.length, 3);
      const nouveauCompte = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code: '706986', libelle: 'Nouveau compte de ventes', nature: 'PRODUIT' });
      assert.equal(nouveauCompte.status, 201);
      assert.equal((await request(app).put('/api/comptabilite/regles/VENTE_PRESTATION').set('Authorization', `Bearer ${session}`).send({ compteId: nouveauCompte.body.id })).status, 200);
      const nouveauClient = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code: '411986', libelle: 'Nouveau compte client', nature: 'ACTIF' });
      const nouvelleTva = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code: '445986', libelle: 'Nouveau compte TVA', nature: 'TVA' });
      assert.equal(nouveauClient.status, 201);
      assert.equal(nouvelleTva.status, 201);
      assert.equal((await request(app).put('/api/comptabilite/regles/CLIENT').set('Authorization', `Bearer ${session}`).send({ compteId: nouveauClient.body.id })).status, 200);
      assert.equal((await request(app).put('/api/comptabilite/tva/20').set('Authorization', `Bearer ${session}`).send({ compteId: nouvelleTva.body.id })).status, 200);
      assert.equal((await request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', `Bearer ${session}`).send({ journal: 'NOUV' })).status, 200);
      const apres = piece((await exporter()).text, emis.body.numero);
      assert.deepEqual(apres, avant, 'les octets historiques ne dépendent plus des comptes client/vente/TVA ni du journal');
      const compteHistorique = await prisma.compteComptable.findUniqueOrThrow({ where: { code: '706100' } });
      const patchHistorique = await request(app).patch(`/api/comptabilite/comptes/${compteHistorique.id}`).set('Authorization', `Bearer ${session}`).send({ libelle: 'Libellé changé après émission', motif: 'Rectification motivée', expectedUpdatedAt: compteHistorique.updatedAt.toISOString() });
      assert.equal(patchHistorique.status, 200, JSON.stringify(patchHistorique.body));
      try {
        assert.deepEqual(piece((await exporter()).text, emis.body.numero), avant, 'CompteLib est également figé');
      } finally {
        const restauration = await request(app).patch(`/api/comptabilite/comptes/${compteHistorique.id}`).set('Authorization', `Bearer ${session}`).send({ libelle: compteHistorique.libelle, motif: 'Restauration du référentiel de test', expectedUpdatedAt: patchHistorique.body.updatedAt });
        assert.equal(restauration.status, 200, JSON.stringify(restauration.body));
      }
      const patchNouveau = await request(app).patch(`/api/comptabilite/comptes/${nouveauCompte.body.id}`).set('Authorization', `Bearer ${session}`).send({ libelle: 'Libellé neuf pour émissions futures', motif: 'Harmonisation du libellé', expectedUpdatedAt: nouveauCompte.body.updatedAt });
      assert.equal(patchNouveau.status, 200, JSON.stringify(patchNouveau.body));
      assert.deepEqual(piece((await exporter()).text, emis.body.numero), avant);
      const second = await creer('TEST gel second');
      const emisSecond = await emettre(second.body.id);
      assert.equal(emisSecond.status, 200, JSON.stringify(emisSecond.body));
      assert.ok(piece((await exporter()).text, emisSecond.body.numero).some(ligne => ligne.includes('706986')));
      assert.ok(piece((await exporter()).text, emisSecond.body.numero).some(ligne => ligne.includes('Libellé neuf pour émissions futures')));
      assert.ok(piece((await exporter()).text, emisSecond.body.numero).some(ligne => ligne.includes('411986')));
      assert.ok(piece((await exporter()).text, emisSecond.body.numero).some(ligne => ligne.includes('445986')));
      assert.ok(piece((await exporter()).text, emisSecond.body.numero).every(ligne => ligne.startsWith('"NOUV";')));
      const avoir = await request(app).post(`/api/factures/${premier.body.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({ lignes: [{ designation: 'TEST crédit', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 40, tauxTva: 20 }] });
      assert.equal(avoir.status, 201, JSON.stringify(avoir.body));
      assert.equal(avoir.body.ecrituresScellees, true, 'la réponse de l’avoir partiel reflète le scellement');
      const lignesAvoir = piece((await exporter()).text, avoir.body.numero);
      assert.equal(lignesAvoir.length, 3);
      assert.ok(lignesAvoir.some(ligne => ligne.includes('706100') && ligne.includes('"40.00"')));
      assert.ok(lignesAvoir.every(ligne => !ligne.includes('706986') && !ligne.includes('411986') && !ligne.includes('445986')));
      assert.ok(lignesAvoir.every(ligne => ligne.startsWith('"VTE";')));
      const originalClient = await prisma.compteComptable.findUniqueOrThrow({ where: { code: '411000' } });
      const originalTva = await prisma.compteComptable.findUniqueOrThrow({ where: { code: '445710' } });
      for (const [cle, id] of [['CLIENT', originalClient.id], ['VENTE_PRESTATION', compteHistorique.id]]) {
        assert.equal((await request(app).put(`/api/comptabilite/regles/${cle}`).set('Authorization', `Bearer ${session}`).send({ compteId: id })).status, 200);
      }
      assert.equal((await request(app).put('/api/comptabilite/tva/20').set('Authorization', `Bearer ${session}`).send({ compteId: originalTva.id })).status, 200);
      assert.equal((await request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', `Bearer ${session}`).send({ journal: 'VTE' })).status, 200);
      const annulation = await request(app).post(`/api/factures/${second.body.id}/annuler`).set('Authorization', `Bearer ${session}`);
      assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
      assert.equal(annulation.body.avoir.ecrituresScellees, true, 'la réponse de l’avoir total reflète le scellement');
      const ecrituresSource = await prisma.ecritureFacture.findMany({ where: { factureId: second.body.id }, orderBy: { ordre: 'asc' } });
      const ecrituresAvoir = await prisma.ecritureFacture.findMany({ where: { factureId: annulation.body.avoir.id }, orderBy: { ordre: 'asc' } });
      assert.deepEqual(ecrituresAvoir.map(e => [e.journalCode, e.compteNum, e.compteLib, Number(e.debit), Number(e.credit)]),
        ecrituresSource.map(e => [e.journalCode, e.compteNum, e.compteLib, Number(e.credit), Number(e.debit)]));
      assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: annulation.body.avoir.id } })).ecrituresScellees, true);
    });

    test('sérialise émission et remappage du journal par verrou comptable commun', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST concurrence règles', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST verrou comptable', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201);
      const ancienJournal = (await prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'JOURNAL_VENTES' } })).journal;
      const clientCompteId = (await prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'CLIENT' } })).compteId;
      const tvaCompteId = (await prisma.regleTvaComptable.findUniqueOrThrow({ where: { taux: 20 } })).compteId;
      let course;
      try {
        await prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(814086)::text`;
          const emission = request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`).then(r => r);
          const remappage = request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', `Bearer ${session}`).send({ journal: 'NOUVEAU' }).then(r => r);
          const regleClient = request(app).put('/api/comptabilite/regles/CLIENT').set('Authorization', `Bearer ${session}`).send({ compteId: clientCompteId }).then(r => r);
          const regleTva = request(app).put('/api/comptabilite/tva/20').set('Authorization', `Bearer ${session}`).send({ compteId: tvaCompteId }).then(r => r);
          course = Promise.all([emission, remappage, regleClient, regleTva]);
          const attendre = p => Promise.race([p.then(() => 'TERMINE'), new Promise(resolve => setTimeout(() => resolve('EN_ATTENTE'), 150))]);
          for (const operation of [emission, remappage, regleClient, regleTva]) assert.equal(await attendre(operation), 'EN_ATTENTE', 'toutes les mutations et l’émission attendent le verrou comptable');
        });
        const [emission, remappage, client, tva] = await course;
        assert.equal(client.status, 200, JSON.stringify(client.body));
        assert.equal(tva.status, 200, JSON.stringify(tva.body));
        assert.equal(emission.status, 200, JSON.stringify(emission.body));
        assert.equal(remappage.status, 200, JSON.stringify(remappage.body));
        const lignes = await prisma.ecritureFacture.findMany({ where: { factureId: brouillon.body.id } });
        assert.equal(new Set(lignes.map(e => e.journalCode)).size, 1);
        assert.ok(['VTE', 'NOUVEAU'].includes(lignes[0].journalCode));
      } finally {
        await prisma.regleComptable.update({ where: { cle: 'JOURNAL_VENTES' }, data: { journal: ancienJournal } });
      }
    });

    test('la base refuse un INSERT tardif et une pièce émise déséquilibrée ou vide', async () => {
      const compte = async (code, nature) => (await prisma.compteComptable.upsert({ where: { code }, create: { code, nature, libelle: `TEST ${code}` }, update: { actif: true } })).id;
      for (const [cle, code, nature] of [['CLIENT', '411000', 'ACTIF'], ['VENTE_PRESTATION', '706100', 'PRODUIT'], ['VENTE_ARTICLE', '706100', 'PRODUIT']]) {
        await prisma.regleComptable.upsert({ where: { cle }, create: { cle, compteId: await compte(code, nature) }, update: { compteId: await compte(code, nature) } });
      }
      await prisma.regleComptable.upsert({ where: { cle: 'JOURNAL_VENTES' }, create: { cle: 'JOURNAL_VENTES', journal: 'VTE' }, update: { journal: 'VTE' } });
      await prisma.regleTvaComptable.upsert({ where: { taux: 20 }, create: { taux: 20, compteId: await compte('445710', 'TVA') }, update: { compteId: await compte('445710', 'TVA') } });
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST scellement SQL', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST scellement', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201);
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const original = await prisma.ecritureFacture.findFirstOrThrow({ where: { factureId: brouillon.body.id } });
      const vide = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST pièce sans écritures', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST vide', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(vide.status, 201);
      await assert.rejects(() => prisma.facture.update({ where: { id: vide.body.id }, data: { statut: 'EMISE', numero: `TEST-VIDE-${Date.now()}`, annee: 2026, ecrituresScellees: true } }), /absentes|déséquilibrées/i);
      assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: vide.body.id } })).statut, 'BROUILLON');
      await assert.rejects(() => prisma.facture.update({ where: { id: brouillon.body.id }, data: { ecrituresScellees: false } }), /scellée : retour interdit/i);
      assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: brouillon.body.id } })).ecrituresScellees, true);
      // 0/0 ne change pas l'équilibre : seul le trigger d'insertion interdit cette ligne parasite d'export.
      await assert.rejects(() => prisma.ecritureFacture.create({ data: { factureId: brouillon.body.id, ordre: 98, cle: 'CLIENT', journalCode: original.journalCode, compteNum: original.compteNum, compteLib: original.compteLib, debit: 0, credit: 0 } }), /scellée : insertion interdite/i);
      assert.equal(await prisma.ecritureFacture.count({ where: { factureId: brouillon.body.id } }), 3);
      await assert.rejects(() => prisma.ecritureFacture.create({ data: { factureId: brouillon.body.id, ordre: 99, cle: 'CLIENT', journalCode: original.journalCode, compteNum: original.compteNum, compteLib: original.compteLib, debit: 1, credit: 0 } }), /figée|scellée/i);
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" DISABLE TRIGGER "ecriture_facture_immutable"');
      try {
        await assert.rejects(() => prisma.$transaction(async tx => {
          await tx.ecritureFacture.delete({ where: { id: original.id } });
        }), /équilibr|scellée/i);
        assert.equal(await prisma.ecritureFacture.count({ where: { factureId: brouillon.body.id } }), 3);
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" ENABLE TRIGGER "ecriture_facture_immutable"');
      }
    });

    test('la base refuse UPDATE et DELETE des écritures émises, y compris après règlement', async () => {
      const facture = await prisma.facture.findFirst({ where: { type: 'FACTURE', statut: 'EMISE', ecrituresComptables: { some: {} }, clientId }, select: { id: true } });
      assert.ok(facture);
      const ecriture = await prisma.ecritureFacture.findFirstOrThrow({ where: { factureId: facture.id } });
      await assert.rejects(() => prisma.ecritureFacture.update({ where: { id: ecriture.id }, data: { compteLib: 'Réécrit' } }));
      await assert.rejects(() => prisma.ecritureFacture.delete({ where: { id: ecriture.id } }));
      assert.deepEqual(await prisma.ecritureFacture.findUnique({ where: { id: ecriture.id } }), ecriture);
      const reglement = await request(app).post(`/api/factures/${facture.id}/regler`).set('Authorization', `Bearer ${session}`);
      assert.equal(reglement.status, 200);
      await assert.rejects(() => prisma.ecritureFacture.update({ where: { id: ecriture.id }, data: { credit: 1 } }));
    });

    test('émet et exporte une facture entièrement offerte sans écriture déséquilibrée', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST remise totale', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST offerte', quantite: 1, prixUnitaireHt: 0, tauxTva: 0 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const ecritures = await prisma.ecritureFacture.findMany({ where: { factureId: emission.body.id } });
      assert.ok(ecritures.length > 0);
      assert.equal(ecritures.reduce((somme, e) => somme + Number(e.debit) - Number(e.credit), 0), 0);
      assert.equal((await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`)).status, 200);
    });

    test('réserve traçabilité, journal et mentions légales à l’administration', async () => {
      const conducteur = await prisma.user.create({ data: { email: 'phase8bis.conducteur@iris.test', name: 'TEST Conducteur phase8bis', role: 'CONDUCTEUR_TRAVAUX' } });
      const token = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const routes = [
        () => request(app).get('/api/factures/inexistante/tracabilite'), () => request(app).get('/api/factures/inexistante/journal'), () => request(app).get('/api/factures/inexistante/document.pdf'), () => request(app).get('/api/mentions-legales'),
        () => request(app).post('/api/mentions-legales').send({ mentions: 'TEST interdit', cgv: 'TEST interdit', penalites: 'TEST interdit' }), () => request(app).post('/api/mentions-legales/1/publier'),
      ];
      for (const route of routes) assert.equal((await route().set('Authorization', `Bearer ${token}`)).status, 403);
      assert.equal(await prisma.mentionsLegalesVersion.count({ where: { mentions: 'TEST interdit' } }), 0);
    });

    test('règle ou annule seulement une facture émise, conserve son contenu et trace la transition', async () => {
      const creerEtEmettre = async (motif) => {
        const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
          clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: motif, dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
          lignes: [{ designation: `TEST ${motif}`, quantite: 2, prixUnitaireHt: 125, tauxTva: 20 }],
        });
        assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
        const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
        assert.equal(emission.status, 200, JSON.stringify(emission.body));
        return emission.body;
      };
      const reglee = await creerEtEmettre('règlement');
      const annulee = await creerEtEmettre('annulation');
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'refus statut', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST refus statut', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));

      const reglement = await request(app).post(`/api/factures/${reglee.id}/regler`).set('Authorization', `Bearer ${session}`);
      assert.equal(reglement.status, 200, JSON.stringify(reglement.body));
      assert.equal(reglement.body.statut, 'REGLEE');
      assert.deepEqual([reglement.body.totalHt, reglement.body.totalTva, reglement.body.totalTtc, reglement.body.lignes], [reglee.totalHt, reglee.totalTva, reglee.totalTtc, reglee.lignes]);
      const journalReglement = await request(app).get(`/api/factures/${reglee.id}/journal`).set('Authorization', `Bearer ${session}`);
      assert.equal(journalReglement.status, 200, JSON.stringify(journalReglement.body));
      const traceReglement = journalReglement.body.at(-1);
      assert.equal(traceReglement.action, 'REGLEMENT');
      assert.ok(traceReglement.acteurId, 'le règlement doit porter son acteur');
      assert.match(traceReglement.detail, /EMISE.*REGLEE/i);

      const annulation = await request(app).post(`/api/factures/${annulee.id}/annuler`).set('Authorization', `Bearer ${session}`);
      assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
      const avoirAnnulation = annulation.body.avoir;
      assert.ok(avoirAnnulation, 'une annulation crée un avoir total');
      assert.equal(avoirAnnulation.type, 'AVOIR');
      assert.equal(avoirAnnulation.factureOrigineId, annulee.id);
      assert.equal(annulation.body.statut, 'ANNULEE');
      assert.deepEqual([annulation.body.totalHt, annulation.body.totalTva, annulation.body.totalTtc, annulation.body.lignes], [annulee.totalHt, annulee.totalTva, annulee.totalTtc, annulee.lignes]);
      const journalAnnulation = await request(app).get(`/api/factures/${annulee.id}/journal`).set('Authorization', `Bearer ${session}`);
      const traceAnnulation = journalAnnulation.body.at(-1);
      assert.equal(traceAnnulation.action, 'ANNULATION');
      assert.ok(traceAnnulation.acteurId, 'l’annulation doit porter son acteur');
      assert.match(traceAnnulation.detail, /EMISE.*ANNULEE/i);
      // Le motif est épinglé : un rejet sans rapport ne doit pas valider le gel SQL.
      for (const id of [reglee.id, annulee.id]) await assert.rejects(() => prisma.facture.update({ where: { id }, data: { motifHorsAffaire: 'TEST modification interdite hors brouillon' } }), /immuables/);

      for (const [id, route] of [[brouillon.body.id, 'regler'], [reglee.id, 'regler'], [annulee.id, 'annuler']]) {
        const refus = await request(app).post(`/api/factures/${id}/${route}`).set('Authorization', `Bearer ${session}`);
        assert.equal(refus.status, 409, JSON.stringify(refus.body));
        assert.match(refus.body.error, /émise/i);
      }
      const documentReglee = await request(app).get(`/api/factures/${reglee.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      const documentAnnulee = await request(app).get(`/api/factures/${annulee.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(documentReglee.status, 200, documentReglee.text);
      assert.equal(documentAnnulee.status, 200, documentAnnulee.text);
      assert.ok(await prisma.facture.findUnique({ where: { id: annulee.id } }), 'une facture annulée demeure conservée');
      const texteDuPdf = async (reponse) => { const lecteur = new PDFParse({ data: reponse.body }); const contenu = await lecteur.getText(); await lecteur.destroy(); return contenu.text; };
      assert.match(await texteDuPdf(documentAnnulee), /FACTURE ANNULÉE/);
      assert.match(await texteDuPdf(documentReglee), /Facture réglée/);
      const pdfEmise = await request(app).get(`/api/factures/${(await creerEtEmettre('témoin émis')).id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.doesNotMatch(await texteDuPdf(pdfEmise), /ANNUL|réglée/i, 'une facture simplement émise ne porte aucune mention post-émission');

      const exportComptable = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportComptable.status, 200, exportComptable.text);
      assert.match(exportComptable.text, new RegExp(reglee.numero));
      const ecrituresFactureAnnulee = exportComptable.text.split('\n').filter((ligne) => ligne.includes(annulee.numero));
      assert.ok(ecrituresFactureAnnulee.some((ligne) => ligne.includes(`\"Facture ${annulee.numero}`)), 'les écritures d’origine restent exportées');
      assert.equal(ecrituresFactureAnnulee.filter((ligne) => ligne.includes(`Annulation facture ${annulee.numero}`)).length, 0, 'un avoir remplace la contre-passation legacy sans doublon');
      const ecrituresAnnulee = exportComptable.text.split('\n').filter((ligne) => ligne.includes(avoirAnnulation.numero));
      assert.ok(ecrituresAnnulee.some((ligne) => ligne.includes(`\"Avoir ${avoirAnnulation.numero}`)), 'l’avoir total est exporté en contre-passation');
      const colonne = (ligne, index) => Number(ligne.split(';')[index].replace(/\"/g, ''));
      const debit = ecrituresAnnulee.reduce((somme, ligne) => somme + colonne(ligne, 6), 0);
      const credit = ecrituresAnnulee.reduce((somme, ligne) => somme + colonne(ligne, 7), 0);
      assert.equal(debit.toFixed(2), credit.toFixed(2), 'un avoir est équilibré dans le journal des ventes');
      assert.ok(debit > 0, 'l’avoir comporte de vraies écritures');
    });

    test('un avoir ne consomme jamais un numéro de la séquence des factures', async () => {
      const emettre = async (motif) => {
        const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: motif, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: `TEST ${motif}`, quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
        assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
        const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
        assert.equal(emission.status, 200, JSON.stringify(emission.body));
        return emission.body;
      };
      const annuler = async (facture) => {
        const annulation = await request(app).post(`/api/factures/${facture.id}/annuler`).set('Authorization', `Bearer ${session}`);
        assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
        return annulation.body.avoir;
      };
      const premiere = await emettre('séquence facture première');
      const avoirPremier = await annuler(premiere);
      const seconde = await emettre('séquence facture seconde');
      const avoirSecond = await annuler(seconde);
      try {
        const rang = (numero) => Number(numero.split('-')[1]);
        assert.equal(rang(seconde.numero), rang(premiere.numero) + 1, 'la séquence des factures ignore les avoirs');
        assert.equal(rang(avoirSecond.numero), rang(avoirPremier.numero) + 1, 'la séquence des avoirs progresse indépendamment');
      } finally {
        for (const id of [avoirPremier.id, avoirSecond.id, premiere.id, seconde.id]) {
          await prisma.journalFacture.deleteMany({ where: { factureId: id } });
          await prisma.factureLigne.deleteMany({ where: { factureId: id } });
          await purgerEcrituresJetables(id);
          await prisma.facture.delete({ where: { id } });
        }
      }
    });

    test('deux avoirs partiels concurrents ne se répartissent pas deux fois le même reliquat', async () => {
      // La transaction témoin reproduit l'entrelacement critique sans une course aléatoire :
      // la vraie route est bloquée sur la facture source, puis relit les avoirs après commit.
      // Le numéro est indépendant de sequenceAvoir afin que ce test ne mesure pas un verrou
      // de séquence au lieu du verrou de la facture qui protège le plafond.
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'course deux avoirs', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [{ designation: 'TEST course deux avoirs', quantite: 1, prixUnitaireHt: 1000, tauxTva: 20 }],
      });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const facture = emission.body;
      let reponseAvoir = null;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "Facture" WHERE "id" = ${facture.id} FOR UPDATE`;
          const concurrent = request(app).post(`/api/factures/${facture.id}/avoirs`).set('Authorization', `Bearer ${session}`)
            .send({ lignes: [{ designation: 'TEST second avoir concurrent', quantite: 1, prixUnitaireHt: 600, tauxTva: 20 }] })
            .then((reponse) => { reponseAvoir = reponse; })
            .catch((erreur) => { reponseAvoir = { status: 'ERREUR', body: { error: String(erreur) } }; });
          void concurrent;
          await new Promise((suite) => setTimeout(suite, 1000));
          const origineEcritures = await tx.ecritureFacture.findMany({ where: { factureId: facture.id }, orderBy: { ordre: 'asc' } });
          const avoirConcurrent = await tx.facture.create({ data: {
            type: 'AVOIR', estAvoirAnnulation: false, factureOrigineId: facture.id, numero: 'AVDOUBLE-COURSE-2026', annee: 2026,
            statut: 'EMISE', dateEmission: new Date('2026-09-08T00:00:00.000Z'), dateEcheance: new Date('2026-09-08T00:00:00.000Z'),
            clientId: facture.clientId, clientRaisonSociale: facture.clientRaisonSociale, clientAdresse: facture.clientAdresse,
            origine: facture.origine, motifHorsAffaire: facture.motifHorsAffaire, mentionsLegalesVersionId: facture.mentionsLegalesVersion.id,
            totalHt: 600, totalTva: 120, totalTtc: 720,
            lignes: { create: [{ ordre: 0, designation: 'TEST premier avoir concurrent', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 600, tauxTva: 20, totalHt: 600, totalTtc: 720 }] },
            ecrituresComptables: { create: origineEcritures.map(e => ({ ordre: e.ordre, cle: e.cle, tauxTva: e.tauxTva, journalCode: e.journalCode, compteNum: e.compteNum, compteLib: e.compteLib, debit: Number(e.credit) * 0.6, credit: Number(e.debit) * 0.6 })) },
          }, select: { id: true } });
          await tx.facture.update({ where: { id: avoirConcurrent.id }, data: { ecrituresScellees: true } });
        }, { timeout: 20000 });
        for (let attente = 0; attente < 60 && !reponseAvoir; attente += 1) await new Promise((suite) => setTimeout(suite, 250));
        assert.ok(reponseAvoir, 'POST /avoirs n’a pas répondu');
        assert.equal(reponseAvoir.status, 409, `le second avoir devait être refusé : ${JSON.stringify(reponseAvoir.body)}`);
        const credites = await prisma.facture.findMany({ where: { factureOrigineId: facture.id }, select: { totalHt: true } });
        assert.equal(credites.reduce((somme, avoir) => somme + Number(avoir.totalHt), 0), 600, 'un seul des deux avoirs de 600 € est retenu');
      } finally {
        const avoirs = await prisma.facture.findMany({ where: { factureOrigineId: facture.id }, select: { id: true } });
        for (const { id } of avoirs) {
          await prisma.journalFacture.deleteMany({ where: { factureId: id } });
          await prisma.factureLigne.deleteMany({ where: { factureId: id } });
          await purgerEcrituresJetables(id);
          await prisma.facture.delete({ where: { id } });
        }
        await prisma.journalFacture.deleteMany({ where: { factureId: facture.id } });
        await prisma.factureLigne.deleteMany({ where: { factureId: facture.id } });
        await purgerEcrituresJetables(facture.id);
        await prisma.facture.deleteMany({ where: { id: facture.id } });
      }
    });

    test('une annulation concurrente ne passe pas par-dessus un avoir partiel', async () => {
      // Même entrelacement déterministe : /annuler doit attendre le verrou de la facture,
      // relire l'avoir partiel créé pendant son attente et expliquer son refus métier.
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'course avoir partiel', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [{ designation: 'TEST course avoir', quantite: 1, prixUnitaireHt: 1000, tauxTva: 20 }],
      });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const facture = emission.body;
      let reponseAnnulation = null;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "Facture" WHERE "id" = ${facture.id} FOR UPDATE`;
          const concurrent = request(app).post(`/api/factures/${facture.id}/annuler`).set('Authorization', `Bearer ${session}`)
            .then((reponse) => { reponseAnnulation = reponse; })
            .catch((erreur) => { reponseAnnulation = { status: 'ERREUR', body: { error: String(erreur) } }; });
          void concurrent;
          await new Promise((suite) => setTimeout(suite, 1000));
          const origineEcritures = await tx.ecritureFacture.findMany({ where: { factureId: facture.id }, orderBy: { ordre: 'asc' } });
          const avoirConcurrent = await tx.facture.create({ data: {
            type: 'AVOIR', estAvoirAnnulation: false, factureOrigineId: facture.id, numero: 'AVCOURSE-PARTIEL-2026', annee: 2026,
            statut: 'EMISE', dateEmission: new Date('2026-09-08T00:00:00.000Z'), dateEcheance: new Date('2026-09-08T00:00:00.000Z'),
            clientId: facture.clientId, clientRaisonSociale: facture.clientRaisonSociale, clientAdresse: facture.clientAdresse,
            origine: facture.origine, motifHorsAffaire: facture.motifHorsAffaire, mentionsLegalesVersionId: facture.mentionsLegalesVersion.id,
            totalHt: 600, totalTva: 120, totalTtc: 720,
            lignes: { create: [{ ordre: 0, designation: 'TEST avoir partiel concurrent', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 600, tauxTva: 20, totalHt: 600, totalTtc: 720 }] },
            ecrituresComptables: { create: origineEcritures.map(e => ({ ordre: e.ordre, cle: e.cle, tauxTva: e.tauxTva, journalCode: e.journalCode, compteNum: e.compteNum, compteLib: e.compteLib, debit: Number(e.credit) * 0.6, credit: Number(e.debit) * 0.6 })) },
          } });
          await tx.facture.update({ where: { id: avoirConcurrent.id }, data: { ecrituresScellees: true } });
        }, { timeout: 20000 });
        for (let attente = 0; attente < 60 && !reponseAnnulation; attente += 1) await new Promise((suite) => setTimeout(suite, 250));
        assert.ok(reponseAnnulation, 'POST /annuler n’a pas répondu');
        assert.equal(reponseAnnulation.status, 409, `l’annulation devait être refusée : ${JSON.stringify(reponseAnnulation.body)}`);
        assert.match(reponseAnnulation.body.error, /avoirs partiels/i, 'le refus doit nommer sa vraie raison');
        const credites = await prisma.facture.findMany({ where: { factureOrigineId: facture.id }, select: { totalHt: true } });
        assert.equal(credites.reduce((somme, avoir) => somme + Number(avoir.totalHt), 0), 600, 'le plafond de 1 000 € n’est jamais dépassé');
      } finally {
        const avoirs = await prisma.facture.findMany({ where: { factureOrigineId: facture.id }, select: { id: true } });
        for (const { id } of avoirs) {
          await prisma.journalFacture.deleteMany({ where: { factureId: id } });
          await prisma.factureLigne.deleteMany({ where: { factureId: id } });
          await purgerEcrituresJetables(id);
          await prisma.facture.delete({ where: { id } });
        }
        await prisma.journalFacture.deleteMany({ where: { factureId: facture.id } });
        await prisma.factureLigne.deleteMany({ where: { factureId: facture.id } });
        await purgerEcrituresJetables(facture.id);
        await prisma.facture.deleteMany({ where: { id: facture.id } });
      }
    });

    test('annule atomiquement une facture en créant un avoir total numéroté séparément', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Avoir total transactionnel', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [
          { designation: 'TEST avoir prestation', nature: 'PRESTATION', quantite: 2, prixUnitaireHt: 100, tauxTva: 20 },
          { designation: 'TEST avoir article', nature: 'ARTICLE', quantite: 1, prixUnitaireHt: 50, tauxTva: 20 },
        ],
      });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const annulation = await request(app).post(`/api/factures/${emission.body.id}/annuler`).set('Authorization', `Bearer ${session}`);
      assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
      assert.equal(annulation.body.statut, 'ANNULEE');
      assert.ok(annulation.body.avoir, 'l’annulation doit retourner l’avoir créé dans la même transaction');
      const avoir = annulation.body.avoir;
      assert.equal(avoir.type, 'AVOIR');
      assert.match(avoir.numero, /^A\d{4}-\d{4}$/);
      assert.equal(avoir.factureOrigineId, emission.body.id);
      assert.deepEqual([avoir.totalHt, avoir.totalTva, avoir.totalTtc], [emission.body.totalHt, emission.body.totalTva, emission.body.totalTtc], 'les montants d’un avoir sont stockés positifs');
      assert.deepEqual(avoir.lignes.map((ligne) => ({ designation: ligne.designation, nature: ligne.nature, quantite: ligne.quantite, prixUnitaireHt: ligne.prixUnitaireHt, tauxTva: ligne.tauxTva })), emission.body.lignes.map((ligne) => ({ designation: ligne.designation, nature: ligne.nature, quantite: ligne.quantite, prixUnitaireHt: ligne.prixUnitaireHt, tauxTva: ligne.tauxTva })));
      const journal = await request(app).get(`/api/factures/${emission.body.id}/journal`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      assert.equal(journal.body.at(-1).action, 'ANNULATION');
      assert.match(journal.body.at(-1).detail, new RegExp(avoir.numero));
      const documentAvoir = await request(app).get(`/api/factures/${avoir.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(documentAvoir.status, 200, documentAvoir.text);
      const lecteur = new PDFParse({ data: documentAvoir.body }); const contenu = await lecteur.getText(); await lecteur.destroy();
      assert.match(contenu.text, new RegExp(`AVOIR ${avoir.numero}`));
      assert.match(contenu.text, new RegExp(`Facture d’origine : ${emission.body.numero}`));
      const exportComptable = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportComptable.status, 200, exportComptable.text);
      const lignesAvoir = exportComptable.text.split('\n').filter((ligne) => ligne.includes(avoir.numero));
      assert.ok(lignesAvoir.length > 0, 'l’avoir est exporté');
      const montant = (ligne, index) => Number(ligne.split(';')[index].replace(/"/g, ''));
      assert.ok(lignesAvoir.some((ligne) => montant(ligne, 6) > 0 && /Vente|TVA/.test(ligne)), 'l’avoir contre-passe les produits et la TVA');
      assert.ok(lignesAvoir.some((ligne) => montant(ligne, 7) > 0 && /Clients/.test(ligne)), 'l’avoir crédite le client');
    });

    test('crée plusieurs avoirs partiels positifs, figés et plafonnés par taux de TVA', async () => {
      await configurerTva55();
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Avoirs partiels multi taux', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [
          { designation: 'TEST source vingt', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 },
          { designation: 'TEST source cinq', nature: 'ARTICLE', quantite: 1, prixUnitaireHt: 100, tauxTva: 5.5 },
        ],
      });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const compteTva = await prisma.compteComptable.findUnique({ where: { code: '445710' } });
      assert.ok(compteTva, 'le compte TVA de test existe');
      await prisma.regleTvaComptable.upsert({ where: { taux: 5.5 }, create: { taux: 5.5, compteId: compteTva.id }, update: { compteId: compteTva.id } });
      try {
      const creer = (lignes) => request(app).post(`/api/factures/${emission.body.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({ lignes });

      const premier = await creer([{ designation: 'TEST geste commercial 20', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 40, tauxTva: 20 }]);
      assert.equal(premier.status, 201, JSON.stringify(premier.body));
      assert.equal(premier.body.type, 'AVOIR'); assert.equal(premier.body.statut, 'EMISE');
      assert.equal(premier.body.factureOrigineId, emission.body.id); assert.equal(premier.body.estAvoirAnnulation, false);
      assert.deepEqual([premier.body.totalHt, premier.body.totalTva, premier.body.totalTtc], [40, 8, 48]);
      assert.match(premier.body.numero, /^A\d{4}-\d{4}$/);
      assert.equal(premier.body.clientRaisonSociale, emission.body.clientRaisonSociale);
      assert.equal(premier.body.clientAdresse, emission.body.clientAdresse);
      assert.equal(premier.body.mentionsLegalesVersion.id, emission.body.mentionsLegalesVersion.id);

      const tauxInconnu = await creer([{ designation: 'TEST taux interdit', quantite: 1, prixUnitaireHt: 1, tauxTva: 10 }]);
      assert.equal(tauxInconnu.status, 400, JSON.stringify(tauxInconnu.body));
      assert.match(tauxInconnu.body.error, /taux de TVA.*origine/i);
      const depassementTaux = await creer([{ designation: 'TEST dépassement vingt', quantite: 1, prixUnitaireHt: 61, tauxTva: 20 }]);
      assert.equal(depassementTaux.status, 409, JSON.stringify(depassementTaux.body));
      assert.match(depassementTaux.body.error, /plafond.*TVA|créditer/i);

      const second = await creer([{ designation: 'TEST reliquat vingt', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 60, tauxTva: 20 }]);
      assert.equal(second.status, 201, JSON.stringify(second.body)); assert.equal(second.body.totalTtc, 72);
      const depassementTotal = await creer([{ designation: 'TEST dépassement total', quantite: 1, prixUnitaireHt: 0.01, tauxTva: 20 }]);
      assert.equal(depassementTotal.status, 409, JSON.stringify(depassementTotal.body));

      const reglee = await request(app).post(`/api/factures/${emission.body.id}/regler`).set('Authorization', `Bearer ${session}`);
      assert.equal(reglee.status, 200, JSON.stringify(reglee.body));
      const troisieme = await creer([{ designation: 'TEST avoir cinq', nature: 'ARTICLE', quantite: 1, prixUnitaireHt: 100, tauxTva: 5.5 }]);
      assert.equal(troisieme.status, 201, JSON.stringify(troisieme.body));
      assert.deepEqual([troisieme.body.totalHt, troisieme.body.totalTva, troisieme.body.totalTtc], [100, 5.5, 105.5]);

      const annulation = await request(app).post(`/api/factures/${emission.body.id}/annuler`).set('Authorization', `Bearer ${session}`);
      assert.equal(annulation.status, 409, JSON.stringify(annulation.body));
      // Un avoir partiel ne crédite que la facture source, émise ou réglée : créditer un
      // brouillon contournerait l'absence de numéro légal, créditer un avoir créerait une
      // chaîne d'avoirs sans document source légitime.
      const surAvoir = await request(app).post(`/api/factures/${premier.body.id}/avoirs`).set('Authorization', `Bearer ${session}`)
        .send({ lignes: [{ designation: 'TEST avoir sur avoir', quantite: 1, prixUnitaireHt: 1, tauxTva: 20 }] });
      assert.equal(surAvoir.status, 409, JSON.stringify(surAvoir.body));
      const jamaisEmise = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'brouillon non créditable', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [{ designation: 'TEST brouillon non créditable', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }],
      });
      assert.equal(jamaisEmise.status, 201, JSON.stringify(jamaisEmise.body));
      const surBrouillon = await request(app).post(`/api/factures/${jamaisEmise.body.id}/avoirs`).set('Authorization', `Bearer ${session}`)
        .send({ lignes: [{ designation: 'TEST avoir sur brouillon', quantite: 1, prixUnitaireHt: 1, tauxTva: 20 }] });
      assert.equal(surBrouillon.status, 409, JSON.stringify(surBrouillon.body));
      const pdf = await request(app).get(`/api/factures/${premier.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(pdf.status, 200, pdf.text);
      const lecteur = new PDFParse({ data: pdf.body }); const contenu = await lecteur.getText(); await lecteur.destroy();
      assert.match(contenu.text, new RegExp(`AVOIR ${premier.body.numero}`));
      assert.match(contenu.text, new RegExp(`Facture d’origine : ${emission.body.numero}`));
      const exportation = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportation.status, 200, exportation.text);
      assert.match(exportation.text, new RegExp(`Avoir ${premier.body.numero}`));
      } finally {
      await prisma.regleTvaComptable.deleteMany({ where: { taux: 5.5 } });
      }
    });

    test('fige la TVA cumulée des avoirs fractionnés à 5,5 % dans le PDF et l’export', async () => {
      await configurerTva55();
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Arrondi cumulatif avoir 5,5', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [
          { designation: 'TEST source 5,5 premier', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 9, tauxTva: 5.5 },
          { designation: 'TEST source 5,5 second', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 9, tauxTva: 5.5 },
        ],
      });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      assert.deepEqual([brouillon.body.totalHt, brouillon.body.totalTva, brouillon.body.totalTtc], [18, 0.99, 18.99]);
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const compteTva = await prisma.compteComptable.findUnique({ where: { code: '445710' } });
      assert.ok(compteTva, 'le compte TVA de test existe');
      await prisma.regleTvaComptable.upsert({ where: { taux: 5.5 }, create: { taux: 5.5, compteId: compteTva.id }, update: { compteId: compteTva.id } });

      const creer = () => request(app).post(`/api/factures/${emission.body.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({
        lignes: [{ designation: 'TEST avoir fractionné 5,5', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 9, tauxTva: 5.5 }],
      });
      const premier = await creer();
      assert.equal(premier.status, 201, JSON.stringify(premier.body));
      assert.deepEqual([premier.body.totalHt, premier.body.totalTva, premier.body.totalTtc], [9, 0.5, 9.5]);
      assert.deepEqual(premier.body.ventilationTva.map(({ tauxTva, totalHt, totalTva, totalTtc }) => ({ tauxTva, totalHt, totalTva, totalTtc })), [{ tauxTva: 5.5, totalHt: 9, totalTva: 0.5, totalTtc: 9.5 }]);

      const second = await creer();
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.deepEqual([second.body.totalHt, second.body.totalTva, second.body.totalTtc], [9, 0.49, 9.49]);
      assert.deepEqual(second.body.ventilationTva.map(({ tauxTva, totalHt, totalTva, totalTtc }) => ({ tauxTva, totalHt, totalTva, totalTtc })), [{ tauxTva: 5.5, totalHt: 9, totalTva: 0.49, totalTtc: 9.49 }]);
      const ventilationFigee = await prisma.factureVentilationTva.findUniqueOrThrow({ where: { factureId_tauxTva: { factureId: second.body.id, tauxTva: 5.5 } } });
      await assert.rejects(() => prisma.factureVentilationTva.update({ where: { id: ventilationFigee.id }, data: { totalTva: 0.5 } }), /immuable/);
      const depassement = await request(app).post(`/api/factures/${emission.body.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({
        lignes: [{ designation: 'TEST dépassement fractionné', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 0.01, tauxTva: 5.5 }],
      });
      assert.equal(depassement.status, 409, JSON.stringify(depassement.body));

      const texteDuPdf = async (reponse) => { const lecteur = new PDFParse({ data: reponse.body }); const contenu = await lecteur.getText(); await lecteur.destroy(); return contenu.text; };
      const pdfSecond = await request(app).get(`/api/factures/${second.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(pdfSecond.status, 200, pdfSecond.text);
      assert.match(await texteDuPdf(pdfSecond), /TVA 5\.5 % sur 9,00 € : 0,49 €/);

      const exportation = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportation.status, 200, exportation.text);
      const lignesSecond = exportation.text.split('\n').filter((ligne) => ligne.includes(second.body.numero));
      const montant = (ligne, index) => Number(ligne.split(';')[index].replace(/\"/g, ''));
      assert.ok(lignesSecond.some((ligne) => /TVA/.test(ligne) && montant(ligne, 6) === 0.49), 'la TVA figée à 0,49 € est contre-passée');
      assert.equal(lignesSecond.reduce((somme, ligne) => somme + montant(ligne, 6), 0).toFixed(2), lignesSecond.reduce((somme, ligne) => somme + montant(ligne, 7), 0).toFixed(2), 'l’export du second avoir est équilibré');
    });

    test('une facture ne quitte pas sa fiche affaire en changeant de statut', async () => {
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Affaire suivie', client: 'TEST Client contrat maintenance', clientId, dateDebut: new Date('2026-09-01T00:00:00.000Z'), statut: 'EN_COURS', budgetGlobalVendu: 10000 } });
      const emettreSurAffaire = async (motif) => {
        const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'CHANTIER', chantierId: chantier.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: `TEST ${motif}`, quantite: 1, prixUnitaireHt: 1000, tauxTva: 20 }] });
        assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
        const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
        assert.equal(emission.status, 200, JSON.stringify(emission.body));
        return emission.body;
      };
      const fiche = async () => (await request(app).get(`/api/chantiers/${chantier.id}`).set('Authorization', `Bearer ${session}`)).body.facturation;
      const aRegler = await emettreSurAffaire('affaire réglée');
      const aAnnuler = await emettreSurAffaire('affaire annulée');
      assert.equal((await fiche()).totalFactureHt, 2000);
      assert.equal((await request(app).post(`/api/factures/${aRegler.id}/regler`).set('Authorization', `Bearer ${session}`)).status, 200);
      const apresReglement = await fiche();
      assert.equal(apresReglement.totalFactureHt, 2000);
      assert.equal(apresReglement.resteAFacturerHt, 8000);
      assert.deepEqual(apresReglement.factures.map((facture) => facture.statut).sort(), ['EMISE', 'REGLEE']);
      assert.equal((await request(app).post(`/api/factures/${aAnnuler.id}/annuler`).set('Authorization', `Bearer ${session}`)).status, 200);
      const apresAnnulation = await fiche();
      assert.equal(apresAnnulation.totalFactureHt, 1000);
      assert.equal(apresAnnulation.resteAFacturerHt, 9000);
      assert.deepEqual(apresAnnulation.factures.map((facture) => [facture.type, facture.statut]).sort(), [['AVOIR', 'EMISE'], ['FACTURE', 'ANNULEE'], ['FACTURE', 'REGLEE']]);
      assert.ok(apresAnnulation.factures.every((facture) => facture.numero), 'chaque facture de la fiche porte son numéro légal');
    });

    test('le contrôle TVA des prérequis couvre les futures émissions sans bloquer l’export historique', async () => {
      await configurerTva55();
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'taux annulé non couvert', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST taux annulé', quantite: 1, prixUnitaireHt: 100, tauxTva: 5.5 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      assert.equal((await request(app).post(`/api/factures/${emission.body.id}/annuler`).set('Authorization', `Bearer ${session}`)).status, 200);
      await prisma.regleTvaComptable.deleteMany({ where: { taux: 5.5 } });
      try {
        const exportation = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
        assert.equal(exportation.status, 200, exportation.text);
        const prerequis = await request(app).get('/api/facturation/prete-a-facturer').set('Authorization', `Bearer ${session}`);
        const tva = prerequis.body.controles.find((controle) => controle.cle === 'TVA');
        assert.equal(tva.pret, false);
        assert.equal(tva.bloquant, true);
        assert.match(tva.detail, /5\.5 %/);
      } finally {
        const avoir = await prisma.facture.findFirst({ where: { factureOrigineId: emission.body.id }, select: { id: true } });
        if (avoir) {
          await prisma.journalFacture.deleteMany({ where: { factureId: avoir.id } });
          await prisma.factureLigne.deleteMany({ where: { factureId: avoir.id } });
          await purgerEcrituresJetables(avoir.id);
          await prisma.facture.delete({ where: { id: avoir.id } });
        }
        await prisma.journalFacture.deleteMany({ where: { factureId: emission.body.id } });
        await prisma.factureLigne.deleteMany({ where: { factureId: emission.body.id } });
        await purgerEcrituresJetables(emission.body.id);
        await prisma.facture.delete({ where: { id: emission.body.id } });
      }
    });

    // Le pendant du test suivant : une date-seule ne bouge JAMAIS, quel que soit le fuseau
    // de la société. Sans cette garde, relire `dateEmission` comme un instant passe
    // inaperçu — à l'ouest de Greenwich l'avoir s'exporterait la veille de son émission.
    test('l’export ne déplace jamais la date d’émission d’un avoir', async () => {
      const compteTva = await prisma.compteComptable.findUnique({ where: { code: '445710' } });
      assert.ok(compteTva, 'le compte TVA de test existe');
      // Le compte du taux 5,5 permet l'émission de la source ; son export ultérieur
      // ne dépend plus de cette règle vivante, contrairement aux futures émissions.
      await prisma.regleTvaComptable.upsert({ where: { taux: 5.5 }, create: { taux: 5.5, compteId: compteTva.id }, update: { compteId: compteTva.id } });
      // La numérotation est chronologique : on émet au jour de la dernière facture numérotée
      // plutôt qu'à une date fixe, sinon ce test dépendrait de son rang dans la suite.
      const derniere = await prisma.facture.findFirst({ where: { numero: { not: null } }, orderBy: { dateEmission: 'desc' }, select: { dateEmission: true } });
      const jour = derniere ? derniere.dateEmission : new Date('2026-09-09T00:00:00.000Z');
      const jourFrancais = `${String(jour.getUTCDate()).padStart(2, '0')}-${String(jour.getUTCMonth() + 1).padStart(2, '0')}-${jour.getUTCFullYear()}`;
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'date-seule immobile', dateEmission: jourFrancais, dateEcheance: jourFrancais, lignes: [{ designation: 'TEST date-seule', quantite: 1, prixUnitaireHt: 1000, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const annulation = await request(app).post(`/api/factures/${emission.body.id}/annuler`).set('Authorization', `Bearer ${session}`);
      assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
      const avoir = annulation.body.avoir;
      const jourAttendu = avoir.dateEmission.slice(0, 10).replace(/-/g, '');
      const datesDeLAvoir = async () => {
        const csv = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
        assert.equal(csv.status, 200, csv.text);
        const lignes = csv.text.split('\n').filter((ligne) => ligne.includes(avoir.numero) && ligne.includes(`Avoir ${avoir.numero}`));
        assert.ok(lignes.length, 'aucune écriture d’avoir dans l’export');
        return [...new Set(lignes.map((ligne) => ligne.split(';')[1].replace(/"/g, '')))];
      };
      const fuseauInitial = (await request(app).get('/api/company').set('Authorization', `Bearer ${session}`)).body.fuseauHoraire;
      try {
        // Nouméa (UTC+11) et Gambier (UTC−9) encadrent l'écart maximal des territoires
        // français : si la date-seule bougeait, l'un des deux la décalerait d'un jour.
        for (const fuseau of ['Europe/Paris', 'Pacific/Noumea', 'America/Martinique', 'Pacific/Gambier']) {
          assert.equal((await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseau })).status, 200);
          assert.deepEqual(await datesDeLAvoir(), [jourAttendu], `la date d’émission de l’avoir reste une date-seule en ${fuseau}`);
        }
      } finally {
        await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseauInitial || 'Europe/Paris' });
        await prisma.journalFacture.deleteMany({ where: { factureId: avoir.id } });
        await prisma.factureLigne.deleteMany({ where: { factureId: avoir.id } });
        await purgerEcrituresJetables(avoir.id);
        await prisma.facture.delete({ where: { id: avoir.id } });
        await prisma.journalFacture.deleteMany({ where: { factureId: emission.body.id } });
        await prisma.factureLigne.deleteMany({ where: { factureId: emission.body.id } });
        await purgerEcrituresJetables(emission.body.id);
        await prisma.facture.delete({ where: { id: emission.body.id } });
      }
    });

    test('l’export date la contre-passation legacy dans le fuseau de la société', async () => {
      const compteTva = await prisma.compteComptable.findUnique({ where: { code: '445710' } });
      assert.ok(compteTva, 'le compte TVA de test existe');
      await prisma.regleTvaComptable.upsert({ where: { taux: 5.5 }, create: { taux: 5.5, compteId: compteTva.id }, update: { compteId: compteTva.id } });
      const derniereFacture = await prisma.facture.findFirst({ where: { type: 'FACTURE', numero: { not: null } }, orderBy: { dateEmission: 'desc' }, select: { dateEmission: true } });
      const datePiece = derniereFacture?.dateEmission || new Date('2026-09-09T00:00:00.000Z');
      const jourPiece = `${String(datePiece.getUTCDate()).padStart(2, '0')}-${String(datePiece.getUTCMonth() + 1).padStart(2, '0')}-${datePiece.getUTCFullYear()}`;
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'bascule de jour civil', dateEmission: jourPiece, dateEcheance: jourPiece, lignes: [{ designation: 'TEST bascule exercice', quantite: 1, prixUnitaireHt: 1000, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const annulation = await request(app).post(`/api/factures/${emission.body.id}/annuler`).set('Authorization', `Bearer ${session}`);
      assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
      // Retire l'avoir pour exercer le chemin historique de contre-passation, pas son
      // remplacement moderne. L'instant est volontairement à cheval sur le nouvel an.
      const avoir = annulation.body.avoir;
      await prisma.journalFacture.deleteMany({ where: { factureId: avoir.id } });
      await prisma.factureLigne.deleteMany({ where: { factureId: avoir.id } });
      await purgerEcrituresJetables(avoir.id);
      await prisma.facture.delete({ where: { id: avoir.id } });
      await prisma.journalFacture.updateMany({ where: { factureId: emission.body.id, action: 'ANNULATION' }, data: { createdAt: new Date('2027-01-01T00:30:00.000Z') } });
      const jourComptable = async () => {
        const csv = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
        assert.equal(csv.status, 200, csv.text);
        const lignes = csv.text.split('\n').filter((ligne) => ligne.includes(emission.body.numero) && ligne.includes(`Annulation facture ${emission.body.numero}`));
        assert.ok(lignes.length, 'aucune contre-passation legacy dans l’export');
        return [...new Set(lignes.map((ligne) => ligne.split(';')[1].replace(/"/g, '')))];
      };
      const fuseauInitial = (await request(app).get('/api/company').set('Authorization', `Bearer ${session}`)).body.fuseauHoraire;
      try {
        for (const [fuseau, jourAttendu] of [['Europe/Paris', '20270101'], ['Pacific/Noumea', '20270101'], ['America/Martinique', '20261231'], ['Pacific/Gambier', '20261231']]) {
          assert.equal((await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseau })).status, 200);
          assert.deepEqual(await jourComptable(), [jourAttendu], `la contre-passation suit l’instant dans ${fuseau}`);
        }
      } finally {
        await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseauInitial || 'Europe/Paris' });
        const avoir = await prisma.facture.findFirst({ where: { factureOrigineId: emission.body.id }, select: { id: true } });
        if (avoir) {
          await prisma.journalFacture.deleteMany({ where: { factureId: avoir.id } });
          await prisma.factureLigne.deleteMany({ where: { factureId: avoir.id } });
          await purgerEcrituresJetables(avoir.id);
          await prisma.facture.delete({ where: { id: avoir.id } });
        }
        await prisma.journalFacture.deleteMany({ where: { factureId: emission.body.id } });
        await prisma.factureLigne.deleteMany({ where: { factureId: emission.body.id } });
        await purgerEcrituresJetables(emission.body.id);
        await prisma.facture.delete({ where: { id: emission.body.id } });
      }
    });

    test('refuse une version légale incomplète', async () => {
      for (const corps of [{ cgv: 'TEST cgv', penalites: 'TEST pénalités' }, { mentions: '   ', cgv: 'TEST cgv', penalites: 'TEST pénalités' }]) {
        assert.equal((await request(app).post('/api/mentions-legales').set('Authorization', `Bearer ${session}`).send(corps)).status, 400);
      }
    });

    test('n’émet pas sur une version légale restée en brouillon', async () => {
      const actives = await prisma.mentionsLegalesVersion.findMany({ where: { actif: true } });
      await prisma.mentionsLegalesVersion.updateMany({ where: { actif: true }, data: { actif: false } });
      const brouillon = await request(app).post('/api/mentions-legales').set('Authorization', `Bearer ${session}`).send({ mentions: 'TEST brouillon', cgv: 'TEST brouillon', penalites: 'TEST brouillon' });
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST brouillon légal', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST brouillon légal', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201); assert.equal((await request(app).post(`/api/factures/${facture.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 409);
      await prisma.mentionsLegalesVersion.delete({ where: { id: brouillon.body.id } });
      for (const active of actives) await prisma.mentionsLegalesVersion.update({ where: { id: active.id }, data: { actif: true } });
    });

    test('ne divulgue pas la facturation d’une affaire à qui ne voit pas la marge', async () => {
      const commercial = await prisma.user.create({ data: { email: 'phase8bis.commercial@iris.test', name: 'TEST Commercial phase8bis', role: 'COMMERCIAL' } });
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Affaire facturée', client: 'TEST Client contrat maintenance', clientId, dateDebut: new Date(), budgetGlobalVendu: 50000, commercialId: commercial.id } });
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'CHANTIER', chantierId: chantier.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST facturation affaire', quantite: 1, prixUnitaireHt: 12345.67, tauxTva: 20 }] });
      assert.equal((await request(app).post(`/api/factures/${facture.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
      const vueCommercial = await request(app).get(`/api/chantiers/${chantier.id}`).set('Authorization', `Bearer ${jwt.sign({ id: commercial.id }, process.env.JWT_SECRET)}`);
      assert.equal(vueCommercial.status, 200); assert.equal(vueCommercial.body.facturation, undefined); assert.equal(vueCommercial.body.factures, undefined);
      assert.equal(/12345\.67|14814\.8/.test(JSON.stringify(vueCommercial.body)), false);
    });

    test('répare le client d’une affaire héritée mais le fige après facturation', async () => {
      const orpheline = await prisma.chantier.create({ data: { nom: 'TEST Affaire héritée', client: 'TEST Libellé libre', dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      const avantReparation = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'CHANTIER', chantierId: orpheline.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST affaire non rattachée', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(avantReparation.status, 404);
      assert.equal((await request(app).patch(`/api/chantiers/${orpheline.id}`).set('Authorization', `Bearer ${session}`).send({ clientId })).status, 200);
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'CHANTIER', chantierId: orpheline.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST affaire réparée', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(facture.status, 201); assert.equal((await request(app).post(`/api/factures/${facture.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
      const autre = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST Client déplacement' });
      assert.equal((await request(app).patch(`/api/chantiers/${orpheline.id}`).set('Authorization', `Bearer ${session}`).send({ clientId: autre.body.id })).status, 409);
    });

    test('refuse le document PDF d’une facture brouillon', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST document brouillon', dateEmission: '09-09-2026', dateEcheance: '09-10-2026', lignes: [{ designation: 'TEST document brouillon', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const document = await request(app).get(`/api/factures/${brouillon.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(document.status, 409, JSON.stringify(document.body));
      assert.match(document.body.error, /facture émise/i);
    });

    test('refuse d’émettre une facture antérieure à la dernière déjà numérotée', async () => {
      const brouillon = (dateEmission, dateEcheance) => request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission, dateEcheance, lignes: [{ designation: 'TEST chronologie', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      const emettre = (id) => request(app).post(`/api/factures/${id}/emettre`).set('Authorization', `Bearer ${session}`);
      const reference = await emettre((await brouillon('08-09-2026', '08-10-2026')).body.id);
      assert.equal(reference.status, 200, JSON.stringify(reference.body));
      assert.equal((await emettre((await brouillon('08-09-2026', '08-10-2026')).body.id)).status, 200);
      const ancienne = await brouillon('02-01-2026', '31-12-2026');
      const refus = await emettre(ancienne.body.id);
      assert.equal(refus.status, 409, JSON.stringify(refus.body)); assert.match(refus.body.error, /chronologique/i); assert.match(refus.body.error, /08-09-2026/);
      assert.equal((await prisma.facture.findUnique({ where: { id: ancienne.body.id } })).numero, null);
    });

    test('génère un document PDF pour une facture émise', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST document émis', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST document émis', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`).send();
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const legalFige = emission.body.mentionsLegalesVersion;
      assert.ok(legalFige, JSON.stringify(emission.body));
      await prisma.companySettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', raisonSociale: 'TEST Société vivante', siret: 'TEST-SIRET-VIVANT', couleurPrimaire: '#123456' }, update: { raisonSociale: 'TEST Société vivante', siret: 'TEST-SIRET-VIVANT', couleurPrimaire: '#123456' } });
      const document = await request(app).get(`/api/factures/${brouillon.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(document.status, 200, document.text);
      assert.match(document.headers['content-type'] || '', /application\/pdf/);
      assert.ok(document.body.subarray(0, 5).equals(Buffer.from('%PDF-')));
      const lecteurPdf = new PDFParse({ data: document.body });
      const contenuPdf = await lecteurPdf.getText();
      await lecteurPdf.destroy();
      assert.match(contenuPdf.text, /TEST document émis/);
      assert.match(contenuPdf.text, new RegExp(legalFige.mentions));
      assert.match(contenuPdf.text, new RegExp(`version ${legalFige.version}`));
      assert.doesNotMatch(contenuPdf.text, /TEST Société vivante|TEST-SIRET-VIVANT/);
      const zlib = await import('node:zlib'); const tailles = new Set();
      for (let curseur = 0; ;) { const debut = document.body.indexOf('stream', curseur); if (debut < 0) break; const fin = document.body.indexOf('endstream', debut); if (fin < 0) break; let corps = debut + 6; while (document.body[corps] === 13 || document.body[corps] === 10) corps += 1; try { for (const trouve of zlib.inflateSync(document.body.subarray(corps, fin)).toString('latin1').matchAll(/\/F\d+\s+([\d.]+)\s+Tf/g)) tailles.add(trouve[1]); } catch {} curseur = fin + 9; }
      assert.ok(tailles.size >= 4, `Hiérarchie typographique absente : ${[...tailles].join(', ')}`);
      assert.match(contenuPdf.text, /Mentions légales et CGV/);
    });

    test('régénère le PDF historique avec le client et les mentions figés', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST gel PDF', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST gel PDF', quantite: 1, prixUnitaireHt: 30, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const nomClientFige = emission.body.clientRaisonSociale;
      const ancienneVersion = await prisma.mentionsLegalesVersion.findFirst({ where: { actif: true }, select: { version: true, mentions: true } });
      assert.ok(ancienneVersion);
      await prisma.client.update({ where: { id: clientId }, data: { raisonSociale: 'TEST Client renommé après émission' } });
      const nouvelleVersion = await request(app).post('/api/mentions-legales').set('Authorization', `Bearer ${session}`).send({ mentions: 'TEST Nouvelles mentions', cgv: 'TEST Nouvelles CGV', penalites: 'TEST Nouvelles pénalités' });
      assert.equal(nouvelleVersion.status, 201, JSON.stringify(nouvelleVersion.body));
      assert.equal((await request(app).post(`/api/mentions-legales/${nouvelleVersion.body.version}/publier`).set('Authorization', `Bearer ${session}`)).status, 200);
      const document = await request(app).get(`/api/factures/${brouillon.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(document.status, 200, document.text);
      const lecteurPdf = new PDFParse({ data: document.body }); const contenuPdf = await lecteurPdf.getText(); await lecteurPdf.destroy();
      assert.ok(contenuPdf.text.includes(nomClientFige));
      assert.doesNotMatch(contenuPdf.text, /TEST Client renommé après émission/);
      assert.match(contenuPdf.text, new RegExp(ancienneVersion.mentions));
      assert.doesNotMatch(contenuPdf.text, /TEST Nouvelles mentions/);
    });

    test('ventile la TVA par taux dans le document PDF', async () => {
      const compteTva = await prisma.compteComptable.findUniqueOrThrow({ where: { code: '445710' } });
      await prisma.regleTvaComptable.upsert({ where: { taux: 10 }, create: { taux: 10, compteId: compteTva.id }, update: { compteId: compteTva.id } });
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST TVA PDF', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST TVA 20', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }, { designation: 'TEST TVA 10', quantite: 1, prixUnitaireHt: 100, tauxTva: 10 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      assert.equal((await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
      const document = await request(app).get(`/api/factures/${brouillon.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(document.status, 200, document.text);
      assert.match(document.headers['content-type'] || '', /application\/pdf/);
      assert.ok(document.body.subarray(0, 5).equals(Buffer.from('%PDF-')));
      const lecteurPdf = new PDFParse({ data: document.body });
      const contenuPdf = await lecteurPdf.getText();
      await lecteurPdf.destroy();
      assert.match(contenuPdf.text, /TVA 10 %/);
      assert.match(contenuPdf.text, /TVA 20 %/);
      assert.match(contenuPdf.text, /20,00 €/);
    });

    test('imprime les montants à quatre chiffres et les désignations longues sans les altérer', async () => {
      const designation = 'TEST Remplacement de la centrale incendie type 4 du bâtiment B, câblage et mise en service comprise';
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST rendu montants', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation, quantite: 1, prixUnitaireHt: 1234.56, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body)); assert.equal((await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
      const document = await request(app).get(`/api/factures/${brouillon.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`); const lecteurPdf = new PDFParse({ data: document.body }); const contenuPdf = await lecteurPdf.getText(); await lecteurPdf.destroy();
      assert.match(contenuPdf.text, /1 234,56 €/); assert.match(contenuPdf.text, /Total TTC : 1 481,47 €/); assert.doesNotMatch(contenuPdf.text, /\d \/\d/);
      for (const mot of designation.split(' ')) assert.ok(contenuPdf.text.includes(mot), `Désignation tronquée : ${mot}`);
      const million = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST colonnes larges', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST lot unique', quantite: 1, prixUnitaireHt: 1234567.89, tauxTva: 20 }] });
      assert.equal(million.status, 201, JSON.stringify(million.body)); assert.equal((await request(app).post(`/api/factures/${million.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
      const docMillion = await request(app).get(`/api/factures/${million.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`); assert.equal(docMillion.status, 200, docMillion.text);
      const lecteurMillion = new PDFParse({ data: docMillion.body }); const contenuMillion = await lecteurMillion.getText(); await lecteurMillion.destroy();
      assert.match(contenuMillion.text, /TEST lot unique 1 1 234 567,89 € 20 % 1 234 567,89 €/); assert.doesNotMatch(contenuMillion.text, /11 234 567,89 €/);
    });

    test('refuse le document PDF d’une facture antérieure au gel de l’adresse', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST adresse héritée', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST adresse héritée', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      const mentions = await prisma.mentionsLegalesVersion.findFirst({ where: { actif: true, publieeLe: { not: null } }, select: { id: true } }); assert.ok(mentions);
      await prisma.$transaction(async tx => {
        await tx.facture.update({ where: { id: brouillon.body.id }, data: { statut: 'EMISE', annee: 2026, numero: `TEST-HERITEE-${Date.now()}`, emisLe: new Date(), mentionsLegalesVersionId: mentions.id } });
        const regles = await tx.regleComptable.findMany({ include: { compte: true } });
        const tva = await tx.regleTvaComptable.findUniqueOrThrow({ where: { taux: 20 }, include: { compte: true } });
        const parCle = new Map(regles.map(r => [r.cle, r]));
        const journalCode = parCle.get('JOURNAL_VENTES').journal;
        const ecritures = [['CLIENT', parCle.get('CLIENT').compte, 12, 0], ['VENTE_PRESTATION', parCle.get('VENTE_PRESTATION').compte, 0, 10], ['TVA:20', tva.compte, 0, 2]];
        await tx.ecritureFacture.createMany({ data: ecritures.map(([cle, compte, debit, credit], ordre) => ({ factureId: brouillon.body.id, ordre, cle, tauxTva: cle === 'TVA:20' ? 20 : null, journalCode, compteNum: compte.code, compteLib: compte.libelle, debit, credit })) });
        await tx.facture.update({ where: { id: brouillon.body.id }, data: { ecrituresScellees: true } });
      });
      const document = await request(app).get(`/api/factures/${brouillon.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`); assert.equal(document.status, 409, document.text); assert.match(document.body.error, /adresse de facturation/i);
    });

    test('fige l’adresse de facturation du client dans le document PDF', async () => {
      const clientAdresse = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST Client adresse facture' });
      assert.equal(clientAdresse.status, 201, JSON.stringify(clientAdresse.body));
      const creerSite = corps => request(app).post(`/api/clients/${clientAdresse.body.id}/sites`).set('Authorization', `Bearer ${session}`).send(corps);
      assert.equal((await creerSite({ nom: 'A Site de chantier', adresse: '1 rue Ignorée', codePostal: '13001', ville: 'Marseille', estSiteIntervention: true })).status, 201);
      const facturation = await creerSite({ nom: 'Z Adresse de facturation', adresse: '7 quai de la Facturation', complementAdresse: 'Bâtiment C', codePostal: '69002', ville: 'Lyon', estSiteFacturation: true });
      assert.equal(facturation.status, 201, JSON.stringify(facturation.body));
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId: clientAdresse.body.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST adresse obligatoire', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST adresse obligatoire', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      assert.equal(emission.body.clientAdresse, '7 quai de la Facturation\nBâtiment C\n69002 Lyon');
      await prisma.clientSite.update({ where: { id: facturation.body.id }, data: { adresse: '99 avenue du Déménagement', complementAdresse: null, codePostal: '75009', ville: 'Paris' } });
      const document = await request(app).get(`/api/factures/${brouillon.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      const lecteurPdf = new PDFParse({ data: document.body }); const contenuPdf = await lecteurPdf.getText(); await lecteurPdf.destroy();
      assert.equal(document.status, 200, document.text); assert.match(contenuPdf.text, /7 quai de la Facturation/); assert.match(contenuPdf.text, /Bâtiment C/); assert.match(contenuPdf.text, /69002 Lyon/);
      assert.doesNotMatch(contenuPdf.text, /1 rue Ignorée|99 avenue du Déménagement/);
      await assert.rejects(() => prisma.facture.update({ where: { id: brouillon.body.id }, data: { clientAdresse: '99 avenue du Déménagement' } }));
      await assert.rejects(() => prisma.facture.update({ where: { id: brouillon.body.id }, data: { clientRaisonSociale: 'TEST Client réécrit' } }));
    });

    test('refuse le document d’une facture émise sans mentions figées', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST document sans mentions', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST document sans mentions', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal((await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
      await prisma.facture.update({ where: { id: brouillon.body.id }, data: { mentionsLegalesVersionId: null } });
      const document = await request(app).get(`/api/factures/${brouillon.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(document.status, 409, JSON.stringify(document.body)); assert.match(document.body.error, /mentions légales/i);
    });

    test('refuse d’émettre une facture pour un client sans adresse de facturation', async () => {
      const clientSansSite = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST Client sans site' });
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId: clientSansSite.body.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST adresse absente', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST adresse absente', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      const refus = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(refus.status, 409, JSON.stringify(refus.body)); assert.match(refus.body.error, /adresse de facturation/i);
      const enBase = await prisma.facture.findUnique({ where: { id: brouillon.body.id } }); assert.equal(enBase.numero, null); assert.equal(enBase.statut, 'BROUILLON');
    });

    test('protège l’autoliquidation BTP et signale les clients sans site sans barrage', async () => {
      const diagnostic = () => request(app).get('/api/facturation/prete-a-facturer').set('Authorization', `Bearer ${session}`);
      const controle = (corps, cle) => corps.controles.find((item) => item.cle === cle);
      const avant = await diagnostic();
      const client = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST client sans site diagnostic' });
      assert.equal(client.status, 201, JSON.stringify(client.body));
      const apres = await diagnostic();
      assert.equal(controle(apres.body, 'ADRESSES_CLIENTS').pret, false);
      assert.equal(controle(apres.body, 'ADRESSES_CLIENTS').bloquant, false);
      assert.equal(apres.body.pret, avant.body.pret);
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId: client.body.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST autoliquidation', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST sous-traitance', quantite: 1, prixUnitaireHt: 5000, tauxTva: 0 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const refus = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      await request(app).post(`/api/clients/${client.body.id}/sites`).set('Authorization', `Bearer ${session}`).send({ nom: 'TEST site', adresse: '1 rue du Test', codePostal: '14000', ville: 'Caen', estSiteFacturation: true });
      assert.equal((await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
      const compteTva = await prisma.compteComptable.findFirst({ where: { nature: 'TVA', actif: true } });
      assert.ok(compteTva);
      const exportAvant = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      const aCouvrir = exportAvant.status === 409 ? (exportAvant.body.tauxManquants || []) : [];
      for (const taux of aCouvrir) assert.equal((await request(app).put(`/api/comptabilite/tva/${taux}`).set('Authorization', `Bearer ${session}`).send({ compteId: compteTva.id })).status, 200);
      const diagCouvert = await diagnostic();
      const tva = controle(diagCouvert.body, 'TVA');
      assert.equal(tva.bloquant, false); assert.doesNotMatch(tva.detail, /0 %.*facturé/i);
      assert.equal(controle(diagCouvert.body, 'PREFIXE_FACTURE').pret, false);
      assert.equal(diagCouvert.body.pret, true, JSON.stringify(diagCouvert.body.controles));
      for (const taux of aCouvrir) await prisma.regleTvaComptable.deleteMany({ where: { taux } });
    });

    test('calcule la TVA sur la base HT cumulée par taux', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: Array.from({ length: 100 }, (_, index) => ({ designation: `TEST arrondi ${index}`, quantite: 1, prixUnitaireHt: 1.99, tauxTva: 20 })) });
      assert.equal(facture.status, 201, JSON.stringify(facture.body)); assert.equal(facture.body.totalHt, 199); assert.equal(facture.body.totalTva, 39.8); assert.equal(facture.body.totalTtc, 238.8);
    });

    test('arrondit commercialement les lignes facture et agrège les taux 20, 10 et 5,5', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Arrondi commercial multi-taux', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [20, 10, 5.5].map((tauxTva) => ({ designation: `TEST demi-centime ${tauxTva}`, quantite: '0.5', prixUnitaireHt: '4.27', tauxTva })),
      });
      assert.equal(facture.status, 201, JSON.stringify(facture.body));
      assert.deepEqual(facture.body.lignes.map((ligne) => ligne.totalHt), [2.14, 2.14, 2.14]);
      assert.deepEqual([facture.body.totalHt, facture.body.totalTva, facture.body.totalTtc], [6.42, 0.76, 7.18]);
      assert.equal(Math.round((facture.body.totalHt + facture.body.totalTva) * 100) / 100, facture.body.totalTtc);
    });

    test('arrondit au demi-centime le TTC de ligne et la TVA agrégée', async () => {
      // 9,00 € à 5,5 % ne distingue pas les formules ; 21,35 € à 10 % produit 2,135 €.
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TVA sur demi-centime', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [{ designation: 'TEST TVA agrégée', quantite: '1', prixUnitaireHt: '21.35', tauxTva: 10 }],
      });
      assert.equal(facture.status, 201, JSON.stringify(facture.body));
      assert.equal(facture.body.totalTva, 2.14);
      assert.equal(facture.body.lignes[0].totalTtc, 23.49);
      assert.equal(facture.body.totalTtc, facture.body.lignes[0].totalTtc);

      // Deuxième témoin, nécessaire en plus du premier : 21,35 € à 10 % ne tient que la
      // TVA agrégée. Son TTC flottant remonte à 23,49 par chance. À 9,00 € et 5,5 %, le
      // flottant descend à 9,49 : ce cas tient seul le TTC de la route POST /api/factures.
      const ttcSurDemiCentime = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TTC de ligne sur demi-centime', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [{ designation: 'TEST TTC de ligne', quantite: '1', prixUnitaireHt: '9.00', tauxTva: 5.5 }],
      });
      assert.equal(ttcSurDemiCentime.status, 201, JSON.stringify(ttcSurDemiCentime.body));
      assert.equal(ttcSurDemiCentime.body.lignes[0].totalTtc, 9.5, 'le TTC de ligne monte la demi-tranche');
      assert.equal(ttcSurDemiCentime.body.totalTtc, ttcSurDemiCentime.body.lignes[0].totalTtc, 'la ligne et le pied disent la même chose');
    });

    test('applique le même arrondi positif aux avoirs partiels et leur plafond', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Plafond avoir demi-centime', dateEmission: '11-09-2026', dateEcheance: '11-10-2026',
        lignes: [{ designation: 'TEST source demi-centime', quantite: '1', prixUnitaireHt: '9.00', tauxTva: 5.5 }, { designation: 'TEST source HT demi-centime', quantite: '0.5', prixUnitaireHt: '4.27', tauxTva: 20 }],
      });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const creer = (lignes) => request(app).post(`/api/factures/${emission.body.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({ lignes });
      const avoir = await creer([{ designation: 'TEST avoir demi-centime', quantite: '1', prixUnitaireHt: '9.00', tauxTva: 5.5 }, { designation: 'TEST avoir HT demi-centime', quantite: '0.5', prixUnitaireHt: '4.27', tauxTva: 20 }]);
      assert.equal(avoir.status, 201, JSON.stringify(avoir.body));
      assert.deepEqual([avoir.body.totalHt, avoir.body.totalTva, avoir.body.totalTtc], [11.14, 0.93, 12.07]);
      assert.equal(avoir.body.lignes[0].totalTtc, 9.5);
      assert.equal(avoir.body.lignes[1].totalHt, 2.14);
      assert.ok(avoir.body.totalHt > 0 && avoir.body.totalTva > 0 && avoir.body.totalTtc > 0, 'les avoirs sont stockés positifs');
      const depassement = await creer([{ designation: 'TEST avoir dépassement', quantite: 1, prixUnitaireHt: '0.01', tauxTva: 5.5 }]);
      assert.equal(depassement.status, 409, JSON.stringify(depassement.body));
    });

    test('refuse les factures incompatibles avec les contraintes métier', async () => {
      const creer = (corps) => request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', ...corps });
      assert.equal((await creer({ lignes: [] })).status, 400);
      assert.equal((await creer({ dateEcheance: '07-09-2026', lignes: [{ designation: 'TEST échéance', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] })).status, 400);
      const inactif = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST Client facture inactif' }); await prisma.client.update({ where: { id: inactif.body.id }, data: { actif: false } });
      assert.equal((await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId: inactif.body.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST inactif', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] })).status, 404);
      const excedent = await creer({ lignes: [{ designation: 'TEST dépassement', quantite: 999999999, prixUnitaireHt: 9999999999, tauxTva: 20 }] });
      assert.equal(excedent.status, 400, JSON.stringify(excedent.body)); assert.equal(/prisma|invocation|\/server\//i.test(excedent.body.error), false, excedent.body.error);
    });

    test('accepte les lignes offertes, l’exonération et les quantités à trois décimales', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST autoliquidation', quantite: 1, prixUnitaireHt: 1000, tauxTva: 0 }, { designation: 'TEST geste commercial', quantite: 1, prixUnitaireHt: 0, tauxTva: 20 }, { designation: 'TEST heures', quantite: 1.125, prixUnitaireHt: 80, tauxTva: 20, nature: 'ARTICLE' }] });
      assert.equal(facture.status, 201, JSON.stringify(facture.body)); assert.equal(facture.body.totalHt, 1090); assert.equal(facture.body.totalTva, 18); assert.equal(facture.body.totalTtc, 1108);
    });

    test('conserve le TTC propre à chaque ligne', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [1, 2, 3].map(rang => ({ designation: `TEST ligne ${rang}`, quantite: 1, prixUnitaireHt: 100, tauxTva: 20 })) });
      assert.equal(facture.status, 201, JSON.stringify(facture.body)); for (const ligne of facture.body.lignes) assert.equal(ligne.totalTtc, 120); assert.equal(facture.body.totalTtc, 360);
    });

    test('génère une seule intervention prévisionnelle par échéance de contrat', async () => {
      const premier = await request(app).post(`/api/contrats-maintenance/${contratId}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(premier.status, 201, JSON.stringify(premier.body));
      assert.equal(premier.body.statut, 'A_PLANIFIER');
      assert.equal(premier.body.client.id, clientId);
      assert.equal(premier.body.site.id, siteId);
      const second = await request(app).post(`/api/contrats-maintenance/${contratId}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(second.body.id, premier.body.id);
    });

    test('ne retourne jamais une intervention d’échéance antérieure après un P2002 de génération', async () => {
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST P2002 fallback', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-01-2025',
      });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const echeanceCourante = new Date('2026-01-01T00:00:00.000Z');
      await prisma.contratMaintenance.update({ where: { id: contrat.body.id }, data: { prochaineEcheance: echeanceCourante } });
      const interventionAnterieure = await prisma.intervention.create({ data: {
        reference: `TEST-I-P2002-ANTERIEURE-${Date.now()}`, clientId, siteId, contratMaintenanceId: contrat.body.id,
        echeanceContrat: new Date('2025-01-01T00:00:00.000Z'), dateDemande: new Date('2025-01-01T00:00:00.000Z'), titre: 'TEST Intervention échéance antérieure',
      } });
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "test_forcer_p2002_generation_contrat"()
        RETURNS TRIGGER AS $$
        BEGIN
          IF NEW."titre" = 'Maintenance préventive — TEST P2002 fallback' THEN
            RAISE EXCEPTION 'collision de test' USING ERRCODE = 'unique_violation';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER "test_forcer_p2002_generation_contrat"
        BEFORE INSERT ON "Intervention"
        FOR EACH ROW EXECUTE FUNCTION "test_forcer_p2002_generation_contrat"();`);
      try {
        const generation = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set('Authorization', `Bearer ${session}`);
        assert.equal(generation.status, 500, JSON.stringify(generation.body));
        assert.notEqual(generation.body.id, interventionAnterieure.id, 'le fallback ne doit pas divulguer l’intervention de l’échéance antérieure');
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "test_forcer_p2002_generation_contrat" ON "Intervention";');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS "test_forcer_p2002_generation_contrat"();');
      }
    });

    test('clôture une échéance avant de préparer la suivante', async () => {
      const intervention = await request(app).post(`/api/contrats-maintenance/${contratId}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(intervention.status, 200, JSON.stringify(intervention.body));
      // L'échéance ne bouge pas tant que son intervention n'est pas effectivement terminée.
      const avancementPremature = await request(app).post(`/api/contrats-maintenance/${contratId}/avancer-echeance`).set('Authorization', `Bearer ${session}`);
      assert.equal(avancementPremature.status, 409, JSON.stringify(avancementPremature.body));
      const tracesInitiales = await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: contratId } });
      for (const statut of ['PLANIFIEE', 'EN_COURS', 'TERMINEE']) {
        const transition = await request(app).patch(`/api/interventions/${intervention.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut });
        assert.equal(transition.status, 200, JSON.stringify(transition.body));
      }
      const avance = await request(app).post(`/api/contrats-maintenance/${contratId}/avancer-echeance`).set('Authorization', `Bearer ${session}`);
      assert.equal(avance.status, 200, JSON.stringify(avance.body));
      assert.equal(new Date(avance.body.prochaineEcheance).toISOString().slice(0, 10), '2027-03-08');
      const journal = await request(app).get(`/api/contrats-maintenance/${contratId}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.status, 200);
      assert.equal(journal.body.length, tracesInitiales + 1, 'une seule trace créée dans la même transaction');
      const trace = journal.body.find((ligne) => ligne.action === 'AVANCEMENT_ECHEANCE');
      assert.ok(trace, 'l’avancement est journalisé');
      assert.equal(trace.cible, 'CONTRAT');
      assert.equal(trace.cibleId, contratId);
      assert.equal(trace.contratMaintenanceId, contratId);
      assert.ok(trace.auteurId);
      assert.ok(trace.auteurNom);
      assert.match(trace.motif, new RegExp(intervention.body.reference));
      assert.equal(trace.avant.prochaineEcheance, intervention.body.echeanceContrat);
      assert.equal(trace.apres.prochaineEcheance, avance.body.prochaineEcheance);
      const secondeTentative = await request(app).post(`/api/contrats-maintenance/${contratId}/avancer-echeance`).set('Authorization', `Bearer ${session}`);
      assert.equal(secondeTentative.status, 409, JSON.stringify(secondeTentative.body));
      assert.equal(await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: contratId } }), tracesInitiales + 1, 'aucune trace de refus');
    });

    test('conserve le jour contractuel après un mois court', async () => {
      const contrat31 = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST Maintenance au 31', periodiciteMois: 1, dureePrevisionnelleMinutes: 60, dateDebut: '31-01-2027',
      });
      assert.equal(contrat31.status, 201, JSON.stringify(contrat31.body));
      const echeanceFevrier = new Date('2027-02-28T00:00:00.000Z');
      await prisma.contratMaintenance.update({ where: { id: contrat31.body.id }, data: { prochaineEcheance: echeanceFevrier } });
      await prisma.intervention.create({ data: {
        reference: `TEST-I-31-${Date.now()}`, clientId, siteId, contratMaintenanceId: contrat31.body.id, echeanceContrat: echeanceFevrier,
        titre: 'TEST Intervention échéance courte', statut: 'TERMINEE', dateSouhaitee: echeanceFevrier, dateDemande: echeanceFevrier,
      } });
      const avance = await request(app).post(`/api/contrats-maintenance/${contrat31.body.id}/avancer-echeance`).set('Authorization', `Bearer ${session}`);
      assert.equal(avance.status, 200, JSON.stringify(avance.body));
      assert.equal(new Date(avance.body.prochaineEcheance).toISOString().slice(0, 10), '2027-03-31');
    });

    test('suspend le contrat et bloque la génération tant qu’il n’est pas réactivé', async () => {
      const suspension = await request(app).patch(`/api/contrats-maintenance/${contratId}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'SUSPENDU', motif: 'Client indisponible pendant travaux' });
      assert.equal(suspension.status, 200, JSON.stringify(suspension.body));
      assert.equal(suspension.body.statut, 'SUSPENDU');
      const journal = await request(app).get(`/api/contrats-maintenance/${contratId}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      assert.equal(journal.body[0].action, 'SUSPENSION');
      assert.equal(journal.body[0].motif, 'Client indisponible pendant travaux');
      assert.ok(journal.body[0].auteurNom);
      assert.ok(journal.body[0].createdAt);
      const sansMotif = await request(app).patch(`/api/contrats-maintenance/${contratId}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'TERMINE' });
      assert.equal(sansMotif.status, 400, JSON.stringify(sansMotif.body));
      const generationRefusee = await request(app).post(`/api/contrats-maintenance/${contratId}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(generationRefusee.status, 404, JSON.stringify(generationRefusee.body));
      const reactivation = await request(app).patch(`/api/contrats-maintenance/${contratId}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ACTIF', motif: 'Reprise après travaux' });
      assert.equal(reactivation.status, 200, JSON.stringify(reactivation.body));
      assert.equal(reactivation.body.statut, 'ACTIF');
      const cloture = await request(app).patch(`/api/contrats-maintenance/${contratId}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'TERMINE', motif: 'Fin contractuelle confirmée' });
      assert.equal(cloture.status, 200, JSON.stringify(cloture.body));
      const repriseInterdite = await request(app).patch(`/api/contrats-maintenance/${contratId}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ACTIF', motif: 'Contrat terminé définitivement' });
      assert.equal(repriseInterdite.status, 409, JSON.stringify(repriseInterdite.body));
    });
  });

  describe('Identité de la société', () => {
    let session = '';
    before(async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = res.body.token;
    });

    test('refuse une couleur qui n’est pas un hexadécimal', async () => {
      const res = await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ couleurPrimaire: 'rouge' });
      assert.equal(res.status, 400);
    });

    test('enregistre et relit l’identité', async () => {
      const maj = await request(app).put('/api/company')
        .set('Authorization', `Bearer ${session}`)
        .send({ raisonSociale: 'TEST Société', couleurPrimaire: '#1E3A8A' });
      assert.equal(maj.status, 200);
      assert.equal(maj.body.couleurPrimaire, '#1e3a8a');

      const lecture = await request(app).get('/api/company').set('Authorization', `Bearer ${session}`);
      assert.equal(lecture.body.raisonSociale, 'TEST Société');
    });

    test('lit weekStart et weekEnd dans le fuseau société pour une référence instant', async () => {
      // Le dimanche 1er mars UTC est déjà lundi 2 mars à Wallis : l’API ne doit pas
      // répondre avec la semaine UTC précédente.
      const maj = await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: 'Pacific/Wallis' });
      assert.equal(maj.status, 200, JSON.stringify(maj.body));
      const res = await request(app)
        .get('/api/stats/conducteurs/assiduite')
        .query({ week: '2026-03-01T12:30:00.000Z' })
        .set('Authorization', `Bearer ${session}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.weekStart, '2026-03-02');
      assert.equal(res.body.weekEnd, '2026-03-06');
    });

    test('date la clôture d’un chantier au jour civil de la société, à minuit', async () => {
      const { aujourdHuiEntreprise } = await import('../dist/index.js');
      const jourUtc = new Date().toISOString().slice(0, 10);
      // On retient le fuseau dont le jour civil diffère d'UTC : Wallis (+12) le fait à
      // partir de 12:00 UTC, Tahiti (-10) jusqu'à 09:59. Fixer Wallis seule laisserait
      // le test aveugle douze heures par jour. Entre 10:00 et 11:59 UTC, aucun fuseau
      // français autorisé ne diffère d'UTC : cette fenêtre de deux heures est irréductible.
      const fuseau = aujourdHuiEntreprise('Pacific/Wallis') !== jourUtc ? 'Pacific/Wallis' : 'Pacific/Tahiti';
      const fuseauInitial = (await request(app).get('/api/company').set('Authorization', `Bearer ${session}`)).body.fuseauHoraire;
      const chantier = await prisma.chantier.create({
        data: { nom: 'TEST clôture fuseau', client: 'TEST', dateDebut: new Date(Date.UTC(2026, 8, 1)), budgetGlobalVendu: 1000, statut: 'EN_COURS' },
      });
      try {
        assert.equal((await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseau })).status, 200);
        const cloture = await request(app).patch(`/api/chantiers/${chantier.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'TERMINE' });
        assert.equal(cloture.status, 200, JSON.stringify(cloture.body));
        const relu = await prisma.chantier.findUnique({ where: { id: chantier.id }, select: { dateFin: true } });
        assert.equal(relu.dateFin.toISOString(), `${aujourdHuiEntreprise(fuseau)}T00:00:00.000Z`,
          `la clôture doit porter le jour civil de la société en ${fuseau}, à minuit`);
      } finally {
        await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseauInitial || 'Europe/Paris' });
        await prisma.chantier.delete({ where: { id: chantier.id } });
      }
    });

    test('range une saisie d’heures au jour et à l’heure de la société, pas d’UTC', async () => {
      // Mardi 09:00 à Wallis est lundi 21:00 UTC : cet instant sépare le jour et l'heure.
      // À 06:00 UTC, Wallis est aussi mardi : une route lisant le jour UTC passerait.
      const instantSaisie = new Date('2026-03-02T21:00:00.000Z');
      const fuseauInitial = (await request(app).get('/api/company').set('Authorization', `Bearer ${session}`)).body.fuseauHoraire;
      const conducteur = await prisma.user.create({ data: { email: 'assiduite.fuseau@iris.test', name: 'TEST Conducteur assiduité', role: 'CONDUCTEUR_TRAVAUX' } });
      const chantier = await prisma.chantier.create({
        data: { nom: 'TEST assiduité fuseau', client: 'TEST', dateDebut: new Date(Date.UTC(2026, 2, 1)), budgetGlobalVendu: 1000, responsableId: conducteur.id },
      });
      const intervenant = await prisma.intervenant.create({ data: { nom: 'TEST Intervenant assiduité', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      const pointage = await prisma.pointageHeure.create({
        data: { date: new Date(Date.UTC(2026, 2, 3)), intervenantId: intervenant.id, chantierId: chantier.id, nbrHeures: 7, tauxHoraireApplique: 30, createdAt: instantSaisie, createdById: conducteur.id, updatedById: conducteur.id },
      });
      try {
        assert.equal((await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: 'Pacific/Wallis' })).status, 200);
        const res = await request(app).get('/api/stats/conducteurs/assiduite').query({ week: '2026-03-02' }).set('Authorization', `Bearer ${session}`);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const ligne = res.body.conducteurs.find((c) => c.id === conducteur.id);
        assert.ok(ligne, 'le conducteur de test est absent de la réponse');
        assert.equal(ligne.days[1].nbSaisies, 1, 'la saisie appartient au mardi de Wallis');
        assert.equal(ligne.days[0].nbSaisies, 0, 'une arithmétique UTC la rangerait au lundi');
        assert.equal(ligne.heurePic, 9, 'l’heure de pic est 9h à Wallis, pas 21h UTC');
      } finally {
        await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseauInitial || 'Europe/Paris' });
        await prisma.pointageHeure.delete({ where: { id: pointage.id } });
        await prisma.chantier.delete({ where: { id: chantier.id } });
        await prisma.intervenant.delete({ where: { id: intervenant.id } });
        await prisma.user.delete({ where: { id: conducteur.id } });
      }
    });

    test('borne la période du tableau de bord dans le fuseau société', async () => {
      // À 13:00 UTC, Paris (le repli) est encore en février, Wallis déjà en mars. À
      // 23:30 UTC ils seraient tous deux en mars : le test passerait sans réglage société.
      const fuseauInitial = (await request(app).get('/api/company').set('Authorization', `Bearer ${session}`)).body.fuseauHoraire;
      try {
        assert.equal((await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: 'Pacific/Wallis' })).status, 200);
        const res = await request(app).get('/api/stats/global').query({ period: 'month', ref: '2026-02-28T13:00:00.000Z' }).set('Authorization', `Bearer ${session}`);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.periodStart, '2026-03-01', 'la période suit le jour civil de la société');
        assert.equal(res.body.periodEnd, '2026-03-31');
      } finally {
        await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseauInitial || 'Europe/Paris' });
      }
    });

    test('n’accepte que les fuseaux horaires français et expose le réglage', async () => {
      const invalide = await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: 'Europe/London' });
      assert.equal(invalide.status, 400, JSON.stringify(invalide.body));
      const maj = await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: 'Pacific/Noumea' });
      assert.equal(maj.status, 200, JSON.stringify(maj.body));
      assert.equal(maj.body.fuseauHoraire, 'Pacific/Noumea');
      const lecture = await request(app).get('/api/company').set('Authorization', `Bearer ${session}`);
      assert.equal(lecture.body.fuseauHoraire, 'Pacific/Noumea');
    });
  });
}
