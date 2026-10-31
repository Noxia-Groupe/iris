import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import type { APIRequestContext, Browser, Locator, Page } from '@playwright/test';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Lot 6a-4e (cadrage du lot 6a-4, version 9 du 31-10-2026, section « 6a-4e », version 2 du lot) : le rapport de
// chantier remis au client (PDF du lot 6a-4c, sans montant ni heures) s'envoie par la messagerie de l'utilisateur,
// avec le dialogue des lots 6a-3 et 6a-4d. Sur la fiche chantier, un bouton « Envoyer », à côté de « Rapport client
// (PDF) », réservé à l'administration, sauf pour un chantier annulé, hors de la capture du « Rapport interne (PDF) »
// (data-html2canvas-ignore). Il ouvre le dialogue dans une fenêtre superposée, rendue par un portail vers
// document.body, donc hors de `main`, qui défile à 375 px et ne se ferme que par « Fermer » (N7). « Préparer
// l'envoi » télécharge le PDF, enregistre l'envoi au journal, puis propose le lien de la messagerie, que ces
// parcours ne cliquent pas : seul son href est lu. Si le PDF est refusé, rien n'est enregistré.

type Chantier = { id: string; nom: string; statut: string };
type Intervention = { id: string; reference: string; titre: string };
type Envoi = { id: string; destinataire: string; objet: string; auteurNom: string; createdAt: string };
type Compte = { id: string; name: string; email: string; role: string };

// Objet et texte du cadrage, mot pour mot (choix par défaut, à confirmer).
const objetRapport = (nom: string, raisonSociale: string) => `Rapport de chantier ${nom} – ${raisonSociale}`;
const corpsRapport = (nom: string, raisonSociale: string) => `Bonjour,\n\nVeuillez trouver ci-joint le rapport de chantier ${nom}.\n\nCordialement,\n${raisonSociale}`;
const lienAttendu = (destinataire: string, objet: string, corps: string) =>
  `mailto:${destinataire}?subject=${encodeURIComponent(objet)}&body=${encodeURIComponent(corps.replace(/\n/g, '\r\n'))}`;
// Nom accessible du bouton : « Envoyer le rapport de chantier {nom} » ; le dialogue porte le même nom (« Envoyer »
// suivi de son libellé, « le rapport de chantier {nom} »).
const nomEnvoi = (nom: string) => `Envoyer le rapport de chantier ${nom}`;
// Fichier joint : `nomFichierRapportChantier(chantier)`, le même que le bouton « Rapport client (PDF) » : le nom réduit
// aux lettres sans accent, aux chiffres, au tiret et au tiret bas, toute autre suite devenant un tiret.
const nomReduit = (nom: string) => nom.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
const fichierRapport = (nom: string) => `Rapport-chantier-${nomReduit(nom)}.pdf`;
const REFUS_OUVERTURE = 'Identité de la société incomplète : renseignez SIRET dans l’écran Société avant d’envoyer un rapport de chantier.';
const REFUS_PDF = 'Identité de la société incomplète : renseignez SIRET dans l’écran Société avant d’imprimer un rapport de chantier.';

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable ouvre une session dans un
// rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

