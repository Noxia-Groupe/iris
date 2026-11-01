// Client Microsoft Graph de l'envoi des documents par Microsoft 365 (lot 6b-1b ; orchestration dans
// ./envoiMicrosoft365.ts). Deux appels, faits avec le jeton d'accès délégué de l'utilisateur, que son
// navigateur obtient (lot 6b-2) et transmet pour la seule requête d'envoi :
//   - GET {adresse}/me?$select=mail,userPrincipalName : l'adresse de la boîte, pour contrôler
//     l'expéditeur (permission déléguée User.Read) ;
//   - POST {adresse}/me/sendMail : le courriel, avec le PDF en pièce jointe, gardé dans les éléments
//     envoyés (permission déléguée Mail.Send).
// Le fetch natif de Node, sans redirection (redirect: 'error') ni proxy (il ignore HTTPS_PROXY : le
// serveur joint https://graph.microsoft.com en direct). Le jeton ne part que dans l'en-tête
// Authorization de ces deux appels : il n'est écrit dans aucune trace, aucune erreur rendue, aucun
// journal. Les erreurs du fetch ne sont jamais tracées telles quelles : seul leur nom l'est.

// Délais des appels, en millisecondes : limites techniques gardées dans le code (règle permanente 1),
// et non des règles de la société. Avec les délais des deux transactions de l'envoi (10 s, puis 5 s),
// et jusqu'à 2 s d'attente de connexion par transaction, l'envoi reste en deçà des 60 s du
// proxy_read_timeout par défaut de nginx (client/nginx.conf) : il répond toujours avant que le proxy
// ne coupe la requête. Objet modifiable : il ne sert qu'aux tests, qui raccourcissent ces délais sans
// variable d'environnement. L'application ne le modifie jamais.
export const delaisGraph = { me: 10_000, envoi: 25_000 };

// Taille maximale du corps JSON de sendMail, PDF en base64 compris, en octets : Microsoft documente une
// limite de 4 Mo pour une requête sendMail avec pièce jointe. Lecture la plus restrictive de « 4 Mo »,
// 4 000 000 octets (choix par défaut, à confirmer). Limite technique gardée dans le code (règle
// permanente 1). Au-delà, l'envoi est refusé (413) sans appel : la messagerie reste possible.
export const TAILLE_MAX_REQUETE_ENVOI = 4_000_000;

export const ADRESSE_GRAPH_PAR_DEFAUT = 'https://graph.microsoft.com/v1.0';

