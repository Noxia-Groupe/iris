import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Mail, Send } from 'lucide-react';
import { apiFetch } from '../api';
import { useCompanyTimezone } from '../companyTimezoneContext';
import { telechargerPdf } from '../lib/documentPdf';
import { lienMessagerie, type EnvoiEnregistre, type EnvoiPrepare, type PropositionEnvoi } from '../lib/envoiDocument';
import {
  DEUX_BOUTONS, MESSAGE_ENVOI_EN_COURS, MESSAGE_ISSUE_INCONNUE, NOTE_JOURNAL_ENVOIS, TEXTE_AIDE_MICROSOFT_365,
  type BoutonsApresEnvoi, type FinEnvoi, type IssueEnvoi,
  classerReponseEnvoi, commencerEnvoi, cumulerBoutons, envoiEnCours, etatBoutonsEnvoi, fenetreExigee, libelleEnvoi,
  noterReponseEnvoi, suivreEnvois, terminerEnvoi,
} from '../lib/envoiMicrosoft365';
import { chargerMicrosoft365, envoyerParMicrosoft365 } from '../lib/microsoft365';
import { getCurrentUser } from '../roles';

export type DocumentAEnvoyer = {
  // Désignation du document dans les libellés : « le devis A26-0001 version 1 », « la facture
  // F2026-0001 », « l’avoir A2026-0001 », « le compte rendu de l’intervention I26-0001 », « le contrat
  // de maintenance Maintenance SSI », « le rapport de chantier Résidence Les Tilleuls ».
  libelle: string;
  // Chemin du document dans l'API, sans /api : « /devis/:id », « /factures/:id » (lot 6a-3),
  // « /interventions/:id » (compte rendu) ou « /contrats-maintenance/:id » (lot 6a-4d), ou
  // « /chantiers/:id » (rapport de chantier remis au client, lot 6a-4e).
  chemin: string;
  // Nom du PDF téléchargé, le même que celui du bouton « PDF ».
  nomFichier: string;
};

const TEXTE_AIDE_MESSAGERIE = 'Votre messagerie s’ouvrira avec le destinataire, l’objet et le texte remplis. Le PDF est téléchargé en même temps : joignez-le à la main au courriel.';

