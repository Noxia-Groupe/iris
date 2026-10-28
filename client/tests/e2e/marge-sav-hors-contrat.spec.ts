import { createHmac } from 'node:crypto';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Lot « marge d'un SAV hors contrat » (décisions de Nelson de la nuit du 26 au 27-10-2026, points 4 à 7, et
// du 27-10-2026) : sur une intervention hors contrat, sans devis ni chantier, l'administration voit la marge
// à l'heure, au prix de vente de la main d'œuvre de chaque intervenant figé à la saisie ; les heures d'un
// intervenant sans main d'œuvre sont signalées.

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable agit au nom du
// technicien pour saisir ses heures.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

test('curative sans devis : l’administration voit la marge à l’heure au prix des mains d’œuvre, et le signalement des heures sans prix', async ({ session, request, creerClient, allerSurPageAdmin }) => {
  const envoyer = async (methode: 'post' | 'put', path: string, data?: object, auth = session.token) => {
    const response = await request[methode](`${api}${path}`, { headers: { Authorization: `Bearer ${auth}` }, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const mainOeuvre = await envoyer('post', '/catalogue/prestations', {
    estMainOeuvre: true, reference: `E2E-MSAV-${suffixe}`, nom: `Électricien E2E ${suffixe}`, tauxTva: '20',
    prixVenteHt: '45.50', prixJourHorsContratHt: '300', prixHeureSousContratHt: '41', prixJourSousContratHt: '280', heuresParJour: '7',
  }) as { id: string };
  // Deux techniciens à 30 € de l'heure : le premier rattaché à la main d'œuvre, le second sans.
  const technicien = async (libelle: string, rattache: boolean) => {
    const compte = await envoyer('post', '/users', { email: `marge-sav-${libelle}.${suffixe}@iris.test`, name: `Technicien ${libelle} ${suffixe}`, role: 'TECHNICIEN' }) as { id: string };
    const fiche = await envoyer('post', '/intervenants', { nom: `Fiche ${libelle} ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 30 }) as { id: string; nom: string };
    await envoyer('put', `/intervenants/${fiche.id}/compte`, { userId: compte.id });
    if (rattache) await envoyer('put', `/intervenants/${fiche.id}/main-oeuvre`, { mainOeuvreId: mainOeuvre.id });
    return { compte, fiche };
  };
  const avecMainOeuvre = await technicien('avec-mo', true);
  const sansMainOeuvre = await technicien('sans-mo', false);
  const client = await creerClient(`Marge SAV ${suffixe}`);
  const intervention = await envoyer('post', '/interventions', { clientId: client.id, titre: `Dépannage à l’heure ${suffixe}` }) as { id: string; titre: string };
  const jour = dateDuJour();
  const jourIso = jour.split('-').reverse().join('-');
  await envoyer('put', `/interventions/${intervention.id}/planning`, { dateDebut: jourIso, creneau: 'HEURES', heureDebut: '08:30', heureFin: '10:30', intervenantIds: [avecMainOeuvre.fiche.id, sansMainOeuvre.fiche.id] });
  await envoyer('post', `/interventions/${intervention.id}/couts/heures`, { date: jour, nbrHeures: 2 }, jetonPour(avecMainOeuvre.compte.id));
  await envoyer('post', `/interventions/${intervention.id}/couts/heures`, { date: jour, nbrHeures: 0.5 }, jetonPour(sansMainOeuvre.compte.id));

  const page = await allerSurPageAdmin(`/interventions/${intervention.id}`);
  const carte = page.locator('article', { hasText: intervention.titre });
  const marge = carte.locator('[data-marge-sav]');
  // Ventes : 2 h à 45,50 € = 91 € ; coût : 2,5 h à 30 € = 75 € ; marge 16 €.
  await expect(marge).toContainText(/Marge à l’heure : 16,00\s€ HT/);
  await expect(marge).toContainText(/Heures de l’intervention vendues 91,00\s€ HT au prix des mains d’œuvre, moins leur coût de 75,00\s€ HT\./);
  await expect(marge.getByRole('note')).toContainText(`Marge incomplète : 0,5 h sans prix de vente (${sansMainOeuvre.fiche.nom})`);
  await expect(carte.locator('[data-marge-devis]')).toHaveCount(0);
});
