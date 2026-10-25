import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { PLAFOND_MONTANT, arrondiCommercialLigneHt, centimesTtcLigne } from '../../commun/montants';
import { nombreDecimalNonNegatif } from '../../commun/validation';
import { UNITE_MAIN_OEUVRE } from '../catalogue/main-oeuvre';
import { formatMontantFacture } from '../factures/metier';

// --- Devis au temps passé (décisions de Nelson des 24 et 25-10-2026) ---
// Le devis indique qu'il est au temps passé ; il facture au moins une heure, hors matériel, et le temps
// au-delà en plus, par un pas réglé par la société, toujours arrondi au pas supérieur ; il affiche le
// prix de l'heure facturée, choisi parmi les mains d'œuvre du catalogue (point 20 et « Réglage
// société », 24-10-2026). Le 25-10-2026 :
//  - « À l'heure seulement » : le prix à l'heure hors contrat ou sous contrat d'une main d'œuvre du
//    catalogue ; le forfait jour n'est pas proposé ;
//  - « Ligne minimum comptée » : une ligne « main d'œuvre au temps passé », 1 h minimum (modifiable vers
//    le haut), au prix de l'heure choisi, figé, comptée dans le total ; le matériel en lignes à part ; le
//    total est un minimum, et le devis le dit ;
//  - « Aucune, à régler » : le pas est vide au démarrage, et un devis au temps passé est refusé tant que
//    l'administration ne l'a pas fixé ;
//  - « Lot suivant » : la facture reprenant les heures saisies vient dans un lot à part.
//
// Choix par défaut, à confirmer (passation, section 4) : le prix de la ligne est fixé par le serveur
// depuis la main d'œuvre ; un prix (ou une TVA, une unité, une nature) envoyé pour cette ligne et
// différent du sien est refusé (400), plutôt qu'ignoré, pour que personne ne croie avoir imposé un
// prix ; au-delà d'une heure, la quantité suit la règle des autres lignes (au millième).

export type TarifTempsPasse = 'HORS_CONTRAT' | 'SOUS_CONTRAT';
export const TARIFS_TEMPS_PASSE: readonly TarifTempsPasse[] = ['HORS_CONTRAT', 'SOUS_CONTRAT'];
export const LIBELLES_TARIF_TEMPS_PASSE: Record<TarifTempsPasse, string> = {
  HORS_CONTRAT: 'tarif à l’heure hors contrat',
  SOUS_CONTRAT: 'tarif à l’heure sous contrat',
};

export const REFUS_PAS_NON_REGLE = 'Réglez d’abord le pas du temps passé dans l’administration (Administration > Marges & Commissions) : un devis au temps passé est refusé tant qu’il n’est pas fixé.';
export const REFUS_QUANTITE_TEMPS_PASSE = 'La ligne au temps passé compte au moins une heure : sa quantité est de 1 ou plus.';
export const REFUS_TARIF_TEMPS_PASSE = 'Tarif de la ligne au temps passé : à l’heure hors contrat (HORS_CONTRAT) ou à l’heure sous contrat (SOUS_CONTRAT) ; le forfait jour n’est pas proposé sur un devis au temps passé.';
export const REFUS_FICHE_TEMPS_PASSE = 'Une ligne au temps passé reprend une main d’œuvre du catalogue (prestation marquée main d’œuvre).';
export const REFUS_MAIN_OEUVRE_INACTIVE = 'Main d’œuvre introuvable ou désactivée : choisissez une main d’œuvre active du catalogue.';
export const REFUS_CHANGEMENT_LIGNE_TEMPS_PASSE = 'La ligne au temps passé garde sa main d’œuvre, son tarif et son prix : pour en changer, retirez-la et ajoutez-en une nouvelle.';
export const REFUS_NATURE_LIGNE_EXISTANTE = 'Une ligne existante garde sa nature : une ligne ordinaire ne devient pas la ligne au temps passé, ni l’inverse. Retirez-la et ajoutez-en une nouvelle.';
export const REFUS_PRIX_ACHAT_TEMPS_PASSE = 'Une ligne au temps passé n’a pas de prix d’achat prévu : son coût est celui des heures des intervenants.';
export const REFUS_UNITE_TEMPS_PASSE = 'La ligne au temps passé est de la main-d’œuvre, comptée à l’heure.';
export const REFUS_UNE_LIGNE_TEMPS_PASSE = 'Un devis au temps passé porte exactement une ligne de main d’œuvre au temps passé.';
export const REFUS_LIGNE_SUR_DEVIS_ORDINAIRE = 'Une ligne au temps passé n’existe que sur un devis au temps passé : cochez « Devis au temps passé ».';
export const REFUS_TVA_MAIN_OEUVRE = 'TVA de la main d’œuvre invalide pour un devis (un pourcentage de 0 à 100, au centième) : corrigez la fiche du catalogue.';

