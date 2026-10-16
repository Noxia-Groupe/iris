import assert from 'node:assert/strict';
import test from 'node:test';
import { resumeCoutsIntervention } from '../src/lib/coutsIntervention.ts';

test('coûts SAV : coût réel pour l’administration, matériel seul pour un conducteur, rien sans total', () => {
  assert.deepEqual(resumeCoutsIntervention({ totalCoutsHT: 96.5, totalMaterielHT: 12.5 }), { libelle: 'Coût réel cumulé', montant: 96.5 });
  // Un conducteur ne reçoit pas le total main-d'œuvre comprise (null) : jamais « 0 € ».
  assert.deepEqual(resumeCoutsIntervention({ totalCoutsHT: null, totalMaterielHT: 12.5 }), { libelle: 'Matériel cumulé', montant: 12.5 });
  assert.deepEqual(resumeCoutsIntervention({ totalCoutsHT: null, totalMaterielHT: 0 }), { libelle: 'Matériel cumulé', montant: 0 });
  // Le technicien ne reçoit que ses heures, sans aucun total.
  assert.equal(resumeCoutsIntervention({}), null);
});
