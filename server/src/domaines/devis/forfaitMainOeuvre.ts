import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { PLAFOND_MONTANT, arrondiCommercialLigneHt, centimesTtcLigne } from '../../commun/montants';
import { nombreDecimalNonNegatif } from '../../commun/validation';
import { estTauxTvaFrancais } from '../../commun/tva';
import { formatMontantFacture } from '../factures/metier';
import { REFUS_MAIN_OEUVRE_INACTIVE, REFUS_TVA_MAIN_OEUVRE } from './tempsPasse';

// --- Ligne de main d'œuvre au jour ou à la demi-journée (lot « budget et heures prévues du chantier »,
// troisième PR) ---
// Décisions de Nelson du 30-10-2026 (matin) :
//  - « Option de la main d'œuvre (Recommandé) » : « Nouvelle ligne de main d'œuvre du catalogue « au jour »
//    ou « à la demi-journée », hors contrat ou sous contrat : prix fixé par Iris depuis la fiche (forfait
//    jour), quantité en jours ou demi-journées. » ;
//  - « Prix à part » : « Deux nouveaux champs sur la fiche de main d'œuvre : prix de la demi-journée hors
//    contrat et sous contrat. ».
// Point 16 de la nuit du 26 au 27-10-2026 : « Un forfait compte pour un forfait donc d’une journee ou d’une
// demi journée » ; « Heures par jour de la MO » : une unité de la ligne compte les heures par jour de sa main
// d'œuvre, ou leur moitié, copiées en minutes prévues par unité (DevisLigne.minutesPrevuesUnite).
//
// Sur le modèle de la ligne au temps passé (./tempsPasse.ts) : le prix est fixé par le serveur depuis la
// fiche, à l'ajout, puis figé ; un prix ou une TVA envoyés et différents des siens sont refusés (400), pour
// que personne ne croie avoir imposé un prix. Choix par défaut, à confirmer (passation, section 4) : pas de
// prix d'achat prévu sur la ligne (une main d'œuvre n'en a pas) ; pas de ligne au forfait sur un devis au
// temps passé ; une main d'œuvre sans prix de la demi-journée ne se vend pas à la demi-journée ; la quantité
// est un nombre entier de jours ou de demi-journées, au moins 1 (le plus restrictif) : lecture de « Prix à
// part » (une demi-journée a son prix, et non la moitié du forfait jour) et de « Un forfait compte pour un
// forfait ». Une ligne au jour de 0,5 vendrait une demi-journée à la moitié du prix du jour.

export type ForfaitMainOeuvre = 'JOUR' | 'DEMI_JOURNEE';
export type TarifForfait = 'HORS_CONTRAT' | 'SOUS_CONTRAT';
export const FORFAITS_MAIN_OEUVRE: readonly ForfaitMainOeuvre[] = ['JOUR', 'DEMI_JOURNEE'];
export const TARIFS_FORFAIT: readonly TarifForfait[] = ['HORS_CONTRAT', 'SOUS_CONTRAT'];
// Unité de la ligne, copiée et figée, comme celle d'une ligne du catalogue ; le PDF l'imprime après la quantité.
export const UNITES_FORFAIT: Record<ForfaitMainOeuvre, string> = { JOUR: 'jour', DEMI_JOURNEE: 'demi-journée' };
// Minutes prévues pour une unité, par heure de la journée de la main d'œuvre : la journée entière, ou sa moitié.
const MINUTES_PAR_HEURE_DU_JOUR: Record<ForfaitMainOeuvre, number> = { JOUR: 60, DEMI_JOURNEE: 30 };
const LIBELLES_PRIX: Record<ForfaitMainOeuvre, Record<TarifForfait, string>> = {
  JOUR: { HORS_CONTRAT: 'forfait jour hors contrat', SOUS_CONTRAT: 'forfait jour sous contrat' },
  DEMI_JOURNEE: { HORS_CONTRAT: 'demi-journée hors contrat', SOUS_CONTRAT: 'demi-journée sous contrat' },
};
const PAR_UNITE: Record<ForfaitMainOeuvre, string> = { JOUR: 'par jour', DEMI_JOURNEE: 'par demi-journée' };

