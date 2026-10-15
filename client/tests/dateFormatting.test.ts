import assert from 'node:assert/strict';
import test from 'node:test';
import { companyDateInputValue, decalerReference, formatCompanyDate, formatCompanyDateTime, formatDateOnly, instantaneLisible, jourCivilChantier, jourCivilChantierIso, jourCivilEntrepriseIso, joursCivilsEntre, jourFrancais, jourSemaineFrancais } from '../src/lib/dateFormatting.ts';

// Décision de Nelson (14-10-2026) : toutes les dates s'affichent au format JJ-MM-AAAA.
test('formatDateOnly always preserves a date-only value in UTC, au format JJ-MM-AAAA', () => {
  assert.equal(formatDateOnly('2026-01-01T00:00:00.000Z'), '01-01-2026');
});

test('formatCompanyDateTime renders an instant in the supplied company timezone', () => {
  assert.equal(
    formatCompanyDateTime('2026-01-01T00:30:00.000Z', 'America/Toronto'),
    '31-12-2025 19:30:00',
  );
});

test('formatCompanyDate derives the date of an instant from the company timezone', () => {
  assert.equal(formatCompanyDate('2026-01-01T00:30:00.000Z', 'America/Toronto'), '31-12-2025');
});

test('jourFrancais et jourSemaineFrancais affichent un jour AAAA-MM-JJ au format JJ-MM-AAAA', () => {
  assert.equal(jourFrancais('2026-10-05'), '05-10-2026');
  assert.equal(jourFrancais('2026-10-05T00:00:00.000Z'), '05-10-2026');
  // Le jour de la semaine ne dépend pas du fuseau du navigateur (tests sous TZ=Pacific/Gambier).
  assert.equal(jourSemaineFrancais('2026-10-05'), 'lun. 05-10-2026');
  assert.equal(jourSemaineFrancais('2026-10-11', 'long'), 'dimanche 11-10-2026');
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

test('instantaneLisible rend une date-seule en JJ-MM-AAAA et un instant au jour et à l’heure de la société', () => {
  const instantane = { date: '2026-10-15T00:00:00.000Z', createdAt: '2026-10-14T13:30:00.000Z', heures: 7.5, commentaire: '2026-10-14 noté à la main' };
  assert.equal(
    instantaneLisible(instantane, 'Pacific/Noumea'),
    '{"date":"15-10-2026","createdAt":"15-10-2026 00:30","heures":7.5,"commentaire":"2026-10-14 noté à la main"}',
  );
  assert.equal(instantaneLisible({ createdAt: '2026-10-14T13:30:00Z' }, 'Europe/Paris'), '{"createdAt":"14-10-2026 15:30"}');
  // Le champ décide : une date métier écrite sans millisecondes reste une date-seule, sans heure
  // ajoutée, et un horodatage à minuit UTC pile garde son heure.
  assert.equal(instantaneLisible({ date: '2026-10-15T00:00:00Z' }, 'Pacific/Tahiti'), '{"date":"15-10-2026"}');
  assert.equal(instantaneLisible({ createdAt: '2026-10-14T00:00:00.000Z' }, 'Pacific/Noumea'), '{"createdAt":"14-10-2026 11:00"}');
});

test('instantaneLisible ne convertit que les champs de date, et jamais une valeur invalide', () => {
  // Un texte libre qui ressemble à une date reste tel qu'il a été saisi.
  assert.equal(
    instantaneLisible({ description: '2026-10-14T13:30:00Z', commentaire: '2026-13-01T10:00:00Z' }, 'Europe/Paris'),
    '{"description":"2026-10-14T13:30:00Z","commentaire":"2026-13-01T10:00:00Z"}',
  );
  // Une date invalide, même dans un champ de date, n'est pas interprétée (et ne lève rien), ni une
  // date qui déborde (30 février, 24:00, 31 avril), que Date accepterait en la décalant.
  assert.equal(instantaneLisible({ date: '2026-13-01T10:00:00Z', createdAt: '2026-10-14T25:00:00Z' }, 'Europe/Paris'), '{"date":"2026-13-01T10:00:00Z","createdAt":"2026-10-14T25:00:00Z"}');
  assert.equal(
    instantaneLisible({ date: '2026-02-30T00:00:00.000Z', createdAt: '2026-10-14T24:00:00Z', archivedAt: '2026-04-31T10:00:00Z' }, 'Europe/Paris'),
    '{"date":"2026-02-30T00:00:00.000Z","createdAt":"2026-10-14T24:00:00Z","archivedAt":"2026-04-31T10:00:00Z"}',
  );
  assert.equal(instantaneLisible({ archivedAt: '2026-10-14T13:30:00.000Z', updatedAt: null }, 'Europe/Paris'), '{"archivedAt":"14-10-2026 15:30","updatedAt":null}');
});
