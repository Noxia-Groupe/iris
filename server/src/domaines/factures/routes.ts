import type { Express } from 'express';
import { Prisma } from '@prisma/client';
import { prisma, transactionVerifiee } from '../../db';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { requireAdmin } from '../../http/gardes';
import { paramId } from '../../http/requete';
import {
  FUSEAU_HORAIRE_PAR_DEFAUT, jourCivilEntreprise, dateEmissionEstFuture, dateSeuleEnJourCivil, dateIsoStricte, dateFrancaise,
} from '../../commun/dates';
import {
  decimalToNumber, PLAFOND_MONTANT, FactureInvalideError, tauxUtilises, baseHtDuTaux, tvaDuTaux, arrondiCommercialLigneHt,
  centimesTtcLigne, centimes,
} from '../../commun/montants';
import { nombreDecimalNonNegatif } from '../../commun/validation';
import { estTauxTvaFrancais, REFUS_TAUX_TVA } from '../../commun/tva';
import { csvComptable } from '../../commun/csv';
import { getCompanySettings } from '../administration/metier';
import { CLES_COMPTABLES, verrouillerParametrageComptable, ImputationIncompletError, ecrituresPourPiece } from '../comptabilite/metier';
import {
  factureInclude, formaterAdresseFacturation, FactureRattachementRefuse, ventilationTvaDerivee, ventilationFacture,
  lignesAvoirPartiel, AvoirPlafondError, derniereDateFactureNumerotee, refusDocumentFacture, refuserOrigineAnnulee,
} from './metier';
import { tempsPasseDeLaChaine } from './tempsPasse';
import { champsIdentiteManquants, figerIdentiteEmetteur, IdentiteEmetteurIncompleteError } from '../documents/identite';
import { exigerIdentiteClient, IdentiteClientIncompleteError } from '../documents/identiteClient';
import { avecSoldes, synchroniserStatutReglement } from '../reglements/metier';
import { FACTURE_A_ENVOYER, SaisieEnvoiInvalideError, lireDemandeEnvoi, lireEnvois, propositionDestinataire, repondreEnvoi, texteEnvoiFacture } from '../documents/envois';
import { envoyerDocument, propositionMicrosoft365 } from '../documents/envoiMicrosoft365';
import { produirePdf, repondrePdf } from '../documents/productionPdf';
import { lireFacturePdf, rendreFichierFacturePdf } from './productionPdf';
import { envoiFacture } from './envois';

