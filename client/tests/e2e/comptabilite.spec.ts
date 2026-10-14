import { Buffer } from 'node:buffer';
import { test, expect } from './fixtures';

test('#95 : remappage de règle par dialogue motivé et historique visible', async ({ allerSurPageAdmin, apiAdmin }) => {
  const plan = await (await apiAdmin.get('/comptabilite')).json() as { comptes: Array<{ id: string; nature: string }> ; regles: Array<{ cle: string; compteId: string }> };
  const comptes = plan.comptes.filter(c => c.nature === 'PRODUIT');
  expect(comptes.length).toBeGreaterThanOrEqual(2);
  const current = plan.regles.find(r => r.cle === 'VENTE_PRESTATION');
  const cible = comptes.find(c => c.id !== current?.compteId)!;
  const page = await allerSurPageAdmin('/comptabilite');
  await page.getByRole('combobox', { name: 'Ventes de prestations' }).selectOption(cible.id);
  const dialogue = page.getByRole('dialog', { name: 'Motif du remappage' });
  await dialogue.getByRole('textbox', { name: /Motif/ }).fill('Révision du compte de prestation');
  await dialogue.getByRole('button', { name: 'Confirmer le remappage' }).click();
  await expect(dialogue).not.toBeVisible();
  await page.getByRole('button', { name: 'Historique des règles' }).click();
  await expect(page.getByRole('region', { name: 'Historique des règles' }).locator('p', { hasText: 'Révision du compte de prestation' }).last()).toBeVisible();
});

test('#95 : retrait de règle standard motivé dans le navigateur', async ({ allerSurPageAdmin, apiAdmin }) => {
  const page = await allerSurPageAdmin('/comptabilite');
  await page.getByRole('button', { name: 'Retirer Ventes d’articles' }).click();
  const dialogue = page.getByRole('dialog', { name: 'Retirer la règle comptable' });
  await dialogue.getByRole('textbox', { name: /Motif du retrait/ }).fill('Révision des ventes articles');
  await dialogue.getByRole('button', { name: 'Confirmer le retrait' }).click();
  await expect(dialogue).not.toBeVisible();
  const plan = await (await apiAdmin.get('/comptabilite')).json() as { regles: Array<{ cle: string }> };
  expect(plan.regles.some(r => r.cle === 'VENTE_ARTICLE')).toBe(false);
  await page.getByRole('button', { name: 'Historique des règles' }).click();
  await expect(page.getByRole('region', { name: 'Historique des règles' }).locator('p', { hasText: 'Révision des ventes articles' }).last()).toBeVisible();
});

