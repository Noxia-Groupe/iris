import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Building2, Plus, Search } from 'lucide-react';
import { apiFetch } from '../api';
import { isAdminRole, useCurrentUser } from '../roles';
import { LIMITE_CLIENTS } from '../components/SelecteurClient';

interface ClientResume {
  id: string;
  raisonSociale: string;
  nomCommercial?: string | null;
  siren?: string | null;
  contacts: Array<{ id: string; prenom?: string | null; nom: string; estSignataire: boolean }>;
  sites: Array<{ ville: string }>;
}

export default function Clients() {
  const navigate = useNavigate();
  // Seule l'administration crée une fiche ; le technicien consulte l'annuaire.
  const modifiable = isAdminRole(useCurrentUser()?.role);
  const [clients, setClients] = useState<ClientResume[]>([]);
  const [query, setQuery] = useState('');
  const [raisonSociale, setRaisonSociale] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  // L'erreur de la liste remplace la liste ; celle de la création reste au-dessus du formulaire.
  const [erreurListe, setErreurListe] = useState('');
  const [erreurCreation, setErreurCreation] = useState('');

  // Seule la dernière recherche s'affiche : une réponse plus lente d'une frappe précédente est ignorée.
  const requete = useRef(0);
  const load = async (q = '') => {
    const numero = ++requete.current;
    setLoading(true);
    setErreurListe('');
    try {
      const res = await apiFetch(`/clients?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Chargement impossible.');
      if (numero === requete.current) setClients(data.clients || []);
    } catch (e) {
      if (numero === requete.current) setErreurListe(e instanceof Error ? e.message : 'Chargement impossible.');
    }
    finally { if (numero === requete.current) setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!query.trim()) return;
    const minuteur = window.setTimeout(() => { void load(query.trim()); }, 250);
    return () => window.clearTimeout(minuteur);
  }, [query]);

  const search = (value: string) => {
    setQuery(value);
    // Effacer la recherche (ou ne garder que des espaces) recharge tout de suite la liste
    // initiale ; une saisie attend 250 ms, et toute réponse antérieure est ignorée.
    if (!value.trim()) void load();
    else { requete.current += 1; setLoading(true); }
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setErreurCreation('');
    try {
      const res = await apiFetch('/clients', { method: 'POST', body: JSON.stringify({ raisonSociale }) });
      const client = await res.json();
      if (!res.ok) throw new Error(client.error || 'Création impossible.');
      navigate(`/clients/${client.id}`);
    } catch (e) { setErreurCreation(e instanceof Error ? e.message : 'Création impossible.'); }
  };

  const recherche = query.trim();
  const messageLimite = !loading && !erreurListe && clients.length >= LIMITE_CLIENTS
    ? (recherche ? `${LIMITE_CLIENTS} clients maximum affichés ; veuillez affiner votre recherche.` : `Seuls les ${LIMITE_CLIENTS} premiers clients sont listés, par raison sociale : recherchez les autres par leur nom ou leur SIREN.`)
    : '';

  return <div className="max-w-6xl mx-auto space-y-6">
    <div className="flex items-center justify-between gap-4 flex-wrap">
      <div><h1 className="text-2xl font-bold text-gray-900">Clients</h1><p className="text-gray-500">Sociétés, contacts et sites de votre référentiel Iris.</p></div>
      {modifiable && <button className="btn btn-primary flex items-center gap-2" onClick={() => setCreating(!creating)}><Plus size={18} /> Nouveau client</button>}
    </div>
    {modifiable && creating && <form onSubmit={create} className="bg-white border rounded-xl p-4 flex gap-3 items-end">
      <label className="flex-1 text-sm font-medium">Raison sociale<input autoFocus required value={raisonSociale} onChange={e => setRaisonSociale(e.target.value)} className="mt-1 w-full border rounded px-3 py-2" /></label>
      <button className="btn btn-primary" type="submit">Créer la fiche</button>
    </form>}
    {erreurCreation && <p role="alert" className="text-red-600">{erreurCreation}</p>}
    <label className="relative block"><Search className="absolute left-3 top-3 text-gray-400" size={18} /><input type="search" aria-label="Rechercher un client" value={query} onChange={e => search(e.target.value)} placeholder="Rechercher une société ou un SIREN" className="w-full border rounded-lg py-2.5 pl-10 pr-3" /></label>
    {/* Région toujours présente : un lecteur d'écran annonce le message quand il change. */}
    <p role="status" aria-label="Limite des résultats clients" className={messageLimite ? 'text-sm text-gray-600' : 'sr-only'}>{messageLimite}</p>
    <div className="bg-white border rounded-xl overflow-hidden">
      {loading ? <p className="p-6 text-gray-500">Chargement…</p> : erreurListe ? <p role="alert" className="p-6 text-red-600">{erreurListe}</p> : clients.length === 0 ? <p className="p-8 text-center text-gray-500">{recherche ? 'Aucun client ne correspond à cette recherche.' : modifiable ? 'Aucun client. Créez votre première fiche client.' : 'Aucun client.'}</p> : <ul aria-label="Liste des clients" className="divide-y">{clients.map(client => <li key={client.id}><Link to={`/clients/${client.id}`} className="block p-4 hover:bg-gray-50"><div className="flex gap-3"><Building2 className="text-blue-700 mt-0.5" size={20} /><div className="min-w-0"><p className="font-semibold text-gray-900">{client.raisonSociale}</p><p className="text-sm text-gray-500">{client.siren ? `SIREN ${client.siren} · ` : ''}{client.sites[0]?.ville || 'Adresse à compléter'}</p>{client.contacts.length > 0 && <p className="text-sm text-gray-600 mt-1">Décisionnaire{client.contacts.length > 1 ? 's' : ''} : {client.contacts.map(c => `${c.prenom ? `${c.prenom} ` : ''}${c.nom}`).join(', ')}</p>}</div></div></Link></li>)}</ul>}
    </div>
  </div>;
}
