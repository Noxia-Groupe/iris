// Lot 6b-1a : production commune des PDF, sans changement de comportement (cadrage du lot 6b, version 3 du
// 31-10-2026, section « Découpage », point 1, précisions P1 à P3).
//
// Le lot fait produire le PDF de chacun des cinq documents (devis, facture ou avoir, compte rendu, contrat de
// maintenance, rapport de chantier) par une fonction de son domaine, que la route « PDF » appelle. Il ne doit
// rien changer à ce qu'on observe : « Les PDF, les en-têtes et les refus restent identiques ». Ces tests figent
// donc, sur le code de main (5cd4a46) avant le changement, ce que les tests existants des PDF ne vérifient pas
// mot pour mot :
//  - le statut, le corps JSON exact et l'ordre de chaque refus de chaque route (P3 : « chaque route garde ses
//    statuts et ses messages exacts ») ;
//  - les droits et le périmètre, qui restent dans la route (P1 : les gardes, le filtre
//    getInterventionFilterForUser, l'exclusion des interventions annulées et le refus du technicien) ;
//  - les en-têtes Content-Type, Content-Disposition et Content-Length, et le nom de fichier de chaque document ;
//  - pour la facture (P2), le comportement inchangé d'une pièce émise, réglée ou annulée, et de ses avoirs :
//    son propre numéro, ses propres montants, sa mention, et un PDF qui ne bouge pas quand la société, le client,
//    son adresse ou les mentions légales changent après l'émission ;
//  - un PDF identique d'un tirage à l'autre, hors CreationDate et /ID (le lot 6b-1b enverra « un PDF identique à
//    celui de la route « PDF », hors CreationDate et /ID »).
//
// Requêtes HTTP réelles sur l'application montée en mémoire, contre un vrai PostgreSQL. Comme
// rapport-chantier-pdf.test.mjs, ce fichier crée sur le serveur de TEST_DATABASE_URL une base jetable qui
// n'appartient qu'à lui (api.test.mjs, lancé en parallèle par `node --test`, purge les données « TEST » et change
// l'identité de la société), la migre, la sert à l'application, puis la supprime. Sans TEST_DATABASE_URL, il
// s'annonce ignoré : un SKIP n'est pas une réussite.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import { PDFParse } from 'pdf-parse';

const TITRE = 'Lot 6b-1a : production commune des PDF, sans changement de comportement';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// --- Corps exacts des refus, relevés sur main (P3) ---
const SANS_SESSION = { error: 'Authentification requise' };
const SESSION_INVALIDE = { error: 'Session expirée ou invalide' };
const COMPTE_INCONNU = { error: 'Compte introuvable ou révoqué' };
const COMPTE_DESACTIVE = { code: 'COMPTE_DESACTIVE', error: 'Ce compte est désactivé.' };
const REFUS_ADMINISTRATION = { error: 'Accès réservé aux administrateurs' };
const REFUS_DEVIS_READ = { error: 'Permission requise : devis:read' };
const REFUS_COMMERCIAL = { error: 'Accès non autorisé pour un compte commercial.' };
const REFUS_DIRECTEUR = { error: 'Accès non autorisé pour un compte directeur.' };
const REFUS_TECHNICIEN = { error: 'Le PDF du compte rendu n’est pas ouvert au technicien.' };
const DEVIS_INTROUVABLE = { error: 'Devis introuvable.' };
const FACTURE_INTROUVABLE = { error: 'Facture introuvable.' };
const INTERVENTION_INTROUVABLE = { error: 'Intervention introuvable.' };
const AUCUN_COMPTE_RENDU = { error: 'Aucun compte rendu à imprimer.' };
const CONTRAT_INTROUVABLE = { error: 'Contrat de maintenance introuvable.' };
// Sans point final : message de la route du rapport de chantier, gardé tel quel (P3).
const CHANTIER_INTROUVABLE = { error: 'Chantier introuvable' };
// refusDocumentFacture (factures/metier.ts), dans son ordre : statut, mentions, adresse.
const FACTURE_NON_EMISE = { error: 'Le document est disponible uniquement pour une facture émise.' };
const FACTURE_SANS_MENTIONS = { error: 'Les mentions légales figées sont introuvables.' };
const FACTURE_SANS_ADRESSE = { error: 'L’adresse de facturation figée est absente de cette facture : le document ne peut pas être imprimé sans cette mention obligatoire.' };
// Messages d'identité « d’imprimer … » (P3), propres à chaque route.
const identiteIncomplete = (champs, avant) => ({ error: `Identité de la société incomplète : renseignez ${champs} dans l’écran Société avant ${avant}.` });
const AVANT = {
  devis: 'd’imprimer un devis',
  compteRendu: 'd’imprimer un compte rendu',
  contrat: 'd’imprimer un contrat',
  chantier: 'd’imprimer un rapport de chantier',
};
const TOUS_LES_SCOPES = ['clients:read', 'clients:write', 'catalogue:read', 'catalogue:write', 'equipements:read', 'equipements:write', 'devis:read', 'devis:write', 'company:read', 'chantiers:read', 'chantiers:write', 'chantiers:archive', 'finances:read'];