test('#95 : création de règle standard motivée, sans mutation à la sélection', async ({ allerSurPageAdmin, apiAdmin }) => {
  const page = await allerSurPageAdmin('/comptabilite');
  await page.getByRole('button', { name: 'Retirer Ventes d’articles' }).click();
  const retrait = page.getByRole('dialog', { name: 'Retirer la règle comptable' });
  await retrait.getByRole('textbox', { name: /Motif du retrait/ }).fill('Recréation contrôlée dans le navigateur');
  await retrait.getByRole('button', { name: 'Confirmer le retrait' }).click();
  await expect(retrait).not.toBeVisible();
  const compte = (await (await apiAdmin.get('/comptabilite')).json() as { comptes: Array<{ id: string; nature: string }> }).comptes.find(c => c.nature === 'PRODUIT')!;
  await page.getByRole('combobox', { name: 'Ventes d’articles' }).selectOption(compte.id);
  const creation = page.getByRole('dialog', { name: 'Motif de la création' });
  await expect(creation).toBeVisible();
  expect((await (await apiAdmin.get('/comptabilite')).json() as { regles: Array<{ cle: string }> }).regles.some(r => r.cle === 'VENTE_ARTICLE')).toBe(false);
  await creation.getByRole('textbox', { name: /Motif/ }).fill('Création de la règle articles');
  await creation.getByRole('button', { name: 'Confirmer la création' }).click();
  await expect(creation).not.toBeVisible();
  expect((await (await apiAdmin.get('/comptabilite')).json() as { regles: Array<{ cle: string }> }).regles.some(r => r.cle === 'VENTE_ARTICLE')).toBe(true);
  await page.getByRole('button', { name: 'Historique des règles' }).click();
  await expect(page.getByRole('region', { name: 'Historique des règles' }).locator('p', { hasText: 'Création de la règle articles' }).last()).toContainText('Création de Ventes d’articles');
});

 test('TVA #92 : liste les taux, confirme le retrait ciblé puis remappe sans supprimer le compte', async ({ allerSurPageAdmin, apiAdmin, session, request }) => {
  const base = 'http://127.0.0.1:3001/api';
  const headers = { Authorization: `Bearer ${session.token}` };
  const code = `445${String(Date.now()).slice(-9)}`;
  const compte = await request.post(`${base}/comptabilite/comptes`, { headers, data: { code, libelle: 'TVA à conserver', nature: 'TVA' } });
  expect(compte.status()).toBe(201);
  const compteId = (await compte.json()).id;
  const avant77 = (await (await apiAdmin.get('/comptabilite')).json() as { reglesTva: Array<{ taux: number; compteId: string; updatedAt: string }> }).reglesTva.find(r => r.taux === 7.7);
  expect((await request.put(`${base}/comptabilite/tva/7.7`, { headers, data: { compteId, motif: 'Configuration du taux de test', ...(avant77 ? { expectedCompteId: avant77.compteId, expectedUpdatedAt: avant77.updatedAt } : {}) } })).status()).toBe(200);
  const page = await allerSurPageAdmin('/comptabilite');
  const ligne = page.getByRole('row', { name: /7,7 %/ });
  await expect(ligne).toContainText(`${code} — TVA à conserver`);
  await ligne.getByRole('button', { name: 'Remapper' }).click();
  await expect(page.getByRole('textbox', { name: 'Taux de TVA (%)' })).toHaveValue('7.7');
  await expect(page.getByRole('combobox', { name: 'Compte TVA à associer' })).toHaveValue(compteId);
  const autreCompte = ((await (await apiAdmin.get('/comptabilite')).json()) as { comptes: Array<{ code: string; id: string }> }).comptes.find(c => c.code === '445710')!;
  await page.getByRole('combobox', { name: 'Compte TVA à associer' }).selectOption(autreCompte.id);
  await page.getByRole('textbox', { name: /Motif du remappage TVA/ }).fill('Révision du compte TVA');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  // Code suivi de son libellé : le code horodaté affiché avant le remappage peut lui-même
  // commencer par 445710.
  await expect(ligne).toContainText('445710 — TVA collectée E2E');
  await ligne.getByRole('button', { name: 'Retirer' }).click();
  const dialogue = page.getByRole('dialog', { name: 'Retirer la règle TVA' });
  await expect(dialogue).toContainText('émissions futures');
  await dialogue.getByRole('button', { name: 'Annuler' }).click();
  await expect(ligne).toBeVisible();
  await ligne.getByRole('button', { name: 'Retirer' }).click();
  await dialogue.getByLabel('Confirmer le taux exact').fill('7.7');
  await dialogue.getByRole('textbox', { name: /Motif du retrait/ }).fill('Retrait du mapping TVA');
  await dialogue.getByRole('button', { name: 'Confirmer le retrait' }).click();
  await expect(ligne).not.toBeVisible();
  expect(((await (await apiAdmin.get('/comptabilite')).json()) as { comptes: Array<{ id: string; actif: boolean }> }).comptes.find(c => c.id === compteId)?.actif).toBe(true);
  await page.getByRole('textbox', { name: 'Taux de TVA (%)' }).fill('7.7');
  await page.getByRole('combobox', { name: 'Compte TVA à associer' }).selectOption(compteId);
  await page.getByRole('textbox', { name: /Motif de création TVA/ }).fill('Retour du taux après retrait');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(ligne).toContainText(code);
});

