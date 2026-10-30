import type { Page } from '@playwright/test';
import { test, expect, choisirClient, dateDuJour } from './fixtures';

// TVA française (décision de Nelson de la nuit du 26 au 27-10-2026, point 13 : « Il faut les tva francaise que ce soit
// l’autoliquidation a 0%, 5,5%, ou 10% ou 20% » ; « Catalogue, devis, factures ») : un autre taux saisi à l'écran est
// refusé par le serveur, le refus s'affiche et rien n'est enregistré ; corrigé, le même formulaire s'enregistre.
const REFUS = 'Taux de TVA non accepté : 0 %, 5,5 %, 10 % ou 20 %.';

// Saisie touche par touche : fill() n'exerce pas le comportement du navigateur sur la virgule.
async function saisir(page: Page, label: string, valeur: string) {
  const champ = page.locator(`input[aria-label="${label}"]`);
  await champ.click();
  await champ.press('Control+a');
  await champ.pressSequentially(valeur, { delay: 10 });
}

test('facture : un taux de 7 % est refusé à l’écran sans rien créer ; à 5,5 %, le brouillon se crée', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
  const client = await creerClient('TVA française facture');
  const page = await allerSurPageAdmin('/factures');
  await page.getByRole('button', { name: /Nouvelle facture/ }).click();
  await choisirClient(page, client);
  await page.locator('input[name="motifHorsAffaire"]').fill('Parcours TVA française');
  await page.locator('input[name="dateEmission"]').fill(dateDuJour());
  await page.locator('input[name="dateEcheance"]').fill(dateDuJour());
  await page.locator('input[aria-label="Désignation ligne 1"]').fill('Rénovation de logement');
  await saisir(page, 'Quantité ligne 1', '1');
  await saisir(page, 'Prix unitaire HT ligne 1', '100');
  await saisir(page, 'TVA ligne 1', '7');
  await page.getByRole('button', { name: /Créer le brouillon/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: REFUS })).toBeVisible();
  const factures = async () => (await (await apiAdmin.get('/factures')).json() as Array<{ client: { id: string }; totalHt: number; totalTva: number; totalTtc: number; ventilationTva: Array<{ tauxTva: number }> }>)
    .filter((facture) => facture.client.id === client.id);
  expect(await factures()).toHaveLength(0);

  await saisir(page, 'TVA ligne 1', '5,5');
  await page.getByRole('button', { name: /Créer le brouillon/ }).click();
  await expect(page.getByText(/Brouillon créé/)).toBeVisible();
  const creees = await factures();
  expect(creees.map((facture) => [facture.ventilationTva.map((v) => v.tauxTva), facture.totalHt, facture.totalTva, facture.totalTtc])).toEqual([[[5.5], 100, 5.5, 105.5]]);
});

test('devis : un taux de 19,6 % est refusé à l’écran sans rien créer ; à 10 %, le brouillon se crée', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
  const client = await creerClient('TVA française devis');
  const objet = `Devis TVA française ${Date.now()}`;
  const page = await allerSurPageAdmin('/devis');
  await choisirClient(page, client);
  await page.getByRole('textbox', { name: 'Objet' }).fill(objet);
  await page.getByRole('textbox', { name: 'Désignation' }).fill('Entretien de chaudière');
  await page.getByRole('spinbutton', { name: 'PU HT' }).fill('100');
  await page.getByRole('spinbutton', { name: 'TVA %' }).fill('19.6');
  await page.getByRole('button', { name: 'Créer le brouillon' }).click();
  await expect(page.getByRole('alert').filter({ hasText: REFUS })).toBeVisible();
  const devis = async () => (await (await apiAdmin.get('/devis')).json() as Array<{ objet: string; totalHt: number; totalTva: number; totalTtc: number; lignes: Array<{ tauxTva: number }> }>)
    .filter((d) => d.objet === objet);
  expect(await devis()).toHaveLength(0);

  await page.getByRole('spinbutton', { name: 'TVA %' }).fill('10');
  await page.getByRole('button', { name: 'Créer le brouillon' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: objet })).toContainText('HT 100.00 €');
  expect((await devis()).map((d) => [d.lignes.map((l) => l.tauxTva), d.totalHt, d.totalTva, d.totalTtc])).toEqual([[[10], 100, 10, 110]]);
});
