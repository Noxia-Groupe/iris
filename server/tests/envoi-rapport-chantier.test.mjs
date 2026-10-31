// Lot 6a-4e : envoi du rapport de chantier remis au client par la messagerie de l'utilisateur (cadrage du lot
// 6a-4, version 9 du 31-10-2026, section « 6a-4e », version 2 du lot ; décisions de Nelson du 22-10-2026, point
// 4, « Tous type de document », et repli « du style mailto » ; réponse de Nelson du 31-10-2026 sur le rapport
// remis au client : « il ne doit pas y avoir de montant ni de heures »). Sur le modèle de l'envoi du contrat de
// maintenance (lot 6a-4d, envoi-compte-rendu-contrat.test.mjs), réservé comme lui à l'administration.
//
// Fichier propre au lot (cadrage, « Conditions du parallélisme », N10) : rien n'est ajouté à api.test.mjs.
// `node --test` exécute les fichiers en parallèle, et api.test.mjs, qui tourne en même temps sur
// TEST_DATABASE_URL, purge les données « TEST » et change l'identité de la société en cours de route. Ce fichier
// crée donc, sur le même serveur PostgreSQL, une base jetable qui n'appartient qu'à lui, la migre, la sert à
// l'application montée en mémoire, puis la supprime ; TEST_DATABASE_URL ne sert que de connexion
// administrative. Sans elle, il s'annonce ignoré : un SKIP n'est pas une réussite.
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

const TITRE = 'Lot 6a-4e : envoi du rapport de chantier remis au client par la messagerie';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const dossierServeur = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dossierPrisma = resolve(dossierServeur, 'prisma');
const binairePrisma = resolve(dossierServeur, 'node_modules/.bin/prisma');
// Dernière migration de `main` (4b2ea9f) avant ce lot, et celle du lot, dont le nom est fixé par le cadrage
// (« Migration du journal », N4) : une migration fusionnée ne se modifie plus.
const DERNIERE_MIGRATION_MAIN = '20261031120000_journal_envois_compte_rendu_contrat';
const MIGRATION_DU_LOT = '20261031200000_journal_envois_rapport_chantier';

// Objet et texte du cadrage (« Objet et texte », choix par défaut, à confirmer), mot pour mot : apostrophe
// typographique (’) et tiret demi-cadratin (–), comme ceux des lots 6a-3 et 6a-4d. `{nom}` est le nom du
// chantier, celui que le PDF imprime ; la raison sociale, l'identité actuelle de la société.
const objetRapport = (nom, raisonSociale) => `Rapport de chantier ${nom} – ${raisonSociale}`;
const corpsRapport = (nom, raisonSociale) => `Bonjour,\n\nVeuillez trouver ci-joint le rapport de chantier ${nom}.\n\nCordialement,\n${raisonSociale}`;
// Refus du cadrage, mot pour mot.
const CHANTIER_ANNULE = 'Un chantier annulé ne s’envoie pas.';
const CHANTIER_INTROUVABLE = 'Chantier introuvable';
const REFUS_ADMINISTRATION = 'Accès réservé aux administrateurs';
const identiteIncomplete = (champs) => `Identité de la société incomplète : renseignez ${champs} dans l’écran Société avant d’envoyer un rapport de chantier.`;
// Lot 6a-3, inchangés : validerDestinataire et les champs exposés d'un envoi.
const REFUS_DESTINATAIRE = 'Adresse du destinataire invalide : indiquez une seule adresse électronique, de la forme nom@domaine.fr.';
const CHAMPS_ENVOI = ['auteurNom', 'canal', 'createdAt', 'destinataire', 'id', 'objet'];
const ROLES_NON_ADMINISTRATEURS = ['CONDUCTEUR_TRAVAUX', 'COMMERCIAL', 'ASSISTANTE_COMMERCIALE', 'TECHNICIEN', 'COMPTABLE', 'DIRECTEUR_COMMERCIAL', 'RESPONSABLE', 'DIRECTEUR'];
const TOUS_LES_SCOPES = ['clients:read', 'clients:write', 'catalogue:read', 'catalogue:write', 'equipements:read', 'equipements:write', 'devis:read', 'devis:write', 'company:read', 'chantiers:read', 'chantiers:write', 'chantiers:archive', 'finances:read'];

