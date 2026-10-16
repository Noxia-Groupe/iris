import { createHmac } from 'node:crypto';
import type { Browser } from '@playwright/test';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable
// ouvre une session dans un rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

type Compte = { id: string; name: string; email: string; role: string };

async function pageDe(browser: Browser, compte: Compte) {
  const contexte = await browser.newContext();
  const page = await contexte.newPage();
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jetonPour(compte.id), JSON.stringify({ ...compte, permissions: [] })]);
  return page;
}

// Lot (d), décisions de Nelson des 13 et 16-10-2026 : seuls les administrateurs voient les taux
// horaires et le coût de main-d'œuvre ; un conducteur garde ses heures, la marge et les alertes.
test('un conducteur suit son chantier sans taux ni coût de main-d’œuvre ; l’administration les voit', async ({ allerSurPageAdmin, creerClient, request, session, browser }) => {
  test.slow();
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'patch' | 'put', path: string, data: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = Date.now();
  const conducteur = await envoyer('post', '/users', { email: `taux.conducteur.${suffixe}@iris.test`, name: `Conducteur taux ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' }) as Compte;

  // Vendu 200 € : 100 € de fourniture et 2 h de pose à 50 € ; 3 h pointées à 47 € (141 €) :
  // heures et main-d'œuvre dépassées, marge du jour 59 €.
  const client = await creerClient('taux-horaire', false);
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Taux horaire E2E ${suffixe}`, lignes: [
    { designation: 'Caméra', nature: 'FOURNITURE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 },
    { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: 50, tauxTva: 20 },
  ] });
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string; nom: string };
  await envoyer('patch', `/chantiers/${chantier.id}`, { responsableId: conducteur.id });
  const intervenant = await envoyer('post', '/intervenants', { nom: `Taux horaire E2E ${suffixe} intervenant`, role: 'TECHNICIEN', tauxHoraireCharge: 47 });
  await envoyer('post', '/heures', { chantierId: chantier.id, intervenantId: intervenant.id, date: dateDuJour(), nbrHeures: 3 });

  const vueConducteur = await pageDe(browser, conducteur);
  try {
    // Fiche : marge, matériel, heures et alertes ; ni coût de main-d'œuvre, ni dépenses, ni €/h.
    await vueConducteur.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
    await expect(vueConducteur.getByText('Marge Commerciale', { exact: true }).first()).toBeVisible();
    await expect(vueConducteur.getByText('Consommation Matériel')).toBeVisible();
    await expect(vueConducteur.getByText('/ 2 h')).toBeVisible();
    await expect(vueConducteur.locator('[data-alerte="MAIN_OEUVRE_DEPASSEE"]').first()).toHaveText('Main-d’œuvre dépassée');
    await expect(vueConducteur.getByText('Coût Main d\'Œuvre')).toHaveCount(0);
    await expect(vueConducteur.getByText('Dépenses Réelles Cumulées')).toHaveCount(0);
    const estimation = vueConducteur.locator('[data-estimation]');
    await expect(estimation).toContainText('heures vendues au coût moyen réellement appliqué sur ce chantier');
    await expect(estimation).not.toContainText('€/h');

    // Journal des heures : les heures, sans colonne de coût interne.
    await vueConducteur.goto('/heures', { waitUntil: 'networkidle' });
    await vueConducteur.getByRole('button', { name: /Historique récent/ }).click();
    const ligneHeures = vueConducteur.locator('tr', { hasText: chantier.nom }).first();
    await expect(ligneHeures).toContainText('3h');
    await expect(ligneHeures).not.toContainText('€');
    await expect(vueConducteur.getByRole('columnheader', { name: 'Coût Interne' })).toHaveCount(0);

    // Témoin : l'administration voit le coût de main-d'œuvre, son dépassement chiffré et le coût interne.
    const vueAdmin = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
    await expect(vueAdmin.getByText('Coût Main d\'Œuvre')).toBeVisible();
    await expect(vueAdmin.getByText('Dépenses Réelles Cumulées')).toBeVisible();
    await expect(vueAdmin.locator('[data-alerte="MAIN_OEUVRE_DEPASSEE"]').first()).toHaveText('Main-d’œuvre +41 €');
    await expect(vueAdmin.locator('[data-estimation]')).toContainText('47 €/h');
    await vueAdmin.goto('/heures', { waitUntil: 'networkidle' });
    await vueAdmin.getByRole('button', { name: /Historique récent/ }).click();
    await expect(vueAdmin.getByRole('columnheader', { name: 'Coût Interne' })).toBeVisible();
    await expect(vueAdmin.locator('tr', { hasText: chantier.nom }).first()).toContainText('141.00 €');
  } finally {
    await vueConducteur.context().close();
  }
});
