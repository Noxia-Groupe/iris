import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// L'écran Utilisateurs ne construit qu'une liste de responsables à la fois, celle que l'on ouvre.
// Proposer tous les comptes sur chaque ligne faisait croître la page comme le carré du nombre de
// comptes. Fermée, une liste ne porte que « Aucun » et le responsable actuel.
test('Administration > Utilisateurs : une seule liste de responsables construite à la fois', async ({ allerSurPageAdmin, request, session }) => {
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
    await expect(liste(premier)).toBeVisible();

    // Fermées : au plus deux options par liste, et le responsable actuel bien affiché.
    expect(await listes.evaluateAll((selects) => selects.filter((s) => (s as HTMLSelectElement).options.length > 2).length)).toBe(0);
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

    // Parcours clavier : Tab depuis le type de compte, puis Flèche bas, rattache au premier proposé.
    const ligneClavier = admin.locator('tr').filter({ hasText: clavier.email });
    await ligneClavier.locator('select').first().focus();
    await admin.keyboard.press('Tab');
    await expect(liste(clavier)).toBeFocused();
    const premierPropose = await liste(clavier).evaluate((s) => (s as HTMLSelectElement).options[1]?.value);
    expect(premierPropose, 'la liste est construite dès le focus clavier').toBeTruthy();
    const rattachement = admin.waitForRequest((r) => r.url().endsWith(`/api/users/${clavier.id}/responsable-hierarchique`) && r.method() === 'PATCH');
    await admin.keyboard.press('ArrowDown');
    expect((await rattachement).postDataJSON()).toEqual({ responsableHierarchiqueId: premierPropose });
  } finally {
    await request.patch(`${api}/users/${clavier.id}/responsable-hierarchique`, { headers, data: { responsableHierarchiqueId: null } }).catch(() => undefined);
  }
});
