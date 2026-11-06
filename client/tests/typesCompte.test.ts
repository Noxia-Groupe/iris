import assert from 'node:assert/strict';
import test from 'node:test';
// lib/droits.ts, et non roles.ts : roles.ts charge api.ts, qui lit import.meta.env, introuvable sous tsx --test (N5 du
// cadrage du lot « anomalies d'écran »). Le journal d'administration, lui, n'importe que lib/droits.ts (V-N6).
import { TYPES_COMPTE, isAdminRole, isSuperAdminRole, roleLabel, typesCompteProposes } from '../src/lib/droits.ts';
import { lisible } from '../src/lib/journalAdministration.ts';

// PR A3 du lot « anomalies d'écran », #203 (cadrage, version 2, contrôlé) ; point 1 de #475 ; N4 du contrôle (casse de
// la cible, MODELE-DROITS-CIBLE.md:324). Micro-arbitrage d'affichage (règle 5), choix par défaut, à confirmer : une seule
// liste ordonnée des types de compte, dans lib/droits.ts, employée par les deux listes de l'administration ; un seul
// libellé par type, le plus explicite, en casse de phrase, porté par roleLabel et employé partout (menu, « Connecté en
// tant que », journal d'administration). L'ordre et les valeurs ne changent pas ; l'option super administrateur reste
// réservée à un super administrateur.

