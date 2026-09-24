import assert from 'node:assert/strict';
import test from 'node:test';
import { archivagesRestaurables } from '../src/lib/archivesRestaurables.ts';

const entree = (id: string, action: string, cibleId = 'a1', cible = 'ACHAT') => ({ id, cible, cibleId, action });

test('une écriture archivée propose la restauration sur son archivage', () => {
  assert.deepEqual([...archivagesRestaurables([entree('j2', 'ARCHIVAGE'), entree('j1', 'CREATION')])], ['j2']);
});

test('une écriture restaurée ne propose plus rien', () => {
  const journal = [entree('j3', 'RESTAURATION'), entree('j2', 'ARCHIVAGE'), entree('j1', 'CREATION')];
  assert.equal(archivagesRestaurables(journal).size, 0);
});

test('seul le dernier archivage d’une écriture ré-archivée est restaurable', () => {
  const journal = [entree('j4', 'ARCHIVAGE'), entree('j3', 'RESTAURATION'), entree('j2', 'ARCHIVAGE'), entree('j1', 'CREATION')];
  assert.deepEqual([...archivagesRestaurables(journal)], ['j4']);
});

test('un achat et un pointage de même identifiant ne se confondent pas', () => {
  const journal = [entree('j2', 'RESTAURATION', 'x', 'ACHAT'), entree('j1', 'ARCHIVAGE', 'x', 'HEURE'), entree('j0', 'ARCHIVAGE', 'x', 'ACHAT')];
  assert.deepEqual([...archivagesRestaurables(journal)], ['j1']);
});
