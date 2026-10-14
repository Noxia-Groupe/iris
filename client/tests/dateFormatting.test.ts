import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCompanyDate, formatCompanyDateTime, formatDateOnly, jourCivilChantier } from '../src/lib/dateFormatting.ts';

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
