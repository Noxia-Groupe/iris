// Ce que l'application compilée (dist/index.js) enregistre, dans l'ordre où Express l'essaie :
// réglages, middlewares, routes, puis les exports que lisent les tests.
//
// Sert de preuve au découpage de server/index.ts par domaine (chantier technique du
// 17-10-2026) : un déplacement de code ne doit changer ni les routes, ni leur ordre, ni les
// gardes qui les protègent, ni le corps des gestionnaires.
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
// La référence a été écrite depuis main avant le découpage. Un lot qui ajoute, retire,
// réordonne une route, modifie un gestionnaire ou un export la réécrit avec --ecrire :
// l'écart apparaît alors dans le diff de sa PR.
//
// À lancer après `npm run build`. L'import n'ouvre aucun port ni aucune connexion à la base.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import inspector from 'node:inspector/promises';
import { fileURLToPath } from 'node:url';

const reference = fileURLToPath(new URL('./routes-reference.txt', import.meta.url));

// dotenv annonce sur la sortie standard ce qu'il charge, avec une astuce tirée au hasard.
process.env.DOTENV_CONFIG_QUIET = 'true';

// Express ne garde pas sur la couche d'un middleware le chemin auquel il l'a monté : on le
// relève au passage. express() copie les méthodes de express.application dans l'application
// qu'il crée ; dist/index.js charge le même module express que ce script.
const express = createRequire(import.meta.url)('express');
const cheminsUse = [];
const useOrigine = express.application.use;
express.application.use = function use(...args) {
  const chemin = typeof args[0] === 'string' ? args[0] : '/';
  for (const argument of args.flat(Infinity)) if (typeof argument === 'function') cheminsUse.push(chemin);
  return useOrigine.apply(this, args);
};
const module = await import('../dist/index.js');
express.application.use = useOrigine;
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
// NOMMÉE qui enferme le gestionnaire (requirePermission, requireApiKey, json…), et propriétés
// de type simple des objets ordinaires qu'elle contient (options), lues par l'inspecteur de V8. Deux portées sont écartées : celle du module, sans nom, et celle d'une
// fonction d'enregistrement de routes, dont le contenu dépend du découpage et non de la garde.
const session = new inspector.Session();
session.connect();
await session.post('Runtime.enable');
const SIMPLES = ['string', 'number', 'boolean'];
async function proprietes(objectId) {
  return session.post('Runtime.getProperties', { objectId, ownProperties: true });
}
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
        if (SIMPLES.includes(variable.value?.type)) valeurs.push(`${variable.name}=${JSON.stringify(variable.value.value)}`);
        else if (variable.value?.type === 'object' && !variable.value.subtype && variable.value.className === 'Object') {
          const { result: champs } = await proprietes(variable.value.objectId);
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

const lignes = [];
const temoin = express();
for (const cle of Object.keys(app.settings).sort()) {
  if (JSON.stringify(app.settings[cle]) !== JSON.stringify(temoin.settings[cle])) lignes.push(`SET ${cle}=${JSON.stringify(app.settings[cle])}`);
}
let indiceUse = 0;
for (const couche of app.router.stack) {
  if (!couche.route) {
    lignes.push(`USE ${cheminsUse[indiceUse++] ?? '?'} ${await decrire(couche)}`);
    continue;
  }
  const gestionnaires = [];
  for (const gestionnaire of couche.route.stack) gestionnaires.push(await decrire(gestionnaire));
  for (const methode of Object.keys(couche.route.methods)) {
    lignes.push(`${methode.toUpperCase()} ${couche.route.path} ${gestionnaires.join(' > ')}`);
  }
}
for (const nom of Object.keys(module).sort()) lignes.push(`EXPORT ${nom}`);
const sortie = `${lignes.join('\n')}\n`;

const compter = (prefixe) => lignes.filter((ligne) => ligne.startsWith(prefixe)).length;
const bilan = `${lignes.length - compter('SET ') - compter('USE ') - compter('EXPORT ')} routes, ${compter('USE ')} middlewares, ${compter('SET ')} réglage(s), ${compter('EXPORT ')} exports`;

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
const max = Math.max(avant.length, lignes.length);
console.error('Diffère de scripts/routes-reference.txt :');
for (let i = 0; i < max; i += 1) {
  if (avant[i] !== lignes[i]) {
    console.error(`  ligne ${i + 1}`);
    console.error(`    référence : ${avant[i] ?? '(absente)'}`);
    console.error(`    actuelle  : ${lignes[i] ?? '(absente)'}`);
  }
}
process.exit(1);
