import express from 'express';
import { ROLE_TECHNICIEN, ROLE_RESPONSABLE, ROLE_DIRECTEUR, isAdminRole, isSuperAdminRole } from '../../droits/roles';
import { requirePermission } from '../../droits/permissions';
import { voitMontantsChantier, sansMontantsSaisie, sansTauxHoraire } from '../../droits/visibilite';
import type { AuthRequest } from '../../http/auth';
import type { ApiRequest } from '../../http/cles-api';
import { type Parametres, getParametres } from '../parametres/metier';

// Rentabilité d'un chantier — montant vendu global, marge du jour, marge estimée, alertes
// « en perte » et « marge faible », facturation de la fiche : elle ne sort que pour ses
// destinataires, décidés chantier par chantier. Les budgets par poste, eux, restent visibles
// (suivi des dépassements), sauf du technicien, à qui aucun montant n'est montré (cf.
// voitMontantsChantier), et permettent d'en déduire le vendu, donc la marge du jour.
// Côté clé d'intégration, le scope finances:read. Côté session :
//  - un administrateur, toujours ;
//  - un directeur, si la société laisse les directeurs destinataires ;
//  - le conducteur (ou responsable) du chantier, si elle laisse le conducteur destinataire ;
//  - un responsable dont la branche hiérarchique contient ce conducteur, à tout niveau, si
//    elle laisse la chaîne hiérarchique destinataire.
// Personne d'autre : ni le commercial (il a son Résultat commercial), ni le technicien, ni un
// rôle à qui la société a retiré ces informations. Le chantier doit en outre être dans le
// périmètre du demandeur — cette fonction ne décide que de ce qui en est montré.
export function voitRentabilite(req: express.Request, chantier: { responsableId?: string | null }, params: Parametres): boolean {
  const cle = (req as ApiRequest).apiKey;
  if (cle) return cle.scopes.includes('finances:read');
  const user = (req as AuthRequest).user;
  if (!user) return false;
  if (isAdminRole(user.role)) return true;
  if (user.role === ROLE_DIRECTEUR) return params.rentabiliteDirecteurs;
  const responsableId = chantier.responsableId;
  if (!responsableId) return false;
  if (responsableId === user.id && (user.role === 'CONDUCTEUR_TRAVAUX' || user.role === ROLE_RESPONSABLE)) return params.rentabiliteConducteur;
  if (user.role === ROLE_RESPONSABLE && user.equipeIds.includes(responsableId)) return params.rentabiliteHierarchie;
  return false;
}

const ALERTES_DEPASSEMENT = new Set(['MATERIEL_DEPASSE', 'MAIN_OEUVRE_DEPASSEE', 'HEURES_DEPASSEES']);
// Chantier sérialisé, vu par un compte non administrateur : ni taux, ni coût de main-d'œuvre, ni
// total qui l'inclut. Le pourcentage du budget main-d'œuvre consommé redonnerait ce coût, et les
// hypothèses de la marge estimée un coût horaire. Les marges et les alertes restent.
export function chantierSansCoutMainOeuvre(c: any) {
  const estimation = c.metrics?.estimation;
  return {
    ...c,
    ...(Array.isArray(c.pointages) ? { pointages: c.pointages.map(sansTauxHoraire) } : {}),
    ...(c.metrics ? { metrics: {
      ...c.metrics,
      moReel: null, totalDepenses: null, pctMainOeuvre: null,
      ...(c.metrics.coutsSuites ? { coutsSuites: { ...c.metrics.coutsSuites, coutMainOeuvre: null } } : {}),
      ...(estimation ? { estimation: { ...estimation, coutEstime: null, coutMainOeuvreAttendu: null, coutHoraireReference: null } } : {}),
    } } : {}),
  };
}