export function enregistrerRoutesFactures(app: Express): void {
  app.get('/api/factures/chronologie', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const derniere = await derniereDateFactureNumerotee(prisma);
      res.json({ derniereDateEmission: derniere?.dateEmission ?? null });
    } catch { res.status(500).json({ error: 'Lecture de la chronologie impossible.' }); }
  });

  // Factures qui attendent un règlement : émises, non soldées, de tous les clients. Le formulaire
  // de règlement y choisit le client puis les factures à régler ; la liste n'est pas tronquée.
  app.get('/api/factures/a-regler', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const factures = await transactionVerifiee(async tx => avecSoldes(tx, await tx.facture.findMany({
        where: { type: 'FACTURE', statut: 'EMISE' },
        select: { id: true, numero: true, type: true, statut: true, dateEmission: true, dateEcheance: true, totalTtc: true, client: { select: { id: true, raisonSociale: true, actif: true } } },
        orderBy: [{ dateEcheance: 'asc' }, { dateEmission: 'asc' }, { numero: 'asc' }],
      })), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 30_000 });
      res.json(decimalToNumber({ factures: factures.filter(facture => (facture.resteDu ?? 0) > 0) }));
    } catch { res.status(500).json({ error: 'Lecture des factures à régler impossible.' }); }
  });

  app.get('/api/factures', requireAuth, requireAdmin, async (req, res) => {
    const pageQuery = req.query.page, tailleQuery = req.query.pageSize;
    const entierStrict = (valeur: unknown): number | null => {
      if (typeof valeur !== 'string' || !/^[1-9]\d*$/.test(valeur)) return null;
      const nombre = Number(valeur);
      return Number.isSafeInteger(nombre) ? nombre : null;
    };
    const pagine = pageQuery !== undefined || tailleQuery !== undefined;
    const page = entierStrict(pageQuery), pageSize = entierStrict(tailleQuery);
    if (pagine && (page === null || pageSize === null || pageSize > 100)) return res.status(400).json({ error: 'page et pageSize doivent être des entiers positifs (pageSize ≤ 100).' });
    try {
      const orderBy = [{ dateEmission: 'desc' as const }, { createdAt: 'desc' as const }, { id: 'desc' as const }];
      if (!pagine) {
        // Liste complète : délai explicite, une base réelle dépasse vite les 5 s par défaut de Prisma.
        const factures = await transactionVerifiee(async tx => avecSoldes(tx, await tx.facture.findMany({ include: factureInclude, orderBy })), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 30_000 });
        return res.json(decimalToNumber(factures));
      }
      const skip = (page! - 1) * pageSize!;
      // Une seule photo de la base : le total, la page et les soldes de ses factures.
      const { total, items } = await transactionVerifiee(async tx => {
        const total = await tx.facture.count();
        const items = skip >= total ? [] : await avecSoldes(tx, await tx.facture.findMany({ include: factureInclude, orderBy, skip, take: pageSize! }));
        return { total, items };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      return res.json({ items: decimalToNumber(items), page, pageSize, total });
    } catch (error) { return res.status(500).json({ error: 'Lecture des factures impossible.' }); }
  });

  // PDF d'une facture ou d'un avoir émis, lu puis rendu par factures/productionPdf.ts (lot 6b-1a).
  app.get('/api/factures/:id/document.pdf', requireAuth, requireAdmin, async (req, res) => {
    try {
      // REPEATABLE READ, comme les quatre autres PDF : la pièce et ses relations, que Prisma lit en plusieurs requêtes, dans un même instantané.
      return repondrePdf(res, await produirePdf((tx) => lireFacturePdf(tx, String(req.params.id)), rendreFichierFacturePdf, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }));
    } catch { return res.status(500).json({ error: 'Lecture du document de facture impossible.' }); }
  });

  // Envoi d'une facture ou d'un avoir émis par la messagerie de l'utilisateur, et journal des envois
  // (lot 6a-3) : réservés à l'administration, en session, comme le PDF des factures, et refusés comme
  // lui pour une pièce sans document. Lecture : destinataire, objet et texte proposés, et envois déjà
  // préparés, du plus récent au plus ancien, dans une même photo de la base ; microsoft365 : l'envoi par
  // Microsoft 365 est proposé (lot 6b-1b).
  app.get('/api/factures/:id/envois', requireAuth, requireAdmin, async (req, res) => {
    try {
      const lu = await transactionVerifiee(async (tx) => {
        const facture = await tx.facture.findUnique({ where: { id: paramId(req) }, select: FACTURE_A_ENVOYER });
        if (!facture) return { refus: { statut: 404, error: 'Facture introuvable.' } };
        const refus = refusDocumentFacture(facture);
        if (refus) return { refus: { statut: 409, error: refus } };
        const { objet, corps } = await texteEnvoiFacture(tx, facture);
        return { lecture: { proposition: { destinataire: await propositionDestinataire(tx, facture.clientId), objet, corps, microsoft365: await propositionMicrosoft365(tx) }, envois: await lireEnvois(tx, { factureId: facture.id }) } };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      if (lu.refus) return res.status(lu.refus.statut).json({ error: lu.refus.error });
      return res.json(lu.lecture);
    } catch (error) {
      if (error instanceof IdentiteEmetteurIncompleteError) return res.status(409).json({ error: error.message });
      return res.status(500).json({ error: 'Lecture des envois de la facture impossible.' });
    }
  });

  // Enregistrement de l'envoi, sous un verrou partagé de la pièce (./envois.ts) : une annulation ou un
  // avoir en cours est attendu, et l'envoi lit la pièce validée. Préparé par la messagerie (l'écran
  // télécharge le PDF avant cet appel), ou fait par Microsoft 365 avec le PDF figé (lot 6b-1b).
  app.post('/api/factures/:id/envois', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      return repondreEnvoi(res, await envoyerDocument(req, lireDemandeEnvoi(req.body), envoiFacture(paramId(req))));
    } catch (error) {
      if (error instanceof SaisieEnvoiInvalideError) return res.status(400).json({ error: error.message });
      if (error instanceof IdentiteEmetteurIncompleteError) return res.status(409).json({ error: error.message });
      return res.status(500).json({ error: 'Enregistrement de l’envoi de la facture impossible.' });
    }
  });

  app.get('/api/factures/:id/journal', requireAuth, requireAdmin, async (req, res) => {
    try {
      const factureId = String(req.params.id);
      const facture = await prisma.facture.findUnique({ where: { id: factureId }, select: { id: true } });
      if (!facture) return res.status(404).json({ error: 'Facture introuvable.' });
      res.json(await prisma.journalFacture.findMany({ where: { factureId }, orderBy: { createdAt: 'asc' } }));
    } catch { res.status(500).json({ error: 'Lecture du journal de facture impossible.' }); }
  });

  app.get('/api/factures/:id/tracabilite', requireAuth, requireAdmin, async (req, res) => {
    try {
      const facture = await prisma.facture.findUnique({ where: { id: String(req.params.id) }, include: {
        client: { select: { id: true, raisonSociale: true } },
        chantier: { select: { id: true, nom: true, numeroDevis: true, statut: true } },
        intervention: { select: { id: true, reference: true, titre: true, chantierId: true, contratMaintenanceId: true } },
        contratMaintenance: { select: { id: true, titre: true, siteId: true } },
      } });
      if (!facture) return res.status(404).json({ error: 'Facture introuvable.' });
      const chantierId = facture.origine === 'CHANTIER' ? facture.chantierId
        : facture.origine === 'INTERVENTION' ? facture.intervention?.chantierId : null;
      // La facture détermine l'affaire ; valider le client avant de suivre ses relations.
      const affaire = chantierId ? await prisma.chantier.findFirst({ where: { id: chantierId, clientId: facture.clientId }, select: { id: true, nom: true, numeroDevis: true, statut: true } }) : null;
      const [conversions, interventionsLiees] = affaire ? await Promise.all([
        prisma.devisConversion.findMany({ where: { cibleType: 'CHANTIER', cibleId: affaire.id, devis: { clientId: facture.clientId } }, orderBy: { id: 'asc' }, take: 2, include: { devis: { select: { id: true, numero: true, objet: true } } } }),
        prisma.intervention.findMany({ where: { chantierId: affaire.id, clientId: facture.clientId }, select: { id: true, reference: true, titre: true, clientId: true, chantierId: true, statut: true }, orderBy: [{ reference: 'asc' }, { id: 'asc' }] }),
      ]) : [[], []];
      res.json(decimalToNumber({ facture: { ...facture, chantier: affaire }, devis: conversions.length === 1 ? conversions[0].devis : null, devisAmbigu: conversions.length > 1, interventionsLiees }));
    } catch { res.status(500).json({ error: 'Lecture de la traçabilité impossible.' }); }
  });

  app.post('/api/factures', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const clientId = String(req.body?.clientId || '');
      const dateEmission = dateIsoStricte(req.body?.dateEmission);
      const dateEcheance = dateIsoStricte(req.body?.dateEcheance);
      if (!dateEmission || !dateEcheance) return res.status(400).json({ error: 'Les dates doivent être valides au format JJ-MM-AAAA.' });
      if (dateEcheance < dateEmission) return res.status(400).json({ error: 'L’échéance ne peut pas précéder la date d’émission.' });
      const societe = await getCompanySettings();
      const fuseauHoraire = societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT;
      if (dateEmissionEstFuture(dateEmission, fuseauHoraire)) return res.status(400).json({ error: "La date d’émission ne peut pas être future." });
      const client = await prisma.client.findFirst({ where: { id: clientId, actif: true }, select: { id: true, raisonSociale: true } });
      if (!client) return res.status(404).json({ error: 'Client introuvable.' });
      const origine = String(req.body?.origine || '');
      const chantierId = req.body?.chantierId ? String(req.body.chantierId) : null;
      const interventionId = req.body?.interventionId ? String(req.body.interventionId) : null;
      const contratMaintenanceId = req.body?.contratMaintenanceId ? String(req.body.contratMaintenanceId) : null;
      const motifHorsAffaire = String(req.body?.motifHorsAffaire || '').trim() || null;
      const rattachements = [chantierId, interventionId, contratMaintenanceId].filter(Boolean);
      if (!['CHANTIER', 'INTERVENTION', 'CONTRAT', 'HORS_AFFAIRE'].includes(origine) || (origine === 'HORS_AFFAIRE' ? rattachements.length !== 0 || !motifHorsAffaire || motifHorsAffaire.length < 3 : rattachements.length !== 1)) return res.status(400).json({ error: 'L’origine de la facture doit être déclarée et cohérente.' });
      if ((origine === 'CHANTIER' && !chantierId) || (origine === 'INTERVENTION' && !interventionId) || (origine === 'CONTRAT' && !contratMaintenanceId)) return res.status(400).json({ error: 'Le rattachement ne correspond pas à l’origine déclarée.' });
      // Ne jamais déduire l'appartenance par un libellé : les trois origines portent un clientId explicite.
      // Une origine étrangère ou inexistante répond 404 afin de ne pas divulguer son existence.
      // L'affaire (origine CHANTIER) se contrôle dans la transaction de création, plus bas.
      if (origine === 'INTERVENTION' && !await prisma.intervention.findFirst({ where: { id: interventionId!, clientId }, select: { id: true } })) return res.status(404).json({ error: 'Intervention facturable introuvable.' });
      if (origine === 'CONTRAT' && !await prisma.contratMaintenance.findFirst({ where: { id: contratMaintenanceId!, clientId }, select: { id: true } })) return res.status(404).json({ error: 'Contrat facturable introuvable.' });
      const lignesBrutes = Array.isArray(req.body?.lignes) ? req.body.lignes : [];
      if (!lignesBrutes.length) return res.status(400).json({ error: 'Une facture doit contenir au moins une ligne.' });
      const lignes = lignesBrutes.map((ligne: any, ordre: number) => {
        const designation = String(ligne?.designation || '').trim();
        const quantite = nombreDecimalNonNegatif(ligne?.quantite, 9, false, 3);
        const prixUnitaireHt = nombreDecimalNonNegatif(ligne?.prixUnitaireHt, 10, true);
        const tauxTva = nombreDecimalNonNegatif(ligne?.tauxTva, 3, true);
        const nature = String(ligne?.nature || 'PRESTATION');
        if (!designation || designation.length > 500 || !['PRESTATION', 'ARTICLE'].includes(nature) || quantite === null || quantite <= 0 || prixUnitaireHt === null || tauxTva === null || tauxTva > 100) throw new FactureInvalideError('Ligne de facture invalide.');
        if (!estTauxTvaFrancais(tauxTva)) throw new FactureInvalideError(REFUS_TAUX_TVA);
        const totalHt = arrondiCommercialLigneHt(ligne?.quantite, ligne?.prixUnitaireHt);
        const totalTtc = centimesTtcLigne(totalHt, ligne?.tauxTva);
        if (totalTtc > PLAFOND_MONTANT) throw new FactureInvalideError('Montant de ligne hors des limites acceptées.');
        return { ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc };
      });
      const totalHt = centimes(lignes.reduce((s: number, ligne: { totalHt: number }) => s + ligne.totalHt, 0));
      // La TVA légale s'arrondit sur la base HT cumulée de chaque taux, jamais ligne par ligne.
      const ventilationTva = ventilationTvaDerivee(lignes);
      const totalTva = centimes(ventilationTva.reduce((somme, ventilation) => somme + ventilation.totalTva, 0));
      const totalTtc = centimes(totalHt + totalTva);
      if (totalTtc > PLAFOND_MONTANT) throw new FactureInvalideError('Montant de facture hors des limites acceptées.');
      const facture = await transactionVerifiee(async (tx) => {
        // Sous verrou partagé : un changement de client de l'affaire en cours (cf. PATCH
        // /api/chantiers/:id) attend la fin de cette création et voit alors la facture, ou s'enregistre
        // d'abord, et l'affaire n'est plus celle de ce client. Une annulation en cours est attendue de
        // même, puis refusée ci-dessous ; pour une intervention ou un contrat, par refuserOrigineAnnulee.
        if (origine === 'CHANTIER') {
          const [chantier] = await tx.$queryRaw<Array<{ statut: string }>>(Prisma.sql`SELECT "statut" FROM "Chantier" WHERE "id" = ${chantierId} AND "clientId" = ${clientId} FOR SHARE`);
          if (!chantier) throw new FactureRattachementRefuse(404, 'Affaire facturable introuvable.');
          if (chantier.statut === 'ANNULE') throw new FactureRattachementRefuse(409, 'Une affaire annulée ne peut pas être facturée.');
        } else {
          await refuserOrigineAnnulee(tx, { origine, chantierId, interventionId, contratMaintenanceId });
          // Une intervention au temps passé, comme ses suites, se facture par sa facture au temps passé, qui
          // reprend les heures saisies (lot « facture au temps passé », domaines/factures/tempsPasse.ts), ou,
          // quand elle se facture avec le chantier de son affaire, par la facture de ce chantier. Ce refus suit
          // celui d'une origine annulée : une intervention annulée n'est pas renvoyée à une autre facture,
          // refusée à son tour (#352, audit n° 2 de #351, N2 ; audit n° 1 de #361, C1).
          const tempsPasse = origine === 'INTERVENTION' ? await tempsPasseDeLaChaine(tx, interventionId!) : null;
          if (tempsPasse) throw new FactureRattachementRefuse(409, tempsPasse.avecLeChantier
            ? `L’intervention ${tempsPasse.reference} est au temps passé et se facture avec le chantier de son affaire, comme ses suites : créez la facture du chantier.`
            : `L’intervention ${tempsPasse.reference} est au temps passé : sa facture, et celle de ses suites, reprend les heures saisies. Créez-la par « Facture au temps passé ».`);
        }
        const creee = await tx.facture.create({ data: { clientId, clientRaisonSociale: client.raisonSociale, origine, chantierId, interventionId, contratMaintenanceId, motifHorsAffaire, dateEmission, dateEcheance, totalHt, totalTva, totalTtc, createdById: req.user!.id, lignes: { create: lignes }, ventilationTva: { create: ventilationTva } }, include: factureInclude });
        await tx.journalFacture.create({ data: { factureId: creee.id, acteurId: req.user!.id, action: 'CREATION_BROUILLON', detail: `Origine ${origine}` } });
        return creee;
      });
      res.status(201).json(decimalToNumber(facture));
    } catch (error) {
      if (error instanceof FactureInvalideError) return res.status(400).json({ error: error.message });
      if (error instanceof FactureRattachementRefuse) return res.status(error.statut).json({ error: error.message });
      res.status(500).json({ error: 'Création de facture impossible.' });
    }
  });

  app.get('/api/facturation/prete-a-facturer', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const [settings, comptes, regles, reglesTva, tauxFactures, mentions, clientsSansSite] = await Promise.all([
        getCompanySettings(), prisma.compteComptable.count({ where: { actif: true } }),
        prisma.regleComptable.findMany({ where: { cle: { in: CLES_COMPTABLES } }, include: { compte: true } }),
        prisma.regleTvaComptable.findMany({ where: { compte: { actif: true } }, select: { taux: true } }),
        prisma.factureLigne.findMany({ where: { facture: { statut: { in: ['EMISE', 'REGLEE', 'ANNULEE'] } } }, distinct: ['tauxTva'], select: { tauxTva: true } }),
        prisma.mentionsLegalesVersion.findFirst({ where: { actif: true, publieeLe: { not: null } }, select: { id: true } }),
        prisma.client.count({ where: { actif: true, sites: { none: {} } } }),
      ]);
      const parCle = new Map(regles.map(regle => [regle.cle, regle]));
      const reglesOk = CLES_COMPTABLES.every(cle => cle === 'JOURNAL_VENTES' ? Boolean(parCle.get(cle)?.journal) : Boolean(parCle.get(cle)?.compte?.actif));
      const tauxCouverts = new Set(reglesTva.map(regle => Number(regle.taux)));
      const tauxManquants = [...new Set(tauxFactures.map(ligne => Number(ligne.tauxTva)))].filter(taux => taux !== 0 && !tauxCouverts.has(taux)).sort((a, b) => a - b);
      // Les taux historiques servent de signal pour de futures émissions ; l'export des
      // pièces déjà émises relit leurs écritures figées. Le 0 % n'exige aucun compte TVA.
      const tvaOk = tauxCouverts.size > 0 && tauxManquants.length === 0;
      const prefixe = (settings.prefixeFacture || '').trim();
      const identiteManquante = champsIdentiteManquants(settings);
      const controles = [
        { cle: 'PLAN_COMPTABLE', bloquant: true, pret: comptes > 0, libelle: 'Plan comptable', detail: comptes > 0 ? `${comptes} compte(s) actif(s).` : 'Importez ou créez au moins un compte.', route: '/comptabilite' },
        { cle: 'REGLES_COMPTABLES', bloquant: true, pret: reglesOk, libelle: 'Règles comptables', detail: reglesOk ? 'Les règles client, ventes et journal sont renseignées.' : 'Renseignez les comptes client, ventes et le journal.', route: '/comptabilite' },
        { cle: 'TVA', bloquant: tauxManquants.length > 0, pret: tvaOk, libelle: 'Règles TVA', detail: tauxManquants.length ? `Aucun compte TVA pour ${tauxManquants.map(taux => `${taux} %`).join(', ')} — ce taux a déjà été facturé ; l’émission d’une nouvelle facture à ce taux sera refusée (l’export historique reste disponible).` : !tauxCouverts.size ? 'Aucun compte TVA associé. Une entreprise qui ne facture qu’à 0 % (autoliquidation BTP) n’en a pas besoin ; sinon, associez un compte avant la première facture à un taux non nul.' : `${tauxCouverts.size} taux configuré(s) ; tous les taux déjà facturés sont couverts.`, route: '/comptabilite' },
        { cle: 'IDENTITE_EMETTEUR', bloquant: true, pret: identiteManquante.length === 0, libelle: 'Identité de la société', detail: identiteManquante.length ? `À renseigner avant d’émettre : ${identiteManquante.join(', ')}. Elle est copiée sur chaque pièce à son émission.` : 'Raison sociale, SIRET, adresse, code postal et ville sont renseignés ; ils sont copiés sur chaque pièce à son émission.', route: '/societe' },
        { cle: 'MENTIONS_LEGALES', bloquant: true, pret: Boolean(mentions), libelle: 'Mentions légales et CGV', detail: mentions ? 'Une version publiée est active.' : 'Publiez une version légale validée.', route: '/mentions-legales' },
        { cle: 'PREFIXE_FACTURE', bloquant: false, pret: Boolean(prefixe), libelle: 'Préfixe de facture', detail: prefixe ? `Préfixe actuel : ${prefixe}.` : 'Aucun préfixe défini : les numéros utiliseront « F » par défaut.', route: null },
        { cle: 'ADRESSES_CLIENTS', bloquant: false, pret: clientsSansSite === 0, libelle: 'Adresses de facturation', detail: clientsSansSite === 0 ? 'Tous les clients actifs portent au moins un site.' : `${clientsSansSite} client(s) actif(s) sans aucun site : l’émission de leurs factures sera refusée.`, route: '/clients' },
      ];
      res.json({ pret: controles.every(controle => !controle.bloquant || controle.pret), controles });
    } catch { res.status(500).json({ error: 'Lecture des prérequis de facturation impossible.' }); }
  });
}

