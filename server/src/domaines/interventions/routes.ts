import type { Express } from 'express';
import { Prisma } from '@prisma/client';
import { prisma, transactionVerifiee } from '../../db';
import { ROLE_TECHNICIEN, isAdminRole } from '../../droits/roles';
import { voitCoutMainOeuvre, sansTauxHoraire, saisieSelonDroits } from '../../droits/visibilite';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { blockCommercial, blockCommercialEtAssimiles, blockTechnicien } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { FUSEAU_HORAIRE_PAR_DEFAUT, anneeEntreprise, dateIsoStricte } from '../../commun/dates';
import { decimalToNumber } from '../../commun/montants';
import { nombreDecimalNonNegatif, motifCorrectionValide, motifRestaurationValide } from '../../commun/validation';
import { getCompanySettings } from '../administration/metier';
import { requirePlanningActif, PLANNING_EVENT_INCLUDE, validatePlanningEvent } from '../planning/metier';
import { verrouillerContratMaintenance } from '../contrats/metier';
import {
  CHANTIER_INTERVENTION_SELECT, chantierDuJournalReduit, journaliserIntervention, exposerIntervention, estEncadrementCoutIntervention,
  chargerInterventionCout, interventionCoutEligible, interventionHeuresEligible, dateHeuresIntervention, estConflitTransactionCout, verrouillerContexteCout, heureOperationnelleTechnicien,
  journaliserCoutIntervention, totalHeuresInterventionAuCentime, getInterventionFilterForUser, synchroniserAffectationsIntervention,
  lireDetailsIntervention, creerInterventionNumerotee, SaisieInterventionInvalide, PRIORITES_INTERVENTION, INSTANTANE_CRENEAU, retirerCreneauIntervention,
} from './metier';
import {
  RAPPORT_SELECT, SIGNATURE_SELECT, cleEnvoiValide, contientCaractereInvalide, empreinteSignature, interventionDansPerimetre, journaliserCompteRendu, motifClotureValide, motifInterventionValide, traceSignatureValide, verrouillerIntervention,
} from './comptesRendus';
import { enregistrerLecturesInterventions } from './lectures';
import { enregistrerRemiseAPlanifier } from './remiseAPlanifier';
import { enregistrerSuites } from './suites';
import { margeDevisIntervention } from './margeDevis';
import { margeSavHorsContrat, prixVenteHoraireHorsContrat } from './margeSav';
import { RefusAffaireSuite, verifierAffaireDeLaSuite } from './affaireSuite';

class ChantierInterventionIntrouvable extends Error {}
// Refus métier relevé sous verrou, dans la transaction : il l'annule et devient un 409.
class RefusIntervention extends Error {}
// Intervention sortie du périmètre du demandeur pendant qu'il attendait le verrou : 404, sans rien dire.
class InterventionHorsPerimetre extends Error {}

const HEURES_DATE_FUTURE = 'Des heures se déclarent une fois faites : la date ne peut pas dépasser aujourd’hui.';
// Instantané du journal SAV d'un changement de statut qui laisse le créneau en place.
const AVEC_CLIENT = { client: { select: { id: true, raisonSociale: true } } } as const;
const MOTIF_ANNULATION_INVALIDE = 'Un motif de 3 à 500 caractères sans caractère de contrôle est obligatoire pour annuler l’intervention.';

