import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRIX_DEMI_JOURNEE, PRIX_MAIN_OEUVRE, formatEuros, formatHeures, formatPrixFacultatif, libelleMainOeuvre, mainsOeuvreProposees, valeurSaisie, type MainOeuvreResumee } from '../src/lib/mainOeuvre.ts';
import { formatPrix } from '../src/lib/tempsPasse.ts';

// Séparateur de milliers du français dans `toLocaleString('fr-FR')` : l'espace fine insécable (U+202F).
const FINE = ' ';

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
  // Milliers séparés comme à l'écran du devis (remarque N2 du contrôle de cohérence de #379) ; « 1234,05 € » avant.
  assert.equal(formatEuros(1234.05), `1${FINE}234,05 €`);
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

// Remarque N2 du contrôle de cohérence de #379 (correctif d'affichage) : un même prix s'écrivait « 1250,00 € » au
// catalogue (formatEuros) et « 1 250,00 € HT » à l'écran du devis (formatPrix). Le catalogue l'écrit désormais au
// format français de formatPrix, avec le même séparateur de milliers.
test('prix du catalogue au format français de l’écran du devis : la même chaîne que formatPrix, milliers compris', () => {
  // Le forfait jour relevé par le contrôle : « 1 250,00 € », et non « 1250,00 € » (toFixed) ni « 1 250 € » (sans centimes).
  assert.equal(formatEuros(1250), `1${FINE}250,00 €`);
  assert.equal(formatPrixFacultatif(1250), `1${FINE}250,00 €`);
  assert.equal(formatEuros(1234567.89), `1${FINE}234${FINE}567,89 €`);
  for (const montant of [0, 0.5, 45.5, 150.5, 999.99, 1000, 1250, 1234.05, 12345.6, 1234567.89]) {
    assert.equal(formatEuros(montant), formatPrix(montant), `${montant} : même chaîne au catalogue et à l’écran du devis`);
  }
});
