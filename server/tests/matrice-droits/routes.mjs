// Table des routes de session des matrices de droits (lot D1a, cadrage version 3, §2.1 à §2.4).
//
// Chaque route de session de l'application a ici une entrée, et une seule : la famille de cibles que désigne son
// paramètre de dossier (null si elle n'en a pas), et sa nature :
//  - `lecture` : jouée pour chaque compte contre chaque cible de sa famille ; `requete` donne, s'il le faut, les
//    paramètres de requête fixes sans lesquels la route répond 400 à tous (plage de dates du planning…) ;
//  - `ecriture` : classée selon le cadrage §2.4, d'après le code et non d'après le verbe :
//      (a) écriture qu'un corps vide n'exécute pas : corps vide, chaque compte contre chaque cible de la famille ;
//      (b) action sans corps, avec un paramètre : chaque compte vise la seule cible `inexistant` ;
//      (c) action sans corps et sans paramètre : jouée à la fin, une route à la fois, empreinte avant et après
//          chaque appel, « écrit » ou « inchangé » enregistré dans la référence.
//    `validationAvantDroit` : la route valide le corps avant un contrôle de droit ou de périmètre fait dans le
//    gestionnaire ; son 400 masquerait un refus, et la référence le marque (cadrage §2.1, N16).
// Le test de couverture compare cette table aux routes de app.router.stack : une route ajoutée sans entrée, une
// écriture sans classe ou une entrée sans route font échouer le test.
//
// Classement relevé dans le code de main (d8ac605), puis éprouvé : chaque écriture (a) est jouée à corps vide sur
// toutes les cibles réelles de sa famille, et l'empreinte de toute la base, prise avant et après la route, prouve
// qu'aucune n'écrit. Une modification partielle dont le corps vide ne change rien (PATCH /api/chantiers/:id,
// PUT /api/clients/:id…) est donc en (a) ; une route dont le corps vide exécute l'action (désactiver un compte,
// archiver un équipement, recopier une affectation du planning…) est en (b), ou en (c) sans paramètre.

// Routes ouvertes sans session : exclues des matrices d'entrée (le lien public du planning a sa petite table à
// part, cadrage §2.1, N5).
export const ROUTES_PUBLIQUES = [
  'GET /api/health', 'GET /api/config', 'POST /api/auth/sso', 'GET /api/auth/secours/etat', 'POST /api/auth/secours',
  'GET /api/planning/public/:token',
];
// Routes /api/v1 (clés d'intégration) : exclues jusqu'à D1a-2 (cadrage §2.1).
export const PREFIXE_CLES = '/api/v1/';

const L = (famille = null, extra = {}) => ({ famille, lecture: true, ...extra });
const A = (famille = null, extra = {}) => ({ famille, ecriture: 'a', ...extra });
const B = (famille = null, extra = {}) => ({ famille, ecriture: 'b', ...extra });
const C3 = (extra = {}) => ({ famille: null, ecriture: 'c', ...extra });
const VAD = { validationAvantDroit: true };