export const REFUS_FORFAIT = 'Forfait de la ligne de main d’œuvre : au jour (JOUR) ou à la demi-journée (DEMI_JOURNEE).';
export const REFUS_TARIF_FORFAIT = 'Tarif de la ligne au jour ou à la demi-journée : hors contrat (HORS_CONTRAT) ou sous contrat (SOUS_CONTRAT).';
export const REFUS_FICHE_FORFAIT = 'Une ligne au jour ou à la demi-journée reprend une main d’œuvre du catalogue (prestation marquée main d’œuvre).';
export const REFUS_NATURE_FORFAIT = 'Une ligne au jour ou à la demi-journée est de la main-d’œuvre.';
export const REFUS_PRIX_ACHAT_FORFAIT = 'Une ligne au jour ou à la demi-journée n’a pas de prix d’achat prévu : une main d’œuvre n’en a pas, son coût est celui des heures des intervenants.';
export const REFUS_QUANTITE_FORFAIT = 'La quantité d’une ligne au jour ou à la demi-journée est un nombre entier de jours ou de demi-journées, au moins 1 : pour une demi-journée, ajoutez une ligne à la demi-journée.';
export const REFUS_CHANGEMENT_FORFAIT = 'La ligne au jour ou à la demi-journée garde sa main d’œuvre, son forfait, son tarif et son prix : pour en changer, retirez-la et ajoutez-en une nouvelle.';
export const REFUS_NATURE_LIGNE_FORFAIT = 'Une ligne existante garde sa nature : une ligne ordinaire ne devient pas une ligne au jour ou à la demi-journée, ni l’inverse. Retirez-la et ajoutez-en une nouvelle.';
export const REFUS_FORFAIT_TEMPS_PASSE = 'Un devis au temps passé ne porte pas de ligne au jour ou à la demi-journée : sa main d’œuvre est la ligne au temps passé.';
export const REFUS_LIGNE_FORFAIT_TEMPS_PASSE = 'Une ligne au temps passé n’est pas au jour ou à la demi-journée.';
export const refusUniteForfait = (forfait: ForfaitMainOeuvre) => `L’unité de la ligne ${forfait === 'JOUR' ? 'au jour' : 'à la demi-journée'} est « ${UNITES_FORFAIT[forfait]} ».`;
export const refusSansPrixDemiJournee = (tarif: TarifForfait) => `Cette main d’œuvre n’a pas de prix de la demi-journée ${tarif === 'HORS_CONTRAT' ? 'hors contrat' : 'sous contrat'} : elle ne se vend pas à la demi-journée tant que l’administration ne l’a pas saisi (Catalogue > Main d’œuvre).`;

// Refus de saisie (400) ; les routes du devis le traitent comme une erreur de saisie du devis.
export class ForfaitSaisieError extends Error {}

const renseigne = (valeur: unknown) => valeur !== undefined && valeur !== null && !(typeof valeur === 'string' && valeur.trim() === '');

// Ce que la saisie d'une ligne au forfait demande : le forfait (qui la désigne comme telle), le tarif (absent
// pour une ligne existante, qui garde le sien) et, pour comparaison seulement, le prix et la TVA envoyés.
export type SaisieForfait = { forfait: ForfaitMainOeuvre; tarif: TarifForfait | null; prixUnitaireHt: number | null; tauxTva: number | null };

// La ligne porte-t-elle un forfait ? Toute valeur renseignée la désigne comme telle, puis est contrôlée.
export const estLigneForfait = (item: Record<string, unknown>) => renseigne(item.forfaitMainOeuvre);

