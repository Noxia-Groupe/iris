// Outil de comparaison du rendu, préalable au découpage des gros écrans du client
// (docs/DECOUPAGE-ECRANS-CIBLE.md, « Preuves par PR »).
//
// Un découpage en composants ne doit changer ni le DOM rendu, ni les requêtes envoyées. Cet
// outil sert la même base et le même serveur à deux versions du client : la référence (le
// client de `main`) et le candidat (celui de la branche). Il relève dans chacune les mêmes
// écrans, onglets et modales, avec le HTML de <main> (où sont rendues les modales) et la liste
// ordonnée des requêtes API de chaque étape, puis compare les deux relevés. La preuve d'une
// PR est un relevé identique.
//
// Un seul serveur et une seule base : les deux relevés voient exactement les mêmes données
// (mêmes identifiants, mêmes dates). L'horloge du navigateur est figée au même instant pour
// les deux ; celle du serveur ne l'est pas, d'où le refus d'une exécution à cheval sur minuit.
// Le serveur des deux arbres doit être identique : l'outil le vérifie.
//
// Usage, depuis client/ (base PostgreSQL jetable, de préférence neuve) :
//   RELEVE_DATABASE_URL=postgresql://iris:…@localhost:5432/iris_releve_test \
//     npm run comparer:rendu -- --reference /chemin/vers/main/client [--sortie /tmp/releve]
// Options : --candidat <dossier client> (par défaut, ce client). Ports : RELEVE_API_PORT (3401)
// et RELEVE_PORT_CLIENT (5401). RELEVE_CHROMIUM désigne au besoin l'exécutable de Chromium ;
// RELEVE_SILENCE_MS (300) règle la durée de calme exigée avant chaque réponse et chaque relevé.
// Codes de sortie : 0 relevés identiques, 1 relevés différents, 2 refus ou erreur de l'outil.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { JETON_SECOURS, JWT_SECRET } from './commun.mjs';
import { preparerDonnees } from './donnees.mjs';
import { relever } from './releve.mjs';

const ici = path.dirname(fileURLToPath(import.meta.url));

class Refus extends Error {}
const echec = (message) => { throw new Refus(message); };
const journal = (message) => console.log(`[comparaison du rendu] ${message}`);

