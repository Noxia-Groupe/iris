// Catalogue dans les devis (lot pilote 2, décision A8 du 16-10-2026) : une fiche du catalogue
// devient une ligne COPIÉE du devis. Le serveur recopie la référence et, pour qui n'écrit pas
// le prix d'achat prévu, celui de la fiche ; l'écran pré-remplit le reste, modifiable tant que
// le devis n'est pas signé.

export type NatureLigneDevis = 'MAIN_OEUVRE' | 'FOURNITURE';
export type FamilleCatalogue = 'prestations' | 'articles' | 'equipements';

export type FicheCatalogueDevis = {
  famille: FamilleCatalogue;
  id: string;
  reference: string;
  nom: string;
  unite: string | null;
  nature: NatureLigneDevis;
  prixVenteHt: number;
  tauxTva: number;
  // Présent seulement pour qui voit le prix d'achat prévu (administration).
  prixAchatHt?: number | null;
  // Main d'œuvre : son drapeau et son prix à l'heure sous contrat (devis au temps passé), ses forfaits jour
  // et ses prix de la demi-journée, vides si non réglés (ligne au jour ou à la demi-journée) ; jamais ses
  // heures par jour.
  estMainOeuvre?: true;
  prixHeureSousContratHt?: number;
  prixJourHorsContratHt?: number;
  prixJourSousContratHt?: number;
  prixDemiJourneeHorsContratHt?: number | null;
  prixDemiJourneeSousContratHt?: number | null;
};

export type LigneDevisSaisie = {
  ligneId?: string;
  designation: string;
  nature: NatureLigneDevis;
  quantite: number;
  prixUnitaireHt: number;
  tauxTva: number;
  unite?: string | null;
  reference?: string | null;
  catalogueFamille?: FamilleCatalogue | null;
  catalogueId?: string | null;
  // Saisie libre de l'administrateur (« 12,50 ») ; vide = pas de prix d'achat prévu.
  prixAchatUnitaireHt?: string;
  // Ligne « main d'œuvre au temps passé » d'un devis au temps passé : son tarif (cf. ./tempsPasse.ts).
  tempsPasse?: boolean;
  tarifTempsPasse?: 'HORS_CONTRAT' | 'SOUS_CONTRAT' | null;
  // Ligne de main d'œuvre au jour ou à la demi-journée : son forfait et son tarif (cf. ./forfaitMainOeuvre.ts).
  forfaitMainOeuvre?: 'JOUR' | 'DEMI_JOURNEE' | null;
  tarifForfait?: 'HORS_CONTRAT' | 'SOUS_CONTRAT' | null;
};

// Total des heures prévues d'un devis (lot « budget et heures prévues du chantier ») : calculé par le
// serveur, affiché à l'écran du devis seulement, jamais sur le PDF (réponse « Écran seulement »).
export const formatHeuresPrevues = (heures: number) => `${Number(heures).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} h`;

export const LIBELLES_FAMILLES: Record<FamilleCatalogue, string> = {
  prestations: 'Prestation',
  articles: 'Article',
  equipements: 'Équipement',
};

export function ligneDepuisCatalogue(fiche: FicheCatalogueDevis, voitPrixAchat: boolean): LigneDevisSaisie {
  return {
    designation: fiche.nom,
    nature: fiche.nature,
    quantite: 1,
    prixUnitaireHt: fiche.prixVenteHt,
    tauxTva: fiche.tauxTva,
    unite: fiche.unite,
    reference: fiche.reference,
    catalogueFamille: fiche.famille,
    catalogueId: fiche.id,
    ...(voitPrixAchat ? { prixAchatUnitaireHt: fiche.prixAchatHt == null ? '' : String(fiche.prixAchatHt).replace('.', ',') } : {}),
  };
}

// Une ligne encore vierge (désignation vide, prix nul) : remplacée plutôt que suivie par la
// première fiche ajoutée.
export function ligneVierge(ligne: LigneDevisSaisie): boolean {
  return !ligne.designation.trim() && !ligne.ligneId && !ligne.catalogueId && Number(ligne.prixUnitaireHt) === 0;
}

