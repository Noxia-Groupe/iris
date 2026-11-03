import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import html2pdf from 'html2pdf.js';
import { ArrowLeft, FileDown, Pencil } from 'lucide-react';
import { apiFetch } from '../api';
import type { ClientActuel } from '../components/SelecteurClient';
import type { BreakdownRow } from '../components/BarBreakdown';
import { isAdminRole, ROLE_TECHNICIEN } from '../roles';
import { useModules } from '../modules';
import { useCompanyTimezone, useFuseauSocieteConnu } from '../companyTimezoneContext';
import { jourCivilChantierIso, jourCivilEntrepriseIso, joursCivilsEntre } from '../lib/dateFormatting';
import { archivagesRestaurables } from '../lib/archivesRestaurables';
import { RapportClientChantier } from '../components/RapportClientChantier';
import type { EstimationMarge } from '../lib/suiviChantiers';
import { sommeExacte, differenceExacte, arrondiCentime } from '../lib/montants';
import { fmtDate } from '../lib/formatsChantier';
import { ChantierEnTete } from '../components/ChantierEnTete';
import { ChantierIndicateurs, type FactureLiee } from '../components/ChantierIndicateurs';
import { ChantierJournalAchats } from '../components/ChantierJournalAchats';
import { ChantierJournalHeures } from '../components/ChantierJournalHeures';
import { ChantierJournalAudit } from '../components/ChantierJournalAudit';
import { ChantierModaleModification } from '../components/ChantierModaleModification';

