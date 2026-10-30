import type { APIRequestContext } from '@playwright/test';
import { test, expect, choisirClient } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Lot « budget et heures prévues du chantier », troisième PR (réponses de Nelson du 30-10-2026, « Option de la
// main d'œuvre » et « Prix à part » ; point 16 de la nuit du 26 au 27-10-2026, « Heures par jour de la MO ») : la
// fiche de main d'œuvre porte deux prix facultatifs de la demi-journée ; le devis reprend une main d'œuvre au
// jour ou à la demi-journée, hors contrat ou sous contrat, au prix de la fiche, fixé par Iris ; chaque unité
// compte les heures par jour de la main d'œuvre, ou leur moitié, dans les heures prévues.

type Ligne = { forfaitMainOeuvre: string | null; tarifForfait: string | null; prixUnitaireHt: number; unite: string | null; minutesPrevuesUnite: number | null; quantite: number };
type DevisLu = { id: string; objet: string; totalHt: number; heuresPrevues: number; lignes: Ligne[] };

async function envoyer(request: APIRequestContext, token: string, methode: 'post' | 'put', chemin: string, data?: object) {
  const response = await request[methode](`${api}${chemin}`, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(response.ok(), `${chemin} : ${await response.text()}`).toBeTruthy();
  return response.json();
}

async function lireDevis(request: APIRequestContext, token: string, objet: string) {
  const liste = await (await request.get(`${api}/devis`, { headers: { Authorization: `Bearer ${token}` } })).json() as DevisLu[];
  return liste.find((d) => d.objet === objet)!;
}

test('fiche de main d’œuvre avec ses prix de la demi-journée, puis devis composé à l’écran au jour et à la demi-journée : prix fixés par Iris et heures prévues', async ({ allerSurPageAdmin, request, session, creerClient }) => {
  test.slow();
  const suffixe = `${Date.now()}`;
  const nom = `Électricien forfait E2E ${suffixe}`;
  const reference = `E2E-FJ-${suffixe}`;
  // Une main d'œuvre sans prix de la demi-journée : elle ne se vend qu'au jour.
  const sansDemi = await envoyer(request, session.token, 'post', '/catalogue/prestations', {
    estMainOeuvre: true, reference: `E2E-FJ-SANS-${suffixe}`, nom: `Sans demi-journée E2E ${suffixe}`, tauxTva: '20',
    prixVenteHt: '42', prixJourHorsContratHt: '290', prixHeureSousContratHt: '38', prixJourSousContratHt: '270', heuresParJour: '7',
  }) as { id: string; nom: string };
  const client = await creerClient('Forfait jour');

  // Catalogue > Main d'œuvre : la fiche, avec ses deux prix de la demi-journée.
  const page = await allerSurPageAdmin('/catalogue');
  await page.getByRole('button', { name: 'Main d’œuvre', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nouvelle main d’œuvre' })).toBeVisible();
  for (const libelle of ['Prix de vente HT à la demi-journée, hors contrat (€)', 'Prix de vente HT à la demi-journée, sous contrat (€)']) {
    await expect(page.getByLabel(libelle)).toHaveValue('');
    await expect(page.getByLabel(libelle)).not.toHaveAttribute('required', '');
  }
  await page.getByLabel('Référence').fill(reference);
  await page.getByLabel('Désignation').fill(nom);
  await page.getByLabel('Prix de vente HT à l’heure, hors contrat (€)').fill('45');
  await page.getByLabel('Prix de vente HT au forfait jour, hors contrat (€)').fill('300');
  await page.getByLabel('Prix de vente HT à l’heure, sous contrat (€)').fill('40');
  await page.getByLabel('Prix de vente HT au forfait jour, sous contrat (€)').fill('280');
  await page.getByLabel('Prix de vente HT à la demi-journée, hors contrat (€)').fill('160');
  await page.getByLabel('Prix de vente HT à la demi-journée, sous contrat (€)').fill('150,50');
  await page.getByLabel('Heures par jour (forfait jour)').fill('7,5');
  await page.getByRole('button', { name: 'Créer la main d’œuvre' }).click();
  await expect(page.getByRole('status')).toHaveText(`Main d’œuvre « ${nom} » créée.`);
  const fiche = page.getByRole('article', { name: nom });
  await expect(fiche.locator('[data-prix="prixDemiJourneeHorsContratHt"]')).toHaveText('160,00 €');
  await expect(fiche.locator('[data-prix="prixDemiJourneeSousContratHt"]')).toHaveText('150,50 €');
  await expect(page.getByRole('article', { name: sansDemi.nom }).locator('[data-prix="prixDemiJourneeHorsContratHt"]')).toHaveText('Non réglé');
  const mainOeuvre = (await (await request.get(`${api}/catalogue/prestations`, { headers: { Authorization: `Bearer ${session.token}` } })).json() as { id: string; reference: string; prixDemiJourneeSousContratHt: number }[])
    .find((p) => p.reference === reference)!;
  expect(mainOeuvre.prixDemiJourneeSousContratHt).toBe(150.5);

  // Devis : une ligne au jour hors contrat, une à la demi-journée sous contrat.
  await page.goto('/devis', { waitUntil: 'networkidle' });
  await choisirClient(page, client);
  const objet = `Devis forfait jour E2E ${suffixe}`;
  await page.getByRole('textbox', { name: 'Objet' }).fill(objet);
  const bloc = page.getByRole('group', { name: 'Main d’œuvre au jour ou à la demi-journée', exact: true });
  const ajouter = bloc.getByRole('button', { name: 'Ajouter la main d’œuvre au forfait' });
  await expect(ajouter).toBeDisabled();
  await bloc.getByRole('combobox', { name: 'Main d’œuvre au forfait' }).selectOption(mainOeuvre.id);
  await expect(bloc.getByRole('combobox', { name: 'Tarif du forfait' }).locator('option')).toHaveText(['Hors contrat — 300,00 € HT', 'Sous contrat — 280,00 € HT']);
  await expect(bloc.getByTestId('prix-forfait-propose')).toHaveText('300,00 € HT par jour');
  await ajouter.click();
  const lignes = page.getByRole('group', { name: 'Ligne au jour ou à la demi-journée', exact: true });
  await expect(lignes).toHaveCount(1);
  await lignes.nth(0).getByRole('spinbutton', { name: 'Jours' }).fill('2');
  await expect(lignes.nth(0).getByTestId('prix-forfait')).toHaveText('300,00 € HT');
  await expect(lignes.nth(0)).toContainText('jour');

  // Main d'œuvre sans prix de la demi-journée : l'ajout reste inactif, avec la raison.
  await bloc.getByRole('combobox', { name: 'Forfait de la main d’œuvre' }).selectOption('DEMI_JOURNEE');
  await bloc.getByRole('combobox', { name: 'Main d’œuvre au forfait' }).selectOption(sansDemi.id);
  await expect(bloc.getByRole('combobox', { name: 'Tarif du forfait' }).locator('option')).toHaveText(['Hors contrat — non réglé', 'Sous contrat — non réglé']);
  await expect(bloc.getByRole('status')).toContainText('n’a pas de prix de la demi-journée hors contrat');
  await expect(ajouter).toBeDisabled();

  await bloc.getByRole('combobox', { name: 'Main d’œuvre au forfait' }).selectOption(mainOeuvre.id);
  await bloc.getByRole('combobox', { name: 'Tarif du forfait' }).selectOption('SOUS_CONTRAT');
  await expect(bloc.getByTestId('prix-forfait-propose')).toHaveText('150,50 € HT par demi-journée');
  await ajouter.click();
  await expect(lignes).toHaveCount(2);
  await expect(lignes.nth(1).getByRole('spinbutton', { name: 'Demi-journées' })).toHaveValue('1');
  await expect(lignes.nth(1).getByTestId('prix-forfait')).toHaveText('150,50 € HT');
  await expect(lignes.nth(1)).toContainText('demi-journée');
  await page.getByRole('button', { name: 'Créer le brouillon' }).click();

  // 2 × 300 € + 150,50 € ; 2 × 7,5 h + 3,75 h.
  const ligne = page.getByRole('listitem').filter({ hasText: objet });
  await expect(ligne).toContainText('HT 750.50 €');
  await expect(ligne.getByTestId('heures-prevues-devis')).toHaveText('Heures prévues : 18,75 h');
  const devis = await lireDevis(request, session.token, objet);
  expect(devis.lignes.map((l) => [l.forfaitMainOeuvre, l.tarifForfait, l.prixUnitaireHt, l.unite, l.minutesPrevuesUnite, l.quantite])).toEqual([
    ['JOUR', 'HORS_CONTRAT', 300, 'jour', 450, 2],
    ['DEMI_JOURNEE', 'SOUS_CONTRAT', 150.5, 'demi-journée', 225, 1],
  ]);

  // Remis en édition, les lignes gardent leur prix figé ; une demi-journée de plus.
  await ligne.getByRole('button', { name: 'Modifier' }).click();
  await expect(lignes).toHaveCount(2);
  await expect(lignes.nth(0).getByTestId('prix-forfait')).toHaveText('300,00 € HT');
  await lignes.nth(1).getByRole('spinbutton', { name: 'Demi-journées' }).fill('2');
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  await expect(ligne).toContainText('HT 901.00 €');
  await expect(ligne.getByTestId('heures-prevues-devis')).toHaveText('Heures prévues : 22,5 h');
  expect((await lireDevis(request, session.token, objet)).heuresPrevues).toBe(22.5);
});