test('TVA #92 : confirmation française 5,5 dans le navigateur retire le mapping et préserve le compte', async ({ allerSurPageAdmin, request, session, apiAdmin }) => {
  const base = 'http://127.0.0.1:3001/api';
  const headers = { Authorization: `Bearer ${session.token}` };
  const code = `445${String(Date.now()).slice(-9)}`;
  const compte = await request.post(`${base}/comptabilite/comptes`, { headers, data: { code, libelle: 'TVA virgule E2E', nature: 'TVA' } });
  expect(compte.status()).toBe(201);
  const compteId = (await compte.json() as { id: string }).id;
  expect((await request.put(`${base}/comptabilite/tva/5.5`, { headers, data: { compteId, motif: 'Création du taux de test' } })).status()).toBe(200);
  const page = await allerSurPageAdmin('/comptabilite');
  const ligne = page.getByRole('row', { name: /5,5 %/ });
  await expect(ligne).toContainText(code);
  await ligne.getByRole('button', { name: 'Retirer' }).click();
  const dialogue = page.getByRole('dialog', { name: 'Retirer la règle TVA' });
  await dialogue.getByLabel('Confirmer le taux exact').fill('5,5');
  await dialogue.getByRole('textbox', { name: /Motif du retrait/ }).fill('Retrait du taux réduit');
  await expect(dialogue.getByRole('button', { name: 'Confirmer le retrait' })).toBeEnabled();
  await dialogue.getByRole('button', { name: 'Confirmer le retrait' }).click();
  await expect(ligne).not.toBeVisible();
  const plan = await (await apiAdmin.get('/comptabilite')).json() as { reglesTva: Array<{ taux: number }>; comptes: Array<{ id: string; actif: boolean }> };
  expect(plan.reglesTva.some(r => r.taux === 5.5)).toBe(false);
  expect(plan.comptes.find(c => c.id === compteId)?.actif).toBe(true);
});

test('TVA #92 : deux sessions, la confirmation ancienne ne retire pas le nouveau mapping', async ({ browser, request, session, apiAdmin }) => {
  const base = 'http://127.0.0.1:3001/api';
  const headers = { Authorization: `Bearer ${session.token}` };
  const code = String(Date.now()).slice(-8);
  const creerCompte = async (suffixe: string) => {
    const response = await request.post(`${base}/comptabilite/comptes`, { headers, data: { code: `445${code}${suffixe}`, libelle: `TVA session ${suffixe}`, nature: 'TVA' } });
    expect(response.status()).toBe(201);
    return (await response.json() as { id: string }).id;
  };
  const ancienId = await creerCompte('1');
  const nouveauId = await creerCompte('2');
  const avant89 = (await (await apiAdmin.get('/comptabilite')).json() as { reglesTva: Array<{ taux: number; compteId: string; updatedAt: string }> }).reglesTva.find(r => r.taux === 8.9);
  expect((await request.put(`${base}/comptabilite/tva/8.9`, { headers, data: { compteId: ancienId, motif: 'Configuration du taux de test', ...(avant89 ? { expectedCompteId: avant89.compteId, expectedUpdatedAt: avant89.updatedAt } : {}) } })).status()).toBe(200);
  const ouvrir = async () => {
    const contexte = await browser.newContext();
    await contexte.addInitScript(([token, user]) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', user);
    }, [session.token, JSON.stringify(session.user)]);
    const page = await contexte.newPage();
    await page.goto('/comptabilite', { waitUntil: 'networkidle' });
    return { contexte, page };
  };
  const a = await ouvrir();
  const b = await ouvrir();
  try {
    const ligneA = a.page.getByRole('row', { name: /8,9 %/ });
    const ligneB = b.page.getByRole('row', { name: /8,9 %/ });
    await expect(ligneA).toContainText('TVA session 1');
    await ligneA.getByRole('button', { name: 'Retirer' }).click();
    const dialogue = a.page.getByRole('dialog', { name: 'Retirer la règle TVA' });
    await dialogue.getByLabel('Confirmer le taux exact').fill('8.9');
    await dialogue.getByRole('textbox', { name: /Motif du retrait/ }).fill('Retrait sur ancienne version');
    await ligneB.getByRole('button', { name: 'Remapper' }).click();
    await b.page.getByRole('combobox', { name: 'Compte TVA à associer' }).selectOption(nouveauId);
    await b.page.getByRole('textbox', { name: /Motif du remappage TVA/ }).fill('Changement concurrent de mapping');
    await b.page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(ligneB).toContainText('TVA session 2');
    await dialogue.getByRole('button', { name: 'Confirmer le retrait' }).click();
    await expect(dialogue.getByRole('alert')).toContainText('a changé depuis son affichage');
    const reglesTva = (await (await request.get(`${base}/comptabilite`, { headers })).json() as { reglesTva: Array<{ taux: number; compteId: string }> }).reglesTva;
    expect(reglesTva.find(r => r.taux === 8.9)?.compteId).toBe(nouveauId);
    await expect(ligneB).toContainText('TVA session 2');
  } finally {
    await a.contexte.close();
    await b.contexte.close();
  }
});

