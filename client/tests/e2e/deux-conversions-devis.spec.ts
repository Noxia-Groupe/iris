import { test, expect, dateDuJour } from './fixtures';
import type { Page } from '@playwright/test';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Lot 4 suite (décisions de Nelson des 22 et 23-10-2026) : depuis l'écran Devis, un devis signé se
// convertit en deux cibles de types différents ; son annulation, dont la question dit ce qu'elle
// annule, annule aussi le chantier, le contrat (statut « Annulé ») et ses visites non réalisées, et
// l'intervention.
const ACTIONS_CONTRAT = ['Modifier la couverture', 'Générer l’intervention', 'Échéance suivante', 'Suspendre', 'Réactiver', 'Clôturer'];
const largeurDebordee = (page: Page) => page.evaluate(() => { const m = document.querySelector('main')!; return m.scrollWidth - m.clientWidth; });

test('deux conversions depuis l’écran Devis, puis annulation du devis avec ce qu’il a créé', async ({ allerSurPageAdmin, creerClient, request, session, page: pageAdmin }) => {
  test.slow();
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'put', path: string, data: object) => {
    const reponse = await request[methode](`${api}${path}`, { headers, data });
    expect(reponse.ok(), `${path} : ${await reponse.text()}`).toBeTruthy();
    return reponse.json();
  };
  const suffixe = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const devisSigne = async (clientId: string, objet: string) => {
    const devis = await envoyer('post', '/devis', { clientId, objet, lignes: [{ designation: 'Visite', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 150, tauxTva: 20 }] }) as { id: string };
    await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
    await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
    return devis;
  };
  const conversionsDe = async (devisId: string) => {
    const liste = await (await request.get(`${api}/devis`, { headers })).json() as { id: string; conversions: { cibleType: string; cibleId: string }[] }[];
    return Object.fromEntries(liste.find((d) => d.id === devisId)!.conversions.map((c) => [c.cibleType, c.cibleId]));
  };
  const client = await creerClient('deux-conversions', true);
  const objetChantier = `Chantier et contrat ${suffixe}`;
  const objetSav = `Contrat et SAV ${suffixe}`;
  const devisChantier = await devisSigne(client.id, objetChantier);
  const devisSav = await devisSigne(client.id, objetSav);

  // Chaque question d'annulation est relevée, puis acceptée avec un motif.
  const questions: string[] = [];
  pageAdmin.on('dialog', (dialogue) => { questions.push(dialogue.message()); void dialogue.accept(`Motif E2E ${suffixe}`); });
  const page = await allerSurPageAdmin('/devis');
  const ligne = (objet: string) => page.locator('li', { hasText: objet });
  const bouton = (objet: string, nom: string) => ligne(objet).getByRole('button', { name: nom, exact: true });

  // 1. Chantier, puis contrat : après la première conversion, les deux autres types restent proposés.
  await bouton(objetChantier, 'Ouvrir le chantier').click();
  await expect(ligne(objetChantier)).toContainText('Chantier issu de ce devis');
  await expect(bouton(objetChantier, 'Ouvrir le chantier')).toHaveCount(0);
  await expect(bouton(objetChantier, 'Créer l’intervention')).toBeVisible();
  await expect(bouton(objetChantier, 'Annuler')).toBeVisible();
  await bouton(objetChantier, 'Créer le contrat').click();
  const formulaireContrat = page.getByRole('dialog', { name: 'Créer le contrat du devis' });
  // Contrat commencé : date de début passée.
  await formulaireContrat.getByLabel('Date de début').fill('01-01-2025');
  await formulaireContrat.getByRole('button', { name: 'Créer le contrat' }).click();
  await expect(formulaireContrat).toHaveCount(0);
  await expect(ligne(objetChantier)).toContainText('Chantier issu de ce devis');
  await expect(ligne(objetChantier)).toContainText('Contrat de maintenance issu de ce devis');
  // Deux conversions : plus aucune n'est proposée ; chaque cible a son lien.
  for (const action of ['Ouvrir le chantier', 'Créer l’intervention', 'Créer le contrat']) await expect(bouton(objetChantier, action)).toHaveCount(0);
  await expect(ligne(objetChantier).getByRole('link', { name: 'voir la fiche du chantier' })).toHaveAttribute('href', /^\/chantiers\/[0-9a-f-]+$/);
  await expect(ligne(objetChantier).getByRole('link', { name: 'voir les contrats' })).toHaveAttribute('href', '/contrats-maintenance');
  const ciblesChantier = await conversionsDe(devisChantier.id);
  // Une visite à planifier sur le contrat : elle sera annulée avec lui.
  const visite = await envoyer('post', `/contrats-maintenance/${ciblesChantier.CONTRAT}/generer-intervention`, {}) as { id: string; titre: string };
  // Avant l'annulation : le chantier dans la liste des chantiers, la visite dans celle des
  // interventions, le contrat actif.
  await page.goto('/chantiers', { waitUntil: 'networkidle' });
  await expect(page.locator('main').getByText(objetChantier).first()).toBeVisible();
  await page.goto('/interventions', { waitUntil: 'networkidle' });
  await expect(page.locator('main').getByText(visite.titre)).toBeVisible();
  await page.goto('/contrats-maintenance', { waitUntil: 'networkidle' });
  await expect(page.locator('article', { hasText: objetChantier }).getByText('Actif', { exact: true })).toBeVisible();

  // 2. Annulation : la question dit ce qui sera annulé avec le devis.
  await page.goto('/devis', { waitUntil: 'networkidle' });
  await bouton(objetChantier, 'Annuler').click();
  await expect(ligne(objetChantier)).toContainText('ANNULE');
  expect(questions).toEqual(['L’annulation de ce devis annule aussi son chantier, son contrat de maintenance et les visites non réalisées de ce contrat.\nMotif de l’annulation de ce devis ?']);
  await expect(ligne(objetChantier)).toContainText('Chantier annulé avec le devis');
  await expect(ligne(objetChantier)).toContainText('Contrat de maintenance annulé avec le devis');
  await expect(ligne(objetChantier)).toContainText(`Annulé : Motif E2E ${suffixe}`);
  await expect(bouton(objetChantier, 'Annuler')).toHaveCount(0);
  const chantier = await (await request.get(`${api}/chantiers/${ciblesChantier.CHANTIER}`, { headers })).json() as { statut: string; motifAnnulation: string };
  expect([chantier.statut, chantier.motifAnnulation]).toEqual(['ANNULE', `Motif E2E ${suffixe}`]);

  // 3. Contrat puis intervention (SAV) depuis l'écran ; l'annulation annule aussi l'intervention.
  await bouton(objetSav, 'Créer le contrat').click();
  await formulaireContrat.getByRole('button', { name: 'Créer le contrat' }).click();
  await expect(formulaireContrat).toHaveCount(0);
  await expect(ligne(objetSav)).toContainText('Contrat de maintenance issu de ce devis');
  await bouton(objetSav, 'Créer l’intervention').click();
  const formulaireIntervention = page.getByRole('dialog', { name: 'Créer l’intervention du devis' });
  await formulaireIntervention.getByRole('button', { name: 'Créer l’intervention' }).click();
  await expect(formulaireIntervention).toHaveCount(0);
  await expect(ligne(objetSav)).toContainText('Intervention issue de ce devis');
  for (const action of ['Ouvrir le chantier', 'Créer l’intervention', 'Créer le contrat']) await expect(bouton(objetSav, action)).toHaveCount(0);
  const lienIntervention = ligne(objetSav).getByRole('link', { name: 'voir la fiche de l’intervention' });
  await expect(lienIntervention).toHaveAttribute('href', /^\/interventions\/[0-9a-f-]+$/);
  await page.goto('/interventions', { waitUntil: 'networkidle' });
  await expect(page.locator('main').getByText(objetSav, { exact: true })).toBeVisible();
  await page.goto('/devis', { waitUntil: 'networkidle' });
  await bouton(objetSav, 'Annuler').click();
  await expect(ligne(objetSav)).toContainText('Intervention issue de ce devis, annulée.');
  await expect(ligne(objetSav)).toContainText('Contrat de maintenance annulé avec le devis');
  expect(questions.at(-1)).toBe('L’annulation de ce devis annule aussi son contrat de maintenance et les visites non réalisées de ce contrat, son intervention.\nMotif de l’annulation de ce devis ?');
  // L'intervention annulée n'a plus de fiche : son lien disparaît.
  await expect(lienIntervention).toHaveCount(0);

  // 4. Effets visibles : le chantier quitte la liste des chantiers, la visite et l'intervention
  // annulées celle des interventions, et les deux contrats sont « Annulé », avec leur date et leur
  // motif, sans action.
  await page.goto('/chantiers', { waitUntil: 'networkidle' });
  await expect(page.locator('main').getByText(objetChantier)).toHaveCount(0);
  await page.goto('/interventions', { waitUntil: 'networkidle' });
  await expect(page.locator('main').getByText(visite.titre)).toHaveCount(0);
  await expect(page.locator('main').getByText(objetSav, { exact: true })).toHaveCount(0);
  const ciblesSav = await conversionsDe(devisSav.id);
  const interventions = await (await request.get(`${api}/interventions?inclureAnnulees=true`, { headers })).json() as { id: string; statut: string }[];
  for (const id of [visite.id, ciblesSav.INTERVENTION]) expect(interventions.find((i) => i.id === id)?.statut).toBe('ANNULEE');
  await page.goto('/contrats-maintenance', { waitUntil: 'networkidle' });
  for (const objet of [objetChantier, objetSav]) {
    const contrat = page.locator('article', { hasText: objet });
    await expect(contrat.getByText('Annulé', { exact: true })).toBeVisible();
    await expect(contrat).toContainText(`Annulé avec son devis le ${dateDuJour()} : Motif E2E ${suffixe}`);
    for (const action of ACTIONS_CONTRAT) await expect(contrat.getByRole('button', { name: action })).toHaveCount(0);
  }
});