export class TempsPasseSaisieError extends Error {}
export class TempsPasseConflitError extends Error {}

const renseigne = (valeur: unknown) => valeur !== undefined && valeur !== null && !(typeof valeur === 'string' && valeur.trim() === '');

// Marqueur du devis : absent (undefined, un PATCH garde alors celui du devis), vrai ou faux.
export function drapeauDevisTempsPasse(valeur: unknown): boolean | undefined {
  if (valeur === undefined || valeur === null) return undefined;
  if (typeof valeur !== 'boolean') throw new TempsPasseSaisieError('« auTempsPasse » doit valoir true ou false.');
  return valeur;
}

// Ce que la saisie d'une ligne au temps passé demande : le tarif (absent pour une ligne existante, qui
// garde le sien), et, pour comparaison seulement, le prix et la TVA envoyés.
export type SaisieTempsPasse = { tarif: TarifTempsPasse | null; prixUnitaireHt: number | null; tauxTva: number | null };

// Lit une ligne marquée au temps passé (`tempsPasse: true`), ou rend null pour une ligne ordinaire. La
// fiche du catalogue est lue par l'appelant (`catalogue`), qui la valide comme pour toute ligne.
export function lireLigneTempsPasse(
  item: Record<string, unknown>, ligneId: string | null, catalogue: { famille: string; id: string } | null,
): { quantite: number; saisie: SaisieTempsPasse } | null {
  const drapeau = item.tempsPasse;
  if (drapeau === undefined || drapeau === null || drapeau === false) return null;
  if (drapeau !== true) throw new TempsPasseSaisieError('« tempsPasse » doit valoir true ou false.');
  const quantite = nombreDecimalNonNegatif(item.quantite, 9, false, 3);
  if (quantite === null) throw new TempsPasseSaisieError('Ligne de devis invalide.');
  if (quantite < 1) throw new TempsPasseSaisieError(REFUS_QUANTITE_TEMPS_PASSE);
  if (renseigne(item.nature) && item.nature !== 'MAIN_OEUVRE') throw new TempsPasseSaisieError(REFUS_UNITE_TEMPS_PASSE);
  if (renseigne(item.unite) && String(item.unite).trim() !== UNITE_MAIN_OEUVRE) throw new TempsPasseSaisieError(REFUS_UNITE_TEMPS_PASSE);
  let tarif: TarifTempsPasse | null = null;
  if (renseigne(item.tarifTempsPasse)) {
    if (!(TARIFS_TEMPS_PASSE as readonly unknown[]).includes(item.tarifTempsPasse)) throw new TempsPasseSaisieError(REFUS_TARIF_TEMPS_PASSE);
    tarif = item.tarifTempsPasse as TarifTempsPasse;
  } else if (!ligneId) throw new TempsPasseSaisieError(REFUS_TARIF_TEMPS_PASSE);
  if (catalogue ? catalogue.famille !== 'prestations' : !ligneId) throw new TempsPasseSaisieError(REFUS_FICHE_TEMPS_PASSE);
  const prixUnitaireHt = renseigne(item.prixUnitaireHt) ? nombreDecimalNonNegatif(item.prixUnitaireHt, 10, true) : null;
  if (renseigne(item.prixUnitaireHt) && prixUnitaireHt === null) throw new TempsPasseSaisieError('Ligne de devis invalide.');
  const tauxTva = renseigne(item.tauxTva) ? nombreDecimalNonNegatif(item.tauxTva, 3, true) : null;
  if (renseigne(item.tauxTva) && (tauxTva === null || tauxTva > 100)) throw new TempsPasseSaisieError('Ligne de devis invalide.');
  return { quantite, saisie: { tarif, prixUnitaireHt, tauxTva } };
}

