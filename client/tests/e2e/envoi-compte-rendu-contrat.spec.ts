import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import type { APIRequestContext, Browser, Locator, Page } from '@playwright/test';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Lot 6a-4d (cadrage du lot 6a-4, version 4 du 31-10-2026, section « 6a-4d ») : le compte rendu d'une
// intervention et le contrat de maintenance s'envoient par la messagerie de l'utilisateur, avec le
// dialogue du lot 6a-3. « Préparer l'envoi » télécharge le PDF, enregistre l'envoi au journal, puis
// propose le lien de la messagerie (destinataire, objet et texte remplis), que ces parcours ne cliquent
// pas : seul son href est lu. Si le PDF est refusé ou échoue, rien n'est enregistré. Le bouton
// « Envoyer » est à côté du bouton « PDF » : sur la fiche de l'intervention, hors technicien, avec au
// moins un compte rendu et le droit clients:read (B3) ; sur chaque contrat de la liste, sauf annulé.

type Intervention = { id: string; reference: string; titre: string; statut: string };
type Contrat = { id: string; titre: string; statut: string };
type Envoi = { id: string; destinataire: string; objet: string; auteurNom: string; createdAt: string };
type Compte = { id: string; name: string; email: string; role: string };

// Objet et texte du cadrage, mot pour mot (choix par défaut, à confirmer).
const objetCompteRendu = (reference: string, raisonSociale: string) => `Compte rendu d’intervention ${reference} – ${raisonSociale}`;
const corpsCompteRendu = (reference: string, raisonSociale: string) => `Bonjour,\n\nVeuillez trouver ci-joint le compte rendu de l’intervention ${reference}.\n\nCordialement,\n${raisonSociale}`;
const objetContrat = (intitule: string, raisonSociale: string) => `Contrat de maintenance ${intitule} – ${raisonSociale}`;
const corpsContrat = (intitule: string, raisonSociale: string) => `Bonjour,\n\nVeuillez trouver ci-joint le récapitulatif de votre contrat de maintenance ${intitule}.\n\nCordialement,\n${raisonSociale}`;
const lienAttendu = (destinataire: string, objet: string, corps: string) =>
  `mailto:${destinataire}?subject=${encodeURIComponent(objet)}&body=${encodeURIComponent(corps.replace(/\n/g, '\r\n'))}`;
// Noms accessibles (N4) : « Envoyer le compte rendu de l’intervention {référence} » ; « Envoyer le contrat
// de maintenance {intitulé} ». Le dialogue porte le même nom (« Envoyer » suivi de sa désignation).
const nomEnvoiCompteRendu = (reference: string) => `Envoyer le compte rendu de l’intervention ${reference}`;
const nomEnvoiContrat = (intitule: string) => `Envoyer le contrat de maintenance ${intitule}`;
// Fichier joint : `Compte-rendu-<référence>.pdf` ; `nomFichierContrat(contrat)`, ici sur un intitulé fait de
// lettres sans accent, de chiffres et d'espaces, qui deviennent des tirets.
const fichierCompteRendu = (reference: string) => `Compte-rendu-${reference}.pdf`;
const fichierContrat = (intitule: string) => `Contrat-${intitule.replace(/ +/g, '-')}.pdf`;

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable ouvre une
// session dans un rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

// Texte d'un PDF produit par PDFKit (comme compte-rendu-pdf.spec.ts) : les chaînes des opérateurs TJ et
// Tj de chaque flux de contenu décompressé.
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

