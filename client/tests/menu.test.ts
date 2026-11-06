import assert from 'node:assert/strict';
import test from 'node:test';
import { sectionsMenu } from '../src/lib/menu.ts';
import {
  estExcluDesOperations, isAdminRole, isSuperAdminRole, peutConsulterAnnuaire, peutConsulterPlanning, peutEtreAussiCommercial, peutOuvrirAdministration,
  peutVoirFinance, peutVoirStatistiques, roleLabel, ROLES_ANNUAIRE, TYPES_ADMINISTRATION, TYPES_COMPTE,
} from '../src/lib/droits.ts';

const liens = (role: string, planningActif = true, permissions: string[] = []) =>
  sectionsMenu({ role, permissions }, planningActif).flatMap((s) => s.entrees.map((e) => e.to)).sort();

// Règles de visibilité de l'ancien menu à plat, réécrites ici à part : le regroupement ne
// doit ni montrer ni cacher une seule entrée par rapport à elles. Seules évolutions depuis :
// l'annuaire des clients ouvert au technicien (décision de Nelson du 13-10-2026), puis au
// conducteur de travaux (décision du 16-10-2026), l'écran des règlements, réservé à
// l'administration (décision A3 du 16-10-2026), le planning et l'administration fermés au
// directeur commercial, à l'assistante commerciale et au comptable (#179, décision 11), et le directeur, qui a les
// droits de l'administration depuis le lot « Directeur aligné sur l'administration » (décision de Nelson du 24-10-2026,
// point 14, « Tout, réglages compris »), hors réglages du super administrateur.
function attendu(role: string, planningActif: boolean, permissions: string[]) {
  const admin = role === 'ADMIN' || role === 'SUPERADMIN' || role === 'DIRECTEUR';
  const commercial = role === 'COMMERCIAL';
  // Seul le commercial est exclu des opérations (estExcluDesOperations) : le directeur ne l'est plus.
  const exclu = commercial;
  const sansPlanning = ['DIRECTEUR_COMMERCIAL', 'ASSISTANTE_COMMERCIALE', 'COMPTABLE'].includes(role);
  const travaux = admin || role === 'CONDUCTEUR_TRAVAUX' || role === 'RESPONSABLE';
  const regles: [string, boolean][] = [
    ['/', true], ['/chantiers', true],
    ['/devis', role === 'SUPERADMIN' || permissions.includes('devis:read')],
    ['/interventions', travaux || role === 'TECHNICIEN'],
    ['/contrats-maintenance', admin], ['/prete-a-facturer', admin], ['/factures', admin], ['/reglements', admin], ['/mentions-legales', admin],
    ['/comptabilite', admin], ['/clients', admin || role === 'TECHNICIEN' || role === 'CONDUCTEUR_TRAVAUX'], ['/catalogue', admin],
    ['/achats', travaux], ['/heures', travaux], ['/statistiques', travaux],
    ['/planning', !exclu && !sansPlanning && planningActif], ['/resultat-commercial', commercial],
    // Administration : plus pour le technicien, qui ne modifie plus les référentiels (lot pilote 3),
    // ni pour les trois types que #179 en écarte.
    ['/admin', !exclu && role !== 'TECHNICIEN' && !sansPlanning], ['/societe', admin], ['/administration/api', role === 'SUPERADMIN'],
    ['/performances', admin], ['/commerciaux', admin],
  ];
  return regles.filter(([, visible]) => visible).map(([to]) => to).sort();
}

