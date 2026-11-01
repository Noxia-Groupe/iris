// Envoi d'un document par Microsoft 365, côté écran (lot 6b-2 ; serveur : lot 6b-1b,
// server/src/domaines/documents/envoiMicrosoft365.ts). Fonctions pures, sans MSAL, React ni API : elles se
// testent sous tsx --test. L'instance MSAL et le jeton vivent dans ./microsoft365.ts, seul module, avec
// la page de connexion, à importer @azure/msal-browser.
import { formatCompanyDateTime } from './dateFormatting';
import type { EnvoiPrepare } from './envoiDocument';

// --- Repris à l'identique du serveur ---
// Messages de MESSAGES_MICROSOFT_365 (server/src/domaines/documents/envoiMicrosoft365.ts) que l'écran
// reconnaît au caractère près : d'autres 500 et d'autres 409 existent.
/** MESSAGES_MICROSOFT_365.nonNote : le cas (c), courriel parti mais non noté (500). */
export const MESSAGE_PARTI_NON_NOTE = 'Le courriel est parti par Microsoft 365, mais son envoi n’a pas pu être noté au journal.';
/** MESSAGES_MICROSOFT_365.accesRefuse : Microsoft Graph refuse le jeton (409) ; la tentative suivante passe par la fenêtre. */
export const MESSAGE_ACCES_REFUSE = 'Microsoft 365 refuse l’envoi : reconnectez-vous, ou vérifiez avec votre administrateur le consentement et la boîte aux lettres de votre compte.';
/** ENTETE_JETON_MICROSOFT du serveur : le seul endroit où le jeton part. */
export const ENTETE_JETON_MICROSOFT = 'X-Jeton-Microsoft';
/** Canaux du journal des envois (CANAL_MESSAGERIE et CANAL_MICROSOFT_365 de server/src/domaines/documents/envois.ts). */
export const CANAL_MICROSOFT_365 = 'MICROSOFT_365';
export const CANAL_MESSAGERIE = 'MESSAGERIE';
/** Permissions déléguées du jeton de l'envoi : Mail.Send pour sendMail, User.Read pour le contrôle de l'expéditeur (GET /me). */
export const PERMISSIONS_ENVOI = ['Mail.Send', 'User.Read'];

// Libellés du mode d'envoi des documents (Parametres.modeEnvoi), les mêmes dans l'onglet Modules et dans
// le journal d'administration : c'est le mode, et non le canal, d'où « Messagerie seule ».
export const LIBELLES_MODE_ENVOI: Record<string, string> = {
  MICROSOFT_365: 'Microsoft 365',
  MESSAGERIE: 'Messagerie seule',
};

// --- Textes du dialogue d'envoi (cadrage 6b-2, choix par défaut, à confirmer) ---
export const TEXTE_AIDE_MICROSOFT_365 = 'Envoyer par Microsoft 365 : le courriel part de votre boîte Microsoft, avec le PDF joint, et Iris le note au journal. Préparer l’envoi : votre messagerie s’ouvre avec le courriel prérempli, et vous joignez le PDF à la main.';
export const MESSAGE_ENVOI_EN_COURS = 'Envoi par Microsoft 365 en cours…';
export const MESSAGE_ISSUE_INCONNUE = 'Iris n’a pas reçu la réponse du serveur : le courriel est peut-être parti. Vérifiez vos éléments envoyés dans Outlook, puis rouvrez ce dialogue pour relire le journal des envois, avant de recommencer.';
export const SUITE_PARTI_NON_NOTE = 'Ne le renvoyez pas. Le statut du document n’a pas changé dans Iris.';
export const MESSAGE_FENETRE_ANNULEE = 'Connexion Microsoft annulée : rien n’a été envoyé.';
export const MESSAGE_FENETRE_BLOQUEE = 'La fenêtre Microsoft a été bloquée : autorisez les fenêtres surgissantes pour ce site. Rien n’a été envoyé.';
export const MESSAGE_CONNEXION_IMPOSSIBLE = 'Connexion Microsoft impossible : rien n’a été envoyé. Vous pouvez préparer l’envoi par la messagerie.';
export const NOTE_JOURNAL_ENVOIS = 'Pour la messagerie, Iris ne note que la préparation de l’envoi : il ne sait pas si le courriel est parti.';

export function messageEnvoiFait(destinataire: string, expediteur: string): string {
  return `Courriel envoyé par Microsoft 365 à ${destinataire}, depuis ${expediteur}.`;
}

