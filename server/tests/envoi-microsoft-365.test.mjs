// Lot 6b-1b : envoi des documents par Microsoft 365, côté serveur (cadrage du lot 6b, version 6 du 31-10-2026,
// section « 6b-1b — Serveur », en particulier « Tests (6b-1b ; N5) »). Décisions appliquées : A10, « mode d'envoi
// choisi dans les paramètres généraux, Microsoft 365 par défaut » (16-10-2026) ; décisions de Nelson du 22-10-2026,
// « Oui il faut un replit du style mailto », « Tous type de document » ; lot 6 placé avant le premier jour
// (21-10-2026). Les choix par défaut du cadrage (« à confirmer ») sont testés tels qu'écrits : permissions
// déléguées, jeton transmis pour la seule requête dans l'en-tête X-Jeton-Microsoft, expéditeur contrôlé par
// l'adresse, mode réglé par le super administrateur seul, Graph appelé hors transaction, journal écrit après le
// 202, messages (a), (b) et (c), empreinte et texte gardés, en-tête x-iris-envoi, MICROSOFT_GRAPH_URL restreinte.
// Le refus de configuration (409 « … n’est pas configuré … », avant le mode) est le choix de Claude Code donné dans
// la consigne du code (« Messages exacts »).
//
// Microsoft Graph est simulé par un petit serveur HTTP lancé par ce fichier sur 127.0.0.1 (port libre), que désigne
// MICROSOFT_GRAPH_URL. Il enregistre chaque requête (méthode, chemin, en-têtes, corps) et sa réponse se règle par
// test : 202, 401, 403, autre 4xx, 5xx, délai, coupure, redirection. Les délais des appels à Graph sont raccourcis
// par l'objet `delaisGraph` du module microsoftGraph (consigne du code, « Noms fixés »), puis remis à leur valeur.
//
// Comme envoi-rapport-chantier.test.mjs, ce fichier crée sur le serveur de TEST_DATABASE_URL une base jetable qui
// n'appartient qu'à lui (« test » comme mot, suffixe tiré au hasard), la migre, la sert à l'application montée en
// mémoire, puis la supprime. Sans TEST_DATABASE_URL, il s'annonce ignoré : un SKIP n'est pas une réussite.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import { PDFParse } from 'pdf-parse';

const TITRE = 'Lot 6b-1b : envoi des documents par Microsoft 365, côté serveur';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const dossierServeur = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dossierPrisma = resolve(dossierServeur, 'prisma');
const binairePrisma = resolve(dossierServeur, 'node_modules/.bin/prisma');
// Dernière migration de main (7f413df) avant ce lot, et celle du lot, dont le nom est fixé (consigne du code,
// « Noms fixés ») : une migration fusionnée ne se modifie plus.
const DERNIERE_MIGRATION_MAIN = '20261031200000_journal_envois_rapport_chantier';
const MIGRATION_DU_LOT = '20261101120000_envoi_microsoft_365';

// --- Messages exacts (cadrage, « Échecs (B3) » et « Paramètre » ; consigne du code, « Messages exacts ») ---
const M365 = {
  NON_CONFIGURE: { error: 'L’envoi par Microsoft 365 n’est pas configuré : préparez l’envoi par la messagerie.' },
  DESACTIVE: { error: 'L’envoi par Microsoft 365 est désactivé : préparez l’envoi par la messagerie.' },
  JETON_ABSENT: { error: 'Connexion Microsoft 365 requise pour cet envoi.' },
  EXPEDITEUR: { error: 'Le compte Microsoft ne correspond pas à votre compte Iris.' },
  TROP_LOURD: { error: 'Le PDF dépasse la taille d’envoi par Microsoft 365 : préparez l’envoi par la messagerie.' },
  NE_REPOND_PAS: { error: 'Microsoft 365 ne répond pas : rien n’a été envoyé ni noté. Vous pouvez préparer l’envoi par la messagerie.' },
  REFUSE: { error: 'Microsoft 365 refuse l’envoi : reconnectez-vous, ou vérifiez avec votre administrateur le consentement et la boîte aux lettres de votre compte.' },
  A_REFUSE: { error: 'Microsoft 365 a refusé l’envoi ; rien n’a été envoyé ni noté. Vous pouvez préparer l’envoi par la messagerie.' },
  NON_CONFIRME: { error: 'Microsoft 365 n’a pas confirmé l’envoi : il n’est pas noté. Vérifiez vos éléments envoyés dans Outlook avant de recommencer.' },
  NON_NOTE: { error: 'Le courriel est parti par Microsoft 365, mais son envoi n’a pas pu être noté au journal.' },
  CANAL_INCONNU: { error: 'Canal d’envoi inconnu.' },
};
// --- Refus existants, inchangés (lots 6a-3, 6a-4d, 6a-4e) ---
const SANS_SESSION = { error: 'Authentification requise' };
const SESSION_INVALIDE = { error: 'Session expirée ou invalide' };
const REFUS_ADMINISTRATION = { error: 'Accès réservé aux administrateurs' };
const REFUS_SUPER_ADMINISTRATION = { error: 'Accès réservé au super administrateur' };
const REFUS_DEVIS_WRITE = { error: 'Permission requise : devis:write' };
const REFUS_CLIENTS_READ = { error: 'Permission requise : clients:read' };
const REFUS_COMMERCIAL = { error: 'Accès non autorisé pour un compte commercial.' };
const REFUS_DIRECTEUR = { error: 'Accès non autorisé pour un compte directeur.' };
const REFUS_TECHNICIEN = { error: 'L’envoi du compte rendu n’est pas ouvert au technicien.' };
const REFUS_DESTINATAIRE = { error: 'Adresse du destinataire invalide : indiquez une seule adresse électronique, de la forme nom@domaine.fr.' };
const DEVIS_INTROUVABLE = { error: 'Devis introuvable.' };
const DEVIS_ANNULE = { error: 'Un devis annulé ou refusé ne s’envoie pas.' };
const FACTURE_INTROUVABLE = { error: 'Facture introuvable.' };
const FACTURE_NON_EMISE = { error: 'Le document est disponible uniquement pour une facture émise.' };
const INTERVENTION_INTROUVABLE = { error: 'Intervention introuvable.' };
const INTERVENTION_ANNULEE = { error: 'Une intervention annulée ne s’envoie pas.' };
const AUCUN_COMPTE_RENDU = { error: 'Aucun compte rendu à envoyer.' };
const CONTRAT_INTROUVABLE = { error: 'Contrat de maintenance introuvable.' };
const CONTRAT_ANNULE = { error: 'Un contrat annulé ne s’envoie pas.' };
const CHANTIER_INTROUVABLE = { error: 'Chantier introuvable' };
const CHANTIER_ANNULE = { error: 'Un chantier annulé ne s’envoie pas.' };
const identiteIncomplete = (champs, document) => ({ error: `Identité de la société incomplète : renseignez ${champs} dans l’écran Société avant d’envoyer ${document}.` });
// Un envoi exposé (lecture et réponse de l'enregistrement) : l'expéditeur s'ajoute, ni l'empreinte ni le texte
// (cadrage, « Journal », « Lecture »).
const CHAMPS_ENVOI = ['auteurNom', 'canal', 'createdAt', 'destinataire', 'expediteur', 'id', 'objet'];
// Colonnes de la ligne du journal en base, après la migration du lot (B6, N13).
const COLONNES_ENVOI = ['auteurId', 'auteurNom', 'canal', 'chantierId', 'contratMaintenanceId', 'corps', 'createdAt', 'destinataire', 'devisId', 'empreintePdf', 'expediteur', 'factureId', 'id', 'interventionId', 'objet'];
const TOUS_LES_SCOPES = ['clients:read', 'clients:write', 'catalogue:read', 'catalogue:write', 'equipements:read', 'equipements:write', 'devis:read', 'devis:write', 'company:read', 'chantiers:read', 'chantiers:write', 'chantiers:archive', 'finances:read'];
// Limite de la requête sendMail encodée (cadrage, « Taille (N4) » ; consigne du code : 4 000 000 octets).
const LIMITE_SENDMAIL = 4_000_000;

// --- Objet et texte des envois (lots 6a-3, 6a-4d, 6a-4e, inchangés) ---
const corpsEnvoi = (joint, raisonSociale) => `Bonjour,\n\nVeuillez trouver ci-joint ${joint}.\n\nCordialement,\n${raisonSociale}`;
const TEXTES = {
  devis: (devis, rs) => ({ objet: `Devis ${devis.numero} version ${devis.version} – ${rs}`, corps: corpsEnvoi(`notre devis ${devis.numero} (version ${devis.version})`, rs) }),
  facture: (piece, rs) => (piece.type === 'AVOIR'
    ? { objet: `Avoir ${piece.numero} – ${rs}`, corps: corpsEnvoi(`notre avoir ${piece.numero}`, rs) }
    : { objet: `Facture ${piece.numero} – ${rs}`, corps: corpsEnvoi(`notre facture ${piece.numero}`, rs) }),
  compteRendu: (intervention, rs) => ({ objet: `Compte rendu d’intervention ${intervention.reference} – ${rs}`, corps: corpsEnvoi(`le compte rendu de l’intervention ${intervention.reference}`, rs) }),
  contrat: (contrat, rs) => ({ objet: `Contrat de maintenance ${contrat.titre} – ${rs}`, corps: corpsEnvoi(`le récapitulatif de votre contrat de maintenance ${contrat.titre}`, rs) }),
  chantier: (chantier, rs) => ({ objet: `Rapport de chantier ${chantier.nom} – ${rs}`, corps: corpsEnvoi(`le rapport de chantier ${chantier.nom}`, rs) }),
};
const CHEMINS = {
  devis: (id) => `/devis/${id}`,
  facture: (id) => `/factures/${id}`,
  compteRendu: (id) => `/interventions/${id}`,
  contrat: (id) => `/contrats-maintenance/${id}`,
  chantier: (id) => `/chantiers/${id}`,
};
const COLONNE_DOCUMENT = { devis: 'devisId', facture: 'factureId', compteRendu: 'interventionId', contrat: 'contratMaintenanceId', chantier: 'chantierId' };