test('chaque rôle voit exactement les mêmes pages qu’avant le regroupement', () => {
  for (const role of ['SUPERADMIN', 'ADMIN', 'CONDUCTEUR_TRAVAUX', 'RESPONSABLE', 'TECHNICIEN', 'COMMERCIAL', 'COMPTABLE', 'ASSISTANTE_COMMERCIALE', 'DIRECTEUR_COMMERCIAL', 'DIRECTEUR']) {
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

test('sans compte connu ni type de compte, le menu ne reprend plus celui d’un conducteur : l’accueil et la liste des chantiers seuls (#206)', () => {
  // PR A4 du lot « anomalies d'écran », #206 (cadrage, version 2, contrôlé : C1 et C7). Choix par défaut, à confirmer
  // (règle 5, option la plus restrictive) : un compte sans rôle n'a aucun rôle, et non celui d'un conducteur. Jusqu'à
  // A4, le menu traitait un rôle absent en conducteur (planning, journaux, interventions, administration) ; les
  // statistiques, l'annuaire et les devis, qui se décident sur le compte lui-même, restaient déjà masqués.
  const versListe = (sections: ReturnType<typeof sectionsMenu>) => sections.flatMap((s) => s.entrees.map((e) => e.to)).sort();
  const sansRole = ['/', '/chantiers'];
  for (const planningActif of [true, false]) {
    for (const [cas, compte] of [
      ['aucun compte (null)', null], ['aucun compte (undefined)', undefined], ['compte vide', {}],
      ['rôle vide', { role: '' }], ['rôle undefined', { role: undefined }], ['rôle null', { role: null as unknown as string }],
      // Compte d'un conducteur relu par /api/me, dont le rôle manque : ses permissions ne rendent pas son menu.
      ['permissions d’un conducteur sans rôle', { id: 'ct', name: 'Conducteur', permissions: ['chantiers:read', 'chantiers:write', 'clients:read'] }],
    ] as const) {
      const obtenu = versListe(sectionsMenu(compte, planningActif));
      assert.deepEqual(obtenu, sansRole, `${cas}, planning=${planningActif}`);
      // Lecture écartée, nommée : l'ancien repli sur le conducteur (moins statistiques et annuaire).
      const ancienRepli = attendu('CONDUCTEUR_TRAVAUX', planningActif, []).filter((to) => to !== '/statistiques' && to !== '/clients');
      assert.notDeepEqual(obtenu, ancienRepli, `${cas}, planning=${planningActif} : pas le menu d'un conducteur`);
      for (const to of ['/planning', '/achats', '/heures', '/interventions', '/admin']) assert.equal(obtenu.includes(to), false, `${cas} : ${to}`);
    }
  }
  // L'accueil garde son libellé commun, et non « Ma journée » du technicien.
  assert.deepEqual(sectionsMenu(null, true)[0].entrees.map((e) => [e.to, e.libelle]), [['/', 'Tableau de bord']]);
  assert.deepEqual(sectionsMenu(null, true).map((s) => s.titre ?? 'Accueil'), ['Accueil', 'Chantiers']);
});

// Lot « Directeur aligné sur l'administration » (cadrage version 3) : décision de Nelson du 24-10-2026, point 14 (« Tout,
// réglages compris »), la lecture de Claude Code consignée au même point gardant au super administrateur ses réglages.
// Le directeur a le menu de l'administrateur, permissions égales (celles que /api/me rend aux deux types sont les mêmes),
// planning actif ou coupé ; il n'a pas l'entrée « API d'intégration » du super administrateur.
test('un directeur a le menu de l’administrateur, sans les entrées du super administrateur ; seul le commercial reste exclu des opérations', () => {
  const droitsAdministration = ['devis:read', 'devis:write', 'clients:read', 'chantiers:read', 'chantiers:write', 'chantiers:archive'];
  for (const planningActif of [true, false]) {
    for (const permissions of [[], droitsAdministration]) {
      assert.deepEqual(liens('DIRECTEUR', planningActif, permissions), liens('ADMIN', planningActif, permissions), `planning=${planningActif} ${permissions.join(',')}`);
    }
    const directeur = liens('DIRECTEUR', planningActif, droitsAdministration);
    for (const to of ['/admin', '/catalogue', '/factures', '/reglements', '/comptabilite', '/contrats-maintenance', '/interventions', '/achats', '/heures', '/statistiques', '/performances', '/commerciaux', '/clients', '/societe', '/devis']) {
      assert.equal(directeur.includes(to), true, `planning=${planningActif} : ${to}`);
    }
    assert.equal(directeur.includes('/planning'), planningActif, `planning=${planningActif} : /planning`);
    // Entrée du super administrateur : jamais pour le directeur, toujours pour le super administrateur.
    assert.equal(directeur.includes('/administration/api'), false);
    assert.equal(liens('SUPERADMIN', planningActif, droitsAdministration).includes('/administration/api'), true);
    assert.equal(directeur.includes('/resultat-commercial'), false, 'pas « aussi commercial »');
  }
  // Mêmes sections que l'administrateur, dans le même ordre.
  assert.deepEqual(sectionsMenu({ role: 'DIRECTEUR', permissions: ['devis:read'] }, true).map((s) => [s.titre ?? 'Accueil', s.entrees.map((e) => e.to)]),
    sectionsMenu({ role: 'ADMIN', permissions: ['devis:read'] }, true).map((s) => [s.titre ?? 'Accueil', s.entrees.map((e) => e.to)]));
  assert.equal(roleLabel('DIRECTEUR'), 'Directeur');
  // Même exclusion que blockCommercial côté serveur : le commercial seulement (le directeur en sort avec ce lot).
  assert.deepEqual(['SUPERADMIN', 'ADMIN', 'CONDUCTEUR_TRAVAUX', 'RESPONSABLE', 'TECHNICIEN', 'COMMERCIAL', 'COMPTABLE', 'ASSISTANTE_COMMERCIALE', 'DIRECTEUR_COMMERCIAL', 'DIRECTEUR']
    .filter((role) => estExcluDesOperations(role)), ['COMMERCIAL']);
  assert.equal(estExcluDesOperations('DIRECTEUR'), false);
});

test('une seule liste des types de l’administration : le directeur y est, avec l’administrateur et le super administrateur ; « aussi commercial » reste aux deux derniers (décision 7 de #182)', () => {
  assert.deepEqual([...TYPES_ADMINISTRATION].sort(), ['ADMIN', 'DIRECTEUR', 'SUPERADMIN']);
  for (const { valeur } of TYPES_COMPTE) {
    assert.equal(isAdminRole(valeur), ['ADMIN', 'DIRECTEUR', 'SUPERADMIN'].includes(valeur), `isAdminRole(${valeur})`);
    assert.equal(isSuperAdminRole(valeur), valeur === 'SUPERADMIN', `isSuperAdminRole(${valeur})`);
    // Case « aussi commercial » : ni le directeur, qui a pourtant les droits de l'administration, ni un autre type.
    assert.equal(peutEtreAussiCommercial(valeur), ['ADMIN', 'SUPERADMIN'].includes(valeur), `peutEtreAussiCommercial(${valeur})`);
  }
  for (const role of ['', null, undefined]) {
    assert.equal(isAdminRole(role), false);
    assert.equal(peutEtreAussiCommercial(role), false);
  }
  // Lecture écartée, nommée : « aussi commercial » ouvert à tout type de l'administration (isAdminRole).
  assert.notEqual(peutEtreAussiCommercial('DIRECTEUR'), isAdminRole('DIRECTEUR'));
});

test('l’annuaire, les statistiques, le planning et l’administration s’ouvrent au directeur, comme à l’administrateur', () => {
  // Annuaire : la liste des routes privées (/clients) et du menu part des types de l'administration (R2 du contrôle).
  for (const role of TYPES_ADMINISTRATION) assert.ok(ROLES_ANNUAIRE.includes(role), role);
  assert.deepEqual([...ROLES_ANNUAIRE].sort(), ['ADMIN', 'CONDUCTEUR_TRAVAUX', 'DIRECTEUR', 'SUPERADMIN', 'TECHNICIEN']);
  const directeur = { role: 'DIRECTEUR', permissions: [] };
  assert.equal(peutConsulterAnnuaire(directeur), true);
  assert.equal(peutVoirStatistiques(directeur), true);
  assert.equal(peutConsulterPlanning('DIRECTEUR'), true);
  assert.equal(peutOuvrirAdministration('DIRECTEUR'), true);
  // L'accès financier reste une décision du super administrateur : le directeur ne l'a pas par son type.
  assert.equal(peutVoirFinance(directeur), false);
  assert.equal(peutVoirFinance({ ...directeur, accesFinance: true }), true);
});

test('le technicien garde le planning en consultation, sans l’administration (lot pilote 3)', () => {
  const visibles = liens('TECHNICIEN', true, ['chantiers:read', 'clients:read']);
  assert.equal(visibles.includes('/planning'), true);
  assert.equal(visibles.includes('/admin'), false);
  assert.equal(peutOuvrirAdministration('TECHNICIEN'), false);
  assert.equal(peutOuvrirAdministration('CONDUCTEUR_TRAVAUX'), true);
  assert.equal(peutOuvrirAdministration('COMMERCIAL'), false);
});

test('l’accueil du technicien s’intitule « Ma journée », celui des autres « Tableau de bord » (lot pilote 3b-4)', () => {
  const accueil = (role: string) => sectionsMenu({ role, permissions: [] }, true)[0].entrees.map((e) => [e.to, e.libelle]);
  assert.deepEqual(accueil('TECHNICIEN'), [['/', 'Ma journée']]);
  for (const role of ['SUPERADMIN', 'ADMIN', 'CONDUCTEUR_TRAVAUX', 'RESPONSABLE', 'COMMERCIAL', 'DIRECTEUR']) assert.deepEqual(accueil(role), [['/', 'Tableau de bord']], role);
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
  // Les autres profils qui portent clients:read (commercial, comptable…) n'ont pas l'écran ; le directeur, qui a les droits
  // de l'administration, l'a dans ses référentiels, avec le catalogue.
  for (const role of ['COMMERCIAL', 'COMPTABLE', 'ASSISTANTE_COMMERCIALE', 'DIRECTEUR_COMMERCIAL', 'RESPONSABLE']) {
    assert.equal(liens(role, true, ['clients:read']).includes('/clients'), false, role);
  }
  const referentielsDirecteur = sectionsMenu({ role: 'DIRECTEUR', permissions: ['clients:read'] }, true).find((s) => s.titre === 'Référentiels');
  assert.deepEqual(referentielsDirecteur?.entrees.map((e) => e.to), ['/clients', '/catalogue']);
});

// #179 (décision 11 de la proposition de droits) : le directeur commercial, l'assistante commerciale
// et le comptable n'ont ni le planning ni l'administration, comme le commercial. #206 (C7 du contrôle du
// cadrage de A4) : un rôle absent non plus, et non plus le repli du conducteur. Le directeur les a depuis le lot
// « Directeur aligné sur l'administration ».
test('le directeur commercial, l’assistante commerciale et le comptable n’ont ni planning ni administration (#179), ni un compte sans type (#206)', () => {
  for (const role of ['DIRECTEUR_COMMERCIAL', 'ASSISTANTE_COMMERCIALE', 'COMPTABLE', 'COMMERCIAL']) {
    assert.equal(peutConsulterPlanning(role), false, role);
    assert.equal(peutOuvrirAdministration(role), false, role);
    assert.equal(liens(role).includes('/planning'), false, role);
    assert.equal(liens(role).includes('/admin'), false, role);
  }
  for (const role of ['SUPERADMIN', 'ADMIN', 'DIRECTEUR', 'CONDUCTEUR_TRAVAUX', 'RESPONSABLE', 'TECHNICIEN']) {
    assert.equal(peutConsulterPlanning(role), true, role);
    assert.equal(liens(role).includes('/planning'), true, role);
  }
  // #206, choix par défaut, à confirmer (règle 5, option la plus restrictive) : sans compte connu, aucun rôle, donc ni
  // planning ni administration ; ce n'est plus le repli du conducteur, qui les avait.
  for (const role of [undefined, null, '']) {
    assert.equal(peutConsulterPlanning(role), false, `rôle absent (${JSON.stringify(role)}) : pas de planning`);
    assert.equal(peutOuvrirAdministration(role), false, `rôle absent (${JSON.stringify(role)}) : pas d'administration`);
  }
  assert.equal(peutConsulterPlanning(), false, 'sans argument : pas de planning');
  assert.equal(peutOuvrirAdministration(), false, 'sans argument : pas d’administration');
  assert.equal(liens('').includes('/planning') || liens('').includes('/admin'), false, 'rôle vide : ni planning ni administration au menu');
});
