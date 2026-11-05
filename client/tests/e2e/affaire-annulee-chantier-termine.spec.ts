import { createHmac } from 'node:crypto';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { test, expect, dateDuJour, horsDuPassageDeMinuit } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Correctif #285 et chantier terminé (cadrage, version 3 du 02-11-2026, point 6 et critère « E2E dans un navigateur »,
// règle 2 de la méthode, montants). Décisions de Nelson du 02-11-2026 : « une affaire annulé ne peut etre encaissé »,
// puis « Corriger maintenant » (#285) ; « A. Non, admin seule » : une fois un chantier terminé, seule l'administration
// en modifie la fiche et en change le commercial (#440, commentaire 6570976812). Sur la fiche chantier :
//  - la pastille « Encaissé / Non encaissé » et le bandeau « Chantier terminé, en attente d'encaissement » ne paraissent
//    que sur un chantier terminé, et non plus sur une affaire annulée ;
//  - « Modifier » (fiche et commercial) ne paraît pas sur une affaire annulée, ni, hors administration, sur un chantier
//    terminé ;
//  - le statut d'une affaire annulée se lit « Annulé », et non par son code.
// Aucune date n'est lue ni comparée : ces parcours ne dépendent ni du jour, ni de l'heure, ni du fuseau.

type Chantier = { id: string; nom: string; statut: string; encaisse: boolean };
type Compte = { id: string; name: string; email: string; role: string };

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable ouvre une session dans un
// rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}
async function pageDe(browser: Browser, compte: Compte): Promise<Page> {
  const contexte = await browser.newContext();
  const page = await contexte.newPage();
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jetonPour(compte.id), JSON.stringify({ ...compte, permissions: [] })]);
  return page;
}

async function appel<T>(request: APIRequestContext, token: string, methode: 'get' | 'post' | 'put' | 'patch', chemin: string, data?: object, attendu = methode === 'post' ? 201 : 200): Promise<T> {
  const reponse = await request[methode](`${api}${chemin}`, { headers: auth(token), ...(data ? { data } : {}) });
  expect(reponse.status(), `${methode.toUpperCase()} ${chemin} : ${await reponse.text()}`).toBe(attendu);
  return reponse.json() as Promise<T>;
}
// Chantier ouvert par la conversion d'un devis signé (seule porte d'ouverture d'une affaire), au titulaire donné.
async function chantierConverti(request: APIRequestContext, token: string, clientId: string, nom: string, responsableId?: string) {
  const devis = await appel<{ id: string }>(request, token, 'post', '/devis', { clientId, objet: nom, lignes: [{ designation: 'Pose et mise en service', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] });
  await appel(request, token, 'put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await appel(request, token, 'post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await appel<Chantier>(request, token, 'post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER', ...(responsableId ? { responsableId } : {}) });
  return { devis, chantier };
}
const annuler = (request: APIRequestContext, token: string, devisId: string) => appel(request, token, 'post', `/devis/${devisId}/annulation`, { motif: 'Annulation E2E du correctif 285' }, 200);
const cloturer = (request: APIRequestContext, token: string, chantierId: string) => appel(request, token, 'patch', `/chantiers/${chantierId}/statut`, { statut: 'TERMINE' });

// En-tête de la fiche : le titre, le statut, et la pastille d'encaissement d'un chantier terminé.
const enTete = (page: Page, nom: string) => page.getByRole('heading', { name: nom, exact: true }).locator('..');
const boutonsModifier = (page: Page) => page.getByRole('button', { name: 'Modifier', exact: true });
// Texte du bandeau, tel que l'écran l'écrit (apostrophe droite).
const BANDEAU = 'Chantier terminé, en attente d\'encaissement';

test('l’administration ouvre une affaire annulée : statut « Annulé », ni « Valider l’encaissement », ni pastille d’encaissement, ni « Modifier »', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  test.slow();
  const token = session.token;
  const nom = `E2E Affaire annulée 285 ${Date.now()}`;
  const client = await creerClient('affaire annulée 285');
  const { devis, chantier } = await chantierConverti(request, token, client.id, nom);
  await annuler(request, token, devis.id);
  expect((await appel<Chantier>(request, token, 'get', `/chantiers/${chantier.id}`)).statut).toBe('ANNULE');

  const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  const entete = enTete(page, nom);
  await expect(entete).toBeVisible();
  await expect(entete.getByText('Annulé', { exact: true })).toBeVisible();
  await expect(entete).not.toContainText('ANNULE');
  // Ni pastille cliquable, ni pastille en lecture, ni bandeau, ni bouton de validation : rien n'invite à encaisser.
  await expect(entete).not.toContainText(/encaiss/i);
  await expect(page.getByRole('button', { name: /encaiss/i })).toHaveCount(0);
  await expect(page.getByText(BANDEAU)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Valider l\'encaissement' })).toHaveCount(0);
  // Ni la fiche, ni le commercial : aucun « Modifier ».
  await expect(boutonsModifier(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Modifier le chantier' })).toHaveCount(0);
});