// --- Classement de la réponse de l'envoi (B2 du contrôle de la version 7 du cadrage) ---
//
// Entrée : { rejet: true } quand fetch est rejeté (aucune réponse), sinon le statut et le corps lu en
// JSON, null s'il n'en est pas. Sortie : la classe 1 à 5, le message à afficher, son rôle, et les
// boutons qui restent proposés jusqu'à la fermeture du dialogue (false : désactivé jusque-là).
//   1. 201 en JSON, avec la ligne du journal et l'expéditeur : envoi fait (role status) ;
//   2. issue inconnue de l'écran : fetch rejeté, corps qui n'est pas du JSON (502 ou 504 de nginx), ou
//      JSON qui ne vient pas de la route (pas d'objet, pas de message d'erreur, 201 sans la ligne) : le
//      serveur a pu envoyer et noter le courriel ;
//   3. 504 en JSON, le cas (b) : le message du serveur, tel quel ;
//   4. 500 en JSON dont le message est exactement MESSAGE_PARTI_NON_NOTE, le cas (c) : ce message, suivi
//      de SUITE_PARTI_NON_NOTE ;
//   5. tout autre statut en JSON avec un message (400, 401, 403, 404, 409, 413, 502, un autre 500) :
//      refus certain, rien n'est parti ; le message du serveur, tel quel.
// Les classes 2 à 5 s'affichent en role alert. Boutons après coup (choix par défaut, à confirmer) :
// après 2 ou 3, seul « Préparer l’envoi » reste proposé ; après 5, les deux ; après 4, aucun, puisque
// le courriel est parti. Après 1, aucun non plus, pour la même raison (le cadrage ne dit rien : choix le
// plus restrictif, à confirmer) : rouvrir le dialogue permet un nouvel envoi.
export type EntreeReponse = { rejet: true } | { statut: number; json: unknown };
export type ClasseReponse = 1 | 2 | 3 | 4 | 5;
export type RoleMessage = 'status' | 'alert';
/** Boutons proposés après un envoi : false, désactivé jusqu'à la fermeture du dialogue. */
export type BoutonsApresEnvoi = { envoyerMicrosoft365: boolean; preparerEnvoi: boolean };
export type IssueEnvoi = { message: string; role: RoleMessage; boutons: BoutonsApresEnvoi };
export type ReponseClassee = IssueEnvoi & { classe: ClasseReponse };

const AUCUN_BOUTON: BoutonsApresEnvoi = { envoyerMicrosoft365: false, preparerEnvoi: false };
const MESSAGERIE_SEULE: BoutonsApresEnvoi = { envoyerMicrosoft365: false, preparerEnvoi: true };
export const DEUX_BOUTONS: BoutonsApresEnvoi = { envoyerMicrosoft365: true, preparerEnvoi: true };

function estObjet(valeur: unknown): valeur is Record<string, unknown> {
  return typeof valeur === 'object' && valeur !== null && !Array.isArray(valeur);
}

const issueInconnue = (): ReponseClassee => ({ classe: 2, message: MESSAGE_ISSUE_INCONNUE, role: 'alert', boutons: { ...MESSAGERIE_SEULE } });

export function classerReponseEnvoi(entree: EntreeReponse): ReponseClassee {
  if ('rejet' in entree) return issueInconnue();
  const { statut, json } = entree;
  if (!estObjet(json)) return issueInconnue();
  if (statut === 201) {
    const envoi = json.envoi;
    const expediteur = typeof json.expediteur === 'string' ? json.expediteur : estObjet(envoi) ? envoi.expediteur : undefined;
    if (!estObjet(envoi) || typeof envoi.destinataire !== 'string' || typeof expediteur !== 'string' || !expediteur) return issueInconnue();
    return { classe: 1, message: messageEnvoiFait(envoi.destinataire, expediteur), role: 'status', boutons: { ...AUCUN_BOUTON } };
  }
  const erreur = typeof json.error === 'string' && json.error.trim() ? json.error : '';
  if (!erreur) return issueInconnue();
  if (statut === 504) return { classe: 3, message: erreur, role: 'alert', boutons: { ...MESSAGERIE_SEULE } };
  if (statut === 500 && erreur === MESSAGE_PARTI_NON_NOTE) return { classe: 4, message: `${MESSAGE_PARTI_NON_NOTE} ${SUITE_PARTI_NON_NOTE}`, role: 'alert', boutons: { ...AUCUN_BOUTON } };
  return { classe: 5, message: erreur, role: 'alert', boutons: { ...DEUX_BOUTONS } };
}

// Après un 409 dont le message est exactement MESSAGE_ACCES_REFUSE, le jeton gardé par MSAL a été refusé
// par Microsoft Graph : la tentative suivante passe directement par la fenêtre (N6, V-N4), et non par le
// cache, qui rendrait le même jeton. Le drapeau vaut pour l'onglet, quel que soit le document : il suit
// la dernière réponse reçue, et une erreur de la fenêtre le laisse en l'état.
export function reponseExigeFenetre(entree: EntreeReponse): boolean {
  return !('rejet' in entree) && entree.statut === 409 && estObjet(entree.json) && entree.json.error === MESSAGE_ACCES_REFUSE;
}