// Ordre et valeurs des deux listes de l'administration avant la PR (AdminUtilisateurs.tsx, l. 66-76 et 162-171 sur
// 1d9eb57), libellés en casse de phrase. Écartés : « Conducteur de Travaux » et « Super Administrateur » (anciennes
// listes), « Conducteur », « Admin » et « Super Admin » (ancien roleLabel).
const ATTENDUS: ReadonlyArray<readonly [string, string]> = [
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
const enObjets = (paires: ReadonlyArray<readonly [string, string]>) => paires.map(([valeur, libelle]) => ({ valeur, libelle }));

test('les dix types de compte, dans l’ordre des listes de l’administration, chacun avec son libellé unique (#203)', () => {
  // Égalité stricte : ni type ajouté, retiré ou déplacé, ni autre champ que la valeur et le libellé.
  assert.deepEqual(TYPES_COMPTE, enObjets(ATTENDUS));
  assert.equal(new Set(TYPES_COMPTE.map((type) => type.valeur)).size, 10, 'chaque valeur une seule fois');
  assert.equal(new Set(TYPES_COMPTE.map((type) => type.libelle)).size, 10, 'chaque libellé une seule fois');
});

test('un super administrateur se voit proposer les dix types ; un autre compte, les neuf sans « Super administrateur », dans le même ordre', () => {
  assert.deepEqual(typesCompteProposes(true), enObjets(ATTENDUS));
  assert.deepEqual(typesCompteProposes(false), enObjets(ATTENDUS.filter(([valeur]) => valeur !== 'SUPERADMIN')));
  assert.equal(typesCompteProposes(false).some((type) => type.valeur === 'SUPERADMIN' || type.libelle === 'Super administrateur'), false);
  // « Administrateur » reste proposé à un administrateur : seule l'option super administrateur lui est retirée.
  assert.equal(typesCompteProposes(false).at(-1)?.valeur, 'ADMIN');
  // Proposer ne modifie pas la table : le menu et le journal continuent d'y lire le libellé du super administrateur.
  assert.equal(TYPES_COMPTE.length, 10);
  assert.equal(roleLabel('SUPERADMIN'), 'Super administrateur');
});

test('chaque type de compte se lit sous le libellé de la liste, dans le menu comme dans le journal d’administration', () => {
  for (const [valeur, libelle] of ATTENDUS) {
    assert.equal(roleLabel(valeur), libelle, valeur);
    // Journal d'administration (lib/journalAdministration.ts:54) : le champ « Type de compte » passe par roleLabel.
    assert.equal(lisible(valeur, 'role'), libelle, `journal : ${valeur}`);
  }
  // Les trois libellés qui changent, nommés : ni « Super Admin », ni « Admin », ni « Conducteur » pour un conducteur de
  // travaux, ni la casse des anciennes listes (« Super Administrateur », « Conducteur de Travaux »).
  assert.equal(roleLabel('SUPERADMIN'), 'Super administrateur');
  assert.equal(roleLabel('ADMIN'), 'Administrateur');
  assert.equal(roleLabel('CONDUCTEUR_TRAVAUX'), 'Conducteur de travaux');
  // Une seule source : le libellé affiché est celui de la table, type par type.
  for (const type of TYPES_COMPTE) assert.equal(roleLabel(type.valeur), type.libelle, type.valeur);
});

test('un rôle absent ou inconnu n’a aucun libellé : rien n’est affiché, ni « Conducteur » ni un autre type (#206)', () => {
  // PR A4 du lot « anomalies d'écran », #206 (cadrage, version 2, point 3 ; C2 du contrôle du cadrage). Choix par défaut,
  // à confirmer (règle 5, option la plus restrictive) : le repli de roleLabel est '' (menu et « Connecté en tant que »
  // n'affichent rien), et non plus « Conducteur », qu'aucun type ne porte depuis #203. Le journal d'administration, lui,
  // garde sa propre lecture (journalAdministration.test.ts).
  // Valeurs proches d'un code connu, sans en être un : 'superadmin' et 'Administrateur' (casse ou libellé, et non code),
  // ' ADMIN' et 'ADMIN ' (espaces) ; 'constructor' et 'toString' (propriétés héritées, si la table devenait un dictionnaire).
  for (const role of ['', null, undefined, 'INCONNU', 'superadmin', 'Administrateur', 'constructor', 'toString', ' ADMIN', 'ADMIN ']) {
    assert.equal(roleLabel(role), '', JSON.stringify(role) ?? 'undefined');
  }
  assert.equal(roleLabel(), '');
  // Lectures écartées, nommées : l'ancien repli « Conducteur », et le libellé d'un conducteur de travaux connu.
  for (const role of ['', null, undefined, 'INCONNU']) {
    assert.notEqual(roleLabel(role), 'Conducteur');
    assert.notEqual(roleLabel(role), roleLabel('CONDUCTEUR_TRAVAUX'));
    assert.equal(TYPES_COMPTE.some((type) => type.libelle === roleLabel(role)), false, `aucun libellé de type pour ${String(role)}`);
  }
});

// Lot « Directeur aligné sur l'administration » (cadrage version 3, « Libellé : Directeur, inchangé ») : le directeur a les
// droits de l'administration (décision de Nelson du 24-10-2026, point 14), pas ceux du super administrateur. Il
// n'attribue pas non plus le type Administrateur, qui lèverait sa restriction de rentabilité (réponse de Nelson du
// 06-11-2026, « Chantiers seulement ») : choix par défaut, à confirmer (règle 5, option la plus restrictive), miroir de
// refuseTypeAdminParDirecteur côté serveur. Dans Administration > Utilisateurs (AdminUtilisateurs.tsx :
// typesCompteProposes(isSuper, estDirecteur)), il se voit donc proposer huit types, sans « Super administrateur » ni
// « Administrateur », et son type garde son libellé.
test('le directeur garde son libellé « Directeur » et se voit proposer les types d’un administrateur, sans « Super administrateur » ni « Administrateur »', () => {
  assert.equal(roleLabel('DIRECTEUR'), 'Directeur');
  assert.equal(lisible('DIRECTEUR', 'role'), 'Directeur');
  assert.equal(isAdminRole('DIRECTEUR'), true);
  assert.equal(isSuperAdminRole('DIRECTEUR'), false);
  const directeur = typesCompteProposes(isSuperAdminRole('DIRECTEUR'), true);
  // Huit types, dans l'ordre des listes, « Directeur » compris : il ouvre un autre directeur.
  assert.deepEqual(directeur, enObjets(ATTENDUS.filter(([valeur]) => valeur !== 'SUPERADMIN' && valeur !== 'ADMIN')));
  assert.equal(directeur.length, 8);
  assert.equal(directeur.some((type) => type.valeur === 'ADMIN' || type.libelle === 'Administrateur'), false);
  assert.equal(directeur.at(-1)?.valeur, 'DIRECTEUR');
  // Lecture écartée : la liste de l'administrateur, « Administrateur » compris.
  assert.notDeepEqual(directeur, typesCompteProposes(isSuperAdminRole('ADMIN')));
});

// Même choix par défaut : le second paramètre retire « Administrateur » et lui seul ; il ne touche pas au filtre du super
// administrateur, et la valeur par défaut garde les listes d'avant (administrateur et super administrateur inchangés).
test('typesCompteProposes : « sans administrateur » retire « Administrateur » et lui seul, avec ou sans « Super administrateur » ; par défaut, les listes d’avant', () => {
  const neuf = enObjets(ATTENDUS.filter(([valeur]) => valeur !== 'SUPERADMIN'));
  assert.deepEqual(typesCompteProposes(false, true), enObjets(ATTENDUS.filter(([valeur]) => valeur !== 'SUPERADMIN' && valeur !== 'ADMIN')));
  assert.deepEqual(typesCompteProposes(true, true), enObjets(ATTENDUS.filter(([valeur]) => valeur !== 'ADMIN')));
  assert.equal(typesCompteProposes(true, true).some((type) => type.valeur === 'SUPERADMIN'), true, 'le super administrateur reste proposé');
  assert.equal(typesCompteProposes(true, true).length, 9);
  // Valeur par défaut, et false explicite : inchangées.
  assert.deepEqual(typesCompteProposes(false), neuf);
  assert.deepEqual(typesCompteProposes(false, false), neuf);
  assert.deepEqual(typesCompteProposes(true), enObjets(ATTENDUS));
  assert.deepEqual(typesCompteProposes(true, false), enObjets(ATTENDUS));
  // Proposer ne modifie pas la table : « Administrateur » garde son libellé (une ligne déjà administrateur l'affiche).
  assert.equal(TYPES_COMPTE.length, 10);
  assert.equal(roleLabel('ADMIN'), 'Administrateur');
});
