import { createHmac } from 'node:crypto';
import type { APIRequestContext, BrowserContext, Locator, Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Lot 6b-2 (cadrage du lot 6b, version 8, section « 6b-2 — Écran ») : le dialogue d'envoi propose
// « Envoyer par Microsoft 365 » quand le serveur le dit possible (`proposition.microsoft365` de
// GET …/envois), garde « Préparer l’envoi » par la messagerie, classe la réponse de l'envoi sans jamais
// pousser à renvoyer un courriel peut-être parti (B2), ne part que d'un clic (B3), et tient un verrou
// par document (V-N8). Le super administrateur règle le mode d'envoi dans l'onglet Modules.
//
// Limites, écrites dans la PR (cadrage, « E2E ») :
//   - le serveur des E2E tourne sans connexion Microsoft (AZURE_TENANT_ID et AZURE_CLIENT_ID vides,
//     playwright.config.ts, N4) : c'est la configuration de la CI, et le serveur répond
//     `microsoft365: false` ;
//   - pour le reste, `proposition.microsoft365` et les réponses de POST …/envois sont simulés par
//     `page.route`, et la fenêtre Microsoft par `browserContext.route` sur login.microsoftonline.com
//     (la fenêtre surgissante échappe à `page.route`, N4), avec un GET /api/config factice : MSAL
//     (vrai code, @azure/msal-browser) ouvre la fenêtre, reçoit un code, l'échange contre un jeton
//     factice et le garde dans son cache de session. Ni Microsoft Graph ni un vrai locataire ne sont
//     joints : le parcours réel reste pour la recette sur le locataire de Nelson.

// Textes du cadrage, mot pour mot.
const AIDE_MICROSOFT_365 = 'Envoyer par Microsoft 365 : le courriel part de votre boîte Microsoft, avec le PDF joint, et Iris le note au journal. Préparer l’envoi : votre messagerie s’ouvre avec le courriel prérempli, et vous joignez le PDF à la main.';
const AIDE_MESSAGERIE = 'Votre messagerie s’ouvrira avec le destinataire, l’objet et le texte remplis. Le PDF est téléchargé en même temps : joignez-le à la main au courriel.';
const NOTE_JOURNAL = 'Pour la messagerie, Iris ne note que la préparation de l’envoi : il ne sait pas si le courriel est parti.';
const ANCIENNE_NOTE = 'Iris ne sait pas si le courriel est parti : seule la préparation de l’envoi est notée.';
const EN_COURS = 'Envoi par Microsoft 365 en cours…';
const ISSUE_INCONNUE = 'Iris n’a pas reçu la réponse du serveur : le courriel est peut-être parti. Vérifiez vos éléments envoyés dans Outlook, puis rouvrez ce dialogue pour relire le journal des envois, avant de recommencer.';
const NE_PAS_RENVOYER = 'Ne le renvoyez pas. Le statut du document n’a pas changé dans Iris.';
const IMPOSSIBLE = 'Connexion Microsoft impossible : rien n’a été envoyé. Vous pouvez préparer l’envoi par la messagerie.';
// Messages du serveur (MESSAGES_MICROSOFT_365, server/src/domaines/documents/envoiMicrosoft365.ts), que
// les réponses simulées reprennent ; client/tests/envoiMicrosoft365.test.ts vérifie que le client les
// reprend au caractère près.
const SERVEUR = {
  accesRefuse: 'Microsoft 365 refuse l’envoi : reconnectez-vous, ou vérifiez avec votre administrateur le consentement et la boîte aux lettres de votre compte.',
  refuse: 'Microsoft 365 a refusé l’envoi ; rien n’a été envoyé ni noté. Vous pouvez préparer l’envoi par la messagerie.',
  incertain: 'Microsoft 365 n’a pas confirmé l’envoi : il n’est pas noté. Vérifiez vos éléments envoyés dans Outlook avant de recommencer.',
  nonNote: 'Le courriel est parti par Microsoft 365, mais son envoi n’a pas pu être noté au journal.',
};
const echapper = (texte: string) => texte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Un instant où la date civile diffère entre UTC (31-10-2026 23:30) et Paris (01-11-2026 00:30) :
// la ligne du journal doit suivre le fuseau de la société.
const INSTANT_ENVOI = '2026-10-31T23:30:00.000Z';

type Session = { token: string; user: unknown };
type Utilisateur = { name: string; email: string };

async function societe(request: APIRequestContext, token: string) {
  return await (await request.get(`${api}/company`, { headers: auth(token) })).json() as { raisonSociale: string; fuseauHoraire: string | null };
}
async function creerDevis(request: APIRequestContext, token: string, clientId: string, objet: string) {
  const cree = await request.post(`${api}/devis`, { headers: auth(token), data: { clientId, objet: `${objet} ${Date.now()}`, lignes: [{ designation: 'Diagnostic', quantite: 1, prixUnitaireHt: 80, tauxTva: 20 }] } });
  expect(cree.status(), await cree.text()).toBe(201);
  return await cree.json() as { id: string; numero: string; version: number; objet: string; statut: string };
}
async function envoisDe(request: APIRequestContext, token: string, chemin: string) {
  const lu = await request.get(`${api}/${chemin}/envois`, { headers: auth(token) });
  expect(lu.status(), await lu.text()).toBe(200);
  return await lu.json() as { proposition: { destinataire: string; objet: string; corps: string; microsoft365: boolean }; envois: { id: string; canal: string; destinataire: string; expediteur: string | null; createdAt: string }[] };
}
// Date et heure au fuseau de la société, comme l'écran : JJ-MM-AAAA HH:MM.
function dateHeure(instant: string, fuseau: string) {
  const parties = new Intl.DateTimeFormat('fr-FR', { timeZone: fuseau, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(instant));
  const partie = (type: string) => parties.find((p) => p.type === type)!.value;
  return `${partie('day')}-${partie('month')}-${partie('year')} ${partie('hour')}:${partie('minute')}`;
}
async function sansDebordement(page: Page, largeur: number, elements: Locator[]) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(largeur);
  for (const element of elements) {
    const boite = await element.boundingBox();
    expect(boite, 'élément affiché').toBeTruthy();
    expect(boite!.x).toBeGreaterThanOrEqual(0);
    expect(boite!.x + boite!.width).toBeLessThanOrEqual(largeur);
  }
}
const utilisateur = (session: Session) => session.user as Utilisateur;

// --- Fenêtre Microsoft simulée ---
//
// Locataire et application factices, donnés à MSAL par un GET /api/config simulé. La fenêtre
// surgissante charge l'adresse d'autorisation de login.microsoftonline.com : la simulation répond par
// une redirection vers /auth/callback (page de retour de l'application, qui transmet la réponse à la
// fenêtre d'origine), avec le `state` reçu ; puis MSAL échange le code contre un jeton factice, avec le
// `nonce` de la demande dans le jeton d'identité. Chaque fenêtre émet un nouveau jeton d'accès : un envoi
// qui reprend le jeton du cache, sans fenêtre, se reconnaît à son jeton.
const LOCATAIRE = '0b6c7a51-6b2e-4d3c-9a10-6b2e00000001';
const APPLICATION = '0b6c7a51-6b2e-4d3c-9a10-6b2e00000002';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
const REFUS_AADSTS = 'AADSTS65004: User declined to consent to access the app.';

type Microsoft = {
  // Demandes d'autorisation reçues (une par fenêtre ouverte), et jetons d'accès émis, dans l'ordre.
  demandes: URL[];
  jetons: string[];
  // « refuser » : Microsoft renvoie une erreur à l'application (consentement refusé), sans code ni jeton ;
  // « laisser » : la fenêtre reste sur une page Microsoft, sans répondre (l'utilisateur la ferme).
  comportement: 'accepter' | 'refuser' | 'laisser';
};

async function simulerConfiguration(cible: BrowserContext | Page) {
  await cible.route('**/api/config', (route) => route.fulfill({ json: { ssoConfigured: true, ssoClientId: APPLICATION, ssoTenantId: LOCATAIRE } }));
}

// `email` : la revendication `email` du compte Microsoft, l'adresse que l'écran compare à celle du compte
// Iris (N1) ; `upn` : son `preferred_username`, que MSAL expose comme `username`, choisi différent.
async function simulerMicrosoft(contexte: BrowserContext, { email, upn }: { email: string; upn: string }): Promise<Microsoft> {
  const etat: Microsoft = { demandes: [], jetons: [], comportement: 'accepter' };
  let nonce = '';
  await simulerConfiguration(contexte);
  await contexte.route('https://login.microsoftonline.com/**', async (route) => {
    const requete = route.request();
    const adresse = new URL(requete.url());
    if (requete.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (adresse.pathname.endsWith('/oauth2/v2.0/authorize')) {
      etat.demandes.push(adresse);
      if (etat.comportement === 'laisser') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Microsoft</title><p>Connexion à votre compte</p>' });
      nonce = adresse.searchParams.get('nonce') || '';
      const reponse = etat.comportement === 'refuser'
        ? new URLSearchParams({ error: 'access_denied', error_description: `${REFUS_AADSTS} Trace ID: e2e`, state: adresse.searchParams.get('state') || '' })
        : new URLSearchParams({ code: `code-${etat.demandes.length}`, client_info: base64url({ uid: 'oid-e2e', utid: LOCATAIRE }), state: adresse.searchParams.get('state') || '', session_state: 'session-e2e' });
      const separateur = adresse.searchParams.get('response_mode') === 'query' ? '?' : '#';
      return route.fulfill({ status: 302, headers: { location: `${adresse.searchParams.get('redirect_uri')}${separateur}${reponse}` } });
    }
    if (adresse.pathname.endsWith('/oauth2/v2.0/token')) {
      const corps = new URLSearchParams(requete.postData() || '');
      const jeton = `jeton-microsoft-e2e-${etat.jetons.length + 1}-${Date.now()}`;
      etat.jetons.push(jeton);
      const maintenant = Math.floor(Date.now() / 1000);
      const identite = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'e2e' })}.${base64url({
        aud: APPLICATION, iss: `https://login.microsoftonline.com/${LOCATAIRE}/v2.0`, tid: LOCATAIRE, oid: 'oid-e2e', sub: 'sub-e2e',
        iat: maintenant, nbf: maintenant, exp: maintenant + 3600, ver: '2.0', name: 'Compte Microsoft E2E', email, preferred_username: upn, nonce,
      })}.signature-e2e`;
      return route.fulfill({ headers: CORS, json: {
        token_type: 'Bearer', scope: corps.get('scope') || '', expires_in: 3599, ext_expires_in: 3599,
        access_token: jeton, refresh_token: `rafraichissement-${jeton}`, id_token: identite, client_info: base64url({ uid: 'oid-e2e', utid: LOCATAIRE }),
      } });
    }
    return route.fulfill({ status: 404, headers: CORS, body: '' });
  });
  return etat;
}

// --- Envois simulés ---
//
// GET …/envois : la réponse du serveur, avec `microsoft365` forcé (et, au besoin, des lignes ajoutées en
// tête du journal). POST …/envois : la messagerie (sans `canal`) passe au vrai serveur ; l'envoi par
// Microsoft 365 reçoit la réponse suivante de la file, sans jamais joindre le serveur.
type ReponseSimulee =
  | { statut: number; json: unknown }
  | { statut: number; html: string }
  | { coupure: true };
type Envois = {
  postes: { canal: unknown; destinataire: unknown; corps: unknown; jeton: string | undefined }[];
  reponses: (ReponseSimulee | (() => Promise<ReponseSimulee>))[];
  journal: unknown[];
  microsoft365: boolean;
};
async function simulerEnvois(page: Page, { microsoft365 = true, journal = [] as unknown[] } = {}): Promise<Envois> {
  const etat: Envois = { postes: [], reponses: [], journal, microsoft365 };
  await page.route(/\/api\/devis\/[^/]+\/envois$/, async (route: Route) => {
    const requete = route.request();
    if (requete.method() === 'GET') {
      const reponse = await route.fetch();
      const json = await reponse.json();
      if (!reponse.ok()) return route.fulfill({ response: reponse, json });
      return route.fulfill({ response: reponse, json: { ...json, proposition: { ...json.proposition, microsoft365: etat.microsoft365 }, envois: [...etat.journal, ...json.envois] } });
    }
    const corps = requete.postDataJSON() as { canal?: unknown; destinataire?: unknown };
    etat.postes.push({ canal: corps.canal, destinataire: corps.destinataire, corps, jeton: requete.headers()['x-jeton-microsoft'] });
    if (corps.canal !== 'MICROSOFT_365') return route.continue();
    const suivante = etat.reponses.shift();
    if (!suivante) return route.fulfill({ status: 599, json: { error: 'Réponse simulée manquante.' } });
    const reponse = typeof suivante === 'function' ? await suivante() : suivante;
    if ('coupure' in reponse) return route.abort('connectionreset');
    if ('html' in reponse) return route.fulfill({ status: reponse.statut, contentType: 'text/html', body: reponse.html });
    return route.fulfill({ status: reponse.statut, json: reponse.json });
  });
  return etat;
}
const enJson = (statut: number, error: string): ReponseSimulee => ({ statut, json: { error } });
const PAGE_NGINX_504 = '<html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center><hr><center>nginx</center></body></html>';

// Réponse 201 du serveur à un envoi par Microsoft 365 (forme de 6b-1b : la ligne du journal avec son
// expéditeur, l'objet, le texte, l'expéditeur, et le statut relu d'un devis).
function envoiFait(n: number, { destinataire, objet, corps, auteurNom, expediteur }: { destinataire: string; objet: string; corps: string; auteurNom: string; expediteur: string }) {
  return {
    statut: 201,
    json: {
      envoi: { id: `envoi-e2e-${n}-${Date.now()}`, canal: 'MICROSOFT_365', destinataire, objet, auteurNom, createdAt: INSTANT_ENVOI, expediteur },
      objet, corps, expediteur, statutDevis: 'ENVOYE',
    },
  } satisfies ReponseSimulee;
}

// Ce qu'Iris garde dans le navigateur : rien dans localStorage qui porte un jeton Microsoft, et dans
// sessionStorage, seulement sous les clés de MSAL (« msal. »).
async function stockage(page: Page) {
  return await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
}
async function aucunJetonHorsDeMsal(page: Page, jetons: string[]) {
  const { local, session } = await stockage(page);
  for (const jeton of jetons) {
    expect(local.filter(([, valeur]) => valeur.includes(jeton)), `jeton dans localStorage`).toEqual([]);
    expect(session.filter(([cle, valeur]) => valeur.includes(jeton) && !cle.startsWith('msal.')).map(([cle]) => cle), 'jeton hors du cache MSAL').toEqual([]);
    await expect(page.locator('body')).not.toContainText(jeton);
  }
}

test('sans connexion Microsoft configurée (configuration de la CI) : pas de bouton Microsoft 365, section « Envois », et la messagerie, touche Entrée comprise, prépare l’envoi comme avant', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  // Cadrage 6b-2 : « Quand il est faux (B1) : pas de bouton « Envoyer par Microsoft 365 » ; le texte
  // d'aide, le bouton « Préparer l’envoi » et les messages de la messagerie sont ceux d'aujourd'hui ;
  // seul le journal du dialogue change » ; « Quand il est faux, [la touche Entrée] prépare l'envoi,
  // comme aujourd'hui ».
  const headers = auth(session.token);
  const client = await creerClient('envoi M365 absent');
  const principal = `principal.${Date.now()}@client-e2e.test`;
  const contact = await request.post(`${api}/clients/${client.id}/contacts`, { headers, data: { nom: 'Principal', email: principal, principal: true } });
  expect(contact.status(), await contact.text()).toBe(201);
  const devis = await creerDevis(request, session.token, client.id, 'E2E Envoi sans M365');
  const lu = await envoisDe(request, session.token, `devis/${devis.id}`);
  expect(lu.proposition.microsoft365).toBe(false);
  const { fuseauHoraire } = await societe(request, session.token);
  const auteur = utilisateur(session).name;

  const page = await allerSurPageAdmin('/devis');
  await page.getByRole('button', { name: `Envoyer le devis ${devis.numero} version 1`, exact: true }).click();
  const dialogue = page.getByRole('dialog', { name: `Envoyer le devis ${devis.numero} version 1` });
  const destinataire = dialogue.getByRole('textbox', { name: 'Destinataire' });
  await expect(destinataire).toHaveValue(principal);
  await expect(dialogue.getByTestId('envoyer-microsoft-365')).toHaveCount(0);
  await expect(dialogue.getByRole('button', { name: 'Envoyer par Microsoft 365' })).toHaveCount(0);
  await expect(dialogue).toContainText(AIDE_MESSAGERIE);
  await expect(dialogue).not.toContainText(AIDE_MICROSOFT_365);
  // Le texte du courriel ne s'affiche que si Microsoft 365 est proposé (N8).
  await expect(dialogue).not.toContainText(`Veuillez trouver ci-joint notre devis ${devis.numero}`);
  await expect(dialogue.getByTestId('preparer-envoi')).toHaveText('Préparer l’envoi');
  await expect(dialogue.getByTestId('preparer-envoi')).toBeEnabled();
  await expect(dialogue.getByTestId('fermer-envoi')).toHaveText('Fermer');

  // Journal du dialogue : « Envois », texte vide inchangé, nouvelle note de bas.
  const section = dialogue.getByRole('region', { name: 'Envois', exact: true });
  await expect(section).toBeVisible();
  await expect(section.getByRole('heading', { name: 'Envois', exact: true })).toBeVisible();
  await expect(section).toContainText('Aucun envoi préparé pour ce document.');
  await expect(section).toContainText(NOTE_JOURNAL);
  await expect(section).not.toContainText(ANCIENNE_NOTE);

  // La touche Entrée dans le champ du destinataire prépare l'envoi par la messagerie, comme aujourd'hui.
  const telechargement = page.waitForEvent('download');
  await destinataire.press('Enter');
  expect((await telechargement).suggestedFilename()).toBe(`${devis.numero}-v1.pdf`);
  await expect(dialogue.getByRole('link', { name: 'Ouvrir la messagerie' })).toBeVisible();
  const [envoi] = (await envoisDe(request, session.token, `devis/${devis.id}`)).envois;
  expect(envoi).toMatchObject({ canal: 'MESSAGERIE', destinataire: principal, expediteur: null });
  await expect(section.getByRole('listitem')).toHaveText([`Envoi préparé le ${dateHeure(envoi.createdAt, fuseauHoraire || 'Europe/Paris')} à ${principal} par ${auteur}`]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('mode messagerie : un envoi par Microsoft 365 déjà noté reste lisible dans la section « Envois », sans bouton Microsoft 365', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  // Cadrage 6b-2, « Journal du dialogue (B1) » : un document peut porter des envois par Microsoft 365
  // faits avant un passage en mode messagerie ; chaque ligne est libellée selon son canal, au fuseau
  // de la société, en JJ-MM-AAAA HH:MM. Le journal est simulé : le serveur des E2E n'envoie rien par
  // Microsoft 365.
  const client = await creerClient('envoi M365 journal');
  const devis = await creerDevis(request, session.token, client.id, 'E2E Journal M365');
  const { fuseauHoraire } = await societe(request, session.token);
  const fuseau = fuseauHoraire || 'Europe/Paris';
  const objet = `Devis ${devis.numero} version 1`;
  const page = await allerSurPageAdmin('/devis');
  const envois = await simulerEnvois(page, {
    microsoft365: false,
    journal: [
      { id: 'e2e-m365', canal: 'MICROSOFT_365', destinataire: 'compta@client-e2e.test', objet, auteurNom: 'Paule Envoi', createdAt: INSTANT_ENVOI, expediteur: 'paule.envoi@societe-e2e.test' },
      { id: 'e2e-messagerie', canal: 'MESSAGERIE', destinataire: 'achats@client-e2e.test', objet, auteurNom: 'Marc Messagerie', createdAt: '2026-10-30T08:05:00.000Z', expediteur: null },
    ],
  });
  await page.getByRole('button', { name: `Envoyer le devis ${devis.numero} version 1`, exact: true }).click();
  const dialogue = page.getByRole('dialog', { name: `Envoyer le devis ${devis.numero} version 1` });
  const section = dialogue.getByRole('region', { name: 'Envois', exact: true });
  await expect(section.getByRole('listitem')).toHaveText([
    `Envoyé par Microsoft 365 le ${dateHeure(INSTANT_ENVOI, fuseau)} à compta@client-e2e.test, depuis paule.envoi@societe-e2e.test, par Paule Envoi`,
    `Envoi préparé le ${dateHeure('2026-10-30T08:05:00.000Z', fuseau)} à achats@client-e2e.test par Marc Messagerie`,
  ]);
  // Au fuseau de Paris, l'envoi du 31-10-2026 à 23:30 UTC est du 01-11-2026 : la date suit la société.
  if (fuseau === 'Europe/Paris') await expect(section.getByRole('listitem').first()).toContainText('le 01-11-2026 00:30 à');
  await expect(section).toContainText(NOTE_JOURNAL);
  await expect(section).not.toContainText('Aucun envoi préparé pour ce document.');
  await expect(dialogue.getByTestId('envoyer-microsoft-365')).toHaveCount(0);
  await expect(dialogue).toContainText(AIDE_MESSAGERIE);
  expect(envois.postes).toEqual([]);
});

test('Microsoft 365 proposé : boutons et textes, touche Entrée sans effet, fenêtre Microsoft puis jeton du cache, en-tête X-Jeton-Microsoft, refus affichés tels quels, et envoi noté en tête du journal', async ({ allerSurPageAdmin, context, creerClient, request, session }) => {
  // Cadrage 6b-2 : « Dialogue d'envoi », « Déclenchement (B3) », « Envoi par Microsoft 365 », classes 1
  // et 5 de la réponse, « Jeton Microsoft dans le navigateur » (choix du compte par l'adresse, N1 ;
  // en silence, puis fenêtre ; fenêtre forcée après le 409 « Microsoft 365 refuse l’envoi… », N6 et
  // V-N4), « Le jeton n'est jamais écrit par Iris ».
  const headers = auth(session.token);
  const compte = utilisateur(session);
  const client = await creerClient('envoi M365 proposé');
  const principal = `principal.${Date.now()}@client-e2e.test`;
  const contact = await request.post(`${api}/clients/${client.id}/contacts`, { headers, data: { nom: 'Principal', email: principal, principal: true } });
  expect(contact.status(), await contact.text()).toBe(201);
  const devis = await creerDevis(request, session.token, client.id, 'E2E Envoi M365');
  const { proposition } = await envoisDe(request, session.token, `devis/${devis.id}`);
  const { fuseauHoraire } = await societe(request, session.token);
  // Le compte Microsoft porte l'adresse du compte Iris dans une autre casse, et un UPN différent : seule
  // la revendication `email`, comparée sans tenir compte de la casse, le retrouve dans le cache (N1).
  const microsoft = await simulerMicrosoft(context, { email: compte.email.toUpperCase(), upn: `upn.distinct.${Date.now()}@locataire-e2e.test` });
  const expediteur = compte.email;

  const page = await allerSurPageAdmin('/devis');
  const envois = await simulerEnvois(page);
  const ligne = page.locator('li', { hasText: devis.objet });
  await expect(ligne).toContainText('v1 · BROUILLON');
  await page.getByRole('button', { name: `Envoyer le devis ${devis.numero} version 1`, exact: true }).click();
  const dialogue = page.getByRole('dialog', { name: `Envoyer le devis ${devis.numero} version 1` });
  const microsoft365 = dialogue.getByTestId('envoyer-microsoft-365');
  const preparer = dialogue.getByTestId('preparer-envoi');
  const fermer = dialogue.getByTestId('fermer-envoi');
  const destinataire = dialogue.getByRole('textbox', { name: 'Destinataire' });
  await expect(destinataire).toHaveValue(principal);

  // Boutons : « Envoyer par Microsoft 365 », de type button, avant « Préparer l’envoi ».
  await expect(microsoft365).toHaveText('Envoyer par Microsoft 365');
  await expect(microsoft365).toHaveAttribute('type', 'button');
  await expect(microsoft365).toBeEnabled();
  await expect(preparer).toHaveText('Préparer l’envoi');
  await expect(preparer).toBeEnabled();
  expect(await microsoft365.evaluate((bouton, autre) => !!(bouton.compareDocumentPosition(autre as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await preparer.elementHandle())).toBe(true);
  await expect(dialogue).toContainText(AIDE_MICROSOFT_365);
  await expect(dialogue).not.toContainText(AIDE_MESSAGERIE);
  // Le texte du courriel s'affiche sous l'objet, en lecture seule : le seul champ modifiable reste le destinataire.
  await expect(dialogue).toContainText(`Objet : ${proposition.objet}`);
  for (const ligneCorps of proposition.corps.split('\n').filter(Boolean)) await expect(dialogue).toContainText(ligneCorps);
  await expect(dialogue.locator('input:not([readonly]):not([type="hidden"]), textarea:not([readonly]), [contenteditable="true"]')).toHaveCount(1);
  await expect(dialogue.getByRole('region', { name: 'Envois', exact: true })).toContainText('Aucun envoi préparé pour ce document.');

  // La touche Entrée dans le champ du destinataire ne déclenche rien : ni fenêtre, ni requête, ni PDF.
  let telechargements = 0;
  page.on('download', () => { telechargements += 1; });
  await destinataire.press('Enter');
  await page.waitForTimeout(800);
  expect(microsoft.demandes).toHaveLength(0);
  expect(envois.postes).toEqual([]);
  expect(telechargements).toBe(0);
  await expect(dialogue.getByText(EN_COURS)).toHaveCount(0);
  await expect(microsoft365).toBeEnabled();

  // 1. Fenêtre Microsoft (aucun compte dans le cache), permissions Mail.Send et User.Read, adresse du
  //    compte Iris proposée. Microsoft 365 refuse (502 en JSON, classe 5) : le message du serveur tel
  //    quel, rien n'est noté, les deux boutons restent proposés.
  envois.reponses.push(enJson(502, SERVEUR.refuse));
  await microsoft365.click();
  await expect(dialogue.getByRole('alert')).toHaveText(SERVEUR.refuse);
  expect(microsoft.demandes).toHaveLength(1);
  const portee = (microsoft.demandes[0].searchParams.get('scope') || '').split(' ');
  expect(portee).toEqual(expect.arrayContaining(['Mail.Send', 'User.Read']));
  expect(portee.filter((p) => /^Mail\./i.test(p))).toEqual(['Mail.Send']);
  expect(microsoft.demandes[0].searchParams.get('login_hint')).toBe(compte.email);
  expect(envois.postes).toEqual([{ canal: 'MICROSOFT_365', destinataire: principal, corps: { destinataire: principal, canal: 'MICROSOFT_365' }, jeton: microsoft.jetons[0] }]);
  await expect(microsoft365).toBeEnabled();
  await expect(preparer).toBeEnabled();
  await expect(fermer).toBeEnabled();
  await expect(dialogue.getByRole('region', { name: 'Envois', exact: true })).toContainText('Aucun envoi préparé pour ce document.');

  // 2. Le jeton se reprend du cache, sans fenêtre, pour le compte dont l'adresse est celle du compte
  //    Iris. Microsoft 365 refuse l'accès (409) : message tel quel, boutons proposés.
  envois.reponses.push(enJson(409, SERVEUR.accesRefuse));
  await microsoft365.click();
  await expect(dialogue.getByRole('alert')).toHaveText(SERVEUR.accesRefuse);
  expect(microsoft.demandes).toHaveLength(1);
  expect(envois.postes.at(-1)?.jeton).toBe(microsoft.jetons[0]);
  await expect(microsoft365).toBeEnabled();
  await expect(preparer).toBeEnabled();

  // 3. Après ce 409, la tentative suivante passe directement par la fenêtre (nouveau jeton). Envoi fait
  //    (201) : message de succès en role="status", ligne en tête du journal, statut du devis suivi.
  envois.reponses.push(envoiFait(1, { destinataire: principal, objet: proposition.objet, corps: proposition.corps, auteurNom: compte.name, expediteur }));
  await microsoft365.click();
  await expect(dialogue.getByRole('status')).toHaveText(`Courriel envoyé par Microsoft 365 à ${principal}, depuis ${expediteur}.`);
  expect(microsoft.demandes).toHaveLength(2);
  expect(microsoft.jetons).toHaveLength(2);
  expect(envois.postes.at(-1)).toEqual({ canal: 'MICROSOFT_365', destinataire: principal, corps: { destinataire: principal, canal: 'MICROSOFT_365' }, jeton: microsoft.jetons[1] });
  await expect(dialogue.getByRole('alert')).toHaveCount(0);
  await expect(dialogue.getByRole('region', { name: 'Envois', exact: true }).getByRole('listitem')).toHaveText([
    `Envoyé par Microsoft 365 le ${dateHeure(INSTANT_ENVOI, fuseauHoraire || 'Europe/Paris')} à ${principal}, depuis ${expediteur}, par ${compte.name}`,
  ]);
  await expect(ligne).toContainText('v1 · ENVOYE');
  expect(envois.postes.every((poste) => poste.canal === 'MICROSOFT_365')).toBe(true);
  expect(telechargements).toBe(0);

  // Le jeton n'est écrit ni dans localStorage, ni hors du cache MSAL, ni à l'écran.
  await aucunJetonHorsDeMsal(page, microsoft.jetons);
  // Rien n'a joint le serveur : le journal réel du devis reste vide.
  expect((await envoisDe(request, session.token, `devis/${devis.id}`)).envois).toEqual([]);

  // La déconnexion d'Iris vide le cache MSAL de l'onglet (cadrage, « Cache MSAL »).
  const { session: avant } = await stockage(page);
  expect(avant.some(([, valeur]) => valeur.includes(microsoft.jetons[1]))).toBe(true);
  await page.getByRole('button', { name: 'Déconnexion' }).click();
  await page.waitForURL('**/login');
  await expect.poll(async () => (await stockage(page)).session.filter(([, valeur]) => microsoft.jetons.some((jeton) => valeur.includes(jeton))).map(([cle]) => cle)).toEqual([]);
});

test('Microsoft 365 proposé : issue inconnue, cas (b) et cas (c) gardent l’envoi désactivé jusqu’à la fermeture du dialogue, avec leurs messages exacts', async ({ allerSurPageAdmin, context, creerClient, request, session }) => {
  // Cadrage 6b-2, « Réponse de l'envoi par Microsoft 365 (B2) » et « État des boutons après la
  // réponse » : classe 2 (fetch rejeté, réponse qui n'est pas du JSON), 3 (504 en JSON), 4 (500 au
  // message exact du serveur), 5 (tout autre statut en JSON, dont un 500 d'un autre message).
  const compte = utilisateur(session);
  const client = await creerClient('envoi M365 classes');
  const devis = await creerDevis(request, session.token, client.id, 'E2E Classes M365');
  const microsoft = await simulerMicrosoft(context, { email: compte.email, upn: compte.email });
  const page = await allerSurPageAdmin('/devis');
  const envois = await simulerEnvois(page);
  const ligne = page.locator('li', { hasText: devis.objet });
  const ouvrir = page.getByRole('button', { name: `Envoyer le devis ${devis.numero} version 1`, exact: true });
  const dialogue = page.getByRole('dialog', { name: `Envoyer le devis ${devis.numero} version 1` });
  const microsoft365 = dialogue.getByTestId('envoyer-microsoft-365');
  const preparer = dialogue.getByTestId('preparer-envoi');
  const fermer = dialogue.getByTestId('fermer-envoi');
  const adresse = `classes.${Date.now()}@client-e2e.test`;
  const envoyer = async (reponse: ReponseSimulee) => {
    await ouvrir.click();
    await dialogue.getByRole('textbox', { name: 'Destinataire' }).fill(adresse);
    await expect(microsoft365).toBeEnabled();
    envois.reponses.push(reponse);
    await microsoft365.click();
  };
  const refermer = async () => {
    await fermer.click();
    await expect(dialogue).toHaveCount(0);
  };

  // Classe 3, cas (b) : 504 en JSON, message du serveur tel quel. Microsoft 365 désactivé, la messagerie
  // reste proposée (l'utilisateur s'en sert après avoir vérifié Outlook).
  await envoyer(enJson(504, SERVEUR.incertain));
  await expect(dialogue.getByRole('alert')).toHaveText(SERVEUR.incertain);
  await expect(microsoft365).toBeDisabled();
  await expect(preparer).toBeEnabled();
  await expect(fermer).toBeEnabled();
  await expect(dialogue.getByRole('status')).toHaveCount(0);
  await refermer();

  // Rouvert, le dialogue propose de nouveau Microsoft 365 (N9). Classe 2 : un 504 de nginx, en HTML.
  await envoyer({ statut: 504, html: PAGE_NGINX_504 });
  await expect(dialogue.getByRole('alert')).toHaveText(ISSUE_INCONNUE);
  await expect(microsoft365).toBeDisabled();
  await expect(preparer).toBeEnabled();
  await refermer();

  // Classe 2 : la requête échoue sans réponse (coupure).
  await envoyer({ coupure: true });
  await expect(dialogue.getByRole('alert')).toHaveText(ISSUE_INCONNUE);
  await expect(microsoft365).toBeDisabled();
  await expect(preparer).toBeEnabled();
  await refermer();

  // Classe 5 : un 500 d'un autre message est un refus certain ; les deux boutons restent proposés.
  await envoyer(enJson(500, 'Opération devis impossible.'));
  await expect(dialogue.getByRole('alert')).toHaveText('Opération devis impossible.');
  await expect(microsoft365).toBeEnabled();
  await expect(preparer).toBeEnabled();
  await refermer();

  // Classe 4, cas (c) : le courriel est parti, mais n'est pas noté. « Ne le renvoyez pas » : les deux
  // boutons d'envoi sont désactivés, et le statut du devis ne change pas à l'écran.
  await envoyer(enJson(500, SERVEUR.nonNote));
  await expect(dialogue.getByRole('alert')).toHaveText(new RegExp(`^${echapper(SERVEUR.nonNote)}\\s*${echapper(NE_PAS_RENVOYER)}$`));
  await expect(microsoft365).toBeDisabled();
  await expect(preparer).toBeDisabled();
  await expect(fermer).toBeEnabled();
  await expect(ligne).toContainText('v1 · BROUILLON');
  await expect(dialogue.getByRole('region', { name: 'Envois', exact: true })).toContainText('Aucun envoi préparé pour ce document.');
  await refermer();

  // Une seule fenêtre Microsoft : les envois suivants reprennent le jeton du cache.
  expect(microsoft.demandes).toHaveLength(1);
  expect(envois.postes).toHaveLength(5);
  expect(envois.postes.every((poste) => poste.jeton === microsoft.jetons[0] && poste.canal === 'MICROSOFT_365' && poste.destinataire === adresse)).toBe(true);
  await aucunJetonHorsDeMsal(page, microsoft.jetons);
});

test('Microsoft 365 proposé : pendant un envoi lent, les boutons et « Fermer » sont désactivés, et le verrou suit le document quand son dialogue est remplacé puis rouvert', async ({ allerSurPageAdmin, context, creerClient, request, session }) => {
  // Cadrage 6b-2, « Pendant l'envoi (B3) » et « Verrou par document (V-N8) ».
  const compte = utilisateur(session);
  const client = await creerClient('envoi M365 lent');
  // Un contact principal : chaque dialogue s'ouvre avec un destinataire, et ses boutons ne sont désactivés
  // que par le verrou.
  const adresse = `lent.${Date.now()}@client-e2e.test`;
  const contact = await request.post(`${api}/clients/${client.id}/contacts`, { headers: auth(session.token), data: { nom: 'Principal', email: adresse, principal: true } });
  expect(contact.status(), await contact.text()).toBe(201);
  const premier = await creerDevis(request, session.token, client.id, 'E2E Envoi lent');
  const second = await creerDevis(request, session.token, client.id, 'E2E Envoi voisin');
  const microsoft = await simulerMicrosoft(context, { email: compte.email, upn: compte.email });
  const page = await allerSurPageAdmin('/devis');
  const envois = await simulerEnvois(page);
  let liberer: () => void = () => {};
  const retenue = new Promise<void>((resolve) => { liberer = resolve; });
  try {
    // La réponse, retenue, sera un refus certain (classe 5) : après elle, les deux boutons sont de nouveau
    // proposés, ce qui montre le verrou levé sans dépendre de l'état après un envoi fait, que le cadrage
    // ne fixe pas.
    envois.reponses.push(async () => {
      await retenue;
      return enJson(502, SERVEUR.refuse);
    });
    const ouvrirPremier = page.getByRole('button', { name: `Envoyer le devis ${premier.numero} version 1`, exact: true });
    const dialoguePremier = page.getByRole('dialog', { name: `Envoyer le devis ${premier.numero} version 1` });
    await ouvrirPremier.click();
    await expect(dialoguePremier.getByRole('textbox', { name: 'Destinataire' })).toHaveValue(adresse);
    await dialoguePremier.getByTestId('envoyer-microsoft-365').click();

    // Pendant l'envoi : « Envoi… », les deux boutons et « Fermer » désactivés, message en role="status".
    await expect(dialoguePremier.getByTestId('envoyer-microsoft-365')).toHaveText('Envoi…');
    await expect(dialoguePremier.getByTestId('envoyer-microsoft-365')).toBeDisabled();
    await expect(dialoguePremier.getByTestId('preparer-envoi')).toBeDisabled();
    await expect(dialoguePremier.getByTestId('fermer-envoi')).toBeDisabled();
    await expect(dialoguePremier.getByRole('status')).toHaveText(EN_COURS);
    await expect.poll(() => envois.postes.length).toBe(1);

    // Le dialogue d'un autre devis remplace le premier : son envoi reste libre (verrou par document).
    await page.getByRole('button', { name: `Envoyer le devis ${second.numero} version 1`, exact: true }).click();
    const dialogueSecond = page.getByRole('dialog', { name: `Envoyer le devis ${second.numero} version 1` });
    await expect(dialogueSecond.getByRole('textbox', { name: 'Destinataire' })).toHaveValue(adresse);
    await expect(dialogueSecond.getByTestId('envoyer-microsoft-365')).toBeEnabled();
    await expect(dialogueSecond.getByTestId('preparer-envoi')).toBeEnabled();
    await expect(dialogueSecond.getByText(EN_COURS)).toHaveCount(0);
    await expect(dialoguePremier).toHaveCount(0);

    // Rouvert pendant l'envoi, le premier devis trouve l'envoi en cours : ses boutons d'envoi sont
    // désactivés, avec le même message, et aucun second envoi ne part.
    await ouvrirPremier.click();
    await expect(dialoguePremier.getByRole('textbox', { name: 'Destinataire' })).toHaveValue(adresse);
    await expect(dialoguePremier.getByTestId('envoyer-microsoft-365')).toBeDisabled();
    await expect(dialoguePremier.getByTestId('preparer-envoi')).toBeDisabled();
    await expect(dialoguePremier.getByText(EN_COURS)).toBeVisible();
    await page.waitForTimeout(300);
    expect(envois.postes).toHaveLength(1);

    // La réponse arrive : le verrou du document se lève, dans le dialogue rouvert aussi.
    liberer();
    await expect(dialoguePremier.getByText(EN_COURS)).toHaveCount(0);
    await expect(dialoguePremier.getByTestId('envoyer-microsoft-365')).toBeEnabled();
    await expect(dialoguePremier.getByTestId('preparer-envoi')).toBeEnabled();
    expect(envois.postes).toHaveLength(1);
    expect(microsoft.demandes).toHaveLength(1);
  } finally {
    liberer();
  }
});

test('Microsoft 365 proposé : Microsoft refuse la connexion dans sa fenêtre, rien n’est envoyé et seul le code de l’erreur s’affiche ; à 375 px le dialogue tient sans défilement horizontal', async ({ allerSurPageAdmin, context, creerClient, request, session }) => {
  // Cadrage 6b-2, « Erreurs de la fenêtre Microsoft » : « autre erreur : « Connexion Microsoft
  // impossible : rien n’a été envoyé. Vous pouvez préparer l’envoi par la messagerie. ». Seul le code de
  // l'erreur MSAL suit ce texte, sans son message ni le jeton » (N6). Ici, Microsoft renvoie
  // `access_denied` (consentement refusé). Dialogue sur mobile.
  const compte = utilisateur(session);
  const client = await creerClient('envoi M365 refusé');
  const devis = await creerDevis(request, session.token, client.id, 'E2E Fenêtre refusée');
  const microsoft = await simulerMicrosoft(context, { email: compte.email, upn: compte.email });
  microsoft.comportement = 'refuser';
  const page = await allerSurPageAdmin('/devis');
  await page.setViewportSize({ width: 375, height: 800 });
  const envois = await simulerEnvois(page);
  const bouton = page.getByRole('button', { name: `Envoyer le devis ${devis.numero} version 1`, exact: true });
  await bouton.scrollIntoViewIfNeeded();
  await bouton.click();
  const dialogue = page.getByRole('dialog', { name: `Envoyer le devis ${devis.numero} version 1` });
  await dialogue.getByRole('textbox', { name: 'Destinataire' }).fill(`refuse.${Date.now()}@client-e2e.test`);
  const microsoft365 = dialogue.getByTestId('envoyer-microsoft-365');
  await expect(microsoft365).toBeVisible();
  await sansDebordement(page, 375, [dialogue, microsoft365, dialogue.getByTestId('preparer-envoi'), dialogue.getByTestId('fermer-envoi'), dialogue.getByText(AIDE_MICROSOFT_365)]);

  await microsoft365.click();
  const alerte = dialogue.getByRole('alert');
  await expect(alerte).toHaveText(new RegExp(`^${echapper(IMPOSSIBLE)}`));
  expect(microsoft.demandes).toHaveLength(1);
  const suite = (await alerte.textContent() || '').slice(IMPOSSIBLE.length);
  expect(suite).toContain('access_denied');
  expect(suite.replace('access_denied', '')).toMatch(/^[\s[\]():]*$/);
  await expect(alerte).not.toContainText('AADSTS');
  // Rien n'est parti : ni jeton, ni requête d'envoi ; l'envoi n'est plus en cours.
  expect(microsoft.jetons).toEqual([]);
  expect(envois.postes).toEqual([]);
  await expect(dialogue.getByText(EN_COURS)).toHaveCount(0);
  await expect(dialogue.getByTestId('fermer-envoi')).toBeEnabled();
  await expect(dialogue.getByTestId('preparer-envoi')).toBeEnabled();
  await sansDebordement(page, 375, [dialogue, alerte]);
});

test('Microsoft 365 proposé : la fenêtre Microsoft fermée par l’utilisateur ne fait rien partir, et le dialogue se libère avec le seul code de l’erreur', async ({ allerSurPageAdmin, context, creerClient, request, session }) => {
  // Limite de MSAL Browser 5.16, déclarée dans la PR : la fermeture de la fenêtre n'est pas détectée.
  // MSAL attend la réponse de la page de retour pendant `popupBridgeTimeout` (60 s par défaut), puis
  // rend `timed_out` : le message est alors « Connexion Microsoft impossible : … », suivi de ce seul
  // code (cadrage 6b-2, « Erreurs de la fenêtre Microsoft », N6), et non « Connexion Microsoft annulée »,
  // qui ne vient que d'une annulation rendue par Microsoft. Pendant l'attente, l'envoi est en cours
  // (jeton compris, B3) : aucune requête ne part.
  test.setTimeout(150_000);
  const compte = utilisateur(session);
  const client = await creerClient('envoi M365 fenêtre fermée');
  const devis = await creerDevis(request, session.token, client.id, 'E2E Fenêtre fermée');
  const microsoft = await simulerMicrosoft(context, { email: compte.email, upn: compte.email });
  microsoft.comportement = 'laisser';
  const page = await allerSurPageAdmin('/devis');
  const envois = await simulerEnvois(page);
  await page.getByRole('button', { name: `Envoyer le devis ${devis.numero} version 1`, exact: true }).click();
  const dialogue = page.getByRole('dialog', { name: `Envoyer le devis ${devis.numero} version 1` });
  await dialogue.getByRole('textbox', { name: 'Destinataire' }).fill(`ferme.${Date.now()}@client-e2e.test`);
  const fenetre = page.waitForEvent('popup');
  await dialogue.getByTestId('envoyer-microsoft-365').click();
  const popup = await fenetre;
  await expect.poll(() => microsoft.demandes.length).toBe(1);
  await expect(dialogue.getByText(EN_COURS)).toBeVisible();
  await popup.close();
  const alerte = dialogue.getByRole('alert');
  await expect(alerte).toHaveText(new RegExp(`^${echapper(IMPOSSIBLE)}`), { timeout: 80_000 });
  const suite = (await alerte.textContent() || '').slice(IMPOSSIBLE.length);
  expect(suite).toContain('timed_out');
  expect(suite.replace('timed_out', '')).toMatch(/^[\s[\]():]*$/);
  expect(microsoft.jetons).toEqual([]);
  expect(envois.postes).toEqual([]);
  await expect(dialogue.getByText(EN_COURS)).toHaveCount(0);
  await expect(dialogue.getByTestId('fermer-envoi')).toBeEnabled();
});

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable ouvre une
// session dans un rôle autre que super administrateur.
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

test('super administrateur : il règle le mode d’envoi dans Modules, et le journal d’administration le dit en clair ; un administrateur n’y a pas accès', async ({ allerSurPageAdmin, browser, request, session }) => {
  // Cadrage 6b-2, « Administration » : bloc « Mode d’envoi des documents » de l'onglet Modules,
  // réservé au super administrateur ; messages après le réglage (V-N5) ; libellés du journal
  // d'administration (C-N1 de #410). La base des E2E est partagée : le mode d'origine est remis à la fin (N4).
  const headers = auth(session.token);
  const lireModules = async () => {
    const lu = await request.get(`${api}/modules`, { headers });
    expect(lu.status(), await lu.text()).toBe(200);
    return await lu.json() as { modeEnvoi: string; planningActifGlobal: boolean };
  };
  const origine = await lireModules();
  const suffixe = Date.now();
  const creation = await request.post(`${api}/users`, { headers, data: { email: `mode.envoi.${suffixe}@iris.test`, name: `Admin mode ${suffixe}`, role: 'ADMIN' } });
  expect(creation.ok(), await creation.text()).toBeTruthy();
  const admin = await creation.json() as { id: string };
  const contexteAdmin = await browser.newContext();
  try {
    const depart = await request.put(`${api}/modules`, { headers, data: { modeEnvoi: 'MICROSOFT_365' } });
    expect(depart.status(), await depart.text()).toBe(200);

    const page = await allerSurPageAdmin('/admin');
    await page.getByRole('button', { name: 'Modules', exact: true }).click();
    const bloc = page.getByTestId('mode-envoi');
    const boutonMicrosoft = bloc.getByTestId('mode-envoi-microsoft-365');
    const boutonMessagerie = bloc.getByTestId('mode-envoi-messagerie');
    await expect(bloc).toContainText('Mode d’envoi des documents');
    await expect(bloc).toContainText('Choisissez comment les documents (devis, factures et avoirs, comptes rendus, contrats, rapports de chantier) peuvent être envoyés. La messagerie de l’utilisateur reste toujours proposée.');
    await expect(bloc).toContainText('Mode actuel : Microsoft 365');
    await expect(boutonMicrosoft).toHaveText('Microsoft 365');
    await expect(boutonMessagerie).toHaveText('Messagerie seule');
    await expect(boutonMicrosoft).toBeDisabled();
    await expect(boutonMessagerie).toBeEnabled();
    // Serveur des E2E sans connexion Microsoft : le super administrateur sait pourquoi rien ne sera proposé.
    await expect(bloc).toContainText('La connexion Microsoft 365 n’est pas configurée sur ce serveur : l’envoi par Microsoft 365 ne sera pas proposé, quel que soit le mode.');

    await boutonMessagerie.click();
    await expect(bloc).toContainText('L’envoi par Microsoft 365 est désactivé : seule la messagerie est proposée.');
    await expect(bloc).toContainText('Mode actuel : Messagerie seule');
    await expect(boutonMessagerie).toBeDisabled();
    await expect(boutonMicrosoft).toBeEnabled();
    expect(await lireModules()).toMatchObject({ modeEnvoi: 'MESSAGERIE', planningActifGlobal: origine.planningActifGlobal });

    // Connexion non configurée : le retour à Microsoft 365 ne promet pas d'envoi (V-N5).
    await boutonMicrosoft.click();
    await expect(bloc).toContainText('Mode d’envoi : Microsoft 365.');
    await expect(bloc).not.toContainText('Les documents peuvent de nouveau partir par Microsoft 365.');
    await expect(bloc).toContainText('Mode actuel : Microsoft 365');
    expect((await lireModules()).modeEnvoi).toBe('MICROSOFT_365');

    // Connexion configurée (GET /api/config simulé) : le message le dit, sans l'avertissement.
    await simulerConfiguration(page);
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Modules', exact: true }).click();
    await expect(bloc).toContainText('Mode actuel : Microsoft 365');
    await expect(bloc).not.toContainText('La connexion Microsoft 365 n’est pas configurée sur ce serveur');
    await boutonMessagerie.click();
    await expect(bloc).toContainText('L’envoi par Microsoft 365 est désactivé : seule la messagerie est proposée.');
    await boutonMicrosoft.click();
    await expect(bloc).toContainText('Les documents peuvent de nouveau partir par Microsoft 365.');
    expect(await lireModules()).toMatchObject({ modeEnvoi: 'MICROSOFT_365', planningActifGlobal: origine.planningActifGlobal });

    // Journal d'administration : le réglage et ses valeurs en clair, jamais leurs codes.
    await page.getByRole('button', { name: 'Journal', exact: true }).click();
    const lignes = page.getByRole('table', { name: 'Entrées du journal' }).locator('tbody tr', { hasText: 'Mode d’envoi des documents' });
    const [retour, coupure] = [lignes.nth(0), lignes.nth(1)];
    await expect(retour.locator('td')).toHaveText([/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}$/, utilisateur(session).name, 'Modules', 'Modification', 'Mode d’envoi des documents', 'Mode d’envoi des documents : Messagerie seule', 'Mode d’envoi des documents : Microsoft 365']);
    await expect(coupure.locator('td')).toHaveText([/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}$/, utilisateur(session).name, 'Modules', 'Modification', 'Mode d’envoi des documents', 'Mode d’envoi des documents : Microsoft 365', 'Mode d’envoi des documents : Messagerie seule']);
    for (const ligne of [retour, coupure]) {
      await expect(ligne).not.toContainText('MICROSOFT_365');
      await expect(ligne).not.toContainText('MESSAGERIE');
      await expect(ligne).not.toContainText('modeEnvoi');
    }

    // Un administrateur n'a ni l'onglet Modules ni le bloc du mode.
    const pageAdmin = await contexteAdmin.newPage();
    await pageAdmin.addInitScript(([token, user]) => {
      localStorage.setItem('token', token as string);
      localStorage.setItem('user', user as string);
    }, [jetonPour(admin.id), JSON.stringify({ id: admin.id, name: `Admin mode ${suffixe}`, email: `mode.envoi.${suffixe}@iris.test`, role: 'ADMIN', permissions: [] })]);
    await pageAdmin.goto('/admin', { waitUntil: 'networkidle' });
    await expect(pageAdmin.getByRole('button', { name: 'Journal', exact: true })).toBeVisible();
    await expect(pageAdmin.getByRole('button', { name: 'Modules', exact: true })).toHaveCount(0);
    await expect(pageAdmin.getByTestId('mode-envoi')).toHaveCount(0);
  } finally {
    await contexteAdmin.close();
    await request.put(`${api}/modules`, { headers, data: { modeEnvoi: origine.modeEnvoi } });
  }
});

test('page de connexion : l’instance MSAL partagée ouvre la fenêtre Microsoft comme avant, sans les permissions de l’envoi, et « Retour à la connexion » vide le cache MSAL de l’onglet', async ({ context, page }) => {
  // Cadrage 6b-2 : « La page de connexion (Login.tsx) l'utilise sans changer de comportement » ; les
  // permissions de l'envoi ne sont demandées qu'au premier envoi (vision, « demandées progressivement ») ;
  // « Cache MSAL » : à la déconnexion par AccesRefuse.tsx, le cache est vidé, par le retrait des clés
  // MSAL du sessionStorage quand l'instance n'existe pas (ici, après un rechargement de la page).
  const adresse = `refuse.${Date.now()}@locataire-e2e.test`;
  const microsoft = await simulerMicrosoft(context, { email: adresse, upn: adresse });
  let jetonIdentite = '';
  await context.route('**/api/auth/sso', async (route) => {
    jetonIdentite = (route.request().postDataJSON() as { idToken?: string }).idToken || '';
    await route.fulfill({ status: 403, json: { error: 'Compte non autorisé.' } });
  });
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Connexion Microsoft 365' }).click();
  await page.waitForURL('**/acces-refuse');
  expect(microsoft.demandes).toHaveLength(1);
  const portee = (microsoft.demandes[0].searchParams.get('scope') || '').split(' ');
  expect(portee).toEqual(expect.arrayContaining(['openid', 'profile', 'email']));
  expect(portee).not.toContain('Mail.Send');
  expect(portee).not.toContain('User.Read');
  expect(jetonIdentite.split('.')).toHaveLength(3);
  expect(JSON.parse(Buffer.from(jetonIdentite.split('.')[1], 'base64url').toString())).toMatchObject({ email: adresse, aud: APPLICATION });
  // Le cache MSAL de l'onglet garde le compte et ses jetons…
  const avant = (await stockage(page)).session.filter(([, valeur]) => valeur.includes(jetonIdentite) || valeur.includes(microsoft.jetons[0]));
  expect(avant.length).toBeGreaterThan(0);
  expect(avant.every(([cle]) => cle.startsWith('msal.'))).toBe(true);
  // … jusqu'à « Retour à la connexion », même après un rechargement qui a perdu l'instance.
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Retour à la connexion' }).click();
  await page.waitForURL('**/login');
  await expect.poll(async () => (await stockage(page)).session.filter(([, valeur]) => valeur.includes(jetonIdentite) || valeur.includes(microsoft.jetons[0])).map(([cle]) => cle)).toEqual([]);
  expect((await stockage(page)).local.filter(([, valeur]) => valeur.includes(microsoft.jetons[0]))).toEqual([]);
});
