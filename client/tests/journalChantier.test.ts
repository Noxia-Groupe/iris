import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changementAffaire, clientLisible, titreEntreeJournal } from '../src/lib/journalChantier.ts';

test('titre des entrées : saisies Travaux et changement de client', () => {
  assert.equal(titreEntreeJournal({ cible: 'ACHAT', action: 'CORRECTION' }), 'Achat — correction');
  assert.equal(titreEntreeJournal({ cible: 'HEURE', action: 'ARCHIVAGE' }), 'Heures — archivage');
  assert.equal(titreEntreeJournal({ cible: 'CHANTIER', action: 'CHANGEMENT_CLIENT' }), 'Client de l’affaire — changement');
  assert.notEqual(changementAffaire({ cible: 'CHANTIER', action: 'CHANGEMENT_CLIENT' }), null);
  assert.equal(changementAffaire({ cible: 'ACHAT', action: 'CHANGEMENT_CLIENT' }), null);
  assert.equal(changementAffaire({ cible: 'CHANTIER', action: 'CORRECTION' }), null);
});

test('un côté du changement : la fiche, et le libellé de l’affaire s’il en diffère', () => {
  assert.equal(clientLisible({ clientId: 'a', raisonSociale: 'Société A', libelle: 'Société A' }), 'Société A');
  assert.equal(clientLisible({ clientId: 'a', raisonSociale: 'Société A', libelle: 'Ancien nom' }), 'Société A (libellé de l’affaire : « Ancien nom »)');
  assert.equal(clientLisible({ clientId: null, raisonSociale: null, libelle: 'Libellé libre' }), 'aucune fiche client liée (libellé de l’affaire : « Libellé libre »)');
  assert.equal(clientLisible(null), 'aucune fiche client liée');
});

// #181 : réattributions du titulaire et du commercial, et case « Encaissé », au journal de la fiche.
test('les changements de titulaire, de commercial et d’encaissement se lisent des deux côtés', () => {
  assert.equal(titreEntreeJournal({ cible: 'CHANTIER', action: 'CHANGEMENT_TITULAIRE' }), 'Titulaire — réattribution');
  assert.equal(titreEntreeJournal({ cible: 'CHANTIER', action: 'CHANGEMENT_COMMERCIAL' }), 'Commercial — réattribution');
  assert.equal(titreEntreeJournal({ cible: 'CHANTIER', action: 'CHANGEMENT_ENCAISSEMENT' }), 'Encaissement — changement');
  assert.deepEqual(changementAffaire({ cible: 'CHANTIER', action: 'CHANGEMENT_TITULAIRE', avant: { responsableId: 'a', nom: 'Alice' }, apres: { responsableId: 'b', nom: 'Bruno' } }), { avant: 'Alice', apres: 'Bruno' });
  assert.deepEqual(changementAffaire({ cible: 'CHANTIER', action: 'CHANGEMENT_COMMERCIAL', avant: { commercialId: null, nom: null }, apres: { commercialId: 'c', nom: null } }), { avant: 'aucun commercial', apres: 'compte supprimé' });
  assert.deepEqual(changementAffaire({ cible: 'CHANTIER', action: 'CHANGEMENT_ENCAISSEMENT', avant: { encaisse: false, dateEncaissement: null }, apres: { encaisse: true, dateEncaissement: '2026-10-21T08:00:00.000Z' } }), { avant: 'Non encaissé', apres: 'Encaissé' });
  assert.deepEqual(changementAffaire({ cible: 'CHANTIER', action: 'CHANGEMENT_CLIENT', avant: { raisonSociale: 'A', libelle: 'A' }, apres: { raisonSociale: 'B', libelle: 'B' } }), { avant: 'A', apres: 'B' });
  // Une saisie Travaux n'est pas un changement de l'affaire, même avec un nom d'action voisin.
  assert.equal(changementAffaire({ cible: 'ACHAT', action: 'CORRECTION' }), null);
  assert.equal(changementAffaire({ cible: 'ACHAT', action: 'CHANGEMENT_TITULAIRE' }), null);
  assert.equal(titreEntreeJournal({ cible: 'HEURE', action: 'CHANGEMENT_TITULAIRE' }), 'Heures — changement_titulaire');
});