function lireOptions(argv) {
  const options = { candidat: path.resolve(ici, '..', '..') };
  for (let i = 0; i < argv.length; i += 1) {
    const [cle, valeur] = [argv[i], argv[i + 1]];
    if (valeur === undefined) echec(`valeur manquante pour ${cle}`);
    if (cle === '--reference') options.reference = path.resolve(valeur);
    else if (cle === '--candidat') options.candidat = path.resolve(valeur);
    else if (cle === '--sortie') options.sortie = path.resolve(valeur);
    else echec(`option inconnue : ${cle}`);
    i += 1;
  }
  if (!options.reference) echec('--reference <dossier client de main> est requis.');
  options.sortie ||= path.join(os.tmpdir(), `iris-releve-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  return options;
}

// Empreinte du code serveur d'un arbre : sources, point d'entrée, schéma, migrations,
// dépendances et configuration de compilation.
function empreinteServeur(dossierClient) {
  const racine = path.resolve(dossierClient, '..', 'server');
  const hash = createHash('sha256');
  const parcourir = (relatif) => {
    const absolu = path.join(racine, relatif);
    if (!existsSync(absolu)) return;
    if (statSync(absolu).isDirectory()) {
      for (const nom of readdirSync(absolu).sort()) parcourir(path.join(relatif, nom));
    } else {
      hash.update(`${relatif}\0`).update(readFileSync(absolu)).update('\0');
    }
  };
  for (const relatif of ['index.ts', 'src', 'prisma/schema.prisma', 'prisma/migrations', 'package.json', 'package-lock.json', 'tsconfig.json']) parcourir(relatif);
  return hash.digest('hex');
}

const portOccupe = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

async function attendre(url, processus, delaiMs = 120_000) {
  const fin = Date.now() + delaiMs;
  while (Date.now() < fin) {
    if (processus.exitCode !== null) echec(`le processus servant ${url} s'est arrêté (code ${processus.exitCode}).`);
    try {
      const reponse = await fetch(url);
      if (reponse.ok) return;
    } catch { /* pas encore prêt */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  echec(`${url} ne répond pas après ${delaiMs / 1000} s.`);
}

// Processus fils : sortie écrite au fil de l'eau dans leur journal, lisible même si l'outil
// s'arrête brutalement.
const processus = [];
function lancer(commande, args, options, fichierJournal) {
  const descripteur = openSync(fichierJournal, 'a');
  const enfant = spawn(commande, args, { ...options, stdio: ['ignore', descripteur, descripteur] });
  closeSync(descripteur);
  processus.push(enfant);
  return enfant;
}
const arreterTout = () => { for (const enfant of processus) if (enfant.exitCode === null) enfant.kill('SIGTERM'); };
process.on('exit', arreterTout);
process.on('SIGINT', () => { arreterTout(); process.exit(130); });
process.on('SIGTERM', () => { arreterTout(); process.exit(143); });

// Vite du client donné, avec un cache de dépendances propre : deux Vite lancés depuis des
// racines différentes qui partagent un node_modules réoptimiseraient sinon le même cache.
// La configuration du client peut être un objet ou une fonction (defineConfig).
function lancerVite(dossierClient, port, portApi, sortie, nom) {
  const config = path.join(sortie, `vite.${nom}.config.mjs`);
  writeFileSync(config, [
    `import base from ${JSON.stringify(path.join(dossierClient, 'vite.config.ts'))};`,
    'export default async (env) => {',
    "  const resolue = typeof base === 'function' ? await base(env) : base;",
    `  return { ...resolue, cacheDir: ${JSON.stringify(path.join(sortie, `vite-cache-${nom}`))} };`,
    '};',
    '',
  ].join('\n'));
  // Vite lancé directement (et non par npx) : l'arrêter libère bien le port pour le client suivant.
  return lancer(process.execPath, [path.join(dossierClient, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--host', '127.0.0.1', '--strictPort', '--config', config], {
    cwd: dossierClient,
    env: { ...process.env, VITE_DEV_API_TARGET: `http://127.0.0.1:${portApi}` },
  }, path.join(sortie, `vite-${nom}.log`));
}

// Nom de fichier d'une étape : lettres, chiffres, point et tiret seulement.
const nomDeFichier = (cle) => `${cle.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9.-]+/g, '-')}.txt`;

const jourCivil = () => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short' }).format(new Date());

function comparer(reference, candidat) {
  const ecarts = [];
  const cles = [...new Set([...Object.keys(reference), ...Object.keys(candidat)])];
  for (const cle of cles) {
    if (reference[cle] === candidat[cle]) continue;
    const [a, b] = [(reference[cle] ?? '(absent)').split('\n'), (candidat[cle] ?? '(absent)').split('\n')];
    const ligne = a.findIndex((texte, i) => texte !== b[i]);
    const indice = ligne === -1 ? Math.min(a.length, b.length) : ligne;
    ecarts.push(`${cle}, ligne ${indice + 1} :\n  référence : ${(a[indice] ?? '(fin)').slice(0, 300)}\n  candidat  : ${(b[indice] ?? '(fin)').slice(0, 300)}`);
  }
  return ecarts;
}

async function principal() {
  const options = lireOptions(process.argv.slice(2));
  const urlBase = process.env.RELEVE_DATABASE_URL;
  if (!urlBase) echec('RELEVE_DATABASE_URL est requise : elle doit viser une base PostgreSQL jetable.');
  let nomBase;
  try {
    nomBase = decodeURIComponent(new URL(urlBase).pathname.replace(/^\//, ''));
  } catch {
    echec('RELEVE_DATABASE_URL n’est pas une URL PostgreSQL valide.');
  }
  // L'outil crée comptes, clients, chantiers et saisies : jamais sur une base réelle. « e2e » ou
  // « test » doit former un mot du nom (iris_releve_test, e2e-iris), pas une sous-chaîne
  // (production_latest).
  if (!/(^|[_-])(e2e|test)([_-]|$)/i.test(nomBase)) echec(`La base « ${nomBase} » ne porte ni « e2e » ni « test » comme mot de son nom : refus d’y écrire.`);
  for (const dossier of [options.reference, options.candidat]) {
    if (!existsSync(path.join(dossier, 'vite.config.ts'))) echec(`${dossier} n’est pas un dossier client (vite.config.ts absent).`);
    if (!existsSync(path.join(dossier, 'node_modules', 'vite', 'bin', 'vite.js'))) echec(`${dossier} : dépendances absentes (npm ci dans ce dossier client).`);
  }
  if (empreinteServeur(options.reference) !== empreinteServeur(options.candidat)) {
    echec('Le code serveur diffère entre la référence et le candidat : l’outil compare deux clients servis par le même serveur.');
  }
  // Un seul port pour les deux clients, servis l'un après l'autre : l'origine de la page (lien
  // de partage du planning, localStorage) est la même dans les deux relevés.
  const ports = {
    api: Number(process.env.RELEVE_API_PORT || '3401'),
    client: Number(process.env.RELEVE_PORT_CLIENT || '5401'),
  };
  for (const [role, port] of Object.entries(ports)) {
    if (await portOccupe(port)) echec(`Le port ${port} (${role}) est déjà occupé.`);
  }
  if (existsSync(options.sortie) && readdirSync(options.sortie).length) echec(`${options.sortie} existe et n’est pas vide : choisissez un autre --sortie.`);
  mkdirSync(options.sortie, { recursive: true });

  // Le serveur du candidat est compilé et démarré : son server/dist et son client Prisma sont
  // régénérés.
  const dossierServeur = path.resolve(options.candidat, '..', 'server');
  // Sans node_modules, npx irait chercher une autre version de Prisma que celle du dépôt.
  if (!existsSync(path.join(dossierServeur, 'node_modules', '.bin', 'prisma'))) echec(`${dossierServeur} : dépendances absentes (npm ci).`);
  const executer = (commande, args, env = process.env) => {
    journal(`${commande} ${args.join(' ')}`);
    try {
      execFileSync(commande, args, { cwd: dossierServeur, env, stdio: 'inherit', shell: process.platform === 'win32' });
    } catch {
      echec(`échec de « ${commande} ${args.join(' ')} » dans ${dossierServeur}.`);
    }
  };
  executer('npx', ['prisma', 'generate']);
  executer('npm', ['run', 'build']);
  executer('npx', ['prisma', 'migrate', 'deploy'], { ...process.env, DATABASE_URL: urlBase });

  const serveur = lancer('node', ['dist/index.js'], {
    cwd: dossierServeur,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(ports.api),
      DATABASE_URL: urlBase,
      JWT_SECRET,
      BREAK_GLASS_EMAIL: 'secours@iris.test',
      BREAK_GLASS_TOKEN: JETON_SECOURS,
      SUPERADMIN_EMAILS: 'secours@iris.test',
    },
  }, path.join(options.sortie, 'serveur.log'));
  await attendre(`http://127.0.0.1:${ports.api}/api/health`, serveur);

  const jourDebut = jourCivil();
  journal('préparation des données');
  const donnees = await preparerDonnees(`http://127.0.0.1:${ports.api}/api`);
  writeFileSync(path.join(options.sortie, 'donnees.json'), JSON.stringify(donnees, null, 2));

  const navigateur = await chromium.launch(process.env.RELEVE_CHROMIUM ? { executablePath: process.env.RELEVE_CHROMIUM } : {});
  // Même instant pour les deux relevés : les dates calculées par le navigateur sont identiques.
  const instant = new Date();
  const releves = {};
  try {
    for (const nom of ['reference', 'candidat']) {
      journal(`relevé du client ${nom} (${options[nom]})`);
      const dossier = path.join(options.sortie, nom);
      mkdirSync(dossier, { recursive: true });
      const vite = lancerVite(options[nom], ports.client, ports.api, options.sortie, nom);
      await attendre(`http://127.0.0.1:${ports.client}/`, vite);
      try {
        releves[nom] = await relever(navigateur, `http://127.0.0.1:${ports.client}`, donnees, instant,
          (cle, contenu) => writeFileSync(path.join(dossier, nomDeFichier(cle)), contenu));
      } finally {
        vite.kill('SIGTERM');
        await new Promise((resolve) => (vite.exitCode !== null ? resolve() : vite.once('exit', resolve)));
        const limite = Date.now() + 30_000;
        while (await portOccupe(ports.client)) {
          if (Date.now() > limite) echec(`le port ${ports.client} reste occupé après l'arrêt de Vite.`);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    }
  } finally {
    await navigateur.close();
  }
  // Le serveur calcule durées et alertes au jour civil réel : les deux relevés doivent tomber
  // le même jour.
  if (jourCivil() !== jourDebut) echec(`le jour a changé pendant l'exécution (${jourDebut}, puis ${jourCivil()}) : relancez l'outil.`);

  const ecarts = comparer(releves.reference, releves.candidat);
  journal(`relevés écrits dans ${options.sortie}`);
  if (ecarts.length) {
    console.error(`\n[comparaison du rendu] ${ecarts.length} étape(s) diffèrent :\n\n${ecarts.join('\n\n')}\n`);
    return 1;
  }
  journal(`identiques : ${Object.keys(releves.reference).length} relevés (HTML et requêtes), mêmes données, même instant.`);
  return 0;
}

try {
  process.exit(await principal());
} catch (erreur) {
  console.error(`\n[comparaison du rendu] ${erreur instanceof Refus ? erreur.message : `erreur de l'outil : ${erreur?.stack ?? erreur}`}\n`);
  process.exit(2);
}