test('sur un chantier terminé, l’administration encaisse toujours depuis la fiche, et garde « Modifier »', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  test.slow();
  const token = session.token;
  const nom = `E2E Chantier terminé 285 ${Date.now()}`;
  const client = await creerClient('chantier terminé 285');
  const { chantier } = await chantierConverti(request, token, client.id, nom);
  await cloturer(request, token, chantier.id);

  const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  const entete = enTete(page, nom);
  await expect(entete.getByText('Terminé', { exact: true })).toBeVisible();
  await expect(entete.getByRole('button', { name: 'Non encaissé', exact: true })).toBeVisible();
  await expect(page.getByText(BANDEAU)).toBeVisible();
  // L'administration modifie toujours la fiche et le commercial d'un chantier terminé.
  await expect(boutonsModifier(page)).toHaveCount(2);

  const encaissement = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/chantiers/${chantier.id}/encaisse`);
  await page.getByRole('button', { name: 'Valider l\'encaissement' }).click();
  expect((await encaissement).status()).toBe(200);
  await expect(entete.getByRole('button', { name: '✓ Encaissé', exact: true })).toBeVisible();
  await expect(page.getByText(BANDEAU)).toHaveCount(0);
  const relu = await appel<Chantier>(request, token, 'get', `/chantiers/${chantier.id}`);
  expect([relu.statut, relu.encaisse]).toEqual(['TERMINE', true]);
});

test('le conducteur titulaire d’une affaire annulée n’y trouve pas « Modifier »', async ({ creerClient, request, session, browser }) => {
  test.slow();
  const token = session.token;
  const suffixe = Date.now();
  const conducteur = await appel<Compte>(request, token, 'post', '/users', { email: `c285.annulee.${suffixe}@iris.test`, name: `Conducteur affaire annulée 285 ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' });
  const nom = `E2E Affaire annulée du titulaire 285 ${suffixe}`;
  const client = await creerClient('affaire annulée titulaire 285');
  const { devis, chantier } = await chantierConverti(request, token, client.id, nom, conducteur.id);
  const page = await pageDe(browser, conducteur);
  try {
    // Témoin : en cours, son titulaire a « Modifier » pour la fiche et pour le commercial.
    await page.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
    await expect(enTete(page, nom).getByText('En cours', { exact: true })).toBeVisible();
    await expect(boutonsModifier(page)).toHaveCount(2);

    await annuler(request, token, devis.id);
    await page.reload({ waitUntil: 'networkidle' });
    const entete = enTete(page, nom);
    await expect(entete.getByText('Annulé', { exact: true })).toBeVisible();
    await expect(boutonsModifier(page)).toHaveCount(0);
    await expect(entete).not.toContainText(/encaiss/i);
  } finally {
    await page.context().close();
  }
});

