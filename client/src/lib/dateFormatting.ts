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

/** Rend la date métier du jour pour un champ texte, dérivée dans le fuseau entreprise. */
export function companyDateInputValue(companyTimeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: companyTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('day')}-${part('month')}-${part('year')}`;
}
