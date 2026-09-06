import { useEffect, useState } from 'react';
import { FilePlus2, RefreshCw } from 'lucide-react';
import { apiFetch } from '../api';
import { isAdminRole, useCurrentUser } from '../roles';

type Client = { id: string; raisonSociale: string };
type Ligne = { designation: string; nature: 'MAIN_OEUVRE' | 'FOURNITURE'; quantite: number; prixUnitaireHt: number; tauxTva: number };
type Devis = { id: string; numero: string; dossierId: string; version: number; objet: string; statut: string; totalHt: number; totalTva: number; totalTtc: number; client: Client; lignes: Ligne[]; conversion?: { cibleType: string; cibleId: string } | null; acompteExige: boolean; tauxAcompte: number | null; acompteRecuLe: string | null; acompteMontant: number | null; motifAnnulation: string | null };
const ligneVide: Ligne = { designation: '', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 0, tauxTva: 20 };

export default function Devis() {
  // Annulation et constatation d'acompte sont réservées à l'administration ; le serveur
  // applique la même règle, l'affichage ne fait que ne pas proposer l'impossible.
  const estAdmin = isAdminRole(useCurrentUser()?.role);
  const [devis, setDevis] = useState<Devis[]>([]), [clients, setClients] = useState<Client[]>([]);
  const [form, setForm] = useState({ clientId: '', objet: '', acompteExige: false, lignes: [{ ...ligneVide }] });
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const load = async () => { setLoading(true); try {
    const [devisRes, clientsRes] = await Promise.all([apiFetch('/devis'), apiFetch('/clients')]);
    const [devisData, clientsData] = await Promise.all([devisRes.json(), clientsRes.json()]);
    if (!devisRes.ok) throw new Error(devisData.error || 'Chargement des devis impossible.');
    if (!clientsRes.ok) throw new Error(clientsData.error || 'Chargement des clients impossible.');
    setDevis(devisData); setClients(clientsData.clients || []);
  } catch (e) { setError(e instanceof Error ? e.message : 'Chargement impossible.'); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, []);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setSaving(true); setError(''); try {
    const res = await apiFetch('/devis', { method: 'POST', body: JSON.stringify(form) }), data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Création impossible.');
    setForm({ clientId: '', objet: '', acompteExige: false, lignes: [{ ...ligneVide }] }); await load();
  } catch (e) { setError(e instanceof Error ? e.message : 'Création impossible.'); } finally { setSaving(false); } };
  const revise = async (id: string) => { setError(''); try { const res = await apiFetch(`/devis/${id}/revisions`, { method: 'POST' }), data = await res.json(); if (!res.ok) throw new Error(data.error || 'Révision impossible.'); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Révision impossible.'); } };
  const statut = async (id: string, valeur: string) => { try { const res = await apiFetch(`/devis/${id}/statut`, { method: 'PUT', body: JSON.stringify({ statut: valeur }) }), data = await res.json(); if (!res.ok) throw new Error(data.error || 'Mise à jour impossible.'); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Mise à jour impossible.'); } };
  const convertir = async (id: string) => { try { const res = await apiFetch(`/devis/${id}/convertir`, { method: 'POST', body: JSON.stringify({ cible: 'CHANTIER' }) }), data = await res.json(); if (!res.ok) throw new Error(data.error || 'Conversion impossible.'); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Conversion impossible.'); } };
  // Constatation manuelle de l'acompte : tant que le module paiements n'existe pas, c'est
  // un administrateur qui saisit la date, le montant et la référence du règlement reçu.
  const constaterAcompte = async (id: string) => { setError(''); try {
    const recuLe = window.prompt('Date de réception de l’acompte (JJ-MM-AAAA) ?')?.trim();
    if (!recuLe) return;
    const montant = window.prompt('Montant reçu (€) ?')?.trim();
    if (!montant) return;
    const reference = window.prompt('Référence du règlement (virement, chèque…) ?')?.trim();
    if (!reference) return;
    const res = await apiFetch(`/devis/${id}/acompte`, { method: 'POST', body: JSON.stringify({ recuLe, montant, reference }) }), data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Constatation impossible.'); await load();
  } catch (e) { setError(e instanceof Error ? e.message : 'Constatation impossible.'); } };
  // Annuler un devis archive le chantier qui en est issu : le motif est obligatoire et
  // l'opération est refusée dès qu'une heure ou un achat a été saisi.
  const annuler = async (id: string) => { setError(''); try {
    const motif = window.prompt('Motif de l’annulation de ce devis ? (conservé avec l’affaire archivée)')?.trim();
    if (!motif) return;
    const res = await apiFetch(`/devis/${id}/annulation`, { method: 'POST', body: JSON.stringify({ motif }) }), data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Annulation impossible.'); await load();
  } catch (e) { setError(e instanceof Error ? e.message : 'Annulation impossible.'); } };
  // Reprise après annulation : un devis neuf, identique, avec son propre numéro d'affaire.
  const dupliquer = async (id: string) => { setError(''); try {
    const res = await apiFetch(`/devis/${id}/duplication`, { method: 'POST' }), data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Duplication impossible.'); await load();
  } catch (e) { setError(e instanceof Error ? e.message : 'Duplication impossible.'); } };
  const updateLine = (index: number, key: keyof Ligne, value: string) => setForm(f => ({ ...f, lignes: f.lignes.map((ligne, i) => i === index ? { ...ligne, [key]: key === 'designation' || key === 'nature' ? value : Number(value) } : ligne) }));
  const addLine = () => setForm(f => ({ ...f, lignes: [...f.lignes, { ...ligneVide }] }));
  const removeLine = (index: number) => setForm(f => ({ ...f, lignes: f.lignes.filter((_, i) => i !== index) }));
  return <div className="max-w-6xl mx-auto space-y-6">
    <div className="flex items-center justify-between gap-3"><div><h1 className="text-2xl font-bold">Devis</h1><p className="text-gray-500">Propositions commerciales versionnées et traçables.</p></div><button className="btn border flex items-center gap-2" onClick={() => void load()}><RefreshCw size={16}/> Actualiser</button></div>
    {error && <p className="text-red-600">{error}</p>}
    <form onSubmit={submit} className="bg-white border rounded-xl p-5 space-y-4"><h2 className="font-semibold flex gap-2 items-center"><FilePlus2 size={18}/> Nouveau devis</h2><div className="grid md:grid-cols-2 gap-3"><label className="text-sm font-medium">Client<select required className="mt-1 w-full border rounded px-3 py-2" value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))}><option value="">Sélectionner…</option>{clients.map(c => <option key={c.id} value={c.id}>{c.raisonSociale}</option>)}</select></label><label className="text-sm font-medium">Objet<input required className="mt-1 w-full border rounded px-3 py-2" value={form.objet} onChange={e => setForm(f => ({ ...f, objet: e.target.value }))}/></label></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" className="w-4 h-4" checked={form.acompteExige} onChange={e => setForm(f => ({ ...f, acompteExige: e.target.checked }))}/><span>Exiger un acompte avant l’ouverture du chantier <span className="text-gray-500">(le taux par défaut du paramétrage est figé sur ce devis)</span></span></label><div className="space-y-2">{form.lignes.map((ligne, index) => <div key={index} className="grid md:grid-cols-[1fr_110px_130px_100px_auto] gap-2 items-end"><label className="text-sm">Désignation<input required className="mt-1 w-full border rounded px-2 py-2" value={ligne.designation} onChange={e => updateLine(index, 'designation', e.target.value)}/></label><label className="text-sm">Nature<select className="mt-1 w-full border rounded px-2 py-2" value={ligne.nature} onChange={e => updateLine(index, 'nature', e.target.value)}><option value="MAIN_OEUVRE">Main-d’œuvre</option><option value="FOURNITURE">Fourniture</option></select></label><label className="text-sm">Qté<input required min="0.001" step="0.001" type="number" className="mt-1 w-full border rounded px-2 py-2" value={ligne.quantite} onChange={e => updateLine(index, 'quantite', e.target.value)}/></label><label className="text-sm">PU HT<input required min="0" step="0.01" type="number" className="mt-1 w-full border rounded px-2 py-2" value={ligne.prixUnitaireHt} onChange={e => updateLine(index, 'prixUnitaireHt', e.target.value)}/></label><label className="text-sm">TVA %<input required min="0" step="0.1" type="number" className="mt-1 w-full border rounded px-2 py-2" value={ligne.tauxTva} onChange={e => updateLine(index, 'tauxTva', e.target.value)}/></label>{form.lignes.length > 1 && <button className="btn border" type="button" onClick={() => removeLine(index)}>Retirer</button>}</div>)}<button className="btn border" type="button" onClick={addLine}>Ajouter une ligne</button></div><button disabled={saving} className="btn btn-primary" type="submit">{saving ? 'Création…' : 'Créer le brouillon'}</button></form>
    <section className="bg-white border rounded-xl overflow-hidden"><div className="p-5 border-b"><h2 className="font-semibold">Historique des devis</h2></div>{loading ? <p className="p-6 text-gray-500">Chargement…</p> : devis.length === 0 ? <p className="p-6 text-gray-500">Aucun devis créé.</p> : <ul className="divide-y">{devis.map(d => <li className="p-4 flex justify-between gap-4 items-center" key={d.id}><div><p className="font-semibold">{d.numero} — {d.objet} <span className="text-sm text-gray-500">v{d.version} · {d.statut}</span></p><p className="text-sm text-gray-500">{d.client.raisonSociale} · HT {d.totalHt.toFixed(2)} € · TVA {d.totalTva.toFixed(2)} € · TTC {d.totalTtc.toFixed(2)} €</p>{d.conversion && <p className="text-sm text-green-700">Chantier créé : {d.conversion.cibleId}</p>}{d.acompteExige && <p className="text-sm text-amber-700">{d.acompteRecuLe ? `Acompte de ${(d.acompteMontant ?? 0).toFixed(2)} € constaté` : `Acompte de ${d.tauxAcompte ?? 0} % exigé avant ouverture du chantier`}</p>}{d.statut === 'ANNULE' && d.motifAnnulation && <p className="text-sm text-red-700">Annulé : {d.motifAnnulation}</p>}</div><div className="flex gap-2 flex-wrap">{d.statut !== 'ANNULE' && <button className="btn border" onClick={() => void revise(d.id)}>Réviser</button>}<button className="btn border" onClick={() => void dupliquer(d.id)}>Dupliquer</button>{d.statut === 'BROUILLON' && <button className="btn border" onClick={() => void statut(d.id, 'ENVOYE')}>Envoyer</button>}{d.statut === 'ENVOYE' && <><button className="btn border" onClick={() => void statut(d.id, 'ACCEPTE')}>Accepter</button><button className="btn border" onClick={() => void statut(d.id, 'REFUSE')}>Refuser</button></>}{d.statut === 'ACCEPTE' && !d.conversion && d.acompteExige && !d.acompteRecuLe && <button className="btn border" onClick={() => void statut(d.id, 'EN_ATTENTE_ACOMPTE')}>Mettre en attente d’acompte</button>}{d.acompteExige && !d.acompteRecuLe && d.statut !== 'ANNULE' && estAdmin && <button className="btn border" onClick={() => void constaterAcompte(d.id)}>Constater l’acompte</button>}{d.statut === 'ACCEPTE' && !d.conversion && <button className="btn btn-primary" onClick={() => void convertir(d.id)}>Créer le chantier</button>}{d.statut !== 'ANNULE' && d.statut !== 'REFUSE' && estAdmin && <button className="btn border text-red-700" onClick={() => void annuler(d.id)}>Annuler le devis</button>}</div></li>)}</ul>}</section>
  </div>;
}
