import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANAL_MESSAGERIE, CANAL_MICROSOFT_365, ENTETE_JETON_MICROSOFT, LIBELLES_MODE_ENVOI, MESSAGE_ACCES_REFUSE, MESSAGE_CONNEXION_IMPOSSIBLE,
  MESSAGE_ENVOI_EN_COURS, MESSAGE_FENETRE_ANNULEE, MESSAGE_FENETRE_BLOQUEE, MESSAGE_ISSUE_INCONNUE, MESSAGE_PARTI_NON_NOTE,
  NOTE_JOURNAL_ENVOIS, PERMISSIONS_ENVOI, SUITE_PARTI_NON_NOTE, TEXTE_AIDE_MICROSOFT_365,
  type ClientJeton, type CompteMsal, type EntreeReponse,
  classerReponseEnvoi, commencerEnvoi, compteMsalPourAdresse, cumulerBoutons, envoiEnCours, etatBoutonsEnvoi, fenetreExigee,
  libelleEnvoi, messageEnvoiFait, messageErreurMsal, noterReponseEnvoi, obtenirJetonAvec, reponseExigeFenetre, suivreEnvois, terminerEnvoi,
} from '../src/lib/envoiMicrosoft365.ts';

// Lot 6b-2, écran de l'envoi des documents par Microsoft 365 (cadrage du lot 6b, version 8, section
// « 6b-2 — Écran », « Tests (6b-2) ») : fonctions pures de lib/envoiMicrosoft365.ts, sans MSAL, React ni
// API (N3). Les textes attendus sont écrits ici en toutes lettres, tels que le cadrage les fixe, et non
// relus dans les constantes du module : une constante mal recopiée fait échouer le test.

// --- Textes du cadrage, mot pour mot ---
const ISSUE_INCONNUE = 'Iris n’a pas reçu la réponse du serveur : le courriel est peut-être parti. Vérifiez vos éléments envoyés dans Outlook, puis rouvrez ce dialogue pour relire le journal des envois, avant de recommencer.';
const NE_PAS_RENVOYER = 'Ne le renvoyez pas. Le statut du document n’a pas changé dans Iris.';
const ANNULEE = 'Connexion Microsoft annulée : rien n’a été envoyé.';
const BLOQUEE = 'La fenêtre Microsoft a été bloquée : autorisez les fenêtres surgissantes pour ce site. Rien n’a été envoyé.';
const IMPOSSIBLE = 'Connexion Microsoft impossible : rien n’a été envoyé. Vous pouvez préparer l’envoi par la messagerie.';

// --- Messages du serveur, relus dans son source ---
// Exception à la règle « un test exécute le code » (server/tests/README.md), comme identite.test.ts : la
// propriété vérifiée est l'identité, au caractère près, de deux textes écrits dans deux codes distincts
// (cadrage : « repris à l'identique dans le client, avec la référence à MESSAGES_MICROSOFT_365 »). Le
// module du serveur ne se charge pas ici (Prisma, Express) : son texte est lu, et le relevé a son témoin.
const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceServeur = readFileSync(path.join(racine, 'server/src/domaines/documents/envoiMicrosoft365.ts'), 'utf8');
const sourceEnvois = readFileSync(path.join(racine, 'server/src/domaines/documents/envois.ts'), 'utf8');
function messagesDuServeur(): Record<string, string> {
  const bloc = /export const MESSAGES_MICROSOFT_365 = \{([\s\S]*?)\n\} as const;/.exec(sourceServeur);
  assert.ok(bloc, 'MESSAGES_MICROSOFT_365 trouvé dans le source du serveur');
  const messages: Record<string, string> = {};
  for (const [, cle, texte] of bloc[1].matchAll(/^\s*(\w+):\s*'([^'\\]*)',\s*$/gm)) messages[cle] = texte;
  return messages;
}
const SERVEUR = messagesDuServeur();

