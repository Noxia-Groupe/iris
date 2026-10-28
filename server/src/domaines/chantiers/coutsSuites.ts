import { prisma } from '../../db';

// --- Coûts des suites dans la marge d'un chantier ---
// Décision de Nelson de la nuit du 26 au 27-10-2026 (« Les suites seulement », docs/HISTORIQUE-DECISIONS.md) :
// parmi les interventions SAV rattachées à l'affaire d'un chantier, seules les suites (interventions de
// suivi liées, suites de suites comprises) voient leurs coûts entrer dans la marge du chantier : leurs
// heures, au taux horaire chargé figé sur chaque heure, et leur matériel. L'intervention initiale et les
// autres interventions de l'affaire restent hors de cette marge, comme avant. Les lignes archivées n'y
// entrent pas, comme sur le chantier ; celles d'une suite annulée y restent, la dépense ayant été faite
// (choix par défaut, à confirmer).
//
// Exception : l'intervention issue du devis qui a aussi ouvert le chantier (devis converti en chantier et
// en intervention) lui est rattachée et compte avec lui (décision de Nelson du 27-10-2026 à 21:41 UTC,
// « Elle vont au chantier auquel il est rattaché si c’est un chantier issue d’un devis, ce n’est pas une
// intervention sav de toute facon »). Ses coûts sont joints à part, dans coutsInterventionDevis : n'étant
// pas une intervention SAV, elle compte comme le travail du chantier (choix par défaut, à confirmer, cf.
// computeChantierMetrics). Ses suites restent des suites.
export type CoutsSuitesChantier = {
  heures: Array<{ nbrHeures: unknown; tauxHoraireApplique: unknown; date?: Date }>;
  achats: Array<{ montantHT: unknown; date?: Date }>;
};

type LecteurConversions = { devisConversion: Pick<typeof prisma.devisConversion, 'findMany'> };

// Interventions issues du devis qui a ouvert chacun de ces chantiers : identifiant de l'intervention vers
// celui du chantier. Un devis se convertit au plus deux fois, et une seule fois par cible.
export async function interventionsDuDevisDesChantiers(client: LecteurConversions, chantierIds: string[]): Promise<Map<string, string>> {
  const parIntervention = new Map<string, string>();
  if (!chantierIds.length) return parIntervention;
  const chantiers = await client.devisConversion.findMany({ where: { cibleType: 'CHANTIER', cibleId: { in: chantierIds } }, select: { devisId: true, cibleId: true } });
  if (!chantiers.length) return parIntervention;
  const chantierDuDevis = new Map(chantiers.map((conversion) => [conversion.devisId, conversion.cibleId]));
  const interventions = await client.devisConversion.findMany({ where: { cibleType: 'INTERVENTION', devisId: { in: [...chantierDuDevis.keys()] } }, select: { devisId: true, cibleId: true } });
  for (const conversion of interventions) parIntervention.set(conversion.cibleId, chantierDuDevis.get(conversion.devisId)!);
  return parIntervention;
}

// Joint à chaque chantier les coûts de ses suites, et ceux de l'intervention issue de son devis, lus par
// computeChantierMetrics. Toute lecture d'une marge de chantier passe par ici, pour que liste, fiche,
// tableau de bord, statistiques et commissions disent la même marge. Les champs joints ne sont jamais
// renvoyés tels quels (cf. serializeChantier).
export async function avecCoutsSuites<T extends { id: string }>(chantiers: T[]): Promise<Array<T & { coutsSuites: CoutsSuitesChantier; coutsInterventionDevis: CoutsSuitesChantier }>> {
  const vide = (): CoutsSuitesChantier => ({ heures: [], achats: [] });
  const parChantier = new Map<string, CoutsSuitesChantier>(chantiers.map((chantier) => [chantier.id, vide()]));
  const devisParChantier = new Map<string, CoutsSuitesChantier>(chantiers.map((chantier) => [chantier.id, vide()]));
  if (parChantier.size) {
    const chantierIds = [...parChantier.keys()];
    const filtre = { archivedAt: null, intervention: { chantierId: { in: chantierIds }, interventionInitialeId: { not: null } } };
    // L'intervention du devis ne compte qu'une fois rattachée à son chantier, à la conversion (aucune
    // reprise des conversions d'avant ce lot, règle 4).
    const interventionsDevis = await interventionsDuDevisDesChantiers(prisma, chantierIds);
    const filtreDevis = { archivedAt: null, interventionId: { in: [...interventionsDevis.keys()] }, intervention: { chantierId: { in: chantierIds } } };
    const [heures, achats, heuresDevis, achatsDevis] = await Promise.all([
      prisma.coutInterventionHeure.findMany({ where: filtre, select: { nbrHeures: true, tauxHoraireApplique: true, intervention: { select: { chantierId: true } } } }),
      prisma.coutInterventionAchat.findMany({ where: filtre, select: { montantHT: true, intervention: { select: { chantierId: true } } } }),
      interventionsDevis.size ? prisma.coutInterventionHeure.findMany({ where: filtreDevis, select: { date: true, nbrHeures: true, tauxHoraireApplique: true, intervention: { select: { id: true, chantierId: true } } } }) : Promise.resolve([]),
      interventionsDevis.size ? prisma.coutInterventionAchat.findMany({ where: filtreDevis, select: { date: true, montantHT: true, intervention: { select: { id: true, chantierId: true } } } }) : Promise.resolve([]),
    ]);
    for (const heure of heures) parChantier.get(heure.intervention.chantierId!)?.heures.push({ nbrHeures: heure.nbrHeures, tauxHoraireApplique: heure.tauxHoraireApplique });
    for (const achat of achats) parChantier.get(achat.intervention.chantierId!)?.achats.push({ montantHT: achat.montantHT });
    // Seulement rattachée au chantier de son propre devis.
    const duChantierDeSonDevis = (intervention: { id: string; chantierId: string | null }) => intervention.chantierId !== null && interventionsDevis.get(intervention.id) === intervention.chantierId;
    for (const heure of heuresDevis) if (duChantierDeSonDevis(heure.intervention)) devisParChantier.get(heure.intervention.chantierId!)?.heures.push({ date: heure.date, nbrHeures: heure.nbrHeures, tauxHoraireApplique: heure.tauxHoraireApplique });
    for (const achat of achatsDevis) if (duChantierDeSonDevis(achat.intervention)) devisParChantier.get(achat.intervention.chantierId!)?.achats.push({ date: achat.date, montantHT: achat.montantHT });
  }
  return chantiers.map((chantier) => ({ ...chantier, coutsSuites: parChantier.get(chantier.id)!, coutsInterventionDevis: devisParChantier.get(chantier.id)! }));
}
