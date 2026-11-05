import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
// lib/droits.ts, et non roles.ts : roles.ts charge api.ts, qui lit import.meta.env, introuvable sous tsx --test (N5 du
// contrôle du cadrage du lot « anomalies d'écran »). roles.ts (getCurrentRole, useCurrentRole), le menu et les six pages
// lisent le rôle par roleDuCompte : c'est elle, avec les deux aides et roleLabel, que l'on éprouve ici.
import {
  estExcluDesOperations, isAdminRole, peutConsulterPlanning, peutOuvrirAdministration, roleDuCompte, roleLabel, TYPES_COMPTE,
  type CurrentUser,
} from '../src/lib/droits.ts';

// PR A4 du lot « anomalies d'écran », #206 (cadrage, version 2, contrôlé : C1, C2, C7 et Nf). Micro-arbitrage de droits
// d'affichage (règle 5, option la plus restrictive), choix par défaut, à confirmer :
//  - une seule lecture du rôle du compte connecté, roleDuCompte(user), qui rend user?.role, ou '' s'il n'en porte pas ;
//  - un compte sans rôle n'a aucun rôle, et non celui d'un conducteur de travaux : aucun libellé (roleLabel rend ''), ni
//    planning, ni administration (les deux aides rendent false pour '', null et undefined) ;
//  - pour les dix types de compte, rien ne change.
// Le serveur reste la seule sécurité : User.role y est obligatoire, et /api/me le renvoie toujours.

// Comptes sans rôle : absents, vides, ou relus par /api/me sans leur rôle (un conducteur, avec ses permissions).
const SANS_ROLE: ReadonlyArray<readonly [string, CurrentUser | null | undefined]> = [
  ['null', null],
  ['undefined', undefined],
  ['compte vide', {}],
  ['rôle vide', { role: '' }],
  ['rôle undefined', { role: undefined }],
  ['rôle null', { role: null as unknown as string }],
  ['conducteur relu sans rôle', { id: 'ct-1', name: 'Conducteur sans rôle', email: 'ct@iris.test', permissions: ['chantiers:read', 'chantiers:write', 'clients:read'] }],
];

// Les dix types et leur accès attendu, écrits ici à part, et non relus du code : planning (fermé au commercial, au
// directeur, et depuis #179 au directeur commercial, à l'assistante commerciale et au comptable) ; administration (fermée
// en plus au technicien, lot pilote 3). Ce sont les valeurs de main avant A4, que la PR ne doit pas changer.
const ACCES: ReadonlyArray<readonly [string, { planning: boolean; administration: boolean }]> = [
  ['SUPERADMIN', { planning: true, administration: true }],
  ['ADMIN', { planning: true, administration: true }],
  ['CONDUCTEUR_TRAVAUX', { planning: true, administration: true }],
  ['RESPONSABLE', { planning: true, administration: true }],
  ['TECHNICIEN', { planning: true, administration: false }],
  ['COMMERCIAL', { planning: false, administration: false }],
  ['DIRECTEUR', { planning: false, administration: false }],
  ['DIRECTEUR_COMMERCIAL', { planning: false, administration: false }],
  ['ASSISTANTE_COMMERCIALE', { planning: false, administration: false }],
  ['COMPTABLE', { planning: false, administration: false }],
];

