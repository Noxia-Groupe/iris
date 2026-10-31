import type { Express } from 'express';
import { prisma } from '../../db';
import { ROLE_TECHNICIEN } from '../../droits/roles';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { blockCommercial } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { FUSEAU_HORAIRE_PAR_DEFAUT, aujourdHuiEntreprise, dateIsoStricte } from '../../commun/dates';
import { decimalToNumber } from '../../commun/montants';
import { getCompanySettings } from '../administration/metier';
import { CHANTIER_INTERVENTION_SELECT, exposerIntervention, getInterventionFilterForUser } from './metier';
import { RAPPORT_SELECT, SIGNATURE_SELECT } from './comptesRendus';
import { liensSuivi } from './suites';
import { produirePdf, repondrePdf } from '../documents/productionPdf';
import { lireCompteRenduPdf, rendreFichierCompteRenduPdf } from './productionPdf';

// --- Lectures des interventions SAV : liste, journée du technicien et fiche (lot pilote 3b-4), PDF du compte rendu (lot 6a-4a) ---

// Ce que portent la liste, la journée et la fiche : de quoi se rendre sur place (adresse du site ou
// de l'affaire, téléphone du contact) et le créneau planifié, jamais un montant. Les liens d'une
// intervention de suivi (intervention initiale et suites, dans le périmètre du demandeur) s'ajoutent à la
// liste et à la fiche (cf. liensSuivi).
const INTERVENTION_INCLUDE = {
  client: { select: { id: true, raisonSociale: true } }, site: true, contact: true, chantier: CHANTIER_INTERVENTION_SELECT,
  rapports: { select: { ...RAPPORT_SELECT, signature: { select: SIGNATURE_SELECT } }, orderBy: { createdAt: 'asc' } },
  affectations: { include: { intervenant: { select: { id: true, nom: true, userId: true } } } },
  planningEvent: { select: { dateDebut: true, dateFin: true, creneau: true, heureDebut: true, heureFin: true } },
} as const;

type Planification = { dateDebut: Date; dateFin: Date; creneau: string; heureDebut: string | null; heureFin: string | null } | null;

// Ordre des créneaux d'une journée, le même que celui du planning : matin, journée, heures (par heure
// de début), après-midi (choix par défaut, à confirmer).
const RANG_CRENEAU: Record<string, number> = { MATIN: 0, JOURNEE: 1, HEURES: 2, APRES_MIDI: 3 };
export function comparerCreneaux(a: { reference: string; planningEvent: Planification }, b: { reference: string; planningEvent: Planification }): number {
  const pa = a.planningEvent;
  const pb = b.planningEvent;
  return (RANG_CRENEAU[pa?.creneau ?? ''] ?? 9) - (RANG_CRENEAU[pb?.creneau ?? ''] ?? 9)
    || (pa?.heureDebut ?? '').localeCompare(pb?.heureDebut ?? '')
    || a.reference.localeCompare(b.reference);
}

