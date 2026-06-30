// Base d'API centralisée.
// En production, le Dockerfile injecte VITE_API_URL=/api (même origine, derrière nginx).
// En développement, on cible /api et le proxy Vite (voir vite.config.ts) redirige vers le backend.
export const API_URL: string = import.meta.env.VITE_API_URL || '/api';

/**
 * Construit l'URL d'un fichier statique servi par le backend (ex: /uploads/photo.jpg).
 * - Si VITE_API_URL est absolu (ex: http://host:3001/api), on réutilise son origine.
 * - Sinon (cas standard prod/dev via proxy), on reste en même origine.
 */
export function assetUrl(p: string): string {
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  if (/^https?:\/\//i.test(API_URL)) {
    try {
      return new URL(API_URL).origin + p;
    } catch {
      /* ignore */
    }
  }
  return p;
}

export function getToken(): string | null {
  return localStorage.getItem('token');
}

function logoutAndRedirect() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  if (!window.location.pathname.startsWith('/login')) {
    window.location.href = '/login';
  }
}

/**
 * fetch authentifié : ajoute l'en-tête Authorization, sérialise le JSON,
 * et gère le 401 (session expirée → déconnexion).
 * @param path chemin relatif à l'API (ex: '/chantiers')
 */
export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  // Ne pas forcer le Content-Type pour les FormData (upload) : le navigateur gère le boundary.
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body && !isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (res.status === 401) {
    logoutAndRedirect();
  }
  return res;
}
