import { test, expect } from './fixtures';

// Une liste d'Administration qui ne se charge pas (erreur serveur) ne fait plus planter l'écran :
// il le signale et reste utilisable. Avant, la réponse d'erreur remplaçait la liste des chantiers
// et la page tombait sur l'écran d'erreur (« chantiers.map is not a function »).
test('Administration : une liste qui ne se charge pas est signalée, sans faire planter l’écran', async ({ page, allerSurPageAdmin }) => {
  let refus = 0;
  await page.route('**/api/chantiers', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    refus += 1;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Error fetching chantiers' }) });
  });

  const admin = await allerSurPageAdmin('/admin');
  const alerte = admin.getByRole('alert').filter({ hasText: 'Cette liste n’a pas pu être chargée' });
  await expect(alerte).toBeVisible();
  expect(refus, 'la liste des chantiers a bien été demandée').toBeGreaterThan(0);
  await expect(admin.getByRole('heading', { name: 'Créer un nouveau chantier' })).toBeVisible();

  // L'écran reste utilisable : un autre onglet s'ouvre et le message disparaît.
  await page.unroute('**/api/chantiers');
  await admin.getByRole('button', { name: 'Fournisseurs', exact: true }).click();
  await expect(alerte).toHaveCount(0);
  // Revenu sur l'onglet, la liste se charge de nouveau, sans message.
  const rechargement = admin.waitForResponse((r) => r.url().endsWith('/api/chantiers') && r.request().method() === 'GET');
  await admin.getByRole('button', { name: 'Chantiers', exact: true }).click();
  expect((await rechargement).status()).toBe(200);
  await expect(alerte).toHaveCount(0);
});
