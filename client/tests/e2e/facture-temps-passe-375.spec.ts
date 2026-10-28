import { createHmac, randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, expect, choisirClient, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Lot « facture au temps passé », seconde PR (décisions de Nelson de la nuit du 26 au 27-10-2026, points 3
// et 8 à 12, et du 28-10-2026) : la facture d'une intervention au temps passé reprend les heures saisies
// sur l'intervention et ses suites, au prix figé sur le devis, arrondies au pas au-delà du minimum figé,
// avec au moins ce minimum, une fois au total. L'écran Factures en montre l'aperçu calculé par le serveur
// à la place de la saisie des lignes.

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable agit au nom du
// technicien pour saisir ses heures.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

async function preparer(request: APIRequestContext, token: string, creerClient: (libelle: string) => Promise<{ id: string; raisonSociale: string }>) {
  const envoyer = async (methode: 'get' | 'post' | 'put' | 'patch', path: string, data?: object, auth = token) => {
    const response = await request[methode](`${api}${path}`, { headers: { Authorization: `Bearer ${auth}` }, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const technicien = await envoyer('post', '/users', { email: `facture-tp.${suffixe}@iris.test`, name: `Technicien facture temps passé ${suffixe}`, role: 'TECHNICIEN' }) as { id: string };
  const fiche = await envoyer('post', '/intervenants', { nom: `Fiche facture temps passé ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 40 }) as { id: string };
  await envoyer('put', `/intervenants/${fiche.id}/compte`, { userId: technicien.id });
  const mainOeuvre = await envoyer('post', '/catalogue/prestations', {
    estMainOeuvre: true, reference: `E2E-FTP-${suffixe}`, nom: `Électricien facture temps passé ${suffixe}`, tauxTva: '20',
    prixVenteHt: '45.50', prixJourHorsContratHt: '320', prixHeureSousContratHt: '40', prixJourSousContratHt: '280', heuresParJour: '7',
  }) as { id: string };
  const client = await creerClient(`facture-temps-passe ${suffixe}`);
  const jour = dateDuJour();
  const jourIso = jour.split('-').reverse().join('-');
  const saisir = (interventionId: string, heures: number) => envoyer('post', `/interventions/${interventionId}/couts/heures`, { date: jour, nbrHeures: heures }, jetonPour(technicien.id));
  // Placée avec le technicien, qui y déclare ses heures, puis terminée avec un compte rendu.
  const realiser = async (interventionId: string, heures: number) => {
    await envoyer('put', `/interventions/${interventionId}/planning`, { dateDebut: jourIso, creneau: 'HEURES', heureDebut: '08:30', heureFin: '09:30', intervenantIds: [fiche.id] });
    await saisir(interventionId, heures);
    await envoyer('patch', `/interventions/${interventionId}/statut`, { statut: 'EN_COURS' });
    await envoyer('post', `/interventions/${interventionId}/rapports`, { contenu: 'Dépannage fait.', cleEnvoi: randomUUID() });
    await envoyer('patch', `/interventions/${interventionId}/statut`, { statut: 'TERMINEE', motifSansSignature: 'CLIENT_ABSENT' });
  };
  // Devis au temps passé (45,50 € HT de l'heure, minimum d'une heure, pas de 15 minutes) avec une fourniture
  // de 10 € HT, signé et converti en intervention.
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Dépannage au temps passé ${suffixe}`, auTempsPasse: true, lignes: [
    { tempsPasse: true, designation: 'Main d’œuvre au temps passé', quantite: 1, tarifTempsPasse: 'HORS_CONTRAT', catalogueFamille: 'prestations', catalogueId: mainOeuvre.id },
    { designation: 'Fourniture', nature: 'FOURNITURE', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 },
  ] }) as { id: string };
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const intervention = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'INTERVENTION' }) as { id: string; reference: string; titre: string };
  return { envoyer, client, intervention, realiser, saisir };
}

test('audit #351 : facture au temps passé lisible à 375 px, sans défilement horizontal, saisie ligne par ligne inchangée pour une intervention ordinaire', async ({ session, request, creerClient, allerSurPageAdmin }) => {
  const lire = async () => (await (await request.get(`${api}/parametres`, { headers: { Authorization: `Bearer ${session.token}` } })).json()) as { pasTempsPasseMinutes: number | null; tempsMinimumMinutes: number };
  const avant = await lire();
  const regler = (reglages: object) => request.put(`${api}/parametres`, { headers: { Authorization: `Bearer ${session.token}` }, data: reglages });
  expect((await regler({ pasTempsPasseMinutes: 15, tempsMinimumMinutes: 60 })).ok()).toBeTruthy();
  try {
    const { envoyer, client, intervention, realiser } = await preparer(request, session.token, creerClient);
    await realiser(intervention.id, 0.75);
    const ordinaire = await envoyer('post', '/interventions', { clientId: client.id, titre: 'Intervention ordinaire audit' }) as { id: string };
    const page = await allerSurPageAdmin('/factures');
    await page.setViewportSize({ width: 375, height: 800 });
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await choisirClient(page, client);
    await page.locator('select[name="origine"]').selectOption('INTERVENTION');
    const choix = page.getByRole('combobox', { name: 'Intervention facturée' });
    await choix.selectOption(intervention.id);
    const apercu = page.getByRole('region', { name: 'Facture au temps passé' });
    await expect(apercu.getByLabel('Heures facturées')).toHaveText('1 h');
    await expect(apercu.getByLabel('Totaux de la facture au temps passé')).toHaveText(/Total HT 55,50\s€/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), 'page élargie à 375 px').toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => { const m = document.querySelector('main')!; return m.scrollWidth - m.clientWidth; }), 'zone principale élargie').toBeLessThanOrEqual(0);
    await expect(page.getByRole('button', { name: 'Créer le brouillon au temps passé' })).toBeEnabled();
    // Intervention ordinaire : la saisie des lignes revient, et l'aperçu disparaît.
    await choix.selectOption(ordinaire.id);
    await expect(page.getByRole('region', { name: 'Facture au temps passé' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ajouter une ligne' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Créer le brouillon', exact: true })).toBeEnabled();
    // Retour à l'intervention au temps passé, puis changement d'origine : la sélection est remise à zéro.
    await choix.selectOption(intervention.id);
    await expect(apercu.getByLabel('Heures facturées')).toHaveText('1 h');
    await page.locator('select[name="origine"]').selectOption('HORS_AFFAIRE');
    await page.locator('select[name="origine"]').selectOption('INTERVENTION');
    await expect(page.getByRole('combobox', { name: 'Intervention facturée' })).toHaveValue('');
    await expect(page.getByRole('region', { name: 'Facture au temps passé' })).toHaveCount(0);
  } finally {
    await regler({ pasTempsPasseMinutes: avant.pasTempsPasseMinutes === null ? '' : avant.pasTempsPasseMinutes, tempsMinimumMinutes: avant.tempsMinimumMinutes });
  }
});
