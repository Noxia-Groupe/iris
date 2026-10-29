import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { PLAFOND_MONTANT, arrondiCommercialLigneHt, centimesTtcLigne } from '../../commun/montants';
import { nombreDecimalNonNegatif } from '../../commun/validation';
import { estTauxTvaFrancais } from '../../commun/tva';
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
// prix.
//
// Lot « facture au temps passé », première PR (décisions de Nelson de la nuit du 26 au 27-10-2026,
// points 8, 9, 11 et 12) : le temps minimum facturé devient un réglage de la société, en minutes, par
// multiples de 15, de 15 minutes à 8 heures (une heure à l'installation, et quand on le vide) ; le pas
// n'admet plus que 15, 30, 45 ou 60 minutes. Un nouveau devis au temps passé fige le minimum avec le pas,
// et sa ligne au temps passé vaut ce minimum, puis des multiples du pas. Un devis fait avant ce lot
// (minimum vide) garde la règle d'alors : une heure au moins, au millième, son pas figé, et sa mention.

export type TarifTempsPasse = 'HORS_CONTRAT' | 'SOUS_CONTRAT';
export const TARIFS_TEMPS_PASSE: readonly TarifTempsPasse[] = ['HORS_CONTRAT', 'SOUS_CONTRAT'];
export const LIBELLES_TARIF_TEMPS_PASSE: Record<TarifTempsPasse, string> = {
  HORS_CONTRAT: 'tarif à l’heure hors contrat',
  SOUS_CONTRAT: 'tarif à l’heure sous contrat',
};

export const REFUS_PAS_NON_REGLE = 'Réglez d’abord le pas du temps passé dans l’administration (Administration > Marges & Commissions) : un devis au temps passé est refusé tant qu’il n’est pas fixé.';
export const PAS_TEMPS_PASSE_ADMIS: readonly number[] = [15, 30, 45, 60];
export const TEMPS_MINIMUM_PAR_DEFAUT = 60;
export const refusPasAncien = (pas: number) => `Le pas du temps passé réglé (${pas} minute${pas > 1 ? 's' : ''}) n’est plus admis : réglez-le de nouveau dans l’administration (Administration > Marges & Commissions), à 15, 30, 45 ou 60 minutes.`;
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
export const REFUS_TVA_MAIN_OEUVRE = 'TVA de la main d’œuvre non acceptée pour un devis (0 %, 5,5 %, 10 % ou 20 %) : corrigez la fiche du catalogue.';
export const REFUS_TVA_LIGNE_TEMPS_PASSE = 'La ligne au temps passé porte une TVA non acceptée (0 %, 5,5 %, 10 % ou 20 %) : retirez-la, puis ajoutez-la de nouveau depuis une main d’œuvre à l’un de ces taux.';

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
  // Le minimum et le pas du devis, connus plus tard, bornent ensuite la quantité (exigerQuantiteTempsPasse).
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

export type ReglagesTempsPasseDevis = { pasTempsPasseMinutes: number | null; tempsMinimumMinutes: number | null };

// Pas et minimum figés sur le devis : ceux déjà figés sur un devis au temps passé (un devis antérieur au
// lot garde son minimum vide, donc la règle d'alors), sinon les réglages de la société, le pas étant
// refusé s'il est vide (décision « Aucune, à régler ») ou s'il n'est plus admis (valeur réglée avant le
// lot) ; ni pas ni minimum sur un devis ordinaire.
export async function reglagesTempsPasseDuDevis(
  db: Prisma.TransactionClient | typeof prisma, auTempsPasse: boolean,
  precedent?: { auTempsPasse: boolean; pasTempsPasseMinutes: number | null; tempsMinimumMinutes: number | null },
): Promise<ReglagesTempsPasseDevis> {
  if (!auTempsPasse) return { pasTempsPasseMinutes: null, tempsMinimumMinutes: null };
  if (precedent?.auTempsPasse && precedent.pasTempsPasseMinutes !== null) {
    return { pasTempsPasseMinutes: precedent.pasTempsPasseMinutes, tempsMinimumMinutes: precedent.tempsMinimumMinutes };
  }
  const reglage = await db.parametres.findUnique({ where: { id: 'singleton' }, select: { pasTempsPasseMinutes: true, tempsMinimumMinutes: true } });
  return reglagesTempsPasseDeLaSociete(reglage);
}