test('témoin du relevé : les dix messages du serveur sont lus, entiers', () => {
  assert.deepEqual(Object.keys(SERVEUR).sort(), ['accesRefuse', 'desactive', 'expediteur', 'incertain', 'injoignable', 'jetonRequis', 'nonConfigure', 'nonNote', 'refuse', 'tropLourd']);
  // Chaque ligne du bloc est relevée : aucune ne lui échappe (une apostrophe droite, un échappement).
  const lignes = /export const MESSAGES_MICROSOFT_365 = \{([\s\S]*?)\n\} as const;/.exec(sourceServeur)![1].split('\n').filter((ligne) => ligne.trim());
  assert.equal(lignes.length, 10);
  assert.equal(SERVEUR.nonNote, 'Le courriel est parti par Microsoft 365, mais son envoi n’a pas pu être noté au journal.');
});

test('les messages repris du serveur le sont au caractère près : cas (c), refus d’accès, en-tête du jeton et canaux', () => {
  // Cadrage 6b-2, classe 4 (« repris à l'identique […] MESSAGES_MICROSOFT_365.nonNote ») et fenêtre
  // forcée (« MESSAGES_MICROSOFT_365.accesRefuse », V-N4).
  assert.equal(MESSAGE_PARTI_NON_NOTE, SERVEUR.nonNote);
  assert.equal(MESSAGE_ACCES_REFUSE, SERVEUR.accesRefuse);
  assert.equal(ENTETE_JETON_MICROSOFT, /export const ENTETE_JETON_MICROSOFT = '([^']+)';/.exec(sourceServeur)?.[1]);
  assert.equal(CANAL_MICROSOFT_365, /export const CANAL_MICROSOFT_365 = '([^']+)'/.exec(sourceEnvois)?.[1]);
  assert.equal(CANAL_MESSAGERIE, /export const CANAL_MESSAGERIE = '([^']+)'/.exec(sourceEnvois)?.[1]);
});

test('textes du dialogue, mot pour mot, avec l’apostrophe typographique', () => {
  assert.equal(TEXTE_AIDE_MICROSOFT_365, 'Envoyer par Microsoft 365 : le courriel part de votre boîte Microsoft, avec le PDF joint, et Iris le note au journal. Préparer l’envoi : votre messagerie s’ouvre avec le courriel prérempli, et vous joignez le PDF à la main.');
  assert.equal(MESSAGE_ENVOI_EN_COURS, 'Envoi par Microsoft 365 en cours…');
  assert.equal(MESSAGE_ISSUE_INCONNUE, ISSUE_INCONNUE);
  assert.equal(SUITE_PARTI_NON_NOTE, NE_PAS_RENVOYER);
  assert.equal(MESSAGE_FENETRE_ANNULEE, ANNULEE);
  assert.equal(MESSAGE_FENETRE_BLOQUEE, BLOQUEE);
  assert.equal(MESSAGE_CONNEXION_IMPOSSIBLE, IMPOSSIBLE);
  assert.equal(NOTE_JOURNAL_ENVOIS, 'Pour la messagerie, Iris ne note que la préparation de l’envoi : il ne sait pas si le courriel est parti.');
  assert.equal(messageEnvoiFait('client@exemple.fr', 'moi@societe.fr'), 'Courriel envoyé par Microsoft 365 à client@exemple.fr, depuis moi@societe.fr.');
  // Permissions déléguées minimales du jeton (cadrage 6b-1b, B1) : aucune autre permission de messagerie.
  assert.deepEqual([...PERMISSIONS_ENVOI].sort(), ['Mail.Send', 'User.Read']);
  // Le mode, et non le canal : « Messagerie seule » (N7).
  assert.deepEqual(LIBELLES_MODE_ENVOI, { MICROSOFT_365: 'Microsoft 365', MESSAGERIE: 'Messagerie seule' });
});

// --- Classement de la réponse de l'envoi (B2, V-N2, V-N3) ---