const fenetre = { exigee: false };
export function noterReponseEnvoi(entree: EntreeReponse): void {
  fenetre.exigee = reponseExigeFenetre(entree);
}
export function fenetreExigee(): boolean {
  return fenetre.exigee;
}

// --- Erreurs de la fenêtre Microsoft (rien n'est envoyé) ---
// Codes MSAL repris de Login.tsx. Pour une autre erreur, seul son code suit le message, entre crochets
// comme sur la page de connexion, et seulement s'il a la forme d'un code MSAL : jamais le message de
// l'erreur, ni rien qui puisse porter un jeton (N6).
const FORME_CODE_MSAL = /^[A-Za-z0-9_]{1,64}$/;
export function messageErreurMsal(erreur: unknown): string {
  const code = estObjet(erreur) && typeof erreur.errorCode === 'string' ? erreur.errorCode : '';
  if (code === 'user_cancelled') return MESSAGE_FENETRE_ANNULEE;
  if (code === 'popup_window_error' || code === 'empty_window_error') return MESSAGE_FENETRE_BLOQUEE;
  return FORME_CODE_MSAL.test(code) ? `${MESSAGE_CONNEXION_IMPOSSIBLE} [${code}]` : MESSAGE_CONNEXION_IMPOSSIBLE;
}

// --- Choix du compte MSAL et du jeton ---
// L'adresse d'un compte MSAL est la revendication email de son jeton d'identité, à défaut son username
// (preferred_username) : la règle de la connexion (verifyMicrosoftIdentity, sso.ts), où une revendication
// vide ne compte pas (N1). Le compte retenu est le premier dont l'adresse est celle du compte Iris, sans
// tenir compte de la casse ni des blancs qui l'entourent.
export type CompteMsal = { username: string; idTokenClaims?: object };
export function adresseCompteMsal(compte: CompteMsal): string {
  const email = (compte.idTokenClaims as { email?: unknown } | undefined)?.email;
  if (typeof email === 'string' && email.trim()) return email;
  return typeof compte.username === 'string' ? compte.username : '';
}
export function compteMsalPourAdresse<C extends CompteMsal>(comptes: readonly C[], adresse: string): C | null {
  const cible = adresse.trim().toLowerCase();
  if (!cible) return null;
  return comptes.find((compte) => adresseCompteMsal(compte).trim().toLowerCase() === cible) ?? null;
}

// Suite des tentatives de jeton, testable sans MSAL : ./microsoft365.ts fournit le client.
//   - le compte MSAL de l'adresse du compte Iris, s'il existe et si la fenêtre n'est pas exigée : en
//     silence, sans iframe (cacheLookupPolicy AccessTokenAndRefreshToken, posée par le client) ;
//   - sinon, ou si la recherche en silence échoue, quelle que soit l'erreur (V-N1) : la fenêtre, avec
//     l'adresse du compte Iris pour indice de connexion.
export type ClientJeton<C extends CompteMsal> = {
  comptes: () => readonly C[];
  enSilence: (compte: C) => Promise<string>;
  parFenetre: (adresseCompte: string) => Promise<string>;
};
export async function obtenirJetonAvec<C extends CompteMsal>(client: ClientJeton<C>, adresseCompte: string, { forcerFenetre = false }: { forcerFenetre?: boolean } = {}): Promise<string> {
  const compte = forcerFenetre ? null : compteMsalPourAdresse(client.comptes(), adresseCompte);
  if (compte) {
    try {
      const jeton = await client.enSilence(compte);
      if (jeton) return jeton;
    } catch {
      // Toute erreur en silence mène à la fenêtre : sans iframe, MSAL rend directement celle du jeton
      // de rafraîchissement (InteractionRequiredAuthError, ServerError ou ClientAuthError).
    }
  }
  const jeton = await client.parFenetre(adresseCompte);
  if (!jeton) throw new Error('Jeton Microsoft absent.');
  return jeton;
}