// --- Outils sans base ---
const aplatir = (texte) => texte.replace(/\s+/g, ' ').trim();
// Un PDF de PDFKit porte sa date de création (objet indirect « (D:AAAAMMJJhhmmssZ) » que désigne /CreationDate) et
// un identifiant de fichier (/ID du trailer) tiré de cette date : seuls ces champs changent d'un tirage à l'autre.
// Chacun est remplacé par une valeur fixe de même longueur ; le nombre de remplacements est vérifié, pour qu'une
// normalisation qui ne trouverait rien ne rende pas la comparaison vide de sens.
function normaliser(octets) {
  let texte = octets.toString('latin1');
  let dates = 0; let ids = 0;
  assert.match(texte, /\/CreationDate \d+ 0 R/, 'la date de création est désignée par /CreationDate');
  texte = texte.replace(/\(D:\d{14}Z\)/g, () => { dates += 1; return '(D:00000000000000Z)'; });
  texte = texte.replace(/\/ID \[<[0-9a-f]{32}> <[0-9a-f]{32}>\]/g, () => { ids += 1; return `/ID [<${'0'.repeat(32)}> <${'0'.repeat(32)}>]`; });
  assert.equal(dates, 1, 'une date de création, et une seule, dans le PDF');
  assert.equal(ids, 1, 'un identifiant de fichier, et un seul, dans le PDF');
  return texte;
}
// Jour civil JJ-MM-AAAA d'un instant dans un fuseau.
function jour(instant, fuseau) {
  const parties = new Intl.DateTimeFormat('en-GB', { timeZone: fuseau, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const valeur = (type) => parties.find((partie) => partie.type === type).value;
  return `${valeur('day')}-${valeur('month')}-${valeur('year')}`;
}

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const source = new URL(TEST_DATABASE_URL);
    // « test » comme mot (règle de client/scripts/base-jetable.mjs) et un suffixe tiré au hasard : deux
    // exécutions simultanées ne partagent jamais leur base.
    const nomBase = `iris_test_pdf6b1a_${randomBytes(6).toString('hex')}`;
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
    const parCompte = (compte) => entete(jetonDe(compte));
    let rang = 0;
    const suffixe = () => `${Date.now()}${(rang += 1)}`;

    const SOCIETE = {
      raisonSociale: 'TEST Émetteur production 6b1a', nomCommercial: '', siret: '12121212100012', tvaIntra: '',
      adresse: '12 rue de la Production', codePostal: '14000', ville: 'Caen', pays: 'France', telephone: '02 31 00 00 12',
      email: 'emetteur-6b1a@iris.test', siteWeb: '', piedFacture: 'TEST Pied de page 6b1a', couleurPrimaire: '#0f766e', fuseauHoraire: 'Europe/Paris',
    };
    const SOCIETE_CHANGEE = { raisonSociale: 'TEST Société changée après émission', siret: '34343434300034', adresse: '34 avenue Changée', piedFacture: 'TEST Pied changé', couleurPrimaire: '#7c2d12' };

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
    const binaire = (reponse, fin) => { const morceaux = []; reponse.on('data', (m) => morceaux.push(m)); reponse.on('end', () => fin(null, Buffer.concat(morceaux))); };
    // Réponse lue en octets, quel que soit son type : un refus JSON comme un PDF.
    const lire = (chemin, auth = admin()) => {
      const requete = request(app).get(chemin);
      return (auth ? requete.set(auth) : requete).buffer(true).parse(binaire);
    };
    const CHEMINS = {
      devis: (id) => `/api/devis/${id}/document.pdf`,
      facture: (id) => `/api/factures/${id}/document.pdf`,
      compteRendu: (id) => `/api/interventions/${id}/document.pdf`,
      contrat: (id) => `/api/contrats-maintenance/${id}/document.pdf`,
      chantier: (id) => `/api/chantiers/${id}/document.pdf`,
    };

    // État de la base : une impression, acceptée ou refusée, n'écrit rien. Chaque table suivie est résumée par son
    // nombre de lignes et l'empreinte de leur contenu entier (statuts, horodatages de mise à jour compris).
    const TABLES_SUIVIES = [
      'Devis', 'DevisLigne', 'DevisSignature', 'DevisConversion', 'Facture', 'FactureLigne', 'FactureVentilationTva', 'JournalFacture',
      'EcritureFacture', 'Reglement', 'AffectationReglement', 'Intervention', 'InterventionAffectation', 'InterventionRapport',
      'InterventionSignature', 'ContratMaintenance', 'Chantier', 'JournalSaisieChantier', 'CompanySettings', 'IdentiteEmetteur',
      'MentionsLegalesVersion', 'EnvoiDocument', 'JournalAdministration', 'User', 'Client', 'ClientSite',
    ];
    const etatBase = async () => {
      const colonnes = TABLES_SUIVIES.map((table) => `(SELECT count(*)::text || ':' || coalesce(md5(string_agg(row_to_json(t)::text, '|' ORDER BY row_to_json(t)::text)), '') FROM "${table}" t) AS "${table}"`);
      const [ligne] = await prisma.$queryRawUnsafe(`SELECT ${colonnes.join(', ')}`);
      return ligne;
    };

    // Un refus : statut, corps JSON exact (aucun autre champ), et aucun PDF.
    const verifierRefus = (res, statut, corps, contexte) => {
      const texte = res.body?.toString?.('utf8') ?? '';
      assert.equal(res.status, statut, `${contexte} : ${res.status} ${texte.slice(0, 300)}`);
      assert.equal(res.headers['content-type'], 'application/json; charset=utf-8', `${contexte} : un refus est en JSON`);
      assert.equal(res.headers['content-disposition'], undefined, `${contexte} : un refus ne porte pas de nom de fichier`);
      assert.deepEqual(JSON.parse(texte), corps, contexte);
    };
    // Un PDF : en-têtes exacts, longueur annoncée égale au corps, signature et fin de fichier PDF.
    const verifierPdf = (res, nomFichier, contexte) => {
      assert.equal(res.status, 200, `${contexte} : ${res.status} ${res.body?.toString?.('utf8')?.slice(0, 300)}`);
      assert.equal(res.headers['content-type'], 'application/pdf', contexte);
      assert.equal(res.headers['content-disposition'], `inline; filename="${nomFichier}"`, contexte);
      assert.equal(res.headers['content-length'], String(res.body.length), `${contexte} : Content-Length`);
      assert.equal(res.body.subarray(0, 5).toString('latin1'), '%PDF-', contexte);
      assert.match(res.body.subarray(-8).toString('latin1'), /%%EOF\s*$/, contexte);
    };
    const texteDuPdf = async (octets) => {
      const lecteur = new PDFParse({ data: octets });
      try { return (await lecteur.getText()).text; } finally { await lecteur.destroy(); }
    };
    // Matrice d'appels : chaque [compte, cible] reçoit le résultat attendu (un PDF ou un refus exact), et
    // l'ensemble des appels n'écrit rien.
    const jouerMatrice = async (route, cibles, attendus, nomsFichiers) => {
      const avant = await etatBase();
      for (const [libelle, auth, resultats] of attendus) {
        assert.equal(resultats.length, cibles.length, `matrice ${route}, ${libelle}`);
        for (const [rangCible, [nomCible, id]] of cibles.entries()) {
          const res = await lire(CHEMINS[route](id), auth);
          const attendu = resultats[rangCible];
          const contexte = `${route}, ${libelle}, cible ${nomCible}`;
          if (attendu === 200) verifierPdf(res, nomsFichiers[nomCible], contexte);
          else verifierRefus(res, attendu[0], attendu[1], contexte);
        }
      }
      assert.deepEqual(await etatBase(), avant, `${route} : aucune de ces impressions n’écrit rien`);
    };
    // Identité de la société modifiée en base le temps d'un rappel, puis rétablie.
    const avecSociete = async (champs, rappel) => {
      const precedente = await prisma.companySettings.findUniqueOrThrow({ where: { id: 'singleton' } });
      await prisma.companySettings.update({ where: { id: 'singleton' }, data: champs });
      try { return await rappel(); } finally {
        const { id: _id, createdAt: _c, updatedAt: _u, ...restaurer } = precedente;
        await prisma.companySettings.update({ where: { id: 'singleton' }, data: restaurer });
      }
    };

    // --- Données ---
    const creerClient = async (raisonSociale) => {
      let client;
      for (let essai = 1; ; essai += 1) {
        const res = await appeler('post', '/clients', { raisonSociale, siren: String(randomInt(100_000_000, 1_000_000_000)) });
        if (res.status === 409 && essai < 5) continue;
        assert.equal(res.status, 201, JSON.stringify(res.body));
        client = res.body;
        break;
      }
      const site = await ok(appeler('post', `/clients/${client.id}/sites`, { nom: 'TEST Facturation 6b1a', adresse: '5 rue de la Facturation', codePostal: '75002', ville: 'Paris', estSiteFacturation: true }), 201);
      return { ...client, siteFacturation: site };
    };
    const creerCompte = (role, cle, extra = {}) => prisma.user.create({ data: { email: `pdf6b1a.${cle}.${suffixe()}@iris.test`, name: `TEST ${cle} 6b1a`, role, ...extra } });
    const creerDevis = (clientId, objet) => ok(appeler('post', '/devis', { clientId, objet, lignes: [{ designation: `TEST Ligne ${objet}`, nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }), 201);
    const statutDevis = (id, statut) => ok(appeler('put', `/devis/${id}/statut`, { statut }));
    const signerDevis = (id) => ok(appeler('post', `/devis/${id}/signature`, { signataire: 'TEST Signataire 6b1a', confirme: true }), 201);
    const creerIntervention = (donnees, auth = admin()) => ok(appeler('post', '/interventions', donnees, auth), 201);
    const changerStatut = (id, statut, extra = {}) => ok(appeler('patch', `/interventions/${id}/statut`, { statut, ...extra }));
    const demarrer = async (id) => {
      const { statut } = await prisma.intervention.findUniqueOrThrow({ where: { id }, select: { statut: true } });
      if (statut === 'A_PLANIFIER') await changerStatut(id, 'PLANIFIEE');
      await changerStatut(id, 'EN_COURS');
    };
    const planifier = (id, intervenantIds) => ok(appeler('put', `/interventions/${id}/planning`, { dateDebut: new Date().toISOString().slice(0, 10), creneau: 'JOURNEE', intervenantIds }));
    const ajouterCompteRendu = (id, contenu, auth = admin()) => ok(appeler('post', `/interventions/${id}/rapports`, { contenu, cleEnvoi: randomUUID() }, auth), 201);
    const aujourdhui = () => jour(new Date(), 'Europe/Paris');
    const creerBrouillonFacture = (clientId, lignes, motif) => ok(appeler('post', '/factures', {
      clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: motif, dateEmission: aujourdhui(), dateEcheance: aujourdhui(), lignes,
    }), 201);
    const emettre = (id) => ok(appeler('post', `/factures/${id}/emettre`));

    // Paramétrage comptable et mentions légales publiées, pour émettre de vraies factures (mêmes prérequis que
    // rapport-chantier-pdf.test.mjs).
    const parametrerFacturation = async () => {
      const compte = (code, libelle, nature) => ok(appeler('post', '/comptabilite/comptes', { code, libelle, nature }), 201);
      const clients = await compte('411000', 'TEST Clients 6b1a', 'ACTIF');
      const prestations = await compte('706000', 'TEST Prestations 6b1a', 'PRODUIT');
      const articles = await compte('707000', 'TEST Articles 6b1a', 'PRODUIT');
      const tva = await compte('445710', 'TEST TVA collectée 6b1a', 'TVA');
      const motif = 'TEST paramétrage comptable 6b1a';
      for (const [cle, donnees] of [['CLIENT', { compteId: clients.id }], ['VENTE_PRESTATION', { compteId: prestations.id }], ['VENTE_ARTICLE', { compteId: articles.id }], ['JOURNAL_VENTES', { journal: 'VE' }]]) {
        const res = await appeler('put', `/comptabilite/regles/${cle}`, { ...donnees, motif });
        assert.ok(res.status >= 200 && res.status < 300, JSON.stringify(res.body));
      }
      const res = await appeler('put', '/comptabilite/tva/20', { compteId: tva.id, motif });
      assert.ok(res.status >= 200 && res.status < 300, JSON.stringify(res.body));
      const version = await ok(appeler('post', '/mentions-legales', { mentions: 'TEST mentions 6b1a v1', cgv: 'TEST CGV 6b1a v1', penalites: 'TEST pénalités 6b1a v1' }), 201);
      await ok(appeler('post', `/mentions-legales/${version.version}/publier`));
    };

    // Jeu de données commun, créé une fois (f.*).
    const f = {};

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
      await ok(appeler('put', '/company', SOCIETE));
      await parametrerFacturation();

      // Comptes de chaque type. Le conducteur est titulaire du chantier et rattaché au responsable.
      const c = {};
      c.admin = await creerCompte('ADMIN', 'admin');
      c.adminCommercial = await creerCompte('ADMIN', 'admin-commercial', { estCommercial: true });
      c.commercial = await creerCompte('COMMERCIAL', 'commercial');
      c.assistante = await creerCompte('ASSISTANTE_COMMERCIALE', 'assistante');
      c.comptable = await creerCompte('COMPTABLE', 'comptable');
      c.directeurCommercial = await creerCompte('DIRECTEUR_COMMERCIAL', 'directeur-commercial');
      c.directeur = await creerCompte('DIRECTEUR', 'directeur');
      c.directeurLecteurDevis = await creerCompte('DIRECTEUR', 'directeur-lecteur-devis', { permissions: ['devis:read'] });
      c.directeurTousDroits = await creerCompte('DIRECTEUR', 'directeur-tous-droits', { permissions: TOUS_LES_SCOPES, accesFinance: true });
      c.responsable = await creerCompte('RESPONSABLE', 'responsable');
      c.conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur', { responsableHierarchiqueId: c.responsable.id });
      c.conducteurTiers = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur-tiers');
      c.responsableTiers = await creerCompte('RESPONSABLE', 'responsable-tiers');
      // Un technicien ne reçoit jamais devis:read, même accordé individuellement (DROITS_INTERDITS_TECHNICIEN).
      c.technicienAffecte = await creerCompte('TECHNICIEN', 'technicien-affecte', { permissions: ['devis:read'] });
      c.technicienNonAffecte = await creerCompte('TECHNICIEN', 'technicien-non-affecte');
      c.desactive = await creerCompte('ADMIN', 'admin-desactive', { actif: false });
      f.comptes = c;
      const intervenant = await prisma.intervenant.create({ data: { nom: 'TEST Intervenant affecté 6b1a', role: 'Technicien', tauxHoraireCharge: 50, userId: c.technicienAffecte.id } });

      f.client = await creerClient('TEST Client production 6b1a');

      // Devis : brouillon, signé (copies figées), annulé avant signature, refusé.
      f.devisBrouillon = await creerDevis(f.client.id, 'TEST Devis brouillon 6b1a');
      f.devisSigne = await creerDevis(f.client.id, 'TEST Devis signé 6b1a');
      await statutDevis(f.devisSigne.id, 'ENVOYE');
      await signerDevis(f.devisSigne.id);
      f.devisAnnule = await creerDevis(f.client.id, 'TEST Devis annulé 6b1a');
      await ok(appeler('post', `/devis/${f.devisAnnule.id}/annulation`, { motif: 'TEST motif d’annulation 6b1a' }));
      f.devisRefuse = await creerDevis(f.client.id, 'TEST Devis refusé 6b1a');
      await statutDevis(f.devisRefuse.id, 'ENVOYE');
      await statutDevis(f.devisRefuse.id, 'REFUSE');
      const statuts = await prisma.devis.findMany({ where: { id: { in: [f.devisBrouillon.id, f.devisSigne.id, f.devisAnnule.id, f.devisRefuse.id] } }, select: { id: true, statut: true, signature: { select: { identiteEmetteurId: true } } } });
      const parId = Object.fromEntries(statuts.map((d) => [d.id, d]));
      assert.deepEqual([f.devisBrouillon, f.devisSigne, f.devisAnnule, f.devisRefuse].map((d) => parId[d.id].statut), ['BROUILLON', 'ACCEPTE', 'ANNULE', 'REFUSE']);
      assert.ok(parId[f.devisSigne.id].signature?.identiteEmetteurId, 'le devis signé porte la copie de l’identité');

      // Factures : brouillon ; émise (2 lignes, dont une au demi-centime) ; réglée ; annulée, et son avoir total.
      f.factureBrouillon = await creerBrouillonFacture(f.client.id, [{ designation: 'TEST Brouillon 6b1a', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }], 'TEST facture brouillon 6b1a');
      f.factureEmise = await emettre((await creerBrouillonFacture(f.client.id, [
        { designation: 'TEST Prestation émise 6b1a', quantite: 2, prixUnitaireHt: 125, tauxTva: 20 },
        { designation: 'TEST Fourniture émise 6b1a', quantite: 2.5, prixUnitaireHt: 0.33, tauxTva: 20 },
      ], 'TEST facture émise 6b1a')).id);
      f.factureReglee = await emettre((await creerBrouillonFacture(f.client.id, [{ designation: 'TEST Prestation payée 6b1a', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }], 'TEST facture réglée 6b1a')).id);
      f.factureAnnulee = await emettre((await creerBrouillonFacture(f.client.id, [{ designation: 'TEST Prestation retirée 6b1a', quantite: 1, prixUnitaireHt: 80, tauxTva: 20 }], 'TEST facture annulée 6b1a')).id);

      // Chantier du conducteur ; interventions avec compte rendu, sans compte rendu, annulée avec un compte rendu ;
      // intervention SAV sans chantier créée par le conducteur, avec un compte rendu.
      f.chantier = await prisma.chantier.create({ data: {
        nom: 'TEST Chantier « été » n°1 / production 6b1a', numeroDevis: 'A26-0601', client: f.client.raisonSociale, clientId: f.client.id,
        adresse: '1 rue du Chantier, 14000 Caen', dateDebut: new Date('2026-06-01T00:00:00.000Z'), budgetGlobalVendu: 0, responsableId: c.conducteur.id,
      } });
      f.chantierAnnule = await prisma.chantier.create({ data: {
        nom: 'TEST Chantier annulé 6b1a', client: f.client.raisonSociale, clientId: f.client.id, dateDebut: new Date('2026-06-01T00:00:00.000Z'),
        budgetGlobalVendu: 0, statut: 'ANNULE', annuleLe: new Date(), motifAnnulation: 'TEST motif chantier 6b1a',
      } });
      const nouvelle = async (titre) => {
        const intervention = await creerIntervention({ clientId: f.client.id, chantierId: f.chantier.id, titre });
        await planifier(intervention.id, [intervenant.id]);
        await demarrer(intervention.id);
        return intervention;
      };
      f.avecCompteRendu = await nouvelle('TEST Intervention avec compte rendu 6b1a');
      await ajouterCompteRendu(f.avecCompteRendu.id, 'TEST Compte rendu imprimé 6b1a.', parCompte(c.technicienAffecte));
      f.sansCompteRendu = await nouvelle('TEST Intervention sans compte rendu 6b1a');
      f.interventionAnnulee = await nouvelle('TEST Intervention annulée 6b1a');
      await ajouterCompteRendu(f.interventionAnnulee.id, 'TEST Compte rendu d’une annulée 6b1a.', parCompte(c.technicienAffecte));
      await changerStatut(f.interventionAnnulee.id, 'ANNULEE', { motif: 'TEST motif d’annulation de l’intervention 6b1a' });
      f.savConducteur = await creerIntervention({ clientId: f.client.id, titre: 'TEST SAV du conducteur 6b1a' }, parCompte(c.conducteur));
      await demarrer(f.savConducteur.id);
      await ajouterCompteRendu(f.savConducteur.id, 'TEST Compte rendu du SAV 6b1a.');

      // Contrats : actif, créé directement ; annulé avec son devis d'origine.
      f.contratActif = await ok(appeler('post', '/contrats-maintenance', {
        clientId: f.client.id, titre: 'TEST Contrat « été » n°1 / production 6b1a', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-09-2025',
      }), 201);
      const devisContrat = await creerDevis(f.client.id, 'TEST Devis du contrat annulé 6b1a');
      await statutDevis(devisContrat.id, 'ENVOYE');
      await signerDevis(devisContrat.id);
      f.contratAnnule = await ok(appeler('post', `/devis/${devisContrat.id}/convertir`, { cible: 'CONTRAT', titre: 'TEST Contrat annulé 6b1a', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '20-05-2025' }), 201);
      await ok(appeler('post', `/devis/${devisContrat.id}/annulation`, { motif: 'TEST motif du contrat annulé 6b1a' }));
      assert.equal((await prisma.contratMaintenance.findUniqueOrThrow({ where: { id: f.contratAnnule.id } })).statut, 'ANNULE');

      // Noms de fichiers attendus, relevés sur main : devis « <numéro>-v<version>.pdf », facture et avoir
      // « <numéro>.pdf », compte rendu « Compte-rendu-<référence>.pdf », contrat « Contrat-<intitulé réduit>.pdf »,
      // rapport « Rapport-chantier-<nom réduit>.pdf » (accents retirés, toute autre suite réduite à un tiret).
      f.noms = {
        devisBrouillon: `${f.devisBrouillon.numero}-v1.pdf`, devisSigne: `${f.devisSigne.numero}-v1.pdf`,
        devisAnnule: `${f.devisAnnule.numero}-v1.pdf`, devisRefuse: `${f.devisRefuse.numero}-v1.pdf`,
        factureEmise: `${f.factureEmise.numero}.pdf`, factureReglee: `${f.factureReglee.numero}.pdf`, factureAnnulee: `${f.factureAnnulee.numero}.pdf`,
        avecCompteRendu: `Compte-rendu-${f.avecCompteRendu.reference}.pdf`, savConducteur: `Compte-rendu-${f.savConducteur.reference}.pdf`,
        contratActif: 'Contrat-TEST-Contrat-ete-n-1-production-6b1a.pdf', contratAnnule: 'Contrat-TEST-Contrat-annule-6b1a.pdf',
        chantier: 'Rapport-chantier-TEST-Chantier-ete-n-1-production-6b1a.pdf', chantierAnnule: 'Rapport-chantier-TEST-Chantier-annule-6b1a.pdf',
      };
    });

    after(async () => {
      await prisma?.$disconnect().catch(() => {});
      await appPrisma?.$disconnect().catch(() => {});
      if (baseCreee) await administrationPg.query(`DROP DATABASE IF EXISTS "${nomBase}" WITH (FORCE)`);
      await administrationPg.end().catch(() => {});
    });

    // Cadrage 6b-1a : « Les PDF, les en-têtes et les refus restent identiques ». Relevé sur main : Content-Type
    // « application/pdf » sans jeu de caractères, Content-Disposition « inline » avec le nom du document,
    // Content-Length égal au corps ; aucun autre nom de fichier ni « attachment ».
    test('en-têtes de chaque PDF : application/pdf, « inline » avec le nom du document, longueur égale au corps ; rien n’est écrit', async () => {
      const documents = [
        ['devis brouillon', CHEMINS.devis(f.devisBrouillon.id), f.noms.devisBrouillon],
        ['devis signé', CHEMINS.devis(f.devisSigne.id), f.noms.devisSigne],
        ['devis annulé', CHEMINS.devis(f.devisAnnule.id), f.noms.devisAnnule],
        ['devis refusé', CHEMINS.devis(f.devisRefuse.id), f.noms.devisRefuse],
        ['facture émise', CHEMINS.facture(f.factureEmise.id), f.noms.factureEmise],
        ['facture réglée (encore émise ici)', CHEMINS.facture(f.factureReglee.id), f.noms.factureReglee],
        ['compte rendu', CHEMINS.compteRendu(f.avecCompteRendu.id), f.noms.avecCompteRendu],
        ['compte rendu du SAV', CHEMINS.compteRendu(f.savConducteur.id), f.noms.savConducteur],
        ['contrat actif', CHEMINS.contrat(f.contratActif.id), f.noms.contratActif],
        ['contrat annulé', CHEMINS.contrat(f.contratAnnule.id), f.noms.contratAnnule],
        ['rapport de chantier', CHEMINS.chantier(f.chantier.id), f.noms.chantier],
        ['rapport d’un chantier annulé', CHEMINS.chantier(f.chantierAnnule.id), f.noms.chantierAnnule],
      ];
      const avant = await etatBase();
      for (const [libelle, chemin, nom] of documents) verifierPdf(await lire(chemin), nom, libelle);
      assert.deepEqual(await etatBase(), avant, 'imprimer n’écrit rien');
      // Révision d'un devis signé : même numéro, le nom porte sa version.
      const revision = await ok(appeler('post', `/devis/${f.devisSigne.id}/revisions`), 201);
      assert.deepEqual([revision.numero, revision.version], [f.devisSigne.numero, 2]);
      verifierPdf(await lire(CHEMINS.devis(revision.id)), `${f.devisSigne.numero}-v2.pdf`, 'révision du devis');
    });

    // Cadrage 6b-1b, « Tests » : le PDF envoyé sera « identique à celui de la route « PDF », hors CreationDate et
    // /ID ». Relevé sur main : deux tirages d'un même document ne diffèrent que par ces deux champs.
    test('un même document tiré deux fois donne le même PDF, hors date de création et identifiant de fichier ; deux documents différents diffèrent', async () => {
      const chemins = [
        CHEMINS.devis(f.devisBrouillon.id), CHEMINS.devis(f.devisSigne.id), CHEMINS.facture(f.factureEmise.id),
        CHEMINS.compteRendu(f.avecCompteRendu.id), CHEMINS.contrat(f.contratActif.id), CHEMINS.chantier(f.chantier.id),
      ];
      const normalises = [];
      for (const chemin of chemins) {
        const premier = await lire(chemin);
        const second = await lire(chemin);
        assert.equal(premier.status, 200, chemin);
        assert.equal(second.status, 200, chemin);
        assert.equal(normaliser(premier.body), normaliser(second.body), `${chemin} : deux tirages identiques hors CreationDate et /ID`);
        normalises.push(normaliser(premier.body));
      }
      assert.equal(new Set(normalises).size, chemins.length, 'chaque document a son propre PDF');
    });

    // P1 et P3 : sans session, ou avec une session refusée, chaque route répond 401 avant tout autre contrôle,
    // document existant ou non. Une clé d'intégration n'ouvre aucune de ces routes (401), et aucune route /api/v1
    // ne sert un PDF (404).
    test('sans session valide : 401 exact sur les cinq routes, avant tout droit et tout document ; aucune clé d’intégration ni route /api/v1', async () => {
      const cle = await ok(appeler('post', '/admin/api-keys', { nom: 'TEST clé 6b1a', scopes: TOUS_LES_SCOPES }), 201);
      const parCle = entete(cle.apiKey);
      assert.equal((await request(app).get('/api/v1/clients').set(parCle)).status, 200, 'la clé est valide');
      const existants = {
        devis: f.devisBrouillon.id, facture: f.factureEmise.id, compteRendu: f.avecCompteRendu.id, contrat: f.contratActif.id, chantier: f.chantier.id,
      };
      const avant = await etatBase();
      for (const [route, id] of Object.entries(existants)) {
        for (const cibleId of [id, randomUUID()]) {
          const contexte = `${route}, ${cibleId === id ? 'existant' : 'introuvable'}`;
          verifierRefus(await lire(CHEMINS[route](cibleId), null), 401, SANS_SESSION, `${contexte}, sans en-tête`);
          verifierRefus(await lire(CHEMINS[route](cibleId), { Authorization: `Basic ${Buffer.from('a:b').toString('base64')}` }), 401, SANS_SESSION, `${contexte}, autre schéma`);
          verifierRefus(await lire(CHEMINS[route](cibleId), entete('jeton-invalide')), 401, SESSION_INVALIDE, `${contexte}, jeton invalide`);
          verifierRefus(await lire(CHEMINS[route](cibleId), entete(jwt.sign({ id: randomUUID() }, process.env.JWT_SECRET))), 401, COMPTE_INCONNU, `${contexte}, compte inconnu`);
          verifierRefus(await lire(CHEMINS[route](cibleId), parCompte(f.comptes.desactive)), 401, COMPTE_DESACTIVE, `${contexte}, compte désactivé`);
          verifierRefus(await lire(CHEMINS[route](cibleId), parCle), 401, SESSION_INVALIDE, `${contexte}, clé d’intégration`);
        }
      }
      assert.deepEqual(await etatBase(), avant, 'aucun refus n’écrit rien');
      for (const [route, id] of Object.entries(existants)) {
        assert.equal((await lire(CHEMINS[route](id).replace('/api/', '/api/v1/'), parCle)).status, 404, `${route} : aucune route /api/v1`);
      }
    });

    // P1 et P3 : la route du devis garde requirePermission('devis:read') (403 « Permission requise : devis:read »,
    // avant tout document), puis 404 « Devis introuvable. » ; aucun périmètre (tout porteur du droit imprime tout
    // devis) ; un devis annulé ou refusé s'imprime.
    test('devis : porteurs de devis:read seulement, 403 exact avant tout document ; 404 « Devis introuvable. » ; annulé et refusé s’impriment', async () => {
      const c = f.comptes;
      const cibles = [['devisBrouillon', f.devisBrouillon.id], ['devisSigne', f.devisSigne.id], ['devisAnnule', f.devisAnnule.id], ['devisRefuse', f.devisRefuse.id], ['introuvable', randomUUID()], ['identifiant libre', 'inexistant'], ['identifiant d’une facture', f.factureEmise.id]];
      const lecteur = [200, 200, 200, 200, [404, DEVIS_INTROUVABLE], [404, DEVIS_INTROUVABLE], [404, DEVIS_INTROUVABLE]];
      const refuse = Array(cibles.length).fill([403, REFUS_DEVIS_READ]);
      await jouerMatrice('devis', cibles, [
        ['SUPERADMIN', admin(), lecteur],
        ['ADMIN', parCompte(c.admin), lecteur],
        ['ADMIN commercial', parCompte(c.adminCommercial), lecteur],
        ['COMMERCIAL (aucun des devis n’est le sien)', parCompte(c.commercial), lecteur],
        ['ASSISTANTE_COMMERCIALE', parCompte(c.assistante), lecteur],
        ['COMPTABLE', parCompte(c.comptable), lecteur],
        ['DIRECTEUR_COMMERCIAL', parCompte(c.directeurCommercial), lecteur],
        ['DIRECTEUR avec devis:read', parCompte(c.directeurLecteurDevis), lecteur],
        ['DIRECTEUR avec tous les droits', parCompte(c.directeurTousDroits), lecteur],
        ['DIRECTEUR', parCompte(c.directeur), refuse],
        ['CONDUCTEUR_TRAVAUX', parCompte(c.conducteur), refuse],
        ['RESPONSABLE', parCompte(c.responsable), refuse],
        ['TECHNICIEN avec devis:read accordé', parCompte(c.technicienAffecte), refuse],
        ['TECHNICIEN', parCompte(c.technicienNonAffecte), refuse],
      ], f.noms);
    });

    // P3 : identité incomplète, 409 « … avant d’imprimer un devis. » pour un devis imprimé avec l'identité actuelle
    // (non signé, annulé ou refusé avant signature) ; un devis signé s'imprime depuis sa copie ; l'ordre reste 401,
    // 403, 404, puis l'identité.
    test('devis, identité de la société incomplète : 409 exact sauf pour le devis signé, imprimé depuis sa copie ; 404 et 403 passent avant', async () => {
      await avecSociete({ siret: '', ville: '  ' }, async () => {
        const incomplete = [409, identiteIncomplete('SIRET, ville', AVANT.devis)];
        await jouerMatrice('devis', [['devisBrouillon', f.devisBrouillon.id], ['devisSigne', f.devisSigne.id], ['devisAnnule', f.devisAnnule.id], ['devisRefuse', f.devisRefuse.id], ['introuvable', randomUUID()]], [
          ['SUPERADMIN', admin(), [incomplete, 200, incomplete, incomplete, [404, DEVIS_INTROUVABLE]]],
          ['COMMERCIAL', parCompte(f.comptes.commercial), [incomplete, 200, incomplete, incomplete, [404, DEVIS_INTROUVABLE]]],
          ['TECHNICIEN', parCompte(f.comptes.technicienNonAffecte), Array(5).fill([403, REFUS_DEVIS_READ])],
        ], f.noms);
        verifierRefus(await lire(CHEMINS.devis(f.devisBrouillon.id), null), 401, SANS_SESSION, 'sans session, identité incomplète');
      });
      await avecSociete({ raisonSociale: '', siret: '', adresse: '', codePostal: '', ville: '' }, async () => {
        verifierRefus(await lire(CHEMINS.devis(f.devisBrouillon.id)), 409, identiteIncomplete('raison sociale, SIRET, adresse, code postal, ville', AVANT.devis), 'aucun champ');
      });
    });

    // P1 et P3 : la route de la facture garde requireAdmin (403 « Accès réservé aux administrateurs », avant tout
    // document), puis 404 « Facture introuvable. », puis refusDocumentFacture. Une pièce émise s'imprime depuis ses
    // copies : une identité actuelle incomplète ne la refuse pas.
    test('facture : administration seule, 403 exact avant tout document ; 404 « Facture introuvable. » ; brouillon refusé ; identité actuelle sans effet', async () => {
      const c = f.comptes;
      const cibles = [['factureEmise', f.factureEmise.id], ['brouillon', f.factureBrouillon.id], ['introuvable', randomUUID()], ['identifiant libre', 'inexistant'], ['identifiant d’un devis', f.devisBrouillon.id]];
      const administration = [200, [409, FACTURE_NON_EMISE], [404, FACTURE_INTROUVABLE], [404, FACTURE_INTROUVABLE], [404, FACTURE_INTROUVABLE]];
      const refuse = Array(cibles.length).fill([403, REFUS_ADMINISTRATION]);
      const matrice = [
        ['SUPERADMIN', admin(), administration],
        ['ADMIN', parCompte(c.admin), administration],
        ['ADMIN commercial', parCompte(c.adminCommercial), administration],
        ...['commercial', 'assistante', 'comptable', 'directeurCommercial', 'directeur', 'directeurTousDroits', 'conducteur', 'responsable', 'technicienAffecte'].map((cle) => [cle, parCompte(c[cle]), refuse]),
      ];
      await jouerMatrice('facture', cibles, matrice, f.noms);
      // Identité de la société vidée : la facture émise s'imprime toujours, les refus restent les mêmes.
      await avecSociete({ raisonSociale: '', siret: '', adresse: '', codePostal: '', ville: '' }, () => jouerMatrice('facture', cibles, matrice, f.noms));
    });

    // P3, ordre de refusDocumentFacture : statut, puis mentions légales figées, puis adresse de facturation figée.
    // Une pièce émise sans mentions ou sans adresse (antérieure à leur gel) est fabriquée en base, comme dans
    // api.test.mjs (« refuse le document PDF d’une facture antérieure au gel de l’adresse »).
    test('facture : ordre des refus du document — non émise, puis sans mentions figées, puis sans adresse figée', async () => {
      const brouillonEnBase = await prisma.facture.findUniqueOrThrow({ where: { id: f.factureBrouillon.id } });
      // Le brouillon n'a ni mentions ni adresse figées : seul le premier refus, celui du statut, est rendu.
      assert.deepEqual([brouillonEnBase.statut, brouillonEnBase.mentionsLegalesVersionId, brouillonEnBase.clientAdresse], ['BROUILLON', null, null]);
      const mentions = await prisma.mentionsLegalesVersion.findFirstOrThrow({ where: { actif: true, publieeLe: { not: null } }, select: { id: true } });
      const identiteEmetteurId = (await prisma.facture.findUniqueOrThrow({ where: { id: f.factureEmise.id } })).identiteEmetteurId;
      const fabriquer = async (libelle, { avecMentions, avecAdresse }) => {
        const brouillon = await creerBrouillonFacture(f.client.id, [{ designation: `TEST ${libelle}`, quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }], `TEST ${libelle}`);
        await prisma.$transaction(async (tx) => {
          await tx.facture.update({ where: { id: brouillon.id }, data: {
            statut: 'EMISE', annee: 2026, numero: `TEST-6B1A-${suffixe()}`, emisLe: new Date(), identiteEmetteurId,
            mentionsLegalesVersionId: avecMentions ? mentions.id : null, clientAdresse: avecAdresse ? '5 rue de la Facturation\n75002 Paris' : null,
          } });
          const regles = new Map((await tx.regleComptable.findMany({ include: { compte: true } })).map((r) => [r.cle, r]));
          const tva = await tx.regleTvaComptable.findUniqueOrThrow({ where: { taux: 20 }, include: { compte: true } });
          const journalCode = regles.get('JOURNAL_VENTES').journal;
          const ecritures = [['CLIENT', regles.get('CLIENT').compte, 12, 0], ['VENTE_PRESTATION', regles.get('VENTE_PRESTATION').compte, 0, 10], ['TVA:20', tva.compte, 0, 2]];
          await tx.ecritureFacture.createMany({ data: ecritures.map(([cle, compte, debit, credit], ordre) => ({ factureId: brouillon.id, ordre, cle, tauxTva: cle === 'TVA:20' ? 20 : null, journalCode, compteNum: compte.code, compteLib: compte.libelle, debit, credit })) });
          await tx.facture.update({ where: { id: brouillon.id }, data: { ecrituresScellees: true } });
        });
        const enBase = await prisma.facture.findUniqueOrThrow({ where: { id: brouillon.id } });
        assert.deepEqual([enBase.statut, enBase.mentionsLegalesVersionId !== null, enBase.clientAdresse !== null], ['EMISE', avecMentions, avecAdresse], libelle);
        return enBase;
      };
      const sansRien = await fabriquer('émise sans mentions ni adresse 6b1a', { avecMentions: false, avecAdresse: false });
      const sansMentions = await fabriquer('émise sans mentions 6b1a', { avecMentions: false, avecAdresse: true });
      const sansAdresse = await fabriquer('émise sans adresse 6b1a', { avecMentions: true, avecAdresse: false });
      const cibles = [['brouillon', f.factureBrouillon.id], ['sansRien', sansRien.id], ['sansMentions', sansMentions.id], ['sansAdresse', sansAdresse.id]];
      const attendus = [[409, FACTURE_NON_EMISE], [409, FACTURE_SANS_MENTIONS], [409, FACTURE_SANS_MENTIONS], [409, FACTURE_SANS_ADRESSE]];
      await jouerMatrice('facture', cibles, [
        ['SUPERADMIN', admin(), attendus],
        ['ADMIN', parCompte(f.comptes.admin), attendus],
        // requireAdmin passe avant le document : un non-administrateur reçoit 403, jamais le refus du document.
        ['COMPTABLE', parCompte(f.comptes.comptable), Array(4).fill([403, REFUS_ADMINISTRATION])],
      ], f.noms);
    });

    // P2 : « la pièce émise est figée ». Chaque pièce s'imprime sous son propre numéro, avec ses propres montants
    // et sa mention (aucune pour une pièce émise, « Facture réglée. », « FACTURE ANNULÉE — … ») ; un avoir porte
    // « AVOIR » et sa facture d'origine. Le PDF d'une pièce émise ne bouge pas, octet pour octet hors CreationDate
    // et /ID, quand la société, le client, son adresse ou les mentions légales changent, ou qu'un avoir partiel
    // la crédite.
    //
    // Montants : la facture émise (301,00 € TTC), la réglée (120,00 €), l'annulée (96,00 €) et l'avoir partiel
    // (48,00 €) ont des totaux distincts ; un PDF qui imprimerait la facture d'origine à la place de son avoir partiel,
    // ou une autre pièce, en diffère. L'avoir total a les mêmes montants que la facture annulée qu'il crédite (96,00 €) :
    // son titre « AVOIR » et son numéro les départagent. La ligne 2,5 × 0,33 € = 0,825 € s'imprime 0,83 € (arrondi commercial, à l'émission) : un PDF qui
    // recalculerait au demi-centime pair ou tronquerait imprimerait 0,82 € et un total de 250,82 €.
    test('facture, avoir : chaque pièce imprime son numéro, ses montants figés et sa mention ; le PDF émis ne bouge pas après l’émission', async () => {
      const lirePiece = async (piece) => {
        const res = await lire(CHEMINS.facture(piece.id));
        verifierPdf(res, `${piece.numero}.pdf`, piece.numero);
        const texte = await texteDuPdf(res.body);
        return { octets: res.body, texte, plat: aplatir(texte) };
      };
      const numeros = () => [f.factureEmise, f.factureReglee, f.factureAnnulee].map((piece) => piece.numero);
      const verifierSeulNumero = (plat, numero, autres) => {
        for (const autre of autres.filter((n) => n !== numero)) assert.ok(!plat.includes(autre), `${numero} : le PDF imprime aussi ${autre}\n${plat}`);
      };

      // Facture émise : numéro, montants et absence de mention.
      assert.deepEqual([f.factureEmise.statut, f.factureEmise.totalHt, f.factureEmise.totalTva, f.factureEmise.totalTtc], ['EMISE', 250.83, 50.17, 301]);
      const emise = await lirePiece(f.factureEmise);
      for (const attendu of [
        `FACTURE ${f.factureEmise.numero}`, `Émise le ${aujourdhui()} · Échéance : ${aujourdhui()}`, 'Client', f.client.raisonSociale, '5 rue de la Facturation', '75002 Paris',
        'TEST Prestation émise 6b1a', '125,00 €', '250,00 €', 'TEST Fourniture émise 6b1a', '2.5', '0,33 €', '0,83 €',
        'Total HT : 250,83 €', 'TVA 20 % sur 250,83 € : 50,17 €', 'TVA totale : 50,17 €', 'Total TTC : 301,00 €',
        'Mentions légales et CGV — version 1', 'TEST mentions 6b1a v1', 'TEST CGV 6b1a v1', 'Pénalités : TEST pénalités 6b1a v1',
        SOCIETE.raisonSociale, `SIRET ${SOCIETE.siret}`, SOCIETE.piedFacture,
      ]) assert.ok(emise.plat.includes(attendu), `facture émise : absent du PDF « ${attendu} »\n${emise.texte}`);
      assert.doesNotMatch(emise.plat, /ANNUL|réglée|AVOIR|Facture d’origine|0,82 €|250,82 €/u, emise.texte);
      verifierSeulNumero(emise.plat, f.factureEmise.numero, numeros());

      // Figée : société, client, adresse de facturation et mentions changés, avoir partiel émis ; même PDF.
      const avantChangements = normaliser(emise.octets);
      const nouvellesMentions = await ok(appeler('post', '/mentions-legales', { mentions: 'TEST mentions 6b1a v2', cgv: 'TEST CGV 6b1a v2', penalites: 'TEST pénalités 6b1a v2' }), 201);
      await ok(appeler('post', `/mentions-legales/${nouvellesMentions.version}/publier`));
      await ok(appeler('put', `/clients/${f.client.id}`, { raisonSociale: 'TEST Client renommé après émission 6b1a' }));
      await prisma.clientSite.update({ where: { id: f.client.siteFacturation.id }, data: { adresse: '99 avenue du Déménagement', codePostal: '13001', ville: 'Marseille' } });
      try {
        const avoirPartiel = await ok(appeler('post', `/factures/${f.factureEmise.id}/avoirs`, { lignes: [{ designation: 'TEST Geste commercial 6b1a', quantite: 1, prixUnitaireHt: 40, tauxTva: 20 }] }), 201);
        await avecSociete(SOCIETE_CHANGEE, async () => {
          const relue = await lirePiece(f.factureEmise);
          assert.equal(normaliser(relue.octets), avantChangements, 'le PDF de la facture émise ne bouge pas après son émission');
          // Avoir partiel : créé sous la société d'origine, il imprime sa copie, ses montants et sa facture d'origine.
          assert.deepEqual([avoirPartiel.type, avoirPartiel.statut, avoirPartiel.totalHt, avoirPartiel.totalTva, avoirPartiel.totalTtc], ['AVOIR', 'EMISE', 40, 8, 48]);
          const avoir = await lirePiece(avoirPartiel);
          for (const attendu of [
            `AVOIR ${avoirPartiel.numero}`, `Facture d’origine : ${f.factureEmise.numero}`, 'TEST Geste commercial 6b1a',
            'Total HT : 40,00 €', 'TVA 20 % sur 40,00 € : 8,00 €', 'TVA totale : 8,00 €', 'Total TTC : 48,00 €', SOCIETE.raisonSociale,
          ]) assert.ok(avoir.plat.includes(attendu), `avoir partiel : absent du PDF « ${attendu} »\n${avoir.texte}`);
          assert.doesNotMatch(avoir.plat, /FACTURE \S+-|Total TTC : 301,00 €|TEST Prestation émise|TEST Société changée|ANNUL|réglée/u, avoir.texte);
        });
      } finally {
        await ok(appeler('put', `/clients/${f.client.id}`, { raisonSociale: f.client.raisonSociale }));
        await prisma.clientSite.update({ where: { id: f.client.siteFacturation.id }, data: { adresse: '5 rue de la Facturation', codePostal: '75002', ville: 'Paris' } });
      }

      // Facture réglée : même document, plus la seule mention « Facture réglée. ».
      const avantReglement = await lirePiece(f.factureReglee);
      assert.doesNotMatch(avantReglement.plat, /réglée|ANNUL/u);
      await ok(appeler('post', '/reglements', { clientId: f.client.id, dateReglement: aujourdhui(), montant: 120, moyen: 'VIREMENT', affectations: [{ factureId: f.factureReglee.id, montant: 120 }] }), 201);
      assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: f.factureReglee.id } })).statut, 'REGLEE');
      const reglee = await lirePiece(f.factureReglee);
      assert.ok(reglee.plat.includes(`FACTURE ${f.factureReglee.numero}`) && reglee.plat.includes('Facture réglée.'), reglee.texte);
      assert.equal(reglee.plat.replace(' Facture réglée.', ''), avantReglement.plat, 'la réglée ne diffère de l’émise que par sa mention');
      for (const attendu of ['Total HT : 100,00 €', 'TVA 20 % sur 100,00 € : 20,00 €', 'Total TTC : 120,00 €']) assert.ok(reglee.plat.includes(attendu), `${attendu}\n${reglee.texte}`);
      assert.doesNotMatch(reglee.plat, /ANNUL|AVOIR/u);
      verifierSeulNumero(reglee.plat, f.factureReglee.numero, numeros());

      // Facture annulée : même document, plus la mention d'annulation ; son avoir total porte ses montants.
      const avantAnnulation = await lirePiece(f.factureAnnulee);
      const annulation = await ok(appeler('post', `/factures/${f.factureAnnulee.id}/annuler`));
      assert.equal(annulation.statut, 'ANNULEE');
      const annulee = await lirePiece(f.factureAnnulee);
      const MENTION_ANNULEE = 'FACTURE ANNULÉE — ce document ne vaut pas justificatif de créance.';
      assert.ok(annulee.plat.includes(`FACTURE ${f.factureAnnulee.numero}`) && annulee.plat.includes(MENTION_ANNULEE), annulee.texte);
      assert.equal(annulee.plat.replace(` ${MENTION_ANNULEE}`, ''), avantAnnulation.plat, 'l’annulée ne diffère de l’émise que par sa mention');
      for (const attendu of ['Total HT : 80,00 €', 'TVA 20 % sur 80,00 € : 16,00 €', 'Total TTC : 96,00 €']) assert.ok(annulee.plat.includes(attendu), `${attendu}\n${annulee.texte}`);
      assert.doesNotMatch(annulee.plat, /réglée|AVOIR/u);
      verifierSeulNumero(annulee.plat, f.factureAnnulee.numero, numeros());
      const avoirTotal = annulation.avoir;
      assert.deepEqual([avoirTotal.type, avoirTotal.factureOrigineId, avoirTotal.totalHt, avoirTotal.totalTva, avoirTotal.totalTtc], ['AVOIR', f.factureAnnulee.id, 80, 16, 96]);
      const avoir = await lirePiece(avoirTotal);
      for (const attendu of [`AVOIR ${avoirTotal.numero}`, `Facture d’origine : ${f.factureAnnulee.numero}`, 'Total HT : 80,00 €', 'Total TTC : 96,00 €']) {
        assert.ok(avoir.plat.includes(attendu), `avoir total : absent du PDF « ${attendu} »\n${avoir.texte}`);
      }
      assert.doesNotMatch(avoir.plat, /ANNULÉE|réglée|FACTURE \S+-/u, avoir.texte);
      // Le PDF d'une pièce annulée ou réglée est lui aussi le même d'un tirage à l'autre.
      for (const piece of [f.factureReglee, f.factureAnnulee, avoirTotal]) {
        assert.equal(normaliser((await lirePiece(piece)).octets), normaliser((await lirePiece(piece)).octets), piece.numero);
      }
    });

    // Audit n° 1 (auditeur-montants), remarque T1 : une pièce émise imprime ses lignes dans leur ordre figé (`ordre`),
    // chacune avec ses montants, quel que soit l'ordre d'écriture des lignes, de leurs désignations ou de leurs
    // identifiants. Les rangs des lignes du brouillon sont permutés en base avant l'émission : l'ordre d'insertion
    // (A, C, B), l'ordre alphabétique (A, B, C) et l'ordre inverse des rangs (A, B, C) diffèrent tous de l'ordre
    // figé (C, B, A). Une lecture qui ne reprendrait pas le tri de factureInclude imprimerait la facture autrement.
    test('facture émise : lignes imprimées dans leur ordre figé, chacune avec ses montants', async () => {
      const brouillon = await creerBrouillonFacture(f.client.id, [
        { designation: 'TEST Ligne A ordre 6b1a', quantite: 1, prixUnitaireHt: 11, tauxTva: 20 },
        { designation: 'TEST Ligne C ordre 6b1a', quantite: 2, prixUnitaireHt: 33, tauxTva: 20 },
        { designation: 'TEST Ligne B ordre 6b1a', quantite: 3, prixUnitaireHt: 22, tauxTva: 20 },
      ], 'TEST ordre des lignes 6b1a');
      const lignes = await prisma.factureLigne.findMany({ where: { factureId: brouillon.id }, orderBy: { ordre: 'asc' } });
      assert.deepEqual(lignes.map((ligne) => ligne.designation), ['TEST Ligne A ordre 6b1a', 'TEST Ligne C ordre 6b1a', 'TEST Ligne B ordre 6b1a']);
      // Rangs figés voulus : C, puis B, puis A (rangs provisoires d'abord, à cause de l'unicité (facture, rang)).
      const rangs = { 'TEST Ligne C ordre 6b1a': 0, 'TEST Ligne B ordre 6b1a': 1, 'TEST Ligne A ordre 6b1a': 2 };
      await prisma.$transaction(async (tx) => {
        for (const [rang, ligne] of lignes.entries()) await tx.factureLigne.update({ where: { id: ligne.id }, data: { ordre: 100 + rang } });
        for (const ligne of lignes) await tx.factureLigne.update({ where: { id: ligne.id }, data: { ordre: rangs[ligne.designation] } });
      });
      const emise = await emettre(brouillon.id);
      assert.deepEqual([emise.statut, emise.totalHt, emise.totalTva, emise.totalTtc], ['EMISE', 143, 28.6, 171.6]);
      const res = await lire(CHEMINS.facture(emise.id));
      verifierPdf(res, `${emise.numero}.pdf`, 'facture aux lignes permutées');
      const plat = aplatir(await texteDuPdf(res.body));
      const positions = ['C', 'B', 'A'].map((lettre) => plat.indexOf(`TEST Ligne ${lettre} ordre 6b1a`));
      assert.ok(positions.every((position) => position >= 0), plat);
      assert.deepEqual([...positions].sort((x, y) => x - y), positions, `lignes hors de leur ordre figé (C, B, A)\n${plat}`);
      // Chaque ligne garde ses montants, dans le même ordre : 66,00 € (C), 66,00 € (B), 11,00 € (A) en total HT, et ses
      // prix unitaires 33,00 €, 22,00 €, 11,00 €.
      const prix = ['33,00 €', '22,00 €', '11,00 €'].map((montant) => plat.indexOf(montant));
      assert.ok(prix.every((position, rang) => position > positions[rang] && (rang === 2 || position < positions[rang + 1])), `prix unitaires hors de leur ligne\n${plat}`);
      for (const attendu of ['Total HT : 143,00 €', 'TVA 20 % sur 143,00 € : 28,60 €', 'Total TTC : 171,60 €']) assert.ok(plat.includes(attendu), `${attendu}\n${plat}`);
    });

    // P1 et P3 : la route du compte rendu garde blockCommercial (commercial, directeur), puis le refus du technicien,
    // avant tout périmètre ; puis getInterventionFilterForUser et l'exclusion des annulées (404 « Intervention
    // introuvable. ») ; puis 409 « Aucun compte rendu à imprimer. ».
    test('compte rendu : 403 exacts du commercial, du directeur et du technicien avant tout périmètre ; périmètre et annulées en 404 exact ; 409 sans compte rendu', async () => {
      const c = f.comptes;
      const cibles = [['avecCompteRendu', f.avecCompteRendu.id], ['sansCompteRendu', f.sansCompteRendu.id], ['annulee', f.interventionAnnulee.id], ['savConducteur', f.savConducteur.id], ['introuvable', randomUUID()], ['identifiant d’un chantier', f.chantier.id]];
      const introuvable = [404, INTERVENTION_INTROUVABLE];
      const toutVu = [200, [409, AUCUN_COMPTE_RENDU], introuvable, 200, introuvable, introuvable];
      const rien = Array(cibles.length).fill(introuvable);
      await jouerMatrice('compteRendu', cibles, [
        ['SUPERADMIN', admin(), toutVu],
        ['ADMIN', parCompte(c.admin), toutVu],
        ['ADMIN commercial', parCompte(c.adminCommercial), toutVu],
        // Titulaire du chantier et créateur du SAV.
        ['CONDUCTEUR_TRAVAUX titulaire', parCompte(c.conducteur), toutVu],
        // Responsable du titulaire : le chantier de sa branche, pas le SAV créé par le conducteur.
        ['RESPONSABLE du titulaire', parCompte(c.responsable), [200, [409, AUCUN_COMPTE_RENDU], introuvable, introuvable, introuvable, introuvable]],
        ['CONDUCTEUR_TRAVAUX tiers', parCompte(c.conducteurTiers), rien],
        ['RESPONSABLE tiers', parCompte(c.responsableTiers), rien],
        ['DIRECTEUR_COMMERCIAL', parCompte(c.directeurCommercial), rien],
        ['ASSISTANTE_COMMERCIALE', parCompte(c.assistante), rien],
        ['COMPTABLE', parCompte(c.comptable), rien],
        ['COMMERCIAL', parCompte(c.commercial), Array(cibles.length).fill([403, REFUS_COMMERCIAL])],
        ['DIRECTEUR', parCompte(c.directeur), Array(cibles.length).fill([403, REFUS_DIRECTEUR])],
        ['DIRECTEUR avec tous les droits', parCompte(c.directeurTousDroits), Array(cibles.length).fill([403, REFUS_DIRECTEUR])],
        ['TECHNICIEN affecté', parCompte(c.technicienAffecte), Array(cibles.length).fill([403, REFUS_TECHNICIEN])],
        ['TECHNICIEN non affecté', parCompte(c.technicienNonAffecte), Array(cibles.length).fill([403, REFUS_TECHNICIEN])],
      ], f.noms);
      // Le technicien affecté lit la fiche de l'intervention : le refus du PDF est propre à sa route.
      assert.equal((await appeler('get', `/interventions/${f.avecCompteRendu.id}`, null, parCompte(c.technicienAffecte))).status, 200);
    });

    // P3, ordre : périmètre et annulation (404), puis absence de compte rendu (409), puis identité (409
    // « … avant d’imprimer un compte rendu. ») ; les 403 passent avant.
    test('compte rendu, identité de la société incomplète : 409 exact après le périmètre, l’annulation et l’absence de compte rendu', async () => {
      const c = f.comptes;
      await avecSociete({ siret: '', ville: '' }, async () => {
        const incomplete = [409, identiteIncomplete('SIRET, ville', AVANT.compteRendu)];
        const introuvable = [404, INTERVENTION_INTROUVABLE];
        await jouerMatrice('compteRendu', [['avecCompteRendu', f.avecCompteRendu.id], ['sansCompteRendu', f.sansCompteRendu.id], ['annulee', f.interventionAnnulee.id], ['introuvable', randomUUID()]], [
          ['SUPERADMIN', admin(), [incomplete, [409, AUCUN_COMPTE_RENDU], introuvable, introuvable]],
          ['CONDUCTEUR_TRAVAUX titulaire', parCompte(c.conducteur), [incomplete, [409, AUCUN_COMPTE_RENDU], introuvable, introuvable]],
          ['CONDUCTEUR_TRAVAUX tiers', parCompte(c.conducteurTiers), Array(4).fill(introuvable)],
          ['TECHNICIEN affecté', parCompte(c.technicienAffecte), Array(4).fill([403, REFUS_TECHNICIEN])],
          ['COMMERCIAL', parCompte(c.commercial), Array(4).fill([403, REFUS_COMMERCIAL])],
        ], f.noms);
      });
    });

    // P1 et P3 : la route du contrat garde requireAdmin (403 avant tout document), puis 404 « Contrat de maintenance
    // introuvable. », puis l'identité (409 « … avant d’imprimer un contrat. ») ; un contrat annulé s'imprime.
    test('contrat : administration seule, 403 exact avant tout document ; 404 exact ; identité incomplète en 409 exact après le 404 ; annulé imprimé', async () => {
      const c = f.comptes;
      const cibles = [['contratActif', f.contratActif.id], ['contratAnnule', f.contratAnnule.id], ['introuvable', randomUUID()], ['identifiant libre', 'inexistant'], ['identifiant d’une intervention', f.avecCompteRendu.id]];
      const introuvable = [404, CONTRAT_INTROUVABLE];
      const refuse = Array(cibles.length).fill([403, REFUS_ADMINISTRATION]);
      const nonAdministrateurs = ['commercial', 'assistante', 'comptable', 'directeurCommercial', 'directeur', 'directeurTousDroits', 'conducteur', 'responsable', 'technicienAffecte'].map((cle) => [cle, parCompte(c[cle]), refuse]);
      await jouerMatrice('contrat', cibles, [
        ['SUPERADMIN', admin(), [200, 200, introuvable, introuvable, introuvable]],
        ['ADMIN', parCompte(c.admin), [200, 200, introuvable, introuvable, introuvable]],
        ['ADMIN commercial', parCompte(c.adminCommercial), [200, 200, introuvable, introuvable, introuvable]],
        ...nonAdministrateurs,
      ], f.noms);
      await avecSociete({ siret: '', ville: '' }, async () => {
        const incomplete = [409, identiteIncomplete('SIRET, ville', AVANT.contrat)];
        await jouerMatrice('contrat', cibles, [
          ['SUPERADMIN', admin(), [incomplete, incomplete, introuvable, introuvable, introuvable]],
          ...nonAdministrateurs,
        ], f.noms);
      });
    });

    // P1 et P3 : la route du rapport de chantier garde requireAdmin (403 avant tout document), puis 404 « Chantier
    // introuvable » (sans point), puis l'identité (409 « … avant d’imprimer un rapport de chantier. ») ; un chantier
    // annulé s'imprime.
    test('rapport de chantier : administration seule, 403 exact avant tout document ; 404 « Chantier introuvable » sans point ; identité incomplète en 409 exact après le 404', async () => {
      const c = f.comptes;
      const cibles = [['chantier', f.chantier.id], ['chantierAnnule', f.chantierAnnule.id], ['introuvable', randomUUID()], ['identifiant libre', 'inexistant'], ['identifiant d’une intervention', f.avecCompteRendu.id]];
      const introuvable = [404, CHANTIER_INTROUVABLE];
      const refuse = Array(cibles.length).fill([403, REFUS_ADMINISTRATION]);
      // Le titulaire du chantier, son responsable et le technicien qui y intervient restent refusés.
      const nonAdministrateurs = ['commercial', 'assistante', 'comptable', 'directeurCommercial', 'directeur', 'directeurTousDroits', 'conducteur', 'responsable', 'technicienAffecte'].map((cle) => [cle, parCompte(c[cle]), refuse]);
      await jouerMatrice('chantier', cibles, [
        ['SUPERADMIN', admin(), [200, 200, introuvable, introuvable, introuvable]],
        ['ADMIN', parCompte(c.admin), [200, 200, introuvable, introuvable, introuvable]],
        ['ADMIN commercial', parCompte(c.adminCommercial), [200, 200, introuvable, introuvable, introuvable]],
        ...nonAdministrateurs,
      ], f.noms);
      await avecSociete({ siret: '', ville: '' }, async () => {
        const incomplete = [409, identiteIncomplete('SIRET, ville', AVANT.chantier)];
        await jouerMatrice('chantier', cibles, [
          ['SUPERADMIN', admin(), [incomplete, incomplete, introuvable, introuvable, introuvable]],
          ...nonAdministrateurs,
        ], f.noms);
      });
    });

    // P1 et transactions (audit droits-sécurité n° 1 de #405) : produirePdf lit dans la transaction, aux options que
    // lui donne la route, puis rend le PDF une fois la transaction validée : pendant le rendu, le client de la
    // transaction est clos, aucune connexion n'est tenue. Un refus n'appelle pas le rendu. identiteActuelleOuRefus ne
    // change en refus que l'identité incomplète : toute autre erreur remonte, et la route la rend en 500, sans détail.
    test('production commune : lecture dans la transaction, rendu après sa validation ; un refus n’appelle pas le rendu ; seule l’identité incomplète devient un refus', async () => {
      const { produirePdf, refusPdf, identiteActuelleOuRefus } = (await import('../dist/src/domaines/documents/productionPdf.js')).default;
      let clientTransaction; let isolation;
      const produit = await produirePdf(async (tx) => {
        clientTransaction = tx;
        [{ transaction_isolation: isolation }] = await tx.$queryRaw`SHOW transaction_isolation`;
        return { valeur: 'lue' };
      }, async (lu) => {
        assert.deepEqual(lu, { valeur: 'lue' });
        await assert.rejects(clientTransaction.$queryRaw`SELECT 1`, /closed|committed/i, 'la transaction est validée avant le rendu');
        return { pdf: Buffer.from('%PDF-'), nomFichier: 'essai.pdf' };
      }, { isolationLevel: 'RepeatableRead' });
      assert.equal(isolation, 'repeatable read', 'la lecture suit le niveau d’isolement de la route');
      assert.equal(produit.nomFichier, 'essai.pdf');
      let rendu = false;
      const refus = await produirePdf(async () => refusPdf(404, 'Introuvable.'), async () => { rendu = true; return { pdf: Buffer.alloc(0), nomFichier: '' }; }, {});
      assert.deepEqual(refus, { statut: 404, error: 'Introuvable.' });
      assert.equal(rendu, false, 'un refus n’appelle pas le rendu');
      const panne = new Error('détail interne de la base');
      await assert.rejects(identiteActuelleOuRefus({ companySettings: { findUnique: async () => { throw panne; } } }, AVANT.devis), (erreur) => erreur === panne, 'une panne n’est pas un refus 409');
      assert.deepEqual(await identiteActuelleOuRefus({ companySettings: { findUnique: async () => null } }, AVANT.devis), { statut: 409, ...identiteIncomplete('raison sociale, SIRET, adresse, code postal, ville', AVANT.devis) });
    });

    // P1 : le périmètre du PDF est celui de la fiche (getInterventionFilterForUser), sans rien y ajouter. Le créateur
    // d'une intervention ordinaire n'y entre que s'il est conducteur de travaux ; les autres comptes, s'ils ne sont ni
    // affectés ni responsables de son chantier, ne l'impriment pas (404 exact), même créateurs.
    test('compte rendu : le créateur d’une intervention ordinaire ne l’imprime que s’il est conducteur de travaux ; les autres en reçoivent le 404 exact', async () => {
      const c = f.comptes;
      const sav = await creerIntervention({ clientId: f.client.id, titre: 'TEST SAV créé par un autre compte 6b1a' });
      await demarrer(sav.id);
      await ajouterCompteRendu(sav.id, 'TEST Compte rendu d’un SAV attribué 6b1a.');
      const nom = `Compte-rendu-${sav.reference}.pdf`;
      try {
        for (const [libelle, compte, attendu] of [
          ['CONDUCTEUR_TRAVAUX tiers', c.conducteurTiers, 200],
          ['RESPONSABLE tiers', c.responsableTiers, [404, INTERVENTION_INTROUVABLE]],
          ['ASSISTANTE_COMMERCIALE', c.assistante, [404, INTERVENTION_INTROUVABLE]],
          ['COMPTABLE', c.comptable, [404, INTERVENTION_INTROUVABLE]],
          ['DIRECTEUR_COMMERCIAL', c.directeurCommercial, [404, INTERVENTION_INTROUVABLE]],
        ]) {
          await prisma.intervention.update({ where: { id: sav.id }, data: { createdById: compte.id } });
          await jouerMatrice('compteRendu', [['sav attribué', sav.id]], [[`${libelle}, créateur`, parCompte(compte), [attendu]]], { 'sav attribué': nom });
        }
      } finally {
        await prisma.intervention.update({ where: { id: sav.id }, data: { createdById: null } });
      }
    });

    // Un rendu qui échoue, après la transaction (ici, un logo illisible de la société), rend le 500 générique de chaque
    // route, sans détail interne, et n'écrit rien ; le devis signé et la facture émise, imprimés depuis leurs copies, ne
    // lisent pas le logo actuel.
    test('rendu impossible : 500 exact de chaque route, sans détail interne, rien n’est écrit ; les copies figées n’en dépendent pas', async () => {
      const contenu = Buffer.from('TEST pas une image 6b1a');
      const logo = await prisma.logoDocument.create({ data: { contenu, typeMime: 'image/png', empreinte: `test-6b1a-${randomUUID()}`, taille: contenu.length } });
      await avecSociete({ logoDocumentId: logo.id }, async () => {
        const avant = await etatBase();
        for (const [chemin, corps] of [
          [CHEMINS.devis(f.devisBrouillon.id), { error: 'Opération devis impossible.' }],
          [CHEMINS.compteRendu(f.avecCompteRendu.id), { error: 'Impression du compte rendu impossible.' }],
          [CHEMINS.contrat(f.contratActif.id), { error: 'Impression du contrat de maintenance impossible.' }],
          [CHEMINS.chantier(f.chantier.id), { error: 'Impression du rapport de chantier impossible.' }],
        ]) verifierRefus(await lire(chemin), 500, corps, `${chemin}, logo illisible`);
        verifierPdf(await lire(CHEMINS.devis(f.devisSigne.id)), f.noms.devisSigne, 'devis signé, logo actuel illisible');
        verifierPdf(await lire(CHEMINS.facture(f.factureEmise.id)), f.noms.factureEmise, 'facture émise, logo actuel illisible');
        assert.deepEqual(await etatBase(), avant, 'un rendu impossible n’écrit rien');
      });
    });
  });
}