const JETON = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJodHRwczovL2dyYXBoLm1pY3Jvc29mdC5jb20ifQ.signature-jeton-test';
const envoiFait = (json: Record<string, unknown> = {}): EntreeReponse => ({
  statut: 201,
  json: {
    envoi: { id: 'e1', canal: 'MICROSOFT_365', destinataire: 'client@exemple.fr', objet: 'Devis A26-0001 version 1 – Société', auteurNom: 'Paule Envoi', createdAt: '2026-10-31T23:30:00.000Z', expediteur: 'paule.envoi@societe.fr' },
    objet: 'Devis A26-0001 version 1 – Société', corps: 'Bonjour,', expediteur: 'paule.envoi@societe.fr', statutDevis: 'ENVOYE', ...json,
  },
});
const enJson = (statut: number, error: string): EntreeReponse => ({ statut, json: { error } });

test('classe 1 : un 201 en JSON est un envoi fait, message de succès en role="status" avec le destinataire et l’expéditeur', () => {
  const classee = classerReponseEnvoi(envoiFait());
  assert.equal(classee.classe, 1);
  assert.equal(classee.role, 'status');
  // Destinataire et expéditeur distincts : une inversion se verrait.
  assert.equal(classee.message, 'Courriel envoyé par Microsoft 365 à client@exemple.fr, depuis paule.envoi@societe.fr.');
});

test('classe 2 : fetch rejeté, 504 et 502 en HTML, et 201 dont le corps n’est pas du JSON sont une issue inconnue de l’écran', () => {
  // Le serveur a pu envoyer et noter le courriel (B2) : le message ne dit ni « parti » ni « non noté ».
  for (const entree of [
    { rejet: true },
    { statut: 504, json: null }, // 504 de nginx, en HTML
    { statut: 502, json: null }, // 502 de nginx, en HTML
    { statut: 201, json: null }, // V-N2 : un 201 au corps illisible n'est pas un envoi fait
  ] satisfies EntreeReponse[]) {
    const classee = classerReponseEnvoi(entree);
    assert.equal(classee.classe, 2, JSON.stringify(entree));
    assert.equal(classee.message, ISSUE_INCONNUE);
    assert.equal(classee.role, 'alert');
  }
});

test('classe 3 : un 504 en JSON, cas (b), affiche le message du serveur tel quel', () => {
  const incertain = classerReponseEnvoi(enJson(504, SERVEUR.incertain));
  assert.deepEqual({ classe: incertain.classe, message: incertain.message, role: incertain.role }, { classe: 3, message: SERVEUR.incertain, role: 'alert' });
  // Tout 504 en JSON, et non le seul message (b) connu de l'écran : « Le message du serveur s'affiche tel quel ».
  const autre = classerReponseEnvoi(enJson(504, 'Délai dépassé : réessayez plus tard.'));
  assert.equal(autre.classe, 3);
  assert.equal(autre.message, 'Délai dépassé : réessayez plus tard.');
});

test('classe 4 : seul un 500 en JSON au message exact du serveur est le cas (c), suivi de « Ne le renvoyez pas. »', () => {
  const classee = classerReponseEnvoi(enJson(500, SERVEUR.nonNote));
  assert.equal(classee.classe, 4);
  assert.equal(classee.role, 'alert');
  // Le message du serveur, suivi de la consigne ; seul un blanc les sépare.
  assert.ok(classee.message.startsWith(SERVEUR.nonNote), classee.message);
  assert.ok(classee.message.endsWith(NE_PAS_RENVOYER), classee.message);
  assert.equal(classee.message.slice(SERVEUR.nonNote.length, classee.message.length - NE_PAS_RENVOYER.length).trim(), '');
  // « exactement » : un autre texte, même voisin (apostrophe droite), ou un autre statut, n'est pas (c).
  assert.equal(classerReponseEnvoi(enJson(500, SERVEUR.nonNote.replace('’', "'"))).classe, 5);
  assert.equal(classerReponseEnvoi(enJson(409, SERVEUR.nonNote)).classe, 5);
  assert.equal(classerReponseEnvoi(enJson(504, SERVEUR.nonNote)).classe, 3);
});

