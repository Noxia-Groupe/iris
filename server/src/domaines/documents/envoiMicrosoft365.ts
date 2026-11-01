import { createHash, randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { transactionVerifiee } from '../../db';
import type { AuthRequest } from '../../http/auth';
import { normalizeEmail } from '../authentification/sso';
import { estRefusPdf } from './productionPdf';
import {
  CANAL_MESSAGERIE, CANAL_MICROSOFT_365, type CanalEnvoi, type DocumentAEnvoyer, type EnvoiPrepare, type IssueEnvoi,
  enregistrerEnvoi, envoyerParMessagerie, estRefusEnvoi, refusEnvoi,
} from './envois';
import { type RefusGraph, TAILLE_MAX_REQUETE_ENVOI, adresseGraph, connexionMicrosoftConfiguree, envoyerSendMail, lireBoiteMicrosoft, requeteSendMail } from './microsoftGraph';

// --- Envoi d'un document par Microsoft 365 (lot 6b-1b, choix par défaut, à confirmer) ---
//
// Iris produit lui-même le PDF (production commune du lot 6b-1a, jamais un fichier fourni par le
// navigateur) et l'envoie depuis la boîte Microsoft de l'utilisateur connecté, par Microsoft Graph
// (./microsoftGraph.ts), avec le jeton délégué (Mail.Send, User.Read) que son navigateur transmet dans
// l'en-tête X-Jeton-Microsoft. Le jeton ne sert qu'à cette requête : il n'est gardé ni en base, ni au
// journal, ni dans une trace, et n'est jamais rendu. Les cinq routes d'envoi (devis, facture ou avoir,
// compte rendu, contrat de maintenance, rapport de chantier) le proposent avec `canal: MICROSOFT_365`,
// sous leurs gardes et leurs droits inchangés.
//
// Ordre des contrôles. Ceux de l'envoi par la messagerie d'abord, inchangés : gardes (401, 403) ;
// destinataire invalide ou canal inconnu (400) ; puis, dans la transaction 1, introuvable ou hors
// périmètre (404), annulé (409), refus propres au document (409), identité de la société incomplète
// (409). Ensuite, pour Microsoft 365 seulement :
//   1. connexion Microsoft non configurée (AZURE_TENANT_ID ou AZURE_CLIENT_ID vides), ou
//      MICROSOFT_GRAPH_URL non admise, lues à l'appel : 409 « L’envoi par Microsoft 365 n’est pas
//      configuré : … » (message choisi par Claude Code, que le cadrage laisse ouvert : choix par
//      défaut, à confirmer), puis mode d'envoi MESSAGERIE : 409 « … est désactivé : … » ;
//   2. jeton absent ou vide : 400 ;
//   3. verdict de GET /me : 502 (Graph ne répond pas : délai, coupure, 5xx), 409 (401 ou 403 de
//      Graph), 502 (autre 4xx), ou 403 si la boîte (mail, à défaut userPrincipalName) n'est pas
//      l'adresse du compte Iris de la session, sans tenir compte de la casse : même règle d'adresse
//      que la connexion, sous réserve de #264 ;
//   4. refus de la lecture du PDF (possible seulement par une écriture concurrente) : 409, avec son
//      message ;
//   5. corps de sendMail de plus de 4 000 000 octets : 413.
// La configuration et le jeton sont examinés dès le début : GET /me n'est appelé ni sans eux. Il est
// appelé avant la transaction 1, et son verdict n'est rendu qu'à sa place ci-dessus.
//
// Déroulement : Microsoft Graph est toujours appelé hors transaction, sans connexion ni verrou tenus.
//   - GET /me (10 s) ;
//   - transaction 1, en READ COMMITTED (10 s) : la préparation de l'envoi (verrous, relectures et refus
//     de la messagerie), le mode d'envoi, l'expéditeur, puis la lecture du PDF, sans rien écrire.
//     Limite déclarée (choix par défaut, à confirmer) : la route « PDF » lit en REPEATABLE READ ; ici,
//     un compte rendu ou une identité enregistrés pendant la lecture peuvent entrer dans le PDF ;
//   - rendu du PDF hors transaction, empreinte SHA-256, contrôle de taille ;
//   - POST /me/sendMail (25 s), avec l'identifiant de la future ligne du journal en en-tête x-iris-envoi ;
//   - transaction 2, après le 202 (5 s) : la ligne du journal, avec ce que le document y ajoute (devis :
//     verrou, statut relu, « envoyé » s'il est encore brouillon). Les refus n'y sont pas appliqués de
//     nouveau : le courriel est parti, le journal doit le dire, même si le document a été annulé
//     entre-temps.
//
// Échecs : aucun ne doit pousser l'utilisateur à renvoyer un courriel déjà parti.
//   (a) refus certain, avant ou par Graph : rien n'est parti ni noté (messages ci-dessous) ;
//   (b) sendMail sans issue connue (délai, coupure, 5xx) : 504, rien n'est noté, l'utilisateur vérifie
//       ses éléments envoyés avant de recommencer ;
//   (c) 202, puis échec de la transaction 2 : 500, le message dit que le courriel est parti, et une
//       trace serveur donne l'identifiant x-iris-envoi, sans jeton ni texte.

export const ENTETE_JETON_MICROSOFT = 'X-Jeton-Microsoft';

export const MESSAGES_MICROSOFT_365 = {
  nonConfigure: 'L’envoi par Microsoft 365 n’est pas configuré : préparez l’envoi par la messagerie.',
  desactive: 'L’envoi par Microsoft 365 est désactivé : préparez l’envoi par la messagerie.',
  jetonRequis: 'Connexion Microsoft 365 requise pour cet envoi.',
  expediteur: 'Le compte Microsoft ne correspond pas à votre compte Iris.',
  tropLourd: 'Le PDF dépasse la taille d’envoi par Microsoft 365 : préparez l’envoi par la messagerie.',
  injoignable: 'Microsoft 365 ne répond pas : rien n’a été envoyé ni noté. Vous pouvez préparer l’envoi par la messagerie.',
  accesRefuse: 'Microsoft 365 refuse l’envoi : reconnectez-vous, ou vérifiez avec votre administrateur le consentement et la boîte aux lettres de votre compte.',
  refuse: 'Microsoft 365 a refusé l’envoi ; rien n’a été envoyé ni noté. Vous pouvez préparer l’envoi par la messagerie.',
  incertain: 'Microsoft 365 n’a pas confirmé l’envoi : il n’est pas noté. Vérifiez vos éléments envoyés dans Outlook avant de recommencer.',
  nonNote: 'Le courriel est parti par Microsoft 365, mais son envoi n’a pas pu être noté au journal.',
} as const;

// Mode d'envoi des documents (Parametres.modeEnvoi) : MICROSOFT_365 par défaut (décision A10), ou
// MESSAGERIE, qui refuse l'envoi par Microsoft 365. Sans ligne de paramètres, la valeur par défaut.
export const MODES_ENVOI: readonly CanalEnvoi[] = [CANAL_MICROSOFT_365, CANAL_MESSAGERIE];
export async function lireModeEnvoi(tx: Prisma.TransactionClient): Promise<string> {
  const parametres = await tx.parametres.findUnique({ where: { id: 'singleton' }, select: { modeEnvoi: true } });
  return parametres?.modeEnvoi ?? CANAL_MICROSOFT_365;
}

// Adresse de Microsoft Graph si l'envoi par Microsoft 365 est configuré (connexion Microsoft et
// MICROSOFT_GRAPH_URL admise, lues à l'appel), sinon null.
function adresseEnvoiMicrosoft365(): string | null {
  return connexionMicrosoftConfiguree() ? adresseGraph() : null;
}

// Proposition de l'écran (GET …/envois) : vrai seulement si le mode est MICROSOFT_365, la connexion
// Microsoft configurée et MICROSOFT_GRAPH_URL admise. La messagerie reste proposée dans tous les cas.
export async function propositionMicrosoft365(tx: Prisma.TransactionClient): Promise<boolean> {
  return !!adresseEnvoiMicrosoft365() && await lireModeEnvoi(tx) === CANAL_MICROSOFT_365;
}

// Jeton de l'en-tête X-Jeton-Microsoft, sans les blancs qui l'entourent. Un jeton d'accès ne contient que
// des caractères ASCII visibles : toute autre valeur (en-tête répété, espace, caractère de contrôle) est
// traitée comme un jeton absent, et n'est jamais transmise.
function jetonMicrosoft(req: AuthRequest): string {
  const valeur = req.get(ENTETE_JETON_MICROSOFT)?.trim() ?? '';
  return /^[\x21-\x7e]+$/.test(valeur) ? valeur : '';
}

function refusDeGraph(refus: RefusGraph | 'INJOIGNABLE' | 'INCERTAIN') {
  switch (refus) {
    case 'ACCES_REFUSE': return refusEnvoi(409, MESSAGES_MICROSOFT_365.accesRefuse);
    case 'REFUSE': return refusEnvoi(502, MESSAGES_MICROSOFT_365.refuse);
    case 'INJOIGNABLE': return refusEnvoi(502, MESSAGES_MICROSOFT_365.injoignable);
    case 'INCERTAIN': return refusEnvoi(504, MESSAGES_MICROSOFT_365.incertain);
  }
}

// Trace d'une erreur de la transaction 2 : son nom et son code seulement. Le message d'une contrainte
// de la base reprend la ligne refusée, texte envoyé compris.
function descriptionErreur(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${error.name} ${code}` : error.name;
}

export async function envoyerParMicrosoft365<P extends EnvoiPrepare, L>(req: AuthRequest, destinataire: string, document: DocumentAEnvoyer<P, L>): Promise<IssueEnvoi> {
  const auteur = req.user!;
  const adresse = adresseEnvoiMicrosoft365();
  const jeton = jetonMicrosoft(req);
  const boite = adresse && jeton ? await lireBoiteMicrosoft(adresse, jeton) : null;
  if (boite && 'refus' in boite) console.warn(`[ENVOI MICROSOFT 365] Lecture de la boîte impossible : ${boite.cause}.`);

  const lecture = await transactionVerifiee(async (tx) => {
    const prepare = await document.preparer(tx);
    if (estRefusEnvoi(prepare)) return prepare;
    if (!adresse) return refusEnvoi(409, MESSAGES_MICROSOFT_365.nonConfigure);
    if (await lireModeEnvoi(tx) !== CANAL_MICROSOFT_365) return refusEnvoi(409, MESSAGES_MICROSOFT_365.desactive);
    if (!boite) return refusEnvoi(400, MESSAGES_MICROSOFT_365.jetonRequis);
    if ('refus' in boite) return refusDeGraph(boite.refus);
    // L'adresse du compte Iris est relue en base : la session n'en porte pas.
    const compte = await tx.user.findUnique({ where: { id: auteur.id }, select: { email: true } });
    const expediteur = normalizeEmail(boite.adresse);
    if (!expediteur || expediteur !== normalizeEmail(compte?.email)) return refusEnvoi(403, MESSAGES_MICROSOFT_365.expediteur);
    const lu = await document.lirePdf(tx, prepare);
    if (estRefusPdf(lu)) return refusEnvoi(409, lu.error);
    return { prepare, lu, expediteur: boite.adresse };
  }, { isolationLevel: 'ReadCommitted', timeout: 10_000 });
  if (estRefusEnvoi(lecture)) return lecture;

  const { prepare, lu, expediteur } = lecture;
  const { pdf, nomFichier } = await document.rendrePdf(lu);
  const empreintePdf = createHash('sha256').update(pdf).digest('hex');
  // Identifiant de la future ligne du journal (EnvoiDocument.id, un UUID), porté par l'en-tête
  // x-iris-envoi du courriel.
  const identifiant = randomUUID();
  const requete = requeteSendMail({ identifiant, destinataire, objet: prepare.objet, corps: prepare.corps, nomFichier, pdf });
  if (Buffer.byteLength(requete, 'utf8') > TAILLE_MAX_REQUETE_ENVOI) return refusEnvoi(413, MESSAGES_MICROSOFT_365.tropLourd);

  const envoi = await envoyerSendMail(adresse!, jeton, requete);
  if (envoi.issue !== 'ENVOYE') {
    console.warn(`[ENVOI MICROSOFT 365] Envoi x-iris-envoi ${identifiant} non confirmé (${envoi.issue}) : ${envoi.cause}.`);
    return refusDeGraph(envoi.issue);
  }

  try {
    const reponse = await transactionVerifiee(async (tx) => {
      const complement = await document.completer?.(tx, prepare);
      const ligne = await enregistrerEnvoi(tx, prepare.journal, { destinataire, objet: prepare.objet }, auteur, { id: identifiant, expediteur, empreintePdf, corps: prepare.corps });
      return { envoi: ligne, objet: prepare.objet, corps: prepare.corps, expediteur, ...complement };
    }, { timeout: 5_000 });
    return { statut: 201, reponse };
  } catch (error) {
    console.error(`[ENVOI MICROSOFT 365] Courriel parti (x-iris-envoi ${identifiant}), mais envoi non noté au journal : ${descriptionErreur(error)}.`);
    return refusEnvoi(500, MESSAGES_MICROSOFT_365.nonNote);
  }
}

// Envoi par le canal de la requête : la messagerie, ou Microsoft 365.
export function envoyerDocument<P extends EnvoiPrepare, L>(
  req: AuthRequest, demande: { destinataire: string; canal: CanalEnvoi }, document: DocumentAEnvoyer<P, L>,
): Promise<IssueEnvoi> {
  return demande.canal === CANAL_MICROSOFT_365
    ? envoyerParMicrosoft365(req, demande.destinataire, document)
    : envoyerParMessagerie(req.user!, demande.destinataire, document);
}
