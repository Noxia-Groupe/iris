// Matrice de non-régression des droits à l'écran (lot D1a-6). Cadrage du lot D1a-6, version 3 du 03-11-2026, contrôlé par
// le controleur-coherence et publié sur #427 ; cadrage du lot D1a, version 3, ligne D1a-6 ; CIBLE §7.1, dimension
// « Écran » : « parcours E2E rôle par rôle : menus, routes accessibles, boutons proposés ».
//
// Tests seuls : la référence enregistre l'état actuel de l'écran, sans rien corriger. Les constats du cadrage (§11) y
// figurent tels quels : E1, « Créer une affaire (devis) » proposé à RESP, CT et TECH et caché à COM ; E2, « Corriger »
// et « Archiver » proposés sur un chantier clôturé ; les écrans plus restrictifs que le serveur, déjà connus.
//
// Pour chacun des dix types de compte, dans Chromium, en grand écran (1280 × 900), réglages par défaut :
//  - les sections du menu et le type affiché ;
//  - pour chaque route privée du client (App.tsx), son entrée au menu, et si elle est accessible ou redirigée ;
//  - les boutons proposés sur les écrans principaux (cadrage §6.2), dans leur portée, sur les cibles du test (§6.1).
// Un test par type, chacun avec son jeu de données, construit par l'API ; un test du module Planning coupé (CT et SA,
// seul écart à « un seul passage par rôle », N12) ; un test de couverture des routes ; les témoins de la garde
// « aucun montant ». Une ligne par (compte, écran, cible, contexte), un fichier de référence par test
// (matrice-droits/ecrans-<TYPE>.txt et ecrans-planning-coupe.txt) ; en cas d'écart voulu, l'obtenu s'adopte par la
// commande `cp` que donne le message d'échec. Aucun montant n'est enregistré : seulement des libellés de menu, des
// chemins, des titres d'écran et des noms de boutons, normalisés (matrice-droits/outils.ts), ce que la garde vérifie.
//
// Les appels d'API de préparation passent par le proxy /api du frontend (adresse relative à `baseURL`) : la spec ne lit
// aucune variable d'environnement (règle permanente 3, N3 du contrôle).
import { randomInt, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, dateDuJour, horsDuPassageDeMinuit } from './fixtures';
import {
  DOSSIER_REFERENCES, ROUTES_PUBLIQUES, SEPARATEUR, auCalme, boutonsDe, branchesMontant, commandesDeLigne, comparerAvecReference,
  creerNormaliseur, entreesDuMenu, gardeAucunMontant, jouerEcran, jouerRoute, ligneMatrice, lireReference, routesDuClient,
  routesPrivees, suivreReseau, titreDeLEcran, trier, type Portee,
} from './matrice-droits/outils';

// Les dix types, dans l'ordre de server/tests/matrice-droits/comptes.mjs:17-28 (cadrage §4.1). Un onzième type
// (l'assistante technique, décision du 24-10-2026) s'ajoute par une ligne, avec sa référence (N13 du cadrage v3 de D1a).
// Variantes et droits individuels : non joués à l'écran (cadrage §4.1 et §8).
const TYPES = [
  { cle: 'SA', role: 'SUPERADMIN', libelle: 'super administrateur (accès de secours)' },
  { cle: 'AD', role: 'ADMIN', libelle: 'administrateur' },
  { cle: 'DIR', role: 'DIRECTEUR', libelle: 'directeur' },
  { cle: 'RESP', role: 'RESPONSABLE', libelle: 'responsable, avec une branche (TECH et CT)' },
  { cle: 'CT', role: 'CONDUCTEUR_TRAVAUX', libelle: 'conducteur de travaux, dans la branche de RESP' },
  { cle: 'COM', role: 'COMMERCIAL', libelle: 'commercial' },
  { cle: 'DC', role: 'DIRECTEUR_COMMERCIAL', libelle: 'directeur commercial' },
  { cle: 'AC', role: 'ASSISTANTE_COMMERCIALE', libelle: 'assistante commerciale' },
  { cle: 'CPT', role: 'COMPTABLE', libelle: 'comptable' },
  { cle: 'TECH', role: 'TECHNICIEN', libelle: 'technicien, fiche intervenant reliée, dans la branche de RESP' },
];
const AFFICHAGE = { viewport: { width: 1280, height: 900 } };

