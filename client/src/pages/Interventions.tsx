import { useEffect, useState } from 'react';
import { Plus, Wrench } from 'lucide-react';
import { apiFetch } from '../api';
import { isAdminRole, useCurrentUser } from '../roles';

type Client = { id: string; raisonSociale: string };
type ClientDetail = Client & { sites: { id: string; nom: string; ville: string }[]; contacts: { id: string; prenom?: string | null; nom: string }[] };
type Chantier = { id: string; nom: string; client: string; numeroDevis?: string | null };
type Intervention = {
  id: string; reference: string; titre: string; description?: string | null; priorite: string; statut: string;
  dateSouhaitee?: string | null; client: Client;
  rapports?: { id: string; contenu: string; createdAt: string; auteur: { name: string } }[];
};

const libelleStatut: Record<string, string> = {
  A_PLANIFIER: 'À planifier', PLANIFIEE: 'Planifiée', EN_COURS: 'En cours', TERMINEE: 'Terminée', ANNULEE: 'Annulée',
};
const libellePriorite: Record<string, string> = { BASSE: 'Basse', NORMALE: 'Normale', HAUTE: 'Haute', URGENTE: 'Urgente' };
const transitions: Record<string, { statut: string; libelle: string }[]> = {
  A_PLANIFIER: [{ statut: 'PLANIFIEE', libelle: 'Planifier' }, { statut: 'ANNULEE', libelle: 'Annuler' }],
  PLANIFIEE: [{ statut: 'EN_COURS', libelle: 'Démarrer' }, { statut: 'ANNULEE', libelle: 'Annuler' }],
  EN_COURS: [{ statut: 'TERMINEE', libelle: 'Terminer' }, { statut: 'ANNULEE', libelle: 'Annuler' }],
  TERMINEE: [], ANNULEE: [],
};
const formatDate = (value?: string | null) => value ? new Date(value).toLocaleDateString('fr-FR') : 'Non renseignée';

