import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect, jetonPour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// PR A4 du lot « anomalies d'écran », #206 (cadrage, version 2, contrôlé : C1, C7 et T1). Micro-arbitrage de droits
// d'affichage (règle 5, option la plus restrictive), choix par défaut, à confirmer : un compte sans rôle n'a aucun rôle,
// et non celui d'un conducteur de travaux. Le menu, roles.ts et les six pages (tableau de bord, statistiques, achats,
// liste des chantiers, planning, fiche chantier) lisent le rôle par roleDuCompte ; roleLabel n'affiche rien ; le planning
// et l'administration ne s'ouvrent pas.
//
// Scénario discriminant (T1 du contrôle du cadrage) : le compte mémorisé d'un conducteur, sans son rôle, et la relecture
// du compte (GET /api/me) en erreur 500, si bien que l'écran ne peut se fier qu'à la copie mémorisée. Avant A4, cette
// copie était lue en conducteur : menu, planning, administration, type affiché et « Modifier » de la fiche dont il est
// titulaire. Témoin : la même copie, son rôle présent, garde l'écran d'un conducteur ; l'absence relevée sans rôle tient
// donc au seul rôle, et non aux données ou à la relecture. Le serveur reste la seule sécurité : le jeton est celui du
// conducteur, et l'API lui sert ses chantiers.

type Compte = { id: string; name: string; email: string; role?: string; permissions?: string[] };

// Menu d'un conducteur de travaux, dans l'ordre affiché (lib/menu.ts) ; sans rôle, l'accueil et la liste des chantiers.
const MENU_CONDUCTEUR = ['/', '/chantiers', '/planning', '/achats', '/heures', '/interventions', '/statistiques', '/clients', '/admin'];
const MENU_SANS_ROLE = ['/', '/chantiers'];

const adresse = (page: Page) => new URL(page.url()).pathname;
const menu = (page: Page) => page.locator('#menu-principal nav a').evaluateAll((liens) => liens.map((lien) => new URL((lien as HTMLAnchorElement).href).pathname));
const typeAuMenu = (page: Page) => page.locator('.sidebar-compte-role');
const connecteEnTantQue = (page: Page) => page.locator('main span', { hasText: 'Connecté en tant que' }).locator('strong');

// Contexte de navigateur à lui : jeton du compte et copie mémorisée donnée ; toute relecture du compte répond 500.
async function ouvrirSansRelecture(browser: Browser, jeton: string, compteMemorise: object) {
  const contexte = await browser.newContext();
  const page = await contexte.newPage();
  const relectures: string[] = [];
  await page.route('**/api/me', async (route) => {
    relectures.push(route.request().method());
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Relecture du compte indisponible (parcours #206)' }) });
  });
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jeton, JSON.stringify(compteMemorise)]);
  return { contexte, page, relectures };
}

async function visiter(page: Page, chemin: string) {
  await page.goto(chemin, { waitUntil: 'networkidle' });
}

