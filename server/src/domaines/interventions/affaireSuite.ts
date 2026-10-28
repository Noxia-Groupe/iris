import { Prisma } from '@prisma/client';
import { isAdminRole } from '../../droits/roles';

// --- Coûts d'une suite rattachée à une affaire close ou annulée ---
// Les coûts d'une suite rattachée à une affaire entrent dans la marge de son chantier (#339). Décision de
// Nelson du 27-10-2026 à 15:50 UTC, en réponse à la question des coûts saisis sur un chantier clos : « oui,
// il faut egalement refusé aussi ces saisies ». Lecture retenue, à confirmer (docs/ROADMAP-PASSATION.md,
// section 3) : la même règle que les saisies du chantier (assertChantierWritable) ; une affaire annulée
// n'accepte plus rien de personne, une affaire clôturée plus rien hors administration. Elle vaut pour la
// création, la correction, l'archivage et la restauration des heures et du matériel de la suite.
// L'intervention initiale et les autres interventions de l'affaire, dont les coûts restent hors de la
// marge du chantier, ne sont pas concernées.
//
// Verrou : l'affaire en partage. À la création et à la correction, après l'intervention et son contrat
// (verrouillerContexteCout), comme à la création d'une suite ou d'une intervention rattachée à un chantier ;
// à l'archivage et à la restauration, qui ne verrouillent pas l'intervention, seule, avant la ligne du coût.
// Sa clôture, sa réouverture et l'annulation de son devis l'écrivent sous un verrou exclusif, et la saisie
// concurrente les attend ou les fait attendre. L'annulation d'un devis ne verrouille jamais une intervention
// rattachée à une affaire : pas d'interblocage.
export class RefusAffaireSuite extends Error {
  constructor(readonly status: 403 | 409, message: string) { super(message); }
}

type SuiteAffaire = { chantierId: string | null; interventionInitialeId: string | null };
type LecteurSql = { $queryRaw: Prisma.TransactionClient['$queryRaw'] };

export async function verifierAffaireDeLaSuite(client: LecteurSql, intervention: SuiteAffaire, role: string | undefined, verrouiller: boolean): Promise<void> {
  if (!intervention.chantierId || !intervention.interventionInitialeId) return;
  const lignes = await client.$queryRaw<Array<{ statut: string }>>(Prisma.sql`SELECT "statut" FROM "Chantier" WHERE "id" = ${intervention.chantierId} ${Prisma.raw(verrouiller ? 'FOR SHARE' : '')}`);
  const statut = lignes[0]?.statut;
  if (statut === 'ANNULE') throw new RefusAffaireSuite(409, 'L’affaire de cette suite est annulée : plus aucun coût ne peut y être saisi.');
  if (statut !== 'EN_COURS' && !isAdminRole(role)) throw new RefusAffaireSuite(403, 'Le chantier de cette suite est clôturé : ses coûts ne peuvent plus être saisis ni modifiés.');
}