const ChantierDetail = () => {
  const companyTimezone = useCompanyTimezone();
  const fuseauConnu = useFuseauSocieteConnu();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const userStr = localStorage.getItem('user');
  const currentUser = userStr ? JSON.parse(userStr) : null;
  const userRole = currentUser?.role || 'CONDUCTEUR_TRAVAUX';
  const permissions = currentUser?.permissions || [];
  // L'API calcule les droits effectifs (rôle + délégations individuelles) à la connexion.
  // L'interface ne recopie donc pas de matrice de rôles pour les actions sensibles.
  const peutCorrigerTravaux = permissions.includes('chantiers:write');
  const peutArchiverTravaux = permissions.includes('chantiers:archive');

  // Libellé du barème de commission réduit, configuré dans Administration : aucun nom
  // de société n'est écrit dans l'interface.
  const { libelleBaremeReduit } = useModules();
  const [chantier, setChantier] = useState<any>(null);
  const [journalSaisies, setJournalSaisies] = useState<any[]>([]);
  const archivesRestaurables = useMemo(() => archivagesRestaurables(journalSaisies), [journalSaisies]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const printRef = useRef<HTMLDivElement>(null);

  const [commerciaux, setCommerciaux] = useState<any[]>([]);
  const [editingCommercial, setEditingCommercial] = useState(false);
  const [savingCommercial, setSavingCommercial] = useState(false);

  // Édition des informations du chantier (nom, budgets, dates...) — ouverte aux admins et
  // au conducteur responsable ; le serveur (PATCH /api/chantiers/:id) refuse déjà la requête
  // à quiconque d'autre.
  const [conducteurs, setConducteurs] = useState<any[]>([]);
  // Client lié, choisi par l'administration dans la fenêtre d'édition (#111).
  const [editClientId, setEditClientId] = useState('');
  const [clientActuel, setClientActuel] = useState<ClientActuel | null>(null);
  const [editingChantier, setEditingChantier] = useState(false);
  const [savingChantier, setSavingChantier] = useState(false);
  // Responsable et commercial de la modale : champs CONTRÔLÉS, contrairement aux autres.
  // Leurs listes arrivent après l'ouverture de la modale ; avec un simple defaultValue, le
  // select afficherait (et enregistrerait) la première option venue au lieu du titulaire
  // en place — une réaffectation silencieuse à l'occasion d'une correction sans rapport.
  const [editResponsableId, setEditResponsableId] = useState('');
  const [editCommercialId, setEditCommercialId] = useState('');
  // Préremplissage du budget global vendu et de l'adresse depuis la référence d'affaire
  // sélectionné (modale d'édition ci-dessous) — champs non contrôlés, on écrit
  // directement dedans.
  const editChantierBudgetRef = useRef<HTMLInputElement>(null);
  const editChantierAdresseRef = useRef<HTMLInputElement>(null);

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

  // Journal complet des achats du chantier : la fiche liste TOUS les achats (et non plus
  // seulement les derniers), avec de quoi retrouver rapidement une dépense précise —
  // recherche libre, filtres fournisseur/catégorie et tri.
  const [achatSearch, setAchatSearch] = useState('');
  const [achatFournisseurFiltre, setAchatFournisseurFiltre] = useState('');
  const [achatCategorieFiltre, setAchatCategorieFiltre] = useState('');
  const [achatTri, setAchatTri] = useState<'date-desc' | 'date-asc' | 'montant-desc' | 'montant-asc'>('date-desc');

  // Journal complet des heures pointées, sur le même principe que celui des achats
  // ci-dessus : la fiche liste tous les pointages du chantier, avec recherche, filtres
  // intervenant/rôle et tri.
  const [pointageSearch, setPointageSearch] = useState('');
  const [pointageIntervenantFiltre, setPointageIntervenantFiltre] = useState('');
  const [pointageRoleFiltre, setPointageRoleFiltre] = useState('');
  const [pointageTri, setPointageTri] = useState<'date-desc' | 'date-asc' | 'heures-desc' | 'heures-asc'>('date-desc');

  useEffect(() => {
    fetchChantier();
    setEditingCommercial(false);
    setEditingChantier(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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

  // Bascule la clause de sécurisation "Encaissé" (réservée aux admins) : un chantier ne
  // compte dans le CA et la marge validés du commercial que s'il est Terminé ET Encaissé.
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

  // Liste des conducteurs, pour le sélecteur de responsable du formulaire d'édition.
  // /conducteurs (comme /commerciaux, et contrairement à /users réservé aux admins) est
  // ouverte à tout compte authentifié : le conducteur responsable édite aussi sa fiche.
  // Les comptes désactivés n'y figurent pas.
  const fetchConducteurs = async () => {
    try {
      const res = await apiFetch('/conducteurs');
      const data = await res.json();
      if (Array.isArray(data)) setConducteurs(data);
    } catch (e) { console.error(e); }
  };

  const startEditChantier = () => {
    if (conducteurs.length === 0) fetchConducteurs();
    if (commerciaux.length === 0) fetchCommerciaux();
    // Le client lié reste proposé même au-delà des 200 premiers ou désactivé : sa fiche donne
    // sa raison sociale et son état. En attendant (ou si elle ne se charge pas), une étiquette
    // neutre : le libellé historique du chantier peut désigner un ancien client.
    if (isAdminRole(userRole)) {
      const lie = chantier?.clientId || '';
      setEditClientId(lie);
      setClientActuel(lie ? { id: lie, raisonSociale: 'Client actuellement lié' } : null);
      if (lie) apiFetch(`/clients/${lie}`).then(res => res.ok ? res.json() : null).then(data => {
        if (data?.id === lie) setClientActuel({ id: data.id, raisonSociale: data.raisonSociale, actif: data.actif });
      }).catch(() => {});
    }
    setEditResponsableId(chantier?.responsable?.id || '');
    setEditCommercialId(chantier?.commercial?.id || '');
    setEditingChantier(true);
  };

  const handleChantierSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    const formData = new FormData(e.target as HTMLFormElement);
    // Le commercial rattaché a sa propre route (/commercial) — pas dans la liste blanche
    // de PATCH /chantiers/:id. Il part AVANT les autres champs, et seulement s'il change :
    // un titulaire qui confie son chantier à un autre conducteur n'en est plus chargé une
    // fois la fiche enregistrée, et le serveur lui refuserait alors le commercial
    // (« Chantier introuvable ») alors que la réattribution est faite.
    const commercialId = String(formData.get('commercialId') || '');
    formData.delete('commercialId');
    // Client : lu dans l'état du sélecteur, pas dans le formulaire, dont il sort quand le
    // sélecteur est désactivé (chargement de la liste, recherche en cours). Une recherche
    // désélectionne le client : on refuse alors l'envoi. Il n'est envoyé que s'il change.
    formData.delete('clientId');
    let clientChange: string | null = null;
    if (isAdminRole(userRole)) {
      if (!editClientId) { alert('Choisissez un client.'); return; }
      if (editClientId !== (chantier?.clientId || '')) clientChange = editClientId;
    }
    const responsableId = String(formData.get('responsableId') || '');
    // Case à cocher unique : absente de FormData quand décochée, on la force donc à
    // explicitement true/false pour que décocher l'enregistre bien (cf. 'types' ci-dessous).
    const data = { ...Object.fromEntries(formData.entries()), types: formData.getAll('types'), baremeReduit: formData.get('baremeReduit') === 'true', ...(clientChange ? { clientId: clientChange } : {}) };
    setSavingChantier(true);
    // Le commercial, enregistré d'abord, le reste si la suite échoue : le message le dit.
    let commercialEnregistre = false;
    try {
      if (commercialId !== (chantier?.commercial?.id || '')) {
        const commRes = await apiFetch(`/chantiers/${id}/commercial`, { method: 'PATCH', body: JSON.stringify({ commercialId: commercialId || null }) });
        const d = await commRes.json().catch(() => ({}));
        if (!commRes.ok) {
          alert(d.error || "Erreur lors de l'affectation du commercial.");
          return;
        }
        // Commercial enregistré : la fiche le reflète aussitôt, même si la suite est refusée.
        // Pas de relecture complète ici : elle démonterait la fenêtre et effacerait la saisie.
        setChantier((c: any) => (c ? { ...c, commercial: d.commercial ?? null } : c));
        commercialEnregistre = true;
      }
      const res = await apiFetch(`/chantiers/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        // La fenêtre reste ouverte avec la saisie, pour corriger le champ refusé.
        const motif = d.error || 'Erreur lors de la modification du chantier.';
        alert(commercialEnregistre ? `Le commercial a été enregistré, mais pas les autres modifications : ${motif}` : motif);
        return;
      }
      setEditingChantier(false);
      // Un conducteur qui vient de confier son chantier à un autre n'y a plus accès : il
      // retrouve sa liste au lieu d'une fiche « introuvable ».
      if (!isAdminRole(userRole) && responsableId !== currentUser?.id) {
        navigate('/chantiers');
        return;
      }
      fetchChantier();
    } catch (e) {
      // Sans réponse, on ne sait pas si le reste de la fiche a été enregistré : on ne l'affirme pas.
      alert(commercialEnregistre ? 'Le commercial a été enregistré ; l’enregistrement des autres modifications n’a pas pu être confirmé : impossible de joindre le serveur.' : 'Impossible de joindre le serveur.');
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

  const handleDeleteAchat = async (achatId: string) => {
    const motifArchivage = window.prompt("Motif de l'archivage de cet achat ?")?.trim();
    if (!motifArchivage) return;
    setSavingAchat(true);
    try {
      const res = await apiFetch(`/achats/${achatId}`, { method: 'DELETE', body: JSON.stringify({ motifArchivage }) });
      if (res.ok) {
        fetchChantier();
      } else {
        const d = await res.json();
        alert(d.error || "Erreur lors de l’archivage de l'achat.");
      }
    } catch (e) {
      alert('Impossible de joindre le serveur.');
    } finally {
      setSavingAchat(false);
    }
  };

  const handleDeletePointage = async (pointageId: string) => {
    const motifArchivage = window.prompt("Motif de l'archivage de ce pointage ?")?.trim();
    if (!motifArchivage) return;
    setSavingPointage(true);
    try {
      const res = await apiFetch(`/heures/${pointageId}`, { method: 'DELETE', body: JSON.stringify({ motifArchivage }) });
      if (res.ok) {
        fetchChantier();
      } else {
        const d = await res.json();
        alert(d.error || 'Erreur lors de l’archivage du pointage.');
      }
    } catch (e) {
      alert('Impossible de joindre le serveur.');
    } finally {
      setSavingPointage(false);
    }
  };

  const handleRestore = async (cible: 'ACHAT' | 'HEURE', cibleId: string) => {
    const motifRestauration = window.prompt(`Motif de la restauration de ${cible === 'ACHAT' ? 'cet achat' : 'ce pointage'} ?`)?.trim();
    if (!motifRestauration) return;
    const setSaving = cible === 'ACHAT' ? setSavingAchat : setSavingPointage;
    setSaving(true);
    try {
      const chemin = cible === 'ACHAT' ? `/achats/${cibleId}/restaurer` : `/heures/${cibleId}/restaurer`;
      const res = await apiFetch(chemin, { method: 'POST', body: JSON.stringify({ motifRestauration }) });
      if (res.ok) fetchChantier();
      else {
        const d = await res.json();
        alert(d.error || 'Erreur lors de la restauration.');
      }
    } catch (e) {
      alert('Impossible de joindre le serveur.');
    } finally {
      setSaving(false);
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
      const journalRes = await apiFetch(`/chantiers/${id}/journal-saisies`);
      if (journalRes.ok) {
        const journal = await journalRes.json();
        setJournalSaisies(Array.isArray(journal) ? journal : []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleExportPDF = () => {
    if (!printRef.current || !chantier) return;
    const opt = {
      margin: 0.5,
      filename: `Rapport-interne_${chantier.nom}.pdf`,
      image: { type: 'jpeg' as const, quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      // Format A4, le format papier attendu en France (lot P0, B-61), et non le format américain.
      jsPDF: { unit: 'in' as const, format: 'a4' as const, orientation: 'portrait' as const },
    };
    html2pdf().set(opt).from(printRef.current).save();
  };

  // Le téléchargement conserve les règles de l'écran Factures : seuls les administrateurs
  // peuvent appeler la route PDF, et la liste ne contient côté API que des documents émis.
  const handleDownloadFacturePdf = async (facture: Pick<FactureLiee, 'id' | 'numero'>) => {
    try {
      const res = await apiFetch(`/factures/${facture.id}/document.pdf`);
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'Document indisponible.');
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${facture.numero}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert('Impossible de joindre le serveur.');
    }
  };

  // Références stables tant que le chantier n'est pas rechargé : les répartitions et le
  // journal des achats ci-dessous sont mémorisés à partir de ces listes.
  const achats: any[] = useMemo(() => chantier?.achats || [], [chantier]);
  const pointages: any[] = useMemo(() => chantier?.pointages || [], [chantier]);

  const parCategorie: BreakdownRow[] = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of achats) {
      const key = a.categorie?.nom || 'Non catégorisé';
      map.set(key, sommeExacte([map.get(key) || 0, a.montantHT]));
    }
    return Array.from(map, ([label, value]) => ({ label, value }));
  }, [achats]);

  const parFournisseur: BreakdownRow[] = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of achats) {
      const key = a.fournisseur?.nom || 'Non renseigné';
      map.set(key, sommeExacte([map.get(key) || 0, a.montantHT]));
    }
    return Array.from(map, ([label, value]) => ({ label, value }));
  }, [achats]);

  // Total dépensé sur le chantier, tous achats confondus.
  const achatsTotal = useMemo(() => sommeExacte(achats.map((a) => a.montantHT)), [achats]);

  // Valeurs proposées dans les filtres : uniquement celles réellement présentes sur ce
  // chantier (inutile de proposer un fournisseur chez qui rien n'a été acheté ici).
  const achatsFournisseursDispo = useMemo(() => (
    Array.from(new Set(achats.map((a) => a.fournisseur?.nom).filter(Boolean) as string[]))
      .sort((a, b) => a.localeCompare(b, 'fr'))
  ), [achats]);

  const achatsCategoriesDispo = useMemo(() => (
    Array.from(new Set(achats.map((a) => a.categorie?.nom).filter(Boolean) as string[]))
      .sort((a, b) => a.localeCompare(b, 'fr'))
  ), [achats]);

  const achatsFiltreActif = achatSearch.trim() !== '' || achatFournisseurFiltre !== '' || achatCategorieFiltre !== '';

  // Liste affichée dans le journal : tous les achats du chantier, filtrés puis triés.
  const achatsAffiches = useMemo(() => {
    const q = achatSearch.trim().toLowerCase();
    const rows = achats.filter((a) => {
      if (achatFournisseurFiltre && (a.fournisseur?.nom || '') !== achatFournisseurFiltre) return false;
      if (achatCategorieFiltre && (a.categorie?.nom || '') !== achatCategorieFiltre) return false;
      if (!q) return true;
      // Recherche libre : description, n° de facture, fournisseur, catégorie, date affichée
      // et montant — de quoi retrouver un achat à partir de n'importe quel indice.
      return [a.description, a.numeroFacture, a.fournisseur?.nom, a.categorie?.nom, fmtDate(a.date), String(a.montantHT)]
        .some((v) => (v || '').toString().toLowerCase().includes(q));
    });
    const byDate = (x: any) => new Date(x.date).getTime();
    return rows.sort((a, b) => {
      if (achatTri === 'date-asc') return byDate(a) - byDate(b);
      if (achatTri === 'montant-desc') return b.montantHT - a.montantHT;
      if (achatTri === 'montant-asc') return a.montantHT - b.montantHT;
      return byDate(b) - byDate(a);
    });
  }, [achats, achatSearch, achatFournisseurFiltre, achatCategorieFiltre, achatTri]);

  const achatsAffichesTotal = useMemo(() => sommeExacte(achatsAffiches.map((a) => a.montantHT)), [achatsAffiches]);

  const resetAchatsFiltres = () => {
    setAchatSearch('');
    setAchatFournisseurFiltre('');
    setAchatCategorieFiltre('');
  };

  // Total des heures pointées sur le chantier.
  const heuresTotal = useMemo(() => sommeExacte(pointages.map((p) => p.nbrHeures)), [pointages]);

  const pointagesIntervenantsDispo = useMemo(() => (
    Array.from(new Set(pointages.map((p) => p.intervenant?.nom).filter(Boolean) as string[]))
      .sort((a, b) => a.localeCompare(b, 'fr'))
  ), [pointages]);

  const pointagesRolesDispo = useMemo(() => (
    Array.from(new Set(pointages.map((p) => p.intervenant?.role).filter(Boolean) as string[]))
      .sort((a, b) => a.localeCompare(b, 'fr'))
  ), [pointages]);

  const pointagesFiltreActif = pointageSearch.trim() !== '' || pointageIntervenantFiltre !== '' || pointageRoleFiltre !== '';

  // Liste affichée dans le journal des heures : tous les pointages, filtrés puis triés.
  const pointagesAffiches = useMemo(() => {
    const q = pointageSearch.trim().toLowerCase();
    const rows = pointages.filter((p) => {
      if (pointageIntervenantFiltre && (p.intervenant?.nom || '') !== pointageIntervenantFiltre) return false;
      if (pointageRoleFiltre && (p.intervenant?.role || '') !== pointageRoleFiltre) return false;
      if (!q) return true;
      // Recherche libre : intervenant, rôle, commentaire, date affichée et nombre d'heures.
      return [p.intervenant?.nom, p.intervenant?.role, p.commentaire, fmtDate(p.date), String(p.nbrHeures)]
        .some((v) => (v || '').toString().toLowerCase().includes(q));
    });
    const byDate = (x: any) => new Date(x.date).getTime();
    return rows.sort((a, b) => {
      if (pointageTri === 'date-asc') return byDate(a) - byDate(b);
      if (pointageTri === 'heures-desc') return b.nbrHeures - a.nbrHeures;
      if (pointageTri === 'heures-asc') return a.nbrHeures - b.nbrHeures;
      return byDate(b) - byDate(a);
    });
  }, [pointages, pointageSearch, pointageIntervenantFiltre, pointageRoleFiltre, pointageTri]);

  const pointagesAffichesTotal = useMemo(() => sommeExacte(pointagesAffiches.map((p) => p.nbrHeures)), [pointagesAffiches]);

  const resetPointagesFiltres = () => {
    setPointageSearch('');
    setPointageIntervenantFiltre('');
    setPointageRoleFiltre('');
  };

  const parIntervenant: BreakdownRow[] = useMemo(() => {
    const map = new Map<string, { heures: number; role: string }>();
    for (const p of pointages) {
      const key = p.intervenant?.nom || 'Non renseigné';
      const cur = map.get(key) || { heures: 0, role: p.intervenant?.role || '' };
      cur.heures = sommeExacte([cur.heures, p.nbrHeures]);
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
  // Les heures des suites sont hors des heures réalisées : leur coût, resté dans le réel, sort
  // aussi du taux (décision de Nelson du 27-10-2026 à 21:41 UTC).
  const heuresDepassement = Math.max(0, differenceExacte(heuresRealisees, chantier.heuresVendues));
  const coutMainOeuvreChantier = differenceExacte(coutMainOeuvreReel, metrics.coutsSuites?.coutMainOeuvre ?? 0);
  const tauxHoraireMoyen = heuresRealisees > 0 ? coutMainOeuvreChantier / heuresRealisees : 0;
  const manqueAGagnerMainOeuvre = heuresDepassement * tauxHoraireMoyen;
  const margeCommerciale: number | null = metrics.margeCommerciale ?? null;
  const showMarge = margeCommerciale !== null;
  // Arrondie au centime : la couleur suit le montant affiché (0,004 € s'affiche 0 €).
  const margeAffichee = arrondiCentime(margeCommerciale ?? 0);
  const showBudgetVendu = chantier.budgetGlobalVendu != null;
  const estimation: EstimationMarge | null = metrics.estimation ?? null;

  // Jours civils de la société (décision de Nelson du 14-10-2026) : le début horodaté d'un
  // chantier converti se lit dans son fuseau, une date-seule telle quelle ; la durée compte
  // des jours civils, jusqu'à la fin ou jusqu'à aujourd'hui pour la société.
  const debutCivil = jourCivilChantierIso(chantier.dateDebut, companyTimezone);
  const finCivile = chantier.dateFin ? jourCivilChantierIso(chantier.dateFin, companyTimezone) : null;
  const isTermine = chantier.statut !== 'EN_COURS';
  const joursEcoules = Math.max(0, joursCivilsEntre(debutCivil, finCivile && isTermine ? finCivile : jourCivilEntrepriseIso(companyTimezone)));

  // La fiche (nom, client, dates, budgets, devis, responsable) et le commercial rattaché sont modifiables par l'admin, ou par
  // le conducteur responsable tant que le chantier est en cours (clôturé : admin seule, décision du 02-11-2026) ; jamais par
  // le commercial, ni par un autre conducteur, et par personne sur une affaire annulée (le serveur refuse ces écritures).
  const canEditChantier = chantier.statut !== 'ANNULE' && (isAdminRole(userRole) || (userRole === 'CONDUCTEUR_TRAVAUX' && chantier.responsable?.id === currentUser?.id && chantier.statut === 'EN_COURS'));
  // Un technicien consulte sans modifier, et ne voit aucun montant (budgets par poste, coûts,
  // taux) : le serveur ne les lui envoie pas, la fiche n'en affiche pas les sections.
  const estTechnicien = userRole === ROLE_TECHNICIEN;
  const montantsVisibles = !estTechnicien;
  // Taux et coût de main-d'œuvre (et dépenses qui l'incluent) : réservés à l'administration, le
  // serveur ne les envoie pas aux autres comptes, qui gardent les heures, les marges et les alertes.
  const coutMainOeuvreVisible = montantsVisibles && metrics.moReel != null;
  const canEditCommercial = canEditChantier;
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

        {estTechnicien && (
          <div role="note" data-consultation-seule className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <strong>Consultation seule.</strong> Un compte technicien n’est pas autorisé à modifier une affaire, à en
            réattribuer le commercial ni à la clôturer. Pour toute modification, adressez-vous à votre responsable (N+1) ;
            la clôture revient à un compte Responsable de votre branche, à la direction ou à l’administration.
          </div>
        )}

        {/* Zone exportable en PDF */}
        <div ref={printRef} className="bg-white p-6 sm:p-8 rounded-2xl shadow-md border border-gray-100 relative">

          {/* Barre d'actions : dans le flux à toute largeur, au-dessus du titre. Le « Rapport interne (PDF) » met la fiche en page sur
              la largeur d'une page A4 (environ 700 px) avec les règles de la largeur de l'écran : un retrait du titre l'y écraserait. */}
          <div className="mb-4 flex flex-wrap justify-end gap-2">
            {canEditChantier && (
              <button
                onClick={startEditChantier}
                className="flex items-center gap-2 bg-white border border-gray-200 text-gray-700 px-4 py-2 rounded-lg font-semibold hover:bg-gray-50 transition-colors shadow-sm text-sm"
              >
                <Pencil size={16} /> Modifier
              </button>
            )}
            <button onClick={handleExportPDF} className="flex items-center gap-2 bg-gray-800 text-white px-4 py-2 rounded-lg font-semibold hover:bg-gray-700 transition-colors shadow-sm text-sm">
              <FileDown size={16} /> Rapport interne (PDF)
            </button>
            <RapportClientChantier chantier={chantier} />
          </div>

          <ChantierEnTete
            chantier={chantier} isTermine={isTermine} libelleBaremeReduit={libelleBaremeReduit} userRole={userRole}
            handleToggleEncaisse={handleToggleEncaisse} savingEncaisse={savingEncaisse}
            companyTimezone={companyTimezone} joursEcoules={joursEcoules} metrics={metrics}
            editingCommercial={editingCommercial} savingCommercial={savingCommercial}
            handleAssignCommercial={handleAssignCommercial} setEditingCommercial={setEditingCommercial}
            commerciaux={commerciaux} canEditCommercial={canEditCommercial} startEditCommercial={startEditCommercial}
          />

          <ChantierIndicateurs
            showBudgetVendu={showBudgetVendu} chantier={chantier} userRole={userRole}
            handleDownloadFacturePdf={handleDownloadFacturePdf} showMarge={showMarge} margeAffichee={margeAffichee}
            metrics={metrics} totalDepensesReelles={totalDepensesReelles} estimation={estimation} isTermine={isTermine}
            montantsVisibles={montantsVisibles} coutMainOeuvreVisible={coutMainOeuvreVisible}
            depenseMaterielReelle={depenseMaterielReelle} coutMainOeuvreReel={coutMainOeuvreReel}
            manqueAGagnerMainOeuvre={manqueAGagnerMainOeuvre} heuresRealisees={heuresRealisees}
            parCategorie={parCategorie} parFournisseur={parFournisseur} parIntervenant={parIntervenant}
          />

        </div>

        {/* Journaux (hors PDF) */}
        <div className="grid grid-cols-1 gap-6">
          {/* Journal complet des achats : toutes les dépenses du chantier, avec recherche,
              filtres et tri pour retrouver une ligne précise et la corriger ou la supprimer.
              C'est un journal de coûts : jamais montré au technicien. */}
          {montantsVisibles && (
          <ChantierJournalAchats
            achats={achats} achatsTotal={achatsTotal} achatSearch={achatSearch} setAchatSearch={setAchatSearch}
            achatFournisseurFiltre={achatFournisseurFiltre} setAchatFournisseurFiltre={setAchatFournisseurFiltre}
            achatsFournisseursDispo={achatsFournisseursDispo} achatCategorieFiltre={achatCategorieFiltre}
            setAchatCategorieFiltre={setAchatCategorieFiltre} achatsCategoriesDispo={achatsCategoriesDispo}
            achatTri={achatTri} setAchatTri={setAchatTri} achatsFiltreActif={achatsFiltreActif}
            resetAchatsFiltres={resetAchatsFiltres} achatsAffiches={achatsAffiches} editingAchatId={editingAchatId}
            handleAchatSubmit={handleAchatSubmit} fournisseurs={fournisseurs} categories={categories}
            savingAchat={savingAchat} setEditingAchatId={setEditingAchatId} peutCorrigerTravaux={peutCorrigerTravaux}
            peutArchiverTravaux={peutArchiverTravaux} startEditAchat={startEditAchat}
            handleDeleteAchat={handleDeleteAchat} achatsAffichesTotal={achatsAffichesTotal}
          />
          )}

          {/* Journal complet des heures : tous les pointages du chantier, avec les mêmes
              outils de recherche que le journal des achats ci-dessus. */}
          <ChantierJournalHeures
            pointages={pointages} heuresTotal={heuresTotal} pointageSearch={pointageSearch}
            setPointageSearch={setPointageSearch} pointageIntervenantFiltre={pointageIntervenantFiltre}
            setPointageIntervenantFiltre={setPointageIntervenantFiltre}
            pointagesIntervenantsDispo={pointagesIntervenantsDispo} pointageRoleFiltre={pointageRoleFiltre}
            setPointageRoleFiltre={setPointageRoleFiltre} pointagesRolesDispo={pointagesRolesDispo}
            pointageTri={pointageTri} setPointageTri={setPointageTri} pointagesFiltreActif={pointagesFiltreActif}
            resetPointagesFiltres={resetPointagesFiltres} pointagesAffiches={pointagesAffiches}
            editingPointageId={editingPointageId} handlePointageSubmit={handlePointageSubmit}
            intervenants={intervenants} savingPointage={savingPointage} setEditingPointageId={setEditingPointageId}
            peutCorrigerTravaux={peutCorrigerTravaux} peutArchiverTravaux={peutArchiverTravaux}
            startEditPointage={startEditPointage} handleDeletePointage={handleDeletePointage}
            pointagesAffichesTotal={pointagesAffichesTotal}
          />
        </div>

        <ChantierJournalAudit
          journalSaisies={journalSaisies} companyTimezone={companyTimezone} peutArchiverTravaux={peutArchiverTravaux}
          archivesRestaurables={archivesRestaurables} handleRestore={handleRestore} savingAchat={savingAchat}
          savingPointage={savingPointage}
        />

      </div>

      {/* Modale d'édition du chantier — admins et conducteur responsable (cf. canEditChantier) */}
      {editingChantier && (
        <ChantierModaleModification
          setEditingChantier={setEditingChantier} handleChantierSubmit={handleChantierSubmit} chantier={chantier}
          userRole={userRole} editClientId={editClientId} setEditClientId={setEditClientId} clientActuel={clientActuel}
          editChantierAdresseRef={editChantierAdresseRef} editResponsableId={editResponsableId}
          setEditResponsableId={setEditResponsableId} conducteurs={conducteurs} commerciaux={commerciaux}
          editCommercialId={editCommercialId} setEditCommercialId={setEditCommercialId}
          companyTimezone={companyTimezone} fuseauConnu={fuseauConnu} editChantierBudgetRef={editChantierBudgetRef}
          libelleBaremeReduit={libelleBaremeReduit} savingChantier={savingChantier}
        />
      )}
    </div>
  );
};

export default ChantierDetail;
