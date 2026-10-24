import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciblesEncorePossibles, questionAnnulation, texteCible } from '../src/lib/ciblesDevis.ts';

// Lot 4 suite : au plus deux conversions par devis, de types différents.
const conversion = (cibleType: string, rang = 1) => ({ cibleType, cibleId: `${cibleType}-1`, rang });

test('un devis sans conversion propose les trois cibles', () => {
  assert.deepEqual(ciblesEncorePossibles([]), ['CHANTIER', 'INTERVENTION', 'CONTRAT']);
});

test('après une conversion, les deux autres types restent proposés', () => {
  assert.deepEqual(ciblesEncorePossibles([conversion('CHANTIER')]), ['INTERVENTION', 'CONTRAT']);
  assert.deepEqual(ciblesEncorePossibles([conversion('CONTRAT')]), ['CHANTIER', 'INTERVENTION']);
  assert.deepEqual(ciblesEncorePossibles([conversion('INTERVENTION')]), ['CHANTIER', 'CONTRAT']);
});

test('après deux conversions, plus rien n’est proposé', () => {
  assert.deepEqual(ciblesEncorePossibles([conversion('CHANTIER'), conversion('CONTRAT', 2)]), []);
  assert.deepEqual(ciblesEncorePossibles([conversion('INTERVENTION'), conversion('CHANTIER', 2)]), []);
});

test('la question d’annulation dit ce qui sera annulé avec le devis', () => {
  assert.equal(questionAnnulation([]), 'Motif de l’annulation de ce devis ?');
  assert.equal(questionAnnulation([conversion('CHANTIER')]), 'L’annulation de ce devis annule aussi son chantier.\nMotif de l’annulation de ce devis ?');
  assert.equal(questionAnnulation([conversion('INTERVENTION'), conversion('CONTRAT', 2)]),
    'L’annulation de ce devis annule aussi son contrat de maintenance et les visites non réalisées de ce contrat, son intervention.\nMotif de l’annulation de ce devis ?');
  assert.equal(questionAnnulation([conversion('CONTRAT'), conversion('CHANTIER', 2)]),
    'L’annulation de ce devis annule aussi son chantier, son contrat de maintenance et les visites non réalisées de ce contrat.\nMotif de l’annulation de ce devis ?');
});

test('chaque cible a sa ligne, avant et après l’annulation du devis', () => {
  assert.equal(texteCible('CHANTIER', false), 'Chantier issu de ce devis');
  assert.equal(texteCible('CHANTIER', true), 'Chantier annulé avec le devis');
  assert.equal(texteCible('INTERVENTION', false), 'Intervention issue de ce devis');
  assert.equal(texteCible('INTERVENTION', true), 'Intervention issue de ce devis, annulée');
  assert.equal(texteCible('CONTRAT', false), 'Contrat de maintenance issu de ce devis');
  assert.equal(texteCible('CONTRAT', true), 'Contrat de maintenance annulé avec le devis');
});
