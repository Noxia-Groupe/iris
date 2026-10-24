import express from 'express';
import type { Express } from 'express';
import { prisma } from '../../db';
import { paramId } from '../../http/requete';
import { routeMixte } from '../../http/routes-mixtes';
import { decimalToNumber } from '../../commun/montants';
import { catalogueModels, catalogueFamily, cataloguePayload, catalogueExtraPayload, ficheCataloguePourLecteur } from './metier';
import { RefusCatalogue, creerPrestation, desactiverPrestation, modifierPrestation } from './main-oeuvre';

// Erreur catalogue : refus métier avec son statut (main d'œuvre : clé d'intégration 403, fiche
// introuvable 404, rattachements 409), 409 sur une référence déjà prise (contrainte unique Prisma
// P2002), 400 sur une saisie refusée par la validation, 500 sinon.
function catalogueApiError(res: express.Response, error: unknown) {
  if (error instanceof RefusCatalogue) return res.status(error.statut).json({ error: error.message });
  if ((error as { code?: string })?.code === 'P2002') {
    return res.status(409).json({ error: 'Cette référence catalogue est déjà utilisée.' });
  }
  if (error instanceof Error && !(error as { code?: string }).code) {
    return res.status(400).json({ error: error.message });
  }
  return res.status(500).json({ error: 'Opération catalogue impossible.' });
}

const listerCategoriesCatalogue: express.RequestHandler = async (_req, res) => {
  try {
    res.json(await prisma.catalogueCategorie.findMany({ orderBy: { nom: 'asc' } }));
  } catch {
    res.status(500).json({ error: 'Error fetching catalogue categories' });
  }
};

const creerCategorieCatalogue: express.RequestHandler = async (req, res) => {
  const nom = String(req.body?.nom || '').trim();
  if (!nom || nom.length > 100) return res.status(400).json({ error: 'Nom de catégorie requis.' });
  try {
    res.status(201).json(await prisma.catalogueCategorie.create({
      data: {
        nom,
        description: req.body?.description ? String(req.body.description).trim() : null,
        parentId: req.body?.parentId ? String(req.body.parentId) : null,
      },
    }));
  } catch {
    res.status(409).json({ error: 'Cette catégorie existe déjà ou sa catégorie parente est invalide.' });
  }
};

const listerCatalogue: express.RequestHandler = async (req, res) => {
  const family = catalogueFamily(String(req.params.family));
  if (!family) return res.status(404).json({ error: 'Famille catalogue inconnue.' });
  try {
    res.json(ficheCataloguePourLecteur(req, decimalToNumber(await catalogueModels[family].findMany({
      include: { categorie: true },
      orderBy: { nom: 'asc' },
    }))));
  } catch {
    res.status(500).json({ error: 'Error fetching catalogue' });
  }
};

const creerFicheCatalogue: express.RequestHandler = async (req, res) => {
  const family = catalogueFamily(String(req.params.family));
  if (!family) return res.status(404).json({ error: 'Famille catalogue inconnue.' });
  try {
    // Une prestation peut être une main d'œuvre (lot « main d'œuvre au catalogue ») : règles,
    // droits et journal propres dans main-oeuvre.ts.
    if (family === 'prestations') return res.status(201).json(ficheCataloguePourLecteur(req, decimalToNumber(await creerPrestation(req))));
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.estMainOeuvre !== undefined && body.estMainOeuvre !== null && body.estMainOeuvre !== false) throw new Error('Seule une prestation peut être une main d’œuvre.');
    const data = { ...cataloguePayload(body), ...catalogueExtraPayload(family, body) };
    res.status(201).json(ficheCataloguePourLecteur(req, decimalToNumber(await catalogueModels[family].create({
      data: data as never,
      include: { categorie: true },
    }))));
  } catch (error) {
    catalogueApiError(res, error);
  }
};

// Modification d'une fiche catalogue. Une référence déjà utilisée ailleurs renvoie 409 ;
// une fiche inexistante renvoie 404 (Prisma P2025).
const modifierFicheCatalogue: express.RequestHandler = async (req, res) => {
  const family = catalogueFamily(String(req.params.family));
  if (!family) return res.status(404).json({ error: 'Famille catalogue inconnue.' });
  try {
    if (family === 'prestations') return res.json(ficheCataloguePourLecteur(req, decimalToNumber(await modifierPrestation(req, paramId(req)))));
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.estMainOeuvre !== undefined && body.estMainOeuvre !== null && body.estMainOeuvre !== false) throw new Error('Seule une prestation peut être une main d’œuvre.');
    const data: Record<string, unknown> = { ...cataloguePayload(body), ...catalogueExtraPayload(family, body) };
    if (body.actif !== undefined) data.actif = !!body.actif;
    res.json(ficheCataloguePourLecteur(req, decimalToNumber(await catalogueModels[family].update({
      where: { id: paramId(req) },
      data: data as never,
      include: { categorie: true },
    }))));
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2025') {
      return res.status(404).json({ error: 'Fiche catalogue introuvable.' });
    }
    catalogueApiError(res, error);
  }
};

// Désactivation (jamais de suppression) : une fiche catalogue peut déjà être référencée
// par un équipement installé — la retirer casserait l'historique. Un devis n'en dépend pas :
// sa ligne est une copie figée (lot pilote 2).
const desactiverFicheCatalogue: express.RequestHandler = async (req, res) => {
  const family = catalogueFamily(String(req.params.family));
  if (!family) return res.status(404).json({ error: 'Famille catalogue inconnue.' });
  try {
    if (family === 'prestations') return res.json(ficheCataloguePourLecteur(req, decimalToNumber(await desactiverPrestation(req, paramId(req)))));
    res.json(ficheCataloguePourLecteur(req, decimalToNumber(await catalogueModels[family].update({
      where: { id: paramId(req) },
      data: { actif: false } as never,
    }))));
  } catch (error) {
    if (error instanceof RefusCatalogue && error.statut !== 404) return res.status(error.statut).json({ error: error.message });
    res.status(404).json({ error: 'Fiche catalogue introuvable.' });
  }
};

export function enregistrerRoutesCatalogue(app: Express): void {
  // Le catalogue est monté sur les deux portes d'entrée, comme le référentiel clients :
  // un agent doit pouvoir lire les références et les tarifs pour rédiger un devis, et les
  // enrichir sous contrôle d'un scope d'écriture distinct de la lecture.
  routeMixte('get', '/catalogue/categories', 'catalogue:read', listerCategoriesCatalogue);
  routeMixte('post', '/catalogue/categories', 'catalogue:write', creerCategorieCatalogue);
  routeMixte('get', '/catalogue/:family', 'catalogue:read', listerCatalogue);
  routeMixte('post', '/catalogue/:family', 'catalogue:write', creerFicheCatalogue);
  routeMixte('put', '/catalogue/:family/:id', 'catalogue:write', modifierFicheCatalogue);
  routeMixte('delete', '/catalogue/:family/:id', 'catalogue:write', desactiverFicheCatalogue);
}
