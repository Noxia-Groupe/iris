import assert from 'node:assert/strict';
import test from 'node:test';
import { dateDuJour } from './e2e/fixtures.ts';

test('dateDuJour uses the company civil day at 22:30 UTC, not the runner local day', (t) => {
  // At 22:30 UTC on June 30, Paris (summer UTC+2) is July 1; UTC and Gambier are June 30.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-06-30T22:30:00.000Z') });
  assert.equal(dateDuJour(), '01-07-2026');
});
