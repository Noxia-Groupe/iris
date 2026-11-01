// Liste FERMÉE des montants masqués selon le demandeur (lot D1a, cadrage version 3, §3 ligne D1a-3 et §6).
//
// Lecture retenue du cadrage §6, déclarée d'avance : un champ de montant que le code retire ou met à null selon le
// demandeur (session, type de compte, périmètre, clé d'intégration) et qui manquerait ici est un « test manquant qui
// touche un montant », classé C (bloquant). La liste est donc établie à partir du code, et non de la documentation.
//
// Méthode de recherche (relevé du 01-11-2026, sur main c95bf06), dans tout server/src :
//  1. les fonctions de visibilité et leurs appels : voitMontantsChantier, voitCoutMainOeuvre, voitPrixAchatDevis,
//     voitRattachementMainOeuvre, ecritPrixAchatDevis, sansMontantsSaisie, sansTauxHoraire, saisieSelonDroits
//     (droits/visibilite.ts) ; voitRentabilite, chantierSansMontants, chantierSansCoutMainOeuvre,
//     chantierSelonRentabilite, peutVoirFinance (domaines/chantiers/droits.ts) ; devisPourLecteur,
//     ficheCataloguePourLecteur, equipementPourLecteur, heureOperationnelleTechnicien ;
//  2. les réglages qui masquent : margeCommercialeActive, rentabiliteConducteur, rentabiliteHierarchie,
//     rentabiliteDirecteurs, et le scope finances:read ;
//  3. les décisions selon le rôle qui retirent un champ : `isAdmin ? … : null`, `role === …`, `canSeeMarge`,
//     `…Visible ? … : null`, `delete copie[…]`, les déstructurations `{ champ: _masque, ...reste }` ;
//  4. chaque route de lecture qui répond 200 avec un montant a été relue (inventaire des 75 lectures de session et
//     des 10 lectures /api/v1), et ses réponses explorées pour chaque compte.
// Le test « aucun champ masqué hors de la liste » de matrice-droits-donnees.test.mjs complète ce relevé à
// l'exécution : un champ numérique, ou un objet, présent pour un compte et nul ou absent pour un autre sur le même
// objet, doit figurer ici ou dans CHAMPS_MASQUES_HORS_MONTANTS (non-montants, avec leur raison).
//
// peutVoirFinance (chantiers/droits.ts:112) n'est appelée par aucune route : elle ne masque rien aujourd'hui.

// --- Types d'objets qui portent un montant masqué, et où ils se trouvent dans chaque réponse de lecture ---
// `routes` : route de lecture → chemin de l'objet dans sa réponse (« . » : la réponse elle-même ; « [] » : chaque
// élément de la liste racine ; « .x[] » : chaque élément de la liste x). `selon` : champ de l'objet qui en fixe la
// nature (journal des saisies : la cible de l'entrée), pour un type dont les montants dépendent de cette nature.
export const TYPES_MONTANTS = {
  chantier: {
    libelle: 'chantier sérialisé (liste, fiche, clé chantiers:read)',
    routes: { 'GET /api/chantiers': '[]', 'GET /api/chantiers/:id': '.', 'GET /api/v1/chantiers': '[]' },
  },
  'achat-chantier': { libelle: 'achat d’un chantier (journal des achats)', routes: { 'GET /api/achats': '[]', 'GET /api/v1/achats': '[]' } },
  'heure-chantier': { libelle: 'heures d’un chantier (journal des heures)', routes: { 'GET /api/heures': '[]', 'GET /api/v1/heures': '[]' } },
  'journal-saisie': {
    libelle: 'entrée du journal des saisies (chantier, intervention), selon sa cible',
    routes: { 'GET /api/chantiers/:id/journal-saisies': '[]', 'GET /api/interventions/:id/journal-saisies': '[]' },
    selon: 'cible',
  },
  intervenant: { libelle: 'fiche intervenant', routes: { 'GET /api/intervenants': '[]' } },
  'couts-intervention': { libelle: 'coûts d’une intervention', routes: { 'GET /api/interventions/:id/couts': '.' } },
  devis: { libelle: 'devis (liste)', routes: { 'GET /api/devis': '[]', 'GET /api/v1/devis': '[]' } },
  'fiche-devis': { libelle: 'fiche du catalogue proposée au devis', routes: { 'GET /api/devis/catalogue': '[]' } },
  'fiche-catalogue': { libelle: 'fiche du catalogue', routes: { 'GET /api/catalogue/:family': '[]', 'GET /api/v1/catalogue/:family': '[]' } },
  equipement: { libelle: 'équipement du parc, avec son modèle du catalogue', routes: { 'GET /api/clients/:clientId/equipements': '[]', 'GET /api/v1/clients/:clientId/equipements': '[]' } },
  'stats-global': { libelle: 'tableau de bord', routes: { 'GET /api/stats/global': '.' } },
  'stats-conducteur': { libelle: 'statistiques d’un conducteur', routes: { 'GET /api/stats/conducteurs': '[]' } },
  'stats-intervenant': { libelle: 'statistiques d’un intervenant', routes: { 'GET /api/stats/intervenants': '.intervenants[]' } },
  'stats-commercial': { libelle: 'résultat d’un commercial', routes: { 'GET /api/stats/commerciaux': '.commerciaux[]' } },
};

