// Scénarios du relevé : les trois écrans à découper (docs/DECOUPAGE-ECRANS-CIBLE.md), chaque
// onglet, chaque modale et chaque section que les PR A, B et C déplacent, pour chaque type de
// compte concerné. Aucune action n'écrit : les modales sont ouvertes puis abandonnées
// (« Annuler », « Fermer »), les champs seulement modifiés quand cela change le rendu sans rien
// envoyer (saisie dans une édition en ligne, filtres, tri, choix d'une nature ou d'un type).
const main = (page) => page.locator('main');
const bouton = (page, name, rang = 0) => main(page).getByRole('button', { name, exact: true }).nth(rang);
const modale = (page) => main(page).locator('.fixed.inset-0').last();
const cliquer = (localisateur) => localisateur.click();
const choixParOption = (page, texte) => main(page).locator('select').filter({ has: page.locator('option', { hasText: texte }) });

const onglet = (nom) => ({ nom: `onglet-${nom}`, faire: (page) => cliquer(bouton(page, nom)) });
const ligneEnEdition = (page) => main(page).locator('tr').filter({ has: page.getByRole('button', { name: 'Enregistrer', exact: true }) });
const editionEnLigne = (nom) => [
  { nom: `${nom}-modifier`, faire: (page) => cliquer(bouton(page, 'Modifier')) },
  { nom: `${nom}-saisie`, faire: (page) => ligneEnEdition(page).locator('input').first().fill('Saisie du relevé') },
  { nom: `${nom}-annuler`, faire: (page) => cliquer(bouton(page, 'Annuler')) },
];
const fermerModale = { nom: 'fermer', faire: (page) => cliquer(modale(page).getByTitle('Fermer')) };
const formulaireCorrection = (page) => main(page).locator('form').filter({ has: page.locator('[name="motifCorrection"]') });
const ligneDeFile = (page, texte) => main(page).getByRole('region', { name: 'Interventions à planifier' }).getByRole('row').filter({ hasText: texte });

