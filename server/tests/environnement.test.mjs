// Variables d'environnement documentées (consigne de Nelson du 20-10-2026) : une installation
// doit trouver dans les modèles toutes les variables à renseigner, Microsoft 365 compris, et
// ces modèles doivent suivre le code au fil des lots. Chaque variable lue par le code figure
// donc dans le bon modèle (.env.example ou server/.env.example) et dans
// docs/CONFIGURATION-ENVIRONNEMENT.md ; un modèle ne garde aucune variable que plus rien ne lit.
// Le test lit les sources : il ne demande ni base ni compilation.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const ici = fileURLToPath(import.meta.url);
const racine = join(dirname(ici), '..', '..');
const lire = (chemin) => readFileSync(join(racine, chemin), 'utf8');

// Variables du système, que personne ne renseigne : le relevé des routes transmet PATH à
// son processus enfant.
const VARIABLES_DU_SYSTEME = new Set(['PATH']);
// Variables intégrées de Vite, toujours définies.
const VARIABLES_DE_VITE = new Set(['MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL']);

function fichiers(chemin, extensions) {
  const absolu = join(racine, chemin);
  if (statSync(absolu).isFile()) return [chemin];
  return readdirSync(absolu, { withFileTypes: true }).flatMap((entree) => {
    if (['node_modules', 'dist', 'test-results', 'playwright-report'].includes(entree.name) || entree.name.startsWith('.')) return [];
    const enfant = join(chemin, entree.name);
    if (entree.isDirectory()) return fichiers(enfant, extensions);
    return extensions.some((extension) => entree.name.endsWith(extension)) ? [enfant] : [];
  });
}

const NOM = '[A-Z_][A-Z0-9_]*';
const LECTURES_DU_CODE = [
  new RegExp(`process\\.env\\.(${NOM})`, 'g'),
  new RegExp(`process\\.env\\[\\s*['"\`](${NOM})['"\`]\\s*\\]`, 'g'),
  new RegExp(`import\\.meta\\.env\\.(${NOM})`, 'g'),
];

// Variables lues par un groupe de fichiers, chacune avec le premier fichier qui la lit.
function variablesLues(chemins) {
  const lues = new Map();
  const noter = (nom, fichier) => {
    if (!VARIABLES_DU_SYSTEME.has(nom) && !VARIABLES_DE_VITE.has(nom) && !lues.has(nom)) lues.set(nom, fichier);
  };
  for (const fichier of chemins) {
    if (join(racine, fichier) === ici) continue;
    const texte = lire(fichier);
    if (fichier.endsWith('.prisma')) {
      for (const [, nom] of texte.matchAll(new RegExp(`\\benv\\(\\s*"(${NOM})"\\s*\\)`, 'g'))) noter(nom, fichier);
    } else if (fichier.endsWith('.yml')) {
      for (const [, nom] of texte.matchAll(new RegExp(`\\$\\{(${NOM})`, 'g'))) noter(nom, fichier);
    } else {
      for (const motif of LECTURES_DU_CODE) for (const [, nom] of texte.matchAll(motif)) noter(nom, fichier);
      // Déstructuration : const { A, B: b } = process.env
      for (const [, liste] of texte.matchAll(/\{([^{}]*)\}\s*=\s*process\.env\b/g)) {
        for (const morceau of liste.split(',')) {
          const nom = morceau.split(/[:=]/)[0].trim();
          if (new RegExp(`^${NOM}$`).test(nom)) noter(nom, fichier);
        }
      }
    }
  }
  return lues;
}

// Variables d'un modèle : lignes « NOM=… », éventuellement commentées (« # NOM=… »).
function variablesDuModele(chemin) {
  return new Set([...lire(chemin).matchAll(new RegExp(`^#?[ \\t]*(${NOM})=`, 'gm'))].map(([, nom]) => nom));
}

const groupes = {
  application: variablesLues([
    'server/index.ts', ...fichiers('server/src', ['.ts']), 'server/prisma/schema.prisma',
  ]),
  outilsServeur: variablesLues([...fichiers('server/tests', ['.mjs']), ...fichiers('server/scripts', ['.mjs'])]),
  frontend: variablesLues(fichiers('client/src', ['.ts', '.tsx'])),
  outilsClient: variablesLues([
    'client/vite.config.ts', 'client/playwright.config.ts',
    ...fichiers('client/scripts', ['.mjs']), ...fichiers('client/tests', ['.ts']),
  ]),
  compose: variablesLues(['docker-compose.yml']),
};
const modeleServeur = variablesDuModele('server/.env.example');
const modeleRacine = variablesDuModele('.env.example');
const texteRacine = lire('.env.example');
const documentation = lire('docs/CONFIGURATION-ENVIRONNEMENT.md');

const absentes = (lues, modele) => [...lues].filter(([nom]) => !modele.has(nom)).map(([nom, fichier]) => `${nom} (lue par ${fichier})`);

describe('Variables d’environnement documentées', () => {
  test('le relevé trouve les variables connues, dans chaque groupe', () => {
    // Témoin du relevé lui-même : un motif cassé rendrait les autres tests vides et verts.
    assert.ok(groupes.application.has('AZURE_TENANT_ID') && groupes.application.has('AZURE_CLIENT_ID'), 'Microsoft 365');
    assert.ok(groupes.application.has('JWT_SECRET') && groupes.application.has('DATABASE_URL'), 'secret et base');
    assert.ok(groupes.outilsServeur.has('TEST_DATABASE_URL'), 'tests du backend');
    assert.ok(groupes.frontend.has('VITE_API_URL'), 'frontend');
    assert.ok(groupes.outilsClient.has('E2E_DATABASE_URL') && groupes.outilsClient.has('VITE_DEV_API_TARGET'), 'outils du client');
    assert.ok(groupes.compose.has('POSTGRES_PASSWORD'), 'docker-compose');
  });

  test('chaque variable du backend et de ses outils figure dans server/.env.example', () => {
    assert.deepEqual(absentes(new Map([...groupes.application, ...groupes.outilsServeur]), modeleServeur), []);
  });

  test('chaque variable du frontend, de docker-compose et des outils du client figure dans .env.example', () => {
    assert.deepEqual(absentes(new Map([...groupes.frontend, ...groupes.outilsClient, ...groupes.compose]), modeleRacine), []);
  });

  test('.env.example rappelle chaque variable de l’application à mettre dans server/.env', () => {
    const oubliees = [...groupes.application.keys()].filter((nom) => !new RegExp(`\\b${nom}\\b`).test(texteRacine));
    assert.deepEqual(oubliees, []);
  });

  test('chaque variable lue est décrite dans docs/CONFIGURATION-ENVIRONNEMENT.md', () => {
    const toutes = new Set(Object.values(groupes).flatMap((lues) => [...lues.keys()]));
    assert.deepEqual([...toutes].filter((nom) => !documentation.includes(`\`${nom}\``)).sort(), []);
  });

  test('aucun modèle ne garde une variable que plus rien ne lit', () => {
    const luesServeur = new Set([...groupes.application.keys(), ...groupes.outilsServeur.keys()]);
    const luesRacine = new Set([...groupes.frontend.keys(), ...groupes.outilsClient.keys(), ...groupes.compose.keys()]);
    assert.deepEqual([...modeleServeur].filter((nom) => !luesServeur.has(nom)), [], 'server/.env.example');
    assert.deepEqual([...modeleRacine].filter((nom) => !luesRacine.has(nom)), [], '.env.example');
  });
});