// --- Outils sans base ---
const aplatir = (texte) => texte.replace(/\s+/g, ' ').trim();
const sha256 = (octets) => createHash('sha256').update(octets).digest('hex');
// Repris de production-pdf.test.mjs (lot 6b-1a) : seuls /CreationDate et /ID changent d'un tirage à l'autre ; le
// nombre de remplacements est vérifié pour que la comparaison ne soit jamais vide de sens.
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
const texteDuPdf = async (octets) => {
  const lecteur = new PDFParse({ data: octets });
  try { return (await lecteur.getText()).text; } finally { await lecteur.destroy(); }
};
function jour(instant, fuseau) {
  const parties = new Intl.DateTimeFormat('en-GB', { timeZone: fuseau, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const valeur = (type) => parties.find((partie) => partie.type === type).value;
  return `${valeur('day')}-${valeur('month')}-${valeur('year')}`;
}
const pause = (ms) => new Promise((fin) => setTimeout(fin, ms));
// Attente bornée d'une condition (sans sommeil au premier plan du shell : de petites attentes dans le test).
async function attendre(condition, delaiMax, message) {
  const debut = Date.now();
  while (!(await condition())) {
    if (Date.now() - debut > delaiMax) assert.fail(message);
    await pause(20);
  }
}
// Texte à forte entropie, en caractères imprimables par le PDF (WinAnsi), coupé en mots : il se compresse mal, et
// fait donc grossir le PDF à peu près d'un octet par caractère.
const ALPHABET_LOURD = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789àâäçéèêëîïôöùûüÿñÀÂÇÉÈÊËÎÏÔÙÛÜœŒæÆ';
function texteLourd(longueur) {
  const octets = randomBytes(longueur);
  const caracteres = new Array(longueur);
  for (let rang = 0; rang < longueur; rang += 1) caracteres[rang] = rang % 9 === 8 ? ' ' : ALPHABET_LOURD[octets[rang] % ALPHABET_LOURD.length];
  return `TEST compte rendu lourd ${caracteres.join('')}`;
}

// --- Microsoft Graph simulé ---
// Chemins attendus sous MICROSOFT_GRAPH_URL = http://127.0.0.1:<port>/v1.0 : GET /v1.0/me et POST /v1.0/me/sendMail.
// Une règle par nature de requête (« me », « envoi », « autre ») : { statut, corps, entetes, delai, retenue,
// coupure, avant }. Par défaut, /me rend la boîte associée au jeton (401 pour un jeton inconnu) et sendMail 202.
function creerGraph() {
  const requetes = [];
  const boites = new Map();
  const minuteurs = new Set();
  let regles = {};
  const regleParDefaut = (requete) => {
    if (requete.nature === 'envoi') return { statut: 202 };
    if (requete.nature !== 'me') return { statut: 404, corps: { error: { code: 'NotFound', message: 'TEST chemin inconnu du simulateur' } } };
    const jeton = String(requete.entetes.authorization ?? '').replace(/^Bearer /, '');
    const boite = boites.get(jeton);
    if (!boite) return { statut: 401, corps: { error: { code: 'InvalidAuthenticationToken', message: 'TEST jeton inconnu du simulateur' } } };
    return { statut: 200, corps: { '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users(mail,userPrincipalName)/$entity', ...boite } };
  };
  async function traiter(req, res, octets) {
    const url = new URL(req.url, 'http://simulateur.invalid');
    const texte = octets.toString('utf8');
    let json;
    try { json = texte ? JSON.parse(texte) : undefined; } catch { json = undefined; }
    const nature = req.method === 'GET' && url.pathname === '/v1.0/me' ? 'me'
      : req.method === 'POST' && url.pathname === '/v1.0/me/sendMail' ? 'envoi' : 'autre';
    const requete = { nature, methode: req.method, chemin: url.pathname, parametres: [...url.searchParams.entries()], entetes: { ...req.headers }, texte, json, taille: octets.length, recueLe: Date.now(), repondue: false };
    requetes.push(requete);
    const regle = regles[nature] ?? regleParDefaut;
    const spec = typeof regle === 'function' ? await regle(requete, regleParDefaut) : regle;
    if (spec.avant) await spec.avant(requete);
    if (spec.delai) await new Promise((fin) => { const minuteur = setTimeout(() => { minuteurs.delete(minuteur); fin(); }, spec.delai); minuteurs.add(minuteur); });
    if (spec.retenue) await spec.retenue;
    if (spec.coupure) { req.socket.destroy(); return; }
    const corps = spec.corps === undefined ? '' : JSON.stringify(spec.corps);
    res.writeHead(spec.statut, { ...(corps ? { 'content-type': 'application/json' } : {}), ...(spec.entetes ?? {}) });
    res.end(corps);
    requete.repondue = true;
  }
  const serveur = http.createServer((req, res) => {
    const morceaux = [];
    req.on('data', (morceau) => morceaux.push(morceau));
    req.on('end', () => {
      traiter(req, res, Buffer.concat(morceaux)).catch((erreur) => {
        requetes.push({ nature: 'erreur-simulateur', erreur: String(erreur?.stack ?? erreur) });
        if (!res.headersSent) { res.writeHead(599); res.end(); }
      });
    });
  });
  return {
    serveur,
    boites,
    demarrer: () => new Promise((fin) => serveur.listen(0, '127.0.0.1', () => fin(serveur.address().port))),
    arreter: () => new Promise((fin) => { for (const minuteur of minuteurs) clearTimeout(minuteur); serveur.closeAllConnections(); serveur.close(() => fin()); }),
    regler: (nouvelles) => { regles = nouvelles ?? {}; },
    reinitialiser: () => { requetes.length = 0; regles = {}; for (const minuteur of minuteurs) clearTimeout(minuteur); minuteurs.clear(); },
    requetes: (nature) => (nature ? requetes.filter((requete) => requete.nature === nature) : [...requetes]),
  };
}

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const source = new URL(TEST_DATABASE_URL);
    const nomBase = `iris_test_m365_${randomBytes(6).toString('hex')}`;
    const maintenance = new URL(source);
    maintenance.pathname = '/postgres';
    const cible = new URL(source);
    cible.pathname = `/${nomBase}`;
    // L'application ouvre au plus cinq connexions : une rafale de cinq envois qui garderait chacune la sienne
    // pendant l'appel à Graph bloquerait toute autre requête (B2), quel que soit le nombre de cœurs de la machine.
    const cibleApplication = new URL(cible);
    cibleApplication.searchParams.set('connection_limit', '5');
    const administrationPg = new pg.Client({ connectionString: maintenance.toString() });
    let baseCreee = false;

    const graph = creerGraph();
    let urlGraph = '';
    let request; let app; let prisma; let appPrisma; let jwt; let delaisGraph; let delaisOriginaux;
    let session = '';
    let secours = { id: '', name: '', email: '' };
    let TABLES = [];
    const environnementAvant = {};
    const NOMS_ENVIRONNEMENT = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'MICROSOFT_GRAPH_URL'];
    // Valeurs factices de la connexion Microsoft, posées après l'import de l'application : la connexion Microsoft
    // (authentification/sso.ts) les lit à son import, l'envoi les lit à chaque appel (N5).
    const AZURE = { AZURE_TENANT_ID: '00000000-0000-4000-8000-0000000006b1', AZURE_CLIENT_ID: '00000000-0000-4000-8000-0000000006b2' };

    // Sortie console.* de l'application, capturée pour toute la durée du fichier (cadrage, « Sécurité »).
    const sortieConsole = [];
    const consoleOriginale = {};

    const entete = (jeton) => ({ Authorization: `Bearer ${jeton}` });
    const admin = () => entete(session);
    const jetonDe = (compte) => jwt.sign({ id: compte.id }, process.env.JWT_SECRET);
    const parCompte = (compte) => entete(jetonDe(compte));
    let rang = 0;
    const suffixe = () => `${Date.now()}${(rang += 1)}`;

    // Jetons Microsoft émis par le test : chacun ouvre la boîte d'une adresse dans le simulateur. Aucun ne doit
    // ressortir nulle part (réponse, base, journal, sortie console).
    const jetonsEmis = [];
    const PREFIXE_JETON = 'eyJ0eXAiOiJKV1QiTEST6b1b.';
    const nouveauJeton = (boite) => {
      const jeton = `${PREFIXE_JETON}${randomBytes(24).toString('hex')}.m365`;
      jetonsEmis.push(jeton);
      graph.boites.set(jeton, typeof boite === 'string' ? { mail: boite, userPrincipalName: boite } : boite);
      return jeton;
    };

    const SOCIETE = {
      raisonSociale: 'TEST Émetteur Microsoft 365', nomCommercial: '', siret: '61616161600061', tvaIntra: '',
      adresse: '6 rue de l’Envoi Graph', codePostal: '14000', ville: 'Caen', pays: 'France', telephone: '02 31 00 06 61',
      email: 'emetteur-6b1b@iris.test', siteWeb: '', piedFacture: 'TEST Pied 6b1b', fuseauHoraire: 'Europe/Paris',
    };
    const SOCIETE_CHANGEE = { raisonSociale: 'TEST Société changée après l’émission 6b1b', siret: '72727272700072', adresse: '72 avenue Changée', piedFacture: 'TEST Pied changé 6b1b' };

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
    const binaire = (reponse, fin) => { const morceaux = []; reponse.on('data', (m) => morceaux.push(m)); reponse.on('end', () => fin(null, Buffer.concat(morceaux))); };
    // PDF de la route « PDF » : ses octets et le nom de fichier de son bouton.
    const lirePdf = async (nature, id) => {
      const res = await request(app).get(`/api${CHEMINS[nature](id)}/document.pdf`).set(admin()).buffer(true).parse(binaire);
      assert.equal(res.status, 200, `${nature} ${id} : ${res.body?.toString?.('utf8').slice(0, 300)}`);
      assert.equal(res.headers['content-type'], 'application/pdf');
      const [, nomFichier] = /^inline; filename="(.+)"$/.exec(res.headers['content-disposition']) ?? [];
      assert.ok(nomFichier, res.headers['content-disposition']);
      return { octets: res.body, nomFichier };
    };
    const lireEnvois = (nature, id, auth = admin()) => appeler('get', `${CHEMINS[nature](id)}/envois`, null, auth);
    // Envoi : canal Microsoft 365 par défaut, aucun canal avec `sansCanal` ; `jeton` absent n'envoie pas l'en-tête ;
    // `corps` remplace le corps.
    const envoyer = (nature, id, destinataire, { auth = admin(), jeton, canal = 'MICROSOFT_365', sansCanal = false, corps } = {}) => {
      let requete = request(app).post(`/api${CHEMINS[nature](id)}/envois`);
      if (auth) requete = requete.set(auth);
      if (jeton !== undefined) requete = requete.set('X-Jeton-Microsoft', jeton);
      return requete.send(corps ?? (sansCanal ? { destinataire } : { destinataire, canal }));
    };
    const definirSociete = (champs) => ok(appeler('put', '/company', champs));

    // --- Environnement, mode et identité, le temps d'un rappel ---
    const avecEnvironnement = async (valeurs, rappel) => {
      const precedentes = Object.fromEntries(Object.keys(valeurs).map((nom) => [nom, process.env[nom]]));
      for (const [nom, valeur] of Object.entries(valeurs)) { if (valeur === undefined) delete process.env[nom]; else process.env[nom] = valeur; }
      try { return await rappel(); } finally {
        for (const [nom, valeur] of Object.entries(precedentes)) { if (valeur === undefined) delete process.env[nom]; else process.env[nom] = valeur; }
      }
    };
    const NON_CONFIGUREE = { AZURE_TENANT_ID: '' };
    const lireMode = async () => (await prisma.$queryRaw`SELECT "modeEnvoi" FROM "Parametres" WHERE "id" = 'singleton'`)[0]?.modeEnvoi;
    const avecMode = async (mode, rappel) => {
      const precedent = await lireMode();
      await prisma.$executeRaw`UPDATE "Parametres" SET "modeEnvoi" = ${mode} WHERE "id" = 'singleton'`;
      try { return await rappel(); } finally { await prisma.$executeRaw`UPDATE "Parametres" SET "modeEnvoi" = ${precedent} WHERE "id" = 'singleton'`; }
    };
    const avecSociete = async (champs, rappel) => {
      const precedente = await prisma.companySettings.findUniqueOrThrow({ where: { id: 'singleton' } });
      await prisma.companySettings.update({ where: { id: 'singleton' }, data: champs });
      try { return await rappel(); } finally {
        const { id: _id, createdAt: _c, updatedAt: _u, ...restaurer } = precedente;
        await prisma.companySettings.update({ where: { id: 'singleton' }, data: restaurer });
      }
    };
    // Toutes les conditions défavorables à Microsoft 365 à la fois, pour éprouver l'ordre des contrôles : connexion non
    // configurée et mode « messagerie ».
    const toutDefavorable = (rappel) => avecEnvironnement(NON_CONFIGUREE, () => avecMode('MESSAGERIE', rappel));

    // --- État de la base : chaque table résumée par son nombre de lignes et l'empreinte de son contenu entier ---
    const etatBase = async () => {
      const colonnes = TABLES.map((table) => `(SELECT count(*)::text || ':' || coalesce(md5(string_agg(row_to_json(t)::text, '|' ORDER BY row_to_json(t)::text)), '') FROM "${table}" t) AS "${table}"`);
      const [ligne] = await prisma.$queryRawUnsafe(`SELECT ${colonnes.join(', ')}`);
      return ligne;
    };
    const ligneEnvoi = async (id) => (await prisma.$queryRaw`SELECT * FROM "EnvoiDocument" WHERE "id" = ${id}`)[0];
    const sansJetonDans = (res, contexte) => {
      const texte = `${JSON.stringify(res.body ?? null)}\n${res.text ?? ''}\n${JSON.stringify(res.headers ?? {})}`;
      for (const jeton of jetonsEmis) assert.ok(!texte.includes(jeton), `${contexte} : le jeton Microsoft est rendu`);
    };
    // Un refus : statut, corps JSON exact, aucune écriture ; sendMail jamais appelé (sauf `envois`, cas (b)) ; /me non
    // appelé si `me` vaut false, appelé une fois s'il vaut true.
    const refus = async (appel, statut, corps, contexte, { me, envois = 0 } = {}) => {
      graph.reinitialiser();
      const avant = await etatBase();
      const res = await appel();
      assert.equal(res.status, statut, `${contexte} : ${res.status} ${JSON.stringify(res.body)}`);
      assert.deepEqual(res.body, corps, contexte);
      assert.deepEqual(await etatBase(), avant, `${contexte} : rien n’est écrit`);
      assert.equal(graph.requetes('envoi').length, envois, `${contexte} : appels à sendMail`);
      if (me === false) assert.equal(graph.requetes('me').length, 0, `${contexte} : /me ne doit pas être appelé`);
      if (me === true) assert.equal(graph.requetes('me').length, 1, `${contexte} : /me est appelé une fois`);
      assert.deepEqual(graph.requetes('autre'), [], `${contexte} : aucune autre requête à Graph`);
      assert.deepEqual(graph.requetes('erreur-simulateur'), [], contexte);
      sansJetonDans(res, contexte);
      return res;
    };

    // Envoi accepté par Microsoft 365, vérifié de bout en bout (cadrage, « Pour chacun des cinq documents ») :
    // 201 et réponse exacte ; GET /me puis POST sendMail reçus par le simulateur, avec le jeton en Authorization ;
    // message exact (destinataire, objet, texte, en-tête x-iris-envoi, pièce jointe) ; PDF reçu identique à celui de
    // la route « PDF » hors CreationDate et /ID ; ligne du journal (canal, expéditeur, empreinte égale au SHA-256 du PDF
    // reçu, texte, auteur, horodatage de la base, identifiant égal à x-iris-envoi) ; seule cette ligne est écrite,
    // avec, pour un devis brouillon, son passage « envoyé » ; le jeton n'est jamais rendu ; la lecture rend l'envoi.
    const envoiAccepte = async ({ nature, id, destinataire, saisi = destinataire, objet, corps, compte = secours, auth = admin(), jeton, adresse = compte.email, statutDevis, pdfAttendu, tablesModifiees = [], champsEnPlus, contexte }) => {
      const pdf = pdfAttendu ?? await lirePdf(nature, id);
      graph.reinitialiser();
      const [{ debut }] = await prisma.$queryRaw`SELECT now() AS debut`;
      const avant = await etatBase();
      const res = await envoyer(nature, id, saisi, { auth, jeton, ...(champsEnPlus ? { corps: { destinataire: saisi, canal: 'MICROSOFT_365', ...champsEnPlus } } : {}) });
      assert.equal(res.status, 201, `${contexte} : ${res.status} ${JSON.stringify(res.body)}`);
      const apres = await etatBase();
      for (const table of TABLES) {
        if (table === 'EnvoiDocument' || tablesModifiees.includes(table)) continue;
        assert.equal(apres[table], avant[table], `${contexte} : ${table} modifiée par l’envoi`);
      }
      assert.equal(Number(apres.EnvoiDocument.split(':')[0]), Number(avant.EnvoiDocument.split(':')[0]) + 1, `${contexte} : une ligne au journal`);

      // Graph : /me, puis sendMail, rien d'autre.
      const requetes = graph.requetes();
      assert.deepEqual(requetes.map((requete) => requete.nature), ['me', 'envoi'], `${contexte} : requêtes reçues par Graph`);
      const [me, envoi] = requetes;
      assert.deepEqual([me.methode, me.chemin, me.parametres], ['GET', '/v1.0/me', [['$select', 'mail,userPrincipalName']]], `${contexte} : GET /me`);
      assert.equal(me.entetes.authorization, `Bearer ${jeton}`, `${contexte} : jeton de /me`);
      assert.deepEqual([envoi.methode, envoi.chemin, envoi.parametres], ['POST', '/v1.0/me/sendMail', []], `${contexte} : POST sendMail`);
      assert.equal(envoi.entetes.authorization, `Bearer ${jeton}`, `${contexte} : jeton de sendMail`);
      assert.match(envoi.entetes['content-type'] ?? '', /^application\/json/, `${contexte} : corps JSON`);
      assert.ok(envoi.json, `${contexte} : la requête sendMail est un JSON valide`);
      const pieces = envoi.json.message?.attachments ?? [];
      assert.equal(pieces.length, 1, `${contexte} : une seule pièce jointe`);
      const contenu = pieces[0].contentBytes;
      assert.equal(typeof contenu, 'string', contexte);
      const pdfRecu = Buffer.from(contenu, 'base64');
      assert.equal(pdfRecu.toString('base64'), contenu, `${contexte} : contentBytes est du base64 exact`);
      const idEnvoi = res.body?.envoi?.id;
      assert.deepEqual({ ...envoi.json, message: { ...envoi.json.message, attachments: [{ ...pieces[0], contentBytes: '(PDF)' }] } }, {
        message: {
          subject: objet,
          body: { contentType: 'Text', content: corps },
          toRecipients: [{ emailAddress: { address: destinataire } }],
          internetMessageHeaders: [{ name: 'x-iris-envoi', value: idEnvoi }],
          attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: pdf.nomFichier, contentType: 'application/pdf', contentBytes: '(PDF)' }],
        },
        saveToSentItems: true,
      }, `${contexte} : message reçu par Graph`);
      // Le PDF envoyé est celui de la route « PDF », hors CreationDate et /ID.
      assert.equal(normaliser(pdfRecu), normaliser(pdf.octets), `${contexte} : PDF envoyé différent de celui de la route « PDF »`);

      // Journal : la ligne de l'envoi, entière.
      const ligne = await ligneEnvoi(idEnvoi);
      assert.ok(ligne, `${contexte} : ligne du journal ${idEnvoi}`);
      assert.deepEqual(Object.keys(ligne).sort(), COLONNES_ENVOI, `${contexte} : colonnes du journal`);
      const documents = Object.fromEntries(Object.values(COLONNE_DOCUMENT).map((colonne) => [colonne, colonne === COLONNE_DOCUMENT[nature] ? id : null]));
      assert.deepEqual(ligne, {
        id: idEnvoi, ...documents, canal: 'MICROSOFT_365', destinataire, objet, auteurId: compte.id, auteurNom: compte.name,
        createdAt: ligne.createdAt, expediteur: adresse, empreintePdf: sha256(pdfRecu), corps,
      }, `${contexte} : ligne du journal`);
      assert.match(ligne.empreintePdf, /^[0-9a-f]{64}$/, contexte);
      assert.ok(ligne.createdAt.getTime() >= debut.getTime() - 1000 && ligne.createdAt.getTime() <= Date.now() + 1000, `${contexte} : horodatage de la base ${ligne.createdAt.toISOString()}`);

      // Réponse : « la même forme que la messagerie, plus expediteur » (consigne du code, point 4) : l'envoi porte
      // l'expéditeur, comme en lecture, et la réponse le rend aussi à son premier niveau ; jamais le jeton.
      assert.deepEqual(res.body, {
        envoi: { id: idEnvoi, canal: 'MICROSOFT_365', destinataire, objet, auteurNom: compte.name, createdAt: ligne.createdAt.toISOString(), expediteur: adresse },
        objet, corps, expediteur: adresse, ...(statutDevis ? { statutDevis } : {}),
      }, `${contexte} : réponse`);
      assert.ok(!JSON.stringify(res.body).includes(compte.id), `${contexte} : identifiant du compte exposé`);
      sansJetonDans(res, contexte);

      // Lecture : l'envoi en tête, avec son expéditeur, sans empreinte ni texte.
      const lu = await lireEnvois(nature, id);
      assert.equal(lu.status, 200, JSON.stringify(lu.body));
      assert.deepEqual(lu.body.envois[0], res.body.envoi, `${contexte} : lecture du journal`);
      for (const envoiLu of lu.body.envois) assert.deepEqual(Object.keys(envoiLu).sort(), CHAMPS_ENVOI, contexte);
      return { res, ligne, pdfRecu, envoi };
    };

    // --- Données ---
    const creerCompte = (role, cle, extra = {}) => prisma.user.create({ data: { email: `m365.${cle}.${suffixe()}@iris.test`, name: `TEST ${cle} 6b1b`, role, ...extra } });
    const creerClient = async (raisonSociale, { email } = {}) => {
      let client;
      for (let essai = 1; ; essai += 1) {
        const res = await appeler('post', '/clients', { raisonSociale, siren: String(randomInt(100_000_000, 1_000_000_000)), ...(email ? { email } : {}) });
        if (res.status === 409 && essai < 5) continue;
        assert.equal(res.status, 201, JSON.stringify(res.body));
        client = res.body;
        break;
      }
      const site = await ok(appeler('post', `/clients/${client.id}/sites`, { nom: 'TEST Facturation 6b1b', adresse: '9 rue du Destinataire', codePostal: '75009', ville: 'Paris', estSiteFacturation: true }), 201);
      return { ...client, siteFacturation: site };
    };
    const creerDevis = (clientId, objet) => ok(appeler('post', '/devis', { clientId, objet, lignes: [{ designation: `TEST Ligne ${objet}`, nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }), 201);
    const statutDevis = (id, statut) => ok(appeler('put', `/devis/${id}/statut`, { statut }));
    const signerDevis = (id) => ok(appeler('post', `/devis/${id}/signature`, { signataire: 'TEST Signataire 6b1b', confirme: true }), 201);
    const annulerDevis = (id) => ok(appeler('post', `/devis/${id}/annulation`, { motif: 'TEST annulation du devis 6b1b' }));
    const creerIntervention = (donnees, auth = admin()) => ok(appeler('post', '/interventions', donnees, auth), 201);
    const changerStatut = (id, statut, extra = {}) => ok(appeler('patch', `/interventions/${id}/statut`, { statut, ...extra }));
    const demarrer = async (id) => {
      const { statut } = await prisma.intervention.findUniqueOrThrow({ where: { id }, select: { statut: true } });
      if (statut === 'A_PLANIFIER') await changerStatut(id, 'PLANIFIEE');
      await changerStatut(id, 'EN_COURS');
    };
    const planifier = (id, intervenantIds) => ok(appeler('put', `/interventions/${id}/planning`, { dateDebut: new Date().toISOString().slice(0, 10), creneau: 'JOURNEE', intervenantIds }));
    const ajouterCompteRendu = (id, contenu, auth = admin()) => ok(appeler('post', `/interventions/${id}/rapports`, { contenu, cleEnvoi: randomUUID() }, auth), 201);
    const creerContrat = (clientId, titre) => ok(appeler('post', '/contrats-maintenance', { clientId, titre, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-10-2030' }), 201);
    const aujourdhui = () => jour(new Date(), 'Europe/Paris');
    const creerBrouillonFacture = (clientId, lignes, motif) => ok(appeler('post', '/factures', { clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: motif, dateEmission: aujourdhui(), dateEcheance: aujourdhui(), lignes }), 201);
    const emettre = (id) => ok(appeler('post', `/factures/${id}/emettre`));
    const creerEmise = async (clientId, designation) => emettre((await creerBrouillonFacture(clientId, [{ designation, quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }], `TEST ${designation}`)).id);
    // Chantier ouvert par la conversion d'un devis signé ; `annuler` annule le devis, et le chantier avec lui.
    const chantierConverti = async (clientId, objet) => {
      const devis = await creerDevis(clientId, objet);
      await statutDevis(devis.id, 'ENVOYE');
      await signerDevis(devis.id);
      const chantier = await ok(appeler('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }), 201);
      return { devis, chantier, annuler: () => annulerDevis(devis.id) };
    };
    const contratDeDevis = async (clientId, titre) => {
      const devis = await creerDevis(clientId, `TEST Devis de ${titre}`);
      await statutDevis(devis.id, 'ENVOYE');
      await signerDevis(devis.id);
      const contrat = await ok(appeler('post', `/devis/${devis.id}/convertir`, { cible: 'CONTRAT', titre, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-11-2030' }), 201);
      return { contrat, annuler: () => annulerDevis(devis.id) };
    };
    const parametrerFacturation = async () => {
      const compte = (code, libelle, nature) => ok(appeler('post', '/comptabilite/comptes', { code, libelle, nature }), 201);
      const clients = await compte('411000', 'TEST Clients 6b1b', 'ACTIF');
      const prestations = await compte('706000', 'TEST Prestations 6b1b', 'PRODUIT');
      const articles = await compte('707000', 'TEST Articles 6b1b', 'PRODUIT');
      const tva = await compte('445710', 'TEST TVA collectée 6b1b', 'TVA');
      const motif = 'TEST paramétrage comptable 6b1b';
      for (const [cle, donnees] of [['CLIENT', { compteId: clients.id }], ['VENTE_PRESTATION', { compteId: prestations.id }], ['VENTE_ARTICLE', { compteId: articles.id }], ['JOURNAL_VENTES', { journal: 'VE' }]]) {
        await reussi(appeler('put', `/comptabilite/regles/${cle}`, { ...donnees, motif }));
      }
      await reussi(appeler('put', '/comptabilite/tva/20', { compteId: tva.id, motif }));
      const version = await ok(appeler('post', '/mentions-legales', { mentions: 'TEST mentions 6b1b v1', cgv: 'TEST CGV 6b1b v1', penalites: 'TEST pénalités 6b1b v1' }), 201);
      await reussi(appeler('post', `/mentions-legales/${version.version}/publier`));
    };

    // Jeu de données commun (f.*) : un document valide de chaque nature, lu sans être modifié par les refus.
    const f = {};

    before(async () => {
      assert.ok(['127.0.0.1', 'localhost'].includes(source.hostname), 'seul un PostgreSQL local est autorisé');
      assert.notEqual(source.pathname.slice(1), nomBase);
      const port = await graph.demarrer();
      urlGraph = `http://127.0.0.1:${port}/v1.0`;
      await administrationPg.connect();
      await administrationPg.query(`CREATE DATABASE "${nomBase}"`);
      baseCreee = true;
      execFileSync(binairePrisma, ['migrate', 'deploy', '--schema', resolve(dossierPrisma, 'schema.prisma')], {
        env: { ...process.env, DATABASE_URL: cible.toString() }, encoding: 'utf8', stdio: 'pipe', timeout: 180_000,
      });
      for (const nom of NOMS_ENVIRONNEMENT) environnementAvant[nom] = process.env[nom];
      // Connexion Microsoft absente à l'import : la connexion par l'accès de secours des tests reste la seule ouverte.
      delete process.env.AZURE_TENANT_ID;
      delete process.env.AZURE_CLIENT_ID;
      process.env.MICROSOFT_GRAPH_URL = urlGraph;
      process.env.DATABASE_URL = cibleApplication.toString();
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'secret-de-test-uniquement';
      process.env.BREAK_GLASS_EMAIL = 'secours@iris.test';
      process.env.BREAK_GLASS_TOKEN = 'jeton-de-secours-de-test-au-moins-32-caracteres';
      process.env.SUPERADMIN_EMAILS = 'secours@iris.test';
      for (const methode of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
        consoleOriginale[methode] = console[methode];
        console[methode] = (...args) => { sortieConsole.push({ methode, texte: format(...args), instant: Date.now() }); consoleOriginale[methode].apply(console, args); };
      }
      request = (await import('supertest')).default;
      const serveur = await import('../dist/index.js');
      app = serveur.app;
      appPrisma = serveur.prisma;
      const moduleGraph = await import('../dist/src/domaines/documents/microsoftGraph.js');
      delaisGraph = moduleGraph.delaisGraph ?? moduleGraph.default?.delaisGraph;
      assert.ok(delaisGraph && typeof delaisGraph.me === 'number' && typeof delaisGraph.envoi === 'number', 'delaisGraph exporté par microsoftGraph');
      delaisOriginaux = { ...delaisGraph };
      assert.deepEqual(delaisOriginaux, { me: 10_000, envoi: 25_000 }, 'délais du cadrage : 10 s pour /me, 25 s pour sendMail');
      // Délais raccourcis, assez longs pour une machine de CI chargée ; le simulateur les dépasse nettement pour
      // simuler un Graph hors délai.
      delaisGraph.me = 2_000;
      delaisGraph.envoi = 3_000;
      Object.assign(process.env, AZURE);
      const { PrismaClient } = await import('@prisma/client');
      prisma = new PrismaClient({ datasources: { db: { url: cible.toString() } } });
      jwt = (await import('jsonwebtoken')).default;
      await serveur.initDb();
      await serveur.ensureSuperAdmins();
      const connexion = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      assert.equal(connexion.status, 200, JSON.stringify(connexion.body));
      session = connexion.body.token;
      secours = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' }, select: { id: true, name: true, role: true, email: true } });
      assert.equal(secours.role, 'SUPERADMIN');
      TABLES = (await prisma.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name`).map((ligne) => ligne.table_name);
      assert.ok(TABLES.includes('EnvoiDocument') && TABLES.includes('Parametres') && TABLES.includes('JournalAdministration'), TABLES.join(', '));
      await definirSociete(SOCIETE);
      await parametrerFacturation();

      // Comptes de chaque type ; le conducteur est titulaire du chantier et rattaché au responsable.
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
      c.technicienAffecte = await creerCompte('TECHNICIEN', 'technicien-affecte', { permissions: ['devis:read', 'devis:write'] });
      c.technicienNonAffecte = await creerCompte('TECHNICIEN', 'technicien-non-affecte');
      f.comptes = c;
      const intervenant = await prisma.intervenant.create({ data: { nom: 'TEST Intervenant affecté 6b1b', role: 'Technicien', tauxHoraireCharge: 50, userId: c.technicienAffecte.id } });
      f.intervenant = intervenant;

      f.client = await creerClient('TEST Client Microsoft 365 6b1b', { email: 'client@client-6b1b.test' });
      f.devis = await creerDevis(f.client.id, 'TEST Devis de référence 6b1b');
      f.facture = await creerEmise(f.client.id, 'TEST Facture de référence 6b1b');
      f.chantier = await prisma.chantier.create({ data: {
        nom: 'TEST Chantier de référence 6b1b', client: f.client.raisonSociale, clientId: f.client.id, dateDebut: new Date('2026-06-01T00:00:00.000Z'), budgetGlobalVendu: 0, responsableId: c.conducteur.id,
      } });
      f.intervention = await creerIntervention({ clientId: f.client.id, chantierId: f.chantier.id, titre: 'TEST Intervention de référence 6b1b' });
      await planifier(f.intervention.id, [intervenant.id]);
      await demarrer(f.intervention.id);
      await ajouterCompteRendu(f.intervention.id, 'TEST Compte rendu de référence 6b1b.', parCompte(c.technicienAffecte));
      f.contrat = await creerContrat(f.client.id, 'TEST Contrat de référence 6b1b');
      f.ids = { devis: f.devis.id, facture: f.facture.id, compteRendu: f.intervention.id, contrat: f.contrat.id, chantier: f.chantier.id };
      f.textes = {
        devis: TEXTES.devis(f.devis, SOCIETE.raisonSociale), facture: TEXTES.facture(f.facture, SOCIETE.raisonSociale), compteRendu: TEXTES.compteRendu(f.intervention, SOCIETE.raisonSociale),
        contrat: TEXTES.contrat(f.contrat, SOCIETE.raisonSociale), chantier: TEXTES.chantier(f.chantier, SOCIETE.raisonSociale),
      };
    });

    after(async () => {
      if (delaisGraph && delaisOriginaux) Object.assign(delaisGraph, delaisOriginaux);
      for (const [methode, originale] of Object.entries(consoleOriginale)) console[methode] = originale;
      for (const nom of NOMS_ENVIRONNEMENT) { if (environnementAvant[nom] === undefined) delete process.env[nom]; else process.env[nom] = environnementAvant[nom]; }
      await graph.arreter().catch(() => {});
      await prisma?.$disconnect().catch(() => {});
      await appPrisma?.$disconnect().catch(() => {});
      if (baseCreee) await administrationPg.query(`DROP DATABASE IF EXISTS "${nomBase}" WITH (FORCE)`);
      await administrationPg.end().catch(() => {});
    });

    // ------------------------------------------------------------------------------------------------
    // Lecture : proposition.microsoft365 (cadrage, « Paramètre », N3 ; consigne du code, « Lecture des envois »).
    // ------------------------------------------------------------------------------------------------

    // Vrai seulement si le mode est MICROSOFT_365, la connexion Microsoft configurée (les deux variables, lues à
    // l'appel) et MICROSOFT_GRAPH_URL admise. Chaque cas est lu sur les cinq routes, sans rien écrire, sans appel à Graph.
    test('lecture : proposition.microsoft365 dans les cinq lectures, vrai seulement en mode Microsoft 365, connexion configurée et adresse de Graph admise', async () => {
      const lireTout = async (attendu, contexte) => {
        graph.reinitialiser();
        const avant = await etatBase();
        for (const nature of Object.keys(CHEMINS)) {
          const res = await lireEnvois(nature, f.ids[nature]);
          assert.equal(res.status, 200, `${contexte}, ${nature} : ${JSON.stringify(res.body)}`);
          assert.deepEqual(res.body.proposition, { destinataire: 'client@client-6b1b.test', ...f.textes[nature], microsoft365: attendu }, `${contexte}, ${nature}`);
        }
        assert.deepEqual(await etatBase(), avant, `${contexte} : une lecture n’écrit rien`);
        assert.deepEqual(graph.requetes(), [], `${contexte} : une lecture n’appelle pas Graph`);
      };
      await lireTout(true, 'mode Microsoft 365, connexion configurée');
      await avecMode('MESSAGERIE', () => lireTout(false, 'mode messagerie'));
      await avecEnvironnement({ AZURE_TENANT_ID: '' }, () => lireTout(false, 'AZURE_TENANT_ID vide'));
      await avecEnvironnement({ AZURE_CLIENT_ID: '' }, () => lireTout(false, 'AZURE_CLIENT_ID vide'));
      await avecEnvironnement({ AZURE_TENANT_ID: undefined, AZURE_CLIENT_ID: undefined }, () => lireTout(false, 'connexion Microsoft absente'));
      await avecEnvironnement({ MICROSOFT_GRAPH_URL: 'https://graph.microsoft.com.evil.example/v1.0' }, () => lireTout(false, 'adresse de Graph non admise'));
      // Adresses admises, sans appel : la valeur par défaut, Graph lui-même, une adresse locale.
      await avecEnvironnement({ MICROSOFT_GRAPH_URL: undefined }, () => lireTout(true, 'MICROSOFT_GRAPH_URL absente (https://graph.microsoft.com/v1.0)'));
      await avecEnvironnement({ MICROSOFT_GRAPH_URL: 'https://graph.microsoft.com/v1.0' }, () => lireTout(true, 'https://graph.microsoft.com/v1.0'));
      await avecEnvironnement({ MICROSOFT_GRAPH_URL: urlGraph.replace('127.0.0.1', 'localhost') }, () => lireTout(true, 'http://localhost:<port>'));
      // Le réglage revient : la lecture suit l'état du moment.
      await lireTout(true, 'retour à la configuration complète');
    });

    // ------------------------------------------------------------------------------------------------
    // Envoi accepté, pour chacun des cinq documents.
    // ------------------------------------------------------------------------------------------------

    // Devis : un brouillon passe « envoyé » (V1, comme envoyerDevis) ; un devis signé s'envoie avec la copie prise à
    // sa signature (identité figée, lot 6a-2), même après un changement de la société.
    test('devis : 201, message reçu par Graph, PDF de la route « PDF », ligne du journal entière ; un brouillon passe « envoyé » ; un devis signé part avec sa copie figée', async () => {
      const s = suffixe();
      const devis = await creerDevis(f.client.id, `TEST Devis envoyé par Microsoft 365 ${s}`);
      const { res } = await envoiAccepte({
        nature: 'devis', id: devis.id, destinataire: 'client@client-6b1b.test', saisi: '  client@client-6b1b.test\n', ...TEXTES.devis(devis, SOCIETE.raisonSociale),
        jeton: nouveauJeton(secours.email), statutDevis: 'ENVOYE', tablesModifiees: ['Devis'], contexte: 'devis brouillon',
      });
      assert.equal(res.body.statutDevis, 'ENVOYE');
      assert.equal((await prisma.devis.findUniqueOrThrow({ where: { id: devis.id } })).statut, 'ENVOYE');

      const signe = await creerDevis(f.client.id, `TEST Devis signé envoyé ${s}`);
      await signerDevis(signe.id);
      const pdfSigne = await lirePdf('devis', signe.id);
      await avecSociete(SOCIETE_CHANGEE, async () => {
        await envoiAccepte({
          nature: 'devis', id: signe.id, destinataire: 'client@client-6b1b.test', ...TEXTES.devis(signe, SOCIETE.raisonSociale),
          jeton: nouveauJeton(secours.email), statutDevis: 'ACCEPTE', pdfAttendu: pdfSigne, contexte: 'devis signé, société changée',
        });
      });
    });

    // Facture et avoir : le PDF reçu par Graph est le PDF figé à l'émission (auditeur des montants). La pièce est
    // imprimée, puis la société, le client, son adresse de facturation et les mentions légales changent, puis la pièce
    // part : le PDF reçu est, octet pour octet hors CreationDate et /ID, celui d'avant les changements.
    // Montants : la facture (2 × 125,00 € et 2,5 × 0,33 € = 0,825 €, imprimé 0,83 €) totalise 250,83 € HT, 50,17 € de
    // TVA et 301,00 € TTC ; l'avoir partiel, 40,00 € HT et 48,00 € TTC. Lectures écartées : un PDF recalculé au
    // demi-centime pair ou tronqué (0,82 €, 250,82 €) ; le PDF de la facture joint à l'envoi de l'avoir, ou
    // l'inverse (301,00 € contre 48,00 €) ; un PDF réimprimé avec la société, le client ou les mentions du jour.
    test('facture et avoir : le PDF reçu par Graph est le PDF figé à l’émission, même après un changement de la société, du client et des mentions ; objet à la raison sociale figée', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client facturé Microsoft 365 ${s}`, { email: 'compta@client-6b1b.test' });
      const facture = await emettre((await creerBrouillonFacture(client.id, [
        { designation: 'TEST Prestation émise 6b1b', quantite: 2, prixUnitaireHt: 125, tauxTva: 20 },
        { designation: 'TEST Fourniture émise 6b1b', quantite: 2.5, prixUnitaireHt: 0.33, tauxTva: 20 },
      ], 'TEST facture envoyée par Microsoft 365')).id);
      assert.deepEqual([facture.statut, facture.totalHt, facture.totalTva, facture.totalTtc], ['EMISE', 250.83, 50.17, 301]);
      const avoir = await ok(appeler('post', `/factures/${facture.id}/avoirs`, { lignes: [{ designation: 'TEST Geste commercial 6b1b', quantite: 1, prixUnitaireHt: 40, tauxTva: 20 }] }), 201);
      assert.deepEqual([avoir.type, avoir.totalHt, avoir.totalTva, avoir.totalTtc], ['AVOIR', 40, 8, 48]);
      const pdfFacture = await lirePdf('facture', facture.id);
      const pdfAvoir = await lirePdf('facture', avoir.id);
      assert.equal(pdfFacture.nomFichier, `${facture.numero}.pdf`);
      assert.equal(pdfAvoir.nomFichier, `${avoir.numero}.pdf`);

      const nouvellesMentions = await ok(appeler('post', '/mentions-legales', { mentions: 'TEST mentions 6b1b v2', cgv: 'TEST CGV 6b1b v2', penalites: 'TEST pénalités 6b1b v2' }), 201);
      await reussi(appeler('post', `/mentions-legales/${nouvellesMentions.version}/publier`));
      await ok(appeler('put', `/clients/${client.id}`, { raisonSociale: `TEST Client renommé après l’émission ${s}` }));
      await prisma.clientSite.update({ where: { id: client.siteFacturation.id }, data: { adresse: '99 avenue du Déménagement', codePostal: '13001', ville: 'Marseille' } });
      await avecSociete(SOCIETE_CHANGEE, async () => {
        for (const [piece, pdf, montants, ecartes] of [
          [facture, pdfFacture, ['0,83 €', 'Total HT : 250,83 €', 'TVA 20 % sur 250,83 € : 50,17 €', 'Total TTC : 301,00 €'], /0,82 €|250,82 €|Total TTC : 48,00 €/u],
          [avoir, pdfAvoir, ['Total HT : 40,00 €', 'TVA 20 % sur 40,00 € : 8,00 €', 'Total TTC : 48,00 €', `Facture d’origine : ${facture.numero}`], /Total TTC : 301,00 €|TEST Prestation émise/u],
        ]) {
          const { pdfRecu } = await envoiAccepte({
            nature: 'facture', id: piece.id, destinataire: 'compta@client-6b1b.test', ...TEXTES.facture(piece, SOCIETE.raisonSociale),
            jeton: nouveauJeton(secours.email), pdfAttendu: pdf, contexte: `${piece.type} ${piece.numero}, après les changements`,
          });
          const plat = aplatir(await texteDuPdf(pdfRecu));
          for (const attendu of [...montants, SOCIETE.raisonSociale, `SIRET ${SOCIETE.siret}`, client.raisonSociale, '9 rue du Destinataire', 'TEST mentions 6b1b v1']) {
            assert.ok(plat.includes(attendu), `${piece.numero} : absent du PDF envoyé « ${attendu} »\n${plat}`);
          }
          assert.doesNotMatch(plat, ecartes, plat);
          assert.doesNotMatch(plat, /TEST Société changée|72727272700072|renommé après|Déménagement|TEST mentions 6b1b v2/u, plat);
        }
      });
    });

    // Facture réglée, facture annulée et son avoir total : chacune part avec le PDF de la route « PDF », mention de
    // son statut comprise (« Facture réglée. », « FACTURE ANNULÉE — ce document ne vaut pas justificatif de créance. »),
    // comme par la messagerie, qui envoie aussi une facture annulée (lot 6a-3). Le cadrage note qu'« une facture se
    // réimprime avec sa mention « réglée » ou « annulée » » (« Journal », B6). Lectures écartées : un PDF « figé à
    // l'émission » sans la mention du statut (une créance annulée imprimée comme due) ; une facture annulée refusée par
    // Microsoft 365 seulement.
    test('facture réglée, facture annulée et avoir total : le PDF reçu par Graph est celui de la route « PDF », avec la mention du statut', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client des statuts Microsoft 365 ${s}`, { email: 'statuts@client-6b1b.test' });
      const reglee = await creerEmise(client.id, `TEST Facture réglée 6b1b ${s}`);
      const annulee = await creerEmise(client.id, `TEST Facture annulée 6b1b ${s}`);
      assert.deepEqual([reglee.totalTtc, annulee.totalTtc], [120, 120]);
      await ok(appeler('post', '/reglements', { clientId: client.id, dateReglement: aujourdhui(), montant: 120, moyen: 'VIREMENT', affectations: [{ factureId: reglee.id, montant: 120 }] }), 201);
      const annulation = await ok(appeler('post', `/factures/${annulee.id}/annuler`));
      const avoirTotal = annulation.avoir;
      assert.deepEqual(
        (await prisma.facture.findMany({ where: { id: { in: [reglee.id, annulee.id, avoirTotal.id] } }, select: { id: true, statut: true } })).map(({ id, statut }) => [id, statut]).sort(),
        [[reglee.id, 'REGLEE'], [annulee.id, 'ANNULEE'], [avoirTotal.id, 'EMISE']].sort(),
      );
      for (const [piece, attendus, ecartes] of [
        [reglee, ['Facture réglée.', 'Total TTC : 120,00 €'], /FACTURE ANNULÉE/u],
        [{ ...annulee, statut: 'ANNULEE' }, ['FACTURE ANNULÉE — ce document ne vaut pas justificatif de créance.', 'Total TTC : 120,00 €'], /Facture réglée/u],
        [avoirTotal, [`Facture d’origine : ${annulee.numero}`, 'Total TTC : 120,00 €'], /FACTURE ANNULÉE|Facture réglée/u],
      ]) {
        const pdf = await lirePdf('facture', piece.id);
        const { pdfRecu } = await envoiAccepte({
          nature: 'facture', id: piece.id, destinataire: 'statuts@client-6b1b.test', ...TEXTES.facture(piece, SOCIETE.raisonSociale),
          jeton: nouveauJeton(secours.email), pdfAttendu: pdf, contexte: `${piece.type} ${piece.numero} (${piece.statut})`,
        });
        const plat = aplatir(await texteDuPdf(pdfRecu));
        for (const attendu of attendus) assert.ok(plat.includes(attendu), `${piece.numero} : absent du PDF envoyé « ${attendu} »\n${plat}`);
        assert.doesNotMatch(plat, ecartes, plat);
      }
    });

    // Cadrage : « Le serveur produit le PDF lui-même […] : jamais un fichier fourni par le navigateur » ; l'objet et le
    // texte « partent sans retouche possible ». Un corps de requête qui porte un PDF (celui d'une autre facture, à
    // d'autres montants), un objet, un texte, un expéditeur ou une empreinte est ignoré : le courriel et le journal
    // portent ce qu'Iris produit. Lectures écartées : la pièce jointe, l'objet ou le texte repris de l'écran, comme
    // dans la messagerie ; l'empreinte ou l'expéditeur déclarés par l'écran.
    test('corps de la requête : un PDF, un objet, un texte, un expéditeur ou une empreinte fournis par l’écran sont ignorés', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client des champs ignorés ${s}`, { email: 'ignores@client-6b1b.test' });
      const facture = await emettre((await creerBrouillonFacture(client.id, [{ designation: `TEST Facture des champs ignorés ${s}`, quantite: 3, prixUnitaireHt: 33.33, tauxTva: 20 }], 'TEST champs ignorés 6b1b')).id);
      assert.deepEqual([facture.totalHt, facture.totalTva, facture.totalTtc], [99.99, 20, 119.99]);
      const autre = await lirePdf('facture', f.facture.id);
      const champsEnPlus = {
        pdf: autre.octets.toString('base64'), contentBytes: autre.octets.toString('base64'), attachments: [{ contentBytes: autre.octets.toString('base64') }],
        nomFichier: 'TEST-forge.pdf', objet: 'TEST Objet saisi à l’écran', corps: 'TEST Texte saisi à l’écran : 1 000,00 € et 12 h', expediteur: 'autre.personne@iris.test',
        empreintePdf: '0'.repeat(64), saveToSentItems: false,
      };
      for (const [nature, id, document, destinataire] of [['facture', facture.id, facture, 'ignores@client-6b1b.test'], ['chantier', f.chantier.id, f.chantier, 'client@client-6b1b.test']]) {
        const { pdfRecu } = await envoiAccepte({
          nature, id, destinataire, ...TEXTES[nature](document, SOCIETE.raisonSociale), jeton: nouveauJeton(secours.email), champsEnPlus, contexte: `${nature}, champs fournis par l’écran`,
        });
        assert.notEqual(normaliser(pdfRecu), normaliser(autre.octets), `${nature} : le PDF fourni par l’écran est joint`);
        if (nature === 'facture') {
          const plat = aplatir(await texteDuPdf(pdfRecu));
          for (const attendu of ['Total HT : 99,99 €', 'TVA 20 % sur 99,99 € : 20,00 €', 'Total TTC : 119,99 €']) assert.ok(plat.includes(attendu), `absent du PDF envoyé « ${attendu} »\n${plat}`);
        }
      }
    });

    // Compte rendu : envoyé par le conducteur titulaire du chantier (périmètre SAV, durcissement N1 de #406 : la lecture
    // du PDF reçoit le périmètre de l'envoi), à son nom et depuis sa boîte.
    test('compte rendu : 201 par le conducteur titulaire, depuis sa boîte, avec le PDF de la route « PDF » et la ligne du journal entière', async () => {
      const conducteur = f.comptes.conducteur;
      await envoiAccepte({
        nature: 'compteRendu', id: f.intervention.id, destinataire: 'client@client-6b1b.test', ...f.textes.compteRendu,
        compte: conducteur, auth: parCompte(conducteur), jeton: nouveauJeton(conducteur.email), contexte: 'compte rendu, conducteur titulaire',
      });
      await envoiAccepte({
        nature: 'compteRendu', id: f.intervention.id, destinataire: 'autre@client-6b1b.test', ...f.textes.compteRendu,
        jeton: nouveauJeton(secours.email), contexte: 'compte rendu, super administrateur',
      });
      assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id: f.intervention.id } })).statut, 'EN_COURS');
    });

    test('contrat de maintenance : 201, message reçu par Graph, PDF de la route « PDF », ligne du journal entière', async () => {
      await envoiAccepte({
        nature: 'contrat', id: f.contrat.id, destinataire: 'client@client-6b1b.test', ...f.textes.contrat,
        compte: f.comptes.admin, auth: parCompte(f.comptes.admin), jeton: nouveauJeton(f.comptes.admin.email), contexte: 'contrat, administrateur',
      });
    });

    test('rapport de chantier : 201, message reçu par Graph, PDF de la route « PDF », ligne du journal entière', async () => {
      await envoiAccepte({
        nature: 'chantier', id: f.chantier.id, destinataire: 'client@client-6b1b.test', ...f.textes.chantier,
        jeton: nouveauJeton(secours.email), contexte: 'rapport de chantier',
      });
    });

    // Cadrage, « Message » (N10) : « Un nom de chantier ou un intitulé de contrat sur plusieurs lignes : le test vérifie
    // que la requête Graph reste valide. La mise sur une seule ligne suit #396 » (hors périmètre) : l'objet part tel
    // quel, dans un JSON valide.
    test('nom de chantier et intitulé de contrat sur plusieurs lignes : la requête Graph reste un JSON valide, objet et texte tels quels', async () => {
      const s = suffixe();
      const chantier = await prisma.chantier.create({ data: { nom: `TEST Chantier\nsur deux lignes ${s}`, client: f.client.raisonSociale, clientId: f.client.id, dateDebut: new Date('2026-06-01T00:00:00.000Z'), budgetGlobalVendu: 0 } });
      const contrat = await creerContrat(f.client.id, `TEST Contrat multiligne ${s}`);
      const titre = `TEST Contrat\r\nsur deux lignes ${s}`;
      await prisma.contratMaintenance.update({ where: { id: contrat.id }, data: { titre } });
      for (const [nature, document] of [['chantier', chantier], ['contrat', { ...contrat, titre }]]) {
        const { envoi } = await envoiAccepte({
          nature, id: document.id, destinataire: 'client@client-6b1b.test', ...TEXTES[nature](document, SOCIETE.raisonSociale),
          jeton: nouveauJeton(secours.email), contexte: `${nature} sur plusieurs lignes`,
        });
        assert.ok(envoi.json.message.subject.includes('\n'), `${nature} : l’objet garde son saut de ligne`);
      }
    });

    // ------------------------------------------------------------------------------------------------
    // Expéditeur contrôlé (cadrage, « Expéditeur contrôlé (N2) »).
    // ------------------------------------------------------------------------------------------------

    // « L'adresse de la boîte, mail (à défaut userPrincipalName), doit être celle du compte Iris de la session, sans
    // tenir compte de la casse. Sinon : 403 « Le compte Microsoft ne correspond pas à votre compte Iris. », sans rien
    // envoyer ni écrire. » Une adresse en d'autres capitales passe ; une boîte sans mail passe par son
    // userPrincipalName ; le mail l'emporte sur le userPrincipalName.
    test('expéditeur : 403 exact pour une autre boîte, sur les cinq routes, sans rien envoyer ni écrire ; casse ignorée ; mail, sinon userPrincipalName', async () => {
      for (const nature of Object.keys(CHEMINS)) {
        for (const [boite, contexte] of [
          [{ mail: 'autre.personne@iris.test', userPrincipalName: 'autre.personne@iris.test' }, 'autre boîte'],
          [{ mail: 'autre.personne@iris.test', userPrincipalName: secours.email }, 'mail d’une autre boîte, userPrincipalName du compte'],
          [{ mail: `${secours.email}.evil.example`, userPrincipalName: `${secours.email}.evil.example` }, 'adresse qui commence comme celle du compte'],
          [{ mail: `x${secours.email}`, userPrincipalName: `x${secours.email}` }, 'adresse qui finit comme celle du compte'],
        ]) {
          await refus(() => envoyer(nature, f.ids[nature], 'client@client-6b1b.test', { jeton: nouveauJeton(boite) }), 403, M365.EXPEDITEUR, `${nature}, ${contexte}`, { me: true });
        }
      }
      const devis = await creerDevis(f.client.id, `TEST Devis expéditeur ${suffixe()}`);
      // Casse ignorée : la boîte « SECOURS@Iris.TEST » est celle du compte secours@iris.test. Le cadrage ne fixe pas
      // l'écriture de l'adresse gardée (celle de la boîte, ou celle du compte) : seule son égalité sans la casse, et
      // son identité entre la réponse et la base, sont vérifiées ici.
      graph.reinitialiser();
      const majuscules = await envoyer('devis', devis.id, 'client@client-6b1b.test', { jeton: nouveauJeton({ mail: 'SECOURS@Iris.TEST', userPrincipalName: 'SECOURS@Iris.TEST' }) });
      assert.equal(majuscules.status, 201, JSON.stringify(majuscules.body));
      assert.deepEqual(graph.requetes().map((requete) => requete.nature), ['me', 'envoi']);
      const ligneMajuscules = await ligneEnvoi(majuscules.body.envoi.id);
      assert.equal(ligneMajuscules.expediteur.toLowerCase(), secours.email);
      assert.deepEqual([majuscules.body.envoi.expediteur, majuscules.body.expediteur], [ligneMajuscules.expediteur, ligneMajuscules.expediteur]);
      sansJetonDans(majuscules, 'adresse en capitales');
      // Boîte sans mail : son userPrincipalName.
      await envoiAccepte({
        nature: 'devis', id: devis.id, destinataire: 'client@client-6b1b.test', ...TEXTES.devis(devis, SOCIETE.raisonSociale),
        jeton: nouveauJeton({ mail: null, userPrincipalName: secours.email }), statutDevis: 'ENVOYE', contexte: 'boîte sans mail, userPrincipalName du compte',
      });
    });

    // ------------------------------------------------------------------------------------------------
    // Refus propres à Microsoft 365 : mode, configuration, jeton, canal.
    // ------------------------------------------------------------------------------------------------

    // Cadrage : « En mode MESSAGERIE, l'envoi par Microsoft 365 est refusé : 409 » ; « la messagerie reste toujours
    // disponible » (N8). Le mode est lu dans la première transaction, après /me : sendMail n'est jamais appelé.
    test('mode « messagerie » : 409 exact sur les cinq routes, sendMail non appelé, rien d’écrit ; la messagerie reste disponible', async () => {
      await avecMode('MESSAGERIE', async () => {
        for (const nature of Object.keys(CHEMINS)) {
          await refus(() => envoyer(nature, f.ids[nature], 'client@client-6b1b.test', { jeton: nouveauJeton(secours.email) }), 409, M365.DESACTIVE, `${nature}, mode messagerie`);
          await refus(() => envoyer(nature, f.ids[nature], 'client@client-6b1b.test'), 409, M365.DESACTIVE, `${nature}, mode messagerie, sans jeton`, { me: false });
        }
        const devis = await creerDevis(f.client.id, `TEST Devis par la messagerie ${suffixe()}`);
        for (const [nature, id] of [['devis', devis.id], ...Object.entries(f.ids).filter(([nature]) => nature !== 'devis')]) {
          graph.reinitialiser();
          for (const canal of [undefined, 'MESSAGERIE']) {
            const res = await envoyer(nature, id, 'client@client-6b1b.test', { canal, sansCanal: canal === undefined, jeton: nouveauJeton(secours.email) });
            assert.equal(res.status, 201, `${nature}, messagerie (${canal ?? 'canal absent'}) : ${JSON.stringify(res.body)}`);
            assert.deepEqual(Object.keys(res.body).sort(), ['corps', 'envoi', 'objet', ...(nature === 'devis' ? ['statutDevis'] : [])], `${nature} : réponse de la messagerie inchangée`);
            assert.deepEqual([res.body.envoi.canal, res.body.envoi.expediteur], ['MESSAGERIE', null], nature);
            const ligne = await ligneEnvoi(res.body.envoi.id);
            assert.deepEqual([ligne.canal, ligne.expediteur, ligne.empreintePdf, ligne.corps], ['MESSAGERIE', null, null, null], nature);
            sansJetonDans(res, nature);
          }
          assert.deepEqual(graph.requetes(), [], `${nature} : la messagerie n’appelle pas Graph`);
        }
      });
    });

    // Cadrage : « Si la connexion Microsoft n'est pas configurée (AZURE_TENANT_ID ou AZURE_CLIENT_ID vides), l'envoi par
    // Microsoft 365 est refusé (409), quel que soit le mode. Ces variables sont lues à l'appel » ; « /me n'est appelé ni
    // sans jeton, ni quand la connexion Microsoft n'est pas configurée ». Message : choix de Claude Code.
    test('connexion Microsoft non configurée : 409 exact sur les cinq routes, quel que soit le mode, /me non appelé ; la messagerie reste disponible', async () => {
      for (const [valeurs, contexte] of [
        [{ AZURE_TENANT_ID: '' }, 'AZURE_TENANT_ID vide'], [{ AZURE_CLIENT_ID: '' }, 'AZURE_CLIENT_ID vide'],
        [{ AZURE_TENANT_ID: undefined, AZURE_CLIENT_ID: undefined }, 'variables absentes'],
      ]) {
        await avecEnvironnement(valeurs, async () => {
          for (const nature of Object.keys(CHEMINS)) {
            await refus(() => envoyer(nature, f.ids[nature], 'client@client-6b1b.test', { jeton: nouveauJeton(secours.email) }), 409, M365.NON_CONFIGURE, `${nature}, ${contexte}`, { me: false });
          }
          // Avant le mode, dans le même rang de contrôle : le refus de configuration l'emporte en mode messagerie.
          await avecMode('MESSAGERIE', () => refus(() => envoyer('contrat', f.ids.contrat, 'client@client-6b1b.test', { jeton: nouveauJeton(secours.email) }), 409, M365.NON_CONFIGURE, `${contexte}, mode messagerie`, { me: false }));
          const res = await envoyer('chantier', f.ids.chantier, 'client@client-6b1b.test', { canal: 'MESSAGERIE' });
          assert.equal(res.status, 201, `${contexte}, messagerie : ${JSON.stringify(res.body)}`);
        });
      }
    });

    // Cadrage, « Configuration » (N6) : MICROSOFT_GRAPH_URL « n'admet que https://graph.microsoft.com/…, ou une adresse
    // locale (http://127.0.0.1:… ou http://localhost:…) » ; consigne du code : analysée avec new URL, et non par un
    // simple préfixe ; lue à l'appel, une valeur refusée rend le refus de configuration, sans appel. Une adresse
    // admise ou refusée à tort serait appelée : un domaine qui ne résout pas rendrait 502, et non ce 409.
    test('MICROSOFT_GRAPH_URL hors des adresses admises : 409 de configuration, sans aucun appel ; analysée comme une adresse, et non comme un préfixe', async () => {
      const port = new URL(urlGraph).port;
      const refusees = [
        'https://graph.microsoft.com.evil.example/v1.0',
        'https://graph.microsoft.com@evil.example/v1.0',
        'https://evil.example/graph.microsoft.com/v1.0',
        'http://graph.microsoft.com/v1.0',
        `http://127.0.0.1@evil.example:${port}/v1.0`,
        `http://127.0.0.1.evil.example:${port}/v1.0`,
        `http://localhost.evil.example:${port}/v1.0`,
        `http://127.0.0.2:${port}/v1.0`,
        `ftp://127.0.0.1:${port}/v1.0`,
        `https://evil.example/?u=http://127.0.0.1:${port}`,
        'pas une adresse',
      ];
      for (const valeur of refusees) {
        await avecEnvironnement({ MICROSOFT_GRAPH_URL: valeur }, async () => {
          await refus(() => envoyer('devis', f.ids.devis, 'client@client-6b1b.test', { jeton: nouveauJeton(secours.email) }), 409, M365.NON_CONFIGURE, `MICROSOFT_GRAPH_URL = ${valeur}`, { me: false });
          assert.equal((await lireEnvois('chantier', f.ids.chantier)).body.proposition.microsoft365, false, valeur);
        });
      }
      assert.equal((await prisma.devis.findUniqueOrThrow({ where: { id: f.ids.devis } })).statut, 'BROUILLON');
    });

    // Cadrage, « Configuration » : « Toute autre valeur refuse le démarrage, car elle porterait les jetons des
    // utilisateurs » ; consigne du code : « le démarrage est refusé (server/src/demarrage.ts) ». La vérification
    // exportée est appelée ; le lancement du serveur l'appelle avant d'écouter (server/index.ts).
    test('démarrage : refusé pour une MICROSOFT_GRAPH_URL non admise, accepté pour les adresses admises et sans la variable', async () => {
      const { verifierConfigurationDemarrage } = await import('../dist/src/demarrage.js');
      assert.equal(typeof verifierConfigurationDemarrage, 'function', 'demarrage.ts exporte sa vérification');
      const port = new URL(urlGraph).port;
      for (const valeur of ['https://graph.microsoft.com.evil.example/v1.0', `http://127.0.0.1@evil.example:${port}/v1.0`, 'http://graph.microsoft.com/v1.0', `http://127.0.0.2:${port}`, 'https://evil.example/v1.0', 'pas une adresse']) {
        await avecEnvironnement({ MICROSOFT_GRAPH_URL: valeur }, () => assert.throws(() => verifierConfigurationDemarrage(), /MICROSOFT_GRAPH_URL/, valeur));
      }
      for (const valeur of [undefined, 'https://graph.microsoft.com/v1.0', urlGraph, urlGraph.replace('127.0.0.1', 'localhost')]) {
        await avecEnvironnement({ MICROSOFT_GRAPH_URL: valeur }, () => assert.doesNotThrow(() => verifierConfigurationDemarrage(), String(valeur)));
      }
    });

    // Cadrage : « jeton absent : 400 « Connexion Microsoft 365 requise pour cet envoi. » » ; consigne du code : « jeton
    // absent ou vide » ; « /me n'est appelé ni sans jeton ».
    test('jeton absent ou vide : 400 exact sur les cinq routes, /me non appelé, rien d’écrit', async () => {
      for (const nature of Object.keys(CHEMINS)) {
        await refus(() => envoyer(nature, f.ids[nature], 'client@client-6b1b.test'), 400, M365.JETON_ABSENT, `${nature}, sans en-tête`, { me: false });
        await refus(() => envoyer(nature, f.ids[nature], 'client@client-6b1b.test', { jeton: '' }), 400, M365.JETON_ABSENT, `${nature}, en-tête vide`, { me: false });
      }
    });

    // Cadrage, « Routes » : « absent ou MESSAGERIE : comportement actuel ; MICROSOFT_365 : envoi par Graph ; toute
    // autre valeur : 400 « Canal d’envoi inconnu. » ». Avant tout appel à Graph, même avec un jeton.
    test('canal inconnu : 400 exact sur les cinq routes, sans appel à Graph ni écriture, même avec un jeton', async () => {
      for (const nature of Object.keys(CHEMINS)) {
        for (const canal of ['COURRIER', 'microsoft_365', 'Microsoft 365', 'messagerie', '', null, 42, true, ['MICROSOFT_365'], { canal: 'MICROSOFT_365' }]) {
          await refus(() => envoyer(nature, f.ids[nature], 'client@client-6b1b.test', { corps: { destinataire: 'client@client-6b1b.test', canal }, jeton: nouveauJeton(secours.email) }), 400, M365.CANAL_INCONNU, `${nature}, canal ${JSON.stringify(canal)}`, { me: false });
        }
      }
    });

    // ------------------------------------------------------------------------------------------------
    // Échecs de Graph (cadrage, « Échecs (B3) »).
    // ------------------------------------------------------------------------------------------------

    // (a) /me : « hors délai, coupé ou en 5xx : 502 « Microsoft 365 ne répond pas … » » ; « 401 ou 403 de Graph : 409
    // « Microsoft 365 refuse l’envoi … » » (consigne du code : sur /me comme sur sendMail). Rien n'est envoyé ni noté.
    test('/me en échec : 401 et 403 rendent 409 « refuse », 5xx, délai dépassé et coupure rendent 502 « ne répond pas » ; sendMail non appelé, rien d’écrit', async () => {
      const cas = [
        [{ statut: 401, corps: { error: { code: 'InvalidAuthenticationToken', message: 'TEST' } } }, 409, M365.REFUSE, '401'],
        [{ statut: 403, corps: { error: { code: 'Authorization_RequestDenied', message: 'TEST' } } }, 409, M365.REFUSE, '403'],
        [{ statut: 500, corps: { error: { code: 'InternalServerError', message: 'TEST' } } }, 502, M365.NE_REPOND_PAS, '500'],
        [{ statut: 503 }, 502, M365.NE_REPOND_PAS, '503'],
        [{ statut: 200, corps: { mail: secours.email }, delai: 6_000 }, 502, M365.NE_REPOND_PAS, 'délai dépassé'],
        [{ coupure: true }, 502, M365.NE_REPOND_PAS, 'coupure'],
      ];
      for (const nature of Object.keys(CHEMINS)) {
        for (const [regle, statut, corps, contexte] of cas) {
          await refus(async () => { graph.regler({ me: regle }); return envoyer(nature, f.ids[nature], 'client@client-6b1b.test', { jeton: nouveauJeton(secours.email) }); }, statut, corps, `${nature}, /me ${contexte}`, { me: true });
        }
      }
      assert.equal((await prisma.devis.findUniqueOrThrow({ where: { id: f.ids.devis } })).statut, 'BROUILLON', 'le devis brouillon reste brouillon');
    });

    // (a) sendMail : « 401 ou 403 de Graph : 409 » ; « Autre 4xx : 502 « Microsoft 365 a refusé l’envoi ; … » ».
    // (b) « Issue incertaine : délai dépassé, coupure ou 5xx de sendMail. Réponse 504 … ». Dans les deux cas, rien n'est
    // noté ; le devis brouillon reste brouillon.
    test('sendMail en échec : 401 et 403 rendent 409, autre 4xx 502, 5xx, délai dépassé et coupure 504 ; rien n’est noté, le brouillon reste brouillon', async () => {
      const cas = [
        [{ statut: 401, corps: { error: { code: 'InvalidAuthenticationToken', message: 'TEST' } } }, 409, M365.REFUSE, '401'],
        [{ statut: 403, corps: { error: { code: 'ErrorAccessDenied', message: 'TEST' } } }, 409, M365.REFUSE, '403 (boîte absente ou consentement manquant)'],
        [{ statut: 400, corps: { error: { code: 'ErrorInvalidRecipients', message: 'TEST' } } }, 502, M365.A_REFUSE, '400'],
        [{ statut: 404, corps: { error: { code: 'ResourceNotFound', message: 'TEST' } } }, 502, M365.A_REFUSE, '404'],
        [{ statut: 413 }, 502, M365.A_REFUSE, '413'],
        [{ statut: 429, entetes: { 'retry-after': '1' } }, 502, M365.A_REFUSE, '429'],
        [{ statut: 500 }, 504, M365.NON_CONFIRME, '500'],
        [{ statut: 502 }, 504, M365.NON_CONFIRME, '502'],
        [{ statut: 503, entetes: { 'retry-after': '1' } }, 504, M365.NON_CONFIRME, '503'],
        [{ statut: 202, delai: 8_000 }, 504, M365.NON_CONFIRME, 'délai dépassé'],
        [{ coupure: true }, 504, M365.NON_CONFIRME, 'coupure'],
      ];
      for (const nature of Object.keys(CHEMINS)) {
        for (const [regle, statut, corps, contexte] of cas) {
          await refus(async () => { graph.regler({ envoi: regle }); return envoyer(nature, f.ids[nature], 'client@client-6b1b.test', { jeton: nouveauJeton(secours.email) }); }, statut, corps, `${nature}, sendMail ${contexte}`, { me: true, envois: 1 });
        }
      }
      assert.equal((await prisma.devis.findUniqueOrThrow({ where: { id: f.ids.devis } })).statut, 'BROUILLON', 'le devis brouillon reste brouillon');
    });

    // Cadrage : « Les redirections sont refusées » (redirect: 'error') : le jeton ne part jamais vers l'adresse d'une
    // redirection. Lecture retenue, à confirmer : une redirection est un échec du transport, comme une coupure (502
    // pour /me, 504 pour sendMail).
    test('redirection de Graph : jamais suivie, le jeton ne part pas ailleurs ; /me redirigé rend 502, sendMail redirigé 504 ; rien d’écrit', async () => {
      const ailleurs = `${urlGraph}/ailleurs`;
      await refus(async () => { graph.regler({ me: { statut: 307, entetes: { location: ailleurs } } }); return envoyer('contrat', f.ids.contrat, 'client@client-6b1b.test', { jeton: nouveauJeton(secours.email) }); }, 502, M365.NE_REPOND_PAS, '/me redirigé', { me: true });
      await refus(async () => { graph.regler({ envoi: { statut: 308, entetes: { location: ailleurs } } }); return envoyer('contrat', f.ids.contrat, 'client@client-6b1b.test', { jeton: nouveauJeton(secours.email) }); }, 504, M365.NON_CONFIRME, 'sendMail redirigé', { me: true, envois: 1 });
    });

    // Cadrage, « Taille (N4) » : « La requête sendMail encodée, PDF en base64 compris, ne doit pas dépasser 4 Mo […]. Au-
    // delà : 413 « Le PDF dépasse la taille d’envoi par Microsoft 365 : préparez l’envoi par la messagerie. », sans
    // appel à Graph » (sendMail ; /me est lu avant). Un compte rendu d'environ 3 millions de caractères à forte
    // entropie donne un PDF dont le base64 seul dépasse la limite (vérifié par la route « PDF ») : le refus n'est pas
    // vide de sens. Le verdict de /me et le mode passent avant la taille.
    test('PDF trop lourd : 413 exact sans appel à sendMail ni écriture ; le mode et l’expéditeur passent avant la taille', async () => {
      const s = suffixe();
      // Intervention sans chantier : le rapport du chantier de référence, qui réunit les comptes rendus de ses
      // interventions, reste léger pour les autres tests.
      const lourde = await creerIntervention({ clientId: f.client.id, titre: `TEST Intervention au compte rendu lourd ${s}` });
      await demarrer(lourde.id);
      await prisma.interventionRapport.create({ data: { interventionId: lourde.id, auteurId: secours.id, contenu: texteLourd(3_200_000) } });
      const pdf = await lirePdf('compteRendu', lourde.id);
      assert.ok(Math.ceil(pdf.octets.length / 3) * 4 > LIMITE_SENDMAIL, `PDF de ${pdf.octets.length} octets : son base64 doit dépasser ${LIMITE_SENDMAIL} octets`);
      await refus(() => envoyer('compteRendu', lourde.id, 'client@client-6b1b.test', { jeton: nouveauJeton(secours.email) }), 413, M365.TROP_LOURD, 'compte rendu lourd', { me: true });
      await refus(() => envoyer('compteRendu', lourde.id, 'client@client-6b1b.test', { jeton: nouveauJeton('autre.personne@iris.test') }), 403, M365.EXPEDITEUR, 'compte rendu lourd, autre boîte', { me: true });
      await avecMode('MESSAGERIE', () => refus(() => envoyer('compteRendu', lourde.id, 'client@client-6b1b.test', { jeton: nouveauJeton(secours.email) }), 409, M365.DESACTIVE, 'compte rendu lourd, mode messagerie'));
      // La messagerie, elle, ne joint rien : elle reste disponible.
      const messagerie = await envoyer('compteRendu', lourde.id, 'client@client-6b1b.test', { canal: 'MESSAGERIE' });
      assert.equal(messagerie.status, 201, JSON.stringify(messagerie.body));
    });

    // ------------------------------------------------------------------------------------------------
    // Ordre des contrôles (cadrage, « Ordre des contrôles (B4) »), pour chacune des cinq routes.
    // ------------------------------------------------------------------------------------------------

    // « 1. Gardes : 401 et 403 […]. 2. Destinataire invalide, ou canal inconnu : 400. 3. Document introuvable ou hors
    // périmètre : 404. 4. Document annulé, ou devis refusé : 409. 5. Refus propres au document : 409. 6. Identité de la
    // société incomplète : 409. […] Pour MICROSOFT_365 seulement, quatre autres suivent : mode d'envoi et configuration :
    // 409 ; jeton absent : 400 ; expéditeur : 403 ; PDF trop lourd : 413 » ; consigne du code : configuration, puis mode ;
    // « /me est lu avant la première transaction, mais son verdict n'est rendu qu'à sa place dans l'ordre ». Chaque
    // refus est provoqué avec les suivants aussi présents : le premier dans l'ordre l'emporte.
    test('ordre des contrôles sur les cinq routes : gardes, destinataire et canal, introuvable, annulé, refus propre, identité, configuration, mode, jeton, expéditeur', async () => {
      const s = suffixe();
      const c = f.comptes;
      const devisAnnule = await creerDevis(f.client.id, `TEST Devis annulé ordre ${s}`);
      await annulerDevis(devisAnnule.id);
      const devisRefuse = await creerDevis(f.client.id, `TEST Devis refusé ordre ${s}`);
      await statutDevis(devisRefuse.id, 'ENVOYE');
      await statutDevis(devisRefuse.id, 'REFUSE');
      const factureBrouillon = await creerBrouillonFacture(f.client.id, [{ designation: 'TEST Brouillon ordre 6b1b', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }], 'TEST brouillon ordre 6b1b');
      const interventionAnnulee = await creerIntervention({ clientId: f.client.id, chantierId: f.chantier.id, titre: `TEST Intervention annulée ordre ${s}` });
      await demarrer(interventionAnnulee.id);
      await ajouterCompteRendu(interventionAnnulee.id, 'TEST Compte rendu d’une annulée 6b1b.');
      await changerStatut(interventionAnnulee.id, 'ANNULEE', { motif: 'TEST annulation ordre 6b1b' });
      const sansCompteRendu = await creerIntervention({ clientId: f.client.id, chantierId: f.chantier.id, titre: `TEST Intervention sans compte rendu ordre ${s}` });
      await demarrer(sansCompteRendu.id);
      const { contrat: contratAnnule, annuler: annulerContrat } = await contratDeDevis(f.client.id, `TEST Contrat annulé ordre ${s}`);
      await annulerContrat();
      const { chantier: chantierAnnule, annuler: annulerChantier } = await chantierConverti(f.client.id, `TEST Chantier annulé ordre ${s}`);
      await annulerChantier();

      const routes = {
        devis: {
          gardes: [[parCompte(c.directeur), REFUS_DEVIS_WRITE, 'DIRECTEUR'], [parCompte(c.technicienAffecte), REFUS_DEVIS_WRITE, 'TECHNICIEN aux droits devis']],
          introuvables: [[randomUUID(), DEVIS_INTROUVABLE, admin()], [f.facture.id, DEVIS_INTROUVABLE, admin()]],
          annules: [[devisAnnule.id, DEVIS_ANNULE], [devisRefuse.id, DEVIS_ANNULE]],
          propres: [],
          identite: identiteIncomplete('SIRET, ville', 'un devis'),
        },
        facture: {
          gardes: [[parCompte(c.comptable), REFUS_ADMINISTRATION, 'COMPTABLE'], [parCompte(c.directeurTousDroits), REFUS_ADMINISTRATION, 'DIRECTEUR tous droits']],
          introuvables: [[randomUUID(), FACTURE_INTROUVABLE, admin()], [f.devis.id, FACTURE_INTROUVABLE, admin()]],
          annules: [],
          propres: [[factureBrouillon.id, FACTURE_NON_EMISE]],
          identite: null,
        },
        compteRendu: {
          gardes: [[parCompte(c.commercial), REFUS_COMMERCIAL, 'COMMERCIAL'], [parCompte(c.directeurTousDroits), REFUS_DIRECTEUR, 'DIRECTEUR'], [parCompte(c.technicienAffecte), REFUS_TECHNICIEN, 'TECHNICIEN affecté'], [parCompte(c.responsable), REFUS_CLIENTS_READ, 'RESPONSABLE sans clients:read']],
          introuvables: [[randomUUID(), INTERVENTION_INTROUVABLE, admin()], [f.intervention.id, INTERVENTION_INTROUVABLE, parCompte(c.conducteurTiers)]],
          annules: [[interventionAnnulee.id, INTERVENTION_ANNULEE]],
          propres: [[sansCompteRendu.id, AUCUN_COMPTE_RENDU]],
          identite: identiteIncomplete('SIRET, ville', 'un compte rendu'),
        },
        contrat: {
          gardes: [[parCompte(c.conducteur), REFUS_ADMINISTRATION, 'CONDUCTEUR_TRAVAUX'], [parCompte(c.commercial), REFUS_ADMINISTRATION, 'COMMERCIAL']],
          introuvables: [[randomUUID(), CONTRAT_INTROUVABLE, admin()], [f.intervention.id, CONTRAT_INTROUVABLE, admin()]],
          annules: [[contratAnnule.id, CONTRAT_ANNULE]],
          propres: [],
          identite: identiteIncomplete('SIRET, ville', 'un contrat'),
        },
        chantier: {
          gardes: [[parCompte(c.conducteur), REFUS_ADMINISTRATION, 'CONDUCTEUR_TRAVAUX titulaire'], [parCompte(c.responsable), REFUS_ADMINISTRATION, 'RESPONSABLE']],
          introuvables: [[randomUUID(), CHANTIER_INTROUVABLE, admin()], [f.contrat.id, CHANTIER_INTROUVABLE, admin()]],
          annules: [[chantierAnnule.id, CHANTIER_ANNULE]],
          propres: [],
          identite: identiteIncomplete('SIRET, ville', 'un rapport de chantier'),
        },
      };
      const VALIDE = 'client@client-6b1b.test';
      const INVALIDE = 'pas-une-adresse';
      for (const [nature, r] of Object.entries(routes)) {
        const valide = f.ids[nature];
        const [introuvable] = r.introuvables[0];
        // 1. Sans session : 401, avant tout, conditions défavorables comprises.
        await toutDefavorable(() => refus(() => envoyer(nature, introuvable, INVALIDE, { auth: null }), 401, SANS_SESSION, `${nature} : session`, { me: false }));
        await refus(() => envoyer(nature, valide, VALIDE, { auth: null, jeton: nouveauJeton(secours.email) }), 401, SANS_SESSION, `${nature} : session, avec un jeton`, { me: false });
        // 1. Gardes : 403, avant destinataire, canal, document et tout contrôle Microsoft 365.
        for (const [auth, corps, libelle] of r.gardes) {
          await toutDefavorable(() => refus(() => envoyer(nature, introuvable, INVALIDE, { auth }), 403, corps, `${nature} : garde ${libelle}`, { me: false }));
          await refus(() => envoyer(nature, valide, VALIDE, { auth, jeton: nouveauJeton(secours.email) }), 403, corps, `${nature} : garde ${libelle}, avec un jeton`, { me: false });
        }
        // 2. Destinataire et canal : 400, avant le document et sans aucun appel à Graph, même avec un jeton valide.
        await toutDefavorable(() => refus(() => envoyer(nature, introuvable, INVALIDE), 400, REFUS_DESTINATAIRE, `${nature} : destinataire`, { me: false }));
        await refus(() => envoyer(nature, introuvable, INVALIDE, { jeton: nouveauJeton(secours.email) }), 400, REFUS_DESTINATAIRE, `${nature} : destinataire, avec un jeton`, { me: false });
        await toutDefavorable(() => refus(() => envoyer(nature, introuvable, VALIDE, { canal: 'COURRIER' }), 400, M365.CANAL_INCONNU, `${nature} : canal`, { me: false }));
        await refus(() => envoyer(nature, introuvable, VALIDE, { canal: 'COURRIER', jeton: nouveauJeton(secours.email) }), 400, M365.CANAL_INCONNU, `${nature} : canal, avec un jeton`, { me: false });
        // 3. Introuvable ou hors périmètre : 404, avant les contrôles Microsoft 365 ; le verdict de /me attend sa place.
        for (const [id, corps, auth] of r.introuvables) {
          await toutDefavorable(() => refus(() => envoyer(nature, id, VALIDE, { auth }), 404, corps, `${nature} : introuvable ${id}`, { me: false }));
          await refus(() => envoyer(nature, id, VALIDE, { auth, jeton: nouveauJeton('autre.personne@iris.test') }), 404, corps, `${nature} : introuvable ${id}, autre boîte`);
          await refus(async () => { graph.regler({ me: { statut: 503 } }); return envoyer(nature, id, VALIDE, { auth, jeton: nouveauJeton(secours.email) }); }, 404, corps, `${nature} : introuvable ${id}, /me en 503`);
        }
        // 4 et 5. Annulé ou refusé, puis refus propre : 409, avant l'identité et les contrôles Microsoft 365.
        for (const [id, corps] of [...r.annules, ...r.propres]) {
          await toutDefavorable(() => refus(() => envoyer(nature, id, VALIDE), 409, corps, `${nature} : ${corps.error}`, { me: false }));
          await refus(() => envoyer(nature, id, VALIDE, { jeton: nouveauJeton('autre.personne@iris.test') }), 409, corps, `${nature} : ${corps.error}, autre boîte`);
          await refus(async () => { graph.regler({ me: { statut: 401 } }); return envoyer(nature, id, VALIDE, { jeton: nouveauJeton(secours.email) }); }, 409, corps, `${nature} : ${corps.error}, /me en 401`);
          await avecSociete({ siret: '', ville: '' }, () => refus(() => envoyer(nature, id, VALIDE, { jeton: nouveauJeton(secours.email) }), 409, corps, `${nature} : ${corps.error}, identité incomplète`));
        }
        // 6. Identité de la société incomplète : 409, avant les contrôles Microsoft 365.
        if (r.identite) {
          await avecSociete({ siret: '', ville: '' }, async () => {
            await toutDefavorable(() => refus(() => envoyer(nature, valide, VALIDE), 409, r.identite, `${nature} : identité`, { me: false }));
            await refus(() => envoyer(nature, valide, VALIDE, { jeton: nouveauJeton('autre.personne@iris.test') }), 409, r.identite, `${nature} : identité, autre boîte`);
          });
        }
        // Configuration, puis mode : 409, avant le jeton et le verdict de /me.
        await toutDefavorable(() => refus(() => envoyer(nature, valide, VALIDE), 409, M365.NON_CONFIGURE, `${nature} : configuration avant mode et jeton`, { me: false }));
        await avecMode('MESSAGERIE', async () => {
          await refus(() => envoyer(nature, valide, VALIDE), 409, M365.DESACTIVE, `${nature} : mode avant jeton`, { me: false });
          await refus(() => envoyer(nature, valide, VALIDE, { jeton: nouveauJeton('autre.personne@iris.test') }), 409, M365.DESACTIVE, `${nature} : mode avant expéditeur`);
          await refus(async () => { graph.regler({ me: { statut: 500 } }); return envoyer(nature, valide, VALIDE, { jeton: nouveauJeton(secours.email) }); }, 409, M365.DESACTIVE, `${nature} : mode avant /me en 500`);
        });
        // Jeton absent : 400, sans appel à /me.
        await refus(() => envoyer(nature, valide, VALIDE), 400, M365.JETON_ABSENT, `${nature} : jeton`, { me: false });
        // Verdict de /me, à sa place.
        await refus(() => envoyer(nature, valide, VALIDE, { jeton: nouveauJeton('autre.personne@iris.test') }), 403, M365.EXPEDITEUR, `${nature} : expéditeur`, { me: true });
      }
    });

    // ------------------------------------------------------------------------------------------------
    // Échec après l'envoi (c), et devis entre les deux transactions (V1).
    // ------------------------------------------------------------------------------------------------

    // Cadrage, (c) : « 202, puis échec de la transaction 2. Réponse 500 « Le courriel est parti par Microsoft 365, mais
    // son envoi n’a pas pu être noté au journal. ». Une trace serveur est écrite, sans le jeton, avec l'identifiant
    // x-iris-envoi. » La transaction 2 est forcée en échec par un déclencheur temporaire, posé dans la base jetable de ce
    // fichier, qui refuse l'insertion d'une ligne du journal pour un destinataire précis, puis retiré.
    test('cas (c) : sendMail accepté puis journal impossible : 500 exact qui dit que le courriel est parti, rien d’écrit, trace serveur avec x-iris-envoi et sans le jeton', async () => {
      const DESTINATAIRE_EN_ECHEC = 'echec-journal@client-6b1b.test';
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_6b1b_echec_journal() RETURNS trigger AS $$ BEGIN
        IF NEW."destinataire" = '${DESTINATAIRE_EN_ECHEC}' THEN RAISE EXCEPTION 'TEST échec forcé du journal des envois 6b1b'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe('CREATE TRIGGER test_6b1b_echec_journal BEFORE INSERT ON "EnvoiDocument" FOR EACH ROW EXECUTE FUNCTION test_6b1b_echec_journal()');
      try {
        const devis = await creerDevis(f.client.id, `TEST Devis au journal impossible ${suffixe()}`);
        for (const [nature, id] of [['devis', devis.id], ...Object.entries(f.ids).filter(([nature]) => nature !== 'devis')]) {
          const jeton = nouveauJeton(secours.email);
          const debut = sortieConsole.length;
          await refus(() => envoyer(nature, id, DESTINATAIRE_EN_ECHEC, { jeton }), 500, M365.NON_NOTE, `${nature} : journal impossible`, { me: true, envois: 1 });
          const [envoi] = graph.requetes('envoi');
          assert.equal(envoi.json?.message?.toRecipients?.[0]?.emailAddress?.address, DESTINATAIRE_EN_ECHEC, `${nature} : le courriel est bien parti`);
          const identifiant = envoi.json?.message?.internetMessageHeaders?.find((entete) => entete.name === 'x-iris-envoi')?.value;
          assert.ok(identifiant, `${nature} : en-tête x-iris-envoi`);
          assert.equal(await prisma.envoiDocument.count({ where: { id: identifiant } }), 0, `${nature} : rien n’est noté`);
          const traces = sortieConsole.slice(debut);
          assert.ok(traces.some((trace) => trace.methode === 'error' && trace.texte.includes(identifiant)), `${nature} : une trace serveur porte ${identifiant}\n${traces.map((trace) => trace.texte).join('\n')}`);
          for (const trace of traces) {
            assert.ok(!trace.texte.includes(jeton), `${nature} : le jeton est écrit dans une trace`);
            assert.ok(!trace.texte.includes(envoi.json.message.attachments[0].contentBytes.slice(0, 200)), `${nature} : le PDF est écrit dans une trace`);
          }
        }
        assert.equal((await prisma.devis.findUniqueOrThrow({ where: { id: devis.id } })).statut, 'BROUILLON', 'la transaction 2 annulée ne laisse pas le devis « envoyé »');
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_6b1b_echec_journal ON "EnvoiDocument"');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_6b1b_echec_journal()');
      }
    });

    // Cadrage, V1 : « Pour un devis, elle prend verrouillerDevis et relit son statut. Seul un devis encore BROUILLON passe
    // ENVOYE […]. Un devis annulé ou signé entre-temps garde son statut. La réponse porte le statutDevis relu » ; « Elle
    // n'applique pas de nouveau les refus : le courriel est parti, le journal doit le dire, même si le document a été
    // annulé entre-temps ». Le simulateur annule (ou signe) le devis par l'API pendant qu'il fait attendre sendMail ;
    // facultatif du cadrage : de même pour une intervention et un chantier annulés.
    test('devis annulé ou signé entre les deux transactions : il garde son statut, l’envoi est noté ; un devis déjà envoyé garde le sien ; intervention et chantier annulés entre-temps, envoi noté', async () => {
      const s = suffixe();
      const pendantEnvoi = (action) => graph.regler({ envoi: { statut: 202, avant: action } });
      // Annulé pendant sendMail.
      const annule = await creerDevis(f.client.id, `TEST Devis annulé pendant l’envoi ${s}`);
      const pdfAnnule = await lirePdf('devis', annule.id);
      graph.reinitialiser();
      pendantEnvoi(() => annulerDevis(annule.id));
      const resAnnule = await envoyer('devis', annule.id, 'client@client-6b1b.test', { jeton: nouveauJeton(secours.email) });
      assert.equal(resAnnule.status, 201, JSON.stringify(resAnnule.body));
      assert.equal(resAnnule.body.statutDevis, 'ANNULE');
      assert.equal((await prisma.devis.findUniqueOrThrow({ where: { id: annule.id } })).statut, 'ANNULE');
      const ligneAnnule = await ligneEnvoi(resAnnule.body.envoi.id);
      assert.deepEqual([ligneAnnule.devisId, ligneAnnule.canal, ligneAnnule.expediteur], [annule.id, 'MICROSOFT_365', secours.email]);
      assert.equal(normaliser(Buffer.from(graph.requetes('envoi')[0].json.message.attachments[0].contentBytes, 'base64')), normaliser(pdfAnnule.octets));
      // Signé pendant sendMail.
      const signe = await creerDevis(f.client.id, `TEST Devis signé pendant l’envoi ${s}`);
      graph.reinitialiser();
      pendantEnvoi(() => signerDevis(signe.id));
      const resSigne = await envoyer('devis', signe.id, 'client@client-6b1b.test', { jeton: nouveauJeton(secours.email) });
      assert.equal(resSigne.status, 201, JSON.stringify(resSigne.body));
      assert.equal(resSigne.body.statutDevis, 'ACCEPTE');
      assert.equal((await prisma.devis.findUniqueOrThrow({ where: { id: signe.id } })).statut, 'ACCEPTE');
      assert.equal(await prisma.envoiDocument.count({ where: { devisId: signe.id } }), 1);
      // Déjà envoyé : il le reste, et n'est pas réécrit.
      const envoye = await creerDevis(f.client.id, `TEST Devis déjà envoyé ${s}`);
      await statutDevis(envoye.id, 'ENVOYE');
      await envoiAccepte({
        nature: 'devis', id: envoye.id, destinataire: 'client@client-6b1b.test', ...TEXTES.devis(envoye, SOCIETE.raisonSociale),
        jeton: nouveauJeton(secours.email), statutDevis: 'ENVOYE', contexte: 'devis déjà envoyé',
      });
      // Intervention annulée pendant sendMail.
      const intervention = await creerIntervention({ clientId: f.client.id, chantierId: f.chantier.id, titre: `TEST Intervention annulée pendant l’envoi ${s}` });
      await demarrer(intervention.id);
      await ajouterCompteRendu(intervention.id, 'TEST Compte rendu annulé pendant l’envoi.');
      graph.reinitialiser();
      pendantEnvoi(() => changerStatut(intervention.id, 'ANNULEE', { motif: 'TEST annulation pendant l’envoi 6b1b' }));
      const resIntervention = await envoyer('compteRendu', intervention.id, 'client@client-6b1b.test', { jeton: nouveauJeton(secours.email) });
      assert.equal(resIntervention.status, 201, JSON.stringify(resIntervention.body));
      assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id: intervention.id } })).statut, 'ANNULEE');
      assert.equal((await ligneEnvoi(resIntervention.body.envoi.id))?.interventionId, intervention.id);
      // Chantier annulé (avec son devis) pendant sendMail.
      const { chantier, annuler } = await chantierConverti(f.client.id, `TEST Chantier annulé pendant l’envoi ${s}`);
      graph.reinitialiser();
      pendantEnvoi(() => annuler());
      const resChantier = await envoyer('chantier', chantier.id, 'client@client-6b1b.test', { jeton: nouveauJeton(secours.email) });
      assert.equal(resChantier.status, 201, JSON.stringify(resChantier.body));
      assert.equal((await prisma.chantier.findUniqueOrThrow({ where: { id: chantier.id } })).statut, 'ANNULE');
      assert.equal((await ligneEnvoi(resChantier.body.envoi.id))?.chantierId, chantier.id);
      graph.reinitialiser();
    });

    // ------------------------------------------------------------------------------------------------
    // Mode d'envoi : PUT et GET /api/modules (cadrage, « Paramètre », B7 et V2).
    // ------------------------------------------------------------------------------------------------

    const journalModules = async (depuis) => prisma.journalAdministration.findMany({ where: { type: 'MODULES', createdAt: { gte: depuis } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const parametres = async () => (await prisma.$queryRaw`SELECT "planningActif", "modeEnvoi" FROM "Parametres" WHERE "id" = 'singleton'`)[0];

    // « PUT /api/modules réglé champ par champ (V2) » : un champ absent garde sa valeur ; la réponse rend aussi
    // modeEnvoi ; « Le mode d'envoi a sa propre ligne de journal (JournalAdministration : réglage « Mode d'envoi des
    // documents », action MODIFICATION, ancienne et nouvelle valeur), distincte de celle du planning » ; « GET
    // /api/modules rend le mode actuel ». Valeur par défaut : MICROSOFT_365 (A10).
    test('mode d’envoi : MICROSOFT_365 par défaut ; PUT /api/modules partiel, le mode et le planning ne se touchent pas ; une ligne de journal par réglage changé ; GET /api/modules rend le mode', async () => {
      const technicien = f.comptes.technicienNonAffecte;
      const lireModules = async (auth) => ok(appeler('get', '/modules', null, auth));
      assert.deepEqual(await parametres(), { planningActif: true, modeEnvoi: 'MICROSOFT_365' }, 'valeurs par défaut');
      const initial = await lireModules(admin());
      assert.deepEqual(Object.keys(initial).sort(), ['libelleBaremeReduit', 'modeEnvoi', 'planningActif', 'planningActifGlobal']);
      assert.equal(initial.modeEnvoi, 'MICROSOFT_365');
      assert.equal((await lireModules(parCompte(technicien))).modeEnvoi, 'MICROSOFT_365');
      const [{ debut }] = await prisma.$queryRaw`SELECT now() AS debut`;
      try {
        // Le mode seul : le planning garde sa valeur ; une ligne « Mode d’envoi des documents ».
        const mode = await ok(appeler('put', '/modules', { modeEnvoi: 'MESSAGERIE' }));
        assert.deepEqual(mode, { planningActif: true, planningActifGlobal: true, modeEnvoi: 'MESSAGERIE' });
        assert.deepEqual(await parametres(), { planningActif: true, modeEnvoi: 'MESSAGERIE' });
        let journal = await journalModules(debut);
        assert.equal(journal.length, 1, JSON.stringify(journal));
        assert.deepEqual(
          [journal[0].domaine, journal[0].type, journal[0].action, journal[0].cibleLibelle, journal[0].avant, journal[0].apres, journal[0].auteurId],
          ['REGLAGES', 'MODULES', 'MODIFICATION', 'Mode d’envoi des documents', { modeEnvoi: 'MICROSOFT_365' }, { modeEnvoi: 'MESSAGERIE' }, secours.id],
        );
        assert.equal((await lireModules(parCompte(technicien))).modeEnvoi, 'MESSAGERIE');
        assert.equal((await lireModules(admin())).modeEnvoi, 'MESSAGERIE');
        // Le planning seul : le mode garde sa valeur ; une ligne « Planning », sans le mode.
        const planning = await ok(appeler('put', '/modules', { planningActif: false }));
        assert.deepEqual(planning, { planningActif: true, planningActifGlobal: false, modeEnvoi: 'MESSAGERIE' });
        assert.deepEqual(await parametres(), { planningActif: false, modeEnvoi: 'MESSAGERIE' });
        journal = await journalModules(debut);
        assert.equal(journal.length, 2, JSON.stringify(journal));
        assert.deepEqual([journal[1].action, journal[1].cibleLibelle, journal[1].avant, journal[1].apres], ['DESACTIVATION', 'Planning', { planningActif: true }, { planningActif: false }]);
        const luTechnicien = await lireModules(parCompte(technicien));
        assert.deepEqual([luTechnicien.planningActif, luTechnicien.planningActifGlobal, luTechnicien.modeEnvoi], [false, false, 'MESSAGERIE']);
        // Rien à changer : aucun réglage modifié, aucune ligne de journal (seule la date technique de mise à jour des
        // paramètres peut bouger, comme avant le lot).
        const reglages = async () => (await prisma.$queryRaw`SELECT row_to_json(p)::jsonb - 'updatedAt' AS ligne FROM "Parametres" p`).map((r) => r.ligne);
        for (const corps of [{}, { modeEnvoi: 'MESSAGERIE' }, { planningActif: false }, { modeEnvoi: 'MESSAGERIE', planningActif: false }]) {
          const avant = await etatBase();
          const reglagesAvant = await reglages();
          assert.deepEqual(await ok(appeler('put', '/modules', corps)), { planningActif: true, planningActifGlobal: false, modeEnvoi: 'MESSAGERIE' }, JSON.stringify(corps));
          const apres = await etatBase();
          for (const table of TABLES.filter((nom) => nom !== 'Parametres')) assert.equal(apres[table], avant[table], `${JSON.stringify(corps)} : ${table} modifiée`);
          assert.deepEqual(await reglages(), reglagesAvant, `${JSON.stringify(corps)} : réglages modifiés`);
        }
        // Les deux à la fois : deux lignes distinctes, chacune pour son réglage.
        assert.deepEqual(await ok(appeler('put', '/modules', { planningActif: true, modeEnvoi: 'MICROSOFT_365' })), { planningActif: true, planningActifGlobal: true, modeEnvoi: 'MICROSOFT_365' });
        journal = await journalModules(debut);
        assert.equal(journal.length, 4, JSON.stringify(journal));
        const nouvelles = journal.slice(2).map((ligne) => [ligne.action, ligne.cibleLibelle, ligne.avant, ligne.apres]).sort((a, b) => a[1].localeCompare(b[1]));
        assert.deepEqual(nouvelles, [
          ['MODIFICATION', 'Mode d’envoi des documents', { modeEnvoi: 'MESSAGERIE' }, { modeEnvoi: 'MICROSOFT_365' }],
          ['ACTIVATION', 'Planning', { planningActif: false }, { planningActif: true }],
        ]);
      } finally {
        await prisma.$executeRaw`UPDATE "Parametres" SET "modeEnvoi" = 'MICROSOFT_365', "planningActif" = true WHERE "id" = 'singleton'`;
      }
    });

    // « Un modeEnvoi invalide est refusé (400), comme un planningActif présent mais non booléen (400, choix le plus
    // restrictif, à confirmer) » ; rien n'est écrit, pas même le champ valide d'un même corps. Messages : ceux que
    // la consigne du code laisse écrire à son agent.
    const REFUS_PLANNING = { error: 'L’activation du planning se règle par oui ou non.' };
    const REFUS_MODE = { error: 'Mode d’envoi des documents inconnu : choisissez MICROSOFT_365 ou MESSAGERIE.' };
    test('mode d’envoi : 400 pour un modeEnvoi invalide ou un planningActif présent mais non booléen, sans rien écrire, pas même l’autre champ valide', async () => {
      for (const corps of [
        { modeEnvoi: 'messagerie' }, { modeEnvoi: 'OUTLOOK' }, { modeEnvoi: 'MICROSOFT 365' }, { modeEnvoi: '' }, { modeEnvoi: null }, { modeEnvoi: 42 }, { modeEnvoi: true }, { modeEnvoi: ['MESSAGERIE'] }, { modeEnvoi: {} },
        { planningActif: 'true' }, { planningActif: 'false' }, { planningActif: 1 }, { planningActif: 0 }, { planningActif: null }, { planningActif: 'oui' }, { planningActif: [] },
        { modeEnvoi: 'MESSAGERIE', planningActif: 'non' }, { modeEnvoi: 'AUCUN', planningActif: false },
      ]) {
        const avant = await etatBase();
        const res = await appeler('put', '/modules', corps);
        assert.equal(res.status, 400, `${JSON.stringify(corps)} : ${res.status} ${JSON.stringify(res.body)}`);
        assert.deepEqual(res.body, 'modeEnvoi' in corps && !['MESSAGERIE', 'MICROSOFT_365'].includes(corps.modeEnvoi) ? REFUS_MODE : REFUS_PLANNING, JSON.stringify(corps));
        assert.deepEqual(await etatBase(), avant, `${JSON.stringify(corps)} : rien n’est écrit`);
      }
      assert.deepEqual(await parametres(), { planningActif: true, modeEnvoi: 'MICROSOFT_365' });
    });

    // B7 : « Qui le règle : le super administrateur, par PUT /api/modules (choix le plus restrictif, à confirmer) » ;
    // « 403 pour l'administration et les autres comptes ». En session seulement : ni visiteur ni clé d'intégration.
    test('mode d’envoi : réglé par le super administrateur seul ; 403 exact pour l’administration et tout autre compte, 401 sans session ou par une clé, sans rien écrire', async () => {
      const cle = await ok(appeler('post', '/admin/api-keys', { nom: `TEST clé modules 6b1b ${suffixe()}`, scopes: TOUS_LES_SCOPES }), 201);
      for (const corps of [{ modeEnvoi: 'MESSAGERIE' }, { planningActif: false }, { modeEnvoi: 'MESSAGERIE', planningActif: false }]) {
        for (const [libelle, compte] of Object.entries(f.comptes)) {
          const avant = await etatBase();
          const res = await appeler('put', '/modules', corps, parCompte(compte));
          assert.equal(res.status, 403, `${libelle} : ${res.status} ${JSON.stringify(res.body)}`);
          assert.deepEqual(res.body, REFUS_SUPER_ADMINISTRATION, libelle);
          assert.deepEqual(await etatBase(), avant, `${libelle} : rien n’est écrit`);
        }
        for (const [libelle, auth, attendu] of [['sans session', null, SANS_SESSION], ['clé d’intégration', entete(cle.apiKey), SESSION_INVALIDE]]) {
          const avant = await etatBase();
          const res = await appeler('put', '/modules', corps, auth);
          assert.equal(res.status, 401, libelle);
          assert.deepEqual(res.body, attendu, libelle);
          assert.deepEqual(await etatBase(), avant, `${libelle} : rien n’est écrit`);
        }
      }
      assert.deepEqual(await parametres(), { planningActif: true, modeEnvoi: 'MICROSOFT_365' });
    });

    // « Parametres.modeEnvoi vaut MICROSOFT_365 ou MESSAGERIE, avec un CHECK en base. Sa valeur par défaut est
    // MICROSOFT_365 ».
    test('mode d’envoi en base : valeur par défaut MICROSOFT_365, CHECK qui refuse toute autre valeur', async () => {
      const [colonne] = await prisma.$queryRaw`SELECT column_default, is_nullable, data_type FROM information_schema.columns WHERE table_name = 'Parametres' AND column_name = 'modeEnvoi'`;
      assert.match(colonne?.column_default ?? '', /^'MICROSOFT_365'/, JSON.stringify(colonne));
      assert.equal(colonne.is_nullable, 'NO');
      for (const valeur of ['AUTRE', 'messagerie', 'microsoft_365', '']) {
        await assert.rejects(prisma.$executeRaw`UPDATE "Parametres" SET "modeEnvoi" = ${valeur} WHERE "id" = 'singleton'`, /23514|violates check constraint/, valeur);
      }
      await assert.rejects(prisma.$executeRaw`UPDATE "Parametres" SET "modeEnvoi" = NULL WHERE "id" = 'singleton'`, /23502|23514|null value|violates/);
      for (const valeur of ['MESSAGERIE', 'MICROSOFT_365']) assert.equal(await prisma.$executeRaw`UPDATE "Parametres" SET "modeEnvoi" = ${valeur} WHERE "id" = 'singleton'`, 1);
      assert.equal(await lireMode(), 'MICROSOFT_365');
    });

    // ------------------------------------------------------------------------------------------------
    // Migration du journal (cadrage, « Journal (migration ; B6, N13) »).
    // ------------------------------------------------------------------------------------------------

    const contraintesEnvoi = async () => prisma.$queryRaw`SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = '"EnvoiDocument"'::regclass AND contype = 'c' ORDER BY conname`;
    const insererEnvoi = ({ devisId, canal = 'MESSAGERIE', expediteur = null, empreintePdf = null, corps = null, createdAt = null }) => prisma.$executeRaw`
      INSERT INTO "EnvoiDocument" ("id", "devisId", "canal", "destinataire", "objet", "auteurId", "auteurNom", "expediteur", "empreintePdf", "corps", "createdAt")
      VALUES (${randomUUID()}, ${devisId}, ${canal}, 'client@client-6b1b.test', 'TEST Objet 6b1b', ${secours.id}, 'TEST Auteur 6b1b', ${expediteur}, ${empreintePdf}, ${corps}, COALESCE(${createdAt}::timestamptz, now()))`;

    // « Canal : le CHECK EnvoiDocument_canal admet MESSAGERIE et MICROSOFT_365 » ; « Trois colonnes facultatives, chacune
    // exigée pour MICROSOFT_365 et nulle pour MESSAGERIE, par des CHECK de la forme CASE WHEN "canal" = 'MICROSOFT_365'
    // THEN btrim("expediteur") <> '' ELSE "expediteur" IS NULL END ». Chaque refus nomme la contrainte de sa colonne.
    test('migration : canal MESSAGERIE ou MICROSOFT_365 ; expediteur, empreintePdf et corps exigés pour Microsoft 365 et nuls pour la messagerie, par un CHECK chacun ; empreinte de 64 caractères hexadécimaux minuscules', async () => {
      const contraintes = await contraintesEnvoi();
      const canal = contraintes.find((contrainte) => contrainte.conname === 'EnvoiDocument_canal');
      assert.deepEqual([...(canal?.definition ?? '').matchAll(/'([^']*)'/g)].map((litteral) => litteral[1]).sort(), ['MESSAGERIE', 'MICROSOFT_365'], canal?.definition);
      const nomDe = (colonne) => {
        const nomme = new RegExp(`(^|[^A-Za-z"])"?${colonne}"?([^A-Za-z"]|$)`);
        const trouvees = contraintes.filter((contrainte) => nomme.test(contrainte.definition) && contrainte.definition.includes('MICROSOFT_365'));
        assert.equal(trouvees.length, 1, `${colonne} : ${JSON.stringify(contraintes)}`);
        return trouvees[0].conname;
      };
      const noms = { expediteur: nomDe('expediteur'), empreintePdf: nomDe('empreintePdf'), corps: nomDe('corps') };
      const devis = await creerDevis(f.client.id, `TEST Devis des contraintes ${suffixe()}`);
      const EMPREINTE = sha256(Buffer.from('TEST PDF 6b1b'));
      const M365_VALIDE = { devisId: devis.id, canal: 'MICROSOFT_365', expediteur: 'secours@iris.test', empreintePdf: EMPREINTE, corps: 'TEST Bonjour 6b1b' };
      const avant = await prisma.envoiDocument.count();
      const refusees = [
        [{ devisId: devis.id, canal: 'COURRIER' }, 'EnvoiDocument_canal'],
        [{ devisId: devis.id, canal: 'microsoft_365' }, 'EnvoiDocument_canal'],
        ...Object.keys(noms).flatMap((colonne) => [
          [{ devisId: devis.id, [colonne]: M365_VALIDE[colonne] }, noms[colonne]],
          [{ ...M365_VALIDE, [colonne]: null }, noms[colonne]],
          [{ ...M365_VALIDE, [colonne]: '' }, noms[colonne]],
          [{ ...M365_VALIDE, [colonne]: '   ' }, noms[colonne]],
        ]),
        // Consigne du code : « l'empreinte : 64 caractères hexadécimaux en minuscules, à vérifier par le CHECK ».
        ...[EMPREINTE.toUpperCase(), EMPREINTE.slice(1), `${EMPREINTE}0`, `${EMPREINTE.slice(1)}g`, ` ${EMPREINTE.slice(1)}`].map((valeur) => [{ ...M365_VALIDE, empreintePdf: valeur }, noms.empreintePdf]),
      ];
      for (const [donnees, nom] of refusees) {
        await assert.rejects(insererEnvoi(donnees), new RegExp(`violates check constraint \\\\?"${nom}\\\\?"`), JSON.stringify(donnees));
      }
      assert.equal(await prisma.envoiDocument.count(), avant, 'aucune ligne refusée n’est écrite');
      // Témoins : une ligne de chaque canal, complète, s'insère.
      assert.equal(await insererEnvoi(M365_VALIDE), 1);
      assert.equal(await insererEnvoi({ devisId: devis.id }), 1);
      assert.equal(await prisma.envoiDocument.count(), avant + 2);
    });

    // « Déclencheurs : les trois restent en place » : une ligne Microsoft 365 est en ajout seul, comme les autres, et son
    // horodatage est imposé par la base.
    test('migration : les trois déclencheurs, actifs, refusent la modification et la suppression d’une ligne Microsoft 365 et le vidage, et imposent l’horodatage', async () => {
      const declencheurs = await prisma.$queryRaw`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = '"EnvoiDocument"'::regclass AND NOT tgisinternal ORDER BY tgname`;
      assert.deepEqual(declencheurs, [
        { tgname: 'envoi_document_ajout_seul', tgenabled: 'O' },
        { tgname: 'envoi_document_horodatage', tgenabled: 'O' },
        { tgname: 'envoi_document_sans_vidage', tgenabled: 'O' },
      ]);
      const devis = await creerDevis(f.client.id, `TEST Devis des déclencheurs ${suffixe()}`);
      const { res } = await envoiAccepte({
        nature: 'devis', id: devis.id, destinataire: 'client@client-6b1b.test', ...TEXTES.devis(devis, SOCIETE.raisonSociale),
        jeton: nouveauJeton(secours.email), statutDevis: 'ENVOYE', tablesModifiees: ['Devis'], contexte: 'ligne des déclencheurs',
      });
      const id = res.body.envoi.id;
      const ligne = await ligneEnvoi(id);
      for (const data of [{ expediteur: 'autre@iris.test' }, { empreintePdf: '0'.repeat(64) }, { corps: 'TEST autre texte' }, { canal: 'MESSAGERIE', expediteur: null, empreintePdf: null, corps: null }, { destinataire: 'autre@client-6b1b.test' }, { createdAt: new Date('2020-01-01T00:00:00Z') }]) {
        await assert.rejects(prisma.envoiDocument.update({ where: { id }, data }), /Journal des envois : ajout seul/, JSON.stringify(data));
      }
      await assert.rejects(prisma.envoiDocument.delete({ where: { id } }), /Journal des envois : ajout seul/);
      await assert.rejects(prisma.$executeRawUnsafe('TRUNCATE "EnvoiDocument"'), /Vidage de « EnvoiDocument » interdit/);
      assert.deepEqual(await ligneEnvoi(id), ligne);
      const [{ maintenant }] = await prisma.$queryRaw`SELECT now() AS maintenant`;
      assert.equal(await insererEnvoi({ devisId: devis.id, canal: 'MICROSOFT_365', expediteur: 'secours@iris.test', empreintePdf: sha256(Buffer.from('x')), corps: 'TEST', createdAt: '2020-01-01T00:00:00Z' }), 1);
      const [{ createdAt }] = await prisma.$queryRaw`SELECT "createdAt" FROM "EnvoiDocument" WHERE "devisId" = ${devis.id} AND "corps" = 'TEST'`;
      assert.ok(Math.abs(createdAt.getTime() - maintenant.getTime()) < 60_000, createdAt.toISOString());
    });

    // « Déclencheurs : les trois restent en place, et aucune ligne existante n'est réécrite. » La migration du lot est
    // rejouée sur une base arrêtée à la dernière migration de main, qui porte des envois des cinq documents et des
    // paramètres réglés : les envois ressortent identiques, les trois colonnes nulles, sans réécriture (même xmin) ; les
    // déclencheurs sont les mêmes objets ; les paramètres gardent leurs valeurs et prennent le mode MICROSOFT_365.
    test('migration : appliquée sur un journal existant, elle garde les envois tels quels sans les réécrire, les déclencheurs sans les recréer, et les paramètres avec le mode MICROSOFT_365', async () => {
      const nomBaseEtape = `${nomBase}_etape`;
      const urlEtape = new URL(source);
      urlEtape.pathname = `/${nomBaseEtape}`;
      const dossier = mkdtempSync(join(tmpdir(), 'iris-m365-migration-'));
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
        await db.query(`INSERT INTO "Parametres" ("id", "planningActif", "joursSansSaisie", "updatedAt") VALUES ('singleton', false, 21, now()) ON CONFLICT ("id") DO UPDATE SET "planningActif" = false, "joursSansSaisie" = 21`);
        await db.query(`INSERT INTO "Client" ("id", "raisonSociale", "updatedAt") VALUES ('client-6b1b', 'TEST Client du journal existant', now())`);
        await db.query(`INSERT INTO "Devis" ("id", "clientId", "dossierId", "numero", "objet", "totalHt", "totalTtc", "totalTva", "updatedAt", "version") VALUES ('devis-6b1b', 'client-6b1b', 'dossier-6b1b', 'D-6B1B', 'TEST Devis existant', 0, 0, 0, now(), 1)`);
        await db.query(`INSERT INTO "Facture" ("id", "clientId", "clientRaisonSociale", "dateEcheance", "dateEmission", "origine", "motifHorsAffaire", "totalHt", "totalTtc", "totalTva", "updatedAt") VALUES ('facture-6b1b', 'client-6b1b', 'TEST Client du journal existant', now(), now(), 'HORS_AFFAIRE', 'TEST motif 6b1b', 0, 0, 0, now())`);
        await db.query(`INSERT INTO "Intervention" ("id", "reference", "clientId", "titre", "updatedAt") VALUES ('intervention-6b1b', 'TEST-6B1B-1', 'client-6b1b', 'TEST Intervention existante', now())`);
        await db.query(`INSERT INTO "ContratMaintenance" ("id", "clientId", "titre", "periodiciteMois", "dureePrevisionnelleMinutes", "dateDebut", "prochaineEcheance", "updatedAt") VALUES ('contrat-6b1b', 'client-6b1b', 'TEST Contrat existant', 12, 60, now(), now(), now())`);
        await db.query(`INSERT INTO "Chantier" ("id", "nom", "client", "clientId", "dateDebut", "budgetGlobalVendu", "updatedAt") VALUES ('chantier-6b1b', 'TEST Chantier existant', 'TEST Client du journal existant', 'client-6b1b', now(), 0, now())`);
        for (const [id, colonne, document] of [
          ['envoi-devis', 'devisId', 'devis-6b1b'], ['envoi-facture', 'factureId', 'facture-6b1b'], ['envoi-intervention', 'interventionId', 'intervention-6b1b'],
          ['envoi-contrat', 'contratMaintenanceId', 'contrat-6b1b'], ['envoi-chantier', 'chantierId', 'chantier-6b1b'],
        ]) {
          await db.query(`INSERT INTO "EnvoiDocument" ("id", "${colonne}", "canal", "destinataire", "objet", "auteurId", "auteurNom") VALUES ($1, $2, 'MESSAGERIE', 'client@client-6b1b.test', 'TEST Objet existant', 'compte-6b1b', 'TEST Auteur existant')`, [id, document]);
        }
        const lignesEtape = async () => (await db.query('SELECT xmin::text AS xmin, row_to_json(e) AS ligne FROM "EnvoiDocument" e ORDER BY "id"')).rows;
        const parametresEtape = async () => (await db.query('SELECT row_to_json(p) AS ligne FROM "Parametres" p')).rows.map((r) => r.ligne);
        const declencheurs = async () => (await db.query(`SELECT tgname, oid::text AS oid, tgfoid::text AS fonction, tgenabled FROM pg_trigger WHERE tgrelid = '"EnvoiDocument"'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows;
        const autresContraintes = async () => (await db.query(`SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = '"EnvoiDocument"'::regclass AND conname <> 'EnvoiDocument_canal' ORDER BY conname`)).rows;
        const avant = await lignesEtape();
        const parametresAvant = await parametresEtape();
        const declencheursAvant = await declencheurs();
        const contraintesAvant = await autresContraintes();
        assert.equal(avant.length, 5);
        assert.ok(avant.every(({ ligne }) => !('expediteur' in ligne)), 'les colonnes n’existent pas avant le lot');
        assert.ok(parametresAvant.length === 1 && !('modeEnvoi' in parametresAvant[0]), 'le mode n’existe pas avant le lot');

        for (const nom of duLot) cpSync(join(dossierPrisma, 'migrations', nom), join(migrations, nom), { recursive: true });
        deployer();
        const appliquees = (await db.query('SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL')).rows.map((r) => r.migration_name);
        assert.ok(appliquees.includes(MIGRATION_DU_LOT), `migration ${MIGRATION_DU_LOT} non appliquée`);
        assert.deepEqual(await lignesEtape(), avant.map(({ xmin, ligne }) => ({ xmin, ligne: { ...ligne, expediteur: null, empreintePdf: null, corps: null } })), 'envois existants réécrits ou changés');
        assert.deepEqual(await parametresEtape(), [{ ...parametresAvant[0], modeEnvoi: 'MICROSOFT_365' }]);
        assert.deepEqual(await declencheurs(), declencheursAvant, 'déclencheurs supprimés ou recréés');
        const contraintesApres = await autresContraintes();
        assert.deepEqual(contraintesApres.filter((contrainte) => contraintesAvant.some((ancienne) => ancienne.conname === contrainte.conname)), contraintesAvant, 'contraintes plus anciennes changées');
        await assert.rejects(db.query(`UPDATE "EnvoiDocument" SET "expediteur" = 'secours@iris.test' WHERE "id" = 'envoi-facture'`), /Journal des envois : ajout seul/);
        await assert.rejects(db.query(`DELETE FROM "EnvoiDocument" WHERE "id" = 'envoi-chantier'`), /Journal des envois : ajout seul/);
      } finally {
        await db?.end().catch(() => {});
        if (creee) await administrationPg.query(`DROP DATABASE IF EXISTS "${nomBaseEtape}" WITH (FORCE)`);
        rmSync(dossier, { recursive: true, force: true });
      }
    });

    // ------------------------------------------------------------------------------------------------
    // Droits.
    // ------------------------------------------------------------------------------------------------

    // Cadrage, « Routes » : « Leurs gardes, leurs droits et leurs refus ne changent pas » ; « Tests » : « La matrice des
    // types de compte de chaque route est inchangée ». Pour chaque route et chaque type de compte, l'envoi par
    // Microsoft 365 (avec le jeton de sa propre boîte) rend le même statut et le même corps que la messagerie ; un refus
    // de garde n'appelle pas Graph ; un refus de périmètre (404) n'appelle pas sendMail.
    test('droits : la matrice des types de compte de chaque route est la même pour Microsoft 365 que pour la messagerie', async () => {
      const s = suffixe();
      const c = f.comptes;
      const comptes = [['SUPERADMIN', secours, admin()], ...Object.entries(c).map(([cle, compte]) => [cle, compte, parCompte(compte)])];
      const ADMIS_ADMINISTRATION = ['SUPERADMIN', 'admin', 'adminCommercial'];
      const attendus = {
        devis: (cle) => (['SUPERADMIN', 'admin', 'adminCommercial', 'commercial', 'assistante', 'comptable', 'directeurCommercial', 'directeurTousDroits'].includes(cle) ? 201 : [403, REFUS_DEVIS_WRITE]),
        facture: (cle) => (ADMIS_ADMINISTRATION.includes(cle) ? 201 : [403, REFUS_ADMINISTRATION]),
        contrat: (cle) => (ADMIS_ADMINISTRATION.includes(cle) ? 201 : [403, REFUS_ADMINISTRATION]),
        chantier: (cle) => (ADMIS_ADMINISTRATION.includes(cle) ? 201 : [403, REFUS_ADMINISTRATION]),
        compteRendu: (cle) => ({
          SUPERADMIN: 201, admin: 201, adminCommercial: 201, conducteur: 201,
          commercial: [403, REFUS_COMMERCIAL], directeur: [403, REFUS_DIRECTEUR], directeurLecteurDevis: [403, REFUS_DIRECTEUR], directeurTousDroits: [403, REFUS_DIRECTEUR],
          technicienAffecte: [403, REFUS_TECHNICIEN], technicienNonAffecte: [403, REFUS_TECHNICIEN],
          responsable: [403, REFUS_CLIENTS_READ], responsableTiers: [403, REFUS_CLIENTS_READ],
          conducteurTiers: [404, INTERVENTION_INTROUVABLE], directeurCommercial: [404, INTERVENTION_INTROUVABLE], assistante: [404, INTERVENTION_INTROUVABLE], comptable: [404, INTERVENTION_INTROUVABLE],
        })[cle],
      };
      const devis = await creerDevis(f.client.id, `TEST Devis de la matrice ${s}`);
      const cibles = { devis: devis.id, facture: f.facture.id, compteRendu: f.intervention.id, contrat: f.contrat.id, chantier: f.chantier.id };
      for (const [nature, id] of Object.entries(cibles)) {
        for (const [cle, compte, auth] of comptes) {
          const attendu = attendus[nature](cle);
          assert.ok(attendu, `${nature}, ${cle} : attendu manquant`);
          const contexte = `${nature}, ${cle}`;
          const parMessagerie = await envoyer(nature, id, 'droits@client-6b1b.test', { auth, canal: 'MESSAGERIE' });
          if (attendu === 201) {
            assert.equal(parMessagerie.status, 201, `${contexte}, messagerie : ${JSON.stringify(parMessagerie.body)}`);
            graph.reinitialiser();
            const res = await envoyer(nature, id, 'droits@client-6b1b.test', { auth, jeton: nouveauJeton(compte.email) });
            assert.equal(res.status, 201, `${contexte}, Microsoft 365 : ${JSON.stringify(res.body)}`);
            assert.deepEqual([res.body.envoi.canal, res.body.envoi.expediteur, res.body.envoi.auteurNom], ['MICROSOFT_365', compte.email, compte.name], contexte);
            assert.deepEqual(graph.requetes().map((requete) => requete.nature), ['me', 'envoi'], contexte);
            sansJetonDans(res, contexte);
          } else {
            assert.deepEqual([parMessagerie.status, parMessagerie.body], attendu, `${contexte}, messagerie`);
            await refus(() => envoyer(nature, id, 'droits@client-6b1b.test', { auth, jeton: nouveauJeton(compte.email) }), attendu[0], attendu[1], `${contexte}, Microsoft 365`, { me: attendu[0] === 403 ? false : undefined });
          }
        }
      }
    });

    // Cadrage, « Sécurité » : « Une clé d'intégration ne peut pas envoyer : 401 » ; aucune route /api/v1 (404).
    test('clé d’intégration : 401 exact sur les cinq routes pour Microsoft 365, sans appel à Graph ni écriture ; aucune route /api/v1', async () => {
      const cle = await ok(appeler('post', '/admin/api-keys', { nom: `TEST clé envoi 6b1b ${suffixe()}`, scopes: TOUS_LES_SCOPES }), 201);
      const parCle = entete(cle.apiKey);
      assert.equal((await appeler('get', '/v1/clients', null, parCle)).status, 200, 'la clé est valide');
      for (const nature of Object.keys(CHEMINS)) {
        await refus(() => envoyer(nature, f.ids[nature], 'client@client-6b1b.test', { auth: parCle, jeton: nouveauJeton(secours.email) }), 401, SESSION_INVALIDE, `${nature}, clé d’intégration`, { me: false });
        // Aucune route /api/v1 : 404 (le corps d'un 404 d'Express n'est pas du JSON), sans appel ni écriture.
        graph.reinitialiser();
        const avant = await etatBase();
        const v1 = await request(app).post(`/api/v1${CHEMINS[nature](f.ids[nature])}/envois`).set(parCle).set('X-Jeton-Microsoft', nouveauJeton(secours.email)).send({ destinataire: 'client@client-6b1b.test', canal: 'MICROSOFT_365' });
        assert.equal(v1.status, 404, `${nature}, /api/v1`);
        assert.deepEqual(await etatBase(), avant, `${nature}, /api/v1 : rien n’est écrit`);
        assert.deepEqual(graph.requetes(), [], `${nature}, /api/v1 : aucun appel à Graph`);
      }
    });

    // ------------------------------------------------------------------------------------------------
    // Concurrence (B2, sur le modèle du test de #237).
    // ------------------------------------------------------------------------------------------------

    // « Microsoft Graph est appelé hors de toute transaction : ni connexion ni verrou n'est tenu pendant un appel
    // réseau » ; « Une rafale de cinq envois Microsoft 365, avec un Graph lent (deux secondes), ne bloque pas une lecture
    // ordinaire de l'API pendant ce temps ». L'application n'a que cinq connexions (connection_limit=5) : cinq envois qui
    // garderaient chacun la sienne pendant sendMail bloqueraient la lecture. Pendant que Graph retient les cinq
    // sendMail, aucune session de la base n'est dans une transaction, et deux lectures répondent dans le délai.
    test('concurrence : cinq envois simultanés, Graph lent, ne tiennent ni transaction ni connexion ; une lecture ordinaire répond pendant ce temps ; les cinq aboutissent', async () => {
      const s = suffixe();
      const devis = await creerDevis(f.client.id, `TEST Devis de la rafale ${s}`);
      const cibles = { devis: devis.id, facture: f.facture.id, compteRendu: f.intervention.id, contrat: f.contrat.id, chantier: f.chantier.id };
      const delais = { ...delaisGraph };
      delaisGraph.me = 20_000;
      delaisGraph.envoi = 20_000;
      let liberer = () => {};
      const liberation = new Promise((fin) => { liberer = fin; });
      graph.reinitialiser();
      graph.regler({ envoi: { statut: 202, retenue: liberation } });
      try {
        const debut = Date.now();
        const envois = Object.entries(cibles).map(([nature, id]) => envoyer(nature, id, 'rafale@client-6b1b.test', { jeton: nouveauJeton(secours.email) }).timeout({ deadline: 30_000 })
          .then((reponse) => reponse, (erreur) => ({ status: 0, body: { error: String(erreur) } })));
        await attendre(() => graph.requetes('envoi').length === 5, 20_000, `les cinq sendMail n’arrivent pas : ${graph.requetes('envoi').length}`);
        const [{ enTransaction }] = await prisma.$queryRaw`SELECT count(*)::int AS "enTransaction" FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'`;
        assert.equal(enTransaction, 0, 'une transaction reste ouverte pendant l’appel à Graph');
        for (const chemin of [`/api/clients/${f.client.id}`, `/api/devis/${f.devis.id}/envois`]) {
          const t0 = Date.now();
          const lecture = await request(app).get(chemin).set(admin()).timeout({ deadline: 3_000 }).then((reponse) => reponse, (erreur) => ({ status: 0, body: { error: String(erreur) } }));
          assert.equal(lecture.status, 200, `${chemin} pendant la rafale (${Date.now() - t0} ms) : ${JSON.stringify(lecture.body)}`);
        }
        assert.ok(graph.requetes('envoi').every((requete) => !requete.repondue), 'Graph retient encore les cinq sendMail pendant les lectures');
        // Graph lent : deux secondes au moins.
        await attendre(() => Date.now() - debut >= 2_000, 5_000, 'attente de deux secondes');
        liberer();
        const reponses = await Promise.all(envois);
        assert.deepEqual(reponses.map((reponse) => reponse.status), Array(5).fill(201), JSON.stringify(reponses.map((reponse) => reponse.body?.error).filter(Boolean)));
        assert.equal(await prisma.envoiDocument.count({ where: { destinataire: 'rafale@client-6b1b.test', canal: 'MICROSOFT_365' } }), 5);
      } finally {
        liberer();
        Object.assign(delaisGraph, delais);
        graph.reinitialiser();
      }
    });

    // ------------------------------------------------------------------------------------------------
    // Sécurité : le jeton n'apparaît nulle part (dernier test du fichier : il relit tout ce que les précédents ont produit).
    // ------------------------------------------------------------------------------------------------

    // Cadrage, « Le serveur ne le garde nulle part : ni en base, ni au journal, ni dans les traces » ; « Tests » : « Le
    // jeton n'apparaît ni en base, ni dans la sortie du serveur capturée, ni dans le journal d'administration ». Toutes
    // les colonnes de toutes les tables sont lues (texte, JSON, tableaux, octets) ; un témoin vérifie que la recherche
    // trouve bien une valeur présente.
    test('sécurité : aucun des jetons Microsoft émis n’apparaît en base, dans le journal d’administration ni dans la sortie console du serveur', async () => {
      assert.ok(jetonsEmis.length > 50, `jetons émis par les tests : ${jetonsEmis.length}`);
      assert.ok(sortieConsole.length > 0, 'la sortie console du serveur est capturée');
      const colonnes = await prisma.$queryRaw`SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' ORDER BY c.table_name, c.ordinal_position`;
      const parTable = new Map();
      for (const { table_name: table, column_name: colonne, data_type: type } of colonnes) {
        if (!parTable.has(table)) parTable.set(table, []);
        parTable.get(table).push({ colonne, type });
      }
      // Nombre de lignes de chaque table dont une colonne contient l'un des motifs (texte, JSON, tableaux, octets).
      const compter = async (motifs) => {
        const trouves = {};
        for (const [table, liste] of parTable) {
          const conditions = liste.map(({ colonne, type }) => (type === 'bytea' ? `encode("${colonne}", 'escape') LIKE ANY($1::text[])` : `"${colonne}"::text LIKE ANY($1::text[])`));
          const [{ n }] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${table}" WHERE ${conditions.join(' OR ')}`, motifs);
          if (n > 0) trouves[table] = n;
        }
        return trouves;
      };
      assert.ok(jetonsEmis.every((jeton) => jeton.startsWith(PREFIXE_JETON)));
      assert.deepEqual(await compter([`%${PREFIXE_JETON}%`, ...jetonsEmis.map((jeton) => `%${jeton.slice(PREFIXE_JETON.length)}%`)]), {}, 'jeton Microsoft trouvé en base');
      // Témoin : la même recherche trouve des valeurs présentes (adresse du compte de secours, SIRET de la société,
      // expéditeur et empreinte d'un envoi par Microsoft 365).
      const [envoiM365] = await prisma.$queryRaw`SELECT "empreintePdf" FROM "EnvoiDocument" WHERE "canal" = 'MICROSOFT_365' LIMIT 1`;
      const temoins = await compter(['%secours@iris.test%', `%${SOCIETE.siret}%`, `%${envoiM365.empreintePdf}%`]);
      assert.ok(temoins.User && temoins.CompanySettings && temoins.EnvoiDocument, `la recherche trouve les valeurs présentes : ${JSON.stringify(temoins)}`);
      // Journal d'administration, relu par l'API comme en base.
      const journal = await prisma.journalAdministration.findMany();
      assert.ok(journal.length > 0);
      for (const jeton of jetonsEmis) assert.ok(!JSON.stringify(journal).includes(jeton), 'jeton Microsoft au journal d’administration');
      // Sortie console du serveur, sur toute la durée du fichier.
      for (const trace of sortieConsole) {
        for (const jeton of jetonsEmis) assert.ok(!trace.texte.includes(jeton), `jeton Microsoft dans la sortie console (${trace.methode}) : ${trace.texte.slice(0, 300)}`);
      }
    });
  });
}
