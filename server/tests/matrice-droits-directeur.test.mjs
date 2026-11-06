// Lot « Directeur aligné sur l'administration » (cadrage version 3, verdict « go » du controleur-coherence ; section
// « Tests », « Nouveau test, DIR égale AD », T4 et T-v2-1 du contrôle).
//
// Décisions appliquées : décision de Nelson du 24-10-2026, point 14 (« Oui la diectiin pourra tout faire », option
// « Tout, réglages compris » : « Le Directeur a les mêmes droits que l'administration (ADMIN), paramètres et gestion des
// comptes compris »), et point 17 (« Il garde ses particularite actuel ») ; réponse de Nelson du 06-11-2026 sur la
// rentabilité, « Chantiers seulement » : le réglage rentabiliteDirecteurs ne lui masque que la marge, le vendu et le coût
// prévu des chantiers, et lui refuse l'écriture du vendu.
//
// Chaque référence versionnée de la matrice des droits (lot D1a, server/tests/matrice-droits/*.txt) est comparée au
// caractère près au comportement réel par son propre fichier de test. Ce fichier-ci vérifie, dans ces références, que la
// colonne DIR est celle d'AD : pour chaque route, cible, contexte (variante) et action, DIR a la même ligne qu'AD, sauf une
// liste FERMÉE de lignes exactes, chacune avec la transformation qu'elle subit, elle aussi vérifiée. Les deux ensemble
// prouvent que le directeur a, à l'API, les droits de l'administration. Le test échoue sur be4f4fb, où DIR est refusé
// (403) sur 161 des 179 routes de session qui admettent l'administration.
//
// Règles de comparaison, déclarées :
//  - les entrées de journal qu'une écriture produit sont nommées par leur auteur : « par AD » est lu « par DIR » dans les
//    lignes d'AD avant la comparaison (journal des saisies compris) ;
//  - les lectures des journaux (lignes GET de journaux.txt, factures.txt et montants.txt, dont la cible nomme l'entrée lue)
//    sont faites par SA et AD seulement : le directeur n'y est pas relecteur, réduction déclarée comme celle d'AD-COM
//    (cadrage de D1a-5c, §2.2) ; ses lectures de ces routes sont comparées à celles d'AD dans entrees.txt et donnees.txt ;
//  - individuels-sans-gain.txt décrit le compte qui reçoit le droit (« valeurs AD », « valeurs DIR ») : chacun est comparé
//    à la description de soi de l'autre.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const DOSSIER = join(dirname(fileURLToPath(import.meta.url)), 'matrice-droits');
const SEPARATEUR = ' | ';
// Nombre de champs de la clé d'une ligne (compte compris), comme le fichier de test de chaque référence (champsCle).
const CHAMPS_CLE = { 'donnees.txt': 5, 'individuels.txt': 6, 'individuels-sans-gain.txt': 6 };
const LECTURES_DES_JOURNAUX = ['journaux.txt', 'factures.txt', 'montants.txt'];
// Références attendues : une de plus ou de moins doit être vue ici (et classée).
const REFERENCES = ['cles-montants.txt', 'cles.txt', 'donnees.txt', 'ecritures-actions.txt', 'ecritures-modifications.txt', 'entrees.txt', 'factures.txt', 'individuels-sans-gain.txt', 'individuels.txt', 'journaux.txt', 'montants.txt'];