test('aperçoit un CSV en mode mise à jour puis confirme avec un motif unique', async ({ allerSurPageAdmin, apiAdmin }) => {
  const code = `716${String(Date.now()).slice(-9)}`;
  const creation = await allerSurPageAdmin('/comptabilite');
  await creation.getByPlaceholder('Code', { exact: true }).fill(code);
  await creation.getByPlaceholder('Libellé', { exact: true }).fill('Avant import');
  await creation.locator('form').filter({ hasText: 'Ajouter' }).getByRole('button', { name: 'Ajouter' }).click();
  await creation.getByLabel('Mode de mise à jour CSV').check();
  const fichier = creation.locator('input[type="file"]');
  await fichier.setInputFiles({ name: 'correction.csv', mimeType: 'text/csv', buffer: Buffer.from(`code;libelle;nature\n${code};Après import;ACTIF`) });
  const dialogue = creation.getByRole('dialog', { name: 'Aperçu de la mise à jour CSV' });
  await expect(dialogue.locator('tbody tr', { hasText: code })).toContainText('Modification');
  await expect(dialogue.getByText(/Le motif documente les modifications ; les créations seules ne produisent pas de journal/)).toBeVisible();
  await expect(dialogue).toContainText('Avant import');
  await expect(dialogue).toContainText('Après import');
  expect(((await (await apiAdmin.get('/comptabilite')).json()) as { comptes: Array<{ code: string; libelle: string }> }).comptes.find(c => c.code === code)?.libelle).toBe('Avant import');
  await dialogue.getByLabel(/Motif unique/).fill('Correction comptable CSV');
  await dialogue.getByRole('button', { name: 'Confirmer la mise à jour' }).click();
  await expect(creation.locator('section.overflow-hidden tbody tr', { hasText: code })).toContainText('Après import');
  const compte = ((await (await apiAdmin.get('/comptabilite')).json()) as { comptes: Array<{ id: string; code: string }> }).comptes.find(c => c.code === code)!;
  const journal = (await (await apiAdmin.get(`/comptabilite/comptes/${compte.id}/journal`)).json()) as Array<{ action: string; motif: string }>;
  expect(journal.map((j: { action: string; motif: string }) => [j.action, j.motif])).toEqual([['MODIFICATION', 'Correction comptable CSV']]);
});