export function enregistrerRoutesEmissionFactures(app: Express): void {
  app.get('/api/factures/export-comptable.csv', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const societe = await getCompanySettings();
      // Une facture numérotée ne quitte jamais le journal des ventes : l'avoir la neutralise
      // par une pièce distincte, sans effacer ses écritures ni son numéro légal déjà exporté.
      // Les annulations historiques sans avoir gardent leur contre-passation legacy ci-dessous.
      const factures = await prisma.facture.findMany({ where: { statut: { in: ['EMISE', 'REGLEE', 'ANNULEE'] } }, include: { ecrituresComptables: { orderBy: { ordre: 'asc' } }, avoirs: { select: { id: true } }, journal: { where: { action: 'ANNULATION' }, orderBy: { createdAt: 'desc' }, take: 1 } }, orderBy: [{ dateEmission: 'asc' }, { numero: 'asc' }] });
      if (factures.some(f => !f.ecrituresComptables.length)) return res.status(409).json({ error: 'Export bloqué : pièce historique sans imputation comptable validée.' });
      // Deux classes de dates, deux lectures — les confondre décale l'écriture d'un jour, et
      // d'un exercice au 1er janvier. La date d'émission est une DATE-SEULE déjà stockée à minuit
      // UTC : elle se lit telle quelle. La date d'annulation vient d'un INSTANT : elle se lit
      // dans le fuseau de l'entreprise, sinon une décision prise vers minuit change d'exercice.
      const fuseauHoraire = societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT;
      const jourDeDateSeule = (date: Date | string) => dateSeuleEnJourCivil(date).replace(/-/g, '');
      const jourDInstant = (instant: Date) => jourCivilEntreprise(instant, fuseauHoraire).replace(/-/g, '');
      const lignes = ['JournalCode;EcritureDate;PieceRef;CompteNum;CompteLib;Libelle;Debit;Credit'];
      for (const f of factures) {
        const date = jourDeDateSeule(f.dateEmission);
        const libelle = `${f.type === 'AVOIR' ? 'Avoir' : 'Facture'} ${f.numero} — ${f.clientRaisonSociale}`;
        const ecrire = (dateEcriture: string, texte: string, contrepasse: boolean) => {
          for (const e of f.ecrituresComptables) lignes.push([e.journalCode, dateEcriture, f.numero, e.compteNum, e.compteLib, texte,
            Number(contrepasse ? e.credit : e.debit).toFixed(2), Number(contrepasse ? e.debit : e.credit).toFixed(2)].map(csvComptable).join(';'));
        };
        ecrire(date, libelle, false);
        if (f.statut === 'ANNULEE' && !f.avoirs.length) ecrire(f.journal[0] ? jourDInstant(f.journal[0].createdAt) : date, `Annulation facture ${f.numero} — ${f.clientRaisonSociale}`, true);
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="export-ventes.csv"'); res.send(`\uFEFF${lignes.join('\n')}\n`);
    } catch { res.status(500).json({ error: 'Export comptable impossible.' }); }
  });

  app.post('/api/mentions-legales/:version/publier', requireAuth, requireAdmin, async (req, res) => {
    try {
      const version = Number(req.params.version);
      if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: 'Version légale invalide.' });
      const publiee = await transactionVerifiee(async (tx) => {
        const cible = await tx.mentionsLegalesVersion.findUnique({ where: { version } });
        if (!cible) return null;
        await tx.mentionsLegalesVersion.updateMany({ where: { actif: true }, data: { actif: false } });
        return tx.mentionsLegalesVersion.update({ where: { version }, data: { actif: true, ...(cible.publieeLe === null ? { publieeLe: new Date() } : {}) } });
      });
      if (!publiee) return res.status(404).json({ error: 'Version légale introuvable.' });
      res.json(publiee);
    } catch { res.status(500).json({ error: 'Publication de la version légale impossible.' }); }
  });

  app.post('/api/mentions-legales', requireAuth, requireAdmin, async (req, res) => {
    try {
      const mentions = String(req.body?.mentions || '').trim(), cgv = String(req.body?.cgv || '').trim(), penalites = String(req.body?.penalites || '').trim();
      const escompte = String(req.body?.escompte || '').trim() || null;
      if (!mentions || !cgv || !penalites) return res.status(400).json({ error: 'Les mentions, CGV et pénalités sont obligatoires.' });
      const derniere = await prisma.mentionsLegalesVersion.aggregate({ _max: { version: true } });
      const version = await prisma.mentionsLegalesVersion.create({ data: { version: (derniere._max.version || 0) + 1, mentions, cgv, penalites, escompte } });
      res.status(201).json(version);
    } catch { res.status(500).json({ error: 'Création de la version légale impossible.' }); }
  });

  app.get('/api/mentions-legales', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const versions = await prisma.mentionsLegalesVersion.findMany({ orderBy: { version: 'desc' } });
      res.json(versions);
    } catch { res.status(500).json({ error: 'Lecture des mentions légales impossible.' }); }
  });

  app.post('/api/factures/:id/emettre', requireAuth, requireAdmin, async (req, res) => {
    try {
      const resultat = await transactionVerifiee(async (tx) => {
        await verrouillerParametrageComptable(tx);
        const facture = await tx.facture.findUnique({ where: { id: paramId(req) }, include: { lignes: true, ventilationTva: true } });
        if (!facture) return { erreur: 'NOT_FOUND' as const };
        if (facture.statut !== 'BROUILLON') return { erreur: 'NOT_DRAFT' as const };
        // Un brouillon dont l'origine a été annulée depuis sa création ne s'émet pas (choix par défaut validé
        // par Nelson le 29-10-2026) ; faute de route qui l'abandonne, il reste brouillon.
        await refuserOrigineAnnulee(tx, facture);
        const annee = facture.dateEmission.getUTCFullYear();
        const derniereEmise = await derniereDateFactureNumerotee(tx);
        if (derniereEmise && facture.dateEmission < derniereEmise.dateEmission) return { erreur: 'CHRONOLOGY' as const, limite: derniereEmise.dateEmission };
        const mentions = await tx.mentionsLegalesVersion.findFirst({ where: { actif: true, publieeLe: { not: null } }, select: { id: true } });
        if (!mentions) return { erreur: 'LEGAL_MENTIONS_MISSING' as const };
        // Avant le numéro : un refus ne consomme aucun numéro de la séquence, et annule la copie de
        // l'identité de la société. La société passe avant le client, comme à la signature d'un devis.
        const identiteEmetteurId = await figerIdentiteEmetteur(tx);
        // Lot 6a-2 bis : identité minimale du client (raison sociale, adresse de facturation et SIREN,
        // ou nom complet et adresse pour un particulier « pas de SIRET »), relue dans la transaction.
        // Le site retenu est celui dont l'adresse est copiée sur la facture.
        const { siteFacturation } = await exigerIdentiteClient(tx, facture.clientId, 'd’émettre une facture');
        const ecritures = await ecrituresPourPiece(tx, facture);
        const sequence = await tx.sequenceFacture.upsert({ where: { annee }, create: { annee, dernierNumero: 1 }, update: { dernierNumero: { increment: 1 } } });
        const identite = await tx.companySettings.findUnique({ where: { id: 'singleton' }, select: { prefixeFacture: true } });
        const prefixe = (identite?.prefixeFacture || 'F').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'F';
        const numero = `${prefixe}${annee}-${String(sequence.dernierNumero).padStart(4, '0')}`;
        const maj = await tx.facture.update({ where: { id: facture.id }, data: { statut: 'EMISE', annee, numero, emisLe: new Date(), mentionsLegalesVersionId: mentions.id, identiteEmetteurId, clientAdresse: formaterAdresseFacturation(siteFacturation) }, include: factureInclude });
        await tx.ecritureFacture.createMany({ data: ecritures.map(e => ({ ...e, factureId: facture.id })) });
        await tx.facture.update({ where: { id: facture.id }, data: { ecrituresScellees: true } });
        await tx.journalFacture.create({ data: { factureId: facture.id, acteurId: (req as AuthRequest).user!.id, action: 'EMISSION', detail: `Numéro ${numero}, version légale ${mentions.id}, identité de l’émetteur ${identiteEmetteurId}` } });
        return { facture: { ...maj, ecrituresScellees: true } };
      });
      if ('erreur' in resultat) {
        if (resultat.erreur === 'NOT_FOUND') return res.status(404).json({ error: 'Facture introuvable.' });
        if (resultat.erreur === 'CHRONOLOGY') return res.status(409).json({ error: `La numérotation est chronologique : la dernière facture émise porte la date du ${dateFrancaise(resultat.limite)}. Ce brouillon ne peut plus être numéroté.` });
        if (resultat.erreur === 'LEGAL_MENTIONS_MISSING') return res.status(409).json({ error: 'Aucune version publiée des mentions légales et CGV n’est active. Publiez-en une avant d’émettre une facture.' });
        return res.status(409).json({ error: 'Seul un brouillon peut être émis.' });
      }
      res.json(decimalToNumber(resultat.facture));
    } catch (error) {
      if (error instanceof ImputationIncompletError || error instanceof IdentiteEmetteurIncompleteError || error instanceof IdentiteClientIncompleteError) return res.status(409).json({ error: error.message });
      if (error instanceof FactureRattachementRefuse) return res.status(error.statut).json({ error: error.message });
      if ((error as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'Numérotation de facture déjà attribuée, veuillez réessayer.' });
      res.status(500).json({ error: 'Émission de facture impossible.' });
    }
  });

  // « Réglée » ne se coche plus à la main : une facture le devient quand ses règlements la
  // soldent (POST /api/reglements). L'ancienne route répond explicitement plutôt qu'un 404 muet.
  app.post('/api/factures/:id/regler', requireAuth, requireAdmin, (_req, res) => {
    res.status(410).json({ error: 'Une facture n’est plus marquée réglée à la main : enregistrez le règlement reçu (montant, date, moyen), elle passe à « réglée » quand elle est soldée.' });
  });

  // L’annulation d’une facture émise est une transition métier atomique : elle conserve la
  // facture historique, crée son unique avoir total et lie les deux documents dans la même TX.
  app.post('/api/factures/:id/annuler', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const resultat = await transactionVerifiee(async (tx) => {
        // Toute décision qui crée un avoir ou annule la facture source acquiert ce verrou
        // d'abord. Même ordre que POST /avoirs : facture puis séquence, afin d'éviter à la
        // fois un reliquat lu périmé et les interblocages entre annulation et avoir partiel.
        await tx.$queryRaw`SELECT 1 FROM "Facture" WHERE "id" = ${paramId(req)} FOR UPDATE`;
        const facture = await tx.facture.findUnique({ where: { id: paramId(req) }, include: { lignes: { orderBy: { ordre: 'asc' } }, ventilationTva: true, avoirs: { select: { id: true } } } });
        if (!facture) return { erreur: 'NOT_FOUND' as const };
        if (facture.statut !== 'EMISE' || facture.type !== 'FACTURE') return { erreur: 'NOT_EMITTED' as const };
        if (facture.avoirs.length) return { erreur: 'PARTIAL_CREDITS_EXIST' as const };
        // Un règlement affecté est un encaissement réel : l'annulation totale le laisserait sans
        // facture. Le garde SQL `facture_statut_reglements` porte la même règle.
        const reglee = await tx.affectationReglement.count({ where: { factureId: facture.id, reglement: { statut: 'ENREGISTRE' } } });
        if (reglee) return { erreur: 'PAYMENTS_EXIST' as const };
        // L'avoir naît émis : il copie l'identité de l'émetteur du jour, avant toute écriture.
        const identiteEmetteurId = await figerIdentiteEmetteur(tx);
        const ecritures = await ecrituresPourPiece(tx, facture, facture.id);
        const now = new Date();
        const societe = await tx.companySettings.findUnique({ where: { id: 'singleton' }, select: { prefixeAvoir: true, fuseauHoraire: true } });
        const jour = jourCivilEntreprise(now, societe?.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);
        const dateAvoir = new Date(`${jour}T00:00:00.000Z`);
        const annee = dateAvoir.getUTCFullYear();
        const sequence = await tx.sequenceAvoir.upsert({ where: { annee }, create: { annee, dernierNumero: 1 }, update: { dernierNumero: { increment: 1 } } });
        const prefixe = (societe?.prefixeAvoir || 'A').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'A';
        const numero = `${prefixe}${annee}-${String(sequence.dernierNumero).padStart(4, '0')}`;
        const maj = await tx.facture.updateMany({ where: { id: facture.id, statut: 'EMISE', type: 'FACTURE' }, data: { statut: 'ANNULEE' } });
        if (!maj.count) return { erreur: 'NOT_EMITTED' as const };
        const avoir = await tx.facture.create({ data: {
          type: 'AVOIR', estAvoirAnnulation: true, factureOrigineId: facture.id, numero, annee, statut: 'EMISE', dateEmission: dateAvoir, dateEcheance: dateAvoir,
          clientId: facture.clientId, clientRaisonSociale: facture.clientRaisonSociale, clientAdresse: facture.clientAdresse,
          origine: facture.origine, chantierId: facture.chantierId, interventionId: facture.interventionId, contratMaintenanceId: facture.contratMaintenanceId,
          motifHorsAffaire: facture.motifHorsAffaire, mentionsLegalesVersionId: facture.mentionsLegalesVersionId, identiteEmetteurId,
          totalHt: facture.totalHt, totalTva: facture.totalTva, totalTtc: facture.totalTtc, createdById: req.user!.id, emisLe: now,
          lignes: { create: facture.lignes.map(({ id: _id, factureId: _factureId, ...ligne }) => ligne) },
          ventilationTva: { create: facture.ventilationTva.length ? facture.ventilationTva.map(({ id: _id, factureId: _factureId, ...v }) => v) : ventilationTvaDerivee(facture.lignes) },
          ecrituresComptables: { create: ecritures },
        }, include: factureInclude });
        await tx.facture.update({ where: { id: avoir.id }, data: { ecrituresScellees: true } });
        await tx.journalFacture.create({ data: { factureId: facture.id, acteurId: req.user!.id, action: 'ANNULATION', detail: `Transition EMISE → ANNULEE ; avoir total ${numero}` } });
        await tx.journalFacture.create({ data: { factureId: avoir.id, acteurId: req.user!.id, action: 'CREATION_AVOIR', detail: `Avoir total de la facture ${facture.numero}` } });
        return { facture: await tx.facture.findUniqueOrThrow({ where: { id: facture.id }, include: factureInclude }), avoir: { ...avoir, ecrituresScellees: true } };
      });
      if ('erreur' in resultat) {
        if (resultat.erreur === 'NOT_FOUND') return res.status(404).json({ error: 'Facture introuvable.' });
        if (resultat.erreur === 'PARTIAL_CREDITS_EXIST') return res.status(409).json({ error: 'Cette facture porte déjà un ou plusieurs avoirs partiels : elle ne peut plus être annulée en totalité.' });
        if (resultat.erreur === 'PAYMENTS_EXIST') return res.status(409).json({ error: 'Cette facture a reçu un règlement : elle ne peut plus être annulée en totalité. Émettez un avoir partiel, ou contre-passez d’abord un règlement saisi par erreur.' });
        return res.status(409).json({ error: 'Seule une facture émise peut être annulée.' });
      }
      return res.json(decimalToNumber({ ...resultat.facture, avoir: resultat.avoir }));
    } catch (error) {
      if (error instanceof ImputationIncompletError || error instanceof IdentiteEmetteurIncompleteError) return res.status(409).json({ error: error.message });
      if ((error as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'Avoir déjà créé ou numéro déjà attribué, veuillez relire la facture.' });
      return res.status(500).json({ error: 'Annulation de facture impossible.' });
    }
  });

  // Un avoir partiel est un document émis immédiatement : il n’annule jamais la facture
  // source et reprend tous ses snapshots. Le verrou SQL de la source sérialise les créations
  // concurrentes avant le contrôle cumulatif des plafonds HT, TVA et TTC.
  app.post('/api/factures/:id/avoirs', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const lignes = lignesAvoirPartiel(req.body?.lignes);
      const resultat = await transactionVerifiee(async (tx) => {
        // PostgreSQL verrouille la facture source jusqu’à la fin de la transaction ; sans ce
        // verrou, deux administrateurs pourraient chacun lire le même reliquat puis le dépasser.
        await tx.$queryRaw`SELECT 1 FROM "Facture" WHERE "id" = ${paramId(req)} FOR UPDATE`;
        const facture = await tx.facture.findUnique({ where: { id: paramId(req) }, include: { lignes: true, ventilationTva: true, avoirs: { include: { lignes: true, ventilationTva: true } } } });
        if (!facture) return { erreur: 'NOT_FOUND' as const };
        if (facture.type !== 'FACTURE' || !['EMISE', 'REGLEE'].includes(facture.statut)) return { erreur: 'NOT_CREDITABLE' as const };
        const tauxSource = new Set(tauxUtilises(facture.lignes));
        for (const taux of tauxUtilises(lignes)) if (!tauxSource.has(taux)) throw new FactureInvalideError('Le taux de TVA d’une ligne d’avoir doit être présent sur la facture d’origine.');
        const avoirsPrecedents = facture.avoirs;
        // La TVA de l'avoir est la différence des arrondis des bases HT cumulées avant/après.
        const ventilationSource = new Map(ventilationFacture(facture).map(ventilation => [ventilation.tauxTva, ventilation]));
        const ventilationTva = tauxUtilises(lignes).sort((a, b) => a - b).map(tauxTva => {
          const totalHt = baseHtDuTaux(lignes, tauxTva);
          const totalHtPrecedent = centimes(avoirsPrecedents.reduce((somme, avoir) => somme + (ventilationFacture(avoir).find(ventilation => ventilation.tauxTva === tauxTva)?.totalHt || 0), 0));
          const totalTvaPrecedent = tvaDuTaux([{ tauxTva, totalHt: totalHtPrecedent }], tauxTva);
          const totalTvaApres = tvaDuTaux([{ tauxTva, totalHt: centimes(totalHtPrecedent + totalHt) }], tauxTva);
          const totalTva = centimes(totalTvaApres - totalTvaPrecedent);
          return { tauxTva, totalHt, totalTva, totalTtc: centimes(totalHt + totalTva) };
        });
        const totalHt = centimes(ventilationTva.reduce((somme, ventilation) => somme + ventilation.totalHt, 0));
        const totalTva = centimes(ventilationTva.reduce((somme, ventilation) => somme + ventilation.totalTva, 0));
        const totalTtc = centimes(totalHt + totalTva);
        if (totalTtc > PLAFOND_MONTANT) throw new FactureInvalideError('Montant d’avoir hors des limites acceptées.');
        const sommePrecedente = (champ: 'totalHt' | 'totalTva' | 'totalTtc') => centimes(avoirsPrecedents.reduce((somme, avoir) => somme + Number(avoir[champ]), 0));
        if (centimes(sommePrecedente('totalHt') + totalHt) > Number(facture.totalHt) || centimes(sommePrecedente('totalTva') + totalTva) > Number(facture.totalTva) || centimes(sommePrecedente('totalTtc') + totalTtc) > Number(facture.totalTtc)) throw new AvoirPlafondError('Cet avoir dépasse le montant total restant à créditer sur la facture d’origine.');
        for (const ventilation of ventilationTva) {
          const source = ventilationSource.get(ventilation.tauxTva)!;
          const precedent = avoirsPrecedents.reduce((somme, avoir) => somme + (ventilationFacture(avoir).find(v => v.tauxTva === ventilation.tauxTva)?.totalHt || 0), 0);
          const tvaPrecedente = avoirsPrecedents.reduce((somme, avoir) => somme + (ventilationFacture(avoir).find(v => v.tauxTva === ventilation.tauxTva)?.totalTva || 0), 0);
          if (centimes(precedent + ventilation.totalHt) > source.totalHt || centimes(tvaPrecedente + ventilation.totalTva) > source.totalTva || centimes(precedent + ventilation.totalHt + tvaPrecedente + ventilation.totalTva) > source.totalTtc) throw new AvoirPlafondError(`Cet avoir dépasse le plafond restant pour la TVA à ${ventilation.tauxTva} % de la facture d’origine.`);
        }
        const identiteEmetteurId = await figerIdentiteEmetteur(tx);
        const ecritures = await ecrituresPourPiece(tx, { lignes, ventilationTva, totalTtc }, facture.id);
        const now = new Date();
        const societe = await tx.companySettings.findUnique({ where: { id: 'singleton' }, select: { prefixeAvoir: true, fuseauHoraire: true } });
        const jour = jourCivilEntreprise(now, societe?.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);
        const dateAvoir = new Date(`${jour}T00:00:00.000Z`);
        const annee = dateAvoir.getUTCFullYear();
        const sequence = await tx.sequenceAvoir.upsert({ where: { annee }, create: { annee, dernierNumero: 1 }, update: { dernierNumero: { increment: 1 } } });
        const prefixe = (societe?.prefixeAvoir || 'A').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'A';
        const numero = `${prefixe}${annee}-${String(sequence.dernierNumero).padStart(4, '0')}`;
        const avoir = await tx.facture.create({ data: {
          type: 'AVOIR', estAvoirAnnulation: false, factureOrigineId: facture.id, numero, annee, statut: 'EMISE', dateEmission: dateAvoir, dateEcheance: dateAvoir,
          clientId: facture.clientId, clientRaisonSociale: facture.clientRaisonSociale, clientAdresse: facture.clientAdresse,
          origine: facture.origine, chantierId: facture.chantierId, interventionId: facture.interventionId, contratMaintenanceId: facture.contratMaintenanceId,
          motifHorsAffaire: facture.motifHorsAffaire, mentionsLegalesVersionId: facture.mentionsLegalesVersionId, identiteEmetteurId,
          totalHt, totalTva, totalTtc, createdById: req.user!.id, emisLe: now, lignes: { create: lignes }, ventilationTva: { create: ventilationTva },
          ecrituresComptables: { create: ecritures },
        }, include: factureInclude });
        await tx.facture.update({ where: { id: avoir.id }, data: { ecrituresScellees: true } });
        await tx.journalFacture.create({ data: { factureId: avoir.id, acteurId: req.user!.id, action: 'CREATION_AVOIR_PARTIEL', detail: `Avoir partiel de la facture ${facture.numero}` } });
        // L'avoir baisse le reste dû : une facture déjà réglée en partie peut devenir soldée.
        await synchroniserStatutReglement(tx, facture.id, req.user!.id, `avoir partiel ${numero}`);
        return { avoir: { ...avoir, ecrituresScellees: true } };
      });
      if ('erreur' in resultat) return res.status(resultat.erreur === 'NOT_FOUND' ? 404 : 409).json({ error: resultat.erreur === 'NOT_FOUND' ? 'Facture introuvable.' : 'Seule une facture émise ou réglée peut recevoir un avoir partiel.' });
      return res.status(201).json(decimalToNumber(resultat.avoir));
    } catch (error) {
      if (error instanceof ImputationIncompletError || error instanceof IdentiteEmetteurIncompleteError) return res.status(409).json({ error: error.message });
      if (error instanceof FactureInvalideError) return res.status(400).json({ error: error.message });
      if (error instanceof AvoirPlafondError) return res.status(409).json({ error: error.message });
      if ((error as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'Avoir total déjà créé ou numéro déjà attribué, veuillez relire la facture.' });
      return res.status(500).json({ error: 'Création de l’avoir partiel impossible.' });
    }
  });
}