// --- Liste fermée des écarts, ligne par ligne (fichier, clé exacte : route | cible | contexte [| objet]) ---
const CHANTIERS = ['chantier-ac', 'chantier-ad', 'chantier-autre', 'chantier-com', 'chantier-com-titulaire', 'chantier-cpt', 'chantier-ct', 'chantier-ct-branche-resp', 'chantier-dc', 'chantier-dir', 'chantier-resp', 'chantier-tech-branche-resp', 'chantier-termine'];
const SANS_REGLAGE = 'rentabiliteDirecteurs=non';
// Montants des chantiers que le réglage coupé masque au directeur (réponse « Chantiers seulement ») : rentabilité (vendu,
// marges, estimation, facturation) et coût prévu (décisions de Nelson du 30-10-2026). Les autres montants du chantier
// (budgets par poste, achats, coûts de main-d'œuvre, taux) restent ceux de l'administration.
const MASQUES_CHANTIER = ['budgetGlobalVendu', 'coutMaterielPrevu', 'metrics.margeBrute', 'metrics.margeCommerciale', 'metrics.margePct', 'metrics.margeEstimee', 'metrics.margeEstimeePct', 'metrics.estimation', 'metrics.estimation.coutEstime', 'metrics.estimation.coutMainOeuvreAttendu', 'metrics.estimation.coutHoraireReference', 'facturation'];
// Performances (GET /api/stats/conducteurs) : le CA et la marge, pas les dépenses.
const MASQUES_PERFORMANCES = ['caTotal', 'margeTotal', 'margePct'];
const REFUS_VENDU = '403 « Le montant vendu n’est modifiable que par qui suit la rentabilité de ce chantier. » inchangé ; aucune entrée ; montants inchangés en base';

const ECARTS = {
  'donnees.txt': [
    // Type affiché du compte connecté : le seul écart du réglage par défaut.
    { cle: 'GET /api/me | — | défaut | valeurs', nature: 'role' },
    // Liste et fiche de chaque chantier, réglage coupé : rentabilité et coût prévu masqués.
    ...CHANTIERS.map((c) => ({ cle: `GET /api/chantiers | — | ${SANS_REGLAGE} | montants ${c}`, nature: 'montants', masques: MASQUES_CHANTIER })),
    ...[...CHANTIERS, 'chantier-annule'].sort().map((c) => ({ cle: `GET /api/chantiers/:id | ${c} | ${SANS_REGLAGE} | montants`, nature: 'montants', masques: MASQUES_CHANTIER })),
    // Fiche, réglage coupé : ses clés, celles d'AD par défaut sans « facturation » (ligne écrite parce qu'elle change).
    ...[...CHANTIERS, 'chantier-annule'].sort().map((c) => ({ cle: `GET /api/chantiers/:id | ${c} | ${SANS_REGLAGE} | clés .`, nature: 'clés sans facturation' })),
    // Performances, réglage coupé : ni CA, ni marge, ni marge %.
    ...['CT', 'CT-BRANCHE', 'CT-TIERS'].map((c) => ({ cle: `GET /api/stats/conducteurs | — | ${SANS_REGLAGE} | montants ${c}`, nature: 'montants', masques: MASQUES_PERFORMANCES })),
  ],
  'montants.txt': [
    // Écriture du vendu, réglage coupé : refusée au directeur, sur le chantier en cours comme sur le chantier terminé.
    { cle: `PATCH /api/chantiers/:id | chantier-ct | ${SANS_REGLAGE}, corps montant vendu`, nature: 'refus du vendu' },
    { cle: `PATCH /api/chantiers/:id | chantier-termine | ${SANS_REGLAGE}, corps montant vendu`, nature: 'refus du vendu' },
    // Réponses d'écriture, réglage coupé : modification, clôture et commercial, sans vendu ni coût prévu.
    { cle: `PATCH /api/chantiers/:id | chantier-ct | ${SANS_REGLAGE}, corps nom`, nature: 'réponse masquée' },
    { cle: `PATCH /api/chantiers/:id/statut | chantier-ct | ${SANS_REGLAGE}, corps statut=TERMINE`, nature: 'réponse masquée' },
    { cle: `PATCH /api/chantiers/:id/commercial | chantier-ct | ${SANS_REGLAGE}, corps commercialId=COM`, nature: 'réponse masquée' },
  ],
  'ecritures-actions.txt': [
    // La cible « compte-administrateur » est le compte AD lui-même : AD ne se supprime ni ne se désactive ; le directeur,
    // qui en a les droits, supprime et désactive ce compte, qui n'est pas le sien. Écart de données, et non de droits.
    { cle: 'DELETE /api/users/:id | compte-administrateur | défaut', nature: 'soi-même', ad: '403 « Vous ne pouvez pas supprimer votre propre compte. » inchangé' },
    { cle: 'PATCH /api/users/:id/actif | compte-administrateur | défaut', nature: 'soi-même', ad: '400 « Vous ne pouvez pas désactiver votre propre compte. » inchangé' },
  ],
};

