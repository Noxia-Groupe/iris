import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtDate, fmtEuro, fmtEuroCentime, fmtHeures, fmtMontantDocument, fmtNombreHeures, toDateFrancaise } from '../src/lib/formats.ts';
import { jourFrancais } from '../src/lib/dateFormatting.ts';
import { arrondiCentime, arrondiEuro, sommeExacte } from '../src/lib/montants.ts';
import { formatEuros } from '../src/lib/mainOeuvre.ts';
import { formatPrix, heuresMinimum, refusQuantiteTempsPasse } from '../src/lib/tempsPasse.ts';
import { heuresFr } from '../src/lib/factureTempsPasse.ts';
import { formatHeuresPrevues } from '../src/lib/catalogueDevis.ts';
import { alerteMargeSav, detailMargeSav, type MargeSavHorsContrat } from '../src/lib/coutsIntervention.ts';

// Lot A5, #205 : un seul module de formats (cadrage du lot « anomalies d'écran », PR A5, version 2, et vérification
// des C5 à C7 du contrôle avant le code). Cinq familles, chacune gardant son texte d'avant #205 :
//  - le montant à l'euro près (`fmtEuro`) : `arrondiEuro`, `fr-FR`, une espace ordinaire puis « € » ;
//  - le montant au centime en devise (`fmtEuroCentime`) : `arrondiCentime`, format monétaire `fr-FR`/`EUR` d'Intl,
//    avec son espace insécable avant « € » ;
//  - la forme des documents (`fmtMontantDocument`, C5) : le texte de `formatMontantFacture` du serveur, espace ordinaire ;
//  - les heures, deux décimales au plus, ou trois pour le temps passé, avec ou sans « h » ;
//  - les jours `JJ-MM-AAAA`, par `jourFrancais`, avec le repli d'un jour absent vers ''.
// Montants (règle 2) : chaque attendu est choisi pour qu'une autre lecture plausible donne un autre texte ; le commentaire
// dit la lecture écartée. `test:unit` tourne avec TZ=Pacific/Gambier (UTC-9) ; la langue par défaut de Node y est celle
// de l'environnement (en-US en CI) : un format sans locale y écrirait « 1,235 ».

// Caractères relevés sous Node 20 (ICU 77) et Chromium : séparateur des milliers de `fr-FR`, l'espace fine insécable
// U+202F ; espace du format monétaire d'Intl avant « € », l'espace insécable U+00A0 ; espace ordinaire U+0020 ailleurs.
const FINE = ' ';
const INSECABLE = ' ';

test('euro près (fmtEuro) : arrondi de #198, moitié vers l’extérieur, sans « -0 », milliers fr-FR et espace ordinaire avant « € »', () => {
  assert.equal(fmtEuro(0), '0 €');
  // Moitiés : 12,5 € donne 13 € (un arrondi au pair donnerait 12), -12,5 € donne -13 € (Math.round donnerait -12).
  assert.equal(fmtEuro(12.5), '13 €');
  assert.equal(fmtEuro(-12.5), '-13 €');
  assert.equal(fmtEuro(12.49), '12 €');
  assert.equal(fmtEuro(-12.49), '-12 €');
  // Négatif arrondi à zéro : « 0 € », jamais « -0 € » (Math.round(-0,4) vaut -0, que toLocaleString écrit « -0 »).
  assert.equal(fmtEuro(-0.4), '0 €');
  assert.equal(fmtEuro(-0.49), '0 €');
  // -0,5 € s'éloigne de zéro : « -1 € » (Math.round donnerait « -0 € »).
  assert.equal(fmtEuro(-0.5), '-1 €');
  // Total flottant : 0,01 + 2,01 + 0,48 vaut 2,4999999999999996 et non 2,50. Écarte Math.round et l'arrondi d'Intl
  // (« 2 € »), comme un format sans arrondi préalable (« 2,5 € »).
  assert.equal(0.01 + 2.01 + 0.48, 2.4999999999999996, 'témoin : le total flottant');
  assert.equal(fmtEuro(0.01 + 2.01 + 0.48), '3 €');
  assert.equal(fmtEuro(sommeExacte([0.01, 2.01, 0.48])), '3 €');
  // Pas de centimes à l'euro près : 45,55 € donne « 46 € » (et non « 45,55 € »).
  assert.equal(fmtEuro(45.55), '46 €');
  // Milliers : l'espace fine insécable de fr-FR. Écarte la langue du navigateur (en-US « 1,235 € »), l'espace
  // ordinaire et l'espace insécable U+00A0.
  assert.equal(fmtEuro(1234.5), `1${FINE}235 €`);
  assert.equal(fmtEuro(-1234.5), `-1${FINE}235 €`, 'Math.round donnerait -1 234');
  assert.equal(fmtEuro(1234567.5), `1${FINE}234${FINE}568 €`);
  assert.equal(fmtEuro(-2345.5), `-2${FINE}346 €`);
  // L'espace avant « € » est l'espace ordinaire (U+0020), comme avant #205 (N8).
  assert.equal(fmtEuro(1234.5).at(-2), ' ');
  for (const montant of [-1234.5, -12.5, -0.4, 0, 0.4, 12.5, 1234567.5]) {
    assert.equal(fmtEuro(montant), `${arrondiEuro(montant).toLocaleString('fr-FR')} €`, String(montant));
  }
});