// Valeurs dérivées des montants, enregistrées avec eux mais qui ne sont pas des montants : les codes d'alerte d'un
// chantier (les alertes de dépassement sont retirées au technicien, « en perte » et « marge faible » ne sortent
// qu'avec la marge ; chantiers/droits.ts:70, chantiers/suivi.ts:154 et :210).
export const VALEURS_DERIVEES = { chantier: ['metrics.alertes'] };

// Comptes de la référence (comptes.mjs) et clés de la matrice des données (« CLE <scope> », « CLE <scope>+finances:read »).
const ADMIN = ['SA', 'AD', 'AD-COM'];

// Une entrée : type d'objet, chemins du champ dans l'objet (un seul, sauf les instantanés du journal, avant et
// après), règle, source dans le code, comptes qui le voient (un au moins doit l'avoir présent) et comptes qui ne le
// voient pas (un au moins doit l'avoir nul ou absent sur un objet qui le porte ; aucun ne doit l'avoir présent) ;
// `reglages` : contextes où un compte qui le voit par défaut le perd ; `routes` : les seules routes du type qui
// portent le champ (la fiche d'un chantier, et non sa liste) ; `inatteignable` : masquage écrit dans le code mais
// qu'aucune lecture ne peut montrer, avec sa raison.
const M = (type, chemins, regle, source, { voit, masque = [], reglages = [], cible = null, routes = null, inatteignable = null }) => ({
  type, chemins: Array.isArray(chemins) ? chemins : [chemins], regle, source, voit, masque, reglages, cible, routes, inatteignable,
});
const RENTABILITE = 'voitRentabilite : administration ; directeur si rentabiliteDirecteurs ; titulaire conducteur ou responsable si rentabiliteConducteur ; responsable de la branche du titulaire si rentabiliteHierarchie ; clé portant finances:read';
const MONTANTS_CHANTIER = 'voitMontantsChantier : tout compte sauf le technicien ; toute clé';
const COUT_MO = 'voitCoutMainOeuvre : administration ; toute clé';
const MARGE = `${RENTABILITE} ; et margeCommercialeActive`;
const SRC_SERIALISE = 'chantiers/suivi.ts:226-239 (serializeChantier)';

