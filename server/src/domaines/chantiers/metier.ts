import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { isCommercialLike, COMMERCIAL_OR_FILTER } from '../../droits/roles';

// Types de chantier (liste fermée, plusieurs possibles par chantier) — sert aussi de
// liste blanche pour ne jamais stocker de valeur arbitraire envoyée par le client.
export const TYPES_CHANTIER = ['Vidéo', 'Alarme', "Contrôle d'accès", 'Interphonie', 'Câblage réseau'];
export function sanitizeTypes(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : input ? [input] : [];
  return TYPES_CHANTIER.filter((t) => arr.includes(t));
}

// Titulaire et commercial d'un chantier : mêmes contrôles à l'ouverture du chantier (conversion
// d'un devis) et à la modification de sa fiche. Un compte désactivé (départ de l'entreprise)
// reste titulaire ou commercial des chantiers qu'il a suivis, son historique étant conservé,
// mais ne reçoit plus de nouvelle affectation. Chacune renvoie le motif du refus, ou null.
export async function refusTitulaire(responsableId: string, actuelId: string | null): Promise<string | null> {
  if (!responsableId) return 'Un chantier doit toujours avoir un conducteur responsable.';
  const responsable = await prisma.user.findUnique({ where: { id: responsableId }, select: { actif: true } });
  return !responsable || (!responsable.actif && responsableId !== actuelId) ? 'Conducteur responsable introuvable.' : null;
}
export async function refusCommercial(commercialId: string, actuelId: string | null): Promise<string | null> {
  if (!commercialId) {
    return (await prisma.user.count({ where: { OR: COMMERCIAL_OR_FILTER } })) > 0 ? 'Un chantier doit toujours avoir un commercial rattaché.' : null;
  }
  const commercial = await prisma.user.findUnique({ where: { id: commercialId }, select: { role: true, estCommercial: true, actif: true } });
  return !commercial || !isCommercialLike(commercial) || (!commercial.actif && commercialId !== actuelId) ? 'Commercial introuvable.' : null;
}

// #181 : un changement de titulaire, de commercial ou de la case « Encaissé » s'écrit au journal
// des saisies du chantier, comme un changement de client, dans la transaction qui l'enregistre :
// sans la trace, le changement n'a pas lieu. L'auteur et les noms des comptes sont figés à l'acte.
// Un enregistrement à l'identique n'en écrit pas : c'est à l'appelant de comparer, sur la ligne
// verrouillée.
export type ChangementChantier = 'CHANGEMENT_TITULAIRE' | 'CHANGEMENT_COMMERCIAL' | 'CHANGEMENT_ENCAISSEMENT';
export async function journaliserChangementChantier(
  tx: Prisma.TransactionClient, chantierId: string, auteur: { id: string; name: string },
  action: ChangementChantier, avant: Prisma.InputJsonObject, apres: Prisma.InputJsonObject,
) {
  await tx.journalSaisieChantier.create({ data: {
    chantierId, cible: 'CHANTIER', cibleId: chantierId, action, auteurId: auteur.id, auteurNom: auteur.name, avant, apres,
  } });
}
// Un compte tel qu'il figure au journal : son identifiant et son nom à l'acte (null s'il n'y en a pas).
export async function compteAuJournal(tx: Prisma.TransactionClient, id: string | null): Promise<{ id: string | null; nom: string | null }> {
  if (!id) return { id: null, nom: null };
  const compte = await tx.user.findUnique({ where: { id }, select: { name: true } });
  return { id, nom: compte?.name ?? null };
}

// Le chantier tel qu'il accompagne un achat ou un pointage : de quoi l'identifier, rien
// de plus. `include: { chantier: true }` renvoyait l'enregistrement ENTIER — budget
// global vendu, budget matériel, budget main-d'œuvre — à tout compte connecté, y compris
// ceux à qui serializeChantier masque précisément ces montants ailleurs. Un `select`
// explicite ferme la fuite par construction : ce qui n'est pas listé ne peut pas sortir.
export const CHANTIER_LITE_SELECT = { id: true, nom: true, client: true, statut: true } as const;
