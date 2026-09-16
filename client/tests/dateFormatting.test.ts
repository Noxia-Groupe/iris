import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCompanyDate, formatCompanyDateTime, formatDateOnly } from '../src/lib/dateFormatting.ts';

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
