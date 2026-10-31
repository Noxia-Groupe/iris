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
  const intervenant = await envoyer('post', '/intervenants', { nom: `Intervenant affichage heures ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 40 }) as { id: string };
  await envoyer('post', '/heures', { chantierId: chantier.id, intervenantId: intervenant.id, date: dateDuJour(), nbrHeures: 0.75 });
  return chantier;
}

// Carte « Heures Prévues » et carte « Consommation Heures » (heures réalisées, puis « / » heures vendues) de la fiche.
const heuresPrevues = (page: Page) => page.getByText('Heures Prévues', { exact: true }).locator('xpath=following-sibling::div[1]');
const consommationHeures = (page: Page) => page.getByRole('heading', { name: 'Consommation Heures' }).locator('xpath=following-sibling::div[1]/span');

test('chantier de 18,75 heures vendues ouvert d’un devis au jour et à la demi-journée : « 18,75 h » sur la fiche et dans la liste, et « Modifier » enregistre 18,75, 20 et 18,5 sans refus du navigateur', async ({ page, request, session, creerClient, allerSurPageAdmin }) => {
  test.slow();
  const chantier = await preparer(request, session.token, creerClient);
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
