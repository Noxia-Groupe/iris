// Devis au temps passé (décisions de Nelson des 24 et 25-10-2026) : une ligne « main d'œuvre au temps
// passé », reprise d'une main d'œuvre du catalogue au prix à l'heure hors contrat ou sous contrat (jamais
// le forfait jour), comptée dans le total ; le pas du temps passé et, depuis le lot « facture au temps
// passé », le temps minimum facturé sont des réglages de la société, figés sur le devis : la ligne vaut ce
// minimum, puis des multiples du pas (un devis antérieur garde une heure au moins, au millième). Le serveur fixe le prix et refuse tout autre prix : l'écran envoie le
// prix qu'il affiche, si bien que ce qui est enregistré est ce que l'utilisateur a vu.
import type { FicheCatalogueDevis, LigneDevisSaisie } from './catalogueDevis';

export type TarifTempsPasse = 'HORS_CONTRAT' | 'SOUS_CONTRAT';
export const TARIFS_TEMPS_PASSE: readonly TarifTempsPasse[] = ['HORS_CONTRAT', 'SOUS_CONTRAT'];
export const LIBELLES_TARIF: Record<TarifTempsPasse, string> = {
  HORS_CONTRAT: 'À l’heure hors contrat',
  SOUS_CONTRAT: 'À l’heure sous contrat',
};
// Libellés de la mention, identiques à ceux du PDF (server/src/domaines/devis/tempsPasse.ts).
const LIBELLES_TARIF_MENTION: Record<TarifTempsPasse, string> = {
  HORS_CONTRAT: 'tarif à l’heure hors contrat',
  SOUS_CONTRAT: 'tarif à l’heure sous contrat',
};
export const UNITE_TEMPS_PASSE = 'heure';
export const REFUS_QUANTITE = 'La ligne au temps passé compte au moins une heure : sa quantité est de 1 ou plus.';
export const REFUS_QUANTITE_POSITIVE = 'La quantité de la ligne au temps passé, en heures, est positive.';
export const REFUS_SANS_LIGNE = 'Choisissez la main d’œuvre et le tarif de la ligne au temps passé.';

