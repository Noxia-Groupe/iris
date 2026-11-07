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
// ASSISTANTE_TECHNIQUE : « Les droit de toute la partie technique », sur toute la société (décisions de Nelson
// du 24-10-2026, points 15, 16, 18 et 28, et section « lots prévus », point 2), sans les droits de
// l'administration : elle n'entre pas dans TYPES_ADMINISTRATION. Ses capacités sont ajoutées une à une aux aides
// qui les décident (voitToutLeSav, estEncadrementCoutIntervention, estEncadrementSuivi, litToutesLesAffaires).
// Distincte de l'assistante commerciale, qui reste sans planning (point 15).
export const ROLE_ASSISTANTE_TECHNIQUE = 'ASSISTANTE_TECHNIQUE';
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
// par les aides de capacité (périmètre SAV, écrans). L'assistante technique a ses propres capacités, sans
// élargir cette liste (cf. ROLE_ASSISTANTE_TECHNIQUE).
export const TYPES_ADMINISTRATION: readonly string[] = [ROLE_SUPERADMIN, 'ADMIN', ROLE_DIRECTEUR];

export function isAdminRole(role: string | undefined | null): boolean {
  return !!role && TYPES_ADMINISTRATION.includes(role);
}
export function isSuperAdminRole(role: string | undefined | null): boolean {
  return role === ROLE_SUPERADMIN;
}

// Capacité « lit toutes les affaires » (liste, fiche, journal des saisies, journaux des achats et des heures,
// historique client, tableau de bord) : l'administration, et l'assistante technique, qui travaille sur toute
// la société. Ce que la fiche en montre
// (rentabilité, coût prévu, taux et coût de main-d'œuvre) reste décidé à part (voitRentabilite,
// voitCoutPrevuParPrixAchat, voitCoutMainOeuvre), et cette lecture n'ouvre aucune écriture.
export function litToutesLesAffaires(role: string | undefined | null): boolean {
  return isAdminRole(role) || role === ROLE_ASSISTANTE_TECHNIQUE;
}

// Capacités de la gestion « comme l'administration » ouvertes à l'assistante technique par la deuxième PR
// de son lot (AT-2a ; réponses de Nelson du 06-11-2026, 3, 4, 5, 8 et 9). Chacune nomme ce qu'elle ouvre ;
// ce qui reste à l'administration garde isAdminRole.
// - gereLesClients : écritures des clients (fiche, contacts, sites, désactivation) et lecture du parc ;
//   l'écriture du parc et le catalogue restent à l'administration.
export function gereLesClients(role: string | undefined | null): boolean {
  return isAdminRole(role) || role === ROLE_ASSISTANTE_TECHNIQUE;
}
// - gereLesContrats : contrats de maintenance (liste, fiche, statut, visites, génération, PDF, envois, journal)
//   et conversion d'un devis en contrat ; création hors devis, couverture et réglages restent à l'administration.
export function gereLesContrats(role: string | undefined | null): boolean {
  return isAdminRole(role) || role === ROLE_ASSISTANTE_TECHNIQUE;
}
// - litEtEcritPrixAchatDevis : prix d'achat prévu des lignes de devis (lecture et écriture), et, en lecture,
//   celui des fiches du catalogue et du parc ; jamais le taux horaire ni le coût de main-d'œuvre.
export function litEtEcritPrixAchatDevis(role: string | undefined | null): boolean {
  return isAdminRole(role) || role === ROLE_ASSISTANTE_TECHNIQUE;
}
// - gereLesChantiersEnCours : ouverture d'un chantier avec ses attributions (titulaire, commercial, types, date
//   de début), réponse 5 ; clôture, réouverture et encaissement restent à l'administration.
export function gereLesChantiersEnCours(role: string | undefined | null): boolean {
  return isAdminRole(role) || role === ROLE_ASSISTANTE_TECHNIQUE;
}
// Coût matériel prévu d'un chantier qui suit sa rentabilité, et non la lecture des prix d'achat prévus des
// devis : le directeur (réponse de Nelson du 06-11-2026, « Chantiers seulement ») et l'assistante technique,
// qui lisent ces prix mais dont un réglage décide de la rentabilité des chantiers (choix par défaut, à confirmer).
export function coutPrevuSuitRentabilite(role: string | undefined | null): boolean {
  return role === ROLE_DIRECTEUR || role === ROLE_ASSISTANTE_TECHNIQUE;
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
