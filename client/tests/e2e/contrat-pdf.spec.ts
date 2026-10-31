import { readFile } from 'node:fs/promises';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
type Contrat = { id: string; titre: string };

// Lot 6a-4b (cadrage du lot 6a-4, version 2, section « 6a-4b », « Écran ») : un bouton « PDF » dans la
// liste des contrats. Un contrat s'imprime quel que soit son statut, annulé compris (« Statuts ») ; le
// refus du serveur s'affiche comme ailleurs, sans fichier.

async function envoyer(request: APIRequestContext, token: string, methode: 'post' | 'put' | 'patch', chemin: string, data: object, attendu: number) {
  const reponse = await request[methode](`${api}${chemin}`, { headers: auth(token), data });
  expect(reponse.status(), `${methode.toUpperCase()} ${chemin} : ${await reponse.text()}`).toBe(attendu);
  return reponse.json();
}

const creerContrat = (request: APIRequestContext, token: string, clientId: string, titre: string): Promise<Contrat> =>
  envoyer(request, token, 'post', '/contrats-maintenance', { clientId, titre, periodiciteMois: 6, dureePrevisionnelleMinutes: 90, dateDebut: '01-10-2030' }, 201);

// Clique le bouton « PDF » d'un contrat et rend la réponse du serveur et le fichier téléchargé.
async function telechargerPdfDuContrat(page: Page, contrat: Contrat) {
  const reponse = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().endsWith(`/api/contrats-maintenance/${contrat.id}/document.pdf`));
  const telechargement = page.waitForEvent('download');
  await page.getByTestId(`pdf-contrat-${contrat.id}`).click();
  const [res, fichier] = await Promise.all([reponse, telechargement]);
  return { res, fichier, octets: await readFile(await fichier.path() as string) };
}

test('PDF du contrat : chaque contrat de la liste, actif, terminé ou annulé, a son bouton « PDF », qui télécharge le PDF de ce contrat', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const token = session.token;
  const suffixe = `${Date.now()}`;
  const client = await creerClient('contrat PDF');
  const actif = await creerContrat(request, token, client.id, `E2E Contrat PDF actif ${suffixe}`);
  const termine = await creerContrat(request, token, client.id, `E2E Contrat PDF terminé ${suffixe}`);
  await envoyer(request, token, 'patch', `/contrats-maintenance/${termine.id}/statut`, { statut: 'TERMINE', motif: 'E2E Clôture du contrat' }, 200);
  // Contrat annulé avec le devis dont il est issu (lot 4 suite).
  const devis = await envoyer(request, token, 'post', '/devis', { clientId: client.id, objet: `E2E Devis du contrat PDF ${suffixe}`, lignes: [{ designation: 'Visite annuelle', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }, 201) as { id: string };
  await envoyer(request, token, 'put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' }, 200);
  await envoyer(request, token, 'post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true }, 201);
  const annule = await envoyer(request, token, 'post', `/devis/${devis.id}/convertir`, { cible: 'CONTRAT', titre: `E2E Contrat PDF annulé ${suffixe}`, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-11-2030' }, 201) as Contrat;
  await envoyer(request, token, 'post', `/devis/${devis.id}/annulation`, { motif: 'E2E Annulation du devis du contrat' }, 200);

  const page = await allerSurPageAdmin('/contrats-maintenance');
  for (const contrat of [actif, termine, annule]) {
    const bouton = page.getByTestId(`pdf-contrat-${contrat.id}`);
    await expect(bouton).toBeVisible();
    await expect(bouton).toContainText('PDF');
    await expect(bouton).toHaveAccessibleName(`PDF du contrat ${contrat.titre}`);
  }

  // Le bouton du contrat annulé imprime ce contrat-là : la réponse est le PDF de sa route, et le fichier
  // téléchargé est ce PDF, sous le nom que donne le serveur (consigne du code : intitulé assaini, accents
  // retirés, autres caractères en tirets).
  for (const [contrat, nom] of [[annule, `Contrat-E2E-Contrat-PDF-annule-${suffixe}.pdf`], [actif, `Contrat-E2E-Contrat-PDF-actif-${suffixe}.pdf`]] as const) {
    const { res, fichier, octets } = await telechargerPdfDuContrat(page, contrat);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/pdf');
    expect(res.headers()['content-disposition']).toBe(`inline; filename="${nom}"`);
    expect(fichier.suggestedFilename()).toBe(nom);
    expect(octets.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // Le corps d'une réponse lue en blob par la page n'est pas relisible par Playwright : le fichier est
    // comparé à la longueur annoncée par le serveur, et doit être un PDF complet.
    expect(octets.length, 'le fichier a la taille du PDF reçu').toBe(Number(res.headers()['content-length']));
    expect(octets.subarray(-8).toString('latin1')).toContain('%%EOF');
  }
});

// Cadrage, « En-tête » : refus 409 si l'identité de la société est incomplète. À l'écran, le message du
// serveur s'affiche, en vue même depuis une liste parcourue à 375 px, et aucun fichier n'est téléchargé ;
// le téléchargement suivant l'efface.
test('PDF du contrat : identité de la société incomplète, le refus s’affiche en vue à 375 px, sans fichier ; il s’efface au téléchargement suivant', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const token = session.token;
  const client = await creerClient('contrat PDF refus');
  const contrat = await creerContrat(request, token, client.id, `E2E Contrat PDF refus ${Date.now()}`);
  const message = 'Identité de la société incomplète : renseignez SIRET dans l’écran Société avant d’imprimer un contrat.';

  const page = await allerSurPageAdmin('/contrats-maintenance');
  await page.setViewportSize({ width: 375, height: 700 });
  const bouton = page.getByTestId(`pdf-contrat-${contrat.id}`);
  await bouton.scrollIntoViewIfNeeded();
  await expect(bouton).toBeInViewport();
  const boite = await bouton.boundingBox();
  expect(boite && boite.x + boite.width, 'le bouton tient dans la largeur de l’écran').toBeLessThanOrEqual(375);

  const societe = await (await request.get(`${api}/company`, { headers: auth(token) })).json() as { siret: string };
  try {
    const maj = await request.put(`${api}/company`, { headers: auth(token), data: { siret: '' } });
    expect(maj.ok(), await maj.text()).toBeTruthy();
    let telecharge = false;
    page.on('download', () => { telecharge = true; });
    const refus = page.waitForResponse((r) => r.url().endsWith(`/api/contrats-maintenance/${contrat.id}/document.pdf`));
    await bouton.click();
    expect((await refus).status()).toBe(409);
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(page.getByText(message, { exact: true })).toBeInViewport();
    expect(telecharge).toBe(false);
  } finally {
    await request.put(`${api}/company`, { headers: auth(token), data: { siret: societe.siret } });
  }

  const { res, octets } = await telechargerPdfDuContrat(page, contrat);
  expect(res.status()).toBe(200);
  expect(octets.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  await expect(page.getByText(message, { exact: true })).toHaveCount(0);
});
