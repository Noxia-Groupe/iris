// Lot « Assistante technique », PR AT-1 (cadrage version 2.1, section « PR AT-1 », « Tests » : « clé AT ajoutée à la matrice
// des droits (comptes.mjs, 11 types, 16 comptes), références régénérées, et un test fermé « AT = encadrement SAV » sur le
// modèle de matrice-droits-directeur.test.mjs »).
//
// Décisions appliquées : décisions de Nelson du 24-10-2026, points 15, 16, 18 et 28 (« Les droit de toute la partie
// technique », planning compris ; crée l'intervention de suivi liée), section « lots prévus », point 2 (toute la société) ;
// réponses de Nelson du 06-11-2026 : 2 (« Décochée (Recommandé) » : ni vendu, ni marge, ni estimation), 4 (« Prix d'achat
// oui, coûts non » : ni taux horaire ni coût de main-d'œuvre) et 7 (« Oui, comme le conducteur (Recommandé) » : matériel
// SAV saisi, corrigé et archivé comme le conducteur). Fermetures d'AT-1 (cadrage, « Fermé à AT-1 ») : écritures des
// chantiers, devis, contrats, saisies Travaux, factures ; Statistiques, Performances et Mes commerciaux (choix par défaut,
// à confirmer) ; refus du nouveau middleware sur la fiche, le statut et le commercial d'une affaire.
//
// Chaque référence versionnée de la matrice des droits (lot D1a, server/tests/matrice-droits/*.txt) est comparée au
// caractère près au comportement réel par son propre fichier de test. Ce fichier-ci vérifie, dans ces références, que la
// colonne AT est celle d'un compte de l'encadrement SAV, ligne par ligne, selon une règle FERMÉE par route :
//  - par défaut, AT a la ligne du conducteur (CT) : planning, référentiels des achats, lectures et refus communs ;
//  - sur les routes de « toute la société » (ROUTES_COMME_AD : SAV entier et affaires en lecture), AT a la ligne de
//    l'administration (AD), ses montants réduits à ceux du conducteur : une liste fermée de montants et de clés que AD lit
//    et que AT ne lit pas (rentabilité, coût prévu, taux et coût de main-d'œuvre, marges du SAV), chacun nul ou absent
//    pour AT, tous les autres montants dans l'état d'AD ;
//  - sur une suite rattachée à une affaire clôturée, AT a la ligne de CT (verifierAffaireDeLaSuite : seule
//    l'administration y écrit encore) ; avec un droit individuel sur les saisies Travaux, celle de l'assistante
//    commerciale (AC), sans affaire à elle (assertChantierWritable reste une liste fermée) ;
//  - une liste fermée de refus nommés (REFUS) : message exact, aucune écriture.
// Les entrées de journal sont nommées par leur auteur : « par AD » ou « par CT » est lu « par AT » avant la comparaison.
//
// PR AT-2a « Devis, clients et contrats » (cadrage AT-2, version 1, section « AT-2a », et version 2, C1 à C4, T1 à T3 et
// N10 ; réponses de Nelson du 06-11-2026, 3, 4, 5, 8 et 9, docs/HISTORIQUE-DECISIONS.md#décisions-du-06-11-2026-sur-lassistante-technique).
// La règle fermée s'étend, route par route, sans règle nouvelle :
//  - « comme AD » (ROUTES_COMME_AD_AT2A) : les devis (droit devis par son type, prix d'achat prévu lu et écrit), les
//    écritures des clients et la lecture du parc (gereLesClients), la gestion des contrats, passage manuel de la
//    génération compris (gereLesContrats) ; dans les réponses d'écriture des références échantillonnées, les montants de
//    MONTANTS_MASQUES_AT y restent nuls ou absents pour AT (coût prévu de la réponse de conversion : piège P1, il suit sa
//    rentabilité, fermée jusqu'à AT-2b) ;
//  - refus nommés au message exact (« Accès réservé aux administrateurs », sans écriture) : acompte et annulation d'un
//    devis, création d'un contrat hors devis, couverture, réglages (anticipation), écriture du parc, routes du catalogue ;
//  - droits individuels : ceux qu'elle porte désormais par son type (devis) ne lui ajoutent rien, comme à l'administration.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const DOSSIER = join(dirname(fileURLToPath(import.meta.url)), 'matrice-droits');
const SEPARATEUR = ' | ';
// Nombre de champs de la clé d'une ligne (compte compris), comme le fichier de test de chaque référence (champsCle).
const CHAMPS_CLE = { 'donnees.txt': 5, 'individuels.txt': 6, 'individuels-sans-gain.txt': 6 };
const INDIVIDUELS = ['individuels.txt', 'individuels-sans-gain.txt'];
// Références où les lectures (GET) nomment l'entrée de journal lue (« … par X ← X route … ») : la lecture d'une entrée
// par AT est comparée à celle d'AD, qui lit toutes les entrées.
const LECTURES_DES_JOURNAUX = ['journaux.txt', 'factures.txt', 'montants.txt'];
// Références où un compte refusé à l'entrée d'une route n'est pas rejoué (cadrage de D1a-5b et suivants) : AT n'y a pas de
// ligne sur une route de REFUS, là où CT en a.
const SANS_REFUS_REJOUES = ['ecritures-modifications.txt', 'montants.txt', 'journaux.txt', 'factures.txt'];
// Références échantillonnées : chaque cas y est joué par une liste de comptes qui lui est propre (SA, AD et un compte hors
// administration qui écrit le couple, cadrage de D1a-5c §2.1 ; comptes admis des 8 groupes, D1a-5d-2). AT n'y est jouée que
// sur ses cas (SAV, droits devis individuels) : chacune de ses lignes est comparée à celle d'AD sur le même cas, ou de SA si
// seul SA le joue parmi l'administration (restauration du matériel archivé par AD), ou de CT hors des routes de toute la
// société ; un cas joué par d'autres et non par elle n'est pas un écart.
const ECHANTILLONS = ['journaux.txt', 'montants.txt'];
const REFERENCES = ['cles-montants.txt', 'cles.txt', 'donnees.txt', 'ecritures-actions.txt', 'ecritures-modifications.txt', 'entrees.txt', 'factures.txt', 'individuels-sans-gain.txt', 'individuels.txt', 'journaux.txt', 'montants.txt'];

