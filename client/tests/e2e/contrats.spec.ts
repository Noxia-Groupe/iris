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
    await editeur.locator('select[name="politiqueMainOeuvre"]').selectOption('INCLUSE');
    await editeur.locator('textarea[name="motif"]').fill('Renégociation avec le client');
    await editeur.getByRole('button', { name: 'Enregistrer la couverture' }).click();
    await expect(page.getByText('Couverture contractuelle mise à jour pour les prochaines interventions.')).toBeVisible();

    const contrats = await apiAdmin.get('/contrats-maintenance');
    expect(contrats.ok(), await contrats.text()).toBeTruthy();
    const contratB = (await contrats.json() as Array<{ titre: string; politiqueMainOeuvre: string; politiqueMateriel: string; noteCouverture: string | null }>).find((contrat) => contrat.titre === titreB);
    expect(contratB).toMatchObject({ politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'INCLUS', noteCouverture: 'Politique B' });
  });

  test('impose un motif de couverture et masque son édition pendant la suspension jusqu’à réactivation motivée', async ({ page, allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('motif couverture', false);
    const titre = `Contrat motif ${Date.now()}`;
    await allerSurPageAdmin('/contrats-maintenance');
    await page.getByRole('button', { name: 'Nouveau contrat' }).click();
    await page.locator('select[name="clientId"]').selectOption(client.id);
    await page.locator('input[name="titre"]').fill(titre);
    await page.locator('input[name="dateDebut"]').fill('01-10-2026');
    await page.getByRole('button', { name: 'Créer le contrat' }).click();
    const carte = page.locator('article').filter({ has: page.getByRole('heading', { name: titre }) });
    await carte.getByRole('button', { name: 'Modifier la couverture' }).click();
    const editeur = page.getByRole('heading', { name: `Modifier la couverture — ${titre}` }).locator('..');
    await editeur.locator('select[name="politiqueMainOeuvre"]').selectOption('INCLUSE');
    await expect(editeur.locator('textarea[name="motif"]')).toBeVisible();
    await editeur.getByRole('button', { name: 'Enregistrer la couverture' }).click();
    await expect(editeur.locator('textarea[name="motif"]')).toBeVisible();
    await editeur.locator('textarea[name="motif"]').fill('Changement confirmé par le client');
    await editeur.getByRole('button', { name: 'Enregistrer la couverture' }).click();
    await expect(page.getByText('Couverture contractuelle mise à jour pour les prochaines interventions.')).toBeVisible();

    await carte.getByRole('button', { name: 'Modifier la couverture' }).click();
    await expect(editeur).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept('Pause temporaire'));
    await carte.getByRole('button', { name: 'Suspendre' }).click();
    await expect(carte.getByText('Suspendu', { exact: true })).toBeVisible();
    await expect(carte.getByRole('button', { name: 'Modifier la couverture' })).toHaveCount(0);
    await expect(editeur).toHaveCount(0);
    const contrat = (await (await apiAdmin.get('/contrats-maintenance')).json() as Array<{ id: string; titre: string }>).find((item) => item.titre === titre);
    expect(contrat).toBeTruthy();
    const avant = await apiAdmin.get(`/contrats-maintenance/${contrat!.id}/journal-saisies`);
    expect((await avant.json() as Array<{ action: string; motif: string }>).find((item) => item.action === 'MODIFICATION_COUVERTURE')?.motif).toBe('Changement confirmé par le client');

    let demandeReactivation = '';
    page.once('dialog', async (dialog) => { demandeReactivation = dialog.message(); await dialog.accept('Retour au service'); });
    await carte.getByRole('button', { name: 'Réactiver' }).click();
    await expect(carte.getByText('Actif', { exact: true })).toBeVisible();
    expect(demandeReactivation).toMatch(/motif|raison/i);
    await expect(carte.getByRole('button', { name: 'Modifier la couverture' })).toBeVisible();
    const apres = await apiAdmin.get(`/contrats-maintenance/${contrat!.id}/journal-saisies`);
    expect((await apres.json() as Array<{ action: string; motif: string }>).find((item) => item.action === 'REACTIVATION')?.motif).toBe('Retour au service');
  });
});