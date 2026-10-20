import assert from 'node:assert/strict';
import test from 'node:test';
import { adresseIntervention, joursPlanifies, libelleCreneau, lienTelephone, nomContact } from '../src/lib/intervention.ts';

// Coordonnées d'une intervention (lot pilote 3b-4) : adresse du site, à défaut celle de l'affaire.
test('l’adresse affichée est celle du site, à défaut celle de l’affaire', () => {
  const site = { nom: 'Siège', adresse: ' 2 rue du Parcours ', complementAdresse: 'Bâtiment B', codePostal: '14000', ville: 'Caen' };
  assert.equal(adresseIntervention({ site, chantier: { adresse: '9 avenue de l’Affaire' } }), '2 rue du Parcours, Bâtiment B, 14000 Caen');
  assert.equal(adresseIntervention({ site: { ...site, complementAdresse: null, codePostal: '' } }), '2 rue du Parcours, Caen');
  assert.equal(adresseIntervention({ site: { ...site, adresse: '  ' }, chantier: { adresse: '9 avenue de l’Affaire' } }), '9 avenue de l’Affaire', 'un site sans adresse laisse place à l’affaire');
  assert.equal(adresseIntervention({ site: null, chantier: { adresse: ' ' } }), null);
  assert.equal(adresseIntervention({}), null);
});

test('le lien d’appel ne garde que les chiffres et un « + » initial', () => {
  assert.equal(lienTelephone('06 12 34 56 78'), 'tel:0612345678');
  assert.equal(lienTelephone(' +33 (0)6.12.34.56.78 '), 'tel:+33612345678', 'le « (0) » ne se compose pas depuis l’international');
  assert.equal(lienTelephone('poste 12'), null, 'moins de trois chiffres : pas de lien');
  assert.equal(lienTelephone('javascript:alert(1)'), null);
  assert.equal(lienTelephone(''), null);
  assert.equal(lienTelephone(null), null);
  // Texte libre : seul le premier numéro est appelé, sans poste ni second numéro accolés.
  assert.equal(lienTelephone('06 12 34 56 78 / 01 23 45 67 89'), 'tel:0612345678');
  assert.equal(lienTelephone('01 23 45 67 89 poste 212'), 'tel:0123456789');
  assert.equal(lienTelephone('Standard : 01 23 45 67 89'), 'tel:0123456789');
  assert.equal(lienTelephone('0612345678 0712345678'), null, 'plus de 15 chiffres : pas de lien');
  assert.equal(nomContact({ prenom: ' Alice ', nom: 'Martin' }), 'Alice Martin');
  assert.equal(nomContact({ prenom: null, nom: 'Martin' }), 'Martin');
});

test('créneau et jours planifiés se lisent en dates-seules, sans fuseau', () => {
  const planif = { dateDebut: '2026-10-20T00:00:00.000Z', dateFin: '2026-10-20T00:00:00.000Z', creneau: 'HEURES', heureDebut: '08:30', heureFin: '09:30' };
  assert.equal(libelleCreneau(planif), '08:30–09:30');
  assert.equal(libelleCreneau({ ...planif, creneau: 'MATIN' }), 'Matin');
  assert.equal(libelleCreneau({ ...planif, creneau: 'APRES_MIDI' }), 'Après-midi');
  assert.equal(libelleCreneau({ ...planif, creneau: 'JOURNEE' }), 'Journée');
  assert.equal(libelleCreneau({ ...planif, heureFin: null }), 'Journée', 'heures incomplètes : la journée');
  // Sous TZ=Pacific/Gambier (UTC-9), une lecture locale afficherait le 19.
  assert.equal(joursPlanifies(planif), 'mar. 20-10-2026');
  assert.equal(joursPlanifies({ ...planif, dateFin: '2026-10-22T00:00:00.000Z' }), 'du 20-10-2026 au 22-10-2026');
});
