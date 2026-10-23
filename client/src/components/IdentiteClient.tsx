import { useEffect, useId, useState } from 'react';
import { apiFetch } from '../api';

// Identité d'une fiche client (lot 6a-2 bis). Signer un devis ou émettre une facture exige, pour un
// professionnel, une raison sociale, une adresse de facturation et un SIREN ; pour un particulier
// (case « Pas de SIRET » cochée), son nom complet et son adresse. Cocher la case vide le SIREN et
// désactive son champ : le serveur refuse une case cochée avec un SIREN.
export type IdentiteClientSaisie = { raisonSociale: string; siren: string; sansSiret: boolean };

const libelleNomClient = (sansSiret: boolean) => (sansSiret ? 'Nom complet' : 'Raison sociale');

export function ChampsIdentiteClient({ valeurs, onChange, autoFocus = false }: {
  valeurs: IdentiteClientSaisie;
  onChange: (valeurs: IdentiteClientSaisie) => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  return <>
    <div className="min-w-0">
      <label htmlFor={`${id}-nom`} className="text-sm font-medium">{libelleNomClient(valeurs.sansSiret)}</label>
      <input id={`${id}-nom`} autoFocus={autoFocus} required value={valeurs.raisonSociale} onChange={e => onChange({ ...valeurs, raisonSociale: e.target.value })} className="mt-1 w-full border rounded px-3 py-2" />
    </div>
    <div className="min-w-0">
      <label htmlFor={`${id}-siren`} className="text-sm font-medium">SIREN</label>
      <input id={`${id}-siren`} inputMode="numeric" autoComplete="off" value={valeurs.siren} disabled={valeurs.sansSiret} aria-describedby={`${id}-siren-aide`}
        onChange={e => onChange({ ...valeurs, siren: e.target.value })} className="mt-1 w-full border rounded px-3 py-2 disabled:bg-gray-100 disabled:text-gray-500" />
      <p id={`${id}-siren-aide`} className="mt-1 text-xs text-gray-500">{valeurs.sansSiret ? 'Sans objet pour un particulier.' : '9 chiffres, exigé pour signer un devis ou émettre une facture.'}</p>
    </div>
    <label className="flex items-center gap-2 text-sm self-center">
      <input type="checkbox" checked={valeurs.sansSiret} onChange={e => onChange({ ...valeurs, sansSiret: e.target.checked, siren: e.target.checked ? '' : valeurs.siren })} />
      Pas de SIRET (particulier)
    </label>
  </>;
}

// Formulaire de la fiche client, pour l'administration : l'identité enregistrée est relue par la
// page après succès (`onEnregistre`).
export function FormulaireIdentiteClient({ client, onEnregistre }: {
  client: { id: string; raisonSociale: string; siren?: string | null; sansSiret?: boolean };
  onEnregistre: () => Promise<void> | void;
}) {
  const { id, raisonSociale, siren, sansSiret } = client;
  const [valeurs, setValeurs] = useState<IdentiteClientSaisie>({ raisonSociale, siren: siren ?? '', sansSiret: Boolean(sansSiret) });
  const [erreur, setErreur] = useState('');
  const [succes, setSucces] = useState('');
  const [enCours, setEnCours] = useState(false);
  // Une fiche relue (après un enregistrement, ou une autre fiche) remplace la saisie.
  useEffect(() => { setValeurs({ raisonSociale, siren: siren ?? '', sansSiret: Boolean(sansSiret) }); }, [id, raisonSociale, siren, sansSiret]);
  const enregistrer = async (event: React.FormEvent) => {
    event.preventDefault(); setErreur(''); setSucces(''); setEnCours(true);
    try {
      const res = await apiFetch(`/clients/${id}`, { method: 'PUT', body: JSON.stringify(valeurs) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Enregistrement impossible.');
      await onEnregistre();
      setSucces('Identité du client enregistrée.');
    } catch (e) { setErreur(e instanceof Error ? e.message : 'Enregistrement impossible.'); } finally { setEnCours(false); }
  };
  return <form onSubmit={enregistrer} aria-label="Identité du client" className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
    <ChampsIdentiteClient valeurs={valeurs} onChange={v => { setValeurs(v); setSucces(''); }} />
    <div className="md:col-span-3 flex flex-wrap items-center gap-3">
      <button className="btn btn-primary w-fit" type="submit" disabled={enCours}>Enregistrer l’identité</button>
      {succes && <p role="status" className="text-sm text-emerald-700">{succes}</p>}
    </div>
    {erreur && <p role="alert" className="md:col-span-3 text-sm text-red-600">{erreur}</p>}
  </form>;
}