export const MONTANTS_MASQUES = [
  // --- Chantier : liste, fiche, clé chantiers:read ---
  M('chantier', 'budgetGlobalVendu', RENTABILITE, `${SRC_SERIALISE}, l.233 ; chantiers/droits.ts:23-35`, {
    voit: [...ADMIN, 'DIR', 'CT', 'RESP', 'CLE chantiers:read+finances:read'], masque: ['COM', 'DC', 'AC', 'CPT', 'TECH', 'CLE chantiers:read'],
    reglages: ['rentabiliteConducteur=non', 'rentabiliteDirecteurs=non', 'rentabiliteHierarchie=non'],
  }),
  M('chantier', 'budgetMaterielVendu', MONTANTS_CHANTIER, 'chantiers/droits.ts:61 (chantierSansMontants) ; droits/visibilite.ts:11-14', { voit: [...ADMIN, 'CT', 'COM'], masque: ['TECH'] }),
  M('chantier', 'budgetMainOeuvreVendu', MONTANTS_CHANTIER, 'chantiers/droits.ts:62 (chantierSansMontants)', { voit: [...ADMIN, 'CT', 'COM'], masque: ['TECH'] }),
  M('chantier', 'coutMaterielPrevu', `(voitPrixAchatDevis ou ${RENTABILITE}) et ${MONTANTS_CHANTIER}`, `${SRC_SERIALISE}, l.234`, {
    voit: [...ADMIN, 'CT', 'CLE chantiers:read+finances:read'], masque: ['COM', 'TECH', 'CLE chantiers:read'], reglages: ['rentabiliteConducteur=non'],
  }),
  M('chantier', 'metrics.materielReel', MONTANTS_CHANTIER, 'chantiers/droits.ts:67', { voit: [...ADMIN, 'CT', 'COM'], masque: ['TECH'] }),
  M('chantier', 'metrics.pctMateriel', MONTANTS_CHANTIER, 'chantiers/droits.ts:67', { voit: [...ADMIN, 'CT', 'COM'], masque: ['TECH'] }),
  M('chantier', 'metrics.moReel', COUT_MO, 'chantiers/droits.ts:48 (chantierSansCoutMainOeuvre) et :67', { voit: [...ADMIN, 'CLE chantiers:read'], masque: ['CT', 'COM', 'TECH'] }),
  M('chantier', 'metrics.totalDepenses', COUT_MO, 'chantiers/droits.ts:48 et :67', { voit: [...ADMIN, 'CLE chantiers:read'], masque: ['CT', 'COM', 'TECH'] }),
  M('chantier', 'metrics.pctMainOeuvre', COUT_MO, 'chantiers/droits.ts:48 et :67', { voit: [...ADMIN, 'CLE chantiers:read'], masque: ['CT', 'COM', 'TECH'] }),
  M('chantier', 'metrics.coutsSuites.coutMainOeuvre', COUT_MO, 'chantiers/droits.ts:49 et :68', { voit: [...ADMIN, 'CLE chantiers:read'], masque: ['CT', 'COM', 'TECH'] }),
  M('chantier', 'metrics.coutsSuites.materiel', MONTANTS_CHANTIER, 'chantiers/droits.ts:68', { voit: [...ADMIN, 'CT', 'COM'], masque: ['TECH'] }),
  M('chantier', 'metrics.coutsInterventionDevis.coutMainOeuvre', COUT_MO, 'chantiers/droits.ts:50 et :69', { voit: [...ADMIN, 'CLE chantiers:read'], masque: ['CT', 'COM', 'TECH'] }),
  M('chantier', 'metrics.coutsInterventionDevis.materiel', MONTANTS_CHANTIER, 'chantiers/droits.ts:69', { voit: [...ADMIN, 'CT', 'COM'], masque: ['TECH'] }),
  ...['margeBrute', 'margeCommerciale', 'margePct', 'margeEstimee', 'margeEstimeePct', 'estimation'].map((champ) => M('chantier', `metrics.${champ}`, MARGE, 'chantiers/suivi.ts:139-141 (computeChantierMetrics)', {
    voit: [...ADMIN, 'DIR', 'CT', 'RESP', 'CLE chantiers:read+finances:read'], masque: ['COM', 'DC', 'AC', 'CPT', 'TECH', 'CLE chantiers:read'],
    reglages: ['margeCommercialeActive=non', 'rentabiliteConducteur=non', 'rentabiliteDirecteurs=non', 'rentabiliteHierarchie=non'],
  })),
  // Estimation présente (rentabilité) : ses coûts de main-d'œuvre restent masqués hors administration. Ses autres
  // champs (coût matériel attendu, ratio, sources) ne sont masqués qu'avec l'estimation entière.
  ...['coutEstime', 'coutMainOeuvreAttendu', 'coutHoraireReference'].map((champ) => M('chantier', `metrics.estimation.${champ}`, COUT_MO, 'chantiers/droits.ts:51 (chantierSansCoutMainOeuvre)', {
    voit: [...ADMIN, 'CLE chantiers:read+finances:read'], masque: ['CT', 'RESP', 'DIR'],
  })),
  M('chantier', 'achats[].montantHT', MONTANTS_CHANTIER, 'chantiers/droits.ts:63 ; droits/visibilite.ts:18-26 (sansMontantsSaisie)', { voit: [...ADMIN, 'CT', 'CLE chantiers:read'], masque: ['TECH'] }),
  M('chantier', 'pointages[].tauxHoraireApplique', COUT_MO, 'chantiers/droits.ts:45 et :64 ; droits/visibilite.ts:41-50 (sansTauxHoraire)', { voit: [...ADMIN, 'CLE chantiers:read'], masque: ['CT', 'TECH'] }),
  M('chantier', 'pointages[].intervenant.tauxHoraireCharge', COUT_MO, 'chantiers/routes.ts:141 (intervenant joint à la fiche) ; droits/visibilite.ts:47 et :24', { voit: ADMIN, masque: ['CT', 'TECH'], routes: ['GET /api/chantiers/:id'] }),
  M('chantier', 'facturation', RENTABILITE, 'chantiers/routes.ts:168-177 (fiche seulement)', {
    voit: [...ADMIN, 'DIR', 'CT', 'RESP'], masque: ['COM', 'DC', 'AC', 'CPT', 'TECH'], reglages: ['rentabiliteConducteur=non', 'rentabiliteDirecteurs=non', 'rentabiliteHierarchie=non'], routes: ['GET /api/chantiers/:id'],
  }),

  // --- Journaux des achats et des heures (et leurs jumelles /api/v1) ---
  M('achat-chantier', 'montantHT', MONTANTS_CHANTIER, 'chantiers/saisies.ts:96', { voit: [...ADMIN, 'CT', 'CLE chantiers:read'], masque: ['TECH'] }),
  M('heure-chantier', 'tauxHoraireApplique', `saisieSelonDroits : ${COUT_MO}`, 'chantiers/saisies.ts:115 ; droits/visibilite.ts:53-57', { voit: [...ADMIN, 'CLE chantiers:read'], masque: ['CT', 'TECH'] }),
  M('heure-chantier', 'intervenant.tauxHoraireCharge', `saisieSelonDroits : ${COUT_MO}`, 'chantiers/saisies.ts:115 ; droits/visibilite.ts:24 et :47', { voit: [...ADMIN, 'CLE chantiers:read'], masque: ['CT', 'TECH'] }),

  // --- Journal des saisies : instantanés avant et après, selon la cible de l'entrée ---
  M('journal-saisie', ['avant.montantHT', 'apres.montantHT'], `saisieSelonDroits : ${MONTANTS_CHANTIER}`, 'chantiers/routes.ts:200-201', { cible: 'ACHAT', voit: [...ADMIN, 'CT'], masque: ['TECH'] }),
  M('journal-saisie', ['avant.tauxHoraireApplique', 'apres.tauxHoraireApplique'], `saisieSelonDroits : ${COUT_MO}`, 'chantiers/routes.ts:200-201', { cible: 'HEURE', voit: ADMIN, masque: ['CT', 'TECH'] }),
  M('journal-saisie', ['avant.tauxHoraireApplique', 'apres.tauxHoraireApplique'], `saisieSelonDroits : ${COUT_MO}`, 'interventions/routes.ts:269-270', { cible: 'COUT_INTERVENTION_HEURE', voit: ADMIN, masque: ['CT'] }),
  M('journal-saisie', ['avant.prixVenteHoraireApplique', 'apres.prixVenteHoraireApplique'], `saisieSelonDroits : ${COUT_MO}`, 'interventions/routes.ts:269-270 ; droits/visibilite.ts:41', { cible: 'COUT_INTERVENTION_HEURE', voit: ADMIN, masque: ['CT'] }),
  M('journal-saisie', ['avant.montantHT', 'apres.montantHT'], `saisieSelonDroits : ${MONTANTS_CHANTIER}`, 'interventions/routes.ts:269-270', {
    cible: 'COUT_INTERVENTION_ACHAT', voit: [...ADMIN, 'CT'],
    inatteignable: 'seul le technicien perd ce montant, et le journal SAV lui est refusé (403) avant toute lecture (interventions/routes.ts:267)',
  }),

  // --- Fiches intervenant ---
  M('intervenant', 'tauxHoraireCharge', `saisieSelonDroits : ${COUT_MO}`, 'utilisateurs/equipes.ts:60', { voit: ADMIN, masque: ['CT', 'COM', 'TECH'] }),
  // Le rattachement désigne le prix de vente à l'heure de la main d'œuvre du catalogue (visibilite.ts:72-78) : il
  // est masqué avec le taux.
  M('intervenant', 'mainOeuvreId', 'voitRattachementMainOeuvre : administration en session seulement', 'utilisateurs/equipes.ts:56-58 ; droits/visibilite.ts:76-78', { voit: ADMIN, masque: ['CT', 'COM', 'TECH'] }),
  M('intervenant', 'mainOeuvre', 'voitRattachementMainOeuvre : administration en session seulement', 'utilisateurs/equipes.ts:56-58', { voit: ADMIN, masque: ['CT', 'COM', 'TECH'] }),

  // --- Coûts d'une intervention ---
  M('couts-intervention', 'heures[].tauxHoraireApplique', `${COUT_MO} ; le technicien ne reçoit que ses heures, sans montant`, 'interventions/routes.ts:95-104 et :116', { voit: ADMIN, masque: ['CT', 'TECH'] }),
  M('couts-intervention', 'heures[].prixVenteHoraireApplique', `${COUT_MO} ; le technicien ne reçoit que ses heures, sans montant`, 'interventions/routes.ts:95-104 et :116', { voit: ADMIN, masque: ['CT', 'TECH'] }),
  M('couts-intervention', 'achats', 'encadrement (administration, conducteur)', 'interventions/routes.ts:95-104', { voit: [...ADMIN, 'CT'], masque: ['TECH'] }),
  M('couts-intervention', 'totalMainOeuvreHT', COUT_MO, 'interventions/routes.ts:116', { voit: ADMIN, masque: ['CT', 'TECH'] }),
  M('couts-intervention', 'totalMaterielHT', 'encadrement (administration, conducteur)', 'interventions/routes.ts:95-104', { voit: [...ADMIN, 'CT'], masque: ['TECH'] }),
  M('couts-intervention', 'totalCoutsHT', COUT_MO, 'interventions/routes.ts:116', { voit: ADMIN, masque: ['CT', 'TECH'] }),
  M('couts-intervention', 'margeDevis', `${COUT_MO} (administration seule)`, 'interventions/routes.ts:116-121', { voit: ADMIN, masque: ['CT', 'TECH'] }),
  M('couts-intervention', 'margeSav', `${COUT_MO} (administration seule)`, 'interventions/routes.ts:116-124', { voit: ADMIN, masque: ['CT', 'TECH'] }),

  // --- Prix d'achat : devis, catalogue, parc ---
  M('devis', 'lignes[].prixAchatUnitaireHt', 'voitPrixAchatDevis : administration en session ; clé portant finances:read', 'devis/metier.ts:163-172 (devisPourLecteur) ; droits/visibilite.ts:63-67', {
    voit: [...ADMIN, 'CLE devis:read+finances:read'], masque: ['COM', 'DC', 'AC', 'CPT', 'CLE devis:read'],
  }),
  M('fiche-devis', 'prixAchatHt', 'voitPrixAchatDevis : administration en session', 'devis/routes.ts:459 et :469', { voit: ADMIN, masque: ['COM', 'DC', 'AC', 'CPT'] }),
  M('fiche-catalogue', 'prixAchatHt', 'voitPrixAchatDevis : administration en session ; clé portant finances:read', 'catalogue/metier.ts:100-110 (ficheCataloguePourLecteur) ; catalogue/routes.ts:52', {
    voit: [...ADMIN, 'CLE catalogue:read+finances:read'], masque: ['CLE catalogue:read'],
  }),
  M('equipement', 'catalogueEquipement.prixAchatHt', 'voitPrixAchatDevis : administration en session ; clé portant finances:read', 'clients/equipements.ts:12-23 (equipementPourLecteur) et :82', {
    voit: [...ADMIN, 'CLE equipements:read+finances:read'], masque: ['CLE equipements:read'],
  }),

  // --- Tableau de bord et statistiques ---
  M('stats-global', 'achatsTotal', `non commercial, et ${MONTANTS_CHANTIER}`, 'statistiques/routes.ts:83-88', { voit: [...ADMIN, 'CT', 'DIR'], masque: ['COM', 'TECH'] }),
  M('stats-global', 'caTotal', 'administration, et margeCommercialeActive', 'statistiques/routes.ts:94-108', { voit: ADMIN, masque: ['CT', 'COM', 'DIR'], reglages: ['margeCommercialeActive=non'] }),
  M('stats-global', 'margeTotal', 'administration ou commercial, et margeCommercialeActive', 'statistiques/routes.ts:109 et :117', { voit: [...ADMIN, 'COM'], masque: ['CT', 'DIR', 'TECH'], reglages: ['margeCommercialeActive=non'] }),
  M('stats-global', 'margePct', 'administration, et margeCommercialeActive', 'statistiques/routes.ts:110', { voit: ADMIN, masque: ['CT', 'COM', 'DIR'], reglages: ['margeCommercialeActive=non'] }),
  M('stats-global', 'commissionCommercialeTotal', 'administration, et margeCommercialeActive', 'statistiques/routes.ts:111', { voit: ADMIN, masque: ['CT', 'COM', 'DIR'], reglages: ['margeCommercialeActive=non'] }),
  M('stats-global', 'commissionTotal', 'commercial, et margeCommercialeActive', 'statistiques/routes.ts:118', { voit: ['COM'], masque: [...ADMIN, 'CT', 'DIR'], reglages: ['margeCommercialeActive=non'] }),
  M('stats-conducteur', 'depensesTotal', 'administration', 'statistiques/routes.ts:226', { voit: ADMIN, masque: ['RESP'] }),
  M('stats-conducteur', 'manqueAGagnerMainOeuvre', 'administration', 'statistiques/routes.ts:227', { voit: ADMIN, masque: ['RESP'] }),
  M('stats-conducteur', 'caTotal', `administration ou ${RENTABILITE}`, 'statistiques/routes.ts:184-186 et :228', { voit: [...ADMIN, 'RESP'], reglages: ['rentabiliteHierarchie=non'] }),
  M('stats-conducteur', 'margeTotal', `administration, ou ${MARGE}`, 'statistiques/routes.ts:187-190 et :229', { voit: [...ADMIN, 'RESP'], reglages: ['margeCommercialeActive=non', 'rentabiliteHierarchie=non'] }),
  M('stats-conducteur', 'margePct', `administration, ou ${MARGE}`, 'statistiques/routes.ts:230', { voit: [...ADMIN, 'RESP'], reglages: ['margeCommercialeActive=non', 'rentabiliteHierarchie=non'] }),
  M('stats-intervenant', 'cout', COUT_MO, 'statistiques/routes.ts:394-398', { voit: ADMIN, masque: ['CT', 'RESP'] }),
  // Masquée par le seul réglage : un commercial ne lit que sa ligne, l'administration toutes (liste, et non champ).
  M('stats-commercial', 'chantiers[].margeCommerciale', 'margeCommercialeActive', 'commissions/routes.ts:66 et :95 ; chantiers/suivi.ts:139-141', { voit: [...ADMIN, 'COM'], reglages: ['margeCommercialeActive=non'] }),
];

