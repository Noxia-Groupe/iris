import type { Express, RequestHandler } from 'express';
import { prisma, transactionVerifiee } from '../../db';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { requireAdmin } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { decimalToNumber } from '../../commun/montants';
import { exposerIntervention } from '../interventions/metier';
import { IdentiteEmetteurIncompleteError } from '../documents/identite';
import { DestinataireInvalideError, enregistrerEnvoi, lireEnvois, propositionDestinataire, texteEnvoiContrat, validerDestinataire } from '../documents/envois';
import { GenerationVisitesDesactivee, etatGenerationVisites, executerGenerationVisites } from './generation';
import { journaliserContrat, motifContratValide, lirePolitiqueCouverture, verrouillerContratMaintenance, lireSaisieContrat, creerContratMaintenance, SaisieContratInvalide, visiteDeLEcheance, creerVisiteContrat, avancerEcheanceContrat, VISITE_INCLUDE } from './metier';
import { produirePdf, repondrePdf } from '../documents/productionPdf';
import { lireContratPdf, rendreFichierContratPdf } from './productionPdf';

// Un contrat annulé avec son devis (lot 4 suite) ne se modifie, ne se suspend, ne se clôt ni ne se
// réactive plus ; la base le refuse aussi (trigger contrat_annule_fige). La suspension et la clôture
// d'un contrat restent, elles, documentées par un motif obligatoire et journalisé.
const REFUS_CONTRAT_ANNULE = 'Ce contrat a été annulé avec son devis : il ne se modifie plus.';

// PDF du contrat de maintenance (lot 6a-4b) : récapitulatif du contrat, de tout statut, avec
// l'identité actuelle de la société, refusé (409) si elle est incomplète. Toutes les lectures se font
// dans un même instantané (REPEATABLE READ) : le contrat, ses visites, son devis d'origine, le site de
// facturation du client et l'identité de la société, logo compris. Le PDF est lu puis rendu par
// contrats/productionPdf.ts (lot 6b-1a), le rendu après la transaction.
const imprimerContrat: RequestHandler = async (req, res) => {
  try {
    repondrePdf(res, await produirePdf((tx) => lireContratPdf(tx, paramId(req)), rendreFichierContratPdf, { isolationLevel: 'RepeatableRead' }));
  } catch (error) {
    console.error('Contrat de maintenance, PDF :', error);
    res.status(500).json({ error: 'Impression du contrat de maintenance impossible.' });
  }
};

// Envoi du contrat de maintenance par la messagerie de l'utilisateur, et journal de ses envois
// (lot 6a-4d), sur le modèle du lot 6a-3 (cf. documents/envois.ts) : réservés à l'administration, en
// session, comme le PDF du contrat. Lecture : destinataire, objet et texte proposés, et envois déjà
// préparés, du plus récent au plus ancien, dans une même photo de la base. Un contrat annulé garde son
// journal et sa proposition lisibles ; l'écran ne lui affiche pas de bouton « Envoyer ».
const lireEnvoisContrat: RequestHandler = async (req, res) => {
  try {
    const lu = await transactionVerifiee(async (tx) => {
      const contrat = await tx.contratMaintenance.findUnique({ where: { id: paramId(req) }, select: { id: true, titre: true, clientId: true } });
      if (!contrat) return null;
      const { objet, corps } = await texteEnvoiContrat(tx, contrat);
      return { proposition: { destinataire: await propositionDestinataire(tx, contrat.clientId), objet, corps }, envois: await lireEnvois(tx, { contratMaintenanceId: contrat.id }) };
    }, { isolationLevel: 'RepeatableRead' });
    if (!lu) return void res.status(404).json({ error: 'Contrat de maintenance introuvable.' });
    res.json(lu);
  } catch (error) {
    if (error instanceof IdentiteEmetteurIncompleteError) return void res.status(409).json({ error: error.message });
    console.error('Contrat de maintenance, lecture des envois :', error);
    res.status(500).json({ error: 'Lecture des envois du contrat de maintenance impossible.' });
  }
};

