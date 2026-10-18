import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { FUSEAU_HORAIRE_PAR_DEFAUT, jourCivilEntreprise, aujourdHuiEntreprise, dateSeuleEnJourCivil } from '../../commun/dates';
import { decimalToNumber, sommeExacte, differenceExacte, produitExact } from '../../commun/montants';
import type { Parametres } from '../parametres/metier';
import { getCompanySettings } from '../administration/metier';
import { chantierSansCoutMainOeuvre, chantierSansMontants } from './droits';

// --- Contexte du suivi des chantiers ---
// Ce que le calcul d'un chantier ne peut pas lire sur le chantier lui-même : le jour civil
// de l'entreprise (délai sans saisie) et deux références société servant à estimer le
// reste à dépenser quand le chantier ne suffit pas à le dire.
interface ContexteSuivi {
  aujourdhui: string;
  fuseauHoraire: string;
  // Coût horaire moyen réellement appliqué, pondéré par les heures, sur tous les pointages
  // actifs des affaires non annulées. Sert seulement aux chantiers sans aucune heure.
  coutHoraireSociete: number | null;
  // Achats / matériel vendu sur les chantiers terminés : ce que coûte en moyenne, à
  // l'achat, un euro de matériel vendu. Null tant qu'aucun chantier n'est terminé.
  ratioMaterielHistorique: number | null;
}

export async function contexteSuivi(avecEstimation: boolean): Promise<ContexteSuivi> {
  const societe = await getCompanySettings();
  const fuseauHoraire = societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT;
  const contexte: ContexteSuivi = { aujourdhui: aujourdHuiEntreprise(fuseauHoraire), fuseauHoraire, coutHoraireSociete: null, ratioMaterielHistorique: null };
  if (!avecEstimation) return contexte;
  const [cout] = await prisma.$queryRaw<{ valeur: Prisma.Decimal | null }[]>(Prisma.sql`
    SELECT SUM(p."nbrHeures" * p."tauxHoraireApplique") / NULLIF(SUM(p."nbrHeures"), 0) AS valeur
    FROM "PointageHeure" p JOIN "Chantier" c ON c."id" = p."chantierId"
    WHERE p."archivedAt" IS NULL AND c."statut" <> 'ANNULE'`);
  const [ratio] = await prisma.$queryRaw<{ valeur: Prisma.Decimal | null }[]>(Prisma.sql`
    SELECT (
      SELECT COALESCE(SUM(a."montantHT"), 0) FROM "AchatReel" a JOIN "Chantier" c ON c."id" = a."chantierId"
      WHERE a."archivedAt" IS NULL AND c."statut" = 'TERMINE' AND c."budgetMaterielVendu" > 0
    ) / NULLIF((
      SELECT SUM("budgetMaterielVendu") FROM "Chantier" WHERE "statut" = 'TERMINE' AND "budgetMaterielVendu" > 0
    ), 0) AS valeur`);
  contexte.coutHoraireSociete = cout?.valeur == null ? null : Number(cout.valeur);
  contexte.ratioMaterielHistorique = ratio?.valeur == null ? null : Number(ratio.valeur);
  return contexte;
}

// Le début d'un chantier converti avant #130 est un instant (lu dans le fuseau de l'entreprise) ;
// depuis, la conversion pose une date-seule, comme une date corrigée à la main : stockée à minuit
// UTC et lue telle quelle.
export function jourCivilDeDebut(dateDebut: Date | string, fuseauHoraire: string): string {
  const iso = new Date(dateDebut).toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : jourCivilEntreprise(new Date(dateDebut), fuseauHoraire);
}

function joursEntre(debut: string, fin: string): number {
  return Math.round((Date.parse(`${fin}T00:00:00Z`) - Date.parse(`${debut}T00:00:00Z`)) / 86_400_000);
}