test('centime en devise (fmtEuroCentime) : arrondiCentime puis format monétaire fr-FR, espace insécable d’Intl, sans « -0,00 € »', () => {
  assert.equal(fmtEuroCentime(0), `0,00${INSECABLE}€`);
  assert.equal(fmtEuroCentime(45.5), `45,50${INSECABLE}€`);
  // Milliers en espace fine insécable, puis l'espace insécable d'Intl avant « € » (et non l'espace ordinaire des documents).
  assert.equal(fmtEuroCentime(1234.5), `1${FINE}234,50${INSECABLE}€`);
  assert.equal(fmtEuroCentime(-1234567.89), `-1${FINE}234${FINE}567,89${INSECABLE}€`);
  // Moitié de centime : 1,005 € donne 1,01 € (1,005 × 100 vaut 100,4999… en flottant : Math.round donnerait 1,00 €).
  assert.equal(fmtEuroCentime(1.005), `1,01${INSECABLE}€`);
  assert.equal(fmtEuroCentime(-1.005), `-1,01${INSECABLE}€`);
  assert.equal(fmtEuroCentime(-0.005), `-0,01${INSECABLE}€`);
  // Négatif arrondi à zéro : « 0,00 € ». Écarte le format monétaire sans arrondi préalable (anciens formatMontant de
  // Factures, Règlements et FactureTempsPasse, euros d'OuvrirChantierAffaire, montantEuros d'Interventions), qui écrit
  // « -0,00 € » : le seul changement de texte annoncé pour cette famille (cadrage, « Changements visibles attendus »).
  assert.equal((-0.004).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }), `-0,00${INSECABLE}€`, 'témoin : Intl seul');
  assert.equal(fmtEuroCentime(-0.004), `0,00${INSECABLE}€`);
  assert.equal(fmtEuroCentime(-0.001), `0,00${INSECABLE}€`);
  // Somme flottante : 0,1 + 0,2 vaut 0,30000000000000004.
  assert.equal(fmtEuroCentime(0.1 + 0.2), `0,30${INSECABLE}€`);
  // Rapport (taux moyen, estimation) : arrondi une seule fois, 104,03 € (un double arrondi par 104,0350 donnerait 104,04 €).
  assert.equal(fmtEuroCentime(104.034996), `104,03${INSECABLE}€`);
  for (const montant of [-1234.5, -1.005, -0.004, 0, 1.005, 2.675, 1234.5]) {
    assert.equal(fmtEuroCentime(montant), arrondiCentime(montant).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }), String(montant));
  }
});

