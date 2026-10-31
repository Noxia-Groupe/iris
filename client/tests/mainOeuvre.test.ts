import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRIX_DEMI_JOURNEE, PRIX_MAIN_OEUVRE, formatEuros, formatHeures, formatPrixFacultatif, libelleMainOeuvre, mainsOeuvreProposees, valeurSaisie, type MainOeuvreResumee } from '../src/lib/mainOeuvre.ts';

const electricien: MainOeuvreResumee = { id: 'mo-1', reference: 'MO-ELEC', nom: 'Électricien', actif: true };
const plombier: MainOeuvreResumee = { id: 'mo-2', reference: 'MO-PLB', nom: 'Plombier', actif: true };
const ancienne: MainOeuvreResumee = { id: 'mo-3', reference: 'MO-OLD', nom: 'Ancien tarif', actif: false };

test('les quatre prix de vente sont libellés sans ambiguïté, dans un ordre fixe', () => {
  assert.deepEqual(PRIX_MAIN_OEUVRE.map((p) => p.cle), ['prixVenteHt', 'prixJourHorsContratHt', 'prixHeureSousContratHt', 'prixJourSousContratHt']);
  assert.deepEqual(PRIX_MAIN_OEUVRE.map((p) => p.libelle), [
    'Prix de vente HT à l’heure, hors contrat',
    'Prix de vente HT au forfait jour, hors contrat',
    'Prix de vente HT à l’heure, sous contrat',
    'Prix de vente HT au forfait jour, sous contrat',
  ]);
});

test('montants au centime et heures au quart d’heure, virgule décimale', () => {
  assert.equal(formatEuros(45.5), '45,50 €');
  assert.equal(formatEuros(0), '0,00 €');
  assert.equal(formatEuros(1234.05), '1234,05 €');
  assert.equal(formatHeures(7), '7 h');
  assert.equal(formatHeures(7.5), '7,5 h');
  assert.equal(formatHeures(7.75), '7,75 h');
  assert.equal(valeurSaisie(45.5), '45,5');
  assert.equal(valeurSaisie(null), '');
});

test('rattachement : les mains d’œuvre actives, triées par nom, et la sienne si elle a été désactivée', () => {
  assert.deepEqual(mainsOeuvreProposees([plombier, ancienne, electricien], null).map((m) => m.id), ['mo-1', 'mo-2']);
  // Rattachement gardé vers une main d'œuvre désactivée : affiché en dernier, marqué comme tel.
  const proposees = mainsOeuvreProposees([plombier, ancienne, electricien], ancienne);
  assert.deepEqual(proposees.map((m) => m.id), ['mo-1', 'mo-2', 'mo-3']);
  assert.equal(libelleMainOeuvre(proposees[2]), 'MO-OLD · Ancien tarif (désactivée)');
  assert.equal(libelleMainOeuvre(electricien), 'MO-ELEC · Électricien');
  // Une main d'œuvre active déjà proposée n'est pas répétée ; absente de la liste (liste non chargée), elle est ajoutée.
  assert.deepEqual(mainsOeuvreProposees([electricien, plombier], electricien).map((m) => m.id), ['mo-1', 'mo-2']);
  assert.deepEqual(mainsOeuvreProposees([], plombier).map((m) => m.id), ['mo-2']);
});

test('les deux prix facultatifs de la demi-journée : libellés sans ambiguïté, « Non réglé » quand ils sont vides', () => {
  assert.deepEqual(PRIX_DEMI_JOURNEE.map((p) => [p.cle, p.libelle]), [
    ['prixDemiJourneeHorsContratHt', 'Prix de vente HT à la demi-journée, hors contrat'],
    ['prixDemiJourneeSousContratHt', 'Prix de vente HT à la demi-journée, sous contrat'],
  ]);
  // Aucun libellé n'en contient un autre : l'écran et ses tests les retrouvent chacun par son libellé.
  const libelles = [...PRIX_MAIN_OEUVRE, ...PRIX_DEMI_JOURNEE].map((p) => p.libelle);
  assert.ok(libelles.every((a) => libelles.every((b) => a === b || !b.includes(a))));
  assert.equal(formatPrixFacultatif(160), '160,00 €');
  assert.equal(formatPrixFacultatif(0), '0,00 €');
  assert.equal(formatPrixFacultatif(null), 'Non réglé');
  assert.equal(formatPrixFacultatif(undefined), 'Non réglé');
});
