// Suivi des chantiers : recherche, filtres et tri de la liste et du tableau de bord.
//
// Les alertes elles-mêmes sont calculées par le serveur (computeChantierMetrics) : le
// client ne fait que les lire, les libeller et ordonner les chantiers. Ainsi une alerte
// « en perte » n'apparaît que pour qui voit déjà la marge — le serveur ne l'envoie pas
// aux autres, et ce module n'essaie jamais de la reconstituer.

// Ordre de gravité : il sert à l'affichage des pastilles comme au tri « à surveiller d'abord ».
export const ALERTES_CHANTIER = ['EN_PERTE', 'MARGE_FAIBLE', 'HEURES_DEPASSEES', 'MAIN_OEUVRE_DEPASSEE', 'MATERIEL_DEPASSE', 'SANS_SAISIE'] as const;
export type AlerteChantier = typeof ALERTES_CHANTIER[number];

export interface MetriquesChantier {
  heuresRealisees?: number;
  materielReel?: number;
  moReel?: number;
  pctHeures?: number;
  pctMateriel?: number;
  pctMainOeuvre?: number;
  margeCommerciale?: number | null;
  margePct?: number | null;
  margeEstimee?: number | null;
  margeEstimeePct?: number | null;
  estimation?: EstimationMarge | null;
  derniereSaisie?: string | null;
  joursSansSaisie?: number | null;
  alertes?: string[];
}

/** Hypothèses de la marge estimée en fin de chantier, telles que le serveur les a prises. */
export interface EstimationMarge {
  coutEstime: number;
  coutMainOeuvreAttendu: number;
  coutMaterielAttendu: number;
  coutHoraireReference: number | null;
  sourceCoutHoraire: 'CHANTIER' | 'SOCIETE' | 'VENDU' | 'REEL';
  ratioMateriel: number | null;
  sourceMateriel: 'HISTORIQUE' | 'VENDU' | 'REEL';
}

export interface ChantierSuivi {
  id: string;
  nom: string;
  client: string;
  numeroDevis?: string | null;
  statut: string;
  heuresVendues: number;
  budgetMaterielVendu: number;
  budgetMainOeuvreVendu: number;
  responsable?: { name?: string | null } | null;
  commercial?: { name?: string | null } | null;
  metrics?: MetriquesChantier;
}

export type FiltreChantiers = 'TOUS' | 'A_SURVEILLER' | AlerteChantier;
export type TriChantiers = 'PRIORITE' | 'AVANCEMENT' | 'MARGE' | 'NOM';

/** Alertes connues renvoyées par le serveur, dans l'ordre de gravité d'affichage. */
export function alertesDuChantier(chantier: ChantierSuivi): AlerteChantier[] {
  const recues = new Set(chantier.metrics?.alertes ?? []);
  return ALERTES_CHANTIER.filter((code) => recues.has(code));
}

export function estASurveiller(chantier: ChantierSuivi): boolean {
  return alertesDuChantier(chantier).length > 0;
}