test('aperçu créations seules : motif expliqué, aucune trace de modification', async ({ allerSurPageAdmin, apiAdmin }) => {
  const code = `718${String(Date.now()).slice(-9)}`;
  const page = await allerSurPageAdmin('/comptabilite');
  await page.getByLabel('Mode de mise à jour CSV').check();
  await page.locator('input[type="file"]').setInputFiles({ name: 'creation.csv', mimeType: 'text/csv', buffer: Buffer.from(`code;libelle;nature\n${code};Nouveau compte;CHARGE`) });
  const dialogue = page.getByRole('dialog', { name: 'Aperçu de la mise à jour CSV' });
  await expect(dialogue.locator('tbody tr', { hasText: code })).toContainText('Création');
  await expect(dialogue.getByText(/Le motif documente les modifications ; les créations seules ne produisent pas de journal/)).toBeVisible();
  await dialogue.getByLabel(/Motif unique/).fill('Création du nouveau plan');
  await dialogue.getByRole('button', { name: 'Confirmer la mise à jour' }).click();
  await expect(dialogue).not.toBeVisible();
  const compte = ((await (await apiAdmin.get('/comptabilite')).json()) as { comptes: Array<{ id: string; code: string }> }).comptes.find(c => c.code === code)!;
  expect(compte).toBeTruthy();
  expect(await (await apiAdmin.get(`/comptabilite/comptes/${compte.id}/journal`)).json()).toEqual([]);
});

test('annule l’aperçu sans écriture puis refuse une confirmation devenue périmée', async ({ allerSurPageAdmin, apiAdmin, session, request }) => {
  const code = `717${String(Date.now()).slice(-9)}`;
  const page = await allerSurPageAdmin('/comptabilite');
  await page.getByPlaceholder('Code', { exact: true }).fill(code);
  await page.getByPlaceholder('Libellé', { exact: true }).fill('Départ');
  await page.locator('form').filter({ hasText: 'Ajouter' }).getByRole('button', { name: 'Ajouter' }).click();
  await expect(page.locator('section.overflow-hidden tbody tr', { hasText: code })).toBeVisible();
  const compte = ((await (await apiAdmin.get('/comptabilite')).json()) as { comptes: Array<{ id: string; code: string; updatedAt: string }> }).comptes.find(c => c.code === code);
  expect(compte).toBeDefined();
  if (!compte) throw new Error(`Compte ${code} absent après création`);
  await page.getByLabel('Mode de mise à jour CSV').check();
  const fichier = page.locator('input[type="file"]');
  const csv = { name: 'correction.csv', mimeType: 'text/csv', buffer: Buffer.from(`code;libelle;nature\n${code};Valeur CSV;ACTIF`) };
  await fichier.setInputFiles(csv);
  const dialogue = page.getByRole('dialog', { name: 'Aperçu de la mise à jour CSV' });
  await expect(dialogue).toBeVisible();
  await dialogue.getByRole('button', { name: 'Annuler' }).click();
  await expect(dialogue).not.toBeVisible();
  expect(((await (await apiAdmin.get('/comptabilite')).json()) as { comptes: Array<{ code: string; libelle: string }> }).comptes.find(c => c.code === code)?.libelle).toBe('Départ');
  await fichier.setInputFiles(csv);
  await expect(dialogue).toBeVisible();
  const patch = await request.patch(`http://127.0.0.1:3001/api/comptabilite/comptes/${compte.id}`, { headers: { Authorization: `Bearer ${session.token}` }, data: { libelle: 'Modification concurrente', motif: 'Autre opérateur', expectedUpdatedAt: compte.updatedAt } });
  expect(patch.status()).toBe(200);
  await dialogue.getByLabel(/Motif unique/).fill('Correction motivée');
  await dialogue.getByRole('button', { name: 'Confirmer la mise à jour' }).click();
  await expect(dialogue).not.toBeVisible();
  await expect(page.getByText(/aperçu périmé/i)).toBeVisible();
  await fichier.setInputFiles(csv);
  await expect(dialogue).toBeVisible();
  await expect(dialogue).toContainText('Modification concurrente');
  await dialogue.getByLabel(/Motif unique/).fill('Correction après nouvel aperçu');
  await dialogue.getByRole('button', { name: 'Confirmer la mise à jour' }).click();
  await expect(dialogue).not.toBeVisible();
  expect(((await (await apiAdmin.get('/comptabilite')).json()) as { comptes: Array<{ code: string; libelle: string }> }).comptes.find(c => c.code === code)?.libelle).toBe('Valeur CSV');
});

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