test('classe 5 : tout autre statut en JSON est un refus certain, message du serveur tel quel (500 « Opération devis impossible. », 404, 409, 413, 502…)', () => {
  for (const [statut, message] of [
    [500, 'Opération devis impossible.'],
    [404, 'Devis introuvable.'],
    [409, SERVEUR.desactive],
    [409, SERVEUR.accesRefuse],
    [413, SERVEUR.tropLourd],
    [502, SERVEUR.refuse], // 502 en JSON : refus de Microsoft 365, et non une page de nginx
    [502, SERVEUR.injoignable],
    [400, SERVEUR.jetonRequis],
    [403, SERVEUR.expediteur],
  ] as const) {
    const classee = classerReponseEnvoi(enJson(statut, message));
    assert.deepEqual({ classe: classee.classe, message: classee.message, role: classee.role }, { classe: 5, message, role: 'alert' }, `${statut} ${message}`);
  }
});

test('états des boutons après chaque classe : 2 et 3 gardent la messagerie, 4 n’en garde aucun, 5 garde les deux', () => {
  // Cadrage 6b-2, « État des boutons après la réponse » (choix par défaut, à confirmer).
  const apres = (entree: EntreeReponse) => classerReponseEnvoi(entree).boutons;
  const messagerieSeule = { envoyerMicrosoft365: false, preparerEnvoi: true };
  // Après la classe 1, le cadrage ne dit rien : le code garde les deux boutons désactivés jusqu'à la
  // fermeture du dialogue, le courriel étant parti (choix le plus restrictif du code, déclaré à confirmer).
  assert.deepEqual(apres(envoiFait()), { envoyerMicrosoft365: false, preparerEnvoi: false });
  assert.deepEqual(apres({ rejet: true }), messagerieSeule);
  assert.deepEqual(apres({ statut: 504, json: null }), messagerieSeule);
  assert.deepEqual(apres(enJson(504, SERVEUR.incertain)), messagerieSeule);
  assert.deepEqual(apres(enJson(500, SERVEUR.nonNote)), { envoyerMicrosoft365: false, preparerEnvoi: false });
  assert.deepEqual(apres(enJson(500, 'Opération devis impossible.')), { envoyerMicrosoft365: true, preparerEnvoi: true });
  assert.deepEqual(apres(enJson(404, 'Devis introuvable.')), { envoyerMicrosoft365: true, preparerEnvoi: true });
  // Un bouton désactivé le reste jusqu'à la fermeture du dialogue (N9), même après un refus certain.
  assert.deepEqual(cumulerBoutons(apres(enJson(504, SERVEUR.incertain)), apres(enJson(409, SERVEUR.desactive))), messagerieSeule);
  assert.deepEqual(cumulerBoutons(null, apres(enJson(409, SERVEUR.desactive))), { envoyerMicrosoft365: true, preparerEnvoi: true });
});

test('aucun jeton dans un message : ni le corps d’une réponse, ni l’erreur de la fenêtre Microsoft n’en font paraître', () => {
  const messages = [
    classerReponseEnvoi(envoiFait({ jeton: JETON, accessToken: JETON })).message,
    classerReponseEnvoi({ statut: 504, json: { error: SERVEUR.incertain, jeton: JETON } }).message,
    classerReponseEnvoi({ statut: 200, json: { jeton: JETON } }).message,
    messageErreurMsal({ errorCode: 'invalid_grant', errorMessage: `AADSTS70000: jeton refusé ${JETON}`, accessToken: JETON }),
    messageErreurMsal({ errorCode: JETON, errorMessage: JETON }),
    messageErreurMsal(new Error(`Bearer ${JETON}`)),
  ];
  for (const message of messages) {
    assert.ok(!message.includes(JETON), message);
    assert.ok(!message.includes('eyJ'), message);
    assert.ok(!message.includes('AADSTS'), message);
  }
});

// --- Fenêtre forcée après un refus d'accès (N6, V-N4) ---

