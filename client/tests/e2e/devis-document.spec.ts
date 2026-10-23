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
  // Un devis plus récent le précède dans la liste : le bouton doit imprimer le sien, pas le premier.
  const autre = await request.post(`${api}/devis`, { headers, data: { clientId: client.id, objet: `E2E PDF autre devis ${Date.now()}`, lignes: [{ designation: 'Diagnostic', quantite: 1, prixUnitaireHt: 90, tauxTva: 20 }] } });
  expect(autre.status(), await autre.text()).toBe(201);

  const page = await allerSurPageAdmin('/devis');
  const bouton = page.getByRole('button', { name: `PDF du devis ${devis.numero} version 1` });
  const telechargement = page.waitForEvent('download');
  await bouton.click();
  const fichier = await telechargement;
  expect(fichier.suggestedFilename()).toBe(`${devis.numero}-v1.pdf`);
  const octets = await readFile(await fichier.path() as string);
  expect(octets.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  // Audit n° 6 : le fichier garde les octets binaires du PDF reçu (commentaire d'en-tête en 0xFF),
  // qu'une lecture de la réponse en texte remplacerait.
  expect(octets.subarray(0, 15).equals(Buffer.from('%PDF-1.3\n%\xff\xff\xff\xff\n', 'latin1'))).toBe(true);
  // Le fichier est bien celui de ce devis : son titre porte son numéro et sa version.
  expect(octets.includes(Buffer.from(`(Devis ${devis.numero} version 1)`))).toBe(true);

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
  // Audit n° 7 : sa révision (version 2) a son propre bouton et son propre fichier.
  const revision = await request.post(`${api}/devis/${devis.id}/revisions`, { headers });
  expect(revision.status(), await revision.text()).toBe(201);
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
    const telechargementRevision = page.waitForEvent('download');
    await page.getByRole('button', { name: `PDF du devis ${devis.numero} version 2`, exact: true }).click();
    expect((await telechargementRevision).suggestedFilename()).toBe(`${devis.numero}-v2.pdf`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    // La liste masque ce qui déborde (overflow-hidden) : chaque action du devis, PDF compris, reste
    // entière dans la largeur de l'écran, au lieu d'être coupée sans défilement.
    for (const action of await page.getByRole('listitem').filter({ has: bouton }).getByRole('button').all()) {
      const boite = await action.boundingBox();
      expect(boite && boite.x + boite.width).toBeLessThanOrEqual(375);
    }
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
  // Audit n° 14 : seul un refus ramène l'écran en haut ; un téléchargement réussi laisse la liste où
  // elle est. Les appels à window.scrollTo sont comptés à partir d'ici.
  await page.evaluate(() => {
    const fenetre = window as Window & { defilements?: number };
    const origine = window.scrollTo.bind(window) as (options?: ScrollToOptions) => void;
    fenetre.defilements = 0;
    window.scrollTo = ((options?: ScrollToOptions) => { fenetre.defilements = (fenetre.defilements ?? 0) + 1; origine(options); }) as typeof window.scrollTo;
  });
  const telechargement = page.waitForEvent('download');
  await bouton.click();
  expect((await telechargement).suggestedFilename()).toBe(`${devis.numero}-v1.pdf`);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { defilements?: number }).defilements)).toBe(0);
});

