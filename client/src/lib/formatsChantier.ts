import { formatDateOnly } from './dateFormatting';
import { arrondiEuro } from './montants';

// Date ISO (avec ou sans heure) -> format métier français JJ-MM-AAAA.
export const toDateFrancaise = (d: string | null | undefined) => {
  if (!d) return '';
  const [annee, mois, jour] = d.slice(0, 10).split('-');
  return `${jour}-${mois}-${annee}`;
};

export const fmtDate = (d: string) => formatDateOnly(d);
export const fmtEuro = (n: number) => `${arrondiEuro(n).toLocaleString('fr-FR')} €`;
// Heures : jusqu'au centième (18,75 h), sans décimale inutile (8 h, 7,5 h).
export const fmtHeures = (n: number) => `${n.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} h`;
