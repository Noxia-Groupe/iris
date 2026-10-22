import assert from 'node:assert/strict';
import test from 'node:test';
import { bilanGeneration, pluriel } from '../src/lib/generationVisites.ts';

// Génération automatique des visites (lot pilote 5) : bilan d'un passage, accordé au nombre.
test('le bilan d’un passage s’accorde au nombre de visites et d’échéances', () => {
  assert.equal(bilanGeneration({ visitesCreees: 0, echeancesAvancees: 0 }), '0 visite créée, 0 échéance avancée');
  assert.equal(bilanGeneration({ visitesCreees: 1, echeancesAvancees: 1 }), '1 visite créée, 1 échéance avancée');
  assert.equal(bilanGeneration({ visitesCreees: 2, echeancesAvancees: 3 }), '2 visites créées, 3 échéances avancées');
  assert.equal(pluriel(30, 'jour', 'jours'), '30 jours');
  assert.equal(pluriel(1, 'jour', 'jours'), '1 jour');
});
