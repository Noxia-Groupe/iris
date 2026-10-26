import type { Express } from 'express';
import { Prisma } from '@prisma/client';
import { prisma, transactionVerifiee } from '../../db';
import { ROLE_RESPONSABLE, ROLE_TECHNICIEN, isAdminRole } from '../../droits/roles';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { blockCommercialEtAssimiles } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { FUSEAU_HORAIRE_PAR_DEFAUT, anneeEntreprise, dateFrancaise, dateSeuleEnJourCivil } from '../../commun/dates';
import { decimalToNumber } from '../../commun/montants';
import { getCompanySettings } from '../administration/metier';
import { verrouillerContratMaintenance } from '../contrats/metier';
import {
  SaisieInterventionInvalide, creerInterventionNumerotee, estConflitTransactionCout, exposerIntervention, getInterventionFilterForUser,
  journaliserIntervention, lireDetailsIntervention,
} from './metier';
import { interventionDansPerimetre, verrouillerIntervention } from './comptesRendus';

// --- Intervention de suivi liée, première PR : « À suivre » et la suite liée, sans montants ---
// Décisions de Nelson du 24-10-2026 (docs/HISTORIQUE-DECISIONS.md, « Décisions du 24-10-2026 sur la
// remise à planifier », points 10 à 12, 16, 19, 25, 28, 29, 31, 32 et 35) et du 26-10-2026 (« Décisions
// du 26-10-2026 sur l'intervention de suivi liée ») :
//  - le technicien qui termine coche « Terminé » ou « À suivre » (PATCH /api/interventions/:id/statut,
//    champ `aSuivre`) ; l'intervention passe « terminée » avec la marque, selon la règle de clôture
//    normale (point 31) ;
//  - l'encadrement pose ou retire la marque, le technicien retire la sienne, chaque changement étant
//    journalisé (point 32, lecture confirmée le 24-10-2026) : PUT /api/interventions/:id/a-suivre ;
//  - ceux qui s'occupent du planning créent la suite (points 12, 16 et 28) : une nouvelle intervention
//    liée, depuis toute intervention SAV ou de maintenance, quel que soit son statut sauf annulée
//    (points 19 et 25), y compris issue d'un devis ou rattachée à un chantier (« Intervention liée ») ;
//    elle reprend le client, le site, le contact, l'affaire et, pour une visite, son contrat (« Tout
//    repris ») ; une intervention peut avoir plusieurs suites, et une suite la sienne ; la marque
//    disparaît une fois la suite créée (point 29) : POST /api/interventions/:id/suites.
// La facturation et la marge de la suite viendront avec la seconde PR (« Deux PR »).
//
// Comptes (choix par défaut, à confirmer, docs/ROADMAP-PASSATION.md, section 4) : en attendant les lots
// de droits, l'encadrement du suivi est celui qui organise aujourd'hui le SAV et le planning :
// l'administration, le conducteur de travaux et le responsable (son équipe), chacun dans son périmètre
// SAV relu sous le verrou de l'intervention. Le directeur n'a aujourd'hui aucun accès au SAV : il créera
// la suite avec le lot « Directeur aligné sur l'administration », et l'assistante technique avec le sien.
// Les autres types de compte sont refusés (403), comme aucune clé d'intégration.
//
// Verrous : l'intervention initiale (FOR UPDATE), puis, pour une visite, son contrat (FOR UPDATE), puis
// l'affaire (FOR SHARE) : le même ordre que le placement au planning (intervention puis contrat) et que la
// création d'une intervention rattachée à un chantier (affaire en partage).

export const estEncadrementSuivi = (role: string | undefined) => isAdminRole(role) || role === 'CONDUCTEUR_TRAVAUX' || role === ROLE_RESPONSABLE;

class RefusSuivi extends Error {}
class InterventionHorsPerimetre extends Error {}

const LIBELLE_STATUT_CONTRAT: Record<string, string> = { BROUILLON: 'en brouillon', SUSPENDU: 'suspendu', TERMINE: 'clos', ANNULE: 'annulé' };
const INSTANTANE_MARQUE = { client: { select: { id: true, raisonSociale: true } } } as const;

// Titre proposé d'une suite : celui de l'intervention initiale, précédé de « Suite — », dans la limite de
// 200 caractères du formulaire de création.
export function titreSuite(titreInitial: string): string {
  return `Suite — ${titreInitial}`.slice(0, 200).trim();
}

