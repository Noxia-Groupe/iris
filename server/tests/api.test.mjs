// Tests d'intégration : l'application Express est montée en mémoire et interrogée par
// de vraies requêtes HTTP, contre une vraie base PostgreSQL. Ce sont ces tests qui
// prouvent que les règles d'accès s'appliquent — pas la lecture du code source.
//
// Ils ont besoin d'une base JETABLE, indiquée par TEST_DATABASE_URL (cf. tests/README.md).
// Sans elle, la suite s'annonce ignorée : mieux vaut un « skip » visible qu'un vert obtenu
// sans avoir rien vérifié.
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

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
  const { app, initDb, ensureSuperAdmins } = await import('../dist/index.js');
  const { PrismaClient } = await import('@prisma/client');
  const jwt = (await import('jsonwebtoken')).default;
  const prisma = new PrismaClient();

  let cleApi = '';

  const nettoyer = async () => {
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
    await prisma.factureLigne.deleteMany({ where: { facture: { client: { raisonSociale: { startsWith: 'TEST ' } } } } });
    await prisma.facture.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
    await prisma.mentionsLegalesVersion.deleteMany({});
    await prisma.regleComptable.deleteMany({});
    await prisma.regleTvaComptable.deleteMany({});
    await prisma.compteComptable.deleteMany({});
    await prisma.sequenceFacture.deleteMany({});
    await prisma.intervention.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
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
    await prisma.user.deleteMany({ where: { email: { in: [
      'cycle.conducteur@iris.test', 'conducteur.test@iris.test', 'permissions@iris.test', 'commercial.permissions@iris.test',
      'sav.non-affecte@iris.test', 'sav.premier@iris.test', 'sav.second@iris.test', 'sav.journal@iris.test', 'sav.rapport@iris.test', 'sav.intrus@iris.test', 'sav.conducteur@iris.test', 'sav.responsable@iris.test', 'sav.tiers@iris.test', 'contrat.conducteur@iris.test', 'facture.conducteur@iris.test',
    ] } } });
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
    let idChantierA = '';
    let idChantierB = '';
    let idCategorie = '';
    let idFournisseur = '';
    let idIntervenant = '';

    before(async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = res.body.token;

      // Un conducteur, responsable d'un seul des deux chantiers.
      const conducteur = await prisma.user.upsert({
        where: { email: 'conducteur.test@iris.test' },
        update: { role: 'CONDUCTEUR_TRAVAUX', actif: true },
        create: { email: 'conducteur.test@iris.test', name: 'TEST Conducteur', role: 'CONDUCTEUR_TRAVAUX' },
      });
      const jwt = (await import('jsonwebtoken')).default;
      sessionConducteur = jwt.sign({ id: conducteur.id, role: 'CONDUCTEUR_TRAVAUX' }, process.env.JWT_SECRET);

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
          data: { date: new Date(), description: 'TEST achat', montantHT: 1000, chantierId, categorieId: categorie.id, fournisseurId: fournisseur.id },
        });
        await prisma.pointageHeure.create({
          data: { date: new Date(), nbrHeures: 7, tauxHoraireApplique: 40, chantierId, intervenantId: intervenant.id },
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
      const correction = await request(app).patch(`/api/achats/${creation.body.id}`).set('Authorization', `Bearer ${sessionConducteur}`).send({ montantHT: 50 });
      assert.equal(correction.status, 200);
      const archive = await request(app).delete(`/api/achats/${creation.body.id}`).set('Authorization', `Bearer ${sessionConducteur}`).send({ motifArchivage: 'Saisie en double' });
      assert.equal(archive.status, 200);
      const journal = await request(app).get('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`);
      assert.equal(journal.body.some((a) => a.id === creation.body.id), false);
      const traces = await prisma.journalSaisieChantier.findMany({ where: { cibleId: creation.body.id }, orderBy: { createdAt: 'asc' } });
      assert.equal(traces.length, 3);
      assert.equal(Number(traces.find((t) => t.action === 'CORRECTION').avant.montantHT), 500);
      assert.equal(Number(traces.find((t) => t.action === 'CORRECTION').apres.montantHT), 50);
    });

    test('le journal d’audit respecte le périmètre du conducteur', async () => {
      // Une trace ne doit pas devenir une porte latérale vers un chantier non rattaché.
      await prisma.journalSaisieChantier.create({
        data: { chantierId: idChantierB, cible: 'ACHAT', cibleId: 'test-hors-perimetre', action: 'CREATION', auteurNom: 'TEST Admin' },
      });
      const interdit = await request(app).get(`/api/chantiers/${idChantierB}/journal-saisies`).set('Authorization', `Bearer ${sessionConducteur}`);
      assert.equal(interdit.status, 404);
      const autorise = await request(app).get(`/api/chantiers/${idChantierA}/journal-saisies`).set('Authorization', `Bearer ${sessionConducteur}`);
      assert.equal(autorise.status, 200);
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

    test('garantit HT + TVA = TTC avec un taux réduit', async () => {
      const res = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({ clientId, objet: 'Rénovation', lignes: [{ designation: 'Fourniture posée', quantite: 1, prixUnitaireHt: 5, tauxTva: 5.5 }] });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.totalHt + res.body.totalTva, res.body.totalTtc);
      assert.equal(res.body.totalTtc, 5.28);
    });

    test('révise un devis sans modifier sa version validée', async () => {
      const res = await request(app).post(`/api/devis/${devisId}/revisions`).set('Authorization', `Bearer ${session}`);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.version, 2);
      assert.equal(res.body.statut, 'BROUILLON');
      assert.equal(res.body.dossierId, dossierId);
      assert.equal(res.body.numero, numero);
    });

    test('ne crée un chantier qu’après acceptation, avec la même référence affaire', async () => {
      const avant = await request(app).post(`/api/devis/${devisId}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });
      assert.equal(avant.status, 400);
      const envoye = await request(app).put(`/api/devis/${devisId}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ENVOYE' });
      assert.equal(envoye.status, 200);
      const accepte = await request(app).put(`/api/devis/${devisId}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ACCEPTE' });
      assert.equal(accepte.status, 200);
      const conversion = await request(app).post(`/api/devis/${devisId}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });
      assert.equal(conversion.status, 201, JSON.stringify(conversion.body));
      assert.equal(conversion.body.numeroDevis, numero);
      const doublon = await request(app).post(`/api/devis/${devisId}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });
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
      await request(app).put(`/api/devis/${devis.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ACCEPTE' });
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
      await request(app).put(`/api/devis/${cree.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ENVOYE' });
      await request(app).put(`/api/devis/${cree.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ACCEPTE' });
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
      await prisma.pointageHeure.create({ data: { date: new Date(), nbrHeures: 3, tauxHoraireApplique: 40, chantierId: chantier.id, intervenantId } });

      const refus = await request(app).post(`/api/devis/${devis.id}/annulation`).set('Authorization', `Bearer ${session}`).send({ motif: 'erreur de saisie' });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.match(refus.body.error, /pointage/);
      assert.equal((await prisma.devis.findUnique({ where: { id: devis.id } })).statut, 'ACCEPTE', 'le devis n’a pas bougé');
      assert.equal((await prisma.chantier.findUnique({ where: { id: chantier.id } })).statut, 'EN_COURS');
    });

    test('un achat suffit lui aussi à verrouiller l’annulation', async () => {
      const devis = await devisAccepte('TEST Affaire approvisionnée');
      const chantier = (await convertir(devis.id)).body;
      await prisma.achatReel.create({ data: { date: new Date(), description: 'TEST matériel', montantHT: 500, chantierId: chantier.id, categorieId, fournisseurId } });

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
        .send({ montantHT: 50 });
      assert.equal(correction.status, 200, JSON.stringify(correction.body));

      const journal = await request(app).get(`/api/chantiers/${chantier.id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      assert.equal(journal.body.length, 2);
      const correctionJournal = journal.body.find((entree) => entree.action === 'CORRECTION');
      assert.equal(correctionJournal.avant.montantHT, 500);
      assert.equal(correctionJournal.apres.montantHT, 50);
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
      await assert.rejects(() => prisma.journalSaisieChantier.create({ data: {
        chantierId: null, interventionId: null, cible: 'INTERVENTION', cibleId: 'TEST-parent-absent', action: 'CREATION', auteurNom: 'TEST',
      } }));
      await assert.rejects(() => prisma.journalSaisieChantier.create({ data: {
        chantierId: 'TEST-chantier-inexistant', interventionId: 'TEST-intervention-inexistante', cible: 'INTERVENTION', cibleId: 'TEST-double-parent', action: 'CREATION', auteurNom: 'TEST',
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
        clientId, titre: 'TEST Alarme déclenchée', description: 'Le client signale un déclenchement intempestif.', priorite: 'HAUTE', dateSouhaitee: '06-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      assert.match(creation.body.reference, /^I\d{2}-\d{4,}$/);
      assert.equal(creation.body.statut, 'A_PLANIFIER');
      assert.equal(creation.body.priorite, 'HAUTE');
      assert.equal(creation.body.client.id, clientId);
    });
  });

  describe('Contrats de maintenance cyclique', () => {
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

    test('paramètre un compte comptable sans imposer de plan préchargé', async () => {
      const compte = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code: '706100', libelle: 'Prestations techniques', nature: 'PRODUIT' });
      assert.equal(compte.status, 201, JSON.stringify(compte.body));
      assert.equal(compte.body.code, '706100');
      const regle = await request(app).put('/api/comptabilite/regles/VENTE_PRESTATION').set('Authorization', `Bearer ${session}`).send({ compteId: compte.body.id });
      assert.equal(regle.status, 200, JSON.stringify(regle.body));
      assert.equal(regle.body.compteId, compte.body.id);
    });

    test('importe un plan comptable contrôlé ligne par ligne', async () => {
      const importation = await request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ lignes: [{ code: '411000', libelle: 'Clients', nature: 'ACTIF' }, { code: '445710', libelle: 'TVA collectée', nature: 'TVA' }] });
      assert.equal(importation.status, 201, JSON.stringify(importation.body));
      assert.equal(importation.body.importes, 2);
    });

    test('réserve factures et comptabilité à l’administration', async () => {
      const conducteur = await prisma.user.create({ data: { email: 'facture.conducteur@iris.test', name: 'TEST Conducteur facture', role: 'CONDUCTEUR_TRAVAUX' } });
      const token = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const routes = [() => request(app).get('/api/factures'), () => request(app).post('/api/factures').send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] }), () => request(app).get('/api/factures/export-comptable.csv'), () => request(app).get('/api/comptabilite'), () => request(app).post('/api/comptabilite/comptes').send({ code: '999999', libelle: 'TEST interdit', nature: 'PRODUIT' }), () => request(app).post('/api/comptabilite/importer').send({ lignes: [{ code: '999998', libelle: 'TEST interdit', nature: 'PRODUIT' }] }), () => request(app).post('/api/factures/inexistante/emettre'), () => request(app).put('/api/comptabilite/regles/CLIENT').send({ compteId: 'peu-importe' }), () => request(app).put('/api/comptabilite/tva/20').send({ compteId: 'peu-importe' })];
      for (const route of routes) assert.equal((await route().set('Authorization', `Bearer ${token}`)).status, 403);
    });

    test('refuse une date d’émission future', async () => {
      const reponse = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '01-01-2099', dateEcheance: '01-02-2099', lignes: [{ designation: 'TEST future', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(reponse.status, 400); assert.match(reponse.body.error, /future/i);
    });

    test('refuse l’émission sans mentions légales publiées', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Facture en attente de paramétrage', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST mentions absentes', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      await prisma.mentionsLegalesVersion.deleteMany({});
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 409, JSON.stringify(emission.body));
      await prisma.mentionsLegalesVersion.create({ data: { version: 1, mentions: 'TEST Mentions légales', cgv: 'TEST Conditions générales', penalites: 'TEST Pénalités de retard', actif: true, publieeLe: new Date() } });
    });

    test('attribue un numéro annuel seulement lors de l’émission', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST Émission facture', quantite: 1, prixUnitaireHt: 50, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      assert.equal(emission.body.statut, 'EMISE');
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
      assert.equal(exportIncomplet.status, 409); assert.deepEqual(exportIncomplet.body.manquantes, ['JOURNAL_VENTES']);
      await prisma.regleComptable.create({ data: { cle: 'JOURNAL_VENTES', journal: journal.journal } });
      await prisma.regleTvaComptable.deleteMany({ where: { taux: 20 } });
      const exportSansTva = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportSansTva.status, 409); assert.deepEqual(exportSansTva.body.tauxManquants, [20]);
      await request(app).put('/api/comptabilite/tva/20').set('Authorization', `Bearer ${session}`).send({ compteId: compte('445710').id });
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

    test('calcule la TVA sur la base HT cumulée par taux', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: Array.from({ length: 100 }, (_, index) => ({ designation: `TEST arrondi ${index}`, quantite: 1, prixUnitaireHt: 1.99, tauxTva: 20 })) });
      assert.equal(facture.status, 201, JSON.stringify(facture.body)); assert.equal(facture.body.totalHt, 199); assert.equal(facture.body.totalTva, 39.8); assert.equal(facture.body.totalTtc, 238.8);
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

    test('clôture une échéance avant de préparer la suivante', async () => {
      const intervention = await request(app).post(`/api/contrats-maintenance/${contratId}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(intervention.status, 200, JSON.stringify(intervention.body));
      // L'échéance ne bouge pas tant que son intervention n'est pas effectivement terminée.
      const avancementPremature = await request(app).post(`/api/contrats-maintenance/${contratId}/avancer-echeance`).set('Authorization', `Bearer ${session}`);
      assert.equal(avancementPremature.status, 409, JSON.stringify(avancementPremature.body));
      for (const statut of ['PLANIFIEE', 'EN_COURS', 'TERMINEE']) {
        const transition = await request(app).patch(`/api/interventions/${intervention.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut });
        assert.equal(transition.status, 200, JSON.stringify(transition.body));
      }
      const avance = await request(app).post(`/api/contrats-maintenance/${contratId}/avancer-echeance`).set('Authorization', `Bearer ${session}`);
      assert.equal(avance.status, 200, JSON.stringify(avance.body));
      assert.equal(new Date(avance.body.prochaineEcheance).toISOString().slice(0, 10), '2027-03-08');
      const secondeTentative = await request(app).post(`/api/contrats-maintenance/${contratId}/avancer-echeance`).set('Authorization', `Bearer ${session}`);
      assert.equal(secondeTentative.status, 409, JSON.stringify(secondeTentative.body));
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
        titre: 'TEST Intervention échéance courte', statut: 'TERMINEE', dateSouhaitee: echeanceFevrier,
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
      const reactivation = await request(app).patch(`/api/contrats-maintenance/${contratId}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ACTIF' });
      assert.equal(reactivation.status, 200, JSON.stringify(reactivation.body));
      assert.equal(reactivation.body.statut, 'ACTIF');
      const cloture = await request(app).patch(`/api/contrats-maintenance/${contratId}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'TERMINE', motif: 'Fin contractuelle confirmée' });
      assert.equal(cloture.status, 200, JSON.stringify(cloture.body));
      const repriseInterdite = await request(app).patch(`/api/contrats-maintenance/${contratId}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ACTIF' });
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
  });
}
