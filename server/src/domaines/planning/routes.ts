import express from 'express';
import type { Express } from 'express';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma, transactionVerifiee } from '../../db';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { blockCommercial, blockTechnicien, requireAdmin } from '../../http/gardes';
import { ROLE_TECHNICIEN } from '../../droits/roles';
import { perimetreChantiers } from '../../droits/perimetres';
import { paramId } from '../../http/requete';
import { FUSEAU_HORAIRE_PAR_DEFAUT, aujourdHuiEntreprise, ajouterJoursCivils } from '../../commun/dates';
import { journaliserAdministration, verrouillerReglage } from '../../commun/journal-administration';
import { getCompanySettings } from '../administration/metier';
import { getInterventionFilterForUser, synchroniserAffectationsIntervention } from '../interventions/metier';
import { requirePlanningActif, parsePlanningJour, parsePlanningCouleur, PLANNING_EVENT_INCLUDE, validatePlanningEvent } from './metier';

// --- Partage public du planning (lien type "OneDrive", sans authentification) ---
// Un seul lien actif à la fois (ligne singleton) : les techniciens, qui n'ont pas de
// compte dans l'application, y accèdent en LECTURE SEULE via GET /api/planning/public/:token.
// Le token ne change qu'à la régénération volontaire par un administrateur (bouton
// "Renouveler le lien") ; `active` permet de couper l'accès sans en générer un nouveau
// (bouton "Désactiver le partage"), en conservant le même token pour une réactivation
// ultérieure avec le lien déjà communiqué.
function generateShareToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function paramToken(req: express.Request): string {
  const t = req.params.token;
  return Array.isArray(t) ? t[0] : t;
}

function serializeShare(share: { token: string; active: boolean; updatedAt: Date } | null) {
  return {
    published: !!share,
    active: !!share?.active,
    token: share?.token || null,
    updatedAt: share?.updatedAt?.toISOString() || null,
  };
}

