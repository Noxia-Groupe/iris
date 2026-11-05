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
  // #499 : forme des documents, le texte du PDF (virgule, espace ordinaire U+0020 avant « € »), et non plus le point décimal.
  await expect(page.getByRole('listitem').filter({ hasText: objet })).toContainText(/HT 62,50\u0020€/);

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
  // #499 : forme des documents (virgule, espace ordinaire U+0020 avant « € »).
  await expect(ligneDevis).toContainText(/HT 230,00\u0020€/);

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
  await expect(ligneDevis).toContainText(/HT 410,00\u0020€/);
  const devis = await devisParObjet(request, session.token, objet);
  expect(devis.lignes.map((l) => [l.designation, l.reference, l.catalogueId, l.quantite, l.prixUnitaireHt, l.prixAchatUnitaireHt]))
    .toEqual([[fiche.nom, fiche.reference, fiche.id, 2, 180, 115.5], ['Déplacement', null, null, 1, 50, null]]);

  // La fiche désactivée n'est plus proposée.
  await page.getByRole('searchbox', { name: 'Rechercher dans le catalogue' }).fill(suffixe);
  await expect(page.getByRole('status').filter({ hasText: 'Aucune fiche active trouvée.' })).toBeVisible();
});

// Correctif #499 (cadrage version 2, « Tests ») : le prix d'une fiche dans la recherche du devis et les totaux de
// l'historique passent à la forme des documents (fmtMontantDocument), le texte du PDF du même devis ; la liste du
// catalogue aussi, comme son onglet de la main d'œuvre (formatEuros). Choix par défaut, à confirmer (règle 5). Chaque
// expression nomme le caractère réel : U+202F entre les milliers, U+0020 avant « € » (et non l'U+00A0 du centime en
// devise) ; avec une chaîne, Playwright ramènerait toute espace à l'espace ordinaire.
const echapper = (texte: string) => texte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('#499 : la recherche du catalogue et l’historique du devis écrivent les montants au-delà de 1 000 € au texte du PDF', async ({ page, request, session, creerClient, allerSurPageAdmin }) => {
  const suffixe = `${Date.now()}`;
  const client = await creerClient('Montants devis milliers');
  const fiche = await envoyer(request, session.token, 'post', '/catalogue/articles', { reference: `E2E-MIL-${suffixe}`, nom: `Centrale E2E ${suffixe}`, unite: 'u', prixVenteHt: '1234.50', tauxTva: '20' }) as { id: string; reference: string; nom: string };
  await allerSurPageAdmin('/devis');
  await choisirClient(page, client);
  const objet = `Devis milliers E2E ${suffixe}`;
  await page.getByRole('textbox', { name: 'Objet' }).fill(objet);
  await page.getByRole('searchbox', { name: 'Rechercher dans le catalogue' }).fill(suffixe);
  const proposee = page.getByRole('list', { name: 'Fiches du catalogue' }).getByRole('listitem').filter({ hasText: fiche.nom });
  // 1 234,50 € HT : écarte le point décimal d'avant #499 (« 1234.50 € HT »), l'espace insécable U+00A0 du centime en
  // devise, un séparateur des milliers absent ou ordinaire, et l'euro près (« 1 235 € »).
  await expect(proposee.getByText(/^· Article/)).toHaveText(new RegExp(`^· Article · Réf\\. ${echapper(fiche.reference)} · 1\u202F234,50\u0020€ HT / u$`));
  await proposee.getByRole('button', { name: `Ajouter ${fiche.nom}` }).click();
  await page.getByRole('spinbutton', { name: 'Qté' }).fill('5');
  await page.getByRole('button', { name: 'Créer le brouillon' }).click();

  // 5 × 1 234,50 € = 6 172,50 € HT ; TVA à 20 % : 1 234,50 € ; TTC : 7 407,00 €. Trois montants au-delà de 1 000 €, dont
  // un TTC aux centimes nuls, que le point décimal écrivait « 7407.00 » et l'euro près « 7 407 € ». L'historique tient en
  // un seul paragraphe, ancré de la raison sociale aux heures prévues.
  const ligne = page.getByRole('listitem').filter({ hasText: objet });
  await expect(ligne.getByText(client.raisonSociale)).toHaveText(new RegExp(`^${echapper(client.raisonSociale)} · HT 6\u202F172,50\u0020€ · TVA 1\u202F234,50\u0020€ · TTC 7\u202F407,00\u0020€ · Heures prévues : 0 h$`));
  const devis = await devisParObjet(request, session.token, objet) as unknown as { totalHt: number; totalTva: number; totalTtc: number; lignes: Record<string, unknown>[] };
  expect([devis.totalHt, devis.totalTva, devis.totalTtc]).toEqual([6172.5, 1234.5, 7407]);
  expect(devis.lignes.map((l) => [l.reference, l.quantite, l.prixUnitaireHt])).toEqual([[fiche.reference, 5, 1234.5]]);
});

