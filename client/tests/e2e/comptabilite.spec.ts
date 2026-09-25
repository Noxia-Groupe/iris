import { Buffer } from 'node:buffer';
import { test, expect } from './fixtures';

test('importe un libellé CSV cité avec virgule et point-virgule puis le conserve', async ({ allerSurPageAdmin, apiAdmin }) => {
  const code = `706${String(Date.now()).slice(-9)}`;
  const libelle = 'Ventes, pose; et "entretien"';
  const page = await allerSurPageAdmin('/comptabilite');
  await expect(page.getByRole('heading', { name: 'Plan comptable' })).toBeVisible();
  const fichier = page.locator('input[type="file"]');
  await fichier.setInputFiles({ name: 'plan.csv', mimeType: 'text/csv', buffer: Buffer.from(`\uFEFFcode;libelle;nature\r\n${code};"Ventes, pose; et ""entretien""";PRODUIT\r\n`) });
  await expect(page.getByText('1 compte(s) importé(s), 0 déjà présent(s).')).toBeVisible();
  await expect(page.locator('tbody tr', { hasText: code })).toContainText(libelle);
  const plan = await (await apiAdmin.get('/comptabilite')).json() as { comptes: Array<{ code: string; libelle: string; nature: string }> };
  expect(plan.comptes.filter(compte => compte.code === code).map(({ code: numero, libelle: nom, nature }) => ({ code: numero, libelle: nom, nature }))).toEqual([{ code, libelle, nature: 'PRODUIT' }]);

  const codeRefuse = `707${String(Date.now()).slice(-9)}`;
  await fichier.setInputFiles({ name: 'incorrect.csv', mimeType: 'text/csv', buffer: Buffer.from(`code;libelle;nature\n${codeRefuse};Correct;PRODUIT\n707999;"Incomplet;PRODUIT`) });
  await expect(page.getByText(/Ligne 3 : guillemet non fermé/)).toBeVisible();
  await expect(fichier).toHaveValue('');
  const apresRefus = await (await apiAdmin.get('/comptabilite')).json() as { comptes: Array<{ code: string }> };
  expect(apresRefus.comptes.some(compte => compte.code === codeRefuse)).toBe(false);
});

test('traduit les erreurs API en lignes physiques du second fichier et préserve le lot', async ({ allerSurPageAdmin, apiAdmin }) => {
  const code = `708${String(Date.now()).slice(-9)}`;
  const page = await allerSurPageAdmin('/comptabilite');
  const fichier = page.locator('input[type="file"]');
  await fichier.setInputFiles({ name: 'premier.csv', mimeType: 'text/csv', buffer: Buffer.from(`code;libelle;nature\n${code};Original;PRODUIT`) });
  await expect(page.getByText('1 compte(s) importé(s), 0 déjà présent(s).')).toBeVisible();
  const nouveau = `709${String(Date.now()).slice(-9)}`;
  await fichier.setInputFiles({ name: 'second.csv', mimeType: 'text/csv', buffer: Buffer.from(`code;Libellé;nature;\r\n\r\n${nouveau};"Libellé; valide";PRODUIT;\r\n   \r\n${code};Modifié;PASSIF;`) });
  await expect(page.getByText(/Ligne 5 : Le compte .* existe avec un libellé ou une nature différente/)).toBeVisible();
  const plan = await (await apiAdmin.get('/comptabilite')).json() as { comptes: Array<{ code: string; libelle: string }> };
  expect(plan.comptes.find(compte => compte.code === code)?.libelle).toBe('Original');
  expect(plan.comptes.some(compte => compte.code === nouveau)).toBe(false);
});

test('refuse un libellé CSV multiligne sur sa ligne physique sans importer le lot', async ({ allerSurPageAdmin, apiAdmin }) => {
  const code = `710${String(Date.now()).slice(-9)}`;
  const page = await allerSurPageAdmin('/comptabilite');
  const fichier = page.locator('input[type="file"]');
  await fichier.setInputFiles({ name: 'libelle-invalide.csv', mimeType: 'text/csv', buffer: Buffer.from(`code;libelle;nature\r\n\r\n${code};Valide;PRODUIT\r\n710999;"Clients\r\nFrance";ACTIF`) });
  await expect(page.getByText(/Ligne 4 : libellé contenant un caractère de contrôle interdit/)).toBeVisible();
  await expect(fichier).toHaveValue('');
  const plan = await (await apiAdmin.get('/comptabilite')).json() as { comptes: Array<{ code: string }> };
  expect(plan.comptes.some(compte => compte.code === code)).toBe(false);
});

test('confirme la désactivation d’un compte, le retire des choix et permet sa réactivation', async ({ allerSurPageAdmin, apiAdmin }) => {
  const code = `711${String(Date.now()).slice(-9)}`;
  const page = await allerSurPageAdmin('/comptabilite');
  await page.getByPlaceholder('Code', { exact: true }).fill(code);
  await page.getByPlaceholder('Libellé', { exact: true }).fill('Compte temporaire E2E');
  await page.locator('form').filter({ hasText: 'Ajouter' }).getByRole('combobox').selectOption('PRODUIT');
  await page.locator('form').filter({ hasText: 'Ajouter' }).getByRole('button', { name: 'Ajouter' }).click();
  const ligne = page.locator('tbody tr', { hasText: code });
  await expect(ligne).toContainText('Actif');
  const regle = page.getByLabel('Ventes de prestations');
  await expect(regle.locator('option', { hasText: code })).toHaveCount(1);
  page.once('dialog', dialog => dialog.dismiss());
  await ligne.getByRole('button', { name: 'Désactiver' }).click();
  await expect(ligne).toContainText('Actif');
  page.once('dialog', dialog => dialog.accept());
  await ligne.getByRole('button', { name: 'Désactiver' }).click();
  await expect(ligne).toContainText('Inactif');
  await expect(regle.locator('option', { hasText: code })).toHaveCount(0);
  const plan = await (await apiAdmin.get('/comptabilite')).json() as { comptes: Array<{ code: string; actif: boolean }> };
  expect(plan.comptes.find(compte => compte.code === code)?.actif).toBe(false);
  page.once('dialog', dialog => dialog.accept());
  await ligne.getByRole('button', { name: 'Réactiver' }).click();
  await expect(ligne).toContainText('Actif');
  await expect(regle.locator('option', { hasText: code })).toHaveCount(1);
});

test('refuse la désactivation d’un compte encore lié à une règle et explique le remappage', async ({ allerSurPageAdmin }) => {
  const page = await allerSurPageAdmin('/comptabilite');
  const ligne = page.locator('tbody tr', { hasText: '706000' });
  await expect(ligne).toContainText('Actif');
  page.once('dialog', dialog => dialog.accept());
  await ligne.getByRole('button', { name: 'Désactiver' }).click();
  await expect(page.getByText(/remappez la règle avant de désactiver/i)).toBeVisible();
  await expect(ligne).toContainText('Actif');
});

test('affiche une erreur lisible si le serveur renvoie une réponse non JSON', async ({ allerSurPageAdmin }) => {
  const page = await allerSurPageAdmin('/comptabilite');
  await page.route('**/api/comptabilite/importer', route => route.fulfill({ status: 413, contentType: 'text/html', body: '<h1>Request Entity Too Large</h1>' }));
  await page.locator('input[type="file"]').setInputFiles({ name: 'plan.csv', mimeType: 'text/csv', buffer: Buffer.from('411123;Clients;ACTIF') });
  await expect(page.getByText(/fichier trop volumineux/i)).toBeVisible();
});
