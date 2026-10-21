import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { ROLE_RESPONSABLE, isAdminRole } from '../../droits/roles';
import type { AuthRequest } from '../../http/auth';
import { paramId } from '../../http/requete';
import { aujourdHuiEntreprise, dateIsoStricte, dateSeuleEnJourCivil } from '../../commun/dates';
import { valeurJournal } from '../../commun/journal-administration';

// Même principe pour l'affaire rattachée à une intervention SAV, que voient le technicien
// affecté et toute la chaîne de son responsable : de quoi la nommer, jamais son montant vendu.
export const CHANTIER_INTERVENTION_SELECT = { select: { id: true, nom: true, numeroDevis: true, client: true, statut: true, adresse: true } } as const;
// Les instantanés plus anciens du journal SAV portent l'affaire complète, montant vendu
// compris : à la lecture, elle est ramenée aux mêmes champs, sans réécrire le journal.
export function chantierDuJournalReduit(instantane: Prisma.JsonValue | null): Prisma.JsonValue | null {
  if (!instantane || typeof instantane !== 'object' || Array.isArray(instantane)) return instantane;
  const chantier = (instantane as Prisma.JsonObject).chantier;
  if (!chantier || typeof chantier !== 'object' || Array.isArray(chantier)) return instantane;
  const reduit = Object.fromEntries(Object.keys(CHANTIER_INTERVENTION_SELECT.select).filter((cle) => cle in chantier).map((cle) => [cle, (chantier as Prisma.JsonObject)[cle]]));
  return { ...(instantane as Prisma.JsonObject), chantier: reduit };
}

// --- Interventions SAV natives ---
export async function journaliserIntervention(tx: Prisma.TransactionClient, req: AuthRequest, action: string, intervention: unknown, avant?: unknown, motif?: string) {
  const user = req.user!;
  const cibleId = String((intervention as { id: string }).id);
  await tx.journalSaisieChantier.create({ data: {
    chantierId: null, interventionId: cibleId, cible: 'INTERVENTION', cibleId, action,
    auteurId: user.id, auteurNom: user.name,
    avant: avant ? valeurJournal(avant) as Prisma.InputJsonValue : undefined,
    apres: valeurJournal(intervention) as Prisma.InputJsonValue, motif: motif || null,
  } });
}

export function exposerIntervention(intervention: any) {
  if (intervention?.couvertureContrat === null) {
    const { couvertureContrat: _couvertureContrat, ...sansCouverture } = intervention;
    return sansCouverture;
  }
  return intervention;
}

const STATUTS_COUT_INTERVENTION = ['A_PLANIFIER', 'PLANIFIEE', 'EN_COURS', 'TERMINEE'];
export const estEncadrementCoutIntervention = (role: string | undefined) => isAdminRole(role) || role === 'CONDUCTEUR_TRAVAUX';