function lire(fichier) {
  return readFileSync(join(DOSSIER, fichier), 'utf8').split('\n').filter(Boolean);
}

// Lignes d'un compte : clé (sans le compte) → reste de la ligne.
function lignesDe(fichier, compte) {
  const n = CHAMPS_CLE[fichier] ?? 4;
  const lignes = new Map();
  for (const ligne of lire(fichier)) {
    const champs = ligne.split(SEPARATEUR);
    if (champs[0] !== compte) continue;
    let cle = champs.slice(1, n).join(SEPARATEUR);
    if (fichier === 'individuels-sans-gain.txt') cle = cle.replace(new RegExp(`${SEPARATEUR.replace(/\|/g, '\\|')}valeurs ${compte}$`), `${SEPARATEUR}valeurs (soi)`);
    if (LECTURES_DES_JOURNAUX.includes(fichier) && cle.startsWith('GET ')) continue;
    assert.ok(!lignes.has(cle), `${fichier} : deux lignes de ${compte} pour ${cle}`);
    lignes.set(cle, champs.slice(n).join(SEPARATEUR));
  }
  return lignes;
}

// « par AD », et non « par AD-COM ».
const commeDir = (valeur) => valeur.replace(/\bpar AD(?![\w-])/g, 'par DIR');
// « champ=état, champ=état, … » → Map.
const etats = (valeur) => new Map(valeur.split(', ').map((morceau) => { const i = morceau.indexOf('='); return [morceau.slice(0, i), morceau.slice(i + 1)]; }));

