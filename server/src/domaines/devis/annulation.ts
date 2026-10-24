import { Prisma, type ContratMaintenance } from '@prisma/client';
import type { AuthRequest } from '../../http/auth';
import { INSTANTANE_CRENEAU, journaliserIntervention, retirerCreneauIntervention } from '../interventions/metier';
import { verrouillerIntervention } from '../interventions/comptesRendus';
import { journaliserContrat, verrouillerContratMaintenance } from '../contrats/metier';
import { DevisConflitError, DevisSaisieError, devisInclude, verrouillerDevis } from './metier';

// --- Annulation d'un devis, en cascade sur ce qu'il a créé (lot 4 suite) ---
// Décisions de Nelson des 22 et 23-10-2026 : « Oui un devis converti en chantier s’annule avec
// lui », « si annulation chantier dans le devis le contrat est forcement annulé egalement », « Si
// devis annulé, le contrat de maintenace l’est aussi » (même un contrat commencé : « même avec une
// date anterieur »), « si devis annulé le sav egalement ». Dans la même transaction que le devis :
//  - le chantier est archivé (ANNULE, motif conservé), comme avant ce lot, et refusé dès qu'une heure
//    ou un achat y est saisi : une affaire commencée ne s'annule pas ;
//  - le contrat de maintenance passe ANNULE, avec la date, l'auteur et le motif du devis, et l'écrit
//    à son journal (action ANNULATION), même commencé (date de début passée, visites réalisées) ;
//    ses visites non réalisées (à planifier, planifiées) sont annulées, ses visites terminées
//    restent, et une visite en cours refuse l'annulation (choix par défaut, à confirmer) ;
//  - l'intervention SAV passe ANNULEE ; en cours ou terminée, elle refuse l'annulation (choix par
//    défaut, à confirmer, comme le chantier qui porte des heures). Seul son statut compte : des
//    coûts saisis sur une intervention pas encore commencée ne refusent pas l'annulation.
// Chaque intervention annulée l'est comme depuis sa fiche (changement de statut journalisé) : son
// créneau est retiré du planning, projection et affectations SAV, sous son verrou déjà pris, et son
// journal les garde dans l'« avant » (décision de Nelson du 24-10-2026, point 7). Les
// contrats et interventions qui ne sont pas issus de ce devis ne changent pas. Une intervention
// ou un contrat que la base ne contiendrait plus (aucune route n'en supprime) est laissé de côté ;
// un chantier ne se supprime pas (DELETE /api/chantiers/:id répond 410). Tous les contrôles
// précèdent toute écriture.
//
// Ordre des verrous, toujours le même : le devis (comme la conversion, qui l'attend), puis le
// chantier (FOR NO KEY UPDATE, le verrou que prenait sa mise à jour), puis les interventions (SAV
// du devis et visites du contrat, par identifiant croissant), enfin le contrat. Les interventions
// passent avant le contrat comme dans le placement d'une visite et les coûts SAV (intervention,
// puis contrat) ; le changement de statut d'une intervention ne prend que l'intervention, et ceux
// du contrat et la génération des visites ne prennent que le contrat avant d'insérer. Aucune de
// ces routes ne prend un verrou dans l'ordre inverse : pas d'interblocage. Seule la génération
// peut créer une visite entre la lecture des visites et le verrou du contrat : relue sous ce verrou,
// une visite nouvelle refuse l'annulation (409, à relancer) plutôt que d'être verrouillée hors ordre.
const STATUTS_NON_REALISES = ['A_PLANIFIER', 'PLANIFIEE'];

