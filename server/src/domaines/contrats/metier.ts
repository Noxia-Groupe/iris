import { Prisma } from '@prisma/client';
import type { AuthRequest } from '../../http/auth';
import { valeurJournal } from '../../commun/journal-administration';

export async function journaliserContrat(tx: Prisma.TransactionClient, req: AuthRequest, action: 'CREATION' | 'SUSPENSION' | 'REACTIVATION' | 'CLOTURE' | 'MODIFICATION_COUVERTURE' | 'AVANCEMENT_ECHEANCE', contrat: unknown, avant: unknown, motif?: string) {
  const user = req.user!;
  const cibleId = String((contrat as { id: string }).id);
  await tx.journalSaisieChantier.create({ data: {
    chantierId: null, interventionId: null, contratMaintenanceId: cibleId, cible: 'CONTRAT', cibleId, action,
    auteurId: user.id, auteurNom: user.name,
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
