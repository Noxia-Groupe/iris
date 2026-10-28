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

test('facture au temps passé : l’aperçu reprend les heures de l’intervention et de sa suite une fois au total ; un aperçu périmé est refusé puis relu', async ({ session, request, creerClient, allerSurPageAdmin }) => {
  const lire = async () => (await (await request.get(`${api}/parametres`, { headers: { Authorization: `Bearer ${session.token}` } })).json()) as { pasTempsPasseMinutes: number | null; tempsMinimumMinutes: number };
  const avant = await lire();
  const regler = (reglages: object) => request.put(`${api}/parametres`, { headers: { Authorization: `Bearer ${session.token}` }, data: reglages });
  expect((await regler({ pasTempsPasseMinutes: 15, tempsMinimumMinutes: 60 })).ok()).toBeTruthy();
  try {
    const { envoyer, client, intervention, realiser, saisir } = await preparer(request, session.token, creerClient);
    // 0,75 h sur l'intervention et 0,5 h sur sa suite : 1,25 h, soit le minimum d'une heure et une tranche
    // de 15 minutes (et non 1 h + 1 h, minimum appliqué à chaque passage).
    await realiser(intervention.id, 0.75);
    const suite = await envoyer('post', `/interventions/${intervention.id}/suites`, {}) as { id: string; reference: string };
    await realiser(suite.id, 0.5);

    const page = await allerSurPageAdmin('/factures');
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await choisirClient(page, client);
    await page.locator('select[name="origine"]').selectOption('INTERVENTION');
    const choix = page.getByRole('combobox', { name: 'Intervention facturée' });
    await expect(choix.locator(`option[value="${intervention.id}"]`)).toHaveText(/— au temps passé$/);
    await choix.selectOption(intervention.id);
    const apercu = page.getByRole('region', { name: 'Facture au temps passé' });
    await expect(apercu.getByLabel('Heures facturées')).toHaveText('1,25 h');
    await expect(apercu.getByRole('list', { name: 'Heures comptées' })).toContainText(`${suite.reference} (suite) : 0,5 h`);
    await expect(apercu).toContainText('Minimum facturé 1 h, puis tranches de 15 min au-delà, toute tranche commencée étant due.');
    await expect(apercu.getByRole('row').nth(1)).toContainText(/Main d’œuvre au temps passé.*1,25.*45,50\s€.*20 %.*56,88\s€/);
    await expect(apercu.getByLabel('Totaux de la facture au temps passé')).toHaveText(/Total HT 66,88\s€ · TVA 13,38\s€ · Total TTC 80,26\s€/);
    // Aucune ligne à saisir : l'aperçu les remplace.
    await expect(page.getByRole('button', { name: 'Ajouter une ligne' })).toHaveCount(0);

    // Une heure saisie après l'aperçu : la création est refusée, et l'aperçu relu montre le nouveau total.
    await saisir(suite.id, 0.25);
    await page.getByRole('button', { name: 'Créer le brouillon au temps passé' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'a changé depuis l’aperçu' })).toHaveText(/La facture au temps passé a changé depuis l’aperçu \(total HT 78,25\s€ au lieu de 66,88\s€\) : relisez l’aperçu avant de la créer\./);
    await expect(apercu.getByLabel('Heures facturées')).toHaveText('1,5 h');
    await expect(apercu.getByLabel('Totaux de la facture au temps passé')).toHaveText(/Total HT 78,25\s€/);
    const factures = async () => ((await envoyer('get', '/factures')) as { interventionId: string | null; tempsPasse: boolean; totalHt: number; statut: string }[]).filter((f) => f.interventionId === intervention.id);
    expect(await factures()).toHaveLength(0);

    await page.getByRole('button', { name: 'Créer le brouillon au temps passé' }).click();
    await expect(page.getByText(/Brouillon créé/)).toBeVisible();
    expect((await factures()).map((f) => [f.tempsPasse, f.totalHt, f.statut])).toEqual([[true, 78.25, 'BROUILLON']]);
    await expect(page.getByRole('row').filter({ hasText: client.raisonSociale })).toContainText('Au temps passé');

    // Unique : l'aperçu suivant le refuse, et le bouton reste inactif.
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await choisirClient(page, client);
    await page.locator('select[name="origine"]').selectOption('INTERVENTION');
    await page.getByRole('combobox', { name: 'Intervention facturée' }).selectOption(intervention.id);
    await expect(page.getByRole('region', { name: 'Facture au temps passé' }).getByRole('alert')).toContainText('a déjà une facture (brouillon) : la facture au temps passé est unique');
    await expect(page.getByRole('button', { name: 'Créer le brouillon au temps passé' })).toBeDisabled();
  } finally {
    await regler({ pasTempsPasseMinutes: avant.pasTempsPasseMinutes === null ? '' : avant.pasTempsPasseMinutes, tempsMinimumMinutes: avant.tempsMinimumMinutes });
  }
});
