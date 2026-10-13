import { createContext, useContext } from 'react';

export const DEFAULT_COMPANY_TIME_ZONE = 'Europe/Paris';
export const CompanyTimezoneContext = createContext(DEFAULT_COMPANY_TIME_ZONE);

export function useCompanyTimezone(): string {
  return useContext(CompanyTimezoneContext);
}

/** Société exploitante telle que l'affiche le cadre de l'application (en-tête du menu). */
export interface SocieteCourante {
  /** Nom commercial, à défaut raison sociale ; vide tant qu'aucun n'est renseigné. */
  nom: string;
  /** Relit CompanySettings, à appeler après tout enregistrement de l'identité ou du fuseau. */
  rafraichir: () => void;
}
export const SocieteContext = createContext<SocieteCourante>({ nom: '', rafraichir: () => {} });

export function useSociete(): SocieteCourante {
  return useContext(SocieteContext);
}
