import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import { useCompanyTimezone, useFuseauSocieteConnu } from '../companyTimezoneContext';
import { companyDateInputValue } from '../lib/dateFormatting';

export type CibleConversionDevis = 'INTERVENTION' | 'CONTRAT';
type ClientDetail = {
  id: string; raisonSociale: string;
  sites: { id: string; nom: string; ville: string }[];
  contacts: { id: string; prenom?: string | null; nom: string }[];
};
type Props = {
  devis: { id: string; numero: string; version: number; objet: string; client: { id: string; raisonSociale: string } };
  cible: CibleConversionDevis;
  onFermer: () => void;
  onConverti: () => void;
};

// Lot pilote 4 (décision A7) : un devis signé crée son intervention SAV ou son contrat de
// maintenance, sans ressaisie du client ni de l'objet. Le formulaire ne demande que ce que le
// devis ne porte pas : site et contact, priorité et date souhaitée pour l'intervention ;
// périodicité, durée, date de début et couverture pour le contrat.
export default function ConversionDevis({ devis, cible, onFermer, onConverti }: Props) {
  const fuseau = useCompanyTimezone();
  const fuseauConnu = useFuseauSocieteConnu();
  const [client, setClient] = useState<ClientDetail | null>(null);
  const [erreurClient, setErreurClient] = useState('');
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const enCours = useRef(false);
  const intervention = cible === 'INTERVENTION';

  useEffect(() => {
    let actif = true;
    (async () => {
      try {
        const reponse = await apiFetch(`/clients/${devis.client.id}`);
        const donnees = await reponse.json();
        if (!reponse.ok) throw new Error(donnees?.error || 'Chargement du client impossible.');
        if (actif) setClient(donnees);
      } catch (e) {
        if (actif) setErreurClient(e instanceof Error ? e.message : 'Chargement du client impossible.');
      }
    })();
    return () => { actif = false; };
  }, [devis.client.id]);

  const envoyer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (enCours.current) return;
    enCours.current = true; setEnvoi(true); setErreur('');
    const champs = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>;
    const corps: Record<string, unknown> = { cible, titre: champs.titre, siteId: champs.siteId || undefined };
    if (intervention) Object.assign(corps, { contactId: champs.contactId || undefined, priorite: champs.priorite, dateSouhaitee: champs.dateSouhaitee || undefined });
    else Object.assign(corps, {
      dateDebut: champs.dateDebut, periodiciteMois: Number(champs.periodiciteMois), dureePrevisionnelleMinutes: Number(champs.dureePrevisionnelleMinutes),
      politiqueMainOeuvre: champs.politiqueMainOeuvre, politiqueMateriel: champs.politiqueMateriel,
    });
    try {
      const reponse = await apiFetch(`/devis/${devis.id}/convertir`, { method: 'POST', body: JSON.stringify(corps) });
      const donnees = await reponse.json();
      if (!reponse.ok) throw new Error(donnees?.error || 'Conversion impossible.');
      onConverti();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Conversion impossible.');
    } finally {
      enCours.current = false; setEnvoi(false);
    }
  };

  const titre = intervention ? 'Créer l’intervention du devis' : 'Créer le contrat du devis';
  return <form role="dialog" aria-label={titre} onSubmit={envoyer} className="bg-blue-50 border border-blue-200 rounded-xl p-5 space-y-3">
    <div>
      <h2 className="font-semibold">{titre}</h2>
      <p className="text-sm text-gray-600">{devis.numero} v{devis.version} · {devis.client.raisonSociale}. {intervention ? 'L’intervention sera à planifier.' : 'Le contrat sera actif, première échéance à sa date de début.'}</p>
    </div>
    {erreurClient && <p role="alert" className="text-red-600">{erreurClient}</p>}
    <label className="text-sm font-medium block">Titre<input required name="titre" defaultValue={devis.objet} maxLength={intervention ? undefined : 200} className="mt-1 w-full border rounded px-3 py-2"/></label>
    {client && <label className="text-sm font-medium block">Site<select name="siteId" defaultValue="" className="mt-1 w-full border rounded px-3 py-2"><option value="">{intervention ? 'Site (facultatif)' : 'Tous sites / site non précisé'}</option>{client.sites.map(site => <option key={site.id} value={site.id}>{site.nom} — {site.ville}</option>)}</select></label>}
    {intervention ? <div className="grid gap-3 sm:grid-cols-3">
      {client && <label className="text-sm font-medium block">Contact<select name="contactId" defaultValue="" className="mt-1 w-full border rounded px-3 py-2"><option value="">Contact (facultatif)</option>{client.contacts.map(contact => <option key={contact.id} value={contact.id}>{[contact.prenom, contact.nom].filter(Boolean).join(' ')}</option>)}</select></label>}
      <label className="text-sm font-medium block">Priorité<select name="priorite" defaultValue="NORMALE" className="mt-1 w-full border rounded px-3 py-2"><option value="BASSE">Basse</option><option value="NORMALE">Normale</option><option value="HAUTE">Haute</option><option value="URGENTE">Urgente</option></select></label>
      <label className="text-sm font-medium block">Date souhaitée<input name="dateSouhaitee" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA (facultatif)" className="mt-1 w-full border rounded px-3 py-2"/></label>
    </div> : <>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm font-medium block">Date de début<input required name="dateDebut" defaultValue={fuseauConnu ? companyDateInputValue(fuseau) : ''} inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" className="mt-1 w-full border rounded px-3 py-2"/></label>
        <label className="text-sm font-medium block">Périodicité (mois)<input required name="periodiciteMois" type="number" min="1" max="60" defaultValue="12" className="mt-1 w-full border rounded px-3 py-2"/></label>
        <label className="text-sm font-medium block">Durée prévue (minutes)<input required name="dureePrevisionnelleMinutes" type="number" min="15" max="1440" defaultValue="60" className="mt-1 w-full border rounded px-3 py-2"/></label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium block">Main-d’œuvre<select required name="politiqueMainOeuvre" defaultValue="HORS_FORFAIT" className="mt-1 w-full border rounded px-3 py-2"><option value="INCLUSE">Incluse</option><option value="HORS_FORFAIT">Hors forfait</option></select></label>
        <label className="text-sm font-medium block">Matériel<select required name="politiqueMateriel" defaultValue="HORS_FORFAIT" className="mt-1 w-full border rounded px-3 py-2"><option value="INCLUS">Inclus</option><option value="HORS_FORFAIT">Hors forfait</option></select></label>
      </div>
    </>}
    {erreur && <p role="alert" className="text-red-600">{erreur}</p>}
    <div className="flex gap-2 flex-wrap">
      <button type="button" className="btn border" onClick={onFermer}>Annuler</button>
      <button disabled={envoi || !client} className="btn bg-blue-700 text-white">{envoi ? 'Création…' : intervention ? 'Créer l’intervention' : 'Créer le contrat'}</button>
    </div>
  </form>;
}
