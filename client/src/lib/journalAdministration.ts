// Libellés du journal des paramètres et des droits (JournalAdministration.tsx), sortis du composant pour
// être testés sous tsx --test (lot 6b-2, N3) : pas d'import de roles.ts, qui charge api.ts et
// import.meta.env, mais de lib/droits.ts, où roleLabel est défini (V-N6).
import { roleLabel } from './droits';
import { LIBELLES_MODE_ENVOI } from './envoiMicrosoft365';

// Libellés des champs journalisés ; un champ absent de la liste garde son nom technique.
export const CHAMPS_JOURNAL: Record<string, string> = {
  role: 'Type de compte',
  estCommercial: 'Aussi commercial',
  accesFinance: 'Accès financier',
  permissions: 'Permissions',
  actif: 'Actif',
  responsableHierarchique: 'Responsable hiérarchique',
  ficheIntervenant: 'Fiche intervenant',
  margeCommercialeActive: 'Marge commerciale',
  tauxAcompteDefaut: 'Acompte par défaut (%)',
  seuilMargeFaible: 'Seuil de marge faible (%)',
  joursSansSaisie: 'Jours sans saisie',
  anticipationVisitesJours: 'Anticipation des visites (jours)',
  pasTempsPasseMinutes: 'Pas du temps passé (minutes)',
  tempsMinimumMinutes: 'Temps minimum facturé (minutes)',
  rentabiliteConducteur: 'Rentabilité : conducteur',
  rentabiliteHierarchie: 'Rentabilité : hiérarchie',
  rentabiliteDirecteurs: 'Rentabilité : directeurs',
  planningActif: 'Planning',
  // Mode d'envoi des documents (lot 6b-1b, C-N1 de #411).
  modeEnvoi: 'Mode d’envoi des documents',
  suiviAdministratif: 'Prime de suivi administratif',
  journalConservationJours: 'Conservation (jours)',
  logoDocuments: 'Logo des documents',
  estMainOeuvre: 'Main d’œuvre',
  reference: 'Référence',
  nom: 'Nom',
  description: 'Description',
  categorie: 'Catégorie',
  tauxTva: 'TVA (%)',
  prixVenteHt: 'Prix de vente HT à l’heure, hors contrat',
  prixJourHorsContratHt: 'Prix de vente HT au forfait jour, hors contrat',
  prixHeureSousContratHt: 'Prix de vente HT à l’heure, sous contrat',
  prixJourSousContratHt: 'Prix de vente HT au forfait jour, sous contrat',
  prixDemiJourneeHorsContratHt: 'Prix de vente HT à la demi-journée, hors contrat',
  prixDemiJourneeSousContratHt: 'Prix de vente HT à la demi-journée, sous contrat',
  heuresParJour: 'Heures par jour',
  unite: 'Unité',
  prixAchatHt: 'Prix d’achat HT',
  dureeIndicativeMin: 'Durée indicative (min)',
  mainOeuvre: 'Main d’œuvre',
};

// Valeur lisible d'un champ journalisé. Le type de compte et le mode d'envoi s'affichent par leur
// libellé (« Microsoft 365 », « Messagerie seule »), et non par leur code ; un code inconnu reste tel quel.
export function lisible(valeur: unknown, champ?: string): string {
  if (champ === 'role' && typeof valeur === 'string') return roleLabel(valeur);
  if (valeur === null || valeur === undefined || valeur === '') return '—';
  if (champ === 'modeEnvoi' && typeof valeur === 'string') return Object.hasOwn(LIBELLES_MODE_ENVOI, valeur) ? LIBELLES_MODE_ENVOI[valeur] : valeur;
  if (typeof valeur === 'boolean') return valeur ? 'oui' : 'non';
  if (Array.isArray(valeur)) return valeur.length ? valeur.map((v) => lisible(v)).join(', ') : 'aucune';
  if (typeof valeur === 'object') return JSON.stringify(valeur);
  return String(valeur);
}