export async function annulerDevisEnCascade(tx: Prisma.TransactionClient, devisId: string, motif: string, req: AuthRequest) {
  const auteur = req.user!;
  if (!await verrouillerDevis(tx, devisId)) throw new DevisSaisieError('Devis introuvable.');
  const devis = await tx.devis.findUnique({ where: { id: devisId }, include: { conversions: { orderBy: { rang: 'asc' } } } });
  if (!devis) throw new DevisSaisieError('Devis introuvable.');
  if (devis.statut === 'ANNULE') throw new DevisSaisieError('Ce devis est déjà annulé.');
  const cible = (type: string) => devis.conversions.find(c => c.cibleType === type)?.cibleId ?? null;
  const chantierId = cible('CHANTIER'), contratId = cible('CONTRAT'), interventionId = cible('INTERVENTION');

  if (chantierId) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Chantier" WHERE "id" = ${chantierId} FOR NO KEY UPDATE`);
    // Le verrou porte sur les écritures VIVANTES : une ligne déjà archivée n'engage rien. Les
    // saisies ne verrouillent pas le chantier : course connue, non corrigée (constat « Saisie sur un
    // chantier pendant l'annulation de son devis » de docs/ROADMAP-PASSATION.md).
    const [heures, achats] = await Promise.all([
      tx.pointageHeure.count({ where: { chantierId, archivedAt: null } }),
      tx.achatReel.count({ where: { chantierId, archivedAt: null } }),
    ]);
    if (heures > 0 || achats > 0) {
      throw new DevisConflitError(`Annulation impossible : ce chantier porte déjà ${heures} pointage(s) d’heures et ${achats} achat(s). Une affaire commencée ne s’annule pas.`);
    }
  }

  const lireVisites = () => contratId
    ? tx.intervention.findMany({ where: { contratMaintenanceId: contratId }, select: { id: true, reference: true, statut: true }, orderBy: { id: 'asc' } })
    : Promise.resolve([]);
  const aVerrouiller = [...new Set([...(interventionId ? [interventionId] : []), ...(await lireVisites()).map(v => v.id)])].sort();
  for (const id of aVerrouiller) await verrouillerIntervention(tx, id, 'FOR UPDATE');
  let contrat: ContratMaintenance | null = null;
  if (contratId) {
    await verrouillerContratMaintenance(tx, contratId);
    contrat = await tx.contratMaintenance.findUnique({ where: { id: contratId } });
  }
  const visites = await lireVisites();
  if (visites.some(v => !aVerrouiller.includes(v.id))) {
    throw new DevisConflitError('Une visite vient d’être créée pour le contrat de ce devis : relancez l’annulation.');
  }
  const sav = interventionId ? await tx.intervention.findUnique({ where: { id: interventionId }, select: { id: true, reference: true, statut: true } }) : null;
  if (sav && ['EN_COURS', 'TERMINEE'].includes(sav.statut)) {
    throw new DevisConflitError(`Annulation impossible : l’intervention ${sav.reference} issue de ce devis est ${sav.statut === 'EN_COURS' ? 'en cours' : 'terminée'}. Une affaire commencée ne s’annule pas.`);
  }
  const visiteEnCours = visites.find(v => v.statut === 'EN_COURS');
  if (visiteEnCours) {
    throw new DevisConflitError(`Annulation impossible : la visite ${visiteEnCours.reference} du contrat issu de ce devis est en cours. Terminez-la ou annulez-la d’abord depuis sa fiche.`);
  }

  // Écritures, une fois tous les contrôles passés.
  const maintenant = new Date();
  const motifCible = `Annulation du devis ${devis.numero} (version ${devis.version}) : ${motif}`;
  if (chantierId) {
    await tx.chantier.update({ where: { id: chantierId }, data: { statut: 'ANNULE', annuleLe: maintenant, annuleParId: auteur.id, motifAnnulation: motif } });
  }
  const interventionsAnnulees: string[] = [];
  for (const intervention of [...(sav ? [sav] : []), ...visites]) {
    if (!STATUTS_NON_REALISES.includes(intervention.statut)) continue;
    const avant = await tx.intervention.findUniqueOrThrow({ where: { id: intervention.id }, include: INSTANTANE_CRENEAU });
    await retirerCreneauIntervention(tx, intervention.id);
    const modifiee = await tx.intervention.update({ where: { id: intervention.id }, data: { statut: 'ANNULEE' }, include: INSTANTANE_CRENEAU });
    await journaliserIntervention(tx, req, 'CHANGEMENT_STATUT', modifiee, avant, motifCible);
    interventionsAnnulees.push(intervention.id);
  }
  let contratAnnule: string | null = null;
  if (contrat && contrat.statut !== 'ANNULE') {
    const maj = await tx.contratMaintenance.update({ where: { id: contrat.id }, data: { statut: 'ANNULE', annuleLe: maintenant, annuleParId: auteur.id, motifAnnulation: motif } });
    await journaliserContrat(tx, req, 'ANNULATION', maj, contrat, motifCible);
    contratAnnule = contrat.id;
  }
  const maj = await tx.devis.update({
    where: { id: devis.id },
    data: { statut: 'ANNULE', annuleLe: maintenant, annuleParId: auteur.id, motifAnnulation: motif },
    include: devisInclude,
  });
  return { devis: maj, chantierArchive: chantierId, contratAnnule, interventionsAnnulees };
}
