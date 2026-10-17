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
};

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

// Corps envoyé à l'API. Le prix d'achat prévu n'est transmis que par qui l'écrit : sinon, le
// serveur conserve celui de la ligne existante (ou reprend celui de la fiche) et refuserait
// toute valeur reçue. La référence n'est jamais envoyée : le serveur la recopie de la fiche.
export function ligneAEnvoyer(ligne: LigneDevisSaisie, ecritPrixAchat: boolean) {
  const prixAchat = (ligne.prixAchatUnitaireHt ?? '').trim();
  return {
    ...(ligne.ligneId ? { ligneId: ligne.ligneId } : {}),
    designation: ligne.designation,
    nature: ligne.nature,
    quantite: ligne.quantite,
    prixUnitaireHt: ligne.prixUnitaireHt,
    tauxTva: ligne.tauxTva,
    unite: ligne.unite?.trim() ? ligne.unite.trim() : null,
    ...(ligne.catalogueFamille && ligne.catalogueId ? { catalogueFamille: ligne.catalogueFamille, catalogueId: ligne.catalogueId } : {}),
    ...(ecritPrixAchat ? { prixAchatUnitaireHt: prixAchat === '' ? null : prixAchat } : {}),
  };
}

// Ligne existante d'un devis remise en édition : son identifiant permet au serveur de garder
// sa fiche d'origine, sa référence et son prix d'achat prévu.
export function ligneEnEdition(ligne: {
  id: string; designation: string; nature: NatureLigneDevis; quantite: number; prixUnitaireHt: number; tauxTva: number;
  unite?: string | null; reference?: string | null; catalogueFamille?: FamilleCatalogue | null; catalogueId?: string | null; prixAchatUnitaireHt?: number | null;
}, voitPrixAchat: boolean): LigneDevisSaisie {
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
