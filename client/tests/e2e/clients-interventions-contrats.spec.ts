import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// #111 : une intervention SAV et un contrat de maintenance se créent pour un client hors des
// 200 premiers (ordre alphabétique), retrouvé par la recherche serveur. La base E2E est
// volontairement conservée entre deux passages de la suite.
test('#111 : intervention et contrat pour un client hors des 200 premiers', async ({ allerSurPageAdmin, request, session }) => {
  test.slow();
  const headers = auth(session.token);
  // 200 clients d'un même préfixe : la recherche doit annoncer sa limite.
  const prefixeLimite = `E2E 111 limite ${Date.now()}`;
  for (let i = 0; i < 200; i += 20) {
    const reponses = await Promise.all(Array.from({ length: 20 }, (_, j) =>
      request.post(`${api}/clients`, { headers, data: { raisonSociale: `${prefixeLimite} ${String(i + j).padStart(3, '0')}` } })));
    for (const reponse of reponses) expect(reponse.status(), await reponse.text()).toBe(201);
  }
  // Le client cible, placé en fin d'alphabet, avec un site et un contact.
  const prefixe = `ZZZ E2E 111 ${Date.now()}`;
  const cible = await request.post(`${api}/clients`, { headers, data: { raisonSociale: `${prefixe} cible` } });
  expect(cible.status(), await cible.text()).toBe(201);
  const clientId = (await cible.json()).id as string;
  const site = await request.post(`${api}/clients/${clientId}/sites`, { headers, data: { nom: 'Site 111', adresse: '1 rue du Parcours', codePostal: '14000', ville: 'Caen', estSiteIntervention: true } });
  expect(site.status(), await site.text()).toBe(201);
  const contact = await request.post(`${api}/clients/${clientId}/contacts`, { headers, data: { nom: 'Contact111', prenom: 'Léa' } });
  expect(contact.status(), await contact.text()).toBe(201);
  // Témoin : sans recherche, la liste des 200 premiers ne contient pas ce client.
  expect((await (await request.get(`${api}/clients`, { headers })).json()).clients.some((c: { id: string }) => c.id === clientId)).toBe(false);

  // Intervention SAV.
  const page = await allerSurPageAdmin('/interventions');
  await page.getByRole('button', { name: 'Nouvelle intervention' }).click();
  const selectIntervention = page.getByRole('combobox', { name: 'Client de l’intervention' });
  await expect(page.getByRole('status', { name: 'Limite des résultats clients' })).toContainText('Seuls les 200 premiers clients sont listés');
  await expect(selectIntervention.locator(`option[value="${clientId}"]`)).toHaveCount(0);
  const rechercheIntervention = page.getByRole('searchbox', { name: 'Rechercher un client' });
  await rechercheIntervention.fill(prefixeLimite);
  await expect(selectIntervention.locator('option')).toHaveCount(201); // option vide + 200 clients
  await expect(page.getByRole('status', { name: 'Limite des résultats clients' })).toContainText('200 clients maximum');
  await rechercheIntervention.fill(`${prefixe} introuvable`);
  await expect(page.getByText('Aucun client actif trouvé.')).toBeVisible();
  await rechercheIntervention.fill(prefixe);
  await expect(selectIntervention.locator(`option[value="${clientId}"]`)).toHaveCount(1);
  await selectIntervention.selectOption(clientId);
  await expect(selectIntervention).toHaveValue(clientId);
  // Le site et le contact du client choisi sont proposés.
  await expect(page.locator('select[name="siteId"] option', { hasText: 'Site 111' })).toHaveCount(1);
  await expect(page.locator('select[name="contactId"] option', { hasText: 'Léa Contact111' })).toHaveCount(1);
  const titreIntervention = `Intervention 111 ${prefixe}`;
  await page.getByPlaceholder('Objet de la demande').fill(titreIntervention);
  const creationIntervention = page.waitForResponse((r) => r.url().endsWith('/api/interventions') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  const intervention = await creationIntervention;
  expect(intervention.status(), await intervention.text()).toBe(201);
  expect((await intervention.json()).client.id).toBe(clientId);
  await expect(page.locator('article').filter({ has: page.getByRole('heading', { name: titreIntervention }) })).toContainText(`${prefixe} cible`);

  // Contrat de maintenance.
  await page.goto('/contrats-maintenance', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Nouveau contrat' }).click();
  const selectContrat = page.getByRole('combobox', { name: 'Client du contrat' });
  await expect(selectContrat).toBeEnabled();
  await expect(selectContrat.locator(`option[value="${clientId}"]`)).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Rechercher un client' }).fill(prefixe);
  await expect(selectContrat.locator(`option[value="${clientId}"]`)).toHaveCount(1);
  await selectContrat.selectOption(clientId);
  await expect(selectContrat).toHaveValue(clientId);
  await expect(page.locator('select[name="siteId"] option', { hasText: 'Site 111' })).toHaveCount(1);
  const titreContrat = `Contrat 111 ${prefixe}`;
  await page.locator('input[name="titre"]').fill(titreContrat);
  await page.locator('input[name="dateDebut"]').fill('01-10-2030');
  const creationContrat = page.waitForResponse((r) => r.url().endsWith('/api/contrats-maintenance') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Créer le contrat' }).click();
  const contrat = await creationContrat;
  expect(contrat.status(), await contrat.text()).toBe(201);
  expect((await contrat.json()).clientId).toBe(clientId);
  await expect(page.getByText(titreContrat, { exact: true })).toBeVisible();
});

// Réponses lentes : une recherche périmée n'écrase pas la suivante, la fiche d'un client abandonné
// ne revient pas à la réouverture du formulaire, et un envoi pendant une recherche est refusé
// localement au lieu d'aboutir à « Client introuvable ».
test('#111 : réponse périmée, fiche abandonnée et envoi sans client', async ({ allerSurPageAdmin, request, session }) => {
  test.slow();
  const headers = auth(session.token);
  const horodatage = Date.now();
  const lente = `E2E 111 lent ${horodatage}`;
  const autre = await request.post(`${api}/clients`, { headers, data: { raisonSociale: `${lente} client` } });
  expect(autre.status(), await autre.text()).toBe(201);
  const autreId = (await autre.json()).id as string;
  const prefixe = `ZZZ E2E 111 perime ${horodatage}`;
  const cible = await request.post(`${api}/clients`, { headers, data: { raisonSociale: `${prefixe} cible` } });
  expect(cible.status(), await cible.text()).toBe(201);
  const clientId = (await cible.json()).id as string;
  const site = await request.post(`${api}/clients/${clientId}/sites`, { headers, data: { nom: 'Site périmé', adresse: '1 rue du Parcours', codePostal: '14000', ville: 'Caen' } });
  expect(site.status(), await site.text()).toBe(201);

  const page = await allerSurPageAdmin('/interventions');
  const estRechercheLente = (url: URL) => url.pathname.endsWith('/api/clients') && url.searchParams.get('q') === lente;
  const estFicheCible = (url: URL) => url.pathname.endsWith(`/api/clients/${clientId}`);
  await page.route(estRechercheLente, async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  await page.route(estFicheCible, async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  await page.getByRole('button', { name: 'Nouvelle intervention' }).click();
  const select = page.getByRole('combobox', { name: 'Client de l’intervention' });
  const recherche = page.getByRole('searchbox', { name: 'Rechercher un client' });
  await expect(select).toBeEnabled();

  // 1. La recherche lente part, une seconde la dépasse : sa réponse tardive est ignorée.
  const requeteLente = page.waitForRequest((r) => estRechercheLente(new URL(r.url())));
  await recherche.fill(lente);
  await requeteLente;
  const reponseLente = page.waitForResponse((r) => estRechercheLente(new URL(r.url())));
  await recherche.fill(prefixe);
  await expect(select.locator(`option[value="${clientId}"]`)).toHaveCount(1);
  await reponseLente;
  await expect(select.locator('option')).toHaveCount(2); // option vide + cible
  await expect(select.locator(`option[value="${autreId}"]`)).toHaveCount(0);

  // 2. Fiche demandée puis formulaire annulé : rouvert, il ne montre pas les sites de ce client.
  const reponseFiche = page.waitForResponse((r) => estFicheCible(new URL(r.url())));
  await select.selectOption(clientId);
  await page.locator('form').filter({ hasText: 'Nouvelle intervention SAV' }).getByRole('button', { name: 'Annuler' }).click();
  await page.getByRole('button', { name: 'Nouvelle intervention' }).click();
  await reponseFiche;
  await expect(page.getByRole('combobox', { name: 'Client de l’intervention' })).toHaveValue('');
  await expect(page.locator('select[name="siteId"]')).toHaveCount(0);

  // 3. Envoi pendant une recherche (sélecteur désactivé) : refus local, aucune création.
  let creations = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/api/interventions')) creations += 1; });
  await page.getByPlaceholder('Objet de la demande').fill(`Intervention sans client ${horodatage}`);
  await page.getByRole('searchbox', { name: 'Rechercher un client' }).fill(lente);
  await expect(page.getByRole('combobox', { name: 'Client de l’intervention' })).toBeDisabled();
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  await expect(page.getByText('Choisissez un client.')).toBeVisible();
  expect(creations).toBe(0);
});
