import { useState } from 'react';
import { useCompanyTimezone } from '../companyTimezoneContext';
import { jourCivilEntrepriseIso } from './dateFormatting';

/**
 * Référence (AAAA-MM-JJ) d'un écran découpé en périodes (semaine, mois…). Tant que l'on n'a pas
 * navigué, c'est le jour de la société, où que se trouve le navigateur, recalculé dès que le
 * fuseau de la société est connu ; passer `null` (bouton « Aujourd'hui ») y revient.
 */
export function useReferencePeriode(): [string, (ref: string | null) => void] {
  const fuseau = useCompanyTimezone();
  const [ref, setRef] = useState<string | null>(null);
  return [ref ?? jourCivilEntrepriseIso(fuseau), setRef];
}
