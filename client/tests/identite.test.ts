import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOM_APPLICATION } from '../src/lib/marque.ts';

// Lot P0 (décision de Nelson du 21-10-2026 : « il ne doit plus y avoir de noxia groupe dans
// l’application, c’est une application ouverte a toute les entreprise ») : aucun nom ni aucune
// couleur de société n'est écrit dans le code livré, client comme serveur. Les migrations déjà
// appliquées, la documentation et le dépôt (README, brand/) restent hors de cette règle.
// Exception à la règle « un test exécute le code » (server/tests/README.md), comme
// environnement.test.mjs : la propriété vérifiée porte sur le texte livré lui-même.
const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fichiers = (dossier: string): string[] => readdirSync(dossier).flatMap((nom) => {
  const chemin = path.join(dossier, nom);
  return statSync(chemin).isDirectory() ? fichiers(chemin) : [chemin];
});
// Migrations déjà appliquées : leur somme de contrôle interdit de les modifier. Toute autre
// migration est livrée dans l'image du serveur et suit la règle.
const MIGRATIONS_FIGEES = ['20260703090000_bareme_commission_commerciale', '20260904210000_parametres_remuneration'];
const livres = [
  ...fichiers(path.join(racine, 'client/src')),
  ...fichiers(path.join(racine, 'server/src')),
  ...fichiers(path.join(racine, 'client/public')).filter((fichier) => !fichier.endsWith('.png')),
  ...fichiers(path.join(racine, 'server/prisma/migrations'))
    .filter((fichier) => !MIGRATIONS_FIGEES.includes(path.basename(path.dirname(fichier)))),
  path.join(racine, 'server/prisma/schema.prisma'),
  path.join(racine, 'server/index.ts'),
  path.join(racine, 'client/index.html'),
  path.join(racine, 'client/nginx.conf'),
  path.join(racine, 'docker-compose.yml'),
];

test('aucun nom de société n’est écrit dans le code livré', () => {
  assert.ok(livres.length > 100, 'les dossiers du code sont bien parcourus');
  const trouves = livres.filter((fichier) => /n[oø]xia/i.test(readFileSync(fichier, 'utf8')));
  assert.deepEqual(trouves.map((fichier) => path.relative(racine, fichier)), []);
});

test('les couleurs de l’ancienne marque ne sont plus celles de l’interface', () => {
  const trouves = livres.filter((fichier) => /#002359|#000726|#0251a1|\b0, ?35, ?89\b|\b2, ?81, ?161\b|\b0, ?7, ?38\b/i.test(readFileSync(fichier, 'utf8')));
  assert.deepEqual(trouves.map((fichier) => path.relative(racine, fichier)), []);
});

// Contrôle textuel seulement : l'affichage du nom est prouvé par l'E2E identite-application.
test('la connexion et le planning public portent le nom de l’application', () => {
  assert.equal(NOM_APPLICATION, 'IRIS');
  for (const page of ['client/src/pages/Login.tsx', 'client/src/pages/PlanningPublic.tsx']) {
    assert.match(readFileSync(path.join(racine, page), 'utf8'), /\{NOM_APPLICATION\}/, page);
  }
});
