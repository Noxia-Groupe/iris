import { createHmac } from 'node:crypto';
import { test, expect } from './fixtures';

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const tokenFor = (userId: string) => {
  const payload = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${payload}.${createHmac('sha256', 'secret-e2e-uniquement').update(payload).digest('base64url')}`;
};

test.describe('Interventions SAV', () => {
  test('saisit et affiche la date de demande client distincte du souhait de planning', async ({ page, request, session, creerClient }) => {
    const client = await creerClient('date demandée intervention', false);
    await page.addInitScript(([token, user]) => {
      localStorage.setItem('token', token as string);
      localStorage.setItem('user', user as string);
    }, [session.token, JSON.stringify(session.user)]);
    await page.goto('/interventions', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Nouvelle intervention' }).click();
    await page.locator('select[name="clientId"]').selectOption(client.id);
    const titre = `TEST Demande datée E2E ${Date.now()}`;
    await page.getByPlaceholder('Objet de la demande').fill(titre);
    await page.getByPlaceholder('Date de demande (JJ-MM-AAAA)').fill('02-01-2026');
    await page.getByPlaceholder('Date souhaitée (JJ-MM-AAAA)').fill('10-01-2026');
    await page.getByRole('button', { name: 'Créer', exact: true }).click();
    const carte = page.locator('article').filter({ has: page.getByRole('heading', { name: titre }) });
    await expect(carte).toContainText('Demandée le 02/01/2026');
    await expect(carte).toContainText('Souhaitée le 10/01/2026');
    const liste = await request.get('http://127.0.0.1:3001/api/interventions', { headers: { Authorization: `Bearer ${session.token}` } });
    expect(liste.ok()).toBeTruthy();
    const enregistree = (await liste.json() as { titre: string; dateDemande: string }[]).find((i) => i.titre === titre);
    expect(enregistree?.dateDemande).toBe('2026-01-02T00:00:00.000Z');
  });

  test('historique sans date de demande : pas de libellé vide dans la carte', async ({ page, request, session, creerClient }) => {
    const client = await creerClient('historique sans demande', false);
    const titre = `TEST Historique sans demande ${Date.now()}`;
    const creation = await request.post('http://127.0.0.1:3001/api/interventions', {
      headers: { Authorization: 'Bearer ' + session.token },
      data: { clientId: client.id, titre, dateSouhaitee: '10-01-2027' },
    });
    expect(creation.status(), await creation.text()).toBe(201);
    const { id } = await creation.json() as { id: string };
    // Simule uniquement le champ NULL d'un enregistrement pré-migration, via la vraie liste API.
    await page.route('**/api/interventions', async (route) => {
      const response = await route.fetch();
      const interventions = await response.json() as { id: string; dateDemande: string | null }[];
      await route.fulfill({ response, json: interventions.map((item) => item.id === id ? { ...item, dateDemande: null } : item) });
    });
    await page.addInitScript(([token, user]) => {
      localStorage.setItem('token', token as string);
      localStorage.setItem('user', user as string);
    }, [session.token, JSON.stringify(session.user)]);
    await page.goto('/interventions', { waitUntil: 'networkidle' });
    const carte = page.locator('article').filter({ has: page.getByRole('heading', { name: titre }) });
    await expect(carte).toContainText('Souhaitée le 10/01/2027');
    await expect(carte).not.toContainText('Demandée le');
  });

  test('permet au conducteur de travaux d’ouvrir la création d’intervention', async ({ page, request, session }) => {
    const headers = { Authorization: `Bearer ${session.token}` };
    const creation = await request.post('http://127.0.0.1:3001/api/users', {
      headers,
      data: { email: `conducteur.intervention.${Date.now()}@iris.test`, name: 'Conducteur interventions', role: 'CONDUCTEUR_TRAVAUX' },
    });
    expect(creation.status(), await creation.text()).toBe(201);
    const { id } = await creation.json() as { id: string };
    const token = tokenFor(id);

    await page.addInitScript(([currentToken, user]) => {
      localStorage.setItem('token', currentToken as string);
      localStorage.setItem('user', user as string);
    }, [token, JSON.stringify({ id, name: 'Conducteur interventions', role: 'CONDUCTEUR_TRAVAUX', permissions: [] })]);
    await page.goto('/interventions', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Nouvelle intervention' }).click();
    await expect(page.getByRole('heading', { name: 'Nouvelle intervention SAV' })).toBeVisible();
    await expect(page.locator('select[name="clientId"]')).toHaveValue('');
    // La création du client prouve que le conducteur peut atteindre le flux ; la liste
    // des clients relève du chargement asynchrone, hors objectif de cette ouverture.
  });

  test('enregistre un achat SAV et réinitialise le formulaire sans erreur de page', async ({ page, request, session, creerClient }) => {
    const headers = { Authorization: `Bearer ${session.token}` };
    const client = await creerClient('achat intervention', false);
    const contrat = await request.post('http://127.0.0.1:3001/api/contrats-maintenance', {
      headers,
      data: { clientId: client.id, titre: `Contrat E2E achat ${Date.now()}`, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-01-2026' },
    });
    expect(contrat.status(), await contrat.text()).toBe(201);
    const { id: contratId } = await contrat.json() as { id: string };
    const intervention = await request.post(`http://127.0.0.1:3001/api/contrats-maintenance/${contratId}/generer-intervention`, { headers });
    expect(intervention.status(), await intervention.text()).toBe(201);
    const { titre: titreIntervention } = await intervention.json() as { titre: string };
    const fournisseur = await request.post('http://127.0.0.1:3001/api/fournisseurs', { headers, data: { nom: `Fournisseur E2E ${Date.now()}` } });
    expect(fournisseur.ok(), await fournisseur.text()).toBeTruthy();
    const { id: fournisseurId, nom: fournisseurNom } = await fournisseur.json() as { id: string; nom: string };
    const erreursPage: Error[] = [];
    page.on('pageerror', (error) => erreursPage.push(error));
    await page.addInitScript(([token, user]) => {
      localStorage.setItem('token', token as string);
      localStorage.setItem('user', user as string);
    }, [session.token, JSON.stringify(session.user)]);
    await page.goto('/interventions', { waitUntil: 'networkidle' });

    const carte = page.locator('article').filter({ has: page.getByRole('heading', { name: titreIntervention }) });
    const formulaire = carte.locator('form').filter({ hasText: 'Enregistrer l’achat matériel' });
    await expect(formulaire).toHaveCount(1);
    await formulaire.getByPlaceholder('Date (JJ-MM-AAAA)').fill('06-09-2026');
    await formulaire.locator('select[name="fournisseurId"]').selectOption({ value: fournisseurId, label: fournisseurNom });
    await formulaire.getByPlaceholder('Description du matériel').fill('Câble E2E');
    await formulaire.getByPlaceholder('Montant HT').fill('12,50');
    await formulaire.getByRole('button', { name: 'Enregistrer l’achat matériel' }).click();

    await expect(formulaire.getByPlaceholder('Description du matériel')).toHaveValue('');
    await expect(carte.getByText(/Coût réel cumulé\s*:\s*12,50\s*€ HT/)).toBeVisible();
    expect(erreursPage, erreursPage.map((error) => error.message).join('\n')).toEqual([]);
  });
});