// --- État des boutons du dialogue (B3, V-N8 ; choix par défaut, à confirmer) ---
//   - « Envoyer par Microsoft 365 » n'existe que si proposition.microsoft365 est vrai ;
//   - pendant l'envoi par Microsoft 365 du document (verrou ci-dessous, jeton compris), les deux boutons
//     d'envoi et « Fermer » sont désactivés, y compris dans un dialogue rouvert sur ce document ;
//   - pendant une préparation par la messagerie, les deux boutons d'envoi sont désactivés ;
//   - un destinataire vide désactive les deux boutons d'envoi ;
//   - après un envoi par Microsoft 365, les boutons de BoutonsApresEnvoi restent désactivés jusqu'à la
//     fermeture du dialogue ;
//   - la touche Entrée dans le champ du destinataire ne prépare l'envoi que si Microsoft 365 n'est pas
//     proposé ; sinon, elle ne déclenche rien.
export type EtatDialogueEnvoi = {
  proposition: { microsoft365?: boolean } | null;
  destinataire: string;
  preparationEnCours: boolean;
  envoiEnCours: boolean;
  apresEnvoi: BoutonsApresEnvoi | null;
};
export type EtatBoutonsEnvoi = {
  microsoft365Propose: boolean;
  envoyerMicrosoft365: boolean;
  preparerEnvoi: boolean;
  fermer: boolean;
  entreePrepare: boolean;
};
export function etatBoutonsEnvoi({ proposition, destinataire, preparationEnCours, envoiEnCours, apresEnvoi }: EtatDialogueEnvoi): EtatBoutonsEnvoi {
  const microsoft365Propose = proposition?.microsoft365 === true;
  const libre = !!proposition && !preparationEnCours && !envoiEnCours && !!destinataire.trim();
  return {
    microsoft365Propose,
    envoyerMicrosoft365: microsoft365Propose && libre && (apresEnvoi?.envoyerMicrosoft365 ?? true),
    preparerEnvoi: libre && (apresEnvoi?.preparerEnvoi ?? true),
    fermer: !envoiEnCours,
    entreePrepare: !microsoft365Propose,
  };
}

// Boutons après plusieurs envois dans un même dialogue : un bouton désactivé le reste.
export function cumulerBoutons(avant: BoutonsApresEnvoi | null, apres: BoutonsApresEnvoi): BoutonsApresEnvoi {
  return {
    envoyerMicrosoft365: (avant?.envoyerMicrosoft365 ?? true) && apres.envoyerMicrosoft365,
    preparerEnvoi: (avant?.preparerEnvoi ?? true) && apres.preparerEnvoi,
  };
}

// --- Verrou de l'envoi par Microsoft 365, par document (V-N8) ---
// Tenu au niveau du module, et non du composant : un dialogue démonté pendant l'envoi (autre document
// ouvert, changement de page) puis rouvert sur le même document trouve l'envoi en cours. Le chemin du
// document dans l'API (« /devis/:id », …) l'identifie. La fin de l'envoi est annoncée à chaque dialogue
// ouvert sur ce document, avec son issue : le message, les boutons après coup, et la ligne du journal
// d'un envoi fait.
export type FinEnvoi = IssueEnvoi & { envoi?: EnvoiPrepare };
/** Appelé au début (fin null) et à la fin (fin : son issue) de chaque envoi, avec le chemin du document. */
export type EcouteurEnvois = (chemin: string, fin: FinEnvoi | null) => void;
const cheminsEnCours = new Set<string>();
const ecouteurs = new Set<EcouteurEnvois>();

function annoncer(chemin: string, fin: FinEnvoi | null): void {
  for (const ecouteur of [...ecouteurs]) ecouteur(chemin, fin);
}
/** Prend le verrou du document ; false s'il est déjà pris (un second clic ne part pas). */
export function commencerEnvoi(chemin: string): boolean {
  if (cheminsEnCours.has(chemin)) return false;
  cheminsEnCours.add(chemin);
  annoncer(chemin, null);
  return true;
}
/** Rend le verrou du document, et annonce l'issue de l'envoi aux dialogues ouverts sur lui. */
export function terminerEnvoi(chemin: string, fin?: FinEnvoi): void {
  cheminsEnCours.delete(chemin);
  annoncer(chemin, fin ?? null);
}
export function envoiEnCours(chemin: string): boolean {
  return cheminsEnCours.has(chemin);
}
/** Suit les débuts et fins d'envoi ; rend la fonction qui arrête le suivi. */
export function suivreEnvois(ecouteur: EcouteurEnvois): () => void {
  ecouteurs.add(ecouteur);
  return () => { ecouteurs.delete(ecouteur); };
}

// --- Journal du dialogue (B1) ---
// Une ligne par envoi, selon son canal, au format JJ-MM-AAAA HH:MM dans le fuseau de la société. Ni
// l'empreinte du PDF ni le texte envoyé : le serveur ne les rend pas.
const DATE_HEURE = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' } as const;
export function libelleEnvoi(envoi: Pick<EnvoiPrepare, 'canal' | 'destinataire' | 'auteurNom' | 'createdAt' | 'expediteur'>, fuseau: string): string {
  const date = formatCompanyDateTime(envoi.createdAt, fuseau, DATE_HEURE);
  return envoi.canal === CANAL_MICROSOFT_365
    ? `Envoyé par Microsoft 365 le ${date} à ${envoi.destinataire}, depuis ${envoi.expediteur ?? '—'}, par ${envoi.auteurNom}`
    : `Envoi préparé le ${date} à ${envoi.destinataire} par ${envoi.auteurNom}`;
}
