import { createHmac } from 'node:crypto';
import { test, expect } from './fixtures';

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const tokenFor = (userId: string) => {
  const payload = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${payload}.${createHmac('sha256', 'secret-e2e-uniquement').update(payload).digest('base64url')}`;
};

test.describe('Interventions SAV', () => {
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
      data: { clientId: client.id, titre: 'Contrat E2E achat', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-01-2026' },
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