test('seul le 409 au message exact du refus d’accès fait passer la tentative suivante par la fenêtre', () => {
  assert.equal(reponseExigeFenetre(enJson(409, SERVEUR.accesRefuse)), true);
  // D'autres 409 existent : désactivé, non configuré, refus du document, identité.
  assert.equal(reponseExigeFenetre(enJson(409, SERVEUR.desactive)), false);
  assert.equal(reponseExigeFenetre(enJson(409, SERVEUR.nonConfigure)), false);
  assert.equal(reponseExigeFenetre(enJson(409, SERVEUR.accesRefuse.replace('’', "'"))), false);
  assert.equal(reponseExigeFenetre(enJson(403, SERVEUR.accesRefuse)), false);
  assert.equal(reponseExigeFenetre({ rejet: true }), false);
  assert.equal(reponseExigeFenetre({ statut: 409, json: null }), false);
  // La dernière réponse reçue décide.
  noterReponseEnvoi(enJson(409, SERVEUR.accesRefuse));
  assert.equal(fenetreExigee(), true);
  noterReponseEnvoi(envoiFait());
  assert.equal(fenetreExigee(), false);
});

// --- États des boutons selon la proposition et l'envoi en cours (B1, B3) ---

test('Microsoft 365 non proposé : pas de bouton Microsoft 365, la messagerie et la touche Entrée préparent l’envoi comme avant', () => {
  for (const proposition of [{ microsoft365: false }, {}]) {
    const etat = etatBoutonsEnvoi({ proposition, destinataire: 'client@exemple.fr', preparationEnCours: false, envoiEnCours: false, apresEnvoi: null });
    assert.deepEqual(etat, { microsoft365Propose: false, envoyerMicrosoft365: false, preparerEnvoi: true, fermer: true, entreePrepare: true });
  }
});

test('Microsoft 365 proposé : les deux boutons, et la touche Entrée ne déclenche rien', () => {
  const etat = etatBoutonsEnvoi({ proposition: { microsoft365: true }, destinataire: 'client@exemple.fr', preparationEnCours: false, envoiEnCours: false, apresEnvoi: null });
  assert.deepEqual(etat, { microsoft365Propose: true, envoyerMicrosoft365: true, preparerEnvoi: true, fermer: true, entreePrepare: false });
});

test('pendant l’envoi par Microsoft 365, jeton compris : les deux boutons et « Fermer » sont désactivés', () => {
  const etat = etatBoutonsEnvoi({ proposition: { microsoft365: true }, destinataire: 'client@exemple.fr', preparationEnCours: false, envoiEnCours: true, apresEnvoi: null });
  assert.deepEqual(etat, { microsoft365Propose: true, envoyerMicrosoft365: false, preparerEnvoi: false, fermer: false, entreePrepare: false });
});

test('après chaque classe, le dialogue suit les boutons du cadrage ; un destinataire vide ou une proposition absente ne laissent rien partir', () => {
  const etat = (entree: EntreeReponse) => etatBoutonsEnvoi({ proposition: { microsoft365: true }, destinataire: 'client@exemple.fr', preparationEnCours: false, envoiEnCours: false, apresEnvoi: classerReponseEnvoi(entree).boutons });
  const boutons = (entree: EntreeReponse) => { const { envoyerMicrosoft365, preparerEnvoi, fermer } = etat(entree); return { envoyerMicrosoft365, preparerEnvoi, fermer }; };
  assert.deepEqual(boutons({ rejet: true }), { envoyerMicrosoft365: false, preparerEnvoi: true, fermer: true });
  assert.deepEqual(boutons({ statut: 504, json: null }), { envoyerMicrosoft365: false, preparerEnvoi: true, fermer: true });
  assert.deepEqual(boutons(enJson(504, SERVEUR.incertain)), { envoyerMicrosoft365: false, preparerEnvoi: true, fermer: true });
  assert.deepEqual(boutons(enJson(500, SERVEUR.nonNote)), { envoyerMicrosoft365: false, preparerEnvoi: false, fermer: true });
  assert.deepEqual(boutons(enJson(502, SERVEUR.refuse)), { envoyerMicrosoft365: true, preparerEnvoi: true, fermer: true });
  // Destinataire blanc, proposition non lue, préparation par la messagerie en cours : aucun envoi.
  for (const sansEnvoi of [
    { proposition: { microsoft365: true }, destinataire: '   ', preparationEnCours: false, envoiEnCours: false, apresEnvoi: null },
    { proposition: null, destinataire: 'client@exemple.fr', preparationEnCours: false, envoiEnCours: false, apresEnvoi: null },
    { proposition: { microsoft365: true }, destinataire: 'client@exemple.fr', preparationEnCours: true, envoiEnCours: false, apresEnvoi: null },
  ]) {
    const { envoyerMicrosoft365, preparerEnvoi } = etatBoutonsEnvoi(sansEnvoi);
    assert.deepEqual({ envoyerMicrosoft365, preparerEnvoi }, { envoyerMicrosoft365: false, preparerEnvoi: false }, JSON.stringify(sansEnvoi));
  }
});

