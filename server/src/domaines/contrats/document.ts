import { dateFrancaise } from '../../commun/dates';
import { formaterAdresseFacturation } from '../factures/metier';
import { ouvrirDocumentPdf, type IdentiteImprimee } from '../documents/gabarit';

// PDF du contrat de maintenance (lot 6a-4b), sur le modèle commun du lot 6a-1 : un récapitulatif du
// contrat tel qu'Iris l'enregistre, avec l'identité actuelle de la société (aucune n'est copiée sur un
// contrat). Un contrat ne porte aucun montant : le document n'imprime ni prix, ni signature, ni
// conditions générales, ni le motif d'une annulation. Les dates d'un contrat (début, échéances) sont
// des dates seules, jours civils de la société stockés à minuit UTC : elles s'impriment telles
// qu'elles sont enregistrées, comme à l'écran, sans être relues dans un fuseau qui les décalerait.
type SiteImprime = { nom: string; adresse: string; complementAdresse: string | null; codePostal: string; ville: string; pays: string };

export type ContratImprime = {
  titre: string; statut: string; periodiciteMois: number; dureePrevisionnelleMinutes: number;
  dateDebut: Date; prochaineEcheance: Date;
  politiqueMainOeuvre: string; politiqueMateriel: string; noteCouverture: string | null;
  client: { raisonSociale: string };
  // Site concerné par le contrat, s'il est précisé, et site retenu pour l'adresse de facturation,
  // dans l'ordre de la facture (SITE_FACTURATION_ORDRE).
  site: SiteImprime | null;
  siteFacturation: SiteImprime | null;
  devisOrigine: { numero: string; version: number } | null;
  // Visites : interventions du contrat qui portent une échéance. Les suites, qui portent le contrat
  // sans échéance, n'en sont pas.
  visites: { echeanceContrat: Date; statut: string }[];
};

const STATUT_CONTRAT: Record<string, string> = { ACTIF: 'actif', SUSPENDU: 'suspendu', TERMINE: 'terminé', ANNULE: 'annulé' };
const STATUT_VISITE: Record<string, string> = { A_PLANIFIER: 'à planifier', PLANIFIEE: 'planifiée', EN_COURS: 'en cours', TERMINEE: 'terminée', ANNULEE: 'annulée' };

// Durée prévisionnelle d'une visite (15 à 1 440 minutes) en heures et minutes : « 45 min », « 2 h »,
// « 1 h 30 min ».
export function dureeEnHeuresMinutes(minutes: number) {
  const heures = Math.floor(minutes / 60);
  const reste = minutes % 60;
  if (!heures) return `${reste} min`;
  return reste ? `${heures} h ${reste} min` : `${heures} h`;
}

// Nom du fichier : l'intitulé réduit aux lettres sans accent, aux chiffres, au tiret et au tiret bas,
// toute autre suite de caractères devenant un tiret, sans tiret en tête ni en fin ; l'identifiant du
// contrat si rien n'en reste. Le même calcul nomme le fichier téléchargé à l'écran
// (client/src/lib/documentPdf.ts).
export function nomFichierContrat(contrat: { id: string; titre: string }) {
  const intitule = contrat.titre.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return `Contrat-${intitule || contrat.id}.pdf`;
}

export async function rendreDocumentContratPdf({ contrat, identite }: { contrat: ContratImprime; identite: IdentiteImprimee }): Promise<Buffer> {
  const document = ouvrirDocumentPdf({ titre: `Contrat de maintenance ${contrat.titre}`, identite });
  const { pdf, ligne, couleur } = document;

  pdf.fillColor(couleur);
  ligne('Contrat de maintenance', { taille: 18 });
  pdf.fillColor('#000000');
  ligne('Récapitulatif du contrat enregistré ; ce document ne porte ni prix ni signature.', { taille: 10 });
  // Comme un devis annulé : imprimé sans le dire, un contrat annulé passerait pour un contrat en cours.
  if (contrat.statut === 'ANNULE') { pdf.fillColor('#b91c1c'); ligne('CONTRAT ANNULÉ', { taille: 12 }); pdf.fillColor('#000000'); }
  pdf.moveDown();
  ligne(`Intitulé : ${contrat.titre}`, { taille: 12 });
  ligne(`Statut : ${STATUT_CONTRAT[contrat.statut] ?? contrat.statut}`, { taille: 10 });

  pdf.moveDown();
  ligne('Client', { taille: 11 });
  ligne(contrat.client.raisonSociale, { taille: 12 });
  if (contrat.site) {
    ligne(`Site : ${contrat.site.nom}`, { taille: 10 });
    const adresse = formaterAdresseFacturation(contrat.site);
    if (adresse) ligne(adresse, { taille: 9 });
  } else {
    ligne('Site : non précisé', { taille: 10 });
  }
  pdf.moveDown(0.5);
  ligne('Adresse de facturation', { taille: 10 });
  const facturation = contrat.siteFacturation ? formaterAdresseFacturation(contrat.siteFacturation) : '';
  ligne(facturation || 'Non renseignée', { taille: 9 });

  pdf.moveDown();
  ligne('Contrat', { taille: 11 });
  ligne(`Date de début : ${dateFrancaise(contrat.dateDebut)}`, { taille: 10 });
  ligne(`Périodicité : tous les ${contrat.periodiciteMois} mois`, { taille: 10 });
  ligne(`Durée prévisionnelle d’une visite : ${dureeEnHeuresMinutes(contrat.dureePrevisionnelleMinutes)}`, { taille: 10 });
  ligne(`Prochaine échéance : ${dateFrancaise(contrat.prochaineEcheance)}`, { taille: 10 });

  pdf.moveDown();
  ligne('Couverture', { taille: 11 });
  ligne(`Main-d’œuvre : ${contrat.politiqueMainOeuvre === 'INCLUSE' ? 'incluse' : 'hors forfait'}`, { taille: 10 });
  ligne(`Matériel : ${contrat.politiqueMateriel === 'INCLUS' ? 'inclus' : 'hors forfait'}`, { taille: 10 });
  if (contrat.noteCouverture) ligne(`Note : ${contrat.noteCouverture}`, { taille: 10 });

  if (contrat.devisOrigine) {
    pdf.moveDown();
    ligne(`Devis d’origine : ${contrat.devisOrigine.numero} version ${contrat.devisOrigine.version}`, { taille: 10 });
  }

  pdf.moveDown();
  ligne('Visites', { taille: 11 });
  if (!contrat.visites.length) ligne('Aucune visite enregistrée.', { taille: 9 });
  for (const visite of contrat.visites) {
    ligne(`Échéance du ${dateFrancaise(visite.echeanceContrat)} : ${STATUT_VISITE[visite.statut] ?? visite.statut}`, { taille: 9 });
  }
  return document.terminer();
}
