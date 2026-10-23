import { test, expect, creerClientAvecSiren } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// La base E2E est volontairement conservée entre deux passages de la suite.
test('#113 : recherche, édition et signature d’un client hors des 200 premiers', async ({ allerSurPageAdmin, request, session }) => {
  const headers = auth(session.token);
  // D8 : une recherche qui renvoie 200 résultats doit annoncer la limite, même sur une base déjà peuplée.
  const prefixLimite = `E2E 113 limite ${Date.now()}`;
  for (let i = 0; i < 200; i += 20) {
    const reponses = await Promise.all(Array.from({ length: 20 }, (_, j) =>
      request.post(`${api}/clients`, { headers, data: { raisonSociale: `${prefixLimite} ${String(i + j).padStart(3, '0')}` } })));
    for (const reponse of reponses) expect(reponse.status(), await reponse.text()).toBe(201);
  }
  const prefix = `ZZZ E2E 113 ${Date.now()}`;
  // Lot 6a-2 bis : le client se signe ; il est donc identifié (SIREN et site de facturation).
  const clientId = (await creerClientAvecSiren(request, headers, { raisonSociale: `${prefix} cible` })).id;
  const site = await request.post(`${api}/clients/${clientId}/sites`, { headers, data: { nom: 'Facturation', adresse: '2 rue du Parcours', codePostal: '14000', ville: 'Caen', estSiteFacturation: true } });
  expect(site.status(), await site.text()).toBe(201);
  const contact = await request.post(`${api}/clients/${clientId}/contacts`, { headers, data: { nom: 'Signataire113', prenom: 'Alice', estSignataire: true } });
  expect(contact.status(), await contact.text()).toBe(201);
  const nonHabilite = await request.post(`${api}/clients/${clientId}/contacts`, { headers, data: { nom: 'NonHabilite113', estSignataire: false } });
  expect(nonHabilite.status(), await nonHabilite.text()).toBe(201);
  expect((await (await request.get(`${api}/clients`, { headers })).json()).clients.some((c: { id: string }) => c.id === clientId)).toBe(false);
  const fiche = await request.get(`${api}/clients/${clientId}`, { headers });
  expect(fiche.status()).toBe(200);
  expect((await fiche.json()).contacts.some((c: { nom: string; estSignataire: boolean }) => c.nom === 'Signataire113' && c.estSignataire)).toBe(true);
  const cle = await request.post(`${api}/admin/api-keys`, { headers, data: { nom: `E2E devis 113 ${Date.now()}`, scopes: ['devis:read'] } });
  expect(cle.status()).toBe(201);
  const { apiKey, key } = await cle.json() as { apiKey: string; key: { id: string } };
  try {
    const refuse = await request.get(`${api}/v1/clients/${clientId}`, { headers: auth(apiKey) });
    expect(refuse.status()).toBe(403);
    expect((await refuse.json()).error).toMatch(/clients:read/);

    const page = await allerSurPageAdmin('/devis');
    const recherche = page.getByRole('searchbox', { name: 'Rechercher un client' });
    const select = page.getByRole('combobox', { name: 'Client du devis' });
    await recherche.fill(prefixLimite);
    await expect(select.locator('option')).toHaveCount(201); // option vide + 200 clients
    await expect(page.getByRole('status', { name: 'Limite des résultats clients' })).toContainText('200 clients maximum');
    await expect(select.locator(`option[value="${clientId}"]`)).toHaveCount(0);
  await recherche.fill(prefix);
  await expect(select.locator(`option[value="${clientId}"]`)).toHaveCount(1);
  await select.selectOption(clientId);
  await page.getByRole('textbox', { name: 'Objet' }).fill(`Devis 113 ${prefix}`);
  await page.getByRole('textbox', { name: 'Désignation' }).fill('Prestation test');
  await page.getByRole('spinbutton', { name: 'PU HT' }).fill('10');
  const creation = page.waitForResponse(r => r.url().endsWith('/api/devis') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Créer le brouillon' }).click();
  const cree = await creation;
  expect(cree.status(), await cree.text()).toBe(201);
  const devisId = (await cree.json()).id as string;
  const ligne = page.getByRole('listitem').filter({ hasText: `Devis 113 ${prefix}` });
  await expect(ligne).toBeVisible();
  await ligne.getByRole('button', { name: 'Modifier' }).click();
  await expect(select).toHaveValue(clientId);
  await expect(select.locator(`option[value="${clientId}"]`)).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Objet' }).fill(`Devis 113 modifié ${prefix}`);
  const edition = page.waitForResponse(r => r.url().endsWith(`/api/devis/${devisId}`) && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  expect((await edition).status()).toBe(200);
  const devisRelu = await request.get(`${api}/devis`, { headers });
  expect(devisRelu.ok()).toBeTruthy();
  expect((await devisRelu.json()).find((d: { id: string }) => d.id === devisId).client.id).toBe(clientId);
  const ligneModifiee = page.getByRole('listitem').filter({ hasText: `Devis 113 modifié ${prefix}` });
  await expect(ligneModifiee).toBeVisible();
  await ligneModifiee.getByRole('button', { name: 'Faire signer le client' }).click();
  const dialogue = page.getByRole('dialog', { name: 'Signature client' });
  await expect(dialogue.getByRole('combobox', { name: 'Signataire client' }).getByRole('option', { name: 'Alice Signataire113' })).toBeAttached();
  await expect(dialogue.getByRole('combobox', { name: 'Signataire client' }).getByRole('option', { name: 'NonHabilite113' })).toHaveCount(0);
  await dialogue.getByRole('combobox', { name: 'Signataire client' }).selectOption({ label: 'Alice Signataire113' });
  await dialogue.getByRole('checkbox', { name: 'Confirmation du client' }).check();
  const signature = page.waitForResponse(r => r.url().endsWith(`/api/devis/${devisId}/signature`) && r.request().method() === 'POST');
  await dialogue.getByRole('button', { name: 'Enregistrer la signature client' }).click();
  expect((await signature).status()).toBe(201);
  await expect(ligneModifiee).toContainText('Signature client : Alice Signataire113');
  const revision = page.waitForResponse(r => r.url().endsWith(`/api/devis/${devisId}/revisions`) && r.request().method() === 'POST');
  await ligneModifiee.getByRole('button', { name: 'Créer une révision' }).click();
  const revisionCreee = await revision;
  expect(revisionCreee.status()).toBe(201);
  const revisionId = (await revisionCreee.json()).id as string;
  await expect(page.getByRole('heading', { name: 'Modifier le brouillon' })).toBeVisible();
  await expect(select).toHaveValue(clientId);
  await expect(select.locator(`option[value="${clientId}"]`)).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Objet' }).fill(`Devis 113 révision ${prefix}`);
  const sauvegardeRevision = page.waitForResponse(r => r.url().endsWith(`/api/devis/${revisionId}`) && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  expect((await sauvegardeRevision).status()).toBe(200);
  const revisionsRelues = await request.get(`${api}/devis`, { headers });
  expect(revisionsRelues.ok()).toBeTruthy();
  const revisionRelue = (await revisionsRelues.json()).find((d: { id: string }) => d.id === revisionId);
  expect(revisionRelue).toMatchObject({ id: revisionId, version: 2, objet: `Devis 113 révision ${prefix}`, client: { id: clientId } });
  } finally {
    const revoke = await request.post(`${api}/admin/api-keys/${key.id}/revoke`, { headers });
    expect(revoke.status()).toBe(200);
    const keys = await request.get(`${api}/admin/api-keys`, { headers });
    expect(keys.status()).toBe(200);
    expect((await keys.json() as { nom: string; actif: boolean }[]).filter(k => k.nom.startsWith('E2E devis 113 ') && k.actif)).toHaveLength(0);
  }
});

test('#113 : les recherches périmées et leurs erreurs ne remplacent pas la sélection courante', async ({ allerSurPageAdmin, request, session }) => {
  const headers = auth(session.token);
  const prefix = `ZZZ E2E 113 recherche ${Date.now()}`;
  const ids: string[] = [];
  for (const nom of ['ancien', 'cible']) {
    const response = await request.post(`${api}/clients`, { headers, data: { raisonSociale: `${prefix} ${nom}` } });
    expect(response.status(), await response.text()).toBe(201);
    ids.push((await response.json()).id);
  }
  const page = await allerSurPageAdmin('/devis');
  const recherche = page.getByRole('searchbox', { name: 'Rechercher un client' });
  const select = page.getByRole('combobox', { name: 'Client du devis' });
  await recherche.fill(`${prefix} ancien`);
  await expect(select.locator(`option[value="${ids[0]}"]`)).toHaveCount(1);
  await select.selectOption(ids[0]);
  await recherche.fill(prefix);
  await expect(select).toHaveValue(''); // L'ancien ID doit être effacé même s'il reste dans les résultats.
  await expect(select).toBeDisabled();
  await expect(select.locator(`option[value="${ids[0]}"]`)).toHaveCount(1); // l'ancien est bien dans les résultats
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue(''); // L'ancien ID doit être effacé même s'il reste dans les résultats.
  await expect(select.locator(`option[value="${ids[1]}"]`)).toHaveCount(1);
  await select.selectOption(ids[1]);

  for (const echec of [false, true]) {
    let liberer!: () => void;
    const attente = new Promise<void>(resolve => { liberer = resolve; });
    await page.route('**/api/clients?q=*', async route => {
      if (new URL(route.request().url()).searchParams.get('q') === `${prefix} ancien`) {
        await attente;
        if (echec) await route.fulfill({ status: 503, json: { error: 'Erreur périmée devis 113' } });
        else await route.continue();
      } else await route.continue();
    });
    const envoyee = page.waitForRequest(r => new URL(r.url()).searchParams.get('q') === `${prefix} ancien`);
    await recherche.fill(`${prefix} ancien`);
    await envoyee;
    await recherche.fill(`${prefix} cible`);
    await expect(select).toBeDisabled();
    await expect(select.locator(`option[value="${ids[1]}"]`)).toHaveCount(1);
    await select.selectOption(ids[1]);
    const retour = page.waitForResponse(r => new URL(r.url()).searchParams.get('q') === `${prefix} ancien`);
    liberer();
    await (await retour).finished();
    await page.evaluate(async ({ cibleId, ancienId }) => {
      const fin = performance.now() + 500;
      while (performance.now() < fin) {
        const select = document.querySelector<HTMLSelectElement>('select[name="clientId"]');
        if (select?.value !== cibleId || select.querySelector(`option[value="${ancienId}"]`) || document.body.textContent?.includes('Erreur périmée devis 113')) throw new Error('Réponse périmée appliquée');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }, { cibleId: ids[1], ancienId: ids[0] });
    await page.unroute('**/api/clients?q=*');
  }
  await page.route('**/api/clients?q=*', route => route.fulfill({ status: 503, json: { error: 'Recherche indisponible 113' } }));
  await recherche.fill(`${prefix} erreur`);
  await expect(page.getByRole('alert')).toContainText('Recherche indisponible 113');
  await expect(select).toBeDisabled();
});

test('#113 : D5 — une réponse signataire A tardive ne remplace pas les contacts du devis B', async ({ allerSurPageAdmin, request, session }) => {
  const headers = auth(session.token);
  const prefix = `D5 ${Date.now()}`;
  const clients: string[] = [];
  for (const nom of ['A', 'B']) {
    const client = await request.post(`${api}/clients`, { headers, data: { raisonSociale: `${prefix} ${nom}` } });
    expect(client.status(), await client.text()).toBe(201);
    const clientId = (await client.json()).id as string;
    clients.push(clientId);
    const contact = await request.post(`${api}/clients/${clientId}/contacts`, { headers, data: { nom: `Sign${nom}`, estSignataire: true } });
    expect(contact.status(), await contact.text()).toBe(201);
    const devis = await request.post(`${api}/devis`, { headers, data: {
      clientId, objet: `${prefix} devis ${nom}`, acompteExige: false,
      lignes: [{ designation: 'Prestation D5', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 1, tauxTva: 20 }],
    } });
    expect(devis.status(), await devis.text()).toBe(201);
  }
  const page = await allerSurPageAdmin('/devis');
  const ligneA = page.getByRole('listitem').filter({ hasText: `${prefix} devis A` });
  const ligneB = page.getByRole('listitem').filter({ hasText: `${prefix} devis B` });
  await expect(ligneA).toBeVisible();
  await expect(ligneB).toBeVisible();
  let libererA!: () => void;
  const attenteA = new Promise<void>(resolve => { libererA = resolve; });
  await page.route(`**/api/clients/${clients[0]}`, async route => {
    await attenteA;
    await route.continue();
  });
  let attenteLiberee = false;
  try {
    const requeteA = page.waitForRequest(r => r.url().endsWith(`/api/clients/${clients[0]}`));
    await ligneA.getByRole('button', { name: 'Faire signer le client' }).click();
    await requeteA;
    const dialogue = page.getByRole('dialog', { name: 'Signature client' });
    await expect(dialogue.getByText('Chargement des contacts…')).toBeVisible();
    await dialogue.getByRole('button', { name: 'Annuler' }).click();
    const reponseB = page.waitForResponse(r => r.url().endsWith(`/api/clients/${clients[1]}`));
    await ligneB.getByRole('button', { name: 'Faire signer le client' }).click();
    const contactB = await reponseB;
    expect(contactB.status()).toBe(200);
    const signataires = page.getByRole('dialog', { name: 'Signature client' }).getByRole('combobox', { name: 'Signataire client' });
    await expect(signataires.getByRole('option', { name: 'SignB' })).toBeAttached();
    await expect(signataires.getByRole('option', { name: 'SignA' })).toHaveCount(0);
    const reponseA = page.waitForResponse(r => r.url().endsWith(`/api/clients/${clients[0]}`));
    libererA(); attenteLiberee = true;
    expect((await reponseA).status()).toBe(200);
    await (await reponseA).finished();
    await page.evaluate(async () => {
      const fin = performance.now() + 500;
      while (performance.now() < fin) {
        const select = document.querySelector<HTMLSelectElement>('select[aria-label="Signataire client"]');
        if (!select || !Array.from(select.options).some(o => o.text === 'SignB') || Array.from(select.options).some(o => o.text === 'SignA')) throw new Error('Contacts du devis A appliqués à la signature de B');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    });
  } finally {
    if (!attenteLiberee) libererA();
    await page.unroute(`**/api/clients/${clients[0]}`);
  }
});