// Recherche tolérante : sans casse ni accents, sur ce qu'un utilisateur a en tête quand il
// cherche une affaire — son nom, le client, le numéro de devis ou le responsable.
function normaliser(texte: string): string {
  return texte.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

export function correspondRecherche(chantier: ChantierSuivi, recherche: string): boolean {
  const termes = normaliser(recherche).split(/\s+/).filter(Boolean);
  if (termes.length === 0) return true;
  const contenu = normaliser([
    chantier.nom, chantier.client, chantier.numeroDevis ?? '', chantier.responsable?.name ?? '', chantier.commercial?.name ?? '',
  ].join(' '));
  return termes.every((terme) => contenu.includes(terme));
}

export function filtrerChantiers<T extends ChantierSuivi>(chantiers: T[], recherche: string, filtre: FiltreChantiers): T[] {
  return chantiers.filter((chantier) => {
    if (!correspondRecherche(chantier, recherche)) return false;
    if (filtre === 'TOUS') return true;
    const alertes = alertesDuChantier(chantier);
    return filtre === 'A_SURVEILLER' ? alertes.length > 0 : alertes.includes(filtre);
  });
}

const comparerNoms = (a: ChantierSuivi, b: ChantierSuivi) => a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' });
const avancement = (c: ChantierSuivi) => c.metrics?.pctHeures ?? 0;

const gravite = (c: ChantierSuivi) => {
  const alertes = alertesDuChantier(c);
  return alertes.length ? ALERTES_CHANTIER.indexOf(alertes[0]) : ALERTES_CHANTIER.length;
};
// La marge estimée en fin de chantier dit mieux qu'une marge du jour où l'affaire finira.
const margeDeTri = (c: ChantierSuivi) => c.metrics?.margeEstimeePct ?? c.metrics?.margePct ?? null;

/**
 * PRIORITE : l'alerte la plus grave d'abord (perte, marge faible, dépassements, absence de
 * saisie), puis le cumul de dérives, puis l'avancement en heures — l'ordre dans lequel on
 * veut regarder les affaires.
 * MARGE : la marge estimée la plus faible d'abord ; une marge non communiquée en dernier.
 */
export function trierChantiers<T extends ChantierSuivi>(chantiers: T[], tri: TriChantiers): T[] {
  const copie = [...chantiers];
  switch (tri) {
    case 'NOM':
      return copie.sort(comparerNoms);
    case 'AVANCEMENT':
      return copie.sort((a, b) => avancement(b) - avancement(a) || comparerNoms(a, b));
    case 'MARGE':
      return copie.sort((a, b) => {
        const ma = margeDeTri(a);
        const mb = margeDeTri(b);
        if (ma == null && mb == null) return comparerNoms(a, b);
        if (ma == null) return 1;
        if (mb == null) return -1;
        return ma - mb || comparerNoms(a, b);
      });
    case 'PRIORITE':
    default:
      return copie.sort((a, b) => {
        return gravite(a) - gravite(b)
          || alertesDuChantier(b).length - alertesDuChantier(a).length
          || avancement(b) - avancement(a)
          || comparerNoms(a, b);
      });
  }
}

const nombre = (valeur: number, decimales = 0) => valeur.toLocaleString('fr-FR', { maximumFractionDigits: decimales });

/** Libellé court et chiffré d'une alerte : ce qui dépasse, et de combien. */
export function libelleAlerte(code: AlerteChantier, chantier: ChantierSuivi): string {
  const m = chantier.metrics ?? {};
  switch (code) {
    case 'EN_PERTE':
      return `En perte ${nombre(Math.abs(m.margeCommerciale ?? 0))} €`;
    case 'MARGE_FAIBLE':
      return `Marge estimée ${nombre(m.margeEstimeePct ?? 0, 1)} %`;
    case 'SANS_SAISIE':
      return `Sans saisie depuis ${nombre(m.joursSansSaisie ?? 0)} j`;
    case 'HEURES_DEPASSEES':
      return `Heures +${nombre((m.heuresRealisees ?? 0) - chantier.heuresVendues, 1)} h`;
    case 'MAIN_OEUVRE_DEPASSEE':
      return `Main-d’œuvre +${nombre((m.moReel ?? 0) - chantier.budgetMainOeuvreVendu)} €`;
    case 'MATERIEL_DEPASSE':
      return `Matériel +${nombre((m.materielReel ?? 0) - chantier.budgetMaterielVendu)} €`;
  }
}

/** Explication complète, pour l'infobulle et les lecteurs d'écran. */
export function explicationAlerte(code: AlerteChantier): string {
  switch (code) {
    case 'EN_PERTE': return 'Les dépenses réelles dépassent le montant vendu.';
    case 'MARGE_FAIBLE': return 'La marge estimée en fin de chantier est sous le seuil réglé par la société, ou négative.';
    case 'SANS_SAISIE': return 'Aucun achat ni aucune heure saisi depuis le délai réglé par la société.';
    case 'HEURES_DEPASSEES': return 'Les heures réalisées dépassent les heures vendues.';
    case 'MAIN_OEUVRE_DEPASSEE': return 'Le coût réel de la main-d’œuvre dépasse le budget main-d’œuvre vendu.';
    case 'MATERIEL_DEPASSE': return 'Les achats de matériel dépassent le budget matériel vendu.';
  }
}

/** « aujourd'hui », « hier », « il y a 12 j » : ancienneté de la dernière saisie. */
export function ancienneteSaisie(jours: number): string {
  if (jours <= 0) return 'aujourd’hui';
  if (jours === 1) return 'hier';
  return `il y a ${nombre(jours)} j`;
}

/** Libellé de l'hypothèse de coût horaire retenue pour l'estimation. */
export function hypotheseCoutHoraire(e: EstimationMarge): string {
  const taux = e.coutHoraireReference != null ? `${nombre(e.coutHoraireReference, 2)} €/h` : '';
  switch (e.sourceCoutHoraire) {
    case 'CHANTIER': return `heures vendues à ${taux}, coût moyen réellement appliqué sur ce chantier`;
    case 'SOCIETE': return `heures vendues à ${taux}, coût moyen de la société (aucune heure encore saisie ici)`;
    case 'VENDU': return 'budget main-d’œuvre vendu (aucun coût horaire connu)';
    case 'REEL': return 'coût réel (chantier terminé)';
  }
}

/** Libellé de l'hypothèse retenue pour le matériel. */
export function hypotheseMateriel(e: EstimationMarge): string {
  switch (e.sourceMateriel) {
    case 'HISTORIQUE': return `matériel vendu × ${nombre((e.ratioMateriel ?? 1) * 100, 0)} %, ratio d’achat observé sur les chantiers terminés`;
    case 'VENDU': return 'matériel restant compté à son prix de vente (aucun chantier terminé pour l’instant)';
    case 'REEL': return 'achats réels (chantier terminé)';
  }
}
