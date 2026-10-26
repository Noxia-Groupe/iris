import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Wrench } from 'lucide-react';
import { apiFetch } from '../api';
import { SelecteurClient } from '../components/SelecteurClient';
import { CoordonneesIntervention } from '../components/CoordonneesIntervention';
import { FormulaireCloture, FormulaireCompteRendu, FormulaireSignature } from '../components/FormulairesIntervention';
import { TraceSignature } from '../components/TraceSignature';
import { AlerteGenerationVisites } from '../components/GenerationVisites';
import { RemiseAPlanifier } from '../components/RemiseAPlanifier';
import { AnnulationIntervention } from '../components/AnnulationIntervention';
import type { TraceSignature as Trace } from '../lib/traceSignature';
import { resumeCoutsIntervention } from '../lib/coutsIntervention';
import { isAdminRole, peutConsulterPlanning, useCurrentUser } from '../roles';
import { useModules } from '../modules';
import { interventionRemettable } from '../lib/remiseAPlanifier';
import { useCompanyTimezone } from '../companyTimezoneContext';
import { formatCompanyDate, formatDateOnly } from '../lib/dateFormatting';
import { chantiersDuClient } from '../lib/chantiersDuClient';
import type { ContactIntervention, Planification, SiteIntervention } from '../lib/intervention';

type Client = { id: string; raisonSociale: string };
type ClientDetail = Client & { sites: { id: string; nom: string; ville: string }[]; contacts: { id: string; prenom?: string | null; nom: string }[] };
type Chantier = { id: string; nom: string; clientId?: string | null; numeroDevis?: string | null };
type Fournisseur = { id: string; nom: string };
type CoutsIntervention = { totalMainOeuvreHT?: number | null; totalMaterielHT?: number | null; totalCoutsHT?: number | null; heures?: { id: string; date: string; nbrHeures: number; commentaire?: string | null; createdAt: string }[] };
type Intervention = {
  id: string; reference: string; titre: string; description?: string | null; priorite: string; statut: string;
  // Marqueur reporté depuis un devis au temps passé, à sa conversion ; sans aucun prix.
  auTempsPasse?: boolean;
  dateSouhaitee?: string | null; dateDemande?: string | null; client: Client; contratMaintenanceId?: string | null;
  site?: (SiteIntervention & { nom: string }) | null; contact?: ContactIntervention | null; chantier?: { nom: string; numeroDevis?: string | null; adresse?: string | null } | null;
  planningEvent?: Planification | null;
  couvertureContrat?: { politiqueMainOeuvre: 'INCLUSE' | 'HORS_FORFAIT'; politiqueMateriel: 'INCLUS' | 'HORS_FORFAIT'; noteCouverture?: string | null };
  rapports?: { id: string; contenu: string; createdAt: string; auteur: { name: string }; signature?: { id: string; signataire: string; accepteLe: string; empreinte: string; trace?: Trace | null; enregistrePar?: { name: string } | null } | null }[];
};
// Formulaire ouvert sous une intervention : un seul à la fois (lot pilote 3b-3).
type FormulaireOuvert = { type: 'compteRendu'; interventionId: string } | { type: 'signature'; interventionId: string; rapportId: string } | { type: 'cloture'; interventionId: string };

const libelleStatut: Record<string, string> = { A_PLANIFIER: 'À planifier', PLANIFIEE: 'Planifiée', EN_COURS: 'En cours', TERMINEE: 'Terminée', ANNULEE: 'Annulée' };
const libellePriorite: Record<string, string> = { BASSE: 'Basse', NORMALE: 'Normale', HAUTE: 'Haute', URGENTE: 'Urgente' };
const transitions: Record<string, { statut: string; libelle: string }[]> = {
  A_PLANIFIER: [{ statut: 'PLANIFIEE', libelle: 'Planifier' }, { statut: 'ANNULEE', libelle: 'Annuler' }],
  PLANIFIEE: [{ statut: 'EN_COURS', libelle: 'Démarrer' }, { statut: 'ANNULEE', libelle: 'Annuler' }],
  EN_COURS: [{ statut: 'TERMINEE', libelle: 'Terminer' }, { statut: 'ANNULEE', libelle: 'Annuler' }],
  TERMINEE: [], ANNULEE: [],
};

