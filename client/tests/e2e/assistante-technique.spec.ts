import { randomInt } from 'node:crypto';
import { test, expect, choisirClient, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Lot « Assistante technique », PR AT-1 (cadrage version 2.1, section « PR AT-1 », « Tests » : « E2E création du compte,
// SAV et planning ») ; décisions de Nelson du 24-10-2026, points 15, 16, 18 et 28, et section « lots prévus », point 2 ;
// réponse 7 du 06-11-2026 (« Oui, comme le conducteur ») : l'assistante technique saisit le matériel d'une intervention SAV
// et voit son coût, jamais les taux ni le coût de main-d'œuvre.
//
// Parcours critique, dans Chromium : le super administrateur autorise le compte dans Administration > Utilisateurs, avec le
// type « Assistante technique » ; connectée, elle a le menu du cadrage (Interventions SAV, Planning, Liste des chantiers,
// Clients, Administration réduite à ses deux onglets ; ni Devis, ni journaux Travaux, ni Contrats, ni Factures, ni
// Statistiques, Performances, Mes commerciaux ou Catalogue), crée une intervention, en saisit le matériel au format français
// (date JJ-MM-AAAA, montant « 12,34 »), le voit cumulé au format français, puis la place au planning depuis la file.
// PR AT-2a (réponses 3 et 9 du 06-11-2026) : Devis et Contrats de maintenance entrent à son menu, et l'onglet Chantiers à son
// Administration ; leur parcours est celui de assistante-technique-devis-contrats.spec.ts.

test('assistante technique : autorisée dans l’administration, elle a son menu, crée une intervention, en saisit le matériel au format français et la place au planning', async ({ connexion, request, session, creerClient }) => {
  test.slow();
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'put', path: string, data?: object) => {
    const reponse = await request[methode](`${api}${path}`, { headers, data });
    expect(reponse.ok(), `${path} : ${await reponse.text()}`).toBeTruthy();
    return reponse.json();
  };
  const suffixe = `${Date.now()}-${randomInt(1_000_000)}`;
  const client = await creerClient(`assistante technique ${suffixe}`, false);
  const fournisseur = await envoyer('post', '/fournisseurs', { nom: `Fournisseur assistante E2E ${suffixe}` }) as { id: string; nom: string };
  const fiche = await envoyer('post', '/intervenants', { nom: `Technicien assistante E2E ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 30 }) as { id: string; nom: string };

  // 1. Le super administrateur autorise le compte, type choisi par son libellé ; le serveur reçoit et garde le type.
  const administration = await connexion('SA');
  await administration.goto('/admin', { waitUntil: 'networkidle' });
  await administration.getByRole('button', { name: 'Utilisateurs', exact: true }).click();
  const formulaire = administration.locator('form').filter({ has: administration.getByRole('button', { name: 'Autoriser', exact: true }) });
  const email = `assistante.technique.${suffixe}@iris.test`;
  const nom = `Assistante technique E2E ${suffixe}`;
  await formulaire.locator('input[name="email"]').fill(email);
  await formulaire.locator('input[name="name"]').fill(nom);
  await formulaire.locator('select[name="role"]').selectOption({ label: 'Assistante technique' });
  const ajout = administration.waitForResponse((r) => r.url().endsWith('/api/users') && r.request().method() === 'POST');
  await formulaire.getByRole('button', { name: 'Autoriser', exact: true }).click();
  const reponseAjout = await ajout;
  expect(reponseAjout.status()).toBe(201);
  expect(reponseAjout.request().postDataJSON()).toMatchObject({ email, role: 'ASSISTANTE_TECHNIQUE' });
  const comptes = await (await request.get(`${api}/users`, { headers })).json() as { id: string; email: string; role: string; estCommercial: boolean }[];
  const compte = comptes.find((c) => c.email === email)!;
  // Lecture écartée : l'ancien repli d'un type inconnu sur le conducteur de travaux.
  expect(compte).toMatchObject({ role: 'ASSISTANTE_TECHNIQUE', estCommercial: false });
  await expect(administration.locator('tr').filter({ hasText: email }).getByRole('combobox', { name: 'Modifier le rôle' }).locator('option:checked')).toHaveText('Assistante technique');

  // 2. Connectée : son type affiché et son menu, ni plus ni moins.
  const page = await connexion(compte);
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('.sidebar-compte-role')).toHaveText('Assistante technique');
  const menu = page.locator('#menu-principal');
  await expect(menu.getByRole('link', { name: 'Interventions SAV' })).toBeVisible();
  const entrees = await menu.locator('a').evaluateAll((liens) => liens.map((lien) => (lien.textContent || '').trim()));
  expect(entrees).toEqual(['Tableau de bord', 'Liste des chantiers', 'Devis', 'Planning', 'Interventions SAV', 'Contrats de maintenance', 'Clients', 'Administration']);
  for (const ferme of ['Journal des achats', 'Journal des heures', 'Factures', 'Statistiques', 'Performances', 'Mes commerciaux', 'Catalogue']) {
    await expect(menu.getByRole('link', { name: ferme, exact: true }), ferme).toHaveCount(0);
  }
  // Administration réduite aux référentiels des achats, avec le texte qui nomme le matériel des interventions SAV, et, depuis
  // AT-2a, l'onglet Chantiers (ouverture du chantier d'une affaire).
  await page.goto('/admin', { waitUntil: 'networkidle' });
  const principal = page.locator('main');
  await expect(principal.getByRole('button', { name: 'Chantiers', exact: true })).toBeVisible();
  await expect(principal.getByRole('button', { name: 'Fournisseurs', exact: true })).toBeVisible();
  await expect(principal.getByRole('button', { name: 'Catégories', exact: true })).toBeVisible();
  await expect(principal.getByRole('button', { name: 'Utilisateurs', exact: true })).toHaveCount(0);
  await expect(principal).toContainText('les fournisseurs servent aussi au matériel des interventions SAV');
  // Une route fermée la ramène à l'accueil (les factures : AT-3).
  await page.goto('/factures', { waitUntil: 'networkidle' });
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');

  // 3. Nouvelle intervention, pour un client retrouvé par la recherche.
  await page.goto('/interventions', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Nouvelle intervention' }).click();
  await choisirClient(page, client);
  const titre = `Fuite assistante technique E2E ${suffixe}`;
  await page.getByPlaceholder('Objet de la demande').fill(titre);
  const creation = page.waitForResponse((r) => r.url().endsWith('/api/interventions') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  const reponseCreation = await creation;
  expect(reponseCreation.status()).toBe(201);
  const intervention = await reponseCreation.json() as { id: string; reference: string };
  await expect(page.locator('article').filter({ has: page.getByRole('heading', { name: titre }) })).toBeVisible();

  // 4. Matériel saisi au format français sur la fiche : relu par l'API au centime, cumulé au format français, sans taux,
  // coût de main-d'œuvre ni marge à l'heure à l'écran.
  await page.goto(`/interventions/${intervention.id}`, { waitUntil: 'networkidle' });
  const carte = page.locator('article', { hasText: titre });
  const saisie = carte.locator('form').filter({ hasText: 'Enregistrer l’achat matériel' });
  await saisie.getByPlaceholder('Date (JJ-MM-AAAA)').fill(dateDuJour());
  await saisie.locator('select[name="fournisseurId"]').selectOption({ value: fournisseur.id, label: fournisseur.nom });
  await saisie.getByPlaceholder('Description du matériel').fill('Joint et raccord');
  await saisie.getByPlaceholder('Montant HT').fill('12,34');
  const achat = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/interventions/${intervention.id}/couts/achats`));
  await saisie.getByRole('button', { name: 'Enregistrer l’achat matériel' }).click();
  expect((await achat).status()).toBe(201);
  await expect(carte.getByText(/Matériel cumulé : 12,34\s€ HT/)).toBeVisible();
  await expect(carte.locator('[data-marge-sav]')).toHaveCount(0);
  await expect(carte.getByText(/Main-d’œuvre cumulée|Coût réel cumulé/)).toHaveCount(0);
  const couts = await (await request.get(`${api}/interventions/${intervention.id}/couts`, { headers })).json() as { totalMaterielHT: number; achats: { montantHT: number; createdById: string }[] };
  expect([couts.totalMaterielHT, couts.achats.map((a) => [a.montantHT, a.createdById])]).toEqual([12.34, [[12.34, compte.id]]]);

  // 5. Planning : l'intervention est dans la file « à planifier » ; elle la place, jour au format JJ-MM-AAAA.
  await page.goto('/planning', { waitUntil: 'networkidle' });
  const file = page.getByRole('region', { name: 'Interventions à planifier' });
  const ligne = file.getByRole('row', { name: new RegExp(intervention.reference) });
  await expect(ligne).toBeVisible();
  await ligne.getByRole('button', { name: 'Placer' }).click();
  const dialogue = page.getByRole('dialog', { name: /Planifier/ });
  await dialogue.getByLabel('Jour', { exact: true }).fill('15-06-2099');
  await dialogue.getByLabel('Heure de début').fill('09:00');
  await dialogue.getByLabel('Technicien').selectOption(fiche.id);
  const placement = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/interventions/${intervention.id}/planning`));
  await dialogue.getByRole('button', { name: 'Confirmer le placement' }).click();
  expect((await placement).status()).toBe(200);
  await expect(ligne).toHaveCount(0);
  const evenements = await (await request.get(`${api}/planning/events?start=2099-06-15&end=2099-06-15`, { headers })).json() as { interventionId: string | null; intervenants: { id: string }[] }[];
  const projection = evenements.find((e) => e.interventionId === intervention.id);
  expect(projection?.intervenants.map((i) => i.id)).toEqual([fiche.id]);
  const relue = await (await request.get(`${api}/interventions/${intervention.id}`, { headers })).json() as { statut: string };
  expect(relue.statut).toBe('PLANIFIEE');
});
