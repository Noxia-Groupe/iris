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
// DIRECTEUR : direction de la société. Il a les droits de l'administration, paramètres et gestion
// des comptes compris, hors réglages réservés au SUPERADMIN (décision de Nelson du 24-10-2026,
// point 14, « Tout, réglages compris »). Il garde ses particularités (point 17) : périmètre de toute
// la société, clôture des chantiers, et rentabilité des chantiers selon le réglage de la société
// (Parametres.rentabiliteDirecteurs, cf. voitRentabilite), qui ne masque que les chantiers (réponse
// de Nelson du 06-11-2026, « Chantiers seulement »).
export const ROLE_DIRECTEUR = 'DIRECTEUR';
// Compte système (décision de Nelson du 22-10-2026, lot pilote 5) : auteur des écritures
// automatiques, comme la génération des visites. Créé par la migration, il ne se connecte jamais
// (inactif, sans mot de passe, adresse réservée), n'a aucun droit et n'apparaît pas dans la
// gestion des comptes ; la base refuse de le modifier ou de le supprimer.
export const ROLE_SYSTEME = 'SYSTEME';
export const COMPTE_SYSTEME_ID = '00000000-0000-4000-8000-000000000001';
// Nom par défaut, à confirmer (passation, section 4) : le changer demande une migration, la base figeant le compte.
export const NOM_COMPTE_SYSTEME = 'Iris (automatique)';
export const EMAIL_COMPTE_SYSTEME = 'systeme@iris.invalid';

// Types de compte qui ont les droits de l'administration : une seule liste, lue par isAdminRole et
// par les aides de capacité (périmètre SAV, écrans). Le lot de l'assistante technique ajoutera ses
// propres capacités sans élargir cette liste.
export const TYPES_ADMINISTRATION: readonly string[] = [ROLE_SUPERADMIN, 'ADMIN', ROLE_DIRECTEUR];

export function isAdminRole(role: string | undefined | null): boolean {
  return !!role && TYPES_ADMINISTRATION.includes(role);
}
export function isSuperAdminRole(role: string | undefined | null): boolean {
  return role === ROLE_SUPERADMIN;
}

// « Aussi commercial » : réservé aux types ADMIN et SUPERADMIN (décision 7 de la proposition de
// droits, #182), seuls connus de COMMERCIAL_OR_FILTER ; le directeur, qui a pourtant les droits de
// l'administration, n'est pas marqué commercial.
export function peutEtreAussiCommercial(role: string | undefined | null): boolean {
  return role === 'ADMIN' || role === ROLE_SUPERADMIN;
}

// Un administrateur peut être marqué "estCommercial" : il garde alors tous les droits
// d'administration (blockCommercial ne le concerne pas, il reste role === 'ADMIN'), mais
// apparaît EN PLUS comme un commercial pour l'affectation aux chantiers et les
// statistiques/marges de "Mes commerciaux" — au même titre qu'un compte de rôle
// COMMERCIAL. isCommercialLike() et COMMERCIAL_OR_FILTER couvrent les deux cas partout où
// l'appli devait jusqu'ici filtrer strictement sur role === 'COMMERCIAL'.
export function isCommercialLike(u: { role: string; estCommercial?: boolean | null }): boolean {
  return u.role === 'COMMERCIAL' || (peutEtreAussiCommercial(u.role) && !!u.estCommercial);
}
export const COMMERCIAL_OR_FILTER = [
  { role: 'COMMERCIAL' },
  { role: 'ADMIN', estCommercial: true },
  { role: ROLE_SUPERADMIN, estCommercial: true },
];
