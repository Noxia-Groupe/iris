import express from 'express';
import { app } from '../app';
import { requireAuth } from './auth';
import { requireAdmin } from './gardes';
import { type ApiScope, requireApiKey } from './cles-api';

// Monte une même opération sur les deux portes d'entrée de l'application :
//   - /api/…    : session humaine (Entra ID ou accès de secours) ;
//   - /api/v1/… : clé d'intégration (agent, connecteur) portant le scope demandé.
// Un seul handler pour les deux : impossible qu'un agent contourne une règle appliquée à
// l'interface, ou qu'une correction ne soit faite que d'un côté.
//
// `gardes` protège la porte interface. Par défaut requireAdmin, qui convient aux
// référentiels (clients, catalogue). Les journaux d'achats et d'heures, eux, sont ouverts
// à tous les rôles : ce n'est pas l'accès à la route qui les restreint, mais le périmètre
// de ce qu'elle renvoie (cf. perimetreChantiers) — passer [] est donc délibéré, pas un
// oubli. La porte /api/v1 ne prend jamais de garde de rôle : une clé n'en a pas.
type MethodeHttp = 'get' | 'post' | 'put' | 'patch' | 'delete';
export function routeMixte(
  methode: MethodeHttp,
  chemin: string,
  scope: ApiScope,
  handler: express.RequestHandler,
  gardes: express.RequestHandler[] = [requireAdmin],
) {
  app[methode](`/api${chemin}`, requireAuth, ...gardes, handler);
  app[methode](`/api/v1${chemin}`, requireApiKey(scope), handler);
}