// Le module du serveur ne se charge pas ici (il importe Prisma, absent du travail « Frontend » de la CI) : comme
// envoiMicrosoft365.test.ts, on relit son source. Sa fonction est une seule expression, relue telle quelle puis
// évaluée : c'est le texte du serveur qui sert de référence, et non une copie écrite dans ce test.
const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function formatMontantFactureDuServeur(): (valeur: unknown) => string {
  const source = readFileSync(path.join(racine, 'server/src/domaines/factures/metier.ts'), 'utf8');
  const fonction = /export function formatMontantFacture\(valeur: unknown\) \{\n {2}return (`[^`\n]*`);\n\}/.exec(source);
  assert.ok(fonction, 'formatMontantFacture relue dans server/src/domaines/factures/metier.ts');
  return new Function('valeur', `return ${fonction[1]};`) as (valeur: unknown) => string;
}

test('forme des documents (fmtMontantDocument) : deux décimales, espace ordinaire avant « € », le texte de formatMontantFacture du serveur', () => {
  assert.equal(fmtMontantDocument(45.5), '45,50 €');
  assert.equal(fmtMontantDocument(45.55), '45,55 €');
  assert.equal(fmtMontantDocument(0), '0,00 €');
  // Espace ordinaire U+0020 avant « € », et non l'espace insécable du format monétaire d'Intl (C5) ; milliers en U+202F.
  assert.equal(fmtMontantDocument(1234.5), `1${FINE}234,50 €`);
  assert.equal(fmtMontantDocument(-1234.56), `-1${FINE}234,56 €`);
  assert.equal(fmtMontantDocument(1234567.89), `1${FINE}234${FINE}567,89 €`);
  assert.notEqual(fmtMontantDocument(1234.5), fmtEuroCentime(1234.5), 'deux familles distinctes');
  assert.equal(fmtEuroCentime(1234.5).replace(INSECABLE, ' '), fmtMontantDocument(1234.5), 'elles ne diffèrent que par l’espace avant « € »');
  // Identique au serveur, valeur par valeur (le PDF et la mention du devis au temps passé). -0,004 € y donne « -0,00 € »
  // des deux côtés : la forme des documents garde le texte du serveur, sur des montants au centime (Decimal(12,2)).
  const serveur = formatMontantFactureDuServeur();
  assert.equal(serveur(45.5), '45,50 €', 'témoin : la fonction du serveur relue');
  for (const montant of [0, 0.5, 1.005, 2.675, 45.5, 45.55, 1234.05, 1234.5, -1234.56, 999999.995, 1234567.89, 9999999999.99, -0.004]) {
    assert.equal(fmtMontantDocument(montant), serveur(montant), String(montant));
  }
  // formatEuros (main d'œuvre) et formatPrix (mention du devis au temps passé) restent, au texte de cette famille.
  for (const montant of [0, 45.5, 45.55, 1234.05, 1234.5, -1234.56]) {
    assert.equal(formatEuros(montant), fmtMontantDocument(montant), `formatEuros(${montant})`);
    assert.equal(formatPrix(montant), fmtMontantDocument(montant), `formatPrix(${montant})`);
  }
});

test('heures : deux décimales au plus, ou trois pour le temps passé, sans décimale inutile ; avec ou sans « h »', () => {
  assert.equal(fmtNombreHeures(18.75), '18,75');
  assert.equal(fmtNombreHeures(8), '8');
  assert.equal(fmtNombreHeures(7.5), '7,5');
  assert.equal(fmtNombreHeures(0), '0');
  // 1,125 h : « 1,13 » à deux décimales, « 1,125 » à trois. Écarte un decimalesMax ignoré, dans un sens ou dans l'autre.
  assert.equal(fmtNombreHeures(1.125), '1,13');
  assert.equal(fmtNombreHeures(1.125, 2), '1,13');
  assert.equal(fmtNombreHeures(1.125, 3), '1,125');
  assert.equal(fmtNombreHeures(2 / 3), '0,67');
  assert.equal(fmtNombreHeures(2 / 3, 3), '0,667');
  assert.equal(fmtNombreHeures(1234.5), `1${FINE}234,5`);
  // Avec « h », après une espace ordinaire.
  assert.equal(fmtHeures(18.75), '18,75 h');
  assert.equal(fmtHeures(8), '8 h');
  assert.equal(fmtHeures(0), '0 h');
  assert.equal(fmtHeures(1.125), '1,13 h');
  assert.equal(fmtHeures(1.125, 3), '1,125 h');
  // Heures enregistrées du tableau de bord : arrondies à l'heure, puis au format fr-FR (et non « 1,234 h »).
  assert.equal(fmtHeures(Math.round(1234.4)), `1${FINE}234 h`);
  // Les fonctions gardées l'emploient : facture au temps passé au millième, heures prévues du devis au centième.
  assert.equal(heuresFr(1.125), '1,125 h');
  assert.equal(heuresFr(1.42), '1,42 h');
  assert.equal(formatHeuresPrevues(1.125), '1,13 h');
  assert.equal(formatHeuresPrevues(7.5), '7,5 h');
  // Temps passé, sans « h » et au millième : minimum facturé, et exemples du refus (60, 85 puis 110 minutes).
  assert.equal(heuresMinimum(1.125), '1,125 heure minimum facturée');
  assert.equal(heuresMinimum(2.5), '2,5 heures minimum facturées');
  assert.match(refusQuantiteTempsPasse(1.2, { tempsMinimumMinutes: 60, pasTempsPasseMinutes: 25 }) || '', /en heures, 1 ; 1,417 ; 1,833…$/);
  // Marge d'un SAV hors contrat : heures au centième, avec « h ».
  const marge: MargeSavHorsContrat = {
    ventesHT: 136.5, coutsHT: 84, materielHT: 0, margeHT: 52.5, nombreSuites: 2,
    heuresNonValorisees: 1.125, intervenantsNonValorises: ['TEST Dupont'], heuresSuitesAnnulees: 1.125,
  };
  assert.match(alerteMargeSav(marge) || '', /^Marge incomplète : 1,13 h sans prix de vente \(TEST Dupont\)\./);
  assert.match(detailMargeSav(marge, fmtEuroCentime), /Les heures des suites annulées \(1,13 h\) comptent dans le coût/);
});

test('jours : JJ-MM-AAAA par jourFrancais, avec ou sans heure, sans changer de jour ; rien pour un jour absent', () => {
  assert.equal(toDateFrancaise('2026-11-05'), '05-11-2026');
  // Instant à 03:00 UTC : le jour écrit reste le 05 (relu dans le fuseau du processus, UTC-9, il deviendrait le 04).
  assert.equal(toDateFrancaise('2026-11-05T03:00:00.000Z'), '05-11-2026');
  assert.equal(toDateFrancaise('2026-01-31T23:59:59.999Z'), '31-01-2026');
  for (const absent of [null, undefined, '']) assert.equal(toDateFrancaise(absent), '', JSON.stringify(absent) ?? 'undefined');
  for (const jour of ['2026-11-05', '2026-11-05T03:00:00.000Z', '2024-02-29']) assert.equal(toDateFrancaise(jour), jourFrancais(jour), jour);
  // fmtDate, inchangé : une date métier stockée à minuit UTC.
  assert.equal(fmtDate('2026-11-05T00:00:00.000Z'), '05-11-2026');
  assert.equal(fmtDate('2024-02-29'), '29-02-2024');
});

// Textes d'avant #205, recopiés de e39f005 (tête de A4, base de A5) : chaque famille garde son texte (cadrage, « chaque
// famille garde son texte actuel » ; N8, C5). Les fonctions sans locale y sont écrites en fr-FR : leur texte dans un
// navigateur français, le seul où elles étaient justes.
const AVANT = {
  // lib/formatsChantier.ts:12, ListeChantiers.tsx:34, Dashboard.tsx:86 (euros) ; sans locale : MesCommerciaux.tsx:22,
  // ResultatCommercial.tsx:21, EditeurBareme.tsx:3 et les montants en ligne du tableau de bord, de Performances et de
  // Statistiques.
  euro: (n: number) => `${arrondiEuro(n).toLocaleString('fr-FR')} €`,
  // CoutsSuitesChantier.tsx:4.
  centimeArrondi: (n: number) => arrondiCentime(n).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }),
  // Factures.tsx:60, Reglements.tsx:25, FactureTempsPasse.tsx:5, OuvrirChantierAffaire.tsx:12.
  centimeIntl: (n: number) => n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }),
  // Interventions.tsx:57.
  montantEuros: (n: number) => Number(n || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }),
  // mainOeuvre.ts:50 (formatEuros), tempsPasse.ts:26 (formatPrix).
  document: (n: number) => `${Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`,
  // formatsChantier.ts:14, ListeChantiers.tsx:35, coutsIntervention.ts:43 (heuresFr), catalogueDevis.ts:54.
  heures: (n: number) => `${n.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} h`,
  // CoutsSuitesChantier.tsx:5, sans « h ».
  nombreHeures: (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 2 }),
  // factureTempsPasse.ts:26 (heuresFr).
  heures3: (n: number) => `${n.toLocaleString('fr-FR', { maximumFractionDigits: 3 })} h`,
  // tempsPasse.ts:61 (quantiteFr), sans « h ».
  nombreHeures3: (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 3 }),
  // Dashboard.tsx:195 (heures enregistrées, sans locale).
  heuresArrondies: (n: number) => `${Math.round(n).toLocaleString('fr-FR')} h`,
  // formatsChantier.ts:5.
  jour: (d: string | null | undefined) => {
    if (!d) return '';
    const [annee, mois, jour] = d.slice(0, 10).split('-');
    return `${jour}-${mois}-${annee}`;
  },
};
const MONTANTS = [
  -1234567.5, -2345.5, -1234.56, -12.5, -1.005, -0.5, -0.4, -0.005, -0.004, -0.001, 0, 0.001, 0.004, 0.005, 0.1 + 0.2, 0.4, 0.5,
  1.005, 2.675, 0.01 + 2.01 + 0.48, 12.49, 12.5, 45.5, 45.55, 104.034996, 999.5, 1234.05, 1234.5, 999999.995, 1234567.89,
];
const HEURES = [0, 0.25, 0.5, 2 / 3, 1, 1.125, 1.42, 1.4166666666666667, 7.5, 7.75, 8, 18.75, 1234.4, 1234.5, 12345.678];
const ecarts = (valeurs: number[], avant: (n: number) => string, apres: (n: number) => string) => valeurs.filter((v) => avant(v) !== apres(v));

test('chaque famille garde son texte d’avant #205 ; au centime, seul « -0,00 € » devient « 0,00 € »', () => {
  assert.deepEqual(ecarts(MONTANTS, AVANT.euro, fmtEuro), []);
  assert.deepEqual(ecarts(MONTANTS, AVANT.centimeArrondi, fmtEuroCentime), []);
  // Sans arrondi préalable, l'ancien format ne diffère que pour un négatif arrondi à zéro (« -0,00 € »), inatteignable
  // pour des montants au centime renvoyés par le serveur (cadrage, Nd).
  assert.deepEqual(ecarts(MONTANTS, AVANT.centimeIntl, fmtEuroCentime), [-0.004, -0.001]);
  assert.deepEqual(ecarts(MONTANTS, AVANT.montantEuros, fmtEuroCentime), [-0.004, -0.001]);
  assert.deepEqual(ecarts(MONTANTS, AVANT.document, fmtMontantDocument), []);
  assert.deepEqual(ecarts(HEURES, AVANT.heures, (n) => fmtHeures(n)), []);
  assert.deepEqual(ecarts(HEURES, AVANT.nombreHeures, (n) => fmtNombreHeures(n)), []);
  assert.deepEqual(ecarts(HEURES, AVANT.heures3, (n) => fmtHeures(n, 3)), []);
  assert.deepEqual(ecarts(HEURES, AVANT.nombreHeures3, (n) => fmtNombreHeures(n, 3)), []);
  assert.deepEqual(ecarts(HEURES, AVANT.heuresArrondies, (n) => fmtHeures(Math.round(n))), []);
  for (const jour of ['2026-11-05', '2026-11-05T03:00:00.000Z', '', null, undefined]) assert.equal(toDateFrancaise(jour), AVANT.jour(jour), String(jour));
  // Témoin : les grilles distinguent bien les familles (trois décimales contre deux, euro contre centime).
  assert.notDeepEqual(ecarts(HEURES, AVANT.heures, (n) => fmtHeures(n, 3)), []);
  assert.notDeepEqual(ecarts(MONTANTS, AVANT.euro, fmtEuroCentime), []);
});

// --- Liste fermée de l'inventaire (C4 et C6 du contrôle du cadrage) ---
// Garde sur les sources : elle échoue si l'une des fonctions locales de l'inventaire, ou l'un de ses toLocaleString()
// sans locale, subsiste. Elle ne porte que sur cette liste, relevée par le cadrage sur 1d9eb57 (lignes de e39f005
// ci-dessous) : les montants hors périmètre, versés à une issue `suivi-audit`, n'y sont pas (Admin.tsx:625-637,
// Achats.tsx:127, lib/suiviChantiers.ts:148). L'E2E formats-locale.spec.ts montre le format à l'écran, navigateur en
// anglais ; ce test couvre aussi les écrans où un navigateur français ne le montrerait pas.
const racineClient = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (relatif: string) => readFileSync(path.join(racineClient, 'src', relatif), 'utf8');

// Exception nommée (C6) : la fiche chantier garde ses dix toLocaleString() sans locale (l. 54, 103, 117, 136, 150, 186,
// 187, 211, 212 et 218), suivis par #388 ; A5 n'y a changé que l'import du module.
const EXCEPTIONS: Record<string, string> = {
  'components/ChantierIndicateurs.tsx': '#388 : montants de la fiche chantier sans locale française ni deux décimales',
};

// Fonctions locales de l'inventaire, retirées : [fichier, fonction, ligne sur e39f005].
const FONCTIONS_LOCALES: [string, string, number][] = [
  ['pages/ListeChantiers.tsx', 'fmtEuro', 34],
  ['pages/ListeChantiers.tsx', 'fmtHeures', 35],
  ['pages/Dashboard.tsx', 'euros', 86],
  ['pages/MesCommerciaux.tsx', 'fmtEuro', 22],
  ['pages/ResultatCommercial.tsx', 'fmtEuro', 21],
  ['components/EditeurBareme.tsx', 'fmtEuro', 3],
  ['components/CoutsSuitesChantier.tsx', 'euros', 4],
  ['components/CoutsSuitesChantier.tsx', 'heures', 5],
  ['components/OuvrirChantierAffaire.tsx', 'euros', 12],
  ['pages/Factures.tsx', 'formatMontant', 60],
  ['pages/Reglements.tsx', 'formatMontant', 25],
  ['components/FactureTempsPasse.tsx', 'formatMontant', 5],
  ['pages/Interventions.tsx', 'montantEuros', 57],
  ['lib/coutsIntervention.ts', 'heuresFr', 43],
  ['lib/tempsPasse.ts', 'quantiteFr', 61],
];
// Définition d'une fonction de ce nom : `const nom = (…) =>`, `const nom = x =>`, ou `function nom(`.
const definition = (nom: string) => new RegExp(`(?:\\b(?:const|let|var)\\s+${nom}\\s*=\\s*(?:\\(|\\w+\\s*=>))|(?:\\bfunction\\s+${nom}\\s*\\()`);

// Fonctions gardées pour leurs appelants, qui deviennent des appels du module : [fichier, nom, appel attendu].
const FONCTIONS_GARDEES: [string, string, RegExp][] = [
  ['lib/mainOeuvre.ts', 'formatEuros', /\bfmtMontantDocument\b/],
  ['lib/tempsPasse.ts', 'formatPrix', /\bfmtMontantDocument\b/],
  ['lib/factureTempsPasse.ts', 'heuresFr', /\bfmtHeures\(heures, 3\)/],
  ['lib/catalogueDevis.ts', 'formatHeuresPrevues', /\bfmtHeures\(heures\)/],
];

// Fichiers dont les montants s'écrivaient sans locale (toLocaleString()) : [fichier, lignes sur e39f005]. Sur e39f005,
// tous leurs toLocaleString() sans locale étaient des entrées de l'inventaire ; il n'en reste aucun.
const SANS_LOCALE: [string, number[]][] = [
  ['pages/Dashboard.tsx', [184, 195, 206, 218, 236]],
  ['pages/Performances.tsx', [103, 107, 165]],
  ['pages/Statistiques.tsx', [195, 246]],
  ['pages/MesCommerciaux.tsx', [22]],
  ['pages/ResultatCommercial.tsx', [21]],
  ['components/EditeurBareme.tsx', [3]],
];
const TO_LOCALE_SANS_LOCALE = /\.toLocaleString\(\s*\)/;
const lignesSansLocale = (texte: string) => texte.split('\n').flatMap((ligne, rang) => (TO_LOCALE_SANS_LOCALE.test(ligne) ? [rang + 1] : []));

const NOMS_DU_MODULE = ['fmtEuro', 'fmtEuroCentime', 'fmtMontantDocument', 'fmtNombreHeures', 'fmtHeures', 'toDateFrancaise', 'fmtDate'];
const IMPORT_DU_MODULE = /from '(?:\.\.\/lib|\.)\/formats'/;
const fichiersSources = (dossier: string): string[] => readdirSync(dossier).flatMap((nom) => {
  const chemin = path.join(dossier, nom);
  return statSync(chemin).isDirectory() ? fichiersSources(chemin) : /\.tsx?$/.test(nom) ? [chemin] : [];
});

test('liste fermée de l’inventaire : aucune fonction de format locale ni montant sans locale ne subsiste, et chaque entrée emploie le module (#205)', () => {
  for (const [fichier, nom, ligne] of FONCTIONS_LOCALES) {
    const texte = source(fichier);
    assert.doesNotMatch(texte, definition(nom), `${fichier} : la fonction locale ${nom} (l. ${ligne} sur e39f005) subsiste`);
    assert.match(texte, IMPORT_DU_MODULE, `${fichier} : le module lib/formats est employé`);
  }
  for (const [fichier, nom, appel] of FONCTIONS_GARDEES) {
    const texte = source(fichier);
    const ligne = texte.split('\n').find((l) => l.startsWith(`export const ${nom} =`));
    assert.ok(ligne, `${fichier} : ${nom} reste exportée`);
    assert.doesNotMatch(ligne, /toLocaleString/, `${fichier} : ${nom} n’écrit plus son propre format`);
    assert.match(ligne, appel, `${fichier} : ${nom} appelle le module`);
    assert.match(texte, IMPORT_DU_MODULE, `${fichier} : le module lib/formats est importé`);
  }
  for (const [fichier, lignes] of SANS_LOCALE) {
    const restants = lignesSansLocale(source(fichier));
    assert.deepEqual(restants, [], `${fichier} : toLocaleString() sans locale aux lignes ${restants.join(', ')} (inventaire : l. ${lignes.join(', ')} sur e39f005)`);
    assert.match(source(fichier), IMPORT_DU_MODULE, `${fichier} : le module lib/formats est employé`);
  }
  // L'exception nommée n'entre dans aucune liste ; sa garde reste à #388.
  for (const fichier of Object.keys(EXCEPTIONS)) {
    assert.ok(![...FONCTIONS_LOCALES, ...FONCTIONS_GARDEES, ...SANS_LOCALE].some(([f]) => f === fichier), `${fichier} : exception (${EXCEPTIONS[fichier]})`);
  }
});

// Famille de montant de chaque fichier (C1 de l'audit des montants de #500). Le centime en devise et la forme des
// documents ne diffèrent que par l'espace avant « € » (U+00A0 contre U+0020) : un écran passé de l'une à l'autre changerait
// de texte sans qu'aucun parcours E2E ne le voie, `toHaveText` et `\s` acceptant toute espace. Chaque fichier qui met en
// forme un montant par le module est donc lié à la famille de son texte d'avant #205, et à elle seule. Chaque nom compte,
// alias de la forme des documents compris.
const FAMILLES_MONTANT: Record<string, string> = {
  fmtEuro: 'euro près',
  fmtEuroCentime: 'centime en devise',
  fmtMontantDocument: 'forme des documents',
  formatEuros: 'forme des documents',
  formatPrix: 'forme des documents',
  formatPrixFacultatif: 'forme des documents',
};
// Les commentaires ne comptent pas : un commentaire peut nommer une autre famille sans l'employer. Le « // » d'une adresse
// (« https:// ») n'ouvre pas de commentaire.
const sansCommentaires = (texte: string) => texte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const famillesEmployees = (texte: string) => {
  const code = sansCommentaires(texte);
  return [...new Set(Object.keys(FAMILLES_MONTANT).filter((nom) => new RegExp(`\\b${nom}\\b`).test(code)).map((nom) => FAMILLES_MONTANT[nom]))];
};
// Famille du texte d'avant #205, fichier par fichier (test « chaque famille garde son texte »).
const FAMILLE_PAR_FICHIER: [string, string][] = [
  // Inventaire du cadrage.
  ['pages/ListeChantiers.tsx', 'euro près'],
  ['pages/Dashboard.tsx', 'euro près'],
  ['pages/MesCommerciaux.tsx', 'euro près'],
  ['pages/ResultatCommercial.tsx', 'euro près'],
  ['components/EditeurBareme.tsx', 'euro près'],
  ['pages/Performances.tsx', 'euro près'],
  ['pages/Statistiques.tsx', 'euro près'],
  ['components/CoutsSuitesChantier.tsx', 'centime en devise'],
  ['components/OuvrirChantierAffaire.tsx', 'centime en devise'],
  ['pages/Factures.tsx', 'centime en devise'],
  ['pages/Reglements.tsx', 'centime en devise'],
  ['components/FactureTempsPasse.tsx', 'centime en devise'],
  ['pages/Interventions.tsx', 'centime en devise'],
  ['lib/mainOeuvre.ts', 'forme des documents'],
  ['lib/tempsPasse.ts', 'forme des documents'],
  // Hors inventaire : écrans qui employaient déjà ces noms avant #205, au même texte. Le prix du devis au temps passé et
  // du forfait reste celui du PDF.
  ['components/ChantierJournalAchats.tsx', 'euro près'],
  ['components/CatalogueMainOeuvre.tsx', 'forme des documents'],
  ['components/DevisTempsPasse.tsx', 'forme des documents'],
  ['components/DevisForfaitMainOeuvre.tsx', 'forme des documents'],
];

test('famille de montant de chaque fichier : celle de son texte d’avant #205, et elle seule ; tout fichier qui met en forme un montant est lié à la sienne', () => {
  // Témoins du relevé : un nom se reconnaît seul (fmtEuro n'est pas lu dans fmtEuroCentime), un alias compte pour sa
  // famille, un commentaire ne compte pas, une adresse n'ouvre pas de commentaire.
  assert.deepEqual(famillesEmployees('{fmtEuroCentime(facture.totalTtc)}'), ['centime en devise']);
  assert.deepEqual(famillesEmployees("import { formatEuros } from '../lib/mainOeuvre';"), ['forme des documents']);
  assert.deepEqual(famillesEmployees('{fmtEuro(a)} {fmtEuroCentime(b)}'), ['euro près', 'centime en devise']);
  assert.deepEqual(famillesEmployees('{fmtEuroCentime(a)} // et non fmtMontantDocument\n/* ni fmtEuro */ {/* ni formatPrix */}'), ['centime en devise']);
  assert.deepEqual(famillesEmployees("const lien = 'https://exemple.fr'; fmtEuro(a);"), ['euro près']);
  for (const [fichier, famille] of FAMILLE_PAR_FICHIER) {
    assert.deepEqual(famillesEmployees(source(fichier)), [famille], `${fichier} : familles de montant employées`);
  }
  // Liste close : tout fichier de src/ qui emploie une famille y figure, hors le module et l'exception nommée (#388) ; et
  // tout export d'une ligne qui renvoie à une famille (un alias, une enveloppe) est compté dans FAMILLES_MONTANT.
  const sources = path.join(racineClient, 'src');
  for (const chemin of fichiersSources(sources)) {
    const relatif = path.relative(sources, chemin).split(path.sep).join('/');
    if (relatif === 'lib/formats.ts' || relatif in EXCEPTIONS) continue;
    const texte = readFileSync(chemin, 'utf8');
    if (famillesEmployees(texte).length) assert.ok(FAMILLE_PAR_FICHIER.some(([f]) => f === relatif), `${relatif} : met en forme un montant ; sa famille est à fixer dans FAMILLE_PAR_FICHIER`);
    for (const [, nom, definition] of sansCommentaires(texte).matchAll(/^export const (\w+)\s*=(.*)$/gm)) {
      if (famillesEmployees(definition).length) assert.ok(nom in FAMILLES_MONTANT, `${relatif} : ${nom} renvoie à une famille de montant ; à compter dans FAMILLES_MONTANT`);
    }
  }
});

test('un seul module de formats : lib/formats.ts remplace lib/formatsChantier.ts, et aucun écran ne redéfinit ses fonctions (#205)', () => {
  assert.ok(existsSync(path.join(racineClient, 'src/lib/formats.ts')), 'lib/formats.ts existe');
  assert.ok(!existsSync(path.join(racineClient, 'src/lib/formatsChantier.ts')), 'lib/formatsChantier.ts est remplacé');
  const fichiers = fichiersSources(path.join(racineClient, 'src'));
  for (const chemin of fichiers) {
    const relatif = path.relative(path.join(racineClient, 'src'), chemin);
    const texte = readFileSync(chemin, 'utf8');
    assert.doesNotMatch(texte, /formatsChantier/, `${relatif} : plus d’import de formatsChantier`);
    if (relatif === path.join('lib', 'formats.ts')) continue;
    for (const nom of NOMS_DU_MODULE) assert.doesNotMatch(texte, definition(nom), `${relatif} : ${nom} redéfinie hors du module`);
  }
  // Le module ne dépend pas de la langue du navigateur : chacun de ses toLocaleString() nomme fr-FR.
  const module = source('lib/formats.ts');
  const appels = module.match(/toLocaleString\(/g) ?? [];
  assert.ok(appels.length >= 4, 'témoin : les toLocaleString() du module sont relevés');
  assert.equal((module.match(/toLocaleString\('fr-FR'/g) ?? []).length, appels.length, 'chaque toLocaleString() du module nomme fr-FR');
  // Les jours passent par jourFrancais (cadrage : « les dates passent par jourFrancais »).
  assert.match(module, /export const toDateFrancaise = [^\n]*\bjourFrancais\(/);
});

test('témoin des gardes : elles reconnaissent les formes de l’inventaire, et non une variable du même nom', () => {
  // Formes relevées sur e39f005.
  assert.match('const fmtEuro = (n: number) => `${arrondiEuro(n).toLocaleString()} €`;', definition('fmtEuro'));
  assert.match('  const euros = (n: number) => `${arrondiEuro(n).toLocaleString(\'fr-FR\')} €`;', definition('euros'));
  assert.match('const heures = (nombre: number) => nombre.toLocaleString(\'fr-FR\', { maximumFractionDigits: 2 });', definition('heures'));
  assert.match('const quantiteFr = (heures: number) => heures.toLocaleString(\'fr-FR\', { maximumFractionDigits: 3 });', definition('quantiteFr'));
  assert.match('function formatMontant(montant: number) {', definition('formatMontant'));
  assert.match('const montantEuros = montant => Number(montant || 0).toLocaleString();', definition('montantEuros'));
  assert.equal(lignesSansLocale('a\n{arrondiEuro(globalStats.achatsTotal).toLocaleString()} €\nb').join(), '2');
  assert.equal(lignesSansLocale('{Math.round(globalStats.heuresTotal).toLocaleString( )} h').join(), '1');
  // Ni une variable du même nom, ni un format qui nomme sa locale.
  assert.doesNotMatch('  const heures = Math.floor(minutes / 60);', definition('heures'));
  assert.doesNotMatch('import { fmtEuro } from \'../lib/formats\';', definition('fmtEuro'));
  assert.deepEqual(lignesSansLocale('{arrondiEuro(x).toLocaleString(\'fr-FR\')} €'), []);
});
