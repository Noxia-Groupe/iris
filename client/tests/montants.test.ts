import assert from 'node:assert/strict';
import test from 'node:test';
import { arrondiCentime, arrondiEuro, coutLigneHeures, differenceExacte, sommeExacte } from '../src/lib/montants.ts';

// #198 : en nombres à virgule, 0,1 + 0,2 + 0,3 vaut 0,6000000000000001, mais 0,3 + 0,2 + 0,1 vaut 0,6.

test('une somme de montants est exacte, quel que soit l’ordre des lignes', () => {
  for (const valeurs of [[0.1, 0.2, 0.3], [0.3, 0.2, 0.1], [0.2, 0.3, 0.1]]) {
    assert.equal(sommeExacte(valeurs), 0.6, valeurs.join(' + '));
  }
  assert.equal(sommeExacte([]), 0);
  assert.equal(sommeExacte([1234567.89, -0.01, 0.12]), 1234568);
  // Coûts de main-d'œuvre (heures × taux) : quatre décimales.
  assert.equal(sommeExacte([0.0001, 0.0002], 4), 0.0003);
  assert.equal(sommeExacte(new Set([12.25, 12.25]).values()), 12.25, 'accepte tout itérable');
});

test('un écart au budget vaut zéro quand le budget est exactement consommé', () => {
  assert.equal(differenceExacte(0.6, 0.1 + 0.2 + 0.3), 0);
  assert.equal(differenceExacte(10, 8.8, 2), 1.2);
  assert.equal(differenceExacte(0.0001, 0.0003), -0.0002);
});

test('arrondi à l’euro : moitié vers l’extérieur, jamais « -0 »', () => {
  assert.equal(arrondiEuro(12.5), 13);
  assert.equal(arrondiEuro(-12.5), -13, 'Math.round donnerait -12');
  assert.equal(arrondiEuro(12.49), 12);
  assert.equal(arrondiEuro(-12.49), -12);
  // 0,01 + 2,01 + 0,48 vaut 2,50 €, mais 2,4999999999999996 en flottant : Math.round donnait 2 €.
  assert.equal(0.01 + 2.01 + 0.48, 2.4999999999999996, 'témoin : l’erreur corrigée');
  assert.equal(arrondiEuro(sommeExacte([0.01, 2.01, 0.48])), 3);
  assert.equal(arrondiEuro(0.01 + 2.01 + 0.48), 3, 'même un total flottant reçu tel quel');
  assert.ok(Object.is(arrondiEuro(-0.4), 0), 'pas de zéro négatif');
  assert.equal(arrondiEuro(-0.4).toLocaleString('fr-FR'), '0');
  assert.equal(arrondiEuro(1234567.5), 1234568);
});

test('arrondi au centime : moitié vers l’extérieur, sur des montants à quatre décimales', () => {
  assert.equal(arrondiCentime(1.005), 1.01, '1,005 × 100 vaut 100,4999… en flottant');
  assert.equal(arrondiCentime(-1.005), -1.01);
  assert.equal(arrondiCentime(1.0049), 1);
  assert.equal(arrondiCentime(8.8), 8.8);
  assert.ok(Object.is(arrondiCentime(-0.004), 0), 'pas de zéro négatif');
  assert.equal(arrondiCentime(0.1 + 0.2), 0.3);
});

test('coût d’une ligne d’heures : produit exact, arrondi au centime supérieur à la moitié', () => {
  assert.equal(coutLigneHeures(2.5, 0.41), 1.03, '1,025 € ; toFixed(2) donnerait 1,02 €');
  assert.equal((2.5 * 0.41).toFixed(2), '1.02', 'témoin : l’erreur corrigée');
  assert.equal(coutLigneHeures(1.1, 1.1), 1.21);
  assert.equal(coutLigneHeures(7.75, 42.5), 329.38);
  assert.equal(coutLigneHeures(0, 42), 0);
});
