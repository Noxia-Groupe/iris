import { createHmac } from 'node:crypto';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Lot « matériel d'une intervention curative » (décision de Nelson du 28-10-2026, réponses du 29-10-2026 :
// « Au coût seul », « L'encadrement ») : l'administration saisit le matériel d'une curative ; son coût
// s'ajoute au coût réel et à la marge à l'heure, sans prix de vente.

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable agit au nom du
// technicien pour saisir ses heures.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

test('curative : l’administration saisit le matériel, compté à son coût dans le coût réel et la marge à l’heure', async ({ session, request, creerClient, allerSurPageAdmin }) => {
  const envoyer = async (methode: 'post' | 'put', path: string, data?: object, auth = session.token) => {
    const response = await request[methode](`${api}${path}`, { headers: { Authorization: `Bearer ${auth}` }, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const mainOeuvre = await envoyer('post', '/catalogue/prestations', {
    estMainOeuvre: true, reference: `E2E-MCUR-${suffixe}`, nom: `Plombier E2E ${suffixe}`, tauxTva: '20',
    prixVenteHt: '45.50', prixJourHorsContratHt: '300', prixHeureSousContratHt: '41', prixJourSousContratHt: '280', heuresParJour: '7',
  }) as { id: string };
  const compte = await envoyer('post', '/users', { email: `materiel-curative.${suffixe}@iris.test`, name: `Technicien matériel ${suffixe}`, role: 'TECHNICIEN' }) as { id: string };
  const fiche = await envoyer('post', '/intervenants', { nom: `Fiche matériel ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 30 }) as { id: string };
  await envoyer('put', `/intervenants/${fiche.id}/compte`, { userId: compte.id });
  await envoyer('put', `/intervenants/${fiche.id}/main-oeuvre`, { mainOeuvreId: mainOeuvre.id });
  const fournisseur = await envoyer('post', '/fournisseurs', { nom: `Fournisseur matériel E2E ${suffixe}` }) as { id: string; nom: string };
  const client = await creerClient(`Matériel curative ${suffixe}`);
  const intervention = await envoyer('post', '/interventions', { clientId: client.id, titre: `Fuite sous évier ${suffixe}` }) as { id: string; titre: string };
  const jour = dateDuJour();
  await envoyer('put', `/interventions/${intervention.id}/planning`, { dateDebut: jour.split('-').reverse().join('-'), creneau: 'HEURES', heureDebut: '08:30', heureFin: '10:30', intervenantIds: [fiche.id] });
  await envoyer('post', `/interventions/${intervention.id}/couts/heures`, { date: jour, nbrHeures: 2 }, jetonPour(compte.id));

  const page = await allerSurPageAdmin(`/interventions/${intervention.id}`);
  const carte = page.locator('article', { hasText: intervention.titre });
  // Avant le matériel : 2 h vendues 91 €, coûtant 60 € ; le total ne compte que la main-d'œuvre.
  await expect(carte.getByText(/Main-d’œuvre cumulée : 60,00\s€ HT/)).toBeVisible();
  await expect(carte.locator('[data-marge-sav]')).toContainText(/Marge à l’heure : 31,00\s€ HT/);

  const formulaire = carte.locator('form').filter({ hasText: 'Enregistrer l’achat matériel' });
  await formulaire.getByPlaceholder('Date (JJ-MM-AAAA)').fill(jour);
  await formulaire.locator('select[name="fournisseurId"]').selectOption({ value: fournisseur.id, label: fournisseur.nom });
  await formulaire.getByPlaceholder('Description du matériel').fill('Siphon et joints');
  await formulaire.getByPlaceholder('Montant HT').fill('15');
  const saisie = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/interventions/${intervention.id}/couts/achats`));
  await formulaire.getByRole('button', { name: 'Enregistrer l’achat matériel' }).click();
  expect((await saisie).status()).toBe(201);

  // Après : coût réel 75 € ; marge 91 − 60 − 15 = 16 €, le matériel compté à son coût, sans prix de vente.
  await expect(carte.getByText(/Coût réel cumulé : 75,00\s€ HT/)).toBeVisible();
  const marge = carte.locator('[data-marge-sav]');
  await expect(marge).toContainText(/Marge à l’heure : 16,00\s€ HT/);
  await expect(marge).toContainText(/moins leur coût de 60,00\s€ HT et le matériel, à son coût de 15,00\s€ HT\./);
});
