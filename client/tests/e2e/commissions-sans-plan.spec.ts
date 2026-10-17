import { createHmac } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const MESSAGE = 'Aucune commission : aucun plan commercial attribué.';

// Décision de Nelson du 17-10-2026 : sans plan commercial, un commercial ne touche aucune
// commission ni prime. Aucun plan n'existe encore : les écrans le disent, et n'affichent ni
// barème, ni primes, ni commission par chantier.

const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

async function creerCommercial(request: APIRequestContext, token: string) {
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const creation = await request.post(`${api}/users`, { headers: { Authorization: `Bearer ${token}` }, data: { email: `sans.plan.${suffixe}@iris.test`, name: `Commercial sans plan ${suffixe}`, role: 'COMMERCIAL' } });
  expect(creation.ok(), await creation.text()).toBeTruthy();
  return creation.json() as Promise<{ id: string; name: string; email: string }>;
}

// Un chantier Terminé, Encaissé et compté dans la période, injecté dans la réponse du serveur :
// le tableau des chantiers s'affiche, et l'on vérifie qu'il n'a plus de colonne de commission.
const chantierCompte = (suffixe: string) => ({
  id: `e2e-sans-plan-${suffixe}`, nom: `Chantier compté ${suffixe}`, client: 'Client E2E', dateDebut: new Date().toISOString(),
  statut: 'TERMINE', budgetGlobalVendu: 1000, margeCommerciale: 300, commissionEstimee: 0, comptabiliseDansPeriode: true, encaisse: true, valide: true, baremeReduit: false,
});

async function injecterChantier(page: Page, commercialId: string, chantier: ReturnType<typeof chantierCompte>) {
  await page.route('**/api/stats/commerciaux?*', async (route) => {
    const reponse = await route.fetch();
    const donnees = await reponse.json() as { commerciaux?: { id: string; chantiers?: unknown[]; nbChantiers?: number }[] };
    const commerciaux = (donnees.commerciaux ?? []).map((c) => (c.id === commercialId ? { ...c, nbChantiers: 1, chantiers: [chantier] } : c));
    await route.fulfill({ response: reponse, json: { ...donnees, commerciaux } });
  });
}

function ouvrirCommeCommercial(page: Page, commercial: { id: string; name: string; email: string }) {
  return page.addInitScript(([jeton, utilisateur]) => {
    localStorage.setItem('token', jeton as string);
    localStorage.setItem('user', utilisateur as string);
  }, [jetonPour(commercial.id), JSON.stringify({ ...commercial, role: 'COMMERCIAL', permissions: [] })]);
}

test('« Résultat commercial » : le commercial voit qu’il n’a aucune commission, sans barème, primes ni commission par chantier', async ({ page, request, session }) => {
  const commercial = await creerCommercial(request, session.token);
  const chantier = chantierCompte(commercial.id);
  await injecterChantier(page, commercial.id, chantier);
  await ouvrirCommeCommercial(page, commercial);
  await page.goto('/resultat-commercial', { waitUntil: 'networkidle' });
  await expect(page.getByRole('note').filter({ hasText: MESSAGE })).toBeVisible();
  await expect(page.getByText('Aucun plan commercial attribué', { exact: true })).toBeVisible();
  for (const absent of ['Barème standard', '16 / 20 / 25', 'Primes sur objectifs mensuels', 'Suivi administratif validé']) {
    await expect(page.getByText(absent)).toHaveCount(0);
  }
  await expect(page.locator('tr', { hasText: chantier.nom })).toBeVisible();
  await expect(page.locator('thead th')).toHaveText(['Chantier', 'Client', 'Statut', 'CA vendu', 'Marge commerciale']);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

// L'administrateur : un avis pour la page, la mention sur la carte du commercial, et ni barème,
// ni primes, ni commission par chantier une fois la carte ouverte.
test('« Mes commerciaux » : avis de la page, carte « sans plan commercial », ni barème, primes ni commission par chantier', async ({ page, allerSurPageAdmin, request, session }) => {
  const commercial = await creerCommercial(request, session.token);
  const chantier = chantierCompte(commercial.id);
  await injecterChantier(page, commercial.id, chantier);
  await allerSurPageAdmin('/commerciaux');
  await expect(page.getByRole('note').filter({ hasText: MESSAGE })).toBeVisible();
  const carte = page.locator('div.bg-white.rounded-xl', { hasText: commercial.email });
  await expect(carte.getByText('Sans plan commercial', { exact: true })).toBeVisible();
  await carte.getByText(commercial.name, { exact: true }).click();
  await expect(carte.locator('tr', { hasText: chantier.nom })).toBeVisible();
  await expect(carte.locator('thead th')).toHaveText(['Chantier', 'Statut', 'Marge', 'Encaissement']);
  for (const absent of ['Barème standard', '16 / 20 / 25', 'Primes sur objectifs mensuels', 'Suivi administratif validé', 'Commission (quote-part)']) {
    await expect(page.getByText(absent)).toHaveCount(0);
  }
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('tableau de bord de l’administrateur et administration : la commission dit l’absence de plan commercial', async ({ allerSurPageAdmin }) => {
  const admin = await allerSurPageAdmin('/');
  const carte = admin.locator('div.bg-white.p-4', { hasText: 'Commission commerciale' }).last();
  await expect(carte).toContainText('0 €');
  await expect(carte).toContainText(MESSAGE);
  await expect(admin.getByText('Commission commerciale versée')).toHaveCount(0);

  await admin.goto('/admin', { waitUntil: 'networkidle' });
  await admin.getByRole('button', { name: 'Marges & Commissions', exact: true }).click();
  const avis = admin.getByRole('note').filter({ hasText: MESSAGE });
  await expect(avis).toBeVisible();
  await expect(avis).toContainText('Ces règles générales ne sont plus appliquées');
  // Le document de référence d'une politique de rémunération écrite en dur est retiré.
  await expect(admin.getByText('Politique de Rémunération Commerciale')).toHaveCount(0);
  await expect(admin.getByText('Aucune commission ne sera calculée')).toHaveCount(0);
});

test('tableau de bord du commercial : « Ma commission » dit l’absence de plan commercial', async ({ page, request, session }) => {
  const commercial = await creerCommercial(request, session.token);
  await ouvrirCommeCommercial(page, commercial);
  await page.goto('/', { waitUntil: 'networkidle' });
  const carte = page.locator('div.bg-white.p-4', { hasText: 'Ma commission' }).last();
  await expect(carte).toContainText('0 €');
  await expect(carte).toContainText(MESSAGE);
  await expect(page.getByText('Ma commission gagnée')).toHaveCount(0);
});
