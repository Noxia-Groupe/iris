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
/** Pilotage de toute la société, en lecture seule, sans administration ni paramétrage. */
export const ROLE_DIRECTEUR = 'DIRECTEUR';

/** Un SUPERADMIN possède TOUS les droits d'un ADMIN, plus ceux réservés à la direction. */
export function isAdminRole(role?: string | null): boolean {
  return role === ROLE_ADMIN || role === ROLE_SUPERADMIN;
}

/** Réglages réservés à la direction : modules de l'application, comptes superadmin. */
export function isSuperAdminRole(role?: string | null): boolean {
  return role === ROLE_SUPERADMIN;
}

/**
 * Types de compte, dans l'ordre des listes de l'administration, avec le libellé unique de chacun
 * (#203 ; point 1 de #475 : un seul libellé par type, le plus explicite, en casse de phrase ;
 * choix par défaut, à confirmer). Le menu, « Connecté en tant que », le journal d'administration
 * et les deux listes de l'administration lisent tous cette table.
 */
export const TYPES_COMPTE: ReadonlyArray<{ valeur: string; libelle: string }> = [
  { valeur: ROLE_CONDUCTEUR, libelle: 'Conducteur de travaux' },
  { valeur: ROLE_COMMERCIAL, libelle: 'Commercial' },
  { valeur: ROLE_ASSISTANTE_COMMERCIALE, libelle: 'Assistante commerciale' },
  { valeur: ROLE_TECHNICIEN, libelle: 'Technicien' },
  { valeur: ROLE_COMPTABLE, libelle: 'Comptable' },
  { valeur: ROLE_DIRECTEUR_COMMERCIAL, libelle: 'Directeur commercial' },
  { valeur: ROLE_RESPONSABLE, libelle: 'Responsable' },
  { valeur: ROLE_DIRECTEUR, libelle: 'Directeur' },
  { valeur: ROLE_ADMIN, libelle: 'Administrateur' },
  { valeur: ROLE_SUPERADMIN, libelle: 'Super administrateur' },
];

/** Types qu'un compte peut attribuer : seul un super administrateur peut en désigner un autre. */
export function typesCompteProposes(estSuperAdmin: boolean): ReadonlyArray<{ valeur: string; libelle: string }> {
  return TYPES_COMPTE.filter((type) => estSuperAdmin || type.valeur !== ROLE_SUPERADMIN);
}

export function roleLabel(role?: string | null): string {
  // Repli d'un rôle absent ou inconnu inchangé ici (#203) ; la PR A4 du lot (#206) le fixe.
  return TYPES_COMPTE.find((type) => type.valeur === role)?.libelle ?? 'Conducteur';
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
  // Jamais pour un technicien, qui ne voit aucun montant.
  if (user?.role === ROLE_TECHNICIEN) return false;
  return !!user && (isSuperAdminRole(user.role) || !!user.accesFinance);
}

/** Statistiques Travaux : admin global, responsable équipe, conducteur sur ses affaires. Les commerciaux ont leur écran Résultat commercial dédié. */
export function peutVoirStatistiques(user?: CurrentUser | null): boolean {
  return !!user && (isAdminRole(user.role) || user.role === ROLE_RESPONSABLE || user.role === ROLE_CONDUCTEUR);
}

/**
 * Comptes exclus des écrans opérationnels (planning, administration, saisies) : le
 * commercial, qui a son propre résultat, et le directeur, qui consulte sans modifier (hors la
 * clôture d'un chantier en cours, depuis la liste des chantiers).
 * Même règle que blockCommercial côté serveur.
 */
export function estExcluDesOperations(role?: string | null): boolean {
  return role === ROLE_COMMERCIAL || role === ROLE_DIRECTEUR;
}

/**
 * Directeur commercial, assistante commerciale et comptable : ni planning, lectures comprises, ni
 * écriture des référentiels des achats (décision 11 de la proposition de droits, #179). Même règle
 * que blockCommercialEtAssimiles côté serveur.
 */
export const ROLES_SANS_PLANNING_NI_REFERENTIELS = [ROLE_DIRECTEUR_COMMERCIAL, ROLE_ASSISTANTE_COMMERCIALE, ROLE_COMPTABLE];

/** Planning : fermé aux comptes exclus des opérations et aux trois types ci-dessus. */
export function peutConsulterPlanning(role?: string | null): boolean {
  return !estExcluDesOperations(role) && !ROLES_SANS_PLANNING_NI_REFERENTIELS.includes(role || '');
}

/**
 * Administration : complète pour les administrateurs, réduite aux référentiels des achats
 * (fournisseurs, catégories) pour le conducteur. Le technicien n'y a plus rien à faire depuis le
 * lot pilote 3, qui lui retire ces écritures (choix par défaut), ni le directeur commercial,
 * l'assistante commerciale et le comptable depuis #179 ; le serveur les leur refuse aussi.
 */
export function peutOuvrirAdministration(role?: string | null): boolean {
  return !estExcluDesOperations(role) && role !== ROLE_TECHNICIEN && !ROLES_SANS_PLANNING_NI_REFERENTIELS.includes(role || '');
}

/**
 * Annuaire des clients (clients, contacts, sites) : les administrateurs, qui le tiennent à jour,
 * puis, en consultation seule, le technicien (décision de Nelson du 13-10-2026), par exemple pour
 * retrouver une adresse, et le conducteur de travaux (décision du 16-10-2026). Le serveur applique
 * la permission clients:read.
 */
export const ROLES_ANNUAIRE = [ROLE_SUPERADMIN, ROLE_ADMIN, ROLE_TECHNICIEN, ROLE_CONDUCTEUR];
// Même liste pour le menu et pour la route /clients (App.tsx) : l'un ne s'ouvre pas sans l'autre.
export function peutConsulterAnnuaire(user?: CurrentUser | null): boolean {
  return !!user && ROLES_ANNUAIRE.includes(user.role || '');
}

/** Accès interface aux devis ; le serveur applique toujours la permission réelle. */
export function peutAccederAuxDevis(user?: CurrentUser | null): boolean {
  return !!user && (isSuperAdminRole(user.role) || (user.permissions || []).includes('devis:read'));
}
