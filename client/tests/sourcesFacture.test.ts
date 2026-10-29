import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceFacturable, sourcesFacturables } from '../src/lib/sourcesFacture.ts';

const contrats = [
  { id: 'c-actif', statut: 'ACTIF', clientId: 'cl-1' },
  { id: 'c-suspendu', statut: 'SUSPENDU', clientId: 'cl-1' },
  { id: 'c-clos', statut: 'TERMINE', clientId: 'cl-1' },
  { id: 'c-annule', statut: 'ANNULE', clientId: 'cl-1' },
  { id: 'c-autre', statut: 'ACTIF', clientId: 'cl-2' },
];

test('un contrat ou une affaire annulés ne sont pas proposés ; actifs, suspendus et clos le restent', () => {
  assert.deepEqual(sourcesFacturables(contrats, contrats, 'cl-1').map((c) => c.id), ['c-actif', 'c-suspendu', 'c-clos']);
  const chantiers = [
    { id: 'a-en-cours', statut: 'EN_COURS', clientId: 'cl-1' },
    { id: 'a-termine', statut: 'TERMINE', clientId: 'cl-1' },
    { id: 'a-annule', statut: 'ANNULE', clientId: 'cl-1' },
  ];
  assert.deepEqual(sourcesFacturables(chantiers, contrats, 'cl-1').map((c) => c.id), ['a-en-cours', 'a-termine']);
});

test('une intervention annulée, d’un contrat annulé ou d’une affaire annulée n’est pas proposée', () => {
  const interventions = [
    { id: 'i-curative', statut: 'TERMINEE', client: { id: 'cl-1' }, contratMaintenanceId: null, chantier: null },
    { id: 'i-annulee', statut: 'ANNULEE', client: { id: 'cl-1' }, contratMaintenanceId: null, chantier: null },
    { id: 'i-visite-active', statut: 'TERMINEE', client: { id: 'cl-1' }, contratMaintenanceId: 'c-actif', chantier: null },
    { id: 'i-visite-close', statut: 'TERMINEE', client: { id: 'cl-1' }, contratMaintenanceId: 'c-clos', chantier: null },
    { id: 'i-visite-annulee', statut: 'TERMINEE', client: { id: 'cl-1' }, contratMaintenanceId: 'c-annule', chantier: null },
    { id: 'i-affaire', statut: 'TERMINEE', client: { id: 'cl-1' }, contratMaintenanceId: null, chantier: { statut: 'TERMINE' } },
    { id: 'i-affaire-annulee', statut: 'TERMINEE', client: { id: 'cl-1' }, contratMaintenanceId: null, chantier: { statut: 'ANNULE' } },
    { id: 'i-autre-client', statut: 'TERMINEE', client: { id: 'cl-2' }, contratMaintenanceId: null, chantier: null },
  ];
  assert.deepEqual(sourcesFacturables(interventions, contrats, 'cl-1').map((i) => i.id), ['i-curative', 'i-visite-active', 'i-visite-close', 'i-affaire']);
  // Sans client choisi, le filtre du client ne s'applique pas ; celui de l'annulation, si.
  assert.deepEqual(sourcesFacturables(interventions, contrats, '').map((i) => i.id), ['i-curative', 'i-visite-active', 'i-visite-close', 'i-affaire', 'i-autre-client']);
});

test('sourceFacturable : le contrat d’une visite n’est lu que dans la liste des contrats annulés', () => {
  assert.equal(sourceFacturable({ id: 'v', statut: 'PLANIFIEE', contratMaintenanceId: 'c-inconnu' }, new Set(['c-annule'])), true);
  assert.equal(sourceFacturable({ id: 'v', statut: 'PLANIFIEE', contratMaintenanceId: 'c-annule' }, new Set(['c-annule'])), false);
});
