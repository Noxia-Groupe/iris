import express from 'express';
import type { AuthRequest } from './auth';
import { ROLE_ASSISTANTE_COMMERCIALE, ROLE_COMPTABLE, ROLE_DIRECTEUR_COMMERCIAL, ROLE_RESPONSABLE, ROLE_TECHNICIEN, gereLesClients, gereLesContrats, isAdminRole, isSuperAdminRole } from '../droits/roles';

export const requireAdmin: express.RequestHandler = (req, res, next) => {
  if (!isAdminRole((req as AuthRequest).user?.role)) {
    res.status(403).json({ error: 'Accès réservé aux administrateurs' });
    return;
  }
  next();
};

// Gestion des clients et des contrats de maintenance : l'administration et l'assistante technique (réponses
// de Nelson du 06-11-2026, 3 et 9 ; cf. gereLesClients, gereLesContrats). Le refus le dit en clair.
export const REFUS_GESTION_ADMINISTRATION_ASSISTANTE = 'Accès réservé à l’administration et à l’assistante technique.';
export const requireGestionClients: express.RequestHandler = (req, res, next) => {
  if (!gereLesClients((req as AuthRequest).user?.role)) {
    res.status(403).json({ error: REFUS_GESTION_ADMINISTRATION_ASSISTANTE });
    return;
  }
  next();
};
export const requireGestionContrats: express.RequestHandler = (req, res, next) => {
  if (!gereLesContrats((req as AuthRequest).user?.role)) {
    res.status(403).json({ error: REFUS_GESTION_ADMINISTRATION_ASSISTANTE });
    return;
  }
  next();
};

// Réglages réservés au superadmin (modules de l'application, comptes superadmin).
export const requireSuperAdmin: express.RequestHandler = (req, res, next) => {
  if (!isSuperAdminRole((req as AuthRequest).user?.role)) {
    res.status(403).json({ error: 'Accès réservé au super administrateur' });
    return;
  }
  next();
};

// Statistiques Travaux : administration globale, responsable équipe déclarée, conducteur périmètre propre.
export const requireTravauxRead: express.RequestHandler = (req, res, next) => {
  const role = (req as AuthRequest).user?.role;
  if (isAdminRole(role) || role === ROLE_RESPONSABLE || role === 'CONDUCTEUR_TRAVAUX') return next();
  res.status(403).json({ error: 'Accès réservé au suivi Travaux.' });
};

// Un commercial a un accès strictement en lecture à ses propres chantiers : ni création,
// ni modification (chantiers, achats, heures), et pas d'accès aux statistiques
// globales/conducteur — uniquement à son propre résultat commercial. Le directeur, qui en était
// exclu de la même façon, a désormais les droits de l'administration (décision de Nelson du
// 24-10-2026, point 14).
export const blockCommercial: express.RequestHandler = (req, res, next) => {
  const role = (req as AuthRequest).user?.role;
  if (role === 'COMMERCIAL') {
    res.status(403).json({ error: 'Accès non autorisé pour un compte commercial.' });
    return;
  }
  next();
};

// Planning (lectures comprises) et écritures des référentiels des achats : le directeur commercial,
// l'assistante commerciale et le comptable en sont refusés comme le commercial (décision 11 de la
// proposition de droits, #179, placée avant la fin du pilote par Nelson le 21-10-2026). Rien ne les
// y prévoit, et ils ne consultent que les chantiers dont ils sont titulaires. Le message nomme le
// type de compte, comme pour le commercial. Ailleurs (fiche chantier, SAV),
// blockCommercial seul s'applique jusqu'à l'harmonisation des droits (lot D2).
const TYPES_SANS_PLANNING_NI_REFERENTIELS: Record<string, string> = {
  [ROLE_DIRECTEUR_COMMERCIAL]: 'directeur commercial',
  [ROLE_ASSISTANTE_COMMERCIALE]: 'assistante commerciale',
  [ROLE_COMPTABLE]: 'comptable',
};
export const blockCommercialEtAssimiles: express.RequestHandler = (req, res, next) => {
  const libelle = TYPES_SANS_PLANNING_NI_REFERENTIELS[(req as AuthRequest).user?.role ?? ''];
  if (libelle) {
    res.status(403).json({ error: `Accès non autorisé pour un compte ${libelle}.` });
    return;
  }
  blockCommercial(req, res, next);
};

// Le technicien n'écrit que dans ses propres interventions (lot pilote 3, choix par défaut) : ni
// le planning de l'équipe (affectations, types d'événement, placement d'une intervention, y compris
// la sienne), ni les référentiels des achats (catégories, fournisseurs). Il garde la lecture.
export const blockTechnicien: express.RequestHandler = (req, res, next) => {
  if ((req as AuthRequest).user?.role === ROLE_TECHNICIEN) {
    res.status(403).json({ error: 'Un technicien ne modifie ni le planning ni les référentiels.' });
    return;
  }
  next();
};
