import { prisma } from '../../db';

// --- Coûts des suites dans la marge d'un chantier ---
// Décision de Nelson de la nuit du 26 au 27-10-2026 (« Les suites seulement », docs/HISTORIQUE-DECISIONS.md) :
// parmi les interventions SAV rattachées à l'affaire d'un chantier, seules les suites (interventions de
// suivi liées, suites de suites comprises) voient leurs coûts entrer dans la marge du chantier : leurs
// heures, au taux horaire chargé figé sur chaque heure, et leur matériel. L'intervention initiale et les
// autres interventions de l'affaire restent hors de cette marge, comme avant. Les lignes archivées n'y
// entrent pas, comme sur le chantier ; celles d'une suite annulée y restent, la dépense ayant été faite
// (choix par défaut, à confirmer).
export type CoutsSuitesChantier = {
  heures: Array<{ nbrHeures: unknown; tauxHoraireApplique: unknown }>;
  achats: Array<{ montantHT: unknown }>;
};

// Joint à chaque chantier les coûts de ses suites, lus par computeChantierMetrics. Toute lecture d'une
// marge de chantier passe par ici, pour que liste, fiche, tableau de bord, statistiques et commissions
// disent la même marge. Le champ joint n'est jamais renvoyé tel quel (cf. serializeChantier).
export async function avecCoutsSuites<T extends { id: string }>(chantiers: T[]): Promise<Array<T & { coutsSuites: CoutsSuitesChantier }>> {
  const parChantier = new Map<string, CoutsSuitesChantier>(chantiers.map((chantier) => [chantier.id, { heures: [], achats: [] }]));
  if (parChantier.size) {
    const filtre = { archivedAt: null, intervention: { chantierId: { in: [...parChantier.keys()] }, interventionInitialeId: { not: null } } };
    const [heures, achats] = await Promise.all([
      prisma.coutInterventionHeure.findMany({ where: filtre, select: { nbrHeures: true, tauxHoraireApplique: true, intervention: { select: { chantierId: true } } } }),
      prisma.coutInterventionAchat.findMany({ where: filtre, select: { montantHT: true, intervention: { select: { chantierId: true } } } }),
    ]);
    for (const heure of heures) parChantier.get(heure.intervention.chantierId!)?.heures.push({ nbrHeures: heure.nbrHeures, tauxHoraireApplique: heure.tauxHoraireApplique });
    for (const achat of achats) parChantier.get(achat.intervention.chantierId!)?.achats.push({ montantHT: achat.montantHT });
  }
  return chantiers.map((chantier) => ({ ...chantier, coutsSuites: parChantier.get(chantier.id)! }));
}
