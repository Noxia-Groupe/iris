import assert from 'node:assert/strict';
import test from 'node:test';
import { companyDateInputValue, decalerReference, formatCompanyDate, formatCompanyDateTime, formatDateOnly, jourCivilChantier, jourCivilChantierIso, jourCivilEntrepriseIso, joursCivilsEntre } from '../src/lib/dateFormatting.ts';

test('formatDateOnly always preserves a date-only value in UTC', () => {
  assert.equal(formatDateOnly('2026-01-01T00:00:00.000Z'), '01/01/2026');
});

test('formatCompanyDateTime renders an instant in the supplied company timezone', () => {
  assert.equal(
    formatCompanyDateTime('2026-01-01T00:30:00.000Z', 'America/Toronto'),
    '31/12/2025 19:30:00',
  );
});

test('formatCompanyDate derives the date of an instant from the company timezone', () => {
  assert.equal(formatCompanyDate('2026-01-01T00:30:00.000Z', 'America/Toronto'), '31/12/2025');
});

test('jourCivilChantier lit une date-seule telle quelle et un instant dans le fuseau de l’entreprise', () => {
  // Date corrigée à la main : minuit UTC, quel que soit le fuseau.
  assert.equal(jourCivilChantier('2026-10-14T00:00:00.000Z', 'America/Toronto'), '14-10-2026');
  // Chantier converti le 15-10 à 00:30 à Paris : instant 2026-10-14T22:30Z.
  assert.equal(jourCivilChantier('2026-10-14T22:30:00.000Z', 'Europe/Paris'), '15-10-2026');
  assert.equal(jourCivilChantier('2026-10-14T22:30:00.000Z', 'UTC'), '14-10-2026');
});

// Décision de Nelson (14-10-2026) : « aujourd'hui » est le jour de la société, pas celui d'UTC
// ni du navigateur (les tests tournent sous TZ=Pacific/Gambier, UTC-9).
test('jourCivilEntrepriseIso et companyDateInputValue donnent le jour de la société', () => {
  // 31-10-2026 à 23:30 UTC : déjà le 1er novembre à Paris, encore le 31 en UTC et à Gambier.
  const instant = new Date('2026-10-31T23:30:00.000Z');
  assert.equal(jourCivilEntrepriseIso('Europe/Paris', instant), '2026-11-01');
  assert.equal(jourCivilEntrepriseIso('UTC', instant), '2026-10-31');
  assert.equal(companyDateInputValue('Europe/Paris', instant), '01-11-2026');
  // Nouméa (UTC+11) : la matinée y est la veille en UTC.
  assert.equal(jourCivilEntrepriseIso('Pacific/Noumea', new Date('2026-10-14T21:00:00.000Z')), '2026-10-15');
  // Cayenne (UTC-3) : la soirée y est le lendemain en UTC.
  assert.equal(jourCivilEntrepriseIso('America/Cayenne', new Date('2026-10-15T01:00:00.000Z')), '2026-10-14');
});

test('decalerReference ne déborde pas d’un mois depuis le 31, ni d’une année depuis un 29 février', () => {
  assert.equal(decalerReference('2026-10-31', 'month', 1), '2026-11-01');
  assert.equal(decalerReference('2026-01-31', 'month', 1), '2026-02-01');
  assert.equal(decalerReference('2026-03-31', 'month', -1), '2026-02-01');
  assert.equal(decalerReference('2026-12-15', 'month', 1), '2027-01-01');
  assert.equal(decalerReference('2026-11-30', 'quarter', 1), '2027-02-01');
  assert.equal(decalerReference('2028-02-29', 'year', 1), '2029-02-01');
  assert.equal(decalerReference('2026-10-31', 'week', 1), '2026-11-07');
  assert.equal(decalerReference('2026-03-02', 'week', -1), '2026-02-23');
});

test('joursCivilsEntre compte des jours civils, et non des tranches de 24 h', () => {
  assert.equal(joursCivilsEntre('2026-10-15', '2026-10-16'), 1);
  // Passage à l'heure d'hiver (25-10-2026) et changement d'année : toujours des jours entiers.
  assert.equal(joursCivilsEntre('2026-10-24', '2026-10-26'), 2);
  assert.equal(joursCivilsEntre('2026-12-31', '2027-01-01'), 1);
  assert.equal(joursCivilsEntre('2026-10-16', '2026-10-16'), 0);
  // Début à 00:30 à Paris (22:30 UTC la veille), lu le lendemain à 23:00 : 46 h 30 se sont
  // écoulées, mais un seul jour civil (des tranches de 24 h arrondies en donnaient 2).
  const debut = jourCivilChantierIso('2026-10-14T22:30:00.000Z', 'Europe/Paris');
  const aujourdhui = jourCivilEntrepriseIso('Europe/Paris', new Date('2026-10-16T21:00:00.000Z'));
  assert.deepEqual([debut, aujourdhui], ['2026-10-15', '2026-10-16']);
  assert.equal(joursCivilsEntre(debut, aujourdhui), 1);
});