// Lit une ligne au forfait (`forfaitMainOeuvre` renseigné). La fiche du catalogue est lue par l'appelant
// (`catalogue`), qui la valide comme pour toute ligne ; elle est exigée d'une nouvelle ligne.
export function lireLigneForfait(
  item: Record<string, unknown>, ligneId: string | null, catalogue: { famille: string; id: string } | null,
): { quantite: number; saisie: SaisieForfait } {
  if (item.tempsPasse !== undefined && item.tempsPasse !== null && item.tempsPasse !== false) throw new ForfaitSaisieError(REFUS_LIGNE_FORFAIT_TEMPS_PASSE);
  if (!(FORFAITS_MAIN_OEUVRE as readonly unknown[]).includes(item.forfaitMainOeuvre)) throw new ForfaitSaisieError(REFUS_FORFAIT);
  const forfait = item.forfaitMainOeuvre as ForfaitMainOeuvre;
  let tarif: TarifForfait | null = null;
  if (renseigne(item.tarifForfait)) {
    if (!(TARIFS_FORFAIT as readonly unknown[]).includes(item.tarifForfait)) throw new ForfaitSaisieError(REFUS_TARIF_FORFAIT);
    tarif = item.tarifForfait as TarifForfait;
  } else if (!ligneId) throw new ForfaitSaisieError(REFUS_TARIF_FORFAIT);
  if (catalogue ? catalogue.famille !== 'prestations' : !ligneId) throw new ForfaitSaisieError(REFUS_FICHE_FORFAIT);
  // Un nombre entier, au moins 1 (« 2 » ou « 2.000 ») : un forfait compte pour un forfait, et la demi-journée
  // a son prix à part. La base le vérifie aussi (DevisLigne_forfait_main_oeuvre_check).
  const quantite = nombreDecimalNonNegatif(item.quantite, 9, false, 3);
  if (quantite === null || !Number.isInteger(quantite) || quantite < 1) throw new ForfaitSaisieError(REFUS_QUANTITE_FORFAIT);
  if (renseigne(item.nature) && item.nature !== 'MAIN_OEUVRE') throw new ForfaitSaisieError(REFUS_NATURE_FORFAIT);
  if (renseigne(item.unite) && String(item.unite).trim() !== UNITES_FORFAIT[forfait]) throw new ForfaitSaisieError(refusUniteForfait(forfait));
  const prixUnitaireHt = renseigne(item.prixUnitaireHt) ? nombreDecimalNonNegatif(item.prixUnitaireHt, 10, true) : null;
  if (renseigne(item.prixUnitaireHt) && prixUnitaireHt === null) throw new ForfaitSaisieError('Ligne de devis invalide.');
  const tauxTva = renseigne(item.tauxTva) ? nombreDecimalNonNegatif(item.tauxTva, 3, true) : null;
  if (renseigne(item.tauxTva) && (tauxTva === null || tauxTva > 100)) throw new ForfaitSaisieError('Ligne de devis invalide.');
  return { quantite, saisie: { forfait, tarif, prixUnitaireHt, tauxTva } };
}

// Pas de ligne au forfait sur un devis au temps passé (choix par défaut, le plus restrictif, à confirmer).
export function exigerForfaitHorsTempsPasse(auTempsPasse: boolean, references: { forfait?: SaisieForfait }[]) {
  if (auTempsPasse && references.some((reference) => reference.forfait)) throw new ForfaitSaisieError(REFUS_FORFAIT_TEMPS_PASSE);
}

type LigneForfaitExistante = {
  catalogueId: string | null; reference: string | null; forfaitMainOeuvre: string | null; tarifForfait: string | null;
  prixUnitaireHt: Prisma.Decimal; tauxTva: Prisma.Decimal; minutesPrevuesUnite: Prisma.Decimal | null;
};

