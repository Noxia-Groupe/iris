import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Building2, FolderOpen, MapPin, UserRound } from 'lucide-react';
import { apiFetch } from '../api';
import { formatDateOnly, jourCivilChantier } from '../lib/dateFormatting';
import { useCompanyTimezone } from '../companyTimezoneContext';
import { isAdminRole, useCurrentUser } from '../roles';

type Client = {
  id: string; raisonSociale: string; nomCommercial?: string | null; siren?: string | null; tvaIntra?: string | null;
  telephone?: string | null; email?: string | null; actif: boolean;
  contacts: Array<{ id: string; prenom?: string | null; nom: string; fonction?: string | null; email?: string | null; telephone?: string | null; principal: boolean; estDecisionnaire: boolean; estSignataire: boolean }>;
  sites: Array<{ id: string; nom: string; adresse: string; complementAdresse?: string | null; codePostal: string; ville: string; estSiegeSocial: boolean; estSiteFacturation: boolean; estSiteIntervention: boolean }>;
};
type ModeleEquipement = { id: string; reference: string; nom: string; fabricant?: string | null; actif: boolean };
type Equipement = { id: string; numeroSerie?: string | null; imei?: string | null; adresseMac?: string | null; statut: string; installeLe?: string | null; garantieJusquAu?: string | null; notes?: string | null; catalogueEquipement: ModeleEquipement; clientSite: { id: string; nom: string } };
// Chantier de l'historique : nom, adresse, statut et période, jamais de montant (cf. GET /api/clients/:id/chantiers).
type ChantierHistorique = { id: string; nom: string; adresse?: string | null; statut: string; dateDebut: string; dateFin?: string | null };
const STATUTS_CHANTIER: Record<string, string> = { EN_COURS: 'En cours', TERMINE: 'Terminé' };
const emptyContact = { prenom: '', nom: '', fonction: '', email: '', telephone: '', principal: false, estDecisionnaire: false, estSignataire: false };
const emptySite = { nom: '', adresse: '', complementAdresse: '', codePostal: '', ville: '', estSiegeSocial: false, estSiteFacturation: false, estSiteIntervention: true };

