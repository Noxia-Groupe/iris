import { createHmac } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable
// ouvre une session dans un rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

type Compte = { id: string; name: string };

// Décisions de Nelson (14-10-2026) : le formulaire de l'Administration ouvre le chantier d'une
// affaire sans erreur, une seule fois par affaire, et un chantier se réattribue à un autre
// conducteur depuis sa fiche, par exemple au départ de son conducteur.
async function preparer(request: APIRequestContext, token: string, creerClient: (libelle: string, avecSite?: boolean) => Promise<{ id: string }>, cle: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const envoyer = async (methode: 'post' | 'patch' | 'put', path: string, data: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const creerCompte = async (role: string, nom: string): Promise<Compte> =>
    envoyer('post', '/users', { email: `ouverture.${cle}.${role.toLowerCase()}.${nom.length}.${suffixe}@iris.test`, name: `${nom} ${suffixe}`, role });
  const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'Conducteur partant');
  const remplacant = await creerCompte('CONDUCTEUR_TRAVAUX', 'Conducteur remplaçant');
  const commercial = await creerCompte('COMMERCIAL', 'Commercial ouverture');
  const client = await creerClient(`ouverture-${cle}`, false);
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Ouverture ${cle} E2E ${suffixe}`, lignes: [
    { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: 50, tauxTva: 20 },
  ] }) as { id: string; numero: string; objet: string };
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  return { headers, envoyer, conducteur, remplacant, commercial, devis };
}

test('l’Administration ouvre le chantier d’une affaire une seule fois, puis le réattribue depuis la fiche au départ du conducteur', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  test.slow();
  const { headers, envoyer, conducteur, remplacant, commercial, devis } = await preparer(request, session.token, creerClient, 'complet');
  const admin = await allerSurPageAdmin('/admin');
  await expect(admin.getByRole('heading', { name: 'Ouvrir le chantier d’une affaire' })).toBeVisible();

  await admin.getByLabel('Devis signé de l’affaire').selectOption(devis.id);
  await expect(admin.getByText(`Chantier « ${devis.objet} »`)).toContainText('vendu 100,00 € HT');
  await admin.getByLabel('Responsable du chantier').selectOption(conducteur.id);
  await admin.getByLabel('Commercial rattaché').selectOption(commercial.id);
  // Préremplie au jour de la société, au format JJ-MM-AAAA.
  await expect(admin.getByLabel('Date de début')).toHaveValue(/^\d{2}-\d{2}-\d{4}$/);
  await admin.getByLabel('Date de début').fill('05-10-2026');
  await admin.getByRole('checkbox', { name: 'Vidéo' }).check();

  const ouverture = admin.waitForResponse((r) => r.url().endsWith(`/api/devis/${devis.id}/convertir`) && r.request().method() === 'POST');
  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  expect((await ouverture).status()).toBe(201);
  const confirmation = admin.getByRole('status').filter({ hasText: `pour l’affaire ${devis.numero}` });
  await expect(confirmation).toBeVisible();
  // Le devis converti n'est plus proposé, et le chantier rejoint la liste avec son titulaire.
  await expect(admin.locator(`#ouverture-devis option[value="${devis.id}"]`)).toHaveCount(0);
  const carte = admin.locator('div.p-4').filter({ has: admin.getByRole('link', { name: devis.objet }) });
  await expect(carte).toContainText(`Responsable : ${conducteur.name}`);

  const chantiers = await (await request.get(`${api}/chantiers`, { headers })).json() as { id: string; numeroDevis: string }[];
  const ouverts = chantiers.filter((c) => c.numeroDevis === devis.numero);
  expect(ouverts).toHaveLength(1);
  const chantierId = ouverts[0].id;
  const fiche = await (await request.get(`${api}/chantiers/${chantierId}`, { headers })).json() as { responsable: Compte; commercial: Compte; types: string[]; dateDebut: string };
  expect(fiche.responsable.id).toBe(conducteur.id);
  expect(fiche.commercial.id).toBe(commercial.id);
  expect(fiche.types).toEqual(['Vidéo']);
  expect(fiche.dateDebut).toBe('2026-10-05T00:00:00.000Z');
  // Chaque affaire a son chantier : une seconde conversion est refusée.
  const seconde = await request.post(`${api}/devis/${devis.id}/convertir`, { headers, data: { cible: 'CHANTIER' } });
  expect(seconde.status()).toBe(409);

  // Départ du conducteur : son compte est désactivé, puis le chantier est confié à un autre
  // conducteur depuis la fiche, sans passer par l'API.
  await envoyer('patch', `/users/${conducteur.id}/actif`, { actif: false });
  await confirmation.getByRole('link', { name: 'Ouvrir la fiche du chantier' }).click();
  await admin.getByRole('button', { name: 'Modifier' }).first().click();
  const titulaire = admin.locator('select[name="responsableId"]');
  await expect(titulaire.locator('option:checked')).toHaveText(`${conducteur.name} (hors des conducteurs actifs)`);
  await titulaire.selectOption(remplacant.id);
  // Le commercial, inchangé, n'est pas renvoyé.
  const appelsCommercial: string[] = [];
  admin.on('request', (r) => { if (r.url().endsWith(`/api/chantiers/${chantierId}/commercial`)) appelsCommercial.push(r.method()); });
  const enregistrement = admin.waitForResponse((r) => r.url().endsWith(`/api/chantiers/${chantierId}`) && r.request().method() === 'PATCH');
  await admin.getByRole('button', { name: 'Enregistrer les modifications' }).click();
  expect((await enregistrement).status()).toBe(200);
  await expect(admin.getByRole('heading', { name: 'Modifier le chantier' })).toHaveCount(0);
  expect(appelsCommercial).toEqual([]);
  const relu = await (await request.get(`${api}/chantiers/${chantierId}`, { headers })).json() as { responsable: Compte; commercial: Compte; dateDebut: string };
  expect(relu.responsable.id).toBe(remplacant.id);
  expect(relu.commercial.id).toBe(commercial.id);
  expect(relu.dateDebut).toBe('2026-10-05T00:00:00.000Z');
});

