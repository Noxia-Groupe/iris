import { createHmac } from 'node:crypto';
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
    await expect(page.getByRole('alert')).toHaveText('Identité de la société incomplète : renseignez SIRET dans l’écran Société avant d’imprimer un devis.');
    expect(telecharge).toBe(false);
  } finally {
    await request.put(`${api}/company`, { headers, data: { siret: societe.siret } });
  }
});

// Session d'un compte non administrateur : jeton signé avec le secret du backend jetable.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

test('PDF du devis : bouton d’un devis signé, ouvert au commercial, sans débordement à 375 px', async ({ browser, creerClient, request, session }) => {
  const headers = auth(session.token);
  const suffixe = `${Date.now()}`;
  const client = await creerClient('devis PDF signé');
  const cree = await request.post(`${api}/devis`, { headers, data: { clientId: client.id, objet: `E2E PDF devis signé ${suffixe}`, lignes: [{ designation: 'Pose', quantite: 1, prixUnitaireHt: 120, tauxTva: 20 }] } });
  expect(cree.status(), await cree.text()).toBe(201);
  const devis = await cree.json() as { id: string; numero: string };
  const signe = await request.post(`${api}/devis/${devis.id}/signature`, { headers, data: { signataire: 'Client E2E', confirme: true } });
  expect(signe.status(), await signe.text()).toBe(201);
  const reponse = await request.post(`${api}/users`, { headers, data: { email: `devis.pdf.${suffixe}@iris.test`, name: `Commercial PDF ${suffixe}`, role: 'COMMERCIAL' } });
  expect(reponse.ok(), await reponse.text()).toBeTruthy();
  const commercial = await reponse.json() as { id: string };

  const contexte = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    const page = await contexte.newPage();
    await page.addInitScript(([jeton, compte]) => {
      localStorage.setItem('token', jeton as string);
      localStorage.setItem('user', compte as string);
    }, [jetonPour(commercial.id), JSON.stringify({ ...commercial, role: 'COMMERCIAL', permissions: ['devis:read', 'devis:write', 'clients:read', 'chantiers:read'] })]);
    await page.goto('/devis', { waitUntil: 'networkidle' });
    const bouton = page.getByRole('button', { name: `PDF du devis ${devis.numero} version 1` });
    await bouton.scrollIntoViewIfNeeded();
    await expect(bouton).toBeInViewport();
    const telechargement = page.waitForEvent('download');
    await bouton.click();
    expect((await telechargement).suggestedFilename()).toBe(`${devis.numero}-v1.pdf`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  } finally {
    await contexte.close();
  }
});

// Le message s'affiche en haut de l'écran : à 375 px, un refus déclenché depuis la liste y est
// ramené ; le téléchargement suivant l'efface.
test('PDF du devis : à 375 px, le refus est ramené en vue, puis effacé au téléchargement suivant', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const headers = auth(session.token);
  const client = await creerClient('devis PDF refus mobile');
  const cree = await request.post(`${api}/devis`, { headers, data: { clientId: client.id, objet: `E2E PDF devis refus mobile ${Date.now()}`, lignes: [{ designation: 'Diagnostic', quantite: 1, prixUnitaireHt: 80, tauxTva: 20 }] } });
  expect(cree.status(), await cree.text()).toBe(201);
  const devis = await cree.json() as { id: string; numero: string };

  const page = await allerSurPageAdmin('/devis');
  await page.setViewportSize({ width: 375, height: 700 });
  const bouton = page.getByRole('button', { name: `PDF du devis ${devis.numero} version 1` });
  const societe = await (await request.get(`${api}/company`, { headers })).json() as { siret: string };
  try {
    const maj = await request.put(`${api}/company`, { headers, data: { siret: '' } });
    expect(maj.ok(), await maj.text()).toBeTruthy();
    await bouton.scrollIntoViewIfNeeded();
    // Le bouton, dans la liste, est loin du haut de l'écran où s'affiche le message.
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await bouton.click();
    await expect(page.getByRole('alert')).toHaveText('Identité de la société incomplète : renseignez SIRET dans l’écran Société avant d’imprimer un devis.');
    await expect(page.getByRole('alert')).toBeInViewport();
  } finally {
    await request.put(`${api}/company`, { headers, data: { siret: societe.siret } });
  }
  const telechargement = page.waitForEvent('download');
  await bouton.click();
  expect((await telechargement).suggestedFilename()).toBe(`${devis.numero}-v1.pdf`);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
