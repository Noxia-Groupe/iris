import assert from 'node:assert/strict';
import test from 'node:test';
import { interventionRemettable } from '../src/lib/remiseAPlanifier.ts';
import { MOTIF_INTERVENTION_MAX, MOTIF_INTERVENTION_MIN, designationIntervention, motifInterventionValide } from '../src/lib/motifIntervention.ts';

// Remise « à planifier » d'une intervention planifiée et annulation depuis sa fiche (décisions de Nelson du
// 23-10-2026, nuit, réponse 2, et du 24-10-2026 : curatives comprises, motif obligatoire pour les deux).
// Modifié par le lot du 24-10-2026 : la règle du motif, commune à la remise et à l'annulation, est
// renommée (motifInterventionValide, dans lib/motifIntervention.ts), sans changer.
test('le motif de la remise et de l’annulation compte de 3 à 500 caractères, sans caractère de contrôle, espaces de bord retirées', () => {
  assert.equal(MOTIF_INTERVENTION_MIN, 3);
  assert.equal(MOTIF_INTERVENTION_MAX, 500);
  assert.equal(motifInterventionValide('  Client absent  '), 'Client absent');
  assert.equal(motifInterventionValide('abc'), 'abc');
  assert.equal(motifInterventionValide('👍ab'), '👍ab', 'un emoji compte pour un caractère');
  assert.equal(motifInterventionValide('m'.repeat(500)), 'm'.repeat(500));
  assert.equal(motifInterventionValide('m'.repeat(501)), null);
  assert.equal(motifInterventionValide('  ab  '), null);
  assert.equal(motifInterventionValide(''), null);
  assert.equal(motifInterventionValide('abc\u0007def'), null, 'caractère de contrôle');
  assert.equal(motifInterventionValide('abc​def'), null, 'caractère de mise en forme');
  assert.equal(motifInterventionValide('abc\ud800def'), null, 'demi-paire de substitution');
  assert.equal(motifInterventionValide('Ligne 1\nLigne 2'), null, 'un retour à la ligne est un caractère de contrôle, comme pour le motif d’un contrat');
});

// Modifié par le lot du 24-10-2026 : une curative planifiée se remet aussi (décision de Nelson, point 1).
test('toute intervention planifiée, visite de contrat ou curative, se remet « à planifier »', () => {
  assert.equal(interventionRemettable({ statut: 'PLANIFIEE', contratMaintenanceId: 'c1' }), true, 'visite');
  assert.equal(interventionRemettable({ statut: 'PLANIFIEE', contratMaintenanceId: null }), true, 'curative');
  assert.equal(interventionRemettable({ statut: 'PLANIFIEE' }), true, 'curative sans le champ');
  for (const statut of ['A_PLANIFIER', 'EN_COURS', 'TERMINEE', 'ANNULEE']) {
    assert.equal(interventionRemettable({ statut, contratMaintenanceId: 'c1' }), false, `visite ${statut}`);
    assert.equal(interventionRemettable({ statut, contratMaintenanceId: null }), false, `curative ${statut}`);
  }
  assert.equal(interventionRemettable(null), false, 'affectation sans intervention');
  assert.equal(interventionRemettable(undefined), false);
});

test('l’écran nomme la visite d’un contrat et l’intervention curative', () => {
  assert.equal(designationIntervention({ contratMaintenanceId: 'c1' }), 'la visite');
  assert.equal(designationIntervention({ contratMaintenanceId: null }), 'l’intervention');
  assert.equal(designationIntervention({}), 'l’intervention');
});
