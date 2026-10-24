import { Prisma, type ContratMaintenance } from '@prisma/client';
import type { AuthRequest } from '../../http/auth';
import { valeurJournal } from '../../commun/journal-administration';
import { FUSEAU_HORAIRE_PAR_DEFAUT, anneeEntreprise, dateFrancaise, dateIsoStricte } from '../../commun/dates';
import { CHANTIER_INTERVENTION_SELECT, auteurJournalSav, journaliserIntervention, prochaineReferenceIntervention } from '../interventions/metier';

// `req` null : écriture de la génération automatique des visites (lot pilote 5). ANNULATION :
// annulation du contrat avec le devis dont il est issu (lot 4 suite, cf. devis/annulation.ts).
export async function journaliserContrat(tx: Prisma.TransactionClient, req: AuthRequest | null, action: 'CREATION' | 'SUSPENSION' | 'REACTIVATION' | 'CLOTURE' | 'MODIFICATION_COUVERTURE' | 'AVANCEMENT_ECHEANCE' | 'ANNULATION', contrat: unknown, avant: unknown, motif?: string) {
  const cibleId = String((contrat as { id: string }).id);
  await tx.journalSaisieChantier.create({ data: {
    chantierId: null, interventionId: null, contratMaintenanceId: cibleId, cible: 'CONTRAT', cibleId, action,
    ...auteurJournalSav(req),
    avant: avant === null ? Prisma.JsonNull : valeurJournal(avant) as Prisma.InputJsonValue,
    apres: valeurJournal(contrat) as Prisma.InputJsonValue,
    motif: motif || null,
  } });
}

const POLITIQUES_MAIN_OEUVRE = ['INCLUSE', 'HORS_FORFAIT'];
const POLITIQUES_MATERIEL = ['INCLUS', 'HORS_FORFAIT'];
export function motifContratValide(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const motif = value.trim();
  const longueur = [...motif].length;
  return longueur >= 3 && longueur <= 500 && !/[\p{Cc}\p{Cf}]/u.test(motif) ? motif : null;
}
export function lirePolitiqueCouverture(body: Record<string, unknown>, defaults?: { politiqueMainOeuvre: string; politiqueMateriel: string; noteCouverture: string | null }) {
  const politiqueMainOeuvre = body.politiqueMainOeuvre === undefined ? defaults?.politiqueMainOeuvre ?? 'HORS_FORFAIT' : String(body.politiqueMainOeuvre);
  const politiqueMateriel = body.politiqueMateriel === undefined ? defaults?.politiqueMateriel ?? 'HORS_FORFAIT' : String(body.politiqueMateriel);
  let noteCouverture: string | null;
  if (body.noteCouverture === undefined) noteCouverture = defaults?.noteCouverture ?? null;
  else if (body.noteCouverture === null) noteCouverture = null;
  else if (typeof body.noteCouverture === 'string') noteCouverture = body.noteCouverture.trim() || null;
  else return null;
  if (!POLITIQUES_MAIN_OEUVRE.includes(politiqueMainOeuvre) || !POLITIQUES_MATERIEL.includes(politiqueMateriel) || (noteCouverture !== null && noteCouverture.length > 1000)) return null;
  return { politiqueMainOeuvre, politiqueMateriel, noteCouverture };
}

// Saisie d'un contrat de maintenance, lue de la même façon à sa création directe et à la
// conversion d'un devis (lot pilote 4) : titre, périodicité, durée prévisionnelle, date de
// début et politique de couverture. Le premier champ invalide est refusé (400).
export class SaisieContratInvalide extends Error {}
export function lireSaisieContrat(body: Record<string, unknown>) {
  const titre = typeof body.titre === 'string' ? body.titre.trim() : '';
  const periodiciteMois = Number(body.periodiciteMois);
  const dureePrevisionnelleMinutes = Number(body.dureePrevisionnelleMinutes);
  const dateDebut = dateIsoStricte(body.dateDebut);
  const couverture = lirePolitiqueCouverture(body);
  if (titre.length < 3 || titre.length > 200) throw new SaisieContratInvalide('Le titre du contrat doit contenir entre 3 et 200 caractères.');
  if (!Number.isInteger(periodiciteMois) || periodiciteMois < 1 || periodiciteMois > 60) throw new SaisieContratInvalide('La périodicité doit être comprise entre 1 et 60 mois.');
  if (!Number.isInteger(dureePrevisionnelleMinutes) || dureePrevisionnelleMinutes < 15 || dureePrevisionnelleMinutes > 1440) throw new SaisieContratInvalide('La durée prévisionnelle doit être comprise entre 15 et 1 440 minutes.');
  if (!dateDebut) throw new SaisieContratInvalide('La date de début doit être valide au format JJ-MM-AAAA.');
  if (!couverture) throw new SaisieContratInvalide('La politique de couverture est invalide.');
  return { titre, periodiciteMois, dureePrevisionnelleMinutes, dateDebut, ...couverture };
}

