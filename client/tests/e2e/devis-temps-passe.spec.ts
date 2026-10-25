import type { APIRequestContext } from '@playwright/test';
import { test, expect, choisirClient } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Lot « devis au temps passé » (décisions de Nelson des 24 et 25-10-2026) : le pas du temps passé est un
// réglage de la société, vide au démarrage, réglé dans Administration > Marges & Commissions ; tant qu'il
// est vide, un devis au temps passé est refusé. Un devis au temps passé porte une ligne de main d'œuvre
// au prix de l'heure choisi (hors contrat ou sous contrat), d'une heure au moins, comptée dans le total,
// et dit que son total est un minimum ; converti en intervention, il la marque « au temps passé ».

const REFUS_PAS = 'Réglez d’abord le pas du temps passé dans l’administration (Administration > Marges & Commissions) : un devis au temps passé est refusé tant qu’il n’est pas fixé.';

async function envoyer(request: APIRequestContext, token: string, methode: 'post' | 'put' | 'delete', chemin: string, data?: object) {
  const response = await request[methode](`${api}${chemin}`, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(response.ok(), `${chemin} : ${await response.text()}`).toBeTruthy();
  return response.json();
}
const lirePas = async (request: APIRequestContext, token: string) => (await (await request.get(`${api}/parametres`, { headers: { Authorization: `Bearer ${token}` } })).json()).pasTempsPasseMinutes as number | null;
const reglerPas = (request: APIRequestContext, token: string, pas: number | null) => envoyer(request, token, 'put', '/parametres', { pasTempsPasseMinutes: pas === null ? '' : pas });
const devisDuClient = async (request: APIRequestContext, token: string, clientId: string) => ((await (await request.get(`${api}/devis`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { client: { id: string } }[]).filter((d) => d.client.id === clientId);
const creerMainOeuvre = (request: APIRequestContext, token: string, suffixe: string, tauxTva = '20') => envoyer(request, token, 'post', '/catalogue/prestations', {
  estMainOeuvre: true, reference: `E2E-TP-${suffixe}`, nom: `Électricien temps passé E2E ${suffixe}`, tauxTva,
  prixVenteHt: '45.50', prixJourHorsContratHt: '320', prixHeureSousContratHt: '40', prixJourSousContratHt: '280', heuresParJour: '7',
}) as Promise<{ id: string; reference: string; nom: string }>;

test('le pas du temps passé se règle dans l’administration ; vide, un devis au temps passé est refusé à l’écran', async ({ allerSurPageAdmin, request, session, creerClient, page }) => {
  const suffixe = `${Date.now()}`;
  const pasAvant = await lirePas(request, session.token);
  try {
    await reglerPas(request, session.token, null);
    const mainOeuvre = await creerMainOeuvre(request, session.token, suffixe);
    const client = await creerClient('Temps passé sans pas');
    await allerSurPageAdmin('/devis');
    await choisirClient(page, client);
    await page.getByRole('textbox', { name: 'Objet' }).fill(`Devis sans pas E2E ${suffixe}`);
    await page.getByRole('checkbox', { name: 'Devis au temps passé' }).check();
    await page.getByRole('combobox', { name: 'Main d’œuvre au temps passé' }).selectOption(mainOeuvre.id);
    await page.getByRole('button', { name: 'Créer le brouillon' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'pas du temps passé' })).toHaveText(REFUS_PAS);
    expect(await devisDuClient(request, session.token, client.id)).toHaveLength(0);

    // Administration > Marges & Commissions : le champ est vide ; un pas hors bornes est refusé, puis réglé.
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Marges & Commissions' }).click();
    const section = page.getByRole('region', { name: 'Devis au temps passé' });
    const champ = section.getByRole('spinbutton', { name: 'Pas du temps passé (minutes)' });
    await expect(champ).toHaveValue('');
    await expect(section).toContainText('Pas non réglé : les devis au temps passé sont refusés.');
    await champ.fill('61');
    await section.getByRole('button', { name: 'Enregistrer le pas' }).click();
    await expect(section.getByRole('alert')).toContainText('entre 1 et 60');
    expect(await lirePas(request, session.token)).toBeNull();
    await champ.fill('15');
    await section.getByRole('button', { name: 'Enregistrer le pas' }).click();
    await expect(section.getByRole('status')).toHaveText('Pas du temps passé enregistré : 15 minutes.');
    await expect(section).not.toContainText('Pas non réglé');
    expect(await lirePas(request, session.token)).toBe(15);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Marges & Commissions' }).click();
    await expect(page.getByRole('region', { name: 'Devis au temps passé' }).getByRole('spinbutton', { name: 'Pas du temps passé (minutes)' })).toHaveValue('15');
    // Le changement est journalisé, avant et après.
    const { entrees } = await (await request.get(`${api}/journal-administration?type=PARAMETRES`, { headers: { Authorization: `Bearer ${session.token}` } })).json() as { entrees: { avant: Record<string, unknown> | null; apres: Record<string, unknown> | null }[] };
    expect(entrees[0]?.avant).toEqual({ pasTempsPasseMinutes: null });
    expect(entrees[0]?.apres).toEqual({ pasTempsPasseMinutes: 15 });
    await page.getByRole('button', { name: 'Journal', exact: true }).click();
    const entree = page.getByRole('table', { name: 'Entrées du journal' }).locator('tr', { hasText: 'Pas du temps passé (minutes)' }).first();
    await expect(entree).toContainText('Pas du temps passé (minutes) : —');
    await expect(entree).toContainText('Pas du temps passé (minutes) : 15');
    await page.getByRole('button', { name: 'Marges & Commissions' }).click();
    // Une minute : au singulier.
    await page.getByRole('region', { name: 'Devis au temps passé' }).getByRole('spinbutton', { name: 'Pas du temps passé (minutes)' }).fill('1');
    await page.getByRole('region', { name: 'Devis au temps passé' }).getByRole('button', { name: 'Enregistrer le pas' }).click();
    await expect(page.getByRole('region', { name: 'Devis au temps passé' }).getByRole('status')).toHaveText('Pas du temps passé enregistré : 1 minute.');
    expect(await lirePas(request, session.token)).toBe(1);
    // Deux minutes : au pluriel.
    await page.getByRole('region', { name: 'Devis au temps passé' }).getByRole('spinbutton', { name: 'Pas du temps passé (minutes)' }).fill('2');
    await page.getByRole('region', { name: 'Devis au temps passé' }).getByRole('button', { name: 'Enregistrer le pas' }).click();
    await expect(page.getByRole('region', { name: 'Devis au temps passé' }).getByRole('status')).toHaveText('Pas du temps passé enregistré : 2 minutes.');
    expect(await lirePas(request, session.token)).toBe(2);
    // Vidé depuis l'écran : retiré.
    await page.getByRole('region', { name: 'Devis au temps passé' }).getByRole('spinbutton', { name: 'Pas du temps passé (minutes)' }).fill('');
    await page.getByRole('region', { name: 'Devis au temps passé' }).getByRole('button', { name: 'Enregistrer le pas' }).click();
    await expect(page.getByRole('region', { name: 'Devis au temps passé' }).getByRole('status')).toContainText('Pas du temps passé retiré');
    await expect(page.getByRole('region', { name: 'Devis au temps passé' })).toContainText('Pas non réglé : les devis au temps passé sont refusés.');
    expect(await lirePas(request, session.token)).toBeNull();
  } finally {
    await reglerPas(request, session.token, pasAvant);
  }
});

test('un devis au temps passé se compose à l’écran : main d’œuvre et tarif, ligne à une heure, refus en dessous, total et mention ; converti, l’intervention est marquée', async ({ allerSurPageAdmin, request, session, creerClient, page }) => {
  test.slow();
  const suffixe = `${Date.now()}`;
  const pasAvant = await lirePas(request, session.token);
  try {
    await reglerPas(request, session.token, 15);
    const mainOeuvre = await creerMainOeuvre(request, session.token, suffixe);
    const cable = await envoyer(request, session.token, 'post', '/catalogue/articles', { reference: `E2E-TP-CAB-${suffixe}`, nom: `Câble temps passé E2E ${suffixe}`, unite: 'm', prixVenteHt: '2.50', tauxTva: '20' }) as { nom: string };
    const client = await creerClient('Temps passé');
    const objet = `Dépannage au temps passé E2E ${suffixe}`;
    await allerSurPageAdmin('/devis');
    await choisirClient(page, client);
    await page.getByRole('textbox', { name: 'Objet' }).fill(objet);
    await page.getByRole('checkbox', { name: 'Devis au temps passé' }).check();
    const tarif = page.getByRole('combobox', { name: 'Tarif de l’heure' });
    await expect(tarif).toBeDisabled();
    await page.getByRole('combobox', { name: 'Main d’œuvre au temps passé' }).selectOption(mainOeuvre.id);
    // Les deux prix à l'heure sont proposés, jamais le forfait jour.
    await expect(tarif.locator('option')).toHaveText(['À l’heure hors contrat — 45,50 € HT', 'À l’heure sous contrat — 40,00 € HT']);
    const ligne = page.getByRole('group', { name: 'Ligne au temps passé' });
    await expect(ligne.getByRole('spinbutton', { name: 'Heures (1 minimum)' })).toHaveValue('1');
    await expect(ligne.getByTestId('prix-heure-temps-passe')).toHaveText('45,50 € HT');
    await tarif.selectOption('SOUS_CONTRAT');
    await expect(ligne.getByTestId('prix-heure-temps-passe')).toHaveText('40,00 € HT');
    await expect(ligne.getByRole('spinbutton', { name: 'Heures (1 minimum)' })).toHaveValue('1');
    // Décocher retire la ligne au temps passé ; recocher la propose de nouveau, à choisir.
    await page.getByRole('checkbox', { name: 'Devis au temps passé' }).uncheck();
    await expect(ligne).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Main d’œuvre au temps passé' })).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Devis au temps passé' }).check();
    await expect(ligne).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Main d’œuvre au temps passé' }).selectOption(mainOeuvre.id);
    await tarif.selectOption('SOUS_CONTRAT');
    await expect(ligne.getByTestId('prix-heure-temps-passe')).toHaveText('40,00 € HT');
    // Le matériel s'ajoute en lignes à part.
    await page.getByRole('searchbox', { name: 'Rechercher dans le catalogue' }).fill(`E2E-TP-CAB-${suffixe}`);
    await page.getByRole('button', { name: `Ajouter ${cable.nom}` }).click();
    await page.getByRole('spinbutton', { name: 'Qté' }).fill('12');
    // En dessous d'une heure : refusé par l'écran, avec un message clair, sans rien envoyer au serveur.
    const envois: string[] = [];
    const surRequete = (requete: { method: () => string; url: () => string }) => { if (requete.method() === 'POST' && /\/api\/devis$/.test(requete.url())) envois.push(requete.url()); };
    page.on('request', surRequete);
    await ligne.getByRole('spinbutton', { name: 'Heures (1 minimum)' }).fill('0.5');
    await page.getByRole('button', { name: 'Créer le brouillon' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'heure' })).toHaveText('La ligne au temps passé compte au moins une heure : sa quantité est de 1 ou plus.');
    expect(envois, 'aucune création envoyée').toHaveLength(0);
    page.off('request', surRequete);
    expect(await devisDuClient(request, session.token, client.id)).toHaveLength(0);
    await ligne.getByRole('spinbutton', { name: 'Heures (1 minimum)' }).fill('2');
    await page.getByRole('button', { name: 'Créer le brouillon' }).click();
    const item = page.getByRole('listitem').filter({ hasText: objet });
    await expect(item).toContainText('Au temps passé');
    await expect(item).toContainText('HT 110.00 € · TVA 22.00 € · TTC 132.00 €');
    await expect(item.getByTestId('mention-temps-passe')).toHaveText('Devis au temps passé : 2 heures minimum facturées au prix de 40,00 € HT de l’heure (tarif à l’heure sous contrat), hors matériel ; au-delà de la première heure, le temps passé se facture par tranches de 15 minutes, toute tranche commencée étant due. Le total de ce devis est un minimum.');
    const [enregistre] = await devisDuClient(request, session.token, client.id) as unknown as { id: string; auTempsPasse: boolean; pasTempsPasseMinutes: number; lignes: { tempsPasse: boolean; tarifTempsPasse: string; prixUnitaireHt: number; quantite: number }[] }[];
    expect([enregistre.auTempsPasse, enregistre.pasTempsPasseMinutes]).toEqual([true, 15]);
    expect(enregistre.lignes.filter((l) => l.tempsPasse).map((l) => [l.tarifTempsPasse, l.prixUnitaireHt, l.quantite])).toEqual([['SOUS_CONTRAT', 40, 2]]);

    // Modifier le brouillon : la ligne garde son prix figé, même si la main d'œuvre change de prix.
    await envoyer(request, session.token, 'put', `/catalogue/prestations/${mainOeuvre.id}`, {
      estMainOeuvre: true, reference: mainOeuvre.reference, nom: mainOeuvre.nom, tauxTva: '20',
      prixVenteHt: '50', prixJourHorsContratHt: '320', prixHeureSousContratHt: '44', prixJourSousContratHt: '280', heuresParJour: '7',
    });
    await item.getByRole('button', { name: 'Modifier' }).click();
    await expect(page.getByRole('checkbox', { name: 'Devis au temps passé' })).toBeChecked();
    await expect(ligne.getByTestId('prix-heure-temps-passe')).toHaveText('40,00 € HT');
    await ligne.getByRole('spinbutton', { name: 'Heures (1 minimum)' }).fill('3');
    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    await expect(item).toContainText('HT 150.00 € · TVA 30.00 € · TTC 180.00 €');
    await expect(item.getByTestId('mention-temps-passe')).toContainText('3 heures minimum facturées au prix de 40,00 € HT de l’heure');

    // Signé, il se convertit en intervention depuis l'écran : l'intervention porte le marqueur.
    await envoyer(request, session.token, 'post', `/devis/${enregistre.id}/signature`, { signataire: 'Client temps passé E2E', confirme: true });
    await page.reload({ waitUntil: 'networkidle' });
    await item.getByRole('button', { name: 'Créer l’intervention' }).click();
    await page.getByRole('dialog', { name: 'Créer l’intervention du devis' }).getByRole('button', { name: 'Créer l’intervention' }).click();
    await expect(page.getByRole('dialog', { name: 'Créer l’intervention du devis' })).toHaveCount(0);
    await page.goto('/interventions', { waitUntil: 'networkidle' });
    const carte = page.locator('article').filter({ has: page.getByRole('heading', { name: objet }) });
    await expect(carte).toContainText('Au temps passé');
    await carte.getByRole('link', { name: 'Ouvrir la fiche' }).click();
    await expect(page).toHaveURL(/\/interventions\/[0-9a-f-]+$/);
    await expect(page.locator('article').filter({ has: page.getByRole('heading', { name: objet }) }).getByText('Au temps passé', { exact: true })).toBeVisible();
  } finally {
    await reglerPas(request, session.token, pasAvant);
  }
});

