import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Lot 6a-2 : le PDF d'un devis se télécharge depuis l'écran Devis ; un refus du serveur s'y
// affiche, sans fichier.
test('PDF du devis : téléchargé depuis l’écran Devis, refus expliqué si l’identité de la société manque', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const headers = auth(session.token);
  const client = await creerClient('devis PDF');
  const cree = await request.post(`${api}/devis`, { headers, data: { clientId: client.id, objet: `E2E PDF devis ${Date.now()}`, lignes: [{ designation: 'Diagnostic', quantite: 1, prixUnitaireHt: 80, tauxTva: 20 }] } });
  expect(cree.status(), await cree.text()).toBe(201);
  const devis = await cree.json() as { id: string; numero: string };

  const page = await allerSurPageAdmin('/devis');
  const bouton = page.getByRole('button', { name: `PDF du devis ${devis.numero} version 1` });
  const telechargement = page.waitForEvent('download');
  await bouton.click();
  const fichier = await telechargement;
  expect(fichier.suggestedFilename()).toBe(`${devis.numero}-v1.pdf`);
  expect((await readFile(await fichier.path() as string)).subarray(0, 5).toString('latin1')).toBe('%PDF-');

  // Identité incomplète : le message du serveur s'affiche et aucun fichier n'est téléchargé.
  const societe = await (await request.get(`${api}/company`, { headers })).json() as { siret: string };
  try {
    const maj = await request.put(`${api}/company`, { headers, data: { siret: '' } });
    expect(maj.ok(), await maj.text()).toBeTruthy();
    let telecharge = false;
    page.on('download', () => { telecharge = true; });
    await bouton.click();
    await expect(page.getByText('Identité de la société incomplète : renseignez SIRET dans l’écran Société avant d’imprimer un devis.')).toBeVisible();
    expect(telecharge).toBe(false);
  } finally {
    await request.put(`${api}/company`, { headers, data: { siret: societe.siret } });
  }
});
