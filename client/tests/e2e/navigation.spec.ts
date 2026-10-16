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

    test('le menu est un tiroir modal qui laisse toute la largeur à la page', async ({ allerSurPageAdmin }) => {
      const page = await allerSurPageAdmin('/');
      const menu = page.locator('#menu-principal');
      const ouvrir = page.getByRole('button', { name: 'Menu', exact: true });
      const fermerMenu = page.getByRole('button', { name: 'Fermer le menu' });
      const debordementPage = () => page.evaluate(() => document.documentElement.style.overflow);
      await expect(menu).toBeHidden();
      await expect(ouvrir).toHaveAttribute('aria-expanded', 'false');
      expect((await page.locator('main').boundingBox())?.width ?? 0).toBeGreaterThan(360);
      // Barre du haut mobile : bouton « Menu » à gauche, pas collé au sélecteur de thème.
      expect((await ouvrir.boundingBox())?.x ?? 999).toBeLessThan(40);

      // Ouvert : focus dans le menu, page derrière inerte et figée.
      await ouvrir.click();
      await expect(menu).toBeVisible();
      await expect(ouvrir).toHaveAttribute('aria-expanded', 'true');
      await expect(fermerMenu).toBeFocused();
      expect(await debordementPage()).toBe('hidden');
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.activeElement?.closest('.content-area') == null), `tabulation ${i + 1} sortie du tiroir`).toBe(true);
      }

      // Échap, le voile et le bouton de fermeture referment et rendent le focus au bouton « Menu ».
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(ouvrir).toBeFocused();
      expect(await debordementPage()).toBe('');
      await ouvrir.click();
      await page.mouse.click(380, 420);
      await expect(menu).toBeHidden();
      await expect(ouvrir).toBeFocused();
      await ouvrir.click();
      await fermerMenu.click();
      await expect(menu).toBeHidden();
      await expect(ouvrir).toBeFocused();

      // Choisir une page ferme le tiroir et place le focus sur le contenu de la nouvelle page.
      await ouvrir.click();
      await menu.getByRole('group', { name: 'Chantiers' }).getByRole('link', { name: 'Liste des chantiers' }).click();
      await expect(page).toHaveURL(/\/chantiers$/);
      await expect(menu).toBeHidden();
      await expect(page.locator('main')).toBeFocused();

      // Retour arrière du navigateur, tiroir ouvert : il se referme sur la page précédente.
      await ouvrir.click();
      await expect(menu).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/\/$/);
      await expect(menu).toBeHidden();
      expect(await debordementPage()).toBe('');

      // Passage en grand écran puis retour : le tiroir ne réapparaît pas ouvert.
      await ouvrir.click();
      await expect(menu).toBeVisible();
      await page.setViewportSize({ width: 1280, height: 800 });
      // Attendre la fermeture en grand écran : deux redimensionnements enchaînés sans attente
      // peuvent ne laisser au navigateur aucune occasion de réévaluer les media queries.
      await expect(menu).not.toHaveClass(/sidebar--ouvert/);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(menu).toBeHidden();
      await expect(ouvrir).toHaveAttribute('aria-expanded', 'false');
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
    // Référentiels : l'annuaire des clients seul, sans le catalogue (décision du 16-10-2026).
    const referentiels = menu.getByRole('group', { name: 'Référentiels' });
    await expect(referentiels.getByRole('link')).toHaveText(['Clients']);
    await expect(menu.getByRole('link', { name: 'API d’intégration' })).toHaveCount(0);
    await expect(menu).toContainText(nom);
  });

  test('l’en-tête porte le nom de la société et suit son enregistrement sans rechargement', async ({ allerSurPageAdmin, apiAdmin, request, session }) => {
    const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
    const headers = { Authorization: `Bearer ${session.token}` };
    const avant = await (await apiAdmin.get('/company')).json() as { nomCommercial: string | null; raisonSociale: string | null };
    const titre = (page: import('@playwright/test').Page) => page.locator('#menu-principal .sidebar-titre');
    const page = await allerSurPageAdmin('/admin');
    await expect(titre(page)).toHaveText((avant.nomCommercial || avant.raisonSociale || '').trim() || 'Iris');
    const nouveauNom = `Société menu E2E ${Date.now()}`;
    try {
      expect((await request.put(`${api}/company`, { headers, data: { nomCommercial: nouveauNom } })).ok()).toBeTruthy();
      // Enregistrer le fuseau (inchangé) depuis Administration relit les paramètres société.
      await page.getByRole('button', { name: 'Société', exact: true }).click();
      const enregistrement = page.waitForResponse((r) => r.url().endsWith('/api/company') && r.request().method() === 'PUT');
      await page.locator('form').filter({ has: page.locator('select[name="fuseauHoraire"]') }).getByRole('button', { name: 'Enregistrer' }).click();
      expect((await enregistrement).ok()).toBeTruthy();
      await expect(titre(page)).toHaveText(nouveauNom);
    } finally {
      await request.put(`${api}/company`, { headers, data: { nomCommercial: avant.nomCommercial ?? '' } });
    }
  });
});