// Une erreur sans corps JSON (passerelle, proxy) s'annonce sans message technique.
test('PDF du devis : une erreur sans corps JSON affiche « Document indisponible. »', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const headers = auth(session.token);
  const client = await creerClient('devis PDF erreur brute');
  const cree = await request.post(`${api}/devis`, { headers, data: { clientId: client.id, objet: `E2E PDF devis erreur brute ${Date.now()}`, lignes: [{ designation: 'Diagnostic', quantite: 1, prixUnitaireHt: 80, tauxTva: 20 }] } });
  expect(cree.status(), await cree.text()).toBe(201);
  const devis = await cree.json() as { id: string; numero: string };
  const page = await allerSurPageAdmin('/devis');
  await page.route(`**/api/devis/${devis.id}/document.pdf`, (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Bad Gateway</body></html>' }));
  await page.getByRole('button', { name: `PDF du devis ${devis.numero} version 1` }).click();
  await expect(page.getByRole('alert')).toHaveText('Document indisponible.');
});

// Audit n° 4 : tout devis a son PDF, quel que soit son statut, y compris annulé ou refusé.
// Audit n° 10 : aussi le devis envoyé, celui que reçoit le client, et le devis signé en attente d'acompte.
// Audit n° 11 : aussi le devis converti, dont le chantier est ouvert.
test('PDF du devis : un devis envoyé, en attente d’acompte, converti, annulé ou refusé garde son bouton et se télécharge', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const headers = auth(session.token);
  const client = await creerClient('devis PDF statuts');
  const creer = async (objet: string, extra: Record<string, unknown> = {}) => {
    const cree = await request.post(`${api}/devis`, { headers, data: { clientId: client.id, objet: `${objet} ${Date.now()}`, lignes: [{ designation: 'Diagnostic', quantite: 1, prixUnitaireHt: 80, tauxTva: 20 }], ...extra } });
    expect(cree.status(), await cree.text()).toBe(201);
    return await cree.json() as { id: string; numero: string };
  };
  const passer = async (id: string, statut: string) => {
    const changement = await request.put(`${api}/devis/${id}/statut`, { headers, data: { statut } });
    expect(changement.status(), await changement.text()).toBe(200);
  };
  const annule = await creer('E2E PDF devis annulé');
  const annulation = await request.post(`${api}/devis/${annule.id}/annulation`, { headers, data: { motif: 'Annulé pour le test du PDF' } });
  expect(annulation.status(), await annulation.text()).toBe(200);
  const refuse = await creer('E2E PDF devis refusé');
  for (const statut of ['ENVOYE', 'REFUSE']) await passer(refuse.id, statut);
  const envoye = await creer('E2E PDF devis envoyé');
  await passer(envoye.id, 'ENVOYE');
  const attente = await creer('E2E PDF devis en attente d’acompte', { acompteExige: true, tauxAcompte: 30 });
  const signature = await request.post(`${api}/devis/${attente.id}/signature`, { headers, data: { signataire: 'Client E2E', confirme: true } });
  expect(signature.status(), await signature.text()).toBe(201);
  await passer(attente.id, 'EN_ATTENTE_ACOMPTE');
  const converti = await creer('E2E PDF devis converti');
  const signatureConverti = await request.post(`${api}/devis/${converti.id}/signature`, { headers, data: { signataire: 'Client E2E', confirme: true } });
  expect(signatureConverti.status(), await signatureConverti.text()).toBe(201);
  const conversion = await request.post(`${api}/devis/${converti.id}/convertir`, { headers, data: { cible: 'CHANTIER' } });
  expect(conversion.status(), await conversion.text()).toBe(201);

  const page = await allerSurPageAdmin('/devis');
  for (const devis of [annule, refuse, envoye, attente, converti]) {
    const telechargement = page.waitForEvent('download');
    await page.getByRole('button', { name: `PDF du devis ${devis.numero} version 1` }).click();
    expect((await telechargement).suggestedFilename()).toBe(`${devis.numero}-v1.pdf`);
  }
});

// Audit n° 17 : le refus de la signature sans identité complète de la société, décidé par Nelson le
// 23-10-2026 (« Oui garde les 5 champs »), s'affiche dans l'écran Devis ; le dialogue reste ouvert
// et rien n'est enregistré.
test('signature : refusée à l’écran si l’identité de la société manque, sans rien enregistrer', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const headers = auth(session.token);
  const client = await creerClient('devis signature refusée');
  const objet = `E2E signature refusée ${Date.now()}`;
  const cree = await request.post(`${api}/devis`, { headers, data: { clientId: client.id, objet, lignes: [{ designation: 'Diagnostic', quantite: 1, prixUnitaireHt: 80, tauxTva: 20 }] } });
  expect(cree.status(), await cree.text()).toBe(201);
  const devis = await cree.json() as { id: string };
  const page = await allerSurPageAdmin('/devis');
  const societe = await (await request.get(`${api}/company`, { headers })).json() as { siret: string };
  try {
    const maj = await request.put(`${api}/company`, { headers, data: { siret: '' } });
    expect(maj.ok(), await maj.text()).toBeTruthy();
    await page.getByRole('listitem').filter({ hasText: objet }).getByRole('button', { name: 'Faire signer le client' }).click();
    const dialogue = page.getByRole('dialog', { name: 'Signature client' });
    await dialogue.getByRole('textbox', { name: 'Autre signataire client' }).fill('Client E2E');
    await dialogue.getByRole('checkbox', { name: 'Confirmation du client' }).check();
    const reponse = page.waitForResponse(r => r.url().endsWith(`/api/devis/${devis.id}/signature`) && r.request().method() === 'POST');
    await dialogue.getByRole('button', { name: 'Enregistrer la signature client' }).click();
    expect((await reponse).status()).toBe(409);
    await expect(page.getByRole('alert')).toHaveText('Identité de la société incomplète : renseignez SIRET dans l’écran Société avant d’enregistrer la signature d’un devis.');
    await expect(dialogue).toBeVisible();
    const relu = (await (await request.get(`${api}/devis`, { headers })).json() as { id: string; statut: string; signature: unknown }[]).find(d => d.id === devis.id);
    expect(relu?.signature).toBeNull();
    expect(relu?.statut).toBe('BROUILLON');
  } finally {
    await request.put(`${api}/company`, { headers, data: { siret: societe.siret } });
  }
});