// À 375 px, la ligne d'un devis converti une fois garde ses actions (seconde conversion, annulation)
// dans l'écran, et l'écran des contrats montre un contrat annulé sans déborder.
test('à 375 px : seconde conversion proposée, annulation, contrat « Annulé »', async ({ allerSurPageAdmin, creerClient, request, session, page: pageAdmin }) => {
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'put', path: string, data: object) => {
    const reponse = await request[methode](`${api}${path}`, { headers, data });
    expect(reponse.ok(), `${path} : ${await reponse.text()}`).toBeTruthy();
    return reponse.json();
  };
  const client = await creerClient('deux-conversions-375', true);
  const objet = `Maintenance de la chaufferie collective du bâtiment B ${Date.now()}`;
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet, lignes: [{ designation: 'Visite', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }) as { id: string };
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CONTRAT', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: dateDuJour() });
  pageAdmin.on('dialog', (dialogue) => void dialogue.accept('Motif E2E 375 px'));
  const page = await allerSurPageAdmin('about:blank');
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/devis', { waitUntil: 'networkidle' });
  const ligne = page.locator('li', { hasText: objet });
  await expect(ligne).toContainText('Contrat de maintenance issu de ce devis');
  for (const action of ['Ouvrir le chantier', 'Créer l’intervention', 'Annuler']) {
    const bouton = ligne.getByRole('button', { name: action, exact: true });
    await expect(bouton).toBeVisible();
    const boite = (await bouton.boundingBox())!;
    expect(boite.x >= 0 && boite.x + boite.width <= 375, `${action} dans l’écran`).toBeTruthy();
  }
  await expect(ligne.getByRole('button', { name: 'Créer le contrat', exact: true })).toHaveCount(0);
  expect(await largeurDebordee(page), 'écran Devis élargi').toBeLessThanOrEqual(0);
  await ligne.getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(ligne).toContainText('Contrat de maintenance annulé avec le devis');
  expect(await largeurDebordee(page), 'écran Devis élargi après l’annulation').toBeLessThanOrEqual(0);

  await page.goto('/contrats-maintenance', { waitUntil: 'networkidle' });
  const contrat = page.locator('article', { hasText: objet });
  await expect(contrat.getByText('Annulé', { exact: true })).toBeVisible();
  await expect(contrat).toContainText('Annulé avec son devis le');
  for (const action of ACTIONS_CONTRAT) await expect(contrat.getByRole('button', { name: action })).toHaveCount(0);
  expect(await largeurDebordee(page), 'écran Contrats élargi').toBeLessThanOrEqual(0);
});
