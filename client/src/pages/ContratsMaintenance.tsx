import { useEffect, useState } from 'react';
import { CalendarPlus, FilePlus2, RefreshCw, Wrench } from 'lucide-react';
import { apiFetch } from '../api';
import { useCompanyTimezone } from '../companyTimezoneContext';
import { companyDateInputValue, formatDateOnly } from '../lib/dateFormatting';

type Client = { id: string; raisonSociale: string };
type ClientDetail = Client & { sites: { id: string; nom: string; ville: string; estSiteIntervention: boolean }[] };
type Contrat = {
  id: string; titre: string; statut: string; periodiciteMois: number; dureePrevisionnelleMinutes: number;
  dateDebut: string; prochaineEcheance: string; client: Client; site?: { id: string; nom: string; ville: string } | null;
  politiqueMainOeuvre: 'INCLUSE' | 'HORS_FORFAIT'; politiqueMateriel: 'INCLUS' | 'HORS_FORFAIT'; noteCouverture?: string | null;
};

const libelleStatut: Record<string, string> = { ACTIF: 'Actif', BROUILLON: 'Brouillon', SUSPENDU: 'Suspendu', TERMINE: 'Terminé' };

export default function ContratsMaintenance() {
  const companyTimezone = useCompanyTimezone();
  const formatDate = (value: string) => formatDateOnly(value);
  const [contrats, setContrats] = useState<Contrat[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [clientSelectionne, setClientSelectionne] = useState<ClientDetail | null>(null);
  const [chargement, setChargement] = useState(true);
  const [formulaireOuvert, setFormulaireOuvert] = useState(false);
  const [contratCouvertureEdite, setContratCouvertureEdite] = useState<Contrat | null>(null);
  const [enregistrementCouverture, setEnregistrementCouverture] = useState(false);
  const [erreur, setErreur] = useState('');
  const [succes, setSucces] = useState('');

  const charger = async () => {
    setChargement(true);
    try {
      const [contratsRes, clientsRes] = await Promise.all([apiFetch('/contrats-maintenance'), apiFetch('/clients')]);
      const [contratsData, clientsData] = await Promise.all([contratsRes.json(), clientsRes.json()]);
      if (!contratsRes.ok) throw new Error(contratsData.error || 'Impossible de charger les contrats.');
      if (!clientsRes.ok) throw new Error(clientsData.error || 'Impossible de charger les clients.');
      setContrats(Array.isArray(contratsData) ? contratsData : []);
      setClients(Array.isArray(clientsData) ? clientsData : (clientsData.clients || []));
    } catch (err) {
      setErreur(err instanceof Error ? err.message : 'Erreur de chargement.');
    } finally {
      setChargement(false);
    }
  };

  useEffect(() => { void charger(); }, []);

  const choisirClient = async (clientId: string) => {
    setClientSelectionne(null);
    if (!clientId) return;
    const res = await apiFetch(`/clients/${clientId}`);
    const data = await res.json();
    if (!res.ok) return setErreur(data.error || 'Client introuvable.');
    setClientSelectionne(data as ClientDetail);
  };

  const creer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErreur(''); setSucces('');
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    const res = await apiFetch('/contrats-maintenance', { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) return setErreur(data.error || 'Création du contrat impossible.');
    setFormulaireOuvert(false);
    setClientSelectionne(null);
    setSucces('Contrat créé. Son échéance est prête à générer une intervention prévisionnelle.');
    await charger();
  };

  const modifierCouverture = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!contratCouvertureEdite || contratCouvertureEdite.statut === 'TERMINE' || enregistrementCouverture) return;
    setErreur(''); setSucces(''); setEnregistrementCouverture(true);
    try {
      const body = Object.fromEntries(new FormData(event.currentTarget).entries());
      const res = await apiFetch(`/contrats-maintenance/${contratCouvertureEdite.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) return setErreur(data.error || 'Mise à jour de la couverture impossible.');
      setContratCouvertureEdite(null);
      setSucces('Couverture contractuelle mise à jour pour les prochaines interventions.');
      await charger();
    } finally {
      setEnregistrementCouverture(false);
    }
  };

  const generer = async (contrat: Contrat) => {
    setErreur(''); setSucces('');
    const res = await apiFetch(`/contrats-maintenance/${contrat.id}/generer-intervention`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) return setErreur(data.error || 'Génération de l’intervention impossible.');
    setSucces(res.status === 201 ? `Intervention ${data.reference} créée à planifier.` : `L’intervention ${data.reference} existe déjà pour cette échéance.`);
  };

  const changerStatut = async (contrat: Contrat, statut: 'ACTIF' | 'SUSPENDU' | 'TERMINE') => {
    const motif = statut === 'ACTIF' ? '' : window.prompt(statut === 'SUSPENDU' ? 'Motif de la suspension du contrat ?' : 'Motif de la clôture définitive du contrat ?')?.trim();
    if (statut !== 'ACTIF' && !motif) return;
    setErreur(''); setSucces('');
    const res = await apiFetch(`/contrats-maintenance/${contrat.id}/statut`, { method: 'PATCH', body: JSON.stringify({ statut, motif }) });
    const data = await res.json();
    if (!res.ok) return setErreur(data.error || 'Mise à jour du contrat impossible.');
    setSucces(statut === 'SUSPENDU' ? 'Contrat suspendu : aucune intervention ne pourra être générée.' : statut === 'TERMINE' ? 'Contrat clôturé définitivement.' : 'Contrat réactivé.');
    await charger();
  };

  const avancerEcheance = async (contrat: Contrat) => {
    setErreur(''); setSucces('');
    const res = await apiFetch(`/contrats-maintenance/${contrat.id}/avancer-echeance`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) return setErreur(data.error || 'Avancement de l’échéance impossible.');
    setSucces(`Nouvelle échéance préparée pour le ${formatDate(data.prochaineEcheance)}.`);
    await charger();
  };

  return <div className="space-y-6">
    <div className="flex items-start justify-between gap-4">
      <div><h1 className="text-2xl font-bold text-gray-900">Contrats de maintenance</h1><p className="text-gray-500">Les échéances contractuelles génèrent des dossiers d’intervention à planifier. Le planning reste une projection.</p></div>
      <button className="btn btn-primary flex items-center gap-2" onClick={() => setFormulaireOuvert(true)}><FilePlus2 size={18} /> Nouveau contrat</button>
    </div>
    {erreur && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700">{erreur}</div>}
    {succes && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-700">{succes}</div>}
    {formulaireOuvert && <form onSubmit={creer} className="rounded-xl border border-blue-200 bg-blue-50 p-5 space-y-3">
      <h2 className="font-semibold">Nouveau contrat de maintenance</h2>
      <select required name="clientId" className="form-input" defaultValue="" onChange={(event) => void choisirClient(event.target.value)}><option value="" disabled>Client concerné</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.raisonSociale}</option>)}</select>
      {clientSelectionne && <select name="siteId" className="form-input" defaultValue=""><option value="">Tous sites / site non précisé</option>{clientSelectionne.sites.map((site) => <option key={site.id} value={site.id}>{site.nom} — {site.ville}{site.estSiteIntervention ? ' · intervention' : ''}</option>)}</select>}
      <input required name="titre" minLength={3} maxLength={200} className="form-input" placeholder="Ex. Maintenance préventive SSI" />
      <div className="grid gap-3 sm:grid-cols-3"><input required name="dateDebut" key={companyTimezone} defaultValue={companyDateInputValue(companyTimezone)} inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" className="form-input" placeholder="Début (JJ-MM-AAAA)" /><input required name="periodiciteMois" type="number" min="1" max="60" defaultValue="12" className="form-input" placeholder="Périodicité (mois)" /><input required name="dureePrevisionnelleMinutes" type="number" min="15" max="1440" defaultValue="60" className="form-input" placeholder="Durée (minutes)" /></div>
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm text-gray-700">Main-d’œuvre<select required name="politiqueMainOeuvre" defaultValue="HORS_FORFAIT" className="form-input mt-1"><option value="INCLUSE">Incluse</option><option value="HORS_FORFAIT">Hors forfait</option></select></label><label className="text-sm text-gray-700">Matériel<select required name="politiqueMateriel" defaultValue="HORS_FORFAIT" className="form-input mt-1"><option value="INCLUS">Inclus</option><option value="HORS_FORFAIT">Hors forfait</option></select></label></div>
      <textarea name="noteCouverture" maxLength={1000} className="form-input" placeholder="Note de couverture (facultative)" />
      <div className="flex gap-2"><button className="btn btn-primary" type="submit">Créer le contrat</button><button className="btn btn-secondary" type="button" onClick={() => { setFormulaireOuvert(false); setClientSelectionne(null); }}>Annuler</button></div>
    </form>}
    {contratCouvertureEdite && contratCouvertureEdite.statut !== 'TERMINE' && <form key={contratCouvertureEdite.id} onSubmit={modifierCouverture} className="rounded-xl border border-blue-200 bg-blue-50 p-5 space-y-3">
      <h2 className="font-semibold">Modifier la couverture — {contratCouvertureEdite.titre}</h2>
      <p className="text-sm text-gray-600">Cette modification s’appliquera aux prochaines interventions ; les instantanés existants restent figés.</p>
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm text-gray-700">Main-d’œuvre<select required name="politiqueMainOeuvre" defaultValue={contratCouvertureEdite.politiqueMainOeuvre} className="form-input mt-1"><option value="INCLUSE">Incluse</option><option value="HORS_FORFAIT">Hors forfait</option></select></label><label className="text-sm text-gray-700">Matériel<select required name="politiqueMateriel" defaultValue={contratCouvertureEdite.politiqueMateriel} className="form-input mt-1"><option value="INCLUS">Inclus</option><option value="HORS_FORFAIT">Hors forfait</option></select></label></div>
      <textarea name="noteCouverture" maxLength={1000} defaultValue={contratCouvertureEdite.noteCouverture || ''} className="form-input" placeholder="Note de couverture (facultative)" />
      <div className="flex gap-2"><button className="btn btn-primary" type="submit" disabled={enregistrementCouverture}>{enregistrementCouverture ? 'Enregistrement…' : 'Enregistrer la couverture'}</button><button className="btn btn-secondary" type="button" disabled={enregistrementCouverture} onClick={() => setContratCouvertureEdite(null)}>Annuler</button></div>
    </form>}
    {chargement ? <p className="text-gray-500">Chargement…</p> : contrats.length === 0 ? <div className="rounded-xl border border-dashed p-10 text-center text-gray-500"><Wrench className="mx-auto mb-3" />Aucun contrat de maintenance.</div> : <div className="grid gap-3">{contrats.map((contrat) => <article key={contrat.id} className="rounded-xl border bg-white p-5 shadow-sm"><div className="flex flex-col justify-between gap-4 sm:flex-row"><div><h2 className="font-semibold text-gray-900">{contrat.titre}</h2><p className="mt-1 text-sm text-gray-600">{contrat.client.raisonSociale}{contrat.site ? ` · ${contrat.site.nom} (${contrat.site.ville})` : ''}</p><p className="mt-2 text-sm text-gray-500">Début : {formatDate(contrat.dateDebut)} · Échéance : {formatDate(contrat.prochaineEcheance)} · Tous les {contrat.periodiciteMois} mois · {contrat.dureePrevisionnelleMinutes} min prévues</p><p className="mt-2 text-sm text-gray-700">Couverture : main-d’œuvre {contrat.politiqueMainOeuvre === 'INCLUSE' ? 'incluse' : 'hors forfait'} · matériel {contrat.politiqueMateriel === 'INCLUS' ? 'inclus' : 'hors forfait'}{contrat.noteCouverture ? ` · ${contrat.noteCouverture}` : ''}</p></div><div className="flex items-center gap-3"><span className="rounded-full bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-700">{libelleStatut[contrat.statut] || contrat.statut}</span>{contrat.statut !== 'TERMINE' && <button className="btn btn-secondary" onClick={() => setContratCouvertureEdite(contrat)}>Modifier la couverture</button>}{contrat.statut === 'ACTIF' && <><button className="btn btn-secondary flex items-center gap-2" onClick={() => void generer(contrat)}><CalendarPlus size={17} /> Générer l’intervention</button><button className="btn btn-secondary flex items-center gap-2" onClick={() => void avancerEcheance(contrat)}><RefreshCw size={17} /> Échéance suivante</button></>}{contrat.statut === 'ACTIF' && <button className="btn btn-secondary" onClick={() => void changerStatut(contrat, 'SUSPENDU')}>Suspendre</button>}{contrat.statut === 'SUSPENDU' && <button className="btn btn-secondary" onClick={() => void changerStatut(contrat, 'ACTIF')}>Réactiver</button>}{contrat.statut !== 'TERMINE' && <button className="btn btn-secondary" onClick={() => void changerStatut(contrat, 'TERMINE')}>Clôturer</button>}</div></div></article>)}</div>}
    <button className="text-sm text-gray-500 underline" onClick={() => void charger()}><RefreshCw className="mr-1 inline" size={14} />Actualiser la liste</button>
  </div>;
}
