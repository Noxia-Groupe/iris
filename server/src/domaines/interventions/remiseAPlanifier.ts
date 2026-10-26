import type { Express } from 'express';
import { prisma, transactionVerifiee } from '../../db';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { blockCommercialEtAssimiles, blockTechnicien } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { decimalToNumber } from '../../commun/montants';
import { requirePlanningActif } from '../planning/metier';
import { INSTANTANE_CRENEAU, estConflitTransactionCout, exposerIntervention, getInterventionFilterForUser, journaliserIntervention, retirerCreneauIntervention } from './metier';
import { interventionDansPerimetre, motifInterventionValide, verrouillerIntervention } from './comptesRendus';

// --- Remise « à planifier » d'une intervention planifiée (visite de contrat ou curative) ---
// Décision de Nelson du 23-10-2026 (nuit), réponse 2 (docs/HISTORIQUE-DECISIONS.md, « Décisions du
// 23-10-2026 (nuit) sur le lot 4 », point 5) : une visite planifiée revient « à planifier », son
// créneau libéré. Décisions de Nelson du 24-10-2026 (« Décisions du 24-10-2026 sur la remise à
// planifier ») :
//  - point 1 : la remise vaut aussi pour une intervention curative (SAV hors contrat, sans
//    contratMaintenanceId), avec les mêmes règles ; seul le statut PLANIFIEE est remis, tout autre
//    statut est refusé (409) ;
//  - point 2, précisé par la réponse complémentaire : une intervention qui porte des heures ou du
//    matériel non archivés ne se remet pas à planifier (409) ; son créneau se déplace toujours au
//    planning (décision du même jour) ; si une suite est nécessaire, on la marque « à suivre » en la
//    terminant, puis on crée sa suite, une intervention liée (lot « intervention de suivi liée », suites.ts).
//    Des saisies archivées ne la retiennent pas (choix par défaut, à confirmer, docs/ROADMAP-PASSATION.md,
//    section 4) ;
//  - point 3 : aucun contrôle du statut du contrat (suspendu ou clos, le créneau se libère aussi) ;
//  - point 4 : motif obligatoire, de 3 à 500 caractères, comme le statut d'un contrat (« on doit garder
//    une tracabilité ») ; écrit au journal SAV avec le changement de statut. Le planning n'a pas de
//    journal propre : la projection supprimée figure dans l'instantané « avant », avec ses intervenants ;
//  - point 5 : les types sans planning (directeur commercial, assistante commerciale, comptable) sont
//    refusés (403), en plus du commercial, du directeur et du technicien ; sinon, mêmes droits que le
//    placement au planning ; périmètre SAV relu sous verrou ; aucune clé d'intégration ;
//  - point 6 : aucune de ces règles n'est un paramètre : elles restent dans le code, par décision de
//    Nelson (exception écrite à la règle permanente 1).
// Les affectations SAV évoluent avec les intervenants de la projection (retirerCreneauIntervention) :
// la remise les retire, si bien que l'intervention sort du périmètre du technicien.
// Verrou : celui de l'intervention seul (FOR UPDATE), comme le changement de statut ; statut,
// périmètre, saisies et projection sont relus sous ce verrou. Le placement et les saisies de coûts SAV
// prennent l'intervention puis le contrat, l'annulation d'un devis les interventions puis le contrat,
// la génération des visites le contrat seul : aucun verrou n'est pris dans l'ordre inverse.
// L'archivage et la restauration d'un coût ne prennent aucun verrou explicite (chemin préexistant) :
// leur transaction ne verrouille jamais l'intervention, mais la ligne du coût et, en partage, celle
// du compte qui agit (contrôle des clés étrangères : archivedById à l'archivage, auteur du journal).

class RefusRemise extends Error {}
class InterventionHorsPerimetre extends Error {}

const MOTIF_INVALIDE = 'Un motif de 3 à 500 caractères sans caractère de contrôle est obligatoire.';
const LIBELLE_STATUT: Record<string, string> = { A_PLANIFIER: 'déjà à planifier', EN_COURS: 'en cours', TERMINEE: 'terminée', ANNULEE: 'annulée' };

// Refus d'une intervention commencée (décision de Nelson du 24-10-2026, réponse complémentaire au
// point 2) : les deux compteurs disent ce qui la retient, puis ce qui reste possible aujourd'hui. Son
// créneau se déplace toujours au planning (même décision, réponse sur le déplacement) ; une suite passe
// par une nouvelle intervention liée à l'intervention initiale (lot « intervention de suivi liée »).
function refusRemiseSaisies(heures: number, achats: number): string {
  return `Remise impossible : cette intervention porte déjà ${heures} saisie(s) d’heures du technicien et ${achats} achat(s) de matériel non archivés. Une intervention commencée ne se remet pas à planifier : déplacez son créneau au planning, ou terminez-la et, si une suite est nécessaire, créez sa suite, une intervention liée.`;
}

export function enregistrerRemiseAPlanifier(app: Express): void {
  app.post('/api/interventions/:id/remise-a-planifier', requireAuth, blockCommercialEtAssimiles, blockTechnicien, requirePlanningActif, async (req: AuthRequest, res) => {
    try {
      const motif = motifInterventionValide(req.body?.motif);
      if (!motif) return res.status(400).json({ error: MOTIF_INVALIDE });
      const id = paramId(req);
      const visible = await prisma.intervention.findFirst({ where: { id, ...getInterventionFilterForUser(req.user!) }, select: { id: true } });
      if (!visible) return res.status(404).json({ error: 'Intervention introuvable.' });
      const intervention = await transactionVerifiee(async (tx) => {
        const statut = await verrouillerIntervention(tx, id, 'FOR UPDATE');
        if (!statut || !await interventionDansPerimetre(tx, id, req.user!)) throw new InterventionHorsPerimetre();
        const avant = await tx.intervention.findUniqueOrThrow({ where: { id }, include: INSTANTANE_CRENEAU });
        if (avant.statut !== 'PLANIFIEE') throw new RefusRemise(`Seule une intervention planifiée se remet « à planifier » : celle-ci est ${LIBELLE_STATUT[avant.statut] ?? avant.statut}.`);
        const [heures, achats] = await Promise.all([
          tx.coutInterventionHeure.count({ where: { interventionId: id, archivedAt: null } }),
          tx.coutInterventionAchat.count({ where: { interventionId: id, archivedAt: null } }),
        ]);
        if (heures > 0 || achats > 0) throw new RefusRemise(refusRemiseSaisies(heures, achats));
        // Une intervention planifiée sans créneau (passée « planifiée » depuis sa fiche) n'a rien à libérer.
        await retirerCreneauIntervention(tx, id);
        const apres = await tx.intervention.update({ where: { id }, data: { statut: 'A_PLANIFIER' }, include: INSTANTANE_CRENEAU });
        await journaliserIntervention(tx, req, 'CHANGEMENT_STATUT', apres, avant, `Remise à planifier : ${motif}`);
        return apres;
      });
      res.json(decimalToNumber(exposerIntervention(intervention)));
    } catch (error) {
      if (error instanceof RefusRemise) return res.status(409).json({ error: error.message });
      if (error instanceof InterventionHorsPerimetre) return res.status(404).json({ error: 'Intervention introuvable.' });
      if (estConflitTransactionCout(error)) return res.status(409).json({ error: 'Conflit concurrent : la remise à planifier n’a pas été enregistrée.' });
      console.error('Erreur remise à planifier d’une intervention', error);
      res.status(500).json({ error: 'Erreur lors de la remise à planifier de l’intervention.' });
    }
  });
}
