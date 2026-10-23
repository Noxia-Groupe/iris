import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Lot 6a-2 bis (décisions de Nelson du 23-10-2026) : un devis ne se signe et une facture ne s'émet
// que pour un client identifié. Professionnel : raison sociale, adresse de facturation et SIREN ;
// particulier, case « Pas de SIRET » cochée : nom complet et adresse.

const sansDefilementHorizontal = async (page: Page) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
};

async function lireClient(request: APIRequestContext, token: string, id: string) {
  const reponse = await request.get(`${api}/clients/${id}`, { headers: auth(token) });
  expect(reponse.status(), await reponse.text()).toBe(200);
  return reponse.json() as Promise<{ siren: string | null; sansSiret: boolean; raisonSociale: string; sites: unknown[] }>;
}

test('fiche client : « Pas de SIRET » vide et désactive le SIREN, renomme le champ en « Nom complet » et s’enregistre, à 375 px', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const client = await creerClient('identité case pas de SIRET', false);
  const page = await allerSurPageAdmin(`/clients/${client.id}`);
  await page.setViewportSize({ width: 375, height: 800 });
  const formulaire = page.getByRole('form', { name: 'Identité du client' });
  const siren = formulaire.getByLabel('SIREN');
  const sansSiret = formulaire.getByRole('checkbox', { name: 'Pas de SIRET (particulier)' });
  await expect(formulaire.getByLabel('Raison sociale')).toHaveValue(client.raisonSociale);
  await expect(siren).toHaveValue(/^\d{9}$/);
  await expect(siren).toBeEnabled();
  await expect(sansSiret).not.toBeChecked();

  await sansSiret.check();
  await expect(siren).toHaveValue('');
  await expect(siren).toBeDisabled();
  await expect(formulaire.getByLabel('Nom complet')).toHaveValue(client.raisonSociale);
  await expect(formulaire.getByLabel('Raison sociale')).toHaveCount(0);
  await sansDefilementHorizontal(page);
  await expect(formulaire.getByRole('button', { name: 'Enregistrer l’identité' })).toBeInViewport({ ratio: 1 });

  const reponse = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/api/clients/${client.id}`));
  await formulaire.getByRole('button', { name: 'Enregistrer l’identité' }).click();
  expect((await reponse).status()).toBe(200);
  await expect(formulaire.getByRole('status')).toHaveText('Identité du client enregistrée.');
  await expect(page.getByText('Particulier, sans SIRET')).toBeVisible();
  const relu = await lireClient(request, session.token, client.id);
  expect([relu.sansSiret, relu.siren]).toEqual([true, null]);
  // La fiche relue garde la case cochée et le SIREN désactivé.
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('form', { name: 'Identité du client' }).getByRole('checkbox', { name: 'Pas de SIRET (particulier)' })).toBeChecked();
  await expect(page.getByRole('form', { name: 'Identité du client' }).getByLabel('SIREN')).toBeDisabled();

  // Décochée, la case rend le SIREN saisissable et le libellé « Raison sociale ».
  await page.getByRole('form', { name: 'Identité du client' }).getByRole('checkbox', { name: 'Pas de SIRET (particulier)' }).uncheck();
  await expect(page.getByRole('form', { name: 'Identité du client' }).getByLabel('SIREN')).toBeEnabled();
  await expect(page.getByRole('form', { name: 'Identité du client' }).getByLabel('Raison sociale')).toHaveValue(client.raisonSociale);
});

test('nouveau client : la case « Pas de SIRET » se coche dès la création, avec le nom complet', async ({ allerSurPageAdmin, request, session }) => {
  const page = await allerSurPageAdmin('/clients');
  await page.getByRole('button', { name: 'Nouveau client' }).click();
  const formulaire = page.getByRole('form', { name: 'Nouveau client' });
  await formulaire.getByLabel('SIREN').fill('123456789');
  await formulaire.getByRole('checkbox', { name: 'Pas de SIRET (particulier)' }).check();
  await expect(formulaire.getByLabel('SIREN')).toHaveValue('');
  await expect(formulaire.getByLabel('SIREN')).toBeDisabled();
  const nom = `E2E Particulier ${Date.now()}`;
  await formulaire.getByLabel('Nom complet').fill(nom);
  const reponse = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/api/clients'));
  await formulaire.getByRole('button', { name: 'Créer la fiche' }).click();
  const creation = await reponse;
  expect(creation.status()).toBe(201);
  const { id } = await creation.json() as { id: string };
  await expect(page.getByRole('heading', { name: nom })).toBeVisible();
  await expect(page.getByText('Particulier, sans SIRET')).toBeVisible();
  const relu = await lireClient(request, session.token, id);
  expect([relu.raisonSociale, relu.sansSiret, relu.siren]).toEqual([nom, true, null]);
});

test('signature : refusée à l’écran pour un client sans adresse de facturation, sans rien enregistrer, puis acceptée après complétion de sa fiche, à 375 px', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const headers = auth(session.token);
  const client = await creerClient('signature client incomplet', false);
  const objet = `E2E signature client incomplet ${Date.now()}`;
  const cree = await request.post(`${api}/devis`, { headers, data: { clientId: client.id, objet, lignes: [{ designation: 'Diagnostic', quantite: 1, prixUnitaireHt: 80, tauxTva: 20 }] } });
  expect(cree.status(), await cree.text()).toBe(201);
  const devis = await cree.json() as { id: string };

  const page = await allerSurPageAdmin('/devis');
  await page.setViewportSize({ width: 375, height: 700 });
  const signer = async () => {
    await page.getByRole('listitem').filter({ hasText: objet }).getByRole('button', { name: 'Faire signer le client' }).click();
    const dialogue = page.getByRole('dialog', { name: 'Signature client' });
    await dialogue.getByRole('textbox', { name: 'Autre signataire client' }).fill('Client E2E');
    await dialogue.getByRole('checkbox', { name: 'Confirmation du client' }).check();
    const reponse = page.waitForResponse((r) => r.url().endsWith(`/api/devis/${devis.id}/signature`) && r.request().method() === 'POST');
    await dialogue.getByRole('button', { name: 'Enregistrer la signature client' }).click();
    return { dialogue, statut: (await reponse).status() };
  };
  const premier = await signer();
  expect(premier.statut).toBe(409);
  const alerte = page.getByRole('alert');
  await expect(alerte).toHaveText('Identité du client incomplète : renseignez adresse de facturation sur la fiche client avant d’enregistrer la signature d’un devis.');
  await expect(alerte).toBeInViewport();
  await expect(premier.dialogue).toBeVisible();
  await sansDefilementHorizontal(page);
  const relu = (await (await request.get(`${api}/devis`, { headers })).json() as { id: string; statut: string; signature: unknown }[]).find((d) => d.id === devis.id);
  expect(relu?.signature).toBeNull();
  expect(relu?.statut).toBe('BROUILLON');

  // La fiche est complétée depuis l'écran du client : un site de facturation.
  await page.goto(`/clients/${client.id}`, { waitUntil: 'networkidle' });
  await page.getByPlaceholder('Nom du site *').fill('Facturation');
  await page.getByPlaceholder('Adresse *').fill('3 rue Complétée');
  await page.getByPlaceholder('Code postal *').fill('14000');
  await page.getByPlaceholder('Ville *').fill('Caen');
  await page.getByRole('checkbox', { name: 'Facturation', exact: true }).check();
  await page.getByRole('button', { name: 'Ajouter le site' }).click();
  await expect(page.getByText('3 rue Complétée, 14000 Caen')).toBeVisible();

  await page.goto('/devis', { waitUntil: 'networkidle' });
  const second = await signer();
  expect(second.statut).toBe(201);
  await expect(second.dialogue).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ hasText: objet })).toContainText('Signature client : Client E2E');
  const signe = (await (await request.get(`${api}/devis`, { headers })).json() as { id: string; statut: string; signature: unknown }[]).find((d) => d.id === devis.id);
  expect(signe?.statut).toBe('ACCEPTE');
  expect(signe?.signature).toBeTruthy();
});

test('émission : refusée à l’écran pour un professionnel sans SIREN, sans numéro, puis acceptée une fois la case « Pas de SIRET » cochée, à 375 px', async ({ allerSurPageAdmin, request, session }) => {
  const headers = auth(session.token);
  const raisonSociale = `E2E Émission sans SIREN ${Date.now()}`;
  const creation = await request.post(`${api}/clients`, { headers, data: { raisonSociale } });
  expect(creation.status(), await creation.text()).toBe(201);
  const client = await creation.json() as { id: string };
  const site = await request.post(`${api}/clients/${client.id}/sites`, { headers, data: { nom: 'Facturation', adresse: '4 rue du Particulier', codePostal: '14000', ville: 'Caen', estSiteFacturation: true } });
  expect(site.status(), await site.text()).toBe(201);
  const jour = dateDuJour();
  const brouillon = await request.post(`${api}/factures`, { headers, data: { clientId: client.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Parcours identité du client', dateEmission: jour, dateEcheance: jour, lignes: [{ designation: 'Prestation identité du client', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] } });
  expect(brouillon.status(), await brouillon.text()).toBe(201);
  const facture = await brouillon.json() as { id: string };

  const page = await allerSurPageAdmin('/factures');
  await page.setViewportSize({ width: 375, height: 700 });
  const ligne = async () => {
    const trouvee = page.locator('tbody tr', { hasText: raisonSociale }).filter({ hasText: 'Facture' });
    await expect(page.getByTestId('pagination-factures')).toContainText('document(s)');
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
    const precedente = page.getByRole('button', { name: 'Page précédente' });
    while (await precedente.isEnabled()) {
      await precedente.click();
      await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
    }
    while (!(await trouvee.count())) {
      const suivante = page.getByRole('button', { name: 'Page suivante' });
      expect(await suivante.isEnabled(), `facture ${raisonSociale} absente de la pagination`).toBeTruthy();
      await suivante.click();
      await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
    }
    return trouvee;
  };
  const emettre = async () => {
    const reponse = page.waitForResponse((r) => r.url().endsWith(`/api/factures/${facture.id}/emettre`) && r.request().method() === 'POST');
    await (await ligne()).getByRole('button', { name: /Émettre/ }).click();
    return (await reponse).status();
  };
  expect(await emettre()).toBe(409);
  const alerte = page.getByRole('alert');
  await expect(alerte).toHaveText('Identité du client incomplète : renseignez SIREN (ou case « pas de SIRET » pour un particulier) sur la fiche client avant d’émettre une facture.');
  await expect(alerte).toBeInViewport();
  await sansDefilementHorizontal(page);
  await expect(await ligne()).toContainText('Brouillon');
  const relue = (await (await request.get(`${api}/factures`, { headers })).json() as { id: string; statut: string; numero: string | null }[]).find((f) => f.id === facture.id);
  expect([relue?.statut, relue?.numero]).toEqual(['BROUILLON', null]);

  // Le client est un particulier : la case est cochée sur sa fiche, puis l'émission passe.
  await page.goto(`/clients/${client.id}`, { waitUntil: 'networkidle' });
  const formulaire = page.getByRole('form', { name: 'Identité du client' });
  await formulaire.getByRole('checkbox', { name: 'Pas de SIRET (particulier)' }).check();
  await formulaire.getByRole('button', { name: 'Enregistrer l’identité' }).click();
  await expect(formulaire.getByRole('status')).toHaveText('Identité du client enregistrée.');
  await page.goto('/factures', { waitUntil: 'networkidle' });
  expect(await emettre()).toBe(200);
  await expect(page.getByText(/émise et figée/)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
