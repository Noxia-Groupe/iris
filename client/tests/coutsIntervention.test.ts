import assert from 'node:assert/strict';
import test from 'node:test';
import { resumeCoutsIntervention, libelleDevisMarge } from '../src/lib/coutsIntervention.ts';

test('coûts SAV : coût réel pour l’administration, main-d’œuvre seule hors contrat, matériel seul pour un conducteur, rien sans total', () => {
  assert.deepEqual(resumeCoutsIntervention({ totalCoutsHT: 96.5, totalMaterielHT: 12.5 }), { libelle: 'Coût réel cumulé', montant: 96.5 });
  // Hors contrat, l'administration ne reçoit pas de total matériel (null) : le total n'est que la main-d'œuvre.
  assert.deepEqual(resumeCoutsIntervention({ totalCoutsHT: 60, totalMaterielHT: null }), { libelle: 'Main-d’œuvre cumulée', montant: 60 });
  assert.deepEqual(resumeCoutsIntervention({ totalCoutsHT: 0, totalMaterielHT: null }), { libelle: 'Main-d’œuvre cumulée', montant: 0 });
  // Avec un contrat, un total matériel nul reste un coût réel : il pourrait en recevoir.
  assert.deepEqual(resumeCoutsIntervention({ totalCoutsHT: 84, totalMaterielHT: 0 }), { libelle: 'Coût réel cumulé', montant: 84 });
  // Un conducteur ne reçoit pas le total main-d'œuvre comprise (null) : jamais « 0 € ».
  assert.deepEqual(resumeCoutsIntervention({ totalCoutsHT: null, totalMaterielHT: 12.5 }), { libelle: 'Matériel cumulé', montant: 12.5 });
  assert.deepEqual(resumeCoutsIntervention({ totalCoutsHT: null, totalMaterielHT: 0 }), { libelle: 'Matériel cumulé', montant: 0 });
  // Le technicien ne reçoit que ses heures, sans aucun total.
  assert.equal(resumeCoutsIntervention({}), null);
});

test('marge d’une intervention issue d’un devis : numéro du devis, version précisée au-delà de la première', () => {
  const marge = { totalDevisHT: 500, coutsInterventionHT: 100, coutsSuitesHT: 50, nombreSuites: 1, margeHT: 350 };
  assert.equal(libelleDevisMarge({ ...marge, devis: { id: 'd1', numero: 'DEV-2026-0007', version: 1 } }), 'DEV-2026-0007');
  assert.equal(libelleDevisMarge({ ...marge, devis: { id: 'd2', numero: 'DEV-2026-0007', version: 3 } }), 'DEV-2026-0007 (version 3)');
});
