import express from 'express';
import { ROLE_ASSISTANTE_COMMERCIALE, ROLE_TECHNICIEN, ROLE_COMPTABLE, ROLE_DIRECTEUR_COMMERCIAL, ROLE_RESPONSABLE, ROLE_DIRECTEUR, isSuperAdminRole } from './roles';
import type { AuthRequest } from '../http/auth';
import { API_SCOPES } from '../http/cles-api';

// Droits par défaut des types de compte. Ils restent volontairement limités aux modules
// existants ; SAV, maintenance, facturation, banques et objectifs seront ajoutés avec
// leurs routes métier, jamais anticipés par des accès fictifs.
const DEFAULT_USER_PERMISSIONS: Record<string, string[]> = {
  ADMIN: ['devis:read', 'devis:write', 'clients:read', 'chantiers:read', 'chantiers:write', 'chantiers:archive'],
  // Le conducteur saisit et corrige les écritures de son affaire. L'archivage, qui retire
  // un coût ou des heures des marges actives, est distinct et réservé par défaut aux rôles
  // d'encadrement ; il peut être accordé individuellement si l'organisation le décide.
  // Il lit les clients (clients, contacts, sites) pour choisir celui d'une intervention SAV
  // qu'il crée (décision de Nelson du 16-10-2026), sans les modifier ni voir de devis.
  CONDUCTEUR_TRAVAUX: ['chantiers:read', 'chantiers:write', 'clients:read'],
  COMMERCIAL: ['devis:read', 'devis:write', 'clients:read', 'chantiers:read'],
  [ROLE_ASSISTANTE_COMMERCIALE]: ['devis:read', 'devis:write', 'clients:read', 'chantiers:read'],
  [ROLE_COMPTABLE]: ['devis:read', 'devis:write', 'clients:read', 'chantiers:read'],
  [ROLE_DIRECTEUR_COMMERCIAL]: ['devis:read', 'devis:write', 'clients:read', 'chantiers:read'],
  [ROLE_RESPONSABLE]: ['chantiers:read', 'chantiers:write', 'chantiers:archive'],
  // Annuaire des clients (clients, contacts, sites) en consultation, par exemple pour retrouver
  // une adresse ; ni devis ni montants (décision de Nelson du 13-10-2026).
  [ROLE_TECHNICIEN]: ['chantiers:read', 'clients:read'],
  // Lecture seule. Le droit devis peut s'accorder individuellement ; la saisie Travaux non :
  // assertChantierWritable ne la permet qu'au conducteur, au responsable de branche et à l'administration.
  [ROLE_DIRECTEUR]: ['chantiers:read'],
};

// Droits jamais accordés à un technicien, ni par son type de compte ni individuellement : il ne
// modifie aucune affaire et ne voit ni prix ni coûts (décisions de Nelson du 13-10-2026). Une
// permission déjà enregistrée, par exemple avant un changement de type, reste sans effet.
export const DROITS_INTERDITS_TECHNICIEN = ['devis:read', 'devis:write', 'chantiers:write', 'chantiers:archive', 'finances:read'];

export function permissionsEffectives(user: { role: string; accesFinance?: boolean | null; permissions?: string[] }): string[] {
  const droits = new Set([...(DEFAULT_USER_PERMISSIONS[user.role] ?? []), ...(user.permissions ?? [])]);
  if (user.accesFinance) droits.add('finances:read');
  // Un superadministrateur ne dépend jamais d'une liste fragile de permissions.
  if (isSuperAdminRole(user.role)) API_SCOPES.forEach((permission) => droits.add(permission));
  if (user.role === ROLE_TECHNICIEN) DROITS_INTERDITS_TECHNICIEN.forEach((permission) => droits.delete(permission));
  return [...droits].sort();
}

function hasUserPermission(user: AuthRequest['user'], permission: string): boolean {
  return !!user && permissionsEffectives(user).includes(permission);
}

export function requirePermission(permission: string): express.RequestHandler {
  return (req, res, next) => {
    if (!hasUserPermission((req as AuthRequest).user, permission)) return void res.status(403).json({ error: `Permission requise : ${permission}` });
    next();
  };
}
