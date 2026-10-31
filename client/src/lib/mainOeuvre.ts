// Main d'œuvre au catalogue (décisions de Nelson du 24-10-2026) : une prestation du catalogue par
// main d'œuvre, avec quatre PRIX DE VENTE (jamais des coûts : le coût reste le taux horaire chargé
// de l'intervenant) et son nombre d'heures par jour. Le prix de vente de la fiche est son prix à
// l'heure hors contrat (choix par défaut, à confirmer).

export type ChampPrixMainOeuvre = 'prixVenteHt' | 'prixJourHorsContratHt' | 'prixHeureSousContratHt' | 'prixJourSousContratHt';

// Libellés sans ambiguïté, repris par le formulaire, la fiche et le journal.
export const PRIX_MAIN_OEUVRE: ReadonlyArray<{ cle: ChampPrixMainOeuvre; libelle: string }> = [
  { cle: 'prixVenteHt', libelle: 'Prix de vente HT à l’heure, hors contrat' },
  { cle: 'prixJourHorsContratHt', libelle: 'Prix de vente HT au forfait jour, hors contrat' },
  { cle: 'prixHeureSousContratHt', libelle: 'Prix de vente HT à l’heure, sous contrat' },
  { cle: 'prixJourSousContratHt', libelle: 'Prix de vente HT au forfait jour, sous contrat' },
];
export const LIBELLE_HEURES_PAR_JOUR = 'Heures par jour (forfait jour)';

// Prix de la demi-journée (lot « budget et heures prévues du chantier », réponse de Nelson du 30-10-2026,
// « Prix à part ») : deux prix de vente de plus, facultatifs (choix par défaut, à confirmer) ; vides, la main
// d'œuvre ne se vend pas à la demi-journée au devis.
export type ChampPrixDemiJournee = 'prixDemiJourneeHorsContratHt' | 'prixDemiJourneeSousContratHt';
export const PRIX_DEMI_JOURNEE: ReadonlyArray<{ cle: ChampPrixDemiJournee; libelle: string }> = [
  { cle: 'prixDemiJourneeHorsContratHt', libelle: 'Prix de vente HT à la demi-journée, hors contrat' },
  { cle: 'prixDemiJourneeSousContratHt', libelle: 'Prix de vente HT à la demi-journée, sous contrat' },
];
export const AIDE_PRIX_DEMI_JOURNEE = 'Prix de la demi-journée : facultatifs ; laissés vides, cette main d’œuvre ne se vend pas à la demi-journée sur un devis.';

export type MainOeuvre = {
  id: string;
  reference: string;
  nom: string;
  description: string | null;
  categorieId: string | null;
  categorie?: { nom: string } | null;
  tauxTva: number;
  prixVenteHt: number;
  prixJourHorsContratHt: number;
  prixHeureSousContratHt: number;
  prixJourSousContratHt: number;
  prixDemiJourneeHorsContratHt: number | null;
  prixDemiJourneeSousContratHt: number | null;
  heuresParJour: number;
  actif: boolean;
  estMainOeuvre: true;
};

// Résumé joint à une fiche intervenant (administration seulement).
export type MainOeuvreResumee = { id: string; reference: string; nom: string; actif: boolean };

// Montant au centime, virgule décimale : « 45,50 € ».
export const formatEuros = (montant: number) => `${Number(montant).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

// Prix facultatif (demi-journée) : le montant, ou « Non réglé ».
export const formatPrixFacultatif = (montant: number | null | undefined) => (montant == null ? 'Non réglé' : formatEuros(montant));

// Heures au quart d'heure, sans zéro inutile : « 7 h », « 7,5 h », « 7,75 h ».
export const formatHeures = (heures: number) => `${String(Number(heures)).replace('.', ',')} h`;

// Valeur d'un champ de saisie : la virgule décimale française, comme l'écrit l'utilisateur.
export const valeurSaisie = (nombre: number | null | undefined) => (nombre == null ? '' : String(nombre).replace('.', ','));

export const libelleMainOeuvre = (mainOeuvre: MainOeuvreResumee) => `${mainOeuvre.reference} · ${mainOeuvre.nom}${mainOeuvre.actif ? '' : ' (désactivée)'}`;

// Mains d'œuvre proposées pour le rattachement d'un intervenant : les actives, triées par nom, et la
// sienne si elle a été désactivée depuis (un rattachement existant est gardé et affiché comme tel ;
// le serveur refuse d'en créer un vers une main d'œuvre désactivée).
export function mainsOeuvreProposees(mainsOeuvre: MainOeuvreResumee[], actuelle: MainOeuvreResumee | null): MainOeuvreResumee[] {
  const actives = mainsOeuvre.filter((m) => m.actif).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  if (actuelle && !actives.some((m) => m.id === actuelle.id)) return [...actives, actuelle];
  return actives;
}
