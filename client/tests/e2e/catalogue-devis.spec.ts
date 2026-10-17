import { createHmac } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, choisirClient } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Lot pilote 2 (décision A8 du 16-10-2026) : une ligne de devis se reprend du catalogue et y est
// copiée, figée ; le prix d'achat prévu, facultatif, n'est montré qu'à l'administration (choix
// par défaut, à confirmer).

const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

async function envoyer(request: APIRequestContext, token: string, methode: 'post' | 'put' | 'delete', chemin: string, data?: object) {
  const response = await request[methode](`${api}${chemin}`, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(response.ok(), `${chemin} : ${await response.text()}`).toBeTruthy();
  return response.json();
}

async function devisParObjet(request: APIRequestContext, token: string, objet: string) {
  const liste = await (await request.get(`${api}/devis`, { headers: { Authorization: `Bearer ${token}` } })).json() as { objet: string; lignes: Record<string, unknown>[] }[];
  const devis = liste.find((d) => d.objet === objet);
  expect(devis, `devis « ${objet} »`).toBeTruthy();
  return devis!;
}

async function ajouterDuCatalogue(page: Page, recherche: string, nom: string) {
  await page.getByRole('searchbox', { name: 'Rechercher dans le catalogue' }).fill(recherche);
  await page.getByRole('button', { name: `Ajouter ${nom}` }).click();
  await expect(page.getByRole('searchbox', { name: 'Rechercher dans le catalogue' })).toHaveValue('');
}

test('un commercial compose son devis depuis le catalogue : ligne copiée, sans prix d’achat à l’écran', async ({ page, request, session, creerClient }) => {
  const suffixe = `${Date.now()}`;
  const client = await creerClient('Catalogue devis commercial');
  const fiche = await envoyer(request, session.token, 'post', '/catalogue/articles', { reference: `E2E-CAB-${suffixe}`, nom: `Câble E2E ${suffixe}`, unite: 'm', prixVenteHt: '2.50', tauxTva: '20', prixAchatHt: '0.80' }) as { id: string; reference: string; nom: string };
  const commercial = await envoyer(request, session.token, 'post', '/users', { email: `catalogue.devis.${suffixe}@iris.test`, name: `Commercial catalogue ${suffixe}`, role: 'COMMERCIAL' }) as { id: string; name: string; email: string };
  await page.addInitScript(([jeton, utilisateur]) => {
    localStorage.setItem('token', jeton as string);
    localStorage.setItem('user', utilisateur as string);
  }, [jetonPour(commercial.id), JSON.stringify({ ...commercial, role: 'COMMERCIAL', permissions: ['devis:read', 'devis:write', 'clients:read', 'chantiers:read'] })]);
  await page.goto('/devis', { waitUntil: 'networkidle' });

  await choisirClient(page, client);
  const objet = `Devis catalogue E2E ${suffixe}`;
  await page.getByRole('textbox', { name: 'Objet' }).fill(objet);
  await ajouterDuCatalogue(page, suffixe, fiche.nom);
  // La ligne vierge initiale est remplacée par la copie de la fiche.
  await expect(page.getByRole('textbox', { name: /Désignation/ })).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: /Désignation/ })).toHaveValue(fiche.nom);
  await expect(page.getByText(`Copiée du catalogue · Réf. ${fiche.reference}`)).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'PU HT' })).toHaveValue('2.5');
  await expect(page.getByRole('textbox', { name: 'Unité' })).toHaveValue('m');
  await expect(page.getByRole('combobox', { name: 'Nature' })).toHaveValue('FOURNITURE');
  await expect(page.getByRole('textbox', { name: 'Prix d’achat prévu' })).toHaveCount(0);
  await page.getByRole('spinbutton', { name: 'Qté' }).fill('25');
  await page.getByRole('button', { name: 'Créer le brouillon' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: objet })).toContainText('HT 62.50 €');

  // Côté serveur : référence recopiée de la fiche, prix d'achat de la fiche repris (vu par l'admin).
  const devis = await devisParObjet(request, session.token, objet);
  expect(devis.lignes.map((l) => [l.reference, l.unite, l.catalogueId, l.quantite, l.prixUnitaireHt, l.prixAchatUnitaireHt]))
    .toEqual([[fiche.reference, 'm', fiche.id, 25, 2.5, 0.8]]);
  const vueCommercial = await devisParObjet(request, jetonPour(commercial.id), objet);
  expect(vueCommercial.lignes.every((l) => !('prixAchatUnitaireHt' in l))).toBeTruthy();
});