type Appel = (methode: 'get' | 'post' | 'put' | 'patch', chemin: string, data?: object) => Promise<any>;
const clientApi = (request: APIRequestContext, token: string): Appel => async (methode, chemin, data) => {
  const reponse = await request[methode](`/api${chemin}`, { headers: { Authorization: `Bearer ${token}` }, ...(data ? { data } : {}) });
  expect(reponse.ok(), `${methode.toUpperCase()} /api${chemin} : ${reponse.status()} ${await reponse.text()}`).toBeTruthy();
  return reponse.json();
};

// Réglages que la matrice lit, à leur valeur par défaut (cadrage §3, N12 a) : si une autre spec ne les a pas restaurés,
// le test échoue ici, sur un message clair, et non sur un diff.
async function verifierReglagesParDefaut(appel: Appel) {
  const modules = await appel('get', '/modules');
  const parametres = await appel('get', '/parametres');
  const lus = {
    planningActif: modules.planningActifGlobal,
    margeCommercialeActive: parametres.margeCommercialeActive,
    rentabiliteConducteur: parametres.rentabiliteConducteur,
    rentabiliteHierarchie: parametres.rentabiliteHierarchie,
    rentabiliteDirecteurs: parametres.rentabiliteDirecteurs,
  };
  expect(lus, 'Réglages hors de leur valeur par défaut : une spec précédente ne les a pas restaurés (module Planning : '
    + 'afterEach de cette spec ; marge et destinataires de la rentabilité : rentabilite-hierarchie.spec.ts). La matrice se lit '
    + 'sous les réglages par défaut.').toEqual({ planningActif: true, margeCommercialeActive: true, rentabiliteConducteur: true, rentabiliteHierarchie: true, rentabiliteDirecteurs: true });
}

