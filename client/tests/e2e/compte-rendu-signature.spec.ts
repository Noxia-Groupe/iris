import { createHmac, randomUUID } from 'node:crypto';
import type { APIRequestContext, Browser, Locator, Page, Route } from '@playwright/test';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable
// ouvre une session dans un rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

type Compte = { id: string; name: string; email: string; role: string };

// Téléphone (375 px) : le technicien remplit le compte rendu et fait signer sur place.
async function pageTelephone(browser: Browser, compte: Compte) {
  const contexte = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await contexte.newPage();
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jetonPour(compte.id), JSON.stringify({ ...compte, permissions: ['chantiers:read', 'clients:read'] })]);
  return page;
}

// Aucune fenêtre du navigateur (prompt, confirm, alert) ne doit s'ouvrir dans ces parcours.
function interdireFenetres(page: Page) {
  const fenetres: string[] = [];
  page.on('dialog', (dialogue) => { fenetres.push(`${dialogue.type()} : ${dialogue.message()}`); void dialogue.dismiss(); });
  return fenetres;
}

// Dessine au pointeur une signature en zigzag dans la zone prévue.
async function dessinerSignature(page: Page, zone: Locator) {
  await zone.scrollIntoViewIfNeeded();
  const cadre = await zone.boundingBox();
  if (!cadre) throw new Error('zone de signature invisible');
  const points = [[0.1, 0.6], [0.22, 0.3], [0.34, 0.7], [0.48, 0.35], [0.62, 0.65], [0.8, 0.4]];
  const position = ([x, y]: number[]) => [cadre.x + cadre.width * x, cadre.y + cadre.height * y] as const;
  await page.mouse.move(...position(points[0]));
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(...position(point), { steps: 6 });
  await page.mouse.up();
}

