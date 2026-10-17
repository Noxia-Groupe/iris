import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centimesSaisis, libelleMoyen, repartirReglement, saisieDeCentimes, situationReglement } from '../src/lib/reglements.ts';

const euros = (montant: number) => `${montant.toFixed(2).replace('.', ',')} €`;

test('montant saisi : virgule ou point, deux décimales au plus, en centimes exacts', () => {
  assert.equal(centimesSaisis('50'), 5000);
  assert.equal(centimesSaisis('50,5'), 5050);
  assert.equal(centimesSaisis('1 234,56'), 123456);
  assert.equal(centimesSaisis('0.1')! + centimesSaisis('0,2')!, centimesSaisis('0,3'));
  for (const refus of ['', '-5', '1,234', '1e3', 'abc', '12,']) assert.equal(centimesSaisis(refus), null, refus);
  assert.equal(saisieDeCentimes(7000), '70,00');
  assert.equal(saisieDeCentimes(30), '0,30');
});

test('répartition : échéance la plus ancienne d’abord, surplus en trop-perçu sur la dernière', () => {
  const factures = [{ id: 'a', resteDu: 70 }, { id: 'b', resteDu: 240 }, { id: 'c', resteDu: 0.3 }];
  assert.deepEqual(repartirReglement(10000, factures), { a: 7000, b: 3000, c: 0 });
  assert.deepEqual(repartirReglement(31030, factures), { a: 7000, b: 24000, c: 30 });
  // Au-delà du total dû, le surplus va sur la dernière facture (trop-perçu, décision du 17-10-2026).
  assert.deepEqual(repartirReglement(40000, factures), { a: 7000, b: 24000, c: 9000 });
  assert.deepEqual(repartirReglement(0, factures), { a: 0, b: 0, c: 0 });
  assert.deepEqual(repartirReglement(500, []), {});
});

test('situation affichée sous le statut : partielle, soldée par avoir, trop-perçu', () => {
  assert.equal(situationReglement({ type: 'FACTURE', statut: 'EMISE', montantRegle: 0, resteDu: 120 }, euros), '');
  assert.equal(situationReglement({ type: 'FACTURE', statut: 'EMISE', montantRegle: 50, resteDu: 70 }, euros), 'Partiellement réglée');
  assert.equal(situationReglement({ type: 'FACTURE', statut: 'EMISE', montantRegle: 0, resteDu: 0 }, euros), 'Soldée par avoir');
  assert.equal(situationReglement({ type: 'FACTURE', statut: 'REGLEE', montantRegle: 120, resteDu: 0 }, euros), '');
  assert.equal(situationReglement({ type: 'FACTURE', statut: 'REGLEE', montantRegle: 120, resteDu: -12 }, euros), 'Trop-perçu : 12,00 €');
  assert.equal(situationReglement({ type: 'AVOIR', statut: 'EMISE', resteDu: null }, euros), '');
  assert.equal(situationReglement({ type: 'FACTURE', statut: 'BROUILLON', resteDu: null }, euros), '');
  assert.equal(libelleMoyen('CHEQUE'), 'Chèque');
});
