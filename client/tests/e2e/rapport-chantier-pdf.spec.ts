import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect, dateDuJour, horsDuPassageDeMinuit } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Lot 6a-4c : rapport de chantier remis au client, produit par le serveur (cadrage du lot 6a-4, version 6 du
// 31-10-2026, section « 6a-4c », « Écran » (N5) et « Tests ») ; réponse de Nelson du 31-10-2026 : « il ne doit
// pas y avoir de montant ni de heures ». Sur la fiche chantier, un bouton « Rapport client (PDF) », pour
// l'administration seulement, après « Modifier » et « Rapport interne (PDF) », hors de la capture
// (data-html2canvas-ignore) ; la capture actuelle devient « Rapport interne (PDF) » ; un refus s'affiche en tête
// de l'écran, hors de la zone capturée.

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable ouvre une session dans
// un rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

// Texte d'un PDF produit par PDFKit (repris de compte-rendu-pdf.spec.ts) : les chaînes des opérateurs TJ et Tj
// de chaque flux de contenu, décompressé, lues dans le jeu WinAnsi (€ y est l'octet 0x80).
function texteDuPdf(octets: Buffer): string {
  const brut = octets.toString('latin1');
  const lignes: string[] = [];
  for (const flux of brut.matchAll(/stream\r?\n/g)) {
    const debut = flux.index! + flux[0].length;
    let contenu: string;
    try { contenu = inflateSync(octets.subarray(debut, brut.indexOf('endstream', debut))).toString('latin1'); } catch { continue; }
    for (const [operation] of contenu.matchAll(/\[(?:[^\]]*)\]\s*TJ|<[0-9A-Fa-f]*>\s*Tj/g)) {
      lignes.push([...operation.matchAll(/<([0-9A-Fa-f]*)>/g)].map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1')).join(''));
    }
  }
  return lignes.join('\n');
}

async function envoyer(request: APIRequestContext, headers: Record<string, string>, methode: 'post' | 'put' | 'patch', chemin: string, data: object) {
  const reponse = await request[methode](`${api}${chemin}`, { headers, data });
  expect(reponse.ok(), `${methode.toUpperCase()} ${chemin} : ${reponse.status()} ${await reponse.text()}`).toBeTruthy();
  return reponse.json();
}

type Chantier = { id: string; nom: string };
type Intervention = { id: string; reference: string; titre: string };

// Chantier ouvert par la conversion d'un devis signé, au montant témoin de 4 321,09 € HT (vendu), avec 37,25 h
// pointées (37 h 15) et une intervention rattachée qui porte un compte rendu.
async function chantierTemoin(request: APIRequestContext, token: string, clientId: string, nom: string) {
  const headers = auth(token);
  const devis = await envoyer(request, headers, 'post', '/devis', { clientId, objet: nom, lignes: [{ designation: 'Pose et mise en service', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 4321.09, tauxTva: 20 }] }) as { id: string };
  await envoyer(request, headers, 'put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer(request, headers, 'post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer(request, headers, 'post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as Chantier & { budgetGlobalVendu: number };
  expect(chantier.budgetGlobalVendu).toBe(4321.09);
  const intervenant = await envoyer(request, headers, 'post', '/intervenants', { nom: `Intervenant rapport ${Date.now()}`, role: 'Technicien', tauxHoraireCharge: 48.13 }) as { id: string };
  await envoyer(request, headers, 'post', '/heures', { chantierId: chantier.id, intervenantId: intervenant.id, date: dateDuJour(), nbrHeures: 37.25 });
  const intervention = await envoyer(request, headers, 'post', '/interventions', { clientId, chantierId: chantier.id, titre: `Demande du rapport ${Date.now()}` }) as Intervention;
  await envoyer(request, headers, 'patch', `/interventions/${intervention.id}/statut`, { statut: 'PLANIFIEE' });
  await envoyer(request, headers, 'patch', `/interventions/${intervention.id}/statut`, { statut: 'EN_COURS' });
  const compteRendu = `Compte rendu remis au client ${Date.now()}.`;
  await envoyer(request, headers, 'post', `/interventions/${intervention.id}/rapports`, { contenu: compteRendu, cleEnvoi: randomUUID() });
  return { chantier, intervention, compteRendu };
}

// Nom du fichier attendu (cadrage, « Noms de fichiers ») : le nom réduit aux lettres sans accent, aux chiffres,
// au tiret et au tiret bas, toute autre suite devenant un tiret, sans tiret en tête ni en fin.
const nomReduit = (nom: string) => nom.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');

// Barre d'actions de la fiche : le plus petit bloc qui contient « Rapport interne (PDF) » et le bouton client
// (les journaux de la fiche ont aussi leurs boutons « Modifier »).
const barreActions = (page: Page) => page.locator('div')
  .filter({ has: page.getByRole('button', { name: 'Rapport interne (PDF)', exact: true }) })
  .filter({ has: page.getByTestId('rapport-client-pdf') }).last();

// Zone capturée par le rapport interne : le plus petit bloc qui contient à la fois le titre du chantier et le
// bouton « Rapport interne (PDF) » (la barre d'actions et le titre sont dans la zone exportée). Un élément est
// « en tête, hors de la zone » s'il n'y est pas contenu et s'affiche au-dessus d'elle.
async function placeParRapportALaZone(page: Page, titre: Locator, element: Locator) {
  const [poigneeTitre, poigneeBouton, poigneeElement] = await Promise.all([
    titre.elementHandle(), page.getByRole('button', { name: 'Rapport interne (PDF)', exact: true }).elementHandle(), element.elementHandle(),
  ]);
  return page.evaluate(([t, b, e]) => {
    let zone: Element | null = t as Element;
    while (zone && !zone.contains(b as Element)) zone = zone.parentElement;
    if (!zone) return { contient: true, auDessus: false };
    return { contient: zone.contains(e as Element), auDessus: (e as Element).getBoundingClientRect().top < zone.getBoundingClientRect().top };
  }, [poigneeTitre, poigneeBouton, poigneeElement] as const);
}

// Cadrage, « Écran » et « Tests » : « le bouton « Rapport client (PDF) » de l'administration télécharge un PDF
// valide, sans montant » ; « « Rapport interne (PDF) » reste » ; noms de fichiers `Rapport-chantier-<nom>.pdf`
// (nom réduit, même calcul côté serveur et côté client) et `Rapport-interne_<nom>.pdf` (le nom tel quel).
test('rapport client : l’administration télécharge le PDF du serveur, sans montant ni heures ; trois boutons dans l’ordre, le rapport interne reste', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  test.slow();
  await horsDuPassageDeMinuit();
  const suffixe = `${Date.now()}`;
  const client = await creerClient('rapport client');
  const nom = `E2E Rapport client ${suffixe}`;
  const { chantier, intervention, compteRendu } = await chantierTemoin(request, session.token, client.id, nom);

  const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  await expect(page.getByRole('heading', { name: nom })).toBeVisible();
  // Les montants existent et l'administration les voit sur la fiche : le rapport client ne passe pas à vide.
  await expect(page.locator('main')).toContainText(/4\s?321,09/);

  // Trois boutons, dans l'ordre : « Modifier », « Rapport interne (PDF) », « Rapport client (PDF) ».
  const boutonClient = page.getByTestId('rapport-client-pdf');
  await expect(boutonClient).toBeVisible();
  await expect(boutonClient).toHaveText('Rapport client (PDF)');
  await expect(boutonClient).toHaveAttribute('data-html2canvas-ignore');
  const boutonInterne = page.getByRole('button', { name: 'Rapport interne (PDF)', exact: true });
  await expect(boutonInterne).toBeVisible();
  await expect(page.getByRole('button', { name: 'PDF', exact: true })).toHaveCount(0);
  expect((await barreActions(page).getByRole('button').allTextContents()).map((texte) => texte.trim())).toEqual(['Modifier', 'Rapport interne (PDF)', 'Rapport client (PDF)']);

  // Le rapport client : la réponse de la route du serveur, téléchargée sous son nom.
  const reponse = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().endsWith(`/api/chantiers/${chantier.id}/document.pdf`));
  const telechargement = page.waitForEvent('download');
  await boutonClient.click();
  const [res, fichier] = await Promise.all([reponse, telechargement]);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/pdf');
  const nomAttendu = `Rapport-chantier-${nomReduit(nom)}.pdf`;
  expect(nomAttendu).toBe(`Rapport-chantier-E2E-Rapport-client-${suffixe}.pdf`);
  expect(fichier.suggestedFilename()).toBe(nomAttendu);
  expect(res.headers()['content-disposition']).toContain(`filename="${nomAttendu}"`);
  const octets = await readFile(await fichier.path() as string);
  expect(octets.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(octets.length, 'le fichier a la taille du PDF reçu').toBe(Number(res.headers()['content-length']));
  expect(octets.subarray(-8).toString('latin1')).toContain('%%EOF');

  // Le rapport de ce chantier, avec son intervention et son compte rendu, daté du jour de la société.
  const texte = texteDuPdf(octets);
  for (const attendu of ['Rapport de chantier', nom, client.raisonSociale, intervention.reference, compteRendu, `Début : ${dateDuJour()}`, 'Statut : en cours']) {
    expect(texte, `absent du PDF : ${attendu}`).toContain(attendu);
  }
  expect(texte).toMatch(new RegExp(`${dateDuJour()} \\d{2}:\\d{2}`));
  // Ni montant ni heures : ni le vendu (4 321,09), ni les 37,25 h pointées, ni le taux, ni symbole monétaire.
  for (const interdit of ['4 321', '4321', '4 321', '4 321', '37,25', '37.25', '37 h', '2235', '48,13', '48.13', '\x80', '€']) {
    expect(texte, `imprimé à tort : ${interdit}`).not.toContain(interdit);
  }
  expect(texte).not.toMatch(/\d,\d{2}(?!\d)/);
  expect(texte).not.toMatch(/(?<![A-Za-z])(HT|TTC)(?![A-Za-z])/);

  // Le rapport interne reste : la capture de l'écran, sous le nom `Rapport-interne_<nom>.pdf`.
  const capture = page.waitForEvent('download');
  await boutonInterne.click();
  const fichierInterne = await capture;
  expect(fichierInterne.suggestedFilename()).toBe(`Rapport-interne_${nom}.pdf`);
  const octetsInterne = await readFile(await fichierInterne.path() as string);
  expect(octetsInterne.subarray(0, 5).toString('latin1')).toBe('%PDF-');
});

// Cadrage, « Écran » : « Un refus s'affiche en tête de l'écran, hors de la zone capturée » ; « Tests » : « un
// refus (identité incomplète) s'affiche en tête de la fiche, sans téléchargement » ; « vue à 375 px ».
test('rapport client à 375 px : les trois boutons tiennent dans l’écran ; identité incomplète, le refus s’affiche en tête de la fiche, hors de la zone capturée, sans fichier', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const suffixe = `${Date.now()}`;
  const client = await creerClient('rapport client refus');
  const nom = `E2E Rapport refus ${suffixe}`;
  const { chantier } = await chantierTemoin(request, session.token, client.id, nom);
  const message = 'Identité de la société incomplète : renseignez SIRET dans l’écran Société avant d’imprimer un rapport de chantier.';

  const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  await page.setViewportSize({ width: 375, height: 800 });
  const titre = page.getByRole('heading', { name: nom });
  await expect(titre).toBeVisible();
  const boutonClient = page.getByTestId('rapport-client-pdf');
  for (const bouton of [barreActions(page).getByRole('button', { name: 'Modifier', exact: true }), page.getByRole('button', { name: 'Rapport interne (PDF)', exact: true }), boutonClient]) {
    await expect(bouton).toBeVisible();
    const boite = await bouton.boundingBox();
    expect(boite && boite.x >= 0 && boite.x + boite.width <= 375, 'le bouton tient dans la largeur de l’écran').toBe(true);
  }
  const largeurPage = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(largeurPage, 'aucun défilement horizontal').toBeLessThanOrEqual(375);

  const societe = await (await request.get(`${api}/company`, { headers: auth(session.token) })).json() as { siret: string };
  try {
    const maj = await request.put(`${api}/company`, { headers: auth(session.token), data: { siret: '' } });
    expect(maj.ok(), await maj.text()).toBeTruthy();
    let telecharge = false;
    page.on('download', () => { telecharge = true; });
    const refus = page.waitForResponse((r) => r.url().endsWith(`/api/chantiers/${chantier.id}/document.pdf`));
    await boutonClient.click();
    expect((await refus).status()).toBe(409);
    const alerte = page.getByText(message, { exact: true });
    await expect(alerte).toBeVisible();
    await expect(alerte).toBeInViewport();
    // En tête de l'écran : avant la zone capturée, et hors d'elle.
    expect(await placeParRapportALaZone(page, titre, alerte)).toEqual({ contient: false, auDessus: true });
    expect(telecharge).toBe(false);
  } finally {
    const retour = await request.put(`${api}/company`, { headers: auth(session.token), data: { siret: societe.siret } });
    expect(retour.ok(), await retour.text()).toBeTruthy();
  }
});

// Cadrage, « Lecteurs » : l'administration seule (choix par défaut, le plus restrictif, à confirmer) ; « Écran » :
// le bouton « pour l'administration seulement » ; « Tests » : « un conducteur ne voit pas le bouton client ». Le
// titulaire du chantier garde sa fiche et le rapport interne ; le serveur lui refuse le rapport client.
test('rapport client : le conducteur titulaire du chantier n’a pas le bouton, garde le rapport interne, et le serveur lui refuse le PDF', async ({ browser, creerClient, request, session }) => {
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const client = await creerClient('rapport client conducteur');
  const nom = `E2E Rapport conducteur ${suffixe}`;
  const { chantier, compteRendu } = await chantierTemoin(request, session.token, client.id, nom);
  const conducteur = await envoyer(request, auth(session.token), 'post', '/users', { email: `rapport.conducteur.${suffixe}@iris.test`, name: `Conducteur rapport ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' }) as { id: string; name: string; email: string; role: string };
  await envoyer(request, auth(session.token), 'patch', `/chantiers/${chantier.id}`, { responsableId: conducteur.id });
  const jeton = jetonPour(conducteur.id);

  const contexte = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await contexte.newPage();
    await page.addInitScript(([valeurJeton, compte]) => {
      localStorage.setItem('token', valeurJeton as string);
      localStorage.setItem('user', compte as string);
    }, [jeton, JSON.stringify({ ...conducteur, permissions: [] })]);
    await page.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('user') || '{}').role)).toBe('CONDUCTEUR_TRAVAUX');
    await expect(page.getByRole('heading', { name: nom })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rapport interne (PDF)', exact: true })).toBeVisible();
    await expect(page.getByTestId('rapport-client-pdf')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Rapport client (PDF)' })).toHaveCount(0);
  } finally {
    await contexte.close();
  }
  const refus = await request.get(`${api}/chantiers/${chantier.id}/document.pdf`, { headers: auth(jeton) });
  expect(refus.status(), await refus.text()).toBe(403);
  // L'administration, elle, obtient le rapport du même chantier.
  const pdf = await request.get(`${api}/chantiers/${chantier.id}/document.pdf`, { headers: auth(session.token) });
  expect(pdf.status()).toBe(200);
  expect(texteDuPdf(Buffer.from(await pdf.body()))).toContain(compteRendu);
});
