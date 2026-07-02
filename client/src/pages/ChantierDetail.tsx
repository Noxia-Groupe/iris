import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import html2pdf from 'html2pdf.js';
import imageCompression from 'browser-image-compression';
import {
  ArrowLeft, Calendar, User, FileDown, Sparkles, Camera,
  Package, Users, Truck, Wallet, Clock3, Hammer, Briefcase,
} from 'lucide-react';
import { apiFetch, assetUrl } from '../api';
import { ProgressMeter } from '../components/ProgressMeter';
import { BarBreakdown, type BreakdownRow } from '../components/BarBreakdown';

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

  useEffect(() => {
    fetchChantier();
    fetchConfig();
    setAiReport(null);
    setEditingCommercial(false);
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
  const fetchCommerciaux = async () => {
    try {
      const res = await apiFetch('/users');
      const data = await res.json();
      if (Array.isArray(data)) setCommerciaux(data.filter((u: any) => u.role === 'COMMERCIAL'));
    } catch (e) { console.error(e); }
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
  const totalDepensesReelles = metrics.totalDepenses || 0;
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
                    <option value="">Aucun commercial</option>
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

          {/* Marge Commerciale (Admin uniquement, si activée dans les paramètres) */}
          {showMarge && (
            <div className={`mb-8 p-6 rounded-xl border-l-8 flex flex-col gap-4 shadow-sm relative overflow-hidden ${margeAffichee > 0 ? 'bg-emerald-50 border-emerald-500' : 'bg-red-50 border-red-500'}`}>
              <div className="flex flex-col md:flex-row justify-between items-center gap-4">
                <div className="z-10 text-center md:text-left">
                  <div className={`text-xs font-bold uppercase tracking-widest ${margeAffichee > 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                    Marge Commerciale Nette
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
                  {chantier.commissionnement?.mode === 'DYNAMIQUE' && (
                    <div className="text-xs font-semibold text-blue-600 mt-2 flex items-center justify-end gap-1">
                      <Sparkles size={12} /> Mode Dynamique Actif
                    </div>
                  )}
                </div>
              </div>

              {(metrics.commission != null || metrics.margeNette != null) && (
                <div className="z-10 grid grid-cols-2 sm:grid-cols-3 gap-3 pt-4 border-t border-black/5">
                  <div className="bg-white/60 backdrop-blur-sm p-3 rounded-lg">
                    <div className="text-[11px] text-gray-500 font-bold uppercase tracking-wider">Taux commission</div>
                    <div className="font-bold text-lg text-gray-800">{(metrics.tauxCommission ?? 0).toFixed(1)}%</div>
                  </div>
                  <div className="bg-white/60 backdrop-blur-sm p-3 rounded-lg">
                    <div className="text-[11px] text-gray-500 font-bold uppercase tracking-wider">Commission</div>
                    <div className="font-bold text-lg text-gray-800">{(metrics.commission ?? 0).toLocaleString()} €</div>
                  </div>
                  <div className="bg-white/60 backdrop-blur-sm p-3 rounded-lg">
                    <div className="text-[11px] text-gray-500 font-bold uppercase tracking-wider">Marge nette</div>
                    <div className="font-bold text-lg text-gray-800">{(metrics.margeNette ?? 0).toLocaleString()} €</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Progress Bars */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
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

            {/* Main d'oeuvre */}
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
                  <div key={a.id} className="flex items-center justify-between gap-3 px-6 py-3 text-sm">
                    <div className="min-w-0">
                      <div className="font-semibold text-gray-700 truncate">{a.description}</div>
                      <div className="text-xs text-gray-400">{fmtDate(a.date)} · {a.fournisseur?.nom} · {a.categorie?.nom}</div>
                    </div>
                    <div className="font-bold text-gray-800 whitespace-nowrap">{fmtEuro(a.montantHT)}</div>
                  </div>
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
                  <div key={p.id} className="flex items-center justify-between gap-3 px-6 py-3 text-sm">
                    <div className="min-w-0">
                      <div className="font-semibold text-gray-700 truncate">{p.intervenant?.nom}</div>
                      <div className="text-xs text-gray-400">{fmtDate(p.date)} · {p.intervenant?.role}</div>
                    </div>
                    <div className="font-bold text-gray-800 whitespace-nowrap">{p.nbrHeures} h</div>
                  </div>
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
    </div>
  );
};

export default ChantierDetail;
