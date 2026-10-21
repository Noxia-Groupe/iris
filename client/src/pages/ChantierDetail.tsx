import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import html2pdf from 'html2pdf.js';
import {
  ArrowLeft, Calendar, User, FileDown,
  Package, Users, Truck, Wallet, Clock3, Hammer, Briefcase, Pencil, Trash2, RotateCcw, X, MapPin, Search,
} from 'lucide-react';
import { apiFetch } from '../api';
import { SelecteurClient, type ClientActuel } from '../components/SelecteurClient';
import { ProgressMeter } from '../components/ProgressMeter';
import { BarBreakdown, type BreakdownRow } from '../components/BarBreakdown';
import { TYPES_CHANTIER } from '../chantierTypes';
import { isAdminRole, ROLE_TECHNICIEN } from '../roles';
import { useModules } from '../modules';
import { useCompanyTimezone, useFuseauSocieteConnu } from '../companyTimezoneContext';
import { formatCompanyDate, formatDateOnly, jourCivilChantier, jourCivilChantierIso, jourCivilEntrepriseIso, joursCivilsEntre, instantaneLisible } from '../lib/dateFormatting';
import { archivagesRestaurables } from '../lib/archivesRestaurables';
import { changementAffaire, titreEntreeJournal } from '../lib/journalChantier';
import { AlertesChantier } from '../components/AlertesChantier';
import { ancienneteSaisie, hypotheseCoutHoraire, hypotheseMateriel, type EstimationMarge } from '../lib/suiviChantiers';
import { sommeExacte, differenceExacte, arrondiEuro, arrondiCentime } from '../lib/montants';

// Date ISO (avec ou sans heure) -> format métier français JJ-MM-AAAA.
const toDateFrancaise = (d: string | null | undefined) => {
  if (!d) return '';
  const [annee, mois, jour] = d.slice(0, 10).split('-');
  return `${jour}-${mois}-${annee}`;
};

const fmtDate = (d: string) => formatDateOnly(d);
const fmtEuro = (n: number) => `${arrondiEuro(n).toLocaleString('fr-FR')} €`;
// Heures pointées : demi-heures possibles, mais pas de décimale inutile (8 h, 7,5 h).
const fmtHeures = (n: number) => `${n.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} h`;

type FactureLiee = {
  id: string;
  numero: string;
  type: 'FACTURE' | 'AVOIR';
  statut: string;
  dateEmission: string;
  totalHt: number;
  totalTtc: number;
};

