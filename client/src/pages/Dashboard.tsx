import { useState, useEffect, useRef } from 'react';
import html2pdf from 'html2pdf.js';
import imageCompression from 'browser-image-compression';

const API_URL = 'http://localhost:3001/api';

const Dashboard = () => {
  const [chantiers, setChantiers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedChantierId, setSelectedChantierId] = useState<string | null>(null);
  
  // Rôle réel
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const userRole = user?.role || 'CONDUCTEUR_TRAVAUX';
  
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiReport, setAiReport] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchStats();
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const res = await fetch(`${API_URL}/config`);
      const data = await res.json();
      setAiEnabled(data.aiEnabled);
    } catch(e) { console.error(e); }
  };

  const fetchStats = async () => {
    try {
      const res = await fetch(`${API_URL}/chantiers`);
      const data = await res.json();
      setChantiers(data);
      if (data.length > 0 && !selectedChantierId) {
        setSelectedChantierId(data[0].id);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const selectedChantier = chantiers.find(c => c.id === selectedChantierId);

  useEffect(() => {
    setAiReport(null); // Reset report when changing chantier
  }, [selectedChantierId]);

  const handleGenerateAI = async () => {
    if (!selectedChantierId) return;
    setAiLoading(true);
    try {
      const res = await fetch(`${API_URL}/chantiers/${selectedChantierId}/analyze`, { method: 'POST' });
      const data = await res.json();
      if (data.report) setAiReport(data.report);
      else alert(data.error || "Erreur IA");
    } catch(e) {
      alert("Erreur de connexion à l'IA");
    } finally {
      setAiLoading(false);
    }
  };

  const handleExportPDF = () => {
    if (!printRef.current || !selectedChantier) return;
    const opt = {
      margin: 0.5,
      filename: `Rapport_${selectedChantier.nom}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
    };
    html2pdf().set(opt).from(printRef.current).save();
  };

  const handlePhotoUpload = async (e: any) => {
    const file = e.target.files[0];
    if (!file || !selectedChantierId) return;

    try {
      const compressedFile = await imageCompression(file, { maxSizeMB: 0.5, maxWidthOrHeight: 1200 });
      const formData = new FormData();
      formData.append('photo', compressedFile);
      formData.append('legende', 'Photo mobile');

      await fetch(`${API_URL}/chantiers/${selectedChantierId}/photos`, {
        method: 'POST',
        body: formData,
      });
      fetchStats();
    } catch (err) {
      console.error(err);
      alert('Erreur lors de l\'upload');
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-xl text-muted animate-pulse">Chargement des données...</div>
    </div>
  );

  let depenseMaterielReelle = 0;
  let depenseMOReelle = 0;
  let heuresRealisees = 0;
  let margeCommerciale = 0;
  let totalDepensesReelles = 0;

  if (selectedChantier) {
    depenseMaterielReelle = selectedChantier.achats?.reduce((acc: number, a: any) => acc + a.montantHT, 0) || 0;
    selectedChantier.pointages?.forEach((h: any) => {
      heuresRealisees += h.nbrHeures;
      depenseMOReelle += (h.nbrHeures * h.tauxHoraireApplique);
    });

    totalDepensesReelles = depenseMaterielReelle + depenseMOReelle;
    const c = selectedChantier.commissionnement;
    const diffHeures = selectedChantier.heuresVendues - heuresRealisees; 
    
    let bonusMalus = 0;
    if (c?.mode === 'DYNAMIQUE') {
      if (diffHeures > 0) bonusMalus = diffHeures * 30 * (c.bonusHeure / 100); 
      else bonusMalus = diffHeures * 30 * (c.malusHeure / 100); 
    }
    
    margeCommerciale = selectedChantier.budgetGlobalVendu - totalDepensesReelles + bonusMalus;
  }

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      
      {/* Header global */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-primary-dark m-0 leading-tight">Tableau de Bord</h1>
          <p className="text-sm text-muted mt-1">Suivi financier et opérationnel</p>
        </div>
        
        <div className="flex flex-wrap items-center gap-4">
          {/* Sélecteur de chantier intégré au header */}
          <div className="flex items-center gap-2">
            <label className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Chantier</label>
            <select 
              className="form-input py-1.5 px-3 bg-gray-50 border-gray-200 font-bold text-primary-dark cursor-pointer rounded-lg hover:border-primary transition-colors"
              value={selectedChantierId || ''}
              onChange={(e) => setSelectedChantierId(e.target.value)}
            >
              {chantiers.map(c => (
                <option key={c.id} value={c.id}>{c.nom}</option>
              ))}
            </select>
          </div>

          <div className="h-8 w-px bg-gray-200 hidden md:block"></div>

          {/* Rôle actuel (Affichage uniquement) */}
          <div className="flex gap-1 items-center bg-gray-100 px-3 py-1.5 rounded-lg">
            <span className="text-sm font-semibold text-gray-500">
              Connecté en tant que: <strong className="text-primary-dark">{userRole === 'ADMIN' ? 'Admin' : 'Conducteur'}</strong>
            </span>
          </div>
        </div>
      </div>

      {!selectedChantier ? (
        <div className="flex-1 flex flex-col items-center justify-center bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
          <div className="text-6xl mb-4">🏗️</div>
          <h2 className="text-2xl font-bold text-gray-700 mb-2">Aucun chantier sélectionné</h2>
          <p className="text-muted max-w-md">Sélectionnez un chantier dans la liste déroulante en haut à droite ou créez-en un nouveau depuis l'administration.</p>
        </div>
      ) : (
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
                  <svg className={`w-4 h-4 ${aiLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                  {aiLoading ? 'Génération...' : 'Rapport IA'}
                </button>
              )}
              <button onClick={handleExportPDF} className="flex items-center gap-2 bg-gray-800 text-white px-4 py-2 rounded-lg font-semibold hover:bg-gray-700 transition-colors shadow-sm text-sm">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                PDF
              </button>
            </div>

            <div className="mb-8 pr-32">
              <h2 className="text-3xl font-extrabold text-primary-dark mb-2 tracking-tight">{selectedChantier.nom}</h2>
              <div className="flex flex-wrap gap-4 text-sm">
                <span className="flex items-center gap-1 text-gray-600"><strong className="text-gray-800">Client:</strong> {selectedChantier.client}</span>
                <span className="flex items-center gap-1 text-gray-600"><strong className="text-gray-800">Devis:</strong> {selectedChantier.numeroDevis || 'N/A'}</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500"></span><strong className="text-gray-800">Statut:</strong> {selectedChantier.statut}</span>
              </div>
            </div>
            
            {/* Key Metrics */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
              <div className="bg-gray-50 p-5 rounded-xl border border-gray-100 flex flex-col justify-center relative overflow-hidden group">
                <div className="absolute top-0 right-0 w-16 h-16 bg-blue-100 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
                <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 z-10">Budget Vendu</div>
                <div className="text-2xl font-black text-primary-dark z-10">{selectedChantier.budgetGlobalVendu.toLocaleString()} €</div>
              </div>
              
              <div className="bg-gray-50 p-5 rounded-xl border border-gray-100 flex flex-col justify-center relative overflow-hidden group">
                <div className="absolute top-0 right-0 w-16 h-16 bg-green-100 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
                <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 z-10">Matériel Prévu</div>
                <div className="text-2xl font-black text-accent z-10">{selectedChantier.budgetMaterielVendu.toLocaleString()} €</div>
              </div>

              <div className="bg-gray-50 p-5 rounded-xl border border-gray-100 flex flex-col justify-center relative overflow-hidden group">
                <div className="absolute top-0 right-0 w-16 h-16 bg-purple-100 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
                <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 z-10">Heures Prévues</div>
                <div className="text-2xl font-black text-purple-600 z-10">{selectedChantier.heuresVendues} h</div>
              </div>

              <div className="bg-gray-50 p-5 rounded-xl border border-gray-100 flex flex-col justify-center relative overflow-hidden group">
                 <div className="absolute top-0 right-0 w-16 h-16 bg-orange-100 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
                <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 z-10">Coût MO Prévu</div>
                <div className="text-2xl font-black text-orange-600 z-10">{selectedChantier.budgetMainOeuvreVendu.toLocaleString()} €</div>
              </div>
            </div>

            {/* Zone Rapport IA */}
            {aiReport && (
              <div className="mb-8 p-6 bg-indigo-50 border border-indigo-100 rounded-xl shadow-sm">
                <div className="flex items-center gap-2 mb-4">
                  <svg className="w-6 h-6 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                  <h3 className="text-lg font-bold text-indigo-900">Synthèse Intelligente (IA)</h3>
                </div>
                <div className="text-gray-800 text-sm leading-relaxed whitespace-pre-wrap">
                  {aiReport}
                </div>
              </div>
            )}

            {/* Marge Commerciale Banner (Admin Only) */}
            {userRole === 'ADMIN' && (
              <div className={`mb-8 p-6 rounded-xl border-l-8 flex flex-col md:flex-row justify-between items-center shadow-sm relative overflow-hidden ${margeCommerciale > 0 ? 'bg-emerald-50 border-emerald-500' : 'bg-red-50 border-red-500'}`}>
                {/* Decorative background element */}
                <div className="absolute -right-10 -bottom-10 opacity-10">
                  <svg width="150" height="150" viewBox="0 0 24 24" fill="none" stroke={margeCommerciale > 0 ? '#10b981' : '#ef4444'} strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                </div>
                
                <div className="z-10 text-center md:text-left mb-4 md:mb-0">
                  <div className="text-xs font-bold uppercase tracking-widest" style={{ color: margeCommerciale > 0 ? '#065f46' : '#991b1b' }}>
                    Marge Commerciale Nette
                  </div>
                  <div className="text-5xl font-black mt-2 tracking-tight" style={{ color: margeCommerciale > 0 ? '#047857' : '#b91c1c' }}>
                    {margeCommerciale.toLocaleString()} €
                  </div>
                </div>
                
                <div className="z-10 bg-white/60 backdrop-blur-sm p-4 rounded-lg text-right">
                  <div className="text-xs text-gray-500 font-bold uppercase tracking-wider mb-1">Dépenses Réelles Cumulées</div>
                  <div className="font-bold text-2xl text-gray-800">{totalDepensesReelles.toLocaleString()} €</div>
                  {selectedChantier.commissionnement?.mode === 'DYNAMIQUE' && (
                    <div className="text-xs font-semibold text-blue-600 mt-2 flex items-center justify-end gap-1">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                      Mode Dynamique Actif
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Progress Bars */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* Matériel */}
              <div>
                <div className="flex justify-between items-end mb-2">
                  <div>
                    <h3 className="font-bold text-gray-800 flex items-center gap-2">
                      <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"></path></svg>
                      Consommation Matériel
                    </h3>
                  </div>
                  <div className="text-right">
                    <span className="text-xl font-black text-accent">{depenseMaterielReelle.toLocaleString()} €</span>
                    <span className="text-sm font-semibold text-gray-400 ml-1">/ {selectedChantier.budgetMaterielVendu.toLocaleString()} €</span>
                  </div>
                </div>
                
                <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden shadow-inner">
                  <div className="h-full rounded-full transition-all duration-1000 ease-out relative" style={{ 
                    width: `${Math.min(100, (depenseMaterielReelle / Math.max(1, selectedChantier.budgetMaterielVendu)) * 100)}%`, 
                    backgroundColor: depenseMaterielReelle > selectedChantier.budgetMaterielVendu ? '#ef4444' : '#0251a1'
                  }}>
                    <div className="absolute inset-0 bg-white/20 w-full" style={{backgroundImage: 'linear-gradient(45deg,rgba(255,255,255,.15) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.15) 50%,rgba(255,255,255,.15) 75%,transparent 75%,transparent)', backgroundSize: '1rem 1rem'}}></div>
                  </div>
                </div>
                <div className="mt-2 text-right text-xs font-bold text-gray-500">
                  {((depenseMaterielReelle / Math.max(1, selectedChantier.budgetMaterielVendu)) * 100).toFixed(1)}%
                </div>
              </div>

              {/* Main d'oeuvre */}
              <div>
                <div className="flex justify-between items-end mb-2">
                  <div>
                    <h3 className="font-bold text-gray-800 flex items-center gap-2">
                      <svg className="w-5 h-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                      Consommation Heures
                    </h3>
                  </div>
                  <div className="text-right">
                    <span className="text-xl font-black text-purple-600">{heuresRealisees} h</span>
                    <span className="text-sm font-semibold text-gray-400 ml-1">/ {selectedChantier.heuresVendues} h</span>
                  </div>
                </div>
                
                <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden shadow-inner">
                  <div className="h-full rounded-full transition-all duration-1000 ease-out relative" style={{ 
                    width: `${Math.min(100, (heuresRealisees / Math.max(1, selectedChantier.heuresVendues)) * 100)}%`, 
                    backgroundColor: heuresRealisees > selectedChantier.heuresVendues ? '#ef4444' : '#8b5cf6'
                  }}>
                    <div className="absolute inset-0 bg-white/20 w-full" style={{backgroundImage: 'linear-gradient(45deg,rgba(255,255,255,.15) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.15) 50%,rgba(255,255,255,.15) 75%,transparent 75%,transparent)', backgroundSize: '1rem 1rem'}}></div>
                  </div>
                </div>
                <div className="mt-2 text-right text-xs font-bold text-gray-500">
                  {((heuresRealisees / Math.max(1, selectedChantier.heuresVendues)) * 100).toFixed(1)}%
                </div>
              </div>
            </div>

          </div>

          {/* Galerie Photos (Hors du PDF) */}
          <div className="bg-white p-6 sm:p-8 rounded-2xl shadow-md border border-gray-100 mt-2">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
              <div>
                <h3 className="text-xl font-bold text-primary-dark">Galerie Photos & Suivi</h3>
                <p className="text-sm text-muted">Photos du terrain compressées automatiquement.</p>
              </div>
              
              <div className="flex flex-wrap gap-3">
                <label className="flex items-center gap-2 px-4 py-2 bg-primary text-white hover:bg-primary-dark font-semibold rounded-lg cursor-pointer transition-colors text-sm shadow-sm">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                  Ajouter une photo
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhotoUpload} />
                </label>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
              {selectedChantier.photos?.map((p: any) => (
                <div key={p.id} className="group relative rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow border border-gray-200 bg-gray-50 aspect-square">
                  <img src={`http://localhost:3001${p.url}`} alt="Chantier" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end">
                    <div className="p-4 w-full">
                      <div className="text-white text-xs font-semibold">{new Date(p.createdAt).toLocaleDateString()}</div>
                      <div className="text-white/80 text-xs truncate">{p.legende || 'Photo'}</div>
                    </div>
                  </div>
                </div>
              ))}
              {(!selectedChantier.photos || selectedChantier.photos.length === 0) && (
                <div className="col-span-full flex flex-col items-center justify-center py-16 bg-gray-50/50 rounded-xl border border-dashed border-gray-300">
                  <div className="text-4xl mb-3 opacity-50">📷</div>
                  <div className="text-gray-500 font-medium">Aucune photo pour le moment</div>
                  <div className="text-sm text-gray-400 mt-1">Les photos ajoutées apparaîtront ici.</div>
                </div>
              )}
            </div>
          </div>
          
        </div>
      )}
    </div>
  );
};

export default Dashboard;
