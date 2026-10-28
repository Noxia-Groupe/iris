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
// Même règle pour l'intervention issue du devis qui a aussi ouvert le chantier, rattachée à lui (décision
// de Nelson du 27-10-2026 à 21:41 UTC, devis/rattachement.ts) : ses coûts entrent dans sa marge (choix par
// défaut, à confirmer, appliqué comme pour une suite). Le rattachement est relu en base, avec le statut du
// chantier : une intervention ou une suite lue avant son rattachement n'échappe pas à la garde.
//
// Verrou : l'affaire en partage. À la création et à la correction, après l'intervention et son contrat
// (verrouillerContexteCout), comme à la création d'une suite ou d'une intervention rattachée à un chantier ;
// à l'archivage et à la restauration, qui ne verrouillent pas l'intervention, seule, avant la ligne du coût.
// Sa clôture, sa réouverture et l'annulation de son devis l'écrivent sous un verrou exclusif, et la saisie
// concurrente les attend ou les fait attendre. L'annulation d'un devis verrouille l'intervention du devis et
// ses suites avant le chantier, dans l'ordre de la saisie (devis/annulation.ts) : pas d'interblocage.
export class RefusAffaireSuite extends Error {
  constructor(readonly status: 403 | 409, message: string) { super(message); }
}

// L'intervention se relit en base par son identifiant : ses champs lus avant la transaction ne comptent pas.
type SuiteAffaire = { id: string };
type LecteurSql = { $queryRaw: Prisma.TransactionClient['$queryRaw'] };

export async function verifierAffaireDeLaSuite(client: LecteurSql, intervention: SuiteAffaire, role: string | undefined, verrouiller: boolean): Promise<void> {
  const lignes = await client.$queryRaw<Array<{ statut: string; suite: boolean }>>(Prisma.sql`
    SELECT c."statut", i."interventionInitialeId" IS NOT NULL AS "suite"
    FROM "Intervention" i JOIN "Chantier" c ON c."id" = i."chantierId"
    WHERE i."id" = ${intervention.id} AND (i."interventionInitialeId" IS NOT NULL OR EXISTS (
      SELECT 1 FROM "DevisConversion" di JOIN "DevisConversion" dc ON dc."devisId" = di."devisId"
      WHERE di."cibleType" = 'INTERVENTION' AND di."cibleId" = i."id" AND dc."cibleType" = 'CHANTIER' AND dc."cibleId" = c."id"))
    ${Prisma.raw(verrouiller ? 'FOR SHARE OF c' : '')}`);
  const ligne = lignes[0];
  if (!ligne) return;
  const objet = ligne.suite ? 'cette suite' : 'cette intervention';
  if (ligne.statut === 'ANNULE') throw new RefusAffaireSuite(409, `L’affaire de ${objet} est annulée : plus aucun coût ne peut y être saisi.`);
  if (ligne.statut !== 'EN_COURS' && !isAdminRole(role)) throw new RefusAffaireSuite(403, `Le chantier de ${objet} est clôturé : ses coûts ne peuvent plus être saisis ni modifiés.`);
}