test('le rôle du compte connecté est celui qu’il porte, et rien s’il n’en porte pas : jamais le conducteur de travaux (#206)', () => {
  for (const [cas, compte] of SANS_ROLE) {
    // Lecture écartée, nommée : l'ancien repli `user?.role || 'CONDUCTEUR_TRAVAUX'` (roles.ts, menu.ts et les six pages).
    assert.equal(roleDuCompte(compte), '', cas);
    assert.notEqual(roleDuCompte(compte), 'CONDUCTEUR_TRAVAUX', cas);
  }
  assert.equal(roleDuCompte(), '', 'sans argument');
  // Un compte qui porte un rôle le garde tel quel, permissions ou non, pour chacun des dix types.
  for (const { valeur } of TYPES_COMPTE) {
    assert.equal(roleDuCompte({ role: valeur }), valeur, valeur);
    assert.equal(roleDuCompte({ id: 'x', name: 'Compte', role: valeur, permissions: [] }), valeur, `${valeur}, avec permissions`);
  }
  assert.equal(TYPES_COMPTE.length, 10);
  // Le rôle n'est pas déduit des permissions : un compte relu sans rôle reste sans rôle, même avec chantiers:write.
  assert.equal(roleDuCompte({ permissions: ['chantiers:read', 'chantiers:write', 'clients:read'] }), '');
  // Toujours une chaîne : les pages la comparent et la passent à roleLabel sans garde.
  for (const [cas, compte] of SANS_ROLE) assert.equal(typeof roleDuCompte(compte), 'string', cas);
});

test('un rôle absent (vide, null ou undefined) n’ouvre ni le planning ni l’administration (#206, C7)', () => {
  for (const role of ['', null, undefined]) {
    // Lecture écartée : la règle par exclusion d'avant A4, où un rôle absent passait comme un conducteur (true).
    assert.equal(peutConsulterPlanning(role), false, `planning, ${JSON.stringify(role) ?? 'undefined'}`);
    assert.equal(peutOuvrirAdministration(role), false, `administration, ${JSON.stringify(role) ?? 'undefined'}`);
  }
  assert.equal(peutConsulterPlanning(), false, 'planning, sans argument');
  assert.equal(peutOuvrirAdministration(), false, 'administration, sans argument');
  // Les règles serveur que reprennent ces aides ne connaissent pas de rôle vide : il n'est ni exclu des opérations, ni
  // administrateur. C'est le garde des deux aides qui l'écarte, et non ces règles (Nf du contrôle du cadrage).
  for (const role of ['', null, undefined]) {
    assert.equal(estExcluDesOperations(role), false);
    assert.equal(isAdminRole(role), false);
  }
});

test('pour les dix types de compte, le planning et l’administration restent ouverts ou fermés comme avant (#206)', () => {
  assert.deepEqual(ACCES.map(([role]) => role).sort(), TYPES_COMPTE.map((type) => type.valeur).sort(), 'les dix types, ni plus ni moins');
  for (const [role, { planning, administration }] of ACCES) {
    assert.equal(peutConsulterPlanning(role), planning, `planning, ${role}`);
    assert.equal(peutOuvrirAdministration(role), administration, `administration, ${role}`);
  }
});

test('un compte mémorisé sans rôle n’a, sur ses écrans, ni type affiché, ni planning, ni administration ; le même compte avec son rôle les garde (#206)', () => {
  // Chaîne des pages après A4 : rôle par roleDuCompte, type affiché par roleLabel (menu, « Connecté en tant que »), accès
  // par les deux aides (menu et PrivateRoute).
  const ecran = (compte: CurrentUser | null | undefined) => {
    const role = roleDuCompte(compte);
    return { type: roleLabel(role), planning: peutConsulterPlanning(role), administration: peutOuvrirAdministration(role), admin: isAdminRole(role) };
  };
  const sansType = { type: '', planning: false, administration: false, admin: false };
  for (const [cas, compte] of SANS_ROLE) {
    assert.deepEqual(ecran(compte), sansType, cas);
  }
  // Témoin : le même conducteur, son rôle présent, a l'écran d'un conducteur de travaux. Lecture écartée pour un compte
  // sans rôle : cet écran-là (ancien repli).
  const conducteur = { ...SANS_ROLE[6][1], role: 'CONDUCTEUR_TRAVAUX' };
  assert.deepEqual(ecran(conducteur), { type: 'Conducteur de travaux', planning: true, administration: true, admin: false });
  assert.notDeepEqual(ecran(SANS_ROLE[6][1]), ecran(conducteur));
  // Un code inconnu n'a pas non plus de libellé : ni « Conducteur » (ancien repli), ni un autre type.
  assert.equal(roleLabel(roleDuCompte({ role: 'INCONNU' })), '');
  for (const role of ['', null, undefined]) assert.equal(roleLabel(role), '', JSON.stringify(role) ?? 'undefined');
});

