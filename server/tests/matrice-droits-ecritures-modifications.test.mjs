// Lot D1a-5b : écritures (a) non marquées sur chaque cible réelle, avec un corps valide, base remise à l'état de
// référence entre deux cas ; tests seuls (cadrage du lot D1a, version 3 du 01-11-2026, §2, ligne D1a-5 du §3, §4, §6 et
// §7 ; avenant au cadrage pour D1a-5, version 2, ligne D1a-5b de la section 2, sections 3 à 5).
//
// Tests seuls : ce fichier enregistre le comportement actuel, sans rien corriger (cadrage §1 et §7). Il reprend les
// outils, les comptes, le jeu de données et la table des routes de D1a-1 (server/tests/matrice-droits/), et l'outil de
// remise en état de D1a-5a (matrice-droits/remise-en-etat.mjs, avenant section 1, approche A3). Il enregistre :
//  - les routes (a) de session non marquées validation-avant-droit (blocs E3 et E4 de l'étude préalable, §1.7), hors
//    des routes réservées à D1a-5d (factures, avoirs et règlements) : chaque compte admis à l'entrée (entrees.txt) les
//    joue AVEC UN CORPS VALIDE sur chaque cible réelle de leur famille, ou sur chaque cible portée par le corps
//    (chantierId, clientId), dans et hors du périmètre ; le corps peut dépendre de l'état de la cible (statut d'un
//    devis, relu en base). Aucun corps ne porte de champ réservé à D1a-5d : ni budgetGlobalVendu, ni prix d'achat prévu
//    d'une ligne de devis, ni prix d'achat d'une fiche du catalogue ; un montant requis ou propre à la route (montantHT
//    d'un matériel SAV, budgets par poste et heures vendues d'un chantier, taux d'une fiche intervenant, acompte d'un
//    devis) y est, et le refus comme l'absence d'effet sont joués pour qui ne doit pas l'écrire. Les envois passent par
//    la messagerie (canal absent), jamais par Microsoft 365 ;
//  - les champs ignorés en silence (bloc S) : un corps qui ne porte que le champ qu'un compte ne peut pas écrire
//    (statut ou client d'un chantier hors administration, chantier d'un achat ou d'un pointage, accès financier d'un
//    compte créé par un administrateur) ; l'empreinte, ou un constat relu en base quand la route écrit autre chose,
//    prouve que le champ n'a pas changé ; et les refus qui dépendent du corps (titulaire, commercial, type super
//    administrateur, droit refusé au technicien), hors montants réservés à D1a-5d ;
//  - les coûts SAV d'une suite rattachée à une affaire clôturée ou annulée (note N5 de l'audit des montants de #437 ;
//    règle du 27-10-2026 : 403 hors administration sur une affaire clôturée, 409 pour tous sur une affaire annulée) ;
//  - trois écritures admises que D1a-5a n'a jamais vues écrire, sur des cibles qui s'y prêtent (note N4 de l'audit des
//    droits de #437) ;
//  - les changements « sans gain » de D1a-4 (individuels-sans-gain.txt, lignes d'entrée des écritures), tranchés par
//    une écriture réelle : le compte « type + droit » rejoue la route avec un corps valide sur chaque cible réelle ; le
//    droit est donné par la route d'administration, puis retiré, comme dans D1a-4.
// Une ligne : compte, route, cible, contexte (« défaut, corps <nom> », ou « droit <nom>, corps <nom> » pour un droit
// individuel), réponse (code, et message exact d'un refus ou d'un 400), puis « écrit (tables) » ou « inchangé » selon
// l'empreinte de toute la base, et, pour un champ ignoré d'une route qui écrit ou pour les budgets par poste et les
// heures vendues d'un chantier, le constat relu en base. Jamais un montant : un 2xx s'écrit par son code seul, suivi
// au plus d'un constat sans chiffre (garde lignesAvecMontant d'outils.mjs).
//
// Déroulement : les cas qu'entrees.txt (ou individuels-sans-gain.txt pour un droit) annonce comme un refus 403, 404, 409
// ou 410 d'un compte hors administration sont joués en parallèle, avec une empreinte pour le lot ; si le lot a écrit, la
// base est remise et le lot rejoué un à un. Les autres cas sont joués un à un, empreinte après chaque appel ; un cas qui
// écrit est noté « écrit (tables) », puis la base est remise en état et vérifiée (empreinte de toute la base et
// séquences, sonde d'immutabilité). Les comptes refusés avant la cible (toutes leurs lignes d'entrées en 401, 403 ou
// 410) ne sont pas rejoués sur les routes (a) non marquées : D1a-1 prouve que la garde passe avant le corps, et
// l'empreinte par route y prouve l'absence d'effet (avenant, section 3 ; écart de forme au cadrage §4, déclaré).
//
// Rôle PostgreSQL : comme D1a-5a, la remise pose session_replication_role ; si le rôle de TEST_DATABASE_URL ne le peut
// pas, le test « rôle PostgreSQL » échoue avec un message clair, chacun des autres le cite, et aucune base n'est créée.
// Sans TEST_DATABASE_URL, le fichier s'annonce ignoré comme les autres fichiers de la matrice : un SKIP n'est pas une
// réussite. Ce fichier crée sa propre base jetable, la migre, la sert à l'application, puis la supprime.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before, describe } from 'node:test';
import { join } from 'node:path';
import {
  CONTEXTE_DEFAUT, DOSSIER_MATRICES, EMAIL_SECOURS, JETON_SECOURS, SEPARATEUR, appeler, baseJetable, chargerApplication,
  comparerAvecReference, enParallele, formaterReponse, ligneMatrice, lignesAvecMontant, lireReference, tablesChangees,
  tablesDeLaBase,
} from './matrice-droits/outils.mjs';
import { COMPTES_JOUES, creerComptes } from './matrice-droits/comptes.mjs';
import { FAMILLES, INEXISTANT, SOCIETE, cheminPour, cibleDe, cibleSansFamille, construireJeuDeDonnees, jourSociete } from './matrice-droits/donnees.mjs';
import { ROUTES_SESSION } from './matrice-droits/routes.mjs';
import { creerRemiseEnEtat, exigerRoleReplication } from './matrice-droits/remise-en-etat.mjs';

const TITRE = 'Lot D1a-5b : écritures (a) non marquées sur chaque cible réelle avec un corps valide, champs ignorés en silence et droits individuels sans gain tranchés, base remise en état entre deux cas';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const REFERENCE = join(DOSSIER_MATRICES, 'ecritures-modifications.txt');
const REFERENCE_ENTREES = join(DOSSIER_MATRICES, 'entrees.txt');
const REFERENCE_SANS_GAIN = join(DOSSIER_MATRICES, 'individuels-sans-gain.txt');
const SA = 'SA';
// Comptes sans périmètre : le minimum « dans et hors du périmètre » ne les vise pas ; leurs refus ne sont jamais
// joués par spéculation (un refus d'administration dépend souvent de l'état, qu'un corps valide peut changer).
const ADMINISTRATION = ['SA', 'AD', 'AD-COM'];
const REFUS_AVANT_LA_CIBLE = /^(401|403|410) /;
const REFUS_PREDIT = /^(403|404|409|410) /;
const DESTINATAIRE = 'contact-matrice@iris.test';
const TRACE = { ratio: 2, traits: [[[0.1, 0.6], [0.25, 0.3], [0.4, 0.7], [0.6, 0.35]]] };
// JPEG 1 × 1 pixel minimal d'api.test.mjs (lot 6a-1), comme matrice-droits-donnees.test.mjs.
const LOGO = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

// --- Routes jouées ---
// Routes (a) non marquées de la table de D1a-1 (avenant, ligne D1a-5b : « Routes (a) de session non marquées »).
const ROUTES_A = Object.keys(ROUTES_SESSION).filter((route) => ROUTES_SESSION[route].ecriture === 'a' && !ROUTES_SESSION[route].validationAvantDroit).sort();
// Réservées à D1a-5d (avenant, ligne D1a-5d : « factures, avoirs et règlements, toutes leurs routes d'écriture (a) »).
// L'envoi d'une facture est une route d'écriture (a) de la famille des factures : rangé en 5d, comme l'étude (§1.5).
const RESERVEES_5D = [
  'POST /api/factures', 'POST /api/factures/:id/annuler', 'POST /api/factures/:id/avoirs', 'POST /api/factures/:id/envois',
  'POST /api/factures/:id/regler', 'POST /api/interventions/:id/facture-temps-passe', 'POST /api/reglements',
  'POST /api/reglements/:id/contrepasser',
];
// Routes que tous les comptes reçoivent refusées avant la cible (410 ou garde) : aucun compte à rejouer.
const SANS_COMPTE_ADMIS = ['DELETE /api/chantiers/:id', 'POST /api/chantiers', 'POST /api/chantiers/:id/analyze'];
const ROUTES_E = ROUTES_A.filter((route) => !RESERVEES_5D.includes(route) && !SANS_COMPTE_ADMIS.includes(route));
// Routes jouées hors des (a) non marquées, sur des cibles propres à ce fichier seulement : la correction d'un coût SAV
// (route marquée, note N5 de l'audit des montants de #437) et les trois écritures de la note N4 de l'audit des droits
// de #437. Comme en D1a-5a pour ces classes de routes, les 15 comptes les jouent, refusés à l'entrée compris.
const ROUTE_CORRECTION_COUT = 'PATCH /api/interventions/:id/couts/:type/:coutId';
const ROUTES_N4 = ['POST /api/contrats-maintenance/:id/generer-intervention', 'PUT /api/interventions/:id/a-suivre', 'POST /api/mentions-legales/:version/publier'];
const ROUTES_TOUS_COMPTES = [ROUTE_CORRECTION_COUT, ...ROUTES_N4];
// Champs réservés à D1a-5d, qu'aucun corps de ce fichier ne porte (test « périmètre ») : montant vendu, prix d'achat
// prévu d'une ligne de devis, prix d'achat d'une fiche du catalogue, planningActif, destinataires de la rentabilité.
const RESERVE_5D = /budgetGlobalVendu|prixAchatUnitaireHt|prixAchatHt|planningActif|rentabilite/;

// Cible portée par le corps (bloc E4 de l'étude) : la famille et le champ ; `sans` ajoute les cibles sans ce champ.
const CIBLE_DU_CORPS = {
  'POST /api/interventions': { famille: 'chantier', champ: 'chantierId' },
  'POST /api/planning/events': { famille: 'chantier', champ: 'chantierId' },
  'POST /api/contrats-maintenance': { famille: 'client', champ: 'clientId' },
  'POST /api/achats': { famille: 'chantier', champ: 'chantierId' },
  'POST /api/heures': { famille: 'chantier', champ: 'chantierId' },
  'POST /api/devis': { famille: 'client', champ: 'clientId' },
};

