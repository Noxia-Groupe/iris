import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const loginPage = readFileSync(new URL('../../client/src/pages/Login.tsx', import.meta.url), 'utf8');
const adminPage = readFileSync(new URL('../../client/src/pages/Admin.tsx', import.meta.url), 'utf8');

test('Iris n’expose pas de connexion locale par mot de passe', () => {
  assert.doesNotMatch(server, /app\.post\('\/api\/login'/);
  assert.doesNotMatch(server, /bcryptjs/);
  assert.doesNotMatch(server, /bcrypt\./);
  assert.doesNotMatch(server, /ADMIN_PASSWORD/);
  assert.doesNotMatch(loginPage, /handleLogin/);
  assert.doesNotMatch(loginPage, /type="password"/);
  assert.doesNotMatch(adminPage, /handlePasswordChange/);
  assert.doesNotMatch(adminPage, /Changer Mdp/);
});

test('Iris conserve la connexion Microsoft et sa validation côté serveur', () => {
  assert.match(server, /app\.post\('\/api\/auth\/sso'/);
  assert.match(server, /verifyMicrosoftIdentity/);
  assert.match(loginPage, /Connexion Microsoft 365/);
});
