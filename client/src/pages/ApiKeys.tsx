import { useEffect, useState } from 'react';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { apiFetch } from '../api';

type Key = { id: string; nom: string; prefixe: string; scopes: string[]; actif: boolean; expireLe?: string | null; dernierUsageLe?: string | null; creeLe: string; revoqueLe?: string | null };
const SCOPES = ['clients:read', 'company:read'];

export default function ApiKeys() {
  const [keys, setKeys] = useState<Key[]>([]); const [nom, setNom] = useState(''); const [scopes, setScopes] = useState<string[]>(['clients:read']); const [revealed, setRevealed] = useState(''); const [error, setError] = useState('');
  const load = async () => { const res = await apiFetch('/admin/api-keys'); const data = await res.json(); if (res.ok) setKeys(data); else setError(data.error || 'Chargement impossible.'); };
  useEffect(() => { void load(); }, []);
  const create = async (e: React.FormEvent) => { e.preventDefault(); setError(''); const res = await apiFetch('/admin/api-keys', { method: 'POST', body: JSON.stringify({ nom, scopes }) }); const data = await res.json(); if (!res.ok) return setError(data.error || 'Création impossible.'); setRevealed(data.apiKey); setNom(''); await load(); };
  const revoke = async (id: string) => { if (!window.confirm('Révoquer cette clé ? L’intégration perdra immédiatement son accès.')) return; const res = await apiFetch(`/admin/api-keys/${id}/revoke`, { method: 'POST' }); if (!res.ok) setError('Révocation impossible.'); else await load(); };
  return <div className="max-w-4xl mx-auto space-y-6"><div><h1 className="text-2xl font-bold">API d’intégration</h1><p className="text-gray-500">Clés machine-à-machine pour Hermes et applications autorisées.</p></div>
    {revealed && <section className="border border-amber-400 bg-amber-50 rounded-xl p-5"><div className="flex gap-2 font-semibold text-amber-900"><ShieldAlert /> Copiez cette clé maintenant</div><p className="text-sm mt-2">Elle ne sera plus jamais affichée. Ne la transmettez ni par e-mail ni dans Git.</p><code className="block mt-3 bg-white p-3 rounded break-all">{revealed}</code><button className="mt-3 btn-primary" onClick={() => { navigator.clipboard?.writeText(revealed); setRevealed(''); }}>Copier puis fermer</button></section>}
    {error && <p className="text-red-600">{error}</p>}<section className="bg-white border rounded-xl p-5"><h2 className="font-semibold flex gap-2"><KeyRound size={20}/> Créer une clé</h2><form onSubmit={create} className="mt-4 space-y-3"><input required value={nom} onChange={e=>setNom(e.target.value)} placeholder="Ex. Hermes production" className="w-full border rounded px-3 py-2"/><div className="flex gap-4">{SCOPES.map(scope => <label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={e=>setScopes(e.target.checked ? [...scopes, scope] : scopes.filter(s=>s!==scope))}/> {scope}</label>)}</div><button className="btn-primary" disabled={scopes.length===0}>Créer la clé</button></form></section>
    <section className="bg-white border rounded-xl overflow-hidden"><div className="p-5 font-semibold">Clés actives et révoquées</div><ul className="divide-y">{keys.map(key => <li className="p-4 flex justify-between gap-4" key={key.id}><div><b>{key.nom}</b><p className="text-sm text-gray-500">{key.prefixe}… · {key.scopes.join(', ')} · {key.actif ? 'Active' : 'Révoquée'}</p></div>{key.actif && <button className="text-red-700" onClick={()=>revoke(key.id)}>Révoquer</button>}</li>)}{keys.length===0 && <li className="p-5 text-gray-500">Aucune clé créée.</li>}</ul></section></div>;
}
