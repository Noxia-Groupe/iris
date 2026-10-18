
export function nombreDecimalNonNegatif(value: unknown, maxIntegerDigits: number, zeroAutorise = false, maxDecimales = 2): number | null {
  // Ne jamais laisser PostgreSQL arrondir silencieusement une valeur métier ; notation scientifique refusée.
  const texte = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  const expression = new RegExp(`^\\d{1,${maxIntegerDigits}}(?:[,.]\\d{1,${maxDecimales}})?$`);
  if (!expression.test(texte)) return null;
  const nombre = Number(texte.replace(',', '.'));
  return Number.isFinite(nombre) && (nombre > 0 || (zeroAutorise && nombre === 0)) ? nombre : null;
}
