// Outils partagés des matrices de non-régression des droits (lot D1a, cadrage version 3 du 01-11-2026, §2).
//
// Ce fichier n'est pas un fichier de tests (pas de suffixe « .test.mjs ») : server/tests/run.mjs ne lit que le
// premier niveau de server/tests, et les fichiers « matrice-droits-<partie>.test.mjs » importent ces outils
// (cadrage §2.1, N4). Ils servent à D1a-1 (entrées) et resserviront à D1a-2 à D1a-5 :
//  - base jetable propre au fichier, migrée puis supprimée (modèle : production-pdf.test.mjs) ;
//  - application montée une fois sur un port libre de la boucle locale, appelée en HTTP réel ;
//  - empreinte de toute la base (toutes les tables, comme envoi-microsoft-365.test.mjs) ;
//  - normalisation des messages et format d'une ligne de matrice ;
//  - comparaison avec la référence versionnée, diff imprimé dans le message d'échec (N8) ;
//  - relevé des routes de l'application importée (app.router.stack), pour le test de couverture.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const DOSSIER_SERVEUR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DOSSIER_MATRICES = dirname(fileURLToPath(import.meta.url));

// Cible d'une route sans paramètre de dossier.
export const SANS_CIBLE = '—';
// Contexte d'une ligne : réglages par défaut (cadrage §2.5 : « Les matrices tournent avec les valeurs par défaut »).
export const CONTEXTE_DEFAUT = 'défaut';

// --- Base jetable ---
// « test » comme mot (règle de client/scripts/base-jetable.mjs) et un suffixe tiré au hasard : deux exécutions
// simultanées, ou deux fichiers de la matrice lancés ensemble par `node --test`, ne partagent jamais leur base.
export function baseJetable(urlSource, partie) {
  const source = new URL(urlSource);
  assert.ok(['127.0.0.1', 'localhost'].includes(source.hostname), 'seul un PostgreSQL local est autorisé');
  assert.match(partie, /^[a-z0-9]+$/, 'partie du nom de base : lettres minuscules et chiffres');
  const nom = `iris_test_matrice_${partie}_${randomBytes(6).toString('hex')}`;
  const maintenance = new URL(source);
  maintenance.pathname = '/postgres';
  const cible = new URL(source);
  cible.pathname = `/${nom}`;
  // L'application parallélise ses appels : quelques connexions de plus que la valeur par défaut de Prisma.
  const cibleApplication = new URL(cible);
  cibleApplication.searchParams.set('connection_limit', '12');
  const administration = new pg.Client({ connectionString: maintenance.toString() });
  let creee = false;
  return {
    nom,
    url: cible.toString(),
    urlApplication: cibleApplication.toString(),
    async creer() {
      await administration.connect();
      await administration.query(`CREATE DATABASE "${nom}"`);
      creee = true;
      execFileSync(resolve(DOSSIER_SERVEUR, 'node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', resolve(DOSSIER_SERVEUR, 'prisma/schema.prisma')], {
        env: { ...process.env, DATABASE_URL: cible.toString() }, encoding: 'utf8', stdio: 'pipe', timeout: 180_000,
      });
    },
    async supprimer() {
      if (creee) await administration.query(`DROP DATABASE IF EXISTS "${nom}" WITH (FORCE)`);
      await administration.end().catch(() => {});
    },
  };
}

// --- Application ---
// Les variables sont posées avant l'import de l'application, comme dans les autres fichiers à base propre
// (mêmes valeurs de test, toutes documentées dans docs/CONFIGURATION-ENVIRONNEMENT.md).
export const JETON_SECOURS = 'jeton-de-secours-de-test-au-moins-32-caracteres';
export const EMAIL_SECOURS = 'secours@iris.test';
export async function chargerApplication(base) {
  process.env.DATABASE_URL = base.urlApplication;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  process.env.BREAK_GLASS_EMAIL = EMAIL_SECOURS;
  process.env.BREAK_GLASS_TOKEN = JETON_SECOURS;
  process.env.SUPERADMIN_EMAILS = EMAIL_SECOURS;
  const serveur = await import('../../dist/index.js');
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: base.url } } });
  const jwt = (await import('jsonwebtoken')).default;
  await serveur.initDb();
  await serveur.ensureSuperAdmins();
  // Un seul serveur HTTP pour tous les appels (supertest en ouvrirait un par requête) : la matrice compte des
  // milliers d'appels. Port choisi par le système sur la boucle locale ; fermé à la fin du fichier.
  const http = await new Promise((ok, ko) => {
    const s = serveur.app.listen(0, '127.0.0.1', () => ok(s));
    s.on('error', ko);
  });
  const adresse = `http://127.0.0.1:${http.address().port}`;
  return {
    serveur, app: serveur.app, prisma, jwt, adresse,
    signer: (id, options) => jwt.sign({ id }, process.env.JWT_SECRET, options),
    async fermer() {
      agentHttp.destroy();
      http.closeAllConnections?.();
      await new Promise((ok) => http.close(() => ok()));
      await prisma.$disconnect().catch(() => {});
      await serveur.prisma?.$disconnect().catch(() => {});
    },
  };
}

