import process from 'node:process';
import { test, expect, choisirClient } from './fixtures';

test('#109 : pages, action sur page suivante, création et réponse périmée', async ({ allerSurPageAdmin, creerClient, apiAdmin, request, session, page }) => {
  const client = await creerClient('pagination-109');
  const prefixe = `Pagination 109 ${Date.now()}`;
  const ids: string[] = [];
  const companyResponse = await apiAdmin.get('/company');
  expect(companyResponse.ok()).toBeTruthy();
  const { fuseauHoraire } = await companyResponse.json() as { fuseauHoraire?: string };
  const parties = new Intl.DateTimeFormat('en-GB', { timeZone: fuseauHoraire || 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date());
  const valeur = (type: string) => parties.find(partie => partie.type === type)!.value;
  const dateEmission = `${valeur('day')}-${valeur('month')}-${valeur('year')}`;
  for (let index = 0; index < 26; index++) {
    const response = await request.post(`http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api/factures`, { headers: { Authorization: `Bearer ${session.token}` }, data: {
      clientId: client.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: `${prefixe} ${index}`,
      dateEmission, dateEcheance: dateEmission,
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
  // Les factures historiques peuvent être datées plus tard : vérifier la continuité
  // de nos 26 brouillons dans le tri global, sans supposer qu'ils occupent la page 1.
  const tousLesIds = [...premierLot.items, ...secondLot.items].map(item => item.id);
  for (let pageApi = 3; pageApi <= nombrePages; pageApi++) {
    const reponse = await apiAdmin.get(`/factures?page=${pageApi}&pageSize=25`);
    expect(reponse.ok()).toBeTruthy();
    const lot = await reponse.json() as { items: { id: string }[] };
    tousLesIds.push(...lot.items.map(item => item.id));
  }
  const debut = tousLesIds.indexOf(ids[25]);
  expect(debut).toBeGreaterThanOrEqual(0);
  expect(tousLesIds.slice(debut, debut + ids.length)).toEqual(ids.toReversed());
  const pageAncienne = Math.floor((debut + 25) / 25) + 1;
  expect(pageAncienne).toBeGreaterThan(1);
  await allerSurPageAdmin('/factures');
  await expect(page.getByTestId('pagination-factures')).toContainText(`Page 1 sur ${nombrePages}`);
  await expect(page.locator('tbody tr')).toHaveCount(25);
  await expect(page.locator('tbody tr', { hasText: `${prefixe} 0` })).toHaveCount(0);
  const premiereLigne = page.locator('tbody tr').first();
  const textePremiereLigne = await premiereLigne.textContent();
  await premiereLigne.getByRole('button', { name: 'Voir l’origine' }).click();
  await expect(page.getByRole('region', { name: 'Origine de la facture' })).toBeVisible();
  for (let numero = 2; numero < pageAncienne; numero++) {
    await page.getByRole('button', { name: 'Page suivante' }).click();
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
  }

  let libererChargement!: () => void;
  const attenteChargement = new Promise<void>(resolve => { libererChargement = resolve; });
  let signalerRequete!: () => void;
  const requeteEnCours = new Promise<void>(resolve => { signalerRequete = resolve; });
  const routePageAncienne = `**/api/factures?page=${pageAncienne}&pageSize=25`;
  await page.route(routePageAncienne, async route => {
    signalerRequete();
    await attenteChargement;
    await route.fulfill({ status: 503, json: { error: 'Échec contrôlé pagination #109' } });
  });
  await page.getByRole('button', { name: 'Page suivante' }).click();
  await requeteEnCours;
  try {
    await expect(page.getByTestId('pagination-factures')).toContainText(`Page ${pageAncienne} sur ${nombrePages}`);
    await expect(page.getByRole('region', { name: 'Origine de la facture' })).toHaveCount(0);
    await expect(page.locator('tbody [role="status"]')).toContainText('Chargement des factures');
    await expect(page.locator('tbody tr', { hasText: `${prefixe} 0` })).toHaveCount(0);
    await expect(page.locator('tbody tr').getByRole('button', { name: 'Émettre' })).toHaveCount(0);
  } finally {
    libererChargement();
  }
  await expect(page.getByText('Échec contrôlé pagination #109')).toBeVisible();
  await expect(page.locator('tbody tr', { hasText: `${prefixe} 0` })).toHaveCount(0);
  await page.unroute(routePageAncienne);
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await expect(page.getByTestId('pagination-factures')).toContainText(`Page ${pageAncienne} sur ${nombrePages}`);
  const ancienne = page.locator('tbody tr', { hasText: `${prefixe} 0` });
  await expect(ancienne).toBeVisible();
  await ancienne.getByRole('button', { name: 'Voir l’origine' }).click();
  await expect(page.getByRole('region', { name: 'Origine de la facture' })).toContainText(`${prefixe} 0`);
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await expect(ancienne).toBeVisible();
  await ancienne.getByRole('button', { name: 'Émettre' }).click();
  await expect(ancienne).toContainText('EMISE');
  await expect(page.getByTestId('pagination-factures')).toContainText(`Page ${pageAncienne} sur ${nombrePages}`);
  for (let numero = pageAncienne; numero > 1; numero--) {
    await page.getByRole('button', { name: 'Page précédente' }).click();
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
  }
  await expect(page.getByRole('region', { name: 'Origine de la facture' })).toHaveCount(0);
  await expect(page.getByTestId('pagination-factures')).toContainText(`Page 1 sur ${nombrePages}`);

  // La réponse ancienne arrive après le retour en page 1 ; elle ne doit rien remplacer.
  const routePage2 = '**/api/factures?page=2&pageSize=25';
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

  // Une erreur ancienne livrée après le succès de la nouvelle page ne doit pas réapparaître.
  let libererErreur!: () => void;
  let signalerErreur!: () => void;
  const erreurAttendue = new Promise<void>(resolve => { libererErreur = resolve; });
  const requeteErreur = new Promise<void>(resolve => { signalerErreur = resolve; });
  await page.route(routePage2, async route => {
    signalerErreur();
    await erreurAttendue;
    await route.fulfill({ status: 503, json: { error: 'Erreur périmée #109' } });
  });
  await page.getByRole('button', { name: 'Page suivante' }).click();
  await requeteErreur;
  await page.getByRole('button', { name: 'Page précédente' }).click();
  await expect.poll(() => premiereLigne.textContent()).toBe(textePremiereLigne);
  const erreurLivree = page.waitForResponse(response => response.url().includes('/api/factures?page=2&pageSize=25') && response.status() === 503);
  libererErreur();
  await (await erreurLivree).finished();
  // Laisser la promesse de lecture JSON et le rendu React traiter la réponse livrée.
  await page.waitForTimeout(100);
  await expect(page.getByText('Erreur périmée #109')).toHaveCount(0);
  await expect.poll(() => premiereLigne.textContent()).toBe(textePremiereLigne);
  await page.unroute(routePage2);

  // Le total peut diminuer entre deux lectures : simuler sans supprimer de facture réelle.
  await page.route(routePage2, route => route.fulfill({ json: { page: 2, pageSize: 25, total: 25, items: [] } }));
  await page.getByRole('button', { name: 'Page suivante' }).click();
  await expect(page.getByTestId('pagination-factures')).toContainText(`Page 1 sur ${nombrePages}`);
  await expect.poll(() => premiereLigne.textContent()).toBe(textePremiereLigne);
  await expect(page.getByText('Aucune facture.')).toHaveCount(0);
  await page.unroute(routePage2);

  await page.getByRole('button', { name: 'Page suivante' }).click();
  await expect(page.getByTestId('pagination-factures')).toContainText(`Page 2 sur ${nombrePages}`);
  await page.getByRole('button', { name: 'Nouvelle facture' }).click();
  await choisirClient(page, client);
  await page.locator('input[name="motifHorsAffaire"]').fill(`${prefixe} nouveau`);
  await page.locator('input[aria-label="Désignation ligne 1"]').fill('Nouvelle prestation');
  await page.locator('input[aria-label="Prix unitaire HT ligne 1"]').fill('10');
  const nouveauRecharge = page.waitForResponse(response => response.url().includes('/api/factures?page=1&pageSize=25') && response.ok());
  await page.getByRole('button', { name: 'Créer le brouillon' }).click();
  await (await nouveauRecharge).finished();
  await expect(page.getByText(/Brouillon créé/)).toBeVisible();
  await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
  await expect(page.getByTestId('pagination-factures')).toContainText('Page 1 sur');
  const nouveau = page.locator('tbody tr', { hasText: `${prefixe} nouveau` });
  while (!(await nouveau.count())) {
    const suivante = page.getByRole('button', { name: 'Page suivante' });
    expect(await suivante.isEnabled(), 'nouveau brouillon absent de la pagination').toBeTruthy();
    await suivante.click();
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
  }
  await expect(nouveau).toContainText('BROUILLON');
  while (await page.getByRole('button', { name: 'Page précédente' }).isEnabled()) {
    await page.getByRole('button', { name: 'Page précédente' }).click();
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
  }
  const pagine = await apiAdmin.get('/factures?page=1&pageSize=25');
  expect(pagine.ok()).toBeTruthy();
  const totalApresCreation = (await pagine.json() as { total: number }).total;
  expect(totalApresCreation).toBeGreaterThanOrEqual(ids.length + 1);
  await expect(page.getByTestId('pagination-factures')).toContainText(`Page 1 sur ${Math.ceil(totalApresCreation / 25)}`);

  // Un brouillon antidaté reste trié parmi les anciennes factures, pas forcément en page 1.
  await page.getByRole('button', { name: 'Nouvelle facture' }).click();
  await choisirClient(page, client);
  await page.locator('input[name="dateEmission"]').fill('01-01-2020');
  await page.locator('input[name="dateEcheance"]').fill('01-01-2020');
  await page.locator('input[name="motifHorsAffaire"]').fill(`${prefixe} antidaté`);
  await page.locator('input[aria-label="Désignation ligne 1"]').fill('Prestation antidatée');
  await page.locator('input[aria-label="Prix unitaire HT ligne 1"]').fill('10');
  await page.getByRole('button', { name: 'Créer le brouillon' }).click();
  await expect(page.getByTestId('pagination-factures')).toContainText(`Page 1 sur ${Math.ceil((totalApresCreation + 1) / 25)}`);
  await expect(page.locator('tbody tr', { hasText: `${prefixe} antidaté` })).toHaveCount(0);
  await expect(page.getByText(/Brouillon créé.*date d’émission.*pages suivantes/)).toBeVisible();
  let position = -1;
  for (let pageApi = 1; pageApi <= Math.ceil((totalApresCreation + 1) / 100); pageApi++) {
    const reponse = await apiAdmin.get(`/factures?page=${pageApi}&pageSize=100`);
    expect(reponse.ok()).toBeTruthy();
    const lot = await reponse.json() as { items: { motifHorsAffaire: string | null }[] };
    const index = lot.items.findIndex(item => item.motifHorsAffaire === `${prefixe} antidaté`);
    if (index >= 0) { position = (pageApi - 1) * 100 + index; break; }
  }
  expect(position).toBeGreaterThanOrEqual(25);
  const pageCible = Math.floor(position / 25) + 1;
  for (let index = 1; index < pageCible; index++) await page.getByRole('button', { name: 'Page suivante' }).click();
  await expect(page.locator('tbody tr', { hasText: `${prefixe} antidaté` })).toBeVisible();
});

test('une erreur export/PDF survit au rechargement ; une erreur de liste disparaît à la reprise', async ({ allerSurPageAdmin, page }) => {
  await allerSurPageAdmin('/factures');
  let liberer!: () => void;
  let signaler!: () => void;
  const attente = new Promise<void>(resolve => { liberer = resolve; });
  const commence = new Promise<void>(resolve => { signaler = resolve; });
  const liste = '**/api/factures?page=1&pageSize=25';
  await page.route(liste, async route => { signaler(); await attente; await route.continue(); });
  await page.route('**/api/factures/export-comptable.csv', route => route.fulfill({ status: 503, json: { error: 'Export refusé pour test' } }));
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await commence;
  await page.getByRole('button', { name: 'Export comptable' }).click();
  await expect(page.getByText('Export refusé pour test')).toBeVisible();
  const terminee = page.waitForResponse(response => response.url().includes('/api/factures?page=1&pageSize=25') && response.status() === 200);
  liberer();
  await (await terminee).finished();
  await expect(page.getByText('Export refusé pour test')).toBeVisible();
  await page.unroute(liste);
  await page.unroute('**/api/factures/export-comptable.csv');

  const pdf = page.getByRole('button', { name: 'PDF' }).first();
  while (await pdf.count() === 0 && await page.getByRole('button', { name: 'Page suivante' }).isEnabled()) {
    const fin = page.waitForResponse(response => response.url().includes('/api/factures?page=') && response.status() === 200);
    await page.getByRole('button', { name: 'Page suivante' }).click();
    await (await fin).finished();
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
  }
  await expect(pdf).toBeVisible();
  await page.route('**/api/factures/*/document.pdf', route => route.fulfill({ status: 503, json: { error: 'PDF refusé pour test' } }));
  await pdf.click();
  await expect(page.getByText('PDF refusé pour test')).toBeVisible();
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await expect(page.getByText('PDF refusé pour test')).toBeVisible();
  await page.unroute('**/api/factures/*/document.pdf');
  while (await page.getByRole('button', { name: 'Page précédente' }).isEnabled()) {
    await page.getByRole('button', { name: 'Page précédente' }).click();
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
  }
  await expect(page.getByText('PDF refusé pour test')).toBeVisible();

  await page.route(liste, route => route.fulfill({ status: 503, json: { error: 'Liste refusée pour test' } }));
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await expect(page.getByText('Liste refusée pour test')).toBeVisible();
  await page.unroute(liste);
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await expect(page.getByText('Liste refusée pour test')).toHaveCount(0);
});
