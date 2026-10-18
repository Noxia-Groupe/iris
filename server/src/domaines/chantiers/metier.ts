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

// Le chantier tel qu'il accompagne un achat ou un pointage : de quoi l'identifier, rien
// de plus. `include: { chantier: true }` renvoyait l'enregistrement ENTIER — budget
// global vendu, budget matériel, budget main-d'œuvre — à tout compte connecté, y compris
// ceux à qui serializeChantier masque précisément ces montants ailleurs. Un `select`
// explicite ferme la fuite par construction : ce qui n'est pas listé ne peut pas sortir.
export const CHANTIER_LITE_SELECT = { id: true, nom: true, client: true, statut: true } as const;