export function enregistrerLecturesInterventions(app: Express): void {
  // Les annulations sont historiques : elles n'encombrent pas l'exploitation courante, mais
  // restent explicitement consultables avec ?inclureAnnulees=true (administration/contrôle).
  app.get('/api/interventions', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
    try {
      const inclureAnnulees = req.query.inclureAnnulees === 'true';
      const filtre = getInterventionFilterForUser(req.user!);
      const interventions = await prisma.intervention.findMany({
        where: {
          AND: [
            filtre,
            inclureAnnulees ? {} : { statut: { not: 'ANNULEE' } },
          ],
        },
        include: INTERVENTION_INCLUDE,
        orderBy: [{ dateSouhaitee: 'asc' }, { createdAt: 'desc' }],
      });
      res.json(decimalToNumber((await liensSuivi(interventions, req.user!)).map(exposerIntervention)));
    } catch (error) {
      console.error('Erreur liste interventions SAV', error);
      res.status(500).json({ error: 'Erreur lors de la lecture des interventions.' });
    }
  });

  // « Ma journée » : les interventions du périmètre dont la projection au planning couvre le jour, au
  // jour civil de la société calculé ici. Choix par défaut de #253, à confirmer : en cours et à faire
  // triées par créneau, terminées à part, annulées exclues ; pour aujourd'hui seulement, celles restées
  // ouvertes après leur dernier jour planifié. Une intervention sans projection n'y figure pas.
  app.get('/api/interventions/journee', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
    try {
      const fuseauHoraire = (await getCompanySettings()).fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT;
      const aujourdhui = aujourdHuiEntreprise(fuseauHoraire);
      let jour = aujourdhui;
      if (req.query.jour !== undefined) {
        const iso = typeof req.query.jour === 'string' ? dateIsoStricte(req.query.jour) : null;
        if (!iso) return res.status(400).json({ error: 'Le jour doit être une date valide au format JJ-MM-AAAA.' });
        jour = iso.slice(0, 10);
      }
      // Les jours du planning sont des dates-seules, stockées à minuit UTC.
      const minuit = new Date(`${jour}T00:00:00.000Z`);
      const filtre = getInterventionFilterForUser(req.user!);
      const [duJour, resteesOuvertes] = await Promise.all([
        prisma.intervention.findMany({
          where: { AND: [filtre, { statut: { not: 'ANNULEE' } }, { planningEvent: { is: { dateDebut: { lte: minuit }, dateFin: { gte: minuit } } } }] },
          include: INTERVENTION_INCLUDE,
        }),
        jour === aujourdhui ? prisma.intervention.findMany({
          where: { AND: [filtre, { statut: { in: ['A_PLANIFIER', 'PLANIFIEE', 'EN_COURS'] } }, { planningEvent: { is: { dateFin: { lt: minuit } } } }] },
          include: INTERVENTION_INCLUDE,
        }) : Promise.resolve([]),
      ]);
      duJour.sort(comparerCreneaux);
      resteesOuvertes.sort((a, b) => (a.planningEvent!.dateFin.getTime() - b.planningEvent!.dateFin.getTime()) || comparerCreneaux(a, b));
      const exposer = (liste: typeof duJour) => decimalToNumber(liste.map(exposerIntervention));
      res.json({
        jour, aujourdhui, fuseauHoraire,
        aFaire: exposer(duJour.filter((intervention) => intervention.statut !== 'TERMINEE')),
        resteesOuvertes: exposer(resteesOuvertes),
        terminees: exposer(duJour.filter((intervention) => intervention.statut === 'TERMINEE')),
      });
    } catch (error) {
      console.error('Erreur journée interventions SAV', error);
      res.status(500).json({ error: 'Erreur lors de la lecture de la journée.' });
    }
  });

  // Fiche d'une intervention, avec le même périmètre que la liste : hors périmètre ou annulée, elle est
  // introuvable (404), sans rien dire de plus.
  app.get('/api/interventions/:id', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
    try {
      const intervention = await prisma.intervention.findFirst({
        where: { AND: [{ id: paramId(req) }, getInterventionFilterForUser(req.user!), { statut: { not: 'ANNULEE' } }] },
        include: INTERVENTION_INCLUDE,
      });
      if (!intervention) return res.status(404).json({ error: 'Intervention introuvable.' });
      res.json(decimalToNumber(exposerIntervention((await liensSuivi([intervention], req.user!))[0])));
    } catch (error) {
      console.error('Erreur fiche intervention SAV', error);
      res.status(500).json({ error: 'Erreur lors de la lecture de l’intervention.' });
    }
  });

  // PDF du compte rendu d'intervention (lot 6a-4a), en session seulement, sans route /api/v1 : les
  // lecteurs de la fiche, sauf le technicien (403, avant tout périmètre ; choix par défaut, le plus
  // restrictif, à confirmer). Hors périmètre ou annulée, l'intervention est introuvable (404), comme sa
  // fiche ; sans compte rendu, il n'y a rien à imprimer (409) ; une intervention en cours qui en porte
  // s'imprime. L'identité imprimée est l'identité actuelle de la société, refusée si elle est incomplète
  // (409). Toutes les lectures se font dans un même instantané (REPEATABLE READ), comme le PDF du devis :
  // un compte rendu ou une signature enregistrés pendant l'impression n'y entrent pas à moitié, ni
  // l'identité avec un autre logo. Le PDF est lu puis rendu par interventions/productionPdf.ts (lot
  // 6b-1a), le rendu après la transaction : le refus du technicien, le périmètre de la fiche et
  // l'exclusion des annulées restent ici.
  app.get('/api/interventions/:id/document.pdf', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
    try {
      if (req.user!.role === ROLE_TECHNICIEN) return res.status(403).json({ error: 'Le PDF du compte rendu n’est pas ouvert au technicien.' });
      repondrePdf(res, await produirePdf((tx) => lireCompteRenduPdf(tx, {
        AND: [{ id: paramId(req) }, getInterventionFilterForUser(req.user!), { statut: { not: 'ANNULEE' } }],
      }), rendreFichierCompteRenduPdf, { isolationLevel: 'RepeatableRead' }));
    } catch (error) {
      console.error('Erreur PDF compte rendu intervention SAV', error);
      res.status(500).json({ error: 'Impression du compte rendu impossible.' });
    }
  });
}