// --- Corps valides ---
// Chaque variante a un nom, écrit dans le contexte de la ligne ; `s` marque un corps du bloc S (champ ignoré ou refus
// selon le corps), que les droits individuels ne rejouent pas ; `constat` relit en base, après un cas qui a écrit, le
// champ ignoré, ou les budgets par poste et les heures vendues écrits (texte sans chiffre). `d` : identifiants et dates (rempli avant la matrice).
const motif = (quoi) => `TEST ${quoi} par la matrice des modifications`;
const LIGNE_DEVIS = (designation, quantite = 1) => ({ designation, nature: 'MAIN_OEUVRE', quantite, prixUnitaireHt: 150, tauxTva: 20 });
// Budgets par poste et heures vendues du corps valide d'un chantier (#387). Le nom changeant aussi, « écrit (Chantier) »
// ne prouverait pas que ces montants sont écrits : le constat les relit en base (C1 de l'audit des montants de #440),
// et le jeu de données n'en porte aucun à ces valeurs (vérifié avant la matrice).
const BUDGETS = { budgetMaterielVendu: 1200, budgetMainOeuvreVendu: 800, heuresVendues: 16 };
const CORPS = {
  // --- Chantiers (titulaire, administration) ---
  // Le corps valide ordinaire modifie le nom, les budgets par poste et les heures vendues (#387), sans le montant vendu
  // (réservé à 5d). Corps S : statut seul et client seul, champs que la route n'accepte que de l'administration et
  // ignore pour les autres ; titulaire réattribué à un autre conducteur, CT-N1 (réattribution par le titulaire, #181 ;
  // le nom du corps ne porte pas le chiffre du compte, la garde « aucun montant » refusant tout chiffre du contexte).
  'PATCH /api/chantiers/:id': (cible, d) => [
    { nom: 'nom, budgets par poste et heures vendues', corps: () => ({ nom: 'TEST Chantier modifié par la matrice', ...BUDGETS }), constat: async (p) => {
      const chantier = await p.chantier.findUniqueOrThrow({ where: { id: cible.ids.id } });
      const nonEcrits = Object.keys(BUDGETS).filter((champ) => Number(chantier[champ]) !== BUDGETS[champ]);
      return nonEcrits.length ? `budgets non écrits : ${nonEcrits.join(', ')}` : 'budgets par poste et heures vendues écrits';
    } },
    { nom: 'statut=TERMINE seul', s: true, corps: () => ({ statut: 'TERMINE' }) },
    { nom: 'clientId=client-second seul', s: true, corps: () => ({ clientId: d.clientSecond }) },
    { nom: 'responsableId=autre conducteur', s: true, corps: () => ({ responsableId: d.comptes['CT-N1'].id }) },
  ],
  'PATCH /api/chantiers/:id/commercial': (_cible, d) => [
    { nom: 'commercialId=COM', corps: () => ({ commercialId: d.comptes.COM.id }) },
    { nom: 'commercialId vide', s: true, corps: () => ({ commercialId: null }) },
  ],
  'PATCH /api/chantiers/:id/encaisse': (cible) => [cible.etat === 'ENCAISSE'
    ? { nom: 'encaisse=non', corps: () => ({ encaisse: false }) }
    : { nom: 'encaisse=oui', corps: () => ({ encaisse: true }) }],
  'POST /api/chantiers/:id/envois': () => [{ nom: 'destinataire, messagerie', corps: () => ({ destinataire: DESTINATAIRE }) }],
  // --- Saisies Travaux : correction (motif ; montant HT d'un achat, nombre d'heures d'un pointage), archivage,
  // restauration ; chantier d'une saisie ignoré (constat) ---
  'PATCH /api/achats/:id': (cible, d) => [
    { nom: 'description, montantHT et motif', corps: () => ({ motifCorrection: motif('correction'), description: 'TEST Achat corrigé par la matrice', montantHT: 87.5 }) },
    { nom: 'chantierId=chantier-autre et motif', s: true, corps: () => ({ motifCorrection: motif('correction'), chantierId: d.chantierAutre }), constat: async (p) => `chantier de l’achat ${(await p.achatReel.findUniqueOrThrow({ where: { id: cible.ids.id } })).chantierId === cible.chantierId ? 'inchangé' : 'changé'}` },
  ],
  'DELETE /api/achats/:id': () => [{ nom: 'motif d’archivage', corps: () => ({ motifArchivage: motif('archivage') }) }],
  'POST /api/achats/:id/restaurer': () => [{ nom: 'motif de restauration', corps: () => ({ motifRestauration: motif('restauration') }) }],
  'PATCH /api/heures/:id': (cible, d) => [
    { nom: 'commentaire, heures et motif', corps: () => ({ motifCorrection: motif('correction'), commentaire: 'TEST Pointage corrigé par la matrice', nbrHeures: 3.5 }) },
    { nom: 'chantierId=chantier-autre et motif', s: true, corps: () => ({ motifCorrection: motif('correction'), chantierId: d.chantierAutre }), constat: async (p) => `chantier du pointage ${(await p.pointageHeure.findUniqueOrThrow({ where: { id: cible.ids.id } })).chantierId === cible.chantierId ? 'inchangé' : 'changé'}` },
  ],
  'DELETE /api/heures/:id': () => [{ nom: 'motif d’archivage', corps: () => ({ motifArchivage: motif('archivage') }) }],
  'POST /api/heures/:id/restaurer': () => [{ nom: 'motif de restauration', corps: () => ({ motifRestauration: motif('restauration') }) }],
  // --- Interventions SAV ---
  // Création : cible portée par chantierId, ou sans chantier (client actif, client désactivé).
  'POST /api/interventions': (cible, d) => [{ nom: 'client, titre et chantier', corps: () => ({ clientId: cible.clientId ?? d.clientActif, titre: 'TEST Intervention créée par la matrice', ...(cible.sansChamp ? {} : { chantierId: cible.ids.id }) }) }],
  'POST /api/interventions/:id/couts/heures': (_cible, d) => [{ nom: 'date et heures', corps: () => ({ date: d.aujourdhui, nbrHeures: 1 }) }],
  'POST /api/interventions/:id/couts/achats': (_cible, d) => [{ nom: 'date, description, montantHT et fournisseur', corps: () => ({ date: d.aujourdhui, description: 'TEST Matériel SAV de la matrice', montantHT: 12.5, fournisseurId: d.fournisseur }) }],
  'POST /api/interventions/:id/couts/:type/:coutId/:action': () => [{ nom: 'motif', corps: () => ({ motif: motif('archivage ou restauration') }) }],
  [ROUTE_CORRECTION_COUT]: (cible) => (cible.ids.type === 'achats'
    ? [{ nom: 'montantHT et motif', corps: () => ({ motifCorrection: motif('correction du matériel'), montantHT: 12.5 }) }]
    : [{ nom: 'nbrHeures et motif', corps: () => ({ motifCorrection: motif('correction des heures'), nbrHeures: 1.25 }) }]),
  'PUT /api/interventions/:id/planning': (_cible, d) => [{ nom: 'jour, créneau et fiche libre', corps: () => ({ dateDebut: d.demain, creneau: 'JOURNEE', intervenantIds: [d.ficheLibre] }) }],
  // --- Planning : affectation d'un chantier (cible portée par chantierId) ou événement libre ---
  'POST /api/planning/events': (cible, d) => [cible.sansChamp
    ? { nom: 'événement libre', corps: () => ({ categorie: 'EVENEMENT', typeEventId: d.typePlanning, dateDebut: d.demain, intervenantIds: [d.ficheLibre] }) }
    : { nom: 'affectation du chantier', corps: () => ({ categorie: 'CHANTIER', chantierId: cible.ids.id, dateDebut: d.demain, intervenantIds: [d.ficheLibre] }) }],
  'POST /api/planning/types': () => [{ nom: 'libellé et couleur', corps: () => ({ nom: 'TEST Type créé par la matrice', couleur: '#654321' }) }],
  'PUT /api/planning/types/:id': () => [{ nom: 'libellé', corps: () => ({ nom: 'TEST Type renommé par la matrice' }) }],
  // --- Référentiels des achats ---
  'POST /api/categories': () => [{ nom: 'nom', corps: () => ({ nom: 'TEST Catégorie créée par la matrice' }) }],
  'PUT /api/categories/:id': () => [{ nom: 'nom', corps: () => ({ nom: 'TEST Catégorie renommée par la matrice' }) }],
  'POST /api/fournisseurs': () => [{ nom: 'nom', corps: () => ({ nom: 'TEST Fournisseur créé par la matrice' }) }],
  'PUT /api/fournisseurs/:id': () => [{ nom: 'nom', corps: () => ({ nom: 'TEST Fournisseur renommé par la matrice' }) }],
  // --- Comptes, fiches intervenant, prime ---
  // Création d'un compte : ordinaire ; accès financier demandé (seul un super administrateur le pose ; constat relu) ;
  // type super administrateur (refusé à un administrateur).
  'POST /api/users': () => {
    const corps = (extra) => () => ({ email: 'matrice.compte-cree@iris.test', name: 'TEST Compte créé par la matrice', role: 'COMMERCIAL', ...extra });
    const constatFinance = async (p) => `accesFinance=${(await p.user.findUniqueOrThrow({ where: { email: 'matrice.compte-cree@iris.test' } })).accesFinance ? 'oui' : 'non'}`;
    return [
      { nom: 'compte commercial', corps: corps({}) },
      { nom: 'compte commercial, accesFinance=oui', s: true, corps: corps({ accesFinance: true }), constat: constatFinance },
      { nom: 'role=SUPERADMIN', s: true, corps: corps({ role: 'SUPERADMIN' }) },
    ];
  },
  // Permissions individuelles : un droit ordinaire, et un droit refusé à un technicien (DROITS_INTERDITS_TECHNICIEN).
  'PUT /api/users/:id/permissions': () => [
    { nom: 'permissions=clients:read', corps: () => ({ permissions: ['clients:read'] }) },
    { nom: 'permissions=finances:read', s: true, corps: () => ({ permissions: ['finances:read'] }) },
  ],
  // Période fixe (aucune dépendance au jour) ; sans plan commercial, le suivi n'ouvre aucune prime.
  'PUT /api/commerciaux/:id/prime-mensuelle': () => [{ nom: 'période et suivi administratif', corps: () => ({ periode: '2026-09', suiviAdministratif: true }) }],
  'POST /api/intervenants': () => [{ nom: 'nom, fonction et taux horaire', corps: () => ({ nom: 'TEST Fiche créée par la matrice', role: 'Technicien', tauxHoraireCharge: 38 }) }],
  'PUT /api/intervenants/:id': () => [{ nom: 'nom et taux horaire', corps: () => ({ nom: 'TEST Fiche modifiée par la matrice', tauxHoraireCharge: 45 }) }],
  'PUT /api/intervenants/:id/main-oeuvre': (_cible, d) => [{ nom: 'mainOeuvreId=main-oeuvre-matrice', corps: () => ({ mainOeuvreId: d.mainOeuvre }) }],
  // --- Clients, contacts, sites, parc ---
  'POST /api/clients': () => [{ nom: 'raison sociale', corps: () => ({ raisonSociale: 'TEST Client créé par la matrice' }) }],
  'PUT /api/clients/:id': () => [{ nom: 'nom commercial', corps: () => ({ nomCommercial: 'TEST Nom commercial de la matrice' }) }],
  'POST /api/clients/:clientId/contacts': () => [{ nom: 'nom du contact', corps: () => ({ nom: 'TEST Contact créé par la matrice', email: DESTINATAIRE }) }],
  'PUT /api/clients/:clientId/contacts/:id': () => [{ nom: 'nom du contact', corps: () => ({ nom: 'TEST Contact modifié par la matrice' }) }],
  'POST /api/clients/:clientId/sites': () => [{ nom: 'site', corps: () => ({ nom: 'TEST Site créé par la matrice', adresse: '9 rue de la Matrice', codePostal: '14000', ville: 'Caen' }) }],
  'PUT /api/clients/:clientId/sites/:id': () => [{ nom: 'nom du site', corps: () => ({ nom: 'TEST Site modifié par la matrice' }) }],
  'POST /api/clients/:clientId/equipements': (cible, d) => [{ nom: 'modèle, site du client et numéro de série', corps: () => ({ catalogueEquipementId: d.modeleEquipement, clientSiteId: d.siteDuClient[cible.nom], numeroSerie: 'TEST-SN-MATRICE-MODIF' }) }],
  // --- Catalogue : sans prix d'achat (réservé à 5d) ---
  'POST /api/catalogue/categories': () => [{ nom: 'nom', corps: () => ({ nom: 'TEST Catégorie de catalogue de la matrice' }) }],
  'POST /api/catalogue/:family': () => [{ nom: 'prestation sans prix d’achat', corps: () => ({ reference: 'TEST-MATRICE-PRE-CREE', nom: 'TEST Prestation créée par la matrice', unite: 'forfait', prixVenteHt: '150', tauxTva: '20' }) }],
  'PUT /api/catalogue/:family/:id': () => [{ nom: 'prestation sans prix d’achat', corps: () => ({ reference: 'TEST-MATRICE-PRE', nom: 'TEST Prestation modifiée par la matrice', unite: 'forfait', prixVenteHt: '120', tauxTva: '20' }) }],
  // --- Devis (le corps du statut dépend de l'état du devis, relu en base) ---
  'POST /api/devis/:id/signature': () => [{ nom: 'signataire et confirmation', corps: () => ({ signataire: 'TEST Signataire de la matrice', confirme: true }) }],
  'POST /api/devis/:id/envois': () => [{ nom: 'destinataire, messagerie', corps: () => ({ destinataire: DESTINATAIRE }) }],
  'PUT /api/devis/:id/statut': (cible) => {
    const suivant = { BROUILLON: 'ENVOYE', ENVOYE: 'BROUILLON', ACCEPTE: 'EN_ATTENTE_ACOMPTE', EN_ATTENTE_ACOMPTE: 'ACCEPTE' }[cible.etat] ?? 'ENVOYE';
    return [{ nom: `statut=${suivant}`, corps: () => ({ statut: suivant }) }];
  },
  'POST /api/devis/:id/acompte': (_cible, d) => [{ nom: 'date, montant et référence', corps: () => ({ recuLe: d.hier, montant: 300, reference: 'TEST-ACOMPTE-MATRICE' }) }],
  'POST /api/devis/:id/annulation': () => [{ nom: 'motif', corps: () => ({ motif: motif('annulation') }) }],
  // --- Contrats de maintenance ---
  'POST /api/contrats-maintenance': (cible, d) => [{ nom: 'titre, périodicité, durée et début', corps: () => ({ clientId: cible.ids.id, titre: 'TEST Contrat créé par la matrice', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: d.aujourdhui }) }],
  'PATCH /api/contrats-maintenance/:id': () => [{ nom: 'note de couverture et motif', corps: () => ({ noteCouverture: 'TEST Note de couverture de la matrice', motif: motif('couverture') }) }],
  'PATCH /api/contrats-maintenance/:id/statut': () => [{ nom: 'statut=SUSPENDU et motif', corps: () => ({ statut: 'SUSPENDU', motif: motif('suspension') }) }],
  'POST /api/contrats-maintenance/:id/avancer-echeance': () => [{ nom: 'sans corps', corps: () => ({}) }],
  'POST /api/contrats-maintenance/:id/envois': () => [{ nom: 'destinataire, messagerie', corps: () => ({ destinataire: DESTINATAIRE }) }],
  // --- Comptabilité (paramètres fixes cle=CLIENT, taux=20 ; versions relues en base avant la matrice) ---
  'POST /api/comptabilite/comptes': () => [{ nom: 'compte de fournisseurs', corps: () => ({ code: '401000', libelle: 'TEST Fournisseurs matrice', nature: 'PASSIF' }) }],
  'PATCH /api/comptabilite/comptes/:id': (_cible, d) => [{ nom: 'libellé, motif et version', corps: () => ({ libelle: 'TEST Clients matrice renommé', motif: motif('renommage'), expectedUpdatedAt: d.compta.compteClientsMaj }) }],
  'PATCH /api/comptabilite/comptes/:id/activation': () => [{ nom: 'actif=non et motif', corps: () => ({ actif: false, motif: motif('désactivation') }) }],
  'POST /api/comptabilite/importer': () => [{ nom: 'une ligne', corps: () => ({ lignes: [{ code: '402000', libelle: 'TEST Fournisseurs importés matrice', nature: 'PASSIF' }] }) }],
  'PUT /api/comptabilite/regles/:cle': (_cible, d) => [{ nom: 'autre compte client, version et motif', corps: () => ({ compteId: d.compta.clientsBis, expectedValeur: d.compta.regleClientValeur, expectedUpdatedAt: d.compta.regleClientMaj, motif: motif('remappage') }) }],
  'DELETE /api/comptabilite/regles/:cle': (_cible, d) => [{ nom: 'version et motif', corps: () => ({ expectedValeur: d.compta.regleClientValeur, expectedUpdatedAt: d.compta.regleClientMaj, motif: motif('retrait') }) }],
  'PUT /api/comptabilite/tva/:taux': (_cible, d) => [{ nom: 'autre compte de TVA, version et motif', corps: () => ({ compteId: d.compta.tvaBis, expectedCompteId: d.compta.regleTvaCompte, expectedUpdatedAt: d.compta.regleTvaMaj, motif: motif('remappage') }) }],
  'DELETE /api/comptabilite/tva/:taux': (_cible, d) => [{ nom: 'confirmation, version et motif', corps: () => ({ confirmation: '20', expectedCompteId: d.compta.regleTvaCompte, expectedUpdatedAt: d.compta.regleTvaMaj, motif: motif('retrait') }) }],
  'POST /api/mentions-legales': () => [{ nom: 'mentions, CGV et pénalités', corps: () => ({ mentions: 'TEST mentions de la matrice des modifications', cgv: 'TEST CGV', penalites: 'TEST pénalités' }) }],
  // --- Clés, société, réglages (sans planningActif ni destinataires de la rentabilité, réservés à 5d) ---
  'POST /api/admin/api-keys': () => [{ nom: 'nom et scope', corps: () => ({ nom: 'TEST Clé créée par la matrice', scopes: ['clients:read'] }) }],
  'PUT /api/parametres': () => [{ nom: 'margeCommercialeActive=non', corps: () => ({ margeCommercialeActive: false }) }],
  'PUT /api/parametres/remuneration': (_cible, d) => [{ nom: 'barèmes relus, libellé changé', corps: () => ({ ...d.remuneration, libelleBaremeReduit: 'TEST Barème réduit de la matrice' }) }],
  'PUT /api/modules': () => [{ nom: 'modeEnvoi=MESSAGERIE', corps: () => ({ modeEnvoi: 'MESSAGERIE' }) }],
  'PUT /api/company': () => [{ nom: 'identité, téléphone changé', corps: () => ({ ...SOCIETE, telephone: '02 31 00 00 09' }) }],
  'PUT /api/company/logo': () => [{ nom: 'logo JPEG', corps: () => ({ fichier: `data:image/jpeg;base64,${LOGO.toString('base64')}` }) }],
  'PUT /api/journal-administration/conservation': () => [{ nom: 'durée de conservation changée', corps: () => ({ jours: 30 }) }],
  // --- N4 de l'audit des droits de #437 : actions jouées à corps vide, retrait de la marque « à suivre » ---
  'POST /api/contrats-maintenance/:id/generer-intervention': () => [{ nom: null, corps: () => ({}) }],
  'POST /api/mentions-legales/:version/publier': () => [{ nom: null, corps: () => ({}) }],
  'PUT /api/interventions/:id/a-suivre': () => [{ nom: 'aSuivre=non', corps: () => ({ aSuivre: false }) }],
};
// Corps des routes que seuls les droits individuels rejouent (routes marquées ou (b) de individuels-sans-gain.txt).
const CORPS_DROITS = {
  'POST /api/achats': (cible, d) => [{ nom: 'achat', corps: () => ({ chantierId: cible.ids.id, categorieId: d.categorie, fournisseurId: d.fournisseur, date: d.hier, description: 'TEST Achat de la matrice des modifications', montantHT: 12.5 }) }],
  'POST /api/heures': (cible, d) => [{ nom: 'heures', corps: () => ({ chantierId: cible.ids.id, intervenantId: d.ficheLibre, date: d.hier, nbrHeures: 2 }) }],
  'POST /api/devis': (cible) => [{ nom: 'client, objet et ligne', corps: () => ({ clientId: cible.ids.id, objet: 'TEST Devis de la matrice des modifications', lignes: [LIGNE_DEVIS('TEST Ligne de la matrice des modifications')] }) }],
  'PATCH /api/devis/:id': (_cible, d) => [{ nom: 'client, objet et ligne', corps: () => ({ clientId: d.clientActif, objet: 'TEST Devis modifié par la matrice', lignes: [LIGNE_DEVIS('TEST Ligne modifiée par la matrice', 2)] }) }],
  'POST /api/devis/:id/convertir': (_cible, d) => [
    { nom: 'cible=CHANTIER', corps: () => ({ cible: 'CHANTIER' }) },
    { nom: 'cible=INTERVENTION', corps: () => ({ cible: 'INTERVENTION' }) },
    { nom: 'cible=CONTRAT', corps: () => ({ cible: 'CONTRAT', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: d.aujourdhui }) },
  ],
  'POST /api/devis/:id/duplication': () => [{ nom: 'sans corps', corps: () => ({}) }],
  'POST /api/interventions/:id/envois': () => [{ nom: 'destinataire, messagerie', corps: () => ({ destinataire: DESTINATAIRE }) }],
};

