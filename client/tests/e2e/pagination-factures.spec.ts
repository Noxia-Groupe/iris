import process from 'node:process';
import { test, expect, dateDuJour } from './fixtures';

test('#109 : pages, action sur page suivante, création et réponse périmée', async ({ allerSurPageAdmin, creerClient, apiAdmin, request, session, page }) => {
  const client = await creerClient('pagination-109');
  const prefixe = `Pagination 109 ${Date.now()}`;
  const ids: string[] = [];
  for (let index = 0; index < 26; index++) {
    const response = await request.post(`http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api/factures`, { headers: { Authorization: `Bearer ${session.token}` }, data: {
      clientId: client.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: `${prefixe} ${index}`,
      dateEmission: dateDuJour(), dateEcheance: dateDuJour(),
      lignes: [{ designation: `Service ${index}`, quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }],
    } });
    expect(response.status(), await response.text()).toBe(201);
    ids.push((await response.json() as { id: string }).id);
  }
  const premierePage = await apiAdmin.get('/factures?page=1&pageSize=25');
  const secondePage = await apiAdmin.get('/factures?page=2&pageSize=25');
  expect(premierePage.ok()).toBeTruthy();
  expect(secondePage.ok()).toBeTruthy();
  const premierLot = await premierePage.json() as { total: number; items: { id: string }[] };
  const secondLot = await secondePage.json() as { items: { id: string }[] };
  const nombrePages = Math.ceil(premierLot.total / 25);
  expect(nombrePages).toBeGreaterThanOrEqual(2);
  expect(premierLot.items.map(item => item.id)).toEqual(ids.slice(1).reverse());
  expect(secondLot.items[0].id).toBe(ids[0]);
  await allerSurPageAdmin('/factures');
  await expect(page.getByTestId('pagination-factures')).toContainText(`Page 1 sur ${nombrePages}`);
  await expect(page.locator('tbody tr')).toHaveCount(25);
  await expect(page.locator('tbody tr', { hasText: `${prefixe} 0` })).toHaveCount(0);
  const premiereLigne = page.locator('tbody tr', { hasText: `${prefixe} 25` });
  await premiereLigne.getByRole('button', { name: 'Voir l’origine' }).click();
  await expect(page.getByRole('region', { name: 'Origine de la facture' })).toBeVisible();

  let libererChargement!: () => void;
  const attenteChargement = new Promise<void>(resolve => { libererChargement = resolve; });
  let signalerRequete!: () => void;
  const requeteEnCours = new Promise<void>(resolve => { signalerRequete = resolve; });
  const routePage2 = '**/api/factures?page=2&pageSize=25';
  await page.route(routePage2, async route => {
    signalerRequete();
    await attenteChargement;
    await route.fulfill({ status: 503, json: { error: 'Échec contrôlé pagination #109' } });
  });
  await page.getByRole('button', { name: 'Page suivante' }).click();
  await requeteEnCours;
  try {
    await expect(page.getByTestId('pagination-factures')).toContainText(`Page 2 sur ${nombrePages}`);
    await expect(page.getByRole('region', { name: 'Origine de la facture' })).toHaveCount(0);
    await expect(page.locator('tbody [role="status"]')).toContainText('Chargement des factures');
    await expect(page.locator('tbody tr', { hasText: `${prefixe} 25` })).toHaveCount(0);
    await expect(page.locator('tbody tr').getByRole('button', { name: 'Émettre' })).toHaveCount(0);
  } finally {
    libererChargement();
  }
  await expect(page.getByText('Échec contrôlé pagination #109')).toBeVisible();
  await expect(page.locator('tbody tr', { hasText: `${prefixe} 25` })).toHaveCount(0);
  await page.unroute(routePage2);
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await expect(page.getByTestId('pagination-factures')).toContainText(`Page 2 sur ${nombrePages}`);
  const ancienne = page.locator('tbody tr', { hasText: `${prefixe} 0` });
  await expect(ancienne).toBeVisible();
  await ancienne.getByRole('button', { name: 'Voir l’origine' }).click();
  await expect(page.getByRole('region', { name: 'Origine de la facture' })).toContainText(`${prefixe} 0`);
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await expect(ancienne).toBeVisible();
  await ancienne.getByRole('button', { name: 'Émettre' }).click();
  await expect(ancienne).toContainText('EMISE');
  await expect(page.getByTestId('pagination-factures')).toContainText(`Page 2 sur ${nombrePages}`);
  await page.getByRole('button', { name: 'Page précédente' }).click();
  await expect(page.getByRole('region', { name: 'Origine de la facture' })).toHaveCount(0);
  await expect(page.getByTestId('pagination-factures')).toContainText(`Page 1 sur ${nombrePages}`);

  // La réponse ancienne arrive après le retour en page 1 ; elle ne doit rien remplacer.
  let liberer!: () => void;
  const attente = new Promise<void>(resolve => { liberer = resolve; });
  await page.route('**/api/factures?page=2&pageSize=25', async route => { await attente; await route.continue(); });
  await page.getByRole('button', { name: 'Page suivante' }).click();
  await page.getByRole('button', { name: 'Page précédente' }).click();
  const ancienneLivree = page.waitForResponse(response => response.url().includes('/api/factures?page=2&pageSize=25'));
  liberer();
  await (await ancienneLivree).finished();
  await expect(page.getByTestId('pagination-factures')).toContainText(`Page 1 sur ${nombrePages}`);
  await expect(page.locator('tbody tr', { hasText: `${prefixe} 0` })).toHaveCount(0);
  await page.unroute('**/api/factures?page=2&pageSize=25');

  await page.getByRole('button', { name: 'Page suivante' }).click();
  await expect(page.getByTestId('pagination-factures')).toContainText(`Page 2 sur ${nombrePages}`);
  await page.getByRole('button', { name: 'Nouvelle facture' }).click();
  await page.locator('select[name="clientId"]').selectOption(client.id);
  await page.locator('input[name="motifHorsAffaire"]').fill(`${prefixe} nouveau`);
  await page.locator('input[aria-label="Désignation ligne 1"]').fill('Nouvelle prestation');
  await page.locator('input[aria-label="Prix unitaire HT ligne 1"]').fill('10');
  await page.getByRole('button', { name: 'Créer le brouillon' }).click();
  await expect(page.locator('tbody tr', { hasText: `${prefixe} nouveau` })).toBeVisible();
  const pagine = await apiAdmin.get('/factures?page=1&pageSize=25');
  expect(pagine.ok()).toBeTruthy();
  const totalApresCreation = (await pagine.json() as { total: number }).total;
  expect(totalApresCreation).toBeGreaterThanOrEqual(ids.length + 1);
  await expect(page.getByTestId('pagination-factures')).toContainText(`Page 1 sur ${Math.ceil(totalApresCreation / 25)}`);
});
