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
  test('un super administrateur voit les dix types, en casse de phrase et dans l’ordre, dans les deux listes, et les retrouve au journal', async ({ connexion, request, session }) => {
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

    // Formulaire « Autoriser un compte » : les dix types, « Conducteur de travaux » par défaut.
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

  test('un administrateur voit les neuf types, sans « Super administrateur », dans les deux listes, et son type affiché en clair', async ({ connexion, request, session }) => {
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
});
