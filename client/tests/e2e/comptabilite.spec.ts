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