// Crée le contrat, actif, première échéance à sa date de début, et l'écrit au journal, dans la
// transaction de l'appelant.
export async function creerContratMaintenance(
  tx: Prisma.TransactionClient, req: AuthRequest, donnees: { clientId: string; siteId: string | null } & ReturnType<typeof lireSaisieContrat>, motif?: string,
) {
  const cree = await tx.contratMaintenance.create({
    data: { ...donnees, prochaineEcheance: donnees.dateDebut, createdById: req.user!.id },
    include: { client: { select: { id: true, raisonSociale: true } }, site: { select: { id: true, nom: true, ville: true } } },
  });
  await journaliserContrat(tx, req, 'CREATION', cree, null, motif);
  return cree;
}

// Tous les parcours qui changent le cycle contractualisé prennent ce verrou avant de
// relire le statut : aucune création ou modification ne peut contourner une clôture.
export async function verrouillerContratMaintenance(tx: Prisma.TransactionClient, contratId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ContratMaintenance" WHERE "id" = ${contratId} FOR UPDATE`);
}

function ajouterMoisUTC(date: Date, nombreDeMois: number): Date {
  // On conserve le jour d'échéance autant que le mois cible le permet (31 janvier → 28 février).
  const jour = date.getUTCDate();
  const cible = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + nombreDeMois, 1));
  const dernierJour = new Date(Date.UTC(cible.getUTCFullYear(), cible.getUTCMonth() + 1, 0)).getUTCDate();
  cible.setUTCDate(Math.min(jour, dernierJour));
  return cible;
}

export function echeanceSuivante(dateDebut: Date, echeanceCourante: Date, periodiciteMois: number): Date {
  // Le jour de la visite est contractuel : repartir de l'origine restaure le 31 (ou le 29 février)
  // dès que le mois cible le permet, au lieu de le raboter définitivement après un mois court.
  const moisEcoules = (echeanceCourante.getUTCFullYear() - dateDebut.getUTCFullYear()) * 12
    + (echeanceCourante.getUTCMonth() - dateDebut.getUTCMonth());
  const periodesEcoulees = Math.max(0, Math.round(moisEcoules / periodiciteMois));
  return ajouterMoisUTC(dateDebut, (periodesEcoulees + 1) * periodiciteMois);
}

// --- Visites d'un contrat : création et avancement de l'échéance ---
// Partagés par les actions de l'écran (un administrateur) et la génération automatique
// (`req` null, lot pilote 5). L'appelant a pris le verrou du contrat et relu son statut.
export const VISITE_INCLUDE = { client: { select: { id: true, raisonSociale: true } }, site: true, contact: true, chantier: CHANTIER_INTERVENTION_SELECT } as const;

export function visiteDeLEcheance(tx: Prisma.TransactionClient, contrat: Pick<ContratMaintenance, 'id' | 'prochaineEcheance'>) {
  return tx.intervention.findFirst({
    where: { contratMaintenanceId: contrat.id, echeanceContrat: contrat.prochaineEcheance },
    include: VISITE_INCLUDE,
  });
}

// Crée l'intervention à planifier de l'échéance courante, numérotée dans l'année civile de la
// société, avec l'instantané de la couverture du contrat, et l'écrit au journal SAV.
export async function creerVisiteContrat(tx: Prisma.TransactionClient, contrat: ContratMaintenance, req: AuthRequest | null, motif?: string) {
  const societe = await tx.companySettings.findUnique({ where: { id: 'singleton' }, select: { fuseauHoraire: true } });
  const annee = anneeEntreprise(new Date(), societe?.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);
  const reference = await prochaineReferenceIntervention(tx, annee);
  const intervention = await tx.intervention.create({
    data: {
      reference, clientId: contrat.clientId, siteId: contrat.siteId, contratMaintenanceId: contrat.id,
      echeanceContrat: contrat.prochaineEcheance, titre: `Maintenance préventive — ${contrat.titre}`,
      description: `Intervention prévisionnelle issue du contrat. Durée prévue : ${contrat.dureePrevisionnelleMinutes} minutes.`,
      dateSouhaitee: contrat.prochaineEcheance, dateDemande: contrat.prochaineEcheance, createdById: auteurJournalSav(req).auteurId,
      couvertureContrat: {
        politiqueMainOeuvre: contrat.politiqueMainOeuvre,
        politiqueMateriel: contrat.politiqueMateriel,
        noteCouverture: contrat.noteCouverture,
      },
    },
    include: VISITE_INCLUDE,
  });
  await journaliserIntervention(tx, req, 'CREATION_CONTRAT', intervention, undefined, motif);
  return intervention;
}

// Passe à l'échéance suivante une fois la visite de l'échéance courante terminée (l'appelant
// l'a vérifié), et l'écrit au journal du contrat avec son motif.
export async function avancerEcheanceContrat(
  tx: Prisma.TransactionClient, contrat: ContratMaintenance, visite: { reference: string }, req: AuthRequest | null, prefixeMotif = '',
) {
  const prochaineEcheance = echeanceSuivante(contrat.dateDebut, contrat.prochaineEcheance, contrat.periodiciteMois);
  const maj = await tx.contratMaintenance.update({ where: { id: contrat.id }, data: { prochaineEcheance } });
  const motif = `${prefixeMotif}Intervention ${visite.reference} terminée : échéance du ${dateFrancaise(contrat.prochaineEcheance)} au ${dateFrancaise(prochaineEcheance)}.`;
  await journaliserContrat(tx, req, 'AVANCEMENT_ECHEANCE', maj, contrat, motif);
  return maj;
}