// Corps envoyé à l'API. Le prix d'achat prévu n'est transmis que par qui l'écrit, et seulement
// si la ligne le porte (champ affiché) : sinon, le serveur conserve celui de la ligne existante
// (ou reprend celui de la fiche), et refuserait toute valeur reçue d'un autre compte. Une ligne
// chargée sans ce champ (droits relus en cours d'édition) ne l'efface donc pas. La référence
// n'est jamais envoyée : le serveur la recopie de la fiche.
export function ligneAEnvoyer(ligne: LigneDevisSaisie, ecritPrixAchat: boolean) {
  const prixAchat = (ligne.prixAchatUnitaireHt ?? '').trim();
  // Ligne au temps passé : le serveur fixe son prix, sa TVA, son unité et sa nature depuis la main
  // d'œuvre ; l'écran envoie le prix et la TVA qu'il affiche, que le serveur refuse s'ils ne sont plus
  // les siens. Jamais de prix d'achat prévu.
  if (ligne.tempsPasse) {
    return {
      ...(ligne.ligneId ? { ligneId: ligne.ligneId } : {}),
      tempsPasse: true,
      designation: ligne.designation,
      quantite: ligne.quantite,
      prixUnitaireHt: ligne.prixUnitaireHt,
      tauxTva: ligne.tauxTva,
      tarifTempsPasse: ligne.tarifTempsPasse ?? null,
      ...(ligne.catalogueId ? { catalogueFamille: 'prestations' as const, catalogueId: ligne.catalogueId } : {}),
    };
  }
  // Ligne au jour ou à la demi-journée : de même, le serveur fixe son prix, sa TVA, son unité et sa nature
  // depuis la main d'œuvre et refuse un prix ou une TVA qui ne sont plus les siens. Jamais de prix d'achat
  // prévu ; une ligne existante envoie son forfait et son tarif, qui ne changent pas.
  if (ligne.forfaitMainOeuvre) {
    return {
      ...(ligne.ligneId ? { ligneId: ligne.ligneId } : {}),
      forfaitMainOeuvre: ligne.forfaitMainOeuvre,
      tarifForfait: ligne.tarifForfait ?? null,
      designation: ligne.designation,
      nature: 'MAIN_OEUVRE' as const,
      quantite: ligne.quantite,
      prixUnitaireHt: ligne.prixUnitaireHt,
      tauxTva: ligne.tauxTva,
      ...(ligne.catalogueId ? { catalogueFamille: 'prestations' as const, catalogueId: ligne.catalogueId } : {}),
    };
  }
  return {
    ...(ligne.ligneId ? { ligneId: ligne.ligneId } : {}),
    designation: ligne.designation,
    nature: ligne.nature,
    quantite: ligne.quantite,
    prixUnitaireHt: ligne.prixUnitaireHt,
    tauxTva: ligne.tauxTva,
    unite: ligne.unite?.trim() ? ligne.unite.trim() : null,
    ...(ligne.catalogueFamille && ligne.catalogueId ? { catalogueFamille: ligne.catalogueFamille, catalogueId: ligne.catalogueId } : {}),
    ...(ecritPrixAchat && ligne.prixAchatUnitaireHt !== undefined ? { prixAchatUnitaireHt: prixAchat === '' ? null : prixAchat } : {}),
  };
}

// Ligne existante d'un devis remise en édition : son identifiant permet au serveur de garder
// sa fiche d'origine, sa référence et son prix d'achat prévu.
export function ligneEnEdition(ligne: {
  id: string; designation: string; nature: NatureLigneDevis; quantite: number; prixUnitaireHt: number; tauxTva: number;
  unite?: string | null; reference?: string | null; catalogueFamille?: FamilleCatalogue | null; catalogueId?: string | null; prixAchatUnitaireHt?: number | null;
  tempsPasse?: boolean; tarifTempsPasse?: 'HORS_CONTRAT' | 'SOUS_CONTRAT' | null;
  forfaitMainOeuvre?: 'JOUR' | 'DEMI_JOURNEE' | null; tarifForfait?: 'HORS_CONTRAT' | 'SOUS_CONTRAT' | null;
}, voitPrixAchat: boolean): LigneDevisSaisie {
  if (ligne.tempsPasse) {
    return {
      ligneId: ligne.id, tempsPasse: true, tarifTempsPasse: ligne.tarifTempsPasse ?? null,
      designation: ligne.designation, nature: ligne.nature, quantite: ligne.quantite, prixUnitaireHt: ligne.prixUnitaireHt, tauxTva: ligne.tauxTva,
      unite: ligne.unite ?? null, reference: ligne.reference ?? null, catalogueFamille: ligne.catalogueFamille ?? null, catalogueId: ligne.catalogueId ?? null,
    };
  }
  // Ligne au jour ou à la demi-journée : jamais de prix d'achat prévu, même pour l'administration.
  if (ligne.forfaitMainOeuvre) {
    return {
      ligneId: ligne.id, forfaitMainOeuvre: ligne.forfaitMainOeuvre, tarifForfait: ligne.tarifForfait ?? null,
      designation: ligne.designation, nature: ligne.nature, quantite: ligne.quantite, prixUnitaireHt: ligne.prixUnitaireHt, tauxTva: ligne.tauxTva,
      unite: ligne.unite ?? null, reference: ligne.reference ?? null, catalogueFamille: ligne.catalogueFamille ?? null, catalogueId: ligne.catalogueId ?? null,
    };
  }
  return {
    ligneId: ligne.id,
    designation: ligne.designation,
    nature: ligne.nature,
    quantite: ligne.quantite,
    prixUnitaireHt: ligne.prixUnitaireHt,
    tauxTva: ligne.tauxTva,
    unite: ligne.unite ?? null,
    reference: ligne.reference ?? null,
    catalogueFamille: ligne.catalogueFamille ?? null,
    catalogueId: ligne.catalogueId ?? null,
    ...(voitPrixAchat ? { prixAchatUnitaireHt: ligne.prixAchatUnitaireHt == null ? '' : String(ligne.prixAchatUnitaireHt).replace('.', ',') } : {}),
  };
}
