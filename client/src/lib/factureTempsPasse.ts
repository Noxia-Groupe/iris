// Facture au temps passé d'une intervention (lot « facture au temps passé », seconde PR ; décisions de Nelson
// de la nuit du 26 au 27-10-2026, points 3 et 8 à 12, et du 28-10-2026) : le serveur calcule l'aperçu, que
// l'écran affiche tel quel ; la création renvoie le total HT lu, si bien qu'une heure saisie entre-temps
// refuse la facture au lieu de la changer en silence.
import { dureeTempsPasse } from './tempsPasse';

export type LigneFactureTempsPasse = {
  ordre: number; designation: string; nature: 'PRESTATION' | 'ARTICLE'; quantite: number; prixUnitaireHt: number; tauxTva: number;
  totalHt: number; totalTtc: number; tempsPasse: boolean;
};
export type ApercuFactureTempsPasse = {
  intervention: { id: string; reference: string; titre: string; clientId: string; clientRaisonSociale: string };
  devis: { id: string; numero: string; version: number };
  heures: {
    intervention: number;
    // Heures d'une suite annulée : null, elles ne sont pas facturées.
    suites: { id: string; reference: string; statut: string; heures: number | null }[];
    saisies: number; minutesSaisies: number; minimumFige: boolean; plancherMinutes: number; pasMinutes: number;
    minutesFacturees: number; facturees: number;
  };
  lignes: LigneFactureTempsPasse[];
  ventilationTva: { tauxTva: number; totalHt: number; totalTva: number; totalTtc: number }[];
  totalHt: number; totalTva: number; totalTtc: number;
};

export const heuresFr = (heures: number) => `${heures.toLocaleString('fr-FR', { maximumFractionDigits: 3 })} h`;
// Une durée en minutes entières s'écrit comme sur le devis (« 1 h 15 min ») ; sinon, en heures au millième
// (plancher d'un devis antérieur dont la ligne est au millième).
export const dureeFacture = (minutes: number) => Number.isInteger(minutes) ? dureeTempsPasse(minutes) : heuresFr(minutes / 60);

// Règle appliquée, en une phrase.
export function regleFactureTempsPasse(heures: ApercuFactureTempsPasse['heures']): string {
  const plancher = dureeFacture(heures.plancherMinutes);
  return heures.minimumFige
    ? `Minimum facturé ${plancher}, puis tranches de ${heures.pasMinutes} min au-delà, toute tranche commencée étant due.`
    : `Devis antérieur au temps minimum : ${plancher} au moins, les heures de sa ligne, puis tranches de ${heures.pasMinutes} min au-delà, toute tranche commencée étant due.`;
}

// Heures comptées, intervention et suites : une suite annulée est citée, sans ses heures.
export function heuresComptees(apercu: ApercuFactureTempsPasse): string[] {
  return [
    `${apercu.intervention.reference} (intervention) : ${heuresFr(apercu.heures.intervention)}`,
    ...apercu.heures.suites.map((suite) => suite.heures === null ? `${suite.reference} (suite annulée) : non facturée` : `${suite.reference} (suite) : ${heuresFr(suite.heures)}`),
  ];
}

export const corpsFactureTempsPasse = (dates: { dateEmission: string; dateEcheance: string }, apercu: ApercuFactureTempsPasse) => ({
  ...dates, totalHtAttendu: apercu.totalHt,
});
