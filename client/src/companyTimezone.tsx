import { useEffect, useState, type ReactNode } from 'react';
import { apiFetch } from './api';
import { CompanyTimezoneContext, DEFAULT_COMPANY_TIME_ZONE } from './companyTimezoneContext';

type CompanySettingsTimezone = { fuseauHoraire?: string | null };

/** Fournit le fuseau enregistré dans CompanySettings ; ne lit jamais celui du navigateur. */
export function CompanyTimezoneProvider({ children }: { children: ReactNode }) {
  const [timezone, setTimezone] = useState(DEFAULT_COMPANY_TIME_ZONE);

  useEffect(() => {
    let cancelled = false;
    void apiFetch('/company')
      .then(async (response) => {
        if (!response.ok) return;
        const settings = await response.json() as CompanySettingsTimezone;
        if (!cancelled && settings.fuseauHoraire) setTimezone(settings.fuseauHoraire);
      })
      .catch(() => {
        // Le défaut serveur reste utilisable si CompanySettings est injoignable.
      });
    return () => { cancelled = true; };
  }, []);

  return <CompanyTimezoneContext value={timezone}>{children}</CompanyTimezoneContext>;
}
