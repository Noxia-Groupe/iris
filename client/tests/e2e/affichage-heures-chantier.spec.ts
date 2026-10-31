import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Correctif d'affichage des heures vendues du chantier (remarque N1 du contrôle de cohérence de #379, avant la
// fusion) : depuis la ligne de main d'œuvre au jour ou à la demi-journée, une demi-journée à 7,5 h par jour vaut
// 3,75 h, et le chantier ouvert du devis reçoit des heures vendues au centième. La fiche affichait « 18.75 h » (nombre
// brut), la liste « 18,8 h » (une décimale), et le champ « Total Heures Vendues (h) » de « Modifier », au pas de 0,5,
// faisait refuser par le navigateur 20 ou 18,5 depuis 18,75. Les écrans affichent désormais deux décimales au plus,
// à la française, et le champ suit le pas de 0,01 de la colonne (Decimal(10,2)).

type Chantier = { id: string; nom: string; heuresVendues: number };

async function preparer(request: APIRequestContext, token: string, creerClient: (libelle: string) => Promise<{ id: string }>) {
  const envoyer = async (methode: 'post' | 'put' | 'patch', chemin: string, data?: object) => {
    const response = await request[methode](`${api}${chemin}`, { headers: { Authorization: `Bearer ${token}` }, data });
    expect(response.ok(), `${chemin} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  // Main d'œuvre à 7,5 h par jour, avec un prix de la demi-journée hors contrat (comme forfait-jour-devis.spec.ts).
  const mainOeuvre = await envoyer('post', '/catalogue/prestations', {
    estMainOeuvre: true, reference: `E2E-AFF-H-${suffixe}`, nom: `Affichage heures E2E ${suffixe}`, tauxTva: '20',
    prixVenteHt: '45', prixJourHorsContratHt: '300', prixHeureSousContratHt: '40', prixJourSousContratHt: '280', heuresParJour: '7.5',
    prixDemiJourneeHorsContratHt: '160', prixDemiJourneeSousContratHt: '150.50',
  }) as { id: string };
  const client = await creerClient(`Affichage heures ${suffixe}`);
  const ligne = (forfaitMainOeuvre: 'JOUR' | 'DEMI_JOURNEE', quantite: number) => ({
    forfaitMainOeuvre, tarifForfait: 'HORS_CONTRAT', designation: `Main d’œuvre ${forfaitMainOeuvre === 'JOUR' ? 'au jour' : 'à la demi-journée'}`,
    quantite, catalogueFamille: 'prestations', catalogueId: mainOeuvre.id,
  });
  // Deux jours et une demi-journée : 2 × 7,5 h + 3,75 h = 18,75 h prévues, copiées en heures vendues à la conversion.
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Affichage heures E2E ${suffixe}`, lignes: [ligne('JOUR', 2), ligne('DEMI_JOURNEE', 1)] }) as { id: string };
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as Chantier;
  expect(chantier.heuresVendues).toBe(18.75);
  // Titulaire et commercial actifs : le formulaire « Modifier » les exige.
  const compte = async (cle: string, nom: string, role: string) => envoyer('post', '/users', { email: `aff-heures.${cle}.${suffixe}@iris.test`, name: `${nom} ${suffixe}`, role }) as Promise<{ id: string }>;
  const conducteur = await compte('conducteur', 'Conducteur affichage heures', 'CONDUCTEUR_TRAVAUX');
  const commercial = await compte('commercial', 'Commercial affichage heures', 'COMMERCIAL');
  await envoyer('patch', `/chantiers/${chantier.id}`, { responsableId: conducteur.id });
  await envoyer('patch', `/chantiers/${chantier.id}/commercial`, { commercialId: commercial.id });
  // Trois quarts d'heure pointés : les heures réalisées s'affichent elles aussi au centième (« 0,75 h »).
  const nomIntervenant = `Intervenant affichage heures ${suffixe}`;
  const intervenant = await envoyer('post', '/intervenants', { nom: nomIntervenant, role: 'Technicien', tauxHoraireCharge: 40 }) as { id: string };
  await envoyer('post', '/heures', { chantierId: chantier.id, intervenantId: intervenant.id, date: dateDuJour(), nbrHeures: 0.75 });
  return { chantier, nomIntervenant };
}

// Carte « Heures Prévues » et carte « Consommation Heures » (heures réalisées, puis « / » heures vendues) de la fiche.
const heuresPrevues = (page: Page) => page.getByText('Heures Prévues', { exact: true }).locator('xpath=following-sibling::div[1]');
const consommationHeures = (page: Page) => page.getByRole('heading', { name: 'Consommation Heures' }).locator('xpath=following-sibling::div[1]/span');
// Carte « Heures par intervenant » : la valeur écrite à côté du nom de l'intervenant.
const heuresIntervenant = (page: Page, nom: string) => page.getByRole('heading', { name: 'Heures par intervenant' }).locator('xpath=..')
  .getByText(nom, { exact: true }).locator('xpath=following-sibling::span[1]');

