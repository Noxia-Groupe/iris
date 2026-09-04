import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');

test('API Iris : clés hashées, superadmin et scopes', () => {
  assert.match(schema, /model ApiAccessKey/);
  assert.match(schema, /secretHash\s+String\s+@unique/);
  assert.match(source, /createHash\('sha256'\)/);
  assert.match(source, /app\.post\('\/api\/admin\/api-keys', requireAuth, requireSuperAdmin/);
  assert.match(source, /app\.post\('\/api\/admin\/api-keys\/:id\/revoke', requireAuth, requireSuperAdmin/);
  assert.match(source, /apiKey: secret/);
  assert.doesNotMatch(source.match(/app\.get\('\/api\/admin\/api-keys'[\s\S]*?\n\}\);/)?.[0] || '', /secretHash/);
  assert.match(source, /app\.get\('\/api\/v1\/clients', requireApiKey\('clients:read'\)/);
  assert.match(source, /app\.get\('\/api\/v1\/company', requireApiKey\('company:read'\)/);
});