// --- Règle fermée par route ---

// « Toute la société » : SAV entier (voitToutLeSav, estEncadrementCoutIntervention, estEncadrementSuivi) et affaires en
// lecture (litToutesLesAffaires : liste, fiche, journal des saisies, historique client, journaux des achats et des heures).
const ROUTES_COMME_AD = new Set([
  'GET /api/chantiers', 'GET /api/chantiers/:id', 'GET /api/chantiers/:id/journal-saisies', 'GET /api/clients/:id/chantiers', 'GET /api/achats', 'GET /api/heures',
  'GET /api/interventions', 'GET /api/interventions/journee', 'GET /api/interventions/:id', 'GET /api/interventions/:id/couts', 'GET /api/interventions/:id/envois',
  'GET /api/interventions/:id/journal-saisies', 'GET /api/interventions/:id/document.pdf', 'GET /api/planning/events', 'GET /api/planning/interventions-a-planifier',
  'POST /api/interventions', 'PATCH /api/interventions/:id/statut', 'POST /api/interventions/:id/rapports', 'POST /api/interventions/rapports/:rapportId/signature',
  'POST /api/interventions/:id/envois', 'POST /api/interventions/:id/remise-a-planifier', 'POST /api/interventions/:id/suites', 'PUT /api/interventions/:id/a-suivre',
  'PUT /api/interventions/:id/planning', 'POST /api/interventions/:id/couts/achats', 'POST /api/interventions/:id/couts/heures', 'PATCH /api/interventions/:id/couts/:type/:coutId',
  'POST /api/interventions/:id/couts/:type/:coutId/:action',
]);
// AT-2a : devis (réponse 3 : « Tous, contrats compris » ; aucun périmètre sur les devis), clients et parc en lecture
// (réponses 3 et 8 ; requireGestionClients), contrats et génération des visites (réponses 3 et 9 ; requireGestionContrats).
const ROUTES_COMME_AD_AT2A = [
  'GET /api/devis', 'POST /api/devis', 'PATCH /api/devis/:id', 'POST /api/devis/:id/revisions', 'POST /api/devis/:id/signature', 'GET /api/devis/:id/document.pdf',
  'GET /api/devis/:id/envois', 'POST /api/devis/:id/envois', 'PUT /api/devis/:id/statut', 'POST /api/devis/:id/convertir', 'GET /api/devis/a-convertir',
  'POST /api/devis/:id/duplication', 'GET /api/devis/catalogue',
  'POST /api/clients', 'PUT /api/clients/:id', 'DELETE /api/clients/:id', 'POST /api/clients/:clientId/contacts', 'PUT /api/clients/:clientId/contacts/:id',
  'POST /api/clients/:clientId/sites', 'PUT /api/clients/:clientId/sites/:id', 'GET /api/clients/:clientId/equipements',
  'GET /api/contrats-maintenance', 'GET /api/contrats-maintenance/generation-visites', 'POST /api/contrats-maintenance/generation-visites',
  'GET /api/contrats-maintenance/:id/journal-saisies', 'GET /api/contrats-maintenance/:id/document.pdf', 'GET /api/contrats-maintenance/:id/envois',
  'POST /api/contrats-maintenance/:id/envois', 'PATCH /api/contrats-maintenance/:id/statut', 'POST /api/contrats-maintenance/:id/avancer-echeance',
  'POST /api/contrats-maintenance/:id/generer-intervention',
];
for (const route of ROUTES_COMME_AD_AT2A) ROUTES_COMME_AD.add(route);
// Droits individuels qu'elle porte par son type depuis AT-2a (DEFAULT_USER_PERMISSIONS) : ils ne lui ajoutent rien, comme à
// l'administration ; ses lignes « type + droit » sont donc celles d'AD (aucune, sauf écart).
const DROITS_PORTES_AT2A = ['droit devis', 'devis:read', 'devis:write'];

