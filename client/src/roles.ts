import { useEffect, useState } from 'react';
import { apiFetch, getToken } from './api';

// Rôles de l'application — source unique de vérité côté client.
// Le serveur applique exactement les mêmes règles (cf. isAdminRole / isSuperAdminRole
// dans server/index.ts) : ce qui est masqué ici est également refusé côté API, l'affichage
// n'est jamais la sécurité.
export const ROLE_SUPERADMIN = 'SUPERADMIN';
export const ROLE_ADMIN = 'ADMIN';
export const ROLE_CONDUCTEUR = 'CONDUCTEUR_TRAVAUX';
export const ROLE_COMMERCIAL = 'COMMERCIAL';

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
    default: return 'Conducteur';
  }
}

export interface CurrentUser {
  id?: string;
  name?: string;
  email?: string;
  role?: string;
  theme?: string;
  /** Accès au Suivi financier accordé au cas par cas (cf. peutVoirFinance). */
  accesFinance?: boolean;
}

/**
 * Accès au Suivi financier : accordé compte par compte depuis Administration >
 * Utilisateurs, indépendamment du rôle. Un superadmin y accède toujours, sans avoir besoin
 * de l'autorisation. Même règle que peutVoirFinance() côté serveur — ce qui est masqué ici
 * est également refusé par l'API.
 */
export function peutVoirFinance(user?: CurrentUser | null): boolean {
  return !!user && (isSuperAdminRole(user.role) || !!user.accesFinance);
}

/** Compte connecté tel que stocké au login (localStorage), ou null. */
export function getCurrentUser(): CurrentUser | null {
  try {
    const raw = localStorage.getItem('user');
    return raw ? (JSON.parse(raw) as CurrentUser) : null;
  } catch {
    return null;
  }
}

export function getCurrentRole(): string {
  return getCurrentUser()?.role || ROLE_CONDUCTEUR;
}

/**
 * Relit le compte connecté auprès du serveur et met à jour la copie locale.
 * Indispensable après un changement de droits : le rôle mémorisé à la connexion peut
 * dater (une promotion en super administrateur, par exemple, a lieu côté serveur sans que
 * la session déjà ouverte en soit informée), alors que l'API applique immédiatement les
 * nouveaux droits. Sans cette resynchronisation, les menus resteraient ceux de l'ancien
 * rôle jusqu'à la prochaine connexion.
 */
export async function refreshCurrentUser(): Promise<CurrentUser | null> {
  if (!getToken()) return null;
  try {
    const res = await apiFetch('/me');
    if (!res.ok) return getCurrentUser();
    const user = (await res.json()) as CurrentUser;
    localStorage.setItem('user', JSON.stringify(user));
    return user;
  } catch {
    return getCurrentUser();
  }
}

/** Compte connecté : valeur mémorisée d'abord, valeur fraîche du serveur ensuite. */
export function useCurrentUser(): CurrentUser | null {
  const [user, setUser] = useState<CurrentUser | null>(getCurrentUser);

  useEffect(() => {
    let annule = false;
    refreshCurrentUser().then((u) => {
      if (!annule && u) setUser(u);
    });
    return () => { annule = true; };
  }, []);

  return user;
}

/** Rôle du compte connecté, resynchronisé avec le serveur. */
export function useCurrentRole(): string {
  return useCurrentUser()?.role || ROLE_CONDUCTEUR;
}
