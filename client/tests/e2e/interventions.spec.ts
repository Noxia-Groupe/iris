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
});
