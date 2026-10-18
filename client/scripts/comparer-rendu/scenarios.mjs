// Scénarios du relevé : les trois écrans à découper (docs/DECOUPAGE-ECRANS-CIBLE.md), chaque
// onglet et chaque modale, pour chaque type de compte concerné. Aucune action n'écrit : les
// modales sont ouvertes puis abandonnées (« Annuler », « Fermer »), les champs seulement
// modifiés quand cela change le rendu sans rien envoyer.
const main = (page) => page.locator('main');
const bouton = (page, name, rang = 0) => main(page).getByRole('button', { name, exact: true }).nth(rang);
const modale = (page) => main(page).locator('.fixed.inset-0').last();
const cliquer = (localisateur) => localisateur.click();

const onglet = (nom) => ({ nom: `onglet-${nom}`, faire: (page) => cliquer(bouton(page, nom)) });
const editionEnLigne = (nom) => [
  { nom: `${nom}-modifier`, faire: (page) => cliquer(bouton(page, 'Modifier')) },
  { nom: `${nom}-annuler`, faire: (page) => cliquer(bouton(page, 'Annuler')) },
];
const fermerModale = { nom: 'fermer', faire: (page) => cliquer(modale(page).getByTitle('Fermer')) };
const formulaireCorrection = (page) => main(page).locator('form').filter({ has: page.locator('[name="motifCorrection"]') });

export function scenarios({ comptes, chantiers, planning }) {
  const ficheA = `/chantiers/${chantiers.A}`;
  return [
    // Administration : les neuf onglets du super administrateur, puis la vue du conducteur.
    { nom: 'admin', compte: comptes.superAdmin, url: '/admin', actions: [
      onglet('Intervenants'), ...editionEnLigne('intervenant'),
      onglet('Fournisseurs'), ...editionEnLigne('fournisseur'),
      onglet('Catégories'), ...editionEnLigne('categorie'),
      onglet('Marges & Commissions'),
      onglet('Utilisateurs'),
      { nom: 'role-administrateur', faire: (page) => main(page).locator('select[name="role"]').selectOption('ADMIN') },
      onglet('Journal'),
      onglet('Société'),
      onglet('Modules'),
      onglet('Chantiers'),
    ] },
    { nom: 'admin-conducteur', compte: comptes.conducteur, url: '/admin', actions: [onglet('Catégories')] },

    // Fiche chantier : administration (modale, corrections, commercial en place), conducteur
    // titulaire et technicien titulaire.
    { nom: 'chantier-admin', compte: comptes.superAdmin, url: ficheA, actions: [
      { nom: 'modale-modifier', faire: (page) => cliquer(bouton(page, 'Modifier')) },
      { nom: 'modale-annuler', faire: (page) => cliquer(modale(page).getByRole('button', { name: 'Annuler', exact: true })) },
      { nom: 'corriger-achat', faire: (page) => cliquer(main(page).getByTitle('Corriger cet achat').first()) },
      { nom: 'corriger-achat-annuler', faire: (page) => cliquer(formulaireCorrection(page).getByRole('button', { name: 'Annuler', exact: true })) },
      { nom: 'corriger-pointage', faire: (page) => cliquer(main(page).getByTitle('Corriger ce pointage').first()) },
      { nom: 'corriger-pointage-annuler', faire: (page) => cliquer(formulaireCorrection(page).getByRole('button', { name: 'Annuler', exact: true })) },
      // En dernier : le choix du commercial se referme dès qu'il perd le focus.
      { nom: 'commercial-en-place', faire: (page) => cliquer(bouton(page, 'Modifier', 1)) },
    ] },
    { nom: 'chantier-conducteur', compte: comptes.conducteur, url: ficheA, actions: [
      { nom: 'modale-modifier', faire: (page) => cliquer(bouton(page, 'Modifier')) },
    ] },
    { nom: 'chantier-technicien', compte: comptes.technicien, url: `/chantiers/${chantiers.B}`, actions: [] },

    // Planning : grille, file et chaque modale pour l'administration ; consultation pour le
    // conducteur et le technicien.
    { nom: 'planning-admin', compte: comptes.superAdmin, url: '/planning', actions: [
      { nom: 'nouvelle-affectation', faire: (page) => cliquer(bouton(page, 'Affectation')) },
      { nom: 'nouvelle-affectation-heures', faire: (page) => cliquer(modale(page).getByRole('button', { name: 'Heures précises', exact: true })) },
      fermerModale,
      { nom: 'modifier-affectation', faire: (page) => cliquer(main(page).getByText(planning.depannage).first()) },
      fermerModale,
      { nom: 'types', faire: (page) => cliquer(bouton(page, "Types d'événements")) },
      { nom: 'types-modifier', faire: (page) => cliquer(modale(page).getByRole('button', { name: 'Modifier', exact: true }).first()) },
      fermerModale,
      { nom: 'placer', faire: (page) => cliquer(main(page).getByRole('region', { name: 'Interventions à planifier' }).getByRole('button', { name: 'Placer', exact: true }).first()) },
      { nom: 'placer-annuler', faire: (page) => cliquer(main(page).getByRole('dialog').getByRole('button', { name: 'Annuler', exact: true })) },
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
