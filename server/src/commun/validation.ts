export function nombreDecimalNonNegatif(value: unknown, maxIntegerDigits: number, zeroAutorise = false, maxDecimales = 2): number | null {
  // Ne jamais laisser PostgreSQL arrondir silencieusement une valeur métier ; notation scientifique refusée.
  const texte = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  const expression = new RegExp(`^\\d{1,${maxIntegerDigits}}(?:[,.]\\d{1,${maxDecimales}})?$`);
  if (!expression.test(texte)) return null;
  const nombre = Number(texte.replace(',', '.'));
  return Number.isFinite(nombre) && (nombre > 0 || (zeroAutorise && nombre === 0)) ? nombre : null;
}

export function motifCorrectionValide(value: unknown): string | null {
  const motif = typeof value === 'string' ? value.trim() : '';
  // Même métrique Unicode que PostgreSQL : un emoji est un caractère métier, pas deux unités UTF-16.
  return [...motif].length >= 3 && [...motif].length <= 500 ? motif : null;
}

export function motifRestaurationValide(value: unknown): string | null {
  const motif = typeof value === 'string' ? value.trim() : '';
  return [...motif].length >= 3 && [...motif].length <= 500 ? motif : null;
}
