import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Wrench } from 'lucide-react';
import { apiFetch } from '../api';
import { SelecteurClient } from '../components/SelecteurClient';
import { resumeCoutsIntervention } from '../lib/coutsIntervention';
import { isAdminRole, useCurrentUser } from '../roles';
import { useCompanyTimezone } from '../companyTimezoneContext';
import { formatCompanyDate, formatDateOnly } from '../lib/dateFormatting';
import { chantiersDuClient } from '../lib/chantiersDuClient';

type Client = { id: string; raisonSociale: string };
type ClientDetail = Client & { sites: { id: string; nom: string; ville: string }[]; contacts: { id: string; prenom?: string | null; nom: string }[] };
type Chantier = { id: string; nom: string; clientId?: string | null; numeroDevis?: string | null };
type Fournisseur = { id: string; nom: string };
type CoutsIntervention = { totalMainOeuvreHT?: number | null; totalMaterielHT?: number | null; totalCoutsHT?: number | null; heures?: { id: string; date: string; nbrHeures: number; commentaire?: string | null; createdAt: string }[] };
type Intervention = {
  id: string; reference: string; titre: string; description?: string | null; priorite: string; statut: string;
  dateSouhaitee?: string | null; dateDemande?: string | null; client: Client;
  site?: { nom: string; ville?: string | null } | null; contact?: { prenom?: string | null; nom: string } | null; chantier?: { nom: string; numeroDevis?: string | null } | null;
  couvertureContrat?: { politiqueMainOeuvre: 'INCLUSE' | 'HORS_FORFAIT'; politiqueMateriel: 'INCLUS' | 'HORS_FORFAIT'; noteCouverture?: string | null };
  rapports?: { id: string; contenu: string; createdAt: string; auteur: { name: string }; signature?: { id: string; signataire: string; accepteLe: string; empreinte: string } | null }[];
};

const libelleStatut: Record<string, string> = { A_PLANIFIER: 'À planifier', PLANIFIEE: 'Planifiée', EN_COURS: 'En cours', TERMINEE: 'Terminée', ANNULEE: 'Annulée' };
const libellePriorite: Record<string, string> = { BASSE: 'Basse', NORMALE: 'Normale', HAUTE: 'Haute', URGENTE: 'Urgente' };
const transitions: Record<string, { statut: string; libelle: string }[]> = {
  A_PLANIFIER: [{ statut: 'PLANIFIEE', libelle: 'Planifier' }, { statut: 'ANNULEE', libelle: 'Annuler' }],
  PLANIFIEE: [{ statut: 'EN_COURS', libelle: 'Démarrer' }, { statut: 'ANNULEE', libelle: 'Annuler' }],
  EN_COURS: [{ statut: 'TERMINEE', libelle: 'Terminer' }, { statut: 'ANNULEE', libelle: 'Annuler' }],
  TERMINEE: [], ANNULEE: [],
};