// Résout la ligne au forfait : prix, TVA, référence et minutes prévues de la main d'œuvre au moment où la
// ligne est ajoutée, figés ensuite. Une ligne existante (`existante`) garde les siens, même si la main
// d'œuvre a changé de prix ou d'heures par jour, ou a été désactivée depuis ; changer de forfait, de tarif ou
// de fiche est refusé. Une nouvelle ligne exige une main d'œuvre active ; son prix est le forfait jour, ou
// le prix de la demi-journée, du tarif choisi. La fiche est lue par `db`, dans la transaction de l'appelant.
export async function resoudreLigneForfait(
  db: Prisma.TransactionClient | typeof prisma,
  ligne: { ordre: number; designation: string; quantite: number },
  saisie: SaisieForfait,
  catalogue: { famille: string; id: string } | null,
  existante: LigneForfaitExistante | null,
) {
  let source: { prix: Prisma.Decimal; tva: Prisma.Decimal; reference: string; catalogueId: string; tarif: TarifForfait; minutes: Prisma.Decimal };
  if (existante) {
    if (saisie.forfait !== existante.forfaitMainOeuvre || (saisie.tarif !== null && saisie.tarif !== existante.tarifForfait) || (catalogue && catalogue.id !== existante.catalogueId)) {
      throw new ForfaitSaisieError(REFUS_CHANGEMENT_FORFAIT);
    }
    source = {
      prix: existante.prixUnitaireHt, tva: existante.tauxTva, reference: existante.reference!, catalogueId: existante.catalogueId!,
      tarif: existante.tarifForfait as TarifForfait, minutes: existante.minutesPrevuesUnite!,
    };
  } else {
    const fiche = await db.cataloguePrestation.findUnique({
      where: { id: catalogue!.id },
      select: {
        reference: true, actif: true, estMainOeuvre: true, tauxTva: true, heuresParJour: true,
        prixJourHorsContratHt: true, prixJourSousContratHt: true, prixDemiJourneeHorsContratHt: true, prixDemiJourneeSousContratHt: true,
      },
    });
    if (!fiche || !fiche.actif) throw new ForfaitSaisieError(REFUS_MAIN_OEUVRE_INACTIVE);
    if (!fiche.estMainOeuvre || fiche.heuresParJour === null) throw new ForfaitSaisieError(REFUS_FICHE_FORFAIT);
    const tarif = saisie.tarif!;
    const prix = saisie.forfait === 'JOUR'
      ? (tarif === 'SOUS_CONTRAT' ? fiche.prixJourSousContratHt : fiche.prixJourHorsContratHt)
      : (tarif === 'SOUS_CONTRAT' ? fiche.prixDemiJourneeSousContratHt : fiche.prixDemiJourneeHorsContratHt);
    if (prix === null) throw new ForfaitSaisieError(saisie.forfait === 'DEMI_JOURNEE' ? refusSansPrixDemiJournee(tarif) : REFUS_FICHE_FORFAIT);
    // Même règle que la TVA d'une ligne saisie (commun/tva.ts) : une fiche enregistrée avant le lot « TVA
    // française » peut porter un autre taux.
    if (!estTauxTvaFrancais(fiche.tauxTva)) throw new ForfaitSaisieError(REFUS_TVA_MAIN_OEUVRE);
    // Heures par jour au quart d'heure (contrainte de la fiche) : 15 minutes × n pour un jour, 7,5 minutes × n
    // pour une demi-journée, exacts au centième de minute de la colonne.
    const minutes = fiche.heuresParJour.times(MINUTES_PAR_HEURE_DU_JOUR[saisie.forfait]);
    source = { prix, tva: fiche.tauxTva, reference: fiche.reference, catalogueId: catalogue!.id, tarif, minutes };
  }
  if (saisie.prixUnitaireHt !== null && !source.prix.equals(saisie.prixUnitaireHt)) {
    throw new ForfaitSaisieError(`Le prix de la ligne ${saisie.forfait === 'JOUR' ? 'au jour' : 'à la demi-journée'} est celui de la main d’œuvre, fixé par Iris : ${formatMontantFacture(source.prix)} HT ${PAR_UNITE[saisie.forfait]} (${LIBELLES_PRIX[saisie.forfait][source.tarif]}). Il ne se saisit pas.`);
  }
  if (saisie.tauxTva !== null && !source.tva.equals(saisie.tauxTva)) {
    throw new ForfaitSaisieError(`La TVA de la ligne ${saisie.forfait === 'JOUR' ? 'au jour' : 'à la demi-journée'} est celle de la main d’œuvre : ${source.tva.toString().replace('.', ',')} %. Elle ne se saisit pas.`);
  }
  const totalHt = arrondiCommercialLigneHt(ligne.quantite, source.prix.toFixed(2));
  const totalTtc = centimesTtcLigne(totalHt, source.tva.toFixed(2));
  if (totalTtc > PLAFOND_MONTANT) throw new ForfaitSaisieError('Montant de ligne hors des limites acceptées.');
  return {
    ordre: ligne.ordre, designation: ligne.designation, nature: 'MAIN_OEUVRE', quantite: ligne.quantite,
    prixUnitaireHt: source.prix.toNumber(), tauxTva: source.tva.toNumber(), totalHt, totalTtc, unite: UNITES_FORFAIT[saisie.forfait],
    reference: source.reference, catalogueFamille: 'prestations', catalogueId: source.catalogueId, prixAchatUnitaireHt: null,
    tempsPasse: false, tarifTempsPasse: null, minutesPrevuesUnite: source.minutes, forfaitMainOeuvre: saisie.forfait, tarifForfait: source.tarif,
  };
}