// Un refus du serveur s'affiche au lieu d'être ignoré : ici, le devis a été converti par un
// autre écran entre l'affichage du formulaire et son envoi.
test('l’ouverture d’un devis converti entre-temps est refusée avec un message, et le devis n’est plus proposé', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const { headers, conducteur, commercial, devis } = await preparer(request, session.token, creerClient, 'concurrent');
  const admin = await allerSurPageAdmin('/admin');
  await admin.getByLabel('Devis signé de l’affaire').selectOption(devis.id);
  await admin.getByLabel('Responsable du chantier').selectOption(conducteur.id);
  await admin.getByLabel('Commercial rattaché').selectOption(commercial.id);
  const ailleurs = await request.post(`${api}/devis/${devis.id}/convertir`, { headers, data: { cible: 'CHANTIER' } });
  expect(ailleurs.status()).toBe(201);

  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  await expect(admin.getByRole('alert').filter({ hasText: 'Ce devis a déjà été converti' })).toBeVisible();
  await expect(admin.locator(`#ouverture-devis option[value="${devis.id}"]`)).toHaveCount(0);
  const chantiers = await (await request.get(`${api}/chantiers`, { headers })).json() as { numeroDevis: string }[];
  expect(chantiers.filter((c) => c.numeroDevis === devis.numero)).toHaveLength(1);
});

// Formulaires voisins de l'Administration : un ajout refusé (nom déjà pris) est signalé, et la
// saisie conservée pour être corrigée.
test('un fournisseur déjà enregistré est refusé avec un message, sans vider la saisie', async ({ allerSurPageAdmin, request, session }) => {
  const nom = `Fournisseur doublon E2E ${Date.now()}`;
  const creation = await request.post(`${api}/fournisseurs`, { headers: { Authorization: `Bearer ${session.token}` }, data: { nom } });
  expect(creation.ok(), await creation.text()).toBeTruthy();
  const admin = await allerSurPageAdmin('/admin');
  await admin.getByRole('button', { name: 'Fournisseurs', exact: true }).click();
  const formulaire = admin.locator('form').filter({ has: admin.locator('input[name="nom"]') }).first();
  await formulaire.locator('input[name="nom"]').fill(nom);
  // L'alerte est acceptée dans l'écouteur même : sans écouteur actif, Playwright la fermerait
  // de lui-même, et une acceptation tardive resterait bloquée.
  let alerte = '';
  admin.once('dialog', (dialogue) => { alerte = dialogue.message(); void dialogue.accept(); });
  await formulaire.getByRole('button', { name: 'Enregistrer' }).click();
  await expect.poll(() => alerte).toBe('Un fournisseur porte déjà ce nom.');
  await expect(formulaire.locator('input[name="nom"]')).toHaveValue(nom);
});

