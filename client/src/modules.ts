// Modules activables de l'application (aujourd'hui : le Planning d'intervention).
// L'état est piloté par un SUPERADMIN depuis Administration > Modules et lu ici par tous
// les comptes pour savoir quelles entrées de menu et quelles pages afficher.
//
// Le serveur renvoie la visibilité EFFECTIVE du compte connecté : un superadmin garde
// toujours le planning, même désactivé (c'est lui qui le pilote). Une copie est conservée
// en localStorage pour que le menu se dessine correctement dès le premier rendu, sans
// clignotement ; elle est rafraîchie à chaque montage et après connexion.
import { useEffect, useState } from 'react';
import { apiFetch } from './api';

export interface Modules {
  /** Planning visible pour le compte connecté. */
  planningActif: boolean;
  /** Réglage global (identique à planningActif sauf pour un superadmin). */
  planningActifGlobal: boolean;
}

const CACHE_KEY = 'modules';
// Par défaut tout est actif : si l'API est momentanément injoignable, on n'ampute pas
// l'application d'un module — le serveur refusera de toute façon les appels non autorisés.
const DEFAUT: Modules = { planningActif: true, planningActifGlobal: true };

export function readCachedModules(): Modules {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return DEFAUT;
    const parsed = JSON.parse(raw) as Partial<Modules>;
    return {
      planningActif: parsed.planningActif !== false,
      planningActifGlobal: parsed.planningActifGlobal !== false,
    };
  } catch {
    return DEFAUT;
  }
}

export function clearCachedModules(): void {
  localStorage.removeItem(CACHE_KEY);
}

/** Recharge l'état des modules depuis l'API et met le cache à jour. */
export async function refreshModules(): Promise<Modules> {
  try {
    const res = await apiFetch('/modules');
    if (!res.ok) return readCachedModules();
    const data = (await res.json()) as Partial<Modules>;
    const modules: Modules = {
      planningActif: data.planningActif !== false,
      planningActifGlobal: data.planningActifGlobal !== false,
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(modules));
    return modules;
  } catch {
    return readCachedModules();
  }
}

/** État des modules : valeur en cache immédiatement, puis valeur fraîche de l'API. */
export function useModules(): Modules {
  const [modules, setModules] = useState<Modules>(readCachedModules);

  useEffect(() => {
    let annule = false;
    refreshModules().then((m) => {
      if (!annule) setModules(m);
    });
    return () => { annule = true; };
  }, []);

  return modules;
}