export default function Interventions() {
  const [interventions, setInterventions] = useState<Intervention[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [chantiers, setChantiers] = useState<Chantier[]>([]);
  const [clientFormulaire, setClientFormulaire] = useState<ClientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState('');
  const user = useCurrentUser();
  const peutCreer = isAdminRole(user?.role);
  const estTechnicien = user?.role === 'TECHNICIEN';

  const load = async () => {
    setLoading(true);
    try {
      const interventionsRes = await apiFetch('/interventions');
      const interventionData = await interventionsRes.json();
      if (!interventionsRes.ok) throw new Error(interventionData.error || 'Impossible de charger les interventions.');
      setInterventions(Array.isArray(interventionData) ? interventionData : []);
      if (peutCreer) {
        const [clientsRes, chantiersRes] = await Promise.all([apiFetch('/clients'), apiFetch('/chantiers')]);
        const [clientData, chantierData] = await Promise.all([clientsRes.json(), chantiersRes.json()]);
        if (clientsRes.ok) setClients(Array.isArray(clientData) ? clientData : (clientData.clients || []));
        if (chantiersRes.ok) setChantiers(Array.isArray(chantierData) ? chantierData : []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const choisirClient = async (clientId: string) => {
    setClientFormulaire(null);
    if (!clientId) return;
    const res = await apiFetch(`/clients/${clientId}`);
    const data = await res.json();
    if (!res.ok) return setError(data.error || 'Client introuvable.');
    setClientFormulaire(data as ClientDetail);
  };

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError('');
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    const res = await apiFetch('/interventions', { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) return setError(data.error || 'Création impossible.');
    setFormOpen(false); await load();
  };

  const transition = async (id: string, statut: string) => {
    setError('');
    const res = await apiFetch(`/interventions/${id}/statut`, { method: 'PATCH', body: JSON.stringify({ statut }) });
    const data = await res.json();
    if (!res.ok) return setError(data.error || 'Transition impossible.');
    await load();
  };

  const ajouterRapport = async (id: string) => {
    const contenu = window.prompt('Compte rendu terrain (3 caractères minimum) :');
    if (contenu === null) return;
    setError('');
    const res = await apiFetch(`/interventions/${id}/rapports`, { method: 'POST', body: JSON.stringify({ contenu }) });
    const data = await res.json();
    if (!res.ok) return setError(data.error || 'Enregistrement du compte rendu impossible.');
  };

  return <div className="space-y-6">
    <div className="flex items-start justify-between gap-4">
      <div><h1 className="text-2xl font-bold text-gray-900">{estTechnicien ? 'Mes interventions' : 'Interventions SAV'}</h1><p className="text-gray-500">{estTechnicien ? 'Uniquement les dossiers qui vous sont explicitement affectés.' : 'Demandes clients et interventions en cours. Le planning reste une projection prévisionnelle.'}</p></div>
      {peutCreer && <button className="btn btn-primary flex items-center gap-2" onClick={() => setFormOpen(true)}><Plus size={18} /> Nouvelle intervention</button>}
    </div>
    {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700">{error}</div>}
    {formOpen && <form onSubmit={create} className="rounded-xl border border-blue-200 bg-blue-50 p-5 space-y-3">
      <h2 className="font-semibold">Nouvelle intervention SAV</h2>
      <select required name="clientId" className="form-input" defaultValue="" onChange={(event) => void choisirClient(event.target.value)}><option value="" disabled>Client concerné</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.raisonSociale}</option>)}</select>
      {clientFormulaire && <div className="grid gap-3 sm:grid-cols-3"><select name="siteId" className="form-input" defaultValue=""><option value="">Site (facultatif)</option>{clientFormulaire.sites.map((site) => <option key={site.id} value={site.id}>{site.nom} — {site.ville}</option>)}</select><select name="contactId" className="form-input" defaultValue=""><option value="">Contact (facultatif)</option>{clientFormulaire.contacts.map((contact) => <option key={contact.id} value={contact.id}>{[contact.prenom, contact.nom].filter(Boolean).join(' ')}</option>)}</select><select name="chantierId" className="form-input" defaultValue=""><option value="">Affaire / chantier (facultatif)</option>{chantiers.filter((chantier) => chantier.client === clientFormulaire.raisonSociale).map((chantier) => <option key={chantier.id} value={chantier.id}>{chantier.numeroDevis ? `${chantier.numeroDevis} — ` : ''}{chantier.nom}</option>)}</select></div>}
      <input required name="titre" maxLength={200} className="form-input" placeholder="Objet de la demande" />
      <textarea name="description" className="form-input" placeholder="Description de la demande" />
      <div className="grid gap-3 sm:grid-cols-2"><select name="priorite" className="form-input" defaultValue="NORMALE">{Object.entries(libellePriorite).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><input name="dateSouhaitee" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="Date souhaitée (JJ-MM-AAAA)" className="form-input" /></div>
      <div className="flex gap-2"><button className="btn btn-primary" type="submit">Créer</button><button className="btn btn-secondary" type="button" onClick={() => setFormOpen(false)}>Annuler</button></div>
    </form>}
    {loading ? <p className="text-gray-500">Chargement…</p> : interventions.length === 0 ? <div className="rounded-xl border border-dashed p-10 text-center text-gray-500"><Wrench className="mx-auto mb-3" />Aucune intervention active.</div> : <div className="grid gap-3">{interventions.map((item) => <article key={item.id} className="rounded-xl border bg-white p-5 shadow-sm"><div className="flex justify-between gap-3"><div><p className="text-xs font-semibold text-blue-700">{item.reference}</p><h2 className="font-semibold text-gray-900">{item.titre}</h2><p className="text-sm text-gray-600">{item.client.raisonSociale} · Souhaitée le {formatDate(item.dateSouhaitee)}</p></div><div className="text-right text-sm"><p className="font-medium">{libelleStatut[item.statut] || item.statut}</p><p className="text-gray-500">Priorité {libellePriorite[item.priorite] || item.priorite}</p></div></div>{item.description && <p className="mt-3 text-sm text-gray-600">{item.description}</p>}{(item.rapports || []).length > 0 && <div className="mt-3 rounded-lg bg-gray-50 p-3 text-sm"><p className="mb-1 font-medium text-gray-700">Comptes rendus terrain</p>{item.rapports!.map((rapport) => <p key={rapport.id} className="text-gray-600">{rapport.contenu} <span className="text-gray-400">— {rapport.auteur.name}, {formatDate(rapport.createdAt)}</span></p>)}</div>}<div className="mt-4 flex flex-wrap gap-2">{(transitions[item.statut] || []).filter((action) => !estTechnicien || action.statut === 'EN_COURS' || action.statut === 'TERMINEE').map((action) => <button key={action.statut} type="button" onClick={() => void transition(item.id, action.statut)} className={action.statut === 'ANNULEE' ? 'btn btn-secondary text-red-700' : 'btn btn-primary'}>{action.libelle}</button>)}{estTechnicien && item.statut === 'EN_COURS' && <button type="button" onClick={() => void ajouterRapport(item.id)} className="btn btn-secondary">Ajouter un compte rendu</button>}</div></article>)}</div>}
  </div>;
}
