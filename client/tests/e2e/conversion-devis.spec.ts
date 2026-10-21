import { createHmac } from 'node:crypto';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable
// ouvre une session dans un rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

// Lot pilote 4 (décision A7) : depuis l'écran Devis, l'administration crée l'intervention ou le
// contrat de maintenance d'un devis signé, sans ressaisir le client ni l'objet ; un refus du
// serveur reste affiché dans le formulaire, sans rien créer.
test('un devis signé crée son intervention ou son contrat depuis l’écran Devis', async ({ allerSurPageAdmin, creerClient, request, session, browser, page: pageAdmin }) => {
  test.slow();
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'put' | 'patch', path: string, data: object) => {
    const reponse = await request[methode](`${api}${path}`, { headers, data });
    expect(reponse.ok(), `${path} : ${await reponse.text()}`).toBeTruthy();
    return reponse.json();
  };
  const suffixe = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const devisSigne = async (clientId: string, objet: string) => {
    const devis = await envoyer('post', '/devis', { clientId, objet, lignes: [
      { designation: 'Visite', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 150, tauxTva: 20 },
    ] }) as { id: string };
    await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
    await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
    return devis;
  };
  const client = await creerClient('conversion-devis', true);
  const contact = await envoyer('post', `/clients/${client.id}/contacts`, { prenom: 'Camille', nom: `Contact ${suffixe}` }) as { id: string };
  const objetIntervention = `Dépannage converti ${suffixe}`;
  const objetContrat = `Maintenance convertie ${suffixe}`;
  await devisSigne(client.id, objetIntervention);
  await devisSigne(client.id, objetContrat);
  const clientInactif = await creerClient('conversion-devis-inactif', false);
  const objetRefuse = `Conversion refusée ${suffixe}`;
  await devisSigne(clientInactif.id, objetRefuse);
  const desactivation = await request.delete(`${api}/clients/${clientInactif.id}`, { headers });
  expect(desactivation.ok(), await desactivation.text()).toBeTruthy();

  const fenetres: string[] = [];
  pageAdmin.on('dialog', (dialogue) => { fenetres.push(`${dialogue.type()} : ${dialogue.message()}`); void dialogue.dismiss(); });
  const page = await allerSurPageAdmin('/devis');
  const ligne = (objet: string) => page.locator('li', { hasText: objet });

  // Intervention : à planifier, reliée au devis, sans autre conversion possible.
  await ligne(objetIntervention).getByRole('button', { name: 'Créer l’intervention' }).click();
  const formulaireIntervention = page.getByRole('dialog', { name: 'Créer l’intervention du devis' });
  await expect(formulaireIntervention.getByLabel('Titre')).toHaveValue(objetIntervention);
  await formulaireIntervention.getByLabel('Priorité').selectOption('HAUTE');
  await formulaireIntervention.getByLabel('Site').selectOption({ label: 'Facturation — Caen' });
  await formulaireIntervention.getByLabel('Contact').selectOption({ label: `Camille Contact ${suffixe}` });
  await formulaireIntervention.getByLabel('Date souhaitée').fill('15-12-2099');
  let envois = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/convertir')) envois += 1; });
  const creationIntervention = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/convertir'));
  // Double envoi : deux soumissions dans le même instant ne font qu'une requête.
  await formulaireIntervention.evaluate((f: HTMLFormElement) => { f.requestSubmit(); f.requestSubmit(); });
  const interventionCreee = await creationIntervention;
  expect(interventionCreee.status()).toBe(201);
  expect(await interventionCreee.json()).toMatchObject({ titre: objetIntervention, priorite: 'HAUTE', statut: 'A_PLANIFIER', site: { nom: 'Facturation' }, contact: { id: contact.id }, dateSouhaitee: '2099-12-15T00:00:00.000Z' });
  expect(envois).toBe(1);
  await expect(formulaireIntervention).toHaveCount(0);
  await expect(ligne(objetIntervention)).toContainText('Intervention issue de ce devis');
  for (const action of ['Ouvrir le chantier', 'Créer l’intervention', 'Créer le contrat', 'Annuler']) {
    await expect(ligne(objetIntervention).getByRole('button', { name: action, exact: true })).toHaveCount(0);
  }

  // Contrat : actif, avec sa périodicité, visible dans la liste des contrats.
  await ligne(objetContrat).getByRole('button', { name: 'Créer le contrat' }).click();
  const formulaireContrat = page.getByRole('dialog', { name: 'Créer le contrat du devis' });
  await formulaireContrat.getByLabel('Périodicité (mois)').fill('6');
  await formulaireContrat.getByLabel('Durée prévue (minutes)').fill('90');
  await formulaireContrat.getByLabel('Main-d’œuvre').selectOption('INCLUSE');
  await formulaireContrat.getByLabel('Matériel').selectOption('INCLUS');
  const creationContrat = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/convertir'));
  await formulaireContrat.getByRole('button', { name: 'Créer le contrat' }).click();
  expect((await creationContrat).status()).toBe(201);
  await expect(ligne(objetContrat)).toContainText('Contrat de maintenance issu de ce devis');
  for (const action of ['Ouvrir le chantier', 'Créer l’intervention', 'Créer le contrat', 'Annuler']) {
    await expect(ligne(objetContrat).getByRole('button', { name: action, exact: true })).toHaveCount(0);
  }

  // Refus du serveur : le client a été désactivé ; le message reste dans le formulaire.
  await ligne(objetRefuse).getByRole('button', { name: 'Créer l’intervention' }).click();
  const formulaireRefuse = page.getByRole('dialog', { name: 'Créer l’intervention du devis' });
  await formulaireRefuse.getByRole('button', { name: 'Créer l’intervention' }).click();
  await expect(formulaireRefuse.getByRole('alert')).toHaveText('Le client de ce devis est désactivé : l’intervention ne peut pas être créée. Réactivez d’abord sa fiche.');
  await formulaireRefuse.getByRole('button', { name: 'Annuler' }).click();
  await expect(formulaireRefuse).toHaveCount(0);
  await expect(ligne(objetRefuse).getByRole('button', { name: 'Créer l’intervention' })).toBeVisible();

  await ligne(objetIntervention).getByRole('link', { name: 'voir la fiche' }).click();
  await expect(page).toHaveURL(/\/interventions\/[0-9a-f-]+$/);
  await expect(page.getByText(objetIntervention).first()).toBeVisible();
  await page.goto('/contrats-maintenance', { waitUntil: 'networkidle' });
  const contrat = page.locator('article', { hasText: objetContrat });
  await expect(contrat).toContainText('Tous les 6 mois · 90 min prévues');
  await expect(contrat).toContainText('main-d’œuvre incluse · matériel inclus');

  // Un commercial, qui a le droit devis, ouvre toujours le chantier, mais ne se voit proposer ni
  // l'intervention ni le contrat, que le serveur lui refuse.
  const creation = await request.post(`${api}/users`, { headers, data: { email: `conversion.commercial.${suffixe}@iris.test`, name: `Commercial conversion ${suffixe}`, role: 'COMMERCIAL' } });
  expect(creation.status(), await creation.text()).toBe(201);
  const commercial = await creation.json() as { id: string; name: string; email: string };
  const contexte = await browser.newContext();
  try {
    const vueCommercial = await contexte.newPage();
    vueCommercial.on('dialog', (dialogue) => { fenetres.push(`${dialogue.type()} : ${dialogue.message()}`); void dialogue.dismiss(); });
    await vueCommercial.addInitScript(([token, user]) => {
      localStorage.setItem('token', token as string);
      localStorage.setItem('user', user as string);
    }, [jetonPour(commercial.id), JSON.stringify({ ...commercial, role: 'COMMERCIAL', permissions: ['devis:read', 'devis:write', 'clients:read', 'chantiers:read'] })]);
    await vueCommercial.goto('/devis', { waitUntil: 'networkidle' });
    const ligneCommercial = vueCommercial.locator('li', { hasText: objetRefuse });
    await expect(ligneCommercial.getByRole('button', { name: 'Ouvrir le chantier', exact: true })).toBeVisible();
    await expect(ligneCommercial.getByRole('button', { name: 'Créer l’intervention', exact: true })).toHaveCount(0);
    await expect(ligneCommercial.getByRole('button', { name: 'Créer le contrat', exact: true })).toHaveCount(0);
  } finally {
    await contexte.close();
  }
  expect(fenetres).toEqual([]);
});