test('rejette depuis l’écran un CSV bidi atomiquement et un motif invisible sans trace', async ({ allerSurPageAdmin, apiAdmin }) => {
  const code = `714${String(Date.now()).slice(-9)}`;
  const codeBidi = `715${String(Date.now()).slice(-9)}`;
  const page = await allerSurPageAdmin('/comptabilite');
  const fichier = page.locator('input[type="file"]');
  await fichier.setInputFiles({ name: 'bidi.csv', mimeType: 'text/csv', buffer: Buffer.from(`code;libelle;nature\n${code};Normal;CHARGE\n${codeBidi};Compte \u202E inversé;CHARGE`) });
  await expect(page.getByText(/Ligne 3 :/)).toBeVisible();
  expect((await (await apiAdmin.get('/comptabilite')).json() as { comptes: Array<{ code: string }> }).comptes.some(c => c.code === code || c.code === codeBidi)).toBe(false);

  await page.getByPlaceholder('Code', { exact: true }).fill(code);
  await page.getByPlaceholder('Libellé', { exact: true }).fill('Compte visible');
  await page.locator('form').filter({ hasText: 'Ajouter' }).getByRole('button', { name: 'Ajouter' }).click();
  const ligne = page.locator('tbody tr', { hasText: code });
  await ligne.getByRole('button', { name: 'Modifier' }).click();
  const dialogue = page.getByRole('dialog', { name: 'Modifier le compte' });
  await dialogue.getByLabel('Libellé').fill('Changement refusé');
  await dialogue.getByLabel(/Motif/).fill('\u200B'.repeat(3));
  await dialogue.getByRole('button', { name: 'Enregistrer la modification' }).click();
  await expect(dialogue.getByRole('alert')).toContainText(/motif de 3 à 500 caractères/i);
  await expect(ligne).toContainText('Compte visible');
  const plan = await (await apiAdmin.get('/comptabilite')).json() as { comptes: Array<{ id: string; code: string }> };
  const journal = await (await apiAdmin.get(`/comptabilite/comptes/${plan.comptes.find(c => c.code === code)!.id}/journal`)).json() as Array<unknown>;
  expect(journal).toHaveLength(0);
});

test('modifie libellé et nature depuis le plan avec motif et conserve une trace', async ({ allerSurPageAdmin, apiAdmin }) => {
  const code = `712${String(Date.now()).slice(-9)}`;
  const page = await allerSurPageAdmin('/comptabilite');
  await page.getByPlaceholder('Code', { exact: true }).fill(code);
  await page.getByPlaceholder('Libellé', { exact: true }).fill('Avant modification');
  await page.locator('form').filter({ hasText: 'Ajouter' }).getByRole('button', { name: 'Ajouter' }).click();
  const ligne = page.locator('tbody tr', { hasText: code });
  await ligne.getByRole('button', { name: 'Modifier' }).click();
  const dialogue = page.getByRole('dialog', { name: 'Modifier le compte' });
  await expect(dialogue.getByText(/factures déjà émises restent inchangées/i)).toBeVisible();
  await expect(dialogue.getByLabel('Code')).toHaveValue(code);
  await expect(dialogue.getByLabel('Code')).toBeDisabled();
  await dialogue.getByLabel('Libellé').fill('Après modification');
  await dialogue.getByLabel('Nature').selectOption('PRODUIT');
  await expect(dialogue.getByRole('button', { name: 'Enregistrer la modification' })).toBeDisabled();
  await dialogue.getByLabel(/Motif/).fill('Correction du référentiel');
  await dialogue.getByRole('button', { name: 'Enregistrer la modification' }).click();
  await expect(ligne).toContainText('Après modification');
  await expect(ligne).toContainText('PRODUIT');
  const plan = await (await apiAdmin.get('/comptabilite')).json() as { comptes: Array<{ id: string; code: string }> };
  const compte = plan.comptes.find(c => c.code === code)!;
  const journal = await (await apiAdmin.get(`/comptabilite/comptes/${compte.id}/journal`)).json() as Array<{ action: string; motif: string }>;
  expect(journal.map(j => [j.action, j.motif])).toEqual([['MODIFICATION', 'Correction du référentiel']]);
});

