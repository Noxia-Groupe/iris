export type DateFormatOptions = Omit<Intl.DateTimeFormatOptions, 'timeZone'>;

const DATE_ONLY_OPTIONS: DateFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
};

const DATE_TIME_OPTIONS: DateFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

// Toutes les dates s'affichent au format JJ-MM-AAAA (décision de Nelson du 14-10-2026). Intl
// (fr-FR) sépare jour, mois et année par des barres obliques : on les remplace par des tirets.
const enTirets = (texte: string) => texte.replace(/(\d{2})\/(\d{2})\/(\d{4})/g, '$1-$2-$3');

/** Formate une date métier stockée à minuit UTC (JJ-MM-AAAA) : elle ne dépend d’aucun fuseau utilisateur. */
export function formatDateOnly(value: string | Date, options: DateFormatOptions = DATE_ONLY_OPTIONS): string {
  return enTirets(new Intl.DateTimeFormat('fr-FR', { ...options, timeZone: 'UTC' }).format(new Date(value)));
}

/** Formate un instant réel dans le fuseau configuré dans CompanySettings (JJ-MM-AAAA HH:MM:SS). */
export function formatCompanyDateTime(value: string | Date, companyTimeZone: string, options: DateFormatOptions = DATE_TIME_OPTIONS): string {
  return enTirets(new Intl.DateTimeFormat('fr-FR', { ...options, timeZone: companyTimeZone }).format(new Date(value)));
}

/** Jour AAAA-MM-JJ au format affiché JJ-MM-AAAA. */
export function jourFrancais(jourIso: string): string {
  const [annee, mois, jour] = jourIso.slice(0, 10).split('-');
  return `${jour}-${mois}-${annee}`;
}

/** Jour AAAA-MM-JJ précédé de son jour de la semaine : « lun. 12-10-2026 » ou « lundi 12-10-2026 ». */
export function jourSemaineFrancais(jourIso: string, nom: 'short' | 'long' = 'short'): string {
  const jourSemaine = new Intl.DateTimeFormat('fr-FR', { weekday: nom, timeZone: 'UTC' }).format(new Date(`${jourIso.slice(0, 10)}T00:00:00Z`));
  return `${jourSemaine} ${jourFrancais(jourIso)}`;
}

/** Formate le jour civil dérivé d’un instant dans le fuseau de l’entreprise. */
export function formatCompanyDate(value: string | Date, companyTimeZone: string, options: DateFormatOptions = DATE_ONLY_OPTIONS): string {
  return formatCompanyDateTime(value, companyTimeZone, options);
}

/**
 * Jour civil d'une date de chantier, au format JJ-MM-AAAA. Une date-seule (saisie ou corrigée à la
 * main ou posée par une conversion, stockée à minuit UTC) est lue telle quelle ; un instant (début
 * d'un chantier converti avant #130) l'est dans le fuseau de l'entreprise. Même règle que
 * jourCivilDeDebut côté serveur.
 */
export function jourCivilChantier(value: string | Date, companyTimeZone: string): string {
  return jourFrancais(jourCivilChantierIso(value, companyTimeZone));
}

/** Même jour civil que jourCivilChantier, au format AAAA-MM-JJ (calculs de durée). */
export function jourCivilChantierIso(value: string | Date, companyTimeZone: string): string {
  const iso = new Date(value).toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : jourCivilEntrepriseIso(companyTimeZone, new Date(value));
}

/** Nombre de jours civils entre deux jours AAAA-MM-JJ (négatif si `fin` précède `debut`). */
export function joursCivilsEntre(debut: string, fin: string): number {
  return Math.round((Date.parse(`${fin}T00:00:00Z`) - Date.parse(`${debut}T00:00:00Z`)) / 86_400_000);
}

/** Jour civil de la société à un instant donné, au format AAAA-MM-JJ (référence envoyée au serveur). */
export function jourCivilEntrepriseIso(companyTimeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: companyTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Rend la date métier du jour pour un champ texte, dérivée dans le fuseau entreprise. */
export function companyDateInputValue(companyTimeZone: string, now: Date = new Date()): string {
  return jourFrancais(jourCivilEntrepriseIso(companyTimeZone, now));
}

export type PeriodeNavigable = 'week' | 'month' | 'quarter' | 'year';

/**
 * Décale une référence AAAA-MM-JJ d'une période. Une semaine se décale de sept jours ; un mois,
 * un trimestre ou une année repartent du 1er du mois, pour ne pas déborder : depuis le 31-10,
 * le mois suivant est novembre, et non décembre.
 */
export function decalerReference(ref: string, periode: PeriodeNavigable, sens: 1 | -1): string {
  const [annee, mois, jour] = ref.split('-').map(Number);
  const date = periode === 'week'
    ? new Date(Date.UTC(annee, mois - 1, jour + sens * 7))
    : new Date(Date.UTC(annee, mois - 1 + sens * (periode === 'month' ? 1 : periode === 'quarter' ? 3 : 12), 1));
  return date.toISOString().slice(0, 10);
}

// Instantané d'une saisie journalisée (achat, heures), rendu lisible : sa date métier en
// JJ-MM-AAAA, ses horodatages (création, mise à jour, archivage) à la date et à l'heure de la
// société, et non en UTC ; le reste est rendu tel quel, en JSON. La nature de chaque valeur suit
// son champ, et seuls ces champs sont convertis : un texte libre (description, commentaire) qui
// ressemble à une date reste tel qu'il a été saisi. Une valeur que Date ne relit pas à l'identique
// (invalide, ou qui déborde comme un 30 février) n'est jamais interprétée.
const CHAMPS_DATE_SEULE = new Set(['date']);
const CHAMPS_INSTANT = new Set(['createdAt', 'updatedAt', 'archivedAt']);
const INSTANT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
export function instantaneLisible(valeur: unknown, fuseau: string): string {
  return JSON.stringify(valeur, (cle, v) => {
    const dateSeule = CHAMPS_DATE_SEULE.has(cle);
    if ((!dateSeule && !CHAMPS_INSTANT.has(cle)) || typeof v !== 'string' || !INSTANT_ISO.test(v)) return v;
    const instant = new Date(v);
    if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 19) !== v.slice(0, 19)) return v;
    if (dateSeule) return jourFrancais(v.slice(0, 10));
    return `${jourFrancais(jourCivilEntrepriseIso(fuseau, instant))} ${formatCompanyDateTime(instant, fuseau, { hour: '2-digit', minute: '2-digit' })}`;
  });
}
