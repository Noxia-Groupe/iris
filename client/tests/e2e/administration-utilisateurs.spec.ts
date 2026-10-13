import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// L'écran Utilisateurs ne construit qu'une liste de responsables à la fois, celle que l'on ouvre.
// Proposer tous les comptes sur chaque ligne faisait croître la page comme le carré du nombre de
// comptes : 156 642 options et 18 s d'affichage pour 396 comptes.
test('Administration > Utilisateurs : une seule liste de responsables construite à la fois', async ({ allerSurPageAdmin, request, session }) => {
  const headers = { Authorization: `Bearer ${session.token}` };
  const suffixe = Date.now();
  const creerCompte = async (cle: string) => {
    const reponse = await request.post(`${api}/users`, { headers, data: { email: `utilisateurs.${cle}.${suffixe}@iris.test`, name: `Compte liste ${cle} ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' } });
    expect(reponse.ok(), await reponse.text()).toBeTruthy();
    return reponse.json() as Promise<{ id: string; name: string }>;
  };
  const premier = await creerCompte('premier');
  const second = await creerCompte('second');

  const admin = await allerSurPageAdmin('/admin');
  await admin.getByRole('button', { name: 'Utilisateurs', exact: true }).click();
  const listes = admin.locator('select[aria-label^="Responsable hiérarchique de"]');
  await expect(listes.first()).toBeVisible();
  // Fermée, chaque liste ne porte que « Aucun » et, s'il existe, le responsable actuel.
  const lignes = await listes.count();
  expect(lignes).toBeGreaterThanOrEqual(2);
  expect(await listes.locator('option').count()).toBeLessThanOrEqual(lignes * 2);

  // Ouverte, la liste propose les autres comptes actifs, hors de la branche du compte.
  const liste = admin.getByRole('combobox', { name: `Responsable hiérarchique de ${premier.name}` });
  await liste.focus();
  await expect(liste.locator('option', { hasText: second.name })).toHaveCount(1);
  await expect(liste.locator('option', { hasText: premier.name })).toHaveCount(0);
  expect(await listes.locator('option').count()).toBeGreaterThan(lignes);

  // Refermée, elle ne garde que son choix actuel (ici « Aucun »).
  await liste.blur();
  await expect(liste.locator('option')).toHaveCount(1);
});
