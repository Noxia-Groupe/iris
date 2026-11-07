// Règles de rôles pures, sans dépendance au navigateur ni à l'API : elles se testent
// directement et servent au menu comme aux routes. roles.ts les réexporte à l'identique.
// Rôles de l'application — source unique de vérité côté client.
// Le serveur applique exactement les mêmes règles (cf. isAdminRole / isSuperAdminRole
// dans server/src/droits/roles.ts) : ce qui est masqué ici est également refusé côté API, l'affichage
// n'est jamais la sécurité. Un compte sans rôle (cas qui n'existe pas en base, où le rôle est
// obligatoire) n'a aucun rôle à l'écran : ni repli sur un autre type, ni planning, ni
// administration (#206, choix par défaut, à confirmer) ; le serveur reste seul juge.
export const ROLE_SUPERADMIN = 'SUPERADMIN';
export const ROLE_ADMIN = 'ADMIN';
export const ROLE_CONDUCTEUR = 'CONDUCTEUR_TRAVAUX';
export const ROLE_COMMERCIAL = 'COMMERCIAL';
export const ROLE_ASSISTANTE_COMMERCIALE = 'ASSISTANTE_COMMERCIALE';
/**
 * Assistante technique : la partie technique de toute la société (SAV, planning, suivi, chantiers en
 * lecture ; devis, clients et contrats depuis AT-2a), sans les droits de l'administration (décisions de
 * Nelson du 24-10-2026 et du 06-11-2026) : ses capacités sont ajoutées une à une aux aides qui les décident.
 * Distincte de l'assistante commerciale, qui reste sans planning. Même type que ROLE_ASSISTANTE_TECHNIQUE
 * côté serveur.
 */
export const ROLE_ASSISTANTE_TECHNIQUE = 'ASSISTANTE_TECHNIQUE';
export const ROLE_TECHNICIEN = 'TECHNICIEN';
export const ROLE_COMPTABLE = 'COMPTABLE';
export const ROLE_DIRECTEUR_COMMERCIAL = 'DIRECTEUR_COMMERCIAL';
export const ROLE_RESPONSABLE = 'RESPONSABLE';
/**
 * Directeur : les droits de l'administration, paramètres et comptes compris, hors réglages du
 * super administrateur (points 14 et 17 du 24-10-2026). Il voit la rentabilité des chantiers
 * selon le réglage de la société (réponse de Nelson du 06-11-2026, « Chantiers seulement ») et
 * n'est jamais « aussi commercial ».
 */
export const ROLE_DIRECTEUR = 'DIRECTEUR';

/**
 * Types qui ont les droits de l'administration : même liste que TYPES_ADMINISTRATION côté
 * serveur. Les listes de l'écran (routes privées, annuaire) s'écrivent à partir d'elle, et non
 * en citant les types un à un.
 */
export const TYPES_ADMINISTRATION: readonly string[] = [ROLE_SUPERADMIN, ROLE_ADMIN, ROLE_DIRECTEUR];

/**
 * Droits de l'administration : ADMIN, SUPERADMIN, qui y ajoute ceux réservés à la direction,
 * et DIRECTEUR, sans ces derniers.
 */
export function isAdminRole(role?: string | null): boolean {
  return !!role && TYPES_ADMINISTRATION.includes(role);
}

/**
 * Case « aussi commercial » : réservée aux types ADMIN et SUPERADMIN (décision 7 de la
 * proposition de droits, #182). Le directeur, qui a les droits de l'administration, ne la porte
 * pas. Même règle que peutEtreAussiCommercial côté serveur.
 */
export function peutEtreAussiCommercial(role?: string | null): boolean {
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
  { valeur: ROLE_ASSISTANTE_TECHNIQUE, libelle: 'Assistante technique' },
  { valeur: ROLE_TECHNICIEN, libelle: 'Technicien' },
  { valeur: ROLE_COMPTABLE, libelle: 'Comptable' },
  { valeur: ROLE_DIRECTEUR_COMMERCIAL, libelle: 'Directeur commercial' },
  { valeur: ROLE_RESPONSABLE, libelle: 'Responsable' },
  { valeur: ROLE_DIRECTEUR, libelle: 'Directeur' },
  { valeur: ROLE_ADMIN, libelle: 'Administrateur' },
  { valeur: ROLE_SUPERADMIN, libelle: 'Super administrateur' },
];

/**
 * Types qu'un compte peut attribuer : seul un super administrateur peut en désigner un autre, et un
 * directeur n'attribue pas le type Administrateur, qui lèverait sa restriction de rentabilité (choix
 * par défaut, à confirmer ; miroir de refuseTypeAdminParDirecteur côté serveur).
 */