test('chantier de 18,75 heures vendues ouvert d’un devis au jour et à la demi-journée : « 18,75 h » sur la fiche et dans la liste, et « Modifier » enregistre 18,75, 20 et 18,5 sans refus du navigateur', async ({ page, request, session, creerClient, allerSurPageAdmin }) => {
  test.slow();
  const { chantier, nomIntervenant } = await preparer(request, session.token, creerClient);
  const relire = async () => ((await (await request.get(`${api}/chantiers/${chantier.id}`, { headers: { Authorization: `Bearer ${session.token}` } })).json()) as Chantier).heuresVendues;
  // Aucune alerte : un refus du serveur s'afficherait par une fenêtre.
  const fenetres: string[] = [];
  page.on('dialog', (dialogue) => { fenetres.push(`${dialogue.type()} : ${dialogue.message()}`); void dialogue.dismiss(); });

  // Fiche : « 18,75 h », et non « 18.75 h » (nombre brut) ni « 18,8 h » (une décimale) ; réalisées « 0,75 h », et non
  // « 0.75 h » (toFixed) ni « 0,8 h ».
  await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  await expect(page.getByRole('heading', { name: chantier.nom })).toBeVisible();
  await expect(heuresPrevues(page)).toHaveText('18,75 h');
  await expect(consommationHeures(page)).toHaveText(['0,75 h', '/ 18,75 h']);
  // Carte « Heures par intervenant » (C1 du contrôle de cohérence de #384) : les mêmes heures pointées, « 0,75 h », et non
  // « 0.8 h » (toFixed(1)), qui contredisait « 0,75 h » de la carte voisine.
  await expect(heuresIntervenant(page, nomIntervenant)).toHaveText('0,75 h');

  // Liste des chantiers : « 0,75 h / 18,75 h », et non « 0,8 h / 18,8 h », valeur qui n'était plus celle du devis.
  await page.goto('/chantiers', { waitUntil: 'networkidle' });
  const ligne = page.locator(`tr[data-chantier="${chantier.id}"]`);
  await expect(ligne.locator('td').nth(1).locator('div').first()).toHaveText('0,75 h / 18,75 h');

  // « Modifier » : le champ « Total Heures Vendues (h) », au pas de 0,01, admet chaque valeur au centième. Au pas de
  // 0,5, compté depuis la valeur d'origine du champ, le navigateur refusait 20 depuis 18,75, puis 18,75 depuis 18,5.
  await page.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
  const champ = page.locator('input[name="heuresVendues"]');
  const valide = () => champ.evaluate((element) => (element as HTMLInputElement).validity.valid);
  const ouvrir = async (valeurActuelle: string) => {
    await page.getByRole('button', { name: 'Modifier', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Modifier le chantier' })).toBeVisible();
    await expect(champ).toHaveValue(valeurActuelle);
  };
  const enregistrer = async (saisie: string, attendu: number, affiche: string) => {
    await champ.fill(saisie);
    expect(await valide(), `le navigateur admet ${affiche}`).toBe(true);
    const enregistrement = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname.endsWith(`/api/chantiers/${chantier.id}`));
    await page.getByRole('button', { name: 'Enregistrer les modifications' }).click();
    expect((await enregistrement).status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Modifier le chantier' })).toHaveCount(0);
    expect(await relire()).toBe(attendu);
    await expect(heuresPrevues(page)).toHaveText(affiche);
    await expect(consommationHeures(page)).toHaveText(['0,75 h', `/ ${affiche}`]);
  };

  // 18,75 enregistré tel quel.
  await ouvrir('18.75');
  await enregistrer('18.75', 18.75, '18,75 h');
  // Puis 20. Au passage, le pas est bien le centième : 18,33 est admis, 18,755 (trois décimales, au-delà des deux
  // de la colonne) est refusé par le navigateur.
  await ouvrir('18.75');
  await champ.fill('18.33');
  expect(await valide(), 'le navigateur admet 18,33 h').toBe(true);
  await champ.fill('18.755');
  expect(await champ.evaluate((element) => (element as HTMLInputElement).validity.stepMismatch), 'le navigateur refuse 18,755 h').toBe(true);
  await enregistrer('20', 20, '20 h');
  // Puis 18,5, et de nouveau 18,75 (refusé depuis 18,5 au pas de 0,5).
  await ouvrir('20');
  await enregistrer('18.5', 18.5, '18,5 h');
  await ouvrir('18.5');
  await enregistrer('18.75', 18.75, '18,75 h');
  expect(fenetres).toEqual([]);
});

// Correctif #387 (cadrage, version 2 du 31-10-2026, section « Tests (B5) », E2E) : le serveur refuse désormais une
// saisie négative, non numérique, à trois décimales ou au-delà de la colonne des heures vendues et des budgets du
// chantier (400, sans rien écrire), au lieu de l'enregistrer telle quelle, à 0 ou arrondie. À l'écran, `min="0"`
// s'ajoute aux quatre champs de « Modifier », sans `max` (choix par défaut, à confirmer) ; le refus du serveur
// s'affiche par la fenêtre d'alerte, « Modifier » restant ouvert avec la saisie (comportement existant).
test('« Modifier » : « -5 » refusé par le navigateur dans les heures vendues et chacun des trois budgets, sans rien envoyer ; « 0 » admis ; 100 000 000 heures, que le navigateur admet, refusées par le serveur avec son message, sans fermer « Modifier » ni rien enregistrer', async ({ page, request, session, creerClient, allerSurPageAdmin }) => {
  test.slow();
  const { chantier } = await preparer(request, session.token, creerClient);
  const CHAMPS = [
    ['Budget Global (€ HT)', 'budgetGlobalVendu'],
    ['Total Heures Vendues (h)', 'heuresVendues'],
    ['Dont Matériel (€ HT)', 'budgetMaterielVendu'],
    ['Dont Main d\'Œuvre (€ HT)', 'budgetMainOeuvreVendu'],
  ] as const;
  const relire = async () => {
    const fiche = await (await request.get(`${api}/chantiers/${chantier.id}`, { headers: { Authorization: `Bearer ${session.token}` } })).json() as Record<string, unknown>;
    return Object.fromEntries(CHAMPS.map(([, nom]) => [nom, fiche[nom]]));
  };
  const avant = await relire();
  // Témoin : l'administration lit les quatre valeurs, dont les 18,75 heures vendues de la préparation.
  expect(avant.heuresVendues).toBe(18.75);
  for (const [, nom] of CHAMPS) expect(typeof avant[nom], nom).toBe('number');
  const fenetres: string[] = [];
  page.on('dialog', (dialogue) => { fenetres.push(dialogue.message()); void dialogue.accept(); });
  // Toute modification envoyée par la page (fiche ou commercial du chantier).
  const envois: string[] = [];
  page.on('request', (requete) => { if (requete.method() === 'PATCH' && new URL(requete.url()).pathname.startsWith('/api/chantiers/')) envois.push(new URL(requete.url()).pathname); });

  await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  await expect(page.getByRole('heading', { name: chantier.nom })).toBeVisible();
  await page.getByRole('button', { name: 'Modifier', exact: true }).first().click();
  const modifier = page.getByRole('heading', { name: 'Modifier le chantier' });
  await expect(modifier).toBeVisible();
  const enregistrer = page.getByRole('button', { name: 'Enregistrer les modifications' });
  // Le champ sous son étiquette, telle qu'affichée dans « Modifier ».
  const champ = (etiquette: string) => page.locator('.form-group', { has: page.getByText(etiquette, { exact: true }) }).locator('input');
  const validite = (saisie: ReturnType<typeof champ>) => saisie.evaluate((element) => {
    const { valid, rangeUnderflow } = (element as HTMLInputElement).validity;
    return { valid, rangeUnderflow };
  });

  // « -5 » dans chaque champ, les trois autres gardant leur valeur : le navigateur le refuse (`min="0"`), et
  // « Enregistrer les modifications » n'envoie rien ; la relecture par l'API rend les valeurs d'avant.
  for (const [etiquette, nom] of CHAMPS) {
    const saisie = champ(etiquette);
    await expect(saisie).toHaveCount(1);
    await expect(saisie).toHaveAttribute('name', nom);
    const origine = await saisie.inputValue();
    await saisie.fill('-5');
    expect(await validite(saisie), `${etiquette} : « -5 »`).toEqual({ valid: false, rangeUnderflow: true });
    await enregistrer.click();
    await expect(modifier).toBeVisible();
    await expect(saisie).toHaveValue('-5');
    expect(envois, `${etiquette} : aucune modification envoyée`).toEqual([]);
    expect(await relire(), etiquette).toEqual(avant);
    await saisie.fill(origine);
  }

  // « 0 » est admis par le navigateur dans chacun des quatre champs.
  for (const [etiquette] of CHAMPS) {
    const saisie = champ(etiquette);
    const origine = await saisie.inputValue();
    await saisie.fill('0');
    expect(await validite(saisie), `${etiquette} : « 0 »`).toEqual({ valid: true, rangeUnderflow: false });
    await saisie.fill(origine);
  }
  expect(fenetres).toEqual([]);

  // 100 000 000 heures : sans `max`, le navigateur les admet ; le serveur les refuse (au-delà des 8 chiffres de la
  // colonne), son message s'affiche, et « Modifier » reste ouvert avec la saisie. Rien n'est enregistré.
  const heures = champ('Total Heures Vendues (h)');
  await heures.fill('100000000');
  expect(await validite(heures)).toEqual({ valid: true, rangeUnderflow: false });
  const reponse = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/chantiers/${chantier.id}`);
  await enregistrer.click();
  expect((await reponse).status()).toBe(400);
  await expect.poll(() => fenetres).toEqual(['Les heures vendues doivent être un nombre positif ou nul, d’au plus 8 chiffres avant la virgule et 2 après.']);
  await expect(modifier).toBeVisible();
  await expect(heures).toHaveValue('100000000');
  // Une seule modification envoyée de tout le parcours, celle-ci : les essais à « -5 » n'en ont envoyé aucune.
  expect(envois).toEqual([`/api/chantiers/${chantier.id}`]);
  expect(await relire()).toEqual(avant);
});