test('rendu à 375 px : formulaire du devis au temps passé, mention, réglage et intervention marquée, sans débordement', async ({ allerSurPageAdmin, request, session, creerClient, page }) => {
  const suffixe = `${Date.now()}`;
  const pasAvant = await lirePas(request, session.token);
  try {
    await reglerPas(request, session.token, 30);
    const mainOeuvre = await creerMainOeuvre(request, session.token, suffixe, '5.5');
    const client = await creerClient('Temps passé mobile');
    await page.setViewportSize({ width: 375, height: 812 });
    await allerSurPageAdmin('/devis');
    const debordement = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await choisirClient(page, client);
    const objet = `Temps passé mobile E2E ${suffixe}`;
    await page.getByRole('textbox', { name: 'Objet' }).fill(objet);
    await page.getByRole('checkbox', { name: 'Devis au temps passé' }).check();
    await page.getByRole('combobox', { name: 'Main d’œuvre au temps passé' }).selectOption(mainOeuvre.id);
    const ligne = page.getByRole('group', { name: 'Ligne au temps passé' });
    // La TVA de la main d'œuvre, affichée au format français.
    await expect(ligne).toContainText('5,5 %');
    for (const element of [page.getByRole('combobox', { name: 'Tarif de l’heure' }), ligne.getByRole('spinbutton', { name: 'Heures (1 minimum)' }), ligne.getByTestId('prix-heure-temps-passe')]) {
      await element.scrollIntoViewIfNeeded();
      const boite = await element.boundingBox();
      expect(boite, 'élément affiché').toBeTruthy();
      expect(boite!.x).toBeGreaterThanOrEqual(0);
      expect(boite!.x + boite!.width).toBeLessThanOrEqual(375);
    }
    expect(await debordement(), 'formulaire élargi').toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Créer le brouillon' }).click();
    const item = page.getByRole('listitem').filter({ hasText: objet });
    await expect(item.getByTestId('mention-temps-passe')).toContainText('tranches de 30 minutes');
    await item.getByTestId('mention-temps-passe').scrollIntoViewIfNeeded();
    const mention = await item.getByTestId('mention-temps-passe').boundingBox();
    expect(mention!.x + mention!.width).toBeLessThanOrEqual(375);
    expect(await debordement(), 'liste élargie').toBeLessThanOrEqual(0);

    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Marges & Commissions' }).click();
    const champ = page.getByRole('region', { name: 'Devis au temps passé' }).getByRole('spinbutton', { name: 'Pas du temps passé (minutes)' });
    await champ.scrollIntoViewIfNeeded();
    await expect(champ).toHaveValue('30');
    const boiteChamp = await champ.boundingBox();
    expect(boiteChamp!.x + boiteChamp!.width).toBeLessThanOrEqual(375);

    // Intervention marquée, sur téléphone.
    const [devis] = await devisDuClient(request, session.token, client.id) as unknown as { id: string }[];
    await envoyer(request, session.token, 'post', `/devis/${devis.id}/signature`, { signataire: 'Client mobile E2E', confirme: true });
    const intervention = await envoyer(request, session.token, 'post', `/devis/${devis.id}/convertir`, { cible: 'INTERVENTION' }) as { id: string; auTempsPasse: boolean };
    expect(intervention.auTempsPasse).toBe(true);
    await page.goto(`/interventions/${intervention.id}`, { waitUntil: 'networkidle' });
    const badge = page.getByText('Au temps passé', { exact: true });
    await expect(badge).toBeVisible();
    const boiteBadge = await badge.boundingBox();
    expect(boiteBadge!.x + boiteBadge!.width).toBeLessThanOrEqual(375);
    expect(await debordement(), 'fiche élargie').toBeLessThanOrEqual(0);
  } finally {
    await reglerPas(request, session.token, pasAvant);
  }
});
