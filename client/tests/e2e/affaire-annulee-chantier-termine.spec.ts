import { createHmac } from 'node:crypto';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { test, expect } from './fixtures';

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