test('l’administrateur voit le prix d’achat prévu, et la copie reste figée quand la fiche change puis disparaît', async ({ page, request, session, creerClient, allerSurPageAdmin }) => {
  const suffixe = `${Date.now()}`;
  const client = await creerClient('Catalogue devis admin');
  const fiche = await envoyer(request, session.token, 'post', '/catalogue/equipements', { reference: `E2E-CAM-${suffixe}`, nom: `Caméra E2E ${suffixe}`, prixVenteHt: '199', tauxTva: '20', prixAchatHt: '120' }) as { id: string; reference: string; nom: string };
  await allerSurPageAdmin('/devis');

  await choisirClient(page, client);
  const objet = `Devis catalogue admin E2E ${suffixe}`;
  await page.getByRole('textbox', { name: 'Objet' }).fill(objet);
  await ajouterDuCatalogue(page, suffixe, fiche.nom);
  const prixAchat = page.getByRole('textbox', { name: 'Prix d’achat prévu' });
  await expect(prixAchat).toHaveValue('120');
  await prixAchat.fill('115,50');
  await page.getByRole('spinbutton', { name: 'PU HT' }).fill('180');
  await page.getByRole('button', { name: 'Ajouter une ligne' }).click();
  await page.getByRole('textbox', { name: /Désignation/ }).last().fill('Déplacement');
  await page.getByRole('spinbutton', { name: 'PU HT' }).last().fill('50');
  await page.getByRole('button', { name: 'Créer le brouillon' }).click();
  const ligneDevis = page.getByRole('listitem').filter({ hasText: objet });
  await expect(ligneDevis).toContainText('HT 230.00 €');

  // La fiche change de référence, de prix et de prix d'achat, puis elle est désactivée.
  await envoyer(request, session.token, 'put', `/catalogue/equipements/${fiche.id}`, { reference: `E2E-CAM2-${suffixe}`, nom: 'Caméra renommée', prixVenteHt: '260', tauxTva: '20', prixAchatHt: '150' });
  await envoyer(request, session.token, 'delete', `/catalogue/equipements/${fiche.id}`);
  await page.reload({ waitUntil: 'networkidle' });

  await ligneDevis.getByRole('button', { name: 'Modifier' }).click();
  await expect(page.getByRole('heading', { name: 'Modifier le brouillon' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Désignation/ }).first()).toHaveValue(fiche.nom);
  await expect(page.getByText(`Copiée du catalogue · Réf. ${fiche.reference}`)).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'PU HT' }).first()).toHaveValue('180');
  await expect(page.getByRole('textbox', { name: 'Prix d’achat prévu' }).first()).toHaveValue('115,5');
  // La fiche désactivée n'empêche pas d'enregistrer le brouillon : la ligne garde sa copie.
  await page.getByRole('spinbutton', { name: 'Qté' }).first().fill('2');
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  await expect(ligneDevis).toContainText('HT 410.00 €');
  const devis = await devisParObjet(request, session.token, objet);
  expect(devis.lignes.map((l) => [l.designation, l.reference, l.catalogueId, l.quantite, l.prixUnitaireHt, l.prixAchatUnitaireHt]))
    .toEqual([[fiche.nom, fiche.reference, fiche.id, 2, 180, 115.5], ['Déplacement', null, null, 1, 50, null]]);

  // La fiche désactivée n'est plus proposée.
  await page.getByRole('searchbox', { name: 'Rechercher dans le catalogue' }).fill(suffixe);
  await expect(page.getByRole('status').filter({ hasText: 'Aucune fiche active trouvée.' })).toBeVisible();
});
