import { useEffect, useRef, useState } from 'react';
import { FilePlus2, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../api';
import { isAdminRole, useCurrentUser } from '../roles';
import { useCompanyTimezone } from '../companyTimezoneContext';
import { formatCompanyDateTime } from '../lib/dateFormatting';
import { LIBELLES_FAMILLES, ligneAEnvoyer, ligneDepuisCatalogue, ligneEnEdition, ligneVierge, type FicheCatalogueDevis, type LigneDevisSaisie } from '../lib/catalogueDevis';

type ClientContact = { id: string; prenom?: string | null; nom: string; estSignataire: boolean };
type Client = { id: string; raisonSociale: string; contacts: ClientContact[] };
type Ligne = LigneDevisSaisie;
type LigneEnregistree = Omit<LigneDevisSaisie, 'ligneId' | 'prixAchatUnitaireHt'> & { id: string; prixAchatUnitaireHt?: number | null };
type Signature = { signataire: string; empreinte: string; signeLe: string };
type Devis = {
  id: string; numero: string; dossierId: string; version: number; objet: string; statut: string;
  totalHt: number; totalTva: number; totalTtc: number; client: Client; lignes: LigneEnregistree[];
  conversion?: { cibleType: string; cibleId: string } | null;
  acompteExige: boolean; tauxAcompte: number | null; acompteRecuLe: string | null; acompteMontant: number | null;
  motifAnnulation: string | null; signature: Signature | null;
};
type Formulaire = { clientId: string; objet: string; acompteExige: boolean; lignes: Ligne[] };

const ligneVide: Ligne = { designation: '', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 0, tauxTva: 20 };
const formulaireVide = (): Formulaire => ({ clientId: '', objet: '', acompteExige: false, lignes: [{ ...ligneVide }] });

export default function Devis() {
  const utilisateur = useCurrentUser();
  // Horodatage de signature lu à l'heure de la société, et non à celle du navigateur.
  const fuseau = useCompanyTimezone();
  const estAdmin = isAdminRole(utilisateur?.role);
  // Prix d'achat prévu : lu et écrit par l'administration seulement (choix par défaut, à
  // confirmer) ; le serveur ne le transmet à personne d'autre.
  const voitPrixAchat = estAdmin;
  // Le lien vers la fiche d'un chantier ouvert n'est montré qu'à l'administration, qui lit tous
  // les chantiers : hors de son périmètre, un autre porteur du droit devis tomberait sur une
  // fiche « introuvable ».
  const [devis, setDevis] = useState<Devis[]>([]), [clients, setClients] = useState<Client[]>([]);
  const [rechercheClient, setRechercheClient] = useState('');
  const [resultatsClients, setResultatsClients] = useState<Client[] | null>(null);
  const [rechercheEnCours, setRechercheEnCours] = useState(false);
  const [erreurRechercheClient, setErreurRechercheClient] = useState('');
  const [clientSelectionne, setClientSelectionne] = useState<Client | null>(null);
  const requeteClients = useRef(0);
  const [clientSignataire, setClientSignataire] = useState<Client | null>(null);
  const [erreurClientSignataire, setErreurClientSignataire] = useState('');
  const [chargementSignataires, setChargementSignataires] = useState(false);
  const requeteSignataires = useRef(0);
  const [form, setForm] = useState<Formulaire>(formulaireVide());
  const [editionId, setEditionId] = useState<string | null>(null);
  const [devisASigner, setDevisASigner] = useState<Devis | null>(null);
  const [signataire, setSignataire] = useState('');
  const [confirmationSignature, setConfirmationSignature] = useState(false);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  // Recherche dans le catalogue : seule la dernière demande s'affiche.
  const [rechercheCatalogue, setRechercheCatalogue] = useState('');
  const [fichesCatalogue, setFichesCatalogue] = useState<FicheCatalogueDevis[] | null>(null);
  const [erreurCatalogue, setErreurCatalogue] = useState('');
  const requeteCatalogue = useRef(0);

  const load = async () => { setLoading(true); try {
    const [devisRes, clientsRes] = await Promise.all([apiFetch('/devis'), apiFetch('/clients')]);
    const [devisData, clientsData] = await Promise.all([devisRes.json(), clientsRes.json()]);
    if (!devisRes.ok) throw new Error(devisData.error || 'Chargement des devis impossible.');
    if (!clientsRes.ok) throw new Error(clientsData.error || 'Chargement des clients impossible.');
    setDevis(devisData); setClients(clientsData.clients || []);
  } catch (e) { setError(e instanceof Error ? e.message : 'Chargement impossible.'); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const q = rechercheClient.trim();
    if (!q) return;
    const requete = requeteClients.current;
    const minuteur = window.setTimeout(async () => {
      try {
        const response = await apiFetch(`/clients?q=${encodeURIComponent(q)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || 'Recherche impossible.');
        if (requete === requeteClients.current) setResultatsClients(data.clients);
      } catch (e) {
        if (requete === requeteClients.current) setErreurRechercheClient(e instanceof Error ? e.message : 'Recherche impossible.');
      } finally {
        if (requete === requeteClients.current) setRechercheEnCours(false);
      }
    }, 250);
    return () => window.clearTimeout(minuteur);
  }, [rechercheClient]);

  useEffect(() => {
    const q = rechercheCatalogue.trim();
    const requete = ++requeteCatalogue.current;
    if (!q) { setFichesCatalogue(null); setErreurCatalogue(''); return; }
    const minuteur = window.setTimeout(async () => {
      try {
        const response = await apiFetch(`/devis/catalogue?q=${encodeURIComponent(q)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || 'Recherche dans le catalogue impossible.');
        if (requete === requeteCatalogue.current) { setFichesCatalogue(data); setErreurCatalogue(''); }
      } catch (e) {
        if (requete === requeteCatalogue.current) setErreurCatalogue(e instanceof Error ? e.message : 'Recherche dans le catalogue impossible.');
      }
    }, 250);
    return () => window.clearTimeout(minuteur);
  }, [rechercheCatalogue]);

  const ajouterDepuisCatalogue = (fiche: FicheCatalogueDevis) => {
    const ligne = ligneDepuisCatalogue(fiche, voitPrixAchat);
    setForm(f => ({ ...f, lignes: f.lignes.length === 1 && ligneVierge(f.lignes[0]) ? [ligne] : [...f.lignes, ligne] }));
    setRechercheCatalogue('');
  };

  const chercherClient = (valeur: string) => {
    requeteClients.current += 1;
    setRechercheClient(valeur);
    setForm(f => ({ ...f, clientId: '' }));
    setClientSelectionne(null);
    setResultatsClients(valeur.trim() ? [] : null);
    setRechercheEnCours(Boolean(valeur.trim()));
    setErreurRechercheClient('');
  };

  const resetForm = () => { chercherClient(''); setRechercheCatalogue(''); setEditionId(null); setForm(formulaireVide()); };
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setSaving(true); setError(''); try {
    const route = editionId ? `/devis/${editionId}` : '/devis';
    const corps = { ...form, lignes: form.lignes.map(ligne => ligneAEnvoyer(ligne, voitPrixAchat)) };
    const res = await apiFetch(route, { method: editionId ? 'PATCH' : 'POST', body: JSON.stringify(corps) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Enregistrement impossible.');
    resetForm(); await load();
  } catch (e) { setError(e instanceof Error ? e.message : 'Enregistrement impossible.'); } finally { setSaving(false); } };
  const commencerEdition = (d: Devis) => {
    if (d.signature || !['BROUILLON', 'ENVOYE'].includes(d.statut) || d.conversion) return;
    chercherClient('');
    setClientSelectionne(d.client);
    setEditionId(d.id);
    setForm({ clientId: d.client.id, objet: d.objet, acompteExige: d.acompteExige, lignes: d.lignes.map(ligne => ligneEnEdition(ligne, voitPrixAchat)) });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const creerRevision = async (id: string) => { setError(''); try {
    const res = await apiFetch(`/devis/${id}/revisions`, { method: 'POST' }), data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Révision impossible.');
    commencerEdition(data); await load();
  } catch (e) { setError(e instanceof Error ? e.message : 'Révision impossible.'); } };
  const ouvrirSignature = async (d: Devis) => {
    const requete = ++requeteSignataires.current;
    setError(''); setDevisASigner(d); setSignataire(''); setConfirmationSignature(false);
    setClientSignataire(null); setErreurClientSignataire(''); setChargementSignataires(true);
    try {
      const response = await apiFetch(`/clients/${d.client.id}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Chargement des contacts impossible.');
      if (requete === requeteSignataires.current) setClientSignataire(data);
    } catch (e) {
      if (requete === requeteSignataires.current) setErreurClientSignataire(e instanceof Error ? e.message : 'Chargement des contacts impossible.');
    } finally {
      if (requete === requeteSignataires.current) setChargementSignataires(false);
    }
  };
  const signer = async (event: React.FormEvent) => { event.preventDefault(); if (!devisASigner) return; setError(''); setSaving(true); try {
    const res = await apiFetch(`/devis/${devisASigner.id}/signature`, { method: 'POST', body: JSON.stringify({ signataire, confirme: confirmationSignature }) }), data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Signature impossible.');
    setDevisASigner(null); setSignataire(''); setConfirmationSignature(false);
    await load();
  } catch (e) { setError(e instanceof Error ? e.message : 'Signature impossible.'); } finally { setSaving(false); } };
  const statut = async (id: string, valeur: string) => { try {
    const res = await apiFetch(`/devis/${id}/statut`, { method: 'PUT', body: JSON.stringify({ statut: valeur }) }), data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Mise à jour impossible.'); await load();
  } catch (e) { setError(e instanceof Error ? e.message : 'Mise à jour impossible.'); } };
  const convertir = async (id: string) => { try {
    const res = await apiFetch(`/devis/${id}/convertir`, { method: 'POST', body: JSON.stringify({ cible: 'CHANTIER' }) }), data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Conversion impossible.'); await load();
  } catch (e) { setError(e instanceof Error ? e.message : 'Conversion impossible.'); } };
  const constaterAcompte = async (id: string) => { setError(''); try {
    const recuLe = window.prompt('Date de réception de l’acompte (JJ-MM-AAAA) ?')?.trim(); if (!recuLe) return;
    const montant = window.prompt('Montant reçu (€) ?')?.trim(); if (!montant) return;
    const reference = window.prompt('Référence du règlement ?')?.trim(); if (!reference) return;
    const res = await apiFetch(`/devis/${id}/acompte`, { method: 'POST', body: JSON.stringify({ recuLe, montant, reference }) }), data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Constatation impossible.'); await load();
  } catch (e) { setError(e instanceof Error ? e.message : 'Constatation impossible.'); } };
  const annuler = async (id: string) => { setError(''); try {
    const motif = window.prompt('Motif de l’annulation de ce devis ?')?.trim(); if (!motif) return;
    const res = await apiFetch(`/devis/${id}/annulation`, { method: 'POST', body: JSON.stringify({ motif }) }), data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Annulation impossible.'); await load();
  } catch (e) { setError(e instanceof Error ? e.message : 'Annulation impossible.'); } };
  const dupliquer = async (id: string) => { setError(''); try {
    const res = await apiFetch(`/devis/${id}/duplication`, { method: 'POST' }), data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Duplication impossible.'); await load();
  } catch (e) { setError(e instanceof Error ? e.message : 'Duplication impossible.'); } };
  const updateLine = (index: number, key: keyof Ligne, value: string) => setForm(f => ({ ...f, lignes: f.lignes.map((ligne, i) => i === index ? { ...ligne, [key]: key === 'designation' || key === 'nature' || key === 'unite' || key === 'prixAchatUnitaireHt' ? value : Number(value) } as Ligne : ligne) }));
  const addLine = () => setForm(f => ({ ...f, lignes: [...f.lignes, { ...ligneVide }] }));
  const removeLine = (index: number) => setForm(f => ({ ...f, lignes: f.lignes.filter((_, i) => i !== index) }));
  const estDerniereVersion = (d: Devis, inclureAnnulees = true) => !devis.some(autre => autre.dossierId === d.dossierId && autre.version > d.version && (inclureAnnulees || autre.statut !== 'ANNULE'));
  const optionsClients = resultatsClients ?? clients;

  return <div className="max-w-6xl mx-auto space-y-6">
    <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between sm:items-center"><div><h1 className="text-2xl font-bold">Devis</h1><p className="text-gray-500">Éditables jusqu’à la signature du client, puis révisables par nouvelle version.</p></div><button className="btn border flex items-center gap-2" onClick={() => void load()}><RefreshCw size={16}/> Actualiser</button></div>
    {error && <p className="text-red-600">{error}</p>}
    {devisASigner && <form role="dialog" aria-label="Signature client" onSubmit={signer} className="bg-blue-50 border border-blue-200 rounded-xl p-5 space-y-3">
      <div><h2 className="font-semibold">Signature client</h2><p className="text-sm text-gray-600">Le client confirme le devis figé. L’employé connecté enregistre son acceptation.</p></div>
      <label className="text-sm font-medium block">Enregistré par<input aria-label="Enregistré par" readOnly className="mt-1 w-full border rounded px-3 py-2 bg-gray-100" value={utilisateur?.name || 'Session interne active'}/></label>
      <label className="text-sm font-medium block">Signataire client<select aria-label="Signataire client" className="mt-1 w-full border rounded px-3 py-2" value={signataire} onChange={e => setSignataire(e.target.value)} disabled={chargementSignataires || Boolean(erreurClientSignataire)}><option value="">Sélectionner un contact habilité…</option>{(clientSignataire?.contacts || []).filter(contact => contact.estSignataire).map(contact => { const nom = `${contact.prenom ? `${contact.prenom} ` : ''}${contact.nom}`; return <option key={contact.id} value={nom}>{nom}</option>; })}</select></label>
      {chargementSignataires && <p role="status">Chargement des contacts…</p>}
      {erreurClientSignataire && <p role="alert" className="text-red-600">{erreurClientSignataire}</p>}
      <label className="text-sm font-medium block">Ou saisir un autre signataire client<input aria-label="Autre signataire client" className="mt-1 w-full border rounded px-3 py-2" value={signataire} onChange={e => setSignataire(e.target.value)} placeholder="Nom complet du client"/></label>
      <label className="flex items-center gap-2 text-sm"><input aria-label="Confirmation du client" type="checkbox" checked={confirmationSignature} onChange={e => setConfirmationSignature(e.target.checked)}/><span>Le client confirme avoir lu et accepté ce devis.</span></label>
      <div className="flex gap-2"><button type="button" className="btn border" onClick={() => { requeteSignataires.current += 1; setDevisASigner(null); }}>Annuler</button><button disabled={saving || signataire.trim().length < 2 || !confirmationSignature} className="btn bg-blue-700 text-white">Enregistrer la signature client</button></div>
    </form>}
    <form onSubmit={submit} className="bg-white border rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between"><h2 className="font-semibold flex gap-2 items-center"><FilePlus2 size={18}/>{editionId ? 'Modifier le brouillon' : 'Nouveau devis'}</h2>{editionId && <button type="button" className="btn border" onClick={resetForm}>Annuler l’édition</button>}</div>
      <div className="grid md:grid-cols-2 gap-3"><div><label htmlFor="recherche-client-devis" className="text-sm font-medium">Rechercher un client</label><input id="recherche-client-devis" type="search" className="mt-1 w-full border rounded px-3 py-2" value={rechercheClient} onChange={e => chercherClient(e.target.value)} placeholder="Nom commercial, raison sociale ou SIREN" aria-controls="clientId-devis"/><select id="clientId-devis" name="clientId" aria-label="Client du devis" required className="mt-1 w-full border rounded px-3 py-2" value={form.clientId} disabled={rechercheEnCours || Boolean(erreurRechercheClient)} onChange={e => { const client = optionsClients.find(c => c.id === e.target.value) ?? clientSelectionne; setClientSelectionne(client?.id === e.target.value ? client : null); setForm(f => ({ ...f, clientId: e.target.value })); }}><option value="">Sélectionner…</option>{optionsClients.map(c => <option key={c.id} value={c.id}>{c.raisonSociale}</option>)}{clientSelectionne && !optionsClients.some(c => c.id === clientSelectionne.id) && <option value={clientSelectionne.id}>{clientSelectionne.raisonSociale}</option>}</select>{rechercheEnCours && <p role="status">Recherche en cours…</p>}{erreurRechercheClient && <p role="alert" className="text-red-600">{erreurRechercheClient}</p>}{resultatsClients?.length === 200 && !rechercheEnCours && <p role="status" aria-label="Limite des résultats clients">200 clients maximum affichés ; veuillez affiner votre recherche.</p>}{resultatsClients?.length === 0 && !rechercheEnCours && !erreurRechercheClient && <p role="status">Aucun client actif trouvé.</p>}</div><label className="text-sm font-medium">Objet<input required className="mt-1 w-full border rounded px-3 py-2" value={form.objet} onChange={e => setForm(f => ({ ...f, objet: e.target.value }))}/></label></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="w-4 h-4" checked={form.acompteExige} onChange={e => setForm(f => ({ ...f, acompteExige: e.target.checked }))}/><span>Exiger un acompte avant l’ouverture du chantier</span></label>
      <div className="border rounded-lg p-3 bg-gray-50 space-y-2">
        <label htmlFor="recherche-catalogue-devis" className="text-sm font-medium">Ajouter depuis le catalogue</label>
        <input id="recherche-catalogue-devis" type="search" className="w-full border rounded px-3 py-2 bg-white" value={rechercheCatalogue} onChange={e => setRechercheCatalogue(e.target.value)} placeholder="Référence ou désignation d’une prestation, d’un article ou d’un équipement" aria-label="Rechercher dans le catalogue"/>
        <p className="text-xs text-gray-500">La ligne est copiée dans le devis : modifier ou retirer la fiche ensuite ne change pas ce devis.</p>
        {erreurCatalogue && <p role="alert" className="text-sm text-red-600">{erreurCatalogue}</p>}
        {fichesCatalogue && (fichesCatalogue.length === 0
          ? <p role="status" className="text-sm text-gray-500">Aucune fiche active trouvée.</p>
          : <ul aria-label="Fiches du catalogue" className="divide-y bg-white border rounded">{fichesCatalogue.map(fiche => <li key={`${fiche.famille}-${fiche.id}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm"><span className="min-w-0"><strong className="break-words">{fiche.nom}</strong> <span className="text-gray-500">· {LIBELLES_FAMILLES[fiche.famille]} · Réf. {fiche.reference} · {fiche.prixVenteHt.toFixed(2)} € HT{fiche.unite ? ` / ${fiche.unite}` : ''}</span></span><button type="button" className="btn border shrink-0" aria-label={`Ajouter ${fiche.nom}`} onClick={() => ajouterDepuisCatalogue(fiche)}>Ajouter</button></li>)}</ul>)}
      </div>
      <div className="space-y-2">{form.lignes.map((ligne, index) => <div key={index} className={`grid gap-2 items-end ${voitPrixAchat ? 'md:grid-cols-[1fr_110px_90px_90px_110px_80px_110px_auto]' : 'md:grid-cols-[1fr_110px_90px_90px_110px_80px_auto]'}`}><label className="text-sm">Désignation<input required className="mt-1 w-full border rounded px-2 py-2" value={ligne.designation} onChange={e => updateLine(index, 'designation', e.target.value)}/>{ligne.catalogueId && <span className="block text-xs text-gray-500 mt-0.5">Copiée du catalogue{ligne.reference ? ` · Réf. ${ligne.reference}` : ''}</span>}</label><label className="text-sm">Nature<select className="mt-1 w-full border rounded px-2 py-2" value={ligne.nature} onChange={e => updateLine(index, 'nature', e.target.value)}><option value="MAIN_OEUVRE">Main-d’œuvre</option><option value="FOURNITURE">Fourniture</option></select></label><label className="text-sm">Qté<input required min="0.001" step="0.001" type="number" className="mt-1 w-full border rounded px-2 py-2" value={ligne.quantite} onChange={e => updateLine(index, 'quantite', e.target.value)}/></label><label className="text-sm">Unité<input maxLength={40} className="mt-1 w-full border rounded px-2 py-2" value={ligne.unite ?? ''} onChange={e => updateLine(index, 'unite', e.target.value)}/></label><label className="text-sm">PU HT<input required min="0" step="0.01" type="number" className="mt-1 w-full border rounded px-2 py-2" value={ligne.prixUnitaireHt} onChange={e => updateLine(index, 'prixUnitaireHt', e.target.value)}/></label><label className="text-sm">TVA %<input required min="0" max="100" step="0.1" type="number" className="mt-1 w-full border rounded px-2 py-2" value={ligne.tauxTva} onChange={e => updateLine(index, 'tauxTva', e.target.value)}/></label>{voitPrixAchat && <label className="text-sm">Prix d’achat prévu<input inputMode="decimal" className="mt-1 w-full border rounded px-2 py-2" value={ligne.prixAchatUnitaireHt ?? ''} onChange={e => updateLine(index, 'prixAchatUnitaireHt', e.target.value)} placeholder="facultatif"/></label>}{form.lignes.length > 1 && <button type="button" className="btn border" onClick={() => removeLine(index)}>Retirer</button>}</div>)}</div>
      <div className="flex gap-2"><button type="button" className="btn border" onClick={addLine}>Ajouter une ligne</button><button disabled={saving} className="btn bg-blue-700 text-white">{saving ? 'Enregistrement…' : editionId ? 'Enregistrer le brouillon' : 'Créer le brouillon'}</button></div>
    </form>
    <section className="bg-white border rounded-xl overflow-hidden"><div className="p-5 border-b"><h2 className="font-semibold">Historique des devis</h2></div>{loading ? <p className="p-6 text-gray-500">Chargement…</p> : devis.length === 0 ? <p className="p-6 text-gray-500">Aucun devis créé.</p> : <ul className="divide-y">{devis.map(d => <li className="p-4 flex justify-between gap-4 items-center" key={d.id}><div><p className="font-semibold">{d.numero} — {d.objet} <span className="text-sm text-gray-500">v{d.version} · {d.statut}</span></p><p className="text-sm text-gray-500">{d.client.raisonSociale} · HT {d.totalHt.toFixed(2)} € · TVA {d.totalTva.toFixed(2)} € · TTC {d.totalTtc.toFixed(2)} €</p>{d.signature && <p className="text-sm text-blue-700">Signature client : {d.signature.signataire} le {formatCompanyDateTime(d.signature.signeLe, fuseau)} · empreinte SHA-256 conservée</p>}{d.conversion && <p className={`text-sm ${d.statut === 'ANNULE' ? 'text-gray-600' : 'text-green-700'}`}>{d.statut === 'ANNULE' ? 'Chantier annulé avec le devis' : 'Chantier issu de ce devis'}{estAdmin ? <> : <Link to={`/chantiers/${d.conversion.cibleId}`} className="underline font-semibold">voir la fiche</Link></> : '.'}</p>}{d.acompteExige && <p className="text-sm text-amber-700">{d.acompteRecuLe ? `Acompte de ${(d.acompteMontant ?? 0).toFixed(2)} € constaté` : `Acompte de ${d.tauxAcompte ?? 0} % exigé avant ouverture du chantier`}</p>}{d.statut === 'ANNULE' && d.motifAnnulation && <p className="text-sm text-red-700">Annulé : {d.motifAnnulation}</p>}</div><div className="flex gap-2 flex-wrap">{!d.signature && ['BROUILLON', 'ENVOYE'].includes(d.statut) && !d.conversion && <><button className="btn border" onClick={() => commencerEdition(d)}>Modifier</button><button className="btn border" onClick={() => ouvrirSignature(d)}>Faire signer le client</button></>}{d.signature && !d.conversion && d.statut !== 'ANNULE' && estDerniereVersion(d) && <button className="btn border" onClick={() => void creerRevision(d.id)}>Créer une révision</button>}<button className="btn border" onClick={() => void dupliquer(d.id)}>Dupliquer</button>{d.statut === 'BROUILLON' && <button className="btn border" onClick={() => void statut(d.id, 'ENVOYE')}>Envoyer</button>}{d.statut === 'ENVOYE' && <button className="btn border" onClick={() => void statut(d.id, 'REFUSE')}>Refuser</button>}{d.statut === 'ACCEPTE' && !d.conversion && d.acompteExige && !d.acompteRecuLe && <button className="btn border" onClick={() => void statut(d.id, 'EN_ATTENTE_ACOMPTE')}>Attendre l’acompte</button>}{d.acompteExige && !d.acompteRecuLe && d.statut !== 'ANNULE' && estAdmin && <button className="btn border" onClick={() => void constaterAcompte(d.id)}>Constater l’acompte</button>}{d.statut === 'ACCEPTE' && d.signature && !d.conversion && estDerniereVersion(d, false) && (!d.acompteExige || !!d.acompteRecuLe) && <button className="btn border" onClick={() => void convertir(d.id)}>Ouvrir le chantier</button>}{d.statut !== 'ANNULE' && estAdmin && <button className="btn border text-red-700" onClick={() => void annuler(d.id)}>Annuler</button>}</div></li>)}</ul>}</section>
  </div>;
}