const montantEuros = (montant: number) => Number(montant || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

// Sans identifiant, la liste ; avec, la fiche d'une seule intervention (lot pilote 3b-4), mêmes actions.
export default function Interventions({ interventionId }: { interventionId?: string } = {}) {
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
  // Fiche : seule une réponse 404 dit l'intervention introuvable ; une panne n'en dit rien.
  const [introuvable, setIntrouvable] = useState(false);
  const [formulaire, setFormulaire] = useState<FormulaireOuvert | null>(null);
  const user = useCurrentUser();
  const estEncadrement = isAdminRole(user?.role) || user?.role === 'CONDUCTEUR_TRAVAUX';
  const estTechnicien = user?.role === 'TECHNICIEN';
  // Remise « à planifier » d'une intervention planifiée, visite de contrat ou curative, comme depuis le
  // planning : mêmes comptes que le planning (hors technicien, en consultation seule), module actif.
  const { planningActif } = useModules();
  const peutRemettre = !estTechnicien && peutConsulterPlanning(user?.role) && planningActif;
  const [remise, setRemise] = useState<{ id: string; reference: string; contratMaintenanceId?: string | null } | null>(null);
  // Annuler demande un motif, écrit au journal (décision de Nelson du 24-10-2026), dans un dialogue.
  const [annulation, setAnnulation] = useState<{ id: string; reference: string; contratMaintenanceId?: string | null } | null>(null);

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

  // Relecture silencieuse (formulaire ouvert) : la liste reste affichée, les formulaires gardent leur saisie.
  const load = useCallback(async (silencieuse = false) => {
    if (!silencieuse) setLoading(true);
    try {
      const interventionsRes = await apiFetch(interventionId ? `/interventions/${interventionId}` : '/interventions');
      const interventionData = await interventionsRes.json();
      // Fiche hors périmètre, annulée ou supprimée : introuvable, la page le dit.
      const absente = !!interventionId && interventionsRes.status === 404;
      if (!interventionsRes.ok && !absente) throw new Error(interventionData.error || 'Impossible de charger les interventions.');
      setIntrouvable(absente);
      const items = absente ? [] : interventionId ? [interventionData] : Array.isArray(interventionData) ? interventionData : [];
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
  }, [chargerCouts, estEncadrement, interventionId]);

  useEffect(() => { void load(); }, [load]);

  // Après une relecture, un formulaire dont l'intervention a quitté la liste (annulée ailleurs, sortie du
  // périmètre) ou n'est plus en cours (clôture) se ferme : resté ouvert mais invisible, il masquerait les
  // actions de toutes les cartes.
  useEffect(() => {
    if (!formulaire || loading) return;
    const item = interventions.find((candidat) => candidat.id === formulaire.interventionId);
    if (!item) {
      setFormulaire(null);
      setError('Cette intervention a changé entre-temps (annulée ou retirée de vos dossiers) : la liste a été relue.');
    } else if (formulaire.type === 'cloture' && item.statut !== 'EN_COURS') {
      setFormulaire(null);
    }
  }, [formulaire, interventions, loading]);

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

  const transition = async (id: string, statut: string) => {
    setError('');
    // Terminer passe par le formulaire de clôture : compte rendu signé, ou motif (lot 3b-3).
    if (statut === 'TERMINEE') return setFormulaire({ type: 'cloture', interventionId: id });
    const res = await apiFetch(`/interventions/${id}/statut`, { method: 'PATCH', body: JSON.stringify({ statut }) });
    const data = await res.json();
    if (!res.ok) return setError(data.error || 'Transition impossible.');
    await load();
  };

  // Après un enregistrement, le formulaire se ferme et la liste est relue.
  const apresEnregistrement = async () => {
    setFormulaire(null);
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
      {interventionId ? <div><h1 className="text-2xl font-bold text-gray-900">Fiche intervention</h1><Link to={estTechnicien ? '/' : '/interventions'} className="text-sm font-medium text-blue-700">{estTechnicien ? '← Ma journée' : '← Toutes les interventions'}</Link></div>
        : <div><h1 className="text-2xl font-bold text-gray-900">{estTechnicien ? 'Mes interventions' : 'Interventions SAV'}</h1><p className="text-gray-500">{estTechnicien ? 'Uniquement les dossiers qui vous sont explicitement affectés.' : 'Demandes clients et interventions en cours. Le planning reste une projection prévisionnelle.'}</p></div>}
      {estEncadrement && !interventionId && <button className="btn btn-primary flex items-center gap-2" onClick={() => setFormOpen(true)}><Plus size={18} /> Nouvelle intervention</button>}
    </div>
    {isAdminRole(user?.role) && !interventionId && <AlerteGenerationVisites />}
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
    {loading ? <p className="text-gray-500">Chargement…</p> : interventions.length === 0 ? <div className="rounded-xl border border-dashed p-10 text-center text-gray-500"><Wrench className="mx-auto mb-3" />{interventionId ? (introuvable ? 'Intervention introuvable : annulée, ou retirée de vos dossiers.' : 'Fiche indisponible pour le moment.') : 'Aucune intervention active.'}</div> : <div className="grid grid-cols-1 gap-3">{interventions.map((item) => <article key={item.id} className="rounded-xl border bg-white p-5 shadow-sm break-words">
      <div className="flex justify-between gap-3"><div className="min-w-0 break-words"><p className="text-xs font-semibold text-blue-700">{item.reference}{item.auTempsPasse && <span className="ml-2 inline-block rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">Au temps passé</span>}{!interventionId && <> · <Link to={`/interventions/${item.id}`} className="underline">Ouvrir la fiche</Link></>}</p><h2 className="font-semibold text-gray-900">{item.titre}</h2><p className="text-sm text-gray-600">{item.client.raisonSociale}{item.dateDemande && ` · Demandée le ${formatDateOnlyOrEmpty(item.dateDemande)}`} · Souhaitée le {formatDateOnlyOrEmpty(item.dateSouhaitee)}</p>{(item.site || item.contact || item.chantier) && <p className="text-sm text-gray-500">{item.site && `Site : ${item.site.nom}${item.site.ville ? ` (${item.site.ville})` : ''}`}{item.contact && `${item.site ? ' · ' : ''}Contact : ${[item.contact.prenom, item.contact.nom].filter(Boolean).join(' ')}`}{item.chantier && `${item.site || item.contact ? ' · ' : ''}Affaire : ${item.chantier.numeroDevis ? `${item.chantier.numeroDevis} — ` : ''}${item.chantier.nom}`}</p>}</div><div className="text-right text-sm"><p className="font-medium">{libelleStatut[item.statut] || item.statut}</p><p className="text-gray-500">Priorité {libellePriorite[item.priorite] || item.priorite}</p></div></div>
      <CoordonneesIntervention intervention={item} />
      {item.description && <p className="mt-3 text-sm text-gray-600">{item.description}</p>}
      {item.couvertureContrat && <p className="mt-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">Couverture contractuelle figée : main-d’œuvre {item.couvertureContrat.politiqueMainOeuvre === 'INCLUSE' ? 'incluse' : 'hors forfait'} · matériel {item.couvertureContrat.politiqueMateriel === 'INCLUS' ? 'inclus' : 'hors forfait'}{item.couvertureContrat.noteCouverture ? ` · ${item.couvertureContrat.noteCouverture}` : ''}</p>}
      {/* Un conducteur ne reçoit aucun total hors contrat, où le matériel ne se saisit pas : pas de cadre vide (lot 3b). */}
      {couts[item.id] && (estTechnicien || (estEncadrement && (resumeCoutsIntervention(couts[item.id]) || (fournisseurs !== null && item.contratMaintenanceId)))) && <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
        {/* Coût réel, main-d'œuvre comprise, pour l'administration (main-d'œuvre seule hors contrat) ; matériel seul pour un conducteur (lot (d)). */}
        {estEncadrement && (() => { const resume = resumeCoutsIntervention(couts[item.id]); return resume && <p className="font-medium text-slate-800">{resume.libelle} : {montantEuros(resume.montant)} HT</p>; })()}
        {estTechnicien && <>
          {(couts[item.id].heures || []).length > 0 && <ul className="mb-3 space-y-1 text-slate-700">{couts[item.id].heures!.map((heure) => <li key={heure.id}>{formatDateOnlyOrEmpty(heure.date)} — {heure.nbrHeures} h{heure.commentaire ? ` — ${heure.commentaire}` : ''}</li>)}</ul>}
          <form onSubmit={(event) => void enregistrerHeures(event, item.id)} className="grid gap-2 sm:grid-cols-2"><input required name="date" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="Date (JJ-MM-AAAA)" className="form-input" /><input required name="nbrHeures" inputMode="decimal" placeholder="Heures" className="form-input" /><input name="commentaire" maxLength={500} placeholder="Commentaire" className="form-input sm:col-span-2" /><input name="motif" maxLength={500} placeholder="Motif (obligatoire si 0)" className="form-input" /><button type="submit" className="btn btn-secondary">Enregistrer mes heures</button></form>
        </>}
        {/* Hors contrat, l'intervention ne porte que les heures du technicien (lot 3b) : pas de matériel. */}
        {estEncadrement && fournisseurs !== null && item.contratMaintenanceId && <form onSubmit={(event) => void enregistrerAchat(event, item.id)} className="mt-3 grid gap-2 sm:grid-cols-2"><input required name="date" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="Date (JJ-MM-AAAA)" className="form-input" /><select required name="fournisseurId" defaultValue="" className="form-input"><option value="" disabled>Fournisseur</option>{fournisseurs.map((fournisseur) => <option key={fournisseur.id} value={fournisseur.id}>{fournisseur.nom}</option>)}</select><input required name="description" maxLength={500} placeholder="Description du matériel" className="form-input sm:col-span-2" /><input required name="montantHT" inputMode="decimal" placeholder="Montant HT" className="form-input" /><input name="motif" maxLength={500} placeholder="Motif (obligatoire si 0)" className="form-input" /><button type="submit" className="btn btn-secondary">Enregistrer l’achat matériel</button></form>}
      </div>}
      {(item.rapports || []).length > 0 && <div className="mt-3 rounded-lg bg-gray-50 p-3 text-sm"><p className="mb-1 font-medium text-gray-700">Comptes rendus terrain</p>{item.rapports!.map((rapport) => <div key={rapport.id} className="mb-2 last:mb-0 text-gray-600"><p className="whitespace-pre-line">{rapport.contenu} <span className="text-gray-400">— {rapport.auteur.name}, {formatCompanyDateOrEmpty(rapport.createdAt)}</span></p>{rapport.signature ? <div className="text-xs text-emerald-700"><p>Signé par {rapport.signature.signataire} le {formatCompanyDateOrEmpty(rapport.signature.accepteLe)}{rapport.signature.enregistrePar ? ` · enregistré par ${rapport.signature.enregistrePar.name}` : ''} · empreinte enregistrée</p>{rapport.signature.trace && <TraceSignature trace={rapport.signature.trace} signataire={rapport.signature.signataire} />}</div> : item.statut !== 'ANNULEE' && !formulaire ? <button type="button" onClick={() => setFormulaire({ type: 'signature', interventionId: item.id, rapportId: rapport.id })} className="mt-1 text-xs font-medium text-blue-700">Faire signer ce compte rendu</button> : null}</div>)}</div>}
      {formulaire?.interventionId === item.id && formulaire.type === 'compteRendu' && <FormulaireCompteRendu interventionId={item.id} onEnregistre={apresEnregistrement} onRelire={() => load(true)} onAnnuler={() => setFormulaire(null)} />}
      {formulaire?.interventionId === item.id && formulaire.type === 'signature' && (() => { const rapport = (item.rapports || []).find((candidat) => candidat.id === formulaire.rapportId); return rapport && <FormulaireSignature rapport={rapport} enregistrePar={user?.name || 'Session interne active'} onEnregistre={apresEnregistrement} onRelire={() => load(true)} onAnnuler={() => setFormulaire(null)} />; })()}
      {formulaire?.interventionId === item.id && formulaire.type === 'cloture' && item.statut === 'EN_COURS' && <FormulaireCloture interventionId={item.id} nombreComptesRendus={(item.rapports || []).length} signe={(item.rapports || []).some((rapport) => rapport.signature)} onTermine={apresEnregistrement} onRelire={() => load(true)} onAjouterCompteRendu={() => setFormulaire({ type: 'compteRendu', interventionId: item.id })} onAnnuler={() => setFormulaire(null)} />}
      {!formulaire && <div className="mt-4 flex flex-wrap gap-2">{(transitions[item.statut] || []).filter((action) => !estTechnicien || action.statut === 'EN_COURS' || action.statut === 'TERMINEE').map((action) => <button key={action.statut} type="button" onClick={() => action.statut === 'ANNULEE' ? setAnnulation({ id: item.id, reference: item.reference, contratMaintenanceId: item.contratMaintenanceId }) : void transition(item.id, action.statut)} className={action.statut === 'ANNULEE' ? 'btn btn-secondary text-red-700' : 'btn btn-primary'}>{action.libelle}</button>)}{item.statut === 'EN_COURS' && <button type="button" onClick={() => setFormulaire({ type: 'compteRendu', interventionId: item.id })} className="btn btn-secondary">Ajouter un compte rendu</button>}{peutRemettre && interventionRemettable(item) && <button type="button" onClick={() => setRemise({ id: item.id, reference: item.reference, contratMaintenanceId: item.contratMaintenanceId })} className="btn btn-secondary">Remettre à planifier</button>}</div>}
    </article>)}</div>}
    {remise && <RemiseAPlanifier interventionId={remise.id} reference={remise.reference} contratMaintenanceId={remise.contratMaintenanceId} onClose={() => setRemise(null)} onRemise={() => { setRemise(null); void load(true); }} />}
    {annulation && <AnnulationIntervention interventionId={annulation.id} reference={annulation.reference} contratMaintenanceId={annulation.contratMaintenanceId} onClose={() => setAnnulation(null)} onAnnulee={() => { setAnnulation(null); setError(''); void load(); }} />}
  </div>;
}
