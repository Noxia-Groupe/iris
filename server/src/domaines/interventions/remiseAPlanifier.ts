import type { Express } from 'express';
import { prisma, transactionVerifiee } from '../../db';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { blockCommercialEtAssimiles, blockTechnicien } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { decimalToNumber } from '../../commun/montants';
import { requirePlanningActif } from '../planning/metier';
import { motifContratValide } from '../contrats/metier';
import { estConflitTransactionCout, exposerIntervention, getInterventionFilterForUser, journaliserIntervention, synchroniserAffectationsIntervention } from './metier';
import { contientCaractereInvalide, interventionDansPerimetre, verrouillerIntervention } from './comptesRendus';

// --- Remise « à planifier » d'une visite de contrat planifiée ---
// Décision de Nelson du 23-10-2026 (nuit), réponse 2, consignée dans docs/HISTORIQUE-DECISIONS.md
// (« Décisions du 23-10-2026 (nuit) sur le lot 4 », point 5) : une visite planifiée revient « à
// planifier », son créneau libéré. Ce que la décision ne dit pas est un choix par défaut, à confirmer
// (docs/ROADMAP-PASSATION.md, section 4) :
//  - seule une visite de contrat (intervention avec contratMaintenanceId) au statut PLANIFIEE est
//    remise ; une intervention curative, ou une visite dans un autre statut, est refusée (409) ;
//  - mêmes droits que le placement au planning, sous la garde des types sans planning (le placement
//    n'en a que celle du commercial et du directeur, cf. #179) ; périmètre SAV relu sous verrou ;
//    aucune clé d'intégration (route de session seulement) ;
//  - motif obligatoire, de 3 à 500 caractères, comme le statut d'un contrat ; écrit au journal SAV
//    avec le changement de statut. Le planning n'a pas de journal propre : la projection supprimée
//    figure dans l'instantané « avant » de cette écriture, avec ses intervenants ;
//  - les affectations SAV évoluent avec les intervenants de la projection
//    (synchroniserAffectationsIntervention) : sa suppression les retire. Une visite qui porte des
//    heures non archivées est donc refusée (409) : retirer l'affectation fermerait au technicien ses
//    propres saisies, que seule son affectation lui ouvre. Du matériel non archivé, saisi par
//    l'encadrement et que le technicien ne voit pas, la refuse aussi : option la plus restrictive ;
//  - aucun contrôle du statut du contrat : un créneau se libère aussi sur un contrat suspendu ou clos.
// Verrou : celui de l'intervention seul (FOR UPDATE), comme le changement de statut ; statut,
// périmètre, saisies et projection sont relus sous ce verrou. Le placement et les saisies de coûts SAV
// prennent l'intervention puis le contrat, l'annulation d'un devis les interventions puis le contrat,
// la génération des visites le contrat seul : aucun verrou n'est pris dans l'ordre inverse.
// L'archivage et la restauration d'un coût ne prennent aucun verrou (chemin préexistant).

class RefusRemise extends Error {}
class InterventionHorsPerimetre extends Error {}

const MOTIF_INVALIDE = 'Un motif de 3 à 500 caractères sans caractère de contrôle est obligatoire.';
const REFUS_CURATIVE = 'Seule une visite de contrat de maintenance se remet « à planifier » : déplacez le créneau de cette intervention au planning, ou annulez-la depuis sa fiche.';
const LIBELLE_STATUT: Record<string, string> = { A_PLANIFIER: 'déjà à planifier', EN_COURS: 'en cours', TERMINEE: 'terminée', ANNULEE: 'annulée' };

// Même règle que le motif du statut d'un contrat (motifContratValide), et ni caractère nul ni
// demi-paire de substitution, que PostgreSQL et l'UTF-8 refusent.
export function motifRemiseValide(valeur: unknown): string | null {
  const motif = motifContratValide(valeur);
  return motif && !contientCaractereInvalide(motif) ? motif : null;
}

// Instantané écrit au journal SAV : la projection et les affectations y figurent, avant (le créneau
// libéré) comme après (vides), pour que les deux aient la même forme.
const INSTANTANE_REMISE = {
  client: { select: { id: true, raisonSociale: true } },
  planningEvent: { select: {
    id: true, dateDebut: true, dateFin: true, creneau: true, heureDebut: true, heureFin: true,
    intervenants: { select: { id: true, nom: true }, orderBy: { nom: 'asc' } },
  } },
  affectations: { select: { intervenantId: true }, orderBy: { intervenantId: 'asc' } },
} as const;

export function enregistrerRemiseAPlanifier(app: Express): void {
  app.post('/api/interventions/:id/remise-a-planifier', requireAuth, blockCommercialEtAssimiles, blockTechnicien, requirePlanningActif, async (req: AuthRequest, res) => {
    try {
      const motif = motifRemiseValide(req.body?.motif);
      if (!motif) return res.status(400).json({ error: MOTIF_INVALIDE });
      const id = paramId(req);
      const visible = await prisma.intervention.findFirst({ where: { id, ...getInterventionFilterForUser(req.user!) }, select: { id: true } });
      if (!visible) return res.status(404).json({ error: 'Intervention introuvable.' });
      const intervention = await transactionVerifiee(async (tx) => {
        const statut = await verrouillerIntervention(tx, id, 'FOR UPDATE');
        if (!statut || !await interventionDansPerimetre(tx, id, req.user!)) throw new InterventionHorsPerimetre();
        const avant = await tx.intervention.findUniqueOrThrow({ where: { id }, include: INSTANTANE_REMISE });
        if (!avant.contratMaintenanceId) throw new RefusRemise(REFUS_CURATIVE);
        if (avant.statut !== 'PLANIFIEE') throw new RefusRemise(`Seule une visite planifiée se remet « à planifier » : celle-ci est ${LIBELLE_STATUT[avant.statut] ?? avant.statut}.`);
        const [heures, achats] = await Promise.all([
          tx.coutInterventionHeure.count({ where: { interventionId: id, archivedAt: null } }),
          tx.coutInterventionAchat.count({ where: { interventionId: id, archivedAt: null } }),
        ]);
        if (heures > 0 || achats > 0) {
          throw new RefusRemise(`Remise impossible : cette visite porte déjà ${heures} saisie(s) d’heures du technicien et ${achats} achat(s) de matériel non archivés. Déplacez plutôt son créneau au planning.`);
        }
        // Une visite planifiée sans créneau (passée « planifiée » depuis sa fiche) n'a rien à libérer.
        await tx.planningEvent.deleteMany({ where: { interventionId: id } });
        await synchroniserAffectationsIntervention(tx, id, []);
        const apres = await tx.intervention.update({ where: { id }, data: { statut: 'A_PLANIFIER' }, include: INSTANTANE_REMISE });
        await journaliserIntervention(tx, req, 'CHANGEMENT_STATUT', apres, avant, `Remise à planifier : ${motif}`);
        return apres;
      });
      res.json(decimalToNumber(exposerIntervention(intervention)));
    } catch (error) {
      if (error instanceof RefusRemise) return res.status(409).json({ error: error.message });
      if (error instanceof InterventionHorsPerimetre) return res.status(404).json({ error: 'Intervention introuvable.' });
      if (estConflitTransactionCout(error)) return res.status(409).json({ error: 'Conflit concurrent : la remise à planifier n’a pas été enregistrée.' });
      console.error('Erreur remise à planifier d’une visite', error);
      res.status(500).json({ error: 'Erreur lors de la remise à planifier de la visite.' });
    }
  });
}