export async function chargerInterventionCout(req: AuthRequest) {
  return prisma.intervention.findFirst({
    where: { id: paramId(req), ...getInterventionFilterForUser(req.user!) },
    include: { contratMaintenance: { select: { statut: true } } },
  });
}
type InterventionCout = { statut: string; contratMaintenanceId: string | null; contratMaintenance: { statut: string } | null };
// Matériel : réservé aux interventions d'un contrat actif.
export function interventionCoutEligible(intervention: InterventionCout) {
  return !!intervention.contratMaintenanceId && intervention.contratMaintenance?.statut === 'ACTIF' && STATUTS_COUT_INTERVENTION.includes(intervention.statut);
}
// Heures du technicien : sur une intervention d'un contrat actif, et aussi hors contrat (décision de
// Nelson du 17-10-2026, lot pilote 3b). Une intervention d'un contrat suspendu ou terminé reste fermée.
export function interventionHeuresEligible(intervention: InterventionCout) {
  if (!STATUTS_COUT_INTERVENTION.includes(intervention.statut)) return false;
  return !intervention.contratMaintenanceId || intervention.contratMaintenance?.statut === 'ACTIF';
}
// Des heures se déclarent une fois faites : une date postérieure au jour de la société est refusée
// (choix par défaut, à confirmer, #253 ; il vaut aussi pour les interventions de contrat).
export function dateHeuresIntervention(value: unknown, fuseauHoraire: string, instant = new Date()): string | null {
  const date = dateIsoStricte(value);
  return date && dateSeuleEnJourCivil(date) <= aujourdHuiEntreprise(fuseauHoraire, instant) ? date : null;
}
export function estConflitTransactionCout(error: unknown) {
  const erreur = error as { code?: string; meta?: { code?: string } } | null;
  // Un refus de sérialisation ou un interblocage remonte en P2034, sauf sur une requête brute (les
  // verrous FOR UPDATE de verrouillerContexteCout), que Prisma rapporte en P2010 avec le code SQL.
  if (erreur?.code === 'P2010') return ['40001', '40P01'].includes(erreur.meta?.code || '');
  return ['P2034', 'P2003'].includes(erreur?.code || '');
}
// Toutes les mutations de coût prennent ces verrous dans cet ordre afin que la relecture
// d'éligibilité soit atomique avec les changements de contrat, statut et affectation. Hors contrat,
// le verrou du contrat est sans objet ; l'ordre des autres est inchangé.
export async function verrouillerContexteCout(tx: Prisma.TransactionClient, interventionId: string, intervenantId?: string, userId?: string) {
  const interventions = await tx.$queryRaw<Array<{ id: string; contratMaintenanceId: string | null }>>(Prisma.sql`SELECT "id", "contratMaintenanceId" FROM "Intervention" WHERE "id" = ${interventionId} FOR UPDATE`);
  const intervention = interventions[0];
  if (!intervention) return null;
  if (intervention.contratMaintenanceId) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ContratMaintenance" WHERE "id" = ${intervention.contratMaintenanceId} FOR UPDATE`);
  if (intervenantId && userId) {
    await tx.$queryRaw(Prisma.sql`SELECT "interventionId", "intervenantId" FROM "InterventionAffectation" WHERE "interventionId" = ${interventionId} AND "intervenantId" = ${intervenantId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Intervenant" WHERE "id" = ${intervenantId} AND "userId" = ${userId} FOR UPDATE`);
  }
  return tx.intervention.findUnique({ where: { id: interventionId }, include: { contratMaintenance: { select: { statut: true } } } });
}
export function heureOperationnelleTechnicien(heure: { id: string; date: Date; nbrHeures: Prisma.Decimal; commentaire: string | null; createdAt: Date }) {
  return { id: heure.id, date: heure.date, nbrHeures: heure.nbrHeures, commentaire: heure.commentaire, createdAt: heure.createdAt };
}
export async function journaliserCoutIntervention(tx: Prisma.TransactionClient, req: AuthRequest, cible: 'COUT_INTERVENTION_HEURE' | 'COUT_INTERVENTION_ACHAT', action: 'CREATION' | 'CORRECTION' | 'ARCHIVAGE' | 'RESTAURATION', cibleId: string, interventionId: string, avant: unknown, apres: unknown, motif?: string) {
  await tx.journalSaisieChantier.create({ data: {
    interventionId, cible, cibleId, action, auteurId: req.user!.id, auteurNom: req.user!.name,
    avant: avant ? valeurJournal(avant) as Prisma.InputJsonValue : undefined, apres: apres ? valeurJournal(apres) as Prisma.InputJsonValue : undefined, motif: motif || null,
  } });
}

export function totalHeuresInterventionAuCentime(heures: Array<{ nbrHeures: Prisma.Decimal; tauxHoraireApplique: Prisma.Decimal }>): Prisma.Decimal {
  // Les coûts de main-d’œuvre se calculent et s'arrondissent ligne par ligne : aucune
  // conversion Number ne doit intervenir avant l'agrégation, sinon le binaire dérive.
  return heures.reduce(
    (total, heure) => total.plus(new Prisma.Decimal(heure.nbrHeures).mul(heure.tauxHoraireApplique).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)),
    new Prisma.Decimal(0),
  ).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

// Hors administration, l'accès SAV reste ancré dans une relation persistante : affectation
// explicite pour le technicien, responsable d'affaire pour le conducteur et équipe déclarée
// pour le responsable. Un rôle seul ne donne jamais accès à un dossier sans rattachement.
export function getInterventionFilterForUser(authUser: { id: string; role: string; equipeIds?: string[] }) {
  if (authUser.role === 'SUPERADMIN' || authUser.role === 'ADMIN') return {};
  const parAffectation = { affectations: { some: { intervenant: { userId: authUser.id } } } };
  if (authUser.role === 'CONDUCTEUR_TRAVAUX') {
    // Le créateur encadrant reste explicitement rattaché aux demandes SAV sans chantier :
    // il peut donc organiser et suivre le dossier qu'il vient d'ouvrir, sans accès global.
    return { OR: [parAffectation, { createdById: authUser.id }, { chantier: { responsableId: authUser.id, annuleLe: null } }] };
  }
  if (authUser.role === ROLE_RESPONSABLE) {
    return { OR: [
      parAffectation,
      { chantier: { responsableId: { in: [authUser.id, ...(authUser.equipeIds || [])] }, annuleLe: null } },
    ] };
  }
  return parAffectation;
}

