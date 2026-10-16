import assert from 'node:assert/strict';
import test from 'node:test';
import { estWeekEnd, formatFr, joursDeLaSemaine, lundiDe, numeroSemaineIso } from '../src/planningUtils.ts';

// Le planning raisonne en jours AAAA-MM-JJ, sans l'horloge ni le fuseau du navigateur (les tests
// tournent sous TZ=Pacific/Gambier, UTC-9, où une date locale glisserait d'un jour).
test('lundiDe et joursDeLaSemaine calculent la semaine d’un jour, sans fuseau', () => {
  assert.equal(lundiDe('2026-10-14'), '2026-10-12');
  assert.equal(lundiDe('2026-10-18'), '2026-10-12', 'le dimanche termine la semaine');
  assert.equal(lundiDe('2026-10-19'), '2026-10-19');
  assert.equal(lundiDe('2027-01-01'), '2026-12-28');
  assert.deepEqual(joursDeLaSemaine('2026-10-26'), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
});

test('estWeekEnd et numeroSemaineIso suivent le calendrier civil', () => {
  assert.equal(estWeekEnd('2026-10-17'), true);
  assert.equal(estWeekEnd('2026-10-18'), true);
  assert.equal(estWeekEnd('2026-10-19'), false);
  assert.equal(numeroSemaineIso('2026-10-14'), 42);
  // Un dimanche appartient à la semaine ISO de son lundi.
  assert.equal(numeroSemaineIso('2026-10-18'), 42);
  assert.equal(numeroSemaineIso('2027-01-03'), 53);
  assert.equal(numeroSemaineIso('2027-01-01'), 53, 'le 1er janvier 2027 appartient à la semaine 53 de 2026');
  assert.equal(numeroSemaineIso('2026-12-28'), 53);
  assert.equal(numeroSemaineIso('2027-01-04'), 1);
});

// Décision de Nelson (14-10-2026) : toutes les dates s'affichent au format JJ-MM-AAAA.
test('formatFr affiche un jour AAAA-MM-JJ au format JJ-MM-AAAA', () => {
  assert.equal(formatFr('2026-10-05'), '05-10-2026');
});