const REFUS_AFFAIRE = 'Un compte assistante technique n’est pas autorisé à modifier une affaire.';
const REFUS_TRAVAUX = 'Accès réservé au suivi Travaux.';
const REFUS_ECRITURE_TRAVAUX = 'Permission requise : chantiers:write';
const REFUS_ADMINISTRATION = 'Accès réservé aux administrateurs';
// Refus de la gestion des clients et des contrats (requireGestionClients, requireGestionContrats ; message exact du cadrage
// AT-2a), reçu par chaque autre compte hors administration.
const REFUS_GESTION = 'Accès réservé à l’administration et à l’assistante technique.';
// Refus nommés, route par route (message exact) : la ligne d'AT est ce refus, sans écriture, quel que soit le contexte par
// défaut (les contextes « droit chantiers:… » suivent la règle d'AC, plus bas).
const REFUS = {
  'PATCH /api/chantiers/:id': REFUS_AFFAIRE,
  'PATCH /api/chantiers/:id/statut': REFUS_AFFAIRE,
  'PATCH /api/chantiers/:id/commercial': REFUS_AFFAIRE,
  'GET /api/stats/conducteurs': REFUS_TRAVAUX,
  'GET /api/stats/conducteurs/assiduite': REFUS_TRAVAUX,
  'GET /api/stats/fournisseurs': REFUS_TRAVAUX,
  'GET /api/stats/intervenants': REFUS_TRAVAUX,
  'GET /api/stats/types-chantiers': REFUS_TRAVAUX,
  'POST /api/achats': REFUS_ECRITURE_TRAVAUX,
  'POST /api/heures': REFUS_ECRITURE_TRAVAUX,
  'PATCH /api/achats/:id': REFUS_ECRITURE_TRAVAUX,
  'PATCH /api/heures/:id': REFUS_ECRITURE_TRAVAUX,
  // AT-2a, restés à l'administration (requireAdmin) : acompte et annulation d'un devis (cadrage, « Devis ») ; création hors
  // devis et couverture d'un contrat, réglage de l'anticipation (C1, choix par défaut, à confirmer) ; écriture du parc et
  // routes du catalogue (C2, choix par défaut, à confirmer).
  'POST /api/devis/:id/acompte': REFUS_ADMINISTRATION,
  'POST /api/devis/:id/annulation': REFUS_ADMINISTRATION,
  'POST /api/contrats-maintenance': REFUS_ADMINISTRATION,
  'PATCH /api/contrats-maintenance/:id': REFUS_ADMINISTRATION,
  'PUT /api/parametres': REFUS_ADMINISTRATION,
  'POST /api/clients/:clientId/equipements': REFUS_ADMINISTRATION,
  'POST /api/clients/:clientId/equipements/:id/archiver': REFUS_ADMINISTRATION,
  'GET /api/catalogue/:family': REFUS_ADMINISTRATION,
  'POST /api/catalogue/:family': REFUS_ADMINISTRATION,
  'PUT /api/catalogue/:family/:id': REFUS_ADMINISTRATION,
  'DELETE /api/catalogue/:family/:id': REFUS_ADMINISTRATION,
};
// Suites d'une affaire clôturée : AT reçoit le refus de CT (verifierAffaireDeLaSuite), et non l'écriture d'AD.
const CIBLES_AFFAIRE_CLOSE = ['suite-affaire-close', 'materiel-suite-affaire-close', 'heures-suite-affaire-close'];
// Droit devis par son type depuis AT-2a (réponse 3 du 06-11-2026).
const VALEURS_ME = 'role=ASSISTANTE_TECHNIQUE ; accesFinance=non ; permissions=chantiers:read+clients:read+devis:read+devis:write';

// --- Montants et clés que AD lit et que AT ne lit pas (liste fermée), sur les routes de ROUTES_COMME_AD ---
// Rentabilité (voitRentabilite : vendu, marges, estimation, facturation), coût prévu (voitCoutPrevuParPrixAchat), taux et coût
// de main-d'œuvre (voitCoutMainOeuvre), marge du devis et d'un SAV hors contrat (administration seule).
const MONTANTS_MASQUES_AT = [
  'budgetGlobalVendu', 'coutMaterielPrevu', 'facturation',
  'metrics.margeBrute', 'metrics.margeCommerciale', 'metrics.margePct', 'metrics.margeEstimee', 'metrics.margeEstimeePct', 'metrics.estimation',
  'metrics.moReel', 'metrics.totalDepenses', 'metrics.pctMainOeuvre', 'metrics.coutsSuites.coutMainOeuvre', 'metrics.coutsInterventionDevis.coutMainOeuvre',
  'pointages[].tauxHoraireApplique', 'pointages[].intervenant.tauxHoraireCharge', 'tauxHoraireApplique', 'intervenant.tauxHoraireCharge',
  'avant.tauxHoraireApplique', 'apres.tauxHoraireApplique', 'avant.prixVenteHoraireApplique', 'apres.prixVenteHoraireApplique',
  'heures[].tauxHoraireApplique', 'heures[].prixVenteHoraireApplique', 'totalMainOeuvreHT', 'totalCoutsHT', 'margeDevis', 'margeSav',
];
// Un champ sous un objet masqué l'est avec lui (l'estimation entière, et ses coûts).
const sousObjetMasque = (champ) => champ.startsWith('metrics.estimation.');
// Montants que AT lit comme AD et CT (budgets par poste, matériel, achats, matériel SAV) : jamais masqués pour elle. Leur
// présence chez AT, là où AD les a, est vérifiée par la comparaison ; cette liste sert au témoin et au résumé.
const MONTANTS_LUS_AT = ['budgetMaterielVendu', 'budgetMainOeuvreVendu', 'metrics.materielReel', 'metrics.pctMateriel', 'metrics.coutsSuites.materiel', 'metrics.coutsInterventionDevis.materiel', 'achats[].montantHT', 'montantHT', 'avant.montantHT', 'apres.montantHT', 'achats', 'totalMaterielHT'];
const CLES_MASQUEES_AT = ['facturation', 'tauxHoraireApplique', 'tauxHoraireApplique?', 'tauxHoraireCharge', 'prixVenteHoraireApplique', 'prixVenteHoraireApplique?', 'margeDevis', 'margeSav'];
const OBJETS_MASQUES_AT = ['.facturation', '[].metrics.estimation', '.metrics.estimation', '.margeSav', '.margeDevis', '.margeDevis.devis'];

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
    const cle = champs.slice(1, n).join(SEPARATEUR);
    assert.ok(!lignes.has(cle), `${fichier} : deux lignes de ${compte} pour ${cle}`);
    lignes.set(cle, champs.slice(n).join(SEPARATEUR));
  }
  return lignes;
}

// « par AD » ou « par CT » (et non « par AD-COM », « par CT-N1 ») lu « par AT ».
const commeAt = (valeur, auteur) => valeur?.replace(new RegExp(`\\bpar ${auteur}(?![\\w-])`, 'g'), 'par AT');
// « champ=état, champ=état, … » → Map.
const etats = (valeur) => new Map(valeur.split(', ').map((morceau) => { const i = morceau.indexOf('='); return [morceau.slice(0, i), morceau.slice(i + 1)]; }));
const MASQUE = ['null', 'absent'];

