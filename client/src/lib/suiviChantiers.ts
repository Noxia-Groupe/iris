// Suivi des chantiers : recherche, filtres et tri de la liste et du tableau de bord.
//
// Les alertes elles-mêmes sont calculées par le serveur (computeChantierMetrics) : le
// client ne fait que les lire, les libeller et ordonner les chantiers. Ainsi une alerte
// « en perte » n'apparaît que pour qui voit déjà la marge — le serveur ne l'envoie pas
// aux autres, et ce module n'essaie jamais de la reconstituer.

export const ALERTES_CHANTIER = ['EN_PERTE', 'HEURES_DEPASSEES', 'MAIN_OEUVRE_DEPASSEE', 'MATERIEL_DEPASSE'] as const;
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
  alertes?: string[];
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

/**
 * PRIORITE : une affaire en perte d'abord, puis celles qui cumulent le plus de dérives,
 * puis la plus avancée en heures — l'ordre dans lequel on veut les regarder.
 * MARGE : la marge la plus faible d'abord ; une marge non communiquée passe en dernier.
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
        const ma = a.metrics?.margePct;
        const mb = b.metrics?.margePct;
        if (ma == null && mb == null) return comparerNoms(a, b);
        if (ma == null) return 1;
        if (mb == null) return -1;
        return ma - mb || comparerNoms(a, b);
      });
    case 'PRIORITE':
    default:
      return copie.sort((a, b) => {
        const aa = alertesDuChantier(a);
        const ab = alertesDuChantier(b);
        return Number(ab.includes('EN_PERTE')) - Number(aa.includes('EN_PERTE'))
          || ab.length - aa.length
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
    case 'HEURES_DEPASSEES': return 'Les heures réalisées dépassent les heures vendues.';
    case 'MAIN_OEUVRE_DEPASSEE': return 'Le coût réel de la main-d’œuvre dépasse le budget main-d’œuvre vendu.';
    case 'MATERIEL_DEPASSE': return 'Les achats de matériel dépassent le budget matériel vendu.';
  }
}
