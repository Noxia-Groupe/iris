import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DROITS_DEVIS, droitsApresBasculeDevis, etatDroitDevis } from '../src/lib/droitDevis.ts';

test('commercial : droit devis du type de compte, case cochée et grisée', () => {
  assert.deepEqual(etatDroitDevis(['chantiers:read', 'clients:read', 'devis:read', 'devis:write'], []), { coche: true, vientDuRole: true });
  // Un droit individuel redondant n'ouvre pas le retrait : devis:write vient toujours du type de compte.
  assert.deepEqual(etatDroitDevis(['clients:read', 'devis:read', 'devis:write'], ['devis:read']), { coche: true, vientDuRole: true });
});

test('conducteur : clients:read du type de compte, sans devis, case décochée et active', () => {
  assert.deepEqual(etatDroitDevis(['chantiers:read', 'chantiers:write', 'clients:read'], []), { coche: false, vientDuRole: false });
});

test('conducteur avec devis individuels, même sans clients:read individuel : case cochée et active', () => {
  const effectifs = ['chantiers:read', 'chantiers:write', 'clients:read', 'devis:read', 'devis:write'];
  assert.deepEqual(etatDroitDevis(effectifs, ['devis:read', 'devis:write']), { coche: true, vientDuRole: false });
  assert.deepEqual(etatDroitDevis(effectifs, [...DROITS_DEVIS]), { coche: true, vientDuRole: false });
});

test('décocher retire les droits devis individuels présents, cocher accorde les trois', () => {
  assert.deepEqual(droitsApresBasculeDevis(['devis:read', 'devis:write', 'chantiers:archive'], true), ['chantiers:archive']);
  assert.deepEqual(droitsApresBasculeDevis(['devis:read', 'devis:write', 'clients:read'], true), []);
  assert.deepEqual(droitsApresBasculeDevis(['chantiers:archive'], false), ['chantiers:archive', ...DROITS_DEVIS]);
  assert.deepEqual(droitsApresBasculeDevis(['clients:read'], false), ['clients:read', 'devis:read', 'devis:write']);
});