// Texte d'un PDF produit par PDFKit (comme rapport-chantier-pdf.spec.ts) : les chaînes des opérateurs TJ et Tj de
// chaque flux de contenu décompressé, lues dans le jeu WinAnsi.
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
async function envoisDe(request: APIRequestContext, token: string, chantierId: string) {
  return (await appel<{ envois: Envoi[] }>(request, token, 'get', `/chantiers/${chantierId}/envois`)).envois;
}
// Chantier ouvert par la conversion d'un devis signé (seule porte d'ouverture d'une affaire). Avec `temoin`, il porte
// le montant témoin de 4 321,09 € HT vendu, 37,25 h pointées (37 h 15) et une intervention rattachée qui porte un
// compte rendu (comme rapport-chantier-pdf.spec.ts) : le rapport envoyé ne passe pas à vide.
async function chantierConverti(request: APIRequestContext, token: string, clientId: string, nom: string, temoin = false) {
  const devis = await appel<{ id: string }>(request, token, 'post', '/devis', { clientId, objet: nom, lignes: [{ designation: 'Pose et mise en service', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: temoin ? 4321.09 : 100, tauxTva: 20 }] });
  await appel(request, token, 'put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await appel(request, token, 'post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await appel<Chantier & { budgetGlobalVendu: number }>(request, token, 'post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' });
  let compteRendu = '';
  let intervention: Intervention | null = null;
  if (temoin) {
    expect(chantier.budgetGlobalVendu).toBe(4321.09);
    const intervenant = await appel<{ id: string }>(request, token, 'post', '/intervenants', { nom: `Intervenant envoi rapport ${Date.now()}`, role: 'Technicien', tauxHoraireCharge: 48.13 }, 200);
    await appel(request, token, 'post', '/heures', { chantierId: chantier.id, intervenantId: intervenant.id, date: dateDuJour(), nbrHeures: 37.25 }, 200);
    intervention = await appel<Intervention>(request, token, 'post', '/interventions', { clientId, chantierId: chantier.id, titre: `Demande du rapport envoyé ${Date.now()}` });
    await appel(request, token, 'patch', `/interventions/${intervention.id}/statut`, { statut: 'PLANIFIEE' });
    await appel(request, token, 'patch', `/interventions/${intervention.id}/statut`, { statut: 'EN_COURS' });
    compteRendu = `Compte rendu du rapport envoyé ${Date.now()}.`;
    await appel(request, token, 'post', `/interventions/${intervention.id}/rapports`, { contenu: compteRendu, cleEnvoi: randomUUID() });
  }
  return { devis, chantier, intervention, compteRendu };
}
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
// La fenêtre : hors de `main` (donc hors de la zone capturée du « Rapport interne (PDF) », qui est dans `main`), et
// superposée (un ancêtre en position fixe).
async function placeDeLaFenetre(dialogue: Locator) {
  return dialogue.evaluate((el) => {
    let fixe = false;
    for (let e: Element | null = el; e; e = e.parentElement) if (getComputedStyle(e).position === 'fixed') fixe = true;
    return { horsDeMain: el.closest('main') === null, superposee: fixe, dansLaPage: document.body.contains(el) };
  });
}
// Barre d'actions de la fiche : le plus petit bloc qui contient « Rapport interne (PDF) » et « Rapport client (PDF) ».
const barreActions = (page: Page) => page.locator('div')
  .filter({ has: page.getByRole('button', { name: 'Rapport interne (PDF)', exact: true }) })
  .filter({ has: page.getByTestId('rapport-client-pdf') }).last();
async function pageDe(browser: Browser, compte: Compte, largeur = 1280) {
  const contexte = await browser.newContext({ viewport: { width: largeur, height: 900 } });
  const page = await contexte.newPage();
  await page.addInitScript(([jeton, utilisateur]) => {
    localStorage.setItem('token', jeton as string);
    localStorage.setItem('user', utilisateur as string);
  }, [jetonPour(compte.id), JSON.stringify({ ...compte, permissions: [] })]);
  return { contexte, page };
}

