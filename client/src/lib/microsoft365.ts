// Connexion Microsoft dans le navigateur : l'instance MSAL partagée (lot 6b-2). Seul module, avec la page
// de connexion (Login.tsx) et la page de retour (AuthCallbackMsal.tsx), à importer @azure/msal-browser.
//
// - L'instance est créée une seule fois, à partir de GET /api/config (ssoClientId, ssoTenantId), avec la
//   configuration de la connexion : autorité https://login.microsoftonline.com/<tenant>, retour sur
//   /auth/callback, cache dans le sessionStorage (il disparaît à la fermeture de l'onglet). La page de
//   connexion la crée au chargement, et non au clic ; le dialogue d'envoi, à son ouverture, quand
//   l'envoi par Microsoft 365 est proposé : la fenêtre Microsoft s'ouvre ainsi directement depuis le clic.
// - Le jeton de l'envoi (Mail.Send, User.Read) ne sort de ce module que dans l'en-tête X-Jeton-Microsoft
//   de la requête d'envoi : il n'est jamais rendu à l'écran, ni gardé dans un état React, une trace, un
//   message ou le localStorage. Seul le cache de MSAL le garde, dans le sessionStorage.
// - À la déconnexion d'Iris, le cache de MSAL de l'onglet est vidé (viderCacheMicrosoft365), jamais par
//   logoutPopup ni logoutRedirect, qui fermeraient la session Microsoft de tout le navigateur.
import { CacheLookupPolicy, PublicClientApplication, type AccountInfo } from '@azure/msal-browser';
import { apiFetch } from '../api';
import {
  CANAL_MICROSOFT_365, ENTETE_JETON_MICROSOFT, PERMISSIONS_ENVOI, type EntreeReponse, messageErreurMsal, obtenirJetonAvec,
} from './envoiMicrosoft365';

export type ConnexionMicrosoft365 = { instance: PublicClientApplication; pret: Promise<void> };
type ConfigConnexion = { ssoConfigured?: boolean; ssoClientId?: string | null; ssoTenantId?: string | null };

let connexion: ConnexionMicrosoft365 | null = null;
let chargement: Promise<ConnexionMicrosoft365 | null> | null = null;

/** L'instance déjà créée, ou null : connexion Microsoft non configurée, ou configuration pas encore lue. */
export function connexionMicrosoft365(): ConnexionMicrosoft365 | null {
  return connexion;
}

/**
 * Crée l'instance MSAL, une seule fois, et lance son initialisation (`pret`, rejetée si elle échoue).
 * Rend null si la connexion Microsoft n'est pas configurée ou si la configuration est illisible : un
 * nouvel appel la relit alors, comme la page de connexion à chacun de ses chargements.
 */
export function chargerMicrosoft365(): Promise<ConnexionMicrosoft365 | null> {
  if (connexion) return Promise.resolve(connexion);
  if (!chargement) {
    chargement = apiFetch('/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((cfg: ConfigConnexion | null) => {
        if (connexion) return connexion;
        if (!cfg?.ssoConfigured || !cfg.ssoClientId || !cfg.ssoTenantId) return null;
        const instance = new PublicClientApplication({
          auth: {
            clientId: cfg.ssoClientId,
            authority: `https://login.microsoftonline.com/${cfg.ssoTenantId}`,
            // Page dédiée (hors PrivateRoute) : évite que le routeur redirige vers /login
            // et écrase la réponse Microsoft avant que MSAL ait pu la lire dans le popup.
            redirectUri: `${window.location.origin}/auth/callback`,
          },
          cache: { cacheLocation: 'sessionStorage' },
        });
        const pret = instance.initialize();
        // L'échec éventuel est rendu à qui attend `pret` (le clic) : pas de rejet non suivi d'ici là.
        pret.catch(() => {});
        connexion = { instance, pret };
        return connexion;
      })
      .catch(() => null /* config indisponible : connexion Microsoft considérée inactive */)
      .finally(() => { chargement = null; });
  }
  return chargement;
}

