import type { Express } from 'express';
import { prisma, transactionVerifiee } from '../../db';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { requireAdmin } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { FUSEAU_HORAIRE_PAR_DEFAUT, anneeEntreprise, dateIsoStricte, dateFrancaise } from '../../commun/dates';
import { decimalToNumber } from '../../commun/montants';
import { CHANTIER_INTERVENTION_SELECT, journaliserIntervention, exposerIntervention } from '../interventions/metier';
import { journaliserContrat, motifContratValide, lirePolitiqueCouverture, verrouillerContratMaintenance, echeanceSuivante } from './metier';

export function enregistrerRoutesContrats(app: Express): void {
  // Le planning est une projection ; cette route crée le dossier métier traçable qui lui est
  // antérieur. Une affectation planning ou un pointage ne peut pas exister à sa place.
  // Contrats de maintenance : le contrat est le document source du cycle. Le planning ne sera
  // qu'une projection des interventions qu'il génère ; aucune échéance n'est inférée d'un écran.
  app.get('/api/contrats-maintenance', requireAuth, requireAdmin, async (_req, res) => {
    const contrats = await prisma.contratMaintenance.findMany({
      include: { client: { select: { id: true, raisonSociale: true } }, site: { select: { id: true, nom: true, ville: true } } },
      orderBy: [{ prochaineEcheance: 'asc' }, { createdAt: 'desc' }],
    });
    res.json(decimalToNumber(contrats));
  });

  app.get('/api/contrats-maintenance/:id/journal-saisies', requireAuth, requireAdmin, async (req, res) => {
    try {
      const contrat = await prisma.contratMaintenance.findUnique({ where: { id: paramId(req) }, select: { id: true } });
      if (!contrat) return res.status(404).json({ error: 'Contrat de maintenance introuvable.' });
      const entrees = await prisma.journalSaisieChantier.findMany({ where: { contratMaintenanceId: contrat.id }, orderBy: { createdAt: 'desc' } });
      res.json(decimalToNumber(entrees));
    } catch (error) {
      res.status(500).json({ error: 'Lecture du journal du contrat impossible.' });
    }
  });

  app.post('/api/contrats-maintenance', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const titre = typeof req.body?.titre === 'string' ? req.body.titre.trim() : '';
      const periodiciteMois = Number(req.body?.periodiciteMois);
      const dureePrevisionnelleMinutes = Number(req.body?.dureePrevisionnelleMinutes);
      const dateDebut = dateIsoStricte(req.body?.dateDebut);
      const couverture = lirePolitiqueCouverture(req.body || {});
      if (titre.length < 3 || titre.length > 200) return res.status(400).json({ error: 'Le titre du contrat doit contenir entre 3 et 200 caractères.' });
      if (!Number.isInteger(periodiciteMois) || periodiciteMois < 1 || periodiciteMois > 60) return res.status(400).json({ error: 'La périodicité doit être comprise entre 1 et 60 mois.' });
      if (!Number.isInteger(dureePrevisionnelleMinutes) || dureePrevisionnelleMinutes < 15 || dureePrevisionnelleMinutes > 1440) return res.status(400).json({ error: 'La durée prévisionnelle doit être comprise entre 15 et 1 440 minutes.' });
      if (!dateDebut) return res.status(400).json({ error: 'La date de début doit être valide au format JJ-MM-AAAA.' });
      if (!couverture) return res.status(400).json({ error: 'La politique de couverture est invalide.' });
      // Même règle que la création directe d’intervention : un client désactivé n'ouvre plus
      // de dossier par le contrat, qui ne doit jamais devenir une porte de contournement.
      const client = await prisma.client.findFirst({ where: { id: String(req.body?.clientId || ''), actif: true }, select: { id: true } });
      if (!client) return res.status(404).json({ error: 'Client introuvable.' });
      const siteId = typeof req.body?.siteId === 'string' && req.body.siteId ? req.body.siteId : null;
      if (siteId) {
        const site = await prisma.clientSite.findFirst({ where: { id: siteId, clientId: client.id }, select: { id: true } });
        if (!site) return res.status(404).json({ error: 'Site introuvable.' });
      }
      const contrat = await transactionVerifiee(async (tx) => {
        const cree = await tx.contratMaintenance.create({
          data: { clientId: client.id, siteId, titre, periodiciteMois, dureePrevisionnelleMinutes, dateDebut, prochaineEcheance: dateDebut, ...couverture, createdById: req.user!.id },
          include: { client: { select: { id: true, raisonSociale: true } }, site: { select: { id: true, nom: true, ville: true } } },
        });
        await journaliserContrat(tx, req, 'CREATION', cree, null);
        return cree;
      });
      res.status(201).json(decimalToNumber(contrat));
    } catch (error) {
      res.status(500).json({ error: 'Création du contrat de maintenance impossible.' });
    }
  });

  app.patch('/api/contrats-maintenance/:id', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      if (!['politiqueMainOeuvre', 'politiqueMateriel', 'noteCouverture'].some((champ) => Object.prototype.hasOwnProperty.call(req.body || {}, champ))) return res.status(400).json({ error: 'Aucune politique de couverture à modifier.' });
      const motif = motifContratValide(req.body?.motif);
      if (!motif) return res.status(400).json({ error: 'Un motif de 3 à 500 caractères sans caractère de contrôle est obligatoire.' });
      const resultat = await transactionVerifiee(async (tx) => {
        await verrouillerContratMaintenance(tx, paramId(req));
        const contrat = await tx.contratMaintenance.findUnique({ where: { id: paramId(req) } });
        if (!contrat) return { erreur: 'NOT_FOUND' as const };
        if (contrat.statut === 'TERMINE') return { erreur: 'TERMINE' as const };
        if (contrat.statut !== 'ACTIF') return { erreur: 'SUSPENDU' as const };
        // Le verrou précède la relecture : deux éditeurs ne peuvent pas écraser la version de l'autre.
        if (req.body?.expectedUpdatedAt !== undefined && req.body.expectedUpdatedAt !== contrat.updatedAt.toISOString()) return { erreur: 'PERIME' as const };
        const couverture = lirePolitiqueCouverture(req.body || {}, contrat);
        if (!couverture) return { erreur: 'INVALIDE' as const };
        if (couverture.politiqueMainOeuvre === contrat.politiqueMainOeuvre && couverture.politiqueMateriel === contrat.politiqueMateriel && couverture.noteCouverture === contrat.noteCouverture) return { erreur: 'INCHANGEE' as const };
        const maj = await tx.contratMaintenance.update({ where: { id: contrat.id }, data: couverture, include: { client: { select: { id: true, raisonSociale: true } }, site: { select: { id: true, nom: true, ville: true } } } });
        await journaliserContrat(tx, req, 'MODIFICATION_COUVERTURE', maj, contrat, motif);
        return { contrat: maj };
      });
      if ('erreur' in resultat) {
        if (resultat.erreur === 'NOT_FOUND') return res.status(404).json({ error: 'Contrat de maintenance introuvable.' });
        if (resultat.erreur === 'TERMINE') return res.status(409).json({ error: 'Un contrat clos ne peut plus être modifié.' });
        if (resultat.erreur === 'SUSPENDU') return res.status(409).json({ error: 'Réactivez le contrat avant de modifier sa couverture.' });
        if (resultat.erreur === 'PERIME') return res.status(409).json({ error: 'Le contrat a été modifié depuis l’ouverture de l’éditeur : actualisez la liste.' });
        if (resultat.erreur === 'INCHANGEE') return res.status(409).json({ error: 'La couverture est inchangée.' });
        return res.status(400).json({ error: 'La politique de couverture est invalide.' });
      }
      res.json(decimalToNumber(resultat.contrat));
    } catch (error) {
      res.status(500).json({ error: 'Mise à jour de la couverture du contrat impossible.' });
    }
  });

  app.patch('/api/contrats-maintenance/:id/statut', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const statut = String(req.body?.statut || '');
      if (!['ACTIF', 'SUSPENDU', 'TERMINE'].includes(statut)) return res.status(400).json({ error: 'Statut de contrat invalide.' });
      const motif = motifContratValide(req.body?.motif);
      if (!motif) return res.status(400).json({ error: 'Un motif de 3 à 500 caractères sans caractère de contrôle est obligatoire.' });
      const resultat = await transactionVerifiee(async (tx) => {
        await verrouillerContratMaintenance(tx, paramId(req));
        const contrat = await tx.contratMaintenance.findUnique({ where: { id: paramId(req) } });
        if (!contrat) return { erreur: 'NOT_FOUND' as const };
        if (contrat.statut === 'TERMINE') return { erreur: 'TERMINE' as const };
        const autorise = (contrat.statut === 'ACTIF' && ['SUSPENDU', 'TERMINE'].includes(statut)) || (contrat.statut === 'SUSPENDU' && ['ACTIF', 'TERMINE'].includes(statut));
        if (!autorise) return { erreur: 'TRANSITION' as const };
        const maj = await tx.contratMaintenance.update({ where: { id: contrat.id }, data: { statut } });
        const action = statut === 'SUSPENDU' ? 'SUSPENSION' : statut === 'TERMINE' ? 'CLOTURE' : 'REACTIVATION';
        await journaliserContrat(tx, req, action, maj, contrat, motif);
        return { contrat: maj };
      });
      if ('erreur' in resultat) {
        if (resultat.erreur === 'NOT_FOUND') return res.status(404).json({ error: 'Contrat de maintenance introuvable.' });
        if (resultat.erreur === 'TERMINE') return res.status(409).json({ error: 'Un contrat clos ne se rouvre pas : signez un nouveau contrat.' });
        return res.status(409).json({ error: 'Transition de statut de contrat incohérente.' });
      }
      res.json(decimalToNumber(resultat.contrat));
    } catch (error) {
      res.status(500).json({ error: 'Mise à jour du statut du contrat impossible.' });
    }
  });

  app.post('/api/contrats-maintenance/:id/avancer-echeance', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const resultat = await transactionVerifiee(async (tx) => {
        await verrouillerContratMaintenance(tx, paramId(req));
        const contrat = await tx.contratMaintenance.findFirst({ where: { id: paramId(req), statut: 'ACTIF' } });
        if (!contrat) return { erreur: 'NOT_FOUND' as const };
        const intervention = await tx.intervention.findFirst({
          where: { contratMaintenanceId: contrat.id, echeanceContrat: contrat.prochaineEcheance },
          select: { id: true, reference: true, statut: true },
        });
        if (!intervention || intervention.statut !== 'TERMINEE') return { erreur: 'NOT_READY' as const };
        const prochaineEcheance = echeanceSuivante(contrat.dateDebut, contrat.prochaineEcheance, contrat.periodiciteMois);
        const maj = await tx.contratMaintenance.update({ where: { id: contrat.id }, data: { prochaineEcheance } });
        const motif = `Intervention ${intervention.reference} terminée : échéance du ${dateFrancaise(contrat.prochaineEcheance)} au ${dateFrancaise(prochaineEcheance)}.`;
        await journaliserContrat(tx, req, 'AVANCEMENT_ECHEANCE', maj, contrat, motif);
        return { contrat: maj };
      });
      if ('erreur' in resultat) {
        if (resultat.erreur === 'NOT_FOUND') return res.status(404).json({ error: 'Contrat de maintenance actif introuvable.' });
        return res.status(409).json({ error: 'L’échéance ne peut avancer qu’après la fin de son intervention.' });
      }
      res.json(decimalToNumber(resultat.contrat));
    } catch (error) {
      res.status(500).json({ error: 'Mise à jour de l’échéance impossible.' });
    }
  });

  app.post('/api/contrats-maintenance/:id/generer-intervention', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const resultat = await transactionVerifiee(async (tx) => {
        await verrouillerContratMaintenance(tx, paramId(req));
        const contrat = await tx.contratMaintenance.findFirst({
          where: { id: paramId(req), statut: 'ACTIF' },
          include: { client: { select: { id: true, raisonSociale: true } }, site: { select: { id: true, nom: true, ville: true } } },
        });
        if (!contrat) return null;
        const existante = await tx.intervention.findFirst({
          where: { contratMaintenanceId: contrat.id, echeanceContrat: contrat.prochaineEcheance },
          include: { client: { select: { id: true, raisonSociale: true } }, site: true, contact: true, chantier: CHANTIER_INTERVENTION_SELECT },
        });
        if (existante) return { intervention: existante, creee: false };
        const societe = await tx.companySettings.findUnique({ where: { id: 'singleton' }, select: { fuseauHoraire: true } });
        const annee = anneeEntreprise(new Date(), societe?.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);
        const sequence = await tx.sequenceIntervention.upsert({
          where: { annee }, create: { annee, dernierNumero: 1 }, update: { dernierNumero: { increment: 1 } },
        });
        const reference = `I${String(annee).slice(-2)}-${String(sequence.dernierNumero).padStart(4, '0')}`;
        const intervention = await tx.intervention.create({
          data: {
            reference, clientId: contrat.clientId, siteId: contrat.siteId, contratMaintenanceId: contrat.id,
            echeanceContrat: contrat.prochaineEcheance, titre: `Maintenance préventive — ${contrat.titre}`,
            description: `Intervention prévisionnelle issue du contrat. Durée prévue : ${contrat.dureePrevisionnelleMinutes} minutes.`,
            dateSouhaitee: contrat.prochaineEcheance, dateDemande: contrat.prochaineEcheance, createdById: req.user!.id,
            couvertureContrat: {
              politiqueMainOeuvre: contrat.politiqueMainOeuvre,
              politiqueMateriel: contrat.politiqueMateriel,
              noteCouverture: contrat.noteCouverture,
            },
          },
          include: { client: { select: { id: true, raisonSociale: true } }, site: true, contact: true, chantier: CHANTIER_INTERVENTION_SELECT },
        });
        await journaliserIntervention(tx, req, 'CREATION_CONTRAT', intervention);
        return { intervention, creee: true };
      });
      if (!resultat) return res.status(404).json({ error: 'Contrat de maintenance actif introuvable.' });
      res.status(resultat.creee ? 201 : 200).json(decimalToNumber(exposerIntervention(resultat.intervention)));
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        // Une génération concurrente ne peut renvoyer que l'intervention de l'échéance
        // courante ; une ancienne visite du même contrat ne prouve pas l'idempotence.
        const contrat = await prisma.contratMaintenance.findUnique({ where: { id: paramId(req) }, select: { prochaineEcheance: true } });
        const existante = contrat && await prisma.intervention.findFirst({
          where: { contratMaintenanceId: paramId(req), echeanceContrat: contrat.prochaineEcheance },
          orderBy: { createdAt: 'desc' },
          include: { client: { select: { id: true, raisonSociale: true } }, site: true, contact: true, chantier: CHANTIER_INTERVENTION_SELECT },
        });
        if (existante) return res.status(200).json(decimalToNumber(exposerIntervention(existante)));
      }
      res.status(500).json({ error: 'Génération de l’intervention prévisionnelle impossible.' });
    }
  });
}
