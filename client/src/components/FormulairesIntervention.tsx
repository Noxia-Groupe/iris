import { useRef, useState } from 'react';
import { apiFetch } from '../api';
import { ZoneSignature } from './ZoneSignature';
import type { TraceSignature } from '../lib/traceSignature';

// Formulaires du compte rendu, de la signature et de la clôture d'une intervention (lot pilote 3b-3),
// dans la page et sans fenêtre du navigateur. Chacun n'envoie qu'une requête à la fois.

type Reponse = { ok: boolean; status: number; data: { error?: string } };

// Une réponse perdue (réseau) ou une erreur du serveur laisse l'issue inconnue : l'écran le dit au
// lieu d'annoncer un échec, et relit la liste.
async function envoyer(chemin: string, methode: 'POST' | 'PATCH', corps: unknown): Promise<Reponse | null> {
  try {
    const res = await apiFetch(chemin, { method: methode, body: JSON.stringify(corps) });
    const data = await res.json().catch(() => ({}));
    if (res.status >= 500) return null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return null;
  }
}

// Clé d'envoi tirée à l'ouverture du formulaire : un nouvel envoi après une réponse perdue retrouve
// le compte rendu déjà enregistré au lieu d'en figer un second.
function nouvelleCleEnvoi(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const octets = crypto.getRandomValues(new Uint8Array(16));
  octets[6] = (octets[6] & 0x0f) | 0x40;
  octets[8] = (octets[8] & 0x3f) | 0x80;
  const hex = Array.from(octets, (octet) => octet.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function useEnvoiUnique() {
  const enCours = useRef(false);
  const [envoi, setEnvoi] = useState(false);
  const executer = async (travail: () => Promise<void>) => {
    if (enCours.current) return;
    enCours.current = true;
    setEnvoi(true);
    try { await travail(); } finally { enCours.current = false; setEnvoi(false); }
  };
  return { envoi, executer };
}

const cadre = 'mt-3 space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-4';

export function FormulaireCompteRendu({ interventionId, onEnregistre, onAnnuler }: { interventionId: string; onEnregistre: () => Promise<void>; onAnnuler: () => void }) {
  const cleEnvoi = useRef(nouvelleCleEnvoi());
  const [contenu, setContenu] = useState('');
  const [erreur, setErreur] = useState('');
  const { envoi, executer } = useEnvoiUnique();
  const valide = contenu.trim().length >= 3 && contenu.trim().length <= 5000;

  const soumettre = (event: React.FormEvent) => {
    event.preventDefault();
    if (!valide) return;
    void executer(async () => {
      setErreur('');
      const reponse = await envoyer(`/interventions/${interventionId}/rapports`, 'POST', { contenu, cleEnvoi: cleEnvoi.current });
      if (!reponse) {
        setErreur('L’enregistrement du compte rendu n’a pas pu être confirmé. Renvoyez-le : il ne sera pas enregistré deux fois.');
        return;
      }
      if (!reponse.ok) { setErreur(reponse.data.error || 'Enregistrement du compte rendu impossible.'); return; }
      await onEnregistre();
    });
  };

  return <form role="dialog" aria-label="Compte rendu d’intervention" onSubmit={soumettre} className={cadre}>
    <div><h3 className="font-semibold">Compte rendu d’intervention</h3><p className="text-sm text-gray-600">Une fois enregistré, il ne se modifie plus : une correction passe par un compte rendu complémentaire.</p></div>
    <label className="block text-sm font-medium">Travaux réalisés et constats<textarea aria-label="Texte du compte rendu" className="form-input mt-1 min-h-[8rem] w-full" maxLength={5000} value={contenu} onChange={(event) => setContenu(event.target.value)} disabled={envoi} /></label>
    {erreur && <p role="alert" className="text-sm text-red-700">{erreur}</p>}
    <div className="flex flex-wrap gap-2"><button type="submit" className="btn btn-primary" disabled={envoi || !valide}>{envoi ? 'Enregistrement…' : 'Enregistrer le compte rendu'}</button><button type="button" className="btn btn-secondary" onClick={onAnnuler} disabled={envoi}>Annuler</button></div>
  </form>;
}

export function FormulaireSignature({ rapport, enregistrePar, onEnregistre, onAnnuler }: { rapport: { id: string; contenu: string }; enregistrePar: string; onEnregistre: () => Promise<void>; onAnnuler: () => void }) {
  const [signataire, setSignataire] = useState('');
  const [confirme, setConfirme] = useState(false);
  const [trace, setTrace] = useState<TraceSignature | null>(null);
  const [erreur, setErreur] = useState('');
  const { envoi, executer } = useEnvoiUnique();
  const valide = signataire.trim().length >= 2 && confirme && trace !== null;

  const soumettre = (event: React.FormEvent) => {
    event.preventDefault();
    if (!valide) return;
    void executer(async () => {
      setErreur('');
      const reponse = await envoyer(`/interventions/rapports/${rapport.id}/signature`, 'POST', { signataire: signataire.trim(), confirme: true, trace });
      if (!reponse) {
        // Une seule signature par compte rendu : un nouvel envoi ne peut pas en créer une seconde.
        setErreur('L’enregistrement de la signature n’a pas pu être confirmé. Renvoyez-la : si elle a déjà été enregistrée, le nouvel envoi sera refusé sans doublon.');
        return;
      }
      if (!reponse.ok) {
        setErreur(reponse.data.error || 'Signature impossible.');
        // Déjà signé : la liste relue montre la signature enregistrée.
        if (reponse.status === 409) await onEnregistre();
        return;
      }
      await onEnregistre();
    });
  };

  return <form role="dialog" aria-label="Signature du client" onSubmit={soumettre} className={cadre}>
    <div><h3 className="font-semibold">Signature du client</h3><p className="text-sm text-gray-600">Le client relit le compte rendu, confirme et signe au doigt. La signature ne se modifie plus.</p></div>
    <blockquote className="rounded border border-gray-200 bg-white p-3 text-sm text-gray-700">{rapport.contenu}</blockquote>
    <label className="block text-sm font-medium">Enregistré par<input aria-label="Enregistré par" readOnly className="form-input mt-1 w-full bg-gray-100" value={enregistrePar} /></label>
    <label className="block text-sm font-medium">Nom du signataire client<input aria-label="Nom du signataire client" className="form-input mt-1 w-full" maxLength={200} value={signataire} onChange={(event) => setSignataire(event.target.value)} disabled={envoi} placeholder="Prénom et nom" /></label>
    <ZoneSignature onChange={setTrace} desactivee={envoi} />
    <label className="flex items-start gap-2 text-sm"><input aria-label="Confirmation du client" type="checkbox" className="mt-1" checked={confirme} onChange={(event) => setConfirme(event.target.checked)} disabled={envoi} /><span>Le client confirme avoir lu et accepté ce compte rendu.</span></label>
    {erreur && <p role="alert" className="text-sm text-red-700">{erreur}</p>}
    <div className="flex flex-wrap gap-2"><button type="submit" className="btn btn-primary" disabled={envoi || !valide}>{envoi ? 'Enregistrement…' : 'Enregistrer la signature'}</button><button type="button" className="btn btn-secondary" onClick={onAnnuler} disabled={envoi}>Annuler</button></div>
  </form>;
}

const MOTIFS = [
  { code: 'CLIENT_ABSENT', libelle: 'Client absent' },
  { code: 'REFUS_SIGNATURE', libelle: 'Refus de signer' },
  { code: 'SIGNATURE_IMPOSSIBLE', libelle: 'Signature impossible' },
  { code: 'AUTRE', libelle: 'Autre' },
];

// Terminer exige un compte rendu, signé par le client ou, à défaut, accompagné d'un motif
// (décisions de Nelson des 19 et 20-10-2026). Le serveur relit la règle sous verrou.
export function FormulaireCloture({ interventionId, nombreComptesRendus, signe, onTermine, onAjouterCompteRendu, onAnnuler }: {
  interventionId: string; nombreComptesRendus: number; signe: boolean; onTermine: () => Promise<void>; onAjouterCompteRendu: () => void; onAnnuler: () => void;
}) {
  const [motif, setMotif] = useState('');
  const [precision, setPrecision] = useState('');
  const [erreur, setErreur] = useState('');
  const { envoi, executer } = useEnvoiUnique();
  const valide = signe || (motif !== '' && (motif !== 'AUTRE' || (precision.trim().length >= 3 && precision.trim().length <= 200)));

  const soumettre = (event: React.FormEvent) => {
    event.preventDefault();
    if (!valide) return;
    void executer(async () => {
      setErreur('');
      const corps = signe ? { statut: 'TERMINEE' } : { statut: 'TERMINEE', motifSansSignature: motif, ...(motif === 'AUTRE' ? { precisionMotif: precision.trim() } : {}) };
      const reponse = await envoyer(`/interventions/${interventionId}/statut`, 'PATCH', corps);
      if (!reponse) {
        setErreur('La fin de l’intervention n’a pas pu être confirmée : la liste est relue.');
        await onTermine();
        return;
      }
      if (!reponse.ok) { setErreur(reponse.data.error || 'Transition impossible.'); return; }
      await onTermine();
    });
  };

  if (nombreComptesRendus === 0) {
    return <div role="dialog" aria-label="Terminer l’intervention" className={cadre}>
      <h3 className="font-semibold">Terminer l’intervention</h3>
      <p className="text-sm text-gray-700">Un compte rendu est obligatoire pour terminer l’intervention.</p>
      <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-primary" onClick={onAjouterCompteRendu}>Rédiger le compte rendu</button><button type="button" className="btn btn-secondary" onClick={onAnnuler}>Annuler</button></div>
    </div>;
  }

  return <form role="dialog" aria-label="Terminer l’intervention" onSubmit={soumettre} className={cadre}>
    <h3 className="font-semibold">Terminer l’intervention</h3>
    {signe ? <p className="text-sm text-gray-700">Le compte rendu est signé par le client.</p> : <>
      <p className="text-sm text-gray-700">Aucun compte rendu n’est signé. Indiquez pourquoi : le motif est consigné au journal.</p>
      <fieldset className="space-y-1"><legend className="text-sm font-medium">Motif sans signature</legend>
        {MOTIFS.map(({ code, libelle }) => <label key={code} className="flex items-center gap-2 text-sm"><input type="radio" name={`motif-${interventionId}`} value={code} checked={motif === code} onChange={() => setMotif(code)} disabled={envoi} />{libelle}</label>)}
      </fieldset>
      {motif === 'AUTRE' && <label className="block text-sm font-medium">Précision (3 à 200 caractères)<input aria-label="Précision du motif" className="form-input mt-1 w-full" maxLength={200} value={precision} onChange={(event) => setPrecision(event.target.value)} disabled={envoi} /></label>}
    </>}
    {erreur && <p role="alert" className="text-sm text-red-700">{erreur}</p>}
    <div className="flex flex-wrap gap-2"><button type="submit" className="btn btn-primary" disabled={envoi || !valide}>{envoi ? 'Enregistrement…' : signe ? 'Confirmer la fin de l’intervention' : 'Terminer sans signature'}</button><button type="button" className="btn btn-secondary" onClick={onAnnuler} disabled={envoi}>Annuler</button></div>
  </form>;
}