// --- Ni montant ni heures (réponse de Nelson du 31-10-2026 ; cadrage, « Objet et texte » : « Le texte ne porte
// aucun montant ni aucune heure ») ---
// Repris de rapport-chantier-pdf.test.mjs (lot 6a-4c), sans changement : un nombre témoin sous ses écritures
// plausibles, une durée témoin en heures décimales, en heures et minutes et en minutes, et les motifs génériques,
// dont celui d'un montant ou d'une durée écrits en toutes lettres (N2 de l'audit des montants de #397, « il
// s'applique aussi à l'objet et au texte de l'envoi »).
function nombreTemoin(valeur, { avecDecimales = true } = {}) {
  const [entier, decimales] = valeur.split('.');
  const groupes = entier.replace(/\B(?=(\d{3})+(?!\d))/g, ' ').split(' ');
  const partieEntiere = groupes.join('[\\s.\\u00a0\\u202f]?');
  const partieDecimale = avecDecimales && decimales ? `[,.]${decimales}` : '';
  return new RegExp(`(?<![\\p{L}\\d])${partieEntiere}${partieDecimale}(?!\\d)`, 'u');
}
function dureeTemoin(heuresDecimales) {
  const totalMinutes = Math.round(Number(heuresDecimales) * 60);
  const heures = Math.floor(totalMinutes / 60);
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  return [
    nombreTemoin(heuresDecimales),
    new RegExp(`(?<![\\p{L}\\d])${heures}\\s?h\\s?${minutes}(?!\\d)`, 'u'),
    new RegExp(`${nombreTemoin(String(totalMinutes), { avecDecimales: false }).source}\\s?min`, 'u'),
  ];
}
const MOTIFS_INTERDITS = [
  [/€/u, 'symbole euro'],
  [/(?<!\p{L})EUR(?!\p{L})/u, 'code EUR'],
  [/(?<!\p{L})(HT|TTC|TVA)(?!\p{L})/u, 'mention HT, TTC ou TVA'],
  [/\d,\d/u, 'nombre décimal à la française'],
  [/\d\.\d/u, 'nombre décimal à l’anglaise'],
  [/(?<![\p{L}\d])\d+(?:[,.]\d+)?\s?h(?:\s?\d{1,2})?(?!\p{L})/u, 'durée en heures'],
  [/(?<!\p{L})min(?:utes?)?(?!\p{L})/iu, 'durée en minutes'],
  [/(?<![\p{L}\d])\d+(?:[\s.,  ]\d+)*\s?(?:heures?|euros?)(?!\p{L})/iu, 'montant ou durée en toutes lettres'],
  [/%/u, 'pourcentage (avancement)'],
  [/budget|marge|vendu|factur|co[uû]t|achat|pointag|avancement|rentabilit|réalis/iu, 'libellé d’un montant ou d’heures'],
];
// Valeurs témoins du test de 6a-4c (« ni montant ni heures ») : budgets, coût d'achat prévu, ligne de budget,
// achat, main-d'œuvre pointée, facture, avoir, facturé net et reste à facturer, taux horaire, heures et matériel
// de l'intervention ; parties entières des montants à quatre chiffres ; heures vendues, allouées, pointées et
// saisies sur l'intervention.
const TEMOINS = [
  ...['4321.09', '1987.63', '2333.46', '1456.78', '2718.28', '876.54', '613.66', '813.39', '162.68', '976.07', '271.13', '54.23', '325.36', '542.26', '3778.83', '48.13', '324.88', '219.47']
    .map((valeur) => [nombreTemoin(valeur), `montant ${valeur}`]),
  ...['4321', '1987', '2333', '1456', '2718', '3778'].map((valeur) => [nombreTemoin(valeur, { avecDecimales: false }), `montant arrondi ${valeur}`]),
  ...['37.25', '20.57', '12.75', '6.75'].flatMap((heures) => dureeTemoin(heures).map((motif) => [motif, `durée ${heures} h`])),
];
function verifierSansMontantNiHeure(texte, contexte) {
  for (const [motif, libelle] of [...MOTIFS_INTERDITS, ...TEMOINS]) assert.doesNotMatch(texte, motif, `${contexte} : ${libelle}\n${texte}`);
}

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const source = new URL(TEST_DATABASE_URL);
    // « test » comme mot (règle de client/scripts/base-jetable.mjs) et un suffixe tiré au hasard.
    const nomBase = `iris_test_envoi6a4e_${randomBytes(6).toString('hex')}`;
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

    // Identité de la société, complète, sans chiffre ni libellé de montant dans la raison sociale (elle entre
    // dans l'objet et le texte, passés au crible des motifs interdits).
    const SOCIETE = {
      raisonSociale: 'TEST Émetteur envoi du rapport', nomCommercial: '', siret: '66666666600066', tvaIntra: '',
      adresse: '6 rue du Rapport envoyé', codePostal: '14000', ville: 'Caen', pays: 'France', telephone: '02 31 00 00 06',
      email: 'emetteur-6a4e@iris.test', siteWeb: '', piedFacture: 'TEST Pied 6a4e', fuseauHoraire: 'Europe/Paris',
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
    const reussi = async (reponse) => {
      const res = await reponse;
      assert.ok(res.status >= 200 && res.status < 300, `${res.req?.method} ${res.req?.path} : ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    };
    const cheminChantier = (id) => `/chantiers/${id}`;
    const lire = (id, auth = admin()) => appeler('get', `${cheminChantier(id)}/envois`, null, auth);
    const envoyer = (id, destinataire, auth = admin()) => appeler('post', `${cheminChantier(id)}/envois`, { destinataire }, auth);
    const definirSociete = (champs) => ok(appeler('put', '/company', champs));
    const aujourdhuiParis = () => {
      const parties = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date());
      const valeur = (type) => parties.find((partie) => partie.type === type).value;
      return `${valeur('day')}-${valeur('month')}-${valeur('year')}`;
    };

    // --- Données ---
    const creerCompte = (role, cle, s, extra = {}) => prisma.user.create({ data: { email: `envoi6a4e.${cle}.${s}@iris.test`, name: `TEST ${cle} ${s}`, role, ...extra } });
    // Technicien : un compte et sa fiche d'intervenant reliée.
    const compteTechnicien = async (cle, s) => {
      const compte = await prisma.user.create({ data: { email: `envoi6a4e.technicien.${cle}.${s}@iris.test`, name: `TEST Technicien ${cle} ${s}`, role: 'TECHNICIEN' } });
      const intervenant = await prisma.intervenant.create({ data: { nom: `TEST Intervenant ${cle} ${s}`, role: 'Technicien', tauxHoraireCharge: 48.13, userId: compte.id } });
      return { compte, jeton: jetonDe(compte), intervenantId: intervenant.id };
    };
    // Client professionnel identifié (lot 6a-2 bis : un devis ne se signe, une facture ne s'émet que pour lui) :
    // SIREN libre, site de facturation ; courriel de la fiche si donné.
    const creerClient = async (raisonSociale, { email } = {}) => {
      let client;
      for (let essai = 1; ; essai += 1) {
        const res = await appeler('post', '/clients', { raisonSociale, siren: String(randomInt(100_000_000, 1_000_000_000)), ...(email ? { email } : {}) });
        if (res.status === 409 && essai < 5) continue;
        assert.equal(res.status, 201, JSON.stringify(res.body));
        client = res.body;
        break;
      }
      await ok(appeler('post', `/clients/${client.id}/sites`, { nom: 'TEST Facturation 6a4e', adresse: '8 rue du Destinataire', codePostal: '75003', ville: 'Paris', estSiteFacturation: true }), 201);
      return client;
    };
    const ajouterContact = (clientId, donnees) => ok(appeler('post', `/clients/${clientId}/contacts`, donnees), 201);
    // Chantier ouvert par la conversion d'un devis signé (seule porte d'ouverture d'une affaire) ; `annuler`
    // annule le devis, et le chantier avec lui (devis/annulation.ts).
    const chantierConverti = async (clientId, objet) => {
      const devis = await ok(appeler('post', '/devis', { clientId, objet, lignes: [{ designation: 'TEST Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }), 201);
      await ok(appeler('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' }));
      await ok(appeler('post', `/devis/${devis.id}/signature`, { signataire: 'TEST Signataire 6a4e', confirme: true }), 201);
      const chantier = await ok(appeler('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }), 201);
      const annuler = async () => {
        await ok(appeler('post', `/devis/${devis.id}/annulation`, { motif: 'TEST annulation du devis du chantier 6a4e' }));
        assert.equal((await prisma.chantier.findUniqueOrThrow({ where: { id: chantier.id } })).statut, 'ANNULE');
      };
      return { devis, chantier, annuler };
    };
    // Chantier posé en base, sans aucun enfant (ni intervention, ni pointage, ni achat, ni facture).
    const creerChantier = (donnees) => prisma.chantier.create({ data: { budgetGlobalVendu: 0, dateDebut: new Date('2026-06-01T00:00:00.000Z'), ...donnees } });
    const creerIntervention = (donnees, auth = admin()) => ok(appeler('post', '/interventions', donnees, auth), 201);
    const changerStatut = (id, statut, extra = {}) => ok(appeler('patch', `/interventions/${id}/statut`, { statut, ...extra }));
    const planifier = (id, intervenantIds) => ok(appeler('put', `/interventions/${id}/planning`, { dateDebut: new Date().toISOString().slice(0, 10), creneau: 'JOURNEE', intervenantIds }));
    const demarrer = async (id) => {
      const { statut } = await prisma.intervention.findUniqueOrThrow({ where: { id }, select: { statut: true } });
      if (statut === 'A_PLANIFIER') await changerStatut(id, 'PLANIFIEE');
      await changerStatut(id, 'EN_COURS');
    };
    const ajouterCompteRendu = (id, contenu, auth = admin()) => ok(appeler('post', `/interventions/${id}/rapports`, { contenu, cleEnvoi: randomUUID() }, auth), 201);
    const creerContrat = (clientId, titre) => ok(appeler('post', '/contrats-maintenance', { clientId, titre, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-10-2030' }), 201);

    // --- État de la base : un refus ou une lecture n'écrit rien, un envoi n'écrit que sa ligne du journal ---
    const lignes = async (modele) => (await prisma[modele].findMany({ orderBy: { id: 'asc' } })).map((ligne) => JSON.stringify(ligne));
    const etatBase = async () => ({
      envois: await prisma.envoiDocument.findMany({ orderBy: { id: 'asc' } }),
      chantiers: await lignes('chantier'),
      interventions: await lignes('intervention'),
      devis: await lignes('devis'),
      contrats: await lignes('contratMaintenance'),
      factures: await prisma.facture.count(),
      rapports: await prisma.interventionRapport.count(),
      journalSaisies: await prisma.journalSaisieChantier.count(),
      journalAdministration: await prisma.journalAdministration.count(),
      societe: JSON.stringify(await prisma.companySettings.findUnique({ where: { id: 'singleton' } })),
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
    // Un enregistrement accepté : 201, une seule ligne ajoutée au journal, celle de la réponse ; ni chantier, ni
    // intervention, ni devis, ni contrat modifiés (« Envoyer ne change aucun statut du chantier »).
    const enregistre = async (appel, contexte) => {
      const avant = await etatBase();
      const res = await appel();
      assert.equal(res.status, 201, `${contexte} : ${res.status} ${JSON.stringify(res.body)}`);
      const apres = await etatBase();
      const nouvelles = apres.envois.filter((ligne) => !avant.envois.some((ancienne) => ancienne.id === ligne.id));
      assert.deepEqual(nouvelles.map((ligne) => ligne.id), [res.body.envoi.id], `${contexte} : une seule ligne au journal`);
      assert.deepEqual(apres.envois.filter((ligne) => ligne.id !== res.body.envoi.id), avant.envois, `${contexte} : le journal existant est intact`);
      for (const cle of ['chantiers', 'interventions', 'devis', 'contrats', 'factures', 'rapports', 'journalSaisies', 'journalAdministration', 'societe']) {
        assert.deepEqual(apres[cle], avant[cle], `${contexte} : ${cle} modifiés par l’envoi`);
      }
      return { res, ligne: nouvelles[0] };
    };
    // L'envoi lancé attend-il le verrou tenu par une transaction ? On cesse de chercher dès qu'il a répondu.
    const attendreBlocage = async (pidTenant, repondu) => {
      for (let essai = 0; essai < 1000 && !repondu(); essai++) {
        const [{ n }] = await prisma.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pidTenant}::int = ANY(pg_blocking_pids(pid))`;
        if (n > 0) return true;
        await new Promise((resolveAttente) => setTimeout(resolveAttente, 20));
      }
      return false;
    };
    // Texte d'un PDF (pour relire le nom du chantier que le rapport imprime).
    const textePdf = async (id) => {
      const res = await request(app).get(`/api/chantiers/${id}/document.pdf`).set(admin()).buffer(true)
        .parse((reponse, fin) => { const morceaux = []; reponse.on('data', (m) => morceaux.push(m)); reponse.on('end', () => fin(null, Buffer.concat(morceaux))); });
      assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
      assert.equal(res.headers['content-type'], 'application/pdf');
      const lecteur = new PDFParse({ data: res.body });
      try { return (await lecteur.getText()).text.replace(/\s+/g, ' '); } finally { await lecteur.destroy(); }
    };

    // Paramétrage comptable et mentions légales publiées, pour émettre une vraie facture sur le chantier témoin
    // (repris de rapport-chantier-pdf.test.mjs).
    const parametrerFacturation = async () => {
      const compte = (code, libelle, nature) => ok(appeler('post', '/comptabilite/comptes', { code, libelle, nature }), 201);
      const clients = await compte('411000', 'TEST Clients 6a4e', 'ACTIF');
      const prestations = await compte('706000', 'TEST Prestations 6a4e', 'PRODUIT');
      const articles = await compte('707000', 'TEST Articles 6a4e', 'PRODUIT');
      const tva = await compte('445710', 'TEST TVA collectée 6a4e', 'TVA');
      const motif = 'TEST paramétrage comptable de l’envoi du rapport';
      for (const [cle, donnees] of [['CLIENT', { compteId: clients.id }], ['VENTE_PRESTATION', { compteId: prestations.id }], ['VENTE_ARTICLE', { compteId: articles.id }], ['JOURNAL_VENTES', { journal: 'VE' }]]) {
        await reussi(appeler('put', `/comptabilite/regles/${cle}`, { ...donnees, motif }));
      }
      await reussi(appeler('put', '/comptabilite/tva/20', { compteId: tva.id, motif }));
      const version = await ok(appeler('post', '/mentions-legales', { mentions: 'TEST mentions 6a4e', cgv: 'TEST CGV 6a4e', penalites: 'TEST pénalités 6a4e' }), 201);
      await reussi(appeler('post', `/mentions-legales/${version.version}/publier`));
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
      secours = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' }, select: { id: true, name: true, role: true } });
      assert.ok(secours.name.trim(), 'le compte de secours porte un nom');
      assert.equal(secours.role, 'SUPERADMIN', 'le compte de secours est super administrateur');
      await definirSociete(SOCIETE);
      await parametrerFacturation();
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

    // Cadrage, « Destinataire proposé » : la règle du lot 6a-3, inchangée (propositionDestinataire(tx,
    // chantier.clientId)) : le courriel du contact principal du client du chantier, sinon celui de la fiche client,
    // sinon rien (choix par défaut, à confirmer) ; « Tests » : « jamais le contact d'une intervention du chantier »
    // (N2 d). Chaque cas donne un courriel au contact de l'intervention, pour que cette lecture se distingue.
    // « Un chantier sans fiche client, qui ne garde que l'ancien libellé, n'a pas de destinataire proposé : la
    // saisie reste possible. »
    test('lecture : contact principal, sinon fiche client, sinon rien, jamais le contact d’une intervention du chantier ; objet et texte mot pour mot ; journal vide ; sans fiche client, rien de proposé et la saisie reste possible', async () => {
      const s = suffixe();
      // Contact principal avec courriel : il l'emporte sur la fiche et sur le contact de l'intervention.
      const avecPrincipal = await creerClient(`TEST Client rapport principal ${s}`, { email: 'fiche@client-6a4e.test' });
      await ajouterContact(avecPrincipal.id, { nom: 'TEST Principal', email: 'principal@client-6a4e.test', principal: true });
      const contactA = await ajouterContact(avecPrincipal.id, { nom: 'TEST Contact de la demande', email: 'demande@client-6a4e.test' });
      const { chantier: chantierA } = await chantierConverti(avecPrincipal.id, `TEST Chantier principal ${s}`);
      await creerIntervention({ clientId: avecPrincipal.id, chantierId: chantierA.id, titre: `TEST Demande A ${s}`, contactId: contactA.id });
      assert.equal(chantierA.nom, `TEST Chantier principal ${s}`);
      const luA = await sansEcriture(() => lire(chantierA.id), 200, 'lecture A');
      assert.deepEqual(luA.body, {
        proposition: { destinataire: 'principal@client-6a4e.test', objet: objetRapport(chantierA.nom, SOCIETE.raisonSociale), corps: corpsRapport(chantierA.nom, SOCIETE.raisonSociale) },
        envois: [],
      });
      // `{nom}` est celui que le PDF imprime, dans son titre « Rapport de chantier {nom} ».
      assert.ok((await textePdf(chantierA.id)).includes(`Rapport de chantier ${chantierA.nom}`), 'désignation du PDF');

      // Contact principal sans courriel : la fiche client, et non le contact de l'intervention.
      const repli = await creerClient(`TEST Client rapport fiche ${s}`, { email: 'fiche@client-6a4e.test' });
      await ajouterContact(repli.id, { nom: 'TEST Principal sans courriel', principal: true });
      const contactB = await ajouterContact(repli.id, { nom: 'TEST Contact de la demande', email: 'demande@client-6a4e.test' });
      const { chantier: chantierB } = await chantierConverti(repli.id, `TEST Chantier fiche ${s}`);
      await creerIntervention({ clientId: repli.id, chantierId: chantierB.id, titre: `TEST Demande B ${s}`, contactId: contactB.id });
      assert.equal((await sansEcriture(() => lire(chantierB.id), 200, 'lecture B')).body.proposition.destinataire, 'fiche@client-6a4e.test');

      // Ni l'un ni l'autre : rien, même si le contact de l'intervention du chantier a un courriel.
      const vide = await creerClient(`TEST Client rapport sans courriel ${s}`);
      const contactC = await ajouterContact(vide.id, { nom: 'TEST Contact de la demande', email: 'demande@client-6a4e.test' });
      const { chantier: chantierC } = await chantierConverti(vide.id, `TEST Chantier sans courriel ${s}`);
      await creerIntervention({ clientId: vide.id, chantierId: chantierC.id, titre: `TEST Demande C ${s}`, contactId: contactC.id });
      assert.equal((await sansEcriture(() => lire(chantierC.id), 200, 'lecture C')).body.proposition.destinataire, '');

      // La proposition suit la fiche actuelle du client.
      const principal = await prisma.clientContact.findFirstOrThrow({ where: { clientId: avecPrincipal.id, principal: true } });
      await ok(appeler('put', `/clients/${avecPrincipal.id}/contacts/${principal.id}`, { email: 'nouveau@client-6a4e.test' }));
      assert.equal((await lire(chantierA.id)).body.proposition.destinataire, 'nouveau@client-6a4e.test');

      // Chantier sans fiche client (ancien libellé seul) : aucun destinataire proposé, la saisie reste possible.
      const sansFiche = await creerChantier({ nom: `TEST Chantier sans fiche ${s}`, client: `TEST Ancien libellé ${s}` });
      const luSansFiche = await sansEcriture(() => lire(sansFiche.id), 200, 'lecture sans fiche client');
      assert.deepEqual(luSansFiche.body, {
        proposition: { destinataire: '', objet: objetRapport(sansFiche.nom, SOCIETE.raisonSociale), corps: corpsRapport(sansFiche.nom, SOCIETE.raisonSociale) },
        envois: [],
      });
      const { res } = await enregistre(() => envoyer(sansFiche.id, 'saisi@client-6a4e.test'), 'envoi sans fiche client');
      assert.equal(res.body.envoi.destinataire, 'saisi@client-6a4e.test');
    });

    // ------------------------------------------------------------------------------------------------
    // Enregistrement.
    // ------------------------------------------------------------------------------------------------

    // Cadrage, « Tests » : « enregistrement : 201 ; ligne au journal avec l'auteur et l'horodatage de la base ;
    // réponse sans identifiant de compte » ; « journal du plus récent au plus ancien » ; « aucun statut changé »
    // (« Envoyer ne change aucun statut du chantier »).
    test('enregistrement : 201, une ligne au journal pour le chantier seul, avec l’auteur et l’horodatage de la base, réponse sans identifiant de compte ; journal du plus récent au plus ancien ; aucun statut changé', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client rapport journal ${s}`);
      const { devis, chantier } = await chantierConverti(client.id, `TEST Chantier journal ${s}`);
      const intervention = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `TEST Demande journal ${s}` });
      await demarrer(intervention.id);
      await ajouterCompteRendu(intervention.id, 'TEST Compte rendu du chantier envoyé.');
      const administrateur = await creerCompte('ADMIN', 'admin-journal', s);
      const [{ debut }] = await prisma.$queryRaw`SELECT now() AS debut`;
      const statutsAvant = {
        chantier: (await prisma.chantier.findUniqueOrThrow({ where: { id: chantier.id } })).statut,
        intervention: (await prisma.intervention.findUniqueOrThrow({ where: { id: intervention.id } })).statut,
        devis: (await prisma.devis.findUniqueOrThrow({ where: { id: devis.id } })).statut,
      };
      assert.deepEqual(statutsAvant.chantier, 'EN_COURS');

      const premier = await enregistre(() => envoyer(chantier.id, '  premier@client-6a4e.test\n'), 'premier envoi');
      assert.deepEqual(Object.keys(premier.res.body).sort(), ['corps', 'envoi', 'objet']);
      assert.deepEqual(Object.keys(premier.res.body.envoi).sort(), CHAMPS_ENVOI);
      assert.deepEqual(premier.res.body.envoi, {
        id: premier.ligne.id, canal: 'MESSAGERIE', destinataire: 'premier@client-6a4e.test', objet: objetRapport(chantier.nom, SOCIETE.raisonSociale),
        auteurNom: secours.name, createdAt: premier.ligne.createdAt.toISOString(),
      });
      assert.equal(premier.res.body.objet, objetRapport(chantier.nom, SOCIETE.raisonSociale));
      assert.equal(premier.res.body.corps, corpsRapport(chantier.nom, SOCIETE.raisonSociale));
      assert.ok(!JSON.stringify(premier.res.body).includes(secours.id), 'identifiant du compte exposé');
      // En base : le chantier seul, le compte, son nom et l'horodatage de la base.
      assert.deepEqual(
        { chantierId: premier.ligne.chantierId, interventionId: premier.ligne.interventionId, contratMaintenanceId: premier.ligne.contratMaintenanceId, devisId: premier.ligne.devisId, factureId: premier.ligne.factureId, auteurId: premier.ligne.auteurId, auteurNom: premier.ligne.auteurNom, canal: premier.ligne.canal, objet: premier.ligne.objet, destinataire: premier.ligne.destinataire },
        { chantierId: chantier.id, interventionId: null, contratMaintenanceId: null, devisId: null, factureId: null, auteurId: secours.id, auteurNom: secours.name, canal: 'MESSAGERIE', objet: objetRapport(chantier.nom, SOCIETE.raisonSociale), destinataire: 'premier@client-6a4e.test' },
      );
      assert.ok(premier.ligne.createdAt.getTime() >= debut.getTime() - 1000, `${premier.ligne.createdAt.toISOString()} < ${debut.toISOString()}`);

      // Un second envoi, par un autre compte de l'administration, passe en tête.
      const second = await enregistre(() => envoyer(chantier.id, 'second@client-6a4e.test', parCompte(administrateur)), 'second envoi');
      assert.equal(second.ligne.auteurId, administrateur.id);
      assert.equal(second.res.body.envoi.auteurNom, administrateur.name);
      assert.ok(!JSON.stringify(second.res.body).includes(administrateur.id), 'identifiant du compte exposé');
      const lu = await sansEcriture(() => lire(chantier.id), 200, 'lecture du journal');
      assert.deepEqual(lu.body.envois, [second.res.body.envoi, premier.res.body.envoi]);
      for (const envoi of lu.body.envois) assert.deepEqual(Object.keys(envoi).sort(), CHAMPS_ENVOI);
      assert.ok(!JSON.stringify(lu.body).includes(secours.id) && !JSON.stringify(lu.body).includes(administrateur.id), 'identifiant de compte exposé');
      assert.ok(Date.parse(lu.body.envois[0].createdAt) >= Date.parse(lu.body.envois[1].createdAt));

      // Aucun statut changé : chantier, intervention et devis (la comparaison complète des lignes est faite par
      // `enregistre` à chaque envoi).
      assert.deepEqual({
        chantier: (await prisma.chantier.findUniqueOrThrow({ where: { id: chantier.id } })).statut,
        intervention: (await prisma.intervention.findUniqueOrThrow({ where: { id: intervention.id } })).statut,
        devis: (await prisma.devis.findUniqueOrThrow({ where: { id: devis.id } })).statut,
      }, statutsAvant);
    });

    // Cadrage, « Chantier terminé : il s'envoie, avec le statut que son PDF imprime, comme un contrat terminé » ;
    // « Chantier sans intervention : il s'envoie aussi. Son PDF dit « Aucune intervention rattachée. » ».
    test('chantier terminé et chantier sans intervention : l’envoi est accepté, et le statut ne change pas', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client rapport terminé ${s}`);
      const termine = await creerChantier({ nom: `TEST Chantier clos ${s}`, client: client.raisonSociale, clientId: client.id });
      await creerIntervention({ clientId: client.id, chantierId: termine.id, titre: `TEST Demande du chantier clos ${s}` });
      await ok(appeler('patch', `/chantiers/${termine.id}/statut`, { statut: 'TERMINE' }));
      assert.equal((await prisma.chantier.findUniqueOrThrow({ where: { id: termine.id } })).statut, 'TERMINE');
      const sansIntervention = await creerChantier({ nom: `TEST Chantier sans intervention ${s}`, client: client.raisonSociale, clientId: client.id });
      assert.match(await textePdf(sansIntervention.id), /Aucune intervention rattachée\./u);
      assert.match(await textePdf(termine.id), /Statut : terminé(?!\p{L})/u);

      for (const chantier of [termine, sansIntervention]) {
        const { res, ligne } = await enregistre(() => envoyer(chantier.id, 'client@envoi-6a4e.test'), chantier.nom);
        assert.equal(res.body.objet, objetRapport(chantier.nom, SOCIETE.raisonSociale));
        assert.equal(res.body.corps, corpsRapport(chantier.nom, SOCIETE.raisonSociale));
        assert.equal(ligne.chantierId, chantier.id);
        assert.deepEqual((await lire(chantier.id)).body.envois, [res.body.envoi]);
      }
      assert.deepEqual((await prisma.chantier.findMany({ where: { id: { in: [termine.id, sansIntervention.id] } }, orderBy: { createdAt: 'asc' } })).map((c) => c.statut), ['TERMINE', 'EN_COURS']);
    });

    // Cadrage, « Enregistrement » : « 400 pour un destinataire invalide (validerDestinataire, inchangé) ».
    test('destinataire invalide : 400 avec le message du lot 6a-3, sans rien écrire', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client rapport destinataire ${s}`);
      const { chantier } = await chantierConverti(client.id, `TEST Chantier destinataire ${s}`);
      for (const valeur of [undefined, null, 42, ['a@b.fr'], '', '   ', 'sans-arobase.fr', 'a@b', 'a@b.fr,c@d.fr', 'a@b.fr;c@d.fr', 'Nom <a@b.fr>', 'a b@c.fr', `${'a'.repeat(250)}@b.fr`]) {
        await sansEcriture(() => appeler('post', `${cheminChantier(chantier.id)}/envois`, valeur === undefined ? {} : { destinataire: valeur }), 400, `destinataire ${JSON.stringify(valeur)}`, REFUS_DESTINATAIRE);
      }
    });

    // ------------------------------------------------------------------------------------------------
    // Droits.
    // ------------------------------------------------------------------------------------------------

    // Cadrage, « Routes » : « en session seulement, sans clé d'intégration ni route /api/v1, avec requireAuth puis
    // requireAdmin, comme le PDF de 6a-4c » ; « Droits » (choix par défaut, le plus restrictif, à confirmer) :
    // « l'administration seule, en session, pour la lecture (proposition et journal) comme pour l'enregistrement ».
    // « Tests » : « matrice des types de compte sur les deux routes (seules l'administration et la
    // super-administration passent, 403 pour tous les autres, même pour un chantier introuvable) ». Le titulaire,
    // le commercial et le directeur lisent la fiche du chantier : leur refus n'est pas de périmètre.
    test('droits : matrice des types de compte sur les deux routes ; seules l’administration et la super-administration passent ; 403 pour tout autre compte, titulaire, commercial et technicien du chantier compris, même avec tous les droits et pour un chantier introuvable', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client rapport droits ${s}`, { email: 'droits@client-6a4e.test' });
      const titulaire = await creerCompte('CONDUCTEUR_TRAVAUX', 'titulaire', s, { permissions: TOUS_LES_SCOPES });
      const commercialDuChantier = await creerCompte('COMMERCIAL', 'commercial-du-chantier', s, { permissions: TOUS_LES_SCOPES });
      const responsable = await creerCompte('RESPONSABLE', 'responsable-du-titulaire', s, { permissions: TOUS_LES_SCOPES });
      await prisma.user.update({ where: { id: titulaire.id }, data: { responsableHierarchiqueId: responsable.id } });
      const directeurTousDroits = await creerCompte('DIRECTEUR', 'directeur-tous-droits', s, { permissions: TOUS_LES_SCOPES, accesFinance: true });
      const affecte = await compteTechnicien('affecte', s);
      const { chantier: enCours } = await chantierConverti(client.id, `TEST Chantier droits ${s}`);
      await prisma.chantier.update({ where: { id: enCours.id }, data: { responsableId: titulaire.id, commercialId: commercialDuChantier.id } });
      const intervention = await creerIntervention({ clientId: client.id, chantierId: enCours.id, titre: `TEST Demande des droits ${s}` });
      await planifier(intervention.id, [affecte.intervenantId]);
      await demarrer(intervention.id);
      await ajouterCompteRendu(intervention.id, 'TEST Compte rendu des droits.', entete(affecte.jeton));
      const { chantier: annule, annuler } = await chantierConverti(client.id, `TEST Chantier droits annulé ${s}`);
      await annuler();
      for (const compte of [titulaire, commercialDuChantier, directeurTousDroits]) {
        assert.equal((await appeler('get', `/chantiers/${enCours.id}`, null, parCompte(compte))).status, 200, `${compte.role} lit la fiche du chantier`);
      }

      const refuses = [
        ...await Promise.all(ROLES_NON_ADMINISTRATEURS.map(async (role) => [role, parCompte(await creerCompte(role, `role-${role.toLowerCase()}`, s))])),
        ['CONDUCTEUR_TRAVAUX (titulaire du chantier, tous les droits)', parCompte(titulaire)],
        ['COMMERCIAL (commercial du chantier, tous les droits)', parCompte(commercialDuChantier)],
        ['RESPONSABLE (du titulaire, tous les droits)', parCompte(responsable)],
        ['DIRECTEUR (tous les droits, accès aux finances)', parCompte(directeurTousDroits)],
        ['TECHNICIEN (affecté à une intervention du chantier)', entete(affecte.jeton)],
      ];
      const admis = [
        ['SUPERADMIN', admin()],
        ['ADMIN', parCompte(await creerCompte('ADMIN', 'admin', s))],
        ['ADMIN commercial', parCompte(await creerCompte('ADMIN', 'admin-commercial', s, { estCommercial: true }))],
      ];
      const cibles = [[enCours.id, 'en cours'], [annule.id, 'annulé'], [randomUUID(), 'introuvable']];
      //                                en cours, annulé, introuvable
      const LECTURE_ADMISE = [200, 200, 404];
      const ENREGISTREMENT_ADMIS = [201, 409, 404];

      for (const [libelle, auth] of refuses) {
        for (const [id, nomCible] of cibles) {
          const lu = await sansEcriture(() => lire(id, auth), 403, `lecture, ${libelle}, ${nomCible}`, REFUS_ADMINISTRATION);
          assert.equal(lu.body.proposition, undefined, libelle);
          await sansEcriture(() => envoyer(id, 'droits@client-6a4e.test', auth), 403, `enregistrement, ${libelle}, ${nomCible}`, REFUS_ADMINISTRATION);
        }
      }
      for (const [libelle, auth] of admis) {
        for (const [rangCible, [id, nomCible]] of cibles.entries()) {
          const lu = await sansEcriture(() => lire(id, auth), LECTURE_ADMISE[rangCible], `lecture, ${libelle}, ${nomCible}`);
          if (lu.status === 200) {
            const nom = rangCible === 0 ? enCours.nom : annule.nom;
            assert.deepEqual(lu.body.proposition, { destinataire: 'droits@client-6a4e.test', objet: objetRapport(nom, SOCIETE.raisonSociale), corps: corpsRapport(nom, SOCIETE.raisonSociale) }, libelle);
          }
          const contexte = `enregistrement, ${libelle}, ${nomCible}`;
          if (ENREGISTREMENT_ADMIS[rangCible] === 201) {
            const { res } = await enregistre(() => envoyer(id, 'droits@client-6a4e.test', auth), contexte);
            assert.equal(res.body.envoi.objet, objetRapport(enCours.nom, SOCIETE.raisonSociale));
          } else {
            await sansEcriture(() => envoyer(id, 'droits@client-6a4e.test', auth), ENREGISTREMENT_ADMIS[rangCible], contexte, rangCible === 1 ? CHANTIER_ANNULE : undefined);
          }
        }
      }
      // Les trois envois admis sont au journal du chantier, du plus récent au plus ancien ; aucun sur l'annulé.
      const comptesAdmis = await prisma.envoiDocument.findMany({ where: { chantierId: enCours.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { auteurNom: true } });
      assert.deepEqual((await lire(enCours.id)).body.envois.map((e) => e.auteurNom), comptesAdmis.map((e) => e.auteurNom));
      assert.equal(comptesAdmis.length, 3);
      assert.equal(await prisma.envoiDocument.count({ where: { chantierId: annule.id } }), 0);
    });

    // Cadrage, « Routes » : « en session seulement, sans clé d'intégration ni route /api/v1 » ; « Tests » : « 401
    // sans session et pour une clé d'intégration ; aucune route /api/v1 (404) » (N2 c).
    test('session seulement : 401 sans session et pour une clé d’intégration de tous les scopes ; aucune route /api/v1 (404), en lecture comme en enregistrement', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client rapport session ${s}`);
      const { chantier } = await chantierConverti(client.id, `TEST Chantier session ${s}`);
      const cle = await ok(appeler('post', '/admin/api-keys', { nom: `TEST clé envoi 6a4e ${s}`, scopes: TOUS_LES_SCOPES }), 201);
      const parCle = entete(cle.apiKey);
      assert.equal((await appeler('get', '/v1/chantiers', null, parCle)).status, 200, 'la clé est valide');
      await sansEcriture(() => lire(chantier.id, null), 401, 'lecture sans session');
      await sansEcriture(() => envoyer(chantier.id, 'client@envoi-6a4e.test', null), 401, 'enregistrement sans session');
      await sansEcriture(() => lire(chantier.id, parCle), 401, 'lecture par une clé');
      await sansEcriture(() => envoyer(chantier.id, 'client@envoi-6a4e.test', parCle), 401, 'enregistrement par une clé');
      await sansEcriture(() => appeler('get', `/v1/chantiers/${chantier.id}/envois`, null, parCle), 404, 'lecture /api/v1');
      await sansEcriture(() => appeler('post', `/v1/chantiers/${chantier.id}/envois`, { destinataire: 'client@envoi-6a4e.test' }, parCle), 404, 'enregistrement /api/v1');
      await sansEcriture(() => appeler('get', `/v1/chantiers/${chantier.id}/envois`), 404, 'lecture /api/v1 en session');
    });

    // ------------------------------------------------------------------------------------------------
    // Refus et ordre des contrôles.
    // ------------------------------------------------------------------------------------------------

    // Cadrage, « Chantier annulé, en lecture » : « il garde son journal et sa proposition lisibles, comme un contrat
    // annulé. Son PDF reste imprimable » ; « Enregistrement » : « 409 « Un chantier annulé ne s’envoie pas. » » ;
    // « Tests » : « chantier annulé par l'annulation de son devis, après un envoi enregistré : la lecture rend cet
    // envoi ; l'enregistrement est refusé (409), sans rien écrire ».
    test('chantier annulé par l’annulation de son devis, après un envoi : le journal et la proposition restent lisibles, l’enregistrement est refusé (409) sans rien écrire, le PDF reste imprimable', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client rapport annulé ${s}`, { email: 'annule@client-6a4e.test' });
      const { chantier, annuler } = await chantierConverti(client.id, `TEST Chantier annulé ${s}`);
      const envoi = (await enregistre(() => envoyer(chantier.id, 'annule@client-6a4e.test'), 'envoi avant annulation')).res.body.envoi;
      await annuler();
      const lu = await sansEcriture(() => lire(chantier.id), 200, 'lecture de l’annulé');
      assert.deepEqual(lu.body, {
        proposition: { destinataire: 'annule@client-6a4e.test', objet: objetRapport(chantier.nom, SOCIETE.raisonSociale), corps: corpsRapport(chantier.nom, SOCIETE.raisonSociale) },
        envois: [envoi],
      });
      await sansEcriture(() => envoyer(chantier.id, 'annule@client-6a4e.test'), 409, 'enregistrement sur l’annulé', CHANTIER_ANNULE);
      const texte = await textePdf(chantier.id);
      assert.ok(texte.includes('CHANTIER ANNULÉ') && texte.includes(chantier.nom), texte);
      assert.equal((await prisma.chantier.findUniqueOrThrow({ where: { id: chantier.id } })).statut, 'ANNULE');
    });

    // Cadrage, « Refus », sans rien écrire : « 404 « Chantier introuvable » » ; « 409 si l'identité de la société
    // est incomplète (« … avant d’envoyer un rapport de chantier ») », en lecture comme en enregistrement.
    // L'identité complétée, l'envoi passe.
    test('refus sans rien écrire : introuvable (404) ; identité incomplète (409) qui nomme les champs manquants, en lecture comme en enregistrement', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client rapport refus ${s}`);
      const { devis, chantier } = await chantierConverti(client.id, `TEST Chantier refus ${s}`);
      const intervention = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `TEST Demande refus ${s}` });
      // Un identifiant d'un autre document n'est pas un chantier.
      for (const id of [randomUUID(), 'inexistant', intervention.id, devis.id]) {
        await sansEcriture(() => lire(id), 404, `lecture, ${id}`, CHANTIER_INTROUVABLE);
        await sansEcriture(() => envoyer(id, 'client@envoi-6a4e.test'), 404, `enregistrement, ${id}`);
      }
      try {
        await definirSociete({ siret: '', ville: '  ' });
        await sansEcriture(() => lire(chantier.id), 409, 'lecture, identité incomplète', identiteIncomplete('SIRET, ville'));
        await sansEcriture(() => envoyer(chantier.id, 'client@envoi-6a4e.test'), 409, 'enregistrement, identité incomplète', identiteIncomplete('SIRET, ville'));
        await definirSociete({ siret: SOCIETE.siret, ville: SOCIETE.ville, raisonSociale: '' });
        await sansEcriture(() => envoyer(chantier.id, 'client@envoi-6a4e.test'), 409, 'raison sociale absente', identiteIncomplete('raison sociale'));
        await sansEcriture(() => lire(chantier.id), 409, 'lecture, raison sociale absente', identiteIncomplete('raison sociale'));
      } finally {
        await definirSociete(SOCIETE);
      }
      await enregistre(() => envoyer(chantier.id, 'client@envoi-6a4e.test'), 'identité complétée');
    });

    // Cadrage, « Ordre des contrôles, comme le contrat : gardes (401, 403), destinataire (400), introuvable (404),
    // annulé (409), identité (409) » ; « Tests » : « chaque refus est provoqué avec le suivant aussi présent, comme
    // dans 6a-4d » (N2 a). Chaque appel réunit deux refus ou plus : le premier dans l'ordre l'emporte.
    test('ordre des contrôles : session, administration, destinataire, introuvable, annulé, identité', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client rapport ordre ${s}`);
      const { chantier: actif } = await chantierConverti(client.id, `TEST Chantier ordre ${s}`);
      const { chantier: annule, annuler } = await chantierConverti(client.id, `TEST Chantier ordre annulé ${s}`);
      await annuler();
      const titulaire = await creerCompte('CONDUCTEUR_TRAVAUX', 'titulaire-ordre', s);
      await prisma.chantier.update({ where: { id: actif.id }, data: { responsableId: titulaire.id } });
      const introuvable = randomUUID();
      const INVALIDE = 'pas-une-adresse';
      const VALIDE = 'client@envoi-6a4e.test';

      // Session avant tout.
      await sansEcriture(() => envoyer(introuvable, INVALIDE, null), 401, 'session avant destinataire et introuvable');
      await sansEcriture(() => lire(introuvable, null), 401, 'session avant introuvable, lecture');
      // Administration avant destinataire, introuvable et annulé.
      for (const [id, contexte] of [[actif.id, 'destinataire invalide'], [introuvable, 'destinataire invalide, introuvable'], [annule.id, 'destinataire invalide, annulé']]) {
        await sansEcriture(() => envoyer(id, INVALIDE, parCompte(titulaire)), 403, `administration avant ${contexte}`, REFUS_ADMINISTRATION);
      }
      await sansEcriture(() => envoyer(introuvable, VALIDE, parCompte(titulaire)), 403, 'administration avant introuvable', REFUS_ADMINISTRATION);
      await sansEcriture(() => envoyer(annule.id, VALIDE, parCompte(titulaire)), 403, 'administration avant annulé', REFUS_ADMINISTRATION);
      await sansEcriture(() => lire(introuvable, parCompte(titulaire)), 403, 'administration avant introuvable, lecture', REFUS_ADMINISTRATION);
      // Destinataire avant introuvable et annulé.
      await sansEcriture(() => envoyer(introuvable, INVALIDE), 400, 'destinataire avant introuvable', REFUS_DESTINATAIRE);
      await sansEcriture(() => envoyer(annule.id, INVALIDE), 400, 'destinataire avant annulé', REFUS_DESTINATAIRE);
      try {
        await definirSociete({ ville: '' });
        // Gardes et destinataire avant l'identité.
        await sansEcriture(() => envoyer(actif.id, VALIDE, parCompte(titulaire)), 403, 'administration avant identité', REFUS_ADMINISTRATION);
        await sansEcriture(() => lire(actif.id, parCompte(titulaire)), 403, 'administration avant identité, lecture', REFUS_ADMINISTRATION);
        await sansEcriture(() => envoyer(actif.id, INVALIDE), 400, 'destinataire avant identité', REFUS_DESTINATAIRE);
        await sansEcriture(() => envoyer(annule.id, INVALIDE), 400, 'destinataire avant annulé et identité', REFUS_DESTINATAIRE);
        // Introuvable avant identité.
        await sansEcriture(() => envoyer(introuvable, VALIDE), 404, 'introuvable avant identité');
        await sansEcriture(() => lire(introuvable), 404, 'introuvable avant identité, lecture', CHANTIER_INTROUVABLE);
        // Annulé avant identité.
        await sansEcriture(() => envoyer(annule.id, VALIDE), 409, 'annulé avant identité', CHANTIER_ANNULE);
        // Identité en dernier, en lecture (annulé compris) comme en enregistrement.
        await sansEcriture(() => envoyer(actif.id, VALIDE), 409, 'identité', identiteIncomplete('ville'));
        await sansEcriture(() => lire(actif.id), 409, 'identité, lecture', identiteIncomplete('ville'));
        await sansEcriture(() => lire(annule.id), 409, 'identité, lecture de l’annulé', identiteIncomplete('ville'));
      } finally {
        await definirSociete(SOCIETE);
      }
    });

    // Cadrage, « Verrou » : « l'enregistrement prend d'abord un verrou partagé du chantier par une requête directe
    // (SELECT 1 FROM "Chantier" WHERE "id" = … FOR SHARE), puis relit son statut dans la transaction. L'annulation
    // d'un devis converti prend FOR NO KEY UPDATE sur son chantier (devis/annulation.ts), un verrou qu'un FOR SHARE
    // bloque. Une annulation en cours est donc attendue, puis elle refuse l'envoi. » « Tests » : « comme le test
    // livré par 6a-4d » (N2 f). L'annulation est tenue ici par une transaction qui prend ce même verrou, passe le
    // chantier « annulé », puis est validée.
    test('verrou : l’envoi attend l’annulation en cours du chantier, puis est refusé (409) sans rien écrire', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client rapport verrou ${s}`);
      const { chantier } = await chantierConverti(client.id, `TEST Chantier verrou ${s}`);
      let liberer;
      const retenue = new Promise((resolveRetenue) => { liberer = resolveRetenue; });
      let pidTenant = null;
      const avant = await prisma.envoiDocument.count();
      const tenant = prisma.$transaction(async (tx) => {
        [{ pid: pidTenant }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT "id" FROM "Chantier" WHERE "id" = ${chantier.id} FOR NO KEY UPDATE`;
        await tx.$executeRaw`UPDATE "Chantier" SET "statut" = 'ANNULE', "annuleLe" = now(), "annuleParId" = ${secours.id}, "motifAnnulation" = 'TEST annulation concurrente 6a4e' WHERE "id" = ${chantier.id}`;
        await retenue;
      }, { timeout: 40_000 });
      try {
        while (pidTenant === null) await new Promise((resolveAttente) => setTimeout(resolveAttente, 10));
        let repondu = false;
        const envoi = envoyer(chantier.id, 'client@envoi-6a4e.test').then((reponse) => { repondu = true; return reponse; });
        const bloque = await attendreBlocage(pidTenant, () => repondu);
        liberer();
        await tenant;
        const reponse = await envoi;
        assert.equal(bloque, true, 'l’envoi doit attendre le verrou de l’annulation');
        assert.equal(reponse.status, 409, JSON.stringify(reponse.body));
        assert.equal(reponse.body.error, CHANTIER_ANNULE);
      } finally {
        liberer();
        await tenant.catch(() => undefined);
      }
      assert.equal(await prisma.envoiDocument.count(), avant, 'rien n’est écrit');
      assert.equal(await prisma.envoiDocument.count({ where: { chantierId: chantier.id } }), 0);
    });

    // ------------------------------------------------------------------------------------------------
    // Isolement du journal et objet sans montant.
    // ------------------------------------------------------------------------------------------------

    // Cadrage, « Tests » : « isolement du journal : la lecture d'un chantier ne rend ni les envois d'un autre
    // chantier, ni ceux de son devis, ni ceux d'un contrat ou d'une intervention du même client » (N2 b).
    test('isolement du journal : un chantier ne rend que ses envois, ni ceux d’un autre chantier, ni ceux de son devis, ni ceux d’un contrat ou d’une intervention du même client', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client rapport isolement ${s}`);
      const { devis, chantier } = await chantierConverti(client.id, `TEST Chantier isolé ${s}`);
      const { chantier: autreChantier } = await chantierConverti(client.id, `TEST Autre chantier ${s}`);
      const intervention = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `TEST Demande isolée ${s}` });
      await demarrer(intervention.id);
      await ajouterCompteRendu(intervention.id, 'TEST Compte rendu isolé.');
      const contrat = await creerContrat(client.id, `TEST Contrat isolé ${s}`);
      // Envois des autres documents du même client, avant et après celui du chantier.
      const avantChantier = [
        await ok(appeler('post', `/devis/${devis.id}/envois`, { destinataire: 'devis@client-6a4e.test' }), 201),
        await ok(appeler('post', `/interventions/${intervention.id}/envois`, { destinataire: 'intervention@client-6a4e.test' }), 201),
      ];
      const duChantier = (await enregistre(() => envoyer(chantier.id, 'chantier@client-6a4e.test'), 'envoi du chantier')).res.body.envoi;
      const apresChantier = [
        await ok(appeler('post', `/contrats-maintenance/${contrat.id}/envois`, { destinataire: 'contrat@client-6a4e.test' }), 201),
      ];
      const deLAutre = (await enregistre(() => envoyer(autreChantier.id, 'autre@client-6a4e.test'), 'envoi de l’autre chantier')).res.body.envoi;
      assert.equal(avantChantier.length + apresChantier.length, 3);
      assert.deepEqual((await sansEcriture(() => lire(chantier.id), 200, 'lecture du chantier')).body.envois, [duChantier]);
      assert.deepEqual((await lire(autreChantier.id)).body.envois, [deLAutre]);
      // Et réciproquement : le journal des autres documents ne rend pas les envois des chantiers.
      assert.deepEqual((await appeler('get', `/devis/${devis.id}/envois`)).body.envois.map((e) => e.destinataire), ['devis@client-6a4e.test']);
      assert.deepEqual((await appeler('get', `/interventions/${intervention.id}/envois`)).body.envois.map((e) => e.destinataire), ['intervention@client-6a4e.test']);
      assert.deepEqual((await appeler('get', `/contrats-maintenance/${contrat.id}/envois`)).body.envois.map((e) => e.destinataire), ['contrat@client-6a4e.test']);
    });

    // Réponse de Nelson du 31-10-2026 (« il ne doit pas y avoir de montant ni de heures ») ; cadrage, « Objet et
    // texte » : « Le texte ne porte aucun montant ni aucune heure, ni mention légale » ; « Tests » : « objet et
    // texte sans montant ni heures, avec les valeurs témoins du test de 6a-4c ». Chaque valeur témoin est d'abord
    // relue par l'application : le test ne passe pas à vide. L'objet et le texte sont lus dans la proposition, la
    // réponse de l'enregistrement, la ligne du journal et sa lecture.
    test('objet et texte sans montant ni heures : aucune valeur témoin du chantier (budgets, coût prévu, achat, pointage, facture, avoir, heures et matériel de l’intervention), sous aucune écriture', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client rapport témoin ${s}`, { email: 'temoin@client-6a4e.test' });
      // Valeurs témoins du chantier : budgets (4 321,09 = 1 987,63 + 2 333,46), 37,25 h vendues (37 h 15, 2 235 min),
      // coût d'achat prévu 1 456,78.
      const chantier = await creerChantier({
        nom: `TEST Chantier témoin ${s}`, numeroDevis: 'A26-0077', client: client.raisonSociale, clientId: client.id, dateDebut: new Date('2026-04-06T00:00:00.000Z'),
        budgetGlobalVendu: 4321.09, budgetMaterielVendu: 1987.63, budgetMainOeuvreVendu: 2333.46, heuresVendues: 37.25, coutMaterielPrevu: 1456.78, types: ['Vidéo'],
      });
      // Ligne de budget prévisionnel : 2 718,28 alloués, 20,57 h allouées.
      const categorie = await prisma.categorie.create({ data: { nom: `TEST Catégorie 6a4e ${s}` } });
      await prisma.ligneBudgetPrevisionnel.create({ data: { chantierId: chantier.id, categorieId: categorie.id, montantAlloue: 2718.28, heuresAllouees: 20.57 } });
      // Achat réel du chantier : 876,54 HT.
      const fournisseur = await prisma.fournisseur.create({ data: { nom: `TEST Fournisseur 6a4e ${s}` } });
      await ok(appeler('post', '/achats', { chantierId: chantier.id, fournisseurId: fournisseur.id, categorieId: categorie.id, date: '10-04-2026', description: 'TEST Câble du chantier témoin', montantHT: 876.54, numeroFacture: 'TEST-FF-6A4E' }));
      // Pointage : 12,75 h au taux de 48,13 €, soit 613,66 € de main-d'œuvre.
      const pointeur = await prisma.intervenant.create({ data: { nom: `TEST Intervenant pointé ${s}`, role: 'Technicien', tauxHoraireCharge: 48.13 } });
      await ok(appeler('post', '/heures', { chantierId: chantier.id, intervenantId: pointeur.id, date: '11-04-2026', nbrHeures: 12.75 }));
      // Facture émise : 3 × 271,13 = 813,39 HT, 162,68 de TVA, 976,07 TTC ; avoir de 271,13 HT, 54,23 de TVA,
      // 325,36 TTC ; facturé net 542,26, reste à facturer 3 778,83.
      const brouillon = await ok(appeler('post', '/factures', {
        clientId: client.id, origine: 'CHANTIER', chantierId: chantier.id, dateEmission: aujourdhuiParis(), dateEcheance: aujourdhuiParis(),
        lignes: [{ designation: 'TEST Prestation du chantier témoin', quantite: 3, prixUnitaireHt: 271.13, tauxTva: 20 }],
      }), 201);
      const facture = await ok(appeler('post', `/factures/${brouillon.id}/emettre`));
      assert.deepEqual([facture.statut, facture.totalHt, facture.totalTva, facture.totalTtc], ['EMISE', 813.39, 162.68, 976.07]);
      await reussi(appeler('post', `/factures/${facture.id}/avoirs`, { lignes: [{ designation: 'TEST Avoir du chantier témoin', quantite: 1, prixUnitaireHt: 271.13, tauxTva: 20 }] }));
      // Intervention du chantier : 6,75 h saisies par le technicien (324,88 € au taux de 48,13 €), 219,47 € de
      // matériel, compte rendu.
      const technicien = await compteTechnicien('temoin', s);
      const intervention = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `TEST Demande témoin ${s}`, dateDemande: '13-04-2026' });
      await planifier(intervention.id, [technicien.intervenantId]);
      await demarrer(intervention.id);
      await ok(appeler('post', `/interventions/${intervention.id}/couts/heures`, { date: '13-04-2026', nbrHeures: 6.75 }, entete(technicien.jeton)), 201);
      await ok(appeler('post', `/interventions/${intervention.id}/couts/achats`, { date: '13-04-2026', description: 'TEST Pièce de l’intervention témoin', montantHT: 219.47, fournisseurId: fournisseur.id }), 201);
      await ajouterCompteRendu(intervention.id, 'TEST Compte rendu de la demande témoin.', entete(technicien.jeton));

      // Les valeurs témoins existent bien, telles que posées : l'application les relit.
      const fiche = await ok(appeler('get', `/chantiers/${chantier.id}`));
      assert.deepEqual([fiche.budgetGlobalVendu, fiche.budgetMaterielVendu, fiche.budgetMainOeuvreVendu, fiche.heuresVendues, fiche.coutMaterielPrevu], [4321.09, 1987.63, 2333.46, 37.25, 1456.78]);
      assert.deepEqual([fiche.achats.length, fiche.pointages.length, fiche.facturation?.totalFactureHt, fiche.facturation?.resteAFacturerHt], [1, 1, 542.26, 3778.83], JSON.stringify(fiche.facturation));
      const couts = await ok(appeler('get', `/interventions/${intervention.id}/couts`));
      assert.deepEqual([couts.heures.length, couts.achats.length], [1, 1]);

      const objet = objetRapport(chantier.nom, SOCIETE.raisonSociale);
      const corps = corpsRapport(chantier.nom, SOCIETE.raisonSociale);
      // Témoin du crible : l'objet et le texte attendus n'en déclenchent aucun motif.
      verifierSansMontantNiHeure(`${objet}\n${corps}`, 'attendu du cadrage');
      // Témoin inverse : le crible reconnaît bien un montant et une durée glissés dans le texte, y compris en toutes
      // lettres (N2), arrondis, ou sous l'écriture française.
      for (const piege of [`${corps} 4 321,09`, `${corps} 4321`, `${corps} 37 h 15`, `${corps} 37 heures`, `${corps} 877 euros`, `${corps} 2235 min`, `${corps} 613,66 €`]) {
        assert.throws(() => verifierSansMontantNiHeure(piege, 'piège'), assert.AssertionError, piege);
      }

      const lu = await sansEcriture(() => lire(chantier.id), 200, 'lecture du chantier témoin');
      assert.deepEqual(lu.body.proposition, { destinataire: 'temoin@client-6a4e.test', objet, corps });
      verifierSansMontantNiHeure(lu.body.proposition.objet, 'objet proposé');
      verifierSansMontantNiHeure(lu.body.proposition.corps, 'texte proposé');
      const { res, ligne } = await enregistre(() => envoyer(chantier.id, 'temoin@client-6a4e.test'), 'envoi du chantier témoin');
      assert.deepEqual([res.body.objet, res.body.corps, res.body.envoi.objet, ligne.objet], [objet, corps, objet, objet]);
      const relu = (await lire(chantier.id)).body;
      for (const [texte, contexte] of [[res.body.objet, 'objet de la réponse'], [res.body.corps, 'texte de la réponse'], [ligne.objet, 'objet du journal'], [relu.envois[0].objet, 'objet relu au journal'], [relu.proposition.corps, 'texte relu']]) {
        verifierSansMontantNiHeure(texte, contexte);
      }
    });

    // ------------------------------------------------------------------------------------------------
    // Migration du journal (cadrage, « Migration du journal », N4, et « Tests », N2 e).
    // ------------------------------------------------------------------------------------------------

    // « les trois déclencheurs du journal (envoi_document_ajout_seul, envoi_document_sans_vidage,
    // envoi_document_horodatage) restent en place, ni supprimés ni recréés, et s'appliquent aux nouvelles lignes » ;
    // « Tests » : « les trois déclencheurs refusent la modification et la suppression d'une ligne de chantier, ainsi
    // que le vidage de la table ».
    test('migration : les trois déclencheurs, actifs, refusent la modification et la suppression d’un envoi de chantier, le vidage de la table, et imposent l’horodatage', async () => {
      const s = suffixe();
      const declencheurs = await prisma.$queryRaw`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = '"EnvoiDocument"'::regclass AND NOT tgisinternal ORDER BY tgname`;
      assert.deepEqual(declencheurs, [
        { tgname: 'envoi_document_ajout_seul', tgenabled: 'O' },
        { tgname: 'envoi_document_horodatage', tgenabled: 'O' },
        { tgname: 'envoi_document_sans_vidage', tgenabled: 'O' },
      ]);
      const client = await creerClient(`TEST Client rapport déclencheurs ${s}`);
      const { chantier } = await chantierConverti(client.id, `TEST Chantier déclencheurs ${s}`);
      const autre = await creerChantier({ nom: `TEST Autre chantier déclencheurs ${s}`, client: client.raisonSociale, clientId: client.id });
      const contrat = await creerContrat(client.id, `TEST Contrat déclencheurs ${s}`);
      const ligne = (await enregistre(() => envoyer(chantier.id, 'client@envoi-6a4e.test'), 'envoi de chantier')).ligne;
      for (const data of [{ destinataire: 'autre@envoi-6a4e.test' }, { objet: 'TEST autre objet' }, { auteurNom: 'TEST Autre' }, { canal: 'MESSAGERIE' }, { createdAt: new Date('2020-01-01T00:00:00Z') }, { chantierId: autre.id }, { chantierId: null, contratMaintenanceId: contrat.id }]) {
        await assert.rejects(prisma.envoiDocument.update({ where: { id: ligne.id }, data }), /Journal des envois : ajout seul/, JSON.stringify(data));
      }
      await assert.rejects(prisma.envoiDocument.delete({ where: { id: ligne.id } }), /Journal des envois : ajout seul/);
      await assert.rejects(prisma.envoiDocument.deleteMany({ where: { chantierId: chantier.id } }), /Journal des envois : ajout seul/);
      await assert.rejects(prisma.$executeRawUnsafe('TRUNCATE "EnvoiDocument"'), /Vidage de « EnvoiDocument » interdit/);
      assert.deepEqual(await prisma.envoiDocument.findUniqueOrThrow({ where: { id: ligne.id } }), ligne);
      // Horodatage imposé par la base, quelle que soit la date fournie, pour une ligne de chantier.
      const [{ maintenant }] = await prisma.$queryRaw`SELECT now() AS maintenant`;
      const id = randomUUID();
      await prisma.$executeRaw`INSERT INTO "EnvoiDocument" ("id", "chantierId", "canal", "destinataire", "objet", "auteurId", "auteurNom", "createdAt") VALUES (${id}, ${chantier.id}, 'MESSAGERIE', 'client@envoi-6a4e.test', 'TEST Objet', ${secours.id}, 'TEST Auteur', '2020-01-01T00:00:00Z')`;
      const { createdAt } = await prisma.envoiDocument.findUniqueOrThrow({ where: { id } });
      assert.ok(Math.abs(createdAt.getTime() - maintenant.getTime()) < 60_000, createdAt.toISOString());
    });

    // « la contrainte supprimée puis recréée sous le même nom, EnvoiDocument_un_document : num_nonnulls("devisId",
    // "factureId", "interventionId", "contratMaintenanceId", "chantierId") = 1 » ; « un index (chantierId,
    // createdAt) » ; « le canal reste MESSAGERIE seul » ; « Tests » : « la contrainte refuse une ligne sans document
    // et une ligne qui porte un chantier et un autre document ».
    test('migration : EnvoiDocument_un_document sur cinq colonnes refuse une ligne sans document et une ligne qui porte un chantier et un autre document ; canal MESSAGERIE seul ; index (chantierId, createdAt)', async () => {
      const s = suffixe();
      const [contrainte] = await prisma.$queryRaw`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = '"EnvoiDocument"'::regclass AND conname = 'EnvoiDocument_un_document'`;
      assert.equal(contrainte?.definition, 'CHECK ((num_nonnulls("devisId", "factureId", "interventionId", "contratMaintenanceId", "chantierId") = 1))');
      const [canal] = await prisma.$queryRaw`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = '"EnvoiDocument"'::regclass AND conname = 'EnvoiDocument_canal'`;
      assert.match(canal?.definition ?? '', /'MESSAGERIE'/);
      assert.doesNotMatch(canal?.definition ?? '', /MICROSOFT|365/);
      const index = (await prisma.$queryRaw`SELECT indexdef FROM pg_indexes WHERE tablename = 'EnvoiDocument'`).map((ligne) => ligne.indexdef.replace(/^.* USING btree /, ''));
      for (const colonnes of ['("chantierId", "createdAt")', '("interventionId", "createdAt")', '("contratMaintenanceId", "createdAt")', '("devisId", "createdAt")', '("factureId", "createdAt")']) {
        assert.ok(index.includes(colonnes), `index ${colonnes} absent : ${index.join(' ; ')}`);
      }
      const client = await creerClient(`TEST Client rapport contrainte ${s}`);
      const { devis, chantier } = await chantierConverti(client.id, `TEST Chantier contrainte ${s}`);
      const intervention = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `TEST Demande contrainte ${s}` });
      const contrat = await creerContrat(client.id, `TEST Contrat contrainte ${s}`);
      const factureId = randomUUID();
      await prisma.$executeRaw`INSERT INTO "Facture" ("id", "clientId", "clientRaisonSociale", "dateEcheance", "dateEmission", "origine", "motifHorsAffaire", "totalHt", "totalTtc", "totalTva", "updatedAt")
        VALUES (${factureId}, ${client.id}, ${client.raisonSociale}, now(), now(), 'HORS_AFFAIRE', 'TEST motif 6a4e', 0, 0, 0, now())`;
      const inserer = ({ devisId = null, factureId: facture = null, interventionId = null, contratMaintenanceId = null, chantierId = null, canal: canalLigne = 'MESSAGERIE' } = {}) => prisma.$executeRaw`
        INSERT INTO "EnvoiDocument" ("id", "devisId", "factureId", "interventionId", "contratMaintenanceId", "chantierId", "canal", "destinataire", "objet", "auteurId", "auteurNom")
        VALUES (${randomUUID()}, ${devisId}, ${facture}, ${interventionId}, ${contratMaintenanceId}, ${chantierId}, ${canalLigne}, 'client@envoi-6a4e.test', 'TEST Objet', ${secours.id}, 'TEST Auteur')`;
      const avant = await prisma.envoiDocument.count();
      for (const [donnees, nom] of [
        [{}, 'EnvoiDocument_un_document'],
        [{ chantierId: chantier.id, devisId: devis.id }, 'EnvoiDocument_un_document'],
        [{ chantierId: chantier.id, factureId }, 'EnvoiDocument_un_document'],
        [{ chantierId: chantier.id, interventionId: intervention.id }, 'EnvoiDocument_un_document'],
        [{ chantierId: chantier.id, contratMaintenanceId: contrat.id }, 'EnvoiDocument_un_document'],
        [{ chantierId: chantier.id, devisId: devis.id, factureId, interventionId: intervention.id, contratMaintenanceId: contrat.id }, 'EnvoiDocument_un_document'],
        [{ interventionId: intervention.id, contratMaintenanceId: contrat.id }, 'EnvoiDocument_un_document'],
        [{ chantierId: chantier.id, canal: 'MICROSOFT_365' }, 'EnvoiDocument_canal'],
        [{ chantierId: chantier.id, canal: 'messagerie' }, 'EnvoiDocument_canal'],
      ]) await assert.rejects(inserer(donnees), new RegExp(`violates check constraint \\\\?"${nom}\\\\?"`), JSON.stringify(donnees));
      assert.equal(await prisma.envoiDocument.count(), avant, 'aucune ligne refusée n’est écrite');
      // Témoins : un seul document, quel qu'il soit, s'insère.
      for (const donnees of [{ chantierId: chantier.id }, { interventionId: intervention.id }, { contratMaintenanceId: contrat.id }, { devisId: devis.id }, { factureId }]) {
        assert.equal(await inserer(donnees), 1, JSON.stringify(donnees));
      }
      assert.equal(await prisma.envoiDocument.count(), avant + 5);
    });

    // « une colonne facultative chantierId, clé étrangère vers Chantier, ON DELETE RESTRICT ON UPDATE CASCADE » ;
    // « Tests » : « la clé étrangère refuse la suppression en SQL d'un chantier qui porte un envoi, l'erreur nommant
    // EnvoiDocument_chantierId_fkey ; le chantier choisi n'a ni intervention, ni pointage, ni achat, ni facture,
    // pour que les clés plus anciennes ne répondent pas avant » (N2 e). Le témoin sans envoi, lui, se supprime.
    test('migration : clé EnvoiDocument_chantierId_fkey (ON DELETE RESTRICT ON UPDATE CASCADE) ; un chantier sans intervention, pointage, achat ni facture qui porte un envoi ne se supprime pas', async () => {
      const s = suffixe();
      const [colonne] = await prisma.$queryRaw`SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name = 'EnvoiDocument' AND column_name = 'chantierId'`;
      assert.deepEqual(colonne, { is_nullable: 'YES', data_type: 'text' });
      const cles = await prisma.$queryRaw`SELECT conname, confrelid::regclass::text AS cible, confdeltype, confupdtype, pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = '"EnvoiDocument"'::regclass AND conname = 'EnvoiDocument_chantierId_fkey'`;
      assert.deepEqual(cles, [{ conname: 'EnvoiDocument_chantierId_fkey', cible: '"Chantier"', confdeltype: 'r', confupdtype: 'c', definition: 'FOREIGN KEY ("chantierId") REFERENCES "Chantier"(id) ON UPDATE CASCADE ON DELETE RESTRICT' }]);
      const client = await creerClient(`TEST Client rapport clé ${s}`);
      const chantier = await creerChantier({ nom: `TEST Chantier clé ${s}`, client: client.raisonSociale, clientId: client.id });
      const temoin = await creerChantier({ nom: `TEST Chantier clé témoin ${s}`, client: client.raisonSociale, clientId: client.id });
      for (const id of [chantier.id, temoin.id]) {
        assert.deepEqual(await Promise.all([
          prisma.intervention.count({ where: { chantierId: id } }), prisma.pointageHeure.count({ where: { chantierId: id } }),
          prisma.achatReel.count({ where: { chantierId: id } }), prisma.facture.count({ where: { chantierId: id } }),
        ]), [0, 0, 0, 0], 'ni intervention, ni pointage, ni achat, ni facture');
      }
      await prisma.$executeRaw`INSERT INTO "EnvoiDocument" ("id", "chantierId", "canal", "destinataire", "objet", "auteurId", "auteurNom") VALUES (${randomUUID()}, ${chantier.id}, 'MESSAGERIE', 'client@envoi-6a4e.test', 'TEST Objet', ${secours.id}, 'TEST Auteur')`;
      await assert.rejects(prisma.$executeRaw`DELETE FROM "Chantier" WHERE "id" = ${chantier.id}`, /EnvoiDocument_chantierId_fkey/);
      assert.ok(await prisma.chantier.findUnique({ where: { id: chantier.id } }), 'le chantier est gardé');
      // Témoin sans envoi : la suppression passe.
      assert.equal(await prisma.$executeRaw`DELETE FROM "Chantier" WHERE "id" = ${temoin.id}`, 1);
    });

    // « Tests » : « les envois des autres documents restent inchangés ». La migration du lot est rejouée sur une base
    // arrêtée à la dernière migration de main (lots 6a-3 et 6a-4d en place), qui porte déjà des envois de devis, de
    // facture, d'intervention et de contrat : ces lignes ressortent identiques, la colonne ajoutée vide ; les trois
    // déclencheurs sont les mêmes objets (mêmes identifiants), ni supprimés ni recréés, et refusent toujours la
    // modification d'une ligne ancienne ; les clés plus anciennes restent.
    test('migration : appliquée sur le journal des lots 6a-3 et 6a-4d, elle garde leurs envois tels quels, et les déclencheurs sans les recréer', async () => {
      const nomBaseEtape = `${nomBase}_etape`;
      const urlEtape = new URL(source);
      urlEtape.pathname = `/${nomBaseEtape}`;
      const dossier = mkdtempSync(join(tmpdir(), 'iris-envoi6a4e-migration-'));
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
        const duLot = toutes.filter((nom) => nom > DERNIERE_MIGRATION_MAIN);
        assert.deepEqual(duLot, [MIGRATION_DU_LOT], 'migration du lot');
        for (const nom of deMain) cpSync(join(dossierPrisma, 'migrations', nom), join(migrations, nom), { recursive: true });
        const deployer = () => execFileSync(binairePrisma, ['migrate', 'deploy', '--schema', schema], {
          env: { ...process.env, DATABASE_URL: urlEtape.toString() }, encoding: 'utf8', stdio: 'pipe', timeout: 180_000,
        });
        deployer();
        db = new pg.Client({ connectionString: urlEtape.toString() });
        await db.connect();
        await db.query(`INSERT INTO "Client" ("id", "raisonSociale", "updatedAt") VALUES ('client-6a4d', 'TEST Client des lots 6a-3 et 6a-4d', now())`);
        await db.query(`INSERT INTO "Devis" ("id", "clientId", "dossierId", "numero", "objet", "totalHt", "totalTtc", "totalTva", "updatedAt", "version") VALUES ('devis-6a3', 'client-6a4d', 'dossier-6a3', 'D-6A3', 'TEST Devis du lot 6a-3', 0, 0, 0, now(), 1)`);
        await db.query(`INSERT INTO "Facture" ("id", "clientId", "clientRaisonSociale", "dateEcheance", "dateEmission", "origine", "motifHorsAffaire", "totalHt", "totalTtc", "totalTva", "updatedAt") VALUES ('facture-6a3', 'client-6a4d', 'TEST Client des lots 6a-3 et 6a-4d', now(), now(), 'HORS_AFFAIRE', 'TEST motif 6a-3', 0, 0, 0, now())`);
        await db.query(`INSERT INTO "Intervention" ("id", "reference", "clientId", "titre", "updatedAt") VALUES ('intervention-6a4d', 'TEST-6A4D-1', 'client-6a4d', 'TEST Intervention du lot 6a-4d', now())`);
        await db.query(`INSERT INTO "ContratMaintenance" ("id", "clientId", "titre", "periodiciteMois", "dureePrevisionnelleMinutes", "dateDebut", "prochaineEcheance", "updatedAt") VALUES ('contrat-6a4d', 'client-6a4d', 'TEST Contrat du lot 6a-4d', 12, 60, now(), now(), now())`);
        for (const [id, colonne, document, destinataire] of [
          ['envoi-devis', 'devisId', 'devis-6a3', 'devis@client-6a4d.test'], ['envoi-facture', 'factureId', 'facture-6a3', 'compta@client-6a4d.test'],
          ['envoi-intervention', 'interventionId', 'intervention-6a4d', 'intervention@client-6a4d.test'], ['envoi-contrat', 'contratMaintenanceId', 'contrat-6a4d', 'contrat@client-6a4d.test'],
        ]) {
          await db.query(`INSERT INTO "EnvoiDocument" ("id", "${colonne}", "canal", "destinataire", "objet", "auteurId", "auteurNom") VALUES ($1, $2, 'MESSAGERIE', $3, 'TEST Objet des lots 6a-3 et 6a-4d', 'compte-6a4d', 'TEST Auteur 6a-4d')`, [id, document, destinataire]);
        }
        const lignesEtape = async () => (await db.query('SELECT row_to_json(e) AS ligne FROM "EnvoiDocument" e ORDER BY "id"')).rows.map((r) => r.ligne);
        const declencheurs = async () => (await db.query(`SELECT tgname, oid::text AS oid, tgfoid::text AS fonction, tgenabled FROM pg_trigger WHERE tgrelid = '"EnvoiDocument"'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows;
        const clesAnciennes = async () => (await db.query(`SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = '"EnvoiDocument"'::regclass AND contype = 'f' ORDER BY conname`)).rows;
        const avant = await lignesEtape();
        const declencheursAvant = await declencheurs();
        const clesAvant = await clesAnciennes();
        assert.equal(avant.length, 4);
        assert.ok(avant.every((ligne) => !('chantierId' in ligne)), 'la colonne n’existe pas avant le lot');
        assert.deepEqual(declencheursAvant.map((d) => d.tgname), ['envoi_document_ajout_seul', 'envoi_document_horodatage', 'envoi_document_sans_vidage']);
        assert.equal(clesAvant.length, 4);

        for (const nom of duLot) cpSync(join(dossierPrisma, 'migrations', nom), join(migrations, nom), { recursive: true });
        deployer();
        const appliquees = (await db.query('SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL')).rows.map((r) => r.migration_name);
        assert.ok(appliquees.includes(MIGRATION_DU_LOT), `migration ${MIGRATION_DU_LOT} non appliquée`);
        assert.deepEqual(await lignesEtape(), avant.map((ligne) => ({ ...ligne, chantierId: null })));
        assert.deepEqual(await declencheurs(), declencheursAvant, 'déclencheurs supprimés ou recréés');
        const clesApres = await clesAnciennes();
        assert.deepEqual(clesApres.filter((cle) => cle.conname !== 'EnvoiDocument_chantierId_fkey'), clesAvant, 'clés plus anciennes changées');
        assert.deepEqual(clesApres.map((cle) => cle.conname).filter((nom) => nom === 'EnvoiDocument_chantierId_fkey'), ['EnvoiDocument_chantierId_fkey']);
        const { rows: [{ definition }] } = await db.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = '"EnvoiDocument"'::regclass AND conname = 'EnvoiDocument_un_document'`);
        assert.equal(definition, 'CHECK ((num_nonnulls("devisId", "factureId", "interventionId", "contratMaintenanceId", "chantierId") = 1))');
        await assert.rejects(db.query(`UPDATE "EnvoiDocument" SET "destinataire" = 'autre@client-6a4d.test' WHERE "id" = 'envoi-facture'`), /Journal des envois : ajout seul/);
        await assert.rejects(db.query(`DELETE FROM "EnvoiDocument" WHERE "id" = 'envoi-contrat'`), /Journal des envois : ajout seul/);
        await assert.rejects(db.query('DELETE FROM "Intervention" WHERE "id" = \'intervention-6a4d\''), /EnvoiDocument_interventionId_fkey/);
        assert.deepEqual(await lignesEtape(), avant.map((ligne) => ({ ...ligne, chantierId: null })));
      } finally {
        await db?.end().catch(() => {});
        if (creee) await administrationPg.query(`DROP DATABASE IF EXISTS "${nomBaseEtape}" WITH (FORCE)`);
        rmSync(dossier, { recursive: true, force: true });
      }
    });

    // Cadrage, « Hors périmètre » : « Toute modification de l'envoi des autres documents ». Sur la base migrée,
    // l'envoi d'un devis, d'un compte rendu et d'un contrat s'enregistre comme aux lots 6a-3 et 6a-4d (réponse,
    // journal), sans chantier. Les suites de ces lots (api.test.mjs, envoi-compte-rendu-contrat.test.mjs) le
    // prouvent en entier.
    test('envois d’un devis, d’un compte rendu et d’un contrat inchangés sur la base migrée : même réponse, une ligne au journal, sans chantier', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client rapport autres documents ${s}`);
      const devis = await ok(appeler('post', '/devis', { clientId: client.id, objet: `TEST Devis envoyé ${s}`, lignes: [{ designation: 'TEST Prestation', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }), 201);
      const reponseDevis = await ok(appeler('post', `/devis/${devis.id}/envois`, { destinataire: 'client@envoi-6a4e.test' }), 201);
      assert.deepEqual(Object.keys(reponseDevis).sort(), ['corps', 'envoi', 'objet', 'statutDevis']);
      assert.equal(reponseDevis.statutDevis, 'ENVOYE');
      assert.equal(reponseDevis.objet, `Devis ${devis.numero} version 1 – ${SOCIETE.raisonSociale}`);
      const intervention = await creerIntervention({ clientId: client.id, titre: `TEST Demande envoyée ${s}` });
      await demarrer(intervention.id);
      await ajouterCompteRendu(intervention.id, 'TEST Compte rendu envoyé.');
      const reponseCompteRendu = await ok(appeler('post', `/interventions/${intervention.id}/envois`, { destinataire: 'client@envoi-6a4e.test' }), 201);
      assert.equal(reponseCompteRendu.objet, `Compte rendu d’intervention ${intervention.reference} – ${SOCIETE.raisonSociale}`);
      const contrat = await creerContrat(client.id, `TEST Contrat envoyé ${s}`);
      const reponseContrat = await ok(appeler('post', `/contrats-maintenance/${contrat.id}/envois`, { destinataire: 'client@envoi-6a4e.test' }), 201);
      assert.equal(reponseContrat.corps, `Bonjour,\n\nVeuillez trouver ci-joint le récapitulatif de votre contrat de maintenance ${contrat.titre}.\n\nCordialement,\n${SOCIETE.raisonSociale}`);
      for (const [reponse, attendu] of [
        [reponseDevis, [devis.id, null, null, null, null]],
        [reponseCompteRendu, [null, null, intervention.id, null, null]],
        [reponseContrat, [null, null, null, contrat.id, null]],
      ]) {
        const ligne = await prisma.envoiDocument.findUniqueOrThrow({ where: { id: reponse.envoi.id } });
        assert.deepEqual([ligne.devisId, ligne.factureId, ligne.interventionId, ligne.contratMaintenanceId, ligne.chantierId], attendu);
      }
      assert.deepEqual((await appeler('get', `/devis/${devis.id}/envois`)).body.envois, [reponseDevis.envoi]);
      assert.deepEqual((await appeler('get', `/interventions/${intervention.id}/envois`)).body.envois, [reponseCompteRendu.envoi]);
      assert.deepEqual((await appeler('get', `/contrats-maintenance/${contrat.id}/envois`)).body.envois, [reponseContrat.envoi]);
    });
  });
}
