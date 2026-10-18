import express from 'express';
import crypto from 'crypto';
import { prisma } from '../db';

// --- API d'intégration machine-à-machine (agents et connecteurs) ---
// Deuxième porte d'entrée de l'application, à côté de Microsoft Entra ID : un agent
// (Hermes) ou un connecteur n'a pas de compte Microsoft et ne doit pas en avoir. Il
// s'authentifie avec une clé Iris, dont le secret n'est JAMAIS stocké — seule son
// empreinte SHA-256 l'est, et la valeur n'est affichée qu'une fois, à sa création.
//
// Le SHA-256 nu suffit ici, contrairement à un mot de passe : le secret est tiré de 32
// octets aléatoires (256 bits d'entropie), il n'est ni mémorisable ni devinable, donc il
// n'y a rien à ralentir par un bcrypt. Le hachage protège la base, pas la clé.
export const API_SCOPES = [
  'clients:read', 'clients:write',
  'catalogue:read', 'catalogue:write',
  'equipements:read', 'equipements:write',
  'devis:read', 'devis:write',
  'company:read',
  // Domaine chantier : les chantiers eux-mêmes, leurs achats et leurs heures. Un agent
  // qui prépare un devis ou un rapport a besoin des trois, qui décrivent le même objet.
  'chantiers:read',
  // Saisie/correction et archivage sont deux capacités distinctes : l'archivage sort une
  // écriture des coûts actifs et requiert donc une délégation explicite.
  'chantiers:write', 'chantiers:archive',
  // Montants vendus et marge. Scope SÉPARÉ, jamais inclus dans chantiers:read : côté
  // interface ces champs sont déjà réservés à certains rôles (cf. serializeChantier), une
  // clé d'intégration ne doit pas les obtenir par le simple fait de lire un chantier.
  'finances:read',
] as const;
export type ApiScope = typeof API_SCOPES[number];
export interface ApiRequest extends express.Request { apiKey?: { id: string; nom: string; scopes: string[] }; }

export function apiKeyHash(key: string) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export const requireApiKey = (scope: ApiScope): express.RequestHandler => async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer iris_') ? header.slice(7) : '';
  if (!token) return void res.status(401).json({ error: 'Clé API Iris requise' });
  try {
    const key = await prisma.apiAccessKey.findUnique({ where: { secretHash: apiKeyHash(token) } });
    if (!key || !key.actif || key.revoqueLe || (key.expireLe && key.expireLe <= new Date())) {
      return void res.status(401).json({ error: 'Clé API invalide, expirée ou révoquée' });
    }
    if (!key.scopes.includes(scope)) {
      return void res.status(403).json({ error: `Scope requis : ${scope}` });
    }
    (req as ApiRequest).apiKey = { id: key.id, nom: key.nom, scopes: key.scopes };
    // Trace de dernière utilisation : sans attente ni échec bloquant, elle sert à repérer
    // une clé oubliée (jamais utilisée) ou toujours vivante avant de la révoquer.
    void prisma.apiAccessKey.update({ where: { id: key.id }, data: { dernierUsageLe: new Date() } }).catch(() => undefined);
    next();
  } catch {
    res.status(500).json({ error: "Erreur d'authentification de la clé API" });
  }
};
