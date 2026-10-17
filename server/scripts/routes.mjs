// Ce que l'application compilée (dist/index.js) met en place en se chargeant : lectures de
// l'environnement, réglages, middlewares, routes dans l'ordre où Express les essaie, puis les
// exports que lisent les tests.
//
// Sert de preuve au découpage de server/index.ts par domaine (chantier technique du
// 17-10-2026) : un déplacement de code ne doit changer ni les routes, ni leur ordre, ni les
// gardes qui les protègent, ni le corps des gestionnaires, ni le moment où .env est chargé.
//
// Lectures de l'environnement : chaque variable lue pendant le chargement, par l'application
// ou une bibliothèque, avec sa phase, `avant` ou `apres` l'appel à dotenv.config(), et le
// nombre de ces appels. Une variable de l'application lue avant le chargement de .env en
// ignorerait la valeur (secret JWT, base de données…).
//
// Chaque gestionnaire (garde, middleware, handler) est décrit par :
//   - son nom, `<anonymous>` pour une fonction sans nom ;
//   - entre accolades, les valeurs que lui a confiées la fonction nommée qui l'a fabriqué :
//     `{permission="chantiers:write"}` pour `requirePermission('chantiers:write')`,
//     `{scope="clients:read"}` pour `requireApiKey('clients:read')`,
//     `{readOptions.limit=5242880,…}` pour `express.json({ limit: '5mb' })` ;
//   - après `#`, l'empreinte de son texte compilé. Elle neutralise ce que la compilation d'un
//     import change (`(0, roles_1.isAdminRole)(…)` redevient `isAdminRole(…)`) et
//     l'indentation, qui change quand on place une route dans une fonction d'enregistrement.
//
//   node scripts/routes.mjs              affiche la liste
//   node scripts/routes.mjs --verifier   la compare à scripts/routes-reference.txt
//   node scripts/routes.mjs --ecrire     (ré)écrit scripts/routes-reference.txt
//
// La référence a été écrite depuis main avant le découpage. Un lot qui change une route, un
// gestionnaire, un middleware, un réglage, un export ou une lecture de l'environnement la
// réécrit avec --ecrire : l'écart apparaît alors dans le diff de sa PR.
//
// Le relevé se fait dans un processus enfant, avec pour seul environnement PATH et sans
// terminal : la liste est la même en local et en CI, avec ou sans server/.env, que l'on
// n'ouvre pas. À lancer après `npm run build`. L'import n'ouvre aucun port ni aucune
// connexion à la base.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import inspector from 'node:inspector/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ceFichier = fileURLToPath(import.meta.url);
const reference = path.join(path.dirname(ceFichier), 'routes-reference.txt');

if (process.argv.includes('--enfant')) {
  process.stdout.write(await releve());
  process.exit(0);
}