// Liens d'une intervention de suivi, dans le périmètre du demandeur : son intervention initiale et ses
// suites. Une intervention liée hors de ce périmètre n'est pas citée, comme elle serait introuvable
// depuis sa fiche ; une intervention liée annulée est citée avec son statut.
const LIEN_SELECT = { id: true, reference: true, titre: true, statut: true } as const;
export type LienSuivi = { id: string; reference: string; titre: string; statut: string };
export async function liensSuivi<T extends { id: string; interventionInitialeId: string | null }>(
  items: T[], user: { id: string; role: string; equipeIds?: string[] },
): Promise<Array<T & { interventionInitiale: LienSuivi | null; suites: LienSuivi[] }>> {
  const ids = items.map((item) => item.id);
  const initialeIds = [...new Set(items.map((item) => item.interventionInitialeId).filter((id): id is string => id !== null))];
  if (!ids.length) return [];
  const filtre = getInterventionFilterForUser(user);
  const [initiales, suites] = await Promise.all([
    initialeIds.length ? prisma.intervention.findMany({ where: { AND: [{ id: { in: initialeIds } }, filtre] }, select: LIEN_SELECT }) : Promise.resolve([]),
    prisma.intervention.findMany({ where: { AND: [{ interventionInitialeId: { in: ids } }, filtre] }, select: { ...LIEN_SELECT, interventionInitialeId: true }, orderBy: { reference: 'asc' } }),
  ]);
  const initialeParId = new Map(initiales.map((initiale) => [initiale.id, initiale]));
  return items.map((item) => ({
    ...item,
    interventionInitiale: item.interventionInitialeId ? initialeParId.get(item.interventionInitialeId) ?? null : null,
    suites: suites.filter((suite) => suite.interventionInitialeId === item.id).map(({ interventionInitialeId: _lien, ...suite }) => suite),
  }));
}