async function preparer(request: APIRequestContext, token: string, creerClient: (libelle: string) => Promise<{ id: string }>, libelle: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const envoyer = async (methode: 'post' | 'put' | 'patch', path: string, data: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const technicien: Compte = await envoyer('post', '/users', { email: `${libelle}.${suffixe}@iris.test`, name: `Technicien ${libelle} ${suffixe}`, role: 'TECHNICIEN' });
  const fiche = await envoyer('post', '/intervenants', { nom: `Fiche ${libelle} ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 40 });
  await envoyer('put', `/intervenants/${fiche.id}/compte`, { userId: technicien.id });
  const client = await creerClient(libelle);
  const titre = `Intervention ${libelle} ${suffixe}`;
  const intervention = await envoyer('post', '/interventions', { clientId: client.id, titre });
  const jour = dateDuJour().split('-').reverse().join('-');
  await envoyer('put', `/interventions/${intervention.id}/planning`, { dateDebut: jour, creneau: 'HEURES', heureDebut: '08:30', heureFin: '09:30', intervenantIds: [fiche.id] });
  await envoyer('patch', `/interventions/${intervention.id}/statut`, { statut: 'EN_COURS' });
  return { technicien, intervention, titre, headers };
}

// Lot pilote 3b-3 : compte rendu et signature dessinée au doigt, sans fenêtre du navigateur ; un
// envoi répété après une réponse perdue n'enregistre pas un second compte rendu ; terminer exige un
// compte rendu signé (décisions de Nelson des 19 et 20-10-2026).
test('sur téléphone, le technicien rédige le compte rendu, le fait signer au doigt, puis termine', async ({ session, request, creerClient, browser }) => {
  const { technicien, intervention, titre, headers } = await preparer(request, session.token, creerClient, 'signature-doigt');
  const page = await pageTelephone(browser, technicien);
  const fenetres = interdireFenetres(page);
  try {
    await page.goto('/interventions', { waitUntil: 'networkidle' });
    const carte = page.locator('article', { hasText: titre });

    // 1. Terminer sans compte rendu : le formulaire de clôture le demande d'abord.
    await carte.getByRole('button', { name: 'Terminer' }).click();
    const cloture = carte.getByRole('dialog', { name: 'Terminer l’intervention' });
    await expect(cloture.getByText('Un compte rendu est obligatoire pour terminer l’intervention.')).toBeVisible();
    await cloture.getByRole('button', { name: 'Rédiger le compte rendu' }).click();

    // 2. Compte rendu : une seule requête malgré deux soumissions ; la réponse de la première est
    // perdue après son enregistrement ; le nouvel envoi relit le compte rendu, sans doublon.
    const formulaire = carte.getByRole('dialog', { name: 'Compte rendu d’intervention' });
    const texte = `Détecteur remplacé, essai concluant ${Date.now()}.`;
    await formulaire.getByLabel('Texte du compte rendu').fill(texte);
    const cheminRapports = `/api/interventions/${intervention.id}/rapports`;
    const envois: string[] = [];
    page.on('request', (requete) => { if (requete.method() === 'POST' && new URL(requete.url()).pathname === cheminRapports) envois.push(requete.postData() || ''); });
    let liberer!: () => void;
    const relache = new Promise<void>((resolve) => { liberer = resolve; });
    let rang = 0;
    await page.route(`**${cheminRapports}`, async (route: Route) => {
      rang += 1;
      if (rang > 1) return route.continue();
      await relache;
      const reponse = await route.fetch();
      expect(reponse.status(), 'le premier envoi est bien enregistré par le serveur').toBe(201);
      await route.abort('failed');
    });
    await formulaire.evaluate((element) => { (element as HTMLFormElement).requestSubmit(); (element as HTMLFormElement).requestSubmit(); });
    await expect(formulaire.getByRole('button', { name: 'Enregistrement…' })).toBeDisabled();
    await expect.poll(() => envois.length).toBe(1);
    liberer();
    await expect(formulaire.getByRole('alert')).toContainText('n’a pas pu être confirmé');
    expect(envois.length, 'aucun second envoi pendant le premier').toBe(1);
    const renvoi = page.waitForResponse((reponse) => reponse.request().method() === 'POST' && new URL(reponse.url()).pathname === cheminRapports);
    await formulaire.getByRole('button', { name: 'Enregistrer le compte rendu' }).click();
    expect((await renvoi).status(), 'compte rendu relu par sa clé d’envoi').toBe(200);
    await expect(formulaire).toHaveCount(0);
    expect(new Set(envois.map((corps) => JSON.parse(corps).cleEnvoi)).size, 'même clé d’envoi pour le renvoi').toBe(1);
    await expect(carte.getByText(texte)).toHaveCount(1);
    const liste = await (await request.get(`${api}/interventions`, { headers })).json() as { id: string; rapports: { contenu: string }[] }[];
    expect(liste.find((item) => item.id === intervention.id)!.rapports.map((rapport) => rapport.contenu)).toEqual([texte]);

    // 3. Signature : nom, confirmation et tracé sont exigés ; le tracé se dessine au doigt.
    await carte.getByRole('button', { name: 'Faire signer ce compte rendu' }).click();
    const signature = carte.getByRole('dialog', { name: 'Signature du client' });
    const enregistrerSignature = signature.getByRole('button', { name: 'Enregistrer la signature' });
    await expect(signature.getByLabel('Enregistré par')).toHaveValue(technicien.name);
    await signature.getByLabel('Nom du signataire client').fill('Marie Client');
    await signature.getByLabel('Confirmation du client').check();
    await expect(enregistrerSignature, 'sans tracé, pas de signature').toBeDisabled();
    const zone = signature.getByRole('img', { name: 'Zone de signature du client' });
    await dessinerSignature(page, zone);
    await expect(signature.getByText('Signature dessinée.')).toBeVisible();
    // Le formulaire se ferme à l'enregistrement : les dimensions de la zone se relèvent avant.
    const cadre = (await zone.boundingBox())!;
    const signe = page.waitForResponse((reponse) => reponse.request().method() === 'POST' && reponse.url().endsWith('/signature'));
    await enregistrerSignature.click();
    const reponseSignature = await signe;
    expect(reponseSignature.status()).toBe(201);
    const corps = reponseSignature.request().postDataJSON() as { trace: { ratio: number; traits: number[][][] } };
    expect(corps.trace.ratio).toBeCloseTo(cadre.width / cadre.height, 1);
    expect(corps.trace.traits).toHaveLength(1);
    expect(corps.trace.traits[0].length, 'le trait garde ses points intermédiaires').toBeGreaterThan(6);
    for (const [x, y] of corps.trace.traits[0]) {
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(1);
    }
    await expect(signature).toHaveCount(0);
    await expect(carte.getByText(/Signé par Marie Client le .* enregistré par /)).toBeVisible();
    await expect(carte.getByRole('img', { name: 'Signature de Marie Client' })).toBeVisible();

    // 4. Compte rendu signé : la clôture ne demande pas de motif.
    await carte.getByRole('button', { name: 'Terminer' }).click();
    await expect(cloture.getByText('Le compte rendu est signé par le client.')).toBeVisible();
    await expect(cloture.getByRole('radio')).toHaveCount(0);
    const fin = page.waitForResponse((reponse) => reponse.request().method() === 'PATCH' && reponse.url().endsWith(`/interventions/${intervention.id}/statut`));
    await cloture.getByRole('button', { name: 'Confirmer la fin de l’intervention' }).click();
    expect((await fin).status()).toBe(200);
    await expect(carte.getByText('Terminée', { exact: true })).toBeVisible();
    await expect(carte.getByRole('button', { name: 'Terminer' })).toHaveCount(0);
    expect(fenetres, 'aucune fenêtre du navigateur').toEqual([]);
  } finally {
    await page.context().close();
  }
});

test('l’encadrement termine sans signature avec un motif, « Autre » exigeant une précision consignée au journal', async ({ allerSurPageAdmin, session, request, creerClient }) => {
  const { intervention, titre, headers } = await preparer(request, session.token, creerClient, 'motif-cloture');
  const page = await allerSurPageAdmin('/interventions');
  const fenetres = interdireFenetres(page);
  const carte = page.locator('article', { hasText: titre });

  await carte.getByRole('button', { name: 'Ajouter un compte rendu' }).click();
  const formulaire = carte.getByRole('dialog', { name: 'Compte rendu d’intervention' });
  await formulaire.getByLabel('Texte du compte rendu').fill('Accès impossible au local technique, à reprogrammer.');
  await formulaire.getByRole('button', { name: 'Enregistrer le compte rendu' }).click();
  await expect(formulaire).toHaveCount(0);
  await expect(carte.getByText('Accès impossible au local technique, à reprogrammer.')).toBeVisible();

  await carte.getByRole('button', { name: 'Terminer' }).click();
  const cloture = carte.getByRole('dialog', { name: 'Terminer l’intervention' });
  const terminer = cloture.getByRole('button', { name: 'Terminer sans signature' });
  await expect(cloture.getByText('Aucun compte rendu n’est signé.', { exact: false })).toBeVisible();
  await expect(terminer, 'un motif est exigé').toBeDisabled();
  for (const libelle of ['Client absent', 'Refus de signer', 'Signature impossible', 'Autre']) await expect(cloture.getByRole('radio', { name: libelle })).toBeVisible();
  await cloture.getByRole('radio', { name: 'Autre' }).check();
  const precision = cloture.getByLabel('Précision du motif');
  await precision.fill('ab');
  await expect(terminer, 'précision trop courte').toBeDisabled();
  await precision.fill('Client parti avant la fin');
  const fin = page.waitForResponse((reponse) => reponse.request().method() === 'PATCH' && reponse.url().endsWith(`/interventions/${intervention.id}/statut`));
  await terminer.click();
  const reponse = await fin;
  expect(reponse.status()).toBe(200);
  expect(reponse.request().postDataJSON()).toEqual({ statut: 'TERMINEE', motifSansSignature: 'AUTRE', precisionMotif: 'Client parti avant la fin' });
  await expect(carte.getByText('Terminée', { exact: true })).toBeVisible();

  const journal = await (await request.get(`${api}/interventions/${intervention.id}/journal-saisies`, { headers })).json() as { action: string; motif: string | null; apres: { statut?: string } }[];
  expect(journal.find((entree) => entree.action === 'CHANGEMENT_STATUT' && entree.apres.statut === 'TERMINEE')?.motif).toBe('Clôture sans signature du client : Autre — Client parti avant la fin');
  expect(fenetres, 'aucune fenêtre du navigateur').toEqual([]);
});

// Au doigt, et non à la souris : de vrais événements tactiles (CDP). Sans `touch-action: none`, la page
// défilerait sous le doigt et le tracé serait réduit à deux points (constaté à l'audit).
test('sur téléphone tactile, la signature se dessine au doigt sans faire défiler la page', async ({ session, request, creerClient, browser }) => {
  const { technicien, intervention, titre, headers } = await preparer(request, session.token, creerClient, 'signature-tactile');
  expect((await request.post(`${api}/interventions/${intervention.id}/rapports`, { headers, data: { contenu: 'Compte rendu à signer au doigt.', cleEnvoi: randomUUID() } })).status()).toBe(201);
  const contexte = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await contexte.newPage();
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jetonPour(technicien.id), JSON.stringify({ ...technicien, permissions: ['chantiers:read', 'clients:read'] })]);
  try {
    await page.goto('/interventions', { waitUntil: 'networkidle' });
    const carte = page.locator('article', { hasText: titre });
    await carte.getByRole('button', { name: 'Faire signer ce compte rendu' }).click();
    const signature = carte.getByRole('dialog', { name: 'Signature du client' });
    const zone = signature.getByRole('img', { name: 'Zone de signature du client' });
    await zone.scrollIntoViewIfNeeded();
    const cadre = (await zone.boundingBox())!;
    const defilement = await page.evaluate(() => window.scrollY);
    const cdp = await contexte.newCDPSession(page);
    const point = (x: number, y: number) => ({ x: cadre.x + cadre.width * x, y: cadre.y + cadre.height * y });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(0.1, 0.8)] });
    for (let i = 1; i <= 20; i += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(0.1 + i * 0.035, i % 2 ? 0.2 : 0.8)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect(await page.evaluate(() => window.scrollY), 'la page ne défile pas sous le doigt').toBe(defilement);
    await expect(signature.getByText('Signature dessinée.')).toBeVisible();
    await signature.getByLabel('Nom du signataire client').fill('Client Tactile');
    await signature.getByLabel('Confirmation du client').check();
    const signe = page.waitForResponse((reponse) => reponse.request().method() === 'POST' && reponse.url().endsWith('/signature'));
    await signature.getByRole('button', { name: 'Enregistrer la signature' }).click();
    const reponse = await signe;
    expect(reponse.status()).toBe(201);
    expect((reponse.request().postDataJSON() as { trace: { traits: number[][][] } }).trace.traits.flat().length, 'le tracé garde les points du doigt').toBeGreaterThan(15);
  } finally {
    await contexte.close();
  }
});

// Sur un écran large, la zone de signature garde des proportions que le serveur admet (10 au plus).
test('sur un écran large, la signature dessinée est acceptée', async ({ session, request, creerClient, page }) => {
  const { intervention, titre, headers } = await preparer(request, session.token, creerClient, 'signature-large');
  expect((await request.post(`${api}/interventions/${intervention.id}/rapports`, { headers, data: { contenu: 'Compte rendu signé sur grand écran.', cleEnvoi: randomUUID() } })).status()).toBe(201);
  await page.setViewportSize({ width: 2560, height: 1200 });
  await page.addInitScript(([token, user]) => { localStorage.setItem('token', token as string); localStorage.setItem('user', user as string); }, [session.token, JSON.stringify(session.user)]);
  await page.goto('/interventions', { waitUntil: 'networkidle' });
  const carte = page.locator('article', { hasText: titre });
  await carte.getByRole('button', { name: 'Faire signer ce compte rendu' }).click();
  const signature = carte.getByRole('dialog', { name: 'Signature du client' });
  await signature.getByLabel('Nom du signataire client').fill('Client Grand Écran');
  await signature.getByLabel('Confirmation du client').check();
  await dessinerSignature(page, signature.getByRole('img', { name: 'Zone de signature du client' }));
  const signe = page.waitForResponse((reponse) => reponse.request().method() === 'POST' && reponse.url().endsWith('/signature'));
  await signature.getByRole('button', { name: 'Enregistrer la signature' }).click();
  const reponse = await signe;
  expect(reponse.status(), await reponse.text()).toBe(201);
  expect((reponse.request().postDataJSON() as { trace: { ratio: number } }).trace.ratio).toBeLessThanOrEqual(10);
});

// Le compte rendu est signé sur un autre appareil pendant que le formulaire de clôture demande un motif :
// le refus relit la liste, et le formulaire passe à la simple confirmation au lieu de boucler sur le motif.
test('une clôture sur un état périmé se remet d’elle-même à jour', async ({ session, request, creerClient, allerSurPageAdmin }) => {
  const { intervention, titre, headers } = await preparer(request, session.token, creerClient, 'cloture-perimee');
  const compteRendu = await request.post(`${api}/interventions/${intervention.id}/rapports`, { headers, data: { contenu: 'Compte rendu signé ailleurs.', cleEnvoi: randomUUID() } });
  expect(compteRendu.status()).toBe(201);
  const page = await allerSurPageAdmin('/interventions');
  const carte = page.locator('article', { hasText: titre });
  await carte.getByRole('button', { name: 'Terminer' }).click();
  const cloture = carte.getByRole('dialog', { name: 'Terminer l’intervention' });
  await cloture.getByRole('radio', { name: 'Client absent' }).check();
  const signeAilleurs = await request.post(`${api}/interventions/rapports/${(await compteRendu.json()).id}/signature`, { headers, data: { signataire: 'Client Ailleurs', confirme: true, trace: { ratio: 2, traits: [[[0.1, 0.1], [0.5, 0.5]]] } } });
  expect(signeAilleurs.status()).toBe(201);
  await cloture.getByRole('button', { name: 'Terminer sans signature' }).click();
  await expect(cloture.getByRole('alert')).toContainText('aucun motif');
  await expect(carte.getByText(/Signé par Client Ailleurs/)).toBeVisible();
  await expect(cloture.getByRole('radio')).toHaveCount(0);
  await cloture.getByRole('button', { name: 'Confirmer la fin de l’intervention' }).click();
  await expect(carte.getByText('Terminée', { exact: true })).toBeVisible();
});

// Un formulaire de clôture dont l'intervention change entre-temps se ferme à la relecture : les autres
// cartes gardent leurs actions (constaté à l'audit : toutes disparaissaient jusqu'au rechargement). Une
// clôture en échec, elle, garde son formulaire ouvert pour être renvoyée.
test('après une clôture à l’issue inconnue ou refusée, les autres cartes gardent leurs actions', async ({ session, request, creerClient, allerSurPageAdmin }) => {
  const dossiers = [];
  for (const libelle of ['cloture-inconnue', 'cloture-annulee', 'cloture-temoin']) {
    const dossier = await preparer(request, session.token, creerClient, libelle);
    expect((await request.post(`${api}/interventions/${dossier.intervention.id}/rapports`, { headers: dossier.headers, data: { contenu: `Compte rendu ${libelle}.`, cleEnvoi: randomUUID() } })).status()).toBe(201);
    dossiers.push(dossier);
  }
  const [inconnue, annulee, temoin] = dossiers;
  const page = await allerSurPageAdmin('/interventions');
  const carte = (dossier: { titre: string }) => page.locator('article', { hasText: dossier.titre });
  const terminerSansSignature = async (dossier: { titre: string }) => {
    await carte(dossier).getByRole('button', { name: 'Terminer' }).click();
    const cloture = carte(dossier).getByRole('dialog', { name: 'Terminer l’intervention' });
    await cloture.getByRole('radio', { name: 'Client absent' }).check();
    await cloture.getByRole('button', { name: 'Terminer sans signature' }).click();
  };
  // 1. La clôture est enregistrée, mais sa réponse est perdue.
  await page.route(`**/api/interventions/${inconnue.intervention.id}/statut`, async (route: Route) => {
    const reponse = await route.fetch();
    expect(reponse.status()).toBe(200);
    await route.abort('failed');
  });
  await terminerSansSignature(inconnue);
  await expect(carte(inconnue).getByText('Terminée', { exact: true })).toBeVisible();
  await expect(carte(inconnue).getByRole('dialog')).toHaveCount(0);
  await expect(carte(temoin).getByRole('button', { name: 'Terminer' })).toBeVisible();
  // 2. L'intervention est annulée ailleurs pendant que le formulaire est ouvert.
  await carte(annulee).getByRole('button', { name: 'Terminer' }).click();
  expect((await request.patch(`${api}/interventions/${annulee.intervention.id}/statut`, { headers: annulee.headers, data: { statut: 'ANNULEE', motif: 'Annulée ailleurs pendant la clôture' } })).ok()).toBeTruthy();
  const cloture = carte(annulee).getByRole('dialog', { name: 'Terminer l’intervention' });
  await cloture.getByRole('radio', { name: 'Client absent' }).check();
  await cloture.getByRole('button', { name: 'Terminer sans signature' }).click();
  await expect(carte(annulee)).toHaveCount(0);
  await expect(page.getByText('Cette intervention a changé entre-temps')).toBeVisible();
  await expect(carte(temoin).getByRole('button', { name: 'Terminer' })).toBeVisible();
  await expect(carte(temoin).getByRole('button', { name: 'Ajouter un compte rendu' })).toBeVisible();
  // 3. La clôture échoue sans être enregistrée : le formulaire reste ouvert avec son message et sa
  // saisie, et un nouvel envoi termine l'intervention.
  const routeTemoin = `**/api/interventions/${temoin.intervention.id}/statut`;
  await page.route(routeTemoin, (route: Route) => route.fulfill({ status: 502, body: '' }));
  await terminerSansSignature(temoin);
  const clotureTemoin = carte(temoin).getByRole('dialog', { name: 'Terminer l’intervention' });
  await expect(clotureTemoin.getByRole('alert')).toContainText('n’a pas pu être confirmée');
  await expect(clotureTemoin.getByRole('radio', { name: 'Client absent' })).toBeChecked();
  await expect(carte(temoin).getByText('En cours', { exact: true })).toBeVisible();
  await page.unroute(routeTemoin);
  await clotureTemoin.getByRole('button', { name: 'Terminer sans signature' }).click();
  await expect(carte(temoin).getByText('Terminée', { exact: true })).toBeVisible();
  await expect(carte(temoin).getByRole('dialog')).toHaveCount(0);
});

// Un seul doigt trace : un second doigt posé dans la zone n'ajoute aucun point.
test('sur téléphone tactile, un second doigt dans la zone de signature est ignoré', async ({ session, request, creerClient, browser }) => {
  const { intervention, titre, headers } = await preparer(request, session.token, creerClient, 'signature-deux-doigts');
  expect((await request.post(`${api}/interventions/${intervention.id}/rapports`, { headers, data: { contenu: 'Compte rendu signé à deux doigts.', cleEnvoi: randomUUID() } })).status()).toBe(201);
  const contexte = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  const page = await contexte.newPage();
  await page.addInitScript(([token, user]) => { localStorage.setItem('token', token as string); localStorage.setItem('user', user as string); }, [session.token, JSON.stringify(session.user)]);
  try {
    await page.goto('/interventions', { waitUntil: 'networkidle' });
    const carte = page.locator('article', { hasText: titre });
    await carte.getByRole('button', { name: 'Faire signer ce compte rendu' }).click();
    const signature = carte.getByRole('dialog', { name: 'Signature du client' });
    const zone = signature.getByRole('img', { name: 'Zone de signature du client' });
    await zone.scrollIntoViewIfNeeded();
    const cadre = (await zone.boundingBox())!;
    const doigt = (x: number, y: number, id: number) => ({ x: cadre.x + cadre.width * x, y: cadre.y + cadre.height * y, id });
    const cdp = await contexte.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [doigt(0.1, 0.2, 1)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [doigt(0.1, 0.2, 1), doigt(0.9, 0.9, 2)] });
    for (let i = 1; i <= 10; i += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [doigt(0.1 + i * 0.03, 0.2, 1), doigt(0.9, 0.9 - i * 0.05, 2)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [doigt(0.4, 0.2, 1)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await signature.getByLabel('Nom du signataire client').fill('Client Deux Doigts');
    await signature.getByLabel('Confirmation du client').check();
    const signe = page.waitForResponse((reponse) => reponse.request().method() === 'POST' && reponse.url().endsWith('/signature'));
    await signature.getByRole('button', { name: 'Enregistrer la signature' }).click();
    const reponse = await signe;
    expect(reponse.status()).toBe(201);
    const points = (reponse.request().postDataJSON() as { trace: { traits: number[][][] } }).trace.traits.flat();
    expect(points.length).toBeGreaterThan(5);
    expect(points.every(([, y]) => y < 0.5), 'aucun point du second doigt').toBe(true);
  } finally {
    await contexte.close();
  }
});