// Cibles propres à ce fichier, construites par l'API dans sa base (avenant, section 3), par route. Chaque cible : nom,
// identifiants, relations (indicateur du périmètre, comme donnees.mjs).
const CIBLES_PROPRES = {};
// Cibles propres des saisies Travaux, sur le chantier dont le compte est titulaire (droits individuels sans gain).
const SAISIES_DES_TITULAIRES = {};
const TITULAIRES_SANS_SAISIE = { COM: 'chantier-com-titulaire', DC: 'chantier-dc', AC: 'chantier-ac', CPT: 'chantier-cpt', DIR: 'chantier-dir' };

// Réponses d'entrée de D1a-1, par compte, route et cible (contexte par défaut).
function lireEntrees() {
  const texte = lireReference(REFERENCE_ENTREES);
  assert.ok(texte, `référence d’entrée absente : ${REFERENCE_ENTREES}`);
  const parCas = new Map(); const parCouple = new Map();
  for (const ligne of texte.split('\n').filter(Boolean)) {
    const [compte, route, cible, contexte, reponse] = ligne.split(SEPARATEUR);
    if (contexte !== CONTEXTE_DEFAUT) continue;
    parCas.set([compte, route, cible].join(SEPARATEUR), reponse);
    const cle = `${compte}${SEPARATEUR}${route}`;
    if (!parCouple.has(cle)) parCouple.set(cle, []);
    parCouple.get(cle).push(reponse);
  }
  return { parCas, parCouple };
}
// Changements « sans gain » des écritures (D1a-4), lignes d'entrée : type, droit, route, cible, réponse avec le droit.
function lireSansGain() {
  const texte = lireReference(REFERENCE_SANS_GAIN);
  assert.ok(texte, `référence des droits sans gain absente : ${REFERENCE_SANS_GAIN}`);
  return texte.split('\n').filter(Boolean).map((ligne) => ligne.split(SEPARATEUR)).filter((c) => c[5] === 'entrée')
    .map(([type, droit, route, cible, , , changement]) => ({ type, droit, route, cible, avec: changement.split(' → ')[1] }));
}
// Indicateur du périmètre (avenant, section 3) : une relation nommée, sauf une relation marquée « (hors périmètre) »
// dans donnees.mjs (note N7 du contrôle de #437).
const dansLePerimetre = (relation) => !!relation && !/\(hors périmètre\)/.test(relation);

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const base = baseJetable(TEST_DATABASE_URL, 'modifications');
    let appli; let remise;
    let refusRole = null;
    const PREPARATION_INTERROMPUE = 'Préparation interrompue : le contrôle du rôle PostgreSQL de TEST_DATABASE_URL a échoué (voir le test « rôle PostgreSQL » : rôle sans session_replication_role, ou serveur injoignable).';
    const testPrepare = (titre, corps) => test(titre, async (t) => {
      if (refusRole) assert.fail(PREPARATION_INTERROMPUE);
      return corps(t);
    });
    let comptes = {};
    const d = {};
    let entrees = { parCas: new Map(), parCouple: new Map() };
    let sansGain = [];
    const lignes = [];
    const chiffres = { casParalleles: 0, casUnAUn: 0, casEcrits: 0, lotsRejoues: [], parRoute: {}, refusesNonRejoues: 0, groupesDroits: 0 };
    const couples = new Map();
    const casDroits = [];
    // Diagnostics des tests qui jouent, imprimés par le test de la référence.
    const diagnostics = [];

    const api = async (compte, methode, chemin, corps, statut = 200) => {
      const res = await appeler(appli.adresse, methode, chemin, { jeton: comptes[compte].jeton, corps: methode === 'GET' ? undefined : corps });
      const admis = Array.isArray(statut) ? statut : [statut];
      assert.ok(admis.includes(res.status), `${methode} ${chemin} (${compte}) : ${res.status} ${JSON.stringify(res.body)?.slice(0, 400)}`);
      return res.body;
    };
    const refuseAvantLaCible = (compte, route) => {
      const reponses = entrees.parCouple.get(`${compte}${SEPARATEUR}${route}`) ?? [];
      assert.ok(reponses.length, `entrees.txt n’a aucune ligne pour ${compte} sur ${route}`);
      return reponses.every((r) => r === reponses[0]) && REFUS_AVANT_LA_CIBLE.test(reponses[0]);
    };

    // Cibles d'une route : chaque cible réelle de sa famille, ou portée par le corps, ou propre à ce fichier ; une route
    // sans paramètre de dossier a une cible fixe (« — » ou ses valeurs fixes, comme entrees.txt).
    const cibleFamille = (route, famille, c) => {
      const chemin = route.split(' ')[1];
      const brut = c.ids.action ? chemin.replace(':action', c.ids.action) : chemin;
      return { nom: c.nom, nomEntree: c.nom, chemin: c.chemin ?? cheminPour(brut, famille, c), ids: c.ids, etat: c.etat, relations: c.relations ?? {}, chantierId: c.chantierId };
    };
    const ciblesDe = (route) => {
      const [, chemin] = route.split(' ');
      const definition = ROUTES_SESSION[route];
      if (CIBLES_PROPRES[route] && ROUTES_TOUS_COMPTES.includes(route)) return CIBLES_PROPRES[route].map((c) => cibleFamille(route, definition.famille, c));
      const porteeParLeCorps = CIBLE_DU_CORPS[route];
      if (porteeParLeCorps) {
        const cibles = FAMILLES[porteeParLeCorps.famille].cibles.filter((c) => c.nom !== INEXISTANT)
          .map((c) => ({ nom: `${porteeParLeCorps.champ}=${c.nom}`, nomEntree: cibleSansFamille(chemin), chemin, ids: c.ids, etat: c.etat, relations: c.relations ?? {} }));
        // Création d'une intervention sans chantier (client actif, client désactivé) ; événement libre du planning.
        if (route === 'POST /api/interventions') {
          for (const client of ['client-actif', 'client-desactive']) cibles.push({ nom: `clientId=${client}, sans chantier`, nomEntree: cibleSansFamille(chemin), chemin, sansChamp: true, clientId: cibleDe('client', client).ids.id, relations: {} });
        }
        if (route === 'POST /api/planning/events') cibles.push({ nom: 'typeEventId=type-planning', nomEntree: cibleSansFamille(chemin), chemin, sansChamp: true, relations: {} });
        return cibles;
      }
      if (!definition.famille) return [{ nom: cibleSansFamille(chemin), nomEntree: cibleSansFamille(chemin), chemin: cheminPour(chemin, null, null), relations: {} }];
      const cibles = FAMILLES[definition.famille].cibles.filter((c) => c.nom !== INEXISTANT).map((c) => cibleFamille(route, definition.famille, c));
      for (const c of CIBLES_PROPRES[route] ?? []) cibles.push({ ...cibleFamille(route, definition.famille, c), nomEntree: null });
      return cibles;
    };

    // Cas d'une route : (compte, cible, variante de corps). Les comptes refusés avant la cible ne sont pas rejoués sur
    // une route (a) non marquée (avenant, section 3) ; ils le sont sur les routes jouées par les 15 comptes.
    const casDe = (route) => {
      const cas = [];
      const tous = ROUTES_TOUS_COMPTES.includes(route);
      for (const cible of ciblesDe(route)) {
        const variantes = CORPS[route](cible, d);
        assert.ok(variantes.length, `${route} : aucun corps pour ${cible.nom}`);
        for (const variante of variantes) {
          for (const compte of COMPTES_JOUES) {
            if (!tous && refuseAvantLaCible(compte, route)) { chiffres.refusesNonRejoues += 1; continue; }
            const predite = cible.nomEntree ? entrees.parCas.get([compte, route, cible.nomEntree].join(SEPARATEUR)) : undefined;
            const refuseEntree = tous && refuseAvantLaCible(compte, route);
            cas.push({
              compte, route, cible, variante,
              contexte: variante.nom ? `${CONTEXTE_DEFAUT}, corps ${variante.nom}` : CONTEXTE_DEFAUT,
              parallele: refuseEntree || (!ADMINISTRATION.includes(compte) && !!predite && REFUS_PREDIT.test(predite)),
              admisEntree: !refuseEntree,
            });
          }
        }
      }
      return cas;
    };

    // Joue une liste de cas : en parallèle ceux qu'on attend refusés (empreinte du lot ; lot rejoué un à un s'il a
    // écrit), un à un les autres. `attendu` : l'empreinte que la base doit garder (la référence, ou l'état « avec le
    // droit » d'un groupe de droits individuels).
    const jouerCas = async (liste, attendu, etiquette) => {
      const unAUn = async (c) => {
        const [methode, chemin] = c.route.split(' ');
        const res = await appeler(appli.adresse, methode, c.cible.chemin, { jeton: comptes[c.compte].jeton, corps: c.variante.corps() });
        const changees = tablesChangees(attendu, await remise.empreinte());
        chiffres.casUnAUn += 1;
        let reponse = formaterReponse(res, { ecriture: changees.length ? `écrit (${changees.join(',')})` : 'inchangé', messageDu400: true });
        if (changees.length && c.variante.constat) reponse += ` ; ${await c.variante.constat(appli.prisma)}`;
        c.reponse = reponse;
        lignes.push(ligneMatrice({ compte: c.compte, methode, chemin, cible: c.cible.nom, contexte: c.contexte, reponse }));
        if (changees.length) {
          chiffres.casEcrits += 1;
          await remise.remettre(changees, `${c.compte} sur ${c.route}, cible ${c.cible.nom}, contexte ${c.contexte}`, attendu);
        }
      };
      const paralleles = liste.filter((c) => c.parallele);
      const resultats = await enParallele(paralleles.map((c) => async () => ({ c, res: await appeler(appli.adresse, c.route.split(' ')[0], c.cible.chemin, { jeton: comptes[c.compte].jeton, corps: c.variante.corps() }) })), 8);
      const changeesLot = tablesChangees(attendu, await remise.empreinte());
      if (changeesLot.length) {
        chiffres.lotsRejoues.push(`${etiquette} (${changeesLot.join(', ')})`);
        await remise.remettre(changeesLot, `lot des refus attendus de ${etiquette}`, attendu);
        for (const c of paralleles) await unAUn(c);
      } else {
        chiffres.casParalleles += resultats.length;
        for (const { c, res } of resultats) {
          const [methode, chemin] = c.route.split(' ');
          c.reponse = formaterReponse(res, { ecriture: 'inchangé', messageDu400: true });
          lignes.push(ligneMatrice({ compte: c.compte, methode, chemin, cible: c.cible.nom, contexte: c.contexte, reponse: c.reponse }));
        }
      }
      for (const c of liste.filter((x) => !x.parallele)) await unAUn(c);
    };

    const jouerRoute = async (route) => {
      const cas = casDe(route);
      const debut = Date.now();
      chiffres.parRoute[route] = { cibles: new Set(cas.map((c) => c.cible.nom)).size, cas: cas.length };
      await jouerCas(cas, remise.reference, route);
      chiffres.parRoute[route].ms = Date.now() - debut;
      for (const c of cas) {
        if (!c.admisEntree) continue;
        const cle = `${c.compte}${SEPARATEUR}${route}`;
        if (!couples.has(cle)) couples.set(cle, { dans: new Set(), hors: new Set(), cibles: chiffres.parRoute[route].cibles, vues: new Set() });
        const couple = couples.get(cle);
        couple.vues.add(c.cible.nom);
        (dansLePerimetre(c.cible.relations?.[c.compte]) ? couple.dans : couple.hors).add(c.cible.nom);
      }
    };

    before(async () => {
      try {
        await exigerRoleReplication(TEST_DATABASE_URL);
      } catch (erreur) {
        refusRole = erreur;
        return;
      }
      entrees = lireEntrees();
      sansGain = lireSansGain();
      await base.creer();
      appli = await chargerApplication(base);
      const connexion = await appeler(appli.adresse, 'POST', '/api/auth/secours', { corps: { token: JETON_SECOURS } });
      assert.equal(connexion.status, 200, JSON.stringify(connexion.body));
      const secours = await appli.prisma.user.findUniqueOrThrow({ where: { email: EMAIL_SECOURS }, select: { id: true, role: true } });
      assert.equal(secours.role, 'SUPERADMIN');
      const crees = await creerComptes({
        prisma: appli.prisma, signer: appli.signer, signerAutreSecret: (id) => appli.jwt.sign({ id }, 'autre-secret-que-celui-de-l-application'),
        secours: { id: secours.id, jeton: connexion.body.token },
        supprimerCompte: async (id) => {
          const res = await appeler(appli.adresse, 'DELETE', `/api/users/${id}`, { jeton: connexion.body.token });
          assert.equal(res.status, 200, JSON.stringify(res.body));
        },
        rattacherCompte: async (id, responsableHierarchiqueId) => {
          const res = await appeler(appli.adresse, 'PATCH', `/api/users/${id}/responsable-hierarchique`, { jeton: connexion.body.token, corps: { responsableHierarchiqueId } });
          assert.equal(res.status, 200, JSON.stringify(res.body));
        },
      });
      comptes = crees.comptes;
      await construireJeuDeDonnees({ prisma: appli.prisma, api, comptes, donnees: crees.donnees });
      const id = (famille, nom) => cibleDe(famille, nom).ids.id;
      Object.assign(d, {
        comptes, hier: jourSociete(-1), aujourdhui: jourSociete(0), demain: jourSociete(1),
        clientActif: id('client', 'client-actif'), categorie: id('categorie', 'categorie'), fournisseur: id('fournisseur', 'fournisseur'),
        ficheLibre: id('fiche-intervenant', 'fiche-libre'), ficheTech: id('fiche-intervenant', 'fiche-tech'),
        typePlanning: id('type-planning', 'type-planning'), chantierAutre: id('chantier', 'chantier-autre'),
      });

      // --- Objets et cibles propres à ce fichier, construits par l'API (avenant, section 3) ---
      // Un second client actif (changement de client d'un chantier), une main d'œuvre du catalogue (rattachement d'une
      // fiche), un second compte client et un second compte de TVA (remappage des règles), le modèle d'équipement et les
      // sites du jeu de données.
      d.clientSecond = (await api(SA, 'POST', '/api/clients', { raisonSociale: 'TEST Client second de la matrice' }, 201)).id;
      d.mainOeuvre = (await api(SA, 'POST', '/api/catalogue/prestations', {
        estMainOeuvre: true, reference: 'TEST-MATRICE-MO-MODIF', nom: 'TEST Main d’œuvre de la matrice des modifications', tauxTva: 20,
        prixVenteHt: 60, prixJourHorsContratHt: 420, prixHeureSousContratHt: 55, prixJourSousContratHt: 385, heuresParJour: 7,
      }, 201)).id;
      const comptaBis = async (code, libelle, nature) => (await api(SA, 'POST', '/api/comptabilite/comptes', { code, libelle, nature }, 201)).id;
      const clientsBis = await comptaBis('411100', 'TEST Clients bis matrice', 'ACTIF');
      const tvaBis = await comptaBis('445711', 'TEST TVA bis matrice', 'TVA');
      d.modeleEquipement = (await appli.prisma.catalogueEquipement.findFirstOrThrow({ where: { reference: 'TEST-MATRICE-EQ' }, select: { id: true } })).id;
      d.siteDuClient = {};
      for (const nom of ['client-actif', 'client-desactive']) d.siteDuClient[nom] = (await appli.prisma.clientSite.findFirstOrThrow({ where: { clientId: id('client', nom) }, select: { id: true } })).id;
      d.remuneration = await api(SA, 'GET', '/api/parametres/remuneration');

      // Devis dont l'acompte est attendu (constat de l'acompte, changement de statut) : créé, envoyé, signé.
      const devisAcompte = await api(SA, 'POST', '/api/devis', { clientId: d.clientActif, objet: 'TEST Devis à acompte de la matrice', acompteExige: true, lignes: [LIGNE_DEVIS('TEST Ligne du devis à acompte')] }, 201);
      await api(SA, 'PUT', `/api/devis/${devisAcompte.id}/statut`, { statut: 'ENVOYE' });
      await api(SA, 'POST', `/api/devis/${devisAcompte.id}/signature`, { signataire: 'TEST Signataire matrice', confirme: true }, 201);
      const cibleDevisAcompte = { nom: 'devis-acompte-attendu', ids: { id: devisAcompte.id }, relations: {} };
      for (const route of ['POST /api/devis/:id/signature', 'POST /api/devis/:id/envois', 'PUT /api/devis/:id/statut', 'POST /api/devis/:id/acompte', 'POST /api/devis/:id/annulation']) CIBLES_PROPRES[route] = [cibleDevisAcompte];

      // Coûts SAV d'une suite rattachée à une affaire clôturée, et d'une suite rattachée à une affaire annulée (note N5
      // de l'audit des montants de #437) : chantier ouvert par la conversion d'un devis (titulaire CT), intervention du
      // chantier, suite, placée sur la fiche du technicien et démarrée ; heures du technicien et matériel de
      // l'administration ; puis clôture du chantier, ou archivage des coûts et annulation du devis (une affaire dont
      // une suite porte un coût vivant ne s'annule pas, devis/annulation.ts).
      const affaire = async (nom) => {
        const devis = await api(SA, 'POST', '/api/devis', { clientId: d.clientActif, objet: `TEST Devis de ${nom}`, lignes: [LIGNE_DEVIS(`TEST Ligne de ${nom}`)] }, 201);
        await api(SA, 'PUT', `/api/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
        await api(SA, 'POST', `/api/devis/${devis.id}/signature`, { signataire: 'TEST Signataire matrice', confirme: true }, 201);
        const conversion = await api(SA, 'POST', `/api/devis/${devis.id}/convertir`, { cible: 'CHANTIER', responsableId: comptes.CT.id, dateDebut: jourSociete(-30) }, 201);
        const chantierId = conversion.chantier?.id ?? conversion.chantierId ?? conversion.id;
        const initiale = await api(SA, 'POST', '/api/interventions', { clientId: d.clientActif, titre: `TEST Intervention de ${nom}`, chantierId }, 201);
        const suite = await api(SA, 'POST', `/api/interventions/${initiale.id}/suites`, {}, 201);
        await api(SA, 'PUT', `/api/interventions/${suite.id}/planning`, { dateDebut: d.aujourdhui, creneau: 'JOURNEE', intervenantIds: [d.ficheTech] }, [200, 201]);
        await api(SA, 'PATCH', `/api/interventions/${suite.id}/statut`, { statut: 'EN_COURS' });
        const heures = await api('TECH', 'POST', `/api/interventions/${suite.id}/couts/heures`, { date: d.aujourdhui, nbrHeures: 1.5 }, 201);
        const materiel = await api(SA, 'POST', `/api/interventions/${suite.id}/couts/achats`, { date: d.aujourdhui, montantHT: 30, description: `TEST Matériel de ${nom}`, fournisseurId: d.fournisseur }, 201);
        return { devis, chantierId, suite, heures, materiel };
      };
      const close = await affaire('l’affaire close');
      await api(SA, 'PATCH', `/api/chantiers/${close.chantierId}/statut`, { statut: 'TERMINE' });
      const annulee = await affaire('l’affaire annulée');
      for (const [type, cout] of [['heures', annulee.heures], ['achats', annulee.materiel]]) await api(SA, 'POST', `/api/interventions/${annulee.suite.id}/couts/${type}/${cout.id}/archiver`, { motif: 'TEST archivage avant l’annulation' });
      await api(SA, 'POST', `/api/devis/${annulee.devis.id}/annulation`, { motif: 'TEST annulation de l’affaire de la suite' });
      assert.deepEqual((await appli.prisma.chantier.findMany({ where: { id: { in: [close.chantierId, annulee.chantierId] } }, select: { id: true, statut: true } })).map((c) => c.statut).sort(), ['ANNULE', 'TERMINE'], 'affaires de la note N5 : close et annulée');
      const relationsSuite = { TECH: 'affecté', CT: 'titulaire du chantier lié' };
      const suiteClose = { nom: 'suite-affaire-close', ids: { id: close.suite.id }, relations: relationsSuite };
      const suiteAnnulee = { nom: 'suite-affaire-annulee', ids: { id: annulee.suite.id }, relations: relationsSuite };
      CIBLES_PROPRES['POST /api/interventions/:id/couts/heures'] = [suiteClose, suiteAnnulee];
      CIBLES_PROPRES['POST /api/interventions/:id/couts/achats'] = [suiteClose, suiteAnnulee];
      const cout = (nom, suite, coutId, type, action) => ({ nom, ids: { id: suite.id, coutId, type, ...(action ? { action } : {}) }, relations: type === 'heures' ? { TECH: 'auteur, affecté', CT: 'titulaire du chantier lié' } : { CT: 'titulaire du chantier lié', TECH: 'affecté' } });
      CIBLES_PROPRES['POST /api/interventions/:id/couts/:type/:coutId/:action'] = [
        cout('heures-suite-affaire-close', close.suite, close.heures.id, 'heures', 'archiver'),
        cout('materiel-suite-affaire-close', close.suite, close.materiel.id, 'achats', 'archiver'),
        cout('heures-archivees-suite-affaire-annulee', annulee.suite, annulee.heures.id, 'heures', 'restaurer'),
        cout('materiel-archive-suite-affaire-annulee', annulee.suite, annulee.materiel.id, 'achats', 'restaurer'),
      ];
      CIBLES_PROPRES[ROUTE_CORRECTION_COUT] = [
        cout('heures-suite-affaire-close', close.suite, close.heures.id, 'heures'),
        cout('materiel-suite-affaire-close', close.suite, close.materiel.id, 'achats'),
        cout('heures-archivees-suite-affaire-annulee', annulee.suite, annulee.heures.id, 'heures'),
        cout('materiel-archive-suite-affaire-annulee', annulee.suite, annulee.materiel.id, 'achats'),
      ];

      // Chantier terminé et encaissé (C2 de l'audit des montants de #440) : seul état où le CA et la marge validés d'un
      // commercial existent (« un chantier ne compte dans le CA et la marge validés du commercial que s'il est Terminé ET
      // Encaissé », chantiers/saisies.ts). Ouvert par la conversion d'un devis (titulaire CT, commercial AD-COM), clôturé
      // puis encaissé par l'administration ; joué sur la réattribution du commercial et sur le retrait de l'encaissement.
      const devisEncaisse = await api(SA, 'POST', '/api/devis', { clientId: d.clientActif, objet: 'TEST Devis du chantier encaissé', lignes: [LIGNE_DEVIS('TEST Ligne du chantier encaissé')] }, 201);
      await api(SA, 'PUT', `/api/devis/${devisEncaisse.id}/statut`, { statut: 'ENVOYE' });
      await api(SA, 'POST', `/api/devis/${devisEncaisse.id}/signature`, { signataire: 'TEST Signataire matrice', confirme: true }, 201);
      const ouvertureEncaisse = await api(SA, 'POST', `/api/devis/${devisEncaisse.id}/convertir`, { cible: 'CHANTIER', responsableId: comptes.CT.id, commercialId: comptes['AD-COM'].id, dateDebut: jourSociete(-30) }, 201);
      const chantierEncaisse = ouvertureEncaisse.chantier?.id ?? ouvertureEncaisse.chantierId ?? ouvertureEncaisse.id;
      await api(SA, 'PATCH', `/api/chantiers/${chantierEncaisse}/statut`, { statut: 'TERMINE' });
      await api(SA, 'PATCH', `/api/chantiers/${chantierEncaisse}/encaisse`, { encaisse: true });
      const cibleEncaisse = { nom: 'chantier-termine-encaisse', ids: { id: chantierEncaisse }, etat: 'ENCAISSE', relations: { CT: 'titulaire (terminé et encaissé)' } };
      for (const route of ['PATCH /api/chantiers/:id/commercial', 'PATCH /api/chantiers/:id/encaisse']) CIBLES_PROPRES[route] = [cibleEncaisse];

      // Note N4 de l'audit des droits de #437 : un contrat sans visite (sa génération écrit), une intervention terminée
      // marquée « à suivre » (le retrait de la marque écrit), une version des mentions publiée puis remplacée (sa
      // nouvelle publication écrit).
      const contrat = await api(SA, 'POST', '/api/contrats-maintenance', { clientId: d.clientActif, titre: 'TEST Contrat sans visite de la matrice', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: d.aujourdhui }, 201);
      CIBLES_PROPRES['POST /api/contrats-maintenance/:id/generer-intervention'] = [{ nom: 'contrat-sans-visite', ids: { id: contrat.id }, relations: {} }];
      const aSuivre = await api(SA, 'POST', '/api/interventions', { clientId: d.clientActif, titre: 'TEST Intervention à suivre de la matrice' }, 201);
      await api(SA, 'PUT', `/api/interventions/${aSuivre.id}/planning`, { dateDebut: d.hier, creneau: 'JOURNEE', intervenantIds: [d.ficheTech] }, [200, 201]);
      await api(SA, 'PATCH', `/api/interventions/${aSuivre.id}/statut`, { statut: 'EN_COURS' });
      await api('TECH', 'POST', `/api/interventions/${aSuivre.id}/rapports`, { contenu: 'TEST Compte rendu de l’intervention à suivre.', cleEnvoi: randomUUID() }, 201);
      await api(SA, 'PATCH', `/api/interventions/${aSuivre.id}/statut`, { statut: 'TERMINEE', motifSansSignature: 'CLIENT_ABSENT' });
      await api(SA, 'PUT', `/api/interventions/${aSuivre.id}/a-suivre`, { aSuivre: true });
      CIBLES_PROPRES['PUT /api/interventions/:id/a-suivre'] = [{ nom: 'intervention-a-suivre', ids: { id: aSuivre.id }, relations: { TECH: 'affecté' } }];
      const versions = await api(SA, 'GET', '/api/mentions-legales');
      const premiere = versions.find((v) => v.actif === true && v.publieeLe);
      assert.ok(premiere, 'une version des mentions publiée et active');
      const seconde = await api(SA, 'POST', '/api/mentions-legales', { mentions: 'TEST mentions matrice v2', cgv: 'TEST CGV matrice v2', penalites: 'TEST pénalités matrice v2' }, 201);
      await api(SA, 'POST', `/api/mentions-legales/${seconde.version}/publier`, {});
      CIBLES_PROPRES['POST /api/mentions-legales/:version/publier'] = [{ nom: 'version-publiee-inactive', chemin: `/api/mentions-legales/${premiere.version}/publier`, ids: { id: String(premiere.version) }, relations: {} }];

      // Saisies Travaux des chantiers dont COM, DC, AC, CPT et DIR sont titulaires (droits individuels sans gain : étude
      // préalable, §1.3) : un achat et un pointage actifs, un achat et un pointage archivés.
      for (const [type, chantier] of Object.entries(TITULAIRES_SANS_SAISIE)) {
        const chantierId = id('chantier', chantier);
        const achat = async (description) => (await api(SA, 'POST', '/api/achats', { chantierId, categorieId: d.categorie, fournisseurId: d.fournisseur, date: d.hier, description, montantHT: 100 })).id;
        const heure = async () => (await api(SA, 'POST', '/api/heures', { chantierId, intervenantId: d.ficheLibre, date: d.hier, nbrHeures: 2 })).id;
        const relations = { [type]: 'titulaire du chantier' };
        const achatActif = await achat(`TEST Achat de ${chantier}`);
        const achatArchive = await achat(`TEST Achat archivé de ${chantier}`);
        await api(SA, 'DELETE', `/api/achats/${achatArchive}`, { motifArchivage: 'TEST archivage pour la matrice' });
        const heureActive = await heure();
        const heureArchivee = await heure();
        await api(SA, 'DELETE', `/api/heures/${heureArchivee}`, { motifArchivage: 'TEST archivage pour la matrice' });
        SAISIES_DES_TITULAIRES[type] = {
          achat: [{ nom: `achat-${chantier}`, ids: { id: achatActif }, relations, chantierId }, { nom: `achat-archive-${chantier}`, ids: { id: achatArchive }, relations, chantierId }],
          heure: [{ nom: `heure-${chantier}`, ids: { id: heureActive }, relations, chantierId }, { nom: `heure-archivee-${chantier}`, ids: { id: heureArchivee }, relations, chantierId }],
        };
      }

      // Versions de la comptabilité, relues en base (la remise les rend identiques à chaque cas).
      const regleClient = await appli.prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'CLIENT' } });
      const regleTva = await appli.prisma.regleTvaComptable.findFirstOrThrow({ where: { taux: 20 } });
      const compteClients = await appli.prisma.compteComptable.findUniqueOrThrow({ where: { id: id('compte-comptable', 'compte-comptable-clients') } });
      d.compta = {
        clientsBis, tvaBis, regleClientValeur: regleClient.compteId, regleClientMaj: regleClient.updatedAt.toISOString(),
        regleTvaCompte: regleTva.compteId, regleTvaMaj: regleTva.updatedAt.toISOString(), compteClientsMaj: compteClients.updatedAt.toISOString(),
      };

      // État des cibles dont le corps dépend, relu en base ; chantier des saisies (constat d'un champ ignoré).
      for (const cible of FAMILLES.devis.cibles) if (cible.nom !== INEXISTANT) cible.etat = (await appli.prisma.devis.findUniqueOrThrow({ where: { id: cible.ids.id }, select: { statut: true } })).statut;
      cibleDevisAcompte.etat = (await appli.prisma.devis.findUniqueOrThrow({ where: { id: devisAcompte.id }, select: { statut: true } })).statut;
      for (const cible of FAMILLES.achat.cibles) if (cible.nom !== INEXISTANT) cible.chantierId = (await appli.prisma.achatReel.findUniqueOrThrow({ where: { id: cible.ids.id } })).chantierId;
      for (const cible of FAMILLES.heure.cibles) if (cible.nom !== INEXISTANT) cible.chantierId = (await appli.prisma.pointageHeure.findUniqueOrThrow({ where: { id: cible.ids.id } })).chantierId;

      for (const cible of FAMILLES.chantier.cibles) if (cible.nom !== INEXISTANT) {
        const chantier = await appli.prisma.chantier.findUniqueOrThrow({ where: { id: cible.ids.id } });
        assert.ok(Object.keys(BUDGETS).every((champ) => Number(chantier[champ]) !== BUDGETS[champ]), `${cible.nom} : un budget vaut déjà celui du corps valide`);
      }

      // Instantané et outil de remise en état, une fois tout construit.
      const tables = await tablesDeLaBase(appli.prisma);
      remise = await creerRemiseEnEtat({
        url: base.url, nomBase: base.nom, tables, connexionApplication: appli.serveur.prisma,
        factureEmiseId: cibleDe('facture', 'facture-emise').ids.id,
      });
    });

    after(async () => {
      await remise?.fermer();
      await appli?.fermer();
      await base.supprimer();
    });

    // Avenant, section 1 : « les fichiers de D1a-5 l'exigent et échouent avec un message clair si le rôle de
    // TEST_DATABASE_URL ne peut pas poser ce paramètre — jamais de SKIP ».
    test('rôle PostgreSQL : le rôle de TEST_DATABASE_URL peut poser session_replication_role, sans quoi la base ne peut pas être remise en état entre deux cas (échec clair, jamais un SKIP)', () => {
      if (refusRole) throw refusRole;
    });

    // Avenant, ligne D1a-5b : « Routes (a) de session non marquées sur cibles réelles, avec un corps valide, hors des
    // routes et des champs réservés à 5d » ; ligne D1a-5d : « factures, avoirs et règlements, toutes leurs routes
    // d'écriture (a) ». Étude préalable, §1.1 : 91 routes (a), dont 16 marquées.
    testPrepare('périmètre : les 75 routes (a) non marquées, moins les 8 routes des factures, avoirs et règlements réservées à D1a-5d et les 3 routes refusées à tous avant la cible, chacune avec un corps valide pour chaque cible', () => {
      assert.equal(ROUTES_A.length, 75, `routes (a) non marquées : ${ROUTES_A.join(', ')}`);
      assert.deepEqual(RESERVEES_5D.filter((route) => !ROUTES_A.includes(route)), [], 'routes réservées à 5d : toutes des (a) non marquées');
      assert.equal(ROUTES_E.length, 64, `routes jouées : ${ROUTES_E.join(', ')}`);
      for (const route of SANS_COMPTE_ADMIS) assert.ok(COMPTES_JOUES.every((compte) => refuseAvantLaCible(compte, route)), `${route} : un compte admis à l’entrée`);
      for (const route of RESERVEES_5D) assert.equal(CORPS[route], undefined, `${route} : réservée à 5d, sans corps ici`);
      const routesJouees = [...ROUTES_E, ...ROUTES_TOUS_COMPTES];
      assert.deepEqual(Object.keys(CORPS).sort(), [...routesJouees].sort(), 'un corps valide pour chaque route jouée, et pour elles seules');
      for (const route of routesJouees) {
        const cibles = ciblesDe(route);
        assert.ok(cibles.length >= 1, `${route} : aucune cible`);
        for (const cible of cibles) assert.ok(cible.chemin && !cible.chemin.includes(':'), `${route} : cible ${cible.nom} sans chemin`);
        // Aucun corps ne porte un champ réservé à 5d (montant vendu, prix d'achat prévu, prix d'achat d'une fiche).
        for (const cible of cibles) for (const variante of CORPS[route](cible, d)) {
          assert.ok(!RESERVE_5D.test(JSON.stringify(variante.corps())), `${route} : corps ${variante.nom} réservé à 5d`);
        }
      }
      // Corps que seuls les droits individuels rejouent, dont les lignes de devis, où vit le prix d'achat prévu : même
      // contrôle, sur chaque cible réelle de leur famille ou portée par le corps (C3 de l'audit des montants de #440).
      for (const [route, corpsDroits] of Object.entries(CORPS_DROITS)) {
        const famille = CIBLE_DU_CORPS[route]?.famille ?? ROUTES_SESSION[route].famille;
        assert.ok(FAMILLES[famille], `${route} : famille de cibles inconnue`);
        for (const cible of FAMILLES[famille].cibles.filter((c) => c.nom !== INEXISTANT)) for (const variante of corpsDroits(cible, d)) {
          assert.ok(!RESERVE_5D.test(JSON.stringify(variante.corps())), `${route} : corps ${variante.nom} réservé à 5d (droits individuels)`);
        }
      }
    });

    // Avenant, ligne D1a-5b : « créations, modifications, champs ignorés en silence (état de la base inchangé) » ;
    // étude préalable, §1.7, blocs E3, E4 et S ; note N5 de l'audit des montants de #437 (coûts SAV d'une affaire close
    // ou annulée) ; note N4 de l'audit des droits de #437.
    testPrepare('écritures (a) non marquées : chaque compte admis à l’entrée, avec un corps valide, sur chaque cible réelle de la famille ou portée par le corps, base remise en état après chaque écriture ; coûts SAV d’une affaire close ou annulée ; écritures de la note N4', async () => {
      for (const route of [...ROUTES_E, ...ROUTES_TOUS_COMPTES]) await jouerRoute(route);
    });

    // Avenant, ligne D1a-5b : « les 337 changements « sans gain » de D1a-4 tranchés par une écriture réelle, dont les
    // actions (b) de la note N3 de l'audit des droits de #435 » ; cadrage §3, ligne D1a-4 : « D1a-5 le tranche par une
    // écriture réelle, par exemple chantiers:write d'un commercial sur POST /api/achats ». Le droit est donné par la
    // route d'administration (PUT /api/users/:id/permissions, session du super administrateur), puis retiré, comme dans
    // D1a-4 ; les lectures (GET) de individuels-sans-gain.txt n'écrivent rien et ne sont pas rejouées (D1a-4 les a déjà
    // jouées sur chaque cible réelle).
    testPrepare('droits individuels sans gain : chaque compte « type + droit » rejoue chaque écriture de individuels-sans-gain.txt avec un corps valide, sur chaque cible réelle, le droit donné puis retiré par la route d’administration', async () => {
      const ecritures = sansGain.filter((l) => !l.route.startsWith('GET '));
      const groupes = new Map();
      for (const l of ecritures) {
        const cle = `${l.type}${SEPARATEUR}${l.droit}`;
        if (!groupes.has(cle)) groupes.set(cle, { type: l.type, droit: l.droit, routes: new Map() });
        const routes = groupes.get(cle).routes;
        if (!routes.has(l.route)) routes.set(l.route, new Map());
        routes.get(l.route).set(l.cible, l.avec);
      }
      // Case « droit devis » de l'écran (devis:read, devis:write et clients:read, comme D1a-4) ; un scope seul sinon. Le
      // contexte nomme le droit : « droit devis » pour la case, « droit <scope> » pour un scope.
      const scopesDe = (droit) => (droit === 'droit devis' ? ['devis:read', 'devis:write', 'clients:read'] : [droit]);
      const contexteDroit = (droit) => (droit === 'droit devis' ? droit : `droit ${droit}`);
      for (const { type, droit, routes } of [...groupes.values()].sort((a, b) => (`${a.type}${a.droit}` < `${b.type}${b.droit}` ? -1 : 1))) {
        const cas = [];
        for (const [route, predites] of [...routes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
          const definition = ROUTES_SESSION[route];
          const [, chemin] = route.split(' ');
          let cibles;
          if (CIBLE_DU_CORPS[route]) {
            const { famille, champ } = CIBLE_DU_CORPS[route];
            cibles = FAMILLES[famille].cibles.filter((c) => c.nom !== INEXISTANT).map((c) => ({ nom: `${champ}=${c.nom}`, chemin, ids: c.ids, relations: c.relations ?? {} }));
          } else {
            cibles = FAMILLES[definition.famille].cibles.filter((c) => c.nom !== INEXISTANT).map((c) => cibleFamille(route, definition.famille, c));
            for (const c of SAISIES_DES_TITULAIRES[type]?.[definition.famille] ?? []) cibles.push(cibleFamille(route, definition.famille, c));
          }
          const corps = CORPS_DROITS[route] ?? ((cible) => CORPS[route](cible, d).filter((v) => !v.s));
          for (const cible of cibles) {
            for (const variante of corps(cible, d)) {
              const predite = predites.get(cible.nom);
              cas.push({ compte: type, droit, route, cible, variante, contexte: `${contexteDroit(droit)}, corps ${variante.nom}`, parallele: !!predite && REFUS_PREDIT.test(predite), admisEntree: false });
            }
          }
        }
        // Octroi par la route d'administration, puis état « avec le droit » relevé ; chaque cas est joué contre cet état
        // et la base y revient après chaque écriture ; retrait par la même route, puis remise à la référence.
        const octroi = await appeler(appli.adresse, 'PUT', `/api/users/${comptes[type].id}/permissions`, { jeton: comptes[SA].jeton, corps: { permissions: scopesDe(droit) } });
        assert.equal(octroi.status, 200, `${type}, octroi de ${droit} : ${JSON.stringify(octroi.body)}`);
        try {
          const avecDroit = await remise.empreinte();
          assert.deepEqual(tablesChangees(remise.reference, avecDroit), ['JournalAdministration', 'User'], `${type} + ${droit} : l’octroi n’écrit que le compte et son journal`);
          await jouerCas(cas, avecDroit, `${type} + ${droit}`);
        } finally {
          const retrait = await appeler(appli.adresse, 'PUT', `/api/users/${comptes[type].id}/permissions`, { jeton: comptes[SA].jeton, corps: { permissions: [] } });
          assert.equal(retrait.status, 200, `${type}, retrait de ${droit} : ${JSON.stringify(retrait.body)}`);
          await remise.remettre(remise.changees(await remise.empreinte()), `retrait de ${droit} à ${type}`);
        }
        chiffres.groupesDroits += 1;
        casDroits.push(...cas);
      }
      // Après le dernier groupe : chaque droit est retiré et la base est revenue à la référence (empreinte de toute la
      // base, table des comptes comprise). Un retrait ou une remise oubliés, qui laisseraient un droit posé, échouent ici
      // (T1 de l'audit des droits de #440).
      assert.deepEqual(remise.changees(await remise.empreinte()), [], 'droits individuels : la base n’est pas revenue à la référence après le dernier groupe');
      for (const type of new Set(ecritures.map((l) => l.type))) {
        const { permissions } = await appli.prisma.user.findUniqueOrThrow({ where: { id: comptes[type].id }, select: { permissions: true } });
        assert.deepEqual(permissions, [], `${type} : droit individuel laissé posé après les droits individuels`);
      }
      // Chaque ligne d'écriture de individuels-sans-gain.txt est tranchée : sur sa cible réelle, par le cas du même compte,
      // droit, route et cible ; sur « inexistant » ou une cible portée par le corps (« — »), par les cas du même compte,
      // droit et route sur chaque cible réelle.
      const bilan = { reelleEcrite: 0, reelleRefusee: 0, parLaRoute: 0 };
      for (const l of ecritures) {
        const memeRoute = casDroits.filter((c) => c.compte === l.type && c.droit === l.droit && c.route === l.route);
        assert.ok(memeRoute.length, `${l.type} + ${l.droit} sur ${l.route} : aucun cas joué`);
        if (l.cible === INEXISTANT || l.cible === cibleSansFamille(l.route.split(' ')[1])) { bilan.parLaRoute += 1; continue; }
        const memeCible = memeRoute.filter((c) => c.cible.nom === l.cible);
        assert.ok(memeCible.length, `${l.type} + ${l.droit} sur ${l.route}, cible ${l.cible} : aucun cas joué`);
        if (memeCible.some((c) => /^2\d\d écrit /.test(c.reponse))) bilan.reelleEcrite += 1; else bilan.reelleRefusee += 1;
      }
      diagnostics.push(`droits individuels : ${chiffres.groupesDroits} groupes (type + droit), ${casDroits.length} cas ; ${sansGain.length} lignes d’entrée de individuels-sans-gain.txt, dont ${sansGain.length - ecritures.length} lectures non rejouées et ${ecritures.length} écritures : ${bilan.reelleEcrite} sur une cible réelle qui écrit désormais, ${bilan.reelleRefusee} sur une cible réelle toujours refusée ou sans effet, ${bilan.parLaRoute} sur « inexistant » ou « — », tranchées par la même route sur chaque cible réelle`);
    });
    // Points affectés à D1a-5b (avenant, section 2 ; étude préalable, §1.6, points 5, 6 et 13) et note N5 de l'audit des
    // montants de #437. État décidé, avec sa source :
    //  - N6 : « Création d'une intervention par un conducteur hors de son périmètre (…) non corrigé ; tranché par un
    //    choix par défaut, à appliquer (section 4) » (passation, section 1, « Défauts connus », et section 4, « Droits et
    //    comptes ») : défaut connu, enregistré tel quel ;
    //  - chantier terminé : « PATCH /api/chantiers/:id admet le conducteur titulaire sur un chantier terminé (200 à corps
    //    vide) ; MODELE-DROITS-CIBLE.md ne dit rien de l'écriture d'un chantier clos, qu'une écriture réelle montrera en
    //    D1a-5 » (historique, liste « À documenter » de D1a-1) ;
    //  - #285 : « commercial et encaissement modifiables sur une affaire annulée » (issue suivi-audit, déjà connue) ;
    //  - coûts SAV : règle du 27-10-2026 (affaireSuite.ts) : « une affaire annulée n'accepte plus rien de personne, une
    //    affaire clôturée plus rien hors administration ».
    testPrepare('points connus : création d’intervention hors du périmètre (N6), chantier terminé modifié par son titulaire, encaissement d’une affaire annulée (#285), coûts SAV d’une affaire close (403 hors administration) ou annulée (409 pour tous)', () => {
      const reponse = (compte, route, cible, contexte) => {
        const debut = [compte, route, cible, contexte].join(SEPARATEUR) + SEPARATEUR;
        const trouvees = lignes.filter((l) => l.startsWith(debut));
        assert.equal(trouvees.length, 1, `ligne attendue : ${debut}`);
        return trouvees[0].slice(debut.length);
      };
      const corps = (nom) => `${CONTEXTE_DEFAUT}, corps ${nom}`;
      // N6 : le conducteur crée une intervention sur un chantier hors de son périmètre (défaut connu, à appliquer).
      for (const chantier of ['chantier-autre', 'chantier-com', 'chantier-resp']) assert.match(reponse('CT', 'POST /api/interventions', `chantierId=${chantier}`, corps('client, titre et chantier')), /^201 écrit \(.*Intervention/);
      assert.match(reponse('CT', 'POST /api/interventions', 'chantierId=chantier-ct', corps('client, titre et chantier')), /^201 écrit \(/);
      // Chantier terminé : son titulaire le modifie (nom, budgets, heures vendues, relus en base) ; un autre conducteur
      // reçoit 404. Terminé et encaissé : son titulaire réattribue le commercial, donc le CA et la marge validés, et
      // l'administration retire l'encaissement (C2 de l'audit des montants de #440 ; question posée à Nelson).
      assert.equal(reponse('CT', 'PATCH /api/chantiers/:id', 'chantier-termine', corps('nom, budgets par poste et heures vendues')), '200 écrit (Chantier) ; budgets par poste et heures vendues écrits');
      assert.equal(reponse('CT', 'PATCH /api/chantiers/:id/commercial', 'chantier-termine-encaisse', corps('commercialId=COM')), '200 écrit (Chantier,JournalSaisieChantier)');
      for (const compte of ADMINISTRATION) assert.equal(reponse(compte, 'PATCH /api/chantiers/:id/encaisse', 'chantier-termine-encaisse', corps('encaisse=non')), '200 écrit (Chantier,JournalSaisieChantier)');
      assert.equal(reponse('CT-N1', 'PATCH /api/chantiers/:id', 'chantier-termine', corps('nom, budgets par poste et heures vendues')), '404 « Chantier introuvable » inchangé');
      // #285 : l'administration encaisse une affaire annulée.
      for (const compte of ADMINISTRATION) assert.match(reponse(compte, 'PATCH /api/chantiers/:id/encaisse', 'chantier-annule', corps('encaisse=oui')), /^200 écrit \(/);
      // Coûts SAV d'une suite d'une affaire clôturée : refus hors administration (403), l'administration écrit.
      const CLOTURE = '403 « Le chantier de cette suite est clôturé : ses coûts ne peuvent plus être saisis ni modifiés. » inchangé';
      const ANNULEE = '409 « L’affaire de cette suite est annulée : plus aucun coût ne peut y être saisi. » inchangé';
      assert.equal(reponse('TECH', 'POST /api/interventions/:id/couts/heures', 'suite-affaire-close', corps('date et heures')), CLOTURE);
      assert.equal(reponse('CT', 'POST /api/interventions/:id/couts/achats', 'suite-affaire-close', corps('date, description, montantHT et fournisseur')), CLOTURE);
      assert.equal(reponse('CT', 'POST /api/interventions/:id/couts/:type/:coutId/:action', 'materiel-suite-affaire-close', corps('motif')), CLOTURE);
      assert.equal(reponse('CT', ROUTE_CORRECTION_COUT, 'materiel-suite-affaire-close', corps('montantHT et motif')), CLOTURE);
      assert.equal(reponse('TECH', ROUTE_CORRECTION_COUT, 'heures-suite-affaire-close', corps('nbrHeures et motif')), CLOTURE);
      for (const compte of ADMINISTRATION) {
        assert.match(reponse(compte, 'POST /api/interventions/:id/couts/achats', 'suite-affaire-close', corps('date, description, montantHT et fournisseur')), /^201 écrit \(/);
        assert.match(reponse(compte, 'POST /api/interventions/:id/couts/:type/:coutId/:action', 'materiel-suite-affaire-close', corps('motif')), /^200 écrit \(/);
        assert.match(reponse(compte, ROUTE_CORRECTION_COUT, 'materiel-suite-affaire-close', corps('montantHT et motif')), /^200 écrit \(/);
        // Affaire annulée : refus pour tous, administration comprise.
        assert.equal(reponse(compte, 'POST /api/interventions/:id/couts/achats', 'suite-affaire-annulee', corps('date, description, montantHT et fournisseur')), ANNULEE);
        assert.equal(reponse(compte, 'POST /api/interventions/:id/couts/:type/:coutId/:action', 'materiel-archive-suite-affaire-annulee', corps('motif')), ANNULEE);
        assert.equal(reponse(compte, ROUTE_CORRECTION_COUT, 'materiel-archive-suite-affaire-annulee', corps('montantHT et motif')), ANNULEE);
      }
      assert.equal(reponse('TECH', 'POST /api/interventions/:id/couts/heures', 'suite-affaire-annulee', corps('date et heures')), ANNULEE);
    });

    // Avenant, ligne D1a-5b : « champs ignorés en silence (état de la base inchangé) » ; étude préalable, §1.7, bloc S :
    // « statut et client d'un non-administrateur ». Code : PATCH /api/chantiers/:id n'accepte le statut et le client que
    // de l'administration (chantiers/routes.ts, `allowed`) ; une saisie Travaux ne change pas de chantier
    // (chantiers/saisies.ts) ; seul un super administrateur pose l'accès financier (utilisateurs/comptes.ts).
    testPrepare('champs ignorés en silence : statut et client d’un chantier hors administration, chantier d’une saisie Travaux, accès financier d’un compte créé par un administrateur ; l’empreinte ou le constat relu en base prouve que le champ n’a pas changé', () => {
      const reponse = (compte, route, cible, nom) => {
        const debut = [compte, route, cible, `${CONTEXTE_DEFAUT}, corps ${nom}`].join(SEPARATEUR) + SEPARATEUR;
        const trouvees = lignes.filter((l) => l.startsWith(debut));
        assert.equal(trouvees.length, 1, `ligne attendue : ${debut}`);
        return trouvees[0].slice(debut.length);
      };
      const CHANTIER = 'PATCH /api/chantiers/:id';
      for (const [compte, cible] of [['CT', 'chantier-ct'], ['CT', 'chantier-termine'], ['RESP', 'chantier-resp'], ['DC', 'chantier-dc'], ['AC', 'chantier-ac'], ['CPT', 'chantier-cpt']]) {
        assert.equal(reponse(compte, CHANTIER, cible, 'statut=TERMINE seul'), '200 inchangé', `${compte} : statut ignoré`);
        assert.equal(reponse(compte, CHANTIER, cible, 'clientId=client-second seul'), '200 inchangé', `${compte} : client ignoré`);
      }
      for (const compte of ADMINISTRATION) {
        assert.match(reponse(compte, CHANTIER, 'chantier-ct', 'statut=TERMINE seul'), /^200 écrit \(Chantier\)$/);
        assert.match(reponse(compte, CHANTIER, 'chantier-com', 'clientId=client-second seul'), /^200 écrit \(/);
        assert.match(reponse(compte, 'PATCH /api/achats/:id', 'achat-chantier-ct', 'chantierId=chantier-autre et motif'), /^200 écrit \(.*\) ; chantier de l’achat inchangé$/);
        assert.match(reponse(compte, 'PATCH /api/heures/:id', 'heure-chantier-ct', 'chantierId=chantier-autre et motif'), /^200 écrit \(.*\) ; chantier du pointage inchangé$/);
      }
      assert.match(reponse('CT', 'PATCH /api/achats/:id', 'achat-chantier-ct', 'chantierId=chantier-autre et motif'), /^200 écrit \(.*\) ; chantier de l’achat inchangé$/);
      assert.match(reponse('SA', 'POST /api/users', '—', 'compte commercial, accesFinance=oui'), /^201 écrit \(.*\) ; accesFinance=oui$/);
      for (const compte of ['AD', 'AD-COM']) assert.match(reponse(compte, 'POST /api/users', '—', 'compte commercial, accesFinance=oui'), /^201 écrit \(.*\) ; accesFinance=non$/);
    });

    // Avenant, section 3 : « pour chaque couple (compte, route) admis à l'entrée, au moins un cas dans et un cas hors du
    // périmètre, quand le jeu de données le permet ; sinon, le corps de la sous-PR le dit ». Indicateur : la table des
    // relations de donnees.mjs, sans compter « dans le périmètre » une relation marquée « (hors périmètre) » (N7 du
    // contrôle de #437) ; la référence enregistre la réponse réelle.
    testPrepare('minimum de l’avenant : chaque couple (compte, route) admis à l’entrée est joué sur toutes les cibles de sa route ; les couples sans cible dans ou hors du périmètre sont relevés', (t) => {
      const sansDans = []; const sansHors = [];
      for (const [cle, { dans, hors, cibles, vues }] of [...couples].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        assert.equal(vues.size, cibles, `${cle} : cibles jouées`);
        if (ADMINISTRATION.includes(cle.split(SEPARATEUR)[0])) continue;
        if (!dans.size) sansDans.push(cle);
        if (!hors.size) sansHors.push(cle);
      }
      t.diagnostic(`couples admis à l’entrée : ${couples.size} (hors administration : ${[...couples.keys()].filter((c) => !ADMINISTRATION.includes(c.split(SEPARATEUR)[0])).length})`);
      t.diagnostic(`sans cible dans le périmètre (${sansDans.length}) : ${sansDans.join(' ; ')}`);
      t.diagnostic(`sans cible hors du périmètre (${sansHors.length}) : ${sansHors.join(' ; ')}`);
    });

    // Cadrage §2.1 (N8) : la matrice obtenue est la référence, au caractère près (diff imprimé, résumé par compte et route
    // au-delà de 60 lignes) ; cadrage v3, §3, ligne D1a-5 : « Les montants restent hors de la référence ».
    testPrepare('la matrice obtenue est la référence matrice-droits/ecritures-modifications.txt, chaque cas y a une ligne, et aucune ligne ne porte de montant', (t) => {
      const cles = lignes.map((l) => l.split(SEPARATEUR).slice(0, 4).join(SEPARATEUR));
      assert.equal(new Set(cles).size, cles.length, 'chaque cas n’a qu’une ligne');
      assert.equal(lignes.length, Object.values(chiffres.parRoute).reduce((s, r) => s + r.cas, 0) + casDroits.length, 'une ligne par cas joué');
      const routesVues = new Set(lignes.map((l) => l.split(SEPARATEUR)[1]));
      assert.deepEqual([...ROUTES_E, ...ROUTES_TOUS_COMPTES].filter((route) => !routesVues.has(route)), [], 'routes sans ligne');
      // Seule cible admise avec un chiffre : la valeur fixe du taux de TVA (paramètre :taux, VALEURS_FIXES de donnees.mjs),
      // nommée comme dans entrees.txt ; ce n'est pas un montant écrit, mais le taux dont la règle est remappée ou retirée.
      const ciblesAdmises = [cibleSansFamille('/api/comptabilite/tva/:taux')];
      assert.deepEqual(lignesAvecMontant(lignes, { comptes: COMPTES_JOUES, constat: true, ciblesAdmises }), [], 'lignes qui portent un montant, ou un nombre hors du code de la réponse et des comptes d’objets d’un refus');
      for (const texte of diagnostics) t.diagnostic(texte);
      t.diagnostic(`routes : ${ROUTES_E.length} (a) non marquées, ${ROUTES_TOUS_COMPTES.length} sur cibles propres (correction d’un coût SAV, note N4) ; comptes : ${COMPTES_JOUES.length}`);
      t.diagnostic(`cas : ${lignes.length} (en parallèle ${chiffres.casParalleles}, un à un ${chiffres.casUnAUn}) ; écrits : ${chiffres.casEcrits} ; remises : ${remise.remises} ; comptes refusés avant la cible non rejoués : ${chiffres.refusesNonRejoues} ; lots rejoués : ${chiffres.lotsRejoues.length ? chiffres.lotsRejoues.join(' ; ') : 'aucun'}`);
      for (const [route, r] of Object.entries(chiffres.parRoute)) t.diagnostic(`${route} : ${r.cibles} cible(s), ${r.cas} cas, ${r.ms} ms`);
      comparerAvecReference(lignes, REFERENCE, 'ecritures-modifications.txt');
    });
  });
}