// --- Verrou par document, au niveau du module (V-N8) ---

test('le verrou est tenu par document, au niveau du module : un second envoi du même document ne part pas, un autre document reste libre', async () => {
  const premier = `/devis/verrou-${Date.now()}`;
  const second = `/factures/verrou-${Date.now()}`;
  const annonces: [string, unknown][] = [];
  const arreter = suivreEnvois((chemin, fin) => { if (chemin === premier) annonces.push([chemin, fin]); });
  try {
    assert.equal(envoiEnCours(premier), false);
    assert.equal(commencerEnvoi(premier), true);
    assert.equal(envoiEnCours(premier), true);
    assert.equal(commencerEnvoi(premier), false, 'un second clic sur le même document ne part pas');
    assert.equal(envoiEnCours(second), false);
    assert.equal(commencerEnvoi(second), true, 'un autre document reste libre');
    // Le verrou survit au démontage du dialogue : le module, rechargé par un autre import, le voit.
    const module = await import('../src/lib/envoiMicrosoft365.ts');
    assert.equal(module.envoiEnCours(premier), true);
    const fin = { message: 'Courriel envoyé par Microsoft 365 à client@exemple.fr, depuis moi@societe.fr.', role: 'status' as const, boutons: { envoyerMicrosoft365: false, preparerEnvoi: false } };
    terminerEnvoi(premier, fin);
    assert.equal(envoiEnCours(premier), false);
    assert.equal(envoiEnCours(second), true);
    assert.equal(commencerEnvoi(premier), true, 'après la réponse, le document peut de nouveau partir');
    terminerEnvoi(premier);
    // Les dialogues ouverts sur le document apprennent le début et la fin de l'envoi, avec son issue.
    assert.deepEqual(annonces, [[premier, null], [premier, fin], [premier, null], [premier, null]]);
    arreter();
    commencerEnvoi(premier);
    terminerEnvoi(premier);
    assert.equal(annonces.length, 4, 'un dialogue fermé n’est plus prévenu');
  } finally {
    arreter();
    terminerEnvoi(premier);
    terminerEnvoi(second);
  }
});

// --- Journal du dialogue (B1) ---

test('une ligne du journal se lit selon son canal, en JJ-MM-AAAA HH:MM au fuseau de la société', () => {
  // 31-10-2026 23:30 UTC : le 01-11-2026 00:30 à Paris, le 31-10-2026 19:30 à New York ; test:unit tourne
  // en Pacific/Gambier (UTC−9), troisième lecture qui donnerait 31-10-2026 14:30.
  const microsoft365 = { canal: 'MICROSOFT_365', destinataire: 'client@exemple.fr', auteurNom: 'Paule Envoi', createdAt: '2026-10-31T23:30:00.000Z', expediteur: 'paule.envoi@societe.fr' };
  assert.equal(libelleEnvoi(microsoft365, 'Europe/Paris'), 'Envoyé par Microsoft 365 le 01-11-2026 00:30 à client@exemple.fr, depuis paule.envoi@societe.fr, par Paule Envoi');
  assert.equal(libelleEnvoi(microsoft365, 'America/New_York'), 'Envoyé par Microsoft 365 le 31-10-2026 19:30 à client@exemple.fr, depuis paule.envoi@societe.fr, par Paule Envoi');
  const messagerie = { canal: 'MESSAGERIE', destinataire: 'achats@exemple.fr', auteurNom: 'Marc Messagerie', createdAt: '2026-10-30T08:05:00.000Z', expediteur: null };
  assert.equal(libelleEnvoi(messagerie, 'Europe/Paris'), 'Envoi préparé le 30-10-2026 09:05 à achats@exemple.fr par Marc Messagerie');
});

