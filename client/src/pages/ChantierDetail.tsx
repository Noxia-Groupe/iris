import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import html2pdf from 'html2pdf.js';
import imageCompression from 'browser-image-compression';
import {
  ArrowLeft, Calendar, User, FileDown, Sparkles, Camera,
  Package, Users, Truck, Wallet, Clock3, Hammer, Briefcase, Pencil, X,
} from 'lucide-react';
import { apiFetch, assetUrl } from '../api';
import { ProgressMeter } from '../components/ProgressMeter';
import { BarBreakdown, type BreakdownRow } from '../components/BarBreakdown';
import { ClientAutocomplete } from '../components/ClientAutocomplete';
import { DevisAutocomplete } from '../components/DevisAutocomplete';
import { TYPES_CHANTIER } from '../chantierTypes';

// Date ISO (avec ou sans heure) -> "YYYY-MM-DD" attendu par <input type="date">.
const toDateInputValue = (d: string | null | undefined) => (d ? d.slice(0, 10) : '');

const fmtDate = (d: string) => new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
const fmtEuro = (n: number) => `${n.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} €`;
const daysBetween = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 86400000));

const STATUT_LABELS: Record<string, string> = {
  EN_COURS: 'En cours',
  TERMINE: 'Terminé',
};

const ChantierDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const userStr = localStorage.getItem('user');
  const currentUser = userStr ? JSON.parse(userStr) : null;
  const userRole = currentUser?.role || 'CONDUCTEUR_TRAVAUX';

  const [chantier, setChantier] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiReport, setAiReport] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  const [commerciaux, setCommerciaux] = useState<any[]>([]);
  const [editingCommercial, setEditingCommercial] = useState(false);
  const [savingCommercial, setSavingCommercial] = useState(false);

  // Édition des informations du chantier (nom, budgets, dates...) — réservée aux admins,
  // le serveur (PATCH /api/chantiers/:id) refuse déjà la requête à quiconque d'autre.
  const [conducteurs, setConducteurs] = useState<any[]>([]);
  const [editingChantier, setEditingChantier] = useState(false);
  const [savingChantier, setSavingChantier] = useState(false);
  // Préremplissage du budget global vendu depuis un devis Odoo sélectionné (modale
  // d'édition ci-dessous) — champ non contrôlé, on écrit directement dedans.
  const editChantierBudgetRef = useRef<HTMLInputElement>(null);

  // Correction d'un pointage d'heures déjà saisi (erreur de date, d'intervenant, de
  // nombre d'heures...) — ouverte aux conducteurs comme aux admins (contrairement à
  // l'édition des infos du chantier ci-dessus, réservée aux admins) : le serveur
  // (PATCH /api/heures/:id) applique les mêmes droits que la saisie initiale.
  const [intervenants, setIntervenants] = useState<any[]>([]);
  const [editingPointageId, setEditingPointageId] = useState<string | null>(null);
  const [savingPointage, setSavingPointage] = useState(false);

  // Correction d'un achat déjà saisi (erreur de montant, de fournisseur, de
  // catégorie...) — mêmes droits que ci-dessus (PATCH /api/achats/:id).
  const [fournisseurs, setFournisseurs] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [editingAchatId, setEditingAchatId] = useState<string | null>(null);
  const [savingAchat, setSavingAchat] = useState(false);

  useEffect(() => {
    fetchChantier();
    fetchConfig();
    setAiReport(null);
    setEditingCommercial(false);
    setEditingChantier(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const fetchConfig = async () => {
    try {
      const res = await apiFetch('/config');
      const data = await res.json();
      setAiEnabled(data.aiEnabled);
    } catch (e) { console.error(e); }
  };

  // Liste des commerciaux, pour le sélecteur d'affectation (admin ou conducteur
  // responsable uniquement — cf. rendu de la section Commercial ci-dessous).
  // /commerciaux (contrairement à /users) est accessible à tout utilisateur authentifié.
  const fetchCommerciaux = async () => {
    try {
      const res = await apiFetch('/commerciaux');
      const data = await res.json();
      if (Array.isArray(data)) setCommerciaux(data);
    } catch (e) { console.error(e); }
  };

  // Bascule la clause de sécurisation "Encaissé" (réservée aux admins) — une commission
  // commerciale n'est comptabilisée dans le barème mensuel que si le chantier est
  // Terminé ET Encaissé (cf. règle 6 du système de rémunération commerciale).
  const [savingEncaisse, setSavingEncaisse] = useState(false);
  const handleToggleEncaisse = async () => {
    if (!id || !chantier) return;
    setSavingEncaisse(true);
    try {
      const res = await apiFetch(`/chantiers/${id}/encaisse`, { method: 'PATCH', body: JSON.stringify({ encaisse: !chantier.encaisse }) });
      if (res.ok) fetchChantier();
      else { const d = await res.json(); alert(d.error || "Erreur lors de la mise à jour de l'encaissement."); }
    } catch (e) {
      alert('Impossible de joindre le serveur.');
    } finally {
      setSavingEncaisse(false);
    }
  };

  const handleAssignCommercial = async (commercialId: string) => {
    if (!id) return;
    setSavingCommercial(true);
    try {
      const res = await apiFetch(`/chantiers/${id}/commercial`, { method: 'PATCH', body: JSON.stringify({ commercialId: commercialId || null }) });
      if (res.ok) {
        setEditingCommercial(false);
        fetchChantier();
      } else {
        const d = await res.json();
        alert(d.error || "Erreur lors de l'affectation du commercial.");
      }
    } catch (e) {
      alert('Impossible de joindre le serveur.');
    } finally {
      setSavingCommercial(false);
    }
  };

  // Liste des conducteurs, pour le sélecteur de responsable dans le formulaire d'édition
  // (admin uniquement — /users est une route admin-only, cohérent ici).
  const fetchConducteurs = async () => {
    try {
      const res = await apiFetch('/users');
      const data = await res.json();
      if (Array.isArray(data)) setConducteurs(data.filter((u: any) => u.role === 'CONDUCTEUR_TRAVAUX'));
    } catch (e) { console.error(e); }
  };

  const startEditChantier = () => {
    if (conducteurs.length === 0) fetchConducteurs();
    if (commerciaux.length === 0) fetchCommerciaux();
    setEditingChantier(true);
  };

  const handleChantierSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    const formData = new FormData(e.target as HTMLFormElement);
    // Le commercial rattaché a sa propre route (/commercial) — pas dans la liste blanche
    // de PATCH /chantiers/:id — on l'envoie donc à part, après les autres champs.
    const commercialId = String(formData.get('commercialId') || '');
    formData.delete('commercialId');
    // Case à cocher unique : absente de FormData quand décochée, on la force donc à
    // explicitement true/false pour que décocher l'enregistre bien (cf. 'types' ci-dessous).
    const data = { ...Object.fromEntries(formData.entries()), types: formData.getAll('types'), dossierNoxia: formData.get('dossierNoxia') === 'true' };
    setSavingChantier(true);
    try {
      const res = await apiFetch(`/chantiers/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
      if (!res.ok) {
        const d = await res.json();
        alert(d.error || 'Erreur lors de la modification du chantier.');
        return;
      }
      const commRes = await apiFetch(`/chantiers/${id}/commercial`, { method: 'PATCH', body: JSON.stringify({ commercialId: commercialId || null }) });
      if (!commRes.ok) {
        const d = await commRes.json();
        alert(d.error || "Erreur lors de l'affectation du commercial.");
        return;
      }
      setEditingChantier(false);
      fetchChantier();
    } catch (e) {
      alert('Impossible de joindre le serveur.');
    } finally {
      setSavingChantier(false);
    }
  };

  // Liste des intervenants, pour le sélecteur de technicien dans le formulaire de
  // correction d'un pointage (chargée à la demande, au premier clic sur "Modifier").
  const fetchIntervenants = async () => {
    try {
      const res = await apiFetch('/intervenants');
      const data = await res.json();
      if (Array.isArray(data)) setIntervenants(data);
    } catch (e) { console.error(e); }
  };

  const startEditPointage = (pointageId: string) => {
    if (intervenants.length === 0) fetchIntervenants();
    setEditingPointageId(pointageId);
  };

  const handlePointageSubmit = async (e: React.FormEvent, pointageId: string) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    const data = Object.fromEntries(formData.entries());
    setSavingPointage(true);
    try {
      const res = await apiFetch(`/heures/${pointageId}`, { method: 'PATCH', body: JSON.stringify(data) });
      if (res.ok) {
        setEditingPointageId(null);
        fetchChantier();
      } else {
        const d = await res.json();
        alert(d.error || 'Erreur lors de la modification du pointage.');
      }
    } catch (e) {
      alert('Impossible de joindre le serveur.');
    } finally {
      setSavingPointage(false);
    }
  };

  // Listes fournisseurs/catégories, pour les sélecteurs du formulaire de correction d'un
  // achat (chargées à la demande, au premier clic sur "Modifier").
  const fetchFournisseurs = async () => {
    try {
      const res = await apiFetch('/fournisseurs');
      const data = await res.json();
      if (Array.isArray(data)) setFournisseurs(data);
    } catch (e) { console.error(e); }
  };

  const fetchCategories = async () => {
    try {
      const res = await apiFetch('/categories');
      const data = await res.json();
      if (Array.isArray(data)) setCategories(data);
    } catch (e) { console.error(e); }
  };

  const startEditAchat = (achatId: string) => {
    if (fournisseurs.length === 0) fetchFournisseurs();
    if (categories.length === 0) fetchCategories();
    setEditingAchatId(achatId);
  };

  const handleAchatSubmit = async (e: React.FormEvent, achatId: string) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    const data = Object.fromEntries(formData.entries());
    setSavingAchat(true);
    try {
      const res = await apiFetch(`/achats/${achatId}`, { method: 'PATCH', body: JSON.stringify(data) });
      if (res.ok) {
        setEditingAchatId(null);
        fetchChantier();
      } else {
        const d = await res.json();
        alert(d.error || "Erreur lors de la modification de l'achat.");
      }
    } catch (e) {
      alert('Impossible de joindre le serveur.');
    } finally {
      setSavingAchat(false);
    }
  };

  const fetchChantier = async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const res = await apiFetch(`/chantiers/${id}`);
      if (res.status === 404) { setNotFound(true); return; }
      const data = await res.json();
      setChantier(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateAI = async () => {
    if (!id) return;
    setAiLoading(true);
    try {
      const res = await apiFetch(`/chantiers/${id}/analyze`, { method: 'POST' });
      const data = await res.json();
      if (data.report) setAiReport(data.report);
      else alert(data.error || 'Erreur IA');
    } catch (e) {
      alert("Erreur de connexion à l'IA");
    } finally {
      setAiLoading(false);
    }
  };

  const handleExportPDF = () => {
    if (!printRef.current || !chantier) return;
    const opt = {
      margin: 0.5,
      filename: `Rapport_${chantier.nom}.pdf`,
      image: { type: 'jpeg' as const, quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'in' as const, format: 'letter' as const, orientation: 'portrait' as const },
    };
    html2pdf().set(opt).from(printRef.current).save();
  };

  const handlePhotoUpload = async (e: any) => {
    const file = e.target.files[0];
    if (!file || !id) return;
    try {
      const compressedFile = await imageCompression(file, { maxSizeMB: 0.5, maxWidthOrHeight: 1200 });
      const formData = new FormData();
      formData.append('photo', compressedFile);
      formData.append('legende', 'Photo mobile');
      await apiFetch(`/chantiers/${id}/photos`, { method: 'POST', body: formData });
      fetchChantier();
    } catch (err) {
      console.error(err);
      alert("Erreur lors de l'upload");
    }
  };

  const achats: any[] = chantier?.achats || [];
  const pointages: any[] = chantier?.pointages || [];

  const parCategorie: BreakdownRow[] = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of achats) {
      const key = a.categorie?.nom || 'Non catégorisé';
      map.set(key, (map.get(key) || 0) + a.montantHT);
    }
    return Array.from(map, ([label, value]) => ({ label, value }));
  }, [achats]);

  const parFournisseur: BreakdownRow[] = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of achats) {
      const key = a.fournisseur?.nom || 'Non renseigné';
      map.set(key, (map.get(key) || 0) + a.montantHT);
    }
    return Array.from(map, ([label, value]) => ({ label, value }));
  }, [achats]);

  const parIntervenant: BreakdownRow[] = useMemo(() => {
    const map = new Map<string, { heures: number; cout: number; role: string }>();
    for (const p of pointages) {
      const key = p.intervenant?.nom || 'Non renseigné';
      const cur = map.get(key) || { heures: 0, cout: 0, role: p.intervenant?.role || '' };
      cur.heures += p.nbrHeures;
      cur.cout += p.nbrHeures * p.tauxHoraireApplique;
      map.set(key, cur);
    }
    return Array.from(map, ([label, v]) => ({ label, value: v.heures, sublabel: v.role }));
  }, [pointages]);

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-xl text-muted animate-pulse">Chargement du chantier...</div>
    </div>
  );

  if (notFound || !chantier) return (
    <div className="flex-1 flex flex-col items-center justify-center bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center h-full">
      <div className="text-6xl mb-4">🔍</div>
      <h2 className="text-2xl font-bold text-gray-700 mb-2">Chantier introuvable</h2>
      <p className="text-muted max-w-md mb-6">Ce chantier n'existe pas ou a été supprimé.</p>
      <Link to="/" className="btn btn-primary flex items-center gap-2 no-underline">
        <ArrowLeft size={16} /> Retour au tableau de bord
      </Link>
    </div>
  );

  const metrics = chantier.metrics || {};
  const depenseMaterielReelle = metrics.materielReel || 0;
  const heuresRealisees = metrics.heuresRealisees || 0;
  const coutMainOeuvreReel = metrics.moReel || 0;
  const totalDepensesReelles = metrics.totalDepenses || 0;
  // Manque à gagner = uniquement le coût des heures EN TROP par rapport au vendu, valorisées
  // au taux horaire moyen réellement appliqué sur ce chantier — pas la différence avec le
  // budget main d'œuvre vendu (qui peut s'écarter du taux horaire pour d'autres raisons,
  // ex: marge intégrée au devis, et fausserait alors le montant du dépassement lui-même).
  const heuresDepassement = Math.max(0, heuresRealisees - chantier.heuresVendues);
  const tauxHoraireMoyen = heuresRealisees > 0 ? coutMainOeuvreReel / heuresRealisees : 0;
  const manqueAGagnerMainOeuvre = heuresDepassement * tauxHoraireMoyen;
  const margeCommerciale: number | null = metrics.margeCommerciale ?? null;
  const showMarge = margeCommerciale !== null;
  const margeAffichee = margeCommerciale ?? 0;
  const showBudgetVendu = chantier.budgetGlobalVendu != null;

  const dateDebut = new Date(chantier.dateDebut);
  const dateFin = chantier.dateFin ? new Date(chantier.dateFin) : null;
  const isTermine = chantier.statut !== 'EN_COURS';
  const joursEcoules = daysBetween(dateDebut, dateFin && isTermine ? dateFin : new Date());

  // Le commercial rattaché est modifiable par l'admin ou par le conducteur responsable
  // du chantier — jamais par le commercial lui-même, ni par un autre conducteur.
  const canEditCommercial = userRole === 'ADMIN' || (userRole === 'CONDUCTEUR_TRAVAUX' && chantier.responsable?.id === currentUser?.id);
  const startEditCommercial = () => {
    if (commerciaux.length === 0) fetchCommerciaux();
    setEditingCommercial(true);
  };

  return (
    <div className="flex flex-col h-full overflow-x-hidden">

      {/* Fil d'ariane / retour */}
      <button
        onClick={() => navigate('/')}
        className="flex items-center gap-2 text-sm font-semibold text-gray-500 hover:text-accent transition-colors mb-4 w-fit"
      >
        <ArrowLeft size={16} /> Retour au tableau de bord
      </button>

      <div className="flex flex-col gap-6 w-full max-w-full">

        {/* Zone exportable en PDF */}
        <div ref={printRef} className="bg-white p-6 sm:p-8 rounded-2xl shadow-md border border-gray-100 relative">

          {/* Action Bar */}
          <div className="absolute top-6 right-6 flex gap-2">
            {userRole === 'ADMIN' && (
              <button
                onClick={startEditChantier}
                className="flex items-center gap-2 bg-white border border-gray-200 text-gray-700 px-4 py-2 rounded-lg font-semibold hover:bg-gray-50 transition-colors shadow-sm text-sm"
              >
                <Pencil size={16} /> Modifier
              </button>
            )}
            {aiEnabled && (
              <button
                onClick={handleGenerateAI}
                disabled={aiLoading}
                className={`flex items-center gap-2 ${aiLoading ? 'bg-indigo-300' : 'bg-indigo-600 hover:bg-indigo-700'} text-white px-4 py-2 rounded-lg font-semibold transition-colors shadow-sm text-sm`}
              >
                <Sparkles size={16} className={aiLoading ? 'animate-spin' : ''} />
                {aiLoading ? 'Génération...' : 'Rapport IA'}
              </button>
            )}
            <button onClick={handleExportPDF} className="flex items-center gap-2 bg-gray-800 text-white px-4 py-2 rounded-lg font-semibold hover:bg-gray-700 transition-colors shadow-sm text-sm">
              <FileDown size={16} /> PDF
            </button>
          </div>

          <div className="mb-8 pr-32">
            <div className="flex items-center gap-3 flex-wrap mb-2">
              <h2 className="text-3xl font-extrabold text-primary-dark tracking-tight m-0">{chantier.nom}</h2>
              <span className={`text-xs font-bold uppercase tracking-wide px-2.5 py-1 rounded-full ${isTermine ? 'bg-gray-100 text-gray-500' : 'bg-blue-100 text-accent'}`}>
                {STATUT_LABELS[chantier.statut] || chantier.statut}
              </span>
              {chantier.types?.map((t: string) => (
                <span key={t} className="text-[11px] font-semibold px-2.5 py-1 bg-indigo-50 text-indigo-700 rounded-full">{t}</span>
              ))}
              {chantier.dossierNoxia && (
                <span className="text-[11px] font-semibold px-2.5 py-1 bg-amber-50 text-amber-700 rounded-full">Dossier NOXIA</span>
              )}
              {isTermine && (userRole === 'ADMIN' ? (
                <button
                  type="button"
                  onClick={handleToggleEncaisse}
                  disabled={savingEncaisse}
                  title="Réservé aux admins : conditionne la commission commerciale du mois de clôture"
                  className={`text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full transition-colors ${chantier.encaisse ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-red-50 text-red-600 hover:bg-red-100'}`}
                >
                  {chantier.encaisse ? '✓ Encaissé' : 'Non encaissé'}
                </button>
              ) : (
                <span className={`text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full ${chantier.encaisse ? 'bg-emerald-100 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                  {chantier.encaisse ? '✓ Encaissé' : 'Non encaissé'}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-gray-600">
              <span className="flex items-center gap-1.5"><strong className="text-gray-800">Client:</strong> {chantier.client}</span>
              <span className="flex items-center gap-1.5"><strong className="text-gray-800">Devis:</strong> {chantier.numeroDevis || 'N/A'}</span>
              {chantier.responsable?.name && (
                <span className="flex items-center gap-1.5"><User size={14} className="text-gray-400" /> {chantier.responsable.name}</span>
              )}
              <span className="flex items-center gap-1.5">
                <Calendar size={14} className="text-gray-400" />
                Démarré le {fmtDate(chantier.dateDebut)}
                {isTermine && dateFin ? ` — terminé le ${fmtDate(chantier.dateFin)} (${joursEcoules} j)` : ` (il y a ${joursEcoules} j)`}
              </span>
              {editingCommercial ? (
                <span className="flex items-center gap-1.5">
                  <Briefcase size={14} className="text-gray-400" />
                  <select
                    autoFocus
                    disabled={savingCommercial}
                    defaultValue={chantier.commercial?.id || ''}
                    onChange={(e) => handleAssignCommercial(e.target.value)}
                    onBlur={() => setEditingCommercial(false)}
                    className="text-sm border border-gray-200 rounded-md px-2 py-0.5"
                  >
                    <option value="" disabled>Sélectionner un commercial...</option>
                    {commerciaux.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <Briefcase size={14} className="text-gray-400" />
                  {chantier.commercial?.name || <span className="italic text-gray-400">Aucun commercial</span>}
                  {canEditCommercial && (
                    <button type="button" onClick={startEditCommercial} className="text-xs font-semibold text-accent hover:underline ml-1">
                      Modifier
                    </button>
                  )}
                </span>
              )}
            </div>
          </div>

          {/* Bannière de rappel : un chantier Terminé mais Non encaissé ne compte pas dans
              la commission du commercial du mois (clause de sécurisation des commissions).
              Le badge ci-dessus permet déjà de basculer ce statut, mais reste discret parmi
              les autres badges — cette bannière rend l'action impossible à manquer. */}
          {isTermine && !chantier.encaisse && userRole === 'ADMIN' && (
            <div className="mb-6 p-4 rounded-xl border-l-8 border-amber-500 bg-amber-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="font-bold text-amber-800">Chantier terminé, en attente d'encaissement</div>
                <div className="text-sm text-amber-700">
                  Tant que l'encaissement n'est pas validé, la marge et la commission du commercial ne sont pas comptabilisées pour ce chantier.
                </div>
              </div>
              <button
                type="button"
                onClick={handleToggleEncaisse}
                disabled={savingEncaisse}
                className="shrink-0 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-semibold text-sm transition-colors"
              >
                {savingEncaisse ? 'Validation...' : "Valider l'encaissement"}
              </button>
            </div>
          )}

          {/* Key Metrics */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {showBudgetVendu && (
              <div className="bg-gray-50 p-5 rounded-xl border border-gray-100 flex flex-col justify-center relative overflow-hidden group">
                <div className="absolute top-0 right-0 w-16 h-16 bg-blue-100 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
                <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 z-10">Budget Vendu</div>
                <div className="text-2xl font-black text-primary-dark z-10">{chantier.budgetGlobalVendu.toLocaleString()} €</div>
              </div>
            )}

            <div className="bg-gray-50 p-5 rounded-xl border border-gray-100 flex flex-col justify-center relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-16 h-16 bg-green-100 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
              <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 z-10">Matériel Prévu</div>
              <div className="text-2xl font-black text-accent z-10">{chantier.budgetMaterielVendu.toLocaleString()} €</div>
            </div>

            <div className="bg-gray-50 p-5 rounded-xl border border-gray-100 flex flex-col justify-center relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-16 h-16 bg-purple-100 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
              <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 z-10">Heures Prévues</div>
              <div className="text-2xl font-black text-purple-600 z-10">{chantier.heuresVendues} h</div>
            </div>

            <div className="bg-gray-50 p-5 rounded-xl border border-gray-100 flex flex-col justify-center relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-16 h-16 bg-orange-100 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
              <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 z-10">Coût MO Prévu</div>
              <div className="text-2xl font-black text-orange-600 z-10">{chantier.budgetMainOeuvreVendu.toLocaleString()} €</div>
            </div>
          </div>

          {/* Zone Rapport IA */}
          {aiReport && (
            <div className="mb-8 p-6 bg-indigo-50 border border-indigo-100 rounded-xl shadow-sm">
              <div className="flex items-center gap-2 mb-4">
                <Sparkles size={20} className="text-indigo-600" />
                <h3 className="text-lg font-bold text-indigo-900 m-0">Synthèse Intelligente (IA)</h3>
              </div>
              <div className="text-gray-800 text-sm leading-relaxed whitespace-pre-wrap">{aiReport}</div>
            </div>
          )}

          {/* Marge Commerciale (admin, ou conducteur responsable sur sa fiche chantier — cf.
              GET /api/chantiers/:id côté serveur —, si activée dans les paramètres) */}
          {showMarge && (
            <div className={`mb-8 p-6 rounded-xl border-l-8 flex flex-col gap-4 shadow-sm relative overflow-hidden ${margeAffichee > 0 ? 'bg-emerald-50 border-emerald-500' : 'bg-red-50 border-red-500'}`}>
              <div className="flex flex-col md:flex-row justify-between items-center gap-4">
                <div className="z-10 text-center md:text-left">
                  <div className={`text-xs font-bold uppercase tracking-widest ${margeAffichee > 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                    Marge Commerciale
                  </div>
                  <div className={`text-5xl font-black mt-2 tracking-tight ${margeAffichee > 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                    {margeAffichee.toLocaleString()} €
                  </div>
                  {metrics.margePct != null && (
                    <div className={`text-sm font-bold mt-1 ${margeAffichee > 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                      {metrics.margePct.toFixed(1)}% du budget vendu
                    </div>
                  )}
                </div>

                <div className="z-10 bg-white/60 backdrop-blur-sm p-4 rounded-lg text-right">
                  <div className="text-xs text-gray-500 font-bold uppercase tracking-wider mb-1">Dépenses Réelles Cumulées</div>
                  <div className="font-bold text-2xl text-gray-800">{totalDepensesReelles.toLocaleString()} €</div>
                </div>
              </div>
            </div>
          )}

          {/* Progress Bars */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-8">
            {/* Matériel */}
            <div>
              <div className="flex justify-between items-end mb-2">
                <h3 className="font-bold text-gray-800 flex items-center gap-2 m-0">
                  <Package size={18} className="text-accent" /> Consommation Matériel
                </h3>
                <div className="text-right">
                  <span className="text-xl font-black text-accent">{depenseMaterielReelle.toLocaleString()} €</span>
                  <span className="text-sm font-semibold text-gray-400 ml-1">/ {chantier.budgetMaterielVendu.toLocaleString()} €</span>
                </div>
              </div>
              <ProgressMeter value={depenseMaterielReelle} max={chantier.budgetMaterielVendu} color="blue" striped />
              <div className="mt-2 text-right text-xs font-bold text-gray-500">
                {((depenseMaterielReelle / Math.max(1, chantier.budgetMaterielVendu)) * 100).toFixed(1)}%
              </div>
            </div>

            {/* Coût main d'oeuvre (€) — distinct de la barre "Heures" ci-dessous : un
                dépassement d'heures se traduit ici en euros réellement dépensés en salaire,
                avec le manque à gagner correspondant s'il dépasse le budget vendu. */}
            <div>
              <div className="flex justify-between items-end mb-2">
                <h3 className="font-bold text-gray-800 flex items-center gap-2 m-0">
                  <Wallet size={18} className="text-orange-500" /> Coût Main d'Œuvre
                </h3>
                <div className="text-right">
                  <span className="text-xl font-black text-orange-600">{coutMainOeuvreReel.toLocaleString()} €</span>
                  <span className="text-sm font-semibold text-gray-400 ml-1">/ {chantier.budgetMainOeuvreVendu.toLocaleString()} €</span>
                </div>
              </div>
              <ProgressMeter value={coutMainOeuvreReel} max={chantier.budgetMainOeuvreVendu} color="orange" striped />
              <div className="mt-2 flex justify-between items-center text-xs font-bold">
                <span className={manqueAGagnerMainOeuvre > 0 ? 'text-red-600' : 'text-gray-300'}>
                  {manqueAGagnerMainOeuvre > 0 ? `Manque à gagner : -${manqueAGagnerMainOeuvre.toLocaleString()} €` : ''}
                </span>
                <span className="text-gray-500">
                  {((coutMainOeuvreReel / Math.max(1, chantier.budgetMainOeuvreVendu)) * 100).toFixed(1)}%
                </span>
              </div>
            </div>

            {/* Heures */}
            <div>
              <div className="flex justify-between items-end mb-2">
                <h3 className="font-bold text-gray-800 flex items-center gap-2 m-0">
                  <Clock3 size={18} className="text-purple-500" /> Consommation Heures
                </h3>
                <div className="text-right">
                  <span className="text-xl font-black text-purple-600">{heuresRealisees.toFixed(2)} h</span>
                  <span className="text-sm font-semibold text-gray-400 ml-1">/ {chantier.heuresVendues} h</span>
                </div>
              </div>
              <ProgressMeter value={heuresRealisees} max={chantier.heuresVendues} color="purple" striped />
              <div className="mt-2 text-right text-xs font-bold text-gray-500">
                {((heuresRealisees / Math.max(1, chantier.heuresVendues)) * 100).toFixed(1)}%
              </div>
            </div>
          </div>

          {/* Répartitions */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="bg-gray-50 rounded-xl border border-gray-100 p-5">
              <h3 className="font-bold text-gray-800 flex items-center gap-2 mb-4 text-sm uppercase tracking-wide">
                <Package size={16} className="text-accent" /> Achats par catégorie
              </h3>
              <BarBreakdown rows={parCategorie} color="#0251a1" formatValue={fmtEuro} emptyLabel="Aucun achat enregistré" />
            </div>
            <div className="bg-gray-50 rounded-xl border border-gray-100 p-5">
              <h3 className="font-bold text-gray-800 flex items-center gap-2 mb-4 text-sm uppercase tracking-wide">
                <Truck size={16} className="text-orange-500" /> Achats par fournisseur
              </h3>
              <BarBreakdown rows={parFournisseur} color="#ea580c" formatValue={fmtEuro} emptyLabel="Aucun achat enregistré" />
            </div>
            <div className="bg-gray-50 rounded-xl border border-gray-100 p-5">
              <h3 className="font-bold text-gray-800 flex items-center gap-2 mb-4 text-sm uppercase tracking-wide">
                <Users size={16} className="text-purple-500" /> Heures par intervenant
              </h3>
              <BarBreakdown rows={parIntervenant} color="#8b5cf6" formatValue={(v) => `${v.toFixed(1)} h`} emptyLabel="Aucune heure enregistrée" />
            </div>
          </div>

        </div>

        {/* Journaux (hors PDF) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-2xl shadow-md border border-gray-100 overflow-hidden">
            <div className="flex items-center gap-2 px-6 py-4 border-b border-gray-100">
              <Wallet size={18} className="text-accent" />
              <h3 className="text-lg font-bold text-primary-dark m-0">Derniers achats</h3>
            </div>
            {achats.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-400 italic">Aucun achat enregistré.</div>
            ) : (
              <div className="divide-y divide-gray-100">
                {achats.slice(0, 6).map((a) => (
                  editingAchatId === a.id ? (
                    <form
                      key={a.id}
                      onSubmit={(e) => handleAchatSubmit(e, a.id)}
                      className="grid grid-cols-2 gap-2 px-6 py-3 bg-gray-50"
                    >
                      <input required type="date" name="date" defaultValue={toDateInputValue(a.date)} className="form-input text-sm" />
                      <input required type="number" step="0.01" name="montantHT" defaultValue={a.montantHT} placeholder="Montant HT" className="form-input text-sm" />
                      <select required name="fournisseurId" defaultValue={a.fournisseurId} className="form-input text-sm">
                        {fournisseurs.length === 0 && <option value={a.fournisseurId}>{a.fournisseur?.nom}</option>}
                        {fournisseurs.map((f) => <option key={f.id} value={f.id}>{f.nom}</option>)}
                      </select>
                      <select required name="categorieId" defaultValue={a.categorieId} className="form-input text-sm">
                        {categories.length === 0 && <option value={a.categorieId}>{a.categorie?.nom}</option>}
                        {categories.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
                      </select>
                      <input required type="text" name="description" defaultValue={a.description} placeholder="Description" className="form-input text-sm col-span-2" />
                      <input type="text" name="numeroFacture" defaultValue={a.numeroFacture || ''} placeholder="N° de facture (optionnel)" className="form-input text-sm col-span-2" />
                      <div className="col-span-2 flex gap-2 justify-end">
                        <button type="button" disabled={savingAchat} onClick={() => setEditingAchatId(null)} className="btn bg-white border text-xs px-3 py-1.5">Annuler</button>
                        <button type="submit" disabled={savingAchat} className="btn btn-primary text-xs px-3 py-1.5">
                          {savingAchat ? 'Enregistrement...' : 'Enregistrer'}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div key={a.id} className="flex items-center justify-between gap-3 px-6 py-3 text-sm">
                      <div className="min-w-0">
                        <div className="font-semibold text-gray-700 truncate">{a.description}</div>
                        <div className="text-xs text-gray-400">{fmtDate(a.date)} · {a.fournisseur?.nom} · {a.categorie?.nom}</div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="font-bold text-gray-800 whitespace-nowrap">{fmtEuro(a.montantHT)}</div>
                        {userRole !== 'COMMERCIAL' && (
                          <button
                            onClick={() => startEditAchat(a.id)}
                            className="p-1.5 text-gray-400 hover:text-accent hover:bg-blue-50 rounded-lg transition-colors"
                            title="Corriger cet achat"
                          >
                            <Pencil size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                ))}
              </div>
            )}
          </div>

          <div className="bg-white rounded-2xl shadow-md border border-gray-100 overflow-hidden">
            <div className="flex items-center gap-2 px-6 py-4 border-b border-gray-100">
              <Hammer size={18} className="text-purple-500" />
              <h3 className="text-lg font-bold text-primary-dark m-0">Dernières heures</h3>
            </div>
            {pointages.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-400 italic">Aucune heure enregistrée.</div>
            ) : (
              <div className="divide-y divide-gray-100">
                {pointages.slice(0, 6).map((p) => (
                  editingPointageId === p.id ? (
                    <form
                      key={p.id}
                      onSubmit={(e) => handlePointageSubmit(e, p.id)}
                      className="grid grid-cols-2 gap-2 px-6 py-3 bg-gray-50"
                    >
                      <input required type="date" name="date" defaultValue={toDateInputValue(p.date)} className="form-input text-sm" />
                      <select required name="intervenantId" defaultValue={p.intervenantId} className="form-input text-sm">
                        {intervenants.length === 0 && <option value={p.intervenantId}>{p.intervenant?.nom}</option>}
                        {intervenants.map((i) => <option key={i.id} value={i.id}>{i.nom} ({i.role})</option>)}
                      </select>
                      <input required type="number" step="0.5" min="0.5" name="nbrHeures" defaultValue={p.nbrHeures} className="form-input text-sm" />
                      <input type="text" name="commentaire" defaultValue={p.commentaire || ''} placeholder="Commentaire" className="form-input text-sm" />
                      <div className="col-span-2 flex gap-2 justify-end">
                        <button type="button" disabled={savingPointage} onClick={() => setEditingPointageId(null)} className="btn bg-white border text-xs px-3 py-1.5">Annuler</button>
                        <button type="submit" disabled={savingPointage} className="btn btn-primary text-xs px-3 py-1.5">
                          {savingPointage ? 'Enregistrement...' : 'Enregistrer'}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div key={p.id} className="flex items-center justify-between gap-3 px-6 py-3 text-sm">
                      <div className="min-w-0">
                        <div className="font-semibold text-gray-700 truncate">{p.intervenant?.nom}</div>
                        <div className="text-xs text-gray-400">{fmtDate(p.date)} · {p.intervenant?.role}</div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="font-bold text-gray-800 whitespace-nowrap">{p.nbrHeures} h</div>
                        {userRole !== 'COMMERCIAL' && (
                          <button
                            onClick={() => startEditPointage(p.id)}
                            className="p-1.5 text-gray-400 hover:text-accent hover:bg-blue-50 rounded-lg transition-colors"
                            title="Corriger ce pointage"
                          >
                            <Pencil size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Galerie Photos */}
        <div className="bg-white p-6 sm:p-8 rounded-2xl shadow-md border border-gray-100">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
            <div>
              <h3 className="text-xl font-bold text-primary-dark m-0">Galerie Photos & Suivi</h3>
              <p className="text-sm text-muted mt-1">Photos du terrain compressées automatiquement.</p>
            </div>
            {userRole !== 'COMMERCIAL' && (
              <div className="flex flex-wrap gap-3">
                <label className="flex items-center gap-2 px-4 py-2 bg-primary text-white hover:bg-primary-dark font-semibold rounded-lg cursor-pointer transition-colors text-sm shadow-sm">
                  <Camera size={16} /> Ajouter une photo
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhotoUpload} />
                </label>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
            {chantier.photos?.map((p: any) => (
              <div key={p.id} className="group relative rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow border border-gray-200 bg-gray-50 aspect-square">
                <img src={assetUrl(p.url)} alt="Chantier" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end">
                  <div className="p-4 w-full">
                    <div className="text-white text-xs font-semibold">{new Date(p.createdAt).toLocaleDateString()}</div>
                    <div className="text-white/80 text-xs truncate">{p.legende || 'Photo'}</div>
                  </div>
                </div>
              </div>
            ))}
            {(!chantier.photos || chantier.photos.length === 0) && (
              <div className="col-span-full flex flex-col items-center justify-center py-16 bg-gray-50/50 rounded-xl border border-dashed border-gray-300">
                <div className="text-4xl mb-3 opacity-50">📷</div>
                <div className="text-gray-500 font-medium">Aucune photo pour le moment</div>
                <div className="text-sm text-gray-400 mt-1">Les photos ajoutées apparaîtront ici.</div>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Modale d'édition du chantier — réservée aux admins */}
      {editingChantier && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setEditingChantier(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 sm:p-8" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold text-primary-dark m-0">Modifier le chantier</h3>
              <button type="button" onClick={() => setEditingChantier(false)} className="text-gray-400 hover:text-gray-600">
                <X size={22} />
              </button>
            </div>
            <form onSubmit={handleChantierSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group mb-0">
                <label className="form-label">Nom du Chantier</label>
                <input required name="nom" defaultValue={chantier.nom} className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Client</label>
                <ClientAutocomplete required defaultValue={chantier.client} />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">N° de Devis</label>
                <DevisAutocomplete
                  required
                  defaultValue={chantier.numeroDevis || ''}
                  onMontantFound={(montant) => {
                    if (editChantierBudgetRef.current) editChantierBudgetRef.current.value = String(montant);
                  }}
                />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Responsable Chantier</label>
                <select required name="responsableId" className="form-input" defaultValue={chantier.responsable?.id || ''}>
                  <option value="" disabled>Sélectionner un conducteur...</option>
                  {conducteurs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Commercial rattaché{commerciaux.length > 0 ? '' : ' (aucun disponible)'}</label>
                <select required={commerciaux.length > 0} name="commercialId" className="form-input" defaultValue={chantier.commercial?.id || ''}>
                  <option value="" disabled>Sélectionner un commercial...</option>
                  {commerciaux.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Date Début</label>
                <input required type="date" name="dateDebut" defaultValue={toDateInputValue(chantier.dateDebut)} className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Date Fin</label>
                <input type="date" name="dateFin" defaultValue={toDateInputValue(chantier.dateFin)} className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label font-bold text-primary">Budget Global (€ HT)</label>
                <input ref={editChantierBudgetRef} required type="number" step="0.01" name="budgetGlobalVendu" defaultValue={chantier.budgetGlobalVendu} className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Total Heures Vendues (h)</label>
                <input required type="number" step="0.5" name="heuresVendues" defaultValue={chantier.heuresVendues} className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Dont Matériel (€ HT)</label>
                <input required type="number" step="0.01" name="budgetMaterielVendu" defaultValue={chantier.budgetMaterielVendu} className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Dont Main d'Œuvre (€ HT)</label>
                <input required type="number" step="0.01" name="budgetMainOeuvreVendu" defaultValue={chantier.budgetMainOeuvreVendu} className="form-input" />
              </div>
              <div className="form-group mb-0 md:col-span-2">
                <label className="form-label">Type(s) de chantier</label>
                <div className="flex flex-wrap gap-2">
                  {TYPES_CHANTIER.map((t) => (
                    <label key={t} className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors">
                      <input type="checkbox" name="types" value={t} defaultChecked={chantier.types?.includes(t)} className="w-4 h-4" />
                      {t}
                    </label>
                  ))}
                </div>
              </div>
              <div className="form-group mb-0 md:col-span-2">
                <label className="flex items-center gap-2 text-sm font-medium px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors w-fit">
                  <input type="checkbox" name="dossierNoxia" value="true" defaultChecked={!!chantier.dossierNoxia} className="w-4 h-4" />
                  Dossier NOXIA (barème de commission commerciale réduit)
                </label>
              </div>
              <div className="md:col-span-2 flex gap-2 mt-2">
                <button type="submit" disabled={savingChantier} className="btn btn-primary px-8">
                  {savingChantier ? 'Enregistrement...' : 'Enregistrer les modifications'}
                </button>
                <button type="button" onClick={() => setEditingChantier(false)} className="btn bg-white border">Annuler</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChantierDetail;
