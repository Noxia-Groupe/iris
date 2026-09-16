import { createContext, useContext } from 'react';

export const DEFAULT_COMPANY_TIME_ZONE = 'Europe/Paris';
export const CompanyTimezoneContext = createContext(DEFAULT_COMPANY_TIME_ZONE);

export function useCompanyTimezone(): string {
  return useContext(CompanyTimezoneContext);
}
