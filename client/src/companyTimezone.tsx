import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiFetch } from './api';
import { CompanyTimezoneConnuContext, CompanyTimezoneContext, DEFAULT_COMPANY_TIME_ZONE, SocieteContext } from './companyTimezoneContext';
import { lireNomSocieteEnCache, memoriserNomSociete } from './lib/cacheSociete';

type CompanySettingsLus = { fuseauHoraire?: string | null; nomCommercial?: string | null; raisonSociale?: string | null };

/**
 * Fournit, en une seule lecture de CompanySettings, le fuseau de l'entreprise (jamais celui
 * du navigateur) et le nom affiché en tête du menu. `rafraichir` relit les paramètres après
 * un enregistrement, pour que le cadre suive sans rechargement de page.
 */
export function CompanyTimezoneProvider({ children }: { children: ReactNode }) {
  const [timezone, setTimezone] = useState(DEFAULT_COMPANY_TIME_ZONE);
  // Fuseau effectivement lu (et non le défaut) : condition pour préremplir une date du jour.
  const [connu, setConnu] = useState(false);
  const [nom, setNom] = useState(lireNomSocieteEnCache);
  const [version, setVersion] = useState(0);
  const rafraichir = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    void apiFetch('/company')
      .then(async (response) => {
        if (!response.ok) return;
        const settings = await response.json() as CompanySettingsLus;
        if (cancelled) return;
        if (settings.fuseauHoraire) setTimezone(settings.fuseauHoraire);
        setConnu(true);
        const nomSociete = (settings.nomCommercial || settings.raisonSociale || '').trim();
        setNom(nomSociete);
        memoriserNomSociete(nomSociete);
      })
      .catch(() => {
        // Le défaut serveur et le nom en cache restent utilisables si CompanySettings est injoignable.
      });
    return () => { cancelled = true; };
  }, [version]);

  const societe = useMemo(() => ({ nom, rafraichir }), [nom, rafraichir]);

  return (
    <CompanyTimezoneContext value={timezone}>
      <CompanyTimezoneConnuContext value={connu}>
        <SocieteContext value={societe}>{children}</SocieteContext>
      </CompanyTimezoneConnuContext>
    </CompanyTimezoneContext>
  );
}
