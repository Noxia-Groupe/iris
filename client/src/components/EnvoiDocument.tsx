import { useEffect, useRef, useState } from 'react';
import { Mail } from 'lucide-react';
import { apiFetch } from '../api';
import { useCompanyTimezone } from '../companyTimezoneContext';
import { formatCompanyDateTime } from '../lib/dateFormatting';
import { telechargerPdf } from '../lib/documentPdf';
import { lienMessagerie, type EnvoiEnregistre, type EnvoiPrepare, type PropositionEnvoi } from '../lib/envoiDocument';

export type DocumentAEnvoyer = {
  // Désignation du document dans les libellés : « le devis A26-0001 version 1 », « la facture
  // F2026-0001 », « l’avoir A2026-0001 », « le compte rendu de l’intervention I26-0001 », « le contrat
  // de maintenance Maintenance SSI ».
  libelle: string;
  // Chemin du document dans l'API, sans /api : « /devis/:id », « /factures/:id » (lot 6a-3),
  // « /interventions/:id » (compte rendu) ou « /contrats-maintenance/:id » (lot 6a-4d).
  chemin: string;
  // Nom du PDF téléchargé, le même que celui du bouton « PDF ».
  nomFichier: string;
};

const DATE_HEURE = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' } as const;

// Envoi d'un document par la messagerie de l'utilisateur (lots 6a-3 et 6a-4d). « Préparer l'envoi »
// télécharge le PDF, puis enregistre l'envoi au journal, puis propose le lien qui ouvre la messagerie
// avec le destinataire, l'objet et le texte remplis ; le PDF se joint à la main. Si le PDF est refusé,
// rien n'est enregistré. Iris ne sait pas si le courriel part : le journal dit « Envoi préparé ».
// `onEnvoiPrepare` reçoit la réponse de l'enregistrement : celle d'un devis porte son statut après
// l'envoi, un brouillon passant « envoyé » (lot 6a-3 bis), que l'écran Devis affiche dans sa liste.
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
      } catch (e) {
        if (actif) setErreur(e instanceof Error ? e.message : 'Lecture des envois impossible.');
      } finally {
        if (actif) setChargement(false);
      }
    })();
    return () => { actif = false; };
  }, [piece.chemin]);

  const preparer = async (event: React.FormEvent) => {
    event.preventDefault();
    if (verrou.current) return;
    verrou.current = true; setEnCours(true); setErreur(''); setPrepare(null);
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

  const libelleTitre = `Envoyer ${piece.libelle}`;
  return <form role="dialog" aria-label={libelleTitre} noValidate onSubmit={preparer} className="bg-blue-50 border border-blue-200 rounded-xl p-5 space-y-3 min-w-0">
    <div>
      <h2 ref={titre} tabIndex={-1} className="font-semibold break-words outline-none">{libelleTitre}</h2>
      <p className="text-sm text-gray-600">Votre messagerie s’ouvrira avec le destinataire, l’objet et le texte remplis. Le PDF est téléchargé en même temps : joignez-le à la main au courriel.</p>
    </div>
    {chargement && <p role="status" className="text-sm">Chargement…</p>}
    {proposition && <>
      <label className="text-sm font-medium block">Destinataire
        <input type="email" inputMode="email" autoComplete="off" maxLength={254} className="mt-1 w-full border rounded px-3 py-2 bg-white" value={destinataire} onChange={(e) => setDestinataire(e.target.value)} placeholder="nom@domaine.fr"/>
      </label>
      <p className="text-sm break-words"><span className="font-medium">Objet :</span> {proposition.objet}</p>
    </>}
    {erreur && <p role="alert" className="text-red-600 break-words">{erreur}</p>}
    {prepare && <div role="status" className="rounded border border-green-300 bg-white p-3 space-y-2 text-sm">
      <p className="break-words">Envoi préparé pour <span className="break-all">{prepare.destinataire}</span>. Le PDF {piece.nomFichier} vient d’être téléchargé : joignez-le à la main au courriel.</p>
      <a className="btn btn-primary gap-2" href={lienMessagerie(prepare.destinataire, prepare.objet, prepare.corps)}><Mail size={16}/> Ouvrir la messagerie</a>
    </div>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn border" onClick={onFermer}>Fermer</button>
      <button type="submit" disabled={!proposition || enCours || !destinataire.trim()} className="btn bg-blue-700 text-white">{enCours ? 'Préparation…' : 'Préparer l’envoi'}</button>
    </div>
    {proposition && <section aria-label="Envois préparés" className="space-y-1">
      <h3 className="text-sm font-semibold">Envois préparés</h3>
      {envois.length === 0
        ? <p className="text-sm text-gray-500">Aucun envoi préparé pour ce document.</p>
        : <ul className="divide-y text-sm">{envois.map((envoi) => <li key={envoi.id} className="py-1 break-words">Envoi préparé le {formatCompanyDateTime(envoi.createdAt, fuseau, DATE_HEURE)} à <span className="break-all">{envoi.destinataire}</span> par {envoi.auteurNom}</li>)}</ul>}
      <p className="text-xs text-gray-500">Iris ne sait pas si le courriel est parti : seule la préparation de l’envoi est notée.</p>
    </section>}
  </form>;
}
