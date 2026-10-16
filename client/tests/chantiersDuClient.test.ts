import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chantiersDuClient } from '../src/lib/chantiersDuClient.ts';

const chantiers = [
  { id: 'lie', clientId: 'client-a', client: 'Ancien nom de A' },
  { id: 'autre', clientId: 'client-b', client: 'Société A' },
  { id: 'herite', clientId: null, client: 'Société A' },
  { id: 'sans-champ', client: 'Société A' },
];

test('propose les chantiers liés à la fiche du client, quel que soit leur libellé', () => {
  assert.deepEqual(chantiersDuClient(chantiers, 'client-a').map((c) => c.id), ['lie']);
});

test('ne propose ni l’homonyme d’une autre fiche, ni une affaire héritée sans fiche', () => {
  assert.deepEqual(chantiersDuClient(chantiers, 'client-b').map((c) => c.id), ['autre']);
  assert.deepEqual(chantiersDuClient(chantiers, 'client-inconnu'), []);
  assert.deepEqual(chantiersDuClient(chantiers, ''), []);
});
