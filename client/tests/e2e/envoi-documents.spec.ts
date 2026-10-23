import { readFile } from 'node:fs/promises';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Lot 6a-3 : un devis, une facture ou un avoir émis s'envoie par la messagerie de l'utilisateur.
// « Préparer l'envoi » télécharge le PDF, enregistre l'envoi au journal, puis propose le lien mailto
// (destinataire, objet et texte remplis), que ces parcours ne cliquent pas : seul son href est lu.

type Envoi = { id: string; destinataire: string; objet: string; auteurNom: string; createdAt: string };
const corpsAttendu = (joint: string, raisonSociale: string) => `Bonjour,\n\nVeuillez trouver ci-joint ${joint}.\n\nCordialement,\n${raisonSociale}`;
const lienAttendu = (destinataire: string, objet: string, corps: string) =>
  `mailto:${destinataire}?subject=${encodeURIComponent(objet)}&body=${encodeURIComponent(corps.replace(/\n/g, '\r\n'))}`;

async function societe(request: APIRequestContext, token: string) {
  return await (await request.get(`${api}/company`, { headers: auth(token) })).json() as { raisonSociale: string; siret: string; fuseauHoraire: string | null };
}
async function creerDevis(request: APIRequestContext, token: string, clientId: string, objet: string) {
  const cree = await request.post(`${api}/devis`, { headers: auth(token), data: { clientId, objet: `${objet} ${Date.now()}`, lignes: [{ designation: 'Diagnostic', quantite: 1, prixUnitaireHt: 80, tauxTva: 20 }] } });
  expect(cree.status(), await cree.text()).toBe(201);
  return await cree.json() as { id: string; numero: string; version: number; statut: string };
}
async function envoisDe(request: APIRequestContext, token: string, chemin: string) {
  const lu = await request.get(`${api}/${chemin}/envois`, { headers: auth(token) });
  expect(lu.status(), await lu.text()).toBe(200);
  return (await lu.json() as { envois: Envoi[] }).envois;
}
// Date et heure d'un envoi au fuseau de la société, comme l'écran : JJ-MM-AAAA HH:MM.
function dateHeure(instant: string, fuseau: string) {
  const parties = new Intl.DateTimeFormat('fr-FR', { timeZone: fuseau, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(instant));
  const partie = (type: string) => parties.find((p) => p.type === type)!.value;
  return `${partie('day')}-${partie('month')}-${partie('year')} ${partie('hour')}:${partie('minute')}`;
}
// Le PDF téléchargé : ses octets, et le titre du document qu'il porte.
async function pdfTelecharge(page: Page, declencher: () => Promise<void>, nomAttendu: string, titre: string) {
  const telechargement = page.waitForEvent('download');
  await declencher();
  const fichier = await telechargement;
  expect(fichier.suggestedFilename()).toBe(nomAttendu);
  const octets = await readFile(await fichier.path() as string);
  expect(octets.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(octets.includes(Buffer.from(`(${titre})`))).toBe(true);
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
// La liste des factures est paginée : la ligne du client est cherchée de page en page.
async function ligneFacture(page: Page, raisonSociale: string) {
  const ligne = page.locator('tbody tr', { hasText: raisonSociale });
  await expect(page.getByTestId('pagination-factures')).toContainText('document(s)');
  await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
  while (!(await ligne.count())) {
    const suivante = page.getByRole('button', { name: 'Page suivante' });
    expect(await suivante.isEnabled(), `facture ${raisonSociale} absente de la pagination`).toBeTruthy();
    await suivante.click();
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
  }
  return ligne;
}

test('devis : destinataire proposé et modifiable, PDF téléchargé, envoi listé, lien mailto exact, statut inchangé', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const headers = auth(session.token);
  const client = await creerClient('envoi devis');
  const suffixe = Date.now();
  const principal = `principal.${suffixe}@client-e2e.test`;
  const contact = await request.post(`${api}/clients/${client.id}/contacts`, { headers, data: { nom: 'Principal', email: principal, principal: true } });
  expect(contact.status(), await contact.text()).toBe(201);
  const devis = await creerDevis(request, session.token, client.id, 'E2E Envoi devis');
  const { raisonSociale, fuseauHoraire } = await societe(request, session.token);
  const emetteur = raisonSociale.trim();
  const objet = `Devis ${devis.numero} version 1 – ${emetteur}`;
  const corps = corpsAttendu(`notre devis ${devis.numero} (version 1)`, emetteur);
  const auteur = (session.user as { name: string }).name;

  const page = await allerSurPageAdmin('/devis');
  await page.getByRole('button', { name: `Envoyer le devis ${devis.numero} version 1`, exact: true }).click();
  const dialogue = page.getByRole('dialog', { name: `Envoyer le devis ${devis.numero} version 1` });
  const destinataire = dialogue.getByRole('textbox', { name: 'Destinataire' });
  await expect(destinataire).toHaveValue(principal);
  await expect(dialogue).toContainText(`Objet : ${objet}`);
  await expect(dialogue).toContainText('Aucun envoi préparé pour ce document.');
  await expect(dialogue.getByRole('link', { name: 'Ouvrir la messagerie' })).toHaveCount(0);

  await pdfTelecharge(page, () => dialogue.getByRole('button', { name: 'Préparer l’envoi' }).click(), `${devis.numero}-v1.pdf`, `Devis ${devis.numero} version 1`);
  const lien = dialogue.getByRole('link', { name: 'Ouvrir la messagerie' });
  await expect(lien).toHaveAttribute('href', lienAttendu(principal, objet, corps));
  await expect(dialogue.getByRole('status')).toContainText(`Le PDF ${devis.numero}-v1.pdf vient d’être téléchargé : joignez-le à la main au courriel.`);
  const [premier] = await envoisDe(request, session.token, `devis/${devis.id}`);
  expect(premier).toMatchObject({ destinataire: principal, objet, auteurNom: auteur });
  const liste = dialogue.getByRole('region', { name: 'Envois préparés' }).getByRole('listitem');
  await expect(liste).toHaveText([`Envoi préparé le ${dateHeure(premier.createdAt, fuseauHoraire || 'Europe/Paris')} à ${principal} par ${auteur}`]);

  // Le destinataire se corrige : le second envoi passe en tête, le lien suit la nouvelle adresse.
  const autre = `autre.${suffixe}@client-e2e.test`;
  await destinataire.fill(autre);
  await pdfTelecharge(page, () => dialogue.getByRole('button', { name: 'Préparer l’envoi' }).click(), `${devis.numero}-v1.pdf`, `Devis ${devis.numero} version 1`);
  await expect(lien).toHaveAttribute('href', lienAttendu(autre, objet, corps));
  await expect(liste).toHaveCount(2);
  await expect(liste.first()).toContainText(`à ${autre} par ${auteur}`);
  const envois = await envoisDe(request, session.token, `devis/${devis.id}`);
  expect(envois.map((e) => e.destinataire)).toEqual([autre, principal]);

  // Préparer l'envoi ne change pas le statut du devis.
  const relu = (await (await request.get(`${api}/devis`, { headers })).json() as { id: string; statut: string }[]).find((d) => d.id === devis.id);
  expect(relu?.statut).toBe('BROUILLON');
  // Le journal se relit à la réouverture du dialogue.
  await dialogue.getByRole('button', { name: 'Fermer' }).click();
  await expect(dialogue).toHaveCount(0);
  await page.getByRole('button', { name: `Envoyer le devis ${devis.numero} version 1`, exact: true }).click();
  await expect(dialogue.getByRole('region', { name: 'Envois préparés' }).getByRole('listitem')).toHaveCount(2);
});

test('facture : envoi d’une facture émise depuis l’écran Factures, au courriel de la fiche client', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const headers = auth(session.token);
  const client = await creerClient('envoi facture');
  const courriel = `compta.${Date.now()}@client-e2e.test`;
  const maj = await request.put(`${api}/clients/${client.id}`, { headers, data: { email: courriel } });
  expect(maj.ok(), await maj.text()).toBeTruthy();
  const emetteur = (await societe(request, session.token)).raisonSociale.trim();
  const brouillon = await request.post(`${api}/factures`, { headers, data: { clientId: client.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Parcours envoi', dateEmission: dateDuJour(), dateEcheance: dateDuJour(), lignes: [{ designation: 'Contrôle annuel', quantite: 1, prixUnitaireHt: 120, tauxTva: 20 }] } });
  expect(brouillon.status(), await brouillon.text()).toBe(201);
  const emise = await request.post(`${api}/factures/${(await brouillon.json()).id}/emettre`, { headers });
  expect(emise.status(), await emise.text()).toBe(200);
  const facture = await emise.json() as { id: string; numero: string };
  const objet = `Facture ${facture.numero} – ${emetteur}`;
  const corps = corpsAttendu(`notre facture ${facture.numero}`, emetteur);
  // Un brouillon du même client, sans document : il n'a pas de bouton « Envoyer ».
  const autreBrouillon = await request.post(`${api}/factures`, { headers, data: { clientId: client.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Parcours envoi brouillon', dateEmission: dateDuJour(), dateEcheance: dateDuJour(), lignes: [{ designation: 'Contrôle à venir', quantite: 1, prixUnitaireHt: 50, tauxTva: 20 }] } });
  expect(autreBrouillon.status(), await autreBrouillon.text()).toBe(201);

  const page = await allerSurPageAdmin('/factures');
  const lignes = await ligneFacture(page, client.raisonSociale);
  const ligne = lignes.filter({ hasText: facture.numero });
  await expect(lignes.filter({ hasText: 'Brouillon' })).toHaveCount(1);
  await expect(lignes.filter({ hasText: 'Brouillon' }).getByRole('button', { name: /^Envoyer/ })).toHaveCount(0);
  await ligne.getByRole('button', { name: `Envoyer la facture ${facture.numero}`, exact: true }).click();
  const dialogue = page.getByRole('dialog', { name: `Envoyer la facture ${facture.numero}` });
  await expect(dialogue.getByRole('textbox', { name: 'Destinataire' })).toHaveValue(courriel);
  await expect(dialogue).toContainText(`Objet : ${objet}`);
  await pdfTelecharge(page, () => dialogue.getByRole('button', { name: 'Préparer l’envoi' }).click(), `${facture.numero}.pdf`, `Facture ${facture.numero}`);
  await expect(dialogue.getByRole('link', { name: 'Ouvrir la messagerie' })).toHaveAttribute('href', lienAttendu(courriel, objet, corps));
  await expect(dialogue.getByRole('region', { name: 'Envois préparés' }).getByRole('listitem')).toHaveCount(1);
  const envois = await envoisDe(request, session.token, `factures/${facture.id}`);
  expect(envois).toHaveLength(1);
  expect(envois[0]).toMatchObject({ destinataire: courriel, objet });
  // La facture émise n'a pas changé de statut.
  await expect(ligne).toContainText('EMISE');
});

test('refus : identité incomplète à l’ouverture comme à la préparation, PDF en échec, sans aucun envoi enregistré', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const headers = auth(session.token);
  const client = await creerClient('envoi refusé');
  const devis = await creerDevis(request, session.token, client.id, 'E2E Envoi refusé');
  const { siret } = await societe(request, session.token);
  const page = await allerSurPageAdmin('/devis');
  const bouton = page.getByRole('button', { name: `Envoyer le devis ${devis.numero} version 1`, exact: true });
  const dialogue = page.getByRole('dialog', { name: `Envoyer le devis ${devis.numero} version 1` });
  let telecharge = false;
  page.on('download', () => { telecharge = true; });
  try {
    // À l'ouverture : la proposition ne se calcule pas sans la raison sociale imprimée.
    expect((await request.put(`${api}/company`, { headers, data: { siret: '' } })).ok()).toBeTruthy();
    await bouton.click();
    await expect(dialogue.getByRole('alert')).toHaveText('Identité de la société incomplète : renseignez SIRET dans l’écran Société avant d’envoyer un devis.');
    await expect(dialogue.getByRole('textbox', { name: 'Destinataire' })).toHaveCount(0);
    await expect(dialogue.getByRole('button', { name: 'Préparer l’envoi' })).toBeDisabled();
    await dialogue.getByRole('button', { name: 'Fermer' }).click();

    // À la préparation : le PDF est refusé d'abord, son refus s'affiche, et rien n'est enregistré.
    expect((await request.put(`${api}/company`, { headers, data: { siret } })).ok()).toBeTruthy();
    await bouton.click();
    await dialogue.getByRole('textbox', { name: 'Destinataire' }).fill('client@exemple-e2e.test');
    expect((await request.put(`${api}/company`, { headers, data: { siret: '' } })).ok()).toBeTruthy();
    const pdf = page.waitForResponse((r) => r.url().endsWith(`/api/devis/${devis.id}/document.pdf`), { timeout: 10_000 });
    await dialogue.getByRole('button', { name: 'Préparer l’envoi' }).click();
    expect((await pdf).status()).toBe(409);
    await expect(dialogue.getByRole('alert')).toHaveText('Identité de la société incomplète : renseignez SIRET dans l’écran Société avant d’imprimer un devis.');
    await expect(dialogue.getByRole('link', { name: 'Ouvrir la messagerie' })).toHaveCount(0);
    await expect(dialogue).toContainText('Aucun envoi préparé pour ce document.');
    expect(telecharge).toBe(false);
  } finally {
    await request.put(`${api}/company`, { headers, data: { siret } });
  }
  // Le PDF échoue autrement (passerelle, proxy) : l'erreur s'affiche, et rien n'est enregistré non
  // plus, alors que le serveur aurait accepté l'envoi.
  await page.route(`**/api/devis/${devis.id}/document.pdf`, (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Bad Gateway</body></html>' }));
  await dialogue.getByRole('button', { name: 'Préparer l’envoi' }).click();
  await expect(dialogue.getByRole('alert')).toHaveText('Document indisponible.');
  await expect(dialogue.getByRole('link', { name: 'Ouvrir la messagerie' })).toHaveCount(0);
  await expect(dialogue.getByRole('button', { name: 'Préparer l’envoi' })).toBeEnabled();
  expect(telecharge).toBe(false);
  expect(await envoisDe(request, session.token, `devis/${devis.id}`)).toEqual([]);
});

test('à 375 px : dialogue d’envoi d’un devis et d’une facture sans défilement horizontal', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const headers = auth(session.token);
  const client = await creerClient('envoi mobile');
  const long = `destinataire.au.nom.particulierement.long.${Date.now()}@sous-domaine.client-e2e.test`;
  const maj = await request.put(`${api}/clients/${client.id}`, { headers, data: { email: long } });
  expect(maj.ok(), await maj.text()).toBeTruthy();
  const devis = await creerDevis(request, session.token, client.id, 'E2E Envoi mobile');
  const brouillon = await request.post(`${api}/factures`, { headers, data: { clientId: client.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Parcours envoi mobile', dateEmission: dateDuJour(), dateEcheance: dateDuJour(), lignes: [{ designation: 'Contrôle', quantite: 1, prixUnitaireHt: 90, tauxTva: 20 }] } });
  expect(brouillon.status(), await brouillon.text()).toBe(201);
  const emise = await request.post(`${api}/factures/${(await brouillon.json()).id}/emettre`, { headers });
  expect(emise.status(), await emise.text()).toBe(200);
  const facture = await emise.json() as { id: string; numero: string };

  const page = await allerSurPageAdmin('/devis');
  await page.setViewportSize({ width: 375, height: 800 });
  const bouton = page.getByRole('button', { name: `Envoyer le devis ${devis.numero} version 1`, exact: true });
  await bouton.scrollIntoViewIfNeeded();
  await sansDebordement(page, 375, [bouton, page.getByRole('button', { name: `PDF du devis ${devis.numero} version 1`, exact: true })]);
  await bouton.click();
  const dialogue = page.getByRole('dialog', { name: `Envoyer le devis ${devis.numero} version 1` });
  await expect(dialogue.getByRole('textbox', { name: 'Destinataire' })).toHaveValue(long);
  await expect(dialogue).toBeInViewport();
  await pdfTelecharge(page, () => dialogue.getByRole('button', { name: 'Préparer l’envoi' }).click(), `${devis.numero}-v1.pdf`, `Devis ${devis.numero} version 1`);
  const lien = dialogue.getByRole('link', { name: 'Ouvrir la messagerie' });
  await expect(lien).toBeVisible();
  await sansDebordement(page, 375, [dialogue, lien, dialogue.getByRole('button', { name: 'Préparer l’envoi' }), dialogue.getByRole('button', { name: 'Fermer' }), dialogue.getByRole('region', { name: 'Envois préparés' }).getByRole('listitem').first()]);

  await page.goto('/factures', { waitUntil: 'networkidle' });
  const ligne = (await ligneFacture(page, client.raisonSociale)).filter({ hasText: facture.numero });
  await ligne.getByRole('button', { name: `Envoyer la facture ${facture.numero}`, exact: true }).click();
  const dialogueFacture = page.getByRole('dialog', { name: `Envoyer la facture ${facture.numero}` });
  await expect(dialogueFacture.getByRole('textbox', { name: 'Destinataire' })).toHaveValue(long);
  await expect(dialogueFacture).toBeInViewport();
  await pdfTelecharge(page, () => dialogueFacture.getByRole('button', { name: 'Préparer l’envoi' }).click(), `${facture.numero}.pdf`, `Facture ${facture.numero}`);
  await expect(dialogueFacture.getByRole('link', { name: 'Ouvrir la messagerie' })).toBeVisible();
  await sansDebordement(page, 375, [dialogueFacture, dialogueFacture.getByRole('link', { name: 'Ouvrir la messagerie' }), dialogueFacture.getByRole('button', { name: 'Préparer l’envoi' })]);
});