// Exactement une ligne au temps passé sur un devis au temps passé, aucune sur un devis ordinaire.
export function exigerCoherenceTempsPasse(auTempsPasse: boolean, references: { tempsPasse?: SaisieTempsPasse }[]) {
  const nombre = references.filter((reference) => reference.tempsPasse).length;
  if (auTempsPasse && nombre !== 1) throw new TempsPasseSaisieError(REFUS_UNE_LIGNE_TEMPS_PASSE);
  if (!auTempsPasse && nombre > 0) throw new TempsPasseSaisieError(REFUS_LIGNE_SUR_DEVIS_ORDINAIRE);
}

// Pas du temps passé du devis : celui déjà figé sur un devis au temps passé, sinon le réglage de la
// société, refusé s'il est vide (décision « Aucune, à régler ») ; aucun pas sur un devis ordinaire.
export async function pasDuDevis(
  db: Prisma.TransactionClient | typeof prisma, auTempsPasse: boolean,
  precedent?: { auTempsPasse: boolean; pasTempsPasseMinutes: number | null },
): Promise<number | null> {
  if (!auTempsPasse) return null;
  if (precedent?.auTempsPasse && precedent.pasTempsPasseMinutes !== null) return precedent.pasTempsPasseMinutes;
  const reglage = await db.parametres.findUnique({ where: { id: 'singleton' }, select: { pasTempsPasseMinutes: true } });
  if (!reglage || reglage.pasTempsPasseMinutes === null) throw new TempsPasseConflitError(REFUS_PAS_NON_REGLE);
  return reglage.pasTempsPasseMinutes;
}

// Lecture du réglage dans le corps de PUT /api/parametres : vide (null ou chaîne vide) pour le retirer,
// ce qui rend null, sinon un entier de minutes de 1 à 60 (choix par défaut, à confirmer).
export function lireReglagePasTempsPasse(brut: unknown): number | null {
  if (brut === null || brut === '') return null;
  const minutes = typeof brut === 'number' ? brut : typeof brut === 'string' && /^\d+$/.test(brut.trim()) ? Number(brut.trim()) : NaN;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    throw new TempsPasseSaisieError('Le pas du temps passé doit être un nombre entier de minutes entre 1 et 60, ou vide pour le retirer (les devis au temps passé sont alors refusés).');
  }
  return minutes;
}

type LigneTempsPasseExistante = { catalogueId: string | null; reference: string | null; tarifTempsPasse: string | null; prixUnitaireHt: Prisma.Decimal; tauxTva: Prisma.Decimal };

