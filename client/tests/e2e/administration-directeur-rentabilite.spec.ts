import { createHmac } from 'node:crypto';
import type { Browser } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable ouvre une session.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}
type Compte = { id: string; name: string; email: string; role: string };
async function pageDe(browser: Browser, compte: Compte) {
  const contexte = await browser.newContext();
  const page = await contexte.newPage();
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jetonPour(compte.id), JSON.stringify({ ...compte, permissions: [] })]);
  return page;
}

// Lot « Directeur aligné sur l'administration » (décision de Nelson du 24-10-2026, point 14) et réponse du 06-11-2026,
// « Chantiers seulement » : réglage `rentabiliteDirecteurs` décoché, le serveur envoie au directeur un vendu nul (null).
// L'Administration, désormais ouverte au directeur, s'ouvre sur l'onglet Chantiers, qui affiche le vendu de chaque chantier :
// elle ne doit ni planter ni afficher un vendu, et affiche « — ». Témoin : l'administrateur lit 240 €.
// Montants : 4 × 35 € de fourniture et 2 × 50 € de pose, soit 240 € HT vendus.
// Lectures écartées : l'écran qui plante (vendu nul lu comme un nombre) ; un « 0 € » trompeur ; le vendu affiché.
test.describe('Administration > Chantiers ouverte au directeur sans la rentabilité des chantiers', () => {
  let reglagesAvant: Record<string, unknown> | null = null;
  test.beforeEach(async ({ apiAdmin }) => {
    reglagesAvant = await (await apiAdmin.get('/parametres')).json() as Record<string, unknown>;
  });
  test.afterEach(async ({ request, session }) => {
    if (!reglagesAvant) return;
    const restauration = await request.put(`${api}/parametres`, { headers: { Authorization: `Bearer ${session.token}` }, data: {
      rentabiliteDirecteurs: reglagesAvant.rentabiliteDirecteurs ?? true,
    } });
    expect(restauration.ok(), await restauration.text()).toBeTruthy();
    reglagesAvant = null;
  });

  test('le directeur ouvre l’Administration réglage décoché : l’écran ne plante pas, le vendu s’affiche « — » ; l’administrateur lit 240 €', async ({ creerClient, request, session, browser }) => {
    const headers = { Authorization: `Bearer ${session.token}` };
    const envoyer = async (methode: 'post' | 'patch' | 'put', path: string, data: object) => {
      const response = await request[methode](`${api}${path}`, { headers, data });
      expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
      return response.json();
    };
    const suffixe = Date.now();
    const directeur = await envoyer('post', '/users', { email: `admin-dir-rentab.directeur.${suffixe}@iris.test`, name: `Directeur Administration ${suffixe}`, role: 'DIRECTEUR' }) as Compte;
    const administrateur = await envoyer('post', '/users', { email: `admin-dir-rentab.admin.${suffixe}@iris.test`, name: `Administrateur Administration ${suffixe}`, role: 'ADMIN' }) as Compte;
    const client = await creerClient('administration-directeur');
    const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Administration directeur E2E ${suffixe}`, lignes: [
      { designation: 'Détecteur', nature: 'FOURNITURE', quantite: 4, prixUnitaireHt: 35, tauxTva: 20 },
      { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: 50, tauxTva: 20 },
    ] });
    await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
    await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
    const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string; nom: string };
    const contextes: { close: () => Promise<void> }[] = [];
    try {
      await envoyer('put', '/parametres', { rentabiliteDirecteurs: false });
      const vueDirecteur = await pageDe(browser, directeur);
      contextes.push(vueDirecteur.context());
      const erreurs: string[] = [];
      vueDirecteur.on('pageerror', (e) => erreurs.push(e.message));
      await vueDirecteur.goto('/admin', { waitUntil: 'networkidle' });
      // Un plantage du rendu est rattrapé par l'ErrorBoundary de l'application (« Application Crash ») : son message est relu.
      const plantage = await vueDirecteur.getByText('Application Crash').count() ? await vueDirecteur.locator('pre').first().innerText() : null;
      expect(plantage, 'aucun plantage de l’écran').toBeNull();
      expect(erreurs, 'aucune erreur de rendu').toEqual([]);
      await expect(vueDirecteur.getByRole('heading', { name: 'Base de données des Chantiers' })).toBeVisible();
      const carte = vueDirecteur.locator('div.p-4.bg-white.border').filter({ hasText: chantier.nom });
      await expect(carte).toBeVisible();
      // Valeur affichée sous le libellé « Global Vendu » de la carte du chantier.
      await expect(carte.getByText('Global Vendu', { exact: true }).locator('xpath=following-sibling::div[1]')).toHaveText('—');
      // Aucun « 240 € » sur la carte (le nom du chantier porte un horodatage, qui peut contenir « 240 » sans euro).
      await expect(carte).not.toContainText(/240\s€/);
      // Témoin : l'administrateur, sous le même réglage, lit le vendu.
      const vueAdmin = await pageDe(browser, administrateur);
      contextes.push(vueAdmin.context());
      await vueAdmin.goto('/admin', { waitUntil: 'networkidle' });
      const carteAdmin = vueAdmin.locator('div.p-4.bg-white.border').filter({ hasText: chantier.nom });
      await expect(carteAdmin.getByText('Global Vendu', { exact: true }).locator('xpath=following-sibling::div[1]')).toHaveText(/^240\s€$/);
    } finally {
      await request.patch(`${api}/chantiers/${chantier.id}/statut`, { headers, data: { statut: 'TERMINE' } }).catch(() => undefined);
      for (const contexte of contextes) await contexte.close().catch(() => undefined);
    }
  });
});
