import type { APIRequestContext } from '@playwright/test';
import { test, expect, choisirClient } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Lot « devis au temps passé » (décisions de Nelson des 24 et 25-10-2026) : le pas du temps passé est un
// réglage de la société, vide au démarrage, réglé dans Administration > Marges & Commissions ; tant qu'il
// est vide, un devis au temps passé est refusé. Un devis au temps passé porte une ligne de main d'œuvre
// au prix de l'heure choisi (hors contrat ou sous contrat), comptée dans le total ; converti en
// intervention, il la marque « au temps passé ».
// Lot « facture au temps passé », première PR (décisions de la nuit du 26 au 27-10-2026, points 8, 9, 11
// et 12) : le temps minimum facturé est un réglage de la société (une heure à l'installation, vidé il
// revient à une heure), le pas vaut 15, 30, 45 ou 60 minutes ; chaque devis au temps passé les fige, et
// sa ligne vaut ce minimum, puis des multiples du pas. La mention les annonce.

const REFUS_PAS = 'Réglez d’abord le pas du temps passé dans l’administration (Administration > Marges & Commissions) : un devis au temps passé est refusé tant qu’il n’est pas fixé.';

async function envoyer(request: APIRequestContext, token: string, methode: 'post' | 'put' | 'delete', chemin: string, data?: object) {
  const response = await request[methode](`${api}${chemin}`, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(response.ok(), `${chemin} : ${await response.text()}`).toBeTruthy();
  return response.json();
}
const lirePas = async (request: APIRequestContext, token: string) => (await (await request.get(`${api}/parametres`, { headers: { Authorization: `Bearer ${token}` } })).json()).pasTempsPasseMinutes as number | null;
const reglerPas = (request: APIRequestContext, token: string, pas: number | null) => envoyer(request, token, 'put', '/parametres', { pasTempsPasseMinutes: pas === null ? '' : pas });
const lireMinimum = async (request: APIRequestContext, token: string) => (await (await request.get(`${api}/parametres`, { headers: { Authorization: `Bearer ${token}` } })).json()).tempsMinimumMinutes as number;
const reglerMinimum = (request: APIRequestContext, token: string, minimum: number) => envoyer(request, token, 'put', '/parametres', { tempsMinimumMinutes: minimum });
const regle = (prix: string, tarif: string, minimum: string, pas: number) => `Devis au temps passé : au prix de ${prix} HT de l’heure (tarif à l’heure ${tarif}), hors matériel, le temps passé se facture avec un minimum de ${minimum}, puis par tranches de ${pas} minutes au-delà, toute tranche commencée étant due.`;
const devisDuClient = async (request: APIRequestContext, token: string, clientId: string) => ((await (await request.get(`${api}/devis`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { client: { id: string } }[]).filter((d) => d.client.id === clientId);
const creerMainOeuvre = (request: APIRequestContext, token: string, suffixe: string, tauxTva = '20') => envoyer(request, token, 'post', '/catalogue/prestations', {
  estMainOeuvre: true, reference: `E2E-TP-${suffixe}`, nom: `Électricien temps passé E2E ${suffixe}`, tauxTva,
  prixVenteHt: '45.50', prixJourHorsContratHt: '320', prixHeureSousContratHt: '40', prixJourSousContratHt: '280', heuresParJour: '7',
}) as Promise<{ id: string; reference: string; nom: string }>;

test('le temps minimum facturé et le pas du temps passé se règlent dans l’administration ; sans pas, un devis au temps passé est refusé à l’écran', async ({ allerSurPageAdmin, request, session, creerClient, page }) => {
  const suffixe = `${Date.now()}`;
  const pasAvant = await lirePas(request, session.token);
  const minimumAvant = await lireMinimum(request, session.token);
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

    // Administration > Marges & Commissions : le pas est vide, le minimum d'une heure ; un minimum hors
    // bornes est refusé, puis les deux se règlent.
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Marges & Commissions' }).click();
    const section = page.getByRole('region', { name: 'Devis au temps passé' });
    const champPas = section.getByRole('combobox', { name: 'Pas du temps passé (minutes)' });
    const champMinimum = section.getByRole('spinbutton', { name: 'Temps minimum facturé (minutes)' });
    const enregistrer = section.getByRole('button', { name: 'Enregistrer les réglages' });
    await expect(champPas).toHaveValue('');
    await expect(champMinimum).toHaveValue('60');
    // Le pas ne propose que 15, 30, 45 ou 60 minutes, ou vide.
    await expect(champPas.locator('option')).toHaveText(['Vide : à régler', '15', '30', '45', '60']);
    await expect(section).toContainText('Pas non réglé : les devis au temps passé sont refusés.');
    await champPas.selectOption('15');
    await champMinimum.fill('50');
    await enregistrer.click();
    await expect(section.getByRole('alert')).toHaveText('Le temps minimum facturé est un nombre de minutes multiple de 15, de 15 minutes à 8 heures (480 minutes), ou vide pour revenir à une heure.');
    expect(await lirePas(request, session.token)).toBeNull();
    expect(await lireMinimum(request, session.token)).toBe(60);
    await champMinimum.fill('60');
    await enregistrer.click();
    await expect(section.getByRole('status')).toHaveText('Réglages du temps passé enregistrés : minimum de 1 h, puis tranches de 15 minutes.');
    await expect(section).not.toContainText('Pas non réglé');
    expect(await lirePas(request, session.token)).toBe(15);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Marges & Commissions' }).click();
    await expect(champPas).toHaveValue('15');
    await expect(champMinimum).toHaveValue('60');
    // Le changement est journalisé, avant et après : le seul pas, le minimum n'ayant pas changé.
    const journal = async () => (await (await request.get(`${api}/journal-administration?type=PARAMETRES`, { headers: { Authorization: `Bearer ${session.token}` } })).json() as { entrees: { avant: Record<string, unknown> | null; apres: Record<string, unknown> | null }[] }).entrees;
    let entrees = await journal();
    expect(entrees[0]?.avant).toEqual({ pasTempsPasseMinutes: null });
    expect(entrees[0]?.apres).toEqual({ pasTempsPasseMinutes: 15 });
    // Minimum d'une heure et demie, pas de 45 minutes ; journalisés tous deux, et lisibles dans le journal.
    await champMinimum.fill('90');
    await champPas.selectOption('45');
    await enregistrer.click();
    await expect(section.getByRole('status')).toHaveText('Réglages du temps passé enregistrés : minimum de 1 h 30 min, puis tranches de 45 minutes.');
    expect([await lirePas(request, session.token), await lireMinimum(request, session.token)]).toEqual([45, 90]);
    entrees = await journal();
    expect(entrees[0]?.avant).toEqual({ pasTempsPasseMinutes: 15, tempsMinimumMinutes: 60 });
    expect(entrees[0]?.apres).toEqual({ pasTempsPasseMinutes: 45, tempsMinimumMinutes: 90 });
    await page.getByRole('button', { name: 'Journal', exact: true }).click();
    const entree = page.getByRole('table', { name: 'Entrées du journal' }).locator('tr', { hasText: 'Temps minimum facturé (minutes)' }).first();
    await expect(entree).toContainText('Temps minimum facturé (minutes) : 60');
    await expect(entree).toContainText('Temps minimum facturé (minutes) : 90');
    await expect(entree).toContainText('Pas du temps passé (minutes) : 15');
    await expect(entree).toContainText('Pas du temps passé (minutes) : 45');
    await page.getByRole('button', { name: 'Marges & Commissions' }).click();
    // Vidés depuis l'écran : le minimum revient à une heure, le pas est retiré.
    await champMinimum.fill('');
    await champPas.selectOption('');
    await enregistrer.click();
    await expect(section.getByRole('status')).toHaveText('Temps minimum facturé : 1 h. Pas du temps passé retiré : les devis au temps passé sont refusés jusqu’à son réglage.');
    await expect(section).toContainText('Pas non réglé : les devis au temps passé sont refusés.');
    await expect(champMinimum).toHaveValue('60');
    expect([await lirePas(request, session.token), await lireMinimum(request, session.token)]).toEqual([null, 60]);
    // Un pas réglé avant le lot (ici 10 minutes, lu tel quel du serveur) reste affiché, signalé comme
    // n'étant plus admis ; l'enregistrer de nouveau est refusé par le serveur, qui ne l'écrit pas.
    await page.route('**/api/parametres', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const reponse = await route.fetch();
      await route.fulfill({ response: reponse, json: { ...(await reponse.json()), pasTempsPasseMinutes: 10 } });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Marges & Commissions' }).click();
    await expect(champPas).toHaveValue('10');
    await expect(champPas.locator('option')).toHaveText(['Vide : à régler', '10 (n’est plus admis)', '15', '30', '45', '60']);
    await expect(section).toContainText('Le pas réglé (10 minutes) n’est plus admis : les nouveaux devis au temps passé sont refusés tant qu’il n’est pas réglé à 15, 30, 45 ou 60 minutes.');
    await enregistrer.click();
    await expect(section.getByRole('alert')).toHaveText('Le pas du temps passé est de 15, 30, 45 ou 60 minutes, ou vide pour le retirer (les devis au temps passé sont alors refusés).');
    expect(await lirePas(request, session.token)).toBeNull();
    await page.unroute('**/api/parametres');
  } finally {
    await reglerPas(request, session.token, pasAvant);
    await reglerMinimum(request, session.token, minimumAvant);
  }
});

test('un devis au temps passé se compose à l’écran : main d’œuvre et tarif, ligne au minimum puis au pas, refus hors du pas, total et mention ; converti, l’intervention est marquée', async ({ allerSurPageAdmin, request, session, creerClient, page }) => {
  test.slow();
  const suffixe = `${Date.now()}`;
  const pasAvant = await lirePas(request, session.token);
  const minimumAvant = await lireMinimum(request, session.token);
  try {
    await reglerPas(request, session.token, 30);
    await reglerMinimum(request, session.token, 60);
    const mainOeuvre = await creerMainOeuvre(request, session.token, suffixe);
    const cable = await envoyer(request, session.token, 'post', '/catalogue/articles', { reference: `E2E-TP-CAB-${suffixe}`, nom: `Câble temps passé E2E ${suffixe}`, unite: 'm', prixVenteHt: '2.50', tauxTva: '20' }) as { nom: string };
    const client = await creerClient('Temps passé');
    const objet = `Dépannage au temps passé E2E ${suffixe}`;
    await allerSurPageAdmin('/devis');
    await choisirClient(page, client);
    await page.getByRole('textbox', { name: 'Objet' }).fill(objet);
    // Seules les mains d'œuvre sont proposées, pas une prestation ordinaire : l'écran demande au serveur les
    // seules mains d'œuvre actives, toutes (`mainOeuvre=1`, que vérifie le test API de la recherche), et non
    // les prestations, ordinaires comprises. Rien n'est ajouté au catalogue : une prestation ordinaire
    // laissée en base serait listée par /catalogue, que contrôle entetes-mobile sur une base neuve (#327).
    const demandeMainsOeuvre = page.waitForRequest((requete) => {
      const url = new URL(requete.url());
      return requete.method() === 'GET' && url.pathname.endsWith('/devis/catalogue') && !url.searchParams.has('q');
    });
    await page.getByRole('checkbox', { name: 'Devis au temps passé' }).check();
    expect(new URL((await demandeMainsOeuvre).url()).searchParams.toString()).toBe('mainOeuvre=1');
    // L'aide de la case n'annonce plus une heure au moins : la ligne suit le minimum et le pas du devis.
    const aideCase = page.getByRole('group', { name: 'Devis au temps passé' });
    await expect(aideCase).toContainText('Le temps minimum facturé et le pas du temps passé, réglés par la société, sont figés sur le devis.');
    await expect(aideCase).not.toContainText('d’une heure au moins');
    const tarif = page.getByRole('combobox', { name: 'Tarif de l’heure' });
    await expect(tarif).toBeDisabled();
    await page.getByRole('combobox', { name: 'Main d’œuvre au temps passé' }).selectOption(mainOeuvre.id);
    // Les deux prix à l'heure sont proposés, jamais le forfait jour.
    await expect(tarif.locator('option')).toHaveText(['À l’heure hors contrat — 45,50 € HT', 'À l’heure sous contrat — 40,00 € HT']);
    const ligne = page.getByRole('group', { name: 'Ligne au temps passé' });
    // Nouveau devis : les réglages de la société ne sont lus que par l'administration ; l'écran le dit, et
    // le serveur applique le minimum et le pas du jour.
    const heures = ligne.getByRole('spinbutton', { name: 'Heures', exact: true });
    await expect(heures).toHaveValue('1');
    await expect(ligne).toContainText('Le temps minimum facturé, puis des tranches du pas, tous deux réglés par la société et figés sur le devis');
    await expect(ligne.getByTestId('prix-heure-temps-passe')).toHaveText('45,50 € HT');
    await tarif.selectOption('SOUS_CONTRAT');
    await expect(ligne.getByTestId('prix-heure-temps-passe')).toHaveText('40,00 € HT');
    await expect(ligne).toContainText('À l’heure sous contrat');
    await expect(heures).toHaveValue('1');
    // Décocher retire la ligne au temps passé ; recocher la propose de nouveau, à choisir.
    await page.getByRole('checkbox', { name: 'Devis au temps passé' }).uncheck();
    await expect(ligne).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Main d’œuvre au temps passé' })).toHaveCount(0);
    // Le devis garde une ligne, vierge, aux valeurs d'une nouvelle ligne : une heure, 0 € HT, TVA à 20 %.
    await expect(page.getByRole('spinbutton', { name: 'Qté' })).toHaveValue('1');
    await expect(page.getByRole('spinbutton', { name: 'PU HT' })).toHaveValue('0');
    await expect(page.getByRole('spinbutton', { name: 'TVA %' })).toHaveValue('20');
    await page.getByRole('checkbox', { name: 'Devis au temps passé' }).check();
    await expect(ligne).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Main d’œuvre au temps passé' }).selectOption(mainOeuvre.id);
    await tarif.selectOption('SOUS_CONTRAT');
    await expect(ligne.getByTestId('prix-heure-temps-passe')).toHaveText('40,00 € HT');
    // Le matériel s'ajoute en lignes à part.
    await page.getByRole('searchbox', { name: 'Rechercher dans le catalogue' }).fill(`E2E-TP-CAB-${suffixe}`);
    await page.getByRole('button', { name: `Ajouter ${cable.nom}` }).click();
    await page.getByRole('spinbutton', { name: 'Qté' }).fill('12');
    // Le navigateur refuse lui-même, sans rien envoyer, une quantité nulle ou hors des quarts d'heure (le
    // champ d'un nouveau devis va par quarts d'heure, à partir d'un quart d'heure).
    const envois: string[] = [];
    const surRequete = (requete: { method: () => string; url: () => string }) => { if (['POST', 'PATCH'].includes(requete.method()) && /\/api\/devis(\/[0-9a-f-]+)?$/.test(requete.url())) envois.push(requete.url()); };
    page.on('request', surRequete);
    const validite = (champ: typeof heures) => champ.evaluate((element) => { const { rangeUnderflow, stepMismatch } = (element as HTMLInputElement).validity; return { rangeUnderflow, stepMismatch }; });
    await heures.fill('0');
    await page.getByRole('button', { name: 'Créer le brouillon' }).click();
    expect(await validite(heures)).toEqual({ rangeUnderflow: true, stepMismatch: false });
    await heures.fill('1.1');
    await page.getByRole('button', { name: 'Créer le brouillon' }).click();
    expect(await validite(heures)).toEqual({ rangeUnderflow: false, stepMismatch: true });
    expect(envois, 'aucune création envoyée').toHaveLength(0);
    // Hors du minimum puis du pas réglés (une heure, puis 30 minutes) : refusée par le serveur, qui n'écrit rien.
    await heures.fill('1.25');
    await page.getByRole('button', { name: 'Créer le brouillon' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'tranches' })).toHaveText('La ligne au temps passé vaut le temps minimum facturé du devis (1 h), puis des tranches de 30 minutes : en heures, 1 ; 1,5 ; 2…');
    expect(envois, 'une création envoyée, refusée').toHaveLength(1);
    expect(await devisDuClient(request, session.token, client.id)).toHaveLength(0);
    await heures.fill('2');
    await page.getByRole('button', { name: 'Créer le brouillon' }).click();
    const item = page.getByRole('listitem').filter({ hasText: objet });
    await expect(item).toContainText('Au temps passé');
    await expect(item).toContainText('HT 110.00 € · TVA 22.00 € · TTC 132.00 €');
    await expect(item.getByTestId('mention-temps-passe')).toHaveText(`${regle('40,00 €', 'sous contrat', '1 h', 30)} Ce devis prévoit 2 h : son total est une estimation, la facture reprenant le temps réellement passé, avec au moins le minimum.`);
    const [enregistre] = await devisDuClient(request, session.token, client.id) as unknown as { id: string; auTempsPasse: boolean; pasTempsPasseMinutes: number; tempsMinimumMinutes: number; lignes: { tempsPasse: boolean; tarifTempsPasse: string; prixUnitaireHt: number; quantite: number }[] }[];
    expect([enregistre.auTempsPasse, enregistre.pasTempsPasseMinutes, enregistre.tempsMinimumMinutes]).toEqual([true, 30, 60]);
    expect(enregistre.lignes.filter((l) => l.tempsPasse).map((l) => [l.tarifTempsPasse, l.prixUnitaireHt, l.quantite])).toEqual([['SOUS_CONTRAT', 40, 2]]);

    // Modifier le brouillon : la ligne garde son prix figé, même si la main d'œuvre change de prix ; le
    // devis garde son minimum et son pas, même si la société les change (ici deux heures, puis une heure).
    await envoyer(request, session.token, 'put', `/catalogue/prestations/${mainOeuvre.id}`, {
      estMainOeuvre: true, reference: mainOeuvre.reference, nom: mainOeuvre.nom, tauxTva: '20',
      prixVenteHt: '50', prixJourHorsContratHt: '320', prixHeureSousContratHt: '44', prixJourSousContratHt: '280', heuresParJour: '7',
    });
    await reglerPas(request, session.token, 60);
    await reglerMinimum(request, session.token, 120);
    await item.getByRole('button', { name: 'Modifier' }).click();
    await expect(page.getByRole('checkbox', { name: 'Devis au temps passé' })).toBeChecked();
    await expect(ligne.getByTestId('prix-heure-temps-passe')).toHaveText('40,00 € HT');
    // Les réglages du devis modifié sont connus de l'écran : le champ part du minimum figé et avance au pas
    // figé, et le navigateur refuse lui-même une quantité qui ne les suit pas.
    const heuresFigees = ligne.getByRole('spinbutton', { name: 'Heures (1 h minimum)' });
    await expect(heuresFigees).toHaveValue('2');
    await expect(ligne).toContainText('Le temps minimum facturé du devis (1 h), puis des tranches de 30 minutes.');
    await expect(heuresFigees).toHaveAttribute('min', '1');
    await expect(heuresFigees).toHaveAttribute('step', '0.5');
    await heuresFigees.fill('2.25');
    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    expect(await validite(heuresFigees)).toEqual({ rangeUnderflow: false, stepMismatch: true });
    await heuresFigees.fill('0.5');
    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    expect(await validite(heuresFigees)).toEqual({ rangeUnderflow: true, stepMismatch: false });
    expect(envois, 'aucune modification envoyée : les deux créations seules').toHaveLength(2);
    page.off('request', surRequete);
    // 2 h 30 : au pas du devis (une heure, puis 30 minutes), non à celui du jour (deux heures, puis une heure).
    await heuresFigees.fill('2.5');
    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    await expect(item).toContainText('HT 130.00 € · TVA 26.00 € · TTC 156.00 €');
    await expect(item.getByTestId('mention-temps-passe')).toHaveText(`${regle('40,00 €', 'sous contrat', '1 h', 30)} Ce devis prévoit 2 h 30 min : son total est une estimation, la facture reprenant le temps réellement passé, avec au moins le minimum.`);

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
    await reglerMinimum(request, session.token, minimumAvant);
  }
});

test('rendu à 375 px : formulaire du devis au temps passé, mention, réglages et intervention marquée, sans débordement', async ({ allerSurPageAdmin, request, session, creerClient, page }) => {
  const suffixe = `${Date.now()}`;
  const pasAvant = await lirePas(request, session.token);
  const minimumAvant = await lireMinimum(request, session.token);
  try {
    await reglerPas(request, session.token, 30);
    await reglerMinimum(request, session.token, 60);
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
    // Nouveau devis : les flèches avancent d'un quart d'heure, le serveur appliquant le minimum et le pas du
    // jour (une heure, puis 30 minutes : 1,5 heure est admise).
    const heures = ligne.getByRole('spinbutton', { name: 'Heures', exact: true });
    await heures.press('ArrowUp');
    await expect(heures).toHaveValue('1.25');
    await heures.press('ArrowUp');
    await expect(heures).toHaveValue('1.5');
    for (const element of [page.getByRole('combobox', { name: 'Tarif de l’heure' }), heures, ligne.getByTestId('prix-heure-temps-passe')]) {
      await element.scrollIntoViewIfNeeded();
      const boite = await element.boundingBox();
      expect(boite, 'élément affiché').toBeTruthy();
      expect(boite!.x).toBeGreaterThanOrEqual(0);
      expect(boite!.x + boite!.width).toBeLessThanOrEqual(375);
    }
    expect(await debordement(), 'formulaire élargi').toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Créer le brouillon' }).click();
    const item = page.getByRole('listitem').filter({ hasText: objet });
    await expect(item.getByTestId('mention-temps-passe')).toContainText('un minimum de 1 h, puis par tranches de 30 minutes au-delà');
    await expect(item.getByTestId('mention-temps-passe')).toContainText('Ce devis prévoit 1 h 30 min');
    await item.getByTestId('mention-temps-passe').scrollIntoViewIfNeeded();
    const mention = await item.getByTestId('mention-temps-passe').boundingBox();
    expect(mention!.x + mention!.width).toBeLessThanOrEqual(375);
    expect(await debordement(), 'liste élargie').toBeLessThanOrEqual(0);

    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Marges & Commissions' }).click();
    const reglages = page.getByRole('region', { name: 'Devis au temps passé' });
    await expect(reglages.getByRole('combobox', { name: 'Pas du temps passé (minutes)' })).toHaveValue('30');
    await expect(reglages.getByRole('spinbutton', { name: 'Temps minimum facturé (minutes)' })).toHaveValue('60');
    for (const champ of [reglages.getByRole('spinbutton', { name: 'Temps minimum facturé (minutes)' }), reglages.getByRole('combobox', { name: 'Pas du temps passé (minutes)' }), reglages.getByRole('button', { name: 'Enregistrer les réglages' })]) {
      await champ.scrollIntoViewIfNeeded();
      const boiteChamp = await champ.boundingBox();
      expect(boiteChamp!.x).toBeGreaterThanOrEqual(0);
      expect(boiteChamp!.x + boiteChamp!.width).toBeLessThanOrEqual(375);
    }
    expect(await debordement(), 'réglages élargis').toBeLessThanOrEqual(0);

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
    await reglerMinimum(request, session.token, minimumAvant);
  }
});

// Audit interne n° 1 de #348 (T3) : l'écran d'un nouveau devis ne connaît pas les réglages ; son champ ne doit
// refuser aucune quantité que le serveur admet, par exemple un minimum réglé à 30 minutes.
test('nouveau devis : le champ des heures admet un temps minimum réglé sous une heure (30 minutes), que le serveur accepte', async ({ allerSurPageAdmin, request, session, creerClient, page }) => {
  const suffixe = `${Date.now()}`;
  const pasAvant = await lirePas(request, session.token);
  const minimumAvant = await lireMinimum(request, session.token);
  try {
    await reglerPas(request, session.token, 15);
    await reglerMinimum(request, session.token, 30);
    const mainOeuvre = await creerMainOeuvre(request, session.token, suffixe);
    const client = await creerClient('Temps passé demi-heure');
    const objet = `Demi-heure au temps passé E2E ${suffixe}`;
    await allerSurPageAdmin('/devis');
    await choisirClient(page, client);
    await page.getByRole('textbox', { name: 'Objet' }).fill(objet);
    await page.getByRole('checkbox', { name: 'Devis au temps passé' }).check();
    await page.getByRole('combobox', { name: 'Main d’œuvre au temps passé' }).selectOption(mainOeuvre.id);
    const heures = page.getByRole('group', { name: 'Ligne au temps passé' }).getByRole('spinbutton', { name: 'Heures', exact: true });
    await heures.fill('0.5');
    expect(await heures.evaluate((element) => (element as HTMLInputElement).validity.valid), 'le navigateur admet 0,5 h').toBe(true);
    await page.getByRole('button', { name: 'Créer le brouillon' }).click();
    const item = page.getByRole('listitem').filter({ hasText: objet });
    await expect(item).toContainText('HT 22.75 € · TVA 4.55 € · TTC 27.30 €');
    await expect(item.getByTestId('mention-temps-passe')).toHaveText(`${regle('45,50 €', 'hors contrat', '30 min', 15)} Le total de ce devis est un minimum.`);
  } finally {
    await reglerPas(request, session.token, pasAvant);
    await reglerMinimum(request, session.token, minimumAvant);
  }
});