// Les réglages du jour, pour un devis qui les fige (création, passage au temps passé, duplication).
export function reglagesTempsPasseDeLaSociete(reglage: { pasTempsPasseMinutes: number | null; tempsMinimumMinutes: number } | null): ReglagesTempsPasseDevis {
  if (!reglage || reglage.pasTempsPasseMinutes === null) throw new TempsPasseConflitError(REFUS_PAS_NON_REGLE);
  if (!PAS_TEMPS_PASSE_ADMIS.includes(reglage.pasTempsPasseMinutes)) throw new TempsPasseConflitError(refusPasAncien(reglage.pasTempsPasseMinutes));
  return { pasTempsPasseMinutes: reglage.pasTempsPasseMinutes, tempsMinimumMinutes: reglage.tempsMinimumMinutes };
}

const minutesSaisies = (brut: unknown) => typeof brut === 'number' ? brut : typeof brut === 'string' && /^\d+$/.test(brut.trim()) ? Number(brut.trim()) : NaN;

// Lecture du pas dans le corps de PUT /api/parametres : vide (null ou chaîne vide) pour le retirer, ce
// qui rend null, sinon 15, 30, 45 ou 60 minutes (décision de la nuit du 26 au 27-10-2026, point 8).
export function lireReglagePasTempsPasse(brut: unknown): number | null {
  if (brut === null || brut === '') return null;
  const minutes = minutesSaisies(brut);
  if (!PAS_TEMPS_PASSE_ADMIS.includes(minutes)) {
    throw new TempsPasseSaisieError('Le pas du temps passé est de 15, 30, 45 ou 60 minutes, ou vide pour le retirer (les devis au temps passé sont alors refusés).');
  }
  return minutes;
}

// Lecture du temps minimum facturé dans le corps de PUT /api/parametres : vide (null ou chaîne vide), il
// revient à une heure (décision « Il revient a 1h ») ; sinon un multiple de 15 minutes, de 15 minutes à
// 8 heures (décision « 15 min à 8 h »).
export function lireReglageTempsMinimum(brut: unknown): number {
  if (brut === null || brut === '') return TEMPS_MINIMUM_PAR_DEFAUT;
  const minutes = minutesSaisies(brut);
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 480 || minutes % 15 !== 0) {
    throw new TempsPasseSaisieError('Le temps minimum facturé est un nombre de minutes multiple de 15, de 15 minutes à 8 heures (480 minutes), ou vide pour revenir à une heure.');
  }
  return minutes;
}

// Durée en minutes, à l'écran et sur le PDF : « 30 min », « 1 h », « 1 h 15 min », « 8 h ».
export function dureeTempsPasse(minutes: number): string {
  const heures = Math.floor(minutes / 60);
  const reste = minutes % 60;
  if (heures === 0) return `${reste} min`;
  return reste === 0 ? `${heures} h` : `${heures} h ${reste} min`;
}

const quantiteFr = (heures: number) => heures.toLocaleString('fr-FR', { maximumFractionDigits: 3 });

