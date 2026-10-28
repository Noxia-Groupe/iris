import { Prisma } from '@prisma/client';
import type { AuthRequest } from '../../http/auth';
import { journaliserIntervention } from '../interventions/metier';
import { verrouillerIntervention } from '../interventions/comptesRendus';
import { lireSuites } from './annulation';
import { DevisConflitError, DevisDroitError } from './metier';

// --- Intervention d'un devis converti aussi en chantier ---
// Décision de Nelson du 27-10-2026 à 21:41 UTC, en réponse à la question du suivi de marge qui reçoit les
// coûts de l'intervention issue d'un devis converti aussi en chantier, et ceux de ses suites : « Elle vont
// au chantier auquel il est rattaché si c’est un chantier issue d’un devis, ce n’est pas une intervention
// sav de toute facon ». L'intervention issue du devis est rattachée au chantier ouvert par le même devis,
// avec ses suites, toutes générations, quel que soit l'ordre des deux conversions :
//  - intervention après le chantier : elle naît rattachée au chantier, qui doit être en cours, du client du
//    devis (chantierPourInterventionDuDevis) ; ses suites le reprennent à leur création ;
//  - chantier après l'intervention : elle et ses suites lui sont rattachées à sa création, quels que soient
//    leurs statuts, chaque rattachement écrit à leur journal (rattacherInterventionDuDevis) ; comme aucune
//    clé d'intégration ne crée l'intervention, aucune n'ouvre ce chantier, qui la modifie (403 ; choix par
//    défaut, à confirmer, le plus restrictif : le journal SAV exige un compte auteur).
// Ses coûts et ceux de ses suites entrent alors dans la marge du chantier (avecCoutsSuites). Aucune reprise
// des conversions faites avant ce lot (règle 4 : aucune donnée réelle).
type DevisConverti = { numero: string; version: number; clientId: string; conversions: Array<{ cibleType: string; cibleId: string }> };

// Chantier auquel naît rattachée l'intervention d'un devis qui a déjà ouvert le sien, ou null. Verrou du
// chantier en partage, après celui du devis, comme à la création d'une intervention rattachée : une
// clôture, une réouverture ou un changement de client en cours est attendu. Refus, choix par défaut, à
// confirmer, comme pour la création d'une suite (suites.ts) : une intervention ne naît pas rattachée à un
// chantier clôturé, dont ses coûts ne pourraient plus se saisir (affaireSuite.ts).
export async function chantierPourInterventionDuDevis(tx: Prisma.TransactionClient, devis: DevisConverti): Promise<string | null> {
  const chantierId = devis.conversions.find(c => c.cibleType === 'CHANTIER')?.cibleId;
  if (!chantierId) return null;
  const [chantier] = await tx.$queryRaw<Array<{ statut: string; clientId: string | null }>>(Prisma.sql`SELECT "statut", "clientId" FROM "Chantier" WHERE "id" = ${chantierId} FOR SHARE`);
  if (!chantier || chantier.statut === 'ANNULE') throw new DevisConflitError('Le chantier ouvert par ce devis est annulé : l’intervention, qui lui serait rattachée, ne peut pas être créée.');
  if (chantier.clientId !== devis.clientId) throw new DevisConflitError('Le chantier ouvert par ce devis n’est plus celui de son client : l’intervention, qui lui serait rattachée, ne peut pas être créée.');
  if (chantier.statut !== 'EN_COURS') throw new DevisConflitError('Le chantier ouvert par ce devis est clôturé : l’intervention, qui lui serait rattachée, ne peut pas être créée tant qu’il n’est pas rouvert.');
  return chantierId;
}

// Rattache au chantier qui vient d'être ouvert l'intervention déjà issue du même devis, et ses suites.
// Verrous : le devis (déjà pris), puis l'intervention et ses suites par identifiant croissant, comme
// l'annulation du devis ; le chantier, créé dans cette transaction, n'est encore visible de personne. Une
// suite créée entre la lecture des suites et leurs verrous (la création verrouille l'intervention
// initiale) refuse la conversion, à relancer.
export async function rattacherInterventionDuDevis(tx: Prisma.TransactionClient, req: AuthRequest, devis: DevisConverti, chantierId: string): Promise<void> {
  const interventionId = devis.conversions.find(c => c.cibleType === 'INTERVENTION')?.cibleId;
  if (!interventionId) return;
  if (!req.user) throw new DevisDroitError('Ce devis a déjà créé son intervention : le chantier, qui la reçoit avec ses suites, ne s’ouvre que dans une session de l’application.');
  const arbre = async () => [interventionId, ...(await lireSuites(tx, interventionId)).map(s => s.id)].sort();
  const lues = await arbre();
  for (const id of lues) await verrouillerIntervention(tx, id, 'FOR UPDATE');
  if ((await arbre()).some(id => !lues.includes(id))) throw new DevisConflitError('Une suite vient d’être créée pour l’intervention de ce devis : relancez la conversion.');
  const interventions = await tx.intervention.findMany({ where: { id: { in: lues } }, orderBy: { id: 'asc' } });
  // Défense en profondeur : le client d'un devis signé est figé, et une suite reprend celui de son
  // intervention initiale (garde en base) ; aucune route ne rattache ensuite une intervention à une affaire.
  if (interventions.some(i => i.clientId !== devis.clientId || i.chantierId !== null)) {
    throw new DevisConflitError('L’intervention de ce devis ou l’une de ses suites n’est plus de son client, ou déjà rattachée à une affaire : elle ne peut pas être rattachée au chantier.');
  }
  const motif = `Conversion du devis ${devis.numero} (version ${devis.version}) en chantier : rattachée au chantier ouvert par le même devis.`;
  for (const avant of interventions) {
    const apres = await tx.intervention.update({ where: { id: avant.id }, data: { chantierId } });
    await journaliserIntervention(tx, req, 'RATTACHEMENT_CHANTIER', apres, avant, motif);
  }
}
