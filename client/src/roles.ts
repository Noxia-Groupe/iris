import { useEffect, useState } from 'react';
import { apiFetch, getToken } from './api';
import { ROLE_CONDUCTEUR, type CurrentUser } from './lib/droits';

export * from './lib/droits';

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