test.describe('Compte mémorisé sans type de compte (#206)', () => {
  test('sans relecture possible, un compte mémorisé sans type n’a ni le menu, ni le planning, ni l’administration, ni la fiche d’un conducteur ; avec son type, il les a', async ({ browser, request, session, creerClient }) => {
    test.slow();
    const headers = { Authorization: `Bearer ${session.token}` };
    const envoyer = async (methode: 'post' | 'patch' | 'put', chemin: string, data: object) => {
      const reponse = await request[methode](`${api}${chemin}`, { headers, data });
      expect(reponse.ok(), `${chemin} : ${reponse.status()} ${await reponse.text()}`).toBeTruthy();
      return reponse.json();
    };

    // Précondition : le module Planning est actif, sans quoi le menu d'un conducteur ne le montrerait pas non plus et le
    // test ne distinguerait plus rien sur ce point.
    const modules = await (await request.get(`${api}/modules`, { headers })).json() as { planningActifGlobal: boolean };
    expect(modules.planningActifGlobal, 'module Planning désactivé par une spec précédente : ce parcours le suppose actif').toBe(true);

    // Un conducteur de travaux, titulaire d'un chantier en cours (sa fiche lui propose « Modifier »).
    const suffixe = `${Date.now()}`;
    const conducteur = await envoyer('post', '/users', { email: `sans-role.ct.${suffixe}@iris.test`, name: `Conducteur sans rôle ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' }) as Compte;
    const client = await creerClient(`compte-sans-role-${suffixe}`);
    const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Compte sans rôle E2E ${suffixe}`, lignes: [
      { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 },
    ] });
    await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
    await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
    const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string; nom: string };
    await envoyer('patch', `/chantiers/${chantier.id}`, { responsableId: conducteur.id });
    const relu = await (await request.get(`${api}/chantiers/${chantier.id}`, { headers })).json() as { statut: string; responsable?: { id: string } };
    expect(relu.statut).toBe('EN_COURS');
    expect(relu.responsable?.id).toBe(conducteur.id);

    // Copie mémorisée : le compte tel que /api/me le rend à la connexion, avec ses permissions, puis la même sans son rôle.
    const jeton = jetonPour(conducteur.id);
    const moi = await request.get(`${api}/me`, { headers: { Authorization: `Bearer ${jeton}` } });
    expect(moi.ok(), `GET /api/me : ${moi.status()}`).toBeTruthy();
    const avecRole = await moi.json() as Compte;
    expect(avecRole.role).toBe('CONDUCTEUR_TRAVAUX');
    expect(avecRole.permissions).toEqual(expect.arrayContaining(['chantiers:read', 'chantiers:write']));
    const { role: _role, ...sansRole } = avecRole;
    expect(Object.hasOwn(sansRole, 'role')).toBe(false);

    const contextes: BrowserContext[] = [];
    try {
      // --- Témoin : la copie avec son rôle, relecture en erreur. L'écran est celui d'un conducteur de travaux. ---
      const temoin = await ouvrirSansRelecture(browser, jeton, avecRole);
      contextes.push(temoin.contexte);
      await visiter(temoin.page, '/');
      await expect.poll(() => menu(temoin.page), 'témoin : menu d’un conducteur').toEqual(MENU_CONDUCTEUR);
      await expect(typeAuMenu(temoin.page)).toHaveText('Conducteur de travaux');
      await expect(connecteEnTantQue(temoin.page)).toHaveText('Conducteur de travaux');
      await visiter(temoin.page, '/planning');
      await expect(temoin.page.getByRole('heading', { level: 1, name: 'Planning d\'intervention' })).toBeVisible();
      expect(adresse(temoin.page), 'témoin : planning ouvert').toBe('/planning');
      await visiter(temoin.page, '/admin');
      await expect(temoin.page.getByRole('heading', { level: 1, name: 'Administration & Paramétrage' })).toBeVisible();
      expect(adresse(temoin.page), 'témoin : administration ouverte').toBe('/admin');
      await visiter(temoin.page, `/chantiers/${chantier.id}`);
      await expect(temoin.page.getByRole('heading', { level: 2, name: chantier.nom })).toBeVisible();
      // « Modifier » de la fiche et du commercial : le conducteur titulaire d'un chantier en cours (canEditChantier).
      await expect(temoin.page.locator('main').getByRole('button', { name: 'Modifier', exact: true })).toHaveCount(2);
      expect(temoin.relectures.length, 'témoin : la relecture du compte a bien été tentée, et refusée').toBeGreaterThan(0);

      // --- Le même compte, mémorisé sans rôle, relecture en erreur : aucun rôle, et non celui d'un conducteur. ---
      const vue = await ouvrirSansRelecture(browser, jeton, sansRole);
      contextes.push(vue.contexte);
      const page = vue.page;

      // Tableau de bord : ouvert à tout compte connecté ; menu réduit à l'accueil et à la liste des chantiers, aucun type
      // affiché. Lectures écartées : le menu d'un conducteur, « Conducteur » (ancien repli de roleLabel, au menu) et
      // « Conducteur de travaux » (ancien repli des pages, dans « Connecté en tant que »).
      await visiter(page, '/');
      expect(adresse(page)).toBe('/');
      await expect(page.getByRole('heading', { level: 1, name: 'Tableau de Bord' })).toBeVisible();
      await expect(page.locator('.sidebar-compte-nom')).toHaveText(conducteur.name);
      expect(await menu(page), 'sans rôle : ni planning, ni journaux, ni interventions, ni administration').toEqual(MENU_SANS_ROLE);
      await expect(typeAuMenu(page)).toHaveText('');
      await expect(connecteEnTantQue(page)).toHaveText('');

      // Liste des chantiers : le chantier du conducteur est servi par l'API (jeton du conducteur), sans type affiché.
      await visiter(page, '/chantiers');
      expect(adresse(page)).toBe('/chantiers');
      await expect(page.getByRole('heading', { level: 1, name: 'Liste des Chantiers' })).toBeVisible();
      await expect(page.locator(`tr[data-chantier="${chantier.id}"]`)).toBeVisible();
      await expect(connecteEnTantQue(page)).toHaveText('');
      expect(await menu(page)).toEqual(MENU_SANS_ROLE);

      // Fiche du chantier dont il est titulaire : affichée, mais sans « Modifier », que seul un conducteur titulaire (ou
      // l'administration) se voit proposer à l'écran.
      await visiter(page, `/chantiers/${chantier.id}`);
      expect(adresse(page)).toBe(`/chantiers/${chantier.id}`);
      await expect(page.getByRole('heading', { level: 2, name: chantier.nom })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Rapport interne (PDF)' })).toBeVisible();
      await expect(page.locator('main').getByRole('button', { name: 'Modifier', exact: true })).toHaveCount(0);

      // Planning et administration : redirigés vers le tableau de bord (PrivateRoute, peutConsulterPlanning et
      // peutOuvrirAdministration). Les écrans réservés aux types de compte (journaux, interventions, statistiques,
      // annuaire) le restent aussi, comme avant A4.
      for (const chemin of ['/planning', '/admin', '/achats', '/heures', '/interventions', '/statistiques', '/clients']) {
        await visiter(page, chemin);
        await expect.poll(() => adresse(page), `${chemin} : redirigé vers le tableau de bord`).toBe('/');
        await expect(page.getByRole('heading', { level: 1, name: 'Tableau de Bord' }), chemin).toBeVisible();
        await expect(page.getByRole('heading', { level: 1, name: /Planning d'intervention|Administration & Paramétrage/ }), chemin).toHaveCount(0);
      }

      // La relecture a été tentée et refusée à chaque chargement, et la copie mémorisée est restée sans rôle : l'écran
      // n'a pu se fier qu'à elle, et l'application n'y a pas écrit de rôle.
      expect(vue.relectures.length, 'relecture du compte tentée').toBeGreaterThan(0);
      expect(vue.relectures.every((methode) => methode === 'GET')).toBe(true);
      const memorise = await page.evaluate(() => JSON.parse(localStorage.getItem('user') || 'null') as { id?: string; role?: string } | null);
      expect(memorise?.id).toBe(conducteur.id);
      expect(memorise?.role).toBeUndefined();
    } finally {
      for (const contexte of contextes) await contexte.close().catch(() => undefined);
    }
  });
});
