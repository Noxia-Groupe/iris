import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Archive, RotateCcw, Filter, Trash2 } from 'lucide-react';
import { apiFetch } from '../api';
import { SectionRepliable } from '../components/SectionRepliable';
import { TYPES_CHANTIER } from '../chantierTypes';
import { ClientAutocomplete } from '../components/ClientAutocomplete';
import { DevisAutocomplete } from '../components/DevisAutocomplete';
import { isAdminRole, roleLabel } from '../roles';

const ListeChantiers = () => {
  const navigate = useNavigate();
  const [chantiers, setChantiers] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [commerciaux, setCommerciaux] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [filterMaterielDepasse, setFilterMaterielDepasse] = useState(false);
  const [filterHeuresDepasse, setFilterHeuresDepasse] = useState(false);
  // Préremplissage du budget global vendu, du "Dont Matériel" et de l'adresse depuis un
  // devis Odoo sélectionné (formulaire de création ci-dessous) — champs non contrôlés, on
  // écrit directement dedans.
  const nouveauChantierBudgetRef = useRef<HTMLInputElement>(null);
  const nouveauChantierMaterielRef = useRef<HTMLInputElement>(null);
  const nouveauChantierAdresseRef = useRef<HTMLInputElement>(null);
  // Client Odoo sélectionné dans le formulaire de création : sert à ne proposer, dans le
  // champ "N° de Devis", que les devis de ce client. Remis à null dès que le champ Client
  // redevient une saisie libre (cf. ClientAutocomplete.onSelect).
  const [nouveauChantierClientId, setNouveauChantierClientId] = useState<number | null>(null);

  // Rôle réel
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const userRole = user?.role || 'CONDUCTEUR_TRAVAUX';

  useEffect(() => {
    fetchChantiers();
    // La liste des conducteurs (pour l'affectation) n'est accessible qu'aux admins.
    if (isAdminRole(userRole)) fetchUsers();
    // Le commercial rattaché est à choisir dès la création, par l'admin comme le conducteur.
    if (userRole !== 'COMMERCIAL') fetchCommerciaux();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchChantiers = async () => {
    try {
      const res = await apiFetch('/chantiers');
      const data = await res.json();
      if(Array.isArray(data)) setChantiers(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // /conducteurs ne renvoie que les comptes actifs : un compte désactivé (départ de
  // l'entreprise) ne peut plus se voir attribuer un chantier.
  const fetchUsers = async () => {
    try {
      const res = await apiFetch('/conducteurs');
      const data = await res.json();
      if (Array.isArray(data)) setUsers(data);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchCommerciaux = async () => {
    try {
      const res = await apiFetch('/commerciaux');
      const data = await res.json();
      if (Array.isArray(data)) setCommerciaux(data);
    } catch (e) {
      console.error(e);
    }
  };

  const handleZipExport = async (id: string, nom: string) => {
    try {
      const res = await apiFetch(`/chantiers/${id}/photos/export`);
      if (!res.ok) { alert("Export impossible"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `photos-${nom.replace(/\s+/g, '_')}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      alert("Export impossible");
    }
  };

  const handlePurge = async (id: string) => {
    if(!confirm("Purger TOUTES les photos de ce chantier ?")) return;
    try {
      await apiFetch(`/chantiers/${id}/photos/purge`, { method: 'DELETE' });
      fetchChantiers();
    } catch(e) {
      console.error(e);
    }
  };

  // Clôturer un chantier (en cours -> terminé) : possible pour son responsable ou un
  // admin. Une fois clôturé, plus aucune heure ni dépense ne peut y être ajoutée.
  const handleCloturer = async (id: string, nom: string) => {
    if (!confirm(`Clôturer « ${nom} » ? Il passera en Terminé/Archivé et il ne sera plus possible d'y ajouter des heures ou des dépenses.`)) return;
    try {
      const res = await apiFetch(`/chantiers/${id}/statut`, { method: 'PATCH', body: JSON.stringify({ statut: 'TERMINE' }) });
      if (res.ok) fetchChantiers();
      else { const d = await res.json(); alert(d.error || 'Erreur lors de la clôture du chantier.'); }
    } catch (e) {
      alert('Impossible de joindre le serveur.');
    }
  };

  // Réouvrir un chantier clôturé (terminé -> en cours) : réservé aux admins.
  const handleReouvrir = async (id: string, nom: string) => {
    if (!confirm(`Réouvrir « ${nom} » ? Il repassera en cours.`)) return;
    try {
      const res = await apiFetch(`/chantiers/${id}/statut`, { method: 'PATCH', body: JSON.stringify({ statut: 'EN_COURS' }) });
      if (res.ok) fetchChantiers();
      else { const d = await res.json(); alert(d.error || 'Erreur lors de la réouverture du chantier.'); }
    } catch (e) {
      alert('Impossible de joindre le serveur.');
    }
  };

  // Supprime définitivement un chantier — réservé aux admins. Le serveur refuse d'abord
  // (409) si des données y sont rattachées et renvoie leur décompte : on l'affiche pour
  // faire confirmer en connaissance de cause, puis on rappelle avec force=1. Un chantier
  // vierge, lui, part en une seule confirmation.
  const handleSupprimer = async (id: string, nom: string) => {
    if (!confirm(`Supprimer définitivement « ${nom} » ?\n\nCette action est irréversible.`)) return;
    try {
      const res = await apiFetch(`/chantiers/${id}`, { method: 'DELETE' });
      if (res.ok) { fetchChantiers(); return; }

      const data = await res.json().catch(() => ({}));
      if (res.status !== 409 || !data.dependances) {
        alert(data.error || 'Erreur lors de la suppression du chantier.');
        return;
      }

      const d = data.dependances;
      const detail = [
        d.achats && `${d.achats} achat${d.achats > 1 ? 's' : ''}`,
        d.pointages && `${d.pointages} pointage${d.pointages > 1 ? 's' : ''} d'heures`,
        d.photos && `${d.photos} photo${d.photos > 1 ? 's' : ''}`,
        d.lignesBudget && `${d.lignesBudget} ligne${d.lignesBudget > 1 ? 's' : ''} de budget`,
      ].filter(Boolean).join('\n· ');
      const planning = d.affectations
        ? `\n\n${d.affectations} affectation${d.affectations > 1 ? 's' : ''} du planning ${d.affectations > 1 ? 'seront détachées' : 'sera détachée'} du chantier, sans être supprimée${d.affectations > 1 ? 's' : ''}.`
        : '';

      if (!confirm(`« ${nom} » porte encore :\n· ${detail}${planning}\n\nTout sera définitivement supprimé. Confirmer ?`)) return;

      const forced = await apiFetch(`/chantiers/${id}?force=1`, { method: 'DELETE' });
      if (forced.ok) fetchChantiers();
      else { const f = await forced.json().catch(() => ({})); alert(f.error || 'Erreur lors de la suppression du chantier.'); }
    } catch (e) {
      alert('Impossible de joindre le serveur.');
    }
  };

  // Création d'un chantier (admin et conducteur). Un conducteur en devient le responsable.
  const handleCreateChantier = async (e: React.FormEvent) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const formData = new FormData(form);
    // Plusieurs cases "types" partagent le même name : entries() n'en garderait qu'une.
    const types = formData.getAll('types');
    // Un groupe de cases à cocher ne peut pas porter l'attribut HTML `required` pour
    // exiger "au moins une" (il exigerait alors qu'elles soient toutes cochées) : la
    // vérification se fait donc ici, en JS.
    if (types.length === 0) {
      alert('Veuillez sélectionner au moins un type de chantier.');
      return;
    }
    const data = { ...Object.fromEntries(formData.entries()), types };
    try {
      const res = await apiFetch('/chantiers', { method: 'POST', body: JSON.stringify(data) });
      if (res.ok) {
        form.reset();
        setNouveauChantierClientId(null);
        setShowForm(false);
        fetchChantiers();
      } else {
        const d = await res.json();
        alert(d.error || 'Erreur lors de la création du chantier.');
      }
    } catch (err) {
      alert('Impossible de joindre le serveur.');
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-xl text-muted animate-pulse">Chargement des chantiers...</div>
    </div>
  );

  // `repliable` : la liste des chantiers archivés est masquée tant qu'on ne l'ouvre pas,
  // pour ne pas noyer les chantiers en cours sous des dossiers clos.
  const renderTable = (list: any[], title: string, emptyMessage: string, repliable = false) => {
    const tableau = (
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-white text-xs uppercase text-gray-500 border-b border-gray-100">
              <th className="px-6 py-4 font-semibold">Chantier</th>
              <th className="px-6 py-4 font-semibold">Client</th>
              <th className="px-6 py-4 font-semibold text-center">Avancement</th>
              <th className="px-6 py-4 font-semibold text-right">
                {isAdminRole(userRole) ? 'Marge Actuelle' : 'Solde Heures'}
              </th>
              <th className="px-6 py-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {list.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-gray-400 italic">
                  {emptyMessage}
                </td>
              </tr>
            ) : list.map(c => {
              // Métriques calculées côté serveur (marge masquée pour les non-admins)
              const metrics = c.metrics || {};
              const heuresRealisees = metrics.heuresRealisees || 0;
              const diffHeures = metrics.diffHeures ?? (c.heuresVendues - heuresRealisees);
              const margeCommerciale: number | null = metrics.margeCommerciale ?? null;
              const progressPct = Math.min(100, Math.max(0, metrics.pctHeures ?? 0));

              return (
                <tr
                  key={c.id}
                  onClick={() => navigate(`/chantiers/${c.id}`)}
                  className="hover:bg-gray-50 transition-colors cursor-pointer"
                >
                  <td className="px-6 py-4">
                    <div className="font-bold text-gray-800">{c.nom}</div>
                    <div className="text-xs text-gray-400">Devis: {c.numeroDevis || 'N/A'}</div>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">{c.client}</td>
                  <td className="px-6 py-4">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-24 h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${progressPct}%` }}></div>
                      </div>
                      <span className="text-xs font-semibold text-gray-500 w-8">{progressPct.toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    {isAdminRole(userRole) ? (
                      margeCommerciale !== null ? (
                        <span className={`inline-block px-3 py-1 rounded-md font-bold text-sm ${margeCommerciale >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                          {margeCommerciale > 0 ? '+' : ''}{margeCommerciale.toLocaleString()} €
                        </span>
                      ) : (
                        <span className="text-gray-400 text-sm">—</span>
                      )
                    ) : (
                      <span className={`inline-block px-3 py-1 rounded-md font-bold text-sm ${diffHeures >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                        {diffHeures > 0 ? '+' : ''}{diffHeures.toFixed(2)} h
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end items-center gap-2">
                      {c.statut === 'EN_COURS' && userRole !== 'COMMERCIAL' && (
                        <button
                          onClick={() => handleCloturer(c.id, c.nom)}
                          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg transition-colors"
                          title="Clôturer le chantier"
                        >
                          <Archive size={14} /> Clôturer
                        </button>
                      )}
                      {c.statut === 'TERMINE' && isAdminRole(userRole) && (
                        <button
                          onClick={() => handleReouvrir(c.id, c.nom)}
                          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 bg-blue-50 text-accent hover:bg-blue-100 rounded-lg transition-colors"
                          title="Réouvrir le chantier"
                        >
                          <RotateCcw size={14} /> Réouvrir
                        </button>
                      )}
                      {isAdminRole(userRole) && (
                        <>
                          <button
                            onClick={() => handleZipExport(c.id, c.nom)}
                            className="p-2 text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
                            title="Télécharger Photos (ZIP)"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                          </button>
                          <button
                            onClick={() => handlePurge(c.id)}
                            className="p-2 text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors"
                            title="Purger Photos"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                          </button>
                          {/* Suppression définitive du chantier — distincte de la purge des
                              photos ci-dessus, d'où le libellé explicite plutôt qu'une
                              seconde corbeille muette. */}
                          <button
                            onClick={() => handleSupprimer(c.id, c.nom)}
                            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 bg-red-600 text-white hover:bg-red-700 rounded-lg transition-colors"
                            title="Supprimer définitivement le chantier"
                          >
                            <Trash2 size={14} /> Supprimer
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );

    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-8">
        {repliable ? (
          <SectionRepliable
            headerClassName="bg-gray-50 px-6 py-4"
            titre={<h2 className="text-lg font-bold text-primary-dark m-0">{title}</h2>}
            resume={
              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider shrink-0">
                {list.length} chantier{list.length > 1 ? 's' : ''}
              </span>
            }
          >
            {tableau}
          </SectionRepliable>
        ) : (
          <>
            <div className="bg-gray-50 border-b border-gray-100 px-6 py-4">
              <h2 className="text-lg font-bold text-primary-dark">{title}</h2>
            </div>
            {tableau}
          </>
        )}
      </div>
    );
  };

  // Filtres de dépassement — appliqués aux deux tableaux (en cours et terminés/archivés).
  const matchesFilters = (c: any) => {
    const metrics = c.metrics || {};
    if (filterMaterielDepasse && !((metrics.materielReel || 0) > (c.budgetMaterielVendu || 0))) return false;
    if (filterHeuresDepasse && !((metrics.heuresRealisees || 0) > (c.heuresVendues || 0))) return false;
    return true;
  };

  const chantiersEnCours = chantiers.filter(c => c.statut === 'EN_COURS').filter(matchesFilters);
  const chantiersTermines = chantiers.filter(c => c.statut === 'TERMINE').filter(matchesFilters);
  const filtresActifs = filterMaterielDepasse || filterHeuresDepasse;

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      
      {/* Header global */}
      <div className="flex justify-between items-center mb-6 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-primary-dark m-0 leading-tight">Liste des Chantiers</h1>
          <p className="text-sm text-muted mt-1">Vue globale et gestion du stockage</p>
        </div>
        
        <div className="flex items-center gap-3">
          {userRole !== 'COMMERCIAL' && (
            <button onClick={() => setShowForm(s => !s)} className="btn btn-primary flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4"></path></svg>
              Nouveau chantier
            </button>
          )}
          {/* Rôle actuel (Affichage uniquement) */}
          <div className="flex gap-1 items-center bg-gray-100 px-3 py-1.5 rounded-lg">
            <span className="text-sm font-semibold text-gray-500">
              Connecté en tant que: <strong className="text-primary-dark">{roleLabel(userRole)}</strong>
            </span>
          </div>
        </div>
      </div>

      {showForm && userRole !== 'COMMERCIAL' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <h2 className="text-lg font-bold text-primary-dark mb-4">Nouveau chantier</h2>
          <form onSubmit={handleCreateChantier} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="form-group mb-0">
              <label className="form-label">Nom du Chantier</label>
              <input required name="nom" className="form-input" />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">Client</label>
              <ClientAutocomplete required onSelect={(c) => setNouveauChantierClientId(c ? c.id : null)} />
            </div>
            {isAdminRole(userRole) ? (
              <div className="form-group mb-0">
                <label className="form-label">Conducteur responsable</label>
                <select required name="responsableId" className="form-input" defaultValue="">
                  <option value="" disabled>Sélectionner un conducteur...</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            ) : (
              <div className="form-group mb-0">
                <label className="form-label">Conducteur responsable</label>
                <div className="form-input bg-gray-50 text-gray-500">Vous-même (attribution automatique)</div>
              </div>
            )}
            <div className="form-group mb-0">
              <label className="form-label">Commercial rattaché{commerciaux.length > 0 ? '' : ' (aucun disponible)'}</label>
              <select required={commerciaux.length > 0} name="commercialId" className="form-input" defaultValue="">
                <option value="" disabled>Sélectionner un commercial...</option>
                {commerciaux.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="form-group mb-0">
              <label className="form-label">N° de Devis</label>
              <DevisAutocomplete
                required
                partnerId={nouveauChantierClientId}
                onMontantFound={(montant) => {
                  if (nouveauChantierBudgetRef.current) nouveauChantierBudgetRef.current.value = String(montant);
                }}
                onMaterielFound={(montant) => {
                  if (nouveauChantierMaterielRef.current) nouveauChantierMaterielRef.current.value = String(montant);
                }}
                onAdresseFound={(adresse) => {
                  if (nouveauChantierAdresseRef.current) nouveauChantierAdresseRef.current.value = adresse;
                }}
              />
            </div>
            <div className="form-group mb-0 md:col-span-2">
              <label className="form-label">Adresse du site (optionnel)</label>
              <input ref={nouveauChantierAdresseRef} name="adresse" className="form-input" placeholder="Préremplie depuis le devis sélectionné, ou à saisir librement..." />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">Date Début</label>
              <input required type="date" name="dateDebut" className="form-input" />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">Budget Global (€ HT)</label>
              <input ref={nouveauChantierBudgetRef} required type="number" step="0.01" name="budgetGlobalVendu" className="form-input" />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">Total Heures Vendues (h)</label>
              <input required type="number" step="0.5" name="heuresVendues" className="form-input" />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">Dont Matériel (€ HT)</label>
              <input ref={nouveauChantierMaterielRef} required type="number" step="0.01" name="budgetMaterielVendu" className="form-input" />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">Dont Main d'Œuvre (€ HT)</label>
              <input required type="number" step="0.01" name="budgetMainOeuvreVendu" className="form-input" />
            </div>
            <div className="form-group mb-0 md:col-span-2">
              <label className="form-label">Type(s) de chantier (au moins un requis)</label>
              <div className="flex flex-wrap gap-2">
                {TYPES_CHANTIER.map((t) => (
                  <label key={t} className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors">
                    <input type="checkbox" name="types" value={t} className="w-4 h-4" />
                    {t}
                  </label>
                ))}
              </div>
            </div>
            <div className="form-group mb-0 md:col-span-2">
              <label className="flex items-center gap-2 text-sm font-medium px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors w-fit">
                <input type="checkbox" name="dossierNoxia" value="true" className="w-4 h-4" />
                Dossier NOXIA (barème de commission commerciale réduit)
              </label>
            </div>
            <div className="md:col-span-2 flex gap-2 mt-2">
              <button className="btn btn-primary px-8">Créer le chantier</button>
              <button type="button" onClick={() => setShowForm(false)} className="btn bg-white border">Annuler</button>
            </div>
          </form>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-6 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <span className="text-sm font-semibold text-gray-500 flex items-center gap-2"><Filter size={16} /> Filtrer :</span>
        <label className={`flex items-center gap-2 text-sm font-semibold px-3 py-1.5 rounded-lg cursor-pointer border transition-colors ${filterMaterielDepasse ? 'bg-red-50 border-red-200 text-red-700' : 'bg-gray-50 border-transparent text-gray-600 hover:bg-gray-100'}`}>
          <input type="checkbox" checked={filterMaterielDepasse} onChange={(e) => setFilterMaterielDepasse(e.target.checked)} className="w-4 h-4" />
          Budget matériel dépassé
        </label>
        <label className={`flex items-center gap-2 text-sm font-semibold px-3 py-1.5 rounded-lg cursor-pointer border transition-colors ${filterHeuresDepasse ? 'bg-red-50 border-red-200 text-red-700' : 'bg-gray-50 border-transparent text-gray-600 hover:bg-gray-100'}`}>
          <input type="checkbox" checked={filterHeuresDepasse} onChange={(e) => setFilterHeuresDepasse(e.target.checked)} className="w-4 h-4" />
          Heures prévues dépassées
        </label>
        {filtresActifs && (
          <button onClick={() => { setFilterMaterielDepasse(false); setFilterHeuresDepasse(false); }} className="text-xs font-semibold text-accent hover:underline ml-auto">
            Réinitialiser
          </button>
        )}
      </div>

      <div className="flex-1">
        {renderTable(chantiersEnCours, "Chantiers En Cours", filtresActifs ? "Aucun chantier en cours ne correspond aux filtres." : "Aucun chantier en cours.")}
        {renderTable(chantiersTermines, "Chantiers Terminés / Archivés", filtresActifs ? "Aucun chantier archivé ne correspond aux filtres." : "Aucun chantier archivé.", true)}
      </div>

    </div>
  );
};

export default ListeChantiers;