// Quantité de la ligne au temps passé, selon le devis : une heure au moins, au millième, sur un devis
// antérieur au lot (minimum vide) ; sinon le minimum figé, puis des multiples du pas, en minutes entières
// (décision « 15 min à 8 h, ligne au pas »). La base le vérifie aussi à la validation.
export function exigerQuantiteTempsPasse(quantite: number, reglages: ReglagesTempsPasseDevis) {
  const { tempsMinimumMinutes: minimum, pasTempsPasseMinutes: pas } = reglages;
  if (minimum === null || pas === null) {
    if (quantite < 1) throw new TempsPasseSaisieError(REFUS_QUANTITE_TEMPS_PASSE);
    return;
  }
  const milliemes = Math.round(quantite * 1000);
  const minutes = (milliemes * 60) / 1000;
  if (!Number.isInteger(minutes) || minutes < minimum || (minutes - minimum) % pas !== 0) {
    const exemples = [0, 1, 2].map((rang) => quantiteFr((minimum + rang * pas) / 60)).join(' ; ');
    throw new TempsPasseSaisieError(`La ligne au temps passé vaut le temps minimum facturé du devis (${dureeTempsPasse(minimum)}), puis des tranches de ${pas} minutes : en heures, ${exemples}…`);
  }
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
    // Comme une ligne ordinaire, revalidée à chaque modification du devis (commun/tva.ts) : une ligne
    // ajoutée avant le lot « TVA française » à un autre taux ne se garde pas ; sa TVA ne se saisit pas,
    // la ligne se remplace.
    if (!estTauxTvaFrancais(existante.tauxTva)) throw new TempsPasseSaisieError(REFUS_TVA_LIGNE_TEMPS_PASSE);
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
    // Même règle que la TVA d'une ligne saisie (commun/tva.ts) : une fiche enregistrée avant le lot « TVA
    // française » peut porter un autre taux.
    if (!estTauxTvaFrancais(fiche.tauxTva)) throw new TempsPasseSaisieError(REFUS_TVA_MAIN_OEUVRE);
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

// Heures minimum de la mention : la quantité de la ligne au temps passé, une heure au moins, que l'on peut
// porter vers le haut (décision « Ligne minimum comptée » du 25-10-2026 : « 1 h minimum (modifiable vers le
// haut) […] Le total est donc un minimum ») ; au singulier en dessous de deux heures.
export function heuresMinimumTempsPasse(quantite: unknown): string {
  const heures = Number(quantite);
  if (heures === 1) return 'une heure minimum facturée';
  const pluriel = heures >= 2 ? 's' : '';
  return `${heures.toLocaleString('fr-FR', { maximumFractionDigits: 3 })} heure${pluriel} minimum facturée${pluriel}`;
}

// Mention du devis au temps passé, à l'écran et sur le PDF, tirée des seules données figées du devis :
// la quantité, le prix et le tarif de sa ligne au temps passé, son pas et son minimum. Null pour un devis
// ordinaire.
// Un devis antérieur au lot (minimum vide) garde le texte d'alors. Sinon, la mention annonce le minimum
// figé et le pas au-delà (décision de la nuit du 26 au 27-10-2026, point 11) ; quand la ligne compte plus
// que le minimum, ses heures sont une prévision et le total une estimation (point 10 : la facture reprend
// le temps passé, avec au moins le minimum). Texte : choix par défaut, à confirmer (passation, section 3).
export function mentionTempsPasse(devis: {
  auTempsPasse: boolean; pasTempsPasseMinutes: number | null; tempsMinimumMinutes?: number | null;
  lignes: { tempsPasse: boolean; tarifTempsPasse: string | null; prixUnitaireHt: unknown; quantite: unknown }[];
}): string | null {
  if (!devis.auTempsPasse) return null;
  const ligne = devis.lignes.find((l) => l.tempsPasse);
  if (!ligne || devis.pasTempsPasseMinutes === null) return null;
  const tarif = LIBELLES_TARIF_TEMPS_PASSE[ligne.tarifTempsPasse as TarifTempsPasse] ?? '';
  const prix = formatMontantFacture(ligne.prixUnitaireHt);
  const minimum = devis.tempsMinimumMinutes ?? null;
  if (minimum === null) {
    const pas = `${devis.pasTempsPasseMinutes} minute${devis.pasTempsPasseMinutes > 1 ? 's' : ''}`;
    return `Devis au temps passé : ${heuresMinimumTempsPasse(ligne.quantite)} au prix de ${prix} HT de l’heure (${tarif}), hors matériel ; au-delà de la première heure, le temps passé se facture par tranches de ${pas}, toute tranche commencée étant due. Le total de ce devis est un minimum.`;
  }
  const regle = `Devis au temps passé : au prix de ${prix} HT de l’heure (${tarif}), hors matériel, le temps passé se facture avec un minimum de ${dureeTempsPasse(minimum)}, puis par tranches de ${devis.pasTempsPasseMinutes} minutes au-delà, toute tranche commencée étant due.`;
  const minutesLigne = Math.round(Number(ligne.quantite) * 60);
  if (minutesLigne <= minimum) return `${regle} Le total de ce devis est un minimum.`;
  return `${regle} Ce devis prévoit ${dureeTempsPasse(minutesLigne)} : son total est une estimation, la facture reprenant le temps réellement passé, avec au moins le minimum.`;
}
