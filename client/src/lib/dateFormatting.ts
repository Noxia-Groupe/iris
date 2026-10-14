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

/** Formate une date métier stockée à minuit UTC : elle ne dépend d’aucun fuseau utilisateur. */
export function formatDateOnly(value: string | Date, options: DateFormatOptions = DATE_ONLY_OPTIONS): string {
  return new Intl.DateTimeFormat('fr-FR', { ...options, timeZone: 'UTC' }).format(new Date(value));
}

/** Formate un instant réel dans le fuseau configuré dans CompanySettings. */
export function formatCompanyDateTime(value: string | Date, companyTimeZone: string, options: DateFormatOptions = DATE_TIME_OPTIONS): string {
  return new Intl.DateTimeFormat('fr-FR', { ...options, timeZone: companyTimeZone }).format(new Date(value));
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
  const [annee, mois, jour] = jourCivilChantierIso(value, companyTimeZone).split('-');
  return `${jour}-${mois}-${annee}`;
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
  const [annee, mois, jour] = jourCivilEntrepriseIso(companyTimeZone, now).split('-');
  return `${jour}-${mois}-${annee}`;
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

// Instantané d'une saisie journalisée, rendu lisible : une date-seule en JJ-MM-AAAA, un
// horodatage (création, archivage…) à la date et à l'heure de la société, et non en UTC ; le
// reste est rendu tel quel, en JSON.
const INSTANT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
export function instantaneLisible(valeur: unknown, fuseau: string): string {
  return JSON.stringify(valeur, (_cle, v) => {
    if (typeof v !== 'string' || !INSTANT_ISO.test(v)) return v;
    const jour = jourCivilChantier(v, fuseau);
    return v.endsWith('T00:00:00.000Z') ? jour : `${jour} ${formatCompanyDateTime(v, fuseau, { hour: '2-digit', minute: '2-digit' })}`;
  });
}
