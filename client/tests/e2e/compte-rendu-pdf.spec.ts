import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import type { APIRequestContext } from '@playwright/test';
import { test, expect, dateDuJour, horsDuPassageDeMinuit } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable ouvre une
// session dans un rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

// Texte d'un PDF produit par PDFKit : les chaînes des opérateurs TJ et Tj de chaque flux de contenu,
// décompressé. Une ligne imprimée peut être coupée par les crénages : ses morceaux sont recollés.
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

type Intervention = { id: string; reference: string; titre: string };

async function envoyer(request: APIRequestContext, headers: Record<string, string>, methode: 'post' | 'put' | 'patch', path: string, data: object) {
  const response = await request[methode](`${api}${path}`, { headers, data });
  expect(response.ok(), `${path} : ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json();
}

// Une intervention en cours, avec un compte rendu si un texte est donné.
async function interventionEnCours(request: APIRequestContext, headers: Record<string, string>, clientId: string, titre: string, compteRendu?: string) {
  const intervention: Intervention = await envoyer(request, headers, 'post', '/interventions', { clientId, titre });
  await envoyer(request, headers, 'patch', `/interventions/${intervention.id}/statut`, { statut: 'PLANIFIEE' });
  await envoyer(request, headers, 'patch', `/interventions/${intervention.id}/statut`, { statut: 'EN_COURS' });
  if (compteRendu) await envoyer(request, headers, 'post', `/interventions/${intervention.id}/rapports`, { contenu: compteRendu, cleEnvoi: randomUUID() });
  return intervention;
}

// Lot 6a-4a (cadrage version 2 du 31-10-2026, section « 6a-4a ») : « un bouton « PDF » sur la fiche de
// l'intervention, pour les lecteurs admis, quand elle porte au moins un compte rendu » ; E2E : « le
// bouton « PDF » de la fiche télécharge un vrai PDF ». Le refus du serveur (identité de la société
// incomplète, 409) s'affiche comme pour le devis, sans fichier.
test('PDF du compte rendu : téléchargé depuis la fiche de l’intervention, refus expliqué si l’identité de la société manque', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  await horsDuPassageDeMinuit();
  const headers = auth(session.token);
  const suffixe = `${Date.now()}`;
  const client = await creerClient('compte rendu PDF');
  const texteCompteRendu = `Detecteur remplace, essai concluant ${suffixe}.`;
  const intervention = await interventionEnCours(request, headers, client.id, `E2E PDF compte rendu ${suffixe}`, texteCompteRendu);

  const page = await allerSurPageAdmin(`/interventions/${intervention.id}`);
  await expect(page.getByRole('heading', { name: 'Fiche intervention' })).toBeVisible();
  const bouton = page.getByTestId('pdf-compte-rendu');
  await expect(bouton).toBeVisible();
  await expect(bouton).toHaveText('PDF');
  await expect(bouton).toHaveAccessibleName(`PDF du compte rendu de l’intervention ${intervention.reference}`);

  const telechargement = page.waitForEvent('download');
  await bouton.click();
  const fichier = await telechargement;
  expect(fichier.suggestedFilename()).toBe(`Compte-rendu-${intervention.reference}.pdf`);
  const octets = await readFile(await fichier.path() as string);
  // Un vrai PDF : en-tête et commentaire binaire (0xFF) intacts, qu'une lecture en texte remplacerait.
  expect(octets.subarray(0, 15).equals(Buffer.from('%PDF-1.3\n%\xff\xff\xff\xff\n', 'latin1'))).toBe(true);
  expect(octets.subarray(-6).toString('latin1')).toContain('%%EOF');
  // Le fichier est bien celui de cette intervention : sa référence, son titre, son compte rendu, daté
  // du jour de la société (JJ-MM-AAAA).
  const texte = texteDuPdf(octets);
  for (const attendu of ["Compte rendu d'intervention", intervention.reference, `E2E PDF compte rendu ${suffixe}`, client.raisonSociale, texteCompteRendu]) {
    expect(texte, `absent du PDF : ${attendu}`).toContain(attendu);
  }
  expect(texte).toMatch(new RegExp(`${dateDuJour()} \\d{2}:\\d{2}`));

  // Identité incomplète : le message du serveur s'affiche et aucun fichier n'est téléchargé.
  const societe = await (await request.get(`${api}/company`, { headers })).json() as { siret: string };
  try {
    const maj = await request.put(`${api}/company`, { headers, data: { siret: '' } });
    expect(maj.ok(), await maj.text()).toBeTruthy();
    let telecharge = false;
    page.on('download', () => { telecharge = true; });
    await bouton.click();
    await expect(page.getByText('Identité de la société incomplète : renseignez SIRET dans l’écran Société avant d’imprimer un compte rendu.', { exact: true })).toBeVisible();
    expect(telecharge).toBe(false);
  } finally {
    const retour = await request.put(`${api}/company`, { headers, data: { siret: societe.siret } });
    expect(retour.ok(), await retour.text()).toBeTruthy();
  }
});

// Cadrage : le bouton s'affiche « pour les lecteurs admis, quand elle porte au moins un compte rendu » ;
// le technicien est exclu du PDF (choix par défaut, le plus restrictif, à confirmer) : il garde sa fiche
// et ses comptes rendus, sans le bouton.
test('PDF du compte rendu : pas de bouton sans compte rendu, ni pour le technicien affecté', async ({ allerSurPageAdmin, browser, creerClient, request, session }) => {
  const headers = auth(session.token);
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const client = await creerClient('compte rendu PDF bouton');

  // Sans compte rendu : la fiche s'affiche, sans bouton.
  const sansCompteRendu = await interventionEnCours(request, headers, client.id, `E2E PDF sans compte rendu ${suffixe}`);
  const page = await allerSurPageAdmin(`/interventions/${sansCompteRendu.id}`);
  await expect(page.getByRole('heading', { name: `E2E PDF sans compte rendu ${suffixe}` })).toBeVisible();
  await expect(page.getByTestId('pdf-compte-rendu')).toHaveCount(0);

  // Technicien affecté : il voit sa fiche et son compte rendu, sans le bouton ; l'administration l'a.
  const technicien = await envoyer(request, headers, 'post', '/users', { email: `cr.pdf.${suffixe}@iris.test`, name: `Technicien PDF ${suffixe}`, role: 'TECHNICIEN' }) as { id: string; name: string; email: string; role: string };
  const fiche = await envoyer(request, headers, 'post', '/intervenants', { nom: `Fiche PDF ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 40 }) as { id: string };
  await envoyer(request, headers, 'put', `/intervenants/${fiche.id}/compte`, { userId: technicien.id });
  const intervention: Intervention = await envoyer(request, headers, 'post', '/interventions', { clientId: client.id, titre: `E2E PDF technicien ${suffixe}` });
  const jour = dateDuJour().split('-').reverse().join('-');
  await envoyer(request, headers, 'put', `/interventions/${intervention.id}/planning`, { dateDebut: jour, creneau: 'JOURNEE', intervenantIds: [fiche.id] });
  await envoyer(request, headers, 'patch', `/interventions/${intervention.id}/statut`, { statut: 'EN_COURS' });
  const texteCompteRendu = `Compte rendu du technicien ${suffixe}.`;
  await envoyer(request, auth(jetonPour(technicien.id)), 'post', `/interventions/${intervention.id}/rapports`, { contenu: texteCompteRendu, cleEnvoi: randomUUID() });

  const contexte = await browser.newContext({ viewport: { width: 375, height: 812 } });
  try {
    const pageTechnicien = await contexte.newPage();
    await pageTechnicien.addInitScript(([jeton, compte]) => {
      localStorage.setItem('token', jeton as string);
      localStorage.setItem('user', compte as string);
    }, [jetonPour(technicien.id), JSON.stringify({ ...technicien, permissions: ['chantiers:read', 'clients:read'] })]);
    await pageTechnicien.goto(`/interventions/${intervention.id}`, { waitUntil: 'networkidle' });
    await expect(pageTechnicien.getByText(texteCompteRendu)).toBeVisible();
    await expect(pageTechnicien.getByTestId('pdf-compte-rendu')).toHaveCount(0);
  } finally {
    await contexte.close();
  }
  await page.goto(`/interventions/${intervention.id}`, { waitUntil: 'networkidle' });
  await expect(page.getByText(texteCompteRendu)).toBeVisible();
  await expect(page.getByTestId('pdf-compte-rendu')).toBeVisible();
});