export const ROUTES_SESSION = {
  // --- Factures, comptabilité, règlements (administration) ---
  'GET /api/factures/chronologie': L(),
  'GET /api/factures/a-regler': L(),
  'GET /api/factures': L(),
  'GET /api/factures/:id/document.pdf': L('facture'),
  'GET /api/factures/:id/envois': L('facture'),
  'POST /api/factures/:id/envois': A('facture'),
  'GET /api/factures/:id/journal': L('facture'),
  'GET /api/factures/:id/tracabilite': L('facture'),
  'POST /api/factures': A(),
  'GET /api/facturation/prete-a-facturer': L(),
  'GET /api/comptabilite': L(),
  'POST /api/comptabilite/comptes': A(),
  'PATCH /api/comptabilite/comptes/:id': A('compte-comptable'),
  'GET /api/comptabilite/comptes/:id/journal': L('compte-comptable'),
  'PATCH /api/comptabilite/comptes/:id/activation': A('compte-comptable'),
  'POST /api/comptabilite/importer': A(),
  'GET /api/comptabilite/regles/journal': L(),
  'PUT /api/comptabilite/regles/:cle': A(),
  'DELETE /api/comptabilite/regles/:cle': A(),
  'DELETE /api/comptabilite/tva/:taux': A(),
  'PUT /api/comptabilite/tva/:taux': A(),
  'GET /api/factures/export-comptable.csv': L(),
  'POST /api/mentions-legales/:version/publier': B(),
  'POST /api/mentions-legales': A(),
  'GET /api/mentions-legales': L(),
  'POST /api/factures/:id/emettre': B('facture'),
  'POST /api/factures/:id/regler': A('facture'),
  'POST /api/factures/:id/annuler': A('facture'),
  'POST /api/factures/:id/avoirs': A('facture'),
  'GET /api/interventions/:id/facture-temps-passe': L('intervention'),
  'POST /api/interventions/:id/facture-temps-passe': A('intervention'),
  'GET /api/reglements': L(),
  'POST /api/reglements': A(),
  'POST /api/reglements/:id/contrepasser': A('reglement'),
  // --- Contrats de maintenance ---
  'GET /api/contrats-maintenance': L(),
  'GET /api/contrats-maintenance/generation-visites': L(),
  'POST /api/contrats-maintenance/generation-visites': C3(),
  'GET /api/contrats-maintenance/:id/journal-saisies': L('contrat'),
  'GET /api/contrats-maintenance/:id/document.pdf': L('contrat'),
  'GET /api/contrats-maintenance/:id/envois': L('contrat'),
  'POST /api/contrats-maintenance/:id/envois': A('contrat'),
  'POST /api/contrats-maintenance': A(),
  'PATCH /api/contrats-maintenance/:id': A('contrat'),
  'PATCH /api/contrats-maintenance/:id/statut': A('contrat'),
  'POST /api/contrats-maintenance/:id/avancer-echeance': A('contrat'),
  'POST /api/contrats-maintenance/:id/generer-intervention': B('contrat'),
  // --- Interventions SAV ---
  'POST /api/interventions': A(),
  'GET /api/interventions': L(),
  'GET /api/interventions/journee': L(),
  'GET /api/interventions/:id': L('intervention'),
  'GET /api/interventions/:id/document.pdf': L('intervention'),
  'GET /api/interventions/:id/couts': L('intervention'),
  'POST /api/interventions/:id/couts/heures': A('intervention'),
  'POST /api/interventions/:id/couts/achats': A('intervention'),
  'PATCH /api/interventions/:id/couts/:type/:coutId': A('cout-sav', VAD),
  'POST /api/interventions/:id/couts/:type/:coutId/:action': A('cout-sav'),
  'GET /api/interventions/:id/journal-saisies': L('intervention'),
  'POST /api/interventions/:id/rapports': A('intervention', VAD),
  'POST /api/interventions/rapports/:rapportId/signature': A('compte-rendu', VAD),
  'PATCH /api/interventions/:id/statut': A('intervention', VAD),
  'GET /api/planning/interventions-a-planifier': L(),
  'PUT /api/interventions/:id/planning': A('intervention'),
  'POST /api/interventions/:id/remise-a-planifier': A('intervention', VAD),
  'PUT /api/interventions/:id/a-suivre': A('intervention', VAD),
  'POST /api/interventions/:id/suites': B('intervention'),
  'GET /api/interventions/:id/envois': L('intervention'),
  'POST /api/interventions/:id/envois': A('intervention', VAD),
  // --- Compte connecté ---
  'GET /api/me': L(),
  'PUT /api/me/theme': C3(),
  // --- Chantiers ---
  'GET /api/chantiers': L(),
  'GET /api/chantiers/:id': L('chantier'),
  'GET /api/chantiers/:id/journal-saisies': L('chantier'),
  'GET /api/chantiers/:id/document.pdf': L('chantier'),
  'GET /api/chantiers/:id/envois': L('chantier'),
  'POST /api/chantiers/:id/envois': A('chantier'),
  'POST /api/chantiers': A(),
  'PATCH /api/chantiers/:id': A('chantier'),
  'DELETE /api/chantiers/:id': A('chantier'),
  'PATCH /api/chantiers/:id/statut': A('chantier', VAD),
  'PATCH /api/chantiers/:id/commercial': A('chantier'),
  // --- Comptes ---
  'GET /api/users': L(),
  'POST /api/users': A(),
  'DELETE /api/users/:id': B('compte'),
  'PATCH /api/users/:id/role': A('compte', VAD),
  'PATCH /api/users/:id/responsable-hierarchique': A('compte', VAD),
  'PATCH /api/users/:id/est-commercial': B('compte'),
  'PUT /api/users/:id/permissions': A('compte'),
  'PATCH /api/users/:id/acces-finance': B('compte'),
  'PATCH /api/users/:id/actif': B('compte'),
  // --- Équipes et fiches intervenant ---
  'GET /api/commerciaux': L(),
  'GET /api/conducteurs': L(),
  'GET /api/intervenants': L(),
  'POST /api/intervenants': A(),
  'PUT /api/intervenants/:id': A('fiche-intervenant'),
  'PUT /api/intervenants/:id/compte': A('fiche-intervenant', VAD),
  'PUT /api/intervenants/:id/main-oeuvre': A('fiche-intervenant'),
  'DELETE /api/intervenants/:id': B('fiche-intervenant'),
  // --- Planning ---
  'GET /api/planning/chantiers': L(),
  // Plage de dates fixe autour du jour de la société (sans elle, 400 pour tous les comptes admis).
  'GET /api/planning/events': L(null, { requete: 'plage' }),
  'POST /api/planning/events': A(),
  'PATCH /api/planning/events/:id': B('affectation'),
  'DELETE /api/planning/events/:id': B('affectation'),
  'GET /api/planning/types': L(),
  'POST /api/planning/types': A(),
  'PUT /api/planning/types/:id': A('type-planning'),
  'DELETE /api/planning/types/:id': B('type-planning'),
  'GET /api/planning/share': L(),
  'POST /api/planning/share': C3(),
  'PATCH /api/planning/share': C3(),
  // --- Référentiels des achats ---
  'GET /api/categories': L(),
  'POST /api/categories': A(),
  'PUT /api/categories/:id': A('categorie'),
  'DELETE /api/categories/:id': B('categorie'),
  'GET /api/fournisseurs': L(),
  'POST /api/fournisseurs': A(),
  'PUT /api/fournisseurs/:id': A('fournisseur'),
  'DELETE /api/fournisseurs/:id': B('fournisseur'),
  // --- Saisies Travaux ---
  'POST /api/achats': A(null, VAD),
  'PATCH /api/achats/:id': A('achat'),
  'DELETE /api/achats/:id': A('achat'),
  'POST /api/achats/:id/restaurer': A('achat'),
  'GET /api/achats': L(),
  'GET /api/heures': L(),
  'POST /api/heures': A(null, VAD),
  'PATCH /api/heures/:id': A('heure'),
  'DELETE /api/heures/:id': A('heure'),
  'POST /api/heures/:id/restaurer': A('heure'),
  'PATCH /api/chantiers/:id/encaisse': A('chantier'),
  'PUT /api/commerciaux/:id/prime-mensuelle': A('compte'),
  // --- Paramètres, clés, clients, catalogue, devis ---
  'GET /api/parametres': L(),
  // Sans paramètre « q », l'administration reçoit 400 : avec lui, la route interroge recherche-entreprises.api.gouv.fr,
  // service extérieur qu'un test n'appelle pas.
  'GET /api/registry/companies': L(),
  'GET /api/admin/api-keys': L(),
  'GET /api/admin/api-scopes': L(),
  'POST /api/admin/api-keys': A(),
  'POST /api/admin/api-keys/:id/revoke': B('cle'),
  'GET /api/clients': L(),
  'POST /api/clients': A(),
  'GET /api/clients/:id': L('client'),
  'PUT /api/clients/:id': A('client'),
  'DELETE /api/clients/:id': B('client'),
  'POST /api/clients/:clientId/contacts': A('client'),
  'PUT /api/clients/:clientId/contacts/:id': A('contact'),
  'POST /api/clients/:clientId/sites': A('client'),
  'PUT /api/clients/:clientId/sites/:id': A('site'),
  'GET /api/clients/:clientId/equipements': L('client'),
  'POST /api/clients/:clientId/equipements': A('client'),
  'POST /api/clients/:clientId/equipements/:id/archiver': B('equipement'),
  'GET /api/clients/:id/chantiers': L('client'),
  'GET /api/catalogue/categories': L(),
  'POST /api/catalogue/categories': A(),
  'GET /api/catalogue/:family': L(),
  'POST /api/catalogue/:family': A(),
  'PUT /api/catalogue/:family/:id': A('fiche-catalogue'),
  'DELETE /api/catalogue/:family/:id': B('fiche-catalogue'),
  'GET /api/devis/catalogue': L(),
  'GET /api/devis': L(),
  'POST /api/devis': A(null, VAD),
  'PATCH /api/devis/:id': A('devis', VAD),
  'POST /api/devis/:id/revisions': B('devis'),
  'POST /api/devis/:id/signature': A('devis'),
  'GET /api/devis/:id/document.pdf': L('devis'),
  'GET /api/devis/:id/envois': L('devis'),
  'POST /api/devis/:id/envois': A('devis'),
  'PUT /api/devis/:id/statut': A('devis'),
  'POST /api/devis/:id/convertir': A('devis', VAD),
  'GET /api/devis/a-convertir': L(),
  'POST /api/devis/:id/acompte': A('devis'),
  'POST /api/devis/:id/annulation': A('devis'),
  'POST /api/devis/:id/duplication': B('devis'),
  // --- Société, logo, réglages, journal d'administration ---
  'GET /api/company': L(),
  'PUT /api/company': A(),
  'GET /api/company/logo': L(),
  'PUT /api/company/logo': A(),
  'DELETE /api/company/logo': C3(),
  'GET /api/parametres/remuneration': L(),
  'PUT /api/parametres/remuneration': A(),
  'PUT /api/parametres': A(),
  'GET /api/modules': L(),
  'PUT /api/modules': A(),
  'GET /api/journal-administration': L(),
  'GET /api/journal-administration/export.csv': L(),
  'PUT /api/journal-administration/conservation': A(),
  // --- Statistiques et commissions ---
  'GET /api/stats/global': L(),
  'GET /api/stats/conducteurs': L(),
  'GET /api/stats/conducteurs/assiduite': L(),
  'GET /api/stats/chantiers-repartition': L(),
  'GET /api/stats/intervenants': L(),
  'GET /api/stats/fournisseurs': L(),
  'GET /api/stats/types-chantiers': L(),
  'GET /api/stats/commerciaux': L(),
  // --- Analyse d'un chantier (bouchon 410) ---
  'POST /api/chantiers/:id/analyze': A('chantier'),
};