const montantEuros = (montant: number) => Number(montant || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

export default function Interventions() {
  const companyTimezone = useCompanyTimezone();
  const formatDateOnlyOrEmpty = (value?: string | null) => value ? formatDateOnly(value) : 'Non renseignée';
  const formatCompanyDateOrEmpty = (value?: string | null) => value ? formatCompanyDate(value, companyTimezone) : 'Non renseignée';
  const [interventions, setInterventions] = useState<Intervention[]>([]);
  const [clientIdFormulaire, setClientIdFormulaire] = useState('');
  // Dernier client demandé : la fiche d'un client choisi puis abandonné ne doit pas s'afficher.
  const clientDemande = useRef('');
  const [chantiers, setChantiers] = useState<Chantier[]>([]);
  const [clientFormulaire, setClientFormulaire] = useState<ClientDetail | null>(null);
  const [couts, setCouts] = useState<Record<string, CoutsIntervention>>({});
  const [fournisseurs, setFournisseurs] = useState<Fournisseur[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState('');
  const user = useCurrentUser();
  const estEncadrement = isAdminRole(user?.role) || user?.role === 'CONDUCTEUR_TRAVAUX';
  const estTechnicien = user?.role === 'TECHNICIEN';

  const chargerCouts = useCallback(async (items: Intervention[]) => {
    const resultats = await Promise.all(items.map(async (item) => {
      try {
        const res = await apiFetch(`/interventions/${item.id}/couts`);
        if (!res.ok) return null;
        const data = await res.json() as CoutsIntervention;
        return [item.id, data] as const;
      } catch {
        return null;
      }
    }));
    setCouts(Object.fromEntries(resultats.filter((resultat): resultat is readonly [string, CoutsIntervention] => resultat !== null)));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const interventionsRes = await apiFetch('/interventions');
      const interventionData = await interventionsRes.json();
      if (!interventionsRes.ok) throw new Error(interventionData.error || 'Impossible de charger les interventions.');
      const items = Array.isArray(interventionData) ? interventionData : [];
      setInterventions(items);
      void chargerCouts(items);
      if (estEncadrement) {
        // Les clients se cherchent dans le sélecteur du formulaire (au-delà des 200 premiers, #111).
        const chantiersRes = await apiFetch('/chantiers');
        const chantierData = await chantiersRes.json();
        if (chantiersRes.ok) setChantiers(Array.isArray(chantierData) ? chantierData : []);
        try {
          const fournisseursRes = await apiFetch('/fournisseurs');
          const fournisseurData = await fournisseursRes.json();
          if (fournisseursRes.ok && Array.isArray(fournisseurData)) setFournisseurs(fournisseurData);
        } catch {
          setFournisseurs(null);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement.');
    } finally {
      setLoading(false);
    }
  }, [chargerCouts, estEncadrement]);

  useEffect(() => { void load(); }, [load]);

  const choisirClient = async (clientId: string) => {
    clientDemande.current = clientId;
    setClientFormulaire(null);
    if (!clientId) return;
    const res = await apiFetch(`/clients/${clientId}`);
    const data = await res.json();
    if (clientDemande.current !== clientId) return;
    if (!res.ok) return setError(data.error || 'Client introuvable.');
    setClientFormulaire(data as ClientDetail);
  };

  const fermerFormulaire = () => {
    clientDemande.current = '';
    setFormOpen(false);
    setClientIdFormulaire('');
    setClientFormulaire(null);
  };

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    // Pendant une recherche, le sélecteur désactivé échappe à `required` et sort du formulaire.
    if (!form.get('clientId')) return setError('Choisissez un client.');
    if (!form.get('dateDemande')) form.delete('dateDemande');
    const res = await apiFetch('/interventions', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
    const data = await res.json();
    if (!res.ok) return setError(data.error || 'Création impossible.');
    fermerFormulaire();
    await load();
  };

  const signerRapport = async (rapportId: string) => {
    const signataire = window.prompt('Nom complet du signataire client :');
    if (!signataire?.trim()) return;
    if (!window.confirm(`Le client ${signataire.trim()} confirme avoir lu et accepté ce compte rendu. Confirmer la signature ?`)) return;
    setError('');
    const res = await apiFetch(`/interventions/rapports/${rapportId}/signature`, { method: 'POST', body: JSON.stringify({ signataire: signataire.trim(), confirme: true }) });
    const data = await res.json();
    if (!res.ok) return setError(data.error || 'Signature impossible.');
    await load();
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
    await load();
  };

  const enregistrerHeures = async (event: React.FormEvent<HTMLFormElement>, interventionId: string) => {
    event.preventDefault();
    setError('');
    const formulaire = event.currentTarget;
    const form = new FormData(formulaire);
    const nbrHeures = String(form.get('nbrHeures') || '').replace(',', '.');
    const motif = String(form.get('motif') || '').trim();
    if (Number(nbrHeures) === 0 && motif.length < 3) return setError('Un motif de 3 caractères minimum est obligatoire pour zéro heure.');
    const res = await apiFetch(`/interventions/${interventionId}/couts/heures`, { method: 'POST', body: JSON.stringify({ date: form.get('date'), nbrHeures, commentaire: form.get('commentaire'), motif }) });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 409) setCouts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== interventionId)));
      return setError(data.error || 'Saisie des heures impossible.');
    }
    formulaire.reset();
    await chargerCouts(interventions);
  };

  const enregistrerAchat = async (event: React.FormEvent<HTMLFormElement>, interventionId: string) => {
    event.preventDefault();
    setError('');
    const formulaire = event.currentTarget;
    const form = new FormData(formulaire);
    const montantHT = String(form.get('montantHT') || '').replace(',', '.');
    const motif = String(form.get('motif') || '').trim();
    if (Number(montantHT) === 0 && motif.length < 3) return setError('Un motif de 3 caractères minimum est obligatoire pour un montant nul.');
    const res = await apiFetch(`/interventions/${interventionId}/couts/achats`, { method: 'POST', body: JSON.stringify({ date: form.get('date'), fournisseurId: form.get('fournisseurId'), description: form.get('description'), montantHT, motif }) });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 409) setCouts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== interventionId)));
      return setError(data.error || 'Saisie de l’achat matériel impossible.');
    }
    formulaire.reset();
    await chargerCouts(interventions);
  };

  return <div className="space-y-6">
    <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
      <div><h1 className="text-2xl font-bold text-gray-900">{estTechnicien ? 'Mes interventions' : 'Interventions SAV'}</h1><p className="text-gray-500">{estTechnicien ? 'Uniquement les dossiers qui vous sont explicitement affectés.' : 'Demandes clients et interventions en cours. Le planning reste une projection prévisionnelle.'}</p></div>
      {estEncadrement && <button className="btn btn-primary flex items-center gap-2" onClick={() => setFormOpen(true)}><Plus size={18} /> Nouvelle intervention</button>}
    </div>
    {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700">{error}</div>}
    {formOpen && <form onSubmit={create} className="rounded-xl border border-blue-200 bg-blue-50 p-5 space-y-3">
      <h2 className="font-semibold">Nouvelle intervention SAV</h2>
      <SelecteurClient id="client-intervention" name="clientId" label="Client de l’intervention" required valeur={clientIdFormulaire} onChange={(client) => { setClientIdFormulaire(client?.id ?? ''); void choisirClient(client?.id ?? ''); }} />
      {clientFormulaire && <div className="grid gap-3 sm:grid-cols-3"><select name="siteId" className="form-input" defaultValue=""><option value="">Site (facultatif)</option>{clientFormulaire.sites.map((site) => <option key={site.id} value={site.id}>{site.nom} — {site.ville}</option>)}</select><select name="contactId" className="form-input" defaultValue=""><option value="">Contact (facultatif)</option>{clientFormulaire.contacts.map((contact) => <option key={contact.id} value={contact.id}>{[contact.prenom, contact.nom].filter(Boolean).join(' ')}</option>)}</select><select name="chantierId" className="form-input" defaultValue=""><option value="">Affaire / chantier (facultatif)</option>{chantiersDuClient(chantiers, clientFormulaire.id).map((chantier) => <option key={chantier.id} value={chantier.id}>{chantier.numeroDevis ? `${chantier.numeroDevis} — ` : ''}{chantier.nom}</option>)}</select></div>}
      <input required name="titre" maxLength={200} className="form-input" placeholder="Objet de la demande" />
      <textarea name="description" className="form-input" placeholder="Description de la demande" />
      <div className="grid gap-3 sm:grid-cols-2"><select name="priorite" className="form-input" defaultValue="NORMALE">{Object.entries(libellePriorite).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><input name="dateDemande" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="Date de demande (JJ-MM-AAAA)" aria-label="Date de demande (JJ-MM-AAAA)" className="form-input" /><input name="dateSouhaitee" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="Date souhaitée (JJ-MM-AAAA)" className="form-input" /></div>
      <div className="flex gap-2"><button className="btn btn-primary" type="submit">Créer</button><button className="btn btn-secondary" type="button" onClick={fermerFormulaire}>Annuler</button></div>
    </form>}
    {loading ? <p className="text-gray-500">Chargement…</p> : interventions.length === 0 ? <div className="rounded-xl border border-dashed p-10 text-center text-gray-500"><Wrench className="mx-auto mb-3" />Aucune intervention active.</div> : <div className="grid gap-3">{interventions.map((item) => <article key={item.id} className="rounded-xl border bg-white p-5 shadow-sm">
      <div className="flex justify-between gap-3"><div><p className="text-xs font-semibold text-blue-700">{item.reference}</p><h2 className="font-semibold text-gray-900">{item.titre}</h2><p className="text-sm text-gray-600">{item.client.raisonSociale}{item.dateDemande && ` · Demandée le ${formatDateOnlyOrEmpty(item.dateDemande)}`} · Souhaitée le {formatDateOnlyOrEmpty(item.dateSouhaitee)}</p>{(item.site || item.contact || item.chantier) && <p className="text-sm text-gray-500">{item.site && `Site : ${item.site.nom}${item.site.ville ? ` (${item.site.ville})` : ''}`}{item.contact && `${item.site ? ' · ' : ''}Contact : ${[item.contact.prenom, item.contact.nom].filter(Boolean).join(' ')}`}{item.chantier && `${item.site || item.contact ? ' · ' : ''}Affaire : ${item.chantier.numeroDevis ? `${item.chantier.numeroDevis} — ` : ''}${item.chantier.nom}`}</p>}</div><div className="text-right text-sm"><p className="font-medium">{libelleStatut[item.statut] || item.statut}</p><p className="text-gray-500">Priorité {libellePriorite[item.priorite] || item.priorite}</p></div></div>
      {item.description && <p className="mt-3 text-sm text-gray-600">{item.description}</p>}
      {item.couvertureContrat && <p className="mt-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">Couverture contractuelle figée : main-d’œuvre {item.couvertureContrat.politiqueMainOeuvre === 'INCLUSE' ? 'incluse' : 'hors forfait'} · matériel {item.couvertureContrat.politiqueMateriel === 'INCLUS' ? 'inclus' : 'hors forfait'}{item.couvertureContrat.noteCouverture ? ` · ${item.couvertureContrat.noteCouverture}` : ''}</p>}
      {couts[item.id] && <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
        {/* Coût réel, main-d'œuvre comprise, pour l'administration ; matériel seul pour un conducteur (lot (d)). */}
        {estEncadrement && (() => { const resume = resumeCoutsIntervention(couts[item.id]); return resume && <p className="font-medium text-slate-800">{resume.libelle} : {montantEuros(resume.montant)} HT</p>; })()}
        {estTechnicien && <>
          {(couts[item.id].heures || []).length > 0 && <ul className="mb-3 space-y-1 text-slate-700">{couts[item.id].heures!.map((heure) => <li key={heure.id}>{formatDateOnlyOrEmpty(heure.date)} — {heure.nbrHeures} h{heure.commentaire ? ` — ${heure.commentaire}` : ''}</li>)}</ul>}
          <form onSubmit={(event) => void enregistrerHeures(event, item.id)} className="grid gap-2 sm:grid-cols-2"><input required name="date" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="Date (JJ-MM-AAAA)" className="form-input" /><input required name="nbrHeures" inputMode="decimal" placeholder="Heures" className="form-input" /><input name="commentaire" maxLength={500} placeholder="Commentaire" className="form-input sm:col-span-2" /><input name="motif" maxLength={500} placeholder="Motif (obligatoire si 0)" className="form-input" /><button type="submit" className="btn btn-secondary">Enregistrer mes heures</button></form>
        </>}
        {estEncadrement && fournisseurs !== null && <form onSubmit={(event) => void enregistrerAchat(event, item.id)} className="mt-3 grid gap-2 sm:grid-cols-2"><input required name="date" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="Date (JJ-MM-AAAA)" className="form-input" /><select required name="fournisseurId" defaultValue="" className="form-input"><option value="" disabled>Fournisseur</option>{fournisseurs.map((fournisseur) => <option key={fournisseur.id} value={fournisseur.id}>{fournisseur.nom}</option>)}</select><input required name="description" maxLength={500} placeholder="Description du matériel" className="form-input sm:col-span-2" /><input required name="montantHT" inputMode="decimal" placeholder="Montant HT" className="form-input" /><input name="motif" maxLength={500} placeholder="Motif (obligatoire si 0)" className="form-input" /><button type="submit" className="btn btn-secondary">Enregistrer l’achat matériel</button></form>}
      </div>}
      {(item.rapports || []).length > 0 && <div className="mt-3 rounded-lg bg-gray-50 p-3 text-sm"><p className="mb-1 font-medium text-gray-700">Comptes rendus terrain</p>{item.rapports!.map((rapport) => <div key={rapport.id} className="mb-2 last:mb-0 text-gray-600"><p>{rapport.contenu} <span className="text-gray-400">— {rapport.auteur.name}, {formatCompanyDateOrEmpty(rapport.createdAt)}</span></p>{rapport.signature ? <p className="text-xs text-emerald-700">Signé par {rapport.signature.signataire} le {formatCompanyDateOrEmpty(rapport.signature.accepteLe)} · empreinte enregistrée</p> : estTechnicien && item.statut !== 'ANNULEE' ? <button type="button" onClick={() => void signerRapport(rapport.id)} className="mt-1 text-xs font-medium text-blue-700">Faire signer ce compte rendu</button> : null}</div>)}</div>}
      <div className="mt-4 flex flex-wrap gap-2">{(transitions[item.statut] || []).filter((action) => !estTechnicien || action.statut === 'EN_COURS' || action.statut === 'TERMINEE').map((action) => <button key={action.statut} type="button" onClick={() => void transition(item.id, action.statut)} className={action.statut === 'ANNULEE' ? 'btn btn-secondary text-red-700' : 'btn btn-primary'}>{action.libelle}</button>)}{estTechnicien && item.statut === 'EN_COURS' && <button type="button" onClick={() => void ajouterRapport(item.id)} className="btn btn-secondary">Ajouter un compte rendu</button>}</div>
    </article>)}</div>}
  </div>;
}
