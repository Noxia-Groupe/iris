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
  const prisma = new PrismaClient();

  let cleApi = '';

  const nettoyer = async () => {
    // Une conversion garde le lien vers le devis : elle part avant le devis et sa fiche client.
    await prisma.devisConversion.deleteMany({ where: { devis: { client: { raisonSociale: { startsWith: 'TEST ' } } } } });
    // Les devis dépendent du client ; ils doivent être retirés avant la fiche client.
    await prisma.devis.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
    // Le parc dépend à la fois du client/site et du catalogue : il part donc en premier.
    await prisma.equipementInstalle.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
    await prisma.clientSite.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
    await prisma.clientContact.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
    await prisma.client.deleteMany({ where: { raisonSociale: { startsWith: 'TEST ' } } });
    await prisma.cataloguePrestation.deleteMany({ where: { reference: { startsWith: 'TEST-' } } });
    await prisma.catalogueArticle.deleteMany({ where: { reference: { startsWith: 'TEST-' } } });
    await prisma.catalogueEquipement.deleteMany({ where: { reference: { startsWith: 'TEST-' } } });
    await prisma.apiAccessKey.deleteMany({ where: { nom: { startsWith: 'TEST ' } } });
    // Domaine chantier : l'ordre suit les clés étrangères — les lignes rattachées d'abord.
    await prisma.achatReel.deleteMany({ where: { chantier: { nom: { startsWith: 'TEST ' } } } });
    await prisma.pointageHeure.deleteMany({ where: { chantier: { nom: { startsWith: 'TEST ' } } } });
    await prisma.chantier.deleteMany({ where: { nom: { startsWith: 'TEST ' } } });
    // Un chantier né d'une conversion porte la raison sociale du client dans `client` ; son
    // `nom` reprend l'objet du devis et n'a donc pas le préfixe TEST. Sans cette ligne,
    // chaque exécution en laisserait un derrière elle. Elle vient APRÈS les achats et les
    // heures, qui référencent le chantier.
    await prisma.chantier.deleteMany({ where: { client: { startsWith: 'TEST ' } } });
    await prisma.intervenant.deleteMany({ where: { nom: { startsWith: 'TEST ' } } });
    await prisma.categorie.deleteMany({ where: { nom: { startsWith: 'TEST ' } } });
    await prisma.fournisseur.deleteMany({ where: { nom: { startsWith: 'TEST ' } } });
    await prisma.user.deleteMany({ where: { email: { in: ['conducteur.test@iris.test', 'permissions@iris.test', 'commercial.permissions@iris.test'] } } });
  };

  before(async () => {
    await initDb();
    await ensureSuperAdmins();
    // Une exécution précédente interrompue a pu laisser des enregistrements : on part
    // toujours d'un état propre, sinon la suite n'est rejouable qu'une fois.
    await nettoyer();
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