// Champs masqués selon le demandeur qui ne sont pas des montants : le test « aucun champ masqué hors de la liste »
// les admet, avec leur raison. Clé : route, puis chemin du champ dans la réponse (« . » : la réponse elle-même) ou
// dans chaque élément de la liste racine (« [] »).
export const CHAMPS_MASQUES_HORS_MONTANTS = {
  'GET /api/stats/global . nbTerminesNonEncaisses': 'compteur de chantiers, réservé à l’administration (statistiques/routes.ts:77-81)',
  'GET /api/stats/global . heuresTotal': 'heures, et non montant : ni l’administration ni le commercial ne le reçoivent (statistiques/routes.ts:89-92)',
};

// Montants masqués par une MISE À ZÉRO, et non par null ou absent, selon un réglage : un zéro est un nombre
// « présent », que ni le statut de la matrice ni le test « aucun champ masqué hors de la liste » ne distinguent d'une
// valeur visible. Ils sont observés par le test « montants mis à zéro » de matrice-droits-donnees.test.mjs : non nuls
// par défaut pour chaque compte de `voit`, zéro sous le réglage, jamais null ni absent. Résultat commercial : la marge
// de chaque chantier est nulle quand la marge commerciale est coupée (chantiers/suivi.ts:139-141), et chaque total du
// commercial la compte pour zéro (commissions/metier.ts:78-79 et :93-96). Les commissions et primes du même résultat
// (commissionBareme, commissionStandard, commissionReduite, primeCA, primeMarge, primeAdmin, commissionTotal, et
// chantiers[].commissionEstimee) suivent la même marge, mais valent zéro avec ou sans le réglage tant qu'aucun plan
// commercial n'existe (commissions/metier.ts:46-52, décision du 17-10-2026) : rien à observer aujourd'hui.
export const MONTANTS_MIS_A_ZERO = [
  {
    route: 'GET /api/stats/commerciaux', element: 'ligne du commercial COM (commerciaux[])', champs: ['margeTotal', 'margeStandard', 'margeReduite'],
    regle: 'margeCommercialeActive : la marge de chaque chantier est nulle et comptée zéro dans les totaux du commercial',
    source: 'commissions/metier.ts:78-79 et :93-96 ; commissions/routes.ts:47-54', voit: ['SA', 'AD', 'AD-COM', 'COM'], reglage: 'margeCommercialeActive=non',
  },
];

