import { createHmac } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable
// ouvre une session dans un autre rôle que celui de l'accès de secours.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

// Message de la prochaine alerte de la page, acceptée aussitôt. L'attente est bornée : sans alerte,
// le test échoue ici plutôt qu'à l'expiration de son délai.
const prochaineAlerte = async (page: Page) => {
  const alerte = await page.waitForEvent('dialog', { timeout: 15_000 });
  const message = alerte.message();
  await alerte.accept();
  return message;
};

// L'écran Utilisateurs ne construit les listes de responsables qu'à la demande : au plus celle qui
// a le focus et la dernière touchée. Proposer tous les comptes sur chaque ligne faisait croître la
// page comme le carré du nombre de comptes. Fermée, une liste ne porte que « Aucun » et le
// responsable actuel.
test('Administration > Utilisateurs : listes de responsables construites à la demande', async ({ allerSurPageAdmin, request, session }) => {
  test.slow();
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'patch', path: string, data: object) => {
    const reponse = await request[methode](`${api}${path}`, { headers, data });
    expect(reponse.ok(), `${path} : ${await reponse.text()}`).toBeTruthy();
    return reponse.json();
  };
  const suffixe = Date.now();
  const creerCompte = (cle: string) => envoyer('post', '/users', { email: `utilisateurs.${cle}.${suffixe}@iris.test`, name: `Compte liste ${cle} ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' }) as Promise<{ id: string; name: string; email: string }>;
  const rattacher = (compte: { id: string }, responsable: { id: string } | null) =>
    envoyer('patch', `/users/${compte.id}/responsable-hierarchique`, { responsableHierarchiqueId: responsable?.id ?? null });
  // premier relève de second ; troisième relève d'un ancien responsable, désactivé depuis.
  const premier = await creerCompte('premier');
  const second = await creerCompte('second');
  const ancien = await creerCompte('ancien');
  const troisieme = await creerCompte('troisieme');
  const clavier = await creerCompte('clavier');
  await rattacher(premier, second);
  await rattacher(troisieme, ancien);
  await envoyer('patch', `/users/${ancien.id}/actif`, { actif: false });

  try {
    const admin = await allerSurPageAdmin('/admin');
    await admin.getByRole('button', { name: 'Utilisateurs', exact: true }).click();
    const listes = admin.locator('select[aria-label^="Responsable hiérarchique de"]');
    const liste = (compte: { name: string }) => admin.getByRole('combobox', { name: `Responsable hiérarchique de ${compte.name}` });
    const listesConstruites = () => listes.evaluateAll((selects) => selects.filter((s) => (s as HTMLSelectElement).options.length > 2).length);
    await expect(liste(premier)).toBeVisible();

    // Fermées : au plus deux options par liste, et le responsable actuel bien affiché.
    expect(await listesConstruites()).toBe(0);
    await expect(liste(premier)).toHaveValue(second.id);
    await expect(liste(premier).locator('option:checked')).toHaveText(second.name);
    await expect(liste(troisieme).locator('option:checked')).toHaveText(`${ancien.name} (compte désactivé)`);

    // Ouverte au clavier (focus) : les comptes actifs hors de la branche, sans le compte lui-même.
    await liste(second).focus();
    await expect(liste(second).locator('option', { hasText: troisieme.name })).toHaveCount(1);
    await expect(liste(second).locator('option', { hasText: premier.name })).toHaveCount(0);
    await expect(liste(second).locator('option', { hasText: second.name })).toHaveCount(0);
    await expect(liste(second).locator('option', { hasText: ancien.name })).toHaveCount(0);
    // Ouverte, la liste d'un compte rattaché à un responsable désactivé garde sa mention.
    await liste(troisieme).focus();
    await expect(liste(troisieme).locator('option:checked')).toHaveText(`${ancien.name} (compte désactivé)`);

    // Ouverte au clic, puis refermée : elle revient à son choix actuel.
    await liste(premier).click();
    await expect(liste(premier).locator('option', { hasText: troisieme.name })).toHaveCount(1);
    await admin.keyboard.press('Escape');
    await liste(premier).blur();
    await expect(liste(premier).locator('option')).toHaveCount(2);
    await expect(liste(premier)).toHaveValue(second.id);

    // Toucher des listes sans leur donner le focus (défilement tactile, aide technique) : seule la
    // dernière touchée reste construite, et un défilement ou une annulation tactile commencés sur
    // elle la referment.
    await admin.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // Les événements tactiles « continus » (touchmove) sont rendus par une tâche planifiée, pas
    // dans la foulée : le nombre de listes construites est relu (expect.poll) jusqu'à la valeur
    // attendue.
    for (const compte of [premier, second, ancien, clavier, troisieme]) await liste(compte).dispatchEvent('touchstart');
    await expect.poll(listesConstruites).toBe(1);
    await expect(liste(troisieme).locator('option', { hasText: clavier.name })).toHaveCount(1);
    await liste(troisieme).dispatchEvent('touchmove');
    await expect.poll(listesConstruites).toBe(0);
    await liste(troisieme).dispatchEvent('touchstart');
    await expect.poll(listesConstruites).toBe(1);
    await liste(troisieme).dispatchEvent('touchcancel');
    await expect.poll(listesConstruites).toBe(0);
    // Une liste qui a le focus n'est jamais refermée par une autre que l'on touche, ni par un
    // défilement ou une annulation tactile commencés sur elle.
    await liste(premier).focus();
    await liste(second).dispatchEvent('touchstart');
    await expect(liste(premier).locator('option', { hasText: troisieme.name })).toHaveCount(1);
    await expect.poll(listesConstruites).toBe(2);
    await liste(premier).dispatchEvent('touchmove');
    await liste(premier).dispatchEvent('touchcancel');
    // Témoin rendu après eux : la liste touchée sans focus, elle, se referme.
    await liste(second).dispatchEvent('touchmove');
    await expect.poll(listesConstruites).toBe(1);
    await expect(liste(premier).locator('option', { hasText: troisieme.name })).toHaveCount(1);
    await liste(premier).blur();

    // Parcours clavier : Tab depuis le type de compte, puis Flèche bas, rattache au premier proposé.
    const ligneClavier = admin.locator('tr').filter({ hasText: clavier.email });
    await ligneClavier.locator('select').first().focus();
    await admin.keyboard.press('Tab');
    await expect(liste(clavier)).toBeFocused();
    const premierPropose = await liste(clavier).evaluate((s) => (s as HTMLSelectElement).options[1]?.value);
    expect(premierPropose, 'la liste est construite dès le focus clavier').toBeTruthy();
    const rattachement = admin.waitForResponse((r) => r.url().endsWith(`/api/users/${clavier.id}/responsable-hierarchique`) && r.request().method() === 'PATCH');
    await admin.keyboard.press('ArrowDown');
    const reponse = await rattachement;
    expect(reponse.status()).toBe(200);
    expect(reponse.request().postDataJSON()).toEqual({ responsableHierarchiqueId: premierPropose });
  } finally {
    await request.patch(`${api}/users/${clavier.id}/responsable-hierarchique`, { headers, data: { responsableHierarchiqueId: null } }).catch(() => undefined);
  }
});

// #220 : un refus du serveur sur le type de compte ou la case « Commercial » est affiché, au lieu
// d'un simple rechargement de la liste qui ramenait la valeur sans explication. Les deux refus
// viennent d'une liste chargée avant une modification faite ailleurs.
test('Administration > Utilisateurs : un refus du type de compte ou de la case Commercial est affiché', async ({ allerSurPageAdmin, request, session, browser }) => {
  test.slow();
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'patch', path: string, data: object) => {
    const reponse = await request[methode](`${api}${path}`, { headers, data });
    expect(reponse.ok(), `${path} : ${await reponse.text()}`).toBeTruthy();
    return reponse.json();
  };
  const lire = async (id: string) => {
    const comptes = await (await request.get(`${api}/users`, { headers })).json() as { id: string; role: string; estCommercial: boolean }[];
    return comptes.find((compte) => compte.id === id);
  };
  const suffixe = Date.now();
  type Compte = { id: string; name: string; email: string; role: string };
  const creerCompte = (cle: string, role: string) => envoyer('post', '/users', { email: `refus.${cle}.${suffixe}@iris.test`, name: `Compte refus ${cle} ${suffixe}`, role }) as Promise<Compte>;

  // Un administrateur (non super administrateur) change le type d'un compte devenu super
  // administrateur depuis le chargement de sa liste : refus 403, affiché ; la liste rechargée ne
  // montre plus ce compte, qui n'existe pas pour lui, et son type reste inchangé.
  const administrateur = await creerCompte('administrateur', 'ADMIN');
  const promu = await creerCompte('promu', 'CONDUCTEUR_TRAVAUX');
  const contexte = await browser.newContext();
  try {
    const vueAdministrateur = await contexte.newPage();
    await vueAdministrateur.addInitScript(([token, user]) => {
      localStorage.setItem('token', token as string);
      localStorage.setItem('user', user as string);
    }, [jetonPour(administrateur.id), JSON.stringify({ ...administrateur, permissions: [] })]);
    await vueAdministrateur.goto('/admin', { waitUntil: 'networkidle' });
    await vueAdministrateur.getByRole('button', { name: 'Utilisateurs', exact: true }).click();
    const lignePromu = vueAdministrateur.locator('tr').filter({ hasText: promu.email });
    await expect(lignePromu.locator('select').first()).toHaveValue('CONDUCTEUR_TRAVAUX');
    await envoyer('patch', `/users/${promu.id}/role`, { role: 'SUPERADMIN' });

    const alerte = prochaineAlerte(vueAdministrateur);
    const refus = vueAdministrateur.waitForResponse((r) => r.url().endsWith(`/api/users/${promu.id}/role`) && r.request().method() === 'PATCH');
    await lignePromu.locator('select').first().selectOption('COMMERCIAL');
    expect((await refus).status()).toBe(403);
    expect(await alerte).toBe('Seul un super administrateur peut gérer un compte super administrateur.');
    await expect(lignePromu).toHaveCount(0);
    expect((await lire(promu.id))?.role).toBe('SUPERADMIN');
  } finally {
    await contexte.close();
    // La base E2E est conservée entre deux passages : le compte promu n'y reste pas super administrateur.
    await request.patch(`${api}/users/${promu.id}/role`, { headers, data: { role: 'CONDUCTEUR_TRAVAUX' } }).catch(() => undefined);
  }

  // L'accès de secours coche « Commercial » pour un administrateur passé conducteur depuis le
  // chargement de la liste : refus 400, affiché ; la liste rechargée montre le nouveau type, sans case.
  const ancienAdministrateur = await creerCompte('ancien-administrateur', 'ADMIN');
  const admin = await allerSurPageAdmin('/admin');
  await admin.getByRole('button', { name: 'Utilisateurs', exact: true }).click();
  const ligne = admin.locator('tr').filter({ hasText: ancienAdministrateur.email });
  // Colonnes : nom, email, type, responsable, puis « Commercial ».
  const celluleCommercial = ligne.locator('td').nth(4);
  const caseCommercial = celluleCommercial.getByRole('checkbox');
  await expect(ligne.locator('select').first()).toHaveValue('ADMIN');
  await expect(caseCommercial).not.toBeChecked();
  await envoyer('patch', `/users/${ancienAdministrateur.id}/role`, { role: 'CONDUCTEUR_TRAVAUX' });

  const alerte = prochaineAlerte(admin);
  const refus = admin.waitForResponse((r) => r.url().endsWith(`/api/users/${ancienAdministrateur.id}/est-commercial`) && r.request().method() === 'PATCH');
  await caseCommercial.click();
  expect((await refus).status()).toBe(400);
  expect(await alerte).toBe('Seul un compte Administrateur peut être marqué "aussi commercial".');
  await expect(ligne.locator('select').first()).toHaveValue('CONDUCTEUR_TRAVAUX');
  await expect(caseCommercial).toHaveCount(0);
  await expect(celluleCommercial).toHaveText('—');
  expect((await lire(ancienAdministrateur.id))?.estCommercial).toBe(false);
});
