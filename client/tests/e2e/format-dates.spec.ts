import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Décision de Nelson (14-10-2026) : toutes les dates s'affichent au même format JJ-MM-AAAA.
// La fiche chantier affichait les dates de ses achats en toutes lettres (« 05 octobre 2026 »).
test('la fiche chantier affiche les dates de ses achats au format JJ-MM-AAAA', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'put', path: string, data: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = Date.now();
  const client = await creerClient('format-dates', false);
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Format dates E2E ${suffixe}`, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }) as { id: string };
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string };
  const fournisseur = await envoyer('post', '/fournisseurs', { nom: `Fournisseur format ${suffixe}` }) as { id: string };
  const categorie = await envoyer('post', '/categories', { nom: `Catégorie format ${suffixe}` }) as { id: string };
  await envoyer('post', '/achats', { chantierId: chantier.id, fournisseurId: fournisseur.id, categorieId: categorie.id, date: '05-10-2026', description: `Achat format ${suffixe}`, montantHT: 10 });

  const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  // La ligne de l'achat dans la liste (sa description figure aussi au journal des saisies).
  const achat = page.locator('div.min-w-0', { has: page.getByText(`Achat format ${suffixe}`, { exact: true }) });
  await expect(achat).toContainText('05-10-2026 ·');
  await expect(achat).not.toContainText('octobre');
});

// La modale d'affectation du planning utilisait le sélecteur de date du navigateur (AAAA-MM-JJ
// selon la langue du poste) : elle saisit désormais ses dates en JJ-MM-AAAA, et les présente
// ainsi à la réouverture.
test('la modale du planning saisit et présente ses dates au format JJ-MM-AAAA', async ({ allerSurPageAdmin, page, request, session }) => {
  // Mercredi 21-10-2026 : la semaine affichée contient les 20 et 21 octobre.
  await page.clock.install({ time: new Date('2026-10-21T10:00:00Z') });
  const headers = { Authorization: `Bearer ${session.token}` };
  const nom = `Format planning E2E ${Date.now()}`;
  const intervenant = await request.post(`${api}/intervenants`, { headers, data: { nom, role: 'Technicien', tauxHoraireCharge: 40 } });
  expect(intervenant.ok(), await intervenant.text()).toBeTruthy();
  const { id: intervenantId } = await intervenant.json() as { id: string };
  const titre = `Affectation format ${Date.now()}`;
  let evenementId: string | undefined;
  try {
    await allerSurPageAdmin('/planning');
    await page.getByRole('button', { name: 'Affectation', exact: true }).click();
    const debut = page.locator('input[name="dateDebut"]');
    await expect(debut).toHaveAttribute('placeholder', 'JJ-MM-AAAA');
    await expect(debut).toHaveValue('21-10-2026');
    await page.getByRole('button', { name: 'Hors suivi (SAV…)' }).click();
    await page.locator('input[name="titre"]').fill(titre);
    await page.getByLabel(nom).check();
    await debut.fill('20-10-2026');
    await page.locator('input[name="dateFin"]').fill('21-10-2026');
    const creation = page.waitForResponse((r) => r.url().endsWith('/api/planning/events') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Ajouter au planning' }).click();
    const reponse = await creation;
    expect(reponse.status()).toBe(201);
    const corps = await reponse.json() as { id: string; dateDebut: string; dateFin: string };
    evenementId = corps.id;
    expect([corps.dateDebut, corps.dateFin]).toEqual(['2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z']);
    await page.getByText(titre).first().click();
    await expect(page.locator('input[name="dateDebut"]')).toHaveValue('20-10-2026');
    await expect(page.locator('input[name="dateFin"]')).toHaveValue('21-10-2026');
  } finally {
    if (evenementId) await request.delete(`${api}/planning/events/${evenementId}`, { headers });
    await request.delete(`${api}/intervenants/${intervenantId}`, { headers });
  }
});

// Parc d'un client : les dates d'installation et de garantie se saisissaient par le sélecteur du
// navigateur, et la date d'installation n'était pas affichée.
test('le parc d’un client saisit et affiche ses dates au format JJ-MM-AAAA', async ({ allerSurPageAdmin, creerClient, page, request, session }) => {
  const headers = { Authorization: `Bearer ${session.token}` };
  const suffixe = Date.now();
  const client = await creerClient('parc format', true);
  const modele = await request.post(`${api}/catalogue/equipements`, { headers, data: { reference: `FMT-${suffixe}`, nom: `Caméra format ${suffixe}`, prixVenteHt: '199' } });
  expect(modele.ok(), await modele.text()).toBeTruthy();
  const { id: modeleId } = await modele.json() as { id: string };
  try {
    await allerSurPageAdmin(`/clients/${client.id}`);
    const formulaire = page.locator('form').filter({ has: page.getByRole('button', { name: 'Ajouter au parc' }) });
    await formulaire.locator('select').first().selectOption(modeleId);
    await formulaire.locator('select').nth(1).selectOption({ index: 1 });
    await formulaire.getByLabel('Installé le (JJ-MM-AAAA)').fill('01-10-2026');
    await formulaire.getByLabel('Garantie jusqu’au (JJ-MM-AAAA)').fill('30-09-2028');
    const ajout = page.waitForResponse((r) => r.url().endsWith(`/api/clients/${client.id}/equipements`) && r.request().method() === 'POST');
    await formulaire.getByRole('button', { name: 'Ajouter au parc' }).click();
    expect((await ajout).status()).toBe(201);
    const carte = page.locator('article', { hasText: `Caméra format ${suffixe}` });
    await expect(carte).toContainText('Installé le : 01-10-2026');
    await expect(carte).toContainText('Garantie : 30-09-2028');
  } finally {
    await request.delete(`${api}/catalogue/equipements/${modeleId}`, { headers });
  }
});