// Appel HTTP réel, par node:http et un agent qui garde les connexions ouvertes. `jeton` : chaîne (en-tête
// Bearer), ou null pour un appel sans session ; `autorisation` : en-tête Authorization donné tel quel, pour un en-tête
// qui ne suit pas la forme « Bearer <jeton> » (matrice des clés d'intégration, D1a-2). Le corps est toujours envoyé
// en JSON pour une écriture (un objet vide pour un « corps vide », cadrage §2.4) ; rien pour une lecture. Pourquoi
// pas `fetch` : sur les quelque 11 000 appels de la matrice d'entrée, `fetch` coûte environ 25 % de processeur de
// plus que node:http, qui en retire donc environ 20 % (mesures du 01-11-2026 : 41,4 et 43,3 s de processeur avec
// `fetch`, de 33,5 à 34,3 s avec node:http) ; la CI partage ce processeur avec les autres fichiers de tests, que la
// matrice ralentit d'autant.
const agentHttp = new Agent({ keepAlive: true, maxSockets: 16 });
// Une route qui ne répond jamais fait échouer l'appel au lieu de suspendre le fichier (fetch abandonnait après 300 s).
const DELAI_APPEL_MS = 60_000;
export function appeler(adresse, methode, chemin, { jeton = null, autorisation = null, corps, requete } = {}) {
  const url = new URL(chemin, adresse);
  for (const [cle, valeur] of Object.entries(requete ?? {})) url.searchParams.set(cle, valeur);
  const entetes = {};
  if (jeton !== null) entetes.Authorization = `Bearer ${jeton}`;
  if (autorisation !== null) entetes.Authorization = autorisation;
  const donnees = methode !== 'GET' ? Buffer.from(JSON.stringify(corps ?? {})) : null;
  if (donnees) {
    entetes['Content-Type'] = 'application/json';
    entetes['Content-Length'] = donnees.length;
  }
  return new Promise((ok, ko) => {
    const requeteHttp = request(url, { method: methode, headers: entetes, agent: agentHttp, timeout: DELAI_APPEL_MS }, (reponse) => {
      const type = reponse.headers['content-type'] ?? '';
      const json = type.includes('application/json');
      const morceaux = [];
      // PDF, CSV : lus puis jetés, le contenu n'entre jamais dans la matrice d'entrée (code seul pour un 2xx).
      reponse.on('data', (morceau) => { if (json) morceaux.push(morceau); });
      reponse.on('error', ko);
      reponse.on('end', () => {
        const texte = json ? Buffer.concat(morceaux).toString('utf8') : '';
        let corpsLu = null;
        if (json) {
          try { corpsLu = JSON.parse(texte); } catch { corpsLu = null; }
        }
        ok({ status: reponse.statusCode, body: corpsLu, texte, type });
      });
    });
    requeteHttp.on('error', ko);
    requeteHttp.on('timeout', () => requeteHttp.destroy(new Error(`${methode} ${chemin} : aucune réponse en ${DELAI_APPEL_MS / 1000} s`)));
    if (donnees) requeteHttp.write(donnees);
    requeteHttp.end();
  });
}

// Exécute des tâches avec au plus `limite` en cours à la fois ; rend les résultats dans l'ordre des tâches.
export async function enParallele(taches, limite = 8) {
  const resultats = new Array(taches.length);
  let suivant = 0;
  const ouvrier = async () => {
    while (suivant < taches.length) {
      const rang = suivant; suivant += 1;
      resultats[rang] = await taches[rang]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, taches.length) }, ouvrier));
  return resultats;
}