// Chantier sérialisé, vu par un technicien : budgets par poste, coûts, taux et alertes de
// dépassement retirés ; le pourcentage de consommation redonnerait un budget à partir du réel.
export function chantierSansMontants(c: any) {
  return {
    ...c,
    budgetMaterielVendu: null,
    budgetMainOeuvreVendu: null,
    ...(Array.isArray(c.achats) ? { achats: c.achats.map(sansMontantsSaisie) } : {}),
    ...(Array.isArray(c.pointages) ? { pointages: c.pointages.map(sansMontantsSaisie) } : {}),
    ...(c.metrics ? { metrics: {
      ...c.metrics,
      materielReel: null, moReel: null, totalDepenses: null, pctMateriel: null, pctMainOeuvre: null,
      ...(c.metrics.coutsSuites ? { coutsSuites: { ...c.metrics.coutsSuites, coutMainOeuvre: null, materiel: null } } : {}),
      alertes: (c.metrics.alertes ?? []).filter((alerte: string) => !ALERTES_DEPASSEMENT.has(alerte)),
    } } : {}),
  };
}

export const REFUS_TECHNICIEN_MODIFICATION = 'Un compte technicien n’est pas autorisé à modifier une affaire. Adressez-vous à votre responsable.';
export const REFUS_TECHNICIEN_COMMERCIAL = 'Un compte technicien n’est pas autorisé à réattribuer le commercial d’une affaire. Adressez-vous à votre responsable.';
export const REFUS_TECHNICIEN_CLOTURE = 'Un compte technicien n’est pas autorisé à clôturer une affaire : la clôture revient à un compte Responsable de sa branche, à la direction ou à l’administration.';

// Clôture d'une affaire en cours : l'administration et les directeurs, sur tout chantier
// (décision de Nelson du 14-10-2026) ; son responsable s'il n'est pas technicien (un conducteur
// clôture l'affaire dont il est chargé) ; et, pour l'affaire d'un technicien, les comptes
// Responsable dont la branche le contient.
export function peutCloturerChantier(user: AuthRequest['user'], chantier: { responsableId: string | null; responsableRole?: string | null }): boolean {
  if (!user) return false;
  if (isAdminRole(user.role) || user.role === ROLE_DIRECTEUR) return true;
  if (user.role === 'COMMERCIAL' || user.role === ROLE_TECHNICIEN) return false;
  if (chantier.responsableId === user.id) return true;
  return user.role === ROLE_RESPONSABLE && !!chantier.responsableId
    && chantier.responsableRole === ROLE_TECHNICIEN && user.equipeIds.includes(chantier.responsableId);
}

// Réponse d'une écriture sur un chantier : même masquage qu'en lecture (montant vendu selon
// voitRentabilite, budgets par poste selon voitMontantsChantier), pour qu'un enregistrement
// renvoyé tel quel ne contourne pas ces règles.
export async function chantierSelonRentabilite<T extends { responsableId: string | null; budgetGlobalVendu: unknown; budgetMaterielVendu: unknown; budgetMainOeuvreVendu: unknown }>(req: express.Request, chantier: T) {
  const sansVendu = voitRentabilite(req, chantier, await getParametres()) ? chantier : { ...chantier, budgetGlobalVendu: null };
  return voitMontantsChantier(req) ? sansVendu : { ...sansVendu, budgetMaterielVendu: null, budgetMainOeuvreVendu: null };
}

// Accès aux données financières : accordé au cas par cas, indépendamment du rôle
// (User.accesFinance, case « Finance » dans Administration > Utilisateurs). Un superadmin
// y accède toujours, sans avoir besoin de la case.
//
// L'autorisation est conservée bien qu'aucun écran ne l'utilise aujourd'hui : elle est
// native à Iris — pas héritée de l'intégration retirée — et c'est elle qui gardera la
// facturation (phase 8) puis les paiements et le rapprochement bancaire (phase 9). La
// retirer imposerait de supprimer la colonne pour la recréer à l'identique deux phases
// plus loin, en perdant au passage les droits déjà accordés aux utilisateurs.
export function peutVoirFinance(user: { role: string; accesFinance?: boolean | null } | undefined): boolean {
  // Jamais pour un technicien, qui ne voit aucun montant (cf. DROITS_INTERDITS_TECHNICIEN).
  if (user?.role === ROLE_TECHNICIEN) return false;
  return !!user && (isSuperAdminRole(user.role) || !!user.accesFinance);
}

// Saisie/correction et archivage sont volontairement séparés : une correction conserve la
// ligne active, alors qu'un archivage la retire des coûts et marges courants.
export const requireTravauxWrite = requirePermission('chantiers:write');
export const requireTravauxArchive = requirePermission('chantiers:archive');