const STATUT_LABELS: Record<string, string> = {
  EN_COURS: 'En cours',
  TERMINE: 'Terminé',
};

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
      filename: `Rapport_${chantier.nom}.pdf`,
      image: { type: 'jpeg' as const, quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'in' as const, format: 'letter' as const, orientation: 'portrait' as const },
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
  const heuresDepassement = Math.max(0, differenceExacte(heuresRealisees, chantier.heuresVendues));
  const tauxHoraireMoyen = heuresRealisees > 0 ? coutMainOeuvreReel / heuresRealisees : 0;
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

  // La fiche (nom, client, dates, budgets, devis, responsable) et le commercial rattaché
  // sont modifiables par l'admin ou par le conducteur responsable du chantier, qui corrige
  // ainsi lui-même ses saisies — jamais par le commercial, ni par un autre conducteur.
  const canEditChantier = isAdminRole(userRole) || (userRole === 'CONDUCTEUR_TRAVAUX' && chantier.responsable?.id === currentUser?.id);
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

          {/* Barre d'actions : dans le flux sur téléphone, au-dessus du titre ; en haut à droite au-delà,
              où le titre lui laisse sa place (sm:pr-56, ou sm:pr-28 pour le seul bouton PDF). */}
          <div className="mb-4 flex flex-wrap justify-end gap-2 sm:absolute sm:top-6 sm:right-6 sm:mb-0">
            {canEditChantier && (
              <button
                onClick={startEditChantier}
                className="flex items-center gap-2 bg-white border border-gray-200 text-gray-700 px-4 py-2 rounded-lg font-semibold hover:bg-gray-50 transition-colors shadow-sm text-sm"
              >
                <Pencil size={16} /> Modifier
              </button>
            )}
            <button onClick={handleExportPDF} className="flex items-center gap-2 bg-gray-800 text-white px-4 py-2 rounded-lg font-semibold hover:bg-gray-700 transition-colors shadow-sm text-sm">
              <FileDown size={16} /> PDF
            </button>
          </div>

          <div className={`mb-8 ${canEditChantier ? 'sm:pr-56' : 'sm:pr-28'}`}>
            <div className="flex items-center gap-3 flex-wrap mb-2">
              <h2 className="text-3xl font-extrabold text-primary-dark tracking-tight m-0">{chantier.nom}</h2>
              <span className={`text-xs font-bold uppercase tracking-wide px-2.5 py-1 rounded-full ${isTermine ? 'bg-gray-100 text-gray-500' : 'bg-blue-100 text-accent'}`}>
                {STATUT_LABELS[chantier.statut] || chantier.statut}
              </span>
              {chantier.types?.map((t: string) => (
                <span key={t} className="text-[11px] font-semibold px-2.5 py-1 bg-indigo-50 text-indigo-700 rounded-full">{t}</span>
              ))}
              {chantier.baremeReduit && (
                <span className="text-[11px] font-semibold px-2.5 py-1 bg-amber-50 text-amber-700 rounded-full">{libelleBaremeReduit}</span>
              )}
              {isTermine && (isAdminRole(userRole) ? (
                <button
                  type="button"
                  onClick={handleToggleEncaisse}
                  disabled={savingEncaisse}
                  title="Réservé aux admins : conditionne le résultat commercial du mois de clôture"
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
              {chantier.adresse && (
                <span className="flex items-center gap-1.5"><MapPin size={14} className="text-gray-400" /> {chantier.adresse}</span>
              )}
              {chantier.responsable?.name && (
                <span className="flex items-center gap-1.5"><User size={14} className="text-gray-400" /> {chantier.responsable.name}</span>
              )}
              <span className="flex items-center gap-1.5">
                <Calendar size={14} className="text-gray-400" />
                Démarré le {jourCivilChantier(chantier.dateDebut, companyTimezone)}
                {isTermine && chantier.dateFin ? ` — terminé le ${jourCivilChantier(chantier.dateFin, companyTimezone)} (${joursEcoules} j)` : ` (il y a ${joursEcoules} j)`}
              </span>
              {metrics.joursSansSaisie != null && (
                <span className="flex items-center gap-1.5" data-derniere-saisie>
                  <Clock3 size={14} className="text-gray-400" />
                  Dernière saisie : {metrics.derniereSaisie ? `${toDateFrancaise(metrics.derniereSaisie)} (${ancienneteSaisie(metrics.joursSansSaisie)})` : 'aucune depuis le démarrage'}
                </span>
              )}
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

          {/* Alertes de suivi, calculées par le serveur : une fiche saine le dit aussi. */}
          <div className="-mt-4 mb-6" data-alertes-fiche>
            <AlertesChantier chantier={chantier} afficherSiSain />
          </div>

          {/* Bannière de rappel : un chantier Terminé mais Non encaissé ne compte pas dans
              le résultat commercial du mois (CA et marge validés).
              Le badge ci-dessus permet déjà de basculer ce statut, mais reste discret parmi
              les autres badges — cette bannière rend l'action impossible à manquer. */}
          {isTermine && !chantier.encaisse && isAdminRole(userRole) && (
            <div className="mb-6 p-4 rounded-xl border-l-8 border-amber-500 bg-amber-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="font-bold text-amber-800">Chantier terminé, en attente d'encaissement</div>
                <div className="text-sm text-amber-700">
                  Tant que l'encaissement n'est pas validé, ce chantier ne compte pas dans le CA et la marge validés du commercial.
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
                <div aria-hidden="true" className="absolute top-0 right-0 w-16 h-16 bg-blue-100 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
                <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 z-10">Budget Vendu</div>
                <div className="text-2xl font-black text-primary-dark z-10">{chantier.budgetGlobalVendu.toLocaleString()} €</div>
              </div>
            )}

            {chantier.facturation && (
              <div className="bg-emerald-50 p-5 rounded-xl border border-emerald-100 flex flex-col justify-center">
                <div className="text-xs font-bold text-emerald-700 uppercase tracking-widest mb-1">Facturé HT</div>
                <div className="text-2xl font-black text-emerald-800">{fmtEuro(chantier.facturation.totalFactureHt)}</div>
                <div className="mt-1 text-xs text-emerald-700">Reste à facturer : {fmtEuro(chantier.facturation.resteAFacturerHt)}</div>
              </div>
            )}

            {chantier.facturation?.factures?.length > 0 && (
              <section aria-label="Factures liées" className="lg:col-span-4 overflow-x-auto rounded-xl border border-emerald-100 bg-white">
                <div className="flex items-center gap-2 border-b border-emerald-100 bg-emerald-50 px-5 py-3">
                  <Wallet size={18} className="text-emerald-700" />
                  <h3 className="m-0 text-lg font-bold text-emerald-900">Factures liées</h3>
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs font-bold text-emerald-700">{chantier.facturation.factures.length}</span>
                </div>
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                    <tr><th className="p-3">Numéro</th><th className="p-3">Type</th><th className="p-3">Statut</th><th className="p-3">Émission</th><th className="p-3 text-right">Total HT</th><th className="p-3 text-right">Total TTC</th>{isAdminRole(userRole) && <th className="p-3">Action</th>}</tr>
                  </thead>
                  <tbody>
                    {chantier.facturation.factures.map((facture: FactureLiee) => (
                      <tr key={facture.id} className="border-t border-gray-100">
                        <td className="p-3 font-semibold text-gray-800">{facture.numero}</td>
                        <td className="p-3">{facture.type === 'AVOIR' ? 'Avoir' : 'Facture'}</td>
                        <td className="p-3">{facture.statut}</td>
                        <td className="p-3">{toDateFrancaise(facture.dateEmission)}</td>
                        <td className="p-3 text-right font-semibold">{fmtEuro(facture.totalHt)}</td>
                        <td className="p-3 text-right font-semibold">{fmtEuro(facture.totalTtc)}</td>
                        {isAdminRole(userRole) && <td className="p-3"><button type="button" className="btn btn-secondary" onClick={() => void handleDownloadFacturePdf(facture)}><FileDown size={16} /> PDF</button></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {/* Budgets par poste : non communiqués à un compte technicien (null côté serveur). */}
            {chantier.budgetMaterielVendu != null && (
            <div className="bg-gray-50 p-5 rounded-xl border border-gray-100 flex flex-col justify-center relative overflow-hidden group">
              <div aria-hidden="true" className="absolute top-0 right-0 w-16 h-16 bg-green-100 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
              <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 z-10">Matériel Prévu</div>
              <div className="text-2xl font-black text-accent z-10">{chantier.budgetMaterielVendu.toLocaleString()} €</div>
            </div>
            )}

            <div className="bg-gray-50 p-5 rounded-xl border border-gray-100 flex flex-col justify-center relative overflow-hidden group">
              <div aria-hidden="true" className="absolute top-0 right-0 w-16 h-16 bg-purple-100 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
              <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 z-10">Heures Prévues</div>
              <div className="text-2xl font-black text-purple-600 z-10">{chantier.heuresVendues} h</div>
            </div>

            {chantier.budgetMainOeuvreVendu != null && (
            <div className="bg-gray-50 p-5 rounded-xl border border-gray-100 flex flex-col justify-center relative overflow-hidden group">
              <div aria-hidden="true" className="absolute top-0 right-0 w-16 h-16 bg-orange-100 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
              <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 z-10">Coût MO Prévu</div>
              <div className="text-2xl font-black text-orange-600 z-10">{chantier.budgetMainOeuvreVendu.toLocaleString()} €</div>
            </div>
            )}
          </div>

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

                {metrics.totalDepenses != null && (
                <div className="z-10 bg-white/60 backdrop-blur-sm p-4 rounded-lg text-right">
                  <div className="text-xs text-gray-500 font-bold uppercase tracking-wider mb-1">Dépenses Réelles Cumulées</div>
                  <div className="font-bold text-2xl text-gray-800">{arrondiCentime(totalDepensesReelles).toLocaleString()} €</div>
                </div>
                )}
              </div>
              {/* Marge estimée en fin de chantier : les hypothèses sont écrites en clair, pour
                  qu'on sache d'où vient le chiffre et ce qui le ferait bouger. */}
              {estimation && metrics.margeEstimee != null && !isTermine && (
                <div className="z-10 bg-white/60 p-4 rounded-lg" data-estimation>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="text-xs text-gray-500 font-bold uppercase tracking-wider">Marge estimée en fin de chantier</div>
                    <div className={`text-2xl font-black ${arrondiEuro(metrics.margeEstimee) >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                      {fmtEuro(metrics.margeEstimee)}
                      <span className="text-sm font-bold ml-2">{(metrics.margeEstimeePct ?? 0).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %</span>
                    </div>
                  </div>
                  <ul className="mt-2 mb-0 pl-4 text-xs text-gray-600 space-y-0.5">
                    <li>Main-d’œuvre attendue : {estimation.coutMainOeuvreAttendu != null && <><strong>{fmtEuro(estimation.coutMainOeuvreAttendu)}</strong> — </>}{hypotheseCoutHoraire(estimation)}.</li>
                    <li>Matériel attendu : <strong>{fmtEuro(estimation.coutMaterielAttendu)}</strong> — {hypotheseMateriel(estimation)}.</li>
                    <li>Un poste n’est jamais estimé sous ce qui a déjà été dépensé.</li>
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Progress Bars */}
          <div className={`grid grid-cols-1 gap-8 mb-8 ${montantsVisibles && !coutMainOeuvreVisible ? 'lg:grid-cols-2' : 'lg:grid-cols-3'}`}>
            {/* Matériel et coût de main-d'œuvre : montants jamais montrés au technicien. */}
            {montantsVisibles && (<>
            {/* Matériel */}
            <div>
              <div className="flex justify-between items-end mb-2">
                <h3 className="font-bold text-gray-800 flex items-center gap-2 m-0">
                  <Package size={18} className="text-accent" /> Consommation Matériel
                </h3>
                <div className="text-right">
                  <span className="text-xl font-black text-accent">{depenseMaterielReelle.toLocaleString()} €</span>
                  {chantier.budgetMaterielVendu != null && <span className="text-sm font-semibold text-gray-400 ml-1">/ {chantier.budgetMaterielVendu.toLocaleString()} €</span>}
                </div>
              </div>
              {chantier.budgetMaterielVendu != null && (
                <>
                  <ProgressMeter value={depenseMaterielReelle} max={chantier.budgetMaterielVendu} color="blue" striped />
                  <div className="mt-2 text-right text-xs font-bold text-gray-500">
                    {((depenseMaterielReelle / Math.max(1, chantier.budgetMaterielVendu)) * 100).toFixed(1)}%
                  </div>
                </>
              )}
            </div>

            {/* Coût main d'oeuvre (€) — distinct de la barre "Heures" ci-dessous : un
                dépassement d'heures se traduit ici en euros réellement dépensés en salaire,
                avec le manque à gagner correspondant s'il dépasse le budget vendu. Réservé à
                l'administration. */}
            {coutMainOeuvreVisible && (
            <div>
              <div className="flex justify-between items-end mb-2">
                <h3 className="font-bold text-gray-800 flex items-center gap-2 m-0">
                  <Wallet size={18} className="text-orange-500" /> Coût Main d'Œuvre
                </h3>
                <div className="text-right">
                  <span className="text-xl font-black text-orange-600">{arrondiCentime(coutMainOeuvreReel).toLocaleString()} €</span>
                  {chantier.budgetMainOeuvreVendu != null && <span className="text-sm font-semibold text-gray-400 ml-1">/ {chantier.budgetMainOeuvreVendu.toLocaleString()} €</span>}
                </div>
              </div>
              {chantier.budgetMainOeuvreVendu != null && <ProgressMeter value={coutMainOeuvreReel} max={chantier.budgetMainOeuvreVendu} color="orange" striped />}
              <div className="mt-2 flex justify-between items-center text-xs font-bold">
                <span className={arrondiCentime(manqueAGagnerMainOeuvre) > 0 ? 'text-red-600' : 'text-gray-300'}>
                  {arrondiCentime(manqueAGagnerMainOeuvre) > 0 ? `Manque à gagner : -${arrondiCentime(manqueAGagnerMainOeuvre).toLocaleString()} €` : ''}
                </span>
                {chantier.budgetMainOeuvreVendu != null && (
                  <span className="text-gray-500">
                    {((coutMainOeuvreReel / Math.max(1, chantier.budgetMainOeuvreVendu)) * 100).toFixed(1)}%
                  </span>
                )}
              </div>
            </div>
            )}
            </>)}

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
            {montantsVisibles && (<>
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
            </>)}
            <div className="bg-gray-50 rounded-xl border border-gray-100 p-5">
              <h3 className="font-bold text-gray-800 flex items-center gap-2 mb-4 text-sm uppercase tracking-wide">
                <Users size={16} className="text-purple-500" /> Heures par intervenant
              </h3>
              <BarBreakdown rows={parIntervenant} color="#8b5cf6" formatValue={(v) => `${v.toFixed(1)} h`} emptyLabel="Aucune heure enregistrée" />
            </div>
          </div>

        </div>

        {/* Journaux (hors PDF) */}
        <div className="grid grid-cols-1 gap-6">
          {/* Journal complet des achats : toutes les dépenses du chantier, avec recherche,
              filtres et tri pour retrouver une ligne précise et la corriger ou la supprimer.
              C'est un journal de coûts : jamais montré au technicien. */}
          {montantsVisibles && (
          <div className="bg-white rounded-2xl shadow-md border border-gray-100 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Wallet size={18} className="text-accent" />
                <h3 className="text-lg font-bold text-primary-dark m-0">Achats du chantier</h3>
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-blue-50 text-accent">
                  {achats.length} achat{achats.length > 1 ? 's' : ''}
                </span>
              </div>
              <div className="text-sm text-muted">
                Total dépensé : <strong className="text-primary-dark">{fmtEuro(achatsTotal)}</strong>
              </div>
            </div>

            {achats.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 px-6 py-3 bg-gray-50 border-b border-gray-100">
                {/* La place de la loupe est réservée en style inline : .form-input pose son
                    propre padding hors couche Tailwind, un utilitaire pl-* serait ignoré. */}
                <div className="relative flex-1 min-w-[220px]">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                  <input
                    type="search"
                    value={achatSearch}
                    onChange={(e) => setAchatSearch(e.target.value)}
                    placeholder="Rechercher (description, n° de facture, fournisseur, montant...)"
                    style={{ paddingLeft: '2.25rem' }}
                    className="form-input text-sm"
                  />
                </div>
                {/* Largeurs portées par des conteneurs : sur le champ lui-même, les
                    utilitaires Tailwind perdraient contre le width:100% de .form-input. */}
                <div className="w-full sm:w-52">
                  <select value={achatFournisseurFiltre} onChange={(e) => setAchatFournisseurFiltre(e.target.value)} className="form-input text-sm">
                    <option value="">Tous les fournisseurs</option>
                    {achatsFournisseursDispo.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div className="w-full sm:w-52">
                  <select value={achatCategorieFiltre} onChange={(e) => setAchatCategorieFiltre(e.target.value)} className="form-input text-sm">
                    <option value="">Toutes les catégories</option>
                    {achatsCategoriesDispo.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="w-full sm:w-60">
                  <select value={achatTri} onChange={(e) => setAchatTri(e.target.value as typeof achatTri)} className="form-input text-sm">
                    <option value="date-desc">Du plus récent au plus ancien</option>
                    <option value="date-asc">Du plus ancien au plus récent</option>
                    <option value="montant-desc">Montant décroissant</option>
                    <option value="montant-asc">Montant croissant</option>
                  </select>
                </div>
                {achatsFiltreActif && (
                  <button type="button" onClick={resetAchatsFiltres} className="text-xs font-semibold text-accent hover:underline">
                    Réinitialiser
                  </button>
                )}
              </div>
            )}

            {achats.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-400 italic">Aucun achat enregistré.</div>
            ) : achatsAffiches.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-400 italic">Aucun achat ne correspond à la recherche.</div>
            ) : (
              <div className="divide-y divide-gray-100 max-h-[32rem] overflow-y-auto">
                {achatsAffiches.map((a) => (
                  editingAchatId === a.id ? (
                    <form
                      key={a.id}
                      onSubmit={(e) => handleAchatSubmit(e, a.id)}
                      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 px-6 py-3 bg-gray-50"
                    >
                      <input required type="text" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" name="date" defaultValue={toDateFrancaise(a.date)} className="form-input text-sm" />
                      <input required type="number" step="0.01" name="montantHT" defaultValue={a.montantHT} placeholder="Montant HT" className="form-input text-sm" />
                      <select required name="fournisseurId" defaultValue={a.fournisseurId} className="form-input text-sm">
                        {fournisseurs.length === 0 && <option value={a.fournisseurId}>{a.fournisseur?.nom}</option>}
                        {fournisseurs.map((f) => <option key={f.id} value={f.id}>{f.nom}</option>)}
                      </select>
                      <select required name="categorieId" defaultValue={a.categorieId} className="form-input text-sm">
                        {categories.length === 0 && <option value={a.categorieId}>{a.categorie?.nom}</option>}
                        {categories.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
                      </select>
                      <input required type="text" name="description" defaultValue={a.description} placeholder="Description" className="form-input text-sm sm:col-span-2 lg:col-span-3" />
                      <input type="text" name="numeroFacture" defaultValue={a.numeroFacture || ''} placeholder="N° de facture (optionnel)" className="form-input text-sm sm:col-span-2 lg:col-span-1" />
                      <input required minLength={3} maxLength={500} type="text" name="motifCorrection" placeholder="Motif de la correction" className="form-input text-sm sm:col-span-2 lg:col-span-4" />
                      <div className="sm:col-span-2 lg:col-span-4 flex gap-2 justify-end">
                        <button type="button" disabled={savingAchat} onClick={() => setEditingAchatId(null)} className="btn bg-white border text-xs px-3 py-1.5">Annuler</button>
                        <button type="submit" disabled={savingAchat} className="btn btn-primary text-xs px-3 py-1.5">
                          {savingAchat ? 'Enregistrement...' : 'Enregistrer'}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div key={a.id} className="flex items-center justify-between gap-3 px-6 py-3 text-sm hover:bg-gray-50 transition-colors">
                      <div className="min-w-0">
                        <div className="font-semibold text-gray-700">{a.description}</div>
                        <div className="text-xs text-gray-400">
                          {fmtDate(a.date)} · {a.fournisseur?.nom} · {a.categorie?.nom}
                          {a.numeroFacture ? ` · Facture ${a.numeroFacture}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="font-bold text-gray-800 whitespace-nowrap">{fmtEuro(a.montantHT)}</div>
                        {(peutCorrigerTravaux || peutArchiverTravaux) && (
                          <>
                            {peutCorrigerTravaux && <button
                              onClick={() => startEditAchat(a.id)}
                              className="p-1.5 text-gray-400 hover:text-accent hover:bg-blue-50 rounded-lg transition-colors"
                              title="Corriger cet achat"
                            >
                              <Pencil size={14} />
                            </button>}
                            {peutArchiverTravaux && <button
                              onClick={() => handleDeleteAchat(a.id)}
                              disabled={savingAchat}
                              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                              title="Archiver cet achat"
                            >
                              <Trash2 size={14} />
                            </button>}
                          </>
                        )}
                      </div>
                    </div>
                  )
                ))}
              </div>
            )}
            {/* Récapitulatif de la sélection : n'a de sens qu'une fois la liste filtrée,
                sinon il répète le total affiché en en-tête. */}
            {achatsFiltreActif && achatsAffiches.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 border-t border-gray-100 bg-gray-50 text-xs font-semibold text-gray-500">
                <span>{achatsAffiches.length} achat{achatsAffiches.length > 1 ? 's' : ''} sur {achats.length}</span>
                <span>Sous-total : <strong className="text-primary-dark">{fmtEuro(achatsAffichesTotal)}</strong></span>
              </div>
            )}
          </div>
          )}

          {/* Journal complet des heures : tous les pointages du chantier, avec les mêmes
              outils de recherche que le journal des achats ci-dessus. */}
          <div className="bg-white rounded-2xl shadow-md border border-gray-100 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Hammer size={18} className="text-purple-500" />
                <h3 className="text-lg font-bold text-primary-dark m-0">Heures du chantier</h3>
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-purple-50 text-purple-600">
                  {pointages.length} pointage{pointages.length > 1 ? 's' : ''}
                </span>
              </div>
              <div className="text-sm text-muted">
                Total pointé : <strong className="text-primary-dark">{fmtHeures(heuresTotal)}</strong>
              </div>
            </div>

            {pointages.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 px-6 py-3 bg-gray-50 border-b border-gray-100">
                <div className="relative flex-1 min-w-[220px]">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                  <input
                    type="search"
                    value={pointageSearch}
                    onChange={(e) => setPointageSearch(e.target.value)}
                    placeholder="Rechercher (intervenant, rôle, commentaire, date...)"
                    style={{ paddingLeft: '2.25rem' }}
                    className="form-input text-sm"
                  />
                </div>
                <div className="w-full sm:w-52">
                  <select value={pointageIntervenantFiltre} onChange={(e) => setPointageIntervenantFiltre(e.target.value)} className="form-input text-sm">
                    <option value="">Tous les intervenants</option>
                    {pointagesIntervenantsDispo.map((i) => <option key={i} value={i}>{i}</option>)}
                  </select>
                </div>
                <div className="w-full sm:w-52">
                  <select value={pointageRoleFiltre} onChange={(e) => setPointageRoleFiltre(e.target.value)} className="form-input text-sm">
                    <option value="">Tous les rôles</option>
                    {pointagesRolesDispo.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div className="w-full sm:w-60">
                  <select value={pointageTri} onChange={(e) => setPointageTri(e.target.value as typeof pointageTri)} className="form-input text-sm">
                    <option value="date-desc">Du plus récent au plus ancien</option>
                    <option value="date-asc">Du plus ancien au plus récent</option>
                    <option value="heures-desc">Heures décroissantes</option>
                    <option value="heures-asc">Heures croissantes</option>
                  </select>
                </div>
                {pointagesFiltreActif && (
                  <button type="button" onClick={resetPointagesFiltres} className="text-xs font-semibold text-accent hover:underline">
                    Réinitialiser
                  </button>
                )}
              </div>
            )}

            {pointages.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-400 italic">Aucune heure enregistrée.</div>
            ) : pointagesAffiches.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-400 italic">Aucun pointage ne correspond à la recherche.</div>
            ) : (
              <div className="divide-y divide-gray-100 max-h-[32rem] overflow-y-auto">
                {pointagesAffiches.map((p) => (
                  editingPointageId === p.id ? (
                    <form
                      key={p.id}
                      onSubmit={(e) => handlePointageSubmit(e, p.id)}
                      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 px-6 py-3 bg-gray-50"
                    >
                      <input required type="text" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" name="date" defaultValue={toDateFrancaise(p.date)} className="form-input text-sm" />
                      <select required name="intervenantId" defaultValue={p.intervenantId} className="form-input text-sm">
                        {intervenants.length === 0 && <option value={p.intervenantId}>{p.intervenant?.nom}</option>}
                        {intervenants.map((i) => <option key={i.id} value={i.id}>{i.nom} ({i.role})</option>)}
                      </select>
                      <input required type="number" step="0.5" min="0.5" name="nbrHeures" defaultValue={p.nbrHeures} className="form-input text-sm" />
                      <input type="text" name="commentaire" defaultValue={p.commentaire || ''} placeholder="Commentaire" className="form-input text-sm" />
                      <input required minLength={3} maxLength={500} type="text" name="motifCorrection" placeholder="Motif de la correction" className="form-input text-sm sm:col-span-2 lg:col-span-3" />
                      <div className="sm:col-span-2 lg:col-span-4 flex gap-2 justify-end">
                        <button type="button" disabled={savingPointage} onClick={() => setEditingPointageId(null)} className="btn bg-white border text-xs px-3 py-1.5">Annuler</button>
                        <button type="submit" disabled={savingPointage} className="btn btn-primary text-xs px-3 py-1.5">
                          {savingPointage ? 'Enregistrement...' : 'Enregistrer'}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div key={p.id} className="flex items-center justify-between gap-3 px-6 py-3 text-sm hover:bg-gray-50 transition-colors">
                      <div className="min-w-0">
                        <div className="font-semibold text-gray-700">{p.intervenant?.nom}</div>
                        <div className="text-xs text-gray-400">
                          {fmtDate(p.date)} · {p.intervenant?.role}
                          {p.commentaire ? ` · ${p.commentaire}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="font-bold text-gray-800 whitespace-nowrap">{fmtHeures(p.nbrHeures)}</div>
                        {(peutCorrigerTravaux || peutArchiverTravaux) && (
                          <>
                            {peutCorrigerTravaux && <button
                              onClick={() => startEditPointage(p.id)}
                              className="p-1.5 text-gray-400 hover:text-accent hover:bg-blue-50 rounded-lg transition-colors"
                              title="Corriger ce pointage"
                            >
                              <Pencil size={14} />
                            </button>}
                            {peutArchiverTravaux && <button
                              onClick={() => handleDeletePointage(p.id)}
                              disabled={savingPointage}
                              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                              title="Archiver ce pointage"
                            >
                              <Trash2 size={14} />
                            </button>}
                          </>
                        )}
                      </div>
                    </div>
                  )
                ))}
              </div>
            )}
            {pointagesFiltreActif && pointagesAffiches.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 border-t border-gray-100 bg-gray-50 text-xs font-semibold text-gray-500">
                <span>{pointagesAffiches.length} pointage{pointagesAffiches.length > 1 ? 's' : ''} sur {pointages.length}</span>
                <span>Sous-total : <strong className="text-primary-dark">{fmtHeures(pointagesAffichesTotal)}</strong></span>
              </div>
            )}
          </div>
        </div>

        <section aria-labelledby="journal-saisies-titre" className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 id="journal-saisies-titre" className="font-bold text-primary-dark">Journal d’audit des saisies</h2>
            <p className="text-sm text-gray-500 mt-1">Historique immuable des créations, corrections et archivages du chantier, et des changements de son client, de son titulaire, de son commercial et de son encaissement.</p>
          </div>
          {journalSaisies.length === 0 ? (
            <p className="px-6 py-5 text-sm italic text-gray-400">Aucune entrée au journal de ce chantier.</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {journalSaisies.map((entree) => (
                <div key={entree.id} className="px-6 py-4 text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    <strong>{titreEntreeJournal(entree)}</strong>
                    <span className="text-gray-500">{formatCompanyDate(entree.createdAt, companyTimezone)} · {entree.auteurNom}</span>
                  </div>
                  {entree.motif && <p className="mt-1 text-gray-600">Motif : {entree.motif}</p>}
                  {changementAffaire(entree) && (
                    <div className="mt-2 grid gap-2 md:grid-cols-2 text-xs">
                      <p className="rounded bg-red-50 p-2 text-red-900">Avant : {changementAffaire(entree)!.avant}</p>
                      <p className="rounded bg-emerald-50 p-2 text-emerald-900">Après : {changementAffaire(entree)!.apres}</p>
                    </div>
                  )}
                  {entree.action === 'CORRECTION' && (
                    <div className="mt-2 grid gap-2 md:grid-cols-2 text-xs">
                      <pre className="overflow-auto rounded bg-red-50 p-2 text-red-900">Avant : {instantaneLisible(entree.avant, companyTimezone)}</pre>
                      <pre className="overflow-auto rounded bg-emerald-50 p-2 text-emerald-900">Après : {instantaneLisible(entree.apres, companyTimezone)}</pre>
                    </div>
                  )}
                  {entree.action === 'CREATION' && entree.apres && (
                    <pre className="mt-2 overflow-auto rounded bg-emerald-50 p-2 text-xs text-emerald-900">Valeurs enregistrées : {instantaneLisible(entree.apres, companyTimezone)}</pre>
                  )}
                  {entree.action === 'ARCHIVAGE' && entree.avant && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <pre className="overflow-auto rounded bg-amber-50 p-2 text-xs text-amber-900">Valeurs archivées : {instantaneLisible(entree.avant, companyTimezone)}</pre>
                      {peutArchiverTravaux && archivesRestaurables.has(entree.id) && (
                        <button
                          type="button"
                          onClick={() => handleRestore(entree.cible, entree.cibleId)}
                          disabled={savingAchat || savingPointage}
                          className="btn border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800 hover:bg-emerald-100"
                        >
                          <RotateCcw size={14} /> Restaurer
                        </button>
                      )}
                    </div>
                  )}
                  {entree.action === 'RESTAURATION' && entree.apres && (
                    <pre className="mt-2 overflow-auto rounded bg-emerald-50 p-2 text-xs text-emerald-900">Valeurs restaurées : {instantaneLisible(entree.apres, companyTimezone)}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

      </div>

      {/* Modale d'édition du chantier — admins et conducteur responsable (cf. canEditChantier) */}
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
                <label className="form-label" htmlFor={isAdminRole(userRole) ? 'client-chantier' : undefined}>Client</label>
                {isAdminRole(userRole) ? (
                  <SelecteurClient id="client-chantier" name="clientId" label="Client du chantier" required valeur={editClientId} onChange={(client) => setEditClientId(client?.id ?? '')} clientActuel={clientActuel} />
                ) : <input readOnly value={chantier.client} className="form-input bg-gray-50" />}
              </div>
              <div className="form-group mb-0">
                <label className="form-label">N° de Devis</label>
                {/* Obligatoire, sauf sur un chantier antérieur créé sans devis : l'exiger
                    ici interdirait toute autre correction sur sa fiche. */}
                <input
                  required={!!chantier.numeroDevis}
                  name="numeroDevis"
                  defaultValue={chantier.numeroDevis || ''}
                  className="form-input"
                  placeholder="Référence d'affaire (ex : A26-0001)"
                />
              </div>
              <div className="form-group mb-0 md:col-span-2">
                <label className="form-label">Adresse du site (optionnel)</label>
                <input ref={editChantierAdresseRef} name="adresse" defaultValue={chantier.adresse || ''} className="form-input" placeholder="Adresse du site" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Responsable Chantier</label>
                <select required name="responsableId" className="form-input" value={editResponsableId} onChange={(e) => setEditResponsableId(e.target.value)}>
                  <option value="" disabled>Sélectionner un conducteur...</option>
                  {/* Un titulaire absent de la liste d'attribution (compte désactivé au départ d'un
                      conducteur, ou titulaire qui n'est pas conducteur) y est rajouté, pour ne pas
                      forcer une réaffectation à l'occasion d'une correction sans rapport. Choisir
                      un autre conducteur le remplace. La raison n'est pas connue ici : le libellé
                      ne la présume pas. */}
                  {chantier.responsable && !conducteurs.some(c => c.id === chantier.responsable.id) && (
                    <option value={chantier.responsable.id}>{chantier.responsable.name} (hors des conducteurs actifs)</option>
                  )}
                  {conducteurs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Commercial rattaché{commerciaux.length > 0 ? '' : ' (aucun disponible)'}</label>
                <select required={commerciaux.length > 0} name="commercialId" className="form-input" value={editCommercialId} onChange={(e) => setEditCommercialId(e.target.value)}>
                  <option value="" disabled>Sélectionner un commercial...</option>
                  {chantier.commercial && !commerciaux.some(c => c.id === chantier.commercial.id) && (
                    <option value={chantier.commercial.id}>{chantier.commercial.name} (hors des commerciaux actifs)</option>
                  )}
                  {commerciaux.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Date Début</label>
                {/* Dates lues au jour de la société : non modifiables tant que son fuseau n'est pas lu,
                    pour ne pas effacer une saisie au moment où le champ se recale. Désactivées, elles
                    ne partent pas avec la fiche, qui garde alors ses dates. */}
                <input required type="text" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" name="dateDebut" key={`debut-${companyTimezone}`} defaultValue={jourCivilChantier(chantier.dateDebut, companyTimezone)} disabled={!fuseauConnu} className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Date Fin</label>
                <input type="text" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" name="dateFin" key={`fin-${companyTimezone}`} defaultValue={chantier.dateFin ? jourCivilChantier(chantier.dateFin, companyTimezone) : ''} disabled={!fuseauConnu} className="form-input" />
              </div>
              {/* Montant vendu : seulement pour qui le voit (le serveur refuse qu'un autre le
                  modifie) ; sinon le champ arriverait vide et l'enregistrer l'écraserait. */}
              {chantier.budgetGlobalVendu != null && (
                <div className="form-group mb-0">
                  <label className="form-label font-bold text-primary">Budget Global (€ HT)</label>
                  <input ref={editChantierBudgetRef} required type="number" step="0.01" name="budgetGlobalVendu" defaultValue={chantier.budgetGlobalVendu} className="form-input" />
                </div>
              )}
              <div className="form-group mb-0">
                <label className="form-label">Total Heures Vendues (h)</label>
                <input required type="number" step="0.5" name="heuresVendues" defaultValue={chantier.heuresVendues} className="form-input" />
              </div>
              {/* Budgets par poste : seulement pour qui les voit (le serveur refuse qu'un technicien les modifie). */}
              {chantier.budgetMaterielVendu != null && (
                <div className="form-group mb-0">
                  <label className="form-label">Dont Matériel (€ HT)</label>
                  <input required type="number" step="0.01" name="budgetMaterielVendu" defaultValue={chantier.budgetMaterielVendu} className="form-input" />
                </div>
              )}
              {chantier.budgetMainOeuvreVendu != null && (
                <div className="form-group mb-0">
                  <label className="form-label">Dont Main d'Œuvre (€ HT)</label>
                  <input required type="number" step="0.01" name="budgetMainOeuvreVendu" defaultValue={chantier.budgetMainOeuvreVendu} className="form-input" />
                </div>
              )}
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
                  <input type="checkbox" name="baremeReduit" value="true" defaultChecked={!!chantier.baremeReduit} className="w-4 h-4" />
                  {libelleBaremeReduit} (sans effet tant qu'aucun plan commercial n'est attribué)
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
