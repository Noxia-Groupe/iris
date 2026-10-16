import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Lot (g) : le serveur réellement lancé (node dist/index.js, démarré par Playwright) garde ses
// connexions keep-alive inactives 65 s, et l'annonce. serveur.test.mjs ne couvre que la fonction
// de réglage : ce parcours vérifie qu'elle est bien appliquée au lancement.
test('le serveur lancé garde ses connexions inactives 65 s', async ({ request }) => {
  const reponse = await request.get(`${api}/health`);
  expect(reponse.ok()).toBeTruthy();
  expect(reponse.headers()['keep-alive']).toBe('timeout=65');
});