test('#499 : la liste du catalogue écrit le prix de vente et le prix d’achat au texte des documents, et « — » sans prix d’achat', async ({ request, session, allerSurPageAdmin }) => {
  const suffixe = `${Date.now()}`;
  const avecAchat = await envoyer(request, session.token, 'post', '/catalogue/articles', { reference: `E2E-PRIX-A-${suffixe}`, nom: `Détecteur E2E ${suffixe}`, unite: 'u', prixVenteHt: '1234.50', tauxTva: '20', prixAchatHt: '1087.25' }) as { id: string; reference: string };
  const sansAchat = await envoyer(request, session.token, 'post', '/catalogue/articles', { reference: `E2E-PRIX-B-${suffixe}`, nom: `Sirène E2E ${suffixe}`, unite: 'u', prixVenteHt: '3050', tauxTva: '20' }) as { id: string; reference: string };
  // Achat gratuit : un prix d'achat de 0, distinct d'un prix absent (catalogue/metier.ts, cataloguePrixAchat).
  const achatNul = await envoyer(request, session.token, 'post', '/catalogue/articles', { reference: `E2E-PRIX-C-${suffixe}`, nom: `Badge E2E ${suffixe}`, unite: 'u', prixVenteHt: '1250', tauxTva: '20', prixAchatHt: '0' }) as { id: string; reference: string };
  const fiches = await (await request.get(`${api}/catalogue/articles`, { headers: { Authorization: `Bearer ${session.token}` } })).json() as { id: string; prixVenteHt: number; prixAchatHt: number | null }[];
  expect([avecAchat.id, sansAchat.id, achatNul.id].map((id) => fiches.filter((f) => f.id === id).map((f) => [f.prixVenteHt, f.prixAchatHt]))).toEqual([[[1234.5, 1087.25]], [[3050, null]], [[1250, 0]]]);

  const page = await allerSurPageAdmin('/catalogue');
  await page.getByRole('button', { name: 'Articles', exact: true }).click();
  const tableau = page.getByRole('table');
  await expect(tableau.getByRole('columnheader')).toHaveText(['Référence', 'Désignation', 'Catégorie', 'Prix HT', 'Prix d\'achat HT', 'TVA', 'Actions']);
  const cellules = (reference: string) => tableau.getByRole('row').filter({ hasText: reference }).getByRole('cell');
  // 1 234,50 € et 1 087,25 € : deux prix distincts, au-delà de 1 000 €. Écartent un échange des deux colonnes, le point
  // décimal d'avant #499 (« 1234.50 € »), l'U+00A0 du centime en devise et l'euro près (« 1 235 € », « 1 087 € »).
  await expect(cellules(avecAchat.reference).nth(3)).toHaveText(/^1\u202F234,50\u0020€$/);
  await expect(cellules(avecAchat.reference).nth(4)).toHaveText(/^1\u202F087,25\u0020€$/);
  // Sans prix d'achat : « — », et non « 0,00 € » ; le prix de vente aux centimes nuls garde ses deux décimales.
  await expect(cellules(sansAchat.reference).nth(3)).toHaveText(/^3\u202F050,00\u0020€$/);
  await expect(cellules(sansAchat.reference).nth(4)).toHaveText(/^—$/);
  // Prix d'achat de 0 : « 0,00 € », et non « — » (écarte un test de vérité, `!f.prixAchatHt`, qui confondrait l'achat
  // gratuit avec le prix absent).
  await expect(cellules(achatNul.reference).nth(3)).toHaveText(/^1\u202F250,00\u0020€$/);
  await expect(cellules(achatNul.reference).nth(4)).toHaveText(/^0,00\u0020€$/);
});
