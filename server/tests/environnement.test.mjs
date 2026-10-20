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
// Variables intégrées de Vite, toujours définies : exclues des seules lectures de Vite
// (import.meta.env, %X% d'index.html). process.env.BASE_URL reste une variable à documenter.
const VARIABLES_DE_VITE = new Set(['MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL']);
const EXTENSIONS_DE_CODE = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

// Fichiers d'un dossier, récursivement (profondeur illimitée, ou 0 pour le seul dossier).
function fichiers(chemin, extensions, profondeur = Infinity) {
  const absolu = join(racine, chemin);
  if (statSync(absolu).isFile()) return [chemin];
  return readdirSync(absolu, { withFileTypes: true }).flatMap((entree) => {
    if (['node_modules', 'dist', 'test-results', 'playwright-report'].includes(entree.name) || entree.name.startsWith('.')) return [];
    const enfant = join(chemin, entree.name);
    if (entree.isDirectory()) return profondeur > 0 ? fichiers(enfant, extensions, profondeur - 1) : [];
    return extensions.some((extension) => entree.name.endsWith(extension)) ? [enfant] : [];
  });
}

const NOM = '[A-Z_][A-Z0-9_]*';
// process.env.X, process.env?.X, process.env['X'], process.env?.['X'], et de même pour
// import.meta.env.
const SOURCE = '(?:process\\.env|import\\.meta\\.env)';
// Chaque motif capture la source (premier groupe), puis le nom ou la liste déstructurée.
const LECTURES_DU_CODE = [
  new RegExp(`(${SOURCE})\\??\\.(${NOM})`, 'g'),
  new RegExp(`(${SOURCE})(?:\\?\\.)?\\[\\s*['"\`](${NOM})['"\`]\\s*\\]`, 'g'),
];
// Déstructuration : const { A, B: b, C = 'x' } = process.env (ou import.meta.env)
const DESTRUCTURATION = new RegExp(`\\{([^{}]*)\\}\\s*=\\s*(${SOURCE})\\b`, 'g');
const lueParVite = (source) => source.startsWith('import');
// Accès indirects, qui masqueraient les lectures suivantes au relevé :
//   const env = process.env;   const env: NodeJS.ProcessEnv = process.env;   … = process.env as …;
//   const { env } = process;   process['env']   import.meta['env']
const ACCES_INDIRECTS = [
  new RegExp(`\\b(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*(?::[^=;\\n]+)?=\\s*\\(?\\s*${SOURCE}\\s*\\)?\\s*(?:(?:as|satisfies)\\b[^;\\n]*)?(?:;|$)`, 'gm'),
  /\{[^{}]*\benv\b[^{}]*\}\s*=\s*(?:globalThis\.)?process\b(?!\s*\.)/g,
  /\b(?:process|import\.meta)\s*\[\s*['"`]env['"`]\s*\]/g,
];
const accesIndirects = (texte) => ACCES_INDIRECTS.flatMap((motif) => [...texte.matchAll(motif)].map(([extrait]) => extrait.trim()));

// Variables lues par un texte, selon le type du fichier.
function variablesDuTexte(texte, fichier) {
  const noms = [];
  if (fichier.endsWith('.prisma')) {
    for (const [, nom] of texte.matchAll(new RegExp(`\\benv\\(\\s*"(${NOM})"\\s*\\)`, 'g'))) noms.push(nom);
  } else if (fichier.endsWith('.yml') || fichier.endsWith('.yaml')) {
    // ${X…} et $X ; $$ est un dollar littéral pour Docker Compose.
    for (const [, nom] of texte.matchAll(new RegExp(`(?<!\\$)\\$\\{(${NOM})`, 'g'))) noms.push(nom);
    for (const [, nom] of texte.matchAll(new RegExp(`(?<!\\$)\\$(${NOM})`, 'g'))) noms.push(nom);
  } else if (fichier.endsWith('.html')) {
    // Remplacement de Vite dans index.html : %VITE_X%
    for (const [, nom] of texte.matchAll(new RegExp(`%(${NOM})%`, 'g'))) if (!VARIABLES_DE_VITE.has(nom)) noms.push(nom);
  } else {
    for (const motif of LECTURES_DU_CODE) {
      for (const [, source, nom] of texte.matchAll(motif)) if (!(lueParVite(source) && VARIABLES_DE_VITE.has(nom))) noms.push(nom);
    }
    for (const [, liste, source] of texte.matchAll(DESTRUCTURATION)) {
      for (const morceau of liste.split(',')) {
        const nom = morceau.split(/[:=]/)[0].trim();
        if (new RegExp(`^${NOM}$`).test(nom) && !(lueParVite(source) && VARIABLES_DE_VITE.has(nom))) noms.push(nom);
      }
    }
  }
  return noms.filter((nom) => !VARIABLES_DU_SYSTEME.has(nom));
}

// Variables lues par un groupe de fichiers, chacune avec le premier fichier qui la lit.
function variablesLues(chemins) {
  const lues = new Map();
  for (const fichier of chemins) {
    if (join(racine, fichier) === ici) continue;
    for (const nom of variablesDuTexte(lire(fichier), fichier)) if (!lues.has(nom)) lues.set(nom, fichier);
  }
  return lues;
}

// Variables d'un modèle : lignes « NOM=… », éventuellement commentées (« # NOM=… »).
function variablesDuModele(chemin) {
  return new Set([...lire(chemin).matchAll(new RegExp(`^#?[ \\t]*(${NOM})=`, 'gm'))].map(([, nom]) => nom));
}

const fichiersDesGroupes = {
  application: [...fichiers('server', ['.ts'], 0), ...fichiers('server/src', EXTENSIONS_DE_CODE), 'server/prisma/schema.prisma'],
  outilsServeur: [...fichiers('server/tests', EXTENSIONS_DE_CODE), ...fichiers('server/scripts', EXTENSIONS_DE_CODE)],
  frontend: [...fichiers('client/src', EXTENSIONS_DE_CODE), 'client/index.html'],
  outilsClient: [
    'client/vite.config.ts', 'client/playwright.config.ts',
    ...fichiers('client/scripts', EXTENSIONS_DE_CODE), ...fichiers('client/tests', EXTENSIONS_DE_CODE),
  ],
  compose: ['docker-compose.yml'],
};
const groupes = Object.fromEntries(Object.entries(fichiersDesGroupes).map(([nom, chemins]) => [nom, variablesLues(chemins)]));
const modeleServeur = variablesDuModele('server/.env.example');
const modeleRacine = variablesDuModele('.env.example');
const texteRacine = lire('.env.example');
const documentation = lire('docs/CONFIGURATION-ENVIRONNEMENT.md');

const absentes = (lues, modele) => [...lues].filter(([nom]) => !modele.has(nom)).map(([nom, fichier]) => `${nom} (lue par ${fichier})`);

describe('Variables d’environnement documentées', () => {
  test('le relevé reconnaît chaque forme de lecture, et trouve les variables connues de chaque groupe', () => {
    // Témoin du relevé lui-même : un motif cassé rendrait les autres tests vides et verts. Chaque
    // motif est éprouvé sur un échantillon, y compris ceux qu'aucune lecture actuelle n'emploie.
    const code = [
      'process.env.A_POINTEE', 'process.env?.B_OPTIONNELLE', "process.env['C_CROCHETS']", 'process.env?.["D_CROCHETS"]',
      'import.meta.env.VITE_E', "import.meta.env['VITE_F']",
      'const { G_DESTR, H_DESTR: h, I_DESTR = "x" } = process.env;', 'const { VITE_J } = import.meta.env;',
      'process.env.PATH', 'import.meta.env.DEV', 'const { MODE } = import.meta.env;',
      // Les noms intégrés de Vite ne sont exclus que des lectures de Vite.
      'process.env.BASE_URL', 'const { MODE: m } = process.env;',
    ].join('\n');
    assert.deepEqual(variablesDuTexte(code, 'x.ts').sort(), [
      'A_POINTEE', 'BASE_URL', 'B_OPTIONNELLE', 'C_CROCHETS', 'D_CROCHETS', 'G_DESTR', 'H_DESTR', 'I_DESTR', 'MODE', 'VITE_E', 'VITE_F', 'VITE_J',
    ]);
    assert.deepEqual(variablesDuTexte('url: ${K_GARDE:?k} ${L_REPLI:-l} $M_NUE $$N_LITTERALE', 'x.yml').sort(), ['K_GARDE', 'L_REPLI', 'M_NUE']);
    assert.deepEqual(variablesDuTexte('url = env("O_PRISMA")', 'x.prisma'), ['O_PRISMA']);
    assert.deepEqual(variablesDuTexte('<title>%VITE_P% %MODE%</title>', 'x.html'), ['VITE_P']);
    // Le garde des accès indirects est éprouvé de même, motif par motif.
    const indirects = [
      'const a = process.env;', 'let b: NodeJS.ProcessEnv = process.env;', 'const c = process.env as Record<string, string>;',
      'const { env } = process;', "process['env'].X", 'import.meta["env"].VITE_X',
    ];
    assert.deepEqual(indirects.map((ligne) => accesIndirects(ligne).length), indirects.map(() => 1), 'accès indirects');
    assert.deepEqual(accesIndirects('const x = process.env.X; const { Y } = process.env; f(env = process.env); const e = { ...process.env };'), []);

    assert.ok(groupes.application.has('AZURE_TENANT_ID') && groupes.application.has('AZURE_CLIENT_ID'), 'Microsoft 365');
    assert.ok(groupes.application.has('JWT_SECRET') && groupes.application.has('DATABASE_URL'), 'secret et base');
    assert.ok(groupes.outilsServeur.has('TEST_DATABASE_URL'), 'tests du backend');
    assert.ok(groupes.frontend.has('VITE_API_URL'), 'frontend');
    assert.ok(groupes.outilsClient.has('E2E_DATABASE_URL') && groupes.outilsClient.has('VITE_DEV_API_TARGET'), 'outils du client');
    assert.ok(groupes.compose.has('POSTGRES_PASSWORD'), 'docker-compose');
  });

  test('aucun accès indirect à process.env ou import.meta.env ne masque une lecture', () => {
    const indirects = Object.values(fichiersDesGroupes).flat()
      .filter((fichier) => join(racine, fichier) !== ici && !/\.(prisma|ya?ml|html)$/.test(fichier))
      .flatMap((fichier) => accesIndirects(lire(fichier)).map((extrait) => `${fichier} : ${extrait}`));
    assert.deepEqual(indirects, [], 'lire chaque variable par process.env.X, pour que le relevé la voie');
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
