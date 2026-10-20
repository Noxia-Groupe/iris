import assert from 'node:assert/strict';
import test from 'node:test';
import { TRACE_MAX_POINTS, TRACE_MAX_TRAITS, cheminsSvg, commencerTrait, nombreDePoints, pointNormalise, prolongerTrait, traceSuffisant, type Point } from '../src/lib/traceSignature.ts';

// Lot pilote 3b-3 : la signature dessinée est gardée en coordonnées normalisées, arrondies au
// dix-millième, sans horodatage ni pression, dans les bornes que le serveur vérifie.

test('un point de la zone de dessin est normalisé entre 0 et 1, au dix-millième', () => {
  assert.deepEqual(pointNormalise(150, 40, 300, 160), [0.5, 0.25]);
  assert.deepEqual(pointNormalise(100, 53, 300, 160), [0.3333, 0.3313]);
  // Un pointeur capturé peut sortir de la zone : le point reste au bord.
  assert.deepEqual(pointNormalise(-12, 400, 300, 160), [0, 1]);
});

test('un trait omet les points trop proches du précédent, mesurés à l’échelle de la largeur', () => {
  const traits: Point[][] = [];
  assert.equal(commencerTrait(traits, [0.1, 0.1]), true);
  // 0,002 en largeur : sous le pas, omis.
  assert.equal(prolongerTrait(traits, [0.102, 0.1], 2), true);
  // 0,004 en hauteur vaut 0,002 en largeur pour une zone deux fois plus large que haute : omis.
  assert.equal(prolongerTrait(traits, [0.1, 0.104], 2), true);
  assert.deepEqual(traits, [[[0.1, 0.1]]]);
  // 0,01 en hauteur vaut 0,005 en largeur : gardé.
  assert.equal(prolongerTrait(traits, [0.1, 0.11], 2), true);
  assert.equal(prolongerTrait(traits, [0.2, 0.11], 2), true);
  assert.deepEqual(traits, [[[0.1, 0.1], [0.1, 0.11], [0.2, 0.11]]]);
  // Sans trait commencé, aucun point ne s'ajoute.
  assert.equal(prolongerTrait([], [0.5, 0.5], 2), false);
});

test('le tracé s’arrête à ses bornes : 50 traits et 2 000 points', () => {
  const traits: Point[][] = [];
  for (let i = 0; i < TRACE_MAX_TRAITS; i += 1) assert.equal(commencerTrait(traits, [0, 0]), true);
  assert.equal(commencerTrait(traits, [0, 0]), false, 'cinquante et unième trait');
  assert.equal(traits.length, TRACE_MAX_TRAITS);

  const long: Point[][] = [[[0, 0]]];
  for (let i = 1; i < TRACE_MAX_POINTS; i += 1) assert.equal(prolongerTrait(long, [i / TRACE_MAX_POINTS, (i % 2) * 0.5], 2), true);
  assert.equal(nombreDePoints(long), TRACE_MAX_POINTS);
  assert.equal(prolongerTrait(long, [0.9999, 0.9], 2), false, 'deux mille et unième point');
  assert.equal(commencerTrait(long, [0.5, 0.5]), false, 'nouveau trait au-delà des points');
  assert.equal(nombreDePoints(long), TRACE_MAX_POINTS);
});

test('un simple appui n’est pas une signature : il faut deux points distincts', () => {
  assert.equal(traceSuffisant([]), false);
  assert.equal(traceSuffisant([[[0.4, 0.4]]]), false);
  assert.equal(traceSuffisant([[[0.4, 0.4], [0.4, 0.4]], [[0.2, 0.2]]]), false);
  assert.equal(traceSuffisant([[[0.4, 0.4]], [[0.2, 0.2], [0.3, 0.2]]]), true);
});

test('le tracé se redessine en SVG à ses proportions', () => {
  assert.deepEqual(cheminsSvg({ ratio: 2, traits: [[[0, 0], [0.5, 0.25], [1, 1]], [[0.25, 0.5]]] }), [
    'M0.0 0.0 L100.0 25.0 L200.0 100.0',
    'M50.0 50.0 l0.1 0',
  ]);
});
