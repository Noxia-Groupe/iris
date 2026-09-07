import { useEffect, useState } from 'react';
import { Plus, Wrench } from 'lucide-react';
import { apiFetch } from '../api';

type Client = { id: string; raisonSociale: string };
type Intervention = {
  id: string; reference: string; titre: string; description?: string | null; priorite: string; statut: string;
  dateSouhaitee?: string | null; client: Client;
};

const libelleStatut: Record<string, string> = {
  A_PLANIFIER: 'À planifier', PLANIFIEE: 'Planifiée', EN_COURS: 'En cours', TERMINEE: 'Terminée', ANNULEE: 'Annulée',
};
const libellePriorite: Record<string, string> = { BASSE: 'Basse', NORMALE: 'Normale', HAUTE: 'Haute', URGENTE: 'Urgente' };
const formatDate = (value?: string | null) => value ? new Date(value).toLocaleDateString('fr-FR') : 'Non renseignée';

export default function Interventions() {
  const [interventions, setInterventions] = useState<Intervention[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [interventionsRes, clientsRes] = await Promise.all([apiFetch('/interventions'), apiFetch('/clients')]);
      const interventionData = await interventionsRes.json();
      const clientData = await clientsRes.json();
      if (!interventionsRes.ok) throw new Error(interventionData.error || 'Impossible de charger les interventions.');
      setInterventions(Array.isArray(interventionData) ? interventionData : []);
      setClients(Array.isArray(clientData) ? clientData : (clientData.clients || []));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError('');
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    const res = await apiFetch('/interventions', { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) return setError(data.error || 'Création impossible.');
    setFormOpen(false); await load();
  };

  return <div className="space-y-6">
    <div className="flex items-start justify-between gap-4">
      <div><h1 className="text-2xl font-bold text-gray-900">Interventions SAV</h1><p className="text-gray-500">Demandes clients et interventions en cours. Le planning reste une projection prévisionnelle.</p></div>
      <button className="btn btn-primary flex items-center gap-2" onClick={() => setFormOpen(true)}><Plus size={18} /> Nouvelle intervention</button>
    </div>
    {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700">{error}</div>}
    {formOpen && <form onSubmit={create} className="rounded-xl border border-blue-200 bg-blue-50 p-5 space-y-3">
      <h2 className="font-semibold">Nouvelle intervention SAV</h2>
      <select required name="clientId" className="form-input" defaultValue=""><option value="" disabled>Client concerné</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.raisonSociale}</option>)}</select>
      <input required name="titre" maxLength={200} className="form-input" placeholder="Objet de la demande" />
      <textarea name="description" className="form-input" placeholder="Description de la demande" />
      <div className="grid gap-3 sm:grid-cols-2"><select name="priorite" className="form-input" defaultValue="NORMALE">{Object.entries(libellePriorite).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><input name="dateSouhaitee" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="Date souhaitée (JJ-MM-AAAA)" className="form-input" /></div>
      <div className="flex gap-2"><button className="btn btn-primary" type="submit">Créer</button><button className="btn btn-secondary" type="button" onClick={() => setFormOpen(false)}>Annuler</button></div>
    </form>}
    {loading ? <p className="text-gray-500">Chargement…</p> : interventions.length === 0 ? <div className="rounded-xl border border-dashed p-10 text-center text-gray-500"><Wrench className="mx-auto mb-3" />Aucune intervention active.</div> : <div className="grid gap-3">{interventions.map((item) => <article key={item.id} className="rounded-xl border bg-white p-5 shadow-sm"><div className="flex justify-between gap-3"><div><p className="text-xs font-semibold text-blue-700">{item.reference}</p><h2 className="font-semibold text-gray-900">{item.titre}</h2><p className="text-sm text-gray-600">{item.client.raisonSociale} · Souhaitée le {formatDate(item.dateSouhaitee)}</p></div><div className="text-right text-sm"><p className="font-medium">{libelleStatut[item.statut] || item.statut}</p><p className="text-gray-500">Priorité {libellePriorite[item.priorite] || item.priorite}</p></div></div>{item.description && <p className="mt-3 text-sm text-gray-600">{item.description}</p>}</article>)}</div>}
  </div>;
}
