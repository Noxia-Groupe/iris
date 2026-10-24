import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Lot « main d'œuvre au catalogue » (décisions de Nelson du 24-10-2026) : une prestation du catalogue
// par main d'œuvre, avec quatre prix de vente (hors contrat et sous contrat, à l'heure et au forfait
// jour) et son nombre d'heures par jour ; l'administration la crée, modifie ses prix depuis l'écran
// (choix par défaut, à confirmer), la désactive, et rattache chaque intervenant à une main d'œuvre
// active. Chaque changement est journalisé.

type MainOeuvre = { id: string; reference: string; nom: string; actif: boolean; prixVenteHt: number; prixJourHorsContratHt: number; prixHeureSousContratHt: number; prixJourSousContratHt: number; heuresParJour: number; estMainOeuvre: boolean };
type Entree = { action: string; cibleLibelle: string | null; avant: Record<string, unknown> | null; apres: Record<string, unknown> | null };

async function envoyer(request: APIRequestContext, token: string, methode: 'post' | 'put' | 'delete', chemin: string, data?: object) {
  const response = await request[methode](`${api}${chemin}`, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(response.ok(), `${chemin} : ${await response.text()}`).toBeTruthy();
  return response.json();
}

async function lire<T>(request: APIRequestContext, token: string, chemin: string): Promise<T> {
  const response = await request.get(`${api}${chemin}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok(), `${chemin} : ${await response.text()}`).toBeTruthy();
  return response.json() as Promise<T>;
}

const creerMainOeuvre = (request: APIRequestContext, token: string, reference: string, nom: string) => envoyer(request, token, 'post', '/catalogue/prestations', {
  estMainOeuvre: true, reference, nom, tauxTva: '20', prixVenteHt: '42', prixJourHorsContratHt: '300', prixHeureSousContratHt: '38', prixJourSousContratHt: '270', heuresParJour: '7',
}) as Promise<MainOeuvre>;

async function ouvrirOngletMainOeuvre(page: Page) {
  await page.getByRole('button', { name: 'Main d’œuvre', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nouvelle main d’œuvre' })).toBeVisible();
}

test('l’administration crée une main d’œuvre depuis le catalogue, modifie un prix, puis la désactive ; chaque étape est journalisée', async ({ allerSurPageAdmin, request, session }) => {
  const suffixe = `${Date.now()}`;
  const reference = `E2E-MO-${suffixe}`;
  const nom = `Électricien E2E ${suffixe}`;
  const page = await allerSurPageAdmin('/catalogue');
  await ouvrirOngletMainOeuvre(page);

  // Saisie à la française (virgule décimale) ; libellés sans ambiguïté.
  await page.getByLabel('Référence').fill(reference);
  await page.getByLabel('Désignation').fill(nom);
  await page.getByLabel('Prix de vente HT à l’heure, hors contrat (€)').fill('45,50');
  await page.getByLabel('Prix de vente HT au forfait jour, hors contrat (€)').fill('320');
  await page.getByLabel('Prix de vente HT à l’heure, sous contrat (€)').fill('40');
  await page.getByLabel('Prix de vente HT au forfait jour, sous contrat (€)').fill('280,25');
  await page.getByLabel('Heures par jour (forfait jour)').fill('7,3');
  // Un refus du serveur s'affiche tel quel, sans rien créer.
  await page.getByRole('button', { name: 'Créer la main d’œuvre' }).click();
  await expect(page.getByRole('alert')).toContainText('quart d’heure');
  await page.getByLabel('Heures par jour (forfait jour)').fill('7,5');
  await page.getByRole('button', { name: 'Créer la main d’œuvre' }).click();
  await expect(page.getByRole('status')).toHaveText(`Main d’œuvre « ${nom} » créée.`);
  await expect(page.getByLabel('Référence')).toHaveValue('');

  const fiche = page.getByRole('article', { name: nom });
  await expect(fiche).toContainText(reference);
  await expect(fiche.locator('[data-prix="prixVenteHt"]')).toHaveText('45,50 €');
  await expect(fiche.locator('[data-prix="prixJourHorsContratHt"]')).toHaveText('320,00 €');
  await expect(fiche.locator('[data-prix="prixHeureSousContratHt"]')).toHaveText('40,00 €');
  await expect(fiche.locator('[data-prix="prixJourSousContratHt"]')).toHaveText('280,25 €');
  await expect(fiche.locator('[data-prix="heuresParJour"]')).toHaveText('7,5 h');
  await expect(fiche.getByText('Prix de vente HT au forfait jour, sous contrat')).toBeVisible();

  // Modifier un prix depuis l'écran.
  await fiche.getByRole('button', { name: `Modifier les prix de ${nom}` }).click();
  const formulaire = fiche.getByRole('form', { name: `Prix de ${nom}` });
  await expect(formulaire.getByLabel('Prix de vente HT au forfait jour, sous contrat (€)')).toHaveValue('280,25');
  await formulaire.getByLabel('Prix de vente HT au forfait jour, sous contrat (€)').fill('300');
  await formulaire.getByRole('button', { name: 'Enregistrer les prix' }).click();
  await expect(page.getByRole('status')).toHaveText(`Prix de « ${nom} » enregistrés.`);
  await expect(fiche.locator('[data-prix="prixJourSousContratHt"]')).toHaveText('300,00 €');

  // La désactiver : elle reste affichée, marquée, et se réactive.
  await fiche.getByRole('button', { name: `Désactiver ${nom}` }).click();
  await expect(page.getByRole('status')).toHaveText(`Main d’œuvre « ${nom} » désactivée.`);
  await expect(fiche).toContainText('Désactivée');
  await expect(fiche.getByRole('button', { name: `Réactiver ${nom}` })).toBeVisible();

  // Côté serveur : les quatre prix, les heures, la désactivation et le journal (auteur, avant, après).
  const prestations = await lire<MainOeuvre[]>(request, session.token, '/catalogue/prestations');
  const enregistree = prestations.find((p) => p.reference === reference)!;
  expect([enregistree.estMainOeuvre, enregistree.prixVenteHt, enregistree.prixJourHorsContratHt, enregistree.prixHeureSousContratHt, enregistree.prixJourSousContratHt, enregistree.heuresParJour, enregistree.actif])
    .toEqual([true, 45.5, 320, 40, 300, 7.5, false]);
  const journal = await lire<{ entrees: Entree[] }>(request, session.token, '/journal-administration?type=MAIN_OEUVRE');
  const entrees = journal.entrees.filter((e) => e.cibleLibelle === `${reference} — ${nom}`).reverse();
  expect(entrees.map((e) => e.action)).toEqual(['CREATION', 'MODIFICATION', 'DESACTIVATION']);
  expect([entrees[1].avant, entrees[1].apres]).toEqual([{ prixJourSousContratHt: 280.25 }, { prixJourSousContratHt: 300 }]);

  // Le journal d'Administration le montre, libellé compris.
  await page.goto('/admin', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Journal', exact: true }).click();
  const ligne = page.getByRole('table', { name: 'Entrées du journal' }).locator('tr', { hasText: `${reference} — ${nom}` }).filter({ hasText: 'Modification' });
  await expect(ligne).toContainText('Mains d’œuvre (prix de vente)');
  await expect(ligne).toContainText('Prix de vente HT au forfait jour, sous contrat : 280.25');

  // L'onglet Prestations ne liste pas les mains d'œuvre.
  await page.goto('/catalogue', { waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: 'Prestations', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(reference)).toHaveCount(0);
});

test('réactivation depuis l’écran : les prix de la fiche sont renvoyés à l’identique ; un écran resté ouvert n’annule pas une désactivation en enregistrant des prix', async ({ allerSurPageAdmin, request, session }) => {
  const suffixe = `${Date.now()}`;
  const reference = `E2E-MO-PERIME-${suffixe}`;
  const nom = `Écran périmé ${suffixe}`;
  const fiche = await envoyer(request, session.token, 'post', '/catalogue/prestations', {
    estMainOeuvre: true, reference, nom, tauxTva: '20', prixVenteHt: '45.5', prixJourHorsContratHt: '320.05', prixHeureSousContratHt: '38', prixJourSousContratHt: '280.25', heuresParJour: '7.75',
  }) as MainOeuvre;
  const montants = (m: MainOeuvre) => [m.prixVenteHt, m.prixJourHorsContratHt, m.prixHeureSousContratHt, m.prixJourSousContratHt, m.heuresParJour];
  const relire = async () => (await lire<MainOeuvre[]>(request, session.token, '/catalogue/prestations')).find((p) => p.id === fiche.id)!;
  const journal = async () => (await lire<{ entrees: Entree[] }>(request, session.token, '/journal-administration?type=MAIN_OEUVRE')).entrees.filter((e) => e.cibleLibelle === `${reference} — ${nom}`).reverse();
  const page = await allerSurPageAdmin('/catalogue');
  await ouvrirOngletMainOeuvre(page);
  const carte = page.getByRole('article', { name: nom });
  await carte.getByRole('button', { name: `Modifier les prix de ${nom}` }).click();
  // Un autre administrateur la désactive pendant la saisie : l'écran la croit encore active.
  await envoyer(request, session.token, 'delete', `/catalogue/prestations/${fiche.id}`);
  await expect(carte).not.toContainText('Désactivée');
  const formulaire = carte.getByRole('form', { name: `Prix de ${nom}` });
  await formulaire.getByLabel('Prix de vente HT à l’heure, sous contrat (€)').fill('39,50');
  await formulaire.getByRole('button', { name: 'Enregistrer les prix' }).click();
  await expect(page.getByRole('status')).toHaveText(`Prix de « ${nom} » enregistrés.`);
  // Le prix est enregistré, la main d'œuvre reste désactivée, et l'écran rechargé le montre.
  await expect(carte).toContainText('Désactivée');
  const enregistree = await relire();
  expect([enregistree.actif, ...montants(enregistree)]).toEqual([false, 45.5, 320.05, 39.5, 280.25, 7.75]);
  let entrees = await journal();
  expect(entrees.map((e) => e.action)).toEqual(['CREATION', 'DESACTIVATION', 'MODIFICATION']);
  expect([entrees[2].avant, entrees[2].apres]).toEqual([{ prixHeureSousContratHt: 38 }, { prixHeureSousContratHt: 39.5 }]);
  // La réactivation volontaire, depuis l'écran, renvoie la fiche entière : seule l'activité change.
  await carte.getByRole('button', { name: `Réactiver ${nom}` }).click();
  await expect(page.getByRole('status')).toHaveText(`Main d’œuvre « ${nom} » réactivée.`);
  await expect(carte).not.toContainText('Désactivée');
  await expect(carte.getByRole('button', { name: `Désactiver ${nom}` })).toBeVisible();
  const reactivee = await relire();
  expect([reactivee.actif, ...montants(reactivee)]).toEqual([true, 45.5, 320.05, 39.5, 280.25, 7.75]);
  entrees = await journal();
  expect(entrees.map((e) => e.action)).toEqual(['CREATION', 'DESACTIVATION', 'MODIFICATION', 'REACTIVATION']);
  expect([entrees[3].avant, entrees[3].apres]).toEqual([{ actif: false }, { actif: true }]);
});

test('l’administration rattache un intervenant à une main d’œuvre active ; désactivée, elle reste affichée comme telle', async ({ allerSurPageAdmin, request, session }) => {
  const suffixe = `${Date.now()}`;
  const electricien = await creerMainOeuvre(request, session.token, `E2E-MO-RAT1-${suffixe}`, `Électricien rattaché ${suffixe}`);
  const plombier = await creerMainOeuvre(request, session.token, `E2E-MO-RAT2-${suffixe}`, `Plombier rattaché ${suffixe}`);
  const intervenant = await envoyer(request, session.token, 'post', '/intervenants', { nom: `Intervenant main d’œuvre ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 34 }) as { id: string; nom: string };

  const page = await allerSurPageAdmin('/admin');
  await page.getByRole('button', { name: 'Intervenants', exact: true }).click();
  const selecteur = page.getByLabel(`Main d’œuvre de ${intervenant.nom}`);
  await expect(selecteur).toHaveValue('');
  await expect(selecteur.locator('option', { hasText: `${electricien.reference} · ${electricien.nom}` })).toHaveCount(1);
  const rattachement = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/intervenants/${intervenant.id}/main-oeuvre`));
  await selecteur.selectOption(electricien.id);
  expect((await rattachement).ok()).toBeTruthy();
  await expect(selecteur).toHaveValue(electricien.id);
  const changement = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/intervenants/${intervenant.id}/main-oeuvre`));
  await selecteur.selectOption(plombier.id);
  expect((await changement).ok()).toBeTruthy();
  await expect(selecteur).toHaveValue(plombier.id);

  const vue = (await lire<Array<{ id: string; mainOeuvreId: string | null }>>(request, session.token, '/intervenants')).find((i) => i.id === intervenant.id)!;
  expect(vue.mainOeuvreId).toBe(plombier.id);
  const journal = await lire<{ entrees: Entree[] }>(request, session.token, '/journal-administration?type=INTERVENANT');
  expect(journal.entrees.filter((e) => e.cibleLibelle === intervenant.nom).reverse().map((e) => [e.avant?.mainOeuvre, e.apres?.mainOeuvre])).toEqual([
    [null, `${electricien.reference} — ${electricien.nom}`],
    [`${electricien.reference} — ${electricien.nom}`, `${plombier.reference} — ${plombier.nom}`],
  ]);

  // La main d'œuvre désactivée garde son rattachement, affiché comme tel ; elle n'est plus proposée ailleurs.
  await envoyer(request, session.token, 'delete', `/catalogue/prestations/${plombier.id}`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Intervenants', exact: true }).click();
  await expect(selecteur).toHaveValue(plombier.id);
  await expect(selecteur.locator('option:checked')).toHaveText(`${plombier.reference} · ${plombier.nom} (désactivée)`);
  // Retirer le rattachement.
  const retrait = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/intervenants/${intervenant.id}/main-oeuvre`));
  await selecteur.selectOption('');
  expect((await retrait).ok()).toBeTruthy();
  await expect(selecteur).toHaveValue('');
  await expect(selecteur.locator('option', { hasText: plombier.reference })).toHaveCount(0);
});

// Sur téléphone, rien ne sort de l'écran ni n'est rogné par son cadre, hors d'un conteneur défilant
// (même règle que le parcours `entetes-mobile`, simplifiée à l'onglet mesuré).
async function debordements(page: Page) {
  return page.evaluate(() => {
    const largeur = window.innerWidth;
    const principal = document.querySelector('main');
    const coupes: string[] = [];
    if (principal && principal.scrollWidth > principal.clientWidth + 0.5) coupes.push(`zone principale : ${principal.scrollWidth} px pour ${principal.clientWidth}`);
    for (const el of Array.from(document.querySelectorAll('main *'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || (el.closest('svg') && el.tagName.toLowerCase() !== 'svg')) continue;
      let defile = false;
      for (let p = el.parentElement; p && p !== principal; p = p.parentElement) {
        if (['auto', 'scroll'].includes(getComputedStyle(p).overflowX)) { defile = true; break; }
      }
      if (!defile && (r.right > largeur + 0.5 || r.left < -0.5)) coupes.push(`${el.tagName.toLowerCase()} « ${(el.textContent || '').trim().slice(0, 40)} »`);
    }
    return coupes;
  });
}

test('rendu à 375 px : l’onglet Main d’œuvre, sa création et la modification des prix tiennent dans l’écran', async ({ allerSurPageAdmin, request, session, page }) => {
  const suffixe = `${Date.now()}`;
  const nom = `Main d’œuvre au nom particulièrement long pour un téléphone ${suffixe}`;
  await creerMainOeuvre(request, session.token, `E2E-MO-375-${suffixe}`, nom);
  await page.setViewportSize({ width: 375, height: 800 });
  await allerSurPageAdmin('/catalogue');
  await ouvrirOngletMainOeuvre(page);
  const fiche = page.getByRole('article', { name: nom });
  await expect(fiche.locator('[data-prix="prixJourSousContratHt"]')).toHaveText('270,00 €');
  expect(await debordements(page), 'onglet Main d’œuvre').toEqual([]);
  await fiche.getByRole('button', { name: `Modifier les prix de ${nom}` }).click();
  await expect(fiche.getByRole('button', { name: 'Enregistrer les prix' })).toBeVisible();
  expect(await debordements(page), 'modification des prix').toEqual([]);
  // Les boutons restent atteignables et lisibles.
  for (const bouton of [page.getByRole('button', { name: 'Créer la main d’œuvre' }), fiche.getByRole('button', { name: 'Enregistrer les prix' })]) {
    await bouton.scrollIntoViewIfNeeded();
    const boite = await bouton.boundingBox();
    expect(boite && boite.x >= 0 && boite.x + boite.width <= 375).toBeTruthy();
  }
});