export function enregistrerRoutesInterventions(app: Express): void {
  app.post('/api/interventions', requireAuth, blockCommercial, (req: AuthRequest, res, next) => {
    if (!isAdminRole(req.user?.role) && req.user?.role !== 'CONDUCTEUR_TRAVAUX') return res.status(403).json({ error: 'Création réservée à l’encadrement SAV.' });
    next();
  }, async (req: AuthRequest, res) => {
    try {
      const titre = String(req.body?.titre || '').trim();
      const clientId = String(req.body?.clientId || '');
      const priorite = String(req.body?.priorite || 'NORMALE');
      if (!titre) return res.status(400).json({ error: 'Le titre de l’intervention est obligatoire.' });
      if (!PRIORITES_INTERVENTION.includes(priorite)) return res.status(400).json({ error: 'Priorité d’intervention invalide.' });
      const client = await prisma.client.findFirst({ where: { id: clientId, actif: true }, select: { id: true } });
      if (!client) return res.status(404).json({ error: 'Client introuvable.' });
      const chantierId = req.body?.chantierId ? String(req.body.chantierId) : null;
      const societe = await getCompanySettings();
      const details = await lireDetailsIntervention(prisma, req.body ?? {}, clientId, societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);
      const annee = anneeEntreprise(new Date(), societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);
      const intervention = await transactionVerifiee(async (tx) => {
        // Le chantier rattaché doit être lié à la fiche de ce client (clientId), et non à un libellé
        // identique : renommer un client ne rompt pas le rattachement, et une affaire héritée sans
        // fiche se répare d'abord (décision de Nelson du 16-10-2026). Le contrôle se fait sous verrou
        // partagé : un changement de client de l'affaire en cours attend la fin de cette création, ou
        // la fait refuser s'il s'enregistre d'abord (cf. PATCH /api/chantiers/:id). FOR SHARE, et non
        // FOR KEY SHARE, pour attendre aussi une annulation en cours, qui ferme alors le chantier.
        if (chantierId && !(await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Chantier" WHERE "id" = ${chantierId} AND "clientId" = ${clientId} AND "annuleLe" IS NULL FOR SHARE`)).length) {
          throw new ChantierInterventionIntrouvable();
        }
        return creerInterventionNumerotee(tx, req, annee, { clientId, titre, chantierId, ...details });
      });
      res.status(201).json(decimalToNumber(exposerIntervention(intervention)));
    } catch (error) {
      if (error instanceof ChantierInterventionIntrouvable) return res.status(404).json({ error: 'Chantier introuvable pour ce client.' });
      if (error instanceof SaisieInterventionInvalide) return res.status(error.status).json({ error: error.message });
      console.error('Erreur création intervention SAV', error);
      res.status(500).json({ error: 'Erreur lors de la création de l’intervention.' });
    }
  });

  enregistrerLecturesInterventions(app);

  // Coûts SAV : leurs lignes ne sont jamais exposées dans les flux Travaux ou /api/v1 ; seuls les totaux
  // des suites rattachées à une affaire entrent dans la marge du chantier (cf. coutsSuites). Hors
  // contrat, une intervention ne porte que les heures du technicien (lot pilote 3b), sans matériel.
  app.get('/api/interventions/:id/couts', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
    try {
      const intervention = await chargerInterventionCout(req);
      if (!intervention) return res.status(404).json({ error: 'Intervention introuvable.' });
      const encadrement = estEncadrementCoutIntervention(req.user!.role);
      if (!encadrement && req.user!.role !== ROLE_TECHNICIEN) return res.status(403).json({ error: 'Accès non autorisé.' });
      if (!encadrement && !interventionHeuresEligible(intervention)) return res.status(409).json({ error: 'Cette intervention ne peut pas recevoir de coûts.' });

      if (!encadrement) {
        const heures = await prisma.coutInterventionHeure.findMany({
          where: { interventionId: intervention.id, intervenant: { userId: req.user!.id }, archivedAt: null },
          select: { id: true, date: true, nbrHeures: true, commentaire: true, createdAt: true },
          orderBy: { date: 'desc' },
        });
        return res.json(decimalToNumber({ heures }));
      }

      // L'encadrement a besoin de toutes les lignes, actives et archivées, pour auditer et
      // restaurer l'historique après suspension, terme ou annulation.
      const [heures, achats] = await Promise.all([
        prisma.coutInterventionHeure.findMany({ where: { interventionId: intervention.id }, orderBy: { date: 'desc' } }),
        prisma.coutInterventionAchat.findMany({ where: { interventionId: intervention.id }, include: { fournisseur: true }, orderBy: { date: 'desc' } }),
      ]);
      const totalMainOeuvreHT = totalHeuresInterventionAuCentime(heures.filter((heure) => !heure.archivedAt));
      // Hors contrat, aucun matériel ne se saisit : pas de total matériel, et le coût réel se limite à
      // la main-d'œuvre (décision de Nelson du 19-10-2026 : l'administration le voit).
      const totalMaterielHT = intervention.contratMaintenanceId
        ? achats.filter((achat) => !achat.archivedAt).reduce((total, achat) => total.plus(achat.montantHT), new Prisma.Decimal(0)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
        : null;
      // Un conducteur garde les heures et le matériel, mais ni taux ni coût de main-d'œuvre, ni le
      // total qui l'inclut (cf. voitCoutMainOeuvre).
      if (!voitCoutMainOeuvre(req)) return res.json(decimalToNumber({ heures: heures.map(sansTauxHoraire), achats, totalMainOeuvreHT: null, totalMaterielHT, totalCoutsHT: null }));
      const totalCoutsHT = totalMaterielHT === null ? totalMainOeuvreHT : totalMainOeuvreHT.plus(totalMaterielHT).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      // Intervention issue d'un devis, sans chantier : sa marge, suites comprises, pour l'administration
      // seule (décision de Nelson de la nuit du 26 au 27-10-2026, cf. margeDevisIntervention).
      const margeDevis = await margeDevisIntervention(intervention);
      // Intervention SAV hors contrat, sans devis ni chantier : sa marge à l'heure, au prix de vente figé
      // de la main d'œuvre de chaque intervenant, suites comprises, pour l'administration seule (cf. margeSav.ts).
      const margeSav = await margeSavHorsContrat(intervention);
      res.json(decimalToNumber({ heures, achats, totalMainOeuvreHT, totalMaterielHT, totalCoutsHT, margeDevis, margeSav }));
    } catch (error) { console.error('Erreur lecture coûts intervention', error); res.status(500).json({ error: 'Lecture des coûts impossible.' }); }
  });

  app.post('/api/interventions/:id/couts/heures', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
    try {
      const intervention = await chargerInterventionCout(req);
      if (!intervention) return res.status(404).json({ error: 'Intervention introuvable.' });
      if (req.user!.role !== ROLE_TECHNICIEN) return res.status(403).json({ error: 'Saisie d’heures réservée au technicien affecté.' });
      if (!interventionHeuresEligible(intervention)) return res.status(409).json({ error: 'Cette intervention ne peut pas recevoir de coûts.' });
      await verifierAffaireDeLaSuite(prisma, intervention, req.user!.role, false);
      const dateSaisie = dateIsoStricte(req.body?.date); const nbrHeures = nombreDecimalNonNegatif(req.body?.nbrHeures, 8, true);
      const motif = motifCorrectionValide(req.body?.motif);
      if (!dateSaisie || nbrHeures === null) return res.status(400).json({ error: 'Date ou nombre d’heures invalide.' });
      const date = dateHeuresIntervention(dateSaisie, (await getCompanySettings()).fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);
      if (!date) return res.status(400).json({ error: HEURES_DATE_FUTURE });
      if (nbrHeures === 0 && !motif) return res.status(400).json({ error: 'Un motif de 3 à 500 caractères est obligatoire pour zéro heure.' });
      const intervenant = await prisma.intervenant.findFirst({ where: { userId: req.user!.id, affectationsIntervention: { some: { interventionId: intervention.id } } } });
      if (!intervenant) return res.status(404).json({ error: 'Intervention introuvable.' });
      const cree = await transactionVerifiee(async (tx) => {
        const interventionActuelle = await verrouillerContexteCout(tx, intervention.id, intervenant.id, req.user!.id);
        if (!interventionActuelle || !interventionHeuresEligible(interventionActuelle)) return null;
        await verifierAffaireDeLaSuite(tx, interventionActuelle, req.user!.role, true);
        const intervenantActuel = await tx.intervenant.findFirst({ where: { id: intervenant.id, userId: req.user!.id, affectationsIntervention: { some: { interventionId: intervention.id } } } });
        if (!intervenantActuel) return null;
        // Hors contrat, le prix de vente à l'heure de la main d'œuvre de l'intervenant est figé sur l'heure,
        // comme le taux chargé (lot « marge d'un SAV hors contrat », cf. margeSav.ts) ; une visite n'en reçoit pas.
        const prixVenteHoraireApplique = interventionActuelle.contratMaintenanceId ? null : await prixVenteHoraireHorsContrat(tx, intervenantActuel.id);
        const cout = await tx.coutInterventionHeure.create({ data: { interventionId: interventionActuelle.id, intervenantId: intervenantActuel.id, date, nbrHeures, tauxHoraireApplique: intervenantActuel.tauxHoraireCharge, prixVenteHoraireApplique, commentaire: req.body?.commentaire ? String(req.body.commentaire).trim() : null, createdById: req.user!.id } });
        await journaliserCoutIntervention(tx, req, 'COUT_INTERVENTION_HEURE', 'CREATION', cout.id, interventionActuelle.id, null, cout, nbrHeures === 0 ? motif! : undefined);
        return heureOperationnelleTechnicien(cout);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      if (!cree) return res.status(409).json({ error: 'Cette intervention ne peut pas recevoir de coûts.' });
      res.status(201).json(decimalToNumber(cree));
    } catch (error) { if (error instanceof RefusAffaireSuite) return res.status(error.status).json({ error: error.message }); if (estConflitTransactionCout(error)) return res.status(409).json({ error: 'Conflit concurrent : la saisie des heures n’a pas été enregistrée.' }); console.error('Erreur saisie heures intervention', error); res.status(500).json({ error: 'Saisie des heures impossible.' }); }
  });

  app.post('/api/interventions/:id/couts/achats', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
    try {
      const intervention = await chargerInterventionCout(req);
      if (!intervention) return res.status(404).json({ error: 'Intervention introuvable.' });
      if (!estEncadrementCoutIntervention(req.user!.role)) return res.status(403).json({ error: 'Saisie de matériel réservée à l’encadrement.' });
      if (!interventionCoutEligible(intervention)) return res.status(409).json({ error: 'Cette intervention ne peut pas recevoir de coûts.' });
      await verifierAffaireDeLaSuite(prisma, intervention, req.user!.role, false);
      const date = dateIsoStricte(req.body?.date); const montantHT = nombreDecimalNonNegatif(req.body?.montantHT, 10, true); const motif = motifCorrectionValide(req.body?.motif);
      const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
      if (!date || montantHT === null || !description) return res.status(400).json({ error: 'Date, description ou montant HT invalide.' });
      if (montantHT === 0 && !motif) return res.status(400).json({ error: 'Un motif de 3 à 500 caractères est obligatoire pour un montant nul.' });
      const fournisseur = await prisma.fournisseur.findUnique({ where: { id: String(req.body?.fournisseurId || '') } });
      if (!fournisseur) return res.status(404).json({ error: 'Fournisseur introuvable.' });
      const cree = await transactionVerifiee(async (tx) => {
        const interventionActuelle = await verrouillerContexteCout(tx, intervention.id);
        if (!interventionActuelle || !interventionCoutEligible(interventionActuelle)) return null;
        await verifierAffaireDeLaSuite(tx, interventionActuelle, req.user!.role, true);
        const cout = await tx.coutInterventionAchat.create({ data: { interventionId: interventionActuelle.id, fournisseurId: fournisseur.id, date, description, montantHT, createdById: req.user!.id } });
        await journaliserCoutIntervention(tx, req, 'COUT_INTERVENTION_ACHAT', 'CREATION', cout.id, interventionActuelle.id, null, cout, montantHT === 0 ? motif! : undefined);
        return cout;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      if (!cree) return res.status(409).json({ error: 'Cette intervention ne peut pas recevoir de coûts.' });
      res.status(201).json(decimalToNumber(cree));
    } catch (error) { if (error instanceof RefusAffaireSuite) return res.status(error.status).json({ error: error.message }); if (estConflitTransactionCout(error)) return res.status(409).json({ error: 'Conflit concurrent : l’achat n’a pas été enregistré.' }); console.error('Erreur saisie achat intervention', error); res.status(500).json({ error: 'Saisie du matériel impossible.' }); }
  });

  // Les mutations sont toutes conditionnelles sur archivedAt : une concurrence ne peut créer
  // ni seconde trace ni correction d'une écriture archivée entre lecture et écriture.
  app.patch('/api/interventions/:id/couts/:type/:coutId', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
    try {
      const intervention = await chargerInterventionCout(req); const type = String(req.params.type);
      if (!intervention) return res.status(404).json({ error: 'Intervention introuvable.' });
      const heures = type === 'heures'; const achats = type === 'achats';
      if (!heures && !achats) return res.status(404).json({ error: 'Coût introuvable.' });
      if ((heures && req.user!.role !== ROLE_TECHNICIEN) || (achats && !estEncadrementCoutIntervention(req.user!.role))) return res.status(403).json({ error: 'Accès non autorisé.' });
      const body = req.body ?? {};
      const motif = motifCorrectionValide(body.motifCorrection); if (!motif) return res.status(400).json({ error: 'Le motif de correction doit contenir entre 3 et 500 caractères.' });
      const data: Record<string, unknown> = {};
      if ('date' in body) {
        const date = dateIsoStricte(body.date); if (!date) return res.status(400).json({ error: 'La date doit être valide au format JJ-MM-AAAA.' });
        if (heures && !dateHeuresIntervention(date, (await getCompanySettings()).fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT)) return res.status(400).json({ error: HEURES_DATE_FUTURE });
        data.date = date;
      }
      const cleMontant = heures ? 'nbrHeures' : 'montantHT';
      if (cleMontant in body) { const valeur = nombreDecimalNonNegatif(body[cleMontant], heures ? 8 : 10, true); if (valeur === null) return res.status(400).json({ error: 'Montant invalide.' }); data[cleMontant] = valeur; }
      if (heures && 'commentaire' in body) data.commentaire = body.commentaire ? String(body.commentaire).trim() : null;
      if (achats && 'description' in body) { const description = String(body.description || '').trim(); if (!description) return res.status(400).json({ error: 'Description obligatoire.' }); data.description = description; }
      if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Aucun champ à corriger.' });
      const eligible = heures ? interventionHeuresEligible : interventionCoutEligible;
      if (!eligible(intervention)) return res.status(409).json({ error: 'Cette intervention ne peut pas recevoir de coûts.' });
      await verifierAffaireDeLaSuite(prisma, intervention, req.user!.role, false);
      const model: any = heures ? prisma.coutInterventionHeure : prisma.coutInterventionAchat;
      const cout = await model.findFirst({ where: { id: String(req.params.coutId), interventionId: intervention.id } });
      if (!cout) return res.status(404).json({ error: 'Coût introuvable.' });
      if (heures && cout.intervenantId !== (await prisma.intervenant.findFirst({ where: { userId: req.user!.id }, select: { id: true } }))?.id) return res.status(404).json({ error: 'Coût introuvable.' });
      if (cout.archivedAt) return res.status(409).json({ error: 'Un coût archivé ne peut pas être corrigé.' });
      const resultat = await transactionVerifiee(async (tx) => {
        const interventionActuelle = await verrouillerContexteCout(tx, intervention.id, heures ? cout.intervenantId : undefined, heures ? req.user!.id : undefined);
        if (!interventionActuelle || !eligible(interventionActuelle)) return null;
        await verifierAffaireDeLaSuite(tx, interventionActuelle, req.user!.role, true);
        const delegate: any = heures ? tx.coutInterventionHeure : tx.coutInterventionAchat;
        const coutActuel = await delegate.findFirst({ where: { id: cout.id, interventionId: interventionActuelle.id, archivedAt: null } });
        if (!coutActuel) return null;
        if (heures) {
          const intervenantActuel = await tx.intervenant.findFirst({
            where: { id: coutActuel.intervenantId, userId: req.user!.id, affectationsIntervention: { some: { interventionId: interventionActuelle.id } } },
            select: { id: true },
          });
          if (!intervenantActuel) return null;
        }
        const updated = await delegate.updateMany({ where: { id: coutActuel.id, archivedAt: null }, data });
        if (!updated.count) return null;
        const apres = await delegate.findUniqueOrThrow({ where: { id: coutActuel.id } });
        await journaliserCoutIntervention(tx, req, heures ? 'COUT_INTERVENTION_HEURE' : 'COUT_INTERVENTION_ACHAT', 'CORRECTION', coutActuel.id, interventionActuelle.id, coutActuel, apres, motif);
        return heures ? heureOperationnelleTechnicien(apres) : apres;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      if (!resultat) return res.status(409).json({ error: 'Cette intervention ne peut pas recevoir de coûts ou le coût a été modifié concurremment.' });
      res.json(decimalToNumber(resultat));
    } catch (error) { if (error instanceof RefusAffaireSuite) return res.status(error.status).json({ error: error.message }); if (estConflitTransactionCout(error)) return res.status(409).json({ error: 'Conflit concurrent : la correction n’a pas été enregistrée.' }); console.error('Erreur correction coût intervention', error); res.status(500).json({ error: 'Correction impossible.' }); }
  });

  app.post('/api/interventions/:id/couts/:type/:coutId/:action', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
    try {
      const intervention = await chargerInterventionCout(req); const type = String(req.params.type); const action = String(req.params.action);
      if (!intervention) return res.status(404).json({ error: 'Intervention introuvable.' });
      // L'archivage et la restauration sont des actes de conservation : l'encadrement peut
      // les accomplir après la clôture, sans jamais réautoriser une création ou correction. Hors
      // contrat, seules des heures existent : aucun matériel à archiver ni à restaurer. Ceux d'une
      // suite changent la marge de son chantier : ils suivent la règle de son affaire (affaireSuite.ts).
      const heures = type === 'heures'; const achats = type === 'achats';
      if (achats && !intervention.contratMaintenanceId) return res.status(409).json({ error: 'Cette intervention ne peut pas recevoir de coûts.' });
      if ((!heures && !achats) || !['archiver', 'restaurer'].includes(action) || !estEncadrementCoutIntervention(req.user!.role)) return res.status(403).json({ error: 'Accès non autorisé.' });
      await verifierAffaireDeLaSuite(prisma, intervention, req.user!.role, false);
      const model: any = heures ? prisma.coutInterventionHeure : prisma.coutInterventionAchat; const cout = await model.findFirst({ where: { id: String(req.params.coutId), interventionId: intervention.id } });
      if (!cout) return res.status(404).json({ error: 'Coût introuvable.' });
      const motif = motifRestaurationValide(req.body?.motif); if (!motif) return res.status(400).json({ error: 'Le motif doit contenir entre 3 et 500 caractères.' });
      const archivage = action === 'archiver'; if ((archivage && cout.archivedAt) || (!archivage && !cout.archivedAt)) return res.status(409).json({ error: archivage ? 'Ce coût est déjà archivé.' : 'Ce coût est déjà actif.' });
      const resultat = await transactionVerifiee(async (tx) => { await verifierAffaireDeLaSuite(tx, intervention, req.user!.role, true); const delegate: any = heures ? tx.coutInterventionHeure : tx.coutInterventionAchat; const updated = await delegate.updateMany({ where: { id: cout.id, archivedAt: archivage ? null : { not: null } }, data: archivage ? { archivedAt: new Date(), archivedById: req.user!.id, motifArchivage: motif } : { archivedAt: null, archivedById: null, motifArchivage: null } }); if (!updated.count) return null; const apres = await delegate.findUniqueOrThrow({ where: { id: cout.id } }); await journaliserCoutIntervention(tx, req, heures ? 'COUT_INTERVENTION_HEURE' : 'COUT_INTERVENTION_ACHAT', archivage ? 'ARCHIVAGE' : 'RESTAURATION', cout.id, intervention.id, cout, apres, motif); return apres; });
      if (!resultat) return res.status(409).json({ error: 'État du coût modifié concurremment.' }); res.json(saisieSelonDroits(req)(decimalToNumber(resultat)));
    } catch (error) { if (error instanceof RefusAffaireSuite) return res.status(error.status).json({ error: error.message }); console.error('Erreur archivage coût intervention', error); res.status(500).json({ error: 'Opération impossible.' }); }
  });

  // Journal append-only du dossier SAV, soumis au même filtre de non-divulgation que les
  // mutations. Les traces sont ordonnées de la plus récente à la plus ancienne.
  app.get('/api/interventions/:id/journal-saisies', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
    try {
      const intervention = await prisma.intervention.findFirst({ where: { id: paramId(req), ...getInterventionFilterForUser(req.user!) }, select: { id: true } });
      if (!intervention) return res.status(404).json({ error: 'Intervention introuvable.' });
      if (req.user!.role === ROLE_TECHNICIEN) return res.status(403).json({ error: 'Le journal financier est réservé à l’encadrement.' });
      const entrees = await prisma.journalSaisieChantier.findMany({ where: { interventionId: intervention.id }, orderBy: { createdAt: 'desc' } });
      const masquer = saisieSelonDroits(req);
      res.json(decimalToNumber(entrees.map((entree) => ({ ...entree, avant: masquer(chantierDuJournalReduit(entree.avant)), apres: masquer(chantierDuJournalReduit(entree.apres)) }))));
    } catch (error) {
      console.error('Erreur journal intervention SAV', error);
      res.status(500).json({ error: 'Erreur lors de la lecture du journal de l’intervention.' });
    }
  });

  // Les comptes rendus terrain sont des écritures en ajout seul, figées en base dès leur enregistrement
  // (#223) : on ne les ajoute que pendant une intervention en cours, sous le verrou partagé de
  // l'intervention, si bien qu'une clôture simultanée les compte ou les fait refuser. La clé d'envoi,
  // tirée par le formulaire, fait d'un envoi répété la relecture du compte rendu déjà enregistré.
  app.post('/api/interventions/:id/rapports', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
    const cleEnvoi = cleEnvoiValide(req.body?.cleEnvoi);
    const contenu = typeof req.body?.contenu === 'string' ? req.body.contenu.trim() : '';
    // Un compte rendu retrouvé par sa clé n'est rendu que s'il est bien celui que ce compte envoie de
    // nouveau ; une clé déjà servie pour autre chose est refusée, sans rien dire de ce qu'elle porte.
    const repondreExistant = (existant: { interventionId: string; auteurId: string; contenu: string; id: string; createdAt: Date; auteur: { name: string } }, interventionId: string) => {
      if (existant.interventionId !== interventionId || existant.auteurId !== req.user!.id || existant.contenu !== contenu) {
        return res.status(409).json({ error: 'Cette clé d’envoi a déjà servi pour un autre compte rendu : rouvrez le formulaire.' });
      }
      return res.status(200).json({ id: existant.id, contenu: existant.contenu, createdAt: existant.createdAt, auteur: existant.auteur, dejaEnregistre: true });
    };
    const lireParCle = (client: Prisma.TransactionClient | typeof prisma) => client.interventionRapport.findUnique({ where: { cleEnvoi: cleEnvoi! }, select: { ...RAPPORT_SELECT, interventionId: true, auteurId: true } });
    let interventionId = '';
    try {
      if (contenu.length < 3 || contenu.length > 5000) return res.status(400).json({ error: 'Le compte rendu doit contenir entre 3 et 5 000 caractères.' });
      if (contientCaractereInvalide(contenu)) return res.status(400).json({ error: 'Le compte rendu contient un caractère invalide.' });
      if (!cleEnvoi) return res.status(400).json({ error: 'Clé d’envoi du compte rendu absente ou invalide : rechargez la page.' });
      const intervention = await prisma.intervention.findFirst({ where: { id: paramId(req), ...getInterventionFilterForUser(req.user!) }, select: { id: true } });
      if (!intervention) return res.status(404).json({ error: 'Intervention introuvable.' });
      interventionId = intervention.id;
      const resultat = await transactionVerifiee(async (tx) => {
        const statut = await verrouillerIntervention(tx, intervention.id, 'FOR SHARE');
        if (!await interventionDansPerimetre(tx, intervention.id, req.user!)) throw new InterventionHorsPerimetre();
        const existant = await lireParCle(tx);
        if (existant) return { existant };
        if (statut !== 'EN_COURS') throw new RefusIntervention('Un compte rendu s’ajoute pendant que l’intervention est en cours.');
        const rapport = await tx.interventionRapport.create({ data: { interventionId: intervention.id, auteurId: req.user!.id, contenu, cleEnvoi }, select: RAPPORT_SELECT });
        await journaliserCompteRendu(tx, req, 'INTERVENTION_RAPPORT', rapport.id, intervention.id, { id: rapport.id, contenu: rapport.contenu, auteur: rapport.auteur.name });
        return { rapport };
      });
      if ('existant' in resultat) return repondreExistant(resultat.existant!, intervention.id);
      res.status(201).json(resultat.rapport);
    } catch (error) {
      if (error instanceof RefusIntervention) return res.status(409).json({ error: error.message });
      if (error instanceof InterventionHorsPerimetre) return res.status(404).json({ error: 'Intervention introuvable.' });
      // Deux envois simultanés de la même clé : le second bute sur l'index unique, puis relit le premier.
      if ((error as { code?: string }).code === 'P2002' && cleEnvoi && interventionId) {
        const existant = await lireParCle(prisma).catch(() => null);
        if (existant) return repondreExistant(existant, interventionId);
      }
      if (estConflitTransactionCout(error)) return res.status(409).json({ error: 'Conflit concurrent : le compte rendu n’a pas été enregistré.' });
      console.error('Erreur compte rendu intervention SAV', error);
      res.status(500).json({ error: 'Erreur lors de l’enregistrement du compte rendu.' });
    }
  });

  // Attestation électronique : le signataire confirme le texte figé du rapport et le signe au doigt.
  // L'empreinte SHA-256 couvre le texte, le signataire et le tracé ; le compte qui enregistre est
  // conservé. Elle reste possible après la clôture (choix par défaut, #253), jamais sur une
  // intervention annulée.
  app.post('/api/interventions/rapports/:rapportId/signature', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
    try {
      const signataire = typeof req.body?.signataire === 'string' ? req.body.signataire.trim() : '';
      if (signataire.length < 2 || signataire.length > 200 || req.body?.confirme !== true) return res.status(400).json({ error: 'Le signataire et sa confirmation explicite sont obligatoires.' });
      if (contientCaractereInvalide(signataire)) return res.status(400).json({ error: 'Le nom du signataire contient un caractère invalide.' });
      const trace = traceSignatureValide(req.body?.trace);
      if (!trace) return res.status(400).json({ error: 'La signature dessinée du client est absente ou invalide.' });
      const rapport = await prisma.interventionRapport.findFirst({ where: { id: String(req.params.rapportId), intervention: getInterventionFilterForUser(req.user!) }, select: { id: true, interventionId: true } });
      if (!rapport) return res.status(404).json({ error: 'Compte rendu introuvable.' });
      const signature = await transactionVerifiee(async (tx) => {
        const statut = await verrouillerIntervention(tx, rapport.interventionId, 'FOR SHARE');
        if (!await interventionDansPerimetre(tx, rapport.interventionId, req.user!)) throw new InterventionHorsPerimetre();
        if (statut === 'ANNULEE') throw new RefusIntervention('La signature est impossible sur une intervention annulée.');
        const actuel = await tx.interventionRapport.findUniqueOrThrow({ where: { id: rapport.id }, select: { id: true, contenu: true, signature: { select: { id: true } } } });
        if (actuel.signature) throw new RefusIntervention('Ce compte rendu est déjà signé.');
        const empreinte = empreinteSignature(actuel, signataire, trace);
        const cree = await tx.interventionSignature.create({ data: { rapportId: actuel.id, signataire, trace, enregistreParId: req.user!.id, empreinte }, select: SIGNATURE_SELECT });
        await journaliserCompteRendu(tx, req, 'INTERVENTION_SIGNATURE', cree.id, rapport.interventionId, { id: cree.id, rapportId: actuel.id, signataire, empreinte, enregistrePar: cree.enregistrePar.name });
        return cree;
      });
      res.status(201).json(signature);
    } catch (error) {
      if (error instanceof RefusIntervention) return res.status(409).json({ error: error.message });
      if (error instanceof InterventionHorsPerimetre) return res.status(404).json({ error: 'Compte rendu introuvable.' });
      if ((error as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'Ce compte rendu est déjà signé.' });
      if (estConflitTransactionCout(error)) return res.status(409).json({ error: 'Conflit concurrent : la signature n’a pas été enregistrée.' });
      console.error('Erreur signature intervention SAV', error);
      res.status(500).json({ error: 'Erreur lors de la signature du compte rendu.' });
    }
  });

  // Cycle de vie volontairement fermé : une intervention annulée ou terminée ne peut pas
  // être "réouverte" silencieusement, afin de préserver l'historique SAV. Une reprise doit
  // créer un nouveau dossier relié au même client (lot dédié avec motif de reprise).
  // Terminer exige un compte rendu, signé par le client ou, à défaut, accompagné d'un motif consigné
  // au journal, pour tous les comptes (décisions de Nelson des 19 et 20-10-2026). La transition et
  // cette règle se vérifient sous le verrou exclusif de l'intervention. Annuler exige un motif et retire
  // le créneau du planning (décisions de Nelson du 24-10-2026 : « Oui un motif pour une annulation depuis
  // sa fiche », « Retirer du planning »).
  app.patch('/api/interventions/:id/statut', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
    try {
      const statut = String(req.body?.statut || '');
      const transitions: Record<string, string[]> = {
        A_PLANIFIER: ['PLANIFIEE', 'ANNULEE'],
        PLANIFIEE: ['EN_COURS', 'ANNULEE'],
        EN_COURS: ['TERMINEE', 'ANNULEE'],
        TERMINEE: [],
        ANNULEE: [],
      };
      if (!Object.prototype.hasOwnProperty.call(transitions, statut)) return res.status(400).json({ error: 'Statut d’intervention invalide.' });
      const motif = motifClotureValide(req.body?.motifSansSignature, req.body?.precisionMotif);
      if ('erreur' in motif) return res.status(400).json({ error: motif.erreur });
      if (statut !== 'TERMINEE' && motif.texte) return res.status(400).json({ error: 'Un motif sans signature ne s’indique qu’en terminant l’intervention.' });
      // « Terminé » ou « À suivre » (intervention de suivi liée, décisions de Nelson du 24-10-2026, points
      // 28, 29 et 31) : la marque se pose en terminant, selon la règle de clôture normale ; sans le champ,
      // l'intervention se termine sans marque.
      if (req.body?.aSuivre !== undefined && typeof req.body.aSuivre !== 'boolean') return res.status(400).json({ error: 'Indiquez si l’intervention est à suivre (oui ou non).' });
      const aSuivre = req.body?.aSuivre === true;
      if (statut !== 'TERMINEE' && req.body?.aSuivre !== undefined) return res.status(400).json({ error: 'La marque « à suivre » ne s’indique qu’en terminant l’intervention.' });
      // Le journal compare avant/apres : les deux instantanés doivent avoir la même forme,
      // sinon une simple transition se lit comme si le client venait d'être ajouté au dossier.
      const intervention = await prisma.intervention.findFirst({
        where: { id: paramId(req), ...getInterventionFilterForUser(req.user!) },
        include: { client: { select: { id: true, raisonSociale: true } } },
      });
      if (!intervention) return res.status(404).json({ error: 'Intervention introuvable.' });
      if (req.user?.role === ROLE_TECHNICIEN && !['EN_COURS', 'TERMINEE'].includes(statut)) return res.status(403).json({ error: 'Un technicien peut uniquement démarrer ou terminer son intervention.' });
      // Motif de l'annulation (champ `motif`), obligatoire, de 3 à 500 caractères, écrit au journal SAV ; il
      // ne s'indique qu'en annulant, comme le motif sans signature qu'en terminant.
      const annulation = statut === 'ANNULEE';
      const motifAnnulation = annulation ? motifInterventionValide(req.body?.motif) : null;
      if (annulation && !motifAnnulation) return res.status(400).json({ error: MOTIF_ANNULATION_INVALIDE });
      if (!annulation && req.body?.motif !== undefined) return res.status(400).json({ error: 'Un motif ne s’indique qu’en annulant l’intervention.' });
      if (!transitions[intervention.statut]?.includes(statut)) {
        return res.status(409).json({ error: `Transition impossible : ${intervention.statut} vers ${statut}.` });
      }
      const updated = await transactionVerifiee(async (tx) => {
        const statutActuel = await verrouillerIntervention(tx, intervention.id, 'FOR UPDATE');
        if (!await interventionDansPerimetre(tx, intervention.id, req.user!)) throw new InterventionHorsPerimetre();
        if (!statutActuel || !transitions[statutActuel]?.includes(statut)) throw new RefusIntervention(`Transition impossible : ${statutActuel} vers ${statut}.`);
        if (statut === 'TERMINEE') {
          const rapports = await tx.interventionRapport.findMany({ where: { interventionId: intervention.id }, select: { signature: { select: { id: true } } } });
          if (!rapports.length) throw new RefusIntervention('Un compte rendu est obligatoire pour terminer l’intervention.');
          const signe = rapports.some((rapport) => rapport.signature);
          if (signe && motif.texte) throw new RefusIntervention('Un compte rendu est signé par le client : aucun motif n’est à donner.');
          if (!signe && !motif.texte) throw new RefusIntervention('Sans signature du client, choisissez un motif pour terminer l’intervention.');
        }
        // Une annulation retire le créneau du planning (décision de Nelson du 24-10-2026, point 7) : sa
        // projection et ses affectations SAV, sous ce verrou, dans cette transaction. Son journal garde
        // ce qui est retiré dans l'« avant », avec un « après » de même forme ; les autres transitions
        // gardent leur instantané (le client seul).
        const instantane = annulation ? INSTANTANE_CRENEAU : AVEC_CLIENT;
        const avant = await tx.intervention.findUniqueOrThrow({ where: { id: intervention.id }, include: instantane });
        if (annulation) await retirerCreneauIntervention(tx, intervention.id);
        const modifiee = await tx.intervention.update({ where: { id: intervention.id }, data: aSuivre ? { statut, aSuivre } : { statut }, include: instantane });
        // La marque figure dans l'« après » du journal ; le motif le dit aussi, à côté du motif sans signature.
        const motifJournal = annulation ? `Annulation : ${motifAnnulation}` : [motif.texte, aSuivre ? 'Terminée « à suivre »' : null].filter(Boolean).join(' · ') || undefined;
        await journaliserIntervention(tx, req, 'CHANGEMENT_STATUT', modifiee, avant, motifJournal);
        return modifiee;
      });
      res.json(decimalToNumber(updated));
    } catch (error) {
      if (error instanceof RefusIntervention) return res.status(409).json({ error: error.message });
      if (error instanceof InterventionHorsPerimetre) return res.status(404).json({ error: 'Intervention introuvable.' });
      if (estConflitTransactionCout(error)) return res.status(409).json({ error: 'Conflit concurrent : la transition n’a pas été enregistrée.' });
      console.error('Erreur transition intervention SAV', error);
      res.status(500).json({ error: 'Erreur lors de la transition de l’intervention.' });
    }
  });

  // La file contient les interventions encore dépourvues de projection : visites d'un contrat actif et
  // curatives. Le même filtre de périmètre gouverne la fiche SAV et son placement. Elle montre aussi les
  // interventions terminées « à suivre », jusqu'à la création de leur suite (intervention de suivi liée,
  // décision de Nelson du 24-10-2026, point 35), quel que soit l'état du contrat d'une visite : la
  // création de la suite dit alors pourquoi elle est refusée.
  app.get('/api/planning/interventions-a-planifier', requireAuth, blockCommercialEtAssimiles, requirePlanningActif, async (req: AuthRequest, res) => {
    try {
      // Visites d'un contrat actif, et interventions curatives (SAV hors contrat, lot pilote 3) : toute
      // intervention à affecter qui n'a pas encore de projection, dans le périmètre du demandeur.
      const interventions = await prisma.intervention.findMany({
        where: { AND: [
          { OR: [
            { AND: [
              { statut: { in: ['A_PLANIFIER', 'PLANIFIEE'] }, planningEvent: { is: null } },
              { OR: [{ contratMaintenanceId: null }, { contratMaintenance: { is: { statut: 'ACTIF' } } }] },
            ] },
            { statut: 'TERMINEE', aSuivre: true },
          ] },
          getInterventionFilterForUser(req.user!),
        ] },
        select: { id: true, reference: true, titre: true, statut: true, aSuivre: true, echeanceContrat: true, dateSouhaitee: true, priorite: true,
          client: { select: { raisonSociale: true } }, site: { select: { nom: true, ville: true } },
          contratMaintenance: { select: { id: true, titre: true, dureePrevisionnelleMinutes: true } } },
        orderBy: [{ reference: 'asc' }],
      });
      // Par date due : l'échéance d'une visite, la date souhaitée d'une curative ; sans date, en dernier.
      const dateDue = (i: { echeanceContrat: Date | null; dateSouhaitee: Date | null }) => (i.echeanceContrat ?? i.dateSouhaitee)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      interventions.sort((a, b) => dateDue(a) - dateDue(b));
      res.json(interventions.map(({ contratMaintenance, ...intervention }) => ({
        ...intervention, contratMaintenance,
        dureePrevisionnelleMinutes: contratMaintenance?.dureePrevisionnelleMinutes ?? null,
      })));
    } catch (error) {
      res.status(500).json({ error: 'Lecture de la file de planification impossible.' });
    }
  });

  // Crée ou met à jour l'unique projection prévisionnelle d'un dossier SAV. La fiche
  // Intervention reste la source de vérité et les mêmes techniciens sont synchronisés dans
  // InterventionAffectation, afin qu'un planning ne donne jamais accès à un dossier sans affectation.
  app.put('/api/interventions/:id/planning', requireAuth, blockCommercial, blockTechnicien, requirePlanningActif, async (req: AuthRequest, res) => {
    try {
      const id = paramId(req);
      const intervention = await prisma.intervention.findFirst({ where: { id, ...getInterventionFilterForUser(req.user!) }, include: { client: { select: { raisonSociale: true } } } });
      if (!intervention) return res.status(404).json({ error: 'Intervention introuvable.' });
      if (['TERMINEE', 'ANNULEE'].includes(intervention.statut)) return res.status(409).json({ error: 'Cette intervention ne peut plus être planifiée.' });
      const { error, data, intervenantIds } = await validatePlanningEvent({ ...req.body, categorie: 'HORS_CHANTIER', titre: intervention.titre, client: intervention.client.raisonSociale });
      if (error) return res.status(400).json({ error });
      const event = await transactionVerifiee(async (tx) => {
        // Statut et périmètre relus sous le verrou de l'intervention, celui que prennent l'annulation et la
        // remise « à planifier » avant de retirer le créneau : une intervention annulée pendant l'attente
        // est refusée, et aucune projection ne se recrée sur elle (décision de Nelson du 24-10-2026, point 7).
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Intervention" WHERE "id" = ${id} FOR UPDATE`);
        const actuel = await tx.intervention.findFirst({ where: { id, ...getInterventionFilterForUser(req.user!) }, include: { client: { select: { raisonSociale: true } } } });
        if (!actuel) throw new Error('INTERVENTION_HORS_PERIMETRE');
        const projection = await tx.planningEvent.findUnique({ where: { interventionId: id }, select: { id: true } });
        if (['TERMINEE', 'ANNULEE'].includes(actuel.statut)) throw new Error('INTERVENTION_NON_PLANIFIABLE');
        // Seulement au premier placement : ordre intervention → contrat pour sérialiser
        // la suspension/réactivation, puis relire le statut avant toute création.
        if (!projection && actuel.contratMaintenanceId) {
          await verrouillerContratMaintenance(tx, actuel.contratMaintenanceId);
          const contrat = await tx.contratMaintenance.findUniqueOrThrow({ where: { id: actuel.contratMaintenanceId }, select: { statut: true } });
          if (contrat.statut === 'SUSPENDU') throw new Error('CONTRAT_SUSPENDU');
          if (contrat.statut === 'TERMINE') throw new Error('CONTRAT_TERMINE');
          if (contrat.statut === 'ANNULE') throw new Error('CONTRAT_ANNULE');
        }
        const planning = await tx.planningEvent.upsert({
          where: { interventionId: id },
          create: { ...data, interventionId: id, intervenants: { connect: intervenantIds!.map((intervenantId) => ({ id: intervenantId })) } } as never,
          update: { ...data, intervenants: { set: intervenantIds!.map((intervenantId) => ({ id: intervenantId })) } } as never,
          include: PLANNING_EVENT_INCLUDE,
        });
        await synchroniserAffectationsIntervention(tx, id, intervenantIds!);
        if (!projection && actuel.statut === 'A_PLANIFIER') {
          const modifiee = await tx.intervention.update({ where: { id }, data: { statut: 'PLANIFIEE' }, include: { client: { select: { raisonSociale: true } } } });
          await journaliserIntervention(tx, req, 'CHANGEMENT_STATUT', modifiee, actuel);
        }
        return planning;
      });
      res.json(event);
    } catch (error) {
      if ((error as Error).message === 'INTERVENTION_HORS_PERIMETRE') return res.status(404).json({ error: 'Intervention introuvable.' });
      if ((error as Error).message === 'INTERVENTION_NON_PLANIFIABLE') return res.status(409).json({ error: 'Cette intervention ne peut plus être planifiée.' });
      if ((error as Error).message === 'CONTRAT_SUSPENDU') return res.status(409).json({ error: 'Réactivez le contrat avant de planifier cette visite.' });
      if ((error as Error).message === 'CONTRAT_TERMINE') return res.status(409).json({ error: 'Un contrat clos interdit tout nouveau placement de visite.' });
      if ((error as Error).message === 'CONTRAT_ANNULE') return res.status(409).json({ error: 'Un contrat annulé interdit tout nouveau placement de visite.' });
      console.error('Erreur de planification SAV', error);
      res.status(500).json({ error: 'Erreur lors de la planification de l’intervention.' });
    }
  });

  // Inverse du premier placement d'une intervention, visite de contrat ou curative : elle revient « à
  // planifier », son créneau libéré (décisions de Nelson des 23-10-2026, nuit, réponse 2, et 24-10-2026 ;
  // cf. remiseAPlanifier.ts).
  enregistrerRemiseAPlanifier(app);

  // Marque « à suivre » et création d'une suite (intervention de suivi liée ; cf. suites.ts).
  enregistrerSuites(app);
}