// Résout la ligne au temps passé : prix, TVA et référence de la main d'œuvre au moment où la ligne est
// ajoutée, figés ensuite. Une ligne existante (`existante`) garde les siens, même si la main d'œuvre a
// changé de prix ou a été désactivée depuis ; une nouvelle ligne exige une main d'œuvre active, dont le
// prix est celui du tarif choisi (jamais un forfait jour). La fiche est lue par `db`, dans la
// transaction de l'appelant.
export async function resoudreLigneTempsPasse(
  db: Prisma.TransactionClient | typeof prisma,
  ligne: { ordre: number; designation: string; quantite: number },
  saisie: SaisieTempsPasse,
  catalogue: { famille: string; id: string } | null,
  existante: LigneTempsPasseExistante | null,
) {
  let source: { prix: Prisma.Decimal; tva: Prisma.Decimal; reference: string; catalogueId: string; tarif: TarifTempsPasse };
  if (existante) {
    if ((saisie.tarif !== null && saisie.tarif !== existante.tarifTempsPasse) || (catalogue && catalogue.id !== existante.catalogueId)) {
      throw new TempsPasseSaisieError(REFUS_CHANGEMENT_LIGNE_TEMPS_PASSE);
    }
    source = { prix: existante.prixUnitaireHt, tva: existante.tauxTva, reference: existante.reference!, catalogueId: existante.catalogueId!, tarif: existante.tarifTempsPasse as TarifTempsPasse };
  } else {
    const fiche = await db.cataloguePrestation.findUnique({
      where: { id: catalogue!.id },
      select: { reference: true, actif: true, estMainOeuvre: true, prixVenteHt: true, prixHeureSousContratHt: true, tauxTva: true },
    });
    if (!fiche || !fiche.actif) throw new TempsPasseSaisieError(REFUS_MAIN_OEUVRE_INACTIVE);
    if (!fiche.estMainOeuvre) throw new TempsPasseSaisieError(REFUS_FICHE_TEMPS_PASSE);
    // Le prix à l'heure hors contrat est le prix de vente de la fiche (choix du lot « main d'œuvre au
    // catalogue ») ; celui sous contrat, son prix à l'heure sous contrat.
    const prix = saisie.tarif === 'SOUS_CONTRAT' ? fiche.prixHeureSousContratHt : fiche.prixVenteHt;
    if (prix === null) throw new TempsPasseSaisieError(REFUS_FICHE_TEMPS_PASSE);
    // Même règle que la TVA d'une ligne saisie : la fiche du catalogue admet aujourd'hui une TVA plus large.
    if (nombreDecimalNonNegatif(fiche.tauxTva.toString(), 3, true) === null || fiche.tauxTva.greaterThan(100)) throw new TempsPasseSaisieError(REFUS_TVA_MAIN_OEUVRE);
    source = { prix, tva: fiche.tauxTva, reference: fiche.reference, catalogueId: catalogue!.id, tarif: saisie.tarif! };
  }
  if (saisie.prixUnitaireHt !== null && !source.prix.equals(saisie.prixUnitaireHt)) {
    throw new TempsPasseSaisieError(`Le prix de la ligne au temps passé est celui de la main d’œuvre, fixé par Iris : ${formatMontantFacture(source.prix)} HT de l’heure (${LIBELLES_TARIF_TEMPS_PASSE[source.tarif]}). Il ne se saisit pas.`);
  }
  if (saisie.tauxTva !== null && !source.tva.equals(saisie.tauxTva)) {
    throw new TempsPasseSaisieError(`La TVA de la ligne au temps passé est celle de la main d’œuvre : ${source.tva.toString().replace('.', ',')} %. Elle ne se saisit pas.`);
  }
  const totalHt = arrondiCommercialLigneHt(ligne.quantite, source.prix.toFixed(2));
  const totalTtc = centimesTtcLigne(totalHt, source.tva.toFixed(2));
  if (totalTtc > PLAFOND_MONTANT) throw new TempsPasseSaisieError('Montant de ligne hors des limites acceptées.');
  return {
    ordre: ligne.ordre, designation: ligne.designation, nature: 'MAIN_OEUVRE', quantite: ligne.quantite,
    prixUnitaireHt: source.prix.toNumber(), tauxTva: source.tva.toNumber(), totalHt, totalTtc, unite: UNITE_MAIN_OEUVRE,
    reference: source.reference, catalogueFamille: 'prestations', catalogueId: source.catalogueId, prixAchatUnitaireHt: null,
    tempsPasse: true, tarifTempsPasse: source.tarif,
  };
}

// Mention du devis au temps passé, à l'écran et sur le PDF, tirée des seules données figées du devis :
// le prix et le tarif de sa ligne au temps passé, et son pas. Rien d'autre n'est dit de la facture, qui
// viendra avec un lot suivant. Null pour un devis ordinaire.
export function mentionTempsPasse(devis: {
  auTempsPasse: boolean; pasTempsPasseMinutes: number | null;
  lignes: { tempsPasse: boolean; tarifTempsPasse: string | null; prixUnitaireHt: unknown }[];
}): string | null {
  if (!devis.auTempsPasse) return null;
  const ligne = devis.lignes.find((l) => l.tempsPasse);
  if (!ligne || devis.pasTempsPasseMinutes === null) return null;
  const tarif = LIBELLES_TARIF_TEMPS_PASSE[ligne.tarifTempsPasse as TarifTempsPasse] ?? '';
  const pas = `${devis.pasTempsPasseMinutes} minute${devis.pasTempsPasseMinutes > 1 ? 's' : ''}`;
  return `Devis au temps passé : une heure minimum facturée au prix de ${formatMontantFacture(ligne.prixUnitaireHt)} HT de l’heure (${tarif}), hors matériel ; au-delà de la première heure, le temps passé se facture par tranches de ${pas}, toute tranche commencée étant due. Le total de ce devis est un minimum.`;
}
