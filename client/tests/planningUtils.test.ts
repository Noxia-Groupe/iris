import assert from 'node:assert/strict';
import test from 'node:test';
import { estWeekEnd, formatFr, joursDeLaSemaine, lignesDuPlanning, lundiDe, numeroSemaineIso } from '../src/planningUtils.ts';

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

// Planning limité à ce dont il est chargé (décision de Nelson du 19-10-2026) : le technicien ne voit
// que la ligne de la fiche reliée à son compte ; l'encadrement voit toute l'équipe.
test('lignesDuPlanning réduit la grille du technicien à sa propre fiche', () => {
  const equipe = [
    { id: 'f1', nom: 'Alice', userId: 'u1' },
    { id: 'f2', nom: 'Bruno', userId: 'u2' },
    { id: 'f3', nom: 'Externe', userId: null },
    { id: 'f4', nom: 'Historique' },
  ];
  assert.deepEqual(lignesDuPlanning(equipe, null).map((i) => i.id), ['f1', 'f2', 'f3', 'f4'], 'encadrement : toute l’équipe');
  assert.deepEqual(lignesDuPlanning(equipe, { id: 'u2' }).map((i) => i.id), ['f2']);
  assert.deepEqual(lignesDuPlanning(equipe, { id: 'u9' }), [], 'sans fiche reliée, aucune ligne');
  assert.deepEqual(lignesDuPlanning(equipe, {}), [], 'sans identifiant, aucune ligne, pas même les fiches sans compte');
  assert.deepEqual(lignesDuPlanning(equipe, { id: undefined }), []);
});
