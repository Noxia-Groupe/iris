import { createHmac } from 'node:crypto';
import { test, expect } from './fixtures';

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable
// ouvre une session dans un rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

test.describe('Navigation — menu regroupé et tiroir mobile', () => {
  test.describe('sur téléphone', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('le menu est un tiroir fermé qui laisse toute la largeur à la page', async ({ allerSurPageAdmin }) => {
      const page = await allerSurPageAdmin('/');
      const menu = page.locator('#menu-principal');
      const ouvrir = page.getByRole('button', { name: 'Menu', exact: true });
      await expect(menu).toBeHidden();
      await expect(ouvrir).toHaveAttribute('aria-expanded', 'false');
      const largeur = (await page.locator('main').boundingBox())?.width ?? 0;
      expect(largeur).toBeGreaterThan(360);

      // Choisir une page ferme le tiroir.
      await ouvrir.click();
      await expect(menu).toBeVisible();
      await expect(ouvrir).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('button', { name: 'Fermer le menu' })).toBeFocused();
      await menu.getByRole('group', { name: 'Chantiers' }).getByRole('link', { name: 'Liste des chantiers' }).click();
      await expect(page).toHaveURL(/\/chantiers$/);
      await expect(menu).toBeHidden();

      // Échap, le voile et le bouton de fermeture le referment aussi.
      await ouvrir.click();
      await expect(menu).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await ouvrir.click();
      await page.mouse.click(380, 420);
      await expect(menu).toBeHidden();
      await ouvrir.click();
      await page.getByRole('button', { name: 'Fermer le menu' }).click();
      await expect(menu).toBeHidden();
    });
  });

  test('sur ordinateur, le menu reste affiché et regroupé par thème', async ({ allerSurPageAdmin }) => {
    const page = await allerSurPageAdmin('/');
    const menu = page.locator('#menu-principal');
    await expect(menu).toBeVisible();
    await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Fermer le menu' })).toBeHidden();
    for (const theme of ['Chantiers', 'Interventions', 'Facturation', 'Pilotage', 'Référentiels', 'Réglages']) {
      await expect(menu.getByRole('group', { name: theme })).toBeVisible();
    }
    await menu.getByRole('group', { name: 'Facturation' }).getByRole('link', { name: 'Factures' }).click();
    await expect(page).toHaveURL(/\/factures$/);
    await expect(menu.getByRole('link', { name: 'Factures' })).toHaveClass(/active/);
    await expect(menu.getByRole('link', { name: 'Tableau de bord' })).not.toHaveClass(/active/);
  });

  test('un conducteur ne voit que ses thèmes', async ({ page, request, session }) => {
    const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
    const nom = `Conducteur menu E2E ${Date.now()}`;
    const creation = await request.post(`${api}/users`, {
      headers: { Authorization: `Bearer ${session.token}` },
      data: { email: `conducteur.menu.${Date.now()}@iris.test`, name: nom, role: 'CONDUCTEUR_TRAVAUX' },
    });
    expect(creation.status(), await creation.text()).toBe(201);
    const { id } = await creation.json() as { id: string };
    await page.addInitScript(([token, user]) => {
      localStorage.setItem('token', token as string);
      localStorage.setItem('user', user as string);
    }, [jetonPour(id), JSON.stringify({ id, name: nom, email: 'conducteur@iris.test', role: 'CONDUCTEUR_TRAVAUX', permissions: [] })]);
    await page.goto('/', { waitUntil: 'networkidle' });
    const menu = page.locator('#menu-principal');
    await expect(menu.getByRole('group', { name: 'Chantiers' }).getByRole('link', { name: 'Journal des heures' })).toBeVisible();
    await expect(menu.getByRole('group', { name: 'Facturation' })).toHaveCount(0);
    await expect(menu.getByRole('group', { name: 'Référentiels' })).toHaveCount(0);
    await expect(menu.getByRole('link', { name: 'API d’intégration' })).toHaveCount(0);
    await expect(menu).toContainText(nom);
  });
});
