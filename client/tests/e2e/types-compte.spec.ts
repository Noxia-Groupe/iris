import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// PR A3 du lot « anomalies d'écran », #203 (cadrage, version 2, contrôlé) ; point 1 de #475 ; N4 du contrôle (casse de
// la cible, MODELE-DROITS-CIBLE.md:324). Micro-arbitrage d'affichage (règle 5), choix par défaut, à confirmer :
//  - une seule liste ordonnée des types de compte (lib/droits.ts, TYPES_COMPTE), employée par les deux listes de
//    l'administration : « Autoriser un compte » et le type de chaque compte du tableau ;
//  - l'ordre et les valeurs ne changent pas, et l'option « Super administrateur » reste réservée à un super
//    administrateur ;
//  - un seul libellé par type, en casse de phrase, lu aussi par le menu, « Connecté en tant que » (tableau de bord,
//    liste des chantiers, statistiques, administration) et le journal d'administration.
// Libellés écartés : « Super Administrateur » et « Conducteur de Travaux » (anciennes listes), « Super Admin », « Admin »
// et « Conducteur » (ancien roleLabel, pour un compte de ces types).

const TYPES: ReadonlyArray<readonly [string, string]> = [
  ['CONDUCTEUR_TRAVAUX', 'Conducteur de travaux'],
  ['COMMERCIAL', 'Commercial'],
  ['ASSISTANTE_COMMERCIALE', 'Assistante commerciale'],
  // Lot « Assistante technique », PR AT-1 (cadrage v2.1, « Type ») : onzième type, après « Assistante commerciale ».
  ['ASSISTANTE_TECHNIQUE', 'Assistante technique'],
  ['TECHNICIEN', 'Technicien'],
  ['COMPTABLE', 'Comptable'],
  ['DIRECTEUR_COMMERCIAL', 'Directeur commercial'],
  ['RESPONSABLE', 'Responsable'],
  ['DIRECTEUR', 'Directeur'],
  ['ADMIN', 'Administrateur'],
  ['SUPERADMIN', 'Super administrateur'],
];
const SANS_SUPERADMIN = TYPES.filter(([valeur]) => valeur !== 'SUPERADMIN');

type Compte = { id: string; name: string; email: string; role: string };

// Options d'une liste, dans l'ordre : libellés relus jusqu'à l'attendu, puis valeurs et libellés ensemble.
async function verifierTypesProposes(liste: Locator, attendus: ReadonlyArray<readonly [string, string]>) {
  await expect(liste.locator('option')).toHaveText(attendus.map(([, libelle]) => libelle));
  const lues = await liste.locator('option').evaluateAll((options) => options.map((option) => [(option as HTMLOptionElement).value, option.textContent]));
  expect(lues).toEqual(attendus.map(([valeur, libelle]) => [valeur, libelle]));
}

// Type affiché du compte connecté : dans le menu (Sidebar.tsx:78) et dans « Connecté en tant que », sur chacune des quatre
// pages qui l'affichent (Dashboard.tsx:133, ListeChantiers.tsx:334, Statistiques.tsx:335, Admin.tsx:546). La page finit
// sur l'administration.
async function verifierTypeAffiche(page: Page, libelle: string) {
  for (const chemin of ['/', '/chantiers', '/statistiques', '/admin']) {
    await page.goto(chemin, { waitUntil: 'networkidle' });
    // La page visée elle-même, et non celle d'une redirection (le tableau de bord affiche aussi le type).
    await expect.poll(() => new URL(page.url()).pathname, `adresse, ${chemin}`).toBe(chemin);
    await expect(page.locator('.sidebar-compte-role'), `menu, ${chemin}`).toHaveText(libelle);
    await expect(page.locator('span', { hasText: 'Connecté en tant que' }).locator('strong'), `« Connecté en tant que », ${chemin}`).toHaveText(libelle);
  }
}