// Cadrage de A4, points 1 et 2 : une seule lecture du rôle, roleDuCompte, employée par roles.ts, le menu et les six pages,
// qui lisent le compte par useCurrentUser() (relu auprès de /api/me), sans JSON.parse local ni repli sur le conducteur.
// Garde sur les sources, faute de mieux : à l'écran, un repli rétabli dans les achats, les statistiques ou le planning ne
// se verrait pas, puisque PrivateRoute ferme d'abord ces trois écrans à un compte sans rôle (App.tsx) ; l'E2E
// compte-sans-role.spec.ts couvre le tableau de bord, la liste des chantiers, la fiche et le menu.
const racineClient = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (relatif: string) => readFileSync(path.join(racineClient, 'src', relatif), 'utf8');
// Corps d'une fonction de premier niveau : de sa déclaration à la première accolade fermante en début de ligne.
const corps = (texte: string, nom: string) => {
  const debut = texte.indexOf(`function ${nom}(`);
  assert.notEqual(debut, -1, `fonction ${nom} introuvable`);
  return texte.slice(debut, texte.indexOf('\n}', debut) + 2);
};
const REPLI_CONDUCTEUR = /(\|\||\?\?)\s*(ROLE_CONDUCTEUR\b|['"]CONDUCTEUR_TRAVAUX['"])/;

test('les six pages, le menu et roles.ts lisent le rôle par roleDuCompte, sans lecture locale du compte ni repli sur le conducteur (#206)', () => {
  for (const page of ['Dashboard', 'Statistiques', 'Achats', 'ListeChantiers', 'Planning', 'ChantierDetail']) {
    const texte = source(`pages/${page}.tsx`);
    assert.match(texte, /\buseCurrentUser\(\)/, `${page} : compte lu par useCurrentUser()`);
    assert.match(texte, /\broleDuCompte\(/, `${page} : rôle lu par roleDuCompte`);
    assert.doesNotMatch(texte, /localStorage/, `${page} : aucune lecture locale du compte`);
    assert.doesNotMatch(texte, /JSON\.parse/, `${page} : aucun JSON.parse local`);
    assert.doesNotMatch(texte, REPLI_CONDUCTEUR, `${page} : aucun repli sur le conducteur`);
  }
  const roles = source('roles.ts');
  for (const nom of ['getCurrentRole', 'useCurrentRole']) {
    assert.match(corps(roles, nom), /return roleDuCompte\(/, `roles.ts, ${nom} : par roleDuCompte`);
  }
  assert.doesNotMatch(roles, REPLI_CONDUCTEUR, 'roles.ts : aucun repli sur le conducteur');
  const menu = source('lib/menu.ts');
  assert.match(corps(menu, 'sectionsMenu'), /const role = roleDuCompte\(user\);/, 'menu : rôle par roleDuCompte');
  assert.doesNotMatch(menu, REPLI_CONDUCTEUR, 'menu : aucun repli sur le conducteur');
  // La fiche chantier lit aussi ses permissions sur le compte relu, et non sur une copie à part.
  assert.match(source('pages/ChantierDetail.tsx'), /const permissions = currentUser\?\.permissions \|\| \[\];/);
  // Témoin du motif : il reconnaît bien les quatre formes de l'ancien repli.
  for (const ancien of ["user?.role || 'CONDUCTEUR_TRAVAUX'", 'user?.role || ROLE_CONDUCTEUR', 'role ?? ROLE_CONDUCTEUR', 'r || "CONDUCTEUR_TRAVAUX"']) {
    assert.match(ancien, REPLI_CONDUCTEUR, ancien);
  }
});
