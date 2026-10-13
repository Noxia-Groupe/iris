// Nom de la société exploitante gardé en cache local, pour que l'en-tête du menu se dessine
// sans attendre l'API. Donnée non sensible, effacée à chaque fin de session.
export const CACHE_NOM_SOCIETE = 'nomSociete';

export function lireNomSocieteEnCache(): string {
  try { return localStorage.getItem(CACHE_NOM_SOCIETE) || ''; } catch { return ''; }
}

export function memoriserNomSociete(nom: string): void {
  try { localStorage.setItem(CACHE_NOM_SOCIETE, nom); } catch { /* cache facultatif */ }
}

export function effacerCacheSociete(): void {
  try { localStorage.removeItem(CACHE_NOM_SOCIETE); } catch { /* cache facultatif */ }
}
