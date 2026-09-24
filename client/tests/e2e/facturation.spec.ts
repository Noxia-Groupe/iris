import { createHmac } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect, dateDuJour } from './fixtures';

// Aucune route de connexion par mot de passe n'existe (SSO Microsoft ou accès de secours) :
// pour ouvrir une session dans un rôle non administrateur, on signe le jeton avec le
// secret que playwright.config.ts donne au backend jetable.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

test.describe('Facturation — parcours utilisateur', () => {
  // Prépare une facture émise hors affaire et rend sa ligne de tableau.
  const emettreFactureSource = async (page: Page, client: { raisonSociale: string }, lignes: Array<[string, string, string]>) => {
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await page.locator('select[name="clientId"]').selectOption({ label: client.raisonSociale });
    await page.locator('input[name="motifHorsAffaire"]').fill('Parcours avoir partiel');
    await page.locator('input[name="dateEmission"]').fill(dateDuJour());
    await page.locator('input[name="dateEcheance"]').fill(dateDuJour());
    for (let index = 1; index < lignes.length; index += 1) await page.getByRole('button', { name: /Ajouter une ligne$/ }).click();
    for (const [rang, [quantite, prix, taux]] of lignes.entries()) {
      const index = rang + 1;
      await page.locator(`input[aria-label="Désignation ligne ${index}"]`).fill(`Prestation à créditer ${index}`);
      for (const [label, valeur] of [['Quantité', quantite], ['Prix unitaire HT', prix], ['TVA', taux]] as const) {
        const champ = page.locator(`input[aria-label="${label} ligne ${index}"]`);
        await champ.click();
        await champ.press('Control+a');
        await champ.pressSequentially(valeur, { delay: 10 });
      }
    }
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    const facture = page.locator('tbody tr', { hasText: client.raisonSociale }).filter({ hasText: 'Facture' });
    // Un brouillon n'est pas créditable : attendre sa ligne rend l'assertion d'absence
    // significative, plutôt que vraie sur une ligne pas encore rendue.
    await expect(facture).toContainText('BROUILLON');
    await expect(facture.getByRole('button', { name: /Créer un avoir partiel/ })).toHaveCount(0);
    await facture.getByRole('button', { name: /Émettre/ }).click();
    await expect(facture).toContainText('EMISE');
    return facture;
  };

  // Remplit la ligne d'avoir `index` du formulaire ouvert.
  const remplirLigneAvoir = async (page: Page, index: number, quantite: string, prix: string, taux: string) => {
    await page.locator(`input[aria-label="Désignation ligne avoir ${index}"]`).fill(`Geste commercial ${index}`);
    await page.locator(`select[aria-label="Nature ligne avoir ${index}"]`).selectOption('PRESTATION');
    // Simule la saisie réelle : fill() n'exerce pas la régression des virgules dans les
    // champs décimaux que ces parcours doivent retenir.
    for (const [label, valeur] of [['Quantité', quantite], ['Prix unitaire HT', prix], ['TVA', taux]] as const) {
      const champ = page.locator(`input[aria-label="${label} ligne avoir ${index}"]`);
      await champ.click();
      await champ.press('Control+a');
      await champ.pressSequentially(valeur, { delay: 10 });
    }
  };

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

    const ligne = page.locator('tbody tr', { hasText: client.raisonSociale }).filter({ hasText: 'Facture' });
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

  test('crée un avoir partiel depuis une facture émise et actualise la liste', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('avoir-partiel');
    const page = await allerSurPageAdmin('/factures');
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await page.locator('select[name="clientId"]').selectOption({ label: client.raisonSociale });
    await page.locator('input[name="motifHorsAffaire"]').fill('Parcours avoir partiel');
    await page.locator('input[name="dateEmission"]').fill(dateDuJour());
    await page.locator('input[name="dateEcheance"]').fill(dateDuJour());
    await page.locator('input[aria-label="Désignation ligne 1"]').fill('Prestation à créditer');
    await page.locator('input[aria-label="Prix unitaire HT ligne 1"]').pressSequentially('100');
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    const facture = page.locator('tbody tr', { hasText: client.raisonSociale }).filter({ hasText: 'Facture' });
    await facture.getByRole('button', { name: /Émettre/ }).click();
    await expect(facture).toContainText('EMISE');

    await facture.getByRole('button', { name: /Créer un avoir partiel/ }).click();
    await expect(page.getByRole('heading', { name: /Nouvel avoir partiel/ })).toBeVisible();
    await page.getByRole('button', { name: /Ajouter une ligne d’avoir/ }).click();
    await page.getByRole('button', { name: /Supprimer la ligne d’avoir 2/ }).click();
    await page.locator('input[aria-label="Désignation ligne avoir 1"]').fill('Geste commercial');
    await page.locator('select[aria-label="Nature ligne avoir 1"]').selectOption('PRESTATION');
    await page.locator('input[aria-label="Quantité ligne avoir 1"]').fill('0,5');
    await page.locator('input[aria-label="Prix unitaire HT ligne avoir 1"]').fill('100');
    await page.locator('input[aria-label="TVA ligne avoir 1"]').fill('20');
    await expect(page.getByTestId('aperçu-avoir')).toContainText(/50,00\s*€/);
    await expect(page.getByTestId('aperçu-avoir')).toContainText(/10,00\s*€/);
    await expect(page.getByTestId('aperçu-avoir')).toContainText(/60,00\s*€/);
    await page.getByRole('button', { name: /Créer l’avoir partiel/ }).click();
    await expect(page.getByText(/Avoir .* créé et émis/)).toBeVisible();

    const avoir = page.locator('tbody tr', { hasText: client.raisonSociale }).filter({ has: page.getByText('Avoir', { exact: true }) });
    await expect(avoir).toHaveCount(1);
    await expect(avoir).toContainText(/60,00\s*€/);
    await expect(avoir).toContainText(/\d{2}[-/]\d{2}[-/]\d{4}/);
    const factures = await (await apiAdmin.get('/factures')).json() as Array<{ type: string; factureOrigine?: { id: string }; client: { id: string }; totalHt: number; totalTva: number; totalTtc: number }>;
    const avoirApi = factures.find((item) => item.type === 'AVOIR' && item.client.id === client.id);
    if (!avoirApi) throw new Error('Avoir partiel absent de l’API');
    expect([avoirApi.totalHt, avoirApi.totalTva, avoirApi.totalTtc]).toEqual([50, 10, 60]);
  });

  // 0,5 × 4,27 = 2,135 € : l'aperçu doit annoncer le montant réellement émis,
  // y compris lorsque l'arrondi navigateur et celui du serveur divergent.
  test('l’aperçu d’avoir annonce au centime le montant réellement émis', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('avoir-arrondi');
    const page = await allerSurPageAdmin('/factures');
    const facture = await emettreFactureSource(page, client, [['10', '4,27', '20']]);
    await facture.getByRole('button', { name: /Créer un avoir partiel/ }).click();
    await remplirLigneAvoir(page, 1, '0,5', '4,27', '20');
    await expect(page.getByTestId('aperçu-avoir')).toContainText(/2,14\s*€/);
    await expect(page.getByTestId('aperçu-avoir')).not.toContainText(/2,13\s*€/);
    await page.getByRole('button', { name: /Créer l’avoir partiel/ }).click();
    await expect(page.getByText(/créé et émis/)).toBeVisible();
    const factures = await (await apiAdmin.get('/factures')).json() as Array<{ type: string; client: { id: string }; totalHt: number; totalTva: number; totalTtc: number }>;
    const avoir = factures.find((item) => item.type === 'AVOIR' && item.client.id === client.id);
    if (!avoir) throw new Error('Avoir partiel absent de l’API');
    expect([avoir.totalHt, avoir.totalTva, avoir.totalTtc]).toEqual([2.14, 0.43, 2.57]);
  });

  // Deux lignes et deux taux exercent l'agrégation de l'aperçu, et vérifient que le
  // payload envoie bien toutes les lignes au serveur.
  test('crédite deux taux en un seul avoir et agrège l’aperçu par taux', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('avoir-deux-taux');
    const page = await allerSurPageAdmin('/factures');
    const facture = await emettreFactureSource(page, client, [['10', '100', '20'], ['10', '100', '10']]);
    await facture.getByRole('button', { name: /Créer un avoir partiel/ }).click();
    await page.getByRole('button', { name: /Ajouter une ligne d’avoir/ }).click();
    await remplirLigneAvoir(page, 1, '1', '33,33', '20');
    await remplirLigneAvoir(page, 2, '2', '16,67', '10');
    await expect(page.getByTestId('aperçu-avoir')).toContainText(/66,67\s*€/);
    await expect(page.getByTestId('aperçu-avoir')).toContainText(/10,00\s*€/);
    await expect(page.getByTestId('aperçu-avoir')).toContainText(/76,67\s*€/);
    await page.getByRole('button', { name: /Créer l’avoir partiel/ }).click();
    await expect(page.getByText(/créé et émis/)).toBeVisible();
    const factures = await (await apiAdmin.get('/factures')).json() as Array<{ type: string; client: { id: string }; lignes: Array<{ tauxTva: number }>; totalHt: number; totalTva: number; totalTtc: number }>;
    const avoir = factures.find((item) => item.type === 'AVOIR' && item.client.id === client.id);
    if (!avoir) throw new Error('Avoir à deux taux absent de l’API');
    expect(avoir.lignes.map((ligne) => ligne.tauxTva).sort((a, b) => a - b)).toEqual([10, 20]);
    expect([avoir.totalHt, avoir.totalTva, avoir.totalTtc]).toEqual([66.67, 10, 76.67]);
  });

  // Les refus métier restent visibles et conservent la saisie. Une création réussie
  // referme ensuite le formulaire et masque l'annulation totale désormais impossible.
  test('affiche les refus métier, conserve la saisie puis ferme le formulaire après succès', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('avoir-plafond');
    const page = await allerSurPageAdmin('/factures');
    const facture = await emettreFactureSource(page, client, [['10', '100', '20']]);
    await facture.getByRole('button', { name: /Créer un avoir partiel/ }).click();
    await remplirLigneAvoir(page, 1, '20', '100', '20');
    await page.getByRole('button', { name: /Créer l’avoir partiel/ }).click();
    await expect(page.getByText(/Cet avoir dépasse le montant total restant à créditer/)).toBeVisible();
    await expect(page.getByRole('heading', { name: /Nouvel avoir partiel/ })).toBeVisible();
    await expect(page.locator('input[aria-label="Prix unitaire HT ligne avoir 1"]')).toHaveValue('100');
    const refuse = await (await apiAdmin.get('/factures')).json() as Array<{ type: string; client: { id: string } }>;
    expect(refuse.filter((item) => item.type === 'AVOIR' && item.client.id === client.id)).toEqual([]);

    await remplirLigneAvoir(page, 1, '1', '10', '10');
    await page.getByRole('button', { name: /Créer l’avoir partiel/ }).click();
    await expect(page.getByText(/Le taux de TVA d’une ligne d’avoir doit être présent/)).toBeVisible();

    await remplirLigneAvoir(page, 1, '1', '10', '20');
    await page.getByRole('button', { name: /Créer l’avoir partiel/ }).click();
    await expect(page.getByText(/créé et émis/)).toBeVisible();
    await expect(page.getByRole('heading', { name: /Nouvel avoir partiel/ })).toHaveCount(0);
    await expect(facture.getByRole('button', { name: /Annuler la facture/ })).toHaveCount(0);
    await expect(facture).toContainText(/Annulation totale impossible : 1 avoir\(s\) partiel\(s\)/);
    await expect(facture.getByRole('button', { name: /Marquer comme réglée/ })).toBeVisible();
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
    const ligne = page.locator('tbody tr', { hasText: client.raisonSociale }).filter({ hasText: 'Facture' });
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

  test('règle une facture émise après confirmation et affiche son nouveau statut', async ({ allerSurPageAdmin, creerClient }) => {
    const client = await creerClient('règlement');
    const page = await allerSurPageAdmin('/factures');
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await page.locator('select[name="clientId"]').selectOption({ label: client.raisonSociale });
    await page.locator('input[name="motifHorsAffaire"]').fill('Parcours règlement');
    await page.locator('input[name="dateEmission"]').fill(dateDuJour());
    await page.locator('input[name="dateEcheance"]').fill(dateDuJour());
    await page.locator('input[aria-label="Désignation ligne 1"]').fill('Contrôle règlement');
    await page.locator('input[aria-label="Prix unitaire HT ligne 1"]').pressSequentially('100');
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    const ligne = page.locator('tbody tr', { hasText: client.raisonSociale }).filter({ hasText: 'Facture' });
    await ligne.getByRole('button', { name: /Émettre/ }).click();
    await expect(ligne.getByRole('button', { name: /Marquer comme réglée/ })).toBeVisible();
    let confirmationDemandee = '';
    page.once('dialog', (dialog) => { confirmationDemandee = dialog.message(); void dialog.accept(); });
    await ligne.getByRole('button', { name: /Marquer comme réglée/ }).click();
    await expect(page.getByText(/marquée comme réglée/i)).toBeVisible();
    expect(confirmationDemandee).toMatch(/Confirmer le règlement de la facture/);
    await expect(ligne).toContainText('REGLEE');
  });

  // Ce parcours couvre confirmation, statut et téléchargement ; le contenu du PDF est
  // extrait et vérifié par les tests serveur avec pdf-parse.
  test('annule une facture après confirmation et garde son document téléchargeable', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('annulation');
    const page = await allerSurPageAdmin('/factures');
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await page.locator('select[name="clientId"]').selectOption({ label: client.raisonSociale });
    await page.locator('input[name="motifHorsAffaire"]').fill('Parcours annulation');
    await page.locator('input[name="dateEmission"]').fill(dateDuJour());
    await page.locator('input[name="dateEcheance"]').fill(dateDuJour());
    await page.locator('input[aria-label="Désignation ligne 1"]').fill('Contrôle annulation');
    await page.locator('input[aria-label="Prix unitaire HT ligne 1"]').pressSequentially('100');
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    const ligne = page.locator('tbody tr', { hasText: client.raisonSociale }).filter({ hasText: 'Facture' });
    await ligne.getByRole('button', { name: /Émettre/ }).click();
    let confirmationDemandee = '';
    page.once('dialog', (dialog) => { confirmationDemandee = dialog.message(); void dialog.accept(); });
    await ligne.getByRole('button', { name: /Annuler la facture/ }).click();
    await expect(page.getByText(/annulée ; avoir .* disponible/i)).toBeVisible();
    expect(confirmationDemandee).toMatch(/Annuler la facture/);
    await expect(ligne).toContainText('ANNULEE');
    const factures = await (await apiAdmin.get('/factures')).json() as Array<{ id: string; client: { id: string } }>;
    const facture = factures.find((item) => item.client.id === client.id);
    if (!facture) throw new Error('Facture annulée absente de l’API');
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
    const ligne = page.locator('tbody tr', { hasText: client.raisonSociale }).filter({ hasText: 'Facture' });
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

  test('n’expose pas d’acceptation manuelle : seule la signature peut accepter un devis envoyé', async ({ allerSurPageAdmin, apiAdmin, creerClient, request, session }) => {
    const client = await creerClient('devis-signature', false);
    const apiResponse = await apiAdmin.get('/company');
    expect(apiResponse.ok(), await apiResponse.text()).toBeTruthy();
    const api = new URL('/api', apiResponse.url()).toString().replace(/\/$/, '');
    const headers = { Authorization: `Bearer ${session.token}` };
    const objet = `Devis E2E signature ${Date.now()}`;
    const creation = await request.post(`${api}/devis`, {
      headers,
      data: { clientId: client.id, objet, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] },
    });
    expect(creation.ok(), await creation.text()).toBeTruthy();
    const { id } = await creation.json() as { id: string };
    const envoi = await request.put(`${api}/devis/${id}/statut`, { headers, data: { statut: 'ENVOYE' } });
    expect(envoi.ok(), await envoi.text()).toBeTruthy();

    const page = await allerSurPageAdmin('/devis');
    const ligne = page.locator('li', { hasText: objet });
    await expect(ligne).toContainText('ENVOYE');
    await expect(ligne.getByRole('button', { name: 'Accepter' })).toHaveCount(0);
    await expect(ligne.getByRole('button', { name: 'Signer en interne' })).toBeVisible();
  });

  test('fait signer le client désigné et identifie l’employé qui enregistre', async ({ allerSurPageAdmin, apiAdmin, creerClient, request, session }) => {
    const client = await creerClient('signataire-client', false);
    const apiResponse = await apiAdmin.get('/company');
    expect(apiResponse.ok(), await apiResponse.text()).toBeTruthy();
    const api = new URL('/api', apiResponse.url()).toString().replace(/\/$/, '');
    const headers = { Authorization: `Bearer ${session.token}` };
    const contact = await request.post(`${api}/clients/${client.id}/contacts`, { headers, data: { prenom: 'Claire', nom: 'Cliente', estSignataire: true } });
    expect(contact.status(), await contact.text()).toBe(201);
    const objet = `Devis E2E signataire client ${Date.now()}`;
    const creation = await request.post(`${api}/devis`, {
      headers,
      data: { clientId: client.id, objet, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] },
    });
    expect(creation.ok(), await creation.text()).toBeTruthy();

    const page = await allerSurPageAdmin('/devis');
    const ligne = page.locator('li', { hasText: objet });
    await ligne.getByRole('button', { name: 'Faire signer le client' }).click();
    const formulaire = page.getByRole('dialog', { name: 'Signature client' });
    await expect(formulaire.getByLabel('Enregistré par')).not.toHaveValue('');
    await expect(formulaire.getByLabel('Autre signataire client')).toBeVisible();
    await formulaire.getByLabel('Signataire client').selectOption({ label: 'Claire Cliente' });
    await formulaire.getByLabel('Confirmation du client').check();
    await formulaire.getByRole('button', { name: 'Enregistrer la signature client' }).click();
    await expect(ligne).toContainText('Signature client : Claire Cliente');
  });

  test('réserve aux administrateurs le PDF des factures liées de la fiche affaire', async ({ page, apiAdmin, creerClient, request, session }) => {
    const apiResponse = await apiAdmin.get('/company');
    expect(apiResponse.ok(), await apiResponse.text()).toBeTruthy();
    const api = new URL('/api', apiResponse.url()).toString().replace(/\/$/, '');
    const client = await creerClient('factures-liees');
    const headers = { Authorization: `Bearer ${session.token}` };
    const devis = await request.post(`${api}/devis`, {
      headers,
      data: { clientId: client.id, objet: `Affaire E2E facturée ${Date.now()}`, lignes: [{ designation: 'Pose facturée', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] },
    });
    expect(devis.ok(), await devis.text()).toBeTruthy();
    const { id: devisId } = await devis.json() as { id: string };
    const envoi = await request.put(`${api}/devis/${devisId}/statut`, { headers, data: { statut: 'ENVOYE' } });
    expect(envoi.ok(), await envoi.text()).toBeTruthy();
    const signature = await request.post(`${api}/devis/${devisId}/signature`, { headers, data: { signataire: 'Signataire E2E', confirme: true } });
    expect(signature.ok(), await signature.text()).toBeTruthy();
    const conversion = await request.post(`${api}/devis/${devisId}/convertir`, { headers, data: { cible: 'CHANTIER' } });
    expect(conversion.ok(), await conversion.text()).toBeTruthy();
    const { id: chantierId } = await conversion.json() as { id: string };
    // Conducteur désigné responsable : c'est la configuration où le serveur lui livre
    // le bloc facturation. Le tableau visible rend l'absence du PDF significative.
    const nom = 'Conducteur factures liées';
    const creation = await request.post(`${api}/users`, {
      headers,
      data: { email: `conducteur.factures.${Date.now()}@iris.test`, name: nom, role: 'CONDUCTEUR_TRAVAUX' },
    });
    expect(creation.status(), await creation.text()).toBe(201);
    const { id: conducteurId } = await creation.json() as { id: string };
    const affectation = await request.patch(`${api}/chantiers/${chantierId}`, {
      headers,
      data: { responsableId: conducteurId },
    });
    expect(affectation.ok(), await affectation.text()).toBeTruthy();
    const brouillon = await request.post(`${api}/factures`, {
      headers,
      data: { clientId: client.id, origine: 'CHANTIER', chantierId, dateEmission: dateDuJour(), dateEcheance: dateDuJour(), lignes: [{ designation: 'Pose facturée', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] },
    });
    expect(brouillon.ok(), await brouillon.text()).toBeTruthy();
    const { id: factureId } = await brouillon.json() as { id: string };
    const emission = await request.post(`${api}/factures/${factureId}/emettre`, { headers });
    expect(emission.ok(), await emission.text()).toBeTruthy();
    const { numero } = await emission.json() as { numero: string };

    const jeton = jetonPour(conducteurId);
    await page.addInitScript(([token, user]) => {
      localStorage.setItem('token', token as string);
      localStorage.setItem('user', user as string);
    }, [jeton, JSON.stringify({ id: conducteurId, name: nom, email: 'conducteur@iris.test', role: 'CONDUCTEUR_TRAVAUX', permissions: [] })]);
    await page.goto(`/chantiers/${chantierId}`, { waitUntil: 'networkidle' });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('user') || '{}').role)).toBe('CONDUCTEUR_TRAVAUX');
    const liste = page.getByRole('region', { name: 'Factures liées' });
    await expect(liste).toBeVisible();
    const ligne = liste.locator('tr', { hasText: numero });
    // Ancrer le tableau avant l'absence du bouton : zéro bouton sur zéro ligne passerait
    // aussi, et masquerait une régression de rendu ou de périmètre du conducteur.
    await expect(liste.locator('th')).toHaveCount(6);
    await expect(ligne.locator('td').nth(0)).toHaveText(numero);
    await expect(ligne.locator('td').nth(4)).toHaveText(/^100\s*€$/);
    await expect(ligne.locator('td')).toHaveCount(6);
    // L'en-tête et les cellules suivent la même garde administrateur : sans ces comptes,
    // une colonne « Action » orpheline rendrait le tableau désaligné sans fuite de données.
    await expect(ligne.getByRole('button', { name: 'PDF' })).toHaveCount(0);
    const pdf = await request.get(`${api}/factures/${factureId}/document.pdf`, { headers: { Authorization: `Bearer ${jeton}` } });
    expect(pdf.status(), await pdf.text()).toBe(403);
  });

  test.describe('navigateur Pacific/Gambier', () => {
    test.use({ timezoneId: 'Pacific/Gambier' });

    // dateEmission est une date-seule stockée à minuit UTC : à l'ouest de Greenwich,
    // un rendu qui passerait par le fuseau du navigateur afficherait la veille.
    test('affiche sur la fiche affaire les factures émises liées et leur PDF', async ({ allerSurPageAdmin, apiAdmin, creerClient, request, session }) => {
      const apiResponse = await apiAdmin.get('/company');
      expect(apiResponse.ok(), await apiResponse.text()).toBeTruthy();
      const api = new URL('/api', apiResponse.url()).toString().replace(/\/$/, '');
      const client = await creerClient('factures-liees');
      const headers = { Authorization: `Bearer ${session.token}` };
      const devis = await request.post(`${api}/devis`, {
        headers,
        data: { clientId: client.id, objet: `Affaire E2E facturée ${Date.now()}`, lignes: [{ designation: 'Pose facturée', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] },
      });
      expect(devis.ok(), await devis.text()).toBeTruthy();
      const { id: devisId } = await devis.json() as { id: string };
      const envoi = await request.put(`${api}/devis/${devisId}/statut`, { headers, data: { statut: 'ENVOYE' } });
      expect(envoi.ok(), await envoi.text()).toBeTruthy();
      const signature = await request.post(`${api}/devis/${devisId}/signature`, { headers, data: { signataire: 'Signataire E2E', confirme: true } });
      expect(signature.ok(), await signature.text()).toBeTruthy();
      const conversion = await request.post(`${api}/devis/${devisId}/convertir`, { headers, data: { cible: 'CHANTIER' } });
      expect(conversion.ok(), await conversion.text()).toBeTruthy();
      const { id: chantierId } = await conversion.json() as { id: string };
      const brouillon = await request.post(`${api}/factures`, {
        headers,
        data: { clientId: client.id, origine: 'CHANTIER', chantierId, dateEmission: dateDuJour(), dateEcheance: dateDuJour(), lignes: [{ designation: 'Pose facturée', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] },
      });
      expect(brouillon.ok(), await brouillon.text()).toBeTruthy();
      const { id: factureId } = await brouillon.json() as { id: string };
      const emission = await request.post(`${api}/factures/${factureId}/emettre`, { headers });
      expect(emission.ok(), await emission.text()).toBeTruthy();
      const { numero } = await emission.json() as { numero: string };

      const page = await allerSurPageAdmin(`/chantiers/${chantierId}`);
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Pacific/Gambier');
      const liste = page.getByRole('region', { name: 'Factures liées' });
      await expect(liste).toBeVisible();
      const ligne = liste.locator('tr', { hasText: numero });
      // L'administrateur reçoit la colonne PDF ; son en-tête fait partie du contrat de table.
      await expect(liste.locator('th')).toHaveCount(7);
      const cellules = ligne.locator('td');
      await expect(cellules.nth(0)).toHaveText(numero);
      await expect(cellules.nth(1)).toHaveText('Facture');
      await expect(cellules.nth(2)).toHaveText('EMISE');
      await expect(cellules.nth(3)).toHaveText(dateDuJour());
      await expect(cellules.nth(4)).toHaveText(/^100\s*€$/);
      await expect(cellules.nth(5)).toHaveText(/^120\s*€$/);
      await expect(ligne.getByRole('button', { name: 'PDF' })).toBeVisible();
      const pdf = await apiAdmin.get(`/factures/${factureId}/document.pdf`);
      expect(pdf.status(), await pdf.text()).toBe(200);
      expect(pdf.headers()['content-type']).toContain('application/pdf');
    });

    test('émet la facture au jour proposé et conserve ce jour dans la ligne', async ({ allerSurPageAdmin, creerClient, page }) => {
      const client = await creerClient('fuseau-gambier');
      await allerSurPageAdmin('/factures');
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Pacific/Gambier');

      await page.getByRole('button', { name: /Nouvelle facture/ }).click();
      const dateEmission = page.locator('input[name="dateEmission"]');
      const jourPropose = await dateEmission.inputValue();
      expect(jourPropose).toMatch(/^\d{2}-\d{2}-\d{4}$/);
      await page.locator('select[name="clientId"]').selectOption({ label: client.raisonSociale });
      await page.locator('input[name="motifHorsAffaire"]').fill('Parcours fuseau Gambier');
      await page.locator('input[aria-label="Désignation ligne 1"]').fill('Contrôle de la date proposée');
      await page.locator('input[aria-label="Prix unitaire HT ligne 1"]').pressSequentially('100');
      await page.getByRole('button', { name: /Créer le brouillon/ }).click();

      const ligne = page.locator('tbody tr', { hasText: client.raisonSociale }).filter({ hasText: 'Facture' });
      await expect(ligne).toContainText('BROUILLON');
      await ligne.getByRole('button', { name: /Émettre/ }).click();
      await expect(ligne).toContainText('EMISE');
      await expect(ligne).toContainText(jourPropose);
    });
  });

  test.describe('fuseau horaire entreprise', () => {
    test.use({ timezoneId: 'Pacific/Gambier' });

    test('préremplit Achats, Heures et Factures au jour de Pacific/Wallis, distinct du navigateur', async ({ allerSurPageAdmin, apiAdmin, page, request, session }) => {
      await page.clock.install({ time: new Date('2027-01-01T13:30:00Z') });
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Pacific/Gambier');
      expect(await page.evaluate(() => new Date().toISOString().startsWith('2027-01-01T13:30:00.'))).toBeTruthy();
      // Ce garde-fou rend le scénario discriminant : Gambier est encore le 01, Wallis est déjà le 02.
      expect(await page.evaluate(() => new Intl.DateTimeFormat('en-CA', {
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date()).map((partie) => partie.value).join(''))).toBe('2027-01-01');
      const reponseSociete = await apiAdmin.get('/company');
      expect(reponseSociete.ok(), await reponseSociete.text()).toBeTruthy();
      const societeInitiale = await reponseSociete.json() as { fuseauHoraire?: string | null };
      const api = new URL('/api', reponseSociete.url()).toString().replace(/\/$/, '');
      const mettreAJourFuseau = (fuseauHoraire: string) => request.put(`${api}/company`, {
        headers: { Authorization: `Bearer ${session.token}` },
        data: { fuseauHoraire },
      });

      try {
        const miseAJour = await mettreAJourFuseau('Pacific/Wallis');
        expect(miseAJour.ok(), await miseAJour.text()).toBeTruthy();
        expect((await miseAJour.json() as { fuseauHoraire: string }).fuseauHoraire).toBe('Pacific/Wallis');

        await allerSurPageAdmin('/achats');
        await expect(page.locator('input[name="date"]')).toHaveValue('02-01-2027');

        await allerSurPageAdmin('/heures');
        await expect(page.locator('input[name="date"]')).toHaveValue('02-01-2027');

        await allerSurPageAdmin('/factures');
        await page.getByRole('button', { name: /Nouvelle facture/ }).click();
        await expect(page.locator('input[name="dateEmission"]')).toHaveValue('02-01-2027');
        await expect(page.locator('input[name="dateEcheance"]')).toHaveValue('02-01-2027');
      } finally {
        const restauration = await mettreAJourFuseau(societeInitiale.fuseauHoraire || 'Europe/Paris');
        expect(restauration.ok(), await restauration.text()).toBeTruthy();
      }
    });
  });
});
