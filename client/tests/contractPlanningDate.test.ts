import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { planningDayToIso } from '../src/lib/contractPlanningDate.ts';

test('convertit un jour français valide, y compris le 29 février bissextile, en ISO pour le planning', () => {
  assert.equal(planningDayToIso('02-01-2099'), '2099-01-02');
  assert.equal(planningDayToIso('29-02-2028'), '2028-02-29');
});

test('refuse les dates inexistantes, les années non bissextiles et les formats hors JJ-MM-AAAA', () => {
  for (const value of ['31-02-2099', '29-02-2100', '31-04-2099', '1-01-2099', '2099-01-02', '00-01-2099', '01-13-2099', '01-01-0000']) {
    assert.equal(planningDayToIso(value), null, value);
  }
});
