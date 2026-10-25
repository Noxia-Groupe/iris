// Devis au temps passé (décisions de Nelson des 24 et 25-10-2026) : une ligne « main d'œuvre au temps
// passé », reprise d'une main d'œuvre du catalogue au prix à l'heure hors contrat ou sous contrat (jamais
// le forfait jour), une heure au moins, comptée dans le total ; le pas du temps passé est un réglage de
// la société, figé sur le devis. Le serveur fixe le prix et refuse tout autre prix : l'écran envoie le
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

// Une heure au moins ; au-delà, la quantité suit la règle des autres lignes (au millième, vérifiée par le
// serveur ; choix par défaut, à confirmer).
export const quantiteTempsPasseValide = (quantite: number) => Number.isFinite(quantite) && quantite >= 1;

// Erreur de saisie du devis au temps passé, avant l'envoi (le serveur refuse les mêmes cas).
export function erreurTempsPasse(auTempsPasse: boolean, lignes: LigneDevisSaisie[]): string | null {
  const lignesTempsPasse = lignes.filter((ligne) => ligne.tempsPasse);
  if (!auTempsPasse) return null;
  if (lignesTempsPasse.length !== 1) return REFUS_SANS_LIGNE;
  if (!quantiteTempsPasseValide(Number(lignesTempsPasse[0].quantite))) return REFUS_QUANTITE;
  return null;
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
// sa ligne au temps passé, et son pas. Le même texte que le PDF.
export function mentionTempsPasse(devis: { auTempsPasse?: boolean; pasTempsPasseMinutes?: number | null; lignes: { tempsPasse?: boolean; tarifTempsPasse?: TarifTempsPasse | null; prixUnitaireHt: number; quantite: number }[] }): string | null {
  if (!devis.auTempsPasse || devis.pasTempsPasseMinutes == null) return null;
  const ligne = devis.lignes.find((l) => l.tempsPasse);
  if (!ligne || !ligne.tarifTempsPasse) return null;
  const pas = `${devis.pasTempsPasseMinutes} minute${devis.pasTempsPasseMinutes > 1 ? 's' : ''}`;
  return `Devis au temps passé : ${heuresMinimum(ligne.quantite)} au prix de ${formatPrix(ligne.prixUnitaireHt)} HT de l’heure (${LIBELLES_TARIF_MENTION[ligne.tarifTempsPasse]}), hors matériel ; au-delà de la première heure, le temps passé se facture par tranches de ${pas}, toute tranche commencée étant due. Le total de ce devis est un minimum.`;
}