export function typesCompteProposes(estSuperAdmin: boolean, sansAdministrateur = false): ReadonlyArray<{ valeur: string; libelle: string }> {
  return TYPES_COMPTE.filter((type) => (estSuperAdmin || type.valeur !== ROLE_SUPERADMIN) && (!sansAdministrateur || type.valeur !== ROLE_ADMIN));
}

/** Libellé d'un type de compte ; '' pour un rôle absent ou inconnu, qui n'affiche rien (#206). */
export function roleLabel(role?: string | null): string {
  return TYPES_COMPTE.find((type) => type.valeur === role)?.libelle ?? '';
}

/**
 * Rôle du compte connecté, tel qu'il est mémorisé ou relu auprès de /api/me ; '' s'il n'en porte
 * pas (#206). Seule lecture du rôle pour le menu, les pages et roles.ts : aucun repli sur le
 * conducteur de travaux, que le compte n'est pas forcément.
 */
export function roleDuCompte(user?: CurrentUser | null): string {
  return user?.role || '';
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
 * commercial, qui a son propre résultat. Le directeur, qui a les droits de l'administration
 * depuis les décisions du 24-10-2026, n'en est plus exclu.
 * Même règle que blockCommercial côté serveur ; un rôle absent, qui n'existe pas côté serveur,
 * est écarté par les aides ci-dessous (#206).
 */
export function estExcluDesOperations(role?: string | null): boolean {
  return role === ROLE_COMMERCIAL;
}

/**
 * Directeur commercial, assistante commerciale et comptable : ni planning, lectures comprises, ni
 * écriture des référentiels des achats (décision 11 de la proposition de droits, #179). Même règle
 * que blockCommercialEtAssimiles côté serveur, pour ces trois types.
 */
export const ROLES_SANS_PLANNING_NI_REFERENTIELS = [ROLE_DIRECTEUR_COMMERCIAL, ROLE_ASSISTANTE_COMMERCIALE, ROLE_COMPTABLE];

/**
 * Planning : fermé aux comptes exclus des opérations, aux trois types ci-dessus et à un rôle absent
 * ('', null ou undefined : option la plus restrictive, #206, choix par défaut, à confirmer). Ouvert,
 * entre autres, à l'assistante technique, qui l'organise sur toute la société.
 */
export function peutConsulterPlanning(role?: string | null): boolean {
  if (!role) return false;
  return !estExcluDesOperations(role) && !ROLES_SANS_PLANNING_NI_REFERENTIELS.includes(role);
}

/**
 * Administration : complète pour les administrateurs, réduite aux référentiels des achats
 * (fournisseurs, catégories) pour le conducteur, le responsable et l'assistante technique, qui saisit le
 * matériel des interventions SAV, chacun lié à un fournisseur ; l'assistante technique y ouvre aussi le
 * chantier d'une affaire (onglet Chantiers, cf. gereLesChantiersEnCours). Le technicien n'y a plus rien à faire depuis le
 * lot pilote 3, qui lui retire ces écritures (choix par défaut), ni le directeur commercial,
 * l'assistante commerciale et le comptable depuis #179 ; le serveur les leur refuse aussi. Un rôle
 * absent ('', null ou undefined) ne l'ouvre pas non plus (#206, choix par défaut, à confirmer).
 */
export function peutOuvrirAdministration(role?: string | null): boolean {
  if (!role) return false;
  return !estExcluDesOperations(role) && role !== ROLE_TECHNICIEN && !ROLES_SANS_PLANNING_NI_REFERENTIELS.includes(role);
}

/**
 * Annuaire des clients (clients, contacts, sites) : les administrateurs (TYPES_ADMINISTRATION,
 * directeur compris), qui le tiennent à jour, puis, en consultation seule, le technicien (décision de Nelson du 13-10-2026), par exemple pour
 * retrouver une adresse, le conducteur de travaux (décision du 16-10-2026) et l'assistante technique,
 * qui choisit le client d'une intervention SAV. Le serveur applique la permission clients:read.
 */
export const ROLES_ANNUAIRE = [...TYPES_ADMINISTRATION, ROLE_TECHNICIEN, ROLE_CONDUCTEUR, ROLE_ASSISTANTE_TECHNIQUE];
// Même liste pour le menu et pour la route /clients (App.tsx) : l'un ne s'ouvre pas sans l'autre.
export function peutConsulterAnnuaire(user?: CurrentUser | null): boolean {
  return !!user && ROLES_ANNUAIRE.includes(user.role || '');
}

/**
 * Écran des interventions SAV : l'administration, le conducteur, le responsable, le technicien et
 * l'assistante technique (même liste pour le menu et la route /interventions).
 */
export const ROLES_INTERVENTIONS = [...TYPES_ADMINISTRATION, ROLE_CONDUCTEUR, ROLE_RESPONSABLE, ROLE_TECHNICIEN, ROLE_ASSISTANTE_TECHNIQUE];
export function peutVoirInterventions(role?: string | null): boolean {
  return !!role && ROLES_INTERVENTIONS.includes(role);
}

/**
 * Encadrement du SAV (nouvelle intervention, matériel, coûts sans taux) : l'administration, le conducteur
 * et l'assistante technique ; même règle que estEncadrementCoutIntervention côté serveur.
 */
export function estEncadrementSav(role?: string | null): boolean {
  return isAdminRole(role) || role === ROLE_CONDUCTEUR || role === ROLE_ASSISTANTE_TECHNIQUE;
}

/**
 * Encadrement du suivi (marque « à suivre », création de la suite) : l'encadrement du SAV et le
 * responsable ; même règle que estEncadrementSuivi côté serveur.
 */
export function estEncadrementSuivi(role?: string | null): boolean {
  return estEncadrementSav(role) || role === ROLE_RESPONSABLE;
}

/**
 * Capacité « lit toutes les affaires » (liste, fiche, journaux, historique client) : l'administration et
 * l'assistante technique, qui travaille sur toute la société. Ce que la fiche en montre (rentabilité, coût
 * prévu, coût de main-d'œuvre) reste décidé à part, et cette lecture n'ouvre aucune écriture. Même règle que
 * litToutesLesAffaires côté serveur.
 */
export function litToutesLesAffaires(role?: string | null): boolean {
  return isAdminRole(role) || role === ROLE_ASSISTANTE_TECHNIQUE;
}

/**
 * Capacités de la gestion « comme l'administration » ouvertes à l'assistante technique par la deuxième PR de
 * son lot (AT-2a ; décision de Nelson du 24-10-2026, point 24, pour les clients ; réponses du 06-11-2026, 3, 4,
 * 5, 8 et 9). Chacune est le miroir exact d'une aide
 * du serveur (server/src/droits/roles.ts), nommée à sa suite ; ce qui reste à l'administration garde isAdminRole.
 *
 * Gestion des clients : écritures de la fiche, des contacts et des sites, désactivation, et lecture du parc
 * installé. L'écriture du parc et le catalogue restent à l'administration. Même règle que gereLesClients
 * côté serveur.
 */
export function gereLesClients(role?: string | null): boolean {
  return isAdminRole(role) || role === ROLE_ASSISTANTE_TECHNIQUE;
}

/**
 * Gestion des contrats de maintenance (liste, statut, visites, passage manuel de la génération, PDF, envois,
 * journal) et conversion d'un devis en contrat. La création hors devis, la couverture et le réglage de
 * l'anticipation restent à l'administration. Même règle que gereLesContrats côté serveur.
 */
export function gereLesContrats(role?: string | null): boolean {
  return isAdminRole(role) || role === ROLE_ASSISTANTE_TECHNIQUE;
}

/**
 * Écran des contrats de maintenance : l'administration et l'assistante technique, même liste pour le menu
 * et la route /contrats-maintenance (cf. gereLesContrats).
 */
export const ROLES_CONTRATS = [...TYPES_ADMINISTRATION, ROLE_ASSISTANTE_TECHNIQUE];

/**
 * Prix d'achat prévu des lignes de devis (lecture et écriture) et, en lecture, celui des fiches du catalogue
 * et du parc : l'administration et l'assistante technique (réponses 4 et 8 : « Prix d'achat oui, coûts
 * non »), jamais le taux horaire ni le coût de main-d'œuvre. Miroir de litEtEcritPrixAchatDevis côté serveur.
 */
export function voitPrixAchatDevis(role?: string | null): boolean {
  return isAdminRole(role) || role === ROLE_ASSISTANTE_TECHNIQUE;
}

/**
 * Chantiers en cours : ouverture d'un chantier avec ses attributions (titulaire, commercial, types, date de
 * début ; réponse 5), depuis l'onglet Administration > Chantiers. La clôture, la réouverture et
 * l'encaissement restent à l'administration. Même règle que gereLesChantiersEnCours côté serveur.
 */
export function gereLesChantiersEnCours(role?: string | null): boolean {
  return isAdminRole(role) || role === ROLE_ASSISTANTE_TECHNIQUE;
}

/** Accès interface aux devis ; le serveur applique toujours la permission réelle. */
export function peutAccederAuxDevis(user?: CurrentUser | null): boolean {
  return !!user && (isSuperAdminRole(user.role) || (user.permissions || []).includes('devis:read'));
}
