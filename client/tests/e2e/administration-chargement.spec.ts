import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const MESSAGE = 'Cette liste n’a pas pu être chargée';

// Laisse au navigateur le temps de traiter une réponse déjà reçue (rendu React planifié).
const laisserRendre = (page: Page) => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));

// Liste des chantiers pilotée par un gestionnaire installé une fois pour tout le test (aucun
// unroute pendant une réponse retenue) : en erreur 500 tant que `enErreur` est vrai, retenue tant
// que `retenir` est vrai et que `liberer` n'a pas été appelé. `recues` et `rendues` comptent les
// GET servis par Playwright (pas leur traitement par la page).
async function chantiersPilotes(page: Page, retenir = false) {
  const etat = { retenir, enErreur: true, recues: 0, rendues: 0, liberer: () => {} };
  const verrou = new Promise<void>((resolve) => { etat.liberer = resolve; });
  await page.route('**/api/chantiers', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    etat.recues += 1;
    if (!etat.enErreur) return route.continue();
    if (etat.retenir) await verrou;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Error fetching chantiers' }) });
    etat.rendues += 1;
  });
  return etat;
}

// Une liste d'Administration qui ne se charge pas (erreur serveur) ne fait plus planter l'écran :
// il le signale et reste utilisable. Avant, la réponse d'erreur remplaçait la liste des chantiers
// et la page tombait sur l'écran d'erreur (« chantiers.map is not a function »).
test('Administration : une liste qui ne se charge pas est signalée, sans faire planter l’écran, puis se recharge', async ({ page, allerSurPageAdmin, request, session }) => {
  const chantiers = await chantiersPilotes(page);
  const admin = await allerSurPageAdmin('/admin');
  const alerte = admin.getByRole('alert').filter({ hasText: MESSAGE });
  await expect(alerte).toBeVisible();
  await expect(admin.getByRole('heading', { name: 'Ouvrir le chantier d’une affaire' })).toBeVisible();

  // L'écran reste utilisable : un autre onglet charge sa liste, sans message.
  const fournisseur = `Fournisseur chargement E2E ${Date.now()}`;
  const creation = await request.post(`${api}/fournisseurs`, { headers: { Authorization: `Bearer ${session.token}` }, data: { nom: fournisseur } });
  expect(creation.ok(), await creation.text()).toBeTruthy();
  chantiers.enErreur = false;
  await admin.getByRole('button', { name: 'Fournisseurs', exact: true }).click();
  await expect(admin.getByText(fournisseur)).toBeVisible();
  await expect(alerte).toHaveCount(0);

  // Revenu sur l'onglet, la liste des chantiers se charge de nouveau, sans message.
  const rechargement = admin.waitForResponse((r) => r.url().endsWith('/api/chantiers') && r.request().method() === 'GET');
  await admin.getByRole('button', { name: 'Chantiers', exact: true }).click();
  expect((await rechargement).status()).toBe(200);
  await laisserRendre(admin);
  await expect(alerte).toHaveCount(0);
});

// Le message appartient à l'onglet dont la liste a échoué : une réponse arrivée après un
// changement d'onglet ne s'affiche pas ailleurs, et Marges ne recharge pas la liste précédente.
test('Administration : le message d’une liste en erreur reste attaché à son onglet', async ({ allerSurPageAdmin }) => {
  // Session ouverte sur une autre page, pour charger Administration sans attendre le réseau.
  const admin = await allerSurPageAdmin('/');
  const alerte = admin.getByRole('alert').filter({ hasText: MESSAGE });
  const chantiers = await chantiersPilotes(admin, true);

  // Réponse en erreur retenue jusqu'à ce que Fournisseurs soit affiché.
  await admin.goto('/admin', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => chantiers.recues).toBeGreaterThan(0);
  await admin.getByRole('button', { name: 'Fournisseurs', exact: true }).click();
  await expect(admin.getByRole('heading', { name: 'Ajouter un fournisseur' })).toBeVisible();
  chantiers.retenir = false;
  chantiers.liberer();
  await expect.poll(() => chantiers.rendues).toBe(chantiers.recues);
  await laisserRendre(admin);
  await expect(alerte).toHaveCount(0);

  // Sur Chantiers, la liste échoue et le message s'affiche ; Marges ne relance pas la liste des
  // chantiers, et le message ne le suit pas.
  await admin.getByRole('button', { name: 'Chantiers', exact: true }).click();
  await expect(alerte).toBeVisible();
  const avantMarges = chantiers.recues;
  const finMarges = admin.waitForResponse((r) => r.url().endsWith('/api/parametres/remuneration'));
  await admin.getByRole('button', { name: 'Marges & Commissions', exact: true }).click();
  await finMarges;
  await laisserRendre(admin);
  await expect(alerte).toHaveCount(0);
  expect(chantiers.recues, 'Marges ne recharge pas la liste des chantiers').toBe(avantMarges);
  // Recliquer sur Marges déjà actif rafraîchit ses réglages.
  const rafraichissement = admin.waitForRequest((r) => r.url().endsWith('/api/parametres/remuneration'), { timeout: 10_000 });
  await admin.getByRole('button', { name: 'Marges & Commissions', exact: true }).click();
  await rafraichissement;

  // Un échec réseau (requête interrompue) est signalé de même, sur l'onglet concerné.
  await admin.route('**/api/fournisseurs', (route) => (route.request().method() === 'GET' ? route.abort('failed') : route.continue()));
  await admin.getByRole('button', { name: 'Fournisseurs', exact: true }).click();
  await expect(alerte).toBeVisible();
});

