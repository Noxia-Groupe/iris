import { createHmac } from 'node:crypto';
import type { APIRequestContext, Browser, Locator, Page } from '@playwright/test';
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

// Décisions de Nelson (13-10-2026) : le technicien consulte l'affaire dont il est chargé avec ses
// heures, sans aucun montant (budgets, coûts, taux) ni alerte de dépassement, et sans pouvoir la
// modifier ni la clôturer. Son responsable hiérarchique (N+1) la clôture.
test('un technicien consulte son chantier sans montant ni alerte de dépassement, et son N+1 le clôture', async ({ creerClient, request, session, browser }) => {
  test.slow();
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'patch' | 'put', path: string, data: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = Date.now();
  const creerCompte = async (cle: string, nom: string, role: string): Promise<Compte> =>
    envoyer('post', '/users', { email: `budgets.${cle}.${suffixe}@iris.test`, name: `${nom} ${suffixe}`, role });
  const technicien = await creerCompte('technicien', 'Technicien budgets', 'TECHNICIEN');
  const responsable = await creerCompte('responsable', 'Responsable du technicien', 'RESPONSABLE');
  await envoyer('patch', `/users/${technicien.id}/responsable-hierarchique`, { responsableHierarchiqueId: responsable.id });

  // 100 € de fourniture et 2 h de pose à 50 € ; 250 € d'achats et 3 h pointées : matériel et
  // heures dépassés.
  const client = await creerClient('budgets-technicien', false);
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Budgets technicien E2E ${suffixe}`, lignes: [
    { designation: 'Caméra', nature: 'FOURNITURE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 },
    { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: 50, tauxTva: 20 },
  ] });
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string; nom: string };
  const contextes: { close: () => Promise<void> }[] = [];
  try {
    await envoyer('patch', `/chantiers/${chantier.id}`, { responsableId: technicien.id });
    const categorie = await envoyer('post', '/categories', { nom: `Budgets technicien E2E ${suffixe} catégorie` });
    const fournisseur = await envoyer('post', '/fournisseurs', { nom: `Budgets technicien E2E ${suffixe} fournisseur` });
    await envoyer('post', '/achats', { chantierId: chantier.id, categorieId: categorie.id, fournisseurId: fournisseur.id, date: dateDuJour(), description: 'Matériel complémentaire', montantHT: 250 });
    const intervenant = await envoyer('post', '/intervenants', { nom: `Budgets technicien E2E ${suffixe} intervenant`, role: 'TECHNICIEN', tauxHoraireCharge: 47 });
    await envoyer('post', '/heures', { chantierId: chantier.id, intervenantId: intervenant.id, date: dateDuJour(), nbrHeures: 3 });

    const vueTechnicien = await pageDe(browser, technicien);
    contextes.push(vueTechnicien.context());

    // Liste : ni colonne Matériel, ni pastille de dépassement, ni bouton Clôturer ; les heures restent.
    await vueTechnicien.goto('/chantiers', { waitUntil: 'networkidle' });
    const ligne = vueTechnicien.locator(`tr[data-chantier="${chantier.id}"]`);
    await expect(ligne).toContainText('3 h');
    await expect(ligne).toContainText('/ 2 h');
    await expect(ligne).not.toContainText('€');
    await expect(vueTechnicien.getByRole('columnheader', { name: 'Matériel' })).toHaveCount(0);
    await expect(ligne.locator('[data-alerte]')).toHaveCount(0);
    await expect(ligne.getByRole('button', { name: 'Clôturer' })).toHaveCount(0);
    const FILTRES_DE_DEPASSEMENT = ['Heures dépassées', 'Main-d’œuvre dépassée', 'Matériel dépassé'];
    for (const filtre of FILTRES_DE_DEPASSEMENT) {
      await expect(vueTechnicien.getByRole('button', { name: filtre, exact: true })).toHaveCount(0);
    }

    // Fiche : avertissement de consultation seule ; aucune section de montant, aucun euro.
    await vueTechnicien.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
    await expect(vueTechnicien.locator('[data-consultation-seule]')).toContainText('n’est pas autorisé à modifier une affaire');
    await expect(vueTechnicien.getByText('/ 2 h')).toBeVisible();
    const SECTIONS_DE_MONTANTS = ['Matériel Prévu', 'Coût MO Prévu', 'Consommation Matériel', 'Coût Main d\'Œuvre', 'Achats par catégorie', 'Achats du chantier'];
    for (const section of SECTIONS_DE_MONTANTS) {
      await expect(vueTechnicien.getByText(section, { exact: true })).toHaveCount(0);
    }
    await expect(vueTechnicien.locator('[data-alertes-fiche] [data-alerte]')).toHaveCount(0);
    await expect(vueTechnicien.getByRole('button', { name: 'Modifier', exact: true })).toHaveCount(0);
    await expect(vueTechnicien.locator('main')).not.toContainText('€');

    // Le N+1 voit le bouton Clôturer sur l'affaire de son technicien et la clôture.
    const vueResponsable = await pageDe(browser, responsable);
    contextes.push(vueResponsable.context());
    // Témoin : les mêmes sections existent bien pour le N+1, qui voit les montants.
    await vueResponsable.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
    for (const section of SECTIONS_DE_MONTANTS) {
      await expect(vueResponsable.getByText(section, { exact: true }).first()).toBeVisible();
    }
    await expect(vueResponsable.locator('[data-consultation-seule]')).toHaveCount(0);
    await vueResponsable.goto('/chantiers', { waitUntil: 'networkidle' });
    // Témoin : le N+1 dispose bien des filtres de dépassement.
    for (const filtre of FILTRES_DE_DEPASSEMENT) {
      await expect(vueResponsable.getByRole('button', { name: filtre, exact: true })).toBeVisible();
    }
    const ligneResponsable = vueResponsable.locator(`tr[data-chantier="${chantier.id}"]`);
    await expect(ligneResponsable.locator('[data-alerte="MATERIEL_DEPASSE"]')).toHaveText(/Matériel \+150\s?€/);
    vueResponsable.once('dialog', (dialog) => void dialog.accept());
    const cloture = vueResponsable.waitForResponse((r) => r.url().endsWith(`/api/chantiers/${chantier.id}/statut`) && r.request().method() === 'PATCH');
    await ligneResponsable.getByRole('button', { name: 'Clôturer' }).click();
    expect((await cloture).status()).toBe(200);
    const relu = await (await request.get(`${api}/chantiers/${chantier.id}`, { headers })).json() as { statut: string; budgetMaterielVendu: number };
    expect([relu.statut, relu.budgetMaterielVendu]).toEqual(['TERMINE', 100]);
  } finally {
    // Chantier clôturé : la base partagée reste lisible pour la suite.
    await request.patch(`${api}/chantiers/${chantier.id}/statut`, { headers, data: { statut: 'TERMINE' } }).catch(() => undefined);
    for (const contexte of contextes) await contexte.close().catch(() => undefined);
  }
});

// Comptes créés sous un autre type avec des droits individuels, puis passés technicien ; ils
// sont supprimés en fin de test pour ne pas grossir la base conservée.
function outilsComptes(request: APIRequestContext, token: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const crees: string[] = [];
  const envoyer = async (methode: 'post' | 'patch' | 'put', path: string, data: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const creer = async (cle: string, role: string, accesFinance = false): Promise<Compte> => {
    const compte: Compte = await envoyer('post', '/users', { email: `budgets.${cle}.${Date.now()}@iris.test`, name: `Compte ${cle} ${Date.now()}`, role, accesFinance });
    crees.push(compte.id);
    return compte;
  };
  const reconverti = async (cle: string, permissions: string[], accesFinance = false) => {
    const compte = await creer(cle, 'CONDUCTEUR_TRAVAUX', accesFinance);
    await envoyer('put', `/users/${compte.id}/permissions`, { permissions });
    await envoyer('patch', `/users/${compte.id}/role`, { role: 'TECHNICIEN' });
    return compte;
  };
  const conducteur = async (cle: string, permissions: string[]) => {
    const compte = await creer(cle, 'CONDUCTEUR_TRAVAUX');
    if (permissions.length) await envoyer('put', `/users/${compte.id}/permissions`, { permissions });
    return compte;
  };
  const nettoyer = async () => {
    for (const id of crees) {
      const reponse = await request.delete(`${api}/users/${id}`, { headers }).catch(() => null);
      if (!reponse?.ok()) console.warn(`Compte de test ${id} non supprimé : ${reponse ? `${reponse.status()} ${await reponse.text()}` : 'requête impossible'}`);
    }
  };
  return { creer, reconverti, conducteur, nettoyer };
}

// Cellules d'un compte dans Administration > Utilisateurs, repérées par l'en-tête de colonne.
async function ligneUtilisateur(page: Page, compte: Compte) {
  const ligne = page.locator('tbody tr').filter({ hasText: compte.email });
  await expect(ligne).toBeVisible();
  const entetes = (await page.locator('table').filter({ has: ligne }).locator('thead th').allTextContents()).map((texte) => texte.trim());
  return (colonne: string) => {
    expect(entetes, colonne).toContain(colonne);
    return ligne.locator('td').nth(entetes.indexOf(colonne));
  };
}

const INFOBULLE_SANS_EFFET = /sans effet pour un compte technicien ; il reprend effet si le compte change de type\./;
const INFOBULLE_RETRAIT = 'Décocher pour le retirer.';
const INFOBULLE_INTERDIT = 'Ce droit ne s’accorde pas à un compte technicien.';

// Clic sur une case pilotée par le serveur (elle ne change qu'au rechargement qui suit la
// réponse) ; renvoie la liste de permissions envoyée.
async function basculerPermissions(page: Page, compte: Compte, td: Locator) {
  const retrait = page.waitForResponse((r) => r.url().endsWith(`/api/users/${compte.id}/permissions`) && r.request().method() === 'PUT');
  await td.getByRole('checkbox').click();
  const reponse = await retrait;
  expect(reponse.status()).toBe(200);
  return reponse.request().postDataJSON();
}

// Un compte devenu technicien garde ses droits individuels enregistrés, sans effet : l'écran
// Utilisateurs les signale, et un super administrateur peut seulement les retirer.
test('Administration > Utilisateurs : les droits d’un compte devenu technicien sont signalés sans effet et se retirent', async ({ allerSurPageAdmin, request, session }) => {
  const comptes = outilsComptes(request, session.token);
  try {
    const compte = await comptes.reconverti('reconverti', ['devis:read', 'devis:write', 'clients:read', 'chantiers:write'], true);
    const admin = await allerSurPageAdmin('/admin');
    await admin.getByRole('button', { name: 'Utilisateurs', exact: true }).click();
    const cellule = await ligneUtilisateur(admin, compte);
    const finance = cellule('Finance');
    const devis = cellule('Droit devis');
    const correction = cellule('Corriger Travaux');
    const archivage = cellule('Archiver Travaux');

    // Enregistrés : cochés, signalés « Sans effet », et seulement décochables.
    for (const [nom, td] of [['finance', finance], ['devis', devis], ['correction', correction]] as const) {
      await expect(td.getByRole('checkbox'), nom).toBeChecked();
      await expect(td.getByRole('checkbox'), nom).toBeEnabled();
      await expect(td, nom).toContainText('Sans effet');
      await expect(td.getByRole('checkbox'), nom).toHaveAttribute('title', INFOBULLE_SANS_EFFET);
      await expect(td.getByRole('checkbox'), nom).toHaveAttribute('title', /Décocher pour le retirer\./);
    }
    // Jamais enregistré : ni cochable, ni signalé.
    await expect(archivage.getByRole('checkbox')).not.toBeChecked();
    await expect(archivage.getByRole('checkbox')).toBeDisabled();
    await expect(archivage.getByRole('checkbox')).toHaveAttribute('title', INFOBULLE_INTERDIT);
    await expect(archivage).not.toContainText('Sans effet');

    // Décocher le droit devis retire ses seuls droits interdits : l'annuaire (clients:read), permis
    // au technicien, est conservé ; le droit Travaux enregistré demeure, sans effet.
    expect(await basculerPermissions(admin, compte, devis)).toEqual({ permissions: ['clients:read', 'chantiers:write'] });
    await expect(devis.getByRole('checkbox')).not.toBeChecked();
    await expect(devis.getByRole('checkbox')).toBeDisabled();
    await expect(devis).toContainText('Droit devis');
    await expect(correction.getByRole('checkbox')).toBeChecked();
    await expect(correction).toContainText('Sans effet');

    // L'accès financier se retire de même.
    const retraitFinance = admin.waitForResponse((r) => r.url().endsWith(`/api/users/${compte.id}/acces-finance`) && r.request().method() === 'PATCH');
    await finance.getByRole('checkbox').click();
    expect((await retraitFinance).status()).toBe(200);
    await expect(finance.getByRole('checkbox')).not.toBeChecked();
    await expect(finance.getByRole('checkbox')).toBeDisabled();
    await expect(finance).toContainText('Non');
  } finally {
    await comptes.nettoyer();
  }
});

// Cas particuliers : un seul droit enregistré (le retrait n'envoie que ce qui est enregistré),
// un droit permis au technicien (clients:read, jamais signalé), et la vue d'un administrateur
// qui n'est pas super administrateur (il voit les droits sans pouvoir les retirer).
test('Administration > Utilisateurs : droit seul enregistré, droit permis, et vue d’un administrateur simple', async ({ allerSurPageAdmin, request, session, browser }) => {
  test.slow();
  const comptes = outilsComptes(request, session.token);
  const contextes: { close: () => Promise<void> }[] = [];
  try {
    const devisSeul = await comptes.reconverti('devis-seul', ['devis:read']);
    const archivageSeul = await comptes.reconverti('archivage-seul', ['chantiers:archive']);
    const clientsSeul = await comptes.reconverti('clients-seul', ['clients:read']);
    const vuParAdmin = await comptes.reconverti('vu-par-admin', ['devis:read', 'chantiers:write'], true);
    const adminSimple = await comptes.creer('admin-simple', 'ADMIN');
    // Témoins hors technicien : rien n'y est « Sans effet », et le droit devis s'accorde.
    const conducteurDevis = await comptes.conducteur('conducteur-devis', ['devis:read', 'devis:write', 'clients:read']);
    const conducteurSans = await comptes.conducteur('conducteur-sans', []);

    const superAdmin = await allerSurPageAdmin('/admin');
    await superAdmin.getByRole('button', { name: 'Utilisateurs', exact: true }).click();

    const devis = (await ligneUtilisateur(superAdmin, devisSeul))('Droit devis');
    await expect(devis.getByRole('checkbox')).toBeChecked();
    await expect(devis.getByRole('checkbox')).toBeEnabled();
    await expect(devis).toContainText('Sans effet');
    expect(await basculerPermissions(superAdmin, devisSeul, devis)).toEqual({ permissions: [] });
    await expect(devis.getByRole('checkbox')).not.toBeChecked();
    await expect(devis.getByRole('checkbox')).toBeDisabled();

    const archivage = (await ligneUtilisateur(superAdmin, archivageSeul))('Archiver Travaux');
    await expect(archivage.getByRole('checkbox')).toBeChecked();
    await expect(archivage.getByRole('checkbox')).toBeEnabled();
    await expect(archivage).toContainText('Sans effet');
    expect(await basculerPermissions(superAdmin, archivageSeul, archivage)).toEqual({ permissions: [] });
    await expect(archivage.getByRole('checkbox')).not.toBeChecked();
    await expect(archivage.getByRole('checkbox')).toBeDisabled();
    await expect(archivage).not.toContainText('Sans effet');
    await expect((await ligneUtilisateur(superAdmin, archivageSeul))('Corriger Travaux')).not.toContainText('Sans effet');

    const devisClients = (await ligneUtilisateur(superAdmin, clientsSeul))('Droit devis');
    await expect(devisClients.getByRole('checkbox')).not.toBeChecked();
    await expect(devisClients.getByRole('checkbox')).toBeDisabled();
    await expect(devisClients.getByRole('checkbox')).toHaveAttribute('title', INFOBULLE_INTERDIT);
    await expect(devisClients).not.toContainText('Sans effet');

    const devisConducteur = (await ligneUtilisateur(superAdmin, conducteurDevis))('Droit devis');
    await expect(devisConducteur.getByRole('checkbox')).toBeChecked();
    await expect(devisConducteur.getByRole('checkbox')).toBeEnabled();
    await expect(devisConducteur).toContainText('Droit devis');
    await expect(devisConducteur).not.toContainText('Sans effet');
    const devisSans = (await ligneUtilisateur(superAdmin, conducteurSans))('Droit devis');
    await expect(devisSans.getByRole('checkbox')).not.toBeChecked();
    await expect(devisSans.getByRole('checkbox')).toBeEnabled();
    expect(await basculerPermissions(superAdmin, conducteurSans, devisSans)).toEqual({ permissions: ['devis:read', 'devis:write', 'clients:read'] });
    await expect(devisSans.getByRole('checkbox')).toBeChecked();

    // Un administrateur simple voit les droits enregistrés sans pouvoir les retirer.
    const vueAdmin = await pageDe(browser, adminSimple);
    contextes.push(vueAdmin.context());
    await vueAdmin.goto('/admin', { waitUntil: 'networkidle' });
    await vueAdmin.getByRole('button', { name: 'Utilisateurs', exact: true }).click();
    const cellule = await ligneUtilisateur(vueAdmin, vuParAdmin);
    for (const [nom, td] of [['finance', cellule('Finance')], ['devis', cellule('Droit devis')], ['correction', cellule('Corriger Travaux')]] as const) {
      await expect(td.getByRole('checkbox'), nom).toBeChecked();
      await expect(td.getByRole('checkbox'), nom).toBeDisabled();
      await expect(td, nom).toContainText('Sans effet');
      await expect(td.getByRole('checkbox'), nom).toHaveAttribute('title', INFOBULLE_SANS_EFFET);
      expect(await td.getByRole('checkbox').getAttribute('title'), nom).not.toContain(INFOBULLE_RETRAIT);
    }
  } finally {
    for (const contexte of contextes) await contexte.close().catch(() => undefined);
    await comptes.nettoyer();
  }
});
