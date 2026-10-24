import express from 'express';
import { prisma } from '../../db';
import { voitPrixAchatDevis } from '../../droits/visibilite';

// --- Catalogue natif Iris ---
// Trois familles partagent la même forme (référence, nom, prix, TVA, catégorie) et sont
// donc servies par les mêmes routes, la famille étant un paramètre d'URL.
//
// Le typage passe par `Prisma.CataloguePrestationDelegate` volontairement élargi : les
// trois délégués Prisma ont des signatures génériques DIFFÉRENTES, si bien qu'une union
// des trois n'est plus appelable (TS2349 — « none of those signatures are compatible with
// each other »). On fixe donc UN type de délégué de référence pour la table de routage ;
// les champs propres à chaque famille (durée, stock, fabricant) sont ajoutés ensuite par
// `catalogueExtraPayload` et validés à l'exécution.
export type CatalogueFamily = 'prestations' | 'articles' | 'equipements';
type CatalogueDelegate = typeof prisma.cataloguePrestation;
export const catalogueModels: Record<CatalogueFamily, CatalogueDelegate> = {
  prestations: prisma.cataloguePrestation,
  articles: prisma.catalogueArticle as unknown as CatalogueDelegate,
  equipements: prisma.catalogueEquipement as unknown as CatalogueDelegate,
};

export function catalogueFamily(value: string): CatalogueFamily | null {
  return value === 'prestations' || value === 'articles' || value === 'equipements' ? value : null;
}

// Nombre positif obligatoire : `Number('')` vaut 0 et `Number('abc')` vaut NaN, on refuse
// donc explicitement tout ce qui n'est pas un nombre fini positif (prix, TVA, stock).
function catalogueNombre(value: unknown, champ: string, defaut = 0): number {
  const n = Number(value ?? defaut);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${champ} invalide.`);
  return n;
}

// Prix d'achat facultatif : un champ laissé vide reste ABSENT. `Number('')` vaudrait 0, soit
// un achat gratuit, que la ligne de devis reprendrait ensuite comme prix d'achat prévu.
function cataloguePrixAchat(value: unknown): number | null {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '') ? null : catalogueNombre(value, "Prix d'achat");
}

// Champs communs aux trois familles et aux mains d'œuvre : référence, nom, description,
// catégorie, TVA.
export function champsCommunsCatalogue(body: Record<string, unknown>) {
  const reference = String(body.reference || '').trim();
  const nom = String(body.nom || '').trim();
  if (!reference || !nom || reference.length > 80 || nom.length > 200) {
    throw new Error('Référence et nom sont obligatoires.');
  }
  return {
    reference,
    nom,
    description: body.description ? String(body.description).trim() : null,
    categorieId: body.categorieId ? String(body.categorieId) : null,
    tauxTva: catalogueNombre(body.tauxTva, 'TVA', 20),
  };
}

// Champs communs aux trois familles, prix de vente compris. Celui d'une main d'œuvre suit la
// règle plus stricte de ses quatre prix (cf. main-oeuvre.ts).
export function cataloguePayload(body: Record<string, unknown>) {
  return {
    ...champsCommunsCatalogue(body),
    prixVenteHt: catalogueNombre(body.prixVenteHt, 'Prix de vente'),
  };
}

// Champs propres à une famille : une prestation a une durée, un article un stock, un
// équipement un fabricant (il devient un EquipementInstalle une fois posé chez un client).
export function catalogueExtraPayload(family: CatalogueFamily, body: Record<string, unknown>) {
  if (family === 'prestations') {
    return {
      unite: String(body.unite || 'unité'),
      dureeIndicativeMin: body.dureeIndicativeMin == null ? null : catalogueNombre(body.dureeIndicativeMin, 'Durée indicative'),
      prixAchatHt: cataloguePrixAchat(body.prixAchatHt),
    };
  }
  if (family === 'articles') {
    return {
      unite: String(body.unite || 'unité'),
      prixAchatHt: cataloguePrixAchat(body.prixAchatHt),
      stockSuivi: !!body.stockSuivi,
      stockActuel: catalogueNombre(body.stockActuel, 'Stock'),
    };
  }
  return { fabricant: body.fabricant ? String(body.fabricant).trim() : null, prixAchatHt: cataloguePrixAchat(body.prixAchatHt) };
}

// Le prix d'achat d'une fiche suit la règle du prix d'achat prévu des devis (voitPrixAchatDevis) :
// une clé d'intégration ne le lit qu'avec finances:read. Sinon, une clé catalogue:read retrouverait
// par la fiche le prix d'achat recopié dans une ligne de devis qu'elle lit (catalogueId).
export function ficheCataloguePourLecteur<T>(req: express.Request, valeur: T): T {
  if (voitPrixAchatDevis(req)) return valeur;
  const masquer = (fiche: unknown) => {
    if (!fiche || typeof fiche !== 'object') return fiche;
    const { prixAchatHt: _masque, ...reste } = fiche as Record<string, unknown>;
    return reste;
  };
  return (Array.isArray(valeur) ? valeur.map(masquer) : masquer(valeur)) as T;
}
