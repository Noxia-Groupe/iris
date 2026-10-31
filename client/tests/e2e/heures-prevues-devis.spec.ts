import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, choisirClient } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Lot « budget et heures prévues du chantier », heures prévues (réponses de Nelson du 30-10-2026) : une prestation
// du catalogue compte sa durée indicative × sa quantité (« Durée indicative »), une ligne de main-d'œuvre saisie à
// la main sa quantité (« Sa quantité ») ; le total s'affiche à l'écran du devis (« Écran seulement ») et devient
// les heures vendues du chantier à la conversion.

async function envoyer(request: APIRequestContext, token: string, methode: 'post' | 'put', chemin: string, data?: object) {
  const response = await request[methode](`${api}${chemin}`, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(response.ok(), `${chemin} : ${await response.text()}`).toBeTruthy();
  return response.json();
}

async function ajouterDuCatalogue(page: Page, recherche: string, nom: string) {
  await page.getByRole('searchbox', { name: 'Rechercher dans le catalogue' }).fill(recherche);
  await page.getByRole('button', { name: `Ajouter ${nom}` }).click();
  await expect(page.getByRole('searchbox', { name: 'Rechercher dans le catalogue' })).toHaveValue('');
}

test('écran du devis : le total des heures prévues, durée indicative × quantité et ligne saisie à la main ; la conversion le reprend', async ({ request, session, creerClient, allerSurPageAdmin }) => {
  const suffixe = `${Date.now()}`;
  const client = await creerClient('Heures prévues devis');
  const prestation = await envoyer(request, session.token, 'post', '/catalogue/prestations', {
    reference: `E2E-MES-${suffixe}`, nom: `Mise en service E2E ${suffixe}`, unite: 'forfait', prixVenteHt: '250', tauxTva: '20', dureeIndicativeMin: 90,
  }) as { nom: string };

  const page = await allerSurPageAdmin('/devis');
  await choisirClient(page, client);
  const objet = `Devis heures prévues E2E ${suffixe}`;
  await page.getByRole('textbox', { name: 'Objet' }).fill(objet);
  await ajouterDuCatalogue(page, suffixe, prestation.nom);
  await page.getByRole('spinbutton', { name: 'Qté' }).fill('2');
  await page.getByRole('button', { name: 'Ajouter une ligne' }).click();
  await page.getByRole('textbox', { name: /Désignation/ }).nth(1).fill('Câblage saisi à la main');
  await page.getByRole('spinbutton', { name: 'Qté' }).nth(1).fill('1.5');
  await page.getByRole('spinbutton', { name: 'PU HT' }).nth(1).fill('50');
  await page.getByRole('button', { name: 'Créer le brouillon' }).click();

  // 2 × 1 h 30 de mise en service, plus 1,5 h saisie à la main.
  const ligne = page.getByRole('listitem').filter({ hasText: objet });
  await expect(ligne).toContainText('HT 575.00 €');
  await expect(ligne.getByTestId('heures-prevues-devis')).toHaveText('Heures prévues : 4,5 h');

  const liste = await (await request.get(`${api}/devis`, { headers: { Authorization: `Bearer ${session.token}` } })).json() as { id: string; objet: string; heuresPrevues: number }[];
  const devis = liste.find((d) => d.objet === objet)!;
  expect(devis.heuresPrevues).toBe(4.5);
  await envoyer(request, session.token, 'post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer(request, session.token, 'post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { heuresVendues: number };
  expect(chantier.heuresVendues).toBe(4.5);
});
