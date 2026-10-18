import express from 'express';
import { prisma } from '../../db';
import { isSuperAdminRole } from '../../droits/roles';
import type { AuthRequest } from '../../http/auth';
import { dateIsoStricte } from '../../commun/dates';
import { getParametres } from '../parametres/metier';

// Module Planning : quand un SUPERADMIN le désactive (Parametres.planningActif = false),
// il disparaît pour TOUS les autres comptes, administrateurs compris. Le blocage est ici,
// côté serveur — masquer le menu côté client ne serait qu'un habillage, l'API resterait
// appelable. Les données ne sont jamais supprimées : la réactivation restitue le planning
// tel quel. Ne s'applique pas au lien de partage public (cf. GET /api/planning/public/:token),
// qui garde son propre interrupteur (PlanningPublicShare.active).
export const requirePlanningActif: express.RequestHandler = async (req, res, next) => {
  try {
    if (isSuperAdminRole((req as AuthRequest).user?.role)) return next();
    const { planningActif } = await getParametres();
    if (!planningActif) {
      res.status(403).json({ code: 'PLANNING_DESACTIVE', error: "Le module Planning est désactivé par l'administration." });
      return;
    }
    next();
  } catch (error) {
    res.status(500).json({ error: 'Error checking planning module' });
  }
};

// --- Planning d'intervention (module réservé aux administrateurs) ---
// Affectation PRÉVISIONNELLE des techniciens : sur un chantier suivi, sur un chantier ou
// une intervention non suivi (ex: SAV — nom et client saisis librement), ou sur
// un événement personnalisé (type réutilisable avec couleur). Aucun lien avec les heures
// réelles : le planning n'écrit jamais dans PointageHeure — les heures des chantiers
// restent saisies manuellement dans le Journal des Heures.

const PLANNING_CATEGORIES = ['CHANTIER', 'HORS_CHANTIER', 'EVENEMENT'];
const PLANNING_CRENEAUX = ['JOURNEE', 'MATIN', 'APRES_MIDI', 'HEURES'];

// Jour du planning : on ne stocke que la date (minuit UTC), jamais d'heure — le créneau
// horaire éventuel est porté par creneau/heureDebut/heureFin. Même lecture que les autres
// dates métier (dateIsoStricte) : JJ-MM-AAAA ou AAAA-MM-JJ, sans débordement (30 février).
export function parsePlanningJour(value: unknown): Date | null {
  const date = dateIsoStricte(value);
  return date ? new Date(date) : null;
}

function parsePlanningHeure(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
}

export function parsePlanningCouleur(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}

export const PLANNING_EVENT_INCLUDE = {
  chantier: { select: { id: true, nom: true, client: true, statut: true, adresse: true } },
  typeEvent: true,
  intervenants: { select: { id: true, nom: true, role: true } },
} as const;

// Valide le contenu complet d'une affectation (à la création comme à l'édition : le PATCH
// fusionne le corps reçu avec l'existant puis revalide le tout — mêmes règles partout).
// Retourne { error } ou { data, intervenantIds } prêts pour Prisma. Les champs des autres
// catégories sont systématiquement remis à null : changer une affectation de catégorie ne
// laisse jamais traîner un chantier ou un type d'événement orphelin.
export async function validatePlanningEvent(body: Record<string, unknown>): Promise<{ error?: string; data?: Record<string, unknown>; intervenantIds?: string[] }> {
  const categorie = String(body.categorie || '');
  if (!PLANNING_CATEGORIES.includes(categorie)) return { error: 'Catégorie invalide.' };

  const dateDebut = parsePlanningJour(body.dateDebut);
  if (!dateDebut) return { error: 'Date de début invalide.' };
  const dateFin = body.dateFin ? parsePlanningJour(body.dateFin) : dateDebut;
  if (!dateFin) return { error: 'Date de fin invalide.' };
  if (dateFin < dateDebut) return { error: 'La date de fin doit être postérieure ou égale à la date de début.' };

  const creneau = PLANNING_CRENEAUX.includes(String(body.creneau)) ? String(body.creneau) : 'JOURNEE';
  let heureDebut: string | null = null;
  let heureFin: string | null = null;
  if (creneau === 'HEURES') {
    heureDebut = parsePlanningHeure(body.heureDebut);
    heureFin = parsePlanningHeure(body.heureFin);
    if (!heureDebut || !heureFin) return { error: 'Heure de début et heure de fin requises (format HH:MM).' };
    if (heureFin <= heureDebut) return { error: "L'heure de fin doit être postérieure à l'heure de début." };
  }

  const intervenantIds = [...new Set((Array.isArray(body.intervenantIds) ? body.intervenantIds : []).map(String))];
  if (intervenantIds.length === 0) return { error: 'Sélectionnez au moins un technicien.' };
  const nbTrouves = await prisma.intervenant.count({ where: { id: { in: intervenantIds } } });
  if (nbTrouves !== intervenantIds.length) return { error: 'Un des techniciens sélectionnés est introuvable.' };

  const data: Record<string, unknown> = {
    categorie, dateDebut, dateFin, creneau, heureDebut, heureFin,
    commentaire: String(body.commentaire || '').trim() || null,
    chantierId: null, titre: null, client: null, adresse: null, typeEventId: null,
  };

  if (categorie === 'CHANTIER') {
    const chantier = await prisma.chantier.findUnique({ where: { id: String(body.chantierId || '') } });
    if (!chantier) return { error: 'Chantier introuvable.' };
    data.chantierId = chantier.id;
  } else if (categorie === 'HORS_CHANTIER') {
    const titre = String(body.titre || '').trim();
    if (!titre) return { error: "Saisissez le nom du chantier ou de l'intervention." };
    data.titre = titre;
    data.client = String(body.client || '').trim() || null;
    // Adresse du site (facultative), saisie librement : contrairement à categorie
    // CHANTIER, il n'existe pas de fiche chantier à côté de laquelle la stocker — elle
    // vit uniquement sur cette affectation.
    data.adresse = String(body.adresse || '').trim() || null;
  } else {
    const typeEvent = await prisma.planningEventType.findUnique({ where: { id: String(body.typeEventId || '') } });
    if (!typeEvent) return { error: "Type d'événement introuvable." };
    data.typeEventId = typeEvent.id;
  }

  return { data, intervenantIds };
}