async function appel<T>(request: APIRequestContext, token: string, methode: 'get' | 'post' | 'put' | 'patch', chemin: string, data?: object, attendu = methode === 'post' ? 201 : 200): Promise<T> {
  const reponse = await request[methode](`${api}${chemin}`, { headers: auth(token), ...(data ? { data } : {}) });
  expect(reponse.status(), `${methode.toUpperCase()} ${chemin} : ${await reponse.text()}`).toBe(attendu);
  return reponse.json() as Promise<T>;
}
async function societe(request: APIRequestContext, token: string) {
  return appel<{ raisonSociale: string; siret: string; fuseauHoraire: string | null }>(request, token, 'get', '/company');
}
async function envoisDe(request: APIRequestContext, token: string, chemin: string) {
  return (await appel<{ envois: Envoi[] }>(request, token, 'get', `${chemin}/envois`)).envois;
}
// Une intervention en cours, avec un compte rendu si un texte est donné.
async function interventionEnCours(request: APIRequestContext, token: string, data: { clientId: string; titre: string; chantierId?: string }, compteRendu?: string) {
  const intervention = await appel<Intervention>(request, token, 'post', '/interventions', data);
  await appel(request, token, 'patch', `/interventions/${intervention.id}/statut`, { statut: 'PLANIFIEE' });
  await appel(request, token, 'patch', `/interventions/${intervention.id}/statut`, { statut: 'EN_COURS' });
  if (compteRendu) await appel(request, token, 'post', `/interventions/${intervention.id}/rapports`, { contenu: compteRendu, cleEnvoi: randomUUID() });
  return intervention;
}
const creerContrat = (request: APIRequestContext, token: string, clientId: string, titre: string) =>
  appel<Contrat>(request, token, 'post', '/contrats-maintenance', { clientId, titre, periodiciteMois: 6, dureePrevisionnelleMinutes: 90, dateDebut: '01-10-2030' });
