// --- Rôles de l'application ---
// SUPERADMIN : rôle « direction ». Il possède TOUS les droits d'un ADMIN (cf. isAdminRole,
// utilisé partout où l'application testait jusqu'ici `role === 'ADMIN'`) et, EN PLUS, les
// réglages qui lui sont réservés : gestion des comptes SUPERADMIN et activation ou
// désactivation des modules de l'application (cf. Parametres.planningActif). Un ADMIN ne
// peut ni se promouvoir superadmin, ni modifier/supprimer un compte superadmin — sans quoi
// la séparation entre les deux rôles n'aurait aucune valeur.
export const ROLE_SUPERADMIN = 'SUPERADMIN';
export const ROLE_ASSISTANTE_COMMERCIALE = 'ASSISTANTE_COMMERCIALE';
export const ROLE_TECHNICIEN = 'TECHNICIEN';
export const ROLE_COMPTABLE = 'COMPTABLE';
export const ROLE_DIRECTEUR_COMMERCIAL = 'DIRECTEUR_COMMERCIAL';
export const ROLE_RESPONSABLE = 'RESPONSABLE';
// DIRECTEUR : pilotage de toute la société sans administration ni paramétrage. Il voit
// tous les chantiers (non annulés), leur rentabilité et leurs alertes si la société l'a
// laissé destinataire (Parametres.rentabiliteDirecteurs), et ne saisit rien.
export const ROLE_DIRECTEUR = 'DIRECTEUR';

export function isAdminRole(role: string | undefined | null): boolean {
  return role === 'ADMIN' || role === ROLE_SUPERADMIN;
}
export function isSuperAdminRole(role: string | undefined | null): boolean {
  return role === ROLE_SUPERADMIN;
}
