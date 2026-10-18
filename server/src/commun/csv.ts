export const csvComptable = (v: unknown) => {
  const texte = String(v ?? ''); const formule = /^[=+@\t\r]/.test(texte) || (texte.startsWith('-') && !Number.isFinite(Number(texte)));
  return `"${(formule ? `'${texte}` : texte).replace(/"/g, '""')}"`;
};