test('deux sessions : le formulaire périmé reçoit 409 sans écraser la première modification', async ({ allerSurPageAdmin, browser, session, apiAdmin }) => {
  const code = `713${String(Date.now()).slice(-9)}`;
  const page = await allerSurPageAdmin('/comptabilite');
  await page.getByPlaceholder('Code', { exact: true }).fill(code);
  await page.getByPlaceholder('Libellé', { exact: true }).fill('Départ partagé');
  await page.locator('form').filter({ hasText: 'Ajouter' }).getByRole('button', { name: 'Ajouter' }).click();
  const contexteSecond = await browser.newContext();
  try {
    await contexteSecond.addInitScript(([token, user]) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', user);
    }, [session.token, JSON.stringify(session.user)]);
    const second = await contexteSecond.newPage();
    await second.goto('/comptabilite');
    const dialogueSecond = second.getByRole('dialog', { name: 'Modifier le compte' });
    await second.locator('tbody tr', { hasText: code }).getByRole('button', { name: 'Modifier' }).click();
    const ligne = page.locator('tbody tr', { hasText: code });
    await ligne.getByRole('button', { name: 'Modifier' }).click();
    const dialogue = page.getByRole('dialog', { name: 'Modifier le compte' });
    await dialogue.getByLabel('Libellé').fill('Premier validé');
    await dialogue.getByLabel(/Motif/).fill('Premier changement motivé');
    await dialogue.getByRole('button', { name: 'Enregistrer la modification' }).click();
    await dialogueSecond.getByLabel('Libellé').fill('Écrasement périmé');
    await dialogueSecond.getByLabel(/Motif/).fill('Tentative périmée motivée');
    await dialogueSecond.getByRole('button', { name: 'Enregistrer la modification' }).click();
    await expect(dialogueSecond).toBeVisible();
    await expect(dialogueSecond.getByRole('alert')).toContainText(/modifié depuis son ouverture/i);
    const plan = await (await apiAdmin.get('/comptabilite')).json() as { comptes: Array<{ id: string; code: string; libelle: string }> };
    const compte = plan.comptes.find(c => c.code === code)!;
    expect(compte.libelle).toBe('Premier validé');
    const journal = await (await apiAdmin.get(`/comptabilite/comptes/${compte.id}/journal`)).json() as Array<{ action: string }>;
    expect(journal.map(j => j.action)).toEqual(['MODIFICATION']);
  } finally { await contexteSecond.close(); }
});

