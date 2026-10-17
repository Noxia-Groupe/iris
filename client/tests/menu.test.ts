import assert from 'node:assert/strict';
import test from 'node:test';
import { sectionsMenu } from '../src/lib/menu.ts';
import { estExcluDesOperations, peutOuvrirAdministration, peutVoirFinance, roleLabel } from '../src/lib/droits.ts';

const liens = (role: string, planningActif = true, permissions: string[] = []) =>
  sectionsMenu({ role, permissions }, planningActif).flatMap((s) => s.entrees.map((e) => e.to)).sort();

// Règles de visibilité de l'ancien menu à plat, réécrites ici à part : le regroupement ne
// doit ni montrer ni cacher une seule entrée par rapport à elles. Seules évolutions depuis :
// l'annuaire des clients ouvert au technicien (décision de Nelson du 13-10-2026), puis au
// conducteur de travaux (décision du 16-10-2026), et l'écran des règlements, réservé à
// l'administration (décision A3 du 16-10-2026).
function attendu(role: string, planningActif: boolean, permissions: string[]) {
  const admin = role === 'ADMIN' || role === 'SUPERADMIN';
  const commercial = role === 'COMMERCIAL';
  const travaux = admin || role === 'CONDUCTEUR_TRAVAUX' || role === 'RESPONSABLE';
  const regles: [string, boolean][] = [
    ['/', true], ['/chantiers', true],
    ['/devis', role === 'SUPERADMIN' || permissions.includes('devis:read')],
    ['/interventions', travaux || role === 'TECHNICIEN'],
    ['/contrats-maintenance', admin], ['/prete-a-facturer', admin], ['/factures', admin], ['/reglements', admin], ['/mentions-legales', admin],
    ['/comptabilite', admin], ['/clients', admin || role === 'TECHNICIEN' || role === 'CONDUCTEUR_TRAVAUX'], ['/catalogue', admin],
    ['/achats', travaux], ['/heures', travaux], ['/statistiques', travaux],
    ['/planning', !commercial && planningActif], ['/resultat-commercial', commercial],
    // Administration : plus pour le technicien, qui ne modifie plus les référentiels (lot pilote 3).
    ['/admin', !commercial && role !== 'TECHNICIEN'], ['/societe', admin], ['/administration/api', role === 'SUPERADMIN'],
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

test('sans compte connu, le menu reprend l’ancien repli : conducteur, sans les statistiques ni l’annuaire', () => {
  // L'ancien menu traitait un rôle absent en conducteur, mais les statistiques (comme les
  // devis et, depuis le 16-10-2026, l'annuaire des clients) se décident sur le compte lui-même :
  // sans compte, elles restent masquées.
  const versListe = (sections: ReturnType<typeof sectionsMenu>) => sections.flatMap((s) => s.entrees.map((e) => e.to)).sort();
  const sansStatistiques = (planningActif: boolean) => attendu('CONDUCTEUR_TRAVAUX', planningActif, []).filter((to) => to !== '/statistiques' && to !== '/clients');
  assert.deepEqual(versListe(sectionsMenu(null, true)), sansStatistiques(true));
  assert.deepEqual(versListe(sectionsMenu({}, false)), sansStatistiques(false));
});

test('un directeur pilote sans écran opérationnel : tableau de bord et chantiers, devis s’il en a reçu le droit', () => {
  for (const planningActif of [true, false]) {
    assert.deepEqual(liens('DIRECTEUR', planningActif), ['/', '/chantiers']);
    assert.deepEqual(liens('DIRECTEUR', planningActif, ['devis:read']), ['/', '/chantiers', '/devis']);
  }
  assert.equal(roleLabel('DIRECTEUR'), 'Directeur');
  // Même exclusion que blockCommercial côté serveur : commercial et directeur seulement.
  assert.deepEqual(['SUPERADMIN', 'ADMIN', 'CONDUCTEUR_TRAVAUX', 'RESPONSABLE', 'TECHNICIEN', 'COMMERCIAL', 'COMPTABLE', 'ASSISTANTE_COMMERCIALE', 'DIRECTEUR_COMMERCIAL', 'DIRECTEUR']
    .filter((role) => estExcluDesOperations(role)), ['COMMERCIAL', 'DIRECTEUR']);
});

test('le technicien garde le planning en consultation, sans l’administration (lot pilote 3)', () => {
  const visibles = liens('TECHNICIEN', true, ['chantiers:read', 'clients:read']);
  assert.equal(visibles.includes('/planning'), true);
  assert.equal(visibles.includes('/admin'), false);
  assert.equal(peutOuvrirAdministration('TECHNICIEN'), false);
  assert.equal(peutOuvrirAdministration('CONDUCTEUR_TRAVAUX'), true);
  assert.equal(peutOuvrirAdministration('COMMERCIAL'), false);
});

test('l’accès financier ne vaut jamais pour un technicien, même enregistré', () => {
  assert.equal(peutVoirFinance({ role: 'TECHNICIEN', permissions: [], accesFinance: true }), false);
  assert.equal(peutVoirFinance({ role: 'CONDUCTEUR_TRAVAUX', permissions: [], accesFinance: true }), true);
  assert.equal(peutVoirFinance({ role: 'CONDUCTEUR_TRAVAUX', permissions: [], accesFinance: false }), false);
  assert.equal(peutVoirFinance({ role: 'SUPERADMIN', permissions: [] }), true);
});

test('le technicien et le conducteur consultent l’annuaire des clients, dans les référentiels, sans le catalogue', () => {
  for (const [role, permissions] of [['TECHNICIEN', ['chantiers:read', 'clients:read']], ['CONDUCTEUR_TRAVAUX', ['chantiers:read', 'chantiers:write', 'clients:read']]] as const) {
    const sections = sectionsMenu({ role, permissions: [...permissions] }, true);
    const referentiels = sections.find((s) => s.titre === 'Référentiels');
    assert.deepEqual(referentiels?.entrees.map((e) => e.to), ['/clients'], role);
  }
  // Les autres profils qui portent clients:read (commercial, comptable…) n'ont pas l'écran.
  for (const role of ['COMMERCIAL', 'COMPTABLE', 'ASSISTANTE_COMMERCIALE', 'DIRECTEUR_COMMERCIAL', 'RESPONSABLE', 'DIRECTEUR']) {
    assert.equal(liens(role, true, ['clients:read']).includes('/clients'), false, role);
  }
});