// Adresse de Microsoft Graph, lue à chaque appel dans MICROSOFT_GRAPH_URL, facultative, réservée aux
// tests (Microsoft Graph simulé) : https://graph.microsoft.com/v1.0 par défaut. Seules sont admises
// une adresse https://graph.microsoft.com/…, au port par défaut, et une adresse locale
// http://127.0.0.1:<port>… ou http://localhost:<port>…, sans identifiants, requête ni fragment : toute
// autre adresse porterait les jetons des utilisateurs ailleurs que chez Microsoft. L'adresse est
// analysée (new URL), et non comparée par préfixe : https://graph.microsoft.com.exemple.fr ou
// http://127.0.0.1@exemple.fr sont refusées. Une adresse refusée rend null : le démarrage est refusé
// (verifierConfigurationDemarrage, demarrage.ts), et l'envoi par Microsoft 365 n'est pas configuré.
// L'adresse rendue n'a pas de barre oblique finale.
export function adresseGraph(): string | null {
  const brute = process.env.MICROSOFT_GRAPH_URL?.trim() || ADRESSE_GRAPH_PAR_DEFAUT;
  let url: URL;
  try {
    url = new URL(brute);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const officielle = url.protocol === 'https:' && url.hostname === 'graph.microsoft.com' && url.port === '';
  const locale = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port !== '';
  if (!officielle && !locale) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

// Connexion Microsoft configurée : AZURE_TENANT_ID et AZURE_CLIENT_ID non vides, lus à chaque appel,
// et non figés au chargement (N5 du cadrage), comme l'inscription Entra qui porte aussi les
// permissions de l'envoi.
export function connexionMicrosoftConfiguree(): boolean {
  return !!process.env.AZURE_TENANT_ID?.trim() && !!process.env.AZURE_CLIENT_ID?.trim();
}

// Refus de Microsoft Graph : ACCES_REFUSE pour un 401 ou un 403 (jeton expiré, consentement absent,
// compte sans boîte Exchange), REFUSE pour un autre 4xx. Les autres statuts (1xx, 3xx, 5xx) ne disent
// pas que la requête a été refusée.
export type RefusGraph = 'ACCES_REFUSE' | 'REFUSE';
function refusDuStatut(statut: number): RefusGraph | null {
  if (statut === 401 || statut === 403) return 'ACCES_REFUSE';
  if (statut >= 400 && statut < 500) return 'REFUSE';
  return null;
}

// Cause d'un échec, pour la trace serveur : le nom de l'erreur du fetch (TimeoutError, TypeError…),
// jamais son message, ou le statut de Graph et le code d'erreur qu'il donne (ErrorAccessDenied…),
// filtré. Ni jeton, ni corps de requête.
function nomErreur(error: unknown): string {
  return error instanceof Error ? error.name : 'erreur';
}
async function causeGraph(reponse: Response): Promise<string> {
  let code = '';
  try {
    const corps = JSON.parse(await reponse.text()) as { error?: { code?: unknown } };
    if (typeof corps?.error?.code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(corps.error.code)) code = ` (${corps.error.code})`;
  } catch {
    // Corps absent, illisible ou coupé : le statut suffit.
  }
  return `statut ${reponse.status}${code}`;
}

const entetes = (jeton: string, autres: Record<string, string> = {}) => ({ Authorization: `Bearer ${jeton}`, ...autres });

// Adresse de la boîte du jeton : mail, à défaut userPrincipalName. INJOIGNABLE quand /me ne répond pas
// dans le délai, que la connexion est coupée ou refusée, qu'il redirige, répond en 5xx ou d'une réponse
// illisible.
export type BoiteMicrosoft = { adresse: string } | { refus: RefusGraph | 'INJOIGNABLE'; cause: string };
export async function lireBoiteMicrosoft(adresse: string, jeton: string): Promise<BoiteMicrosoft> {
  let reponse: Response;
  try {
    reponse = await fetch(`${adresse}/me?$select=mail,userPrincipalName`, {
      headers: entetes(jeton, { Accept: 'application/json' }), redirect: 'error', signal: AbortSignal.timeout(delaisGraph.me),
    });
  } catch (error) {
    return { refus: 'INJOIGNABLE', cause: nomErreur(error) };
  }
  if (!reponse.ok) return { refus: refusDuStatut(reponse.status) ?? 'INJOIGNABLE', cause: await causeGraph(reponse) };
  try {
    const moi = await reponse.json() as { mail?: unknown; userPrincipalName?: unknown };
    const valeurs = [moi?.mail, moi?.userPrincipalName].map((valeur) => (typeof valeur === 'string' ? valeur.trim() : ''));
    return { adresse: valeurs.find(Boolean) ?? '' };
  } catch (error) {
    return { refus: 'INJOIGNABLE', cause: `réponse illisible (${nomErreur(error)})` };
  }
}

// Corps de la requête sendMail : l'objet, le texte simple, un seul destinataire, l'en-tête x-iris-envoi
// (identifiant de la ligne du journal, qui retrouve l'envoi dans Outlook) et le PDF en pièce jointe, sous
// le nom de fichier du bouton « PDF ». Le message est gardé dans les éléments envoyés. Un objet ou un
// texte sur plusieurs lignes reste une requête JSON valide.
export type CourrielMicrosoft = { identifiant: string; destinataire: string; objet: string; corps: string; nomFichier: string; pdf: Buffer };
export function requeteSendMail(courriel: CourrielMicrosoft): string {
  return JSON.stringify({
    message: {
      subject: courriel.objet,
      body: { contentType: 'Text', content: courriel.corps },
      toRecipients: [{ emailAddress: { address: courriel.destinataire } }],
      internetMessageHeaders: [{ name: 'x-iris-envoi', value: courriel.identifiant }],
      attachments: [{
        '@odata.type': '#microsoft.graph.fileAttachment', name: courriel.nomFichier, contentType: 'application/pdf', contentBytes: courriel.pdf.toString('base64'),
      }],
    },
    saveToSentItems: true,
  });
}

// Envoi : ENVOYE sur le seul 202 (Accepted) que documente Microsoft. INCERTAIN quand l'issue n'est pas
// connue : délai dépassé, connexion coupée, redirection, 5xx, ou un autre statut sans refus (2xx autre
// que 202 compris : choix par défaut, à confirmer). Le corps d'un 202 n'est pas attendu.
export type IssueSendMail = { issue: 'ENVOYE' } | { issue: RefusGraph | 'INCERTAIN'; cause: string };
export async function envoyerSendMail(adresse: string, jeton: string, requete: string): Promise<IssueSendMail> {
  let reponse: Response;
  try {
    reponse = await fetch(`${adresse}/me/sendMail`, {
      method: 'POST', headers: entetes(jeton, { 'Content-Type': 'application/json' }), body: requete,
      redirect: 'error', signal: AbortSignal.timeout(delaisGraph.envoi),
    });
  } catch (error) {
    return { issue: 'INCERTAIN', cause: nomErreur(error) };
  }
  if (reponse.status === 202) {
    void reponse.body?.cancel().catch(() => undefined);
    return { issue: 'ENVOYE' };
  }
  return { issue: refusDuStatut(reponse.status) ?? 'INCERTAIN', cause: await causeGraph(reponse) };
}
