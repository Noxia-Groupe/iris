// Lot 6a-4a : PDF du compte rendu d'intervention (cadrage du lot 6a-4, version 2 du 31-10-2026,
// section « 6a-4a » ; décisions de Nelson du 22-10-2026, point 4 « Tous type de document », et du
// 31-10-2026, « le prochain lot est la fin du lot 6 »).
//
// Requêtes HTTP réelles sur l'application montée en mémoire, contre un vrai PostgreSQL, comme
// api.test.mjs. Ce fichier a pourtant sa propre base : `node --test` exécute les fichiers de tests
// en parallèle (Node 20, un processus par fichier), et api.test.mjs, qui tourne en même temps sur
// TEST_DATABASE_URL, purge toutes les données « TEST » et change l'identité de la société en cours
// de route. Ce fichier crée donc, à côté de la base de TEST_DATABASE_URL et sur le même serveur, une
// base jetable qui n'appartient qu'à lui, la migre, puis la supprime, comme les tests de migration.
// Sans TEST_DATABASE_URL, il s'annonce ignoré : un SKIP n'est pas une réussite.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import { PDFParse } from 'pdf-parse';

const TITRE = 'Lot 6a-4a : PDF du compte rendu d’intervention';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// --- Outils sans base : texte et tracés d'un PDF, dates attendues ---

// Texte aplati : un repli de ligne du PDF ne doit pas faire échouer la recherche d'une phrase.
const aplatir = (texte) => texte.replace(/\s+/g, ' ');
const sansBlancs = (texte) => texte.replace(/\s+/g, '');
const occurrences = (texte, motif) => texte.split(motif).length - 1;