/**
 * Jeton d'accès de l'envoi pour le compte Iris d'adresse `adresseCompte` : en silence, sans iframe, avec
 * le compte MSAL de cette adresse, sinon par la fenêtre Microsoft (lib/envoiMicrosoft365.ts,
 * obtenirJetonAvec). `forcerFenetre` : directement par la fenêtre, après un refus d'accès de Microsoft 365.
 * Rejetée avec l'erreur de MSAL si la fenêtre échoue, ou une erreur sans code si la connexion n'est pas
 * configurée. Non exportée : seul envoyerParMicrosoft365, ci-dessous, s'en sert, et le jeton ne sort
 * pas de ce module.
 */
async function obtenirJetonEnvoi(adresseCompte: string, { forcerFenetre = false }: { forcerFenetre?: boolean } = {}): Promise<string> {
  const msal = connexion ?? await chargerMicrosoft365();
  if (!msal) throw new Error('Connexion Microsoft non configurée.');
  await msal.pret;
  const { instance } = msal;
  return obtenirJetonAvec<AccountInfo>({
    comptes: () => instance.getAllAccounts(),
    enSilence: async (compte) => (await instance.acquireTokenSilent({
      scopes: [...PERMISSIONS_ENVOI], account: compte, cacheLookupPolicy: CacheLookupPolicy.AccessTokenAndRefreshToken,
    })).accessToken,
    parFenetre: async (adresse) => (await instance.acquireTokenPopup({ scopes: [...PERMISSIONS_ENVOI], loginHint: adresse.trim() || undefined })).accessToken,
  }, adresseCompte, { forcerFenetre });
}

/**
 * Envoi d'un document par Microsoft 365 : le jeton, puis POST {chemin}/envois avec
 * { destinataire, canal: 'MICROSOFT_365' } et l'en-tête X-Jeton-Microsoft, par apiFetch (un 401 déconnecte).
 * Rend le message de l'erreur de la fenêtre Microsoft (rien n'est parti), ou la réponse à classer :
 * { rejet: true } si fetch est rejeté, sinon son statut et son corps en JSON (null s'il n'en est pas).
 */
export async function envoyerParMicrosoft365(
  chemin: string, destinataire: string, adresseCompte: string, options: { forcerFenetre?: boolean } = {},
): Promise<{ messageFenetre: string } | { reponse: EntreeReponse }> {
  let jeton: string;
  try {
    jeton = await obtenirJetonEnvoi(adresseCompte, options);
  } catch (erreur) {
    return { messageFenetre: messageErreurMsal(erreur) };
  }
  let reponse: Response;
  try {
    reponse = await apiFetch(`${chemin}/envois`, {
      method: 'POST',
      headers: { [ENTETE_JETON_MICROSOFT]: jeton },
      body: JSON.stringify({ destinataire, canal: CANAL_MICROSOFT_365 }),
    });
  } catch {
    return { reponse: { rejet: true } };
  }
  const json: unknown = await reponse.json().catch(() => null);
  return { reponse: { statut: reponse.status, json } };
}

// Retire du sessionStorage les clés de MSAL (toutes commencent par « msal. ») : le cache d'un onglet
// dont l'instance n'existe pas, ou plus (page rechargée).
function retirerClesMsal(): void {
  try {
    const cles: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const cle = sessionStorage.key(i);
      if (cle?.startsWith('msal.')) cles.push(cle);
    }
    for (const cle of cles) sessionStorage.removeItem(cle);
  } catch {
    // Stockage indisponible : rien à vider.
  }
}

/**
 * Vide le cache MSAL de l'onglet, à la déconnexion d'Iris (menu, session expirée, accès refusé) :
 * clearCache() de l'instance partagée, ou, si elle n'existe pas, ou si clearCache échoue, le retrait des
 * clés MSAL du sessionStorage. Jamais logoutPopup ni logoutRedirect : la session Microsoft du
 * navigateur reste ouverte.
 */
export function viderCacheMicrosoft365(): void {
  if (!connexion) {
    retirerClesMsal();
    return;
  }
  try {
    connexion.instance.clearCache().catch(retirerClesMsal);
  } catch {
    retirerClesMsal();
  }
}