// Enregistrement de l'envoi préparé, sous un verrou partagé du contrat, pris par une requête directe :
// verrouillerContratMaintenance prend un verrou exclusif, dont un envoi n'a pas besoin. Une annulation
// en cours est attendue, puis refuse l'envoi (409, comme un devis annulé ; choix par défaut, à
// confirmer) ; son PDF reste disponible. Un contrat suspendu ou terminé s'envoie, avec le statut que
// son PDF imprime. Un envoi ne change aucun statut, et un refus n'écrit rien. L'écran télécharge le PDF
// avant cet appel.
const envoyerContrat: RequestHandler = async (req, res) => {
  try {
    const destinataire = validerDestinataire(req.body?.destinataire);
    const resultat = await transactionVerifiee(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "ContratMaintenance" WHERE "id" = ${paramId(req)} FOR SHARE`;
      const contrat = await tx.contratMaintenance.findUnique({ where: { id: paramId(req) }, select: { id: true, titre: true, statut: true } });
      if (!contrat) return { refus: { statut: 404, error: 'Contrat de maintenance introuvable.' } };
      if (contrat.statut === 'ANNULE') return { refus: { statut: 409, error: 'Un contrat annulé ne s’envoie pas.' } };
      const { objet, corps } = await texteEnvoiContrat(tx, contrat);
      const envoi = await enregistrerEnvoi(tx, { contratMaintenanceId: contrat.id }, { destinataire, objet }, (req as AuthRequest).user!);
      return { envoi: { envoi, objet, corps } };
    });
    if (resultat.refus) return void res.status(resultat.refus.statut).json({ error: resultat.refus.error });
    res.status(201).json(resultat.envoi);
  } catch (error) {
    if (error instanceof DestinataireInvalideError) return void res.status(400).json({ error: error.message });
    if (error instanceof IdentiteEmetteurIncompleteError) return void res.status(409).json({ error: error.message });
    console.error('Contrat de maintenance, envoi :', error);
    res.status(500).json({ error: 'Enregistrement de l’envoi du contrat de maintenance impossible.' });
  }
};

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

  // Génération automatique des visites (lot pilote 5) : état du dernier passage, alerte éventuelle,
  // et passage lancé à la main (même traitement, au nom de l'administrateur), réservés à
  // l'administration comme les contrats.
  app.get('/api/contrats-maintenance/generation-visites', requireAuth, requireAdmin, async (_req, res) => {
    try {
      res.json(await etatGenerationVisites());
    } catch (error) {
      res.status(500).json({ error: 'Lecture de l’état de la génération des visites impossible.' });
    }
  });

  app.post('/api/contrats-maintenance/generation-visites', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const execution = await executerGenerationVisites({ type: 'MANUEL', req });
      res.status(201).json({ execution, etat: await etatGenerationVisites() });
    } catch (error) {
      if (error instanceof GenerationVisitesDesactivee) return res.status(409).json({ error: error.message });
      console.error('[GÉNÉRATION DES VISITES] Passage manuel impossible :', error);
      res.status(500).json({ error: 'Génération des visites impossible.' });
    }
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

  // En session seulement, sans route /api/v1, comme toutes les routes des contrats.
  app.get('/api/contrats-maintenance/:id/document.pdf', requireAuth, requireAdmin, imprimerContrat);
  // Envoi par la messagerie et journal des envois (lot 6a-4d) : en session seulement, comme le PDF.
  app.get('/api/contrats-maintenance/:id/envois', requireAuth, requireAdmin, lireEnvoisContrat);
  app.post('/api/contrats-maintenance/:id/envois', requireAuth, requireAdmin, envoyerContrat);

  app.post('/api/contrats-maintenance', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const saisie = lireSaisieContrat(req.body || {});
      // Même règle que la création directe d’intervention : un client désactivé n'ouvre plus
      // de dossier par le contrat, qui ne doit jamais devenir une porte de contournement.
      const client = await prisma.client.findFirst({ where: { id: String(req.body?.clientId || ''), actif: true }, select: { id: true } });
      if (!client) return res.status(404).json({ error: 'Client introuvable.' });
      const siteId = typeof req.body?.siteId === 'string' && req.body.siteId ? req.body.siteId : null;
      if (siteId) {
        const site = await prisma.clientSite.findFirst({ where: { id: siteId, clientId: client.id }, select: { id: true } });
        if (!site) return res.status(404).json({ error: 'Site introuvable.' });
      }
      const contrat = await transactionVerifiee((tx) => creerContratMaintenance(tx, req, { clientId: client.id, siteId, ...saisie }));
      res.status(201).json(decimalToNumber(contrat));
    } catch (error) {
      if (error instanceof SaisieContratInvalide) return res.status(400).json({ error: error.message });
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
        if (contrat.statut === 'ANNULE') return { erreur: 'ANNULE' as const };
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
        if (resultat.erreur === 'ANNULE') return res.status(409).json({ error: REFUS_CONTRAT_ANNULE });
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
        if (contrat.statut === 'ANNULE') return { erreur: 'ANNULE' as const };
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
        if (resultat.erreur === 'ANNULE') return res.status(409).json({ error: REFUS_CONTRAT_ANNULE });
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
        const intervention = await visiteDeLEcheance(tx, contrat);
        if (!intervention || intervention.statut !== 'TERMINEE') return { erreur: 'NOT_READY' as const };
        return { contrat: await avancerEcheanceContrat(tx, contrat, intervention, req) };
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
        const contrat = await tx.contratMaintenance.findFirst({ where: { id: paramId(req), statut: 'ACTIF' } });
        if (!contrat) return null;
        const existante = await visiteDeLEcheance(tx, contrat);
        if (existante) return { intervention: existante, creee: false };
        return { intervention: await creerVisiteContrat(tx, contrat, req), creee: true };
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
          include: VISITE_INCLUDE,
        });
        if (existante) return res.status(200).json(decimalToNumber(exposerIntervention(existante)));
      }
      res.status(500).json({ error: 'Génération de l’intervention prévisionnelle impossible.' });
    }
  });
}
