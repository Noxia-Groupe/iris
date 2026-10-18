import express from 'express';
import { ROLE_TECHNICIEN, isAdminRole } from './roles';
import type { AuthRequest } from '../http/auth';
import type { ApiRequest } from '../http/cles-api';

// Montants d'un chantier — budgets matériel et main-d'œuvre, coûts réels (achats, main-d'œuvre,
// totaux), taux horaires — et alertes de dépassement de budget : jamais montrés au technicien
// (décisions de Nelson du 13-10-2026). Il garde le chantier, ses heures vendues et réalisées et
// l'alerte d'absence de saisie. Les autres profils voient ces montants dans leur périmètre ;
// une clé d'intégration garde son accès inchangé (scope chantiers:read).
export function voitMontantsChantier(req: express.Request): boolean {
  if ((req as ApiRequest).apiKey) return true;
  return (req as AuthRequest).user?.role !== ROLE_TECHNICIEN;
}

// Clés monétaires des saisies (achats, pointages, intervenants), y compris dans les
// instantanés du journal des saisies.
const CLES_MONTANTS_SAISIE = ['montantHT', 'tauxHoraireApplique', 'tauxHoraireCharge'] as const;

export function sansMontantsSaisie<T>(valeur: T): T {
  if (!valeur || typeof valeur !== 'object' || Array.isArray(valeur)) return valeur;
  const copie: Record<string, unknown> = { ...(valeur as Record<string, unknown>) };
  for (const cle of CLES_MONTANTS_SAISIE) if (cle in copie) delete copie[cle];
  if (copie.intervenant) copie.intervenant = sansMontantsSaisie(copie.intervenant);
  return copie as T;
}

// Taux horaires et coût de main-d'œuvre : réservés à l'administration (décision de Nelson du
// 13-10-2026, précisée le 16-10-2026). Les autres comptes gardent les heures, jamais un montant
// horaire, ni le coût de main-d'œuvre ni un total qui l'inclut, d'où l'on retrouverait le taux.
// Les destinataires de la rentabilité gardent la marge du jour, la marge estimée et les alertes.
// Une clé d'intégration garde son accès inchangé (scope chantiers:read).
export function voitCoutMainOeuvre(req: express.Request): boolean {
  if ((req as ApiRequest).apiKey) return true;
  return isAdminRole((req as AuthRequest).user?.role);
}

const CLES_TAUX_HORAIRE = ['tauxHoraireApplique', 'tauxHoraireCharge'] as const;

export function sansTauxHoraire<T>(valeur: T): T {
  if (!valeur || typeof valeur !== 'object' || Array.isArray(valeur)) return valeur;
  const copie: Record<string, unknown> = { ...(valeur as Record<string, unknown>) };
  for (const cle of CLES_TAUX_HORAIRE) if (cle in copie) delete copie[cle];
  if (copie.intervenant) copie.intervenant = sansTauxHoraire(copie.intervenant);
  return copie as T;
}

// Masquage d'une saisie (achat, pointage, intervenant, instantané du journal) selon le
// demandeur : rien au technicien, ni taux ni coût horaire aux autres comptes non administrateurs.
export function saisieSelonDroits(req: express.Request): <T>(valeur: T) => T {
  if (!voitMontantsChantier(req)) return sansMontantsSaisie;
  if (!voitCoutMainOeuvre(req)) return sansTauxHoraire;
  return (valeur) => valeur;
}
