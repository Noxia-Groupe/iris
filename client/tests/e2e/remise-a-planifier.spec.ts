import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Remise « à planifier » d'une visite de contrat planifiée, son créneau libéré (décision de Nelson du
// 23-10-2026, nuit, réponse 2) : depuis son affectation au planning, la visite quitte la grille et
// revient dans la file des visites à planifier ; le motif est obligatoire.

type Visite = { id: string; reference: string; titre: string; contratTitre: string };

async function preparer(request: APIRequestContext, token: string, creerClient: (libelle: string) => Promise<{ id: string }>) {
  const headers = { Authorization: `Bearer ${token}` };
  const envoyer = async (methode: 'get' | 'post' | 'put', path: string, data?: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  // « Aujourd'hui » au fuseau de la société : la semaine que l'écran du planning affiche.
  const { fuseauHoraire } = await envoyer('get', '/company') as { fuseauHoraire?: string | null };
  const parties = new Intl.DateTimeFormat('en-GB', { timeZone: fuseauHoraire || 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date());
  const partie = (type: string) => parties.find((p) => p.type === type)!.value;
  const aujourdhui = `${partie('year')}-${partie('month')}-${partie('day')}`;
  const client = await creerClient(`Remise planifier ${suffixe}`);
  const technicien = await envoyer('post', '/intervenants', { nom: `E2E Technicien remise ${suffixe}`, role: 'TECHNICIEN', tauxHoraireCharge: 30 }) as { id: string };
  const placer = (id: string) => envoyer('put', `/interventions/${id}/planning`, { dateDebut: aujourdhui, creneau: 'HEURES', heureDebut: '09:00', heureFin: '10:00', intervenantIds: [technicien.id] });
  const visitePlacee = async (libelle: string): Promise<Visite> => {
    const contratTitre = `${libelle} ${suffixe}`;
    const contrat = await envoyer('post', '/contrats-maintenance', { clientId: client.id, titre: contratTitre, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-01-2099' }) as { id: string };
    const visite = await envoyer('post', `/contrats-maintenance/${contrat.id}/generer-intervention`) as Visite;
    await placer(visite.id);
    return { ...visite, contratTitre };
  };
  return { envoyer, aujourdhui, technicien, placer, visitePlacee, client, suffixe };
}

async function ouvrirRemise(page: Page, visite: Visite) {
  const affectation = page.getByText(visite.titre, { exact: true });
  // Sur téléphone, la grille défile dans son cadre sous la colonne des techniciens, fixée à gauche :
  // comme d'un glissement du doigt, la journée est amenée juste à droite de cette colonne.
  await affectation.scrollIntoViewIfNeeded();
  await affectation.evaluate((element) => {
    const cadre = element.closest('.overflow-x-auto');
    const colonne = cadre?.querySelector('thead th');
    if (!cadre || !colonne) return;
    cadre.scrollLeft += element.getBoundingClientRect().left - cadre.getBoundingClientRect().left - colonne.getBoundingClientRect().width - 8;
  });
  await affectation.click();
  const modale = page.getByRole('dialog', { name: 'Modifier l\'affectation' });
  await expect(modale).toBeVisible();
  await modale.getByRole('button', { name: 'Remettre à planifier' }).click();
  const dialogue = page.getByRole('dialog', { name: `Remettre à planifier la visite ${visite.reference}` });
  await expect(dialogue).toBeVisible();
  return { modale, dialogue };
}

test('depuis le planning, une visite planifiée se remet à planifier : motif exigé, créneau libéré, retour dans la file', async ({ allerSurPageAdmin, session, request, creerClient }) => {
  const { envoyer, aujourdhui, technicien, placer, visitePlacee, client, suffixe } = await preparer(request, session.token, creerClient);
  const visite = await visitePlacee('Visite remise E2E');
  // Une curative placée le même jour : son affectation ne propose pas la remise.
  const curative = await envoyer('post', '/interventions', { clientId: client.id, titre: `Dépannage remise E2E ${suffixe}` }) as Visite;
  await placer(curative.id);

  const page = await allerSurPageAdmin('/planning');
  const file = page.getByRole('region', { name: 'Interventions à planifier' });
  await expect(file.getByRole('row', { name: new RegExp(visite.reference) })).toHaveCount(0);
  await page.getByText(curative.titre, { exact: true }).click();
  const modaleCurative = page.getByRole('dialog', { name: 'Modifier l\'affectation' });
  await expect(modaleCurative).toBeVisible();
  await expect(modaleCurative.getByRole('button', { name: 'Remettre à planifier' })).toHaveCount(0);
  await modaleCurative.getByRole('button', { name: 'Annuler' }).click();
  await expect(modaleCurative).toHaveCount(0);

  const { modale, dialogue } = await ouvrirRemise(page, visite);
  const motif = dialogue.getByLabel('Motif (obligatoire)');
  await expect(motif).toBeFocused();
  let envois = 0;
  page.on('request', (req) => { if (req.method() === 'POST' && req.url().endsWith(`/interventions/${visite.id}/remise-a-planifier`)) envois++; });
  // Motif trop court : refusé à l'écran, sans requête.
  await motif.fill('ab');
  await dialogue.getByRole('button', { name: 'Confirmer la remise' }).click();
  await expect(dialogue.getByRole('alert')).toContainText('de 3 à 500 caractères');
  expect(envois).toBe(0);
  // Refus du serveur : affiché dans le dialogue, qui reste ouvert, la visite reste au planning.
  const chemin = `**/api/interventions/${visite.id}/remise-a-planifier`;
  await page.route(chemin, async (route) => {
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Conflit de remise, réessayez.' }) });
    await page.unroute(chemin);
  });
  await motif.fill('Client absent ce jour-là');
  await dialogue.getByRole('button', { name: 'Confirmer la remise' }).click();
  await expect(dialogue.getByRole('alert')).toHaveText('Conflit de remise, réessayez.');
  await expect(motif).toHaveValue('Client absent ce jour-là');
  // Confirmée : les dialogues se ferment, la visite quitte la grille et revient dans la file.
  const reponse = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/interventions/${visite.id}/remise-a-planifier`));
  await dialogue.getByRole('button', { name: 'Confirmer la remise' }).click();
  expect((await reponse).status()).toBe(200);
  await expect(dialogue).toHaveCount(0);
  await expect(modale).toHaveCount(0);
  await expect(page.getByText(visite.titre, { exact: true })).toHaveCount(0);
  const ligne = file.getByRole('row', { name: new RegExp(visite.reference) });
  await expect(ligne).toBeVisible();
  await expect(ligne).toContainText(visite.contratTitre);
  await expect(page.getByText(curative.titre, { exact: true })).toBeVisible();
  // Côté serveur : à planifier, sans créneau ni technicien, motif au journal.
  const fiche = await envoyer('get', `/interventions/${visite.id}`) as { statut: string; planningEvent: unknown; affectations: unknown[] };
  expect([fiche.statut, fiche.planningEvent, fiche.affectations]).toEqual(['A_PLANIFIER', null, []]);
  const jour = await envoyer('get', `/planning/events?start=${aujourdhui}&end=${aujourdhui}`) as Array<{ interventionId: string | null }>;
  expect(jour.some((ev) => ev.interventionId === visite.id)).toBe(false);
  const journal = await envoyer('get', `/interventions/${visite.id}/journal-saisies`) as Array<{ action: string; motif: string | null }>;
  expect(journal[0]).toMatchObject({ action: 'CHANGEMENT_STATUT', motif: 'Remise à planifier : Client absent ce jour-là' });
  // Elle se replace depuis la file, comme toute visite à planifier.
  await ligne.getByRole('button', { name: 'Placer' }).click();
  const placement = page.getByRole('dialog', { name: `Planifier ${visite.reference}` });
  await placement.getByLabel('Technicien').selectOption(technicien.id);
  await placement.getByLabel('Jour', { exact: true }).fill(aujourdhui.split('-').reverse().join('-'));
  await placement.getByRole('button', { name: 'Confirmer le placement' }).click();
  await expect(placement).toHaveCount(0);
  await expect(ligne).toHaveCount(0);
  await expect(page.getByText(visite.titre, { exact: true })).toBeVisible();
});

test('sur téléphone (375 px), la remise depuis le planning tient dans l’écran, sans défilement horizontal de la page', async ({ allerSurPageAdmin, page, session, request, creerClient }) => {
  const { visitePlacee } = await preparer(request, session.token, creerClient);
  const visite = await visitePlacee('Visite remise mobile E2E');
  await page.setViewportSize({ width: 375, height: 812 });
  await allerSurPageAdmin('/planning');
  const largeurPage = () => page.evaluate(() => document.documentElement.scrollWidth);
  expect(await largeurPage()).toBeLessThanOrEqual(375);
  // La colonne des techniciens, fixée à gauche, garde sa largeur malgré les noms longs de la base de
  // parcours : elle laisse à droite de quoi toucher une affectation.
  const colonne = await page.getByRole('columnheader', { name: 'Technicien' }).boundingBox();
  expect(colonne && colonne.width <= 175, `colonne des techniciens : ${colonne?.width}`).toBe(true);
  const { modale, dialogue } = await ouvrirRemise(page, visite);
  await expect(modale).toBeVisible();
  for (const element of [dialogue, dialogue.getByLabel('Motif (obligatoire)'), dialogue.getByRole('button', { name: 'Confirmer la remise' }), dialogue.getByRole('button', { name: 'Annuler' })]) {
    await expect(element).toBeInViewport({ ratio: 1 });
    const cadre = await element.boundingBox();
    expect(cadre && cadre.x >= 0 && cadre.x + cadre.width <= 375, 'dans la largeur de l’écran').toBe(true);
  }
  expect(await largeurPage()).toBeLessThanOrEqual(375);
  // Annuler laisse la visite planifiée ; la remise confirmée la renvoie dans la file.
  await dialogue.getByRole('button', { name: 'Annuler' }).click();
  await expect(dialogue).toHaveCount(0);
  const boutonRemise = modale.getByRole('button', { name: 'Remettre à planifier' });
  await boutonRemise.scrollIntoViewIfNeeded();
  const cadreBouton = await boutonRemise.boundingBox();
  expect(cadreBouton && cadreBouton.x >= 0 && cadreBouton.x + cadreBouton.width <= 375, 'bouton dans la largeur de l’écran').toBe(true);
  await boutonRemise.click();
  const dialogueBis = page.getByRole('dialog', { name: `Remettre à planifier la visite ${visite.reference}` });
  await dialogueBis.getByLabel('Motif (obligatoire)').fill('Technicien indisponible');
  await dialogueBis.getByRole('button', { name: 'Confirmer la remise' }).click();
  await expect(dialogueBis).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Interventions à planifier' }).getByRole('row', { name: new RegExp(visite.reference) })).toBeVisible();
  expect(await largeurPage()).toBeLessThanOrEqual(375);
});

test('depuis la fiche de l’intervention, une visite planifiée se remet aussi à planifier', async ({ allerSurPageAdmin, session, request, creerClient }) => {
  const { envoyer, visitePlacee } = await preparer(request, session.token, creerClient);
  const visite = await visitePlacee('Visite remise fiche E2E');
  const page = await allerSurPageAdmin(`/interventions/${visite.id}`);
  const carte = page.getByRole('article');
  await expect(carte).toContainText('Planifiée');
  await carte.getByRole('button', { name: 'Remettre à planifier' }).click();
  const dialogue = page.getByRole('dialog', { name: `Remettre à planifier la visite ${visite.reference}` });
  await dialogue.getByLabel('Motif (obligatoire)').fill('Accès au site impossible');
  await dialogue.getByRole('button', { name: 'Confirmer la remise' }).click();
  await expect(dialogue).toHaveCount(0);
  await expect(carte).toContainText('À planifier');
  await expect(carte.getByRole('button', { name: 'Remettre à planifier' })).toHaveCount(0);
  const fiche = await envoyer('get', `/interventions/${visite.id}`) as { statut: string; planningEvent: unknown };
  expect([fiche.statut, fiche.planningEvent]).toEqual(['A_PLANIFIER', null]);
});