// Date et heure d'un envoi au fuseau de la société, comme l'écran : JJ-MM-AAAA HH:MM.
function dateHeure(instant: string, fuseau: string) {
  const parties = new Intl.DateTimeFormat('fr-FR', { timeZone: fuseau, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(instant));
  const partie = (type: string) => parties.find((p) => p.type === type)!.value;
  return `${partie('day')}-${partie('month')}-${partie('year')} ${partie('hour')}:${partie('minute')}`;
}
// Le PDF téléchargé : son nom, un vrai PDF, et le texte qu'il imprime.
async function pdfTelecharge(page: Page, declencher: () => Promise<void>, nomAttendu: string) {
  const telechargement = page.waitForEvent('download');
  await declencher();
  const fichier = await telechargement;
  expect(fichier.suggestedFilename()).toBe(nomAttendu);
  const octets = await readFile(await fichier.path() as string);
  expect(octets.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(octets.subarray(-8).toString('latin1')).toContain('%%EOF');
  return texteDuPdf(octets);
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
async function pageDe(browser: Browser, compte: Compte, permissions: string[], largeur?: number) {
  const contexte = await browser.newContext(largeur ? { viewport: { width: largeur, height: 812 } } : {});
  const page = await contexte.newPage();
  await page.addInitScript(([jeton, utilisateur]) => {
    localStorage.setItem('token', jeton as string);
    localStorage.setItem('user', utilisateur as string);
  }, [jetonPour(compte.id), JSON.stringify({ ...compte, permissions })]);
  return { contexte, page };
}

test('compte rendu : envoi préparé depuis la fiche de l’intervention, PDF téléchargé, « Envoi préparé » au journal, lien de la messagerie exact, statut inchangé', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const token = session.token;
  const suffixe = `${Date.now()}`;
  const client = await creerClient('envoi compte rendu');
  const principal = `principal.${suffixe}@client-e2e.test`;
  await appel(request, token, 'post', `/clients/${client.id}/contacts`, { nom: 'Principal', email: principal, principal: true });
  const texteCompteRendu = `Chaudiere remise en service ${suffixe}.`;
  const intervention = await interventionEnCours(request, token, { clientId: client.id, titre: `E2E Envoi compte rendu ${suffixe}` }, texteCompteRendu);
  const { raisonSociale, fuseauHoraire } = await societe(request, token);
  const emetteur = raisonSociale.trim();
  const objet = objetCompteRendu(intervention.reference, emetteur);
  const corps = corpsCompteRendu(intervention.reference, emetteur);
  const auteur = (session.user as { name: string }).name;

  const page = await allerSurPageAdmin(`/interventions/${intervention.id}`);
  await expect(page.getByRole('heading', { name: 'Fiche intervention' })).toBeVisible();
  const bouton = page.getByRole('button', { name: nomEnvoiCompteRendu(intervention.reference), exact: true });
  await expect(bouton).toBeVisible();
  await expect(bouton).toContainText('Envoyer');
  // À côté du bouton « PDF ».
  await expect(page.getByTestId('pdf-compte-rendu')).toBeVisible();
  await bouton.click();
  const dialogue = page.getByRole('dialog', { name: nomEnvoiCompteRendu(intervention.reference) });
  await expect(dialogue).toBeVisible();
  await expect(dialogue).toBeInViewport();
  // En tête de la fiche : au-dessus des comptes rendus, où se trouve le bouton.
  const haut = async (element: Locator) => (await element.boundingBox())!.y;
  expect(await haut(dialogue)).toBeLessThan(await haut(page.getByText('Comptes rendus terrain', { exact: true })));
  const destinataire = dialogue.getByRole('textbox', { name: 'Destinataire' });
  await expect(destinataire).toHaveValue(principal);
  await expect(dialogue).toContainText(`Objet : ${objet}`);
  await expect(dialogue).toContainText('Aucun envoi préparé pour ce document.');
  await expect(dialogue.getByRole('link', { name: 'Ouvrir la messagerie' })).toHaveCount(0);

  const texte = await pdfTelecharge(page, () => dialogue.getByRole('button', { name: 'Préparer l’envoi' }).click(), fichierCompteRendu(intervention.reference));
  for (const attendu of ["Compte rendu d'intervention", intervention.reference, texteCompteRendu]) expect(texte, `absent du PDF : ${attendu}`).toContain(attendu);
  const lien = dialogue.getByRole('link', { name: 'Ouvrir la messagerie' });
  await expect(lien).toHaveAttribute('href', lienAttendu(principal, objet, corps));
  await expect(dialogue.getByRole('status')).toContainText(`Le PDF ${fichierCompteRendu(intervention.reference)} vient d’être téléchargé : joignez-le à la main au courriel.`);
  const [premier] = await envoisDe(request, token, `/interventions/${intervention.id}`);
  expect(premier).toMatchObject({ destinataire: principal, objet, auteurNom: auteur });
  const liste = dialogue.getByRole('region', { name: 'Envois préparés' }).getByRole('listitem');
  await expect(liste).toHaveText([`Envoi préparé le ${dateHeure(premier.createdAt, fuseauHoraire || 'Europe/Paris')} à ${principal} par ${auteur}`]);

  // Le destinataire se corrige : le second envoi passe en tête, le lien suit la nouvelle adresse.
  const autre = `autre.${suffixe}@client-e2e.test`;
  await destinataire.fill(autre);
  await pdfTelecharge(page, () => dialogue.getByRole('button', { name: 'Préparer l’envoi' }).click(), fichierCompteRendu(intervention.reference));
  await expect(lien).toHaveAttribute('href', lienAttendu(autre, objet, corps));
  await expect(liste).toHaveCount(2);
  await expect(liste.first()).toContainText(`à ${autre} par ${auteur}`);
  expect((await envoisDe(request, token, `/interventions/${intervention.id}`)).map((e) => e.destinataire)).toEqual([autre, principal]);
  // Le journal se relit à la réouverture du dialogue.
  await dialogue.getByRole('button', { name: 'Fermer' }).click();
  await expect(dialogue).toHaveCount(0);
  await bouton.click();
  await expect(dialogue.getByRole('region', { name: 'Envois préparés' }).getByRole('listitem')).toHaveCount(2);

  // L'envoi ne change pas le statut de l'intervention, relu par l'API.
  expect((await appel<Intervention>(request, token, 'get', `/interventions/${intervention.id}`)).statut).toBe('EN_COURS');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('contrat : envoi préparé depuis la liste des contrats ; un contrat suspendu a son bouton « Envoyer », un contrat annulé garde son « PDF » sans « Envoyer »', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const token = session.token;
  const suffixe = `${Date.now()}`;
  const client = await creerClient('envoi contrat');
  const courriel = `contrats.${suffixe}@client-e2e.test`;
  await appel(request, token, 'put', `/clients/${client.id}`, { email: courriel });
  const actif = await creerContrat(request, token, client.id, `E2E Contrat envoi actif ${suffixe}`);
  const suspendu = await creerContrat(request, token, client.id, `E2E Contrat envoi suspendu ${suffixe}`);
  await appel(request, token, 'patch', `/contrats-maintenance/${suspendu.id}/statut`, { statut: 'SUSPENDU', motif: 'E2E Suspension du contrat' });
  // Contrat annulé avec le devis dont il est issu (lot 4 suite).
  const devis = await appel<{ id: string }>(request, token, 'post', '/devis', { clientId: client.id, objet: `E2E Devis du contrat envoyé ${suffixe}`, lignes: [{ designation: 'Visite annuelle', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] });
  await appel(request, token, 'put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await appel(request, token, 'post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const annule = await appel<Contrat>(request, token, 'post', `/devis/${devis.id}/convertir`, { cible: 'CONTRAT', titre: `E2E Contrat envoi annule ${suffixe}`, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-11-2030' });
  await appel(request, token, 'post', `/devis/${devis.id}/annulation`, { motif: 'E2E Annulation du devis du contrat' }, 200);
  const { raisonSociale, fuseauHoraire } = await societe(request, token);
  const emetteur = raisonSociale.trim();
  const objet = objetContrat(actif.titre, emetteur);
  const corps = corpsContrat(actif.titre, emetteur);
  const auteur = (session.user as { name: string }).name;

  const page = await allerSurPageAdmin('/contrats-maintenance');
  await expect(page.getByTestId(`pdf-contrat-${annule.id}`)).toBeVisible();
  await expect(page.getByRole('button', { name: nomEnvoiContrat(annule.titre), exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: nomEnvoiContrat(suspendu.titre), exact: true })).toBeVisible();
  for (const contrat of [actif, suspendu]) await expect(page.getByTestId(`pdf-contrat-${contrat.id}`)).toBeVisible();
  const bouton = page.getByRole('button', { name: nomEnvoiContrat(actif.titre), exact: true });
  await expect(bouton).toContainText('Envoyer');
  await bouton.click();
  const dialogue = page.getByRole('dialog', { name: nomEnvoiContrat(actif.titre) });
  await expect(dialogue).toBeVisible();
  await expect(dialogue).toBeInViewport();
  const destinataire = dialogue.getByRole('textbox', { name: 'Destinataire' });
  await expect(destinataire).toHaveValue(courriel);
  await expect(dialogue).toContainText(`Objet : ${objet}`);
  await expect(dialogue).toContainText('Aucun envoi préparé pour ce document.');

  const texte = await pdfTelecharge(page, () => dialogue.getByRole('button', { name: 'Préparer l’envoi' }).click(), fichierContrat(actif.titre));
  for (const attendu of ['Contrat de maintenance', actif.titre, client.raisonSociale]) expect(texte, `absent du PDF : ${attendu}`).toContain(attendu);
  await expect(dialogue.getByRole('link', { name: 'Ouvrir la messagerie' })).toHaveAttribute('href', lienAttendu(courriel, objet, corps));
  await expect(dialogue.getByRole('status')).toContainText(`Le PDF ${fichierContrat(actif.titre)} vient d’être téléchargé : joignez-le à la main au courriel.`);
  const envois = await envoisDe(request, token, `/contrats-maintenance/${actif.id}`);
  expect(envois).toHaveLength(1);
  expect(envois[0]).toMatchObject({ destinataire: courriel, objet, auteurNom: auteur });
  await expect(dialogue.getByRole('region', { name: 'Envois préparés' }).getByRole('listitem'))
    .toHaveText([`Envoi préparé le ${dateHeure(envois[0].createdAt, fuseauHoraire || 'Europe/Paris')} à ${courriel} par ${auteur}`]);
  // Le statut des contrats ne change pas, relu par l'API.
  const contrats = await appel<Contrat[]>(request, token, 'get', '/contrats-maintenance');
  expect([actif, suspendu, annule].map((c) => contrats.find((lu) => lu.id === c.id)?.statut)).toEqual(['ACTIF', 'SUSPENDU', 'ANNULE']);
  expect(await envoisDe(request, token, `/contrats-maintenance/${suspendu.id}`)).toEqual([]);
});

// Cadrage : « si le PDF est refusé ou échoue, rien n'est enregistré » ; E2E : « le refus d'un PDF n'écrit
// rien ». À l'ouverture, la proposition elle-même est refusée si l'identité est incomplète (« … avant
// d’envoyer un compte rendu »).
test('refus : identité incomplète à l’ouverture et au PDF du compte rendu, passerelle en échec pour le contrat, sans aucun envoi enregistré', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const token = session.token;
  const suffixe = `${Date.now()}`;
  const client = await creerClient('envoi refusé');
  const intervention = await interventionEnCours(request, token, { clientId: client.id, titre: `E2E Envoi refusé ${suffixe}` }, `Compte rendu refusé ${suffixe}.`);
  const contrat = await creerContrat(request, token, client.id, `E2E Contrat envoi refuse ${suffixe}`);
  const { siret } = await societe(request, token);
  const page = await allerSurPageAdmin(`/interventions/${intervention.id}`);
  const bouton = page.getByRole('button', { name: nomEnvoiCompteRendu(intervention.reference), exact: true });
  const dialogue = page.getByRole('dialog', { name: nomEnvoiCompteRendu(intervention.reference) });
  let telecharge = false;
  page.on('download', () => { telecharge = true; });
  try {
    // À l'ouverture : la proposition ne se calcule pas sans la raison sociale imprimée.
    await appel(request, token, 'put', '/company', { siret: '' });
    await bouton.click();
    await expect(dialogue.getByRole('alert')).toHaveText('Identité de la société incomplète : renseignez SIRET dans l’écran Société avant d’envoyer un compte rendu.');
    await expect(dialogue.getByRole('textbox', { name: 'Destinataire' })).toHaveCount(0);
    await expect(dialogue.getByRole('button', { name: 'Préparer l’envoi' })).toBeDisabled();
    await dialogue.getByRole('button', { name: 'Fermer' }).click();

    // À la préparation : le PDF est refusé d'abord, son refus s'affiche, et rien n'est enregistré.
    await appel(request, token, 'put', '/company', { siret });
    await bouton.click();
    await dialogue.getByRole('textbox', { name: 'Destinataire' }).fill('client@exemple-e2e.test');
    await appel(request, token, 'put', '/company', { siret: '' });
    const pdf = page.waitForResponse((r) => r.url().endsWith(`/api/interventions/${intervention.id}/document.pdf`), { timeout: 10_000 });
    await dialogue.getByRole('button', { name: 'Préparer l’envoi' }).click();
    expect((await pdf).status()).toBe(409);
    await expect(dialogue.getByRole('alert')).toHaveText('Identité de la société incomplète : renseignez SIRET dans l’écran Société avant d’imprimer un compte rendu.');
    await expect(dialogue.getByRole('link', { name: 'Ouvrir la messagerie' })).toHaveCount(0);
    await expect(dialogue).toContainText('Aucun envoi préparé pour ce document.');
    expect(telecharge).toBe(false);
  } finally {
    await request.put(`${api}/company`, { headers: auth(token), data: { siret } });
  }
  expect(await envoisDe(request, token, `/interventions/${intervention.id}`)).toEqual([]);

  // Le PDF du contrat échoue autrement (passerelle, proxy) : l'erreur s'affiche, et rien n'est enregistré
  // non plus, alors que le serveur aurait accepté l'envoi.
  await page.goto('/contrats-maintenance', { waitUntil: 'networkidle' });
  await page.route(`**/api/contrats-maintenance/${contrat.id}/document.pdf`, (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Bad Gateway</body></html>' }));
  await page.getByRole('button', { name: nomEnvoiContrat(contrat.titre), exact: true }).click();
  const dialogueContrat = page.getByRole('dialog', { name: nomEnvoiContrat(contrat.titre) });
  await dialogueContrat.getByRole('textbox', { name: 'Destinataire' }).fill('client@exemple-e2e.test');
  await dialogueContrat.getByRole('button', { name: 'Préparer l’envoi' }).click();
  await expect(dialogueContrat.getByRole('alert')).toHaveText('Document indisponible.');
  await expect(dialogueContrat.getByRole('link', { name: 'Ouvrir la messagerie' })).toHaveCount(0);
  await expect(dialogueContrat.getByRole('button', { name: 'Préparer l’envoi' })).toBeEnabled();
  await expect(dialogueContrat).toContainText('Aucun envoi préparé pour ce document.');
  expect(telecharge).toBe(false);
  expect(await envoisDe(request, token, `/contrats-maintenance/${contrat.id}`)).toEqual([]);
});

// Cadrage, « Écran » : le bouton « Envoyer » de la fiche dans les mêmes conditions que le bouton « PDF »
// (hors technicien, au moins un compte rendu) et pour un compte qui porte clients:read (B3) : le
// responsable ne l'a pas par son type de compte ; un droit accordé individuellement le lui rouvre.
test('bouton « Envoyer » absent sans compte rendu, pour le technicien affecté, et pour le responsable sans clients:read, qui garde le « PDF » ; le droit accordé, il apparaît', async ({ allerSurPageAdmin, browser, creerClient, request, session }) => {
  test.slow();
  const token = session.token;
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const client = await creerClient('envoi bouton');

  // Sans compte rendu : la fiche s'affiche, sans « PDF » ni « Envoyer ».
  const sansCompteRendu = await interventionEnCours(request, token, { clientId: client.id, titre: `E2E Envoi sans compte rendu ${suffixe}` });
  const page = await allerSurPageAdmin(`/interventions/${sansCompteRendu.id}`);
  await expect(page.getByRole('heading', { name: `E2E Envoi sans compte rendu ${suffixe}` })).toBeVisible();
  await expect(page.getByTestId('pdf-compte-rendu')).toHaveCount(0);
  await expect(page.getByRole('button', { name: nomEnvoiCompteRendu(sansCompteRendu.reference), exact: true })).toHaveCount(0);

  // Technicien affecté : il voit sa fiche et son compte rendu, ni « PDF » ni « Envoyer ».
  const technicien = await appel<Compte>(request, token, 'post', '/users', { email: `envoi.technicien.${suffixe}@iris.test`, name: `Technicien envoi ${suffixe}`, role: 'TECHNICIEN' });
  const fiche = await appel<{ id: string }>(request, token, 'post', '/intervenants', { nom: `Fiche envoi ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 40 }, 200);
  await appel(request, token, 'put', `/intervenants/${fiche.id}/compte`, { userId: technicien.id });
  const intervention = await appel<Intervention>(request, token, 'post', '/interventions', { clientId: client.id, titre: `E2E Envoi technicien ${suffixe}` });
  await appel(request, token, 'put', `/interventions/${intervention.id}/planning`, { dateDebut: dateDuJour().split('-').reverse().join('-'), creneau: 'JOURNEE', intervenantIds: [fiche.id] });
  await appel(request, token, 'patch', `/interventions/${intervention.id}/statut`, { statut: 'EN_COURS' });
  const texteTechnicien = `Compte rendu du technicien ${suffixe}.`;
  const parTechnicien = await request.post(`${api}/interventions/${intervention.id}/rapports`, { headers: auth(jetonPour(technicien.id)), data: { contenu: texteTechnicien, cleEnvoi: randomUUID() } });
  expect(parTechnicien.status(), await parTechnicien.text()).toBe(201);
  const vueTechnicien = await pageDe(browser, technicien, ['chantiers:read', 'clients:read'], 375);
  try {
    await vueTechnicien.page.goto(`/interventions/${intervention.id}`, { waitUntil: 'networkidle' });
    await expect(vueTechnicien.page.getByText(texteTechnicien)).toBeVisible();
    await expect(vueTechnicien.page.getByTestId('pdf-compte-rendu')).toHaveCount(0);
    await expect(vueTechnicien.page.getByRole('button', { name: nomEnvoiCompteRendu(intervention.reference), exact: true })).toHaveCount(0);
    await expect(vueTechnicien.page.getByRole('button', { name: /^Envoyer le compte rendu/ })).toHaveCount(0);
  } finally {
    await vueTechnicien.contexte.close();
  }
  // L'administration, elle, a les deux boutons sur cette fiche.
  await page.goto(`/interventions/${intervention.id}`, { waitUntil: 'networkidle' });
  await expect(page.getByText(texteTechnicien)).toBeVisible();
  await expect(page.getByTestId('pdf-compte-rendu')).toBeVisible();
  await expect(page.getByRole('button', { name: nomEnvoiCompteRendu(intervention.reference), exact: true })).toBeVisible();

  // Responsable de l'affaire : il lit la fiche et son PDF, sans « Envoyer » tant qu'il n'a pas clients:read.
  const responsable = await appel<Compte>(request, token, 'post', '/users', { email: `envoi.responsable.${suffixe}@iris.test`, name: `Responsable envoi ${suffixe}`, role: 'RESPONSABLE' });
  const devis = await appel<{ id: string }>(request, token, 'post', '/devis', { clientId: client.id, objet: `E2E Affaire du responsable ${suffixe}`, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] });
  await appel(request, token, 'put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await appel(request, token, 'post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await appel<{ id: string }>(request, token, 'post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' });
  await appel(request, token, 'patch', `/chantiers/${chantier.id}`, { responsableId: responsable.id });
  const deLAffaire = await interventionEnCours(request, token, { clientId: client.id, chantierId: chantier.id, titre: `E2E Envoi responsable ${suffixe}` }, `Compte rendu de l’affaire ${suffixe}.`);
  const vueResponsable = await pageDe(browser, responsable, ['chantiers:read', 'chantiers:write', 'chantiers:archive']);
  try {
    await vueResponsable.page.goto(`/interventions/${deLAffaire.id}`, { waitUntil: 'networkidle' });
    await expect(vueResponsable.page.getByText(`Compte rendu de l’affaire ${suffixe}.`)).toBeVisible();
    await expect(vueResponsable.page.getByTestId('pdf-compte-rendu')).toBeVisible();
    await expect(vueResponsable.page.getByRole('button', { name: nomEnvoiCompteRendu(deLAffaire.reference), exact: true })).toHaveCount(0);
    // Le droit accordé individuellement : le bouton apparaît au chargement suivant, et le dialogue s'ouvre.
    await appel(request, token, 'put', `/users/${responsable.id}/permissions`, { permissions: ['clients:read'] });
    await vueResponsable.page.reload({ waitUntil: 'networkidle' });
    const bouton = vueResponsable.page.getByRole('button', { name: nomEnvoiCompteRendu(deLAffaire.reference), exact: true });
    await expect(bouton).toBeVisible();
    await bouton.click();
    await expect(vueResponsable.page.getByRole('dialog', { name: nomEnvoiCompteRendu(deLAffaire.reference) }).getByRole('textbox', { name: 'Destinataire' })).toBeVisible();
  } finally {
    await vueResponsable.contexte.close();
  }
});

test('à 375 px : boutons et dialogue d’envoi du compte rendu et du contrat sans défilement horizontal', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const token = session.token;
  const suffixe = `${Date.now()}`;
  const client = await creerClient('envoi mobile 6a4d');
  const long = `destinataire.au.nom.particulierement.long.${suffixe}@sous-domaine.client-e2e.test`;
  await appel(request, token, 'put', `/clients/${client.id}`, { email: long });
  const intervention = await interventionEnCours(request, token, { clientId: client.id, titre: `E2E Envoi mobile ${suffixe}` }, `Compte rendu mobile ${suffixe}.`);
  const contrat = await creerContrat(request, token, client.id, `E2E Contrat envoi mobile ${suffixe}`);

  const page = await allerSurPageAdmin(`/interventions/${intervention.id}`);
  await page.setViewportSize({ width: 375, height: 800 });
  const bouton = page.getByRole('button', { name: nomEnvoiCompteRendu(intervention.reference), exact: true });
  await bouton.scrollIntoViewIfNeeded();
  await sansDebordement(page, 375, [bouton, page.getByTestId('pdf-compte-rendu')]);
  await bouton.click();
  const dialogue = page.getByRole('dialog', { name: nomEnvoiCompteRendu(intervention.reference) });
  await expect(dialogue.getByRole('textbox', { name: 'Destinataire' })).toHaveValue(long);
  await expect(dialogue).toBeInViewport();
  await pdfTelecharge(page, () => dialogue.getByRole('button', { name: 'Préparer l’envoi' }).click(), fichierCompteRendu(intervention.reference));
  const lien = dialogue.getByRole('link', { name: 'Ouvrir la messagerie' });
  await expect(lien).toBeVisible();
  await sansDebordement(page, 375, [dialogue, lien, dialogue.getByRole('button', { name: 'Préparer l’envoi' }), dialogue.getByRole('button', { name: 'Fermer' }), dialogue.getByRole('region', { name: 'Envois préparés' }).getByRole('listitem').first()]);

  await page.goto('/contrats-maintenance', { waitUntil: 'networkidle' });
  const boutonContrat = page.getByRole('button', { name: nomEnvoiContrat(contrat.titre), exact: true });
  await boutonContrat.scrollIntoViewIfNeeded();
  await sansDebordement(page, 375, [boutonContrat, page.getByTestId(`pdf-contrat-${contrat.id}`)]);
  await boutonContrat.click();
  const dialogueContrat = page.getByRole('dialog', { name: nomEnvoiContrat(contrat.titre) });
  await expect(dialogueContrat.getByRole('textbox', { name: 'Destinataire' })).toHaveValue(long);
  await expect(dialogueContrat).toBeInViewport();
  await pdfTelecharge(page, () => dialogueContrat.getByRole('button', { name: 'Préparer l’envoi' }).click(), fichierContrat(contrat.titre));
  await expect(dialogueContrat.getByRole('link', { name: 'Ouvrir la messagerie' })).toBeVisible();
  await sansDebordement(page, 375, [dialogueContrat, dialogueContrat.getByRole('link', { name: 'Ouvrir la messagerie' }), dialogueContrat.getByRole('button', { name: 'Préparer l’envoi' }), dialogueContrat.getByRole('region', { name: 'Envois préparés' }).getByRole('listitem').first()]);
});