// Ligne attendue d'AT à partir de celle d'AD, sur une route de toute la société, pour donnees.txt : rend { attendu } (ligne
// exacte, ou undefined pour une ligne absente) ou { verifier } (fonction qui rend la liste des défauts).
function attenduDonneesCommeAd(objet, ad) {
  if (ad === undefined) return { attendu: undefined };
  if (objet.startsWith('clés ')) {
    const chemin = objet.slice('clés '.length);
    if (OBJETS_MASQUES_AT.includes(chemin)) return { attendu: undefined };
    return { attendu: ad.split(', ').filter((cle) => !CLES_MASQUEES_AT.includes(cle)).join(', ') };
  }
  if (objet.startsWith('montants')) {
    return {
      verifier: (at) => {
        if (at === undefined) return ['ligne absente pour AT'];
        const a = etats(ad); const t = etats(at);
        const defauts = [];
        for (const champ of new Set([...a.keys(), ...t.keys()])) {
          const ea = a.get(champ) ?? 'absent'; const et = t.get(champ) ?? 'absent';
          if (MONTANTS_MASQUES_AT.includes(champ) || sousObjetMasque(champ)) {
            if (!MASQUE.includes(et)) defauts.push(`${champ} devrait être masqué pour AT (${et})`);
          } else if (ea !== et) defauts.push(`${champ} différent hors des montants masqués (AD ${ea}, AT ${et})`);
        }
        return defauts;
      },
    };
  }
  return { attendu: ad };
}

// Références échantillonnées (journaux, montants), routes de toute la société : la ligne d'AD, sauf dans la partie
// « réponse : champ état, … » des écritures, où chaque montant de MONTANTS_MASQUES_AT présent pour AD est nul ou absent pour
// AT (AT-2a : coût prévu de la réponse de conversion, piège P1) ; tout le reste au caractère près. Rend une fonction qui
// liste les défauts. Une ligne d'AD absente : la ligne d'AT doit l'être aussi.
function verifierReponseCommeAd(ad) {
  const parties = (ligne) => {
    const m = /^(.*? ; réponse : )(.*?)( ; .*)?$/.exec(ligne);
    return m ? { avant: m[1], champs: new Map(m[2].split(', ').map((x) => { const i = x.lastIndexOf(' '); return [x.slice(0, i), x.slice(i + 1)]; })), apres: m[3] ?? '' } : null;
  };
  return (at) => {
    if (ad === undefined && at === undefined) return [];
    if (ad === undefined || at === undefined) return [`ligne d’AD ${ad ?? '(absente)'} ; ligne d’AT ${at ?? '(absente)'}`];
    const pa = parties(ad); const pt = parties(at);
    // Sans montant de réponse relevé : au caractère près. Même ligne qu'AD : les montants masqués y sont encore vérifiés.
    if (!pa && !pt) return at === ad ? [] : [`ligne différente de celle d’AD\n  AD ${ad}\n  AT ${at}`];
    if (!pa || !pt || pa.avant !== pt.avant || pa.apres !== pt.apres) return [`ligne différente de celle d’AD hors des montants de la réponse\n  AD ${ad}\n  AT ${at}`];
    const defauts = [];
    for (const champ of new Set([...pa.champs.keys(), ...pt.champs.keys()])) {
      const ea = pa.champs.get(champ) ?? 'absent'; const et = pt.champs.get(champ) ?? 'absent';
      if (MONTANTS_MASQUES_AT.includes(champ)) { if (!MASQUE.includes(et)) defauts.push(`${champ} devrait être masqué pour AT dans la réponse (${et})`); } else if (ea !== et) defauts.push(`${champ} différent dans la réponse (AD ${ea}, AT ${et})`);
    }
    return defauts;
  };
}

