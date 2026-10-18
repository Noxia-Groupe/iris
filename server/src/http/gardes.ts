import express from 'express';
import type { AuthRequest } from './auth';
import { ROLE_DIRECTEUR, ROLE_RESPONSABLE, ROLE_TECHNICIEN, isAdminRole, isSuperAdminRole } from '../droits/roles';

export const requireAdmin: express.RequestHandler = (req, res, next) => {
  if (!isAdminRole((req as AuthRequest).user?.role)) {
    res.status(403).json({ error: 'Accès réservé aux administrateurs' });
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
// globales/conducteur — uniquement à son propre résultat commercial.
// Le directeur en est exclu de la même façon : il pilote depuis la liste, le tableau de bord
// et les fiches chantier, sans saisie, planning, SAV ni référentiel à modifier.
export const blockCommercial: express.RequestHandler = (req, res, next) => {
  const role = (req as AuthRequest).user?.role;
  if (role === 'COMMERCIAL') {
    res.status(403).json({ error: 'Accès non autorisé pour un compte commercial.' });
    return;
  }
  if (role === ROLE_DIRECTEUR) {
    res.status(403).json({ error: 'Accès non autorisé pour un compte directeur.' });
    return;
  }
  next();
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