// Cadrage, « Tests », E2E : « depuis la fiche chantier, en administration, « Envoyer » ouvre le dialogue » ;
// « « Préparer l'envoi » télécharge Rapport-chantier-<nom>.pdf, ajoute « Envoi préparé » au journal et propose le
// lien » ; « la fenêtre est rendue hors de main (el.closest('main') === null) » ; « Fermeture » (N7) : « par
// « Fermer » seul, et non d'un clic à l'extérieur » ; « Envoyer ne change aucun statut du chantier ».
test('rapport de chantier : envoi préparé depuis la fiche, PDF téléchargé sans montant, « Envoi préparé » au journal, lien de la messagerie exact ; fenêtre hors de main, fermée par « Fermer » seul ; statut inchangé', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  test.slow();
  const token = session.token;
  const suffixe = `${Date.now()}`;
  const client = await creerClient('envoi rapport de chantier');
  const principal = `principal.${suffixe}@client-e2e.test`;
  await appel(request, token, 'post', `/clients/${client.id}/contacts`, { nom: 'Principal', email: principal, principal: true });
  const nom = `E2E Envoi rapport ${suffixe}`;
  const { chantier, intervention, compteRendu } = await chantierConverti(request, token, client.id, nom, true);
  const { raisonSociale, fuseauHoraire } = await societe(request, token);
  const emetteur = raisonSociale.trim();
  const objet = objetRapport(nom, emetteur);
  const corps = corpsRapport(nom, emetteur);
  const auteur = (session.user as { name: string }).name;

  const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  await expect(page.getByRole('heading', { name: nom })).toBeVisible();
  // Le bouton : à côté de « Rapport client (PDF) », en quatrième, hors de la capture, avec son nom accessible.
  const bouton = page.getByRole('button', { name: nomEnvoi(nom), exact: true });
  await expect(bouton).toBeVisible();
  await expect(bouton).toHaveText('Envoyer');
  await expect(bouton).toHaveAttribute('data-testid', 'envoyer-rapport-client');
  await expect(bouton).toHaveAttribute('data-html2canvas-ignore');
  expect((await barreActions(page).getByRole('button').allTextContents()).map((texte) => texte.trim())).toEqual(['Modifier', 'Rapport interne (PDF)', 'Rapport client (PDF)', 'Envoyer']);
  await bouton.click();

  const dialogue = page.getByRole('dialog', { name: nomEnvoi(nom) });
  await expect(dialogue).toBeVisible();
  await expect(dialogue).toBeInViewport();
  expect(await placeDeLaFenetre(dialogue)).toEqual({ horsDeMain: true, superposee: true, dansLaPage: true });
  const destinataire = dialogue.getByRole('textbox', { name: 'Destinataire' });
  await expect(destinataire).toHaveValue(principal);
  await expect(dialogue).toContainText(`Objet : ${objet}`);
  await expect(dialogue).toContainText('Aucun envoi préparé pour ce document.');
  await expect(dialogue.getByRole('link', { name: 'Ouvrir la messagerie' })).toHaveCount(0);
  // Un clic à l'extérieur, sur le fond de la fenêtre, ne la ferme pas.
  await page.mouse.click(5, 5);
  await expect(dialogue).toBeVisible();
  await expect(destinataire).toHaveValue(principal);

  const texte = await pdfTelecharge(page, () => dialogue.getByRole('button', { name: 'Préparer l’envoi' }).click(), fichierRapport(nom));
  expect(fichierRapport(nom)).toBe(`Rapport-chantier-E2E-Envoi-rapport-${suffixe}.pdf`);
  for (const attendu of ['Rapport de chantier', nom, client.raisonSociale, intervention!.reference, compteRendu]) expect(texte, `absent du PDF : ${attendu}`).toContain(attendu);
  // Le PDF joint est le rapport remis au client : ni le vendu (4 321,09), ni les 37,25 h pointées, ni symbole monétaire.
  for (const interdit of ['4 321', '4321', '37,25', '37.25', '37 h', '2235', '48,13', '€', '\x80']) expect(texte, `imprimé à tort : ${interdit}`).not.toContain(interdit);
  const lien = dialogue.getByRole('link', { name: 'Ouvrir la messagerie' });
  await expect(lien).toHaveAttribute('href', lienAttendu(principal, objet, corps));
  await expect(dialogue.getByRole('status')).toContainText(`Le PDF ${fichierRapport(nom)} vient d’être téléchargé : joignez-le à la main au courriel.`);
  const envois = await envoisDe(request, token, chantier.id);
  expect(envois).toHaveLength(1);
  expect(envois[0]).toMatchObject({ destinataire: principal, objet, auteurNom: auteur });
  const liste = dialogue.getByRole('region', { name: 'Envois préparés' }).getByRole('listitem');
  await expect(liste).toHaveText([`Envoi préparé le ${dateHeure(envois[0].createdAt, fuseauHoraire || 'Europe/Paris')} à ${principal} par ${auteur}`]);
  // Ni l'objet ni le texte ne portent de montant ni d'heures.
  for (const interdit of ['4 321', '4321', '37,25', '37 h', '€']) expect(`${objet}\n${corps}`).not.toContain(interdit);

  // Fermée par « Fermer » ; le journal se relit à la réouverture.
  await page.mouse.click(5, 5);
  await expect(lien).toBeVisible();
  await dialogue.getByRole('button', { name: 'Fermer' }).click();
  await expect(dialogue).toHaveCount(0);
  await bouton.click();
  await expect(dialogue.getByRole('region', { name: 'Envois préparés' }).getByRole('listitem')).toHaveCount(1);
  await dialogue.getByRole('button', { name: 'Fermer' }).click();
  await expect(dialogue).toHaveCount(0);

  // L'envoi ne change pas le statut du chantier, relu par l'API.
  expect((await appel<Chantier>(request, token, 'get', `/chantiers/${chantier.id}`)).statut).toBe('EN_COURS');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

// Cadrage, « Périmètre » : « si le PDF est refusé ou échoue, rien n'est enregistré » ; E2E : « le refus du PDF
// (identité incomplète) n'écrit rien ». À l'ouverture, la proposition elle-même est refusée si l'identité est
// incomplète (« … avant d’envoyer un rapport de chantier »).
test('refus : identité incomplète à l’ouverture et au PDF du rapport, sans aucun envoi enregistré ni fichier', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const token = session.token;
  const suffixe = `${Date.now()}`;
  const client = await creerClient('envoi rapport refusé');
  const nom = `E2E Envoi rapport refuse ${suffixe}`;
  const { chantier } = await chantierConverti(request, token, client.id, nom);
  const { siret } = await societe(request, token);
  const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  const bouton = page.getByRole('button', { name: nomEnvoi(nom), exact: true });
  const dialogue = page.getByRole('dialog', { name: nomEnvoi(nom) });
  let telecharge = false;
  page.on('download', () => { telecharge = true; });
  try {
    // À l'ouverture : la proposition ne se calcule pas sans la raison sociale imprimée.
    await appel(request, token, 'put', '/company', { siret: '' });
    await bouton.click();
    await expect(dialogue.getByRole('alert')).toHaveText(REFUS_OUVERTURE);
    await expect(dialogue.getByRole('textbox', { name: 'Destinataire' })).toHaveCount(0);
    await expect(dialogue.getByRole('button', { name: 'Préparer l’envoi' })).toBeDisabled();
    await dialogue.getByRole('button', { name: 'Fermer' }).click();
    await expect(dialogue).toHaveCount(0);

    // À la préparation : le PDF est refusé d'abord, son refus s'affiche dans la fenêtre, et rien n'est enregistré.
    await appel(request, token, 'put', '/company', { siret });
    await bouton.click();
    await dialogue.getByRole('textbox', { name: 'Destinataire' }).fill('client@exemple-e2e.test');
    await appel(request, token, 'put', '/company', { siret: '' });
    const pdf = page.waitForResponse((r) => r.url().endsWith(`/api/chantiers/${chantier.id}/document.pdf`), { timeout: 10_000 });
    await dialogue.getByRole('button', { name: 'Préparer l’envoi' }).click();
    expect((await pdf).status()).toBe(409);
    await expect(dialogue.getByRole('alert')).toHaveText(REFUS_PDF);
    await expect(dialogue.getByRole('link', { name: 'Ouvrir la messagerie' })).toHaveCount(0);
    await expect(dialogue.getByRole('button', { name: 'Préparer l’envoi' })).toBeEnabled();
    await expect(dialogue).toContainText('Aucun envoi préparé pour ce document.');
    expect(telecharge).toBe(false);
  } finally {
    const retour = await request.put(`${api}/company`, { headers: auth(token), data: { siret } });
    expect(retour.ok(), await retour.text()).toBeTruthy();
  }
  expect(await envoisDe(request, token, chantier.id)).toEqual([]);
});