// --- Empreinte de la base ---
// Toutes les tables du schéma public (relues dans information_schema, comme envoi-microsoft-365.test.mjs), hors
// l'historique des migrations ; chacune résumée par son nombre de lignes et l'empreinte de leur contenu entier
// (horodatages de mise à jour compris). Une écriture, même silencieuse, change donc l'empreinte.
export async function tablesDeLaBase(prisma) {
  const lignes = await prisma.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name`;
  return lignes.map((ligne) => ligne.table_name);
}
// `colonnesIgnorees` (table → noms de colonnes) retire des colonnes du contenu résumé : la matrice des clés
// d'intégration (D1a-2) en retire la dernière utilisation d'une clé, écrite sans attente par la porte /api/v1, et la
// contrôle à part, clé par clé (voir matrice-droits-cles.test.mjs). Sans elle, l'empreinte est celle de D1a-1.
export async function empreinteBase(prisma, tables, { colonnesIgnorees = {} } = {}) {
  const contenu = (table) => {
    const ignorees = colonnesIgnorees[table] ?? [];
    for (const colonne of ignorees) assert.match(colonne, /^[A-Za-z]+$/, `colonne ignorée : ${colonne}`);
    return ignorees.length ? `(row_to_json(t)::jsonb${ignorees.map((colonne) => ` - '${colonne}'`).join('')})::text` : 'row_to_json(t)::text';
  };
  const colonnes = tables.map((table) => `(SELECT count(*)::text || ':' || coalesce(md5(string_agg(${contenu(table)}, '|' ORDER BY ${contenu(table)})), '') FROM "${table}" t) AS "${table}"`);
  const [ligne] = await prisma.$queryRawUnsafe(`SELECT ${colonnes.join(', ')}`);
  return ligne;
}
// Tables dont l'empreinte a changé, pour nommer l'écriture dans un message d'échec.
export function tablesChangees(avant, apres) {
  return Object.keys({ ...avant, ...apres }).filter((table) => avant[table] !== apres[table]).sort();
}

// --- Normalisation et format d'une ligne (cadrage §2.1, N6, N16) ---
// Aucun identifiant, date, horodatage ni jeton dans la référence ; un message variable est normalisé. Les noms du
// jeu de données sont fixes (base propre au fichier) : ils n'ont pas besoin de l'être.
export function normaliserTexte(texte) {
  return String(texte)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\biris_[A-Za-z0-9_-]{16,}\b/g, '<clé>')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?/g, '<horodatage>')
    .replace(/\b\d{2}-\d{2}-\d{4}\b/g, '<date>')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>')
    .replace(/\b\d{2}\/\d{2}\/\d{4}\b/g, '<date>')
    // Numéros de pièce portant l'année (devis, affaire, intervention, facture, avoir) : l'année change.
    .replace(/\b([A-Z]{1,3})-?(20)?\d{2}-\d{3,}\b/g, '<numéro>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Réponse d'un cas, telle que la référence l'enregistre :
//  - 2xx : le code seul ;
//  - 400 : le code seul (le message d'une validation n'est pas un droit), suivi de « validation-avant-droit »
//    quand la route valide le corps avant un contrôle de droit ou de périmètre (cadrage §2.1, N16) ;
//  - tout autre code (401, 403, 404, 409, 410, et un éventuel 500) : le code, le champ `code` du corps s'il en
//    porte un, puis le message exact, normalisé. Un corps qui porte d'autres champs les nomme, sans leur valeur ;
//  - pour une écriture (c) du cadrage §2.4, suivi de « écrit » ou « inchangé » selon l'empreinte de la base.
export function formaterReponse(res, { validationAvantDroit = false, ecriture = null } = {}) {
  const reponse = reponseSansEcriture(res, validationAvantDroit);
  return ecriture ? `${reponse} ${ecriture}` : reponse;
}
function reponseSansEcriture(res, validationAvantDroit) {
  if (res.status >= 200 && res.status < 300) return String(res.status);
  if (res.status === 400) return validationAvantDroit ? '400 validation-avant-droit' : '400';
  const corps = res.body;
  if (!corps || typeof corps !== 'object' || Array.isArray(corps)) {
    return `${res.status} (corps non JSON${res.texte ? ` : ${normaliserTexte(res.texte).slice(0, 120)}` : ''})`;
  }
  const morceaux = [String(res.status)];
  if (typeof corps.code === 'string') morceaux.push(corps.code);
  morceaux.push(`« ${normaliserTexte(corps.error ?? corps.message ?? '')} »`);
  const autres = Object.keys(corps).filter((cle) => !['code', 'error', 'message'].includes(cle)).sort();
  if (autres.length) morceaux.push(`+ ${autres.join(',')}`);
  return morceaux.join(' ');
}

// Une ligne de matrice : compte, méthode et chemin, cible nommée, contexte (réglage), réponse. Champs séparés par
// « | », sans espace en fin de ligne.
export const SEPARATEUR = ' | ';
export function ligneMatrice({ compte, methode, chemin, cible, contexte = CONTEXTE_DEFAUT, reponse }) {
  const champs = [compte, `${methode} ${chemin}`, cible, contexte, reponse];
  for (const champ of champs) assert.ok(!String(champ).includes('|') && String(champ) === String(champ).trim() && !/\n/.test(champ), `champ de ligne invalide : ${champ}`);
  return champs.join(SEPARATEUR);
}
export const cleDeLigne = (ligne) => ligne.split(SEPARATEUR).slice(0, 4).join(SEPARATEUR);
// Tri au code de caractère près, indépendant de la langue de la machine.
export const trier = (lignes) => [...lignes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// --- Comparaison avec la référence (cadrage §2.1, N8) ---
// En cas d'écart : la matrice obtenue est écrite dans un fichier temporaire hors du dépôt, dont le chemin est
// donné, et le message d'échec imprime les premières lignes du diff (60 au plus), le fichier temporaire étant
// perdu en CI. Le diff est fait par clé (compte, route, cible, contexte) : une réponse changée se lit en deux
// lignes, « - » la référence, « + » l'obtenu.
export function lireReference(chemin) {
  try { return readFileSync(chemin, 'utf8'); } catch { return null; }
}
export function diffParCle(lignesReference, lignesObtenues) {
  const reference = new Map(lignesReference.map((ligne) => [cleDeLigne(ligne), ligne]));
  const obtenues = new Map(lignesObtenues.map((ligne) => [cleDeLigne(ligne), ligne]));
  const cles = trier([...new Set([...reference.keys(), ...obtenues.keys()])]);
  const diff = [];
  for (const cle of cles) {
    const avant = reference.get(cle); const apres = obtenues.get(cle);
    if (avant === apres) continue;
    if (avant !== undefined) diff.push(`- ${avant}`);
    if (apres !== undefined) diff.push(`+ ${apres}`);
  }
  return diff;
}
export function comparerAvecReference(lignesObtenues, cheminReference, nomTemporaire) {
  const texteObtenu = `${trier(lignesObtenues).join('\n')}\n`;
  const texteReference = lireReference(cheminReference);
  if (texteReference === texteObtenu) return;
  const dossier = mkdtempSync(join(tmpdir(), 'iris-matrice-'));
  const cheminObtenu = join(dossier, nomTemporaire);
  writeFileSync(cheminObtenu, texteObtenu);
  const lignesReference = texteReference === null ? [] : texteReference.split('\n').filter((ligne) => ligne !== '');
  const diff = diffParCle(lignesReference, trier(lignesObtenues));
  const entete = texteReference === null
    ? `Référence absente : ${cheminReference}.`
    : `La matrice obtenue diffère de la référence ${cheminReference} (${diff.length} ligne(s) de diff).`;
  const extrait = diff.slice(0, 60).join('\n');
  const suite = diff.length > 60 ? `\n… ${diff.length - 60} ligne(s) de diff de plus.` : '';
  const ordre = diff.length === 0 ? '\n(Mêmes lignes, ordre ou fin de fichier différents.)' : '';
  assert.fail(`${entete}\nMatrice obtenue : ${cheminObtenu}\nPour l’adopter dans la PR qui change volontairement un droit : cp ${cheminObtenu} ${cheminReference}\n${extrait}${suite}${ordre}`);
}

// --- Routes de l'application importée ---
// Même lecture que server/scripts/routes.mjs : chaque couche de app.router.stack qui porte une route, et chacune de
// ses méthodes. Les gestionnaires sont nommés (requireAuth, requireAdmin…) pour classer les routes ouvertes.
export function routesDeLApplication(app) {
  const routes = [];
  for (const couche of app.router.stack) {
    if (!couche.route) continue;
    for (const methode of Object.keys(couche.route.methods)) {
      routes.push({ methode: methode.toUpperCase(), chemin: couche.route.path, gestionnaires: couche.route.stack.map((g) => g.name || '<anonymous>') });
    }
  }
  return routes;
}
export const cleRoute = (methode, chemin) => `${methode} ${chemin}`;
