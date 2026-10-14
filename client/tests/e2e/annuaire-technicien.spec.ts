import { createHmac } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable
// ouvre une session dans un rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

type Compte = { id: string; name: string; email: string; role: string };

// Jour civil JJ-MM-AAAA d'un instant dans un fuseau donné.
function jourDans(fuseau: string, instant: Date = new Date()) {
  const parties = new Intl.DateTimeFormat('en-GB', { timeZone: fuseau, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(instant);
  const valeur = (type: string) => parties.find((partie) => partie.type === type)!.value;
  return `${valeur('day')}-${valeur('month')}-${valeur('year')}`;
}

// Laisse au navigateur le temps de traiter une réponse déjà reçue (rendu React planifié).
const laisserRendre = (page: Page) => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));

async function pageDe(browser: Browser, compte: Compte) {
  const contexte = await browser.newContext();
  const page = await contexte.newPage();
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jetonPour(compte.id), JSON.stringify({ ...compte, permissions: [] })]);
  return page;
}

// Décision de Nelson (13-10-2026) : le technicien consulte l'annuaire des clients, leurs contacts
// et leurs sites, par exemple pour retrouver une adresse, et l'historique des chantiers, sans
// montant ; il ne modifie rien et ne voit ni devis ni prix.
test('un technicien consulte l’annuaire des clients et l’historique de ses chantiers, sans montant ni modification', async ({ creerClient, request, session, browser, allerSurPageAdmin, apiAdmin }) => {
  test.slow();
  const { fuseauHoraire } = await (await apiAdmin.get('/company')).json() as { fuseauHoraire?: string };
  const fuseau = fuseauHoraire || 'Europe/Paris';
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'patch' | 'put', path: string, data: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = Date.now();
  const technicien: Compte = await envoyer('post', '/users', { email: `annuaire.technicien.${suffixe}@iris.test`, name: `Technicien annuaire ${suffixe}`, role: 'TECHNICIEN' });
  // Site « Facturation », 2 rue du Parcours, 14000 Caen (cf. fixtures).
  const client = await creerClient('annuaire-technicien');
  await envoyer('post', `/clients/${client.id}/contacts`, { nom: 'Gardien', prenom: 'Paul', telephone: '06 11 22 33 44' });
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Annuaire technicien E2E ${suffixe}`, lignes: [
    { designation: 'Caméra', nature: 'FOURNITURE', quantite: 1, prixUnitaireHt: 4321.87, tauxTva: 20 },
  ] });
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  // Jour de la conversion, encadré : minuit peut tomber pendant l'appel.
  const jourAvant = jourDans(fuseau);
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string; nom: string };
  const jourApres = jourDans(fuseau);
  const contextes: { close: () => Promise<void> }[] = [];
  try {
    await envoyer('patch', `/chantiers/${chantier.id}`, { responsableId: technicien.id });
    const vue = await pageDe(browser, technicien);
    contextes.push(vue.context());
    await vue.goto('/', { waitUntil: 'networkidle' });
    // Aucune requête de l'annuaire ne doit être refusée (parc, catalogue…).
    const refus: string[] = [];
    let surveiller = true;
    vue.on('response', (reponse) => {
      if (surveiller && reponse.url().includes('/api/') && reponse.status() >= 400) refus.push(`${reponse.status()} ${reponse.request().method()} ${reponse.url()}`);
    });

    // Le menu propose l'annuaire, mais pas les devis.
    const menu = vue.locator('#menu-principal');
    await expect(menu.getByRole('link', { name: 'Devis' })).toHaveCount(0);
    await menu.getByRole('group', { name: 'Référentiels' }).getByRole('link', { name: 'Clients' }).click();
    await expect(vue).toHaveURL(/\/clients$/);
    await expect(vue.getByRole('heading', { name: 'Clients', level: 1 })).toBeVisible();
    await expect(vue.getByRole('button', { name: 'Nouveau client' })).toHaveCount(0);
    await vue.getByPlaceholder('Rechercher une société ou un SIREN').fill(client.raisonSociale);
    await vue.getByRole('link', { name: new RegExp(client.raisonSociale) }).click();

    // Fiche en consultation seule : coordonnées, contacts et sites, sans formulaire ni parc.
    await expect(vue).toHaveURL(new RegExp(`/clients/${client.id}$`));
    const fiche = vue.locator('main');
    await expect(fiche.getByRole('heading', { name: client.raisonSociale })).toBeVisible();
    await expect(fiche.getByRole('note')).toContainText('Consultation seule');
    await expect(fiche.getByText('06 11 22 33 44', { exact: false })).toBeVisible();
    await expect(fiche.getByText('2 rue du Parcours, 14000 Caen')).toBeVisible();
    for (const bouton of ['Ajouter le contact', 'Ajouter le site', 'Ajouter au parc', 'Archiver']) {
      await expect(fiche.getByRole('button', { name: bouton })).toHaveCount(0);
    }
    await expect(fiche.getByRole('heading', { name: 'Parc d’équipements installés' })).toHaveCount(0);

    // Historique des chantiers du client, sans montant.
    const historique = fiche.getByRole('region', { name: 'Historique des chantiers' });
    await expect(historique.getByRole('link', { name: chantier.nom })).toBeVisible();
    await expect(historique).toContainText('En cours');
    // Début : jour civil de la conversion dans le fuseau de l'entreprise.
    await expect(historique).toContainText(new RegExp(`Début : (${jourAvant}|${jourApres})`));
    await expect(fiche).not.toContainText('€');
    await expect(fiche).not.toContainText(/4[\s\u202f\u00a0]?321[,.]87/);
    expect(refus, 'requêtes refusées dans l’annuaire').toEqual([]);
    surveiller = false;

    // Depuis l'historique, la fiche du chantier, elle aussi en consultation seule.
    await historique.getByRole('link', { name: chantier.nom }).click();
    await expect(vue).toHaveURL(new RegExp(`/chantiers/${chantier.id}$`));
    await expect(vue.locator('[data-consultation-seule]')).toBeVisible();

    // Témoin : l'administration garde ses formulaires, le parc et le même historique.
    const admin = await allerSurPageAdmin(`/clients/${client.id}`);
    const ficheAdmin = admin.locator('main');
    await expect(ficheAdmin.getByRole('button', { name: 'Ajouter le contact' })).toBeVisible();
    await expect(ficheAdmin.getByRole('heading', { name: 'Parc d’équipements installés' })).toBeVisible();
    await expect(ficheAdmin.getByRole('region', { name: 'Historique des chantiers' }).getByRole('link', { name: chantier.nom })).toBeVisible();
    await expect(ficheAdmin.getByRole('note')).toHaveCount(0);
  } finally {
    // Chantier clôturé : la base partagée reste lisible pour la suite.
    await request.patch(`${api}/chantiers/${chantier.id}/statut`, { headers, data: { statut: 'TERMINE' } }).catch(() => undefined);
    for (const contexte of contextes) await contexte.close().catch(() => undefined);
  }
});

// L'historique ne bloque pas la fiche : s'il ne se charge pas, sa section le dit et le reste de
// la fiche (coordonnées, contacts, sites) reste consultable.
test('fiche client : un historique en échec est signalé dans sa section, sans bloquer la fiche', async ({ creerClient, page, allerSurPageAdmin }) => {
  const client = await creerClient('annuaire-historique-en-echec');
  await page.route('**/api/clients/*/chantiers', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Lecture de l’historique des chantiers impossible.' }) }));
  const fiche = (await allerSurPageAdmin(`/clients/${client.id}`)).locator('main');
  await expect(fiche.getByRole('heading', { name: client.raisonSociale })).toBeVisible();
  await expect(fiche.getByText('2 rue du Parcours, 14000 Caen')).toBeVisible();
  const historique = fiche.getByRole('region', { name: 'Historique des chantiers' });
  await expect(historique.getByRole('alert')).toHaveText('L’historique des chantiers n’a pas pu être chargé. Rechargez la page pour réessayer.');
  await expect(fiche.getByRole('button', { name: 'Ajouter le contact' })).toBeVisible();
});

// Les dates de l'historique sont des jours civils de l'entreprise : un instant (début d'un chantier
// converti) est lu dans son fuseau, une date-seule (minuit UTC) telle quelle. L'historique est
// intercepté pour placer l'instant là où le jour de l'entreprise et le jour UTC diffèrent.
test('fiche client : les dates de l’historique sont lues au jour civil de l’entreprise', async ({ creerClient, page, allerSurPageAdmin, apiAdmin }) => {
  const { fuseauHoraire } = await (await apiAdmin.get('/company')).json() as { fuseauHoraire?: string };
  const fuseau = fuseauHoraire || 'Europe/Paris';
  const instant = ['2026-10-14T22:30:00.000Z', '2026-10-14T01:30:00.000Z']
    .find((iso) => jourDans(fuseau, new Date(iso)) !== jourDans('UTC', new Date(iso)));
  expect(instant, `le fuseau ${fuseau} doit différer d'UTC pour ce test`).toBeTruthy();
  const client = await creerClient('annuaire-jour-civil');
  await page.route('**/api/clients/*/chantiers', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
    { id: 'converti', nom: 'Chantier converti de nuit', adresse: null, statut: 'EN_COURS', dateDebut: instant, dateFin: null },
    { id: 'corrige', nom: 'Chantier aux dates saisies', adresse: null, statut: 'TERMINE', dateDebut: '2026-03-02T00:00:00.000Z', dateFin: '2026-04-30T00:00:00.000Z' },
  ]) }));
  const historique = (await allerSurPageAdmin(`/clients/${client.id}`)).locator('main').getByRole('region', { name: 'Historique des chantiers' });
  await expect(historique.getByRole('listitem').filter({ hasText: 'Chantier converti de nuit' })).toContainText(`Début : ${jourDans(fuseau, new Date(instant!))}`);
  await expect(historique.getByRole('listitem').filter({ hasText: 'Chantier aux dates saisies' })).toContainText('Début : 02-03-2026 · Fin : 30-04-2026');
});

