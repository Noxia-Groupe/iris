// Liste des routes réellement enregistrées par l'application compilée (dist/index.js), dans
// l'ordre où Express les essaie : une ligne par méthode, avec la chaîne de ses gestionnaires.
//
// Sert de preuve au découpage de server/index.ts par domaine (chantier technique du
// 17-10-2026) : un déplacement de code ne doit changer ni les routes, ni leur ordre, ni les
// gardes qui les protègent.
//
//   node scripts/routes.mjs              affiche la liste
//   node scripts/routes.mjs --verifier   la compare à scripts/routes-reference.txt
//   node scripts/routes.mjs --ecrire     (ré)écrit scripts/routes-reference.txt
//
// La référence a été écrite depuis main avant le découpage. Un lot qui ajoute, retire ou
// réordonne une route la réécrit avec --ecrire : l'écart apparaît alors dans le diff de sa PR.
//
// À lancer après `npm run build`. L'import n'ouvre aucun port ni aucune connexion à la base.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const reference = fileURLToPath(new URL('./routes-reference.txt', import.meta.url));
const { app } = await import('../dist/index.js');

const lignes = [];
for (const couche of app.router.stack) {
  if (!couche.route) {
    // Middleware applicatif (app.use) : global, ou limité à un chemin.
    lignes.push(`USE ${couche.slash ? '(global)' : '(chemin)'} ${couche.name}`);
    continue;
  }
  const gestionnaires = couche.route.stack.map((g) => g.name).join(' > ');
  for (const methode of Object.keys(couche.route.methods)) {
    lignes.push(`${methode.toUpperCase()} ${couche.route.path} ${gestionnaires}`);
  }
}
const sortie = `${lignes.join('\n')}\n`;

if (process.argv.includes('--ecrire')) {
  writeFileSync(reference, sortie);
  console.log(`Référence écrite : ${lignes.length} lignes.`);
  process.exit(0);
}
if (!process.argv.includes('--verifier')) {
  process.stdout.write(sortie);
  process.exit(0);
}

const attendue = readFileSync(reference, 'utf8');
if (attendue === sortie) {
  console.log(`Routes identiques à la référence : ${lignes.filter((l) => !l.startsWith('USE ')).length} routes, ${lignes.filter((l) => l.startsWith('USE ')).length} middlewares.`);
  process.exit(0);
}
const avant = attendue.trimEnd().split('\n');
const apres = lignes;
const max = Math.max(avant.length, apres.length);
console.error('Les routes diffèrent de scripts/routes-reference.txt :');
for (let i = 0; i < max; i += 1) {
  if (avant[i] !== apres[i]) {
    console.error(`  ligne ${i + 1}`);
    console.error(`    référence : ${avant[i] ?? '(absente)'}`);
    console.error(`    actuelle  : ${apres[i] ?? '(absente)'}`);
  }
}
process.exit(1);