export function enregistrerSuites(app: Express): void {
  // Marque « à suivre », posée ou retirée hors de la clôture. Corps : { aSuivre: true | false }.
  app.put('/api/interventions/:id/a-suivre', requireAuth, blockCommercialEtAssimiles, async (req: AuthRequest, res) => {
    try {
      const role = req.user!.role;
      if (typeof req.body?.aSuivre !== 'boolean') return res.status(400).json({ error: 'Indiquez si l’intervention est à suivre (oui ou non).' });
      const aSuivre: boolean = req.body.aSuivre;
      if (role === ROLE_TECHNICIEN && aSuivre) return res.status(403).json({ error: 'Le technicien marque son intervention « à suivre » en la terminant ; il peut seulement retirer la marque ensuite.' });
      if (role !== ROLE_TECHNICIEN && !estEncadrementSuivi(role)) return res.status(403).json({ error: 'Marque « à suivre » réservée à l’encadrement du SAV et au technicien affecté.' });
      const id = paramId(req);
      const visible = await prisma.intervention.findFirst({ where: { id, ...getInterventionFilterForUser(req.user!) }, select: { id: true } });
      if (!visible) return res.status(404).json({ error: 'Intervention introuvable.' });
      const resultat = await transactionVerifiee(async (tx) => {
        const statut = await verrouillerIntervention(tx, id, 'FOR UPDATE');
        if (!statut || !await interventionDansPerimetre(tx, id, req.user!)) throw new InterventionHorsPerimetre();
        const avant = await tx.intervention.findUniqueOrThrow({ where: { id }, include: INSTANTANE_MARQUE });
        if (avant.statut !== 'TERMINEE') throw new RefusSuivi('Seule une intervention terminée porte la marque « à suivre ».');
        // Un enregistrement à l'identique ne change rien et n'écrit rien au journal.
        if (avant.aSuivre === aSuivre) return avant;
        const apres = await tx.intervention.update({ where: { id }, data: { aSuivre }, include: INSTANTANE_MARQUE });
        await journaliserIntervention(tx, req, 'MARQUE_A_SUIVRE', apres, avant, aSuivre ? 'Marquée « à suivre »' : 'Marque « à suivre » retirée');
        return apres;
      });
      res.json(decimalToNumber(exposerIntervention(resultat)));
    } catch (error) {
      if (error instanceof RefusSuivi) return res.status(409).json({ error: error.message });
      if (error instanceof InterventionHorsPerimetre) return res.status(404).json({ error: 'Intervention introuvable.' });
      if (estConflitTransactionCout(error)) return res.status(409).json({ error: 'Conflit concurrent : la marque « à suivre » n’a pas été enregistrée.' });
      console.error('Erreur marque « à suivre »', error);
      res.status(500).json({ error: 'Erreur lors de l’enregistrement de la marque « à suivre ».' });
    }
  });

  // Création d'une suite. Corps facultatif : titre (par défaut « Suite — » et le titre initial),
  // description, priorité (par défaut celle de l'intervention initiale), date souhaitée (JJ-MM-AAAA).
  // Le client, le site, le contact, l'affaire et le contrat sont repris de l'intervention initiale et
  // ne se choisissent pas.
  app.post('/api/interventions/:id/suites', requireAuth, blockCommercialEtAssimiles, async (req: AuthRequest, res) => {
    try {
      if (!estEncadrementSuivi(req.user!.role)) return res.status(403).json({ error: 'Création d’une suite réservée à l’encadrement du SAV.' });
      const id = paramId(req);
      const initiale = await prisma.intervention.findFirst({ where: { id, ...getInterventionFilterForUser(req.user!) } });
      if (!initiale) return res.status(404).json({ error: 'Intervention introuvable.' });
      const titre = req.body?.titre == null || String(req.body.titre).trim() === '' ? titreSuite(initiale.titre) : String(req.body.titre).trim();
      if (titre.length > 200) return res.status(400).json({ error: 'Le titre de la suite ne dépasse pas 200 caractères.' });
      const societe = await getCompanySettings();
      const fuseauHoraire = societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT;
      // Les champs saisis se lisent comme à la création d'une intervention (priorité, description, date
      // souhaitée) ; le site et le contact repris sont relus pour le client repris, et la date de demande
      // est le jour même, au fuseau de la société.
      const details = await lireDetailsIntervention(prisma, {
        description: req.body?.description, priorite: req.body?.priorite || initiale.priorite, dateSouhaitee: req.body?.dateSouhaitee,
        siteId: initiale.siteId, contactId: initiale.contactId,
      }, initiale.clientId, fuseauHoraire);
      const annee = anneeEntreprise(new Date(), fuseauHoraire);
      const suite = await transactionVerifiee(async (tx) => {
        const statut = await verrouillerIntervention(tx, id, 'FOR UPDATE');
        if (!statut || !await interventionDansPerimetre(tx, id, req.user!)) throw new InterventionHorsPerimetre();
        const actuelle = await tx.intervention.findUniqueOrThrow({ where: { id }, include: { client: { select: { id: true, raisonSociale: true, actif: true } } } });
        if (actuelle.statut === 'ANNULEE') throw new RefusSuivi('Une intervention annulée n’a pas de suite.');
        if (!actuelle.client.actif) throw new RefusSuivi('Le client de cette intervention est désactivé : réactivez-le avant de créer une suite.');
        // Suite d'une visite : couverte par le contrat, qui doit être actif, comme pour placer une visite.
        if (actuelle.contratMaintenanceId) {
          await verrouillerContratMaintenance(tx, actuelle.contratMaintenanceId);
          const contrat = await tx.contratMaintenance.findUniqueOrThrow({ where: { id: actuelle.contratMaintenanceId }, select: { statut: true, dateDebut: true } });
          if (contrat.statut !== 'ACTIF') throw new RefusSuivi(`Le contrat de cette visite est ${LIBELLE_STATUT_CONTRAT[contrat.statut] ?? contrat.statut} : une suite couverte par le contrat demande un contrat actif.`);
          // La date de demande d'une intervention d'un contrat ne précède pas son début (garde en base) : la
          // suite, demandée le jour même, attend le début d'un contrat qui n'a pas commencé (choix par
          // défaut, à confirmer).
          if (dateSeuleEnJourCivil(details.dateDemande) < dateSeuleEnJourCivil(contrat.dateDebut)) {
            throw new RefusSuivi(`Le contrat de cette visite commence le ${dateFrancaise(contrat.dateDebut)} : une suite couverte par le contrat se crée à partir de ce jour.`);
          }
        }
        // Affaire reprise, en partage comme à la création d'une intervention : une annulation en cours de
        // l'affaire est attendue, puis la suite est refusée.
        if (actuelle.chantierId && !(await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Chantier" WHERE "id" = ${actuelle.chantierId} AND "clientId" = ${actuelle.clientId} AND "annuleLe" IS NULL FOR SHARE`)).length) {
          throw new RefusSuivi('L’affaire de cette intervention est annulée ou n’est plus celle de son client : aucune suite ne lui est rattachée.');
        }
        const creee = await creerInterventionNumerotee(tx, req, annee, {
          clientId: actuelle.clientId, titre, chantierId: actuelle.chantierId, ...details,
          interventionInitialeId: actuelle.id, contratMaintenanceId: actuelle.contratMaintenanceId,
          couvertureContrat: actuelle.couvertureContrat === null ? undefined : actuelle.couvertureContrat as Prisma.InputJsonValue,
        }, `Suite de ${actuelle.reference}`);
        // La marque disparaît une fois la suite créée (point 29) ; la création s'écrit au journal de
        // l'intervention initiale, avec la référence de la suite.
        const avant = { ...actuelle, client: { id: actuelle.client.id, raisonSociale: actuelle.client.raisonSociale } };
        const apres = actuelle.aSuivre
          ? await tx.intervention.update({ where: { id }, data: { aSuivre: false }, include: INSTANTANE_MARQUE })
          : await tx.intervention.findUniqueOrThrow({ where: { id }, include: INSTANTANE_MARQUE });
        await journaliserIntervention(tx, req, 'SUITE_CREEE', apres, avant, `Suite créée : ${creee.reference}`);
        return creee;
      });
      res.status(201).json(decimalToNumber(exposerIntervention(suite)));
    } catch (error) {
      if (error instanceof RefusSuivi) return res.status(409).json({ error: error.message });
      if (error instanceof InterventionHorsPerimetre) return res.status(404).json({ error: 'Intervention introuvable.' });
      if (error instanceof SaisieInterventionInvalide) return res.status(error.status).json({ error: error.message });
      if (estConflitTransactionCout(error)) return res.status(409).json({ error: 'Conflit concurrent : la suite n’a pas été créée.' });
      console.error('Erreur création d’une suite d’intervention', error);
      res.status(500).json({ error: 'Erreur lors de la création de la suite.' });
    }
  });
}