// Règle d'une ligne d'AT : rend { modele, attendu?, verifier?, absentAdmis? } pour la clé donnée.
function regle(fichier, cle, lignes) {
  const champs = cle.split(SEPARATEUR);
  const individuel = INDIVIDUELS.includes(fichier);
  const droit = individuel ? champs[0] : null;
  const route = individuel ? champs[1] : champs[0];
  const cible = individuel ? champs[2] : champs[1];
  const contexte = individuel ? champs[3] : champs[2];
  const objet = fichier === 'donnees.txt' ? champs[3] : null;
  // Droits individuels : AT a les gains de CT, sauf sur les saisies Travaux, où elle a ceux d'AC (aucune affaire à elle) ;
  // depuis AT-2a, le droit devis, qu'elle porte par son type, ne lui ajoute rien, comme au commercial, qui le porte aussi
  // par son type sans lire les comptes (aucune ligne).
  if (individuel) {
    if (DROITS_PORTES_AT2A.includes(droit)) return { modele: 'COM', attendu: lignes.COM.get(cle) };
    const modele = /^chantiers:(write|archive)$/.test(droit) ? 'AC' : 'CT';
    return { modele, attendu: lignes[modele].get(cle) };
  }
  // Contextes « droit chantiers:… » des écritures (droits individuels sans gain rejoués) : comme AC.
  if (/^droit chantiers:(write|archive)/.test(contexte ?? '')) return { modele: 'AC', attendu: lignes.AC.get(cle) };
  // Lectures des entrées de journal : comme AD, qui lit toutes les entrées.
  if (LECTURES_DES_JOURNAUX.includes(fichier) && route.startsWith('GET ')) {
    return { modele: 'AD', attendu: lignes.AD.get(cle), absentAdmis: true };
  }
  if (fichier === 'donnees.txt' && route === 'GET /api/me' && objet === 'valeurs') return { modele: 'nommé', attendu: VALEURS_ME };
  if (REFUS[route]) {
    const message = `403 « ${REFUS[route]} »`;
    return {
      modele: 'refus',
      verifier: (at) => {
        if (at === undefined) {
          // Lecture refusée : aucune donnée ; écriture refusée à l'entrée : non rejouée dans ces références.
          if (fichier === 'donnees.txt' || SANS_REFUS_REJOUES.includes(fichier)) return [];
          return ['ligne absente pour AT'];
        }
        if (at === message || at === `${message} inchangé` || at.startsWith(`${message} inchangé ;`)) return [];
        return [`refus attendu ${message} (AT « ${at} »)`];
      },
    };
  }
  if (ROUTES_COMME_AD.has(route)) {
    if (CIBLES_AFFAIRE_CLOSE.includes(cible)) return { modele: 'CT', attendu: commeAt(lignes.CT.get(cle), 'CT') };
    if (ECHANTILLONS.includes(fichier) && !lignes.AD.has(cle)) return { modele: 'SA', attendu: commeAt(lignes.SA.get(cle), 'SA'), absentAdmis: true };
    const ad = commeAt(lignes.AD.get(cle), 'AD');
    // factures.txt rejoue chaque corps de l'administration par les seuls comptes refusés à l'entrée : depuis AT-2a, elle
    // écrit les clients (écriture indirecte « client renommé ») et n'y est plus jouée ; une ligne d'AT, s'il y en a, est celle
    // d'AD.
    if (fichier === 'factures.txt' && ROUTES_COMME_AD_AT2A.includes(route)) return { modele: 'AD', attendu: ad, absentAdmis: true };
    if (ECHANTILLONS.includes(fichier)) return { modele: 'AD', verifier: verifierReponseCommeAd(ad), absentAdmis: true };
    if (fichier === 'donnees.txt') return { modele: 'AD', ...attenduDonneesCommeAd(objet, ad) };
    return { modele: 'AD', attendu: ad };
  }
  return { modele: 'CT', attendu: commeAt(lignes.CT.get(cle), 'CT') };
}

function comparer(fichier) {
  const lignes = { AT: lignesDe(fichier, 'AT'), AD: lignesDe(fichier, 'AD'), CT: lignesDe(fichier, 'CT'), AC: lignesDe(fichier, 'AC'), SA: lignesDe(fichier, 'SA'), COM: lignesDe(fichier, 'COM') };
  const defauts = [];
  const parModele = {};
  const cles = new Set([...lignes.AT.keys()]);
  // Clés des modèles sur les routes qu'AT ne peut ignorer : une ligne de CT (par défaut) ou d'AD (toute la société) sans
  // ligne d'AT est un écart, sauf refus non rejoué ou lecture de journal.
  for (const modele of ['AD', 'CT']) for (const cle of lignes[modele].keys()) cles.add(cle);
  for (const cle of cles) {
    const r = regle(fichier, cle, lignes);
    const at = lignes.AT.get(cle);
    // Une clé d'un autre modèle que celui de la règle ne concerne pas AT (ex. : ligne d'AD sur une route où AT suit CT).
    if (at === undefined && r.modele !== 'refus' && !['nommé'].includes(r.modele)) {
      const source = lignes[r.modele]?.get(cle);
      if (source === undefined) continue;
      if (r.absentAdmis) continue;
      // Références échantillonnées : un cas de CT que AT ne joue pas n'est pas un écart.
      if (ECHANTILLONS.includes(fichier)) continue;
    }
    parModele[r.modele] = (parModele[r.modele] ?? 0) + (at === undefined ? 0 : 1);
    if (r.verifier) {
      for (const d of r.verifier(at)) defauts.push(`${fichier} : ${cle} (${r.modele}) : ${d}`);
    } else if (r.attendu !== at) {
      defauts.push(`${fichier} : ${cle} (règle ${r.modele})\n  attendu ${r.attendu}\n  AT      ${at}`);
    }
  }
  return { defauts, parModele, nombre: lignes.AT.size };
}