// Une réponse en erreur périmée, arrivée après le rechargement réussi du même onglet, n'affiche
// pas le message sur la liste à jour.
test('Administration : une erreur périmée n’affiche pas le message sur la liste rechargée', async ({ allerSurPageAdmin }) => {
  const admin = await allerSurPageAdmin('/');
  const alerte = admin.getByRole('alert').filter({ hasText: MESSAGE });
  const chantiers = await chantiersPilotes(admin, true);
  await admin.goto('/admin', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => chantiers.recues).toBeGreaterThan(0);
  await admin.getByRole('button', { name: 'Fournisseurs', exact: true }).click();
  await expect(admin.getByRole('heading', { name: 'Ajouter un fournisseur' })).toBeVisible();

  const enAttente = chantiers.recues;
  chantiers.enErreur = false;
  const recharge = admin.waitForResponse((r) => r.url().endsWith('/api/chantiers') && r.status() === 200);
  await admin.getByRole('button', { name: 'Chantiers', exact: true }).click();
  await recharge;
  chantiers.liberer();
  await expect.poll(() => chantiers.rendues).toBe(enAttente);
  await laisserRendre(admin);
  await expect(alerte).toHaveCount(0);
});

// Le rechargement qu'un formulaire demande après un enregistrement porte sur l'onglet affiché,
// même si l'on a changé d'onglet pendant l'enregistrement : la liste de cet onglet n'est pas
// laissée vide ni périmée.
test('Administration : la liste de l’onglet ouvert pendant un enregistrement se charge', async ({ page, allerSurPageAdmin, request, session }) => {
  const intervenant = `Intervenant chargement E2E ${Date.now()}`;
  const creation = await request.post(`${api}/intervenants`, { headers: { Authorization: `Bearer ${session.token}` }, data: { nom: intervenant, role: 'Technicien', tauxHoraireCharge: 30 } });
  expect(creation.ok(), await creation.text()).toBeTruthy();

  const admin = await allerSurPageAdmin('/admin');
  // La lecture des fournisseurs due au clic est attendue avant d'installer les routes : elle ne
  // doit pas être prise pour le rechargement attendu plus bas.
  const listeFournisseurs = admin.waitForResponse((r) => r.url().endsWith('/api/fournisseurs') && r.request().method() === 'GET');
  await admin.getByRole('button', { name: 'Fournisseurs', exact: true }).click();
  await listeFournisseurs;
  await expect(admin.getByRole('heading', { name: 'Ajouter un fournisseur' })).toBeVisible();

  // L'enregistrement du fournisseur et la première lecture des intervenants sont retenus.
  let libererEnregistrement = () => {};
  const enregistrement = new Promise<void>((resolve) => { libererEnregistrement = resolve; });
  await page.route('**/api/fournisseurs', async (route) => {
    if (route.request().method() === 'POST') await enregistrement;
    await route.continue();
  });
  let libererLecture = () => {};
  const lecture = new Promise<void>((resolve) => { libererLecture = resolve; });
  let lecturesIntervenants = 0;
  let perimeeServie = false;
  await page.route('**/api/intervenants', async (route) => {
    if (route.request().method() === 'GET' && ++lecturesIntervenants === 1) {
      await lecture;
      // Réponse périmée, et différente : une liste vide, qui ne doit pas remplacer la liste
      // rechargée entre-temps.
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      perimeeServie = true;
      return;
    }
    await route.continue();
  });

  await admin.locator('form input[name="nom"]').fill(`Fournisseur chargement E2E ${Date.now()}`);
  const reponseEnregistrement = admin.waitForResponse((r) => r.url().endsWith('/api/fournisseurs') && r.request().method() === 'POST');
  await admin.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await admin.getByRole('button', { name: 'Intervenants', exact: true }).click();
  await expect.poll(() => lecturesIntervenants).toBe(1);

  // L'enregistrement aboutit, et son formulaire redemande un chargement, servi avant la première
  // lecture, libérée ensuite.
  const rechargement = admin.waitForResponse((r) => /\/api\/(intervenants|fournisseurs)$/.test(r.url()) && r.request().method() === 'GET');
  libererEnregistrement();
  expect((await reponseEnregistrement).ok()).toBeTruthy();
  await rechargement;
  libererLecture();
  await expect.poll(() => perimeeServie).toBe(true);
  await laisserRendre(admin);
  await expect(admin.getByText(intervenant)).toBeVisible();
});