// Une affectation SAV gouverne la visibilité du dossier. Elle doit donc toujours évoluer
// atomiquement avec les intervenants de sa projection planning.
export async function synchroniserAffectationsIntervention(tx: Prisma.TransactionClient, interventionId: string, intervenantIds: string[]) {
  await tx.interventionAffectation.deleteMany({ where: { interventionId } });
  if (intervenantIds.length) {
    await tx.interventionAffectation.createMany({ data: intervenantIds.map((intervenantId) => ({ interventionId, intervenantId })) });
  }
}

export function dateDemandeCurative(value: unknown, fuseauHoraire: string, instant = new Date()): string | null {
  if (value === undefined) return `${aujourdHuiEntreprise(fuseauHoraire, instant)}T00:00:00.000Z`;
  if (typeof value !== 'string' || !/^\d{2}-\d{2}-\d{4}$/.test(value)) return null;
  const date = dateIsoStricte(value);
  return date && dateSeuleEnJourCivil(date) <= aujourdHuiEntreprise(fuseauHoraire, instant) ? date : null;
}

// Champs facultatifs d'une intervention SAV, lus de la même façon à sa création directe et à la
// conversion d'un devis (lot pilote 4) : description, priorité, site et contact du client, dates.
// Un refus porte son code HTTP (400 pour une saisie invalide, 404 pour un site ou un contact
// étranger au client).
export class SaisieInterventionInvalide extends Error {
  constructor(readonly status: 400 | 404, message: string) { super(message); }
}
export const PRIORITES_INTERVENTION = ['BASSE', 'NORMALE', 'HAUTE', 'URGENTE'];
export async function lireDetailsIntervention(db: Prisma.TransactionClient, body: Record<string, unknown>, clientId: string, fuseauHoraire: string) {
  const description = body.description == null ? null : String(body.description).trim() || null;
  const priorite = String(body.priorite || 'NORMALE');
  if (!PRIORITES_INTERVENTION.includes(priorite)) throw new SaisieInterventionInvalide(400, 'Priorité d’intervention invalide.');
  const siteId = body.siteId ? String(body.siteId) : null;
  const contactId = body.contactId ? String(body.contactId) : null;
  if (siteId && !await db.clientSite.findFirst({ where: { id: siteId, clientId }, select: { id: true } })) {
    throw new SaisieInterventionInvalide(404, 'Site introuvable pour ce client.');
  }
  if (contactId && !await db.clientContact.findFirst({ where: { id: contactId, clientId }, select: { id: true } })) {
    throw new SaisieInterventionInvalide(404, 'Contact introuvable pour ce client.');
  }
  const dateSouhaitee = body.dateSouhaitee ? dateIsoStricte(body.dateSouhaitee) : null;
  if (body.dateSouhaitee && !dateSouhaitee) throw new SaisieInterventionInvalide(400, 'La date souhaitée doit être valide au format JJ-MM-AAAA.');
  const dateDemande = dateDemandeCurative(body.dateDemande, fuseauHoraire);
  if (!dateDemande) throw new SaisieInterventionInvalide(400, 'La date de demande doit être valide au format JJ-MM-AAAA et ne peut pas être future.');
  if (dateSouhaitee && dateSouhaitee < dateDemande) throw new SaisieInterventionInvalide(400, 'La date souhaitée ne peut pas précéder la date de demande.');
  return { description, priorite, siteId, contactId, dateSouhaitee, dateDemande };
}

// Numérote et crée l'intervention, puis l'écrit au journal SAV, dans la transaction de l'appelant.
// La référence suit la séquence de l'année civile de la société (I26-0001).
export async function creerInterventionNumerotee(
  tx: Prisma.TransactionClient, req: AuthRequest, annee: number,
  donnees: { clientId: string; titre: string; chantierId: string | null } & Awaited<ReturnType<typeof lireDetailsIntervention>>,
  motif?: string,
) {
  const sequence = await tx.sequenceIntervention.upsert({
    where: { annee }, create: { annee, dernierNumero: 1 }, update: { dernierNumero: { increment: 1 } },
  });
  const reference = `I${String(annee).slice(-2)}-${String(sequence.dernierNumero).padStart(4, '0')}`;
  const cree = await tx.intervention.create({
    data: { reference, ...donnees, createdById: req.user!.id },
    include: { client: { select: { id: true, raisonSociale: true } }, site: true, contact: true, chantier: CHANTIER_INTERVENTION_SELECT },
  });
  await journaliserIntervention(tx, req, 'CREATION', cree, undefined, motif);
  return cree;
}
