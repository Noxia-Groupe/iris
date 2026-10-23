import { Prisma, PrismaClient } from '@prisma/client';
import {
  PLAFOND_MONTANT, FactureInvalideError, type LigneTaxable, tauxUtilises, baseHtDuTaux, tvaDuTaux, arrondiCommercialLigneHt, centimesTtcLigne,
  centimes,
} from '../../commun/montants';
import { nombreDecimalNonNegatif } from '../../commun/validation';

// --- Facturation française native ---
export const factureInclude = { client: { select: { id: true, raisonSociale: true } }, factureOrigine: { select: { id: true, numero: true } }, avoirs: { select: { id: true, numero: true, type: true, statut: true, estAvoirAnnulation: true, ventilationTva: { select: { tauxTva: true, totalHt: true } }, lignes: { select: { tauxTva: true, totalHt: true } } }, orderBy: { createdAt: 'asc' as const } }, mentionsLegalesVersion: { select: { id: true, version: true, mentions: true, cgv: true, penalites: true, escompte: true, publieeLe: true } }, lignes: { orderBy: { ordre: 'asc' as const } }, ventilationTva: { orderBy: { tauxTva: 'asc' as const } } };

// L'adresse du client est sélectionnée depuis son site de facturation, puis figée à l'émission.
export const SITE_FACTURATION_ORDRE = [{ estSiteFacturation: 'desc' as const }, { principal: 'desc' as const }, { estSiegeSocial: 'desc' as const }, { nom: 'asc' as const }, { id: 'asc' as const }];
export function formaterAdresseFacturation(site: { adresse: string; complementAdresse: string | null; codePostal: string; ville: string; pays: string }) {
  return [site.adresse, site.complementAdresse, `${site.codePostal} ${site.ville}`.trim(), site.pays && site.pays !== 'France' ? site.pays : null].filter(Boolean).join('\n');
}

export function formatMontantFacture(valeur: unknown) {
  return `${Number(valeur).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

export function formatDateFacture(valeur: Date | string) {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC' }).format(new Date(valeur)).replace(/\//g, '-');
}

export class FactureRattachementRefuse extends Error {
  statut: number;
  constructor(statut: number, message: string) { super(message); this.statut = statut; }
}

type VentilationTva = { tauxTva: number; totalHt: number; totalTva: number; totalTtc: number };
export const ventilationTvaDerivee = (lignes: LigneTaxable[]): VentilationTva[] => tauxUtilises(lignes).sort((a, b) => a - b).map(tauxTva => {
  const totalHt = baseHtDuTaux(lignes, tauxTva);
  const totalTva = tvaDuTaux(lignes, tauxTva);
  return { tauxTva, totalHt, totalTva, totalTtc: centimes(totalHt + totalTva) };
});
// Le fallback ne sert qu'aux documents historiques, qui n'ont volontairement pas été réécrits.
export const ventilationFacture = (facture: { lignes: LigneTaxable[]; ventilationTva?: { tauxTva: unknown; totalHt: unknown; totalTva: unknown; totalTtc: unknown }[] }): VentilationTva[] =>
  facture.ventilationTva?.length ? facture.ventilationTva.map(v => ({ tauxTva: Number(v.tauxTva), totalHt: Number(v.totalHt), totalTva: Number(v.totalTva), totalTtc: Number(v.totalTtc) })) : ventilationTvaDerivee(facture.lignes);

export function lignesAvoirPartiel(brutes: unknown): { ordre: number; designation: string; nature: string; quantite: number; prixUnitaireHt: number; tauxTva: number; totalHt: number; totalTtc: number }[] {
  const lignesBrutes = Array.isArray(brutes) ? brutes : [];
  if (!lignesBrutes.length) throw new FactureInvalideError('Un avoir partiel doit contenir au moins une ligne.');
  return lignesBrutes.map((ligne: any, ordre: number) => {
    const designation = String(ligne?.designation || '').trim();
    const quantite = nombreDecimalNonNegatif(ligne?.quantite, 9, false, 3);
    const prixUnitaireHt = nombreDecimalNonNegatif(ligne?.prixUnitaireHt, 10, true);
    const tauxTva = nombreDecimalNonNegatif(ligne?.tauxTva, 3, true);
    const nature = String(ligne?.nature || 'PRESTATION');
    if (!designation || designation.length > 500 || !['PRESTATION', 'ARTICLE'].includes(nature) || quantite === null || quantite <= 0 || prixUnitaireHt === null || prixUnitaireHt <= 0 || tauxTva === null || tauxTva > 100) throw new FactureInvalideError('Ligne d’avoir partiel invalide.');
    const totalHt = arrondiCommercialLigneHt(ligne?.quantite, ligne?.prixUnitaireHt);
    const totalTtc = centimesTtcLigne(totalHt, ligne?.tauxTva);
    if (totalTtc > PLAFOND_MONTANT) throw new FactureInvalideError('Montant de ligne hors des limites acceptées.');
    return { ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc };
  });
}
export class AvoirPlafondError extends Error {}

// Même sélection pour la lecture informative et le garde transactionnel à l'émission.
export const derniereDateFactureNumerotee = (db: PrismaClient | Prisma.TransactionClient) =>
  db.facture.findFirst({ where: { type: 'FACTURE', numero: { not: null } }, orderBy: { dateEmission: 'desc' }, select: { dateEmission: true } });
