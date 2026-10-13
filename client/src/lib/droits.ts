// Règles de rôles pures, sans dépendance au navigateur ni à l'API : elles se testent
// directement et servent au menu comme aux routes. roles.ts les réexporte à l'identique.
// Rôles de l'application — source unique de vérité côté client.
// Le serveur applique exactement les mêmes règles (cf. isAdminRole / isSuperAdminRole
// dans server/index.ts) : ce qui est masqué ici est également refusé côté API, l'affichage
// n'est jamais la sécurité.
export const ROLE_SUPERADMIN = 'SUPERADMIN';
export const ROLE_ADMIN = 'ADMIN';
export const ROLE_CONDUCTEUR = 'CONDUCTEUR_TRAVAUX';
export const ROLE_COMMERCIAL = 'COMMERCIAL';
export const ROLE_ASSISTANTE_COMMERCIALE = 'ASSISTANTE_COMMERCIALE';
export const ROLE_TECHNICIEN = 'TECHNICIEN';
export const ROLE_COMPTABLE = 'COMPTABLE';
export const ROLE_DIRECTEUR_COMMERCIAL = 'DIRECTEUR_COMMERCIAL';
export const ROLE_RESPONSABLE = 'RESPONSABLE';

/** Un SUPERADMIN possède TOUS les droits d'un ADMIN, plus ceux réservés à la direction. */
export function isAdminRole(role?: string | null): boolean {
  return role === ROLE_ADMIN || role === ROLE_SUPERADMIN;
}

/** Réglages réservés à la direction : modules de l'application, comptes superadmin. */
export function isSuperAdminRole(role?: string | null): boolean {
  return role === ROLE_SUPERADMIN;
}

export function roleLabel(role?: string | null): string {
  switch (role) {
    case ROLE_SUPERADMIN: return 'Super Admin';
    case ROLE_ADMIN: return 'Admin';
    case ROLE_COMMERCIAL: return 'Commercial';
    case ROLE_ASSISTANTE_COMMERCIALE: return 'Assistante commerciale';
    case ROLE_TECHNICIEN: return 'Technicien';
    case ROLE_COMPTABLE: return 'Comptable';
    case ROLE_DIRECTEUR_COMMERCIAL: return 'Directeur commercial';
    case ROLE_RESPONSABLE: return 'Responsable';
    default: return 'Conducteur';
  }
}

export interface CurrentUser {
  id?: string;
  name?: string;
  email?: string;
  role?: string;
  theme?: string;
  /** Accès aux données financières, accordé au cas par cas (cf. peutVoirFinance). */
  accesFinance?: boolean;
  /** Permissions individuelles relues depuis /api/me. */
  permissions?: string[];
}

/**
 * Accès aux données financières : accordé compte par compte depuis Administration >
 * Utilisateurs, indépendamment du rôle. Un superadmin y accède toujours, sans avoir besoin
 * de l'autorisation. Même règle que peutVoirFinance() côté serveur.
 *
 * Aucun écran ne s'en sert aujourd'hui : l'autorisation attend la facturation (phase 8)
 * puis les paiements et le rapprochement bancaire (phase 9), qu'elle gardera.
 */
export function peutVoirFinance(user?: CurrentUser | null): boolean {
  return !!user && (isSuperAdminRole(user.role) || !!user.accesFinance);
}

/** Statistiques Travaux : admin global, responsable équipe, conducteur sur ses affaires. Les commerciaux ont leur écran Résultat commercial dédié. */
export function peutVoirStatistiques(user?: CurrentUser | null): boolean {
  return !!user && (isAdminRole(user.role) || user.role === ROLE_RESPONSABLE || user.role === ROLE_CONDUCTEUR);
}

/** Accès interface aux devis ; le serveur applique toujours la permission réelle. */
export function peutAccederAuxDevis(user?: CurrentUser | null): boolean {
  return !!user && (isSuperAdminRole(user.role) || (user.permissions || []).includes('devis:read'));
}