// Cadrage, « Écran » : le bouton « réservé à l'administration, sauf pour un chantier annulé » ; « Chantier annulé,
// en lecture » : « Son PDF reste imprimable […]. L'écran ne lui affiche pas de bouton « Envoyer » » ; « Droits » :
// l'administration seule (choix par défaut, le plus restrictif, à confirmer). E2E : « ni le conducteur, ni un
// chantier annulé n'affichent le bouton ». Le titulaire garde sa fiche et le rapport interne ; le serveur lui
// refuse la lecture des envois.
test('bouton « Envoyer » absent pour le conducteur titulaire, qui garde le rapport interne, et pour un chantier annulé, qui garde le « Rapport client (PDF) »', async ({ allerSurPageAdmin, browser, creerClient, request, session }) => {
  const token = session.token;
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const client = await creerClient('envoi rapport bouton');
  const nom = `E2E Envoi rapport conducteur ${suffixe}`;
  const { chantier } = await chantierConverti(request, token, client.id, nom);
  const conducteur = await appel<Compte>(request, token, 'post', '/users', { email: `envoi.rapport.conducteur.${suffixe}@iris.test`, name: `Conducteur envoi rapport ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' });
  await appel(request, token, 'patch', `/chantiers/${chantier.id}`, { responsableId: conducteur.id });

  const vue = await pageDe(browser, conducteur);
  try {
    await vue.page.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
    await expect(vue.page.getByRole('heading', { name: nom })).toBeVisible();
    await expect(vue.page.getByRole('button', { name: 'Rapport interne (PDF)', exact: true })).toBeVisible();
    await expect(vue.page.getByTestId('envoyer-rapport-client')).toHaveCount(0);
    await expect(vue.page.getByRole('button', { name: /^Envoyer/ })).toHaveCount(0);
    await expect(vue.page.getByRole('dialog')).toHaveCount(0);
  } finally {
    await vue.contexte.close();
  }
  const refus = await request.get(`${api}/chantiers/${chantier.id}/envois`, { headers: auth(jetonPour(conducteur.id)) });
  expect(refus.status(), await refus.text()).toBe(403);

  // Chantier annulé par l'annulation de son devis : la fiche, le « Rapport client (PDF) », pas d'« Envoyer ».
  const nomAnnule = `E2E Envoi rapport annule ${suffixe}`;
  const { devis, chantier: annule } = await chantierConverti(request, token, client.id, nomAnnule);
  await appel(request, token, 'post', `/devis/${devis.id}/annulation`, { motif: 'E2E Annulation du devis du chantier envoyé' }, 200);
  expect((await appel<Chantier>(request, token, 'get', `/chantiers/${annule.id}`)).statut).toBe('ANNULE');
  const page = await allerSurPageAdmin(`/chantiers/${annule.id}`);
  await expect(page.getByRole('heading', { name: nomAnnule })).toBeVisible();
  await expect(page.getByTestId('rapport-client-pdf')).toBeVisible();
  await expect(page.getByTestId('envoyer-rapport-client')).toHaveCount(0);
  await expect(page.getByRole('button', { name: nomEnvoi(nomAnnule), exact: true })).toHaveCount(0);
  // Témoin : sur un chantier en cours, l'administration a bien le bouton.
  await page.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: nomEnvoi(nom), exact: true })).toBeVisible();
});

// Cadrage, « Écran » : la fenêtre « avec max-h-[90vh] overflow-y-auto pour défiler à 375 px » ; E2E : « vue à 375 px :
// la fenêtre défile, sans défilement horizontal du document » (N3). Un nom de chantier et un destinataire longs, sur
// un écran de 640 px de haut, font dépasser le dialogue une fois l'envoi préparé.
test('à 375 px : le bouton tient dans l’écran ; la fenêtre défile, sans défilement horizontal du document, jusqu’au journal', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const token = session.token;
  const suffixe = `${Date.now()}`;
  const client = await creerClient('envoi rapport mobile');
  const long = `destinataire.au.nom.particulierement.long.${suffixe}@sous-domaine.client-e2e.test`;
  await appel(request, token, 'put', `/clients/${client.id}`, { email: long });
  const nom = `E2E Envoi rapport mobile renovation complete de la chaufferie collective ${suffixe}`;
  const { chantier } = await chantierConverti(request, token, client.id, nom);

  const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  await page.setViewportSize({ width: 375, height: 640 });
  const bouton = page.getByRole('button', { name: nomEnvoi(nom), exact: true });
  await expect(bouton).toBeVisible();
  const boite = await bouton.boundingBox();
  expect(boite && boite.x >= 0 && boite.x + boite.width <= 375, 'le bouton tient dans la largeur de l’écran').toBe(true);
  await bouton.click();
  const dialogue = page.getByRole('dialog', { name: nomEnvoi(nom) });
  await expect(dialogue.getByRole('textbox', { name: 'Destinataire' })).toHaveValue(long);
  await pdfTelecharge(page, () => dialogue.getByRole('button', { name: 'Préparer l’envoi' }).click(), fichierRapport(nom));
  await expect(dialogue.getByRole('link', { name: 'Ouvrir la messagerie' })).toBeVisible();
  await expect(dialogue.getByRole('region', { name: 'Envois préparés' }).getByRole('listitem')).toHaveCount(1);

  // Aucun défilement horizontal du document ; la fenêtre et ses commandes dans la largeur de l'écran.
  expect(await page.evaluate(() => document.documentElement.scrollWidth), 'défilement horizontal du document').toBeLessThanOrEqual(375);
  // La fenêtre défile : son conteneur défilant tient dans 90 % de la hauteur de l'écran et son contenu le dépasse.
  const defilement = await dialogue.evaluate((el) => {
    let e: Element | null = el;
    while (e && !['auto', 'scroll'].includes(getComputedStyle(e).overflowY)) e = e.parentElement;
    if (!e) return null;
    const avant = e.scrollTop;
    e.scrollTop = e.scrollHeight;
    return { hauteur: e.clientHeight, contenu: e.scrollHeight, deplace: e.scrollTop > avant, horsDeMain: e.closest('main') === null };
  });
  expect(defilement, 'conteneur défilant de la fenêtre').not.toBeNull();
  expect(defilement!.hauteur).toBeLessThanOrEqual(640 * 0.9 + 1);
  expect(defilement!.contenu, 'le contenu dépasse la fenêtre').toBeGreaterThan(defilement!.hauteur);
  expect(defilement!.deplace, 'la fenêtre défile').toBe(true);
  expect(defilement!.horsDeMain).toBe(true);
  // Défilée jusqu'en bas, le journal est atteint, et chaque commande tient dans la largeur.
  const journal = dialogue.getByRole('region', { name: 'Envois préparés' }).getByRole('listitem').first();
  await expect(journal).toBeInViewport();
  for (const element of [dialogue, dialogue.getByRole('link', { name: 'Ouvrir la messagerie' }), dialogue.getByRole('button', { name: 'Préparer l’envoi' }), dialogue.getByRole('button', { name: 'Fermer' }), journal]) {
    const cadre = await element.boundingBox();
    expect(cadre, 'élément affiché').toBeTruthy();
    expect(cadre!.x).toBeGreaterThanOrEqual(0);
    expect(cadre!.x + cadre!.width).toBeLessThanOrEqual(375);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth), 'défilement horizontal du document').toBeLessThanOrEqual(375);
  await dialogue.getByRole('button', { name: 'Fermer' }).click();
  await expect(dialogue).toHaveCount(0);
});
