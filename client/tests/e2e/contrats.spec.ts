import { test, expect } from './fixtures';

test.describe('Contrats de maintenance', () => {
  test('réinitialise l’éditeur de couverture avant d’enregistrer le second contrat', async ({ page, allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('couverture contrats', false);
    await allerSurPageAdmin('/contrats-maintenance');

    const creerContrat = async (titre: string, politiqueMainOeuvre: 'INCLUSE' | 'HORS_FORFAIT', politiqueMateriel: 'INCLUS' | 'HORS_FORFAIT', noteCouverture: string) => {
      await page.getByRole('button', { name: 'Nouveau contrat' }).click();
      await page.locator('select[name="clientId"]').selectOption(client.id);
      await page.locator('input[name="titre"]').fill(titre);
      await page.locator('input[name="dateDebut"]').fill('01-10-2026');
      await page.locator('select[name="politiqueMainOeuvre"]').selectOption(politiqueMainOeuvre);
      await page.locator('select[name="politiqueMateriel"]').selectOption(politiqueMateriel);
      await page.locator('textarea[name="noteCouverture"]').fill(noteCouverture);
      await page.getByRole('button', { name: 'Créer le contrat' }).click();
      await expect(page.getByText(titre, { exact: true })).toBeVisible();
    };

    const titreA = `Contrat couverture A ${Date.now()}`;
    const titreB = `Contrat couverture B ${Date.now()}`;
    await creerContrat(titreA, 'INCLUSE', 'HORS_FORFAIT', 'Politique A');
    await creerContrat(titreB, 'HORS_FORFAIT', 'INCLUS', 'Politique B');

    const carteA = page.locator('article').filter({ has: page.getByRole('heading', { name: titreA }) });
    const carteB = page.locator('article').filter({ has: page.getByRole('heading', { name: titreB }) });
    await carteA.getByRole('button', { name: 'Modifier la couverture' }).click();
    await carteB.getByRole('button', { name: 'Modifier la couverture' }).click();

    const editeur = page.getByRole('heading', { name: `Modifier la couverture — ${titreB}` }).locator('..');
    await expect(editeur.locator('select[name="politiqueMainOeuvre"]')).toHaveValue('HORS_FORFAIT');
    await expect(editeur.locator('select[name="politiqueMateriel"]')).toHaveValue('INCLUS');
    await expect(editeur.locator('textarea[name="noteCouverture"]')).toHaveValue('Politique B');
    await editeur.getByRole('button', { name: 'Enregistrer la couverture' }).click();

    const contrats = await apiAdmin.get('/contrats-maintenance');
    expect(contrats.ok(), await contrats.text()).toBeTruthy();
    const contratB = (await contrats.json() as Array<{ titre: string; politiqueMainOeuvre: string; politiqueMateriel: string; noteCouverture: string | null }>).find((contrat) => contrat.titre === titreB);
    expect(contratB).toMatchObject({ politiqueMainOeuvre: 'HORS_FORFAIT', politiqueMateriel: 'INCLUS', noteCouverture: 'Politique B' });
  });
});