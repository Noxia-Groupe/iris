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
// les deux. Le serveur des deux arbres doit donc être identique : l'outil le vérifie.
//
// Usage, depuis client/ (base PostgreSQL jetable, de préférence neuve) :
//   RELEVE_DATABASE_URL=postgresql://iris:…@localhost:5432/iris_releve_test \
//     npm run comparer:rendu -- --reference /chemin/vers/main/client [--sortie /tmp/releve]
// Options : --candidat <dossier client> (par défaut, ce client). Ports : RELEVE_API_PORT (3401)
// et RELEVE_PORT_CLIENT (5401). RELEVE_CHROMIUM désigne au besoin l'exécutable de Chromium ;
// RELEVE_SILENCE_MS (300) règle l'attente de stabilité après chaque réponse.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

const echec = (message) => {
  console.error(`\n[comparaison du rendu] ${message}\n`);
  process.exit(2);
};
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

// Empreinte du code serveur d'un arbre : sources, point d'entrée, schéma et migrations.
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
  for (const relatif of ['index.ts', 'src', 'prisma/schema.prisma', 'prisma/migrations', 'package.json']) parcourir(relatif);
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

const processus = [];
function lancer(commande, args, options, fichierJournal) {
  const enfant = spawn(commande, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const sortie = [];
  enfant.stdout.on('data', (morceau) => sortie.push(morceau));
  enfant.stderr.on('data', (morceau) => sortie.push(morceau));
  enfant.on('exit', () => writeFileSync(fichierJournal, Buffer.concat(sortie)));
  processus.push(enfant);
  return enfant;
}
const arreterTout = () => { for (const enfant of processus) if (enfant.exitCode === null) enfant.kill('SIGTERM'); };
process.on('exit', arreterTout);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { arreterTout(); process.exit(130); });

// Vite du client donné, avec un cache de dépendances propre : deux Vite lancés depuis des
// racines différentes qui partagent un node_modules réoptimiseraient sinon le même cache.
function lancerVite(dossierClient, port, portApi, sortie, nom) {
  const config = path.join(sortie, `vite.${nom}.config.mjs`);
  writeFileSync(config, [
    `import base from ${JSON.stringify(path.join(dossierClient, 'vite.config.ts'))};`,
    `export default { ...base, cacheDir: ${JSON.stringify(path.join(sortie, `vite-cache-${nom}`))} };`,
    '',
  ].join('\n'));
  // Vite lancé directement (et non par npx) : l'arrêter libère bien le port pour le client suivant.
  return lancer(process.execPath, [path.join(dossierClient, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--host', '127.0.0.1', '--strictPort', '--config', config], {
    cwd: dossierClient,
    env: { ...process.env, VITE_DEV_API_TARGET: `http://127.0.0.1:${portApi}` },
  }, path.join(sortie, `vite-${nom}.log`));
}

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
  // L'outil crée comptes, clients, chantiers et saisies : jamais sur une base réelle.
  if (!/e2e|test/i.test(nomBase)) echec(`La base « ${nomBase} » ne porte ni « e2e » ni « test » dans son nom : refus d’y écrire.`);
  for (const dossier of [options.reference, options.candidat]) {
    if (!existsSync(path.join(dossier, 'vite.config.ts'))) echec(`${dossier} n’est pas un dossier client (vite.config.ts absent).`);
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
  mkdirSync(options.sortie, { recursive: true });

  const dossierServeur = path.resolve(options.candidat, '..', 'server');
  // Sans node_modules, npx irait chercher une autre version de Prisma que celle du dépôt.
  if (!existsSync(path.join(dossierServeur, 'node_modules', '.bin', 'prisma'))) echec(`${dossierServeur} : dépendances absentes (npm ci).`);
  const executer = (commande, args, env = process.env) => {
    journal(`${commande} ${args.join(' ')}`);
    try {
      execFileSync(commande, args, { cwd: dossierServeur, env, stdio: 'inherit' });
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
      const vite = lancerVite(options[nom], ports.client, ports.api, options.sortie, nom);
      await attendre(`http://127.0.0.1:${ports.client}/`, vite);
      try {
        releves[nom] = await relever(navigateur, `http://127.0.0.1:${ports.client}`, donnees, instant);
      } finally {
        vite.kill('SIGTERM');
        await new Promise((resolve) => (vite.exitCode !== null ? resolve() : vite.once('exit', resolve)));
        const limite = Date.now() + 30_000;
        while (await portOccupe(ports.client)) {
          if (Date.now() > limite) echec(`le port ${ports.client} reste occupé après l'arrêt de Vite.`);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      const dossier = path.join(options.sortie, nom);
      mkdirSync(dossier, { recursive: true });
      for (const [cle, contenu] of Object.entries(releves[nom])) writeFileSync(path.join(dossier, `${cle}.txt`), contenu);
    }
  } finally {
    await navigateur.close();
  }

  const ecarts = comparer(releves.reference, releves.candidat);
  journal(`relevés écrits dans ${options.sortie}`);
  if (ecarts.length) {
    console.error(`\n[comparaison du rendu] ${ecarts.length} étape(s) diffèrent :\n\n${ecarts.join('\n\n')}\n`);
    process.exit(1);
  }
  journal(`identiques : ${Object.keys(releves.reference).length} relevés (HTML et requêtes), mêmes données, même instant.`);
  process.exit(0);
}

await principal();