// --- Calcul centralisé des métriques d'un chantier (source unique de vérité) ---
// La marge commerciale n'est calculée que si elle est activée ET pour les destinataires
// de la rentabilité de ce chantier (cf. voitRentabilite), sur la liste, le tableau de bord
// et la fiche.
export function computeChantierMetrics(chantier: any, params: Parametres, canSeeMarge: boolean, contexte?: ContexteSuivi) {
  // Défense en profondeur : une archive ne doit jamais déformer un coût, une marge ou une commission.
  const achats: any[] = (chantier.achats || []).filter((a: any) => !a.archivedAt);
  const pointages: any[] = (chantier.pointages || []).filter((p: any) => !p.archivedAt);

  // Sommes exactes, indépendantes de l'ordre des lignes (#198) : les alertes de
  // dépassement ci-dessous comparent ces totaux au vendu, au centime près.
  const materielReel = achats.reduce((s: number, a: any) => sommeExacte(s, a.montantHT), 0);
  let heuresRealisees = 0;
  let moReel = 0;
  for (const p of pointages) {
    heuresRealisees = sommeExacte(heuresRealisees, p.nbrHeures);
    moReel = sommeExacte(moReel, produitExact(p.nbrHeures, p.tauxHoraireApplique));
  }
  const totalDepenses = sommeExacte(materielReel, moReel);
  const diffHeures = differenceExacte(chantier.heuresVendues, heuresRealisees);
  const pctMateriel = chantier.budgetMaterielVendu > 0 ? (materielReel / chantier.budgetMaterielVendu) * 100 : 0;
  const pctHeures = chantier.heuresVendues > 0 ? (heuresRealisees / chantier.heuresVendues) * 100 : 0;
  const pctMainOeuvre = chantier.budgetMainOeuvreVendu > 0 ? (moReel / chantier.budgetMainOeuvreVendu) * 100 : 0;

  // Dérives constatées, sans seuil inventé : le réel dépasse ce qui a été vendu. Ce sont
  // les comparaisons déjà employées par les filtres de la liste et par la répartition des
  // chantiers terminés, calculées ici une fois pour que liste, tableau de bord et API
  // d'intégration disent la même chose.
  const alertes: string[] = [];
  if (heuresRealisees > chantier.heuresVendues) alertes.push('HEURES_DEPASSEES');
  if (materielReel > chantier.budgetMaterielVendu) alertes.push('MATERIEL_DEPASSE');
  if (moReel > chantier.budgetMainOeuvreVendu) alertes.push('MAIN_OEUVRE_DEPASSEE');

  // Dernière saisie : date métier du dernier achat ou pointage actif. Un chantier en cours
  // sans aucune saisie compte son délai depuis son début.
  let derniereSaisie: string | null = null;
  for (const ligne of [...achats, ...pointages]) {
    if (!ligne.date || Number.isNaN(new Date(ligne.date).getTime())) continue;
    const jour = dateSeuleEnJourCivil(new Date(ligne.date));
    if (!derniereSaisie || jour > derniereSaisie) derniereSaisie = jour;
  }
  let joursSansSaisie: number | null = null;
  if (contexte && chantier.statut === 'EN_COURS') {
    joursSansSaisie = Math.max(0, joursEntre(derniereSaisie ?? jourCivilDeDebut(chantier.dateDebut, contexte.fuseauHoraire), contexte.aujourdhui));
    if (params.joursSansSaisie != null && joursSansSaisie >= params.joursSansSaisie) alertes.push('SANS_SAISIE');
  }

  const base = { materielReel, moReel, totalDepenses, heuresRealisees, diffHeures, pctMateriel, pctHeures, pctMainOeuvre, derniereSaisie, joursSansSaisie, alertes };

  if (!canSeeMarge || !params.margeCommercialeActive) {
    return { ...base, margeBrute: null, margeCommerciale: null, margePct: null, margeEstimee: null, margeEstimeePct: null, estimation: null };
  }

  // Marge commerciale = budget vendu − dépenses réelles (matériel + main d'œuvre).
  // Il n'y a pas de variable sur cette marge pour les conducteurs de travaux (voir la
  // marge ne leur ouvre droit à rien) : seuls les commerciaux ont une rémunération
  // variable, calculée à part par computeCommissionsParCommercial (utilisé par
  // /api/stats/commerciaux) sur la marge cumulée du mois du commercial, pas chantier par
  // chantier. Sans plan commercial, elle est nulle (décision du 17-10-2026).
  const margeBrute = differenceExacte(chantier.budgetGlobalVendu, totalDepenses);
  const margeCommerciale = margeBrute;
  const margePct = chantier.budgetGlobalVendu > 0 ? (margeCommerciale / chantier.budgetGlobalVendu) * 100 : 0;
  // Le signe de la marge est une donnée commerciale : l'alerte « en perte » ne sort que
  // pour qui voit déjà la marge, jamais pour un rôle ou une clé à qui elle est masquée.
  const alertesMarge = margeCommerciale < 0 ? [...alertes, 'EN_PERTE'] : [...alertes];

  // Marge estimée en fin de chantier : ce qui restera du vendu une fois chaque poste
  // dépensé comme attendu. Pour chaque poste, le coût attendu ne descend jamais sous le
  // réel déjà engagé :
  //  - main-d'œuvre : heures vendues × coût horaire de référence (celui réellement
  //    appliqué sur ce chantier ; à défaut, la moyenne de la société ; à défaut, le
  //    budget main-d'œuvre vendu) ;
  //  - matériel : matériel vendu × ce que coûte en moyenne un euro de matériel vendu sur
  //    les chantiers terminés ; sans historique, le matériel restant est compté à son prix
  //    de vente — hypothèse prudente. Le prix d'achat prévu des lignes de devis (lot pilote 2)
  //    n'est pas encore repris par le chantier : à décider (question ouverte de la passation).
  // Un chantier clos n'a plus de reste à faire : son estimation est son réel.
  let estimation: Record<string, unknown> | null = null;
  let margeEstimee: number | null = null;
  let margeEstimeePct: number | null = null;
  if (contexte) {
    let coutMainOeuvreAttendu = moReel;
    let coutMaterielAttendu = materielReel;
    let coutHoraireReference: number | null = heuresRealisees > 0 ? moReel / heuresRealisees : null;
    let sourceCoutHoraire = 'REEL';
    let ratioMateriel: number | null = null;
    let sourceMateriel = 'REEL';
    if (chantier.statut === 'EN_COURS') {
      sourceCoutHoraire = coutHoraireReference != null ? 'CHANTIER' : contexte.coutHoraireSociete != null ? 'SOCIETE' : 'VENDU';
      coutHoraireReference ??= contexte.coutHoraireSociete;
      const mainOeuvrePrevue = coutHoraireReference != null ? chantier.heuresVendues * coutHoraireReference : chantier.budgetMainOeuvreVendu;
      coutMainOeuvreAttendu = Math.max(moReel, mainOeuvrePrevue);
      ratioMateriel = contexte.ratioMaterielHistorique ?? 1;
      sourceMateriel = contexte.ratioMaterielHistorique != null ? 'HISTORIQUE' : 'VENDU';
      coutMaterielAttendu = Math.max(materielReel, chantier.budgetMaterielVendu * ratioMateriel);
    }
    const coutEstime = sommeExacte(coutMainOeuvreAttendu, coutMaterielAttendu);
    margeEstimee = differenceExacte(chantier.budgetGlobalVendu, coutEstime);
    margeEstimeePct = chantier.budgetGlobalVendu > 0 ? (margeEstimee / chantier.budgetGlobalVendu) * 100 : 0;
    estimation = { coutEstime, coutMainOeuvreAttendu, coutMaterielAttendu, coutHoraireReference, sourceCoutHoraire, ratioMateriel, sourceMateriel };
    // Une affaire déjà en perte porte l'alerte la plus forte ; sinon une marge estimée
    // négative, ou sous le seuil réglé par la société, est signalée.
    const seuil = params.seuilMargeFaible;
    if (margeCommerciale >= 0 && (margeEstimee < 0 || (seuil != null && margeEstimeePct < seuil))) alertesMarge.push('MARGE_FAIBLE');
  }

  return { ...base, alertes: alertesMarge, margeBrute, margeCommerciale, margePct, margeEstimee, margeEstimeePct, estimation };
}

// Sérialise un chantier pour le client en masquant les données commerciales à qui n'en
// est pas destinataire (cf. canSeeMarge ci-dessus). Pour la rentabilité, seul le montant vendu
// global est masqué : les budgets par poste restent envoyés pour le suivi des dépassements ;
// ils en donnent la somme, donc avec les dépenses la marge du jour.
// Exception : au technicien, ni budgets par poste, ni coûts, ni taux, ni alertes de
// dépassement (cf. voitMontantsChantier et chantierSansMontants) ; aux autres comptes non
// administrateurs, ni taux ni coût de main-d'œuvre (cf. voitCoutMainOeuvre).
export function serializeChantier(chantier: any, params: Parametres, canSeeMarge: boolean, contexte?: ContexteSuivi, montantsVisibles = true, coutMainOeuvreVisible = true) {
  const c = decimalToNumber(chantier);
  const serialise = {
    ...c,
    budgetGlobalVendu: canSeeMarge ? c.budgetGlobalVendu : null,
    metrics: computeChantierMetrics(c, params, canSeeMarge, contexte),
  };
  if (!montantsVisibles) return chantierSansMontants(serialise);
  return coutMainOeuvreVisible ? serialise : chantierSansCoutMainOeuvre(serialise);
}