export function enregistrerRoutesPlanning(app: Express): void {
  // Liste des chantiers pour peupler le sélecteur "Chantier suivi" du planning — TOUS les
  // chantiers (pas seulement ceux du conducteur connecté, contrairement à GET /api/chantiers) :
  // le planning est un outil d'équipe partagé entre conducteurs, il faut pouvoir y affecter un
  // technicien sur n'importe quel chantier en cours, pas seulement les siens. N'affecte en rien
  // la visibilité des chantiers ailleurs dans l'application (Liste des Chantiers, Tableau de
  // bord...), qui reste strictement scoped par responsable pour un conducteur.
  // Le technicien ne crée pas d'affectation : cette liste, qui ne sert qu'au formulaire d'affectation,
  // lui est fermée (planning limité à ce dont il est chargé, décision de Nelson du 19-10-2026).
  app.get('/api/planning/chantiers', requireAuth, blockCommercial, requirePlanningActif, async (req: AuthRequest, res) => {
    if (req.user!.role === ROLE_TECHNICIEN) return res.status(403).json({ error: 'La liste des chantiers du planning sert à créer une affectation : elle n’est pas ouverte au technicien.' });
    try {
      const chantiers = await prisma.chantier.findMany({
        select: { id: true, nom: true, client: true, statut: true },
        orderBy: { nom: 'asc' },
      });
      res.json(chantiers);
    } catch (error) {
      res.status(500).json({ error: 'Error fetching planning chantiers' });
    }
  });

  // Affectations chevauchant la plage de jours [start, end] (bornes incluses).
  app.get('/api/planning/events', requireAuth, blockCommercial, requirePlanningActif, async (req: AuthRequest, res) => {
    try {
      const start = parsePlanningJour(req.query.start);
      const end = parsePlanningJour(req.query.end);
      if (!start || !end) return res.status(400).json({ error: 'Plage de dates invalide (start et end requis, au format JJ-MM-AAAA ou AAAA-MM-JJ).' });
      // Le technicien lit les affectations dont il est chargé, par la fiche intervenant reliée à son
      // compte (décision de Nelson du 19-10-2026), et celles des chantiers dont il est titulaire, quel
      // que soit l'intervenant (décision du 21-10-2026). Le chantier est pris dans son périmètre de
      // lecture : une affaire annulée en sort. Une projection SAV n'est jamais rattachée à un chantier
      // ici : elle reste soumise au périmètre du dossier. Sans fiche ni chantier, rien.
      const chargeDe = req.user!.role === ROLE_TECHNICIEN ? [{ OR: [
        { intervenants: { some: { userId: req.user!.id } } },
        { chantier: { is: perimetreChantiers(req) } },
      ] }] : [];
      const events = await prisma.planningEvent.findMany({
        where: { dateDebut: { lte: end }, dateFin: { gte: start }, OR: [
          { interventionId: null }, { intervention: { is: getInterventionFilterForUser(req.user!) } },
        ], AND: chargeDe },
        include: PLANNING_EVENT_INCLUDE,
        orderBy: [{ dateDebut: 'asc' }, { createdAt: 'asc' }],
      });
      res.json(events);
    } catch (error) {
      res.status(500).json({ error: 'Error fetching planning events' });
    }
  });

  app.post('/api/planning/events', requireAuth, blockCommercial, blockTechnicien, requirePlanningActif, async (req, res) => {
    try {
      const { error, data, intervenantIds } = await validatePlanningEvent(req.body);
      if (error) return res.status(400).json({ error });
      const event = await prisma.planningEvent.create({
        data: { ...data, intervenants: { connect: intervenantIds!.map((id) => ({ id })) } } as never,
        include: PLANNING_EVENT_INCLUDE,
      });
      res.status(201).json(event);
    } catch (error) {
      res.status(500).json({ error: 'Error creating planning event' });
    }
  });

  // Édition complète ou déplacement (glisser-déposer) : fusion existant + corps reçu,
  // puis revalidation de l'ensemble — cf. validatePlanningEvent.
  app.patch('/api/planning/events/:id', requireAuth, blockCommercial, blockTechnicien, requirePlanningActif, async (req: AuthRequest, res) => {
    try {
      const existing = await prisma.planningEvent.findUnique({
        where: { id: paramId(req) },
        include: { intervenants: { select: { id: true } } },
      });
      if (!existing) return res.status(404).json({ error: 'Affectation introuvable.' });
      if (existing.interventionId) {
        const autorisee = await prisma.intervention.findFirst({ where: { id: existing.interventionId, ...getInterventionFilterForUser(req.user!) }, select: { id: true, statut: true } });
        if (!autorisee) return res.status(404).json({ error: 'Affectation introuvable.' });
        if (['TERMINEE', 'ANNULEE'].includes(autorisee.statut)) return res.status(409).json({ error: 'Cette intervention ne peut plus être planifiée.' });
        if (['categorie', 'titre', 'client', 'chantierId', 'typeEventId', 'interventionId'].some(cle => cle in req.body)) {
          return res.status(400).json({ error: 'La projection liée conserve les données de son intervention.' });
        }
      }

      const merged = {
        categorie: existing.categorie,
        dateDebut: existing.dateDebut.toISOString(),
        dateFin: existing.dateFin.toISOString(),
        creneau: existing.creneau,
        heureDebut: existing.heureDebut,
        heureFin: existing.heureFin,
        chantierId: existing.chantierId,
        titre: existing.titre,
        client: existing.client,
        adresse: existing.adresse,
        typeEventId: existing.typeEventId,
        commentaire: existing.commentaire,
        intervenantIds: existing.intervenants.map((i) => i.id),
        ...req.body,
      };
      const { error, data, intervenantIds } = await validatePlanningEvent(merged);
      if (error) return res.status(400).json({ error });
      const event = await transactionVerifiee(async (tx) => {
        if (existing.interventionId) {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Intervention" WHERE "id" = ${existing.interventionId} FOR UPDATE`);
          const autorisee = await tx.intervention.findFirst({ where: { id: existing.interventionId, ...getInterventionFilterForUser(req.user!) }, include: { client: { select: { raisonSociale: true } } } });
          if (!autorisee) throw new Error('INTERVENTION_HORS_PERIMETRE');
          if (['TERMINEE', 'ANNULEE'].includes(autorisee.statut)) throw new Error('INTERVENTION_NON_PLANIFIABLE');
          const projection = await tx.planningEvent.findUnique({ where: { id: existing.id }, select: { interventionId: true } });
          if (projection?.interventionId !== autorisee.id) throw new Error('INTERVENTION_HORS_PERIMETRE');
          // Les champs de source ne proviennent jamais du corps ni de l'ancienne projection.
          data!.categorie = 'HORS_CHANTIER';
          data!.titre = autorisee.titre;
          data!.client = autorisee.client.raisonSociale;
          data!.chantierId = null;
          data!.typeEventId = null;
        }
        const updated = await tx.planningEvent.update({
          where: { id: existing.id },
          data: { ...data, intervenants: { set: intervenantIds!.map((id) => ({ id })) } } as never,
          include: PLANNING_EVENT_INCLUDE,
        });
        if (existing.interventionId) await synchroniserAffectationsIntervention(tx, existing.interventionId, intervenantIds!);
        return updated;
      });
      res.json(event);
    } catch (error) {
      if ((error as Error).message === 'INTERVENTION_HORS_PERIMETRE') return res.status(404).json({ error: 'Affectation introuvable.' });
      if ((error as Error).message === 'INTERVENTION_NON_PLANIFIABLE') return res.status(409).json({ error: 'Cette intervention ne peut plus être planifiée.' });
      res.status(500).json({ error: 'Error updating planning event' });
    }
  });

  app.delete('/api/planning/events/:id', requireAuth, blockCommercial, blockTechnicien, requirePlanningActif, async (req: AuthRequest, res) => {
    try {
      const existing = await prisma.planningEvent.findUnique({ where: { id: paramId(req) } });
      if (!existing) return res.status(404).json({ error: 'Affectation introuvable.' });
      if (existing.interventionId) {
        const autorisee = await prisma.intervention.findFirst({ where: { id: existing.interventionId, ...getInterventionFilterForUser(req.user!) }, select: { id: true } });
        if (!autorisee) return res.status(404).json({ error: 'Affectation introuvable.' });
        return res.status(409).json({ error: 'Suppression impossible : cette projection est liée à une intervention SAV. Modifiez ou annulez le dossier SAV.' });
      }
      await prisma.planningEvent.delete({ where: { id: existing.id } });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Error deleting planning event' });
    }
  });

  // Types d'événements personnalisés du planning (libellé + couleur, réutilisables).
  app.get('/api/planning/types', requireAuth, blockCommercial, requirePlanningActif, async (req, res) => {
    try {
      res.json(await prisma.planningEventType.findMany({ orderBy: { nom: 'asc' } }));
    } catch (error) {
      res.status(500).json({ error: 'Error fetching planning types' });
    }
  });

  app.post('/api/planning/types', requireAuth, blockCommercial, blockTechnicien, requirePlanningActif, async (req, res) => {
    try {
      const nom = String(req.body.nom || '').trim();
      if (!nom) return res.status(400).json({ error: 'Le libellé du type est requis.' });
      const couleur = parsePlanningCouleur(req.body.couleur) || '#f59e0b';
      res.status(201).json(await prisma.planningEventType.create({ data: { nom, couleur } }));
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Un type porte déjà ce libellé.' });
      res.status(500).json({ error: 'Error creating planning type' });
    }
  });

  app.put('/api/planning/types/:id', requireAuth, blockCommercial, blockTechnicien, requirePlanningActif, async (req, res) => {
    try {
      const data: Record<string, unknown> = {};
      if (typeof req.body.nom === 'string' && req.body.nom.trim()) data.nom = req.body.nom.trim();
      const couleur = parsePlanningCouleur(req.body.couleur);
      if (couleur) data.couleur = couleur;
      res.json(await prisma.planningEventType.update({ where: { id: paramId(req) }, data }));
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Un type porte déjà ce libellé.' });
      res.status(500).json({ error: 'Error updating planning type' });
    }
  });

  // Supprimer un type d'événement. Bloqué si des affectations du planning l'utilisent.
  app.delete('/api/planning/types/:id', requireAuth, blockCommercial, blockTechnicien, requirePlanningActif, async (req, res) => {
    try {
      const id = paramId(req);
      const used = await prisma.planningEvent.count({ where: { typeEventId: id } });
      if (used > 0) {
        return res.status(409).json({ error: `Suppression impossible : ${used} affectation(s) du planning utilisent ce type.` });
      }
      await prisma.planningEventType.delete({ where: { id } });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Error deleting planning type' });
    }
  });

  app.get('/api/planning/share', requireAuth, requireAdmin, requirePlanningActif, async (req, res) => {
    try {
      const share = await prisma.planningPublicShare.findUnique({ where: { id: 'singleton' } });
      res.json(serializeShare(share));
    } catch (error) {
      res.status(500).json({ error: 'Error fetching planning share' });
    }
  });

  // Publie le planning (1ère fois) ou renouvelle le lien existant : génère TOUJOURS un
  // nouveau token aléatoire et (ré)active le partage — l'ancien lien devient aussitôt
  // invalide (cf. GET /api/planning/public/:token, qui compare le token reçu au token stocké).
  app.post('/api/planning/share', requireAuth, requireAdmin, requirePlanningActif, async (req, res) => {
    try {
      const token = generateShareToken();
      const share = await transactionVerifiee(async (tx) => {
        await verrouillerReglage(tx, 'PlanningPublicShare');
        const avant = await tx.planningPublicShare.findUnique({ where: { id: 'singleton' } });
        const apres = await tx.planningPublicShare.upsert({
          where: { id: 'singleton' },
          update: { token, active: true },
          create: { id: 'singleton', token, active: true },
        });
        // Le jeton est le secret du lien : le journal note seulement qu'il a changé.
        await journaliserAdministration(tx, req as AuthRequest, {
          domaine: 'REGLAGES', type: 'PARTAGE_PLANNING', action: avant ? 'NOUVEAU_LIEN' : 'PUBLICATION',
          avant: avant ? { actif: avant.active } : null, apres: { actif: true },
          detail: avant ? 'Nouveau lien : l’ancien ne fonctionne plus.' : 'Premier lien publié.',
        });
        return apres;
      });
      res.json(serializeShare(share));
    } catch (error) {
      res.status(500).json({ error: 'Error publishing planning share' });
    }
  });

  // Active/désactive le partage SANS changer le token (contrairement à la régénération
  // ci-dessus) : permet de couper l'accès temporairement puis de le rétablir avec le même
  // lien déjà communiqué aux techniciens.
  app.patch('/api/planning/share', requireAuth, requireAdmin, requirePlanningActif, async (req, res) => {
    try {
      const active = !!req.body.active;
      const share = await transactionVerifiee(async (tx) => {
        await verrouillerReglage(tx, 'PlanningPublicShare');
        const existing = await tx.planningPublicShare.findUnique({ where: { id: 'singleton' } });
        if (!existing) return null;
        const apres = await tx.planningPublicShare.update({ where: { id: 'singleton' }, data: { active } });
        if (existing.active !== active) {
          await journaliserAdministration(tx, req as AuthRequest, {
            domaine: 'REGLAGES', type: 'PARTAGE_PLANNING', action: active ? 'ACTIVATION' : 'DESACTIVATION',
            avant: { actif: existing.active }, apres: { actif: active },
          });
        }
        return apres;
      });
      if (!share) return res.status(404).json({ error: "Le planning n'a encore jamais été publié." });
      res.json(serializeShare(share));
    } catch (error) {
      res.status(500).json({ error: 'Error updating planning share' });
    }
  });

  // Consultation PUBLIQUE et SANS authentification du planning (lien de partage) —
  // destinée aux techniciens qui n'ont pas de compte. Lecture seule : mêmes affectations
  // que GET /api/planning/events, réduites à ce qui leur est utile (aucun montant, aucune
  // marge — ces champs n'existent de toute façon pas sur Chantier "lite"). Token invalide
  // OU partage désactivé renvoient la MÊME erreur générique, pour ne jamais révéler si un
  // token a existé.
  app.get('/api/planning/public/:token', async (req, res) => {
    try {
      const token = paramToken(req);
      const share = token ? await prisma.planningPublicShare.findUnique({ where: { token } }) : null;
      if (!share || !share.active) {
        return res.status(404).json({ error: "Ce lien de planning n'est plus disponible. Contactez votre administrateur." });
      }

      // Le téléphone du technicien ne connaît ni le fuseau de la société ni son jour : sans plage
      // demandée (première ouverture), la page reçoit la semaine du jour de la société, et chaque
      // réponse lui donne ce jour et ce fuseau (« aujourd'hui », heure de mise à jour).
      const fuseauHoraire = (await getCompanySettings()).fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT;
      const aujourdhui = aujourdHuiEntreprise(fuseauHoraire);
      const jourSemaine = new Date(`${aujourdhui}T00:00:00.000Z`).getUTCDay();
      const lundi = ajouterJoursCivils(aujourdhui, jourSemaine === 0 ? -6 : 1 - jourSemaine);
      const sansPlage = req.query.start === undefined && req.query.end === undefined;
      const start = parsePlanningJour(sansPlage ? lundi : req.query.start);
      const end = parsePlanningJour(sansPlage ? ajouterJoursCivils(lundi, 6) : req.query.end);
      if (!start || !end) return res.status(400).json({ error: 'Plage de dates invalide : start et end vont ensemble, au format JJ-MM-AAAA ou AAAA-MM-JJ.' });

      // `select` explicite (plutôt qu'`include`, qui renverrait aussi tous les champs
      // scalaires bruts de PlanningEvent) : n'expose que ce qui est utile à un technicien,
      // jamais d'identifiant interne (chantierId, typeEventId) ni de donnée de gestion.
      const [events, intervenants] = await Promise.all([
        prisma.planningEvent.findMany({
          where: { dateDebut: { lte: end }, dateFin: { gte: start } },
          select: {
            id: true, categorie: true, dateDebut: true, dateFin: true, creneau: true,
            heureDebut: true, heureFin: true, titre: true, client: true, adresse: true, commentaire: true,
            chantier: { select: { nom: true, client: true, adresse: true } },
            typeEvent: { select: { nom: true, couleur: true } },
            intervenants: { select: { id: true, nom: true, role: true } },
          },
          orderBy: [{ dateDebut: 'asc' }, { createdAt: 'asc' }],
        }),
        prisma.intervenant.findMany({ select: { id: true, nom: true }, orderBy: { nom: 'asc' } }),
      ]);

      res.json({ events, intervenants, fuseauHoraire, aujourdhui, debut: start.toISOString().slice(0, 10), fin: end.toISOString().slice(0, 10) });
    } catch (error) {
      res.status(500).json({ error: 'Error fetching public planning' });
    }
  });
}
