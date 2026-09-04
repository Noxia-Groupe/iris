import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

test('Iris expose un CRUD client natif sans route Odoo', () => {
  assert.match(server, /app\.get\('\/api\/clients'/);
  assert.match(server, /app\.post\('\/api\/clients'/);
  assert.match(server, /app\.get\('\/api\/clients\/:id'/);
  assert.match(server, /app\.put\('\/api\/clients\/:id'/);
  assert.match(server, /app\.delete\('\/api\/clients\/:id'/);
  assert.match(server, /prisma\.client\.(findMany|create|findUnique|update)/);
});

test('Iris gère les contacts et les sites par client', () => {
  assert.match(server, /app\.post\('\/api\/clients\/:clientId\/contacts'/);
  assert.match(server, /app\.put\('\/api\/clients\/:clientId\/contacts\/:id'/);
  assert.match(server, /app\.post\('\/api\/clients\/:clientId\/sites'/);
  assert.match(server, /app\.put\('\/api\/clients\/:clientId\/sites\/:id'/);
  assert.match(server, /prisma\.clientContact\.(create|update)/);
  assert.match(server, /prisma\.clientSite\.(create|update)/);
});

test('les routes clients sont réservées aux administrateurs', () => {
  const clientRoutes = server.slice(server.indexOf("app.get('/api/clients'"), server.indexOf("// --- Paramètres singleton"));
  assert.match(clientRoutes, /requireAuth, requireAdmin/);
});