// --- Erreurs de la fenêtre Microsoft ---

test('erreurs de la fenêtre Microsoft : annulation, fenêtre bloquée, et toute autre erreur par son seul code', () => {
  assert.equal(messageErreurMsal({ errorCode: 'user_cancelled', errorMessage: 'User cancelled the flow.' }), ANNULEE);
  assert.equal(messageErreurMsal({ errorCode: 'popup_window_error', errorMessage: 'Error opening popup window.' }), BLOQUEE);
  assert.equal(messageErreurMsal({ errorCode: 'empty_window_error', errorMessage: 'window.open returned null.' }), BLOQUEE);
  // Autre erreur : le texte, puis le code seul, sans le message de MSAL (N6, plus restrictif que Login.tsx).
  for (const code of ['interaction_required', 'invalid_grant', 'monitor_window_timeout']) {
    const message = messageErreurMsal({ errorCode: code, errorMessage: `AADSTS65001: The user or administrator has not consented (${code}).` });
    assert.ok(message.startsWith(IMPOSSIBLE), message);
    const suite = message.slice(IMPOSSIBLE.length);
    assert.ok(suite.includes(code), message);
    assert.match(suite.replace(code, ''), /^[\s[\]():]*$/, message);
  }
  // Sans code (connexion non configurée, erreur quelconque) : le texte seul.
  assert.equal(messageErreurMsal(new Error('Connexion Microsoft non configurée.')), IMPOSSIBLE);
  assert.equal(messageErreurMsal(undefined), IMPOSSIBLE);
});

// --- Choix du compte MSAL et chemin du jeton (N1, N2, V-N1) ---

test('le compte MSAL se choisit par son adresse, la revendication email d’abord, à défaut username, sans tenir compte de la casse', () => {
  // A : UPN différent, email = l'adresse du compte Iris dans une autre casse. B : username = l'adresse
  // du compte Iris, mais son email en est une autre. La règle de la connexion (sso.ts) retient A.
  const a: CompteMsal = { username: 'upn.distinct@locataire.onmicrosoft.com', idTokenClaims: { email: 'Paule.Envoi@Societe.FR' } };
  const b: CompteMsal = { username: 'paule.envoi@societe.fr', idTokenClaims: { email: 'autre.boite@societe.fr' } };
  assert.equal(compteMsalPourAdresse([b, a], 'paule.envoi@societe.fr'), a);
  assert.equal(compteMsalPourAdresse([b, a], 'PAULE.ENVOI@societe.fr'), a);
  // Sans revendication email, ou avec une revendication vide (la connexion la tient pour absente) : username.
  const c: CompteMsal = { username: 'Jean.Technique@Societe.fr', idTokenClaims: {} };
  const d: CompteMsal = { username: 'marc@societe.fr', idTokenClaims: { email: '' } };
  const e: CompteMsal = { username: 'lea@societe.fr' };
  assert.equal(compteMsalPourAdresse([a, c, d, e], 'jean.technique@societe.fr'), c);
  assert.equal(compteMsalPourAdresse([a, c, d, e], 'marc@societe.fr'), d);
  assert.equal(compteMsalPourAdresse([a, c, d, e], 'lea@societe.fr'), e);
  // Aucun compte de cette adresse, ou une adresse vide : aucun compte, jamais le premier venu.
  assert.equal(compteMsalPourAdresse([a, b, c], 'inconnu@societe.fr'), null);
  assert.equal(compteMsalPourAdresse([a, b, c], ''), null);
  assert.equal(compteMsalPourAdresse([], 'paule.envoi@societe.fr'), null);
});

