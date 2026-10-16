import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientLisible, estChangementClient, titreEntreeJournal } from '../src/lib/journalChantier.ts';

test('titre des entrées : saisies Travaux et changement de client', () => {
  assert.equal(titreEntreeJournal({ cible: 'ACHAT', action: 'CORRECTION' }), 'Achat — correction');
  assert.equal(titreEntreeJournal({ cible: 'HEURE', action: 'ARCHIVAGE' }), 'Heures — archivage');
  assert.equal(titreEntreeJournal({ cible: 'CHANTIER', action: 'CHANGEMENT_CLIENT' }), 'Client de l’affaire — changement');
  assert.equal(estChangementClient({ cible: 'CHANTIER', action: 'CHANGEMENT_CLIENT' }), true);
  assert.equal(estChangementClient({ cible: 'ACHAT', action: 'CHANGEMENT_CLIENT' }), false);
  assert.equal(estChangementClient({ cible: 'CHANTIER', action: 'CORRECTION' }), false);
});

test('un côté du changement : la fiche, et le libellé de l’affaire s’il en diffère', () => {
  assert.equal(clientLisible({ clientId: 'a', raisonSociale: 'Société A', libelle: 'Société A' }), 'Société A');
  assert.equal(clientLisible({ clientId: 'a', raisonSociale: 'Société A', libelle: 'Ancien nom' }), 'Société A (libellé de l’affaire : « Ancien nom »)');
  assert.equal(clientLisible({ clientId: null, raisonSociale: null, libelle: 'Libellé libre' }), 'aucune fiche client liée (libellé de l’affaire : « Libellé libre »)');
  assert.equal(clientLisible(null), 'aucune fiche client liée');
});
