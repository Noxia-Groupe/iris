import express from 'express';
import { Prisma } from '@prisma/client';
import { ROLE_RESPONSABLE, ROLE_DIRECTEUR, isAdminRole } from './roles';
import type { AuthRequest } from '../http/auth';
import type { ApiRequest } from '../http/cles-api';

// --- Périmètre de lecture du domaine chantier ---
// Une même liste (achats, heures, chantiers) ne montre pas la même chose selon qui la
// demande. Deux natures de porteur, deux façons de le décider :
//
//   - session humaine : le RÔLE décide. Un administrateur ou un directeur voit tout ; un
//     conducteur de travaux, les chantiers dont il est responsable ; un responsable, les
//     siens et ceux de toute sa branche hiérarchique ; un commercial, ceux qu'il a vendus.
//     C'est exactement la règle qu'applique déjà GET /api/chantiers.
//   - clé d'intégration : le SCOPE décide. Une clé ne représente personne en particulier,
//     elle n'a donc pas de rôle à interroger ; porter `chantiers:read` vaut autorisation
//     sur le domaine, et c'est au superadmin de ne délivrer que les scopes utiles.
//
// Renvoie un filtre Prisma applicable à un champ `chantier` imbriqué comme à un chantier
// racine ; `{}` signifie « aucune restriction ».
// Une affaire ANNULÉE sort du périmètre de tout le monde, administrateurs compris : elle
// n'a plus à peser sur une liste, un coût, une marge ou une commission. Elle n'est pas
// perdue pour autant — GET /api/chantiers/:id la rend toujours, avec le motif de son
// annulation, et c'est bien là qu'on va la chercher quand on veut comprendre.
export const AFFAIRE_NON_ANNULEE = { statut: { not: 'ANNULE' } } as const;

export function perimetreChantiers(req: express.Request): Prisma.ChantierWhereInput {
  return { ...AFFAIRE_NON_ANNULEE, ...perimetreDemandeur(req) };
}

function perimetreDemandeur(req: express.Request): Prisma.ChantierWhereInput {
  if ((req as ApiRequest).apiKey) return {};
  const user = (req as AuthRequest).user;
  if (!user || isAdminRole(user.role) || user.role === ROLE_DIRECTEUR) return {};
  if (user.role === 'COMMERCIAL') return { commercialId: user.id };
  if (user.role === ROLE_RESPONSABLE) return { responsableId: { in: [user.id, ...user.equipeIds] } };
  return { responsableId: user.id };
}
