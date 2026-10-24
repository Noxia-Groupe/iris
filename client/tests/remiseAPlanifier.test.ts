import assert from 'node:assert/strict';
import test from 'node:test';
import { MOTIF_REMISE_MAX, MOTIF_REMISE_MIN, motifRemiseValide, visiteRemettable } from '../src/lib/remiseAPlanifier.ts';

// Remise « à planifier » d'une visite de contrat (décision de Nelson du 23-10-2026, nuit, réponse 2).
test('le motif de la remise compte de 3 à 500 caractères, sans caractère de contrôle, espaces de bord retirées', () => {
  assert.equal(MOTIF_REMISE_MIN, 3);
  assert.equal(MOTIF_REMISE_MAX, 500);
  assert.equal(motifRemiseValide('  Client absent  '), 'Client absent');
  assert.equal(motifRemiseValide('abc'), 'abc');
  assert.equal(motifRemiseValide('👍ab'), '👍ab', 'un emoji compte pour un caractère');
  assert.equal(motifRemiseValide('m'.repeat(500)), 'm'.repeat(500));
  assert.equal(motifRemiseValide('m'.repeat(501)), null);
  assert.equal(motifRemiseValide('  ab  '), null);
  assert.equal(motifRemiseValide(''), null);
  assert.equal(motifRemiseValide('abc\u0007def'), null, 'caractère de contrôle');
  assert.equal(motifRemiseValide('abc​def'), null, 'caractère de mise en forme');
  assert.equal(motifRemiseValide('abc\ud800def'), null, 'demi-paire de substitution');
  assert.equal(motifRemiseValide('Ligne 1\nLigne 2'), null, 'un retour à la ligne est un caractère de contrôle, comme pour le motif d’un contrat');
});

test('seule une visite de contrat planifiée se remet « à planifier »', () => {
  assert.equal(visiteRemettable({ statut: 'PLANIFIEE', contratMaintenanceId: 'c1' }), true);
  for (const statut of ['A_PLANIFIER', 'EN_COURS', 'TERMINEE', 'ANNULEE']) {
    assert.equal(visiteRemettable({ statut, contratMaintenanceId: 'c1' }), false, statut);
  }
  assert.equal(visiteRemettable({ statut: 'PLANIFIEE', contratMaintenanceId: null }), false, 'curative');
  assert.equal(visiteRemettable({ statut: 'PLANIFIEE' }), false);
  assert.equal(visiteRemettable(null), false, 'affectation sans intervention');
  assert.equal(visiteRemettable(undefined), false);
});
