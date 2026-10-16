import assert from 'node:assert/strict';
import test from 'node:test';
import { alertesDuChantier, ancienneteSaisie, filtrerChantiers, hypotheseCoutHoraire, libelleAlerte, trierChantiers, type ChantierSuivi, type EstimationMarge } from '../src/lib/suiviChantiers.ts';

const chantier = (id: string, nom: string, metrics: ChantierSuivi['metrics'] = {}, extra: Partial<ChantierSuivi> = {}): ChantierSuivi => ({
  id, nom, client: 'Client', statut: 'EN_COURS', heuresVendues: 10, budgetMaterielVendu: 300, budgetMainOeuvreVendu: 700, metrics, ...extra,
});

const sain = chantier('a', 'Bureaux Caen', { pctHeures: 40, margePct: 35, alertes: [] }, { client: 'Société Générale d’Électricité', numeroDevis: 'A26-0001', responsable: { name: 'Hélène Martin' } });
const heures = chantier('b', 'Entrepôt Rouen', { pctHeures: 130, heuresRealisees: 13, margePct: 12, alertes: ['HEURES_DEPASSEES'] });
const perte = chantier('c', 'Agence Lisieux', { pctHeures: 60, margePct: -8, margeCommerciale: -80, alertes: ['MATERIEL_DEPASSE', 'EN_PERTE'] });
const cumul = chantier('d', 'Mairie Bayeux', { pctHeures: 90, margePct: null, alertes: ['MAIN_OEUVRE_DEPASSEE', 'HEURES_DEPASSEES'] });
const tous = [sain, heures, perte, cumul];

test('les alertes reçues sont ordonnées par gravité et les codes inconnus ignorés', () => {
  assert.deepEqual(alertesDuChantier(chantier('x', 'X', { alertes: ['MATERIEL_DEPASSE', 'INCONNUE', 'EN_PERTE', 'HEURES_DEPASSEES'] })),
    ['EN_PERTE', 'HEURES_DEPASSEES', 'MATERIEL_DEPASSE']);
  assert.deepEqual(alertesDuChantier(chantier('y', 'Y', undefined)), []);
});