test.describe('Types de compte : une seule liste et un seul libellé (#203)', () => {
  test('un super administrateur voit les onze types, en casse de phrase et dans l’ordre, dans les deux listes, et les retrouve au journal', async ({ connexion, request, session }) => {
    test.slow();
    const headers = { Authorization: `Bearer ${session.token}` };
    const suffixe = `${Date.now()}`;
    const creation = await request.post(`${api}/users`, { headers, data: { email: `types-compte.sa.cible.${suffixe}@iris.test`, name: `Types compte cible SA ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' } });
    expect(creation.status(), await creation.text()).toBe(201);
    const cible = await creation.json() as Compte;
    const lireRole = async (email: string) => {
      const comptes = await (await request.get(`${api}/users`, { headers })).json() as Compte[];
      return comptes.find((compte) => compte.email === email)?.role;
    };

    const page = await connexion('SA');
    await verifierTypeAffiche(page, 'Super administrateur');
    await page.getByRole('button', { name: 'Utilisateurs', exact: true }).click();

    // Formulaire « Autoriser un compte » : les onze types, « Conducteur de travaux » par défaut.
    const formulaire = page.locator('form').filter({ has: page.getByRole('button', { name: 'Autoriser', exact: true }) });
    const typeNouveau = formulaire.locator('select[name="role"]');
    await verifierTypesProposes(typeNouveau, TYPES);
    await expect(typeNouveau).toHaveValue('CONDUCTEUR_TRAVAUX');
    await expect(typeNouveau.locator('option:checked')).toHaveText('Conducteur de travaux');

    // Type d'un compte du tableau : la même liste, dans le même ordre.
    const typeCible = page.locator('tr').filter({ hasText: cible.email }).getByRole('combobox', { name: 'Modifier le rôle' });
    await verifierTypesProposes(typeCible, TYPES);
    await expect(typeCible).toHaveValue('CONDUCTEUR_TRAVAUX');
    await expect(typeCible.locator('option:checked')).toHaveText('Conducteur de travaux');

    // Un compte autorisé avec le type choisi par son libellé : le serveur reçoit la valeur de la même ligne de la table.
    const email = `types-compte.sa.nouveau.${suffixe}@iris.test`;
    await formulaire.locator('input[name="email"]').fill(email);
    await formulaire.locator('input[name="name"]').fill(`Types compte nouveau ${suffixe}`);
    await typeNouveau.selectOption({ label: 'Administrateur' });
    const ajout = page.waitForResponse((r) => r.url().endsWith('/api/users') && r.request().method() === 'POST');
    await formulaire.getByRole('button', { name: 'Autoriser', exact: true }).click();
    const reponseAjout = await ajout;
    expect(reponseAjout.status()).toBe(201);
    expect(reponseAjout.request().postDataJSON()).toMatchObject({ email, role: 'ADMIN' });
    expect(await lireRole(email)).toBe('ADMIN');
    await expect(page.locator('tr').filter({ hasText: email }).getByRole('combobox', { name: 'Modifier le rôle' }).locator('option:checked')).toHaveText('Administrateur');

    // Type d'un compte changé par son libellé dans le tableau : même correspondance, relue par l'API.
    const changement = page.waitForResponse((r) => r.url().endsWith(`/api/users/${cible.id}/role`) && r.request().method() === 'PATCH');
    await typeCible.selectOption({ label: 'Administrateur' });
    const reponseChangement = await changement;
    expect(reponseChangement.status()).toBe(200);
    expect(reponseChangement.request().postDataJSON()).toEqual({ role: 'ADMIN' });
    expect(await lireRole(cible.email)).toBe('ADMIN');
    await expect(typeCible).toHaveValue('ADMIN');

    // Journal d'administration : le type, avant et après, sous le même libellé que dans les listes.
    await page.getByRole('button', { name: 'Journal', exact: true }).click();
    const tableau = page.getByRole('table', { name: 'Entrées du journal' });
    const entree = tableau.locator('tbody tr').filter({ hasText: cible.email }).filter({ hasText: 'Type de compte : Conducteur de travaux' }).filter({ hasText: 'Type de compte : Administrateur' });
    await expect(entree).toHaveCount(1);
    const cellules = entree.locator('td');
    await expect(cellules.nth(3)).toHaveText('Type de compte');
    await expect(cellules.nth(5).locator('li')).toHaveText(['Type de compte : Conducteur de travaux']);
    await expect(cellules.nth(6).locator('li')).toHaveText(['Type de compte : Administrateur']);
  });

  test('un administrateur voit les dix types, sans « Super administrateur », dans les deux listes, et son type affiché en clair', async ({ connexion, request, session }) => {
    const headers = { Authorization: `Bearer ${session.token}` };
    const suffixe = `${Date.now()}`;
    const creer = async (cle: string, role: string) => {
      const reponse = await request.post(`${api}/users`, { headers, data: { email: `types-compte.ad.${cle}.${suffixe}@iris.test`, name: `Types compte ${cle} AD ${suffixe}`, role } });
      expect(reponse.status(), await reponse.text()).toBe(201);
      return reponse.json() as Promise<Compte>;
    };
    const administrateur = await creer('administrateur', 'ADMIN');
    const cible = await creer('cible', 'CONDUCTEUR_TRAVAUX');

    const page = await connexion(administrateur);
    await verifierTypeAffiche(page, 'Administrateur');
    await page.getByRole('button', { name: 'Utilisateurs', exact: true }).click();

    const formulaire = page.locator('form').filter({ has: page.getByRole('button', { name: 'Autoriser', exact: true }) });
    await verifierTypesProposes(formulaire.locator('select[name="role"]'), SANS_SUPERADMIN);
    const typeCible = page.locator('tr').filter({ hasText: cible.email }).getByRole('combobox', { name: 'Modifier le rôle' });
    await verifierTypesProposes(typeCible, SANS_SUPERADMIN);
    await expect(typeCible.locator('option:checked')).toHaveText('Conducteur de travaux');
    // Sa propre ligne : la même liste, sans modification possible, son type lu « Administrateur ».
    const typePropre = page.locator('tr').filter({ hasText: administrateur.email }).locator('select').first();
    await expect(typePropre).toBeDisabled();
    await verifierTypesProposes(typePropre, SANS_SUPERADMIN);
    await expect(typePropre.locator('option:checked')).toHaveText('Administrateur');
    // Nulle part sur l'écran l'option super administrateur, ni par sa valeur, ni par son libellé.
    await expect(page.locator('option[value="SUPERADMIN"]')).toHaveCount(0);
    await expect(page.getByRole('option', { name: 'Super administrateur' })).toHaveCount(0);
  });

  test('un conducteur de travaux lit « Conducteur de travaux » dans le menu et dans « Connecté en tant que »', async ({ connexion, request, session }) => {
    const headers = { Authorization: `Bearer ${session.token}` };
    const suffixe = `${Date.now()}`;
    const reponse = await request.post(`${api}/users`, { headers, data: { email: `types-compte.ct.${suffixe}@iris.test`, name: `Types compte CT ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' } });
    expect(reponse.status(), await reponse.text()).toBe(201);
    const conducteur = await reponse.json() as Compte;
    const page = await connexion(conducteur);
    await verifierTypeAffiche(page, 'Conducteur de travaux');
  });

  // Lot « Directeur aligné sur l'administration » (cadrage version 3) : le directeur a les droits de l'administration
  // (décision de Nelson du 24-10-2026, point 14), hors réglages du super administrateur ; son type garde son libellé
  // « Directeur » ; « aussi commercial » reste réservé aux types Administrateur et Super administrateur (décision 7 de
  // #182). Il ouvre les quatre pages qui affichent son type (statistiques et administration comprises, qui le
  // redirigeaient jusqu'ici). Il n'attribue pas le type Administrateur, qui lèverait sa restriction de rentabilité
  // (choix par défaut, à confirmer, règle 5, option la plus restrictive ; miroir de refuseTypeAdminParDirecteur côté
  // serveur) : neuf types (huit avant le lot AT-1, qui ajoute l'assistante technique) à la création et sur la ligne d'un compte d'un autre type ; la ligne d'un compte déjà
  // administrateur garde l'option « Administrateur », pour l'afficher. La case « aussi commercial » ne lui est jamais
  // proposée pour un compte directeur, ni à la création, ni dans le tableau.
  // Lectures écartées : « Administrateur » retiré de toutes les lignes (la ligne administrateur l'afficherait mal) ; laissé
  // dans la création ou sur la ligne d'un autre type.
  test('un directeur voit neuf types, sans « Super administrateur » ni « Administrateur », sauf sur la ligne d’un administrateur, qui l’affiche ; son type affiché « Directeur » ; la case « aussi commercial » n’existe pas pour un compte directeur', async ({ connexion, request, session }) => {
    test.slow();
    const headers = { Authorization: `Bearer ${session.token}` };
    const suffixe = `${Date.now()}`;
    const creer = async (cle: string, role: string) => {
      const reponse = await request.post(`${api}/users`, { headers, data: { email: `types-compte.dir.${cle}.${suffixe}@iris.test`, name: `Types compte ${cle} DIR ${suffixe}`, role } });
      expect(reponse.status(), await reponse.text()).toBe(201);
      return reponse.json() as Promise<Compte>;
    };
    const SANS_ADMINISTRATION = SANS_SUPERADMIN.filter(([valeur]) => valeur !== 'ADMIN');
    expect(SANS_ADMINISTRATION).toHaveLength(9);
    const directeur = await creer('directeur', 'DIRECTEUR');
    const autreDirecteur = await creer('autre-directeur', 'DIRECTEUR');
    const administrateur = await creer('administrateur', 'ADMIN');
    const cible = await creer('cible', 'CONDUCTEUR_TRAVAUX');

    const page = await connexion(directeur);
    await verifierTypeAffiche(page, 'Directeur');
    await page.getByRole('button', { name: 'Utilisateurs', exact: true }).click();
    const formulaire = page.locator('form').filter({ has: page.getByRole('button', { name: 'Autoriser', exact: true }) });
    const typeNouveau = formulaire.locator('select[name="role"]');
    // Création : neuf types, sans « Administrateur ».
    await verifierTypesProposes(typeNouveau, SANS_ADMINISTRATION);
    await expect(typeNouveau.locator('option[value="ADMIN"]')).toHaveCount(0);
    // Ligne d'un conducteur et d'un autre directeur : les mêmes neuf types, son type lu.
    const ligne = (compte: Compte) => page.locator('tr').filter({ hasText: compte.email }).getByRole('combobox', { name: 'Modifier le rôle' });
    for (const [compte, libelle] of [[cible, 'Conducteur de travaux'], [autreDirecteur, 'Directeur']] as const) {
      await verifierTypesProposes(ligne(compte), SANS_ADMINISTRATION);
      await expect(ligne(compte).locator('option:checked'), compte.email).toHaveText(libelle);
    }
    // Ligne d'un administrateur : l'option « Administrateur » reste, pour afficher son type.
    await verifierTypesProposes(ligne(administrateur), SANS_SUPERADMIN);
    await expect(ligne(administrateur).locator('option:checked')).toHaveText('Administrateur');
    await expect(page.locator('option[value="SUPERADMIN"]')).toHaveCount(0);
    // Sa propre ligne : son type lu « Directeur », sans modification possible.
    const typePropre = page.locator('tr').filter({ hasText: directeur.email }).locator('select').first();
    await expect(typePropre).toBeDisabled();
    await expect(typePropre.locator('option:checked')).toHaveText('Directeur');

    // « Aussi commercial » à la création : aucun des neuf types proposés au directeur ne l'ouvre, le type Directeur compris.
    const caseCreation = formulaire.getByRole('checkbox', { name: /^Commercial \(affectation aux chantiers/ });
    for (const [, libelle] of SANS_ADMINISTRATION) {
      await typeNouveau.selectOption({ label: libelle });
      await expect(caseCreation, libelle).toHaveCount(0);
    }
    // Un compte directeur autorisé par le directeur : créé sans la marque, relu par l'API.
    await typeNouveau.selectOption({ label: 'Directeur' });
    const email = `types-compte.dir.cree.${suffixe}@iris.test`;
    await formulaire.locator('input[name="email"]').fill(email);
    await formulaire.locator('input[name="name"]').fill(`Types compte directeur créé ${suffixe}`);
    const ajout = page.waitForResponse((r) => r.url().endsWith('/api/users') && r.request().method() === 'POST');
    await formulaire.getByRole('button', { name: 'Autoriser', exact: true }).click();
    const reponseAjout = await ajout;
    expect(reponseAjout.status()).toBe(201);
    expect(reponseAjout.request().postDataJSON()).toMatchObject({ email, role: 'DIRECTEUR' });
    const comptes = await (await request.get(`${api}/users`, { headers })).json() as Array<Compte & { estCommercial: boolean }>;
    expect(comptes.find((compte) => compte.email === email)).toMatchObject({ role: 'DIRECTEUR', estCommercial: false });

    // Dans le tableau : la case existe pour l'administrateur (témoin), pas pour un directeur.
    await expect(page.getByRole('checkbox', { name: `Commercial — ${administrateur.name}` })).toHaveCount(1);
    for (const compte of [directeur, autreDirecteur]) {
      await expect(page.getByRole('checkbox', { name: `Commercial — ${compte.name}` }), compte.email).toHaveCount(0);
    }

    // Témoin de la création, chez l'administrateur : « Administrateur » proposé, et la case « aussi commercial » s'ouvre.
    const pageAdmin = await connexion(administrateur);
    await pageAdmin.goto('/admin', { waitUntil: 'networkidle' });
    await pageAdmin.getByRole('button', { name: 'Utilisateurs', exact: true }).click();
    const formulaireAdmin = pageAdmin.locator('form').filter({ has: pageAdmin.getByRole('button', { name: 'Autoriser', exact: true }) });
    await verifierTypesProposes(formulaireAdmin.locator('select[name="role"]'), SANS_SUPERADMIN);
    await formulaireAdmin.locator('select[name="role"]').selectOption({ label: 'Administrateur' });
    await expect(formulaireAdmin.getByRole('checkbox', { name: /^Commercial \(affectation aux chantiers/ })).toHaveCount(1);
  });
});
