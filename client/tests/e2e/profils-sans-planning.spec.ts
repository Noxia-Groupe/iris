import { createHmac } from 'node:crypto';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable
// ouvre une session dans un rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

// #179, décision 11 de la proposition de droits : le directeur commercial, l'assistante commerciale
// et le comptable n'ont ni le planning ni l'administration (référentiels des achats). Le menu ne
// les leur propose plus, et leurs adresses ramènent à l'accueil. Le conducteur garde les deux.
test('le directeur commercial, l’assistante commerciale et le comptable n’ont ni planning ni administration', async ({ browser, request, session }) => {
  const headers = { Authorization: `Bearer ${session.token}` };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const fenetres: string[] = [];
  for (const [role, cle] of [['DIRECTEUR_COMMERCIAL', 'dc'], ['ASSISTANTE_COMMERCIALE', 'ac'], ['COMPTABLE', 'cpt'], ['CONDUCTEUR_TRAVAUX', 'temoin']] as const) {
    const nom = `Profil 179 ${cle} ${suffixe}`;
    const creation = await request.post(`${api}/users`, { headers, data: { email: `profil179.${cle}.${suffixe}@iris.test`, name: nom, role } });
    expect(creation.status(), await creation.text()).toBe(201);
    const { id } = await creation.json() as { id: string };
    const contexte = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await contexte.newPage();
      page.on('dialog', (dialogue) => { fenetres.push(`${role} ${dialogue.type()} : ${dialogue.message()}`); void dialogue.dismiss(); });
      await page.addInitScript(([token, user]) => {
        localStorage.setItem('token', token as string);
        localStorage.setItem('user', user as string);
      }, [jetonPour(id), JSON.stringify({ id, name: nom, email: `profil179.${cle}@iris.test`, role, permissions: [] })]);
      await page.goto('/', { waitUntil: 'networkidle' });
      const menu = page.locator('#menu-principal');
      await expect(menu).toContainText(nom);
      const temoin = role === 'CONDUCTEUR_TRAVAUX';
      await expect(menu.getByRole('link', { name: 'Planning', exact: true }), role).toHaveCount(temoin ? 1 : 0);
      await expect(menu.getByRole('link', { name: 'Administration', exact: true }), role).toHaveCount(temoin ? 1 : 0);
      // Les adresses tapées à la main ramènent à l'accueil, sans appel au planning.
      for (const chemin of ['/planning', '/admin']) {
        const appelsPlanning: string[] = [];
        const ecouter = (requete: { url: () => string }) => { if (requete.url().includes('/api/planning/')) appelsPlanning.push(requete.url()); };
        page.on('request', ecouter);
        await page.goto(chemin, { waitUntil: 'networkidle' });
        page.off('request', ecouter);
        if (temoin) {
          await expect(page, `${role} ${chemin}`).toHaveURL(new RegExp(`${chemin}$`));
        } else {
          await expect(page, `${role} ${chemin}`).toHaveURL(/\/$/);
          expect(appelsPlanning, `${role} ${chemin}`).toEqual([]);
        }
      }
    } finally {
      await contexte.close();
    }
  }
  expect(fenetres).toEqual([]);
});