export function scenarios({ comptes, noms, chantiers, planning }) {
  const ficheA = `/chantiers/${chantiers.A}`;
  return [
    // Administration : les neuf onglets du super administrateur, l'édition en ligne des
    // référentiels, le formulaire d'autorisation et le choix d'un responsable hiérarchique ;
    // puis l'administrateur sans super administration, et le conducteur.
    { nom: 'admin', compte: comptes.superAdmin, url: '/admin', actions: [
      onglet('Intervenants'), ...editionEnLigne('intervenant'),
      onglet('Fournisseurs'), ...editionEnLigne('fournisseur'),
      onglet('Catégories'), ...editionEnLigne('categorie'),
      onglet('Marges & Commissions'),
      onglet('Utilisateurs'),
      { nom: 'role-administrateur', faire: (page) => main(page).locator('select[name="role"]').selectOption('ADMIN') },
      // Les options du choix du responsable ne sont construites qu'au focus.
      { nom: 'responsable-ouvert', faire: (page) => main(page).getByLabel(`Responsable hiérarchique de ${noms.technicien}`).focus() },
      { nom: 'responsable-desactive-ouvert', faire: (page) => main(page).getByLabel(`Responsable hiérarchique de ${noms.conducteur}`).focus() },
      onglet('Journal'),
      onglet('Société'),
      onglet('Modules'),
      onglet('Chantiers'),
    ] },
    // Seul profil où isAdmin et isSuper diffèrent : relever les référentiels y détecte une
    // inversion de ces deux indicateurs.
    { nom: 'admin-administrateur', compte: comptes.administrateur, url: '/admin', actions: [
      onglet('Intervenants'),
      onglet('Fournisseurs'),
      onglet('Utilisateurs'),
      onglet('Marges & Commissions'),
    ] },
    { nom: 'admin-conducteur', compte: comptes.conducteur, url: '/admin', actions: [onglet('Catégories')] },

    // Fiche chantier : administration (modale, corrections, filtres et tri des journaux,
    // choix du commercial en place), conducteur titulaire, technicien titulaire, chantiers
    // terminés en attente d'encaissement et encaissé.
    { nom: 'chantier-admin', compte: comptes.superAdmin, url: ficheA, actions: [
      { nom: 'modale-modifier', faire: (page) => cliquer(bouton(page, 'Modifier')) },
      { nom: 'modale-annuler', faire: (page) => cliquer(modale(page).getByRole('button', { name: 'Annuler', exact: true })) },
      { nom: 'corriger-achat', faire: (page) => cliquer(main(page).getByTitle('Corriger cet achat').first()) },
      { nom: 'corriger-achat-annuler', faire: (page) => cliquer(formulaireCorrection(page).getByRole('button', { name: 'Annuler', exact: true })) },
      { nom: 'corriger-pointage', faire: (page) => cliquer(main(page).getByTitle('Corriger ce pointage').first()) },
      { nom: 'corriger-pointage-annuler', faire: (page) => cliquer(formulaireCorrection(page).getByRole('button', { name: 'Annuler', exact: true })) },
      { nom: 'achats-recherche', faire: (page) => main(page).getByPlaceholder('Rechercher (description, n° de facture, fournisseur, montant...)').fill('F-') },
      { nom: 'achats-fournisseur', faire: (page) => choixParOption(page, 'Tous les fournisseurs').selectOption(noms.fournisseurA) },
      { nom: 'achats-categorie', faire: (page) => choixParOption(page, 'Toutes les catégories').selectOption(noms.categorieA) },
      { nom: 'achats-tri', faire: (page) => choixParOption(page, 'Montant décroissant').selectOption('montant-asc') },
      { nom: 'achats-reinitialiser', faire: (page) => cliquer(main(page).getByRole('button', { name: 'Réinitialiser', exact: true }).first()) },
      { nom: 'heures-recherche', faire: (page) => main(page).getByPlaceholder('Rechercher (intervenant, rôle, commentaire, date...)').fill('Pose') },
      { nom: 'heures-intervenant', faire: (page) => choixParOption(page, 'Tous les intervenants').selectOption(noms.intervenantA) },
      { nom: 'heures-role', faire: (page) => choixParOption(page, 'Tous les rôles').selectOption('TECHNICIEN') },
      { nom: 'heures-tri', faire: (page) => choixParOption(page, 'Heures décroissantes').selectOption('heures-desc') },
      // Le « Réinitialiser » des achats a disparu avec leurs filtres : reste celui des heures.
      { nom: 'heures-reinitialiser', faire: (page) => cliquer(main(page).getByRole('button', { name: 'Réinitialiser', exact: true }).last()) },
      // En dernier : le choix du commercial se referme dès qu'il perd le focus.
      { nom: 'commercial-en-place', faire: (page) => cliquer(bouton(page, 'Modifier', 1)) },
    ] },
    { nom: 'chantier-conducteur', compte: comptes.conducteur, url: ficheA, actions: [
      { nom: 'modale-modifier', faire: (page) => cliquer(bouton(page, 'Modifier')) },
    ] },
    { nom: 'chantier-technicien', compte: comptes.technicien, url: `/chantiers/${chantiers.B}`, actions: [] },
    { nom: 'chantier-termine-admin', compte: comptes.superAdmin, url: `/chantiers/${chantiers.C}`, actions: [] },
    { nom: 'chantier-termine-conducteur', compte: comptes.conducteur, url: `/chantiers/${chantiers.C}`, actions: [] },
    { nom: 'chantier-encaisse-admin', compte: comptes.superAdmin, url: `/chantiers/${chantiers.D}`, actions: [] },

    // Planning : grille, file et chaque modale et chaque branche de la modale d'affectation
    // pour l'administration ; consultation pour le conducteur et le technicien.
    { nom: 'planning-admin', compte: comptes.superAdmin, url: '/planning', actions: [
      { nom: 'nouvelle-affectation', faire: (page) => cliquer(bouton(page, 'Affectation')) },
      { nom: 'nouvelle-affectation-heures', faire: (page) => cliquer(modale(page).getByRole('button', { name: 'Heures précises', exact: true })) },
      { nom: 'nouvelle-affectation-evenement', faire: (page) => cliquer(modale(page).getByRole('button', { name: 'Événement', exact: true })) },
      { nom: 'nouveau-type', faire: (page) => modale(page).locator('select[name="typeEventId"]').selectOption('__new__') },
      fermerModale,
      { nom: 'modifier-affectation', faire: (page) => cliquer(main(page).getByText(planning.depannage).first()) },
      fermerModale,
      { nom: 'modifier-evenement', faire: (page) => cliquer(main(page).getByText(planning.formation).first()) },
      fermerModale,
      { nom: 'modifier-intervention', faire: (page) => cliquer(main(page).getByText(planning.planifiee).first()) },
      fermerModale,
      { nom: 'types', faire: (page) => cliquer(bouton(page, "Types d'événements")) },
      { nom: 'types-modifier', faire: (page) => cliquer(modale(page).getByRole('button', { name: 'Modifier', exact: true }).first()) },
      fermerModale,
      { nom: 'placer-visite', faire: (page) => cliquer(main(page).getByRole('region', { name: 'Interventions à planifier' }).getByRole('button', { name: 'Placer', exact: true }).first()) },
      { nom: 'placer-visite-annuler', faire: (page) => cliquer(main(page).getByRole('dialog').getByRole('button', { name: 'Annuler', exact: true })) },
      // La file affiche l'origine, pas le titre : une curative y est « SAV hors contrat ».
      { nom: 'placer-curative', faire: (page) => cliquer(ligneDeFile(page, 'SAV hors contrat').getByRole('button', { name: 'Placer', exact: true }).first()) },
      { nom: 'placer-curative-annuler', faire: (page) => cliquer(main(page).getByRole('dialog').getByRole('button', { name: 'Annuler', exact: true })) },
      { nom: 'partage', faire: (page) => cliquer(main(page).getByRole('button', { name: /^(Publier|Renouveler le lien|Partage désactivé)$/ }).first()) },
      fermerModale,
      { nom: 'semaine-suivante', faire: (page) => cliquer(main(page).getByTitle('Semaine suivante')) },
      { nom: 'cellule', faire: (page) => cliquer(main(page).locator('td[title="Cliquer pour ajouter une affectation"]').first()) },
      fermerModale,
    ] },
    { nom: 'planning-conducteur', compte: comptes.conducteur, url: '/planning', actions: [] },
    { nom: 'planning-technicien', compte: comptes.technicien, url: '/planning', actions: [] },
  ];
}