const enfant = spawnSync(process.execPath, [ceFichier, '--enfant'], {
  cwd: path.resolve(path.dirname(ceFichier), '..'),
  env: { PATH: process.env.PATH ?? '' },
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
if (enfant.status !== 0) {
  process.stderr.write(enfant.stderr);
  console.error(`Relevé impossible (sortie ${enfant.status ?? enfant.signal}).`);
  process.exit(1);
}
const sortie = enfant.stdout;
const lignes = sortie.trimEnd().split('\n');
const compter = (prefixe) => lignes.filter((ligne) => ligne.startsWith(prefixe)).length;
const routes = lignes.length - compter('ENV ') - compter('SET ') - compter('USE ') - compter('EXPORT ');
const bilan = `${routes} routes, ${compter('USE ')} middlewares, ${compter('SET ')} réglage(s), ${compter('EXPORT ')} exports, ${compter('ENV ')} lignes d'environnement`;

if (process.argv.includes('--ecrire')) {
  writeFileSync(reference, sortie);
  console.log(`Référence écrite : ${bilan}.`);
  process.exit(0);
}
if (!process.argv.includes('--verifier')) {
  process.stdout.write(sortie);
  process.exit(0);
}
const attendue = readFileSync(reference, 'utf8');
if (attendue === sortie) {
  console.log(`Identique à la référence : ${bilan}.`);
  process.exit(0);
}
const avant = attendue.trimEnd().split('\n');
console.error('Diffère de scripts/routes-reference.txt :');
for (let i = 0; i < Math.max(avant.length, lignes.length); i += 1) {
  if (avant[i] !== lignes[i]) {
    console.error(`  ligne ${i + 1}`);
    console.error(`    référence : ${avant[i] ?? '(absente)'}`);
    console.error(`    actuelle  : ${lignes[i] ?? '(absente)'}`);
  }
}
process.exit(1);

async function releve() {
  const require = createRequire(import.meta.url);

  // Lectures de l'environnement pendant le chargement. Celles de Node lui-même sont écartées :
  // elles changent d'une version à l'autre, et la CI n'a pas la même que le poste local.
  const lectures = new Set();
  let phase = 'avant';
  let appelsDotenv = 0;
  let sonde = true;
  const lire = (nom) => {
    if (!sonde || typeof nom !== 'string') return;
    const appelant = new Error().stack.split('\n').slice(1).find((ligne) => !ligne.includes(ceFichier)) ?? '';
    if (/\(node:|at node:/.test(appelant)) return;
    lectures.add(`${phase} ${nom}`);
  };
  process.env = new Proxy(process.env, {
    get(cible, nom) { lire(nom); return Reflect.get(cible, nom); },
    has(cible, nom) { lire(nom); return Reflect.has(cible, nom); },
  });
  // dotenv.config() marque le passage d'une phase à l'autre ; server/.env n'est pas ouvert.
  const dotenv = require('dotenv');
  const configOrigine = dotenv.config;
  dotenv.config = function config() {
    appelsDotenv += 1;
    phase = 'apres';
    return { parsed: {} };
  };

  // Express ne garde pas sur la couche d'un middleware le chemin auquel il l'a monté : on le
  // relève au passage. express() copie les méthodes de express.application dans l'application
  // qu'il crée ; dist/index.js charge le même module express que ce script.
  const express = require('express');
  const cheminsUse = [];
  const useOrigine = express.application.use;
  express.application.use = function use(...args) {
    const chemin = typeof args[0] === 'string' ? args[0] : '/';
    for (const argument of args.flat(Infinity)) if (typeof argument === 'function') cheminsUse.push(chemin);
    return useOrigine.apply(this, args);
  };
  const module = await import('../dist/index.js');
  sonde = false;
  express.application.use = useOrigine;
  dotenv.config = configOrigine;
  const { app } = module;

  const normaliser = (texte) => texte
    .replace(/\(0,\s*([\w$]+?)_\d+\.default\)/g, '$1.default')
    .replace(/\(0,\s*[\w$]+_\d+\.([\w$]+)\)/g, '$1')
    .replace(/\(0,\s*exports\.([\w$]+)\)/g, '$1')
    .replace(/\b([\w$]+?)_\d+\.default\b/g, '$1.default')
    .replace(/\b[\w$]+_\d+\.([\w$]+)/g, '$1')
    .replace(/\bexports\.([\w$]+)/g, '$1')
    .split('\n').map((ligne) => ligne.trim()).filter(Boolean).join('\n');
  const empreinte = (fonction) => createHash('sha256').update(normaliser(Function.prototype.toString.call(fonction))).digest('hex').slice(0, 12);

  // Valeurs confiées par une fabrique : variables de type simple de la portée d'une fonction
  // NOMMÉE qui enferme le gestionnaire (requirePermission, requireApiKey, json…), éléments des
  // tableaux de valeurs simples, et propriétés de type simple des objets ordinaires (options),
  // lues par l'inspecteur de V8. Deux portées sont écartées : celle du module, sans nom, et
  // celle d'une fonction d'enregistrement de routes, dont le contenu dépend du découpage et
  // non de la garde.
  const SIMPLES = ['string', 'number', 'boolean'];
  const session = new inspector.Session();
  session.connect();
  await session.post('Runtime.enable');
  const proprietes = (objectId) => session.post('Runtime.getProperties', { objectId, ownProperties: true });
  async function valeursDeFabrique(fonction) {
    globalThis.__sondeRoutes = fonction;
    const { result } = await session.post('Runtime.evaluate', { expression: 'globalThis.__sondeRoutes', objectGroup: 'routes' });
    const { internalProperties = [] } = await proprietes(result.objectId);
    const portees = internalProperties.find((propriete) => propriete.name === '[[Scopes]]');
    const valeurs = [];
    if (portees) {
      const { result: liste } = await proprietes(portees.value.objectId);
      for (const portee of liste) {
        const nom = /^Closure \((.+)\)$/.exec(portee.value?.description ?? '')?.[1];
        if (!nom || nom.startsWith('enregistrerRoutes')) continue;
        const { result: variables } = await proprietes(portee.value.objectId);
        for (const variable of variables) {
          const valeur = variable.value;
          if (SIMPLES.includes(valeur?.type)) valeurs.push(`${variable.name}=${JSON.stringify(valeur.value)}`);
          else if (valeur?.type === 'object' && valeur.subtype === 'array') {
            const { result: elements } = await proprietes(valeur.objectId);
            const simples = elements.filter((e) => /^\d+$/.test(e.name)).map((e) => e.value);
            if (simples.every((e) => SIMPLES.includes(e?.type))) valeurs.push(`${variable.name}=${JSON.stringify(simples.map((e) => e.value))}`);
          } else if (valeur?.type === 'object' && !valeur.subtype && valeur.className === 'Object') {
            const { result: champs } = await proprietes(valeur.objectId);
            for (const champ of champs) {
              if (SIMPLES.includes(champ.value?.type)) valeurs.push(`${variable.name}.${champ.name}=${JSON.stringify(champ.value.value)}`);
            }
          }
        }
      }
    }
    await session.post('Runtime.releaseObjectGroup', { objectGroup: 'routes' });
    return valeurs.sort().join(',');
  }
  async function decrire(couche) {
    const valeurs = await valeursDeFabrique(couche.handle);
    return `${couche.name}${valeurs ? `{${valeurs}}` : ''}#${empreinte(couche.handle)}`;
  }

  const resultat = [`ENV dotenv.config() appelé ${appelsDotenv} fois`];
  for (const phaseLue of ['avant', 'apres']) {
    resultat.push(...[...lectures].filter((l) => l.startsWith(`${phaseLue} `)).sort().map((l) => `ENV ${l}`));
  }
  const temoin = express();
  for (const cle of Object.keys(app.settings).sort()) {
    if (JSON.stringify(app.settings[cle]) !== JSON.stringify(temoin.settings[cle])) resultat.push(`SET ${cle}=${JSON.stringify(app.settings[cle])}`);
  }
  let indiceUse = 0;
  for (const couche of app.router.stack) {
    if (!couche.route) {
      resultat.push(`USE ${cheminsUse[indiceUse++] ?? '?'} ${await decrire(couche)}`);
      continue;
    }
    const gestionnaires = [];
    for (const gestionnaire of couche.route.stack) gestionnaires.push(await decrire(gestionnaire));
    for (const methode of Object.keys(couche.route.methods)) {
      resultat.push(`${methode.toUpperCase()} ${couche.route.path} ${gestionnaires.join(' > ')}`);
    }
  }
  // `default` et `__esModule` viennent de l'interopérabilité CommonJS, pas de l'application.
  for (const nom of Object.keys(module).filter((n) => n !== 'default' && n !== '__esModule').sort()) resultat.push(`EXPORT ${nom}`);
  return `${resultat.join('\n')}\n`;
}
