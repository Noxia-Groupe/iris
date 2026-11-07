import { randomInt } from 'node:crypto';
import { test, expect, choisirClient, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Lot « Assistante technique », PR AT-2a « Devis, clients et contrats » (cadrage AT-2, version 1, « AT-2a », « Tests » :
// « E2E : devis jusqu'à la conversion en contrat, client, contrat » ; version 2, C1 et C2). Réponses de Nelson du 06-11-2026
// (docs/HISTORIQUE-DECISIONS.md#décisions-du-06-11-2026-sur-lassistante-technique) : 3 (« Tous, contrats compris » ; elle
// « gère les clients »), 4 et 8 (prix d'achat lus, catalogue et parc en lecture seule) et 9 (génération des visites).
//
// Parcours critique, dans Chromium, connectée en assistante technique :
//  1. son menu porte Devis et Contrats de maintenance ;
//  2. elle compose un devis depuis le catalogue, dont la recherche lui montre le prix d'achat de la fiche au format des
//     documents (« 74,35 € HT »), saisit le prix d'achat prévu au format français, crée le brouillon, le fait signer, puis
//     crée le contrat du devis ; ni « Constater l'acompte » ni « Annuler », qui restent à l'administration ;
//  3. sur la fiche du client, elle ajoute un contact ; le parc lui est montré en consultation seule ;
//  4. sur l'écran des contrats, sans « Nouveau contrat » ni « Modifier la couverture », elle suspend le contrat.
// Chaque écriture est relue par l'API, à son nom.
test('assistante technique : devis composé du catalogue avec le prix d’achat de la fiche, signé puis converti en contrat ; contact ajouté sur la fiche client ; contrat suspendu depuis l’écran des contrats', async ({ connexion, request, session, creerClient }) => {
  test.slow();
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'put', path: string, data?: object) => {
    const reponse = await request[methode](`${api}${path}`, { headers, data });
    expect(reponse.ok(), `${path} : ${await reponse.text()}`).toBeTruthy();
    return reponse.json();
  };
  const suffixe = `${Date.now()}-${randomInt(1_000_000)}`;
  const client = await creerClient(`assistante technique devis ${suffixe}`, true);
  const fiche = await envoyer('post', '/catalogue/articles', { reference: `E2E-AT2A-${suffixe}`, nom: `Détecteur AT-2a ${suffixe}`, unite: 'u', prixVenteHt: '129.90', prixAchatHt: '74.35', tauxTva: '20' }) as { id: string; nom: string; reference: string };
  const compte = await envoyer('post', '/users', { email: `at2a.${suffixe}@iris.test`, name: `Assistante technique AT-2a ${suffixe}`, role: 'ASSISTANTE_TECHNIQUE' }) as { id: string; name: string };
  const page = await connexion(compte);

  // 1. Menu : Devis et Contrats de maintenance.
  await page.goto('/', { waitUntil: 'networkidle' });
  const menu = page.locator('#menu-principal');
  await expect(menu.getByRole('link', { name: 'Devis', exact: true })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Contrats de maintenance', exact: true })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Catalogue', exact: true })).toHaveCount(0);

  // 2. Devis composé du catalogue : le prix d'achat de la fiche est affiché au format des documents (virgule, espace
  // ordinaire U+0020 avant « € »), distinct de son prix de vente.
  await page.goto('/devis', { waitUntil: 'networkidle' });
  await choisirClient(page, client);
  const objet = `Maintenance AT-2a ${suffixe}`;
  await page.getByRole('textbox', { name: 'Objet' }).fill(objet);
  await page.getByRole('searchbox', { name: 'Rechercher dans le catalogue' }).fill(fiche.reference);
  const ficheProposee = page.getByRole('list', { name: 'Fiches du catalogue' }).getByRole('listitem').filter({ hasText: fiche.nom });
  await expect(ficheProposee.getByTestId('prix-achat-fiche-catalogue')).toHaveText(/^Prix d’achat 74,35 € HT$/);
  await expect(ficheProposee).toContainText(/129,90 € HT/);
  await page.getByRole('button', { name: `Ajouter ${fiche.nom}` }).click();
  await page.getByRole('textbox', { name: 'Prix d’achat prévu' }).fill('70,10');
  await page.getByRole('spinbutton', { name: 'Qté' }).fill('2');
  const creation = page.waitForResponse((r) => r.url().endsWith('/api/devis') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Créer le brouillon' }).click();
  const reponseCreation = await creation;
  expect(reponseCreation.status()).toBe(201);
  const devisId = (await reponseCreation.json()).id as string;
  const ligne = page.getByRole('listitem').filter({ hasText: objet });
  await expect(ligne).toContainText(/HT 259,80 €/);
  // Signature par le client, enregistrée par elle.
  await ligne.getByRole('button', { name: 'Faire signer le client' }).click();
  const dialogue = page.getByRole('dialog', { name: 'Signature client' });
  await dialogue.getByRole('textbox', { name: 'Autre signataire client' }).fill('Client AT-2a');
  await dialogue.getByRole('checkbox', { name: 'Confirmation du client' }).check();
  const signature = page.waitForResponse((r) => r.url().endsWith(`/api/devis/${devisId}/signature`) && r.request().method() === 'POST');
  await dialogue.getByRole('button', { name: 'Enregistrer la signature client' }).click();
  expect((await signature).status()).toBe(201);
  await expect(ligne).toContainText('Signature client : Client AT-2a');
  // L'acompte et l'annulation restent à l'administration : ni l'un ni l'autre ne lui sont proposés.
  await expect(ligne.getByRole('button', { name: 'Annuler', exact: true })).toHaveCount(0);
  await expect(ligne.getByRole('button', { name: /Constater l’acompte/ })).toHaveCount(0);
  // Contrat du devis, créé par elle.
  await ligne.getByRole('button', { name: 'Créer le contrat' }).click();
  const formulaire = page.getByRole('dialog', { name: 'Créer le contrat du devis' });
  await expect(formulaire.getByLabel('Date de début')).toHaveValue(dateDuJour());
  await formulaire.getByLabel('Périodicité (mois)').fill('12');
  await formulaire.getByLabel('Durée prévue (minutes)').fill('60');
  const conversion = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/devis/${devisId}/convertir`));
  await formulaire.getByRole('button', { name: 'Créer le contrat' }).click();
  const reponseConversion = await conversion;
  expect(reponseConversion.status()).toBe(201);
  const contrat = await reponseConversion.json() as { id: string; titre: string; createdById: string };
  expect(contrat.createdById).toBe(compte.id);
  await expect(ligne).toContainText('Contrat de maintenance issu de ce devis');
  await expect(ligne.getByRole('link', { name: 'voir les contrats' })).toHaveAttribute('href', '/contrats-maintenance');
  // Côté serveur : le prix d'achat prévu saisi par elle (70,10 €), et non celui de la fiche (74,35 €).
  const devis = (await (await request.get(`${api}/devis`, { headers })).json() as { id: string; lignes: { prixAchatUnitaireHt: number; prixUnitaireHt: number; quantite: number }[] }[]).find((d) => d.id === devisId)!;
  expect(devis.lignes.map((l) => [l.quantite, l.prixUnitaireHt, l.prixAchatUnitaireHt])).toEqual([[2, 129.9, 70.1]]);

  // 3. Fiche du client : un contact ajouté par elle ; le parc en consultation seule.
  await page.goto(`/clients/${client.id}`, { waitUntil: 'networkidle' });
  await page.getByPlaceholder('Nom *').fill(`Martin ${suffixe}`);
  await page.getByPlaceholder('Prénom').fill('Camille');
  const ajoutContact = page.waitForResponse((r) => r.url().endsWith(`/api/clients/${client.id}/contacts`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Ajouter le contact' }).click();
  expect((await ajoutContact).status()).toBe(201);
  await expect(page.getByText(`Camille Martin ${suffixe}`)).toBeVisible();
  await expect(page.getByText('Consultation seule : le parc est tenu à jour par l’administration.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ajouter au parc' })).toHaveCount(0);
  const relu = await (await request.get(`${api}/clients/${client.id}`, { headers })).json() as { contacts: { nom: string; prenom: string }[] };
  expect(relu.contacts.some((c) => c.nom === `Martin ${suffixe}` && c.prenom === 'Camille')).toBeTruthy();

  // 4. Écran des contrats : ni création hors devis ni couverture ; suspension par elle, motif demandé.
  await page.goto('/contrats-maintenance', { waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: /Nouveau contrat/ })).toHaveCount(0);
  const carte = page.locator('article').filter({ hasText: contrat.titre });
  await expect(carte).toBeVisible();
  await expect(carte.getByRole('button', { name: 'Modifier la couverture' })).toHaveCount(0);
  page.once('dialog', (fenetre) => void fenetre.accept('Client absent cet été'));
  const suspension = page.waitForResponse((r) => r.url().endsWith(`/api/contrats-maintenance/${contrat.id}/statut`) && r.request().method() === 'PATCH');
  await carte.getByRole('button', { name: 'Suspendre' }).click();
  expect((await suspension).status()).toBe(200);
  await expect(carte.getByRole('button', { name: 'Réactiver' })).toBeVisible();
  const journal = await (await request.get(`${api}/contrats-maintenance/${contrat.id}/journal-saisies`, { headers })).json() as { action: string; auteurId: string; motif: string | null }[];
  expect(journal.filter((e) => e.auteurId === compte.id).map((e) => [e.action, e.motif])).toEqual(expect.arrayContaining([['CREATION', expect.stringMatching(/^Conversion du devis /)], ['SUSPENSION', 'Client absent cet été']]));
});
