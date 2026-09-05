import { useEffect, useState } from 'react';
import { FilePlus2, RefreshCw } from 'lucide-react';
import { apiFetch } from '../api';

type Client = { id: string; raisonSociale: string };
type Ligne = { designation: string; quantite: number; prixUnitaireHt: number; tauxTva: number };
type Devis = { id: string; dossierId: string; version: number; objet: string; statut: string; totalHt: number; totalTva: number; totalTtc: number; client: Client; lignes: Ligne[] };
const ligneVide: Ligne = { designation: '', quantite: 1, prixUnitaireHt: 0, tauxTva: 20 };

export default function Devis() {
  const [devis, setDevis] = useState<Devis[]>([]), [clients, setClients] = useState<Client[]>([]);
  const [form, setForm] = useState({ clientId: '', objet: '', lignes: [{ ...ligneVide }] });
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
    setForm({ clientId: '', objet: '', lignes: [{ ...ligneVide }] }); await load();
  } catch (e) { setError(e instanceof Error ? e.message : 'Création impossible.'); } finally { setSaving(false); } };
  const revise = async (id: string) => { setError(''); try { const res = await apiFetch(`/devis/${id}/revisions`, { method: 'POST' }), data = await res.json(); if (!res.ok) throw new Error(data.error || 'Révision impossible.'); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Révision impossible.'); } };
  const updateLine = (key: keyof Ligne, value: string) => setForm(f => ({ ...f, lignes: [{ ...f.lignes[0], [key]: key === 'designation' ? value : Number(value) }] }));
  return <div className="max-w-6xl mx-auto space-y-6">
    <div className="flex items-center justify-between gap-3"><div><h1 className="text-2xl font-bold">Devis</h1><p className="text-gray-500">Propositions commerciales versionnées et traçables.</p></div><button className="btn border flex items-center gap-2" onClick={() => void load()}><RefreshCw size={16}/> Actualiser</button></div>
    {error && <p className="text-red-600">{error}</p>}
    <form onSubmit={submit} className="bg-white border rounded-xl p-5 space-y-4"><h2 className="font-semibold flex gap-2 items-center"><FilePlus2 size={18}/> Nouveau devis</h2><div className="grid md:grid-cols-2 gap-3"><label className="text-sm font-medium">Client<select required className="mt-1 w-full border rounded px-3 py-2" value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))}><option value="">Sélectionner…</option>{clients.map(c => <option key={c.id} value={c.id}>{c.raisonSociale}</option>)}</select></label><label className="text-sm font-medium">Objet<input required className="mt-1 w-full border rounded px-3 py-2" value={form.objet} onChange={e => setForm(f => ({ ...f, objet: e.target.value }))}/></label></div><div className="grid md:grid-cols-4 gap-2"><label className="text-sm">Désignation<input required className="mt-1 w-full border rounded px-2 py-2" value={form.lignes[0].designation} onChange={e => updateLine('designation', e.target.value)}/></label><label className="text-sm">Qté<input required min="0.001" step="0.001" type="number" className="mt-1 w-full border rounded px-2 py-2" value={form.lignes[0].quantite} onChange={e => updateLine('quantite', e.target.value)}/></label><label className="text-sm">PU HT<input required min="0" step="0.01" type="number" className="mt-1 w-full border rounded px-2 py-2" value={form.lignes[0].prixUnitaireHt} onChange={e => updateLine('prixUnitaireHt', e.target.value)}/></label><label className="text-sm">TVA %<input required min="0" step="0.1" type="number" className="mt-1 w-full border rounded px-2 py-2" value={form.lignes[0].tauxTva} onChange={e => updateLine('tauxTva', e.target.value)}/></label></div><button disabled={saving} className="btn btn-primary" type="submit">{saving ? 'Création…' : 'Créer le brouillon'}</button></form>
    <section className="bg-white border rounded-xl overflow-hidden"><div className="p-5 border-b"><h2 className="font-semibold">Historique des devis</h2></div>{loading ? <p className="p-6 text-gray-500">Chargement…</p> : devis.length === 0 ? <p className="p-6 text-gray-500">Aucun devis créé.</p> : <ul className="divide-y">{devis.map(d => <li className="p-4 flex justify-between gap-4 items-center" key={d.id}><div><p className="font-semibold">{d.objet} <span className="text-sm text-gray-500">— v{d.version} · {d.statut}</span></p><p className="text-sm text-gray-500">{d.client.raisonSociale} · HT {d.totalHt.toFixed(2)} € · TVA {d.totalTva.toFixed(2)} € · TTC {d.totalTtc.toFixed(2)} €</p></div><button className="btn border" onClick={() => void revise(d.id)}>Créer une révision</button></li>)}</ul>}</section>
  </div>;
}