// « JJ-MM-AAAA HH:MM » d'un instant dans un fuseau (cadrage : date et heure de chaque compte rendu
// au fuseau de la société, en JJ-MM-AAAA HH:MM).
function dateHeure(instant, fuseau) {
  const parties = new Intl.DateTimeFormat('en-GB', {
    timeZone: fuseau, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const valeur = (type) => parties.find((partie) => partie.type === type).value;
  return `${valeur('day')}-${valeur('month')}-${valeur('year')} ${valeur('hour')}:${valeur('minute')}`;
}
const jour = (instant, fuseau) => dateHeure(instant, fuseau).slice(0, 10);

// Chemins tracés au trait (opérateurs m et l, peints par S, s, B ou b) de tous les flux de contenu,
// en coordonnées de la page : la matrice courante (q, Q, cm) est appliquée à chaque point, si bien
// qu'un tracé dessiné sous une mise à l'échelle se retrouve comme un tracé dessiné en points.
function cheminsTraces(octets) {
  const brut = octets.toString('latin1');
  const chemins = [];
  for (const flux of brut.matchAll(/stream\r?\n/g)) {
    const debut = flux.index + flux[0].length;
    let contenu;
    try { contenu = inflateSync(octets.subarray(debut, brut.indexOf('endstream', debut))).toString('latin1'); } catch { continue; }
    let matrice = [1, 0, 0, 1, 0, 0];
    const pile = [];
    let operandes = [];
    let courant = null;
    let enCours = [];
    const appliquer = ([x, y]) => [matrice[0] * x + matrice[2] * y + matrice[4], matrice[1] * x + matrice[3] * y + matrice[5]];
    const jetons = contenu.match(/\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>|\[|\]|\/[^\s/[\]()<>]+|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z'"*]+/g) ?? [];
    for (const jeton of jetons) {
      if (/^[-+]?(?:\d|\.\d)/.test(jeton)) { operandes.push(Number(jeton)); continue; }
      if (!/^[A-Za-z'"*]+$/.test(jeton)) continue;
      switch (jeton) {
        case 'q': pile.push(matrice); break;
        case 'Q': matrice = pile.pop() ?? [1, 0, 0, 1, 0, 0]; break;
        case 'cm': {
          const [a, b, c, d, e, f] = operandes.slice(-6);
          const [A, B, C, D, E, F] = matrice;
          matrice = [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
          break;
        }
        case 'm': courant = [appliquer(operandes.slice(-2))]; enCours.push(courant); break;
        case 'l': if (courant) courant.push(appliquer(operandes.slice(-2))); break;
        case 'c': case 'v': case 'y': if (courant) { courant.courbe = true; courant.push(appliquer(operandes.slice(-2))); } break;
        case 're': courant = null; break;
        case 'S': case 's': case 'B': case 'B*': case 'b': case 'b*': chemins.push(...enCours.filter((chemin) => !chemin.courbe)); enCours = []; courant = null; break;
        case 'f': case 'F': case 'f*': case 'n': enCours = []; courant = null; break;
        default: break;
      }
      operandes = [];
    }
  }
  return chemins;
}

// Ajuste, axe par axe, les points d'un chemin aux points normalisés d'un trait : X = origine + pente × x.
function ajuster(points, normalises) {
  const axe = (mesures, reperes) => {
    const n = mesures.length;
    const moyenneRepere = reperes.reduce((s, v) => s + v, 0) / n;
    const moyenneMesure = mesures.reduce((s, v) => s + v, 0) / n;
    const variance = reperes.reduce((s, v) => s + (v - moyenneRepere) ** 2, 0);
    if (variance === 0) return null;
    const pente = reperes.reduce((s, v, i) => s + (v - moyenneRepere) * (mesures[i] - moyenneMesure), 0) / variance;
    const origine = moyenneMesure - pente * moyenneRepere;
    const ecart = Math.max(...reperes.map((v, i) => Math.abs(mesures[i] - (origine + pente * v))));
    return { pente, origine, ecart };
  };
  const x = axe(points.map(([X]) => X), normalises.map(([px]) => px));
  const y = axe(points.map(([, Y]) => Y), normalises.map(([, py]) => py));
  return x && y ? { x, y } : null;
}

// Le tracé est reproduit en vectoriel s'il existe, pour chaque trait, un chemin tracé de même nombre de
// points, posé sur un même cadre pour tous les traits, au ratio du tracé (largeur / hauteur), ni
// déformé, ni retourné : x croît vers la droite, y vers le bas de la zone (repère du dessin à l'écran),
// soit vers le bas de la page, dont l'axe vertical du PDF monte.
function traceReproduit(chemins, trace) {
  const candidats = trace.traits.map((trait) => chemins
    .filter((chemin) => chemin.length === trait.length)
    .map((chemin) => ajuster(chemin, trait))
    .filter((cadre) => cadre && cadre.x.pente > 10 && cadre.y.pente < -4 && cadre.x.ecart < 0.1 && cadre.y.ecart < 0.1
      && Math.abs(cadre.x.pente / -cadre.y.pente - trace.ratio) < trace.ratio * 0.01));
  const meme = (a, b) => ['x', 'y'].every((k) => Math.abs(a[k].pente - b[k].pente) < 0.2 && Math.abs(a[k].origine - b[k].origine) < 0.2);
  return candidats[0].some((cadre) => candidats.every((liste) => liste.some((autre) => meme(cadre, autre))));
}

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const source = new URL(TEST_DATABASE_URL);
    const nomBase = `iris_test_cr_pdf_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
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
    let rang = 0;
    const suffixe = () => `${Date.now()}${(rang += 1)}`;

    // Identité de la société : complète, et distincte des adresses des clients et des sites, si bien que
    // chaque ligne attendue ne peut venir que de sa source.
    const SOCIETE_A = {
      raisonSociale: 'TEST Émetteur CR A', nomCommercial: '', siret: '55555555500055', tvaIntra: '',
      adresse: '9 rue de l’Émetteur', codePostal: '50000', ville: 'Saint-Lô', pays: 'France', telephone: '02 33 00 00 05',
      email: 'emetteur-cr-a@iris.test', siteWeb: '', piedFacture: 'TEST Pied CR A', couleurPrimaire: '#0f766e', fuseauHoraire: 'Europe/Paris',
    };
    const SOCIETE_B = { ...SOCIETE_A, raisonSociale: 'TEST Émetteur CR B', siret: '66666666600066', adresse: '6 avenue Changée', piedFacture: 'TEST Pied CR B' };

    // Deux traits de longueurs différentes, au ratio 2,5 ; un tracé plus simple, au ratio 2.
    const TRACE_DEUX_TRAITS = { ratio: 2.5, traits: [
      [[0.1, 0.2], [0.3, 0.8], [0.5, 0.25], [0.7, 0.9], [0.9, 0.4]],
      [[0.2, 0.6], [0.8, 0.55], [0.6, 0.1]],
    ] };
    const TRACE_SIMPLE = { ratio: 2, traits: [[[0.1, 0.6], [0.25, 0.3], [0.4, 0.7], [0.6, 0.35]]] };

    const definirSociete = async (champs) => {
      const res = await request(app).put('/api/company').set(admin()).send(champs);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    };
    const creerClient = async (raisonSociale) => {
      const res = await request(app).post('/api/clients').set(admin()).send({ raisonSociale });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body;
    };
    const creerCompte = (role, cle, s) => prisma.user.create({ data: { email: `crpdf.${cle}.${s}@iris.test`, name: `TEST ${cle} ${s}`, role } });
    // Technicien : un compte et sa fiche d'intervenant, au taux chargé de 57,89 €, qu'aucun PDF n'imprime.
    const compteTechnicien = async (cle, s, nom = cle) => {
      const compte = await prisma.user.create({ data: { email: `crpdf.technicien.${cle.toLowerCase()}.${s}@iris.test`, name: `TEST Technicien ${nom} ${s}`, role: 'TECHNICIEN' } });
      const intervenant = await prisma.intervenant.create({ data: { nom: `TEST Intervenant ${nom} ${s}`, role: 'Technicien', tauxHoraireCharge: 57.89, userId: compte.id } });
      return { compte, jeton: jetonDe(compte), intervenantId: intervenant.id, nomIntervenant: intervenant.nom };
    };
    const creerIntervention = async (donnees, auth = admin()) => {
      const res = await request(app).post('/api/interventions').set(auth).send(donnees);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body;
    };
    const planifier = async (interventionId, intervenantIds) => {
      const res = await request(app).put(`/api/interventions/${interventionId}/planning`).set(admin())
        .send({ dateDebut: new Date().toISOString().slice(0, 10), creneau: 'JOURNEE', intervenantIds });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    };
    const changerStatut = async (interventionId, statut, extra = {}) => {
      const res = await request(app).patch(`/api/interventions/${interventionId}/statut`).set(admin()).send({ statut, ...extra });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body;
    };
    const demarrer = async (interventionId) => {
      const { statut } = await prisma.intervention.findUniqueOrThrow({ where: { id: interventionId }, select: { statut: true } });
      if (statut === 'A_PLANIFIER') await changerStatut(interventionId, 'PLANIFIEE');
      await changerStatut(interventionId, 'EN_COURS');
    };
    const ajouterCompteRendu = async (interventionId, contenu, jeton = session) => {
      const res = await request(app).post(`/api/interventions/${interventionId}/rapports`).set(entete(jeton)).send({ contenu, cleEnvoi: randomUUID() });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body;
    };
    const signer = async (rapportId, signataire, trace = TRACE_SIMPLE) => {
      const res = await request(app).post(`/api/interventions/rapports/${rapportId}/signature`).set(admin()).send({ signataire, confirme: true, trace });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body;
    };
    // Une intervention en cours, avec ses comptes rendus (textes donnés), écrits par l'administration.
    const interventionAvecComptesRendus = async (s, contenus, donnees = {}) => {
      const client = donnees.clientId ? null : await creerClient(`TEST Client CR ${s}`);
      const intervention = await creerIntervention({ clientId: client?.id, titre: `TEST Demande ${s}`, ...donnees });
      await demarrer(intervention.id);
      const rapports = [];
      for (const contenu of contenus) rapports.push(await ajouterCompteRendu(intervention.id, contenu));
      return { client, intervention, rapports };
    };

    const binaire = (reponse, fin) => { const morceaux = []; reponse.on('data', (m) => morceaux.push(m)); reponse.on('end', () => fin(null, Buffer.concat(morceaux))); };
    const pdfCompteRendu = (interventionId, auth = admin()) => {
      const requete = request(app).get(`/api/interventions/${interventionId}/document.pdf`);
      return (auth ? requete.set(auth) : requete).buffer(true).parse(binaire);
    };
    const erreurDe = (res) => JSON.parse(res.body.toString('utf8')).error;
    const lirePdf = async (interventionId, auth = admin()) => {
      const res = await pdfCompteRendu(interventionId, auth);
      assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 500));
      assert.equal(res.headers['content-type'], 'application/pdf');
      assert.equal(res.body.subarray(0, 5).toString('latin1'), '%PDF-');
      const lecteur = new PDFParse({ data: res.body });
      const { text } = await lecteur.getText();
      await lecteur.destroy();
      return { octets: res.body, texte: text, plat: aplatir(text), disposition: res.headers['content-disposition'] };
    };
    // Ce que le PDF ne doit jamais écrire : ni journal, ni compte rendu, ni signature.
    const etatEcrit = async (interventionIds) => ({
      journal: await prisma.journalSaisieChantier.count({ where: { interventionId: { in: interventionIds } } }),
      rapports: await prisma.interventionRapport.count({ where: { interventionId: { in: interventionIds } } }),
      signatures: await prisma.interventionSignature.count({ where: { rapport: { interventionId: { in: interventionIds } } } }),
      statuts: (await prisma.intervention.findMany({ where: { id: { in: interventionIds } }, select: { id: true, statut: true, updatedAt: true }, orderBy: { id: 'asc' } })).map((i) => `${i.id}:${i.statut}:${i.updatedAt.toISOString()}`),
    });

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
      secours = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' }, select: { id: true, name: true } });
      assert.ok(secours.name, 'le compte de secours porte un nom');
      await definirSociete(SOCIETE_A);
    });

    after(async () => {
      await prisma?.$disconnect().catch(() => {});
      await appPrisma?.$disconnect().catch(() => {});
      if (baseCreee) await administrationPg.query(`DROP DATABASE IF EXISTS "${nomBase}" WITH (FORCE)`);
      await administrationPg.end().catch(() => {});
    });

    // Cadrage, « Contenu imprimé » : en-tête à l'identité actuelle ; intervention (titre du document,
    // référence, titre et description de la demande, client, site et adresse, contact, intervenants
    // affectés, date de la demande) ; chaque compte rendu dans l'ordre, avec sa date et son heure au
    // fuseau de la société (JJ-MM-AAAA HH:MM), son auteur et son texte, et sa signature (signataire, date
    // d'acceptation, empreinte). Choix par défaut, à confirmer : « Un seul PDF par intervention, avec tous
    // ses comptes rendus ».
    test('contenu : identité, demande, client, site, contact, intervenants, date de la demande, puis chaque compte rendu dans l’ordre, au fuseau de la société', async () => {
      const s = suffixe();
      // Fuseau des Marquises (UTC−9:30) : l'heure imprimée diffère toujours, minutes comprises, de celle
      // d'UTC et de celle de Paris ; une date-seule relue dans ce fuseau reculerait d'un jour.
      const FUSEAU = 'Pacific/Marquesas';
      await definirSociete({ fuseauHoraire: FUSEAU });
      try {
        const client = await creerClient(`TEST Client CR ${s}`);
        const site = await prisma.clientSite.create({ data: { clientId: client.id, nom: `TEST Chaufferie CR ${s}`, adresse: '2 rue du Parcours', codePostal: '14000', ville: 'Caen' } });
        const contact = await prisma.clientContact.create({ data: { clientId: client.id, prenom: 'Alice', nom: 'Martin', telephone: '06 12 34 56 78', email: 'alice.martin@client-cr.test' } });
        const alpha = await compteTechnicien('Alpha', s);
        // Intervenant affecté sans compte ni compte rendu : son nom ne peut venir que de la liste des intervenants.
        const beta = await prisma.intervenant.create({ data: { nom: `TEST Intervenant Bêta ${s}`, role: 'Technicien', tauxHoraireCharge: 57.89 } });
        const intervention = await creerIntervention({
          clientId: client.id, siteId: site.id, contactId: contact.id, titre: `TEST Titre de la demande ${s}`,
          description: 'TEST Description : fuite sous l’évier de la cuisine.', dateDemande: '03-02-2026',
        });
        await planifier(intervention.id, [alpha.intervenantId, beta.id]);
        await demarrer(intervention.id);
        const premier = await ajouterCompteRendu(intervention.id, 'TEST Premier compte rendu : diagnostic de la fuite.', alpha.jeton);
        const deuxieme = await ajouterCompteRendu(intervention.id, 'TEST Deuxième compte rendu : joint remplacé.', session);
        const troisieme = await ajouterCompteRendu(intervention.id, 'TEST Troisième compte rendu : essai concluant.', alpha.jeton);
        const signature = await signer(deuxieme.id, 'TEST Claire Dupont', TRACE_DEUX_TRAITS);
        // Les comptes rendus d'une autre intervention n'entrent pas dans ce PDF.
        const autre = await interventionAvecComptesRendus(s, ['TEST Compte rendu d’une autre intervention.'], { clientId: client.id });

        const avant = await etatEcrit([intervention.id, autre.intervention.id]);
        const { texte, plat, disposition } = await lirePdf(intervention.id);
        assert.match(disposition, new RegExp(`filename="Compte-rendu-${intervention.reference}\\.pdf"`), disposition);
        // Titre du document, à l'apostrophe droite du cadrage.
        assert.ok(plat.includes('Compte rendu d\'intervention'), texte);
        for (const attendu of [
          // En-tête : identité actuelle de la société.
          'TEST Émetteur CR A', 'SIRET 55555555500055', '9 rue de l’Émetteur', '50000 Saint-Lô',
          // Intervention.
          intervention.reference, `TEST Titre de la demande ${s}`, 'TEST Description : fuite sous l’évier de la cuisine.',
          client.raisonSociale, `TEST Chaufferie CR ${s}`, '2 rue du Parcours', '14000 Caen', 'Alice Martin',
          alpha.nomIntervenant, `TEST Intervenant Bêta ${s}`,
          // Date de la demande, date-seule imprimée telle quelle.
          '03-02-2026',
          // Comptes rendus : texte, auteur, date et heure au fuseau de la société.
          premier.contenu, deuxieme.contenu, troisieme.contenu, `TEST Technicien Alpha ${s}`, secours.name,
          dateHeure(premier.createdAt, FUSEAU), dateHeure(deuxieme.createdAt, FUSEAU), dateHeure(troisieme.createdAt, FUSEAU),
          // Signature : signataire et date d'acceptation (jour de la société).
          `Signé par TEST Claire Dupont le ${jour(signature.accepteLe, FUSEAU)}.`,
        ]) assert.ok(plat.includes(attendu), `absent du PDF : ${attendu}\n${texte}`);
        assert.ok(sansBlancs(texte).includes(signature.empreinte), `empreinte de la signature absente\n${texte}`);
        // Lectures écartées : la date de la demande relue dans le fuseau (02-02-2026), l'heure d'UTC ou de Paris.
        assert.ok(!plat.includes('02-02-2026'), `date de la demande décalée d’un jour\n${texte}`);
        // Le contact par son seul nom (consigne du code, choix le plus restrictif) : ni téléphone ni courriel.
        assert.ok(!plat.includes('06 12 34 56 78') && !plat.includes('alice.martin@client-cr.test'), `coordonnées du contact imprimées\n${texte}`);
        for (const rapport of [premier, deuxieme, troisieme]) {
          for (const fuseau of ['UTC', 'Europe/Paris']) assert.ok(!plat.includes(dateHeure(rapport.createdAt, fuseau)), `heure lue en ${fuseau} : ${dateHeure(rapport.createdAt, fuseau)}\n${texte}`);
        }
        // Dans l'ordre d'enregistrement.
        assert.ok(plat.indexOf(premier.contenu) < plat.indexOf(deuxieme.contenu) && plat.indexOf(deuxieme.contenu) < plat.indexOf(troisieme.contenu), `ordre des comptes rendus\n${texte}`);
        assert.ok(!plat.includes('TEST Compte rendu d’une autre intervention.'), `compte rendu d’une autre intervention imprimé\n${texte}`);
        assert.ok(!plat.includes('Non signé par le client'), 'intervention en cours avec une signature');
        // Lire le PDF n'écrit rien.
        assert.deepEqual(await etatEcrit([intervention.id, autre.intervention.id]), avant);

        // Identité actuelle (choix par défaut, à confirmer) : aucune copie n'est prise à la signature d'un
        // compte rendu ; le PDF suit l'identité de la société au moment où il s'imprime.
        try {
          await definirSociete(SOCIETE_B);
          const relu = await lirePdf(intervention.id);
          assert.ok(relu.plat.includes('TEST Émetteur CR B') && relu.plat.includes('SIRET 66666666600066') && relu.plat.includes('6 avenue Changée'), relu.texte);
          assert.ok(!relu.plat.includes('TEST Émetteur CR A') && !relu.plat.includes('55555555500055'), relu.texte);
        } finally {
          await definirSociete(SOCIETE_A);
        }
      } finally {
        await definirSociete({ fuseauHoraire: 'Europe/Paris' });
      }
    });

    // Cadrage : « la date et l'heure, au fuseau de la société, en JJ-MM-AAAA HH:MM » ; « date
    // d'acceptation ». L'horodatage d'un compte rendu et d'une signature est imposé par la base à
    // l'insertion : pour éprouver le jour civil à coup sûr, quelle que soit l'heure de la suite, ce test
    // le fixe en SQL de test, gardes suspendus le temps d'une transaction (comme le nettoyage de
    // api.test.mjs). L'empreinte ne couvre pas l'horodatage.
    test('date et heure au fuseau de la société : jour civil et heure de la société, jamais ceux d’UTC ni de Paris', async () => {
      const s = suffixe();
      const FUSEAU = 'Pacific/Marquesas';
      const { intervention, rapports: [rapport] } = await interventionAvecComptesRendus(s, ['TEST Compte rendu horodaté.'], {});
      const signature = await signer(rapport.id, 'TEST Signataire horodaté');
      // 16-01-2026 06:05 UTC = 15-01-2026 20:35 aux Marquises = 16-01-2026 07:05 à Paris.
      // 17-01-2026 05:20 UTC = 16-01-2026 19:50 aux Marquises = 17-01-2026 06:20 à Paris.
      await prisma.$transaction([
        prisma.$executeRawUnsafe('ALTER TABLE "InterventionRapport" DISABLE TRIGGER "intervention_rapport_ajout_seul"'),
        prisma.$executeRawUnsafe('ALTER TABLE "InterventionSignature" DISABLE TRIGGER "intervention_signature_figee"'),
        prisma.$executeRawUnsafe('UPDATE "InterventionRapport" SET "createdAt" = $1::timestamp WHERE "id" = $2', '2026-01-16 06:05:00', rapport.id),
        prisma.$executeRawUnsafe('UPDATE "InterventionSignature" SET "accepteLe" = $1::timestamp, "createdAt" = $1::timestamp WHERE "id" = $2', '2026-01-17 05:20:00', signature.id),
        prisma.$executeRawUnsafe('ALTER TABLE "InterventionSignature" ENABLE TRIGGER "intervention_signature_figee"'),
        prisma.$executeRawUnsafe('ALTER TABLE "InterventionRapport" ENABLE TRIGGER "intervention_rapport_ajout_seul"'),
      ]);
      assert.equal((await prisma.interventionRapport.findUniqueOrThrow({ where: { id: rapport.id } })).createdAt.toISOString(), '2026-01-16T06:05:00.000Z');
      assert.equal((await prisma.interventionSignature.findUniqueOrThrow({ where: { id: signature.id } })).accepteLe.toISOString(), '2026-01-17T05:20:00.000Z');
      await definirSociete({ fuseauHoraire: FUSEAU });
      try {
        const { texte, plat } = await lirePdf(intervention.id);
        assert.ok(plat.includes('15-01-2026 20:35'), `date et heure du compte rendu au fuseau de la société\n${texte}`);
        assert.ok(!plat.includes('16-01-2026 06:05') && !plat.includes('16-01-2026 07:05'), `heure d’UTC ou de Paris\n${texte}`);
        assert.ok(plat.includes('16-01-2026'), `jour d’acceptation de la signature au fuseau de la société\n${texte}`);
        assert.ok(!plat.includes('17-01-2026'), `jour d’acceptation lu en UTC ou à Paris\n${texte}`);
      } finally {
        await definirSociete({ fuseauHoraire: 'Europe/Paris' });
      }
    });

    // Cadrage : « tracé dessiné reproduit en vectoriel » (décision de Nelson du 19-10-2026 : tracé
    // vectoriel, coordonnées normalisées, ratio de la zone de signature).
    test('signatures : le tracé de chaque compte rendu signé est reproduit en vectoriel, à son ratio, avec signataire et empreinte', async () => {
      const s = suffixe();
      const { intervention, rapports: [premier, second, troisieme] } = await interventionAvecComptesRendus(s, [
        'TEST Compte rendu signé à deux traits.', 'TEST Compte rendu non signé.', 'TEST Compte rendu signé à un trait.',
      ]);
      const deuxTraits = await signer(premier.id, 'TEST Signataire deux traits', TRACE_DEUX_TRAITS);
      const unTrait = await signer(troisieme.id, 'TEST Signataire un trait', TRACE_SIMPLE);
      const { octets, texte, plat } = await lirePdf(intervention.id);
      for (const attendu of ['TEST Signataire deux traits', 'TEST Signataire un trait', second.contenu]) assert.ok(plat.includes(attendu), `absent du PDF : ${attendu}\n${texte}`);
      for (const empreinte of [deuxTraits.empreinte, unTrait.empreinte]) assert.ok(sansBlancs(texte).includes(empreinte), `empreinte absente : ${empreinte}\n${texte}`);
      // Chaque signature suit son compte rendu : le signataire du premier avant le texte du deuxième.
      assert.ok(plat.indexOf('TEST Signataire deux traits') > plat.indexOf(premier.contenu) && plat.indexOf('TEST Signataire deux traits') < plat.indexOf(second.contenu), `signature hors de son compte rendu\n${texte}`);
      assert.ok(plat.indexOf('TEST Signataire un trait') > plat.indexOf(troisieme.contenu), `signature hors de son compte rendu\n${texte}`);
      const chemins = cheminsTraces(octets);
      assert.ok(traceReproduit(chemins, TRACE_DEUX_TRAITS), `tracé à deux traits non reproduit (ratio 2,5)\n${JSON.stringify(chemins)}`);
      assert.ok(traceReproduit(chemins, TRACE_SIMPLE), `tracé à un trait non reproduit (ratio 2)\n${JSON.stringify(chemins)}`);
      // Vectoriel, et non une image : la société n'a pas de logo dans cette base, le PDF n'en porte aucune.
      assert.ok(!octets.includes(Buffer.from('/Subtype /Image')), 'le tracé est imprimé en image');
    });

    // Cadrage, « Intervention terminée sans signature » : la mention « Non signé par le client », au
    // niveau de l'intervention et non de chaque compte rendu ; le motif de clôture sans signature n'est
    // pas imprimé, ni sa précision « Autre », ni la marque interne « à suivre » (B1 ; choix par défaut, le
    // plus restrictif, à confirmer).
    test('« Non signé par le client » : une fois, pour une intervention terminée sans signature, sans le motif, sa précision ni « à suivre »', async () => {
      const s = suffixe();
      const PRECISION = 'TEST précision confidentielle du motif';
      const autre = await interventionAvecComptesRendus(`${s}a`, ['TEST Premier compte rendu sans signature.', 'TEST Second compte rendu sans signature.']);
      await changerStatut(autre.intervention.id, 'TERMINEE', { motifSansSignature: 'AUTRE', precisionMotif: PRECISION, aSuivre: true });
      const journal = await prisma.journalSaisieChantier.findFirst({ where: { interventionId: autre.intervention.id, action: 'CHANGEMENT_STATUT', motif: { contains: PRECISION } } });
      assert.ok(journal, 'le motif et sa précision sont bien au journal SAV');
      assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id: autre.intervention.id } })).aSuivre, true);
      const { texte, plat } = await lirePdf(autre.intervention.id);
      assert.equal(occurrences(plat, 'Non signé par le client'), 1, `mention une seule fois, au niveau de l’intervention\n${texte}`);
      for (const absent of [PRECISION, 'précision confidentielle', 'Clôture sans signature', 'Autre —']) assert.ok(!plat.includes(absent), `imprimé à tort : ${absent}\n${texte}`);
      assert.doesNotMatch(plat, /à suivre/iu, texte);
      assert.ok(plat.includes('TEST Premier compte rendu sans signature.') && plat.includes('TEST Second compte rendu sans signature.'), texte);

      // Autre motif : son libellé n'est pas imprimé non plus.
      const refus = await interventionAvecComptesRendus(`${s}b`, ['TEST Compte rendu, refus de signer.']);
      await changerStatut(refus.intervention.id, 'TERMINEE', { motifSansSignature: 'REFUS_SIGNATURE' });
      const texteRefus = (await lirePdf(refus.intervention.id)).plat;
      assert.equal(occurrences(texteRefus, 'Non signé par le client'), 1, texteRefus);
      assert.ok(!texteRefus.includes('Refus de signer') && !texteRefus.includes('Clôture sans signature'), texteRefus);

      // En cours, sans signature : l'intervention n'est pas terminée, la mention n'a pas lieu d'être.
      const enCours = await interventionAvecComptesRendus(`${s}c`, ['TEST Compte rendu en cours, non signé.']);
      assert.ok(!(await lirePdf(enCours.intervention.id)).plat.includes('Non signé par le client'), 'mention sur une intervention en cours');

      // Terminée avec un compte rendu signé (un autre ne l'est pas) : pas de mention.
      const signee = await interventionAvecComptesRendus(`${s}d`, ['TEST Compte rendu non signé avant.', 'TEST Compte rendu signé ensuite.']);
      await signer(signee.rapports[1].id, 'TEST Signataire de la clôture');
      await changerStatut(signee.intervention.id, 'TERMINEE');
      assert.ok(!(await lirePdf(signee.intervention.id)).plat.includes('Non signé par le client'), 'mention malgré une signature');

      // Terminée sans signature, puis signée après la clôture (possible, choix par défaut de #253) : un
      // compte rendu est désormais signé, la mention disparaît (consigne du code : « terminée dont aucun
      // compte rendu n'est signé »), le motif restant au journal seulement.
      const signeeApres = await interventionAvecComptesRendus(`${s}e`, ['TEST Compte rendu signé après la clôture.']);
      await changerStatut(signeeApres.intervention.id, 'TERMINEE', { motifSansSignature: 'CLIENT_ABSENT' });
      assert.equal(occurrences((await lirePdf(signeeApres.intervention.id)).plat, 'Non signé par le client'), 1);
      await signer(signeeApres.rapports[0].id, 'TEST Signataire après clôture');
      const apres = (await lirePdf(signeeApres.intervention.id)).plat;
      assert.ok(!apres.includes('Non signé par le client') && apres.includes('TEST Signataire après clôture'), apres);
    });

    // Cadrage : « Montants, heures, matériel et coûts : aucun n'est imprimé » (choix par défaut, le plus
    // restrictif, à confirmer) ; hors périmètre : « les heures, le matériel et les montants ». Les valeurs
    // sont choisies pour n'apparaître nulle part ailleurs dans le PDF.
    test('ni heures, ni matériel, ni montants, ni coûts : rien de ce que porte l’intervention ou son affaire', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client CR coûts ${s}`);
      const chantier = await prisma.chantier.create({ data: { nom: `TEST Chantier CR coûts ${s}`, client: client.raisonSociale, clientId: client.id, dateDebut: new Date(), budgetGlobalVendu: 98765.43 } });
      const technicien = await compteTechnicien('couts', s, 'Coûts');
      const fournisseur = await prisma.fournisseur.create({ data: { nom: `TEST Fournisseur confidentiel CR ${s}` } });
      const intervention = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `TEST Demande avec coûts ${s}` });
      await planifier(intervention.id, [technicien.intervenantId]);
      await demarrer(intervention.id);
      const rapport = await ajouterCompteRendu(intervention.id, 'TEST Compte rendu de la demande avec coûts.', technicien.jeton);
      const heures = await request(app).post(`/api/interventions/${intervention.id}/couts/heures`).set(entete(technicien.jeton))
        .send({ date: '2026-01-10', nbrHeures: 7.25, commentaire: 'TEST commentaire des heures confidentiel' });
      assert.equal(heures.status, 201, JSON.stringify(heures.body));
      const achat = await request(app).post(`/api/interventions/${intervention.id}/couts/achats`).set(admin())
        .send({ date: '2026-01-10', description: 'TEST Matériel confidentiel CR', montantHT: 123.45, fournisseurId: fournisseur.id });
      assert.equal(achat.status, 201, JSON.stringify(achat.body));
      await signer(rapport.id, 'TEST Signataire des coûts');
      await changerStatut(intervention.id, 'TERMINEE');
      // Les coûts existent bien : le test ne passe pas à vide.
      const couts = await request(app).get(`/api/interventions/${intervention.id}/couts`).set(admin());
      assert.equal(couts.status, 200, JSON.stringify(couts.body));
      assert.deepEqual([couts.body.heures.length, couts.body.achats.length], [1, 1]);

      const { texte, plat } = await lirePdf(intervention.id);
      assert.ok(plat.includes('TEST Compte rendu de la demande avec coûts.') && plat.includes(technicien.nomIntervenant), texte);
      for (const absent of [
        '€',
        // Heures déclarées (7,25 h), leur commentaire, le taux horaire chargé (57,89 €) et le coût qui en découle (419,70 €).
        '7,25', '7.25', 'TEST commentaire des heures', '57,89', '57.89', '419,70', '419.7',
        // Matériel : description, fournisseur, montant (123,45 €), et le total des coûts (543,15 €).
        'TEST Matériel confidentiel', 'TEST Fournisseur confidentiel', '123,45', '123.45', '543,15', '543.15',
      ]) assert.ok(!plat.includes(absent), `imprimé à tort : ${absent}\n${texte}`);
      // Montant vendu de l'affaire rattachée (98 765,43 €), sous toutes ses écritures (98 765, 98765, 98 765,43,
      // 98.765,43, et 9876543 en centimes), cherché comme un nombre borné, et non comme une simple sous-chaîne (#412) :
      // le PDF imprime des libellés suffixés par Date.now() (demande, client, intervenant, auteur), dont la suite de
      // chiffres peut contenir « 98765 », ainsi que l'empreinte hexadécimale de la signature. Borné comme nombreTemoin
      // (rapport-chantier-pdf.test.mjs) : ni chiffre ni lettre avant, aucun chiffre après.
      assert.doesNotMatch(plat, /(?<![\p{L}\d])98[\s.,\u00a0\u2009\u202f]?765(?:[,.]?43)?(?!\d)/u, `montant vendu imprimé à tort\n${texte}`);
    });

    // Cadrage, « Refus » : 404 hors du périmètre, comme la fiche ; 404 pour une intervention annulée,
    // même si elle porte des comptes rendus ; 409 « Aucun compte rendu à imprimer. » ; une intervention en
    // cours qui en porte s'imprime (choix par défaut, à confirmer, N9). Cadrage, « Lecteurs » : ceux de la
    // fiche (getInterventionFilterForUser, blockCommercial), sauf le technicien (choix par défaut, le plus
    // restrictif, à confirmer) ; le directeur commercial, l'assistante commerciale et le comptable restent
    // refusés, comme pour la fiche ; en session seulement, sans route /api/v1 (choix par défaut, à
    // confirmer). Le technicien est refusé (403) avant tout périmètre : ordre des gardes de la consigne du
    // code (requireAuth, blockCommercial, refus du technicien, puis périmètre).
    test('droits et refus par type de compte : intervention avec compte rendu, sans compte rendu, annulée, introuvable', async () => {
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
      const affecte = await compteTechnicien('affecte', s, 'Affecté');
      const nonAffecte = await compteTechnicien('non-affecte', s, 'Non affecté');
      const client = await creerClient(`TEST Client CR droits ${s}`);
      // Affaire du conducteur, dans l'équipe du responsable : les trois interventions y sont rattachées.
      const chantier = await prisma.chantier.create({ data: { nom: `TEST Chantier CR droits ${s}`, client: client.raisonSociale, clientId: client.id, dateDebut: new Date(), budgetGlobalVendu: 1000, responsableId: conducteur.id } });
      const nouvelle = async (titre) => {
        const intervention = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `${titre} ${s}` });
        await planifier(intervention.id, [affecte.intervenantId]);
        await demarrer(intervention.id);
        return intervention;
      };
      const avecCompteRendu = await nouvelle('TEST Droits avec compte rendu');
      await ajouterCompteRendu(avecCompteRendu.id, 'TEST Compte rendu des droits.', affecte.jeton);
      const sansCompteRendu = await nouvelle('TEST Droits sans compte rendu');
      const annulee = await nouvelle('TEST Droits annulée');
      const rapportAnnule = await ajouterCompteRendu(annulee.id, 'TEST Compte rendu d’une intervention annulée.', affecte.jeton);
      await signer(rapportAnnule.id, 'TEST Signataire d’une annulée');
      await changerStatut(annulee.id, 'ANNULEE', { motif: 'TEST motif d’annulation du PDF' });
      assert.equal(await prisma.interventionRapport.count({ where: { interventionId: annulee.id } }), 1, 'l’annulée porte bien un compte rendu');

      // Le technicien affecté lit la fiche, qu'il garde ; seul le PDF lui est refusé.
      assert.equal((await request(app).get(`/api/interventions/${avecCompteRendu.id}`).set(entete(affecte.jeton))).status, 200);

      const ids = [avecCompteRendu.id, sansCompteRendu.id, annulee.id];
      const avant = await etatEcrit(ids);
      const cibles = [avecCompteRendu.id, sansCompteRendu.id, annulee.id, randomUUID()];
      //                          avec CR, sans CR, annulée, introuvable
      const attendus = {
        superadmin: [200, 409, 404, 404],
        admin: [200, 409, 404, 404],
        conducteur: [200, 409, 404, 404],
        responsable: [200, 409, 404, 404],
        conducteurTiers: [404, 404, 404, 404],
        responsableTiers: [404, 404, 404, 404],
        technicienAffecte: [403, 403, 403, 403],
        technicienNonAffecte: [403, 403, 403, 403],
        commercial: [403, 403, 403, 403],
        directeur: [403, 403, 403, 403],
        directeurCommercial: [404, 404, 404, 404],
        assistanteCommerciale: [404, 404, 404, 404],
        comptable: [404, 404, 404, 404],
      };
      const jetons = {
        superadmin: session, technicienAffecte: affecte.jeton, technicienNonAffecte: nonAffecte.jeton,
        ...Object.fromEntries(Object.entries(comptes).map(([cle, compte]) => [cle, jetonDe(compte)])),
      };
      for (const [cle, statuts] of Object.entries(attendus)) {
        for (const [rangCible, interventionId] of cibles.entries()) {
          const res = await pdfCompteRendu(interventionId, entete(jetons[cle]));
          assert.equal(res.status, statuts[rangCible], `${cle}, cible ${['avec compte rendu', 'sans compte rendu', 'annulée', 'introuvable'][rangCible]} : ${res.body.toString('utf8').slice(0, 300)}`);
          if (res.status === 200) {
            assert.equal(res.headers['content-type'], 'application/pdf');
            assert.equal(res.body.subarray(0, 5).toString('latin1'), '%PDF-');
          } else {
            assert.match(res.headers['content-type'], /^application\/json/, `${cle} : un refus ne porte pas de PDF`);
            if (res.status === 409) assert.equal(erreurDe(res), 'Aucun compte rendu à imprimer.');
          }
        }
      }
      // « Comme pour la fiche » : ces trois types de compte ne voient pas non plus la fiche.
      for (const cle of ['directeurCommercial', 'assistanteCommerciale', 'comptable', 'conducteurTiers', 'responsableTiers']) {
        assert.equal((await request(app).get(`/api/interventions/${avecCompteRendu.id}`).set(entete(jetons[cle]))).status, 404, `fiche lue par ${cle}`);
      }
      // L'annulée est introuvable aussi par sa fiche.
      assert.equal((await request(app).get(`/api/interventions/${annulee.id}`).set(admin())).status, 404);

      // Ni visiteur, ni clé d'intégration, ni route /api/v1.
      assert.equal((await pdfCompteRendu(avecCompteRendu.id, null)).status, 401);
      const cle = await request(app).post('/api/admin/api-keys').set(admin()).send({ nom: `TEST clé PDF compte rendu ${s}`, scopes: ['clients:read', 'devis:read'] });
      assert.equal(cle.status, 201, JSON.stringify(cle.body));
      const parCle = entete(cle.body.apiKey);
      assert.equal((await request(app).get('/api/v1/clients').set(parCle)).status, 200, 'la clé est bien valide');
      assert.equal((await pdfCompteRendu(avecCompteRendu.id, parCle)).status, 401);
      assert.equal((await request(app).get(`/api/v1/interventions/${avecCompteRendu.id}/document.pdf`).set(parCle)).status, 404);

      // Aucun de ces appels n'a rien écrit.
      assert.deepEqual(await etatEcrit(ids), avant);
    });

    // Cadrage, « Refus » : « 409 si l'identité de la société est incomplète (identiteActuelleImprimee) » ;
    // message d'IdentiteEmetteurIncompleteError, « … avant d’imprimer un compte rendu » (consigne du code).
    // Comme pour le devis (audit n° 18 de 6a-2), une intervention introuvable ou annulée reste 404.
    test('identité de la société incomplète : 409 qui nomme les champs manquants, sans rien écrire ; introuvable et annulée restent 404, sans compte rendu reste « Aucun compte rendu »', async () => {
      const s = suffixe();
      const { intervention } = await interventionAvecComptesRendus(s, ['TEST Compte rendu, identité incomplète.']);
      const annulee = await interventionAvecComptesRendus(`${s}b`, ['TEST Compte rendu annulé, identité incomplète.']);
      await changerStatut(annulee.intervention.id, 'ANNULEE', { motif: 'TEST motif d’annulation, identité' });
      const vide = await interventionAvecComptesRendus(`${s}c`, []);
      const avant = await etatEcrit([intervention.id]);
      try {
        await definirSociete({ siret: '', ville: '' });
        const refus = await pdfCompteRendu(intervention.id);
        assert.equal(refus.status, 409, refus.body.toString('utf8'));
        assert.match(refus.headers['content-type'], /^application\/json/);
        assert.match(erreurDe(refus), /^Identité de la société incomplète : renseignez SIRET, ville dans l’écran Société avant d’imprimer un compte rendu\.$/);
        assert.equal((await pdfCompteRendu(randomUUID())).status, 404);
        assert.equal((await pdfCompteRendu(annulee.intervention.id)).status, 404);
        // Ordre des refus (consigne du code) : l'absence de compte rendu passe avant l'identité.
        const sansCompteRendu = await pdfCompteRendu(vide.intervention.id);
        assert.equal(sansCompteRendu.status, 409);
        assert.equal(erreurDe(sansCompteRendu), 'Aucun compte rendu à imprimer.');
        await definirSociete({ siret: '55555555500055', ville: 'Saint-Lô', raisonSociale: '' });
        assert.match(erreurDe(await pdfCompteRendu(intervention.id)), /^Identité de la société incomplète : renseignez raison sociale dans l’écran Société avant d’imprimer un compte rendu\.$/);
      } finally {
        await definirSociete(SOCIETE_A);
      }
      assert.deepEqual(await etatEcrit([intervention.id]), avant);
      assert.ok((await lirePdf(intervention.id)).plat.includes('TEST Compte rendu, identité incomplète.'));
    });

    // Modèle commun (lot 6a-2) : un caractère hors du jeu WinAnsi devient son équivalent de même sens, sa
    // lettre de base ou « ? », sans brouiller la suite de la ligne ; un accent combinant est recomposé ; une
    // fin de ligne Windows est un saut de ligne. Cadrage, « Tests » : « le texte hors du jeu WinAnsi ».
    test('caractères hors WinAnsi : remplacés un à un dans la demande, le client, le compte rendu, le signataire et les intervenants', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client Dvořák ∞ ${s}`);
      const site = await prisma.clientSite.create({ data: { clientId: client.id, nom: `TEST Site Ω ${s}`, adresse: '4 rue Ŵ fin', codePostal: '14000', ville: 'Caen' } });
      const contact = await prisma.clientContact.create({ data: { clientId: client.id, prenom: 'Zoë', nom: 'Šimek ⌀ fin' } });
      const technicien = await compteTechnicien('oystein', s, 'Øystein ∑');
      const intervention = await creerIntervention({
        clientId: client.id, siteId: site.id, contactId: contact.id,
        titre: `TEST Café crème ⌀ 12 fin ${s}`, description: 'TEST Résist. 10 Ω ∞ 3 ⌀ 🔧 ok',
      });
      await planifier(intervention.id, [technicien.intervenantId]);
      await demarrer(intervention.id);
      const rapport = await ajouterCompteRendu(intervention.id, 'TEST Ligne un ≤ 5 μF\r\nTEST Ligne deux 10⁶ ① fin', technicien.jeton);
      const signature = await signer(rapport.id, 'TEST Łukasz Dvořák');
      const { texte, plat } = await lirePdf(intervention.id);
      for (const attendu of [
        `TEST Client Dvorák ? ${s}`, `TEST Site ? ${s}`, '4 rue W fin', 'Zoë Šimek ? fin',
        `TEST Café crème ? 12 fin ${s}`, 'TEST Résist. 10 ? ? 3 ? ? ok',
        `TEST Intervenant Øystein ? ${s}`,
        'TEST Ligne deux 10? ? fin',
        'TEST ?ukasz Dvorák',
      ]) assert.ok(plat.includes(attendu), `absent du PDF : ${attendu}\n${texte}`);
      // La fin de ligne Windows est un saut de ligne, sans retour chariot imprimé.
      assert.ok(!texte.includes('\r'), 'retour chariot imprimé');
      // μ grec devient le signe micro µ (0xB5 du jeu WinAnsi), et non « ? » ; l'extraction du texte (pdf.js)
      // rend ce signe en μ grec : les deux formes sont admises à la lecture.
      assert.match(texte, /TEST Ligne un <= 5 [µμ]F\s*\n\s*TEST Ligne deux/u, texte);
      // Le reste du document n'est pas brouillé : l'empreinte et la date du compte rendu restent lisibles.
      assert.ok(sansBlancs(texte).includes(signature.empreinte), texte);
      assert.ok(plat.includes(dateHeure(rapport.createdAt, 'Europe/Paris')), texte);
    });
  });
}
