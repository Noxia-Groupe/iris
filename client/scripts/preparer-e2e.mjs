// Prépare une exécution locale des parcours Playwright dans le même état que la CI.
//
// Playwright démarre le backend avec `node dist/index.js` : sans recompilation, il exécute
// le dernier `dist/` produit, éventuellement par une autre branche ou par un test qui a
// modifié temporairement les sources. Hors CI, il réutilise aussi tout serveur déjà à
// l'écoute sur ses ports (`reuseExistingServer`). Ce script recompile donc le backend,
// migre la base jetable et refuse de continuer si un serveur occupe déjà ces ports.
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { REGLE_BASE_JETABLE, estNomBaseJetable } from './base-jetable.mjs';

const racineClient = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dossierServeur = path.join(racineClient, '..', 'server');

const echec = (message) => {
  console.error(`\n[préparation E2E] ${message}\n`);
  process.exit(1);
};

const urlBase = process.env.E2E_DATABASE_URL;
if (!urlBase) echec('E2E_DATABASE_URL est requise : elle doit viser une base PostgreSQL jetable.');
let nomBase;
try {
  nomBase = decodeURIComponent(new URL(urlBase).pathname.replace(/^\//, ''));
} catch {
  echec('E2E_DATABASE_URL n’est pas une URL PostgreSQL valide.');
}
// Les parcours écrivent factures, clients et clés d'API : ne jamais viser une base réelle.
if (!estNomBaseJetable(nomBase)) {
  echec(`La base « ${nomBase} » n’est pas une base jetable (${REGLE_BASE_JETABLE}) : refus de la migrer et d’y écrire.`);
}

const portOccupe = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

const ports = [
  ['API', Number(process.env.E2E_API_PORT || '3001')],
  ['frontend', Number(new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:5199').port)],
];
for (const [role, port] of ports) {
  if (port && await portOccupe(port)) {
    echec(`Un serveur écoute déjà sur le port ${port} (${role}). Playwright le réutiliserait et pourrait tester un ancien code : arrêtez-le, ou choisissez un autre port (E2E_API_PORT / E2E_BASE_URL).`);
  }
}

const executer = (commande, args, env = process.env) => {
  console.log(`[préparation E2E] ${commande} ${args.join(' ')}`);
  try {
    execFileSync(commande, args, { cwd: dossierServeur, env, stdio: 'inherit', shell: process.platform === 'win32' });
  } catch {
    echec(`Échec de « ${commande} ${args.join(' ')} » : Playwright n’est pas lancé.`);
  }
};

executer('npx', ['prisma', 'generate']);
executer('npm', ['run', 'build']);
executer('npx', ['prisma', 'migrate', 'deploy'], { ...process.env, DATABASE_URL: urlBase });
console.log(`[préparation E2E] Backend recompilé et base « ${nomBase} » migrée.`);
