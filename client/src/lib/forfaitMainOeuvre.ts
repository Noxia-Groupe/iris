// Ligne de main d'œuvre au jour ou à la demi-journée (lot « budget et heures prévues du chantier », troisième
// PR ; réponses de Nelson du 30-10-2026, « Option de la main d'œuvre » et « Prix à part ») : une main d'œuvre
// du catalogue, au forfait jour ou à la demi-journée, hors contrat ou sous contrat ; le prix est celui de la
// fiche, fixé par le serveur et figé sur la ligne, la quantité se compte en jours ou en demi-journées. Le
// serveur refuse tout autre prix : l'écran envoie le prix qu'il affiche, si bien que ce qui est enregistré est
// ce que l'utilisateur a vu. Les heures prévues de la ligne (heures par jour de la main d'œuvre, ou leur
// moitié, par unité) sont copiées par le serveur seul ; l'écran n'en connaît que le total du devis.
import type { FicheCatalogueDevis, LigneDevisSaisie } from './catalogueDevis';

export type ForfaitMainOeuvre = 'JOUR' | 'DEMI_JOURNEE';
export type TarifForfait = 'HORS_CONTRAT' | 'SOUS_CONTRAT';
export const FORFAITS: readonly ForfaitMainOeuvre[] = ['JOUR', 'DEMI_JOURNEE'];
export const TARIFS_FORFAIT: readonly TarifForfait[] = ['HORS_CONTRAT', 'SOUS_CONTRAT'];
export const LIBELLES_FORFAIT: Record<ForfaitMainOeuvre, string> = { JOUR: 'Au jour', DEMI_JOURNEE: 'À la demi-journée' };
export const LIBELLES_TARIF_FORFAIT: Record<TarifForfait, string> = { HORS_CONTRAT: 'Hors contrat', SOUS_CONTRAT: 'Sous contrat' };
// Unité de la ligne, la même que celle que le serveur copie (server/src/domaines/devis/forfaitMainOeuvre.ts).
export const UNITES_FORFAIT: Record<ForfaitMainOeuvre, string> = { JOUR: 'jour', DEMI_JOURNEE: 'demi-journée' };
// Libellé de la quantité, au pluriel : la ligne se compte en jours ou en demi-journées.
export const LIBELLES_QUANTITE_FORFAIT: Record<ForfaitMainOeuvre, string> = { JOUR: 'Jours', DEMI_JOURNEE: 'Demi-journées' };
export const REFUS_FORFAIT_TEMPS_PASSE = 'Un devis au temps passé ne porte pas de ligne au jour ou à la demi-journée : retirez-la, ou décochez « Devis au temps passé ».';
// Quantité entière, au moins 1 (choix par défaut, le plus restrictif, à confirmer : lecture de « Prix à part »
// et de « Un forfait compte pour un forfait ») ; même message que le serveur, qui refuse les mêmes cas.
export const REFUS_QUANTITE_FORFAIT = 'La quantité d’une ligne au jour ou à la demi-journée est un nombre entier de jours ou de demi-journées, au moins 1 : pour une demi-journée, ajoutez une ligne à la demi-journée.';

// Prix de vente de la fiche pour ce forfait et ce tarif : forfait jour, ou prix de la demi-journée. Null si la
// fiche n'est pas une main d'œuvre, ou si ce prix n'est pas réglé (une demi-journée sans prix ne se vend pas).
export function prixDuForfait(fiche: FicheCatalogueDevis, forfait: ForfaitMainOeuvre, tarif: TarifForfait): number | null {
  if (!fiche.estMainOeuvre) return null;
  const prix = forfait === 'JOUR'
    ? (tarif === 'SOUS_CONTRAT' ? fiche.prixJourSousContratHt : fiche.prixJourHorsContratHt)
    : (tarif === 'SOUS_CONTRAT' ? fiche.prixDemiJourneeSousContratHt : fiche.prixDemiJourneeHorsContratHt);
  return prix ?? null;
}

// Nouvelle ligne au forfait, d'une unité, au prix de la fiche ; null si ce prix n'existe pas.
export function ligneForfait(fiche: FicheCatalogueDevis, forfait: ForfaitMainOeuvre, tarif: TarifForfait): LigneDevisSaisie | null {
  const prix = prixDuForfait(fiche, forfait, tarif);
  if (prix === null) return null;
  return {
    forfaitMainOeuvre: forfait, tarifForfait: tarif,
    designation: `${fiche.nom} — ${forfait === 'JOUR' ? 'au jour' : 'à la demi-journée'}, ${tarif === 'SOUS_CONTRAT' ? 'sous contrat' : 'hors contrat'}`,
    nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: prix, tauxTva: fiche.tauxTva, unite: UNITES_FORFAIT[forfait],
    reference: fiche.reference, catalogueFamille: 'prestations', catalogueId: fiche.id,
  };
}

// Pas de ligne au forfait sur un devis au temps passé, et une quantité entière, au moins 1, sur chaque ligne au
// forfait (le serveur refuse les mêmes cas).
export function erreurForfait(auTempsPasse: boolean, lignes: LigneDevisSaisie[]): string | null {
  const forfaits = lignes.filter((ligne) => ligne.forfaitMainOeuvre);
  if (auTempsPasse && forfaits.length) return REFUS_FORFAIT_TEMPS_PASSE;
  return forfaits.some((ligne) => !Number.isInteger(Number(ligne.quantite)) || Number(ligne.quantite) < 1) ? REFUS_QUANTITE_FORFAIT : null;
}