// Envoi d'un document, par la messagerie de l'utilisateur (lots 6a-3, 6a-4d et 6a-4e) ou par Microsoft 365
// (lot 6b-2). `onEnvoiPrepare` reçoit la réponse de l'enregistrement : celle d'un devis porte son statut
// après l'envoi, un brouillon passant « envoyé » (lot 6a-3 bis), que l'écran Devis affiche dans sa liste.
//
// Messagerie : « Préparer l'envoi » télécharge le PDF, puis enregistre l'envoi au journal, puis propose le
// lien qui ouvre la messagerie avec le destinataire, l'objet et le texte remplis ; le PDF se joint à la
// main. Si le PDF est refusé, rien n'est enregistré. Iris ne sait pas si le courriel part : le journal dit
// « Envoi préparé ».
//
// Microsoft 365, quand le serveur le propose (proposition.microsoft365) : « Envoyer par Microsoft 365 »
// obtient le jeton dans le navigateur (lib/microsoft365.ts), puis le serveur produit le PDF, l'envoie
// depuis la boîte Microsoft de l'utilisateur et note l'envoi. Il ne part que d'un clic sur son bouton :
// la touche Entrée ne déclenche alors rien. Pendant l'envoi, jeton compris, les boutons d'envoi et
// « Fermer » sont désactivés ; le verrou est tenu par document, au niveau du module
// (lib/envoiMicrosoft365.ts), et un dialogue rouvert sur le document le trouve. La réponse est classée
// (classerReponseEnvoi) : aucun message ne pousse à renvoyer un courriel peut-être parti.
export default function EnvoiDocument({ document: piece, onFermer, onEnvoiPrepare }: { document: DocumentAEnvoyer; onFermer: () => void; onEnvoiPrepare?: (reponse: EnvoiEnregistre) => void }) {
  const fuseau = useCompanyTimezone();
  const titre = useRef<HTMLHeadingElement>(null);
  const [chargement, setChargement] = useState(true);
  const [proposition, setProposition] = useState<PropositionEnvoi | null>(null);
  const [envois, setEnvois] = useState<EnvoiPrepare[]>([]);
  const [destinataire, setDestinataire] = useState('');
  const [erreur, setErreur] = useState('');
  const [prepare, setPrepare] = useState<PropositionEnvoi | null>(null);
  const [enCours, setEnCours] = useState(false);
  const verrou = useRef(false);
  // Envoi par Microsoft 365 : le verrou du document (module), l'issue du dernier envoi, et les boutons
  // qu'il laisse désactivés jusqu'à la fermeture du dialogue.
  const envoiMicrosoft365EnCours = useSyncExternalStore(suivreEnvois, () => envoiEnCours(piece.chemin));
  const [issue, setIssue] = useState<IssueEnvoi | null>(null);
  const [apresEnvoi, setApresEnvoi] = useState<BoutonsApresEnvoi | null>(null);

  useEffect(() => { titre.current?.focus(); }, []);
  useEffect(() => {
    let actif = true;
    (async () => {
      try {
        const reponse = await apiFetch(`${piece.chemin}/envois`);
        const donnees = await reponse.json().catch(() => ({}));
        if (!reponse.ok) throw new Error(donnees?.error || 'Lecture des envois impossible.');
        if (!actif) return;
        setProposition(donnees.proposition);
        setEnvois(donnees.envois);
        setDestinataire(donnees.proposition.destinataire);
        // L'instance MSAL est initialisée dès l'ouverture : la fenêtre Microsoft s'ouvre ainsi
        // directement depuis le clic.
        if (donnees.proposition?.microsoft365 === true) void chargerMicrosoft365();
      } catch (e) {
        if (actif) setErreur(e instanceof Error ? e.message : 'Lecture des envois impossible.');
      } finally {
        if (actif) setChargement(false);
      }
    })();
    return () => { actif = false; };
  }, [piece.chemin]);

  // Fin d'un envoi par Microsoft 365 de ce document, lancé depuis ce dialogue ou depuis un autre, démonté
  // depuis : son message, les boutons qu'il laisse désactivés, et la ligne du journal d'un envoi fait.
  useEffect(() => suivreEnvois((chemin, fin) => {
    if (chemin !== piece.chemin || !fin) return;
    setIssue({ message: fin.message, role: fin.role, boutons: fin.boutons });
    setApresEnvoi((avant) => cumulerBoutons(avant, fin.boutons));
    const envoi = fin.envoi;
    if (envoi) setEnvois((liste) => [envoi, ...liste.filter((ligne) => ligne.id !== envoi.id)]);
  }), [piece.chemin]);

  const boutons = etatBoutonsEnvoi({ proposition, destinataire, preparationEnCours: enCours, envoiEnCours: envoiMicrosoft365EnCours, apresEnvoi });

  const preparer = async () => {
    if (verrou.current || envoiEnCours(piece.chemin)) return;
    verrou.current = true; setEnCours(true); setErreur(''); setPrepare(null); setIssue(null);
    try {
      // Le PDF d'abord, avec le code du bouton « PDF » : s'il est refusé, rien n'est enregistré.
      await telechargerPdf(`${piece.chemin}/document.pdf`, piece.nomFichier);
      const reponse = await apiFetch(`${piece.chemin}/envois`, { method: 'POST', body: JSON.stringify({ destinataire }) });
      const donnees = await reponse.json().catch(() => ({}));
      if (!reponse.ok) throw new Error(donnees?.error || 'Enregistrement de l’envoi impossible.');
      const enregistre = donnees as EnvoiEnregistre;
      setEnvois((liste) => [enregistre.envoi, ...liste.filter((envoi) => envoi.id !== enregistre.envoi.id)]);
      setPrepare({ destinataire: enregistre.envoi.destinataire, objet: enregistre.objet, corps: enregistre.corps });
      onEnvoiPrepare?.(enregistre);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Enregistrement de l’envoi impossible.');
    } finally {
      verrou.current = false; setEnCours(false);
    }
  };

  // La touche Entrée dans le champ du destinataire soumet le formulaire : elle prépare l'envoi comme
  // aujourd'hui, sauf quand Microsoft 365 est proposé, où elle ne déclenche rien (choix le plus
  // restrictif, à confirmer) : un envoi réel ne part que d'un clic sur son bouton.
  const soumettre = (event: React.FormEvent) => {
    event.preventDefault();
    if (boutons.entreePrepare) void preparer();
  };

  const envoyerMicrosoft365 = async () => {
    const chemin = piece.chemin;
    if (!commencerEnvoi(chemin)) return;
    setErreur(''); setPrepare(null); setIssue(null);
    // Une exception imprévue laisse l'issue inconnue : jamais un message qui dirait que rien n'est parti.
    let fin: FinEnvoi = { message: MESSAGE_ISSUE_INCONNUE, role: 'alert', boutons: { envoyerMicrosoft365: false, preparerEnvoi: true } };
    let enregistre: EnvoiEnregistre | null = null;
    try {
      const tentative = await envoyerParMicrosoft365(chemin, destinataire, getCurrentUser()?.email ?? '', { forcerFenetre: fenetreExigee() });
      if ('messageFenetre' in tentative) {
        // Erreur de la fenêtre Microsoft : rien n'est parti, les deux boutons restent proposés.
        fin = { message: tentative.messageFenetre, role: 'alert', boutons: { ...DEUX_BOUTONS } };
      } else {
        noterReponseEnvoi(tentative.reponse);
        const classee = classerReponseEnvoi(tentative.reponse);
        fin = { message: classee.message, role: classee.role, boutons: classee.boutons };
        if (classee.classe === 1 && 'json' in tentative.reponse) {
          enregistre = tentative.reponse.json as EnvoiEnregistre;
          fin.envoi = enregistre.envoi;
        }
      }
    } catch {
      // fin reste l'issue inconnue.
    } finally {
      terminerEnvoi(chemin, fin);
    }
    if (enregistre) onEnvoiPrepare?.(enregistre);
  };

  const libelleTitre = `Envoyer ${piece.libelle}`;
  const microsoft365 = boutons.microsoft365Propose;
  return <form role="dialog" aria-label={libelleTitre} noValidate onSubmit={soumettre} className="bg-blue-50 border border-blue-200 rounded-xl p-5 space-y-3 min-w-0">
    <div>
      <h2 ref={titre} tabIndex={-1} className="font-semibold break-words outline-none">{libelleTitre}</h2>
      <p className="text-sm text-gray-600">{microsoft365 ? TEXTE_AIDE_MICROSOFT_365 : TEXTE_AIDE_MESSAGERIE}</p>
    </div>
    {chargement && <p role="status" className="text-sm">Chargement…</p>}
    {proposition && <>
      <label className="text-sm font-medium block">Destinataire
        <input type="email" inputMode="email" autoComplete="off" maxLength={254} className="mt-1 w-full border rounded px-3 py-2 bg-white" value={destinataire} onChange={(e) => setDestinataire(e.target.value)} placeholder="nom@domaine.fr"/>
      </label>
      <p className="text-sm break-words"><span className="font-medium">Objet :</span> {proposition.objet}</p>
      {/* Avec Microsoft 365, le texte part sans retouche : il s'affiche en lecture seule. */}
      {microsoft365 && <div className="text-sm">
        <span className="font-medium">Texte du courriel :</span>
        <p className="mt-1 whitespace-pre-wrap wrap-anywhere rounded border bg-white px-3 py-2">{proposition.corps}</p>
      </div>}
    </>}
    {erreur && <p role="alert" className="text-red-600 break-words">{erreur}</p>}
    {envoiMicrosoft365EnCours && <p role="status" className="text-sm">{MESSAGE_ENVOI_EN_COURS}</p>}
    {issue && (issue.role === 'alert'
      ? <p role="alert" className="text-red-600 wrap-anywhere">{issue.message}</p>
      : <p role="status" className="rounded border border-green-300 bg-white p-3 text-sm wrap-anywhere">{issue.message}</p>)}
    {prepare && <div role="status" className="rounded border border-green-300 bg-white p-3 space-y-2 text-sm">
      <p className="break-words">Envoi préparé pour <span className="break-all">{prepare.destinataire}</span>. Le PDF {piece.nomFichier} vient d’être téléchargé : joignez-le à la main au courriel.</p>
      <a className="btn btn-primary gap-2" href={lienMessagerie(prepare.destinataire, prepare.objet, prepare.corps)}><Mail size={16}/> Ouvrir la messagerie</a>
    </div>}
    <div className="flex flex-wrap gap-2">
      <button type="button" data-testid="fermer-envoi" className="btn border disabled:opacity-50 disabled:cursor-not-allowed" onClick={onFermer} disabled={!boutons.fermer}>Fermer</button>
      {microsoft365 && <button type="button" data-testid="envoyer-microsoft-365" onClick={() => { void envoyerMicrosoft365(); }} disabled={!boutons.envoyerMicrosoft365} className="btn bg-blue-700 text-white gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
        <Send size={16} aria-hidden="true"/> {envoiMicrosoft365EnCours ? 'Envoi…' : 'Envoyer par Microsoft 365'}
      </button>}
      {microsoft365
        ? <button type="button" data-testid="preparer-envoi" onClick={() => { void preparer(); }} disabled={!boutons.preparerEnvoi} className="btn border bg-white disabled:opacity-50 disabled:cursor-not-allowed">{enCours ? 'Préparation…' : 'Préparer l’envoi'}</button>
        : <button type="submit" data-testid="preparer-envoi" disabled={!boutons.preparerEnvoi} className="btn bg-blue-700 text-white">{enCours ? 'Préparation…' : 'Préparer l’envoi'}</button>}
    </div>
    {proposition && <section aria-label="Envois" className="space-y-1">
      <h3 className="text-sm font-semibold">Envois</h3>
      {envois.length === 0
        ? <p className="text-sm text-gray-500">Aucun envoi préparé pour ce document.</p>
        : <ul className="divide-y text-sm">{envois.map((envoi) => <li key={envoi.id} className="py-1 wrap-anywhere">{libelleEnvoi(envoi, fuseau)}</li>)}</ul>}
      <p className="text-xs text-gray-500">{NOTE_JOURNAL_ENVOIS}</p>
    </section>}
  </form>;
}
