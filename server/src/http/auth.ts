import '../env';
import express from 'express';
import { Prisma } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { prisma } from '../db';
import { ROLE_RESPONSABLE, ROLE_SYSTEME } from '../droits/roles';

// --- Sécurité : résolution du secret JWT ---
// En production, le secret est OBLIGATOIRE : on refuse de démarrer sinon.
export function resolveJwtSecret(secret = process.env.JWT_SECRET, environnement = process.env.NODE_ENV): string {
  if (!secret) {
    if (environnement === 'production') throw new Error('JWT_SECRET manquant : définissez-le dans server/.env avant de démarrer en production.');
    console.warn('[AVERTISSEMENT] JWT_SECRET non défini — clé de développement non sécurisée utilisée.');
    return 'dev_only_insecure_secret_change_me';
  }
  if (environnement === 'production' && /^CHANGE_ME(?:_|$)/.test(secret)) throw new Error('JWT_SECRET est resté la valeur d’exemple : générez-en un avec openssl rand -base64 48.');
  return secret;
}
export const JWT_SECRET = resolveJwtSecret();

// --- Middlewares d'authentification / autorisation ---
export interface AuthRequest extends express.Request {
  // equipeIds : toute la branche hiérarchique d'un compte Responsable (cf. brancheHierarchique),
  // vide pour les autres types de compte.
  user?: { id: string; name: string; role: string; accesFinance: boolean; permissions: string[]; equipeIds: string[] };
}

// Branche hiérarchique d'un compte : ses collaborateurs directs, puis les leurs, jusqu'au
// bas de l'organisation — un responsable régional supervise ainsi les conducteurs de ses
// responsables de secteur, quelle que soit la taille de la structure. Les collaborateurs
// inactifs restent inclus : leur historique chantier ne disparaît pas du périmètre. L'API
// refuse les boucles ; UNION et l'exclusion du compte lui-même garantissent malgré tout
// que la lecture se termine si une boucle avait été écrite directement en base.
export async function brancheHierarchique(userId: string, db: Prisma.TransactionClient = prisma): Promise<string[]> {
  const lignes = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH RECURSIVE branche AS (
      SELECT "id" FROM "User" WHERE "responsableHierarchiqueId" = ${userId}
      UNION
      SELECT u."id" FROM "User" u JOIN branche b ON u."responsableHierarchiqueId" = b."id"
    )
    SELECT "id" FROM branche WHERE "id" <> ${userId}`);
  return lignes.map((ligne) => ligne.id);
}

// Le jeton n'authentifie QUE l'identité : le rôle est systématiquement relu en base, il
// n'est jamais repris du jeton. Un changement de droits (promotion superadmin au démarrage,
// rétrogradation décidée par la direction, révocation d'un compte) prend ainsi effet à la
// requête suivante, sans attendre l'expiration du jeton (7 jours) ni une reconnexion.
export const requireAuth: express.RequestHandler = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentification requise' });
    return;
  }
  let payload: { id: string };
  try {
    payload = jwt.verify(header.slice(7), JWT_SECRET) as { id: string; role: string };
  } catch {
    res.status(401).json({ error: 'Session expirée ou invalide' });
    return;
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: payload.id }, select: { id: true, name: true, role: true, accesFinance: true, permissions: true, actif: true } });
    // Le compte système, inactif, ne reçoit jamais de jeton ; le refuser ici aussi garde la porte
    // fermée même si une modification le réactivait.
    if (!user || user.role === ROLE_SYSTEME) {
      res.status(401).json({ error: 'Compte introuvable ou révoqué' });
      return;
    }
    // Désactivation en cours de session : les jetons déjà émis cessent d'être acceptés à la
    // requête suivante, sans attendre leur expiration (même logique que la relecture du rôle).
    if (!user.actif) {
      res.status(401).json({ code: 'COMPTE_DESACTIVE', error: 'Ce compte est désactivé.' });
      return;
    }
    // Seul un compte Responsable tire un périmètre de sa branche : un rattachement donné à un
    // autre type de compte reste une donnée d'organisation, sans élargir aucun accès.
    const equipeIds = user.role === ROLE_RESPONSABLE ? await brancheHierarchique(user.id) : [];
    (req as AuthRequest).user = { id: user.id, name: user.name, role: user.role, accesFinance: user.accesFinance, permissions: user.permissions, equipeIds };
    next();
  } catch {
    res.status(500).json({ error: 'Error resolving authenticated user' });
  }
};