type Compte = CompteMsal & { nom: string };
function clientSimule(comptes: Compte[], { silence, fenetre }: { silence: () => Promise<string>; fenetre: () => Promise<string> }) {
  const appels: string[] = [];
  const client: ClientJeton<Compte> = {
    comptes: () => comptes,
    enSilence: async (compte) => { appels.push(`silence:${compte.nom}`); return silence(); },
    parFenetre: async (adresse) => { appels.push(`fenetre:${adresse}`); return fenetre(); },
  };
  return { client, appels };
}
const compteIris: Compte = { nom: 'paule', username: 'upn@locataire.onmicrosoft.com', idTokenClaims: { email: 'paule.envoi@societe.fr' } };
const autreCompte: Compte = { nom: 'autre', username: 'autre@societe.fr', idTokenClaims: { email: 'autre@societe.fr' } };
const erreurMsal = (name: string, errorCode: string) => Object.assign(new Error(errorCode), { name, errorCode });

test('jeton : en silence pour le compte de l’adresse Iris, sans fenêtre quand le cache répond', async () => {
  const { client, appels } = clientSimule([autreCompte, compteIris], { silence: async () => 'jeton-silence', fenetre: async () => 'jeton-fenetre' });
  assert.equal(await obtenirJetonAvec(client, 'Paule.Envoi@societe.fr'), 'jeton-silence');
  assert.deepEqual(appels, ['silence:paule']);
});

test('jeton : la recherche en silence échoue, quelle que soit l’erreur, et la fenêtre s’ouvre avec l’adresse du compte Iris', async () => {
  // V-N1 : sans iframe, MSAL rend directement l'erreur du jeton de rafraîchissement, qui n'est pas
  // toujours une InteractionRequiredAuthError.
  for (const erreur of [
    erreurMsal('InteractionRequiredAuthError', 'interaction_required'),
    erreurMsal('ServerError', 'invalid_grant'),
    erreurMsal('ClientAuthError', 'token_refresh_required'),
    new TypeError('Failed to fetch'),
  ]) {
    const { client, appels } = clientSimule([compteIris], { silence: async () => { throw erreur; }, fenetre: async () => 'jeton-fenetre' });
    assert.equal(await obtenirJetonAvec(client, 'paule.envoi@societe.fr'), 'jeton-fenetre', erreur.name);
    assert.deepEqual(appels, ['silence:paule', 'fenetre:paule.envoi@societe.fr'], erreur.name);
  }
});

test('jeton : sans compte de cette adresse, ou fenêtre forcée après un refus d’accès, directement par la fenêtre', async () => {
  const sansCompte = clientSimule([autreCompte], { silence: async () => 'jeton-silence', fenetre: async () => 'jeton-fenetre' });
  assert.equal(await obtenirJetonAvec(sansCompte.client, 'paule.envoi@societe.fr'), 'jeton-fenetre');
  assert.deepEqual(sansCompte.appels, ['fenetre:paule.envoi@societe.fr']);
  const force = clientSimule([compteIris], { silence: async () => 'jeton-silence-refuse', fenetre: async () => 'jeton-fenetre' });
  assert.equal(await obtenirJetonAvec(force.client, 'paule.envoi@societe.fr', { forcerFenetre: true }), 'jeton-fenetre');
  assert.deepEqual(force.appels, ['fenetre:paule.envoi@societe.fr']);
});

test('jeton : l’erreur de la fenêtre remonte telle quelle, pour être traduite par son code', async () => {
  const annulee = erreurMsal('BrowserAuthError', 'user_cancelled');
  const { client } = clientSimule([], { silence: async () => 'jeton-silence', fenetre: async () => { throw annulee; } });
  await assert.rejects(obtenirJetonAvec(client, 'paule.envoi@societe.fr'), (erreur) => erreur === annulee);
  assert.equal(messageErreurMsal(annulee), ANNULEE);
});