describe('Assistante technique (AT-1, AT-2a) : la colonne AT de chaque référence de la matrice des droits est celle de l’encadrement SAV, route par route, puis celle de l’administration sur les devis, les clients et les contrats', () => {
  test('références de la matrice : celles attendues, ni plus ni moins (une nouvelle référence doit être classée ici)', () => {
    assert.deepEqual(readdirSync(DOSSIER).filter((f) => f.endsWith('.txt')).sort(), [...REFERENCES].sort());
  });

  for (const fichier of REFERENCES) {
    test(`${fichier} : chaque ligne d’AT suit sa règle (CT par défaut, AD sur toute la société sans rentabilité, coût prévu ni main-d’œuvre, refus nommés)`, (t) => {
      const { defauts, parModele, nombre } = comparer(fichier);
      assert.deepEqual(defauts, [], `${fichier} : colonne AT hors de la règle fermée`);
      t.diagnostic(`${fichier} : ${nombre} ligne(s) d’AT ; par règle : ${Object.entries(parModele).map(([m, n]) => `${m} ${n}`).join(', ') || 'aucune'}`);
    });
  }

  // La règle n'est pas vide : AT est jouée là où les autres comptes le sont, et chaque famille de la règle s'applique.
  test('AT est jouée dans chaque référence où CT l’est, et chaque famille de la règle (AD, CT, AC, refus) s’applique au moins une fois', () => {
    const familles = new Set();
    for (const fichier of REFERENCES) {
      const at = lignesDe(fichier, 'AT'); const ct = lignesDe(fichier, 'CT');
      // individuels.txt (gains) : depuis AT-2a, aucun droit individuel ne lui ajoute de gain. Le droit devis est porté par son
      // type ; les saisies Travaux, une fois le droit donné, lui sont refusées plus loin (404, aucune affaire à elle :
      // individuels-sans-gain.txt, règle d'AC), comme à l'assistante commerciale, qui n'y a pas de ligne non plus.
      if (fichier === 'individuels.txt') {
        assert.equal(at.size, 0, `${fichier} : un gain d’AT est à classer`);
        assert.equal(lignesDe(fichier, 'AC').size, 0, `${fichier} : témoin, l’assistante commerciale n’y a pas de ligne`);
        continue;
      }
      if (ct.size) assert.ok(at.size > 0, `${fichier} : CT y est joué, AT non`);
      for (const [m, n] of Object.entries(comparer(fichier).parModele)) if (n) familles.add(m);
    }
    assert.deepEqual([...familles].sort(), ['AC', 'AD', 'CT', 'SA', 'nommé', 'refus']);
    // Les onze types et les cinq variantes : seize comptes joués (cadrage, « 11 types, 16 comptes »).
    // PUBLIC : le lien public du planning, joué sans session.
    const comptes = new Set(lire('entrees.txt').map((ligne) => ligne.split(SEPARATEUR)[0]).filter((c) => !['ANONYME', 'JETON-INVALIDE', 'DESACTIVE', 'SYSTEME', 'SUPPRIME', 'PUBLIC'].includes(c)));
    assert.equal(comptes.size, 16, [...comptes].sort().join(', '));
    assert.ok(comptes.has('AT'));
  });

  // Ouvertures du cadrage (T3 du contrôle), lues dans la référence des entrées : planning (lecture, créneaux, types, file),
  // référentiels des achats (POST, PUT, DELETE), SAV de toute la société, affaires en lecture ; et les refus du cadrage (T1).
  test('entrees.txt : ouvertures et refus du cadrage AT-1, lus ligne à ligne', () => {
    const at = lignesDe('entrees.txt', 'AT');
    const ligne = (route, cible = '—', contexte = 'défaut') => at.get([route, cible, contexte].join(SEPARATEUR));
    // Ouvertures : admises à l'entrée (2xx, ou 400/404/500 après la garde, jamais 401 ni 403).
    for (const [route, cible] of [
      ['POST /api/fournisseurs'], ['PUT /api/fournisseurs/:id', 'fournisseur'], ['DELETE /api/fournisseurs/:id', 'inexistant'],
      ['POST /api/categories'], ['PUT /api/categories/:id', 'categorie'], ['DELETE /api/categories/:id', 'inexistant'],
      ['GET /api/planning/events'], ['POST /api/planning/events'], ['PATCH /api/planning/events/:id', 'inexistant'], ['DELETE /api/planning/events/:id', 'inexistant'],
      ['GET /api/planning/types'], ['POST /api/planning/types'], ['PUT /api/planning/types/:id', 'type-planning'], ['DELETE /api/planning/types/:id', 'inexistant'],
      ['GET /api/planning/interventions-a-planifier'], ['GET /api/chantiers'], ['GET /api/chantiers/:id', 'chantier-autre'], ['GET /api/chantiers/:id/journal-saisies', 'chantier-autre'],
      ['GET /api/stats/global'], ['GET /api/interventions/:id', 'intervention-autre'], ['POST /api/interventions'],
    ]) {
      const valeur = ligne(route, cible);
      assert.ok(valeur !== undefined, `${route} ${cible ?? ''} : ligne absente`);
      assert.doesNotMatch(valeur, /^40[13]/, `${route} ${cible ?? ''} : ${valeur}`);
    }
    // Refus du cadrage, message exact.
    assert.equal(ligne('GET /api/stats/conducteurs'), `403 « ${REFUS_TRAVAUX} »`);
    assert.equal(ligne('PATCH /api/chantiers/:id', 'chantier-ct'), `403 « ${REFUS_AFFAIRE} »`);
    assert.equal(ligne('PATCH /api/chantiers/:id', 'inexistant'), `403 « ${REFUS_AFFAIRE} »`, 'refus avant le 404');
    assert.equal(ligne('POST /api/achats'), `403 « ${REFUS_ECRITURE_TRAVAUX} »`);
    assert.equal(ligne('GET /api/chantiers/:id/document.pdf', 'chantier-ct'), '403 « Accès réservé aux administrateurs »');
    assert.match(ligne('POST /api/planning/share'), /^403 « Accès réservé aux administrateurs »/);
    assert.match(ligne('PATCH /api/users/:id/est-commercial', 'inexistant'), /^403 « Accès réservé aux administrateurs »/);
    // Factures : AT-3. La liste des contrats et les devis, fermés en AT-1, s'ouvrent avec AT-2a (test suivant) ; la création
    // d'un contrat hors devis reste à l'administration.
    for (const route of ['GET /api/factures', 'POST /api/factures', 'POST /api/contrats-maintenance']) assert.match(ligne(route), /^403 « Accès réservé aux administrateurs »/, route);
    // Module Planning coupé : fermé à AT comme aux autres comptes.
    assert.match(ligne('GET /api/planning/events', '—', 'planningActif=non'), /^403 PLANNING_DESACTIVE/);
  });

  // PR AT-2a (cadrage v1, « AT-2a », et v2, C1 et C2 ; réponses 3, 4, 5, 8 et 9 du 06-11-2026) : ouvertures et refus lus dans la
  // référence des entrées ; le refus des gardes de la gestion des clients et des contrats, au message exact, pour chaque autre
  // compte hors administration, et l'administration et le directeur admis comme elle.
  test('entrees.txt : ouvertures et refus du cadrage AT-2a (devis, clients et parc en lecture, contrats et génération ; acompte, annulation, contrat hors devis, couverture, anticipation, écriture du parc et catalogue à l’administration), lus ligne à ligne', () => {
    const at = lignesDe('entrees.txt', 'AT');
    const ligne = (route, cible = '—', contexte = 'défaut', lignes = at) => lignes.get([route, cible, contexte].join(SEPARATEUR));
    // Ouvertures : admises à l'entrée (2xx, ou 400/404/409 après la garde, jamais 401 ni 403).
    const OUVERTURES = [
      ['GET /api/devis'], ['POST /api/devis'], ['PATCH /api/devis/:id', 'devis-brouillon'], ['PUT /api/devis/:id/statut', 'devis-brouillon'], ['POST /api/devis/:id/signature', 'devis-brouillon'],
      ['POST /api/devis/:id/convertir', 'devis-signe'], ['GET /api/devis/catalogue'], ['GET /api/devis/a-convertir'], ['GET /api/devis/:id/document.pdf', 'devis-signe'],
      ['POST /api/clients'], ['PUT /api/clients/:id', 'client-actif'], ['DELETE /api/clients/:id', 'inexistant'], ['POST /api/clients/:clientId/contacts', 'client-actif'],
      ['PUT /api/clients/:clientId/contacts/:id', 'contact-client-actif'], ['POST /api/clients/:clientId/sites', 'client-actif'], ['PUT /api/clients/:clientId/sites/:id', 'site-client-actif'],
      ['GET /api/clients/:clientId/equipements', 'client-actif'],
      ['GET /api/contrats-maintenance'], ['GET /api/contrats-maintenance/generation-visites'], ['POST /api/contrats-maintenance/generation-visites'],
      ['GET /api/contrats-maintenance/:id/journal-saisies', 'contrat-actif'], ['GET /api/contrats-maintenance/:id/document.pdf', 'contrat-actif'], ['GET /api/contrats-maintenance/:id/envois', 'contrat-actif'],
      ['POST /api/contrats-maintenance/:id/envois', 'contrat-actif'], ['PATCH /api/contrats-maintenance/:id/statut', 'contrat-actif'], ['POST /api/contrats-maintenance/:id/avancer-echeance', 'contrat-actif'],
      ['POST /api/contrats-maintenance/:id/generer-intervention', 'inexistant'],
    ];
    for (const [route, cible] of OUVERTURES) {
      const valeur = ligne(route, cible);
      assert.ok(valeur !== undefined, `${route} ${cible ?? ''} : ligne absente`);
      assert.doesNotMatch(valeur, /^40[13]/, `${route} ${cible ?? ''} : ${valeur}`);
    }
    assert.equal(ligne('GET /api/contrats-maintenance/:id/document.pdf', 'contrat-actif'), '200');
    assert.equal(ligne('GET /api/clients/:clientId/equipements', 'client-actif'), '200');
    assert.match(ligne('POST /api/contrats-maintenance/generation-visites'), /^409 « La génération automatique des visites est désactivée/, 'passage manuel admis, réglage vide');
    // Refus restés à l'administration, message exact (choix par défaut, à confirmer, sauf l'acompte et l'annulation).
    for (const [route, cible] of [
      ['POST /api/devis/:id/acompte', 'devis-signe'], ['POST /api/devis/:id/annulation', 'devis-signe'], ['POST /api/contrats-maintenance'], ['PATCH /api/contrats-maintenance/:id', 'contrat-actif'],
      ['PUT /api/parametres'], ['POST /api/clients/:clientId/equipements', 'client-actif'], ['POST /api/clients/:clientId/equipements/:id/archiver', 'inexistant'],
      ['GET /api/catalogue/:family', 'family=prestations'], ['POST /api/catalogue/:family', 'family=prestations'], ['PUT /api/catalogue/:family/:id', 'prestation-catalogue'], ['DELETE /api/catalogue/:family/:id', 'inexistant'],
    ]) assert.equal(ligne(route, cible), `403 « ${REFUS_ADMINISTRATION} »`, `${route} ${cible ?? ''}`);
    // Gardes de la gestion des clients et des contrats : chaque autre compte hors administration reçoit leur refus, au message
    // exact, sur chacune des dix-huit routes ; l'administration, le directeur et AT y entrent.
    const ROUTES_GARDEES = ROUTES_COMME_AD_AT2A.filter((r) => /\/api\/(clients|contrats-maintenance)/.test(r));
    assert.equal(ROUTES_GARDEES.length, 18, ROUTES_GARDEES.join(', '));
    const cles = lire('entrees.txt').map((l) => l.split(SEPARATEUR));
    const vues = new Set();
    for (const [compte, route, , contexte, reponse] of cles) {
      if (!ROUTES_GARDEES.includes(route) || contexte !== 'défaut') continue;
      vues.add(`${compte} ${route}`);
      if (['SA', 'AD', 'AD-COM', 'DIR', 'AT'].includes(compte)) assert.doesNotMatch(reponse, /^40[13]/, `${compte} ${route} : ${reponse}`);
      else if (['CT', 'CT-N1', 'RESP', 'RESP-SANS-BRANCHE', 'TECH', 'TECH-SANS-FICHE', 'COM', 'DC', 'AC', 'CPT', 'CPT-FINANCE'].includes(compte)) assert.match(reponse, new RegExp(`^403 « ${REFUS_GESTION} »( inchangé)?$`), `${compte} ${route}`);
    }
    for (const compte of ['CT', 'COM', 'AC', 'AT', 'AD']) for (const route of ROUTES_GARDEES) assert.ok(vues.has(`${compte} ${route}`), `${compte} ${route} : jouée`);
  });

  test('témoins de la règle : un montant de rentabilité, de coût prévu ou de main-d’œuvre lu par AT, un budget par poste masqué, un refus changé ou une entrée à un autre nom sont des écarts', () => {
    const ad = 'budgetGlobalVendu=présent, budgetMaterielVendu=présent, coutMaterielPrevu=présent, metrics.moReel=présent, metrics.materielReel=présent, achats[].montantHT=présent';
    const at = 'budgetGlobalVendu=null, budgetMaterielVendu=présent, coutMaterielPrevu=null, metrics.moReel=null, metrics.materielReel=présent, achats[].montantHT=présent';
    const { verifier } = attenduDonneesCommeAd('montants', ad);
    assert.deepEqual(verifier(at), []);
    // Lecture écartée : « Rentabilité selon un réglage » ouverte par défaut (réponse 2 de Nelson, « Décochée ») : le vendu lu.
    assert.equal(verifier(at.replace('budgetGlobalVendu=null', 'budgetGlobalVendu=présent')).length, 1);
    // Lecture écartée : coût prévu lu (voitCoutPrevuParPrixAchat élargi).
    assert.equal(verifier(at.replace('coutMaterielPrevu=null', 'coutMaterielPrevu=présent')).length, 1);
    // Lecture écartée : coût de main-d'œuvre lu (réponse 4, « coûts non »).
    assert.equal(verifier(at.replace('metrics.moReel=null', 'metrics.moReel=présent')).length, 1);
    // Lecture écartée : « Toute la vue financière » masquée (budgets par poste et matériel ôtés).
    assert.equal(verifier(at.replace('budgetMaterielVendu=présent', 'budgetMaterielVendu=null')).length, 1);
    assert.equal(verifier(at.replace('metrics.materielReel=présent', 'metrics.materielReel=absent')).length, 1);
    for (const champ of MONTANTS_LUS_AT) assert.ok(!MONTANTS_MASQUES_AT.includes(champ), `${champ} : lu et masqué à la fois`);
    // Clés : la facturation et les taux ôtés, le reste gardé.
    assert.deepEqual(attenduDonneesCommeAd('clés .', 'achats, facturation, id, metrics').attendu, 'achats, id, metrics');
    assert.equal(attenduDonneesCommeAd('clés .margeSav', 'coutsHT, margeHT').attendu, undefined);
    // Refus : message exact, sans écriture.
    const lignes = { AT: new Map(), AD: new Map(), CT: new Map(), AC: new Map(), SA: new Map() };
    const refus = regle('entrees.txt', 'PATCH /api/chantiers/:id | chantier-ct | défaut', lignes);
    assert.deepEqual(refus.verifier(`403 « ${REFUS_AFFAIRE} »`), []);
    assert.equal(refus.verifier('404 « Chantier introuvable »').length, 1);
    assert.equal(refus.verifier(`403 « ${REFUS_AFFAIRE} » écrit (Chantier)`).length, 1);
    assert.equal(refus.verifier(undefined).length, 1, 'entrees.txt rejoue chaque compte');
    assert.equal(commeAt('entrées : JournalSaisieChantier COUT_INTERVENTION_ACHAT CREATION par CT', 'CT'), 'entrées : JournalSaisieChantier COUT_INTERVENTION_ACHAT CREATION par AT');
    assert.equal(commeAt('entrées : JournalSaisieChantier CHANTIER CHANGEMENT par CT-N1', 'CT'), 'entrées : JournalSaisieChantier CHANTIER CHANGEMENT par CT-N1', 'CT-N1 n’est pas CT');
    // AT-2a : la réponse de conversion d'AT donne le coût prévu (piège P1) : écart ; masqué : conforme ; le prix d'achat prévu
    // d'une ligne de devis, lu par AT comme par AD, masqué pour elle : écart.
    const conversionAd = '201 écrit (Chantier,DevisConversion) ; aucune entrée ; réponse : coutMaterielPrevu présent ; montants du chantier ouvert relus en base conformes';
    const verifierConversion = verifierReponseCommeAd(conversionAd);
    assert.deepEqual(verifierConversion(conversionAd.replace('coutMaterielPrevu présent', 'coutMaterielPrevu null')), []);
    assert.equal(verifierConversion(conversionAd).length, 1, 'coût prévu lu par AT');
    assert.equal(verifierConversion(conversionAd.replace('relus en base conformes', 'relus en base différents')).length, 1, 'constat des montants changé');
    const devisAd = '201 écrit (Devis,DevisLigne,SequenceAffaire) ; aucune entrée ; réponse : lignes[].prixAchatUnitaireHt présent ; montants du devis relus en base conformes';
    assert.deepEqual(verifierReponseCommeAd(devisAd)(devisAd), []);
    assert.equal(verifierReponseCommeAd(devisAd)(devisAd.replace('prixAchatUnitaireHt présent', 'prixAchatUnitaireHt absent')).length, 1, 'prix d’achat masqué pour AT');
    // Refus d'AT-2a : l'acompte écrit, ou refusé sous un autre message, est un écart.
    const acompte = regle('ecritures-actions.txt', 'POST /api/devis/:id/acompte | devis-signe | défaut', lignes);
    assert.deepEqual(acompte.verifier(`403 « ${REFUS_ADMINISTRATION} » inchangé`), []);
    assert.equal(acompte.verifier('200 écrit (Devis)').length, 1);
    assert.equal(acompte.verifier(`403 « ${REFUS_GESTION} » inchangé`).length, 1);
    // Droit devis donné à AT : aucune ligne, comme le commercial ; une ligne serait un écart.
    const droitDevis = regle('individuels.txt', 'droit devis | GET /api/devis | — | défaut | entrée', { ...lignes, COM: new Map() });
    assert.equal(droitDevis.modele, 'COM');
    assert.equal(droitDevis.attendu, undefined);
  });
});
