import { createHmac } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Intervention de suivi liée, seconde PR (décisions de Nelson du 24-10-2026, points 13 et 23, et de la nuit
// du 26 au 27-10-2026, points 1 et 2) : les coûts des suites d'une affaire comptent dans le réel du
// chantier ; une intervention issue d'un devis, sans chantier, montre à l'administration sa marge, suites
// comprises ; la suite d'une intervention hors contrat rappelle d'informer le client.

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable agit au nom du
// technicien pour saisir ses heures.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

const RAPPEL = 'Intervention hors contrat : cette suite n’était pas prévue au départ et peut coûter au client. Prévenez-le qu’elle sera facturée ou non.';

async function preparer(request: APIRequestContext, token: string, creerClient: (libelle: string) => Promise<{ id: string }>, libelle: string) {
  const envoyer = async (methode: 'post' | 'put' | 'patch', path: string, data?: object, auth = token) => {
    const response = await request[methode](`${api}${path}`, { headers: { Authorization: `Bearer ${auth}` }, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const technicien = await envoyer('post', '/users', { email: `${libelle}.${suffixe}@iris.test`, name: `Technicien ${libelle} ${suffixe}`, role: 'TECHNICIEN' }) as { id: string };
  const fiche = await envoyer('post', '/intervenants', { nom: `Fiche ${libelle} ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 40 }) as { id: string };
  await envoyer('put', `/intervenants/${fiche.id}/compte`, { userId: technicien.id });
  const client = await creerClient(`${libelle} ${suffixe}`);
  const jour = dateDuJour();
  const jourIso = jour.split('-').reverse().join('-');
  // Placée avec le technicien, qui y déclare `heures` heures (40 € de l'heure, taux de sa fiche).
  const heuresDuTechnicien = async (interventionId: string, heures: number) => {
    await envoyer('put', `/interventions/${interventionId}/planning`, { dateDebut: jourIso, creneau: 'HEURES', heureDebut: '08:30', heureFin: '09:30', intervenantIds: [fiche.id] });
    await envoyer('post', `/interventions/${interventionId}/couts/heures`, { date: jour, nbrHeures: heures }, jetonPour(technicien.id));
  };
  const devisSigne = async (objet: string) => {
    const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `${objet} ${suffixe}`, lignes: [
      { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: 150, tauxTva: 20 },
      { designation: 'Fourniture', nature: 'FOURNITURE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 },
    ] }) as { id: string; numero: string };
    await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
    await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
    return devis;
  };
  return { envoyer, client, suffixe, heuresDuTechnicien, devisSigne };
}

test('intervention issue d’un devis : l’administration voit sa marge, suites comprises ; la suite d’une curative rappelle d’informer le client', async ({ session, request, creerClient, allerSurPageAdmin }) => {
  const { envoyer, heuresDuTechnicien, devisSigne } = await preparer(request, session.token, creerClient, 'marge-devis');
  const devis = await devisSigne('Dépannage chiffré');
  const intervention = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'INTERVENTION' }) as { id: string; reference: string; titre: string };
  await heuresDuTechnicien(intervention.id, 1.5);

  const page = await allerSurPageAdmin(`/interventions/${intervention.id}`);
  const carte = page.locator('article', { hasText: intervention.titre });
  const marge = carte.locator('[data-marge-devis]');
  // Total HT du devis 400 €, moins 1,5 h à 40 € : 340 €.
  await expect(marge).toContainText(new RegExp(`Marge sur le devis ${devis.numero} : 340,00\\s€ HT`));
  await expect(marge).toContainText('aucune suite pour l’instant');

  // À l'ouverture de la suite d'une curative, le dialogue rappelle d'informer le client.
  await carte.getByRole('button', { name: 'Créer la suite' }).click();
  const dialogue = page.getByRole('dialog', { name: `Créer la suite de ${intervention.reference}` });
  await expect(dialogue.getByRole('note')).toHaveText(RAPPEL);
  const creation = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/interventions/${intervention.id}/suites`));
  await dialogue.getByRole('button', { name: 'Créer la suite' }).click();
  const suite = await (await creation).json() as { id: string; reference: string };
  await expect(dialogue).toHaveCount(0);
  await expect(marge).toContainText(/et de sa suite \(0,00\s€ HT\)/);

  // Les heures de la suite pèsent sur la marge de l'intervention initiale.
  await heuresDuTechnicien(suite.id, 0.5);
  await page.reload({ waitUntil: 'networkidle' });
  await expect(marge).toContainText(/Marge sur le devis .* : 320,00\s€ HT/);
  await expect(marge).toContainText(/et de sa suite \(20,00\s€ HT\)/);

  // La fiche de la suite porte le même rappel, sans marge propre.
  await page.goto(`/interventions/${suite.id}`, { waitUntil: 'networkidle' });
  const carteSuite = page.locator('article', { hasText: suite.reference });
  await expect(carteSuite.getByRole('note')).toHaveText(RAPPEL);
  await expect(carteSuite.locator('[data-marge-devis]')).toHaveCount(0);
});

test('la suite d’une visite de contrat ne porte pas le rappel du hors contrat', async ({ session, request, creerClient, allerSurPageAdmin }) => {
  const { envoyer, client, suffixe } = await preparer(request, session.token, creerClient, 'marge-visite');
  const contrat = await envoyer('post', '/contrats-maintenance', { clientId: client.id, titre: `Contrat suite ${suffixe}`, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-01-2099' }) as { id: string };
  const visite = await envoyer('post', `/contrats-maintenance/${contrat.id}/generer-intervention`) as { id: string; reference: string; titre: string };
  const page = await allerSurPageAdmin(`/interventions/${visite.id}`);
  const carte = page.locator('article', { hasText: visite.titre });
  await carte.getByRole('button', { name: 'Créer la suite' }).click();
  const dialogue = page.getByRole('dialog', { name: `Créer la suite de ${visite.reference}` });
  await expect(dialogue.getByRole('heading', { name: `Créer la suite de ${visite.reference}` })).toBeVisible();
  await expect(dialogue.getByRole('note')).toHaveCount(0);
  await dialogue.getByRole('button', { name: 'Annuler' }).click();
  await expect(dialogue).toHaveCount(0);
});

test('fiche chantier : les coûts des suites de l’affaire sont comptés dans le réel, et l’écran le dit', async ({ session, request, creerClient, allerSurPageAdmin }) => {
  const { envoyer, client, heuresDuTechnicien, devisSigne } = await preparer(request, session.token, creerClient, 'marge-chantier');
  const devis = await devisSigne('Affaire avec suites');
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string };
  const initiale = await envoyer('post', '/interventions', { clientId: client.id, titre: 'Dépannage de l’affaire', chantierId: chantier.id }) as { id: string };
  const suite = await envoyer('post', `/interventions/${initiale.id}/suites`, {}) as { id: string };
  await heuresDuTechnicien(initiale.id, 3); // l'intervention initiale reste hors du réel du chantier
  await heuresDuTechnicien(suite.id, 2);

  const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  await expect(page.locator('[data-couts-suites]')).toHaveText(/Dont suites SAV de l’affaire, comptées dans le réel : 2 h · matériel 0,00\s€ · main-d’œuvre 80,00\s€\./);
  // Le réel du chantier comprend les 2 h de la suite, et elles seules.
  await expect(page.getByText('2.00 h', { exact: true })).toBeVisible();
});