// Vérifie qu'un écart de la liste est exactement celui que sa nature décrit. Rend la liste des défauts.
function verifierEcart(fichier, ecart, ad, dir) {
  const defauts = [];
  const nom = `${fichier} ${ecart.cle}`;
  if (ecart.nature === 'role') {
    if (ad === undefined || dir === undefined) return [`${nom} : ligne absente`];
    if (dir !== ad.replace('role=ADMIN', 'role=DIRECTEUR') || !ad.includes('role=ADMIN')) defauts.push(`${nom} : seul le type affiché doit différer (AD « ${ad} », DIR « ${dir} »)`);
  } else if (ecart.nature === 'montants') {
    if (ad === undefined || dir === undefined) return [`${nom} : ligne absente`];
    const a = etats(ad); const d = etats(dir);
    let masque = false;
    for (const champ of new Set([...a.keys(), ...d.keys()])) {
      const ea = a.get(champ) ?? 'absent'; const ed = d.get(champ) ?? 'absent';
      if (ecart.masques.includes(champ)) {
        // Masqué pour DIR, quel que soit l'état chez AD (un coût horaire de référence peut être nul sans heures).
        if (!['null', 'absent'].includes(ed)) defauts.push(`${nom} : ${champ} devrait être masqué pour DIR (${ed})`);
        if (ea === 'présent') masque = true;
      } else if (ea !== ed) defauts.push(`${nom} : ${champ} différent hors des montants masqués (AD ${ea}, DIR ${ed})`);
    }
    if (!masque) defauts.push(`${nom} : aucun montant présent pour AD et masqué pour DIR, l’écart n’a pas lieu d’être`);
  } else if (ecart.nature === 'clés sans facturation') {
    // Ligne écrite pour DIR seulement : elle change par rapport au défaut ; elle doit valoir celle d'AD par défaut sans facturation.
    const [route, cible] = ecart.cle.split(SEPARATEUR);
    const defaut = lignesDe(fichier, 'AD').get([route, cible, 'défaut', 'clés .'].join(SEPARATEUR));
    if (ad !== undefined) defauts.push(`${nom} : ligne d’AD inattendue (« ${ad} »)`);
    if (dir === undefined || defaut === undefined) return [...defauts, `${nom} : ligne absente`];
    const attendu = defaut.split(', ').filter((cle) => cle !== 'facturation').join(', ');
    if (!defaut.split(', ').includes('facturation')) defauts.push(`${nom} : AD devrait avoir « facturation » par défaut`);
    if (dir !== attendu) defauts.push(`${nom} : clés de DIR (« ${dir} ») différentes de celles d’AD sans facturation (« ${attendu} »)`);
  } else if (ecart.nature === 'refus du vendu') {
    if (ad === undefined || dir === undefined) return [`${nom} : ligne absente`];
    if (!/^200 écrit \(Chantier\) ; .* ; montant vendu écrit relu en base$/.test(ad)) defauts.push(`${nom} : AD devrait écrire le vendu (« ${ad} »)`);
    if (dir !== REFUS_VENDU) defauts.push(`${nom} : DIR devrait être refusé (« ${dir} »)`);
  } else if (ecart.nature === 'réponse masquée') {
    if (ad === undefined || dir === undefined) return [`${nom} : ligne absente`];
    const attendu = commeDir(ad).replace('budgetGlobalVendu présent, coutMaterielPrevu présent', 'budgetGlobalVendu null, coutMaterielPrevu null');
    if (!ad.includes('budgetGlobalVendu présent, coutMaterielPrevu présent')) defauts.push(`${nom} : AD devrait lire vendu et coût prévu (« ${ad} »)`);
    if (dir !== attendu) defauts.push(`${nom} : DIR (« ${dir} ») devrait être AD sans vendu ni coût prévu (« ${attendu} »)`);
  } else if (ecart.nature === 'soi-même') {
    if (ad === undefined || dir === undefined) return [`${nom} : ligne absente`];
    if (ad !== ecart.ad) defauts.push(`${nom} : AD (« ${ad} ») devrait être le refus sur soi-même`);
    if (!/^200 écrit \(/.test(dir)) defauts.push(`${nom} : DIR devrait écrire (« ${dir} »)`);
  } else defauts.push(`${nom} : nature inconnue ${ecart.nature}`);
  return defauts;
}

describe('Directeur aligné sur l’administration : la colonne DIR de chaque référence de la matrice des droits est celle d’AD', () => {
  test('références de la matrice : celles attendues, ni plus ni moins (une nouvelle référence doit être classée ici)', () => {
    assert.deepEqual(readdirSync(DOSSIER).filter((f) => f.endsWith('.txt')).sort(), [...REFERENCES].sort());
  });

  for (const fichier of REFERENCES) {
    test(`${fichier} : chaque ligne de DIR est celle d’AD (entrées « par AD » lues « par DIR »), sauf la liste fermée des écarts, chacun vérifié`, () => {
      const ad = lignesDe(fichier, 'AD');
      const dir = lignesDe(fichier, 'DIR');
      const ecarts = new Map((ECARTS[fichier] ?? []).map((e) => [e.cle, e]));
      assert.equal(ecarts.size, (ECARTS[fichier] ?? []).length, `${fichier} : écart déclaré deux fois`);
      const defauts = [];
      for (const cle of new Set([...ad.keys(), ...dir.keys()])) {
        const ecart = ecarts.get(cle);
        if (ecart) { defauts.push(...verifierEcart(fichier, ecart, ad.get(cle), dir.get(cle))); continue; }
        if (!ad.has(cle)) defauts.push(`${fichier} : ligne de DIR sans ligne d’AD : ${cle} | ${dir.get(cle)}`);
        else if (!dir.has(cle)) defauts.push(`${fichier} : ligne d’AD sans ligne de DIR : ${cle} | ${ad.get(cle)}`);
        else if (commeDir(ad.get(cle)) !== dir.get(cle)) defauts.push(`${fichier} : ${cle}\n  AD  ${ad.get(cle)}\n  DIR ${dir.get(cle)}`);
      }
      // Liste fermée : chaque écart déclaré existe (ni ligne disparue, ni écart devenu égal).
      for (const ecart of ecarts.values()) if (!ad.has(ecart.cle) && !dir.has(ecart.cle)) defauts.push(`${fichier} : écart déclaré sans ligne : ${ecart.cle}`);
      assert.deepEqual(defauts, [], `${fichier} : colonne DIR différente de celle d’AD hors de la liste fermée`);
      // Le directeur est bien joué dans cette référence quand AD l'est (une colonne DIR vide passerait sinon pour égale).
      if (ad.size) assert.ok(dir.size >= ad.size - (ECARTS[fichier] ?? []).filter((e) => !ad.has(e.cle)).length, `${fichier} : DIR moins joué qu’AD`);
    });
  }

  // La branche DIRECTEUR de blockCommercial est retirée : son message ne figure plus dans aucune référence (le directeur
  // commercial garde le sien, distinct).
  test('aucune référence ne porte plus le refus « Accès non autorisé pour un compte directeur. »', () => {
    const lignes = REFERENCES.flatMap((fichier) => lire(fichier).filter((ligne) => ligne.includes('« Accès non autorisé pour un compte directeur. »')).map((ligne) => `${fichier} : ${ligne}`));
    assert.deepEqual(lignes, []);
    // Témoin : le message du directeur commercial, voisin, y figure toujours.
    assert.ok(lire('entrees.txt').some((ligne) => ligne.includes('« Accès non autorisé pour un compte directeur commercial. »')));
  });

  test('témoin de la comparaison : un refus du directeur, un montant de plus masqué ou une entrée à un autre nom sont des écarts', () => {
    const fichier = 'montants.txt';
    const ecart = ECARTS[fichier].find((e) => e.nature === 'réponse masquée');
    const ad = '200 écrit (Chantier) ; aucune entrée ; réponse : budgetGlobalVendu présent, coutMaterielPrevu présent, budgetMaterielVendu présent, budgetMainOeuvreVendu présent ; montants inchangés en base';
    assert.deepEqual(verifierEcart(fichier, ecart, ad, ad.replace('budgetGlobalVendu présent, coutMaterielPrevu présent', 'budgetGlobalVendu null, coutMaterielPrevu null')), []);
    // Un budget par poste masqué en plus (« Toute la vue financière », option écartée) est un défaut.
    assert.equal(verifierEcart(fichier, ecart, ad, ad.replace('budgetGlobalVendu présent, coutMaterielPrevu présent, budgetMaterielVendu présent', 'budgetGlobalVendu null, coutMaterielPrevu null, budgetMaterielVendu null')).length, 1);
    // La réponse de l'administration rendue au directeur sous le réglage coupé (réglage ignoré) est un défaut.
    assert.equal(verifierEcart(fichier, ecart, ad, ad).length, 1);
    const montants = ECARTS['donnees.txt'].find((e) => e.cle === `GET /api/stats/conducteurs | — | ${SANS_REGLAGE} | montants CT`);
    const performancesAd = 'depensesTotal=présent, manqueAGagnerMainOeuvre=présent, caTotal=présent, margeTotal=présent, margePct=présent';
    assert.deepEqual(verifierEcart('donnees.txt', montants, performancesAd, 'depensesTotal=présent, manqueAGagnerMainOeuvre=présent, caTotal=null, margeTotal=null, margePct=null'), []);
    // Les dépenses masquées au directeur (coût de main-d'œuvre, montré à l'administration quel que soit le réglage) : défaut.
    assert.equal(verifierEcart('donnees.txt', montants, performancesAd, 'depensesTotal=null, manqueAGagnerMainOeuvre=présent, caTotal=null, margeTotal=null, margePct=null').length, 1);
    assert.equal(commeDir('entrées : JournalSaisieChantier CHANTIER CHANGEMENT_COMMERCIAL par AD'), 'entrées : JournalSaisieChantier CHANTIER CHANGEMENT_COMMERCIAL par DIR');
    assert.equal(commeDir('entrées : JournalAdministration COMPTE CREATION par AD-COM'), 'entrées : JournalAdministration COMPTE CREATION par AD-COM', 'AD-COM n’est pas AD');
  });
});