// Montant au centime, comme le PDF : « 45,50 € », « 1 234,50 € ».
export const formatPrix = (montant: number) => `${Number(montant).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

// Prix de l'heure d'une main d'œuvre selon le tarif : son prix de vente à l'heure hors contrat, ou son prix
// à l'heure sous contrat. Null si la fiche n'est pas une main d'œuvre.
export function prixDuTarif(fiche: FicheCatalogueDevis, tarif: TarifTempsPasse): number | null {
  if (!fiche.estMainOeuvre) return null;
  if (tarif === 'SOUS_CONTRAT') return fiche.prixHeureSousContratHt ?? null;
  return fiche.prixVenteHt;
}

// Nouvelle ligne au temps passé, à une heure : changer de main d'œuvre ou de tarif crée une nouvelle ligne.
export function ligneTempsPasse(fiche: FicheCatalogueDevis, tarif: TarifTempsPasse): LigneDevisSaisie | null {
  const prix = prixDuTarif(fiche, tarif);
  if (prix === null) return null;
  return {
    tempsPasse: true, tarifTempsPasse: tarif,
    designation: `Main d’œuvre au temps passé — ${fiche.nom}`,
    nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: prix, tauxTva: fiche.tauxTva, unite: UNITE_TEMPS_PASSE,
    reference: fiche.reference, catalogueFamille: 'prestations', catalogueId: fiche.id,
  };
}

// Pas et minimum figés sur un devis au temps passé : connus pour un devis déjà au temps passé, que l'on
// modifie (minimum vide pour un devis antérieur au lot) ; inconnus (null) pour un nouveau devis, les
// réglages de la société n'étant lus que par l'administration : le serveur contrôle alors la quantité.
export type ReglagesTempsPasse = { tempsMinimumMinutes: number | null; pasTempsPasseMinutes: number | null };

// Durée en minutes, comme le PDF : « 30 min », « 1 h », « 1 h 15 min ».
export function dureeTempsPasse(minutes: number): string {
  const heures = Math.floor(minutes / 60);
  const reste = minutes % 60;
  if (heures === 0) return `${reste} min`;
  return reste === 0 ? `${heures} h` : `${heures} h ${reste} min`;
}

const quantiteFr = (heures: number) => heures.toLocaleString('fr-FR', { maximumFractionDigits: 3 });

// Refus de la quantité de la ligne au temps passé, ou null : la règle du serveur quand les réglages du devis
// sont connus ; sinon une quantité positive, le serveur contrôlant le reste.
export function refusQuantiteTempsPasse(quantite: number, reglages: ReglagesTempsPasse | null): string | null {
  if (!Number.isFinite(quantite) || quantite <= 0) return REFUS_QUANTITE_POSITIVE;
  if (!reglages) return null;
  const { tempsMinimumMinutes: minimum, pasTempsPasseMinutes: pas } = reglages;
  if (minimum === null || pas === null) return quantite >= 1 ? null : REFUS_QUANTITE;
  const minutes = (Math.round(quantite * 1000) * 60) / 1000;
  if (Number.isInteger(minutes) && minutes >= minimum && (minutes - minimum) % pas === 0) return null;
  const exemples = [0, 1, 2].map((rang) => quantiteFr((minimum + rang * pas) / 60)).join(' ; ');
  return `La ligne au temps passé vaut le temps minimum facturé du devis (${dureeTempsPasse(minimum)}), puis des tranches de ${pas} minutes : en heures, ${exemples}…`;
}

// Erreur de saisie du devis au temps passé, avant l'envoi (le serveur refuse les mêmes cas).
export function erreurTempsPasse(auTempsPasse: boolean, lignes: LigneDevisSaisie[], reglages: ReglagesTempsPasse | null = null): string | null {
  const lignesTempsPasse = lignes.filter((ligne) => ligne.tempsPasse);
  if (!auTempsPasse) return null;
  if (lignesTempsPasse.length !== 1) return REFUS_SANS_LIGNE;
  return refusQuantiteTempsPasse(Number(lignesTempsPasse[0].quantite), reglages);
}

// Heures minimum de la mention, comme le PDF : la quantité de la ligne au temps passé, une heure au moins,
// que l'on peut porter vers le haut ; au singulier en dessous de deux heures.
export function heuresMinimum(quantite: number): string {
  const heures = Number(quantite);
  if (heures === 1) return 'une heure minimum facturée';
  const pluriel = heures >= 2 ? 's' : '';
  return `${heures.toLocaleString('fr-FR', { maximumFractionDigits: 3 })} heure${pluriel} minimum facturée${pluriel}`;
}

// Mention du devis au temps passé, tirée de ses seules données figées : la quantité, le prix et le tarif de
// sa ligne au temps passé, son pas et son minimum. Le même texte que le PDF (un devis antérieur au lot
// « facture au temps passé », sans minimum, garde le texte d'alors).
export function mentionTempsPasse(devis: { auTempsPasse?: boolean; pasTempsPasseMinutes?: number | null; tempsMinimumMinutes?: number | null; lignes: { tempsPasse?: boolean; tarifTempsPasse?: TarifTempsPasse | null; prixUnitaireHt: number; quantite: number }[] }): string | null {
  if (!devis.auTempsPasse || devis.pasTempsPasseMinutes == null) return null;
  const ligne = devis.lignes.find((l) => l.tempsPasse);
  if (!ligne || !ligne.tarifTempsPasse) return null;
  const prix = formatPrix(ligne.prixUnitaireHt);
  const tarif = LIBELLES_TARIF_MENTION[ligne.tarifTempsPasse];
  const minimum = devis.tempsMinimumMinutes ?? null;
  if (minimum === null) {
    const pas = `${devis.pasTempsPasseMinutes} minute${devis.pasTempsPasseMinutes > 1 ? 's' : ''}`;
    return `Devis au temps passé : ${heuresMinimum(ligne.quantite)} au prix de ${prix} HT de l’heure (${tarif}), hors matériel ; au-delà de la première heure, le temps passé se facture par tranches de ${pas}, toute tranche commencée étant due. Le total de ce devis est un minimum.`;
  }
  const regle = `Devis au temps passé : au prix de ${prix} HT de l’heure (${tarif}), hors matériel, le temps passé se facture avec un minimum de ${dureeTempsPasse(minimum)}, puis par tranches de ${devis.pasTempsPasseMinutes} minutes au-delà, toute tranche commencée étant due.`;
  const minutesLigne = Math.round(Number(ligne.quantite) * 60);
  if (minutesLigne <= minimum) return `${regle} Le total de ce devis est un minimum.`;
  return `${regle} Ce devis prévoit ${dureeTempsPasse(minutesLigne)} : son total est une estimation, la facture reprenant le temps réellement passé, avec au moins le minimum.`;
}