// --- Jeu de données (cadrage §4.1 et §6.1), construit par l'API en session SA, propre à chaque test ---
// Comptes : les neuf types hors SA ; TECH et CT rattachés à RESP ; une fiche intervenant reliée à TECH. Cibles :
//  - chantier-en-cours : titulaire CT, commercial COM, un achat, un pointage, une facture émise liée (« Factures liées »
//    et leur PDF, M17) ;
//  - chantier-termine : idem sans facture, puis clôturé (E2) ;
//  - chantier-titulaire-dc et chantier-titulaire-tech : en cours (« Modifier » que l'API admet au DC titulaire et que
//    l'écran ne propose qu'au CT, CIBLE §4.2 note 2, M05a ; fiche du technicien et branche de RESP) ;
//  - chantier-annule : comme chantier-en-cours, sans facture ni saisie (l'annulation est refusée dès une saisie,
//    devis/annulation.ts:94-99), puis devis annulé, ce qui annule le chantier (T1 du contrôle, M19) ;
//  - intervention-planifiee et intervention-terminee : rattachées à chantier-en-cours, affectées à TECH, placées au
//    lendemain ; la seconde démarrée, avec compte rendu, terminée avec motif ;
//  - devis-brouillon (acompte exigé) et devis-signe (envoyé et signé, sans conversion) ;
//  - un fournisseur et une catégorie (lignes de l'administration).
// Tout porte un suffixe aléatoire, sur une base E2E partagée : une liste n'est lue que sur les lignes des cibles du test,
// et la référence ne dépend ni de l'ordre des specs, ni de l'âge de la base.
async function preparer(appel: Appel, creerClient: (libelle: string) => Promise<{ id: string }>) {
  const s = `${Date.now()}-${randomInt(1_000_000)}`;
  const comptes: Record<string, { id: string; name: string }> = {};
  for (const t of TYPES) {
    if (t.cle !== 'SA') comptes[t.cle] = await appel('post', '/users', { email: `ecrans.${t.cle.toLowerCase()}.${s}@iris.test`, name: `Écrans ${t.cle} ${s}`, role: t.role });
  }
  await appel('patch', `/users/${comptes.TECH.id}/responsable-hierarchique`, { responsableHierarchiqueId: comptes.RESP.id });
  await appel('patch', `/users/${comptes.CT.id}/responsable-hierarchique`, { responsableHierarchiqueId: comptes.RESP.id });
  const fiche = await appel('post', '/intervenants', { nom: `Écrans fiche ${s}`, role: 'Technicien', tauxHoraireCharge: 40 });
  await appel('put', `/intervenants/${fiche.id}/compte`, { userId: comptes.TECH.id });
  const client = await creerClient(`ecrans-${s}`);
  const noms = { fournisseur: `Écrans fournisseur ${s}`, categorie: `Écrans catégorie ${s}` };
  const fournisseur = await appel('post', '/fournisseurs', { nom: noms.fournisseur });
  const categorie = await appel('post', '/categories', { nom: noms.categorie });
  const lignesDevis = [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }];
  const ouvrir = async (objet: string, titulaireId: string, saisies: boolean) => {
    const devis = await appel('post', '/devis', { clientId: client.id, objet, lignes: lignesDevis });
    await appel('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
    await appel('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
    const chantier = await appel('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' });
    await appel('patch', `/chantiers/${chantier.id}`, { responsableId: titulaireId });
    await appel('patch', `/chantiers/${chantier.id}/commercial`, { commercialId: comptes.COM.id });
    if (saisies) {
      await appel('post', '/achats', { chantierId: chantier.id, categorieId: categorie.id, fournisseurId: fournisseur.id, date: dateDuJour(), description: `Écrans achat ${s}`, montantHT: 10 });
      await appel('post', '/heures', { chantierId: chantier.id, intervenantId: fiche.id, date: dateDuJour(), nbrHeures: 1 });
    }
    return { chantier: chantier as { id: string }, devis: devis as { id: string } };
  };
  const enCours = await ouvrir(`Écrans en cours ${s}`, comptes.CT.id, true);
  const facture = await appel('post', '/factures', { clientId: client.id, origine: 'CHANTIER', chantierId: enCours.chantier.id, dateEmission: dateDuJour(), dateEcheance: dateDuJour(), lignes: [{ designation: `Écrans facture ${s}`, quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
  await appel('post', `/factures/${facture.id}/emettre`, {});
  const termine = await ouvrir(`Écrans terminé ${s}`, comptes.CT.id, true);
  await appel('patch', `/chantiers/${termine.chantier.id}/statut`, { statut: 'TERMINE' });
  const titulaireDc = await ouvrir(`Écrans titulaire DC ${s}`, comptes.DC.id, true);
  const titulaireTech = await ouvrir(`Écrans titulaire TECH ${s}`, comptes.TECH.id, true);
  const annule = await ouvrir(`Écrans annulé ${s}`, comptes.CT.id, false);
  await appel('post', `/devis/${annule.devis.id}/annulation`, { motif: 'Annulation E2E de la matrice des écrans' });
  expect((await appel('get', `/chantiers/${annule.chantier.id}`)).statut, 'chantier-annule').toBe('ANNULE');
  const iso = dateDuJour().split('-').reverse().join('-');
  const demain = new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const intervention = async (titre: string) => {
    const creee = await appel('post', '/interventions', { clientId: client.id, titre: `${titre} ${s}`, chantierId: enCours.chantier.id });
    await appel('put', `/interventions/${creee.id}/planning`, { intervenantIds: [fiche.id], dateDebut: demain, creneau: 'JOURNEE' });
    return creee as { id: string; reference: string };
  };
  const planifiee = await intervention('Écrans planifiée');
  const terminee = await intervention('Écrans terminée');
  await appel('patch', `/interventions/${terminee.id}/statut`, { statut: 'EN_COURS' });
  await appel('post', `/interventions/${terminee.id}/rapports`, { contenu: 'Fait.', cleEnvoi: randomUUID() });
  await appel('patch', `/interventions/${terminee.id}/statut`, { statut: 'TERMINEE', motifSansSignature: 'CLIENT_ABSENT' });
  const objets = { brouillon: `Écrans devis brouillon ${s}`, signe: `Écrans devis signé ${s}` };
  const devisBrouillon = await appel('post', '/devis', { clientId: client.id, objet: objets.brouillon, acompteExige: true, tauxAcompte: 30, lignes: lignesDevis });
  const devisSigne = await appel('post', '/devis', { clientId: client.id, objet: objets.signe, lignes: lignesDevis });
  await appel('put', `/devis/${devisSigne.id}/statut`, { statut: 'ENVOYE' });
  await appel('post', `/devis/${devisSigne.id}/signature`, { signataire: 'Client E2E', confirme: true });
  return {
    comptes,
    ids: {
      client: client.id, planifiee: planifiee.id, terminee: terminee.id,
      chantiers: { 'chantier-en-cours': enCours.chantier.id, 'chantier-termine': termine.chantier.id, 'chantier-titulaire-dc': titulaireDc.chantier.id, 'chantier-titulaire-tech': titulaireTech.chantier.id, 'chantier-annule': annule.chantier.id },
    },
    objets,
    noms,
    // Normalisation (cadrage §5) : références et numéros des cibles, noms des comptes, suffixe.
    normalisation: {
      cibles: { 'intervention-planifiee': planifiee.reference, 'intervention-terminee': terminee.reference, 'devis-brouillon': devisBrouillon.numero, 'devis-signe': devisSigne.numero },
      comptes: Object.fromEntries(Object.entries(comptes).map(([cle, compte]) => [cle, compte.name])),
      suffixe: s,
    },
  };
}
type JeuDeDonnees = Awaited<ReturnType<typeof preparer>>;
type Connexion = (compte: { id: string } | 'SA', options?: object) => Promise<Page>;

// Contexte « planning coupé » (cadrage §6.3) : le menu, les routes /planning et /interventions/:id, l'écran du planning
// et les deux fiches d'intervention.
const SELECTION_COUPE = { routes: ['/planning', '/interventions/:id'], ecrans: ['planning', 'fiche intervention'] };

// Parcours d'un compte : un chargement complet, puis la navigation dans l'application (cadrage §3). Rend ses lignes.
async function parcourir(cle: string, contexte: string, jeu: JeuDeDonnees, connexion: Connexion, selection?: typeof SELECTION_COUPE) {
  const lignes: string[] = [];
  const ligne = (ecran: string, cible: string, observation: string) => lignes.push(ligneMatrice([cle, ecran, cible, contexte, observation]));
  const normaliser = creerNormaliseur(jeu.normalisation);
  const page = await connexion(cle === 'SA' ? 'SA' : jeu.comptes[cle], AFFICHAGE);
  // Aucune fenêtre : un alert ou un confirm ouvert fait échouer le test (cadrage §3).
  const fenetres: string[] = [];
  page.on('dialog', (fenetre) => { fenetres.push(`${fenetre.type()} « ${fenetre.message()} »`); void fenetre.dismiss(); });
  const etat = suivreReseau(page);
  await page.goto('/', { waitUntil: 'networkidle' });

  // Menu : sections, type affiché ; chaque entrée, relue par son chemin, est portée par la ligne de sa route.
  const menu = await page.evaluate(() => {
    const racine = document.querySelector('#menu-principal');
    const entrees: Record<string, string> = {};
    const sections: string[] = [];
    for (const groupe of Array.from(racine?.querySelectorAll('[role="group"]') || [])) {
      sections.push(groupe.getAttribute('aria-label') || '');
      for (const lien of Array.from(groupe.querySelectorAll('a'))) entrees[new URL(lien.href).pathname] = `${groupe.getAttribute('aria-label')} › ${(lien.textContent || '').trim()}`;
    }
    return { entrees, sections, type: (racine?.querySelector('.sidebar-compte-role')?.textContent || '').trim() };
  });
  ligne('menu', '—', `sections : ${menu.sections.join(', ')} ; type affiché : ${menu.type}`);
  const privees = routesPrivees();
  expect(Object.keys(menu.entrees).filter((chemin) => !privees.includes(chemin)), `${cle} : entrée du menu qui ne mène à aucune route privée`).toEqual([]);

  // Routes privées : le paramètre d'une route reçoit sa cible.
  const concretes: Record<string, [string, string]> = {
    '/chantiers/:id': [`/chantiers/${jeu.ids.chantiers['chantier-en-cours']}`, 'chantier-en-cours'],
    '/interventions/:id': [`/interventions/${jeu.ids.planifiee}`, 'intervention-planifiee'],
    '/clients/:id': [`/clients/${jeu.ids.client}`, 'client'],
  };
  for (const route of privees) {
    if (selection && !selection.routes.includes(route)) continue;
    const [chemin, cible] = concretes[route] ?? [route, '—'];
    const arrivee = await jouerRoute(page, chemin);
    ligne(`route ${route}`, cible, `${menu.entrees[route] ? `menu « ${menu.entrees[route]} »` : 'hors menu'} ; ${arrivee === chemin ? 'accessible' : `redirigée vers ${arrivee}`}`);
  }

  // Écrans principaux (cadrage §6.2) : chacun monté à neuf, puis lu dans sa portée.
  const boutons = (noms: string[], ecran: string) => `boutons : ${trier(noms.map((nom) => normaliser(nom, ecran))).join(', ') || 'aucun'}`;
  const titre = async (ecran: string) => `titre « ${normaliser(await titreDeLEcran(page), ecran)} »`;
  const ouvrirEcran = async (ecran: string, chemin: string, cible: string) => {
    const arrivee = await jouerEcran(page, etat, chemin);
    if (arrivee !== chemin) ligne(ecran, cible, `redirigé vers ${arrivee}`);
    return arrivee === chemin;
  };
  const lireFiche = async (ecran: string, chemin: string, cible: string) => {
    if (await ouvrirEcran(ecran, chemin, cible)) ligne(ecran, cible, `${await titre(ecran)} ; ${boutons((await boutonsDe(page, { tout: true }))!, ecran)}`);
  };
  // Liste à lignes : une ligne pour les boutons hors lignes, puis une par ligne cible (« ligne absente » si la cible
  // n'y figure pas), pour qu'un bouton qui passe d'une ligne à l'autre se voie.
  const lireListe = async (ecran: string, chemin: string, cibles: [string, Portee][], section?: RegExp) => {
    if (!await ouvrirEcran(ecran, chemin, 'hors lignes')) return;
    if (section) {
      const repliee = page.locator('main').getByRole('button', { name: section });
      if (await repliee.count()) { await repliee.click(); await auCalme(page, etat); }
    }
    ligne(ecran, 'hors lignes', `${await titre(ecran)} ; ${boutons((await boutonsDe(page, { horsLignes: true }))!, ecran)}`);
    for (const [cible, portee] of cibles) {
      const noms = await boutonsDe(page, portee);
      ligne(ecran, cible, noms === null ? 'ligne absente' : boutons(noms, ecran));
    }
  };
  const voir = (ecran: string) => !selection || selection.ecrans.includes(ecran);

  if (voir('fiche chantier')) {
    for (const [cible, id] of Object.entries(jeu.ids.chantiers)) await lireFiche('fiche chantier', `/chantiers/${id}`, cible);
  }
  // Liste des chantiers : section « Chantiers Terminés / Archivés » ouverte (« Réouvrir »).
  if (voir('liste des chantiers')) {
    await lireListe('liste des chantiers', '/chantiers', Object.entries(jeu.ids.chantiers).map(([cible, id]) => [cible, { selecteur: `tr[data-chantier="${id}"]` }]), /^Chantiers Terminés/);
  }
  if (voir('liste des interventions')) await lireListe('liste des interventions', '/interventions', []);
  if (voir('fiche intervention')) {
    await lireFiche('fiche intervention', `/interventions/${jeu.ids.planifiee}`, 'intervention-planifiee');
    await lireFiche('fiche intervention', `/interventions/${jeu.ids.terminee}`, 'intervention-terminee');
  }
  if (voir('devis')) await lireListe('devis', '/devis', [['devis-brouillon', { texte: jeu.objets.brouillon }], ['devis-signe', { texte: jeu.objets.signe }]]);
  // Factures : Factures.tsx ne teste aucun rôle, seule la route le fait ; pagination exclue.
  if (voir('factures')) await lireListe('factures', '/factures', []);
  if (voir('planning')) await lireListe('planning', '/planning', []);
  // Administration : l'onglet par défaut (onglets et formulaire, hors lignes), puis les lignes du fournisseur et de la
  // catégorie cibles, chacune dans son onglet ; là où l'onglet « Utilisateurs » existe (SA, AD), la ligne du compte CT,
  // avec ses boutons, cases et listes et leur état. Le champ cible nomme ce qui est lu (N6 du contrôle).
  if (voir('administration') && await ouvrirEcran('administration', '/admin', 'onglet par défaut')) {
    const principal = page.locator('main');
    ligne('administration', 'onglet par défaut', `${await titre('administration')} ; ${boutons((await boutonsDe(page, { horsLignes: true }))!, 'administration')}`);
    for (const [onglet, cible, nom] of [['Fournisseurs', 'fournisseur', jeu.noms.fournisseur], ['Catégories', 'catégorie', jeu.noms.categorie]]) {
      const bouton = principal.getByRole('button', { name: onglet, exact: true });
      if (!await bouton.count()) { ligne('administration', cible, `onglet « ${onglet} » absent`); continue; }
      await bouton.click();
      await auCalme(page, etat);
      const noms = await boutonsDe(page, { texte: nom });
      ligne('administration', cible, noms === null ? 'ligne absente' : boutons(noms, 'administration'));
    }
    const utilisateurs = principal.getByRole('button', { name: 'Utilisateurs', exact: true });
    if (await utilisateurs.count()) {
      await utilisateurs.click();
      await auCalme(page, etat);
      const selecteur = `main tr:has(input[aria-label="Droit devis — ${jeu.comptes.CT.name}"])`;
      const commandes = await page.locator(selecteur).count() ? await commandesDeLigne(page, selecteur) : null;
      ligne('administration › utilisateurs', 'compte CT', commandes === null ? 'ligne absente' : trier(commandes.map((c) => normaliser(c, 'administration'))).join(', '));
    }
  }
  expect(fenetres, `${cle} : aucune fenêtre (alert, confirm) ne doit s'ouvrir`).toEqual([]);
  return lignes;
}

function verifierAucunMontant(lignes: string[]) {
  expect(gardeAucunMontant(lignes), 'garde « aucun montant » : une ligne porte encore un chiffre, « € », « % » ou « #,# » (cadrage §5)').toEqual([]);
}

test.describe('Matrice des droits à l’écran (lot D1a-6)', () => {
  for (const type of TYPES) {
    test(`${type.cle}, ${type.libelle} : le menu, les routes du client et les boutons des écrans principaux sont ceux de la référence`, async ({ request, session, creerClient, connexion }) => {
      test.slow();
      // La préparation date la facture du jour et place les interventions au lendemain (N12 b du contrôle).
      await horsDuPassageDeMinuit();
      const appel = clientApi(request, session.token);
      await verifierReglagesParDefaut(appel);
      const jeu = await preparer(appel, creerClient);
      const lignes = await parcourir(type.cle, 'défaut', jeu, connexion);
      verifierAucunMontant(lignes);
      await comparerAvecReference(lignes, `ecrans-${type.cle}.txt`);
    });
  }

  // Module Planning coupé (cadrage §6.3) : réglage posé en session SA, restauré dans un afterEach, qui s'exécute avec son
  // propre budget de temps, comme rentabilite-hierarchie.spec.ts:34-47. Seul moyen de tuer M08 (PlanningRoute qui ignore
  // le module), que menu.test.ts ne voit pas.
  test.describe('module Planning coupé', () => {
    let planningARestaurer = false;
    test.afterEach(async ({ request, session }) => {
      if (!planningARestaurer) return;
      const restauration = await request.put('/api/modules', { headers: { Authorization: `Bearer ${session.token}` }, data: { planningActif: true } });
      expect(restauration.ok(), `restauration de planningActif : ${await restauration.text()}`).toBeTruthy();
      planningARestaurer = false;
    });

    test('module Planning coupé : le conducteur perd l’entrée, la route et « Remettre à planifier », le super administrateur en est exempté', async ({ request, session, creerClient, connexion }) => {
      test.slow();
      await horsDuPassageDeMinuit();
      const appel = clientApi(request, session.token);
      await verifierReglagesParDefaut(appel);
      const jeu = await preparer(appel, creerClient);
      planningARestaurer = true;
      await appel('put', '/modules', { planningActif: false });
      expect((await appel('get', '/modules')).planningActifGlobal).toBe(false);
      const lignes: string[] = [];
      for (const cle of ['CT', 'SA']) lignes.push(...await parcourir(cle, 'planning coupé', jeu, connexion, SELECTION_COUPE));
      verifierAucunMontant(lignes);
      await comparerAvecReference(lignes, 'ecrans-planning-coupe.txt');
    });
  });

  // Couverture (cadrage §5, N10 du contrôle) : les routes sont relevées par `<Route path="…"`, et leur nombre comparé à
  // celui des balises `<Route\b` ; une route écrite autrement fait échouer le test.
  test('couverture : chaque route privée du client a sa ligne dans chaque référence de type, aucune référence ne nomme une route absente, et chaque entrée du menu mène à une route', () => {
    const { routes, balises } = routesDuClient();
    expect(balises, 'une balise <Route> écrite autrement que <Route path="…"> échapperait au relevé des routes').toBe(routes.length);
    expect(ROUTES_PUBLIQUES.filter((route) => !routes.includes(route)), 'route publique nommée absente de App.tsx').toEqual([]);
    const privees = routes.filter((route) => !ROUTES_PUBLIQUES.includes(route));
    const routesNommees = (lignes: string[], contexte?: string) => lignes.map((l) => l.split(SEPARATEUR))
      .filter((champs) => champs[1].startsWith('route ') && (!contexte || champs[3] === contexte)).map((champs) => champs[1].slice('route '.length));
    for (const type of TYPES) {
      const nommees = routesNommees(lireReference(`ecrans-${type.cle}.txt`), 'défaut');
      expect(privees.filter((route) => !nommees.includes(route)), `${type.cle} : route privée sans ligne dans ecrans-${type.cle}.txt`).toEqual([]);
    }
    const references = [...TYPES.map((t) => `ecrans-${t.cle}.txt`), 'ecrans-planning-coupe.txt'];
    expect(trier(readdirSync(DOSSIER_REFERENCES).filter((nom) => nom.endsWith('.txt'))), 'référence sans test, ou test sans référence').toEqual(trier(references));
    for (const nom of references) {
      expect(routesNommees(lireReference(nom)).filter((route) => !privees.includes(route)), `${nom} : route absente de App.tsx, ou publique`).toEqual([]);
    }
    const { entrees, occurrences } = entreesDuMenu();
    expect(occurrences, 'une entrée de lib/menu.ts écrite autrement que to: \'…\' échapperait au relevé').toBe(entrees.length);
    expect(entrees.filter((chemin) => !privees.includes(chemin)), 'entrée du menu qui ne mène à aucune route privée').toEqual([]);
  });

  // Témoins de la garde « aucun montant » (cadrage §5, T3 du contrôle) : un par branche, que lui seul déclenche ; les
  // témoins d'un montant passent d'abord par la normalisation, qui ne laisse aucun chiffre ; et une ligne propre.
  test('garde « aucun montant » : chaque branche a son témoin, qu’elle est seule à déclencher, et une ligne propre passe', () => {
    const normaliser = creerNormaliseur({ cibles: {}, comptes: {}, suffixe: '' });
    expect([normaliser('12,50'), normaliser('12.50'), normaliser('12 €'), normaliser('15 %')]).toEqual(['#,#', '#.#', '# €', '# %']);
    const temoins: [string, string, string[]][] = [
      ['« Semaine 45 », non normalisée', 'CT | planning | hors lignes | défaut | boutons : Semaine 45', ['chiffre']],
      ['« 12,50 », normalisée', `CT | devis | hors lignes | défaut | boutons : ${normaliser('12,50')}`, ['#,#']],
      ['« 12.50 », normalisée', `CT | devis | hors lignes | défaut | boutons : ${normaliser('12.50')}`, ['#,#']],
      ['« 12 € », normalisée', `CT | devis | hors lignes | défaut | boutons : ${normaliser('12 €')}`, ['€']],
      ['« 15 % », normalisée', `CT | devis | hors lignes | défaut | boutons : ${normaliser('15 %')}`, ['%']],
      ['ligne propre', 'CT | fiche chantier | chantier-en-cours | défaut | titre « Écrans en cours <s> » ; boutons : Modifier, Semaine #', []],
    ];
    for (const [nom, ligne, attendu] of temoins) expect(branchesMontant(ligne), nom).toEqual(attendu);
    expect(gardeAucunMontant(temoins.map(([, ligne]) => ligne)).length, 'la garde arrête chaque témoin d’un montant, et laisse passer la ligne propre').toBe(temoins.length - 1);
  });
});