test('nature liée à une règle refusée et dialogue conservé pour corriger la saisie', async ({ allerSurPageAdmin, apiAdmin }) => {
  const page = await allerSurPageAdmin('/comptabilite');
  // Ligne du seul compte 706000 : un code créé par un autre test peut commencer par 706000
  // (code horodaté), et une recherche par sous-chaîne trouverait alors deux lignes.
  const ligne = page.locator('tbody tr').filter({ has: page.getByRole('cell', { name: '706000', exact: true }) });
  await ligne.getByRole('button', { name: 'Modifier' }).click();
  const dialogue = page.getByRole('dialog', { name: 'Modifier le compte' });
  const libelle = await dialogue.getByLabel('Libellé').inputValue();
  await dialogue.getByLabel('Nature').selectOption('CHARGE');
  await dialogue.getByLabel(/Motif/).fill('Reclassement envisagé');
  await dialogue.getByRole('button', { name: 'Enregistrer la modification' }).click();
  await expect(dialogue.getByRole('alert')).toContainText(/nature incompatible.*remappez/i);
  await expect(dialogue.getByLabel('Nature')).toHaveValue('CHARGE');
  await expect(ligne).toContainText('PRODUIT');
  const plan = await (await apiAdmin.get('/comptabilite')).json() as { comptes: Array<{ id: string; code: string; libelle: string }> };
  const compte = plan.comptes.find(c => c.code === '706000')!;
  expect(compte.libelle).toBe(libelle);
  const journal = await (await apiAdmin.get(`/comptabilite/comptes/${compte.id}/journal`)).json() as Array<{ action: string }>;
  expect(journal.filter(j => j.action === 'MODIFICATION')).toHaveLength(0);
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
  await ligne.getByRole('button', { name: 'Désactiver' }).click();
  const dialogue = page.getByRole('dialog', { name: 'Motif du changement de statut' });
  await expect(dialogue.getByRole('button', { name: 'Confirmer la désactivation' })).toBeDisabled();
  await dialogue.getByRole('button', { name: 'Annuler' }).click();
  await expect(ligne).toContainText('Actif');
  await ligne.getByRole('button', { name: 'Désactiver' }).click();
  await dialogue.getByRole('textbox', { name: /Motif/ }).fill('  Compte retiré du plan  ');
  await dialogue.getByRole('button', { name: 'Confirmer la désactivation' }).click();
  await expect(ligne).toContainText('Inactif');
  await expect(regle.locator('option', { hasText: code })).toHaveCount(0);
  const plan = await (await apiAdmin.get('/comptabilite')).json() as { comptes: Array<{ id: string; code: string; actif: boolean }> };
  const compte = plan.comptes.find(compte => compte.code === code);
  expect(compte?.actif).toBe(false);
  const journal = await (await apiAdmin.get(`/comptabilite/comptes/${compte!.id}/journal`)).json() as Array<{ motif: string; action: string }>;
  expect(journal.map(({ motif, action }) => ({ motif, action }))).toEqual([{ motif: 'Compte retiré du plan', action: 'DESACTIVATION' }]);
  await ligne.getByRole('button', { name: 'Réactiver' }).click();
  await dialogue.getByRole('textbox', { name: /Motif/ }).fill('Retour en service');
  await dialogue.getByRole('button', { name: 'Confirmer la réactivation' }).click();
  await expect(ligne).toContainText('Actif');
  await expect(regle.locator('option', { hasText: code })).toHaveCount(1);
});

test('refuse la désactivation d’un compte encore lié à une règle et explique le remappage', async ({ allerSurPageAdmin }) => {
  const page = await allerSurPageAdmin('/comptabilite');
  // Ligne du seul compte 706000 : un code créé par un autre test peut commencer par 706000
  // (code horodaté), et une recherche par sous-chaîne trouverait alors deux lignes.
  const ligne = page.locator('tbody tr').filter({ has: page.getByRole('cell', { name: '706000', exact: true }) });
  await expect(ligne).toContainText('Actif');
  await ligne.getByRole('button', { name: 'Désactiver' }).click();
  const dialogue = page.getByRole('dialog', { name: 'Motif du changement de statut' });
  await dialogue.getByRole('textbox', { name: /Motif/ }).fill('Règle à remapper');
  await dialogue.getByRole('button', { name: 'Confirmer la désactivation' }).click();
  await expect(dialogue.getByRole('alert')).toContainText(/remappez la règle avant de désactiver/i);
  await expect(ligne).toContainText('Actif');
});

test('affiche une erreur lisible si le serveur renvoie une réponse non JSON', async ({ allerSurPageAdmin }) => {
  const page = await allerSurPageAdmin('/comptabilite');
  await page.route('**/api/comptabilite/importer', route => route.fulfill({ status: 413, contentType: 'text/html', body: '<h1>Request Entity Too Large</h1>' }));
  await page.locator('input[type="file"]').setInputFiles({ name: 'plan.csv', mimeType: 'text/csv', buffer: Buffer.from('411123;Clients;ACTIF') });
  await expect(page.getByText(/fichier trop volumineux/i)).toBeVisible();
});