export default function ClientDetail() {
  const { id } = useParams();
  // L'administration tient la fiche à jour ; le technicien et le conducteur la consultent, sans parc
  // ni formulaire.
  const modifiable = isAdminRole(useCurrentUser()?.role);
  const fuseauHoraire = useCompanyTimezone();
  // Numéro du dernier chargement : un chargement dépassé (rôle relu entre-temps, par exemple) est ignoré.
  const dernierChargement = useRef(0);
  const [client, setClient] = useState<Client | null>(null);
  const [chantiers, setChantiers] = useState<ChantierHistorique[]>([]);
  const [erreurHistorique, setErreurHistorique] = useState(false);
  const [error, setError] = useState('');
  const [contact, setContact] = useState(emptyContact);
  const [site, setSite] = useState(emptySite);
  const [equipements, setEquipements] = useState<Equipement[]>([]);
  const [modeles, setModeles] = useState<ModeleEquipement[]>([]);
  const [equipement, setEquipement] = useState({ catalogueEquipementId: '', clientSiteId: '', numeroSerie: '', imei: '', adresseMac: '', installeLe: '', garantieJusquAu: '', notes: '' });
  const load = async () => {
    const chargement = ++dernierChargement.current;
    const actuel = () => chargement === dernierChargement.current;
    setError('');
    try {
      const [clientRes, historiqueRes, parcRes, modelesRes] = await Promise.all([
        apiFetch(`/clients/${id}`),
        // L'historique ne bloque pas la fiche : son échec est signalé dans sa section.
        apiFetch(`/clients/${id}/chantiers`).catch(() => null),
        modifiable ? apiFetch(`/clients/${id}/equipements`) : null,
        modifiable ? apiFetch('/catalogue/equipements') : null,
      ]);
      const clientData = await clientRes.json();
      if (!clientRes.ok) throw new Error(clientData.error || 'Client introuvable.');
      let parc: { equipements: Equipement[]; modeles: ModeleEquipement[] } | null = null;
      if (parcRes && modelesRes) {
        const [parcData, modelesData] = await Promise.all([parcRes.json(), modelesRes.json()]);
        if (!parcRes.ok) throw new Error(parcData.error || 'Chargement du parc impossible.');
        if (!modelesRes.ok) throw new Error(modelesData.error || 'Chargement des modèles impossible.');
        parc = { equipements: parcData, modeles: modelesData.filter((m: ModeleEquipement) => m.actif) };
      }
      const historique: unknown = historiqueRes?.ok ? await historiqueRes.json().catch(() => null) : null;
      if (!actuel()) return;
      if (parc) { setEquipements(parc.equipements); setModeles(parc.modeles); }
      setChantiers(Array.isArray(historique) ? historique : []);
      setErreurHistorique(!Array.isArray(historique));
      setClient(clientData);
    } catch (e) { if (actuel()) setError(e instanceof Error ? e.message : 'Chargement impossible.'); }
  };
  useEffect(() => { void load(); }, [id, modifiable]);
  const addContact = async (event: React.FormEvent) => { event.preventDefault(); try { const res = await apiFetch(`/clients/${id}/contacts`, { method: 'POST', body: JSON.stringify(contact) }); const data = await res.json(); if (!res.ok) throw new Error(data.error); setContact(emptyContact); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Ajout impossible.'); } };
  const addSite = async (event: React.FormEvent) => { event.preventDefault(); try { const res = await apiFetch(`/clients/${id}/sites`, { method: 'POST', body: JSON.stringify(site) }); const data = await res.json(); if (!res.ok) throw new Error(data.error); setSite(emptySite); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Ajout impossible.'); } };
  const addEquipement = async (event: React.FormEvent) => { event.preventDefault(); try { const res = await apiFetch(`/clients/${id}/equipements`, { method: 'POST', body: JSON.stringify(equipement) }); const data = await res.json(); if (!res.ok) throw new Error(data.error); setEquipement({ catalogueEquipementId: '', clientSiteId: '', numeroSerie: '', imei: '', adresseMac: '', installeLe: '', garantieJusquAu: '', notes: '' }); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Ajout impossible.'); } };
  const archiverEquipement = async (equipementId: string) => { try { const res = await apiFetch(`/clients/${id}/equipements/${equipementId}/archiver`, { method: 'POST' }); const data = await res.json(); if (!res.ok) throw new Error(data.error); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Archivage impossible.'); } };
  if (error && !client) return <div><Link to="/clients">← Clients</Link><p className="mt-4 text-red-600">{error}</p></div>;
  if (!client) return <p className="text-gray-500">Chargement…</p>;
  return <div className="max-w-6xl mx-auto space-y-6">
    <Link to="/clients" className="text-sm text-blue-700">← Clients</Link>
    <section className="bg-white border rounded-xl p-6"><div className="flex gap-3"><Building2 className="text-blue-700" size={28}/><div><h1 className="text-2xl font-bold">{client.raisonSociale}</h1>{client.actif === false && <p className="mt-1 w-fit rounded bg-amber-50 px-2 py-0.5 text-sm font-medium text-amber-800">Client désactivé</p>}<p className="text-gray-500">{client.nomCommercial || 'Fiche société'} {client.siren ? `· SIREN ${client.siren}` : ''}</p></div></div><div className="grid md:grid-cols-3 gap-4 mt-5 text-sm"><p><b>TVA :</b> {client.tvaIntra || '—'}</p><p><b>E-mail :</b> {client.email || '—'}</p><p><b>Téléphone :</b> {client.telephone || '—'}</p></div></section>
    {!modifiable && <p role="note" className="bg-blue-50 text-blue-800 rounded-lg px-4 py-3 text-sm">Consultation seule : la fiche, ses contacts et ses sites sont tenus à jour par l’administration.</p>}
    {error && <p className="text-red-600">{error}</p>}
    <section className="bg-white border rounded-xl p-6"><h2 className="font-bold text-lg flex gap-2 items-center"><UserRound size={20}/> Contacts</h2><div className="mt-4 grid md:grid-cols-2 gap-3">{client.contacts.map(c => <div key={c.id} className="border rounded-lg p-3 min-w-0"><p className="font-medium break-words">{c.prenom} {c.nom} {c.principal && <span className="text-xs text-blue-700">· Principal</span>}</p><p className="text-sm text-gray-500 break-words">{c.fonction || 'Fonction non renseignée'} · {c.email || 'Pas d’e-mail'}</p>{c.telephone && <p className="text-sm text-gray-700 break-words">{c.telephone}</p>}<div className="mt-2 flex gap-2 flex-wrap">{c.estDecisionnaire && <span className="text-xs bg-amber-100 text-amber-800 rounded px-2 py-1">Décisionnaire</span>}{c.estSignataire && <span className="text-xs bg-emerald-100 text-emerald-800 rounded px-2 py-1">Signataire</span>}</div></div>)}</div>{modifiable && <form onSubmit={addContact} className="mt-5 grid md:grid-cols-3 gap-3"><input required placeholder="Nom *" value={contact.nom} onChange={e=>setContact({...contact, nom:e.target.value})} className="border rounded px-3 py-2"/><input placeholder="Prénom" value={contact.prenom} onChange={e=>setContact({...contact, prenom:e.target.value})} className="border rounded px-3 py-2"/><input placeholder="Fonction" value={contact.fonction} onChange={e=>setContact({...contact, fonction:e.target.value})} className="border rounded px-3 py-2"/><input type="email" placeholder="E-mail" value={contact.email} onChange={e=>setContact({...contact, email:e.target.value})} className="border rounded px-3 py-2"/><input placeholder="Téléphone" value={contact.telephone} onChange={e=>setContact({...contact, telephone:e.target.value})} className="border rounded px-3 py-2"/><div className="flex items-center gap-3 text-sm"><label><input type="checkbox" checked={contact.estDecisionnaire} onChange={e=>setContact({...contact, estDecisionnaire:e.target.checked})}/> Décisionnaire</label><label><input type="checkbox" checked={contact.estSignataire} onChange={e=>setContact({...contact, estSignataire:e.target.checked})}/> Signataire</label></div><button className="btn btn-primary w-fit" type="submit">Ajouter le contact</button></form>}</section>
    <section className="bg-white border rounded-xl p-6"><h2 className="font-bold text-lg flex gap-2 items-center"><MapPin size={20}/> Sites</h2><div className="mt-4 grid md:grid-cols-2 gap-3">{client.sites.map(s => <div key={s.id} className="border rounded-lg p-3 min-w-0"><p className="font-medium break-words">{s.nom}</p><p className="text-sm text-gray-500 break-words">{s.adresse}{s.complementAdresse ? `, ${s.complementAdresse}` : ''}, {s.codePostal} {s.ville}</p><div className="mt-2 flex flex-wrap gap-2">{s.estSiegeSocial && <span className="text-xs bg-slate-100 rounded px-2 py-1">Siège social</span>}{s.estSiteFacturation && <span className="text-xs bg-blue-100 text-blue-800 rounded px-2 py-1">Facturation</span>}{s.estSiteIntervention && <span className="text-xs bg-emerald-100 text-emerald-800 rounded px-2 py-1">Intervention</span>}</div></div>)}</div>{modifiable && <form onSubmit={addSite} className="mt-5 grid md:grid-cols-2 gap-3"><input required placeholder="Nom du site *" value={site.nom} onChange={e=>setSite({...site, nom:e.target.value})} className="border rounded px-3 py-2"/><input required placeholder="Adresse *" value={site.adresse} onChange={e=>setSite({...site, adresse:e.target.value})} className="border rounded px-3 py-2"/><input required placeholder="Code postal *" value={site.codePostal} onChange={e=>setSite({...site, codePostal:e.target.value})} className="border rounded px-3 py-2"/><input required placeholder="Ville *" value={site.ville} onChange={e=>setSite({...site, ville:e.target.value})} className="border rounded px-3 py-2"/><div className="flex gap-3 flex-wrap text-sm"><label><input type="checkbox" checked={site.estSiegeSocial} onChange={e=>setSite({...site, estSiegeSocial:e.target.checked})}/> Siège social</label><label><input type="checkbox" checked={site.estSiteFacturation} onChange={e=>setSite({...site, estSiteFacturation:e.target.checked})}/> Facturation</label><label><input type="checkbox" checked={site.estSiteIntervention} onChange={e=>setSite({...site, estSiteIntervention:e.target.checked})}/> Intervention</label></div><button className="btn btn-primary w-fit" type="submit">Ajouter le site</button></form>}</section>
    {modifiable && <section className="bg-white border rounded-xl p-6"><h2 className="font-bold text-lg">Parc d’équipements installés</h2><div className="mt-4 grid md:grid-cols-2 gap-3">{equipements.length === 0 ? <p className="text-sm text-gray-500">Aucun équipement installé.</p> : equipements.map(e => <article key={e.id} className="border rounded-lg p-3"><div className="flex justify-between gap-3"><div><p className="font-medium">{e.catalogueEquipement.nom}</p><p className="text-sm text-gray-500">{e.catalogueEquipement.reference}{e.catalogueEquipement.fabricant ? ` · ${e.catalogueEquipement.fabricant}` : ''}</p></div><button type="button" onClick={() => archiverEquipement(e.id)} className="text-xs text-red-700">Archiver</button></div><p className="mt-2 text-sm">Site : <b>{e.clientSite.nom}</b></p><p className="text-sm">Série : {e.numeroSerie || '—'} {e.imei ? `· IMEI ${e.imei}` : ''}</p><p className="text-sm">Installé le : {e.installeLe ? formatDateOnly(e.installeLe) : 'non renseigné'}</p><p className="text-sm">Garantie : {e.garantieJusquAu ? formatDateOnly(e.garantieJusquAu) : 'Non renseignée'}</p>{e.notes && <p className="mt-2 text-sm text-gray-600">{e.notes}</p>}</article>)}</div><form onSubmit={addEquipement} className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-3 [&>*]:min-w-0"><select required value={equipement.catalogueEquipementId} onChange={e => setEquipement({...equipement, catalogueEquipementId:e.target.value})} className="border rounded px-3 py-2"><option value="">Modèle équipement *</option>{modeles.map(m => <option key={m.id} value={m.id}>{m.reference} — {m.nom}</option>)}</select><select required value={equipement.clientSiteId} onChange={e => setEquipement({...equipement, clientSiteId:e.target.value})} className="border rounded px-3 py-2"><option value="">Site *</option>{client.sites.map(s => <option key={s.id} value={s.id}>{s.nom}</option>)}</select><input placeholder="Numéro de série" value={equipement.numeroSerie} onChange={e => setEquipement({...equipement, numeroSerie:e.target.value})} className="border rounded px-3 py-2"/><input placeholder="IMEI" value={equipement.imei} onChange={e => setEquipement({...equipement, imei:e.target.value})} className="border rounded px-3 py-2"/><input inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="Installé le (JJ-MM-AAAA)" aria-label="Installé le (JJ-MM-AAAA)" value={equipement.installeLe} onChange={e => setEquipement({...equipement, installeLe:e.target.value})} className="border rounded px-3 py-2"/><input inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="Garantie jusqu’au (JJ-MM-AAAA)" aria-label="Garantie jusqu’au (JJ-MM-AAAA)" value={equipement.garantieJusquAu} onChange={e => setEquipement({...equipement, garantieJusquAu:e.target.value})} className="border rounded px-3 py-2"/><input placeholder="Notes" value={equipement.notes} onChange={e => setEquipement({...equipement, notes:e.target.value})} className="border rounded px-3 py-2"/><button className="btn btn-primary w-fit">Ajouter au parc</button></form></section>}
    <section className="bg-white border rounded-xl p-6" aria-labelledby="historique-chantiers">
      <h2 id="historique-chantiers" className="font-bold text-lg flex gap-2 items-center"><FolderOpen size={20}/> Historique des chantiers</h2>
      {erreurHistorique
        ? <p role="alert" className="mt-3 text-sm text-red-700">L’historique des chantiers n’a pas pu être chargé. Rechargez la page pour réessayer.</p>
        : chantiers.length === 0
          ? <p className="mt-3 text-sm text-gray-500">{modifiable ? 'Aucun chantier relié à cette fiche.' : 'Aucun chantier de ce client ne vous a été confié.'}</p>
          : <ul className="mt-3 divide-y">{chantiers.map(c => <li key={c.id} className="py-3 flex justify-between gap-3 flex-wrap">
              <div className="min-w-0"><Link to={`/chantiers/${c.id}`} className="font-medium text-blue-700">{c.nom}</Link>{c.adresse && <p className="text-sm text-gray-500">{c.adresse}</p>}</div>
              <div className="text-sm text-gray-600 sm:text-right"><p>{STATUTS_CHANTIER[c.statut] ?? c.statut}</p><p>Début : {jourCivilChantier(c.dateDebut, fuseauHoraire)}{c.dateFin ? ` · Fin : ${jourCivilChantier(c.dateFin, fuseauHoraire)}` : ''}</p></div>
            </li>)}</ul>}
      {modifiable && <p className="mt-4 text-sm text-gray-500">Les devis, interventions, e-mails Iris et factures apparaîtront ici au fil des prochains modules.</p>}
    </section>
  </div>;
}
