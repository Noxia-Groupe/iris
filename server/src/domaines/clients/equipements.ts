import express from 'express';
import { prisma } from '../../db';
import { voitPrixAchatDevis } from '../../droits/visibilite';
import { paramId } from '../../http/requete';
import { dateIsoStricte } from '../../commun/dates';
import { ficheCataloguePourLecteur } from '../catalogue/metier';

// --- Parc d'équipements installés ---
// Le matériel est toujours rattaché à un client ET à l'un de ses sites. Cette double
// vérification interdit de déplacer un équipement vers le site d'un autre client en
// devinant un identifiant. L'archivage préserve la série, la garantie et l'historique.
const equipementInclude = { catalogueEquipement: true, clientSite: true };
// Le modèle du catalogue joint à chaque équipement suit la règle des fiches : son prix d'achat
// ne sort que pour l'administration ou une clé portant `finances:read` (cf. ficheCataloguePourLecteur).
function equipementPourLecteur<T>(req: express.Request, valeur: T): T {
  if (voitPrixAchatDevis(req)) return valeur;
  const masquer = (equipement: unknown) => {
    if (!equipement || typeof equipement !== 'object') return equipement;
    const { catalogueEquipement, ...reste } = equipement as Record<string, unknown>;
    return { ...reste, catalogueEquipement: ficheCataloguePourLecteur(req, catalogueEquipement) };
  };
  return (Array.isArray(valeur) ? valeur.map(masquer) : masquer(valeur)) as T;
}

function equipementTexte(value: unknown, champ: string, requis = false) {
  const texte = value == null ? '' : String(value).trim();
  if (requis && !texte) throw new Error(`${champ} obligatoire.`);
  if (texte.length > 500) throw new Error(`${champ} invalide.`);
  return texte || null;
}

// Date-seule, comme toute date métier : JJ-MM-AAAA (ou AAAA-MM-JJ des champs natifs), à minuit
// UTC. `new Date` lisait « 01-10-2026 » comme le 10 janvier, à minuit du fuseau du serveur.
function equipementDate(value: unknown, champ: string) {
  if (value == null || value === '') return null;
  const date = dateIsoStricte(String(value));
  if (!date) throw new Error(`${champ} invalide.`);
  return new Date(date);
}

async function equipementPayload(clientId: string, body: Record<string, unknown>) {
  const catalogueEquipementId = equipementTexte(body.catalogueEquipementId, 'Modèle équipement', true)!;
  const clientSiteId = equipementTexte(body.clientSiteId, 'Site', true)!;
  const [modele, site] = await Promise.all([
    prisma.catalogueEquipement.findUnique({ where: { id: catalogueEquipementId } }),
    prisma.clientSite.findFirst({ where: { id: clientSiteId, clientId } }),
  ]);
  if (!modele) throw new Error('Modèle équipement introuvable.');
  if (!site) throw new Error('Le site doit appartenir au client.');
  return {
    catalogueEquipementId,
    clientSiteId,
    numeroSerie: equipementTexte(body.numeroSerie, 'Numéro de série'),
    imei: equipementTexte(body.imei, 'IMEI'),
    adresseMac: equipementTexte(body.adresseMac, 'Adresse MAC'),
    installeLe: equipementDate(body.installeLe, 'Date d’installation'),
    garantieJusquAu: equipementDate(body.garantieJusquAu, 'Date de garantie'),
    notes: equipementTexte(body.notes, 'Notes'),
  };
}

function equipementApiError(res: express.Response, error: unknown) {
  if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Ce numéro de série est déjà enregistré pour ce modèle.' });
  const message = error instanceof Error ? error.message : 'Opération sur le parc impossible.';
  if (message.includes('obligatoire') || message.includes('invalide') || message.includes('introuvable') || message.includes('appartenir')) {
    return res.status(400).json({ error: message });
  }
  return res.status(500).json({ error: 'Opération sur le parc impossible.' });
}

export const listerEquipementsClient: express.RequestHandler = async (req, res) => {
  const clientId = String(req.params.clientId);
  try {
    const equipements = await prisma.equipementInstalle.findMany({
      where: { clientId, ...(req.query.inclureArchives === 'true' ? {} : { statut: { not: 'ARCHIVE' } }) },
      include: equipementInclude,
      // 'desc' plutôt que 'asc' : alphabétiquement ARCHIVE < INSTALLE, un tri croissant
      // ferait donc remonter le matériel archivé avant le matériel actif dès que
      // inclureArchives=true est demandé — l'inverse de ce qu'on veut consulter en premier.
      orderBy: [{ statut: 'desc' }, { createdAt: 'desc' }],
    });
    res.json(equipementPourLecteur(req, equipements));
  } catch (error) {
    equipementApiError(res, error);
  }
};

export const creerEquipementClient: express.RequestHandler = async (req, res) => {
  const clientId = String(req.params.clientId);
  try {
    const data = await equipementPayload(clientId, (req.body ?? {}) as Record<string, unknown>);
    res.status(201).json(equipementPourLecteur(req, await prisma.equipementInstalle.create({ data: { ...data, clientId }, include: equipementInclude })));
  } catch (error) {
    equipementApiError(res, error);
  }
};

export const archiverEquipementClient: express.RequestHandler = async (req, res) => {
  const clientId = String(req.params.clientId);
  const id = paramId(req);
  try {
    const maj = await prisma.equipementInstalle.updateMany({ where: { id, clientId }, data: { statut: 'ARCHIVE' } });
    if (!maj.count) return res.status(404).json({ error: 'Équipement introuvable.' });
    res.json(equipementPourLecteur(req, await prisma.equipementInstalle.findUnique({ where: { id }, include: equipementInclude })));
  } catch (error) {
    equipementApiError(res, error);
  }
};