// Un rôle mémorisé périmé (administrateur, alors que le serveur répond technicien) ne laisse ni
// erreur ni parc sur la fiche : le chargement fait sous l'ancien rôle est ignoré, et l'erreur
// qu'il a pu produire est effacée par le chargement suivant.
for (const retarde of ['/api/me', '/api/clients/*/equipements']) {
  test(`fiche client : un rôle mémorisé périmé ne laisse ni erreur ni parc (${retarde} retardé)`, async ({ creerClient, request, session, browser }) => {
    const headers = { Authorization: `Bearer ${session.token}` };
    const creation = await request.post(`${api}/users`, { headers, data: { email: `annuaire.perime.${Date.now()}@iris.test`, name: `Technicien périmé ${Date.now()}`, role: 'TECHNICIEN' } });
    expect(creation.ok(), await creation.text()).toBeTruthy();
    const technicien = await creation.json() as Compte;
    const client = await creerClient('annuaire-role-perime');
    const vue = await pageDe(browser, { ...technicien, role: 'ADMIN' });
    try {
      await vue.route(`**${retarde}`, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.continue();
      });
      const reponseRetardee = vue.waitForResponse((r) => new RegExp(retarde.replace('*', '[^/]+') + '$').test(new URL(r.url()).pathname));
      await vue.goto(`/clients/${client.id}`);
      await reponseRetardee;
      const fiche = vue.locator('main');
      await expect(fiche.getByRole('note')).toContainText('Consultation seule');
      await laisserRendre(vue);
      await expect(fiche.locator('p.text-red-600')).toHaveCount(0);
      await expect(fiche.getByRole('heading', { name: 'Parc d’équipements installés' })).toHaveCount(0);
      await expect(fiche.getByRole('heading', { name: client.raisonSociale })).toBeVisible();
    } finally {
      await vue.context().close();
    }
  });
}
