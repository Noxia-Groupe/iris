import assert from 'node:assert/strict';
import test from 'node:test';
import { sectionsMenu } from '../src/lib/menu.ts';
import {
  estEncadrementSav, estEncadrementSuivi, estExcluDesOperations, isAdminRole, isSuperAdminRole, peutAccederAuxDevis, peutConsulterAnnuaire, peutConsulterPlanning,
  peutEtreAussiCommercial, peutOuvrirAdministration, peutVoirFinance, peutVoirInterventions, peutVoirStatistiques, roleLabel, ROLES_ANNUAIRE, ROLES_INTERVENTIONS,
  TYPES_ADMINISTRATION, TYPES_COMPTE,
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
// point 14, « Tout, réglages compris »), hors réglages du super administrateur. Enfin l'assistante technique (lot
// « Assistante technique », PR AT-1, cadrage v2.1, « Écran ») : interventions SAV, planning, liste des chantiers, clients
// et administration réduite, sans devis (sauf permission), journaux Travaux, contrats, facturation, statistiques,
// performances ni catalogue.
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
    ['/interventions', travaux || role === 'TECHNICIEN' || role === 'ASSISTANTE_TECHNIQUE'],
    ['/contrats-maintenance', admin], ['/prete-a-facturer', admin], ['/factures', admin], ['/reglements', admin], ['/mentions-legales', admin],
    ['/comptabilite', admin], ['/clients', admin || role === 'TECHNICIEN' || role === 'CONDUCTEUR_TRAVAUX' || role === 'ASSISTANTE_TECHNIQUE'], ['/catalogue', admin],
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
  // Les onze types, relus de la table (une liste écrite ici oublierait un type ajouté), chacun nommé.
  const roles = TYPES_COMPTE.map((type) => type.valeur);
  assert.equal(roles.length, 11);
  for (const role of ['SUPERADMIN', 'ADMIN', 'CONDUCTEUR_TRAVAUX', 'RESPONSABLE', 'TECHNICIEN', 'COMMERCIAL', 'COMPTABLE', 'ASSISTANTE_COMMERCIALE', 'DIRECTEUR_COMMERCIAL', 'DIRECTEUR', 'ASSISTANTE_TECHNIQUE']) assert.ok(roles.includes(role), role);
  for (const role of roles) {
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
  assert.deepEqual(['SUPERADMIN', 'ADMIN', 'CONDUCTEUR_TRAVAUX', 'RESPONSABLE', 'TECHNICIEN', 'COMMERCIAL', 'COMPTABLE', 'ASSISTANTE_COMMERCIALE', 'DIRECTEUR_COMMERCIAL', 'DIRECTEUR', 'ASSISTANTE_TECHNIQUE']
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
  // L'assistante technique y entre avec le lot AT-1 (elle choisit le client d'une intervention SAV ; clients:read).
  assert.deepEqual([...ROLES_ANNUAIRE].sort(), ['ADMIN', 'ASSISTANTE_TECHNIQUE', 'CONDUCTEUR_TRAVAUX', 'DIRECTEUR', 'SUPERADMIN', 'TECHNICIEN']);
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

// Lot « Assistante technique », PR AT-1 (cadrage v2.1, « Écran » et « Fermé à AT-1 » ; décisions de Nelson du 24-10-2026,
// points 15, 16, 18 et 28, réponse 7 du 06-11-2026). Menu : Interventions SAV, Planning, Liste des chantiers, Clients et
// Administration (réduite à ses deux onglets) ; ni Devis (AT-2, permission devis:read absente par défaut), ni journaux
// des achats et des heures (AT-2), ni contrats (AT-2), ni facturation (AT-3), ni Statistiques, Performances, Mes
// commerciaux (fermés, choix par défaut, à confirmer), ni catalogue (administration).
test('assistante technique : menu exact (Interventions SAV, Planning, Liste des chantiers, Clients, Administration), sans devis, journaux Travaux, contrats, facturation, statistiques ni catalogue', () => {
  // Permissions par défaut du type (DEFAULT_USER_PERMISSIONS côté serveur) : clients:read et chantiers:read.
  const permissions = ['clients:read', 'chantiers:read'];
  const sections = sectionsMenu({ role: 'ASSISTANTE_TECHNIQUE', permissions }, true);
  assert.deepEqual(sections.map((s) => [s.titre ?? 'Accueil', s.entrees.map((e) => e.libelle)]), [
    ['Accueil', ['Tableau de bord']],
    ['Chantiers', ['Liste des chantiers', 'Planning']],
    ['Interventions', ['Interventions SAV']],
    ['Référentiels', ['Clients']],
    ['Réglages', ['Administration']],
  ]);
  const visibles = liens('ASSISTANTE_TECHNIQUE', true, permissions);
  for (const to of ['/devis', '/achats', '/heures', '/contrats-maintenance', '/prete-a-facturer', '/factures', '/reglements', '/mentions-legales', '/comptabilite',
    '/statistiques', '/resultat-commercial', '/performances', '/commerciaux', '/catalogue', '/societe', '/administration/api']) {
    assert.equal(visibles.includes(to), false, to);
  }
  // Module Planning coupé : l'entrée disparaît, comme pour les autres comptes ; le reste ne bouge pas.
  assert.deepEqual(liens('ASSISTANTE_TECHNIQUE', false, permissions), visibles.filter((to) => to !== '/planning'));
  // Lectures écartées, nommées : le menu de l'assistante commerciale (sans planning ni SAV), celui du conducteur (journaux
  // Travaux et statistiques) et celui de l'administration.
  for (const autre of ['ASSISTANTE_COMMERCIALE', 'CONDUCTEUR_TRAVAUX', 'ADMIN']) assert.notDeepEqual(visibles, liens(autre, true, permissions), autre);
  assert.equal(peutVoirStatistiques({ role: 'ASSISTANTE_TECHNIQUE', permissions }), false);
  assert.equal(peutAccederAuxDevis({ role: 'ASSISTANTE_TECHNIQUE', permissions }), false);
  assert.equal(peutConsulterAnnuaire({ role: 'ASSISTANTE_TECHNIQUE', permissions }), true);
  assert.equal(peutConsulterPlanning('ASSISTANTE_TECHNIQUE'), true);
  assert.equal(peutOuvrirAdministration('ASSISTANTE_TECHNIQUE'), true);
  assert.equal(estExcluDesOperations('ASSISTANTE_TECHNIQUE'), false);
  // L'accès financier n'est pas porté par le type.
  assert.equal(peutVoirFinance({ role: 'ASSISTANTE_TECHNIQUE', permissions }), false);
});

// Même cadrage (« Écran », « SAV sur toute la société ») : écran des interventions, encadrement du SAV (nouvelle
// intervention, matériel, coûts sans taux) et encadrement du suivi (« à suivre », suite), type par type, écrits ici à
// part et non relus du code ; mêmes règles que le serveur (estEncadrementCoutIntervention, estEncadrementSuivi).
test('écran des interventions, encadrement du SAV et du suivi : l’assistante technique y entre comme le conducteur, type par type', () => {
  const ATTENDU: Record<string, [boolean, boolean, boolean]> = {
    //                       interventions, encadrement SAV, encadrement suivi
    SUPERADMIN: [true, true, true],
    ADMIN: [true, true, true],
    DIRECTEUR: [true, true, true],
    CONDUCTEUR_TRAVAUX: [true, true, true],
    ASSISTANTE_TECHNIQUE: [true, true, true],
    RESPONSABLE: [true, false, true],
    TECHNICIEN: [true, false, false],
    COMMERCIAL: [false, false, false],
    DIRECTEUR_COMMERCIAL: [false, false, false],
    ASSISTANTE_COMMERCIALE: [false, false, false],
    COMPTABLE: [false, false, false],
  };
  assert.deepEqual(Object.keys(ATTENDU).sort(), TYPES_COMPTE.map((type) => type.valeur).sort(), 'les onze types, ni plus ni moins');
  for (const [role, [interventions, sav, suivi]] of Object.entries(ATTENDU)) {
    assert.equal(peutVoirInterventions(role), interventions, `interventions, ${role}`);
    assert.equal(ROLES_INTERVENTIONS.includes(role), interventions, `ROLES_INTERVENTIONS, ${role}`);
    assert.equal(liens(role, true, []).includes('/interventions'), interventions, `menu, ${role}`);
    assert.equal(estEncadrementSav(role), sav, `encadrement SAV, ${role}`);
    assert.equal(estEncadrementSuivi(role), suivi, `encadrement du suivi, ${role}`);
  }
  // Un rôle absent ou inconnu n'ouvre rien (#206).
  for (const role of ['', null, undefined, 'INCONNU', 'assistante_technique']) {
    assert.equal(peutVoirInterventions(role), false, String(role));
    assert.equal(estEncadrementSav(role), false, String(role));
    assert.equal(estEncadrementSuivi(role), false, String(role));
  }
});
