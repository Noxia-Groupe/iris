import { useEffect, useState, type ReactNode } from 'react';
import { apiFetch } from './api';
import { CompanyTimezoneContext, DEFAULT_COMPANY_TIME_ZONE } from './companyTimezoneContext';

type CompanySettingsTimezone = { fuseauHoraire?: string | null };

/** Supplies the timezone stored in CompanySettings; never reads the browser timezone. */
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
        // The server default remains usable if CompanySettings cannot be fetched.
      });
    return () => { cancelled = true; };
  }, []);

  return <CompanyTimezoneContext value={timezone}>{children}</CompanyTimezoneContext>;
}