test('le conducteur titulaire d’un chantier terminé n’y trouve plus « Modifier » ; l’administration, si', async ({ allerSurPageAdmin, creerClient, request, session, browser }) => {
  test.slow();
  const token = session.token;
  const suffixe = Date.now();
  const conducteur = await appel<Compte>(request, token, 'post', '/users', { email: `c285.termine.${suffixe}@iris.test`, name: `Conducteur chantier terminé 285 ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' });
  const nom = `E2E Chantier terminé du titulaire 285 ${suffixe}`;
  const client = await creerClient('chantier terminé titulaire 285');
  const { chantier } = await chantierConverti(request, token, client.id, nom, conducteur.id);
  const page = await pageDe(browser, conducteur);
  try {
    // Témoin : en cours, son titulaire a « Modifier » pour la fiche et pour le commercial.
    await page.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
    await expect(boutonsModifier(page)).toHaveCount(2);

    await cloturer(request, token, chantier.id);
    await page.reload({ waitUntil: 'networkidle' });
    const entete = enTete(page, nom);
    await expect(entete.getByText('Terminé', { exact: true })).toBeVisible();
    await expect(boutonsModifier(page)).toHaveCount(0);
    // L'encaissement se lit sans se changer : pastille en lecture seule, ni bouton ni bandeau.
    await expect(entete.getByText('Non encaissé', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /encaiss/i })).toHaveCount(0);
    await expect(page.getByText(BANDEAU)).toHaveCount(0);
  } finally {
    await page.context().close();
  }
  // L'administration garde « Modifier » sur le même chantier terminé.
  const vueAdmin = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  await expect(enTete(vueAdmin, nom).getByText('Terminé', { exact: true })).toBeVisible();
  await expect(boutonsModifier(vueAdmin)).toHaveCount(2);
});

// ---------------------------------------------------------------------------------------------------------------------
// Correctif #483 : fiche d'une affaire annulée, montants masqués (cadrage, version 2, « Critères métier observables » 1 à 4
// et « Tests »). Décision de Nelson du 04-11-2026 : « 2. Masquer ces montants », soit l'option 1 de l'issue : « Masquer le
// reste à facturer, la marge et l'alerte de budget, en les remplaçant par « Affaire annulée » ». Libellés et places : choix
// par défaut, à confirmer (règle 5 de la méthode). Sur la fiche d'une affaire au statut ANNULE, et non `isTermine`, qui
// couvre aussi le chantier terminé (cadrage, point 5) :
//  - bloc de facturation [data-facturation] : « Affaire annulée » à la place de « Reste à facturer : … » ; le facturé HT et
//    les factures liées, qui sont des faits, restent (points 1 et 7) ;
//  - carte de marge [data-marge-commerciale] : son titre reste ; « Affaire annulée » remplace le montant et le « % du budget
//    vendu », sur un style neutre, sans couleur liée au signe (point 2) ; « Dépenses Réelles Cumulées » reste à
//    l'administration ;
//  - bloc d'alertes de l'en-tête [data-alertes-fiche] : la seule pastille « Affaire annulée », ni « Dans le budget » ni
//    aucune alerte (point 3) ;
//  - marge estimée [data-estimation] : toujours absente (point 6).
// Visibilité inchangée (point 4) : le commercial ne voit toujours ni la carte de marge ni le bloc de facturation. Le serveur
// renvoie les mêmes montants qu'avant : le masquage est fait à l'écran seul (cadrage, « Pourquoi masquer à l'écran »).
//
// Montants (règle 2 de la méthode ; un test manquant serait classé C). Le budget vendu, 1 234,56 € HT, est choisi pour que
// chaque format affiché se distingue des autres lectures :
//  - le reste à facturer s'affiche à l'euro, la moitié arrondie vers l'extérieur (fmtEuro) : « 1 235 € », et non
//    « 1 234,56 € » (au centime) ni « 1 234 € » (tronqué) ;
//  - la marge s'affiche au centime (toLocaleString) : « 1 234,56 € », suivie de « 100.0% du budget vendu ».
// Le budget vendu, de même valeur, reste affiché hors de ces blocs : chaque absence est bornée à son bloc. Chaque parcours
// lit d'abord ces montants sur la même fiche encore en cours (témoin), puis vérifie qu'ils ont quitté leur bloc une fois
// l'affaire annulée : l'absence porte sur le texte réellement affiché, et non sur un format supposé. Les blocs sont enfin lus
// en entier, pour qu'aucun autre montant n'y subsiste. Le séparateur de milliers du français est une espace fine insécable,
// que `\s` reconnaît. Seules les factures et l'achat datent du jour (dateDuJour) ; aucune date n'est lue à l'écran.

type FicheLue = Chantier & {
  budgetGlobalVendu: number;
  facturation?: { totalFactureHt: number; resteAFacturerHt: number; factures: unknown[] };
  metrics: { margeCommerciale: number | null; alertes: string[] };
};

const BUDGET_483 = 1234.56;
// Formats affichés d'une affaire vendue 1 234,56 € HT, sans facture ni dépense.
const RESTE_AFFICHE = /Reste à facturer : 1\s235\s€/;
const AU_CENTIME = /1\s234,56\s€/;
const POURCENTAGE_AFFICHE = '100.0% du budget vendu';
// Toute lecture de 1 234,56 € (au centime, à l'euro arrondi ou tronqué, avec ou sans séparateur) : absente des blocs masqués.
const LECTURES_DU_BUDGET = /1\s?23[45]/;
// Couleurs liées au signe de la marge (vert si positive, rouge sinon) ou d'une alerte.
const COULEUR_DU_SIGNE = /(?:^|\s)(?:bg|border|text)-(?:emerald|red)-\d+(?:\s|$)/;

const blocFacturation = (page: Page) => page.locator('[data-facturation]');
const carteMarge = (page: Page) => page.locator('[data-marge-commerciale]');
const blocAlertes = (page: Page) => page.locator('[data-alertes-fiche]');
const margeEstimee = (page: Page) => page.locator('[data-estimation]');
const carteBudgetVendu = (page: Page) => page.getByText('Budget Vendu', { exact: true }).locator('..');

// Affaire vendue 1 234,56 € HT (une ligne de main-d'œuvre), ouverte comme par chantierConverti : conversion d'un devis signé.
async function affaireVendue(request: APIRequestContext, token: string, clientId: string, nom: string, responsableId?: string) {
  const devis = await appel<{ id: string }>(request, token, 'post', '/devis', { clientId, objet: nom, lignes: [{ designation: 'Pose et mise en service', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: BUDGET_483, tauxTva: 20 }] });
  await appel(request, token, 'put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await appel(request, token, 'post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await appel<Chantier>(request, token, 'post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER', ...(responsableId ? { responsableId } : {}) });
  expect((await appel<FicheLue>(request, token, 'get', `/chantiers/${chantier.id}`)).budgetGlobalVendu).toBe(BUDGET_483);
  return { devis, chantier };
}

// La marge et ses destinataires se lisent sous leurs réglages par défaut (schema.prisma : margeCommercialeActive et
// rentabiliteConducteur valent true) : si une spec précédente ne les a pas restaurés, le test échoue ici, sur un message clair.
async function verifierReglagesDeLaMarge(request: APIRequestContext, token: string) {
  const parametres = await appel<{ margeCommercialeActive: boolean; rentabiliteConducteur: boolean }>(request, token, 'get', '/parametres');
  expect({ margeCommercialeActive: parametres.margeCommercialeActive, rentabiliteConducteur: parametres.rentabiliteConducteur },
    'Réglages de la marge hors de leur valeur par défaut : une spec précédente ne les a pas restaurés.').toEqual({ margeCommercialeActive: true, rentabiliteConducteur: true });
}

// Alertes que le serveur calcule pour ce compte (GET /api/chantiers/:id).
const alertesDuServeur = async (request: APIRequestContext, token: string, chantierId: string) => (await appel<FicheLue>(request, token, 'get', `/chantiers/${chantierId}`)).metrics.alertes;

// Bloc d'alertes d'une affaire en cours ou terminée, inchangé : « Dans le budget » si le serveur ne signale rien, sinon ses
// pastilles. L'état d'une affaire en cours dépend de la base : tant que la société n'a aucun coût horaire moyen, une affaire
// dont tout le vendu est de la main-d'œuvre porte « Marge estimée 0 % » (chantiers/suivi.ts, coût attendu au budget de
// main-d'œuvre vendu) ; il est donc lu du serveur. Une affaire terminée sans dépense, elle, est toujours « Dans le budget ».
async function attendreAlertesAffichees(page: Page, alertes: string[]) {
  const bloc = blocAlertes(page);
  if (alertes.length === 0) {
    await expect(bloc).toHaveText('Dans le budget');
  } else {
    for (const code of alertes) await expect(bloc.locator(`[data-alerte="${code}"]`)).toBeVisible();
    await expect(bloc.locator('[data-alerte]')).toHaveCount(alertes.length);
    await expect(bloc).not.toContainText('Dans le budget');
  }
  await expect(bloc).not.toContainText('Affaire annulée');
}

// Témoin et contre-épreuve : fiche d'une affaire en cours ou terminée, sans facture ni dépense, telle qu'avant le correctif.
async function attendreMontantsAffiches(page: Page, { estimation, alertes }: { estimation: boolean; alertes: string[] }) {
  const facturation = blocFacturation(page);
  await expect(facturation).toContainText(RESTE_AFFICHE);
  await expect(facturation).not.toContainText('Affaire annulée');
  const marge = carteMarge(page);
  await expect(marge).toContainText(AU_CENTIME);
  await expect(marge).toContainText(POURCENTAGE_AFFICHE);
  await expect(marge).not.toContainText('Affaire annulée');
  // Couleurs de la marge, positive ici : celles que l'affaire annulée doit perdre.
  await expect(marge).toHaveClass(/(?:^|\s)bg-emerald-50(?:\s|$)/);
  await expect(marge.getByText('Marge Commerciale', { exact: true })).toHaveClass(/(?:^|\s)text-emerald-700(?:\s|$)/);
  await attendreAlertesAffichees(page, alertes);
  // Marge estimée : affichée en cours, jamais sur une affaire close (ChantierIndicateurs, `!isTermine`).
  await expect(margeEstimee(page)).toHaveCount(estimation ? 1 : 0);
}

// Affaire annulée vue d'un destinataire de la rentabilité (administration ou conducteur titulaire), aux trois emplacements.
//  - `factureHt` : le facturé HT affiché, qui reste ;
//  - `restes` : toutes les lectures du reste à facturer, qui doivent avoir quitté le bloc de facturation ;
//  - `administration` : « Dépenses Réelles Cumulées » reste dans la carte de marge (fermée au conducteur, chantiers/droits.ts :
//    pour lui, le cadrage limite les assertions aux trois emplacements).
async function attendreAffaireAnnulee(page: Page, { factureHt, restes, administration }: { factureHt: string; restes: RegExp; administration: boolean }) {
  // Bloc de facturation : « Affaire annulée » à la place du reste à facturer ; « Facturé HT » et son montant restent.
  const facturation = blocFacturation(page);
  await expect(facturation).toContainText('Affaire annulée');
  await expect(facturation).not.toContainText('Reste à facturer');
  await expect(facturation).not.toContainText(restes);
  await expect(facturation).toHaveText(new RegExp(`^\\s*Facturé HT\\s*${factureHt}\\s€\\s*Affaire annulée\\s*$`));

  // Carte de marge : titre gardé ; ni montant, ni pourcentage, ni couleur liée au signe de la marge.
  const marge = carteMarge(page);
  const titre = marge.getByText('Marge Commerciale', { exact: true });
  await expect(titre).toBeVisible();
  await expect(marge).toContainText('Affaire annulée');
  await expect(marge).not.toContainText(LECTURES_DU_BUDGET);
  await expect(marge).not.toContainText('du budget vendu');
  await expect(marge).not.toContainText('%');
  await expect(marge).not.toHaveClass(COULEUR_DU_SIGNE);
  await expect(titre).not.toHaveClass(COULEUR_DU_SIGNE);
  await expect(marge.getByText('Affaire annulée', { exact: true })).not.toHaveClass(COULEUR_DU_SIGNE);
  // Rien d'autre que son titre, « Affaire annulée » et, pour l'administration, les dépenses réelles : 0 €, car une affaire
  // qui porte un coût ne s'annule pas (devis/annulation.ts).
  await expect(marge).toHaveText(/^\s*Marge Commerciale\s*Affaire annulée\s*(?:Dépenses Réelles Cumulées\s*0\s€)?\s*$/);
  if (administration) await expect(marge).toContainText(/Dépenses Réelles Cumulées\s*0\s€/);

  // Bloc d'alertes de l'en-tête : la seule pastille « Affaire annulée », neutre ; ni « Dans le budget » ni alerte.
  const alertes = blocAlertes(page);
  await expect(alertes).toHaveText('Affaire annulée');
  await expect(alertes).not.toContainText('Dans le budget');
  await expect(alertes.locator('[data-alerte]')).toHaveCount(0);
  await expect(alertes.getByText('Affaire annulée', { exact: true })).not.toHaveClass(/(?:^|\s)(?:bg|text)-(?:emerald|red|yellow)-\d+(?:\s|$)/);

  // Marge estimée : toujours absente.
  await expect(margeEstimee(page)).toHaveCount(0);
}

test.describe('Correctif #483 : fiche d’une affaire annulée, montants masqués', () => {
  test('l’administration ouvre une affaire annulée sans facture : « Affaire annulée » remplace le reste à facturer, la marge et « Dans le budget », le budget vendu reste affiché', async ({ allerSurPageAdmin, creerClient, request, session }) => {
    test.slow();
    const token = session.token;
    await verifierReglagesDeLaMarge(request, token);
    const nom = `E2E Affaire annulée 483 ${Date.now()}`;
    const client = await creerClient('affaire annulée 483');
    const { devis, chantier } = await affaireVendue(request, token, client.id, nom);

    // Témoin : en cours, la fiche affiche le reste à facturer (1 235 €), la marge (1 234,56 €, 100.0 %), la marge estimée,
    // et ses alertes ou « Dans le budget ».
    const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
    await expect(enTete(page, nom).getByText('En cours', { exact: true })).toBeVisible();
    await attendreMontantsAffiches(page, { estimation: true, alertes: await alertesDuServeur(request, token, chantier.id) });

    await annuler(request, token, devis.id);
    // Le serveur renvoie les mêmes montants : reste à facturer et marge valent le budget vendu, seul l'écran les masque. Il ne
    // signale aucune alerte : sans le correctif, l'écran afficherait « Dans le budget ».
    const lu = await appel<FicheLue>(request, token, 'get', `/chantiers/${chantier.id}`);
    expect([lu.statut, lu.budgetGlobalVendu, lu.facturation?.totalFactureHt, lu.facturation?.resteAFacturerHt, lu.metrics.margeCommerciale, lu.metrics.alertes])
      .toEqual(['ANNULE', BUDGET_483, 0, BUDGET_483, BUDGET_483, []]);

    await page.reload({ waitUntil: 'networkidle' });
    await expect(enTete(page, nom).getByText('Annulé', { exact: true })).toBeVisible();
    // Facturé HT : 0 €. Reste à facturer et marge : 1 234,56 €, qui ne doivent plus se lire dans leur bloc sous aucune forme.
    await attendreAffaireAnnulee(page, { factureHt: '0', restes: LECTURES_DU_BUDGET, administration: true });
    // Le budget vendu, un fait, reste affiché, au format même de la marge masquée.
    await expect(carteBudgetVendu(page)).toContainText(AU_CENTIME);
  });

  test('l’administration ouvre une affaire annulée après une facture annulée par son avoir et une facture réduite d’un avoir partiel : le facturé HT et les factures liées restent, le reste à facturer et la marge sont masqués', async ({ allerSurPageAdmin, creerClient, request, session }) => {
    test.slow();
    // Les factures datent du jour : le parcours ne chevauche pas minuit (#366).
    await horsDuPassageDeMinuit();
    const token = session.token;
    await verifierReglagesDeLaMarge(request, token);
    const suffixe = Date.now();
    const nom = `E2E Affaire facturée puis annulée 483 ${suffixe}`;
    const client = await creerClient('affaire facturée puis annulée 483');
    const { devis, chantier } = await affaireVendue(request, token, client.id, nom);
    const facturer = async (montantHt: number, designation: string) => {
      const brouillon = await appel<{ id: string }>(request, token, 'post', '/factures', { clientId: client.id, origine: 'CHANTIER', chantierId: chantier.id, dateEmission: dateDuJour(), dateEcheance: dateDuJour(), lignes: [{ designation, nature: 'PRESTATION', quantite: 1, prixUnitaireHt: montantHt, tauxTva: 20 }] });
      const emise = await appel<{ id: string; numero: string; statut: string; totalHt: number }>(request, token, 'post', `/factures/${brouillon.id}/emettre`, {}, 200);
      expect([emise.statut, emise.totalHt]).toEqual(['EMISE', montantHt]);
      return emise;
    };
    // Une facture de 400 € HT annulée par son avoir total, une facture de 300 € HT réduite d'un avoir partiel de 50 € HT.
    // Facturé HT : 400 − 400 + 300 − 50 = 250 €. Reste à facturer : 1 234,56 − 250 = 984,56 €, affiché « 985 € ». Ces valeurs
    // écartent les autres lectures du reste : « 1 235 € » (budget, factures ignorées), « 984,56 € » (au centime), « 984 € »
    // (tronqué) ; aucune ne doit rester dans le bloc.
    const annulee = await facturer(400, `Acompte E2E 483 ${suffixe}`);
    const annulation = await appel<{ statut: string; avoir: { numero: string; totalHt: number } }>(request, token, 'post', `/factures/${annulee.id}/annuler`, undefined, 200);
    expect([annulation.statut, annulation.avoir.totalHt]).toEqual(['ANNULEE', 400]);
    const reduite = await facturer(300, `Situation E2E 483 ${suffixe}`);
    const avoirPartiel = await appel<{ numero: string; totalHt: number }>(request, token, 'post', `/factures/${reduite.id}/avoirs`, { lignes: [{ designation: `Geste commercial E2E 483 ${suffixe}`, nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 50, tauxTva: 20 }] });
    expect(avoirPartiel.totalHt).toBe(50);
    const pieces = [
      { numero: annulee.numero, type: 'Facture', totalHt: '400' },
      { numero: annulation.avoir.numero, type: 'Avoir', totalHt: '400' },
      { numero: reduite.numero, type: 'Facture', totalHt: '300' },
      { numero: avoirPartiel.numero, type: 'Avoir', totalHt: '50' },
    ];
    const avant = await appel<FicheLue>(request, token, 'get', `/chantiers/${chantier.id}`);
    expect([avant.facturation?.totalFactureHt, avant.facturation?.resteAFacturerHt, avant.facturation?.factures.length]).toEqual([250, 984.56, 4]);

    // Témoin : en cours, facturé HT 250 €, reste à facturer 985 €, quatre factures liées, la marge, et ses alertes ou « Dans
    // le budget ».
    const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
    await expect(enTete(page, nom).getByText('En cours', { exact: true })).toBeVisible();
    const facturation = blocFacturation(page);
    await expect(facturation).toContainText(/Facturé HT\s*250\s€/);
    await expect(facturation).toContainText(/Reste à facturer : 985\s€/);
    const facturesLiees = page.getByRole('region', { name: 'Factures liées' });
    await expect(facturesLiees.locator('tbody tr')).toHaveCount(4);
    await expect(carteMarge(page)).toContainText(AU_CENTIME);
    await expect(carteMarge(page)).toContainText(POURCENTAGE_AFFICHE);
    await attendreAlertesAffichees(page, avant.metrics.alertes);

    // L'annulation du devis ne vérifie aucune facture (cadrage, « Constat ») : l'affaire facturée s'annule. Le serveur garde
    // ses montants et ne signale aucune alerte.
    await annuler(request, token, devis.id);
    const apres = await appel<FicheLue>(request, token, 'get', `/chantiers/${chantier.id}`);
    expect([apres.statut, apres.facturation?.totalFactureHt, apres.facturation?.resteAFacturerHt, apres.facturation?.factures.length, apres.metrics.margeCommerciale, apres.metrics.alertes])
      .toEqual(['ANNULE', 250, 984.56, 4, BUDGET_483, []]);

    await page.reload({ waitUntil: 'networkidle' });
    await expect(enTete(page, nom).getByText('Annulé', { exact: true })).toBeVisible();
    await attendreAffaireAnnulee(page, { factureHt: '250', restes: /98[45]|1\s?23[45]/, administration: true });
    // Les quatre pièces, des faits, restent liées à l'affaire, chacune avec son type et son total HT (colonnes « Type » et
    // « Total HT » du tableau des factures liées).
    await expect(facturesLiees.locator('tbody tr')).toHaveCount(4);
    for (const piece of pieces) {
      const ligne = facturesLiees.locator('tbody tr').filter({ hasText: piece.numero });
      await expect(ligne).toHaveCount(1);
      await expect(ligne.locator('td').nth(1)).toHaveText(piece.type);
      await expect(ligne.locator('td').nth(4)).toHaveText(new RegExp(`^\\s*${piece.totalHt}\\s€\\s*$`));
    }
    await expect(carteBudgetVendu(page)).toContainText(AU_CENTIME);
  });

  test('le conducteur titulaire d’une affaire annulée lit « Affaire annulée » aux trois mêmes emplacements que l’administration', async ({ connexion, creerClient, request, session }) => {
    test.slow();
    const token = session.token;
    await verifierReglagesDeLaMarge(request, token);
    const suffixe = Date.now();
    const conducteur = await appel<Compte>(request, token, 'post', '/users', { email: `c483.annulee.${suffixe}@iris.test`, name: `Conducteur affaire annulée 483 ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' });
    const nom = `E2E Affaire annulée du titulaire 483 ${suffixe}`;
    const client = await creerClient('affaire annulée titulaire 483');
    const { devis, chantier } = await affaireVendue(request, token, client.id, nom, conducteur.id);

    // Témoin : destinataire de la rentabilité par défaut (rentabiliteConducteur), il lit en cours le reste à facturer, la
    // marge, la marge estimée, et ses alertes ou « Dans le budget », comme l'administration.
    const page = await connexion(conducteur);
    await page.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
    await expect(enTete(page, nom).getByText('En cours', { exact: true })).toBeVisible();
    await attendreMontantsAffiches(page, { estimation: true, alertes: await alertesDuServeur(request, jetonPour(conducteur.id), chantier.id) });

    await annuler(request, token, devis.id);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(enTete(page, nom).getByText('Annulé', { exact: true })).toBeVisible();
    await attendreAffaireAnnulee(page, { factureHt: '0', restes: LECTURES_DU_BUDGET, administration: false });
  });

  test('le commercial d’une affaire annulée lit la pastille « Affaire annulée », et toujours ni carte de marge ni bloc de facturation', async ({ connexion, creerClient, request, session }) => {
    test.slow();
    const token = session.token;
    const suffixe = Date.now();
    const commercial = await appel<Compte>(request, token, 'post', '/users', { email: `com483.annulee.${suffixe}@iris.test`, name: `Commercial affaire annulée 483 ${suffixe}`, role: 'COMMERCIAL' });
    const nom = `E2E Affaire annulée du commercial 483 ${suffixe}`;
    const client = await creerClient('affaire annulée commercial 483');
    const { devis, chantier } = await affaireVendue(request, token, client.id, nom);
    await appel(request, token, 'patch', `/chantiers/${chantier.id}/commercial`, { commercialId: commercial.id });

    // Témoin : en cours, le commercial ouvre la fiche de son affaire et lit ses alertes ou « Dans le budget », sans carte de
    // marge ni bloc de facturation : il n'est pas destinataire de la rentabilité (chantiers/droits.ts, voitRentabilite).
    const page = await connexion(commercial);
    await page.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
    await expect(enTete(page, nom).getByText('En cours', { exact: true })).toBeVisible();
    await attendreAlertesAffichees(page, await alertesDuServeur(request, jetonPour(commercial.id), chantier.id));
    await expect(carteMarge(page)).toHaveCount(0);
    await expect(blocFacturation(page)).toHaveCount(0);

    await annuler(request, token, devis.id);
    // Le serveur ne lui envoie toujours ni facturation ni marge.
    const lu = await appel<FicheLue>(request, jetonPour(commercial.id), 'get', `/chantiers/${chantier.id}`);
    expect([lu.statut, lu.facturation, lu.metrics.margeCommerciale]).toEqual(['ANNULE', undefined, null]);

    await page.reload({ waitUntil: 'networkidle' });
    await expect(enTete(page, nom).getByText('Annulé', { exact: true })).toBeVisible();
    const alertes = blocAlertes(page);
    await expect(alertes).toHaveText('Affaire annulée');
    await expect(alertes.locator('[data-alerte]')).toHaveCount(0);
    await expect(carteMarge(page)).toHaveCount(0);
    await expect(blocFacturation(page)).toHaveCount(0);
    await expect(margeEstimee(page)).toHaveCount(0);
  });

  // Critère 5 et point 3 du cadrage : le technicien titulaire ouvre la fiche, voit le bloc d'alertes comme tout compte, et
  // aucun montant (décision de Nelson du 13-10-2026, budgets-technicien.spec.ts) ; il ne voit rien de plus une fois l'affaire
  // annulée, sinon la pastille « Affaire annulée » à la place de « Dans le budget ».
  test('le technicien titulaire d’une affaire annulée lit la pastille « Affaire annulée », et toujours aucun montant', async ({ connexion, creerClient, request, session }) => {
    test.slow();
    const token = session.token;
    const suffixe = Date.now();
    const technicien = await appel<Compte>(request, token, 'post', '/users', { email: `t483.annulee.${suffixe}@iris.test`, name: `Technicien affaire annulée 483 ${suffixe}`, role: 'TECHNICIEN' });
    const nom = `E2E Affaire annulée du technicien 483 ${suffixe}`;
    const client = await creerClient('affaire annulée technicien 483');
    const { devis, chantier } = await affaireVendue(request, token, client.id, nom);
    await appel(request, token, 'patch', `/chantiers/${chantier.id}`, { responsableId: technicien.id });
    const jetonTechnicien = jetonPour(technicien.id);

    // Témoin : en cours, le technicien titulaire lit ses alertes ou « Dans le budget », sans carte de marge, ni bloc de
    // facturation, ni marge estimée, ni aucun montant en euros sur la fiche.
    const page = await connexion(technicien);
    await page.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
    await expect(enTete(page, nom).getByText('En cours', { exact: true })).toBeVisible();
    await attendreAlertesAffichees(page, await alertesDuServeur(request, jetonTechnicien, chantier.id));
    const fiche = page.locator('main');
    await expect(fiche).toContainText(nom);
    await expect(fiche).not.toContainText('€');
    await expect(carteMarge(page)).toHaveCount(0);
    await expect(blocFacturation(page)).toHaveCount(0);
    await expect(margeEstimee(page)).toHaveCount(0);

    await annuler(request, token, devis.id);
    // Le serveur ne lui envoie toujours ni budget vendu, ni facturation, ni marge.
    const lu = await appel<FicheLue>(request, jetonTechnicien, 'get', `/chantiers/${chantier.id}`);
    expect([lu.statut, lu.budgetGlobalVendu, lu.facturation, lu.metrics.margeCommerciale]).toEqual(['ANNULE', null, undefined, null]);

    await page.reload({ waitUntil: 'networkidle' });
    await expect(enTete(page, nom).getByText('Annulé', { exact: true })).toBeVisible();
    const alertes = blocAlertes(page);
    await expect(alertes).toHaveText('Affaire annulée');
    await expect(alertes.locator('[data-alerte]')).toHaveCount(0);
    await expect(fiche).toContainText(nom);
    await expect(fiche).not.toContainText('€');
    await expect(carteMarge(page)).toHaveCount(0);
    await expect(blocFacturation(page)).toHaveCount(0);
    await expect(margeEstimee(page)).toHaveCount(0);
  });

  // Points 2, 3 et 5 du cadrage : le statut seul décide, quoi que porte la fiche. Une affaire annulée sans dépense ne reçoit
  // du serveur ni alerte ni marge négative ; une affaire annulée en porte pourtant si une saisie passe pendant l'annulation de
  // son devis (course connue, docs/ROADMAP-PASSATION.md, « Saisie sur un chantier pendant l'annulation de son devis », non
  // corrigée). Pour l'éprouver sans provoquer la course, la vraie réponse de GET /api/chantiers/:id est complétée dans le
  // navigateur des six alertes connues (point 3 : en perte, marge faible, dépassements, sans saisie) et d'une marge de
  // −65,44 € (−5,3 %), celle d'un achat de 1 300 € resté sur l'affaire. Les autres champs viennent de la base.
  test('l’administration ouvre une affaire annulée dont la fiche porte des alertes et une marge négative : ni pastille d’alerte, ni montant, ni rouge, seul « Affaire annulée »', async ({ allerSurPageAdmin, creerClient, page, request, session }) => {
    test.slow();
    const token = session.token;
    await verifierReglagesDeLaMarge(request, token);
    const nom = `E2E Affaire annulée en perte 483 ${Date.now()}`;
    const client = await creerClient('affaire annulée en perte 483');
    const { devis, chantier } = await affaireVendue(request, token, client.id, nom);

    const ALERTES_INJECTEES = ['EN_PERTE', 'MARGE_FAIBLE', 'HEURES_DEPASSEES', 'MAIN_OEUVRE_DEPASSEE', 'MATERIEL_DEPASSE', 'SANS_SAISIE'];
    const statutsServis: string[] = [];
    await page.route((url) => url.pathname === `/api/chantiers/${chantier.id}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const reponse = await route.fetch();
      const lue = await reponse.json() as FicheLue & { metrics: Record<string, unknown> };
      statutsServis.push(lue.statut);
      await route.fulfill({ response: reponse, json: { ...lue, metrics: { ...lue.metrics, margeCommerciale: -65.44, margePct: (-65.44 / BUDGET_483) * 100, alertes: ALERTES_INJECTEES } } });
    });

    // Témoin : en cours, la fiche complétée affiche les six pastilles, la marge négative en rouge et son pourcentage.
    await allerSurPageAdmin(`/chantiers/${chantier.id}`);
    await expect(enTete(page, nom).getByText('En cours', { exact: true })).toBeVisible();
    for (const code of ALERTES_INJECTEES) await expect(blocAlertes(page).locator(`[data-alerte="${code}"]`)).toBeVisible();
    await expect(blocAlertes(page).locator('[data-alerte="EN_PERTE"]')).toHaveText(/En perte 65\s€/);
    const marge = carteMarge(page);
    await expect(marge).toContainText(/[-−]65,44\s€/);
    await expect(marge).toContainText(/[-−]5\.3% du budget vendu/);
    await expect(marge).toHaveClass(/(?:^|\s)bg-red-50(?:\s|$)/);
    await expect(marge.getByText('Marge Commerciale', { exact: true })).toHaveClass(/(?:^|\s)text-red-700(?:\s|$)/);
    await expect(blocFacturation(page)).toContainText(RESTE_AFFICHE);

    await annuler(request, token, devis.id);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(enTete(page, nom).getByText('Annulé', { exact: true })).toBeVisible();
    // La fiche affichée est bien celle de l'affaire annulée, complétée de ses alertes et de sa marge négative.
    expect(statutsServis.at(-1)).toBe('ANNULE');
    // Aucune des six pastilles, ni −65,44 €, ni −5,3 %, ni rouge : les trois emplacements disent « Affaire annulée ».
    await attendreAffaireAnnulee(page, { factureHt: '0', restes: LECTURES_DU_BUDGET, administration: true });
    await expect(marge).not.toContainText('65');
    await expect(blocAlertes(page)).not.toContainText(/En perte|Marge estimée|Heures|Main-d’œuvre|Matériel|Sans saisie/);
  });

  test('contre-épreuve : un chantier en cours, puis terminé, garde son reste à facturer, sa marge, et ses alertes ou « Dans le budget »', async ({ allerSurPageAdmin, creerClient, request, session }) => {
    test.slow();
    const token = session.token;
    await verifierReglagesDeLaMarge(request, token);
    const nom = `E2E Chantier terminé 483 ${Date.now()}`;
    const client = await creerClient('chantier terminé 483');
    const { chantier } = await affaireVendue(request, token, client.id, nom);

    const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
    await expect(enTete(page, nom).getByText('En cours', { exact: true })).toBeVisible();
    await attendreMontantsAffiches(page, { estimation: true, alertes: await alertesDuServeur(request, token, chantier.id) });

    // Terminé, `isTermine` vaut vrai comme pour une affaire annulée : seul le statut ANNULE masque (cadrage, point 5). Sans
    // dépense, le chantier terminé n'a aucune alerte : l'écran affiche « Dans le budget », que l'affaire annulée doit perdre.
    await cloturer(request, token, chantier.id);
    expect(await alertesDuServeur(request, token, chantier.id)).toEqual([]);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(enTete(page, nom).getByText('Terminé', { exact: true })).toBeVisible();
    await attendreMontantsAffiches(page, { estimation: false, alertes: [] });
  });

  test('contre-épreuve : un chantier terminé en perte garde son reste à facturer, sa marge négative en rouge et ses alertes', async ({ allerSurPageAdmin, creerClient, request, session }) => {
    test.slow();
    const token = session.token;
    await verifierReglagesDeLaMarge(request, token);
    const suffixe = Date.now();
    const nom = `E2E Chantier terminé en perte 483 ${suffixe}`;
    const client = await creerClient('chantier terminé en perte 483');
    const { chantier } = await affaireVendue(request, token, client.id, nom);
    const categorie = await appel<{ id: string }>(request, token, 'post', '/categories', { nom: `Catégorie E2E 483 ${suffixe}` }, 200);
    const fournisseur = await appel<{ id: string }>(request, token, 'post', '/fournisseurs', { nom: `Fournisseur E2E 483 ${suffixe}` }, 200);
    // 1 300 € d'achats pour 1 234,56 € vendus : marge de −65,44 € (−5,3 % du budget vendu), en perte ; rien de facturé, le
    // reste à facturer vaut le budget vendu.
    await appel(request, token, 'post', '/achats', { chantierId: chantier.id, categorieId: categorie.id, fournisseurId: fournisseur.id, date: dateDuJour(), description: `Matériel E2E 483 ${suffixe}`, montantHT: 1300 }, 200);
    await cloturer(request, token, chantier.id);
    const lu = await appel<FicheLue>(request, token, 'get', `/chantiers/${chantier.id}`);
    expect([lu.statut, lu.metrics.margeCommerciale, lu.facturation?.resteAFacturerHt]).toEqual(['TERMINE', -65.44, BUDGET_483]);
    expect(lu.metrics.alertes).toContain('EN_PERTE');

    const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
    await expect(enTete(page, nom).getByText('Terminé', { exact: true })).toBeVisible();
    const facturation = blocFacturation(page);
    await expect(facturation).toContainText(RESTE_AFFICHE);
    await expect(facturation).not.toContainText('Affaire annulée');
    const marge = carteMarge(page);
    await expect(marge).toContainText(/[-−]65,44\s€/);
    await expect(marge).toContainText(/[-−]5\.3% du budget vendu/);
    await expect(marge).not.toContainText('Affaire annulée');
    await expect(marge).toHaveClass(/(?:^|\s)bg-red-50(?:\s|$)/);
    await expect(marge.getByText('Marge Commerciale', { exact: true })).toHaveClass(/(?:^|\s)text-red-700(?:\s|$)/);
    const alertes = blocAlertes(page);
    await expect(alertes.locator('[data-alerte="EN_PERTE"]')).toHaveText(/En perte 65\s€/);
    await expect(alertes).not.toContainText('Dans le budget');
    await expect(alertes).not.toContainText('Affaire annulée');
  });
});
