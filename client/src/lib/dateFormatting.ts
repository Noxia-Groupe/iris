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

/** Formats a business date stored at midnight UTC; it must never depend on a user timezone. */
export function formatDateOnly(value: string | Date, options: DateFormatOptions = DATE_ONLY_OPTIONS): string {
  return new Intl.DateTimeFormat('fr-FR', { ...options, timeZone: 'UTC' }).format(new Date(value));
}

/** Formats a real instant using the timezone configured in CompanySettings. */
export function formatCompanyDateTime(value: string | Date, companyTimeZone: string, options: DateFormatOptions = DATE_TIME_OPTIONS): string {
  return new Intl.DateTimeFormat('fr-FR', { ...options, timeZone: companyTimeZone }).format(new Date(value));
}

/** Formats only the calendar day derived from a real instant in the company timezone. */
export function formatCompanyDate(value: string | Date, companyTimeZone: string, options: DateFormatOptions = DATE_ONLY_OPTIONS): string {
  return formatCompanyDateTime(value, companyTimeZone, options);
}

/** Returns today's business date for a text input, derived from an instant in the company timezone. */
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
