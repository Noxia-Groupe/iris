import assert from 'node:assert/strict';
import test from 'node:test';
import { sectionsMenu } from '../src/lib/menu.ts';

const liens = (role: string, planningActif = true, permissions: string[] = []) =>
  sectionsMenu({ role, permissions }, planningActif).flatMap((s) => s.entrees.map((e) => e.to)).sort();

// Règles de visibilité de l'ancien menu à plat, réécrites ici à part : le regroupement ne
// doit ni montrer ni cacher une seule entrée par rapport à elles.
function attendu(role: string, planningActif: boolean, permissions: string[]) {
  const admin = role === 'ADMIN' || role === 'SUPERADMIN';
  const commercial = role === 'COMMERCIAL';
  const travaux = admin || role === 'CONDUCTEUR_TRAVAUX' || role === 'RESPONSABLE';
  const regles: [string, boolean][] = [
    ['/', true], ['/chantiers', true],
    ['/devis', role === 'SUPERADMIN' || permissions.includes('devis:read')],
    ['/interventions', travaux || role === 'TECHNICIEN'],
    ['/contrats-maintenance', admin], ['/prete-a-facturer', admin], ['/factures', admin], ['/mentions-legales', admin],
    ['/comptabilite', admin], ['/clients', admin], ['/catalogue', admin],
    ['/achats', travaux], ['/heures', travaux], ['/statistiques', travaux],
    ['/planning', !commercial && planningActif], ['/resultat-commercial', commercial],
    ['/admin', !commercial], ['/societe', admin], ['/administration/api', role === 'SUPERADMIN'],
    ['/performances', admin], ['/commerciaux', admin],
  ];
  return regles.filter(([, visible]) => visible).map(([to]) => to).sort();
}

test('chaque rôle voit exactement les mêmes pages qu’avant le regroupement', () => {
  for (const role of ['SUPERADMIN', 'ADMIN', 'CONDUCTEUR_TRAVAUX', 'RESPONSABLE', 'TECHNICIEN', 'COMMERCIAL', 'COMPTABLE', 'ASSISTANTE_COMMERCIALE', 'DIRECTEUR_COMMERCIAL']) {
    for (const planningActif of [true, false]) {
      for (const permissions of [[], ['devis:read']]) {
        assert.deepEqual(liens(role, planningActif, permissions), attendu(role, planningActif, permissions), `${role} planning=${planningActif} ${permissions.join(',')}`);
      }
    }
  }
});

test('un administrateur voit les thèmes dans l’ordre du travail, sans section vide', () => {
  const sections = sectionsMenu({ role: 'ADMIN', permissions: ['devis:read'] }, true);
  assert.deepEqual(sections.map((s) => s.titre ?? 'Accueil'), ['Accueil', 'Chantiers', 'Interventions', 'Facturation', 'Pilotage', 'Référentiels', 'Réglages']);
  assert.deepEqual(sections[1].entrees.map((e) => e.libelle), ['Liste des chantiers', 'Devis', 'Planning', 'Journal des achats', 'Journal des heures']);
});

test('un commercial n’a que ses sections : ni facturation, ni réglages', () => {
  const sections = sectionsMenu({ role: 'COMMERCIAL', permissions: [] }, true);
  assert.deepEqual(sections.map((s) => s.titre ?? 'Accueil'), ['Accueil', 'Chantiers', 'Pilotage']);
  assert.deepEqual(sections[2].entrees.map((e) => e.to), ['/resultat-commercial']);
});

test('seuls l’accueil et la liste des chantiers sont actifs sur leur chemin exact', () => {
  const entrees = sectionsMenu({ role: 'SUPERADMIN' }, true).flatMap((s) => s.entrees);
  assert.deepEqual(entrees.filter((e) => e.exact).map((e) => e.to), ['/', '/chantiers']);
});

test('sans compte connu, le menu reprend l’ancien repli : conducteur, sans les statistiques', () => {
  // L'ancien menu traitait un rôle absent en conducteur, mais les statistiques (comme les
  // devis) se décident sur le compte lui-même : sans compte, elles restaient masquées.
  const versListe = (sections: ReturnType<typeof sectionsMenu>) => sections.flatMap((s) => s.entrees.map((e) => e.to)).sort();
  const sansStatistiques = (planningActif: boolean) => attendu('CONDUCTEUR_TRAVAUX', planningActif, []).filter((to) => to !== '/statistiques');
  assert.deepEqual(versListe(sectionsMenu(null, true)), sansStatistiques(true));
  assert.deepEqual(versListe(sectionsMenu({}, false)), sansStatistiques(false));
});