// Le titulaire confie lui-même son chantier à un autre conducteur depuis la fiche : la
// réattribution aboutit sans alerte, et il retrouve sa liste, le chantier n'étant plus le sien.
// Avant, le commercial était enregistré après coup et refusé (« Chantier introuvable »).
test('un conducteur confie son chantier à un autre conducteur depuis la fiche, sans message d’erreur', async ({ browser, creerClient, request, session }) => {
  test.slow();
  const { headers, conducteur, remplacant, commercial, devis } = await preparer(request, session.token, creerClient, 'passation');
  const ouvert = await request.post(`${api}/devis/${devis.id}/convertir`, { headers, data: { cible: 'CHANTIER', responsableId: conducteur.id, commercialId: commercial.id } });
  expect(ouvert.status(), await ouvert.text()).toBe(201);
  const chantierId = (await ouvert.json() as { id: string }).id;

  const contexte = await browser.newContext();
  try {
    const page = await contexte.newPage();
    await page.addInitScript(([token, user]) => {
      localStorage.setItem('token', token as string);
      localStorage.setItem('user', user as string);
    }, [jetonPour(conducteur.id), JSON.stringify({ ...conducteur, role: 'CONDUCTEUR_TRAVAUX', permissions: [] })]);
    const alertes: string[] = [];
    page.on('dialog', (dialog) => { alertes.push(dialog.message()); void dialog.accept(); });
    const appelsCommercial: string[] = [];
    page.on('request', (r) => { if (r.url().endsWith(`/api/chantiers/${chantierId}/commercial`)) appelsCommercial.push(r.method()); });

    await page.goto(`/chantiers/${chantierId}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Modifier' }).first().click();
    await page.locator('select[name="responsableId"]').selectOption(remplacant.id);
    const enregistrement = page.waitForResponse((r) => r.url().endsWith(`/api/chantiers/${chantierId}`) && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Enregistrer les modifications' }).click();
    expect((await enregistrement).status()).toBe(200);
    await expect(page).toHaveURL(/\/chantiers$/);
    expect(alertes).toEqual([]);
    expect(appelsCommercial, 'le commercial inchangé n’est pas renvoyé').toEqual([]);
  } finally {
    await contexte.close();
  }
  const relu = await (await request.get(`${api}/chantiers/${chantierId}`, { headers })).json() as { responsable: { id: string }; commercial: { id: string } };
  expect(relu.responsable.id).toBe(remplacant.id);
  expect(relu.commercial.id).toBe(commercial.id);
});

// Un refus de la fiche (ici une référence d'affaire déjà prise) laisse la fenêtre ouverte avec
// la saisie, pour corriger le champ refusé ; le commercial, enregistré juste avant, s'affiche
// tel qu'il est désormais. Relire toute la fiche aurait démonté la fenêtre et vidé la saisie.
test('un refus de la fiche garde la saisie, et le commercial déjà enregistré s’affiche', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  test.slow();
  const { headers, envoyer, conducteur, commercial, devis } = await preparer(request, session.token, creerClient, 'refus');
  const suffixe = Date.now();
  const autreCommercial = await envoyer('post', '/users', { email: `ouverture.refus.autre.${suffixe}@iris.test`, name: `Autre commercial ${suffixe}`, role: 'COMMERCIAL' }) as Compte;
  const ouvert = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER', responsableId: conducteur.id, commercialId: commercial.id }) as { id: string; nom: string };
  // Une autre affaire, dont la référence est déjà portée par son chantier.
  const autreClient = await creerClient('ouverture-refus-autre', false);
  const autreDevis = await envoyer('post', '/devis', { clientId: autreClient.id, objet: `Autre affaire E2E ${suffixe}`, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] }) as { id: string; numero: string };
  await envoyer('put', `/devis/${autreDevis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${autreDevis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  await envoyer('post', `/devis/${autreDevis.id}/convertir`, { cible: 'CHANTIER' });

  const admin = await allerSurPageAdmin(`/chantiers/${ouvert.id}`);
  await admin.getByRole('button', { name: 'Modifier' }).first().click();
  const nouveauNom = `Nom corrigé E2E ${suffixe}`;
  await admin.locator('input[name="nom"]').fill(nouveauNom);
  await admin.locator('select[name="commercialId"]').selectOption(autreCommercial.id);
  await admin.locator('input[name="numeroDevis"]').fill(autreDevis.numero);
  let alerte = '';
  admin.once('dialog', (dialogue) => { alerte = dialogue.message(); void dialogue.accept(); });
  await admin.getByRole('button', { name: 'Enregistrer les modifications' }).click();
  await expect.poll(() => alerte).toContain('déjà rattaché à un autre chantier');
  // La fenêtre et la saisie sont intactes.
  await expect(admin.getByRole('heading', { name: 'Modifier le chantier' })).toBeVisible();
  await expect(admin.locator('input[name="nom"]')).toHaveValue(nouveauNom);
  await expect(admin.locator('input[name="numeroDevis"]')).toHaveValue(autreDevis.numero);
  await expect(admin.locator('select[name="commercialId"]')).toHaveValue(autreCommercial.id);
  // Le commercial est enregistré, la fiche ne l'est pas.
  const relu = await (await request.get(`${api}/chantiers/${ouvert.id}`, { headers })).json() as { nom: string; commercial: Compte };
  expect(relu.commercial.id).toBe(autreCommercial.id);
  expect(relu.nom).toBe(ouvert.nom);
});
