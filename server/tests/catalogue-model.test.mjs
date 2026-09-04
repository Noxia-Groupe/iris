import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../prisma/migrations/20260904140000_add_catalogue_and_installed_equipment/migration.sql', import.meta.url), 'utf8');
const categoriesMigration = readFileSync(new URL('../prisma/migrations/20260904141500_add_catalogue_categories/migration.sql', import.meta.url), 'utf8');
const server = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

test('catalogue Iris distingue service, article et équipement installé', () => {
  for (const model of ['CataloguePrestation', 'CatalogueArticle', 'CatalogueEquipement', 'EquipementInstalle']) assert.match(schema, new RegExp(`model ${model}`));
  assert.match(schema, /dureeIndicativeMin/);
  assert.match(schema, /stockSuivi/);
  assert.match(schema, /numeroSerie/);
  assert.match(schema, /garantieJusquAu/);
  assert.match(schema, /clientSiteId/);
  assert.match(schema, /model CatalogueCategorie/);
  assert.match(schema, /parentId/);
  assert.match(schema, /categorie\s+CatalogueCategorie\?/);
  assert.match(categoriesMigration, /CREATE TABLE "CatalogueCategorie"/);
  assert.match(categoriesMigration, /CatalogueCategorie_parentId_fkey/);
  assert.match(migration, /CREATE TABLE "EquipementInstalle"/);
  assert.match(migration, /FOREIGN KEY \("clientSiteId"\) REFERENCES "ClientSite"/);
  assert.match(server, /app\.get\('\/api\/catalogue\/categories', requireAuth, requireAdmin/);
  assert.match(server, /app\.post\('\/api\/catalogue\/categories', requireAuth, requireAdmin/);
  assert.match(server, /app\.get\('\/api\/catalogue\/:family', requireAuth, requireAdmin/);
  assert.match(server, /app\.post\('\/api\/catalogue\/:family', requireAuth, requireAdmin/);
  assert.match(server, /const catalogueModels/);
});
