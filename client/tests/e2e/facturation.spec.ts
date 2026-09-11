import { test, expect, dateDuJour } from './fixtures';

test.describe('Facturation — parcours utilisateur', () => {
  test('saisit plusieurs lignes à la virgule et conserve les totaux exacts', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('multi-lignes');
    const page = await allerSurPageAdmin('/factures');
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await page.locator('select[name="clientId"]').selectOption({ label: client.raisonSociale });
    await page.locator('input[name="motifHorsAffaire"]').fill('Parcours multi-lignes');
    await page.locator('input[name="dateEmission"]').fill(dateDuJour());
    await page.locator('input[name="dateEcheance"]').fill(dateDuJour());
    await page.getByRole('button', { name: /Ajouter une ligne/ }).click();
    await page.getByRole('button', { name: /Ajouter une ligne/ }).click();

    const remplir = async (index: number, designation: string, nature: string, quantite: string, prix: string, taux: string) => {
      await page.locator(`input[aria-label="Désignation ligne ${index}"]`).fill(designation);
      await page.locator(`select[aria-label="Nature ligne ${index}"]`).selectOption(nature);
      // Il faut simuler les touches : fill() n'exerce pas le comportement navigateur qui
      // rejetait auparavant la virgule avec <input type="number">.
      for (const [label, valeur] of [['Quantité', quantite], ['Prix unitaire HT', prix], ['TVA', taux]] as const) {
        const champ = page.locator(`input[aria-label="${label} ligne ${index}"]`);
        await champ.click();
        await champ.press('Control+a');
        await champ.pressSequentially(valeur, { delay: 10 });
      }
    };
    await remplir(1, 'Pose de centrale incendie', 'PRESTATION', '2', '1234,56', '20');
    await remplir(2, 'Détecteur optique', 'ARTICLE', '3', '49,90', '10');
    await remplir(3, 'Mise en service', 'PRESTATION', '1', '250', '20');
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    await expect(page.getByText(/Brouillon créé/)).toBeVisible();

    const ligne = page.locator('tbody tr', { hasText: client.raisonSociale });
    await expect(ligne).toHaveCount(1);
    await expect(ligne).toContainText(/3\s*427,61\s*€/);
    const factures = await (await apiAdmin.get('/factures')).json() as Array<{ client: { id: string }; lignes: Array<{ ordre: number; nature: string; prixUnitaireHt: number }>; totalHt: number; totalTva: number; totalTtc: number }>;
    const facture = factures.find((item) => item.client.id === client.id);
    if (!facture) throw new Error('Facture multi-lignes absente de l’API');
    expect(facture.lignes.map((item) => [item.ordre, item.nature, item.prixUnitaireHt])).toEqual([
      [0, 'PRESTATION', 1234.56], [1, 'ARTICLE', 49.9], [2, 'PRESTATION', 250],
    ]);
    expect([facture.totalHt, facture.totalTva, facture.totalTtc]).toEqual([2868.82, 558.79, 3427.61]);
  });

  test('émet un brouillon, attribue un numéro et rend le PDF disponible', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('emission');
    const page = await allerSurPageAdmin('/factures');
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await page.locator('select[name="clientId"]').selectOption({ label: client.raisonSociale });
    await page.locator('input[name="motifHorsAffaire"]').fill('Parcours émission');
    await page.locator('input[name="dateEmission"]').fill(dateDuJour());
    await page.locator('input[name="dateEcheance"]').fill(dateDuJour());
    await page.locator('input[aria-label="Désignation ligne 1"]').fill('Contrôle annuel');
    const prix = page.locator('input[aria-label="Prix unitaire HT ligne 1"]');
    await prix.click();
    await prix.pressSequentially('480,50', { delay: 10 });
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    await expect(page.getByText(/Brouillon créé/)).toBeVisible();
    const ligne = page.locator('tbody tr', { hasText: client.raisonSociale });
    await ligne.getByRole('button', { name: /Émettre/ }).click();
    await expect(page.getByText(/émise et figée/)).toBeVisible();
    await expect(ligne).toContainText(/\d{4}-\d{4}/);
    const factures = await (await apiAdmin.get('/factures')).json() as Array<{ id: string; client: { id: string } }>;
    const facture = factures.find((item) => item.client.id === client.id);
    if (!facture) throw new Error('Facture émise absente de l’API');
    const document = await apiAdmin.get(`/factures/${facture.id}/document.pdf`);
    expect(document.status()).toBe(200);
    expect((await document.body()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('refuse la ligne invalide sans créer de facture', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('invalide'); const page = await allerSurPageAdmin('/factures');
    await page.getByRole('button', { name: /Nouvelle facture/ }).click(); await page.locator('select[name="clientId"]').selectOption({ label: client.raisonSociale });
    await page.locator('input[name="motifHorsAffaire"]').fill('Validation client'); await page.getByRole('button', { name: /Ajouter une ligne/ }).click();
    await page.locator('input[aria-label="Désignation ligne 1"]').fill('Correcte'); await page.locator('input[aria-label="Prix unitaire HT ligne 1"]').pressSequentially('10');
    await page.locator('input[aria-label="Désignation ligne 2"]').fill('Invalide'); await page.locator('input[aria-label="Prix unitaire HT ligne 2"]').pressSequentially('douze');
    await page.getByRole('button', { name: /Créer le brouillon/ }).click(); await expect(page.getByText(/^Ligne 2 :/)).toBeVisible();
    const factures = await (await apiAdmin.get('/factures')).json() as Array<{ client: { id: string } }>; expect(factures.filter((item) => item.client.id === client.id)).toHaveLength(0);
  });

  test('affiche le refus d’émission sans adresse et ne consomme pas de numéro', async ({ allerSurPageAdmin, creerClient }) => {
    const client = await creerClient('sans-site', false);
    const page = await allerSurPageAdmin('/factures');
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await page.locator('select[name="clientId"]').selectOption({ label: client.raisonSociale });
    await page.locator('input[name="motifHorsAffaire"]').fill('Parcours sans adresse');
    await page.locator('input[name="dateEmission"]').fill(dateDuJour());
    await page.locator('input[name="dateEcheance"]').fill(dateDuJour());
    await page.locator('input[aria-label="Désignation ligne 1"]').fill('Prestation refusée');
    const prix = page.locator('input[aria-label="Prix unitaire HT ligne 1"]');
    await prix.click();
    await prix.pressSequentially('100');
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    await expect(page.getByText(/Brouillon créé/)).toBeVisible();
    const ligne = page.locator('tbody tr', { hasText: client.raisonSociale });
    await ligne.getByRole('button', { name: /Émettre/ }).click();
    await expect(page.getByText(/adresse de facturation/i)).toBeVisible();
    await expect(ligne).toContainText('Brouillon');
  });

  test('ne bloque pas la facturation lorsqu’un contrôle non bloquant manque', async ({ allerSurPageAdmin }) => {
    const page = await allerSurPageAdmin('/prete-a-facturer');
    await expect(page.getByRole('heading', { name: 'Prêt à facturer' })).toBeVisible();
    await expect(page.getByText('Configuration prête pour la facturation.')).toBeVisible();
    const prefixe = page.locator('article', { hasText: 'Préfixe de facture' });
    await expect(prefixe).toContainText('Non bloquant');
    await expect(prefixe.getByRole('link', { name: 'Configurer' })).toHaveCount(0);
  });

  test.describe('à l’ouest de Greenwich', () => {
    test.use({ timezoneId: 'America/New_York' });
    test('affiche la date d’émission sans la décaler d’un jour', async ({ allerSurPageAdmin, creerClient, page }) => {
      const client = await creerClient('fuseau'); await allerSurPageAdmin('/factures');
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('America/New_York');
      await page.getByRole('button', { name: /Nouvelle facture/ }).click(); await page.locator('select[name="clientId"]').selectOption({ label: client.raisonSociale });
      await page.locator('input[name="motifHorsAffaire"]').fill('Parcours fuseau'); const aujourdhui = dateDuJour();
      await page.locator('input[name="dateEmission"]').fill(aujourdhui); await page.locator('input[name="dateEcheance"]').fill(aujourdhui);
      await page.locator('input[aria-label="Désignation ligne 1"]').fill('Contrôle fuseau'); const prix = page.locator('input[aria-label="Prix unitaire HT ligne 1"]'); await prix.click(); await prix.pressSequentially('100');
      await page.getByRole('button', { name: /Créer le brouillon/ }).click(); await expect(page.getByText(/Brouillon créé/)).toBeVisible();
      const [jour, mois, annee] = aujourdhui.split('-'); const ligne = page.locator('tbody tr', { hasText: client.raisonSociale }); await expect(ligne).toHaveCount(1); await expect(ligne).toContainText(new RegExp(`${jour}[-/]${mois}[-/]${annee}`));
    });
  });
});
