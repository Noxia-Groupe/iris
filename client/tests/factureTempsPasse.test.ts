import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corpsFactureTempsPasse, dureeFacture, heuresComptees, heuresFr, regleFactureTempsPasse, type ApercuFactureTempsPasse } from '../src/lib/factureTempsPasse.ts';

const apercu: ApercuFactureTempsPasse = {
  intervention: { id: 'i-1', reference: 'SAV-2026-0001', titre: 'Fuite', clientId: 'c-1', clientRaisonSociale: 'Client' },
  devis: { id: 'd-1', numero: 'DEV-2026-0001', version: 1 },
  heures: {
    intervention: 0.67,
    suites: [{ id: 's-1', reference: 'SAV-2026-0002', statut: 'TERMINEE', heures: 0.75 }, { id: 's-2', reference: 'SAV-2026-0003', statut: 'ANNULEE', heures: null }],
    saisies: 1.42, minutesSaisies: 85.2, minimumFige: true, plancherMinutes: 60, pasMinutes: 15, minutesFacturees: 90, facturees: 1.5,
  },
  lignes: [], ventilationTva: [], totalHt: 78.25, totalTva: 15.65, totalTtc: 93.9,
};

test('heures et durées à la française : au millième, et en minutes entières comme sur le devis', () => {
  assert.equal(heuresFr(1.42), '1,42 h');
  assert.equal(heuresFr(1.6666), '1,667 h');
  assert.equal(dureeFacture(60), '1 h');
  assert.equal(dureeFacture(75), '1 h 15 min');
  assert.equal(dureeFacture(30), '30 min');
  assert.equal(dureeFacture(79.98), '1,333 h');
});

test('règle appliquée : minimum figé puis le pas, ou, sur un devis antérieur, les heures de sa ligne puis le pas', () => {
  assert.equal(regleFactureTempsPasse(apercu.heures), 'Minimum facturé 1 h, puis tranches de 15 min au-delà, toute tranche commencée étant due.');
  assert.equal(regleFactureTempsPasse({ ...apercu.heures, minimumFige: false, plancherMinutes: 120, pasMinutes: 45 }),
    'Devis antérieur au temps minimum : 2 h au moins, les heures de sa ligne, puis tranches de 45 min au-delà, toute tranche commencée étant due.');
});

test('heures comptées : l’intervention, puis chaque suite, une suite annulée sans ses heures', () => {
  assert.deepEqual(heuresComptees(apercu), [
    'SAV-2026-0001 (intervention) : 0,67 h',
    'SAV-2026-0002 (suite) : 0,75 h',
    'SAV-2026-0003 (suite annulée) : non facturée',
  ]);
});

test('création : les dates du formulaire et le total HT de l’aperçu lu', () => {
  assert.deepEqual(corpsFactureTempsPasse({ dateEmission: '01-10-2026', dateEcheance: '31-10-2026' }, apercu), { dateEmission: '01-10-2026', dateEcheance: '31-10-2026', totalHtAttendu: 78.25 });
});
