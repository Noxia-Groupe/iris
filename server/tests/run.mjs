// Lanceur des tests.
//
// `node --test "tests/**/*.test.mjs"` ne fonctionne qu'à partir de Node 21 : les versions
// antérieures ne développent pas les globs et échouent sur « Could not find ». Or la
// production tourne sous Node 20 (cf. les Dockerfile), et la CI teste cette version-là —
// c'est bien le harnais qui doit s'y conformer, pas l'inverse.
//
// Lister les fichiers à la main dans package.json marcherait, mais créerait le piège que
// ce harnais existe précisément pour éviter : un test ajouté et jamais exécuté parce que
// personne n'a pensé à l'inscrire quelque part. La découverte est donc automatique.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dossier = dirname(fileURLToPath(import.meta.url));
const fichiers = readdirSync(dossier)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => join(dossier, f));

if (fichiers.length === 0) {
  console.error('Aucun fichier de test trouvé dans', dossier);
  process.exit(1);
}

const enfant = spawn(process.execPath, ['--test', ...fichiers], { stdio: 'inherit' });
enfant.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