// Montants masqués dans les RÉPONSES D'ÉCRITURE : même règle que la lecture, mais une écriture réelle est nécessaire
// pour les voir. Ils relèvent de D1a-5 (écritures réelles, cadrage §3) et ne sont pas observés ici ; ils sont listés
// pour que la liste soit fermée.
export const MONTANTS_MASQUES_ECRITURES = [
  { routes: ['PATCH /api/chantiers/:id', 'PATCH /api/chantiers/:id/statut', 'PATCH /api/chantiers/:id/commercial'], champs: ['budgetGlobalVendu', 'coutMaterielPrevu', 'budgetMaterielVendu', 'budgetMainOeuvreVendu'], source: 'chantiers/droits.ts:95-101 (chantierSelonRentabilite) ; chantiers/routes.ts:383, :451, :497' },
  { routes: ['POST /api/devis/:id/convertir', 'POST /api/v1/devis/:id/convertir'], champs: ['coutMaterielPrevu'], source: 'devis/routes.ts:423' },
  { routes: ['POST /api/devis', 'PATCH /api/devis/:id', 'POST /api/devis/:id/revisions', 'PUT /api/devis/:id/statut', 'POST /api/devis/:id/acompte', 'POST /api/devis/:id/annulation', 'POST /api/devis/:id/duplication', 'et leurs jumelles /api/v1'], champs: ['lignes[].prixAchatUnitaireHt'], source: 'devis/routes.ts:82, :113, :136, :237, :564, :582, :648 (devisPourLecteur)' },
  { routes: ['POST /api/heures', 'PATCH /api/heures/:id', 'POST /api/heures/:id/restaurer'], champs: ['tauxHoraireApplique', 'intervenant.tauxHoraireCharge'], source: 'chantiers/saisies.ts:286, :339, :393 (saisieSelonDroits)' },
  { routes: ['POST /api/interventions/:id/couts/heures', 'PATCH /api/interventions/:id/couts/heures/:coutId'], champs: ['tauxHoraireApplique', 'prixVenteHoraireApplique'], source: 'interventions/metier.ts:96-98 (heureOperationnelleTechnicien) ; interventions/routes.ts:154 et :234' },
  { routes: ['POST /api/interventions/:id/couts/:type/:coutId/:action'], champs: ['tauxHoraireApplique', 'prixVenteHoraireApplique', 'montantHT'], source: 'interventions/routes.ts:257 (saisieSelonDroits)' },
  { routes: ['POST /api/catalogue/:family', 'PUT /api/catalogue/:family/:id', 'DELETE /api/catalogue/:family/:id', 'et leurs jumelles /api/v1'], champs: ['prixAchatHt'], source: 'catalogue/routes.ts:67, :71, :86, :91, :111, :112 (ficheCataloguePourLecteur)' },
  { routes: ['POST /api/clients/:clientId/equipements', 'POST /api/clients/:clientId/equipements/:id/archiver', 'et leurs jumelles /api/v1'], champs: ['catalogueEquipement.prixAchatHt'], source: 'clients/equipements.ts:92 et :104 (equipementPourLecteur)' },
];
