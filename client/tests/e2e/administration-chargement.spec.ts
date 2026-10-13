import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const MESSAGE = 'Cette liste n’a pas pu être chargée';

// La liste des chantiers répond 500, après un délai éventuel ; les autres requêtes passent.
async function chantiersEnErreur(page: Page, delai = 0) {
  await page.route('**/api/chantiers', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (delai) await new Promise((resolve) => setTimeout(resolve, delai));
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Error fetching chantiers' }) });
  });
}

// Laisse au navigateur le temps de traiter une réponse déjà reçue (rendu React planifié).
const laisserRendre = (page: Page) => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));

// Une liste d'Administration qui ne se charge pas (erreur serveur) ne fait plus planter l'écran :
// il le signale et reste utilisable. Avant, la réponse d'erreur remplaçait la liste des chantiers
// et la page tombait sur l'écran d'erreur (« chantiers.map is not a function »).
test('Administration : une liste qui ne se charge pas est signalée, sans faire planter l’écran, puis se recharge', async ({ page, allerSurPageAdmin, request, session }) => {
  await chantiersEnErreur(page);
  const admin = await allerSurPageAdmin('/admin');
  const alerte = admin.getByRole('alert').filter({ hasText: MESSAGE });
  await expect(alerte).toBeVisible();
  await expect(admin.getByRole('heading', { name: 'Créer un nouveau chantier' })).toBeVisible();

  // L'écran reste utilisable : un autre onglet charge sa liste, sans message.
  const fournisseur = `Fournisseur chargement E2E ${Date.now()}`;
  const creation = await request.post(`${api}/fournisseurs`, { headers: { Authorization: `Bearer ${session.token}` }, data: { nom: fournisseur } });
  expect(creation.ok(), await creation.text()).toBeTruthy();
  await page.unroute('**/api/chantiers');
  await admin.getByRole('button', { name: 'Fournisseurs', exact: true }).click();
  await expect(admin.getByText(fournisseur)).toBeVisible();
  await expect(alerte).toHaveCount(0);

  // Revenu sur l'onglet, la liste des chantiers se charge de nouveau, sans message.
  const rechargement = admin.waitForResponse((r) => r.url().endsWith('/api/chantiers') && r.request().method() === 'GET');
  await admin.getByRole('button', { name: 'Chantiers', exact: true }).click();
  expect((await rechargement).status()).toBe(200);
  await laisserRendre(admin);
  await expect(alerte).toHaveCount(0);
});

// Le message appartient à l'onglet dont la liste a échoué : une réponse arrivée après un
// changement d'onglet, ou demandée pour l'onglet précédent, ne s'affiche pas ailleurs.
test('Administration : le message d’une liste en erreur reste attaché à son onglet', async ({ page, allerSurPageAdmin }) => {
  // Session ouverte sur une autre page, pour charger Administration sans attendre le réseau.
  const admin = await allerSurPageAdmin('/');
  const alerte = admin.getByRole('alert').filter({ hasText: MESSAGE });

  // Réponse en erreur tardive : on est passé sur Fournisseurs avant qu'elle n'arrive.
  await chantiersEnErreur(admin, 1500);
  const tardive = admin.waitForResponse((r) => r.url().endsWith('/api/chantiers'));
  await admin.goto('/admin', { waitUntil: 'domcontentloaded' });
  await admin.getByRole('button', { name: 'Fournisseurs', exact: true }).click();
  expect((await tardive).status()).toBe(500);
  await laisserRendre(admin);
  await expect(alerte).toHaveCount(0);

  // Sur Chantiers, la liste échoue et le message s'affiche ; il ne suit pas sur Marges.
  await page.unroute('**/api/chantiers');
  await chantiersEnErreur(admin);
  await admin.getByRole('button', { name: 'Chantiers', exact: true }).click();
  await expect(alerte).toBeVisible();
  await admin.getByRole('button', { name: 'Marges & Commissions', exact: true }).click();
  await expect(alerte).toHaveCount(0);
  await laisserRendre(admin);
  await expect(alerte).toHaveCount(0);

  // Un échec réseau (requête interrompue) est signalé de même, sur l'onglet concerné.
  await admin.route('**/api/fournisseurs', (route) => (route.request().method() === 'GET' ? route.abort('failed') : route.continue()));
  await admin.getByRole('button', { name: 'Fournisseurs', exact: true }).click();
  await expect(alerte).toBeVisible();
});