test('la recherche ignore casse et accents et porte sur client, devis et responsable', () => {
  assert.deepEqual(filtrerChantiers(tous, 'electricite', 'TOUS').map((c) => c.id), ['a']);
  assert.deepEqual(filtrerChantiers(tous, 'a26-0001', 'TOUS').map((c) => c.id), ['a']);
  assert.deepEqual(filtrerChantiers(tous, 'HELENE caen', 'TOUS').map((c) => c.id), ['a']);
  assert.deepEqual(filtrerChantiers(tous, '   ', 'TOUS').map((c) => c.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(filtrerChantiers(tous, 'introuvable', 'TOUS'), []);
});

test('« à surveiller » retient toute affaire en alerte ; un filtre précis, la seule alerte nommée', () => {
  assert.deepEqual(filtrerChantiers(tous, '', 'A_SURVEILLER').map((c) => c.id), ['b', 'c', 'd']);
  assert.deepEqual(filtrerChantiers(tous, '', 'HEURES_DEPASSEES').map((c) => c.id), ['b', 'd']);
  assert.deepEqual(filtrerChantiers(tous, '', 'EN_PERTE').map((c) => c.id), ['c']);
  assert.deepEqual(filtrerChantiers(tous, 'rouen', 'A_SURVEILLER').map((c) => c.id), ['b']);
});

test('la priorité place la perte, puis le cumul de dérives, puis l’avancement', () => {
  assert.deepEqual(trierChantiers(tous, 'PRIORITE').map((c) => c.id), ['c', 'd', 'b', 'a']);
});

test('le tri par marge montre la plus faible d’abord et la marge masquée en dernier', () => {
  assert.deepEqual(trierChantiers(tous, 'MARGE').map((c) => c.id), ['c', 'b', 'a', 'd']);
});

test('avancement décroissant et nom alphabétique, sans modifier la liste reçue', () => {
  const avant = tous.map((c) => c.id);
  assert.deepEqual(trierChantiers(tous, 'AVANCEMENT').map((c) => c.id), ['b', 'd', 'c', 'a']);
  assert.deepEqual(trierChantiers(tous, 'NOM').map((c) => c.id), ['c', 'a', 'b', 'd']);
  assert.deepEqual(tous.map((c) => c.id), avant);
});

test('chaque alerte dit de combien le réel dépasse le vendu', () => {
  const derive = chantier('z', 'Z', { heuresRealisees: 12.5, materielReel: 450, moReel: 820, margeCommerciale: -270 });
  assert.equal(libelleAlerte('HEURES_DEPASSEES', derive), 'Heures +2,5 h');
  assert.equal(libelleAlerte('MATERIEL_DEPASSE', derive), 'Matériel +150 €');
  assert.equal(libelleAlerte('MAIN_OEUVRE_DEPASSEE', derive), 'Main-d’œuvre +120 €');
  assert.equal(libelleAlerte('EN_PERTE', derive), 'En perte 270 €');
});

test('marge faible et absence de saisie : libellés chiffrés et rang dans la priorité', () => {
  const faible = chantier('f', 'Faible', { margeEstimeePct: 8.25, alertes: ['MARGE_FAIBLE'] });
  const dormant = chantier('s', 'Dormant', { joursSansSaisie: 21, alertes: ['SANS_SAISIE'] });
  assert.equal(libelleAlerte('MARGE_FAIBLE', faible), 'Marge estimée 8,3 %');
  assert.equal(libelleAlerte('SANS_SAISIE', dormant), 'Sans saisie depuis 21 j');
  // Perte > marge faible > dépassements (même cumulés) > absence de saisie > rien.
  assert.deepEqual(trierChantiers([sain, dormant, cumul, faible, perte], 'PRIORITE').map((c) => c.id), ['c', 'f', 'd', 's', 'a']);
  assert.deepEqual(filtrerChantiers([sain, dormant, faible], '', 'SANS_SAISIE').map((c) => c.id), ['s']);
});

test('le tri par marge suit la marge estimée en fin de chantier quand elle est connue', () => {
  const bonDuJour = chantier('x', 'X', { margePct: 60, margeEstimeePct: 5 });
  const moyen = chantier('y', 'Y', { margePct: 20, margeEstimeePct: 18 });
  assert.deepEqual(trierChantiers([moyen, bonDuJour], 'MARGE').map((c) => c.id), ['x', 'y']);
});

test('ancienneté de la dernière saisie en mots simples', () => {
  assert.equal(ancienneteSaisie(0), 'aujourd’hui');
  assert.equal(ancienneteSaisie(1), 'hier');
  assert.equal(ancienneteSaisie(12), 'il y a 12 j');
});

test('budget non communiqué : un libellé de dépassement ne donne jamais de montant', () => {
  const technicien = chantier('t', 'Vu par un technicien', { materielReel: 450, moReel: 820, alertes: ['MATERIEL_DEPASSE', 'MAIN_OEUVRE_DEPASSEE'] },
    { budgetMaterielVendu: null, budgetMainOeuvreVendu: null });
  assert.equal(libelleAlerte('MATERIEL_DEPASSE', technicien), 'Matériel dépassé');
  assert.equal(libelleAlerte('MAIN_OEUVRE_DEPASSEE', technicien), 'Main-d’œuvre dépassée');
  assert.deepEqual(alertesDuChantier(technicien), ['MAIN_OEUVRE_DEPASSEE', 'MATERIEL_DEPASSE']);
});

test('coût de main-d’œuvre réservé à l’administration : alerte et hypothèse sans montant horaire', () => {
  // Un conducteur reçoit le budget main-d'œuvre vendu et l'alerte, mais ni le coût réel ni le taux.
  const conducteur = chantier('m', 'Vu par un conducteur', { moReel: null, totalDepenses: null, alertes: ['MAIN_OEUVRE_DEPASSEE'] });
  assert.equal(libelleAlerte('MAIN_OEUVRE_DEPASSEE', conducteur), 'Main-d’œuvre dépassée');
  assert.equal(libelleAlerte('MAIN_OEUVRE_DEPASSEE', chantier('n', 'Vu par l’administration', { moReel: 820 })), 'Main-d’œuvre +120 €');
  const estimation = (source: EstimationMarge['sourceCoutHoraire'], coutHoraireReference: number | null): EstimationMarge => ({
    coutEstime: null, coutMainOeuvreAttendu: null, coutMaterielAttendu: 300, coutHoraireReference, sourceCoutHoraire: source, ratioMateriel: 1, sourceMateriel: 'VENDU',
  });
  assert.equal(hypotheseCoutHoraire(estimation('CHANTIER', null)), 'heures vendues au coût moyen réellement appliqué sur ce chantier');
  assert.equal(hypotheseCoutHoraire(estimation('SOCIETE', null)), 'heures vendues au coût moyen de la société (aucune heure encore saisie ici)');
  assert.equal(hypotheseCoutHoraire(estimation('CHANTIER', 42.5)), 'heures vendues à 42,5 €/h, coût moyen réellement appliqué sur ce chantier');
});
