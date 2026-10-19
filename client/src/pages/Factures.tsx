import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, Download, FilePlus2, HandCoins, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { apiFetch } from '../api';
import { companyDateInputValue, formatDateOnly } from '../lib/dateFormatting';
import { situationReglement } from '../lib/reglements';

type Client = { id: string; raisonSociale: string };
type Origine = 'CHANTIER' | 'INTERVENTION' | 'CONTRAT' | 'HORS_AFFAIRE';
type NatureLigne = 'PRESTATION' | 'ARTICLE';
type Source = { id: string; nom?: string; titre?: string; reference?: string; clientId?: string; client?: Client };
type Ligne = { designation: string; nature: NatureLigne; quantite: string; prixUnitaireHt: string; tauxTva: string };
type Trace = {
  facture: { id: string; origine: Origine; motifHorsAffaire: string | null; client: Client;
    chantier: { id: string; nom: string; numeroDevis: string | null; statut: string } | null;
    intervention: { id: string; reference: string; titre: string; chantierId: string | null } | null;
    contratMaintenance: { id: string; titre: string } | null };
  devis: { id: string; numero: string; objet: string } | null;
  devisAmbigu: boolean;
  interventionsLiees: { id: string; reference: string; titre: string }[];
};
type Facture = {
  id: string;
  numero: string | null;
  statut: string;
  type: 'FACTURE' | 'AVOIR';
  factureOrigine?: { id: string; numero: string | null } | null;
  avoirs?: { id: string; numero: string | null; estAvoirAnnulation: boolean }[];
  dateEmission: string;
  dateEcheance: string;
  totalHt: number;
  totalTva: number;
  totalTtc: number;
  // Soldes déduits des règlements et des avoirs : null hors facture émise ou réglée.
  montantRegle?: number | null;
  montantAvoirs?: number | null;
  resteDu?: number | null;
  origine: Origine;
  motifHorsAffaire?: string | null;
  client: Client;
  lignes: Ligne[];
};

const nouvelleLigne = (): Ligne => ({ designation: '', nature: 'PRESTATION', quantite: '1', prixUnitaireHt: '', tauxTva: '20' });
const nombreFr = (valeur: string): number | null => { const normalise = valeur.trim().replace(',', '.'); return /^\d+(\.\d+)?$/.test(normalise) ? Number(normalise) : null; };
const formatDate = (date: string) => formatDateOnly(date);
const formatMontant = (montant: number) => montant.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
// Même arithmétique que le serveur : chaque ligne est arrondie au centime avant
// agrégation, puis la TVA est calculée par taux. L’aperçu doit annoncer le document émis.
const centimes = (montant: number) => Math.round((montant + Number.EPSILON) * 100) / 100;
const entierDecimal = (valeur: string, decimales: number): bigint | null => {
  const resultat = new RegExp(`^(\\d+)(?:[,.](\\d{1,${decimales}}))?$`).exec(valeur.trim());
  return resultat ? BigInt(resultat[1]) * 10n ** BigInt(decimales) + BigInt((resultat[2] || '').padEnd(decimales, '0') || '0') : null;
};
const centimesLigne = (quantite: string, prixUnitaireHt: string): number => {
  const milliemes = entierDecimal(quantite, 3), centimesPu = entierDecimal(prixUnitaireHt, 2);
  return milliemes === null || centimesPu === null ? 0 : Number((milliemes * centimesPu + 500n) / 1000n) / 100;
};
const avoirsPartiels = (facture: Facture) => (facture.avoirs || []).filter((avoir) => !avoir.estAvoirAnnulation);

export default function Factures() {
  const [factures, setFactures] = useState<Facture[]>([]);
  const [page, setPage] = useState(1);
  // Inconnu (null) jusqu'à la première réponse : la pagination ne donne pas de compte qu'elle n'a pas
  // reçu, « 0 document(s) » se lirait comme une liste vide (#211).
  const [total, setTotal] = useState<number | null>(null);
  // Vrai dès le premier rendu : la page ne montre jamais « Aucune facture » avant sa première réponse,
  // et les parcours qui attendent la fin du chargement attendent bien cette réponse (#211).
  const [chargement, setChargement] = useState(true);
  const pageCourante = useRef(1);
  const requeteListe = useRef(0);
  const taillePage = 25;
  const nombrePages = Math.max(1, Math.ceil((total ?? 0) / taillePage));
  const [derniereDateEmission, setDerniereDateEmission] = useState<string | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [rechercheClient, setRechercheClient] = useState('');
  const [resultatsClients, setResultatsClients] = useState<Client[] | null>(null);
  const [rechercheEnCours, setRechercheEnCours] = useState(false);
  const [erreurRechercheClient, setErreurRechercheClient] = useState('');
  const requeteClients = useRef(0);
  const [chantiers, setChantiers] = useState<Source[]>([]);
  const [interventions, setInterventions] = useState<Source[]>([]);
  const [contrats, setContrats] = useState<Source[]>([]);
  const [erreur, setErreur] = useState('');
  const [erreurListe, setErreurListe] = useState('');
  const [succes, setSucces] = useState('');
  const [ouvert, setOuvert] = useState(false);
  const [origine, setOrigine] = useState<Origine>('HORS_AFFAIRE');
  const [clientSelection, setClientSelection] = useState('');
  const [lignes, setLignes] = useState<Ligne[]>([nouvelleLigne()]);
  // Fuseau de la société, lu avec la liste : tant qu'il n'est pas connu, les dates d'émission et
  // d'échéance ne sont pas préremplies (un jour d'Europe/Paris par défaut serait faux ailleurs).
  const [fuseauHoraire, setFuseauHoraire] = useState<string | null>(null);
  const [factureAvoir, setFactureAvoir] = useState<Facture | null>(null);
  const [lignesAvoir, setLignesAvoir] = useState<Ligne[]>([nouvelleLigne()]);
  const [factureTraceId, setFactureTraceId] = useState<string | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [traceErreur, setTraceErreur] = useState('');
  const [traceCharge, setTraceCharge] = useState(false);
  const traceRequete = useRef(0);

  const chargerTrace = async (id: string) => {
    const requete = ++traceRequete.current;
    setFactureTraceId(id);
    setTrace(null);
    setTraceErreur('');
    setTraceCharge(true);
    try {
      const response = await apiFetch(`/factures/${id}/tracabilite`);
      const donnees = await response.json();
      if (!response.ok) throw new Error(donnees?.error || 'Lecture de l’origine impossible.');
      if (requete === traceRequete.current) setTrace(donnees as Trace);
    } catch (e) {
      if (requete === traceRequete.current) setTraceErreur(e instanceof Error ? e.message : 'Lecture de l’origine impossible.');
    } finally {
      if (requete === traceRequete.current) setTraceCharge(false);
    }
  };

  const fermerTrace = () => {
    traceRequete.current += 1;
    setFactureTraceId(null);
    setTrace(null);
  };

  const charger = async (pageDemandee = pageCourante.current) => {
    const requete = ++requeteListe.current;
    setErreurListe('');
    setChargement(true);
    try {
      const chemins = {
        factures: `/factures?page=${pageDemandee}&pageSize=${taillePage}`, clients: '/clients', chantiers: '/chantiers',
        interventions: '/interventions', contrats: '/contrats-maintenance',
        societe: '/company', chronologie: '/factures/chronologie',
      };
      const entrees = await Promise.all(Object.entries(chemins).map(async ([cle, path]) => {
        const reponse = await apiFetch(path);
        const donnee = await reponse.json();
        if (!reponse.ok) throw new Error(donnee?.error || 'Chargement impossible.');
        return [cle, donnee];
      }));
      if (requete !== requeteListe.current) return;
      const {
        factures: facturesData, clients: clientsData, chantiers: chantiersData,
        interventions: interventionsData, contrats: contratsData, societe: societeData,
        chronologie: chronologieData,
      } = Object.fromEntries(entrees);
      if (pageDemandee > 1 && facturesData.total <= (pageDemandee - 1) * taillePage) {
        changerPage(Math.max(1, Math.ceil(facturesData.total / taillePage)));
        return;
      }
      setFactures(facturesData.items);
      setTotal(facturesData.total);
      setChargement(false);
      setClients(clientsData.clients || clientsData || []);
      setChantiers(Array.isArray(chantiersData) ? chantiersData : []);
      setInterventions(Array.isArray(interventionsData) ? interventionsData : []);
      setContrats(Array.isArray(contratsData) ? contratsData : []);
      setFuseauHoraire(societeData?.fuseauHoraire || 'Europe/Paris');
      setDerniereDateEmission(chronologieData.derniereDateEmission);
    } catch (e) {
      if (requete === requeteListe.current) {
        setChargement(false);
        setErreurListe(e instanceof Error ? e.message : 'Chargement impossible.');
      }
    }
  };

  const changerPage = (nouvellePage: number) => {
    if (nouvellePage === pageCourante.current) return;
    pageCourante.current = nouvellePage;
    setPage(nouvellePage);
    setFactures([]);
    fermerTrace();
    setFactureAvoir(null);
    void charger(nouvellePage);
  };

  useEffect(() => { void charger(); return () => { requeteListe.current += 1; }; }, []);

  useEffect(() => {
    const q = rechercheClient.trim();
    if (!ouvert || !q) return;
    const requete = requeteClients.current;
    const minuteur = window.setTimeout(async () => {
      try {
        const response = await apiFetch(`/clients?q=${encodeURIComponent(q)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || 'Recherche impossible.');
        if (requete === requeteClients.current) setResultatsClients(data.clients);
      } catch (e) {
        if (requete === requeteClients.current) setErreurRechercheClient(e instanceof Error ? e.message : 'Recherche impossible.');
      } finally {
        if (requete === requeteClients.current) setRechercheEnCours(false);
      }
    }, 250);
    return () => window.clearTimeout(minuteur);
  }, [rechercheClient, ouvert]);

  const chercherClient = (valeur: string) => {
    requeteClients.current += 1;
    setRechercheClient(valeur);
    setClientSelection('');
    setResultatsClients(valeur.trim() ? [] : null);
    setRechercheEnCours(Boolean(valeur.trim()));
    setErreurRechercheClient('');
  };

  const ouvrirFormulaire = () => {
    setErreur('');
    setSucces('');
    setClientSelection('');
    chercherClient('');
    setOrigine('HORS_AFFAIRE');
    setLignes([nouvelleLigne()]);
    setOuvert(true);
  };

  const modifierLigne = <Champ extends keyof Ligne>(index: number, champ: Champ, valeur: Ligne[Champ]) => {
    setLignes((lignesActuelles) => lignesActuelles.map((ligne, ligneIndex) => (
      ligneIndex === index ? { ...ligne, [champ]: valeur } : ligne
    )));
  };

  const supprimerLigne = (index: number) => {
    setLignes((lignesActuelles) => lignesActuelles.length > 1
      ? lignesActuelles.filter((_, ligneIndex) => ligneIndex !== index)
      : lignesActuelles);
  };

  const ouvrirAvoirPartiel = (facture: Facture) => {
    setErreur('');
    setSucces('');
    setFactureAvoir(facture);
    setLignesAvoir([nouvelleLigne()]);
  };

  const modifierLigneAvoir = <Champ extends keyof Ligne>(index: number, champ: Champ, valeur: Ligne[Champ]) => {
    setLignesAvoir((lignesActuelles) => lignesActuelles.map((ligne, ligneIndex) => (
      ligneIndex === index ? { ...ligne, [champ]: valeur } : ligne
    )));
  };

  const supprimerLigneAvoir = (index: number) => {
    setLignesAvoir((lignesActuelles) => lignesActuelles.length > 1
      ? lignesActuelles.filter((_, ligneIndex) => ligneIndex !== index)
      : lignesActuelles);
  };

  const totauxAvoir = (() => {
    const htParTaux = new Map<number, number>();
    for (const ligne of lignesAvoir) {
      const tauxTva = nombreFr(ligne.tauxTva) ?? 0;
      // Le serveur arrondit chaque ligne avant de sommer : faire de même ici évite
      // qu’un aperçu à côté d’un plafond annonce un montant différent du document.
      htParTaux.set(tauxTva, centimes((htParTaux.get(tauxTva) || 0) + centimesLigne(ligne.quantite, ligne.prixUnitaireHt)));
    }
    const totalHt = centimes([...htParTaux.values()].reduce((somme, ht) => somme + ht, 0));
    const totalTva = centimes([...htParTaux.entries()].reduce((somme, [taux, ht]) => somme + centimes(ht * taux / 100), 0));
    return { totalHt, totalTva, totalTtc: centimes(totalHt + totalTva) };
  })();

  const creerAvoirPartiel = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!factureAvoir) return;
    setErreur('');
    setSucces('');
    const lignesConverties = lignesAvoir.map((ligne) => ({ ...ligne, designation: ligne.designation.trim(), quantite: nombreFr(ligne.quantite), prixUnitaireHt: nombreFr(ligne.prixUnitaireHt), tauxTva: nombreFr(ligne.tauxTva) }));
    const fautive = lignesConverties.findIndex((ligne) => !ligne.designation || ligne.quantite === null || ligne.quantite <= 0 || ligne.prixUnitaireHt === null || ligne.prixUnitaireHt < 0 || ligne.tauxTva === null || ligne.tauxTva < 0 || ligne.tauxTva > 100);
    if (fautive >= 0) return setErreur(`Ligne d’avoir ${fautive + 1} : désignation obligatoire, quantité supérieure à zéro et montants numériques attendus (TVA entre 0 et 100).`);
    const res = await apiFetch(`/factures/${factureAvoir.id}/avoirs`, { method: 'POST', body: JSON.stringify({ lignes: lignesConverties }) });
    const data = await res.json();
    if (!res.ok) return setErreur(data.error || 'Création de l’avoir partiel impossible.');
    setFactureAvoir(null);
    setSucces(`Avoir ${data.numero || ''} créé et émis.`.trim());
    await charger();
  };

  const creer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErreur('');
    setSucces('');
    // Champs de date désactivés tant que le fuseau n'est pas lu (chargement en échec, par exemple) :
    // le formulaire les omettrait, et le serveur ne refuserait qu'une « date invalide ».
    if (!fuseauHoraire) return setErreur('Les paramètres de la société ne sont pas chargés : actualisez la liste avant de créer la facture, ses dates suivent le jour de la société.');
    const form = new FormData(event.currentTarget);
    const lignesConverties = lignes.map((ligne) => ({ ...ligne, quantite: nombreFr(ligne.quantite), prixUnitaireHt: nombreFr(ligne.prixUnitaireHt), tauxTva: nombreFr(ligne.tauxTva) }));
    const fautive = lignesConverties.findIndex((ligne) => ligne.quantite === null || ligne.quantite <= 0 || ligne.prixUnitaireHt === null || ligne.tauxTva === null || ligne.tauxTva > 100);
    if (fautive >= 0) return setErreur(`Ligne ${fautive + 1} : la quantité doit être supérieure à zéro, le prix et le taux de TVA doivent être des nombres (la virgule est acceptée, le taux ne dépasse pas 100).`);
    const payload: Record<string, unknown> = {
      clientId: form.get('clientId'),
      origine,
      dateEmission: form.get('dateEmission'),
      dateEcheance: form.get('dateEcheance'),
      lignes: lignesConverties,
    };
    if (origine === 'CHANTIER') payload.chantierId = form.get('chantierId');
    if (origine === 'INTERVENTION') payload.interventionId = form.get('interventionId');
    if (origine === 'CONTRAT') payload.contratMaintenanceId = form.get('contratMaintenanceId');
    if (origine === 'HORS_AFFAIRE') payload.motifHorsAffaire = form.get('motifHorsAffaire');

    const res = await apiFetch('/factures', { method: 'POST', body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) return setErreur(data.error || 'Création impossible.');
    setOuvert(false);
    setSucces('Brouillon créé : il ne porte aucun numéro tant qu’il n’est pas émis. La liste est triée par date d’émission décroissante : si le brouillon n’apparaît pas en page 1, parcourez les pages suivantes.');
    pageCourante.current = 1;
    setPage(1);
    setFactures([]);
    fermerTrace();
    await charger(1);
  };

  const emettre = async (facture: Facture) => {
    setErreur('');
    setSucces('');
    const res = await apiFetch(`/factures/${facture.id}/emettre`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 409) await charger();
      return setErreur(data.error || 'Émission impossible.');
    }
    setSucces(`Facture ${data.numero} émise et figée.`);
    await charger();
  };

  const annuler = async (facture: Facture) => {
    if (!window.confirm(`Annuler la facture ${facture.numero} ? Cette opération crée immédiatement un avoir total numéroté, conserve les deux documents et ne peut pas être annulée depuis cet écran.`)) return;
    setErreur('');
    setSucces('');
    const res = await apiFetch(`/factures/${facture.id}/annuler`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) return setErreur(data.error || 'Annulation impossible.');
    setSucces(`Facture ${data.numero} annulée ; avoir ${data.avoir?.numero || 'créé'} disponible.`);
    await charger();
  };

  const exporter = async () => {
    setErreur('');
    const res = await apiFetch('/factures/export-comptable.csv');
    if (!res.ok) {
      const data = await res.json();
      return setErreur(data.error || 'Export impossible.');
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'export-ventes.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const telechargerDocument = async (facture: Facture) => {
    setErreur('');
    const res = await apiFetch(`/factures/${facture.id}/document.pdf`);
    if (!res.ok) {
      const data = await res.json();
      return setErreur(data.error || 'Document indisponible.');
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `${facture.numero || 'facture'}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const emissionImpossible = (facture: Facture) => !!derniereDateEmission && facture.dateEmission.slice(0, 10) < derniereDateEmission.slice(0, 10);
  const sources = (origine === 'CHANTIER' ? chantiers : origine === 'INTERVENTION' ? interventions : contrats)
    .filter((source) => !clientSelection || source.clientId === clientSelection || source.client?.id === clientSelection);
  const sourceName = (source: Source) => source.nom || source.titre || source.reference || source.id;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Factures</h1>
          <p className="text-gray-500">Facturation française native et numérotation attribuée à l’émission.</p>
        </div>
        <div className="flex flex-wrap gap-2 sm:shrink-0 sm:justify-end">
          <button className="btn btn-secondary" onClick={() => void charger()}><RefreshCw size={16} /> Actualiser</button>
          <button className="btn btn-secondary" onClick={() => void exporter()}><Download size={16} /> Export comptable</button>
          <button className="btn btn-primary" onClick={ouvrirFormulaire}><FilePlus2 size={16} /> Nouvelle facture</button>
        </div>
      </div>

      {erreur && <p className="text-red-600">{erreur}</p>}
      {erreurListe && <p className="text-red-600">{erreurListe}</p>}
      <p data-testid="derniere-date-facture" className="text-sm text-gray-600">Dernière facture numérotée : {derniereDateEmission ? formatDate(derniereDateEmission) : 'aucune'}.</p>
      {succes && <p className="text-emerald-700">{succes}</p>}

      {factureAvoir && (
        <form className="rounded-xl border border-amber-300 bg-amber-50 p-5 space-y-4" onSubmit={creerAvoirPartiel}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">Nouvel avoir partiel</h2>
              <p className="text-sm text-gray-600">Facture {factureAvoir.numero} du {formatDate(factureAvoir.dateEmission)} — {factureAvoir.client.raisonSociale}</p>
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => setFactureAvoir(null)}>Annuler</button>
          </div>
          <p className="text-sm text-gray-600">Les plafonds cumulés et les taux autorisés sont contrôlés par le serveur lors de la création.</p>
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-medium">Lignes à créditer</h3>
              <button type="button" className="btn btn-secondary" onClick={() => setLignesAvoir((lignesActuelles) => [...lignesActuelles, nouvelleLigne()])}>
                <Plus size={16} /> Ajouter une ligne d’avoir
              </button>
            </div>
            {lignesAvoir.map((ligne, index) => (
              <div key={index} className="grid gap-3 rounded-lg border bg-white p-3 sm:grid-cols-12">
                <input required className="form-input sm:col-span-4" value={ligne.designation} onChange={(e) => modifierLigneAvoir(index, 'designation', e.target.value)} placeholder="Désignation" aria-label={`Désignation ligne avoir ${index + 1}`} />
                <select className="form-input sm:col-span-2" value={ligne.nature} onChange={(e) => modifierLigneAvoir(index, 'nature', e.target.value as NatureLigne)} aria-label={`Nature ligne avoir ${index + 1}`}>
                  <option value="PRESTATION">Prestation</option>
                  <option value="ARTICLE">Article</option>
                </select>
                <input required inputMode="decimal" className="form-input sm:col-span-1" value={ligne.quantite} onChange={(e) => modifierLigneAvoir(index, 'quantite', e.target.value)} placeholder="Qté" aria-label={`Quantité ligne avoir ${index + 1}`} />
                <input required inputMode="decimal" className="form-input sm:col-span-2" value={ligne.prixUnitaireHt} onChange={(e) => modifierLigneAvoir(index, 'prixUnitaireHt', e.target.value)} placeholder="PU HT" aria-label={`Prix unitaire HT ligne avoir ${index + 1}`} />
                <input required inputMode="decimal" className="form-input sm:col-span-1" value={ligne.tauxTva} onChange={(e) => modifierLigneAvoir(index, 'tauxTva', e.target.value)} placeholder="TVA %" aria-label={`TVA ligne avoir ${index + 1}`} />
                <button type="button" className="btn btn-secondary sm:col-span-2" disabled={lignesAvoir.length === 1} onClick={() => supprimerLigneAvoir(index)} aria-label={`Supprimer la ligne d’avoir ${index + 1}`}>
                  <Trash2 size={16} /> Supprimer
                </button>
              </div>
            ))}
          </section>
          <div data-testid="aperçu-avoir" className="grid gap-3 rounded-lg border bg-white p-3 text-sm sm:grid-cols-3">
            <span><strong>Total HT</strong><br />{formatMontant(totauxAvoir.totalHt)}</span>
            <span><strong>TVA</strong><br />{formatMontant(totauxAvoir.totalTva)}</span>
            <span><strong>Total TTC</strong><br />{formatMontant(totauxAvoir.totalTtc)}</span>
          </div>
          <button className="btn btn-primary" type="submit"><Send size={16} /> Créer l’avoir partiel</button>
        </form>
      )}

      {ouvert && (
        <form className="rounded-xl border bg-white p-5 space-y-4" onSubmit={creer}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">Nouveau brouillon</h2>
            <button type="button" className="btn btn-secondary" onClick={() => { requeteClients.current += 1; setOuvert(false); }}>Annuler</button>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <label htmlFor="recherche-client-facture" className="block text-sm font-medium">Rechercher un client</label>
              <input id="recherche-client-facture" type="search" className="form-input w-full" value={rechercheClient} onChange={(e) => chercherClient(e.target.value)} placeholder="Nom commercial, raison sociale ou SIREN" aria-controls="clientId-facture" />
              <select id="clientId-facture" required name="clientId" aria-label="Client de la facture" className="form-input w-full" value={clientSelection} onChange={(e) => setClientSelection(e.target.value)} disabled={rechercheEnCours || Boolean(erreurRechercheClient)}>
                <option value="">Client…</option>
                {(resultatsClients ?? clients).map((client) => <option key={client.id} value={client.id}>{client.raisonSociale}</option>)}
              </select>
              {rechercheEnCours && <p role="status" className="text-sm">Recherche en cours…</p>}
              {erreurRechercheClient && <p role="alert" className="text-sm text-red-700">{erreurRechercheClient}</p>}
              {resultatsClients?.length === 200 && !rechercheEnCours && !erreurRechercheClient && <p role="status" aria-label="Limite des résultats clients" className="text-sm">200 clients maximum affichés ; veuillez affiner votre recherche.</p>}
              {resultatsClients?.length === 0 && !rechercheEnCours && !erreurRechercheClient && <p role="status" className="text-sm">Aucun client actif trouvé.</p>}
            </div>
            {/* Préremplies au jour de la société une fois son fuseau connu : la clé remonte les champs
                à son arrivée, quand le formulaire a été ouvert avant (ils restent désactivés d'ici là). */}
            <input key={`emission-${fuseauHoraire ?? ''}`} required name="dateEmission" disabled={!fuseauHoraire} defaultValue={fuseauHoraire ? companyDateInputValue(fuseauHoraire) : ''} pattern="\d{2}-\d{2}-\d{4}" className="form-input" placeholder={fuseauHoraire ? 'Émission (JJ-MM-AAAA)' : erreurListe ? 'Actualisez la liste' : 'Chargement…'} aria-label="Date d’émission" />
            <input key={`echeance-${fuseauHoraire ?? ''}`} required name="dateEcheance" disabled={!fuseauHoraire} defaultValue={fuseauHoraire ? companyDateInputValue(fuseauHoraire) : ''} pattern="\d{2}-\d{2}-\d{4}" className="form-input" placeholder={fuseauHoraire ? 'Échéance (JJ-MM-AAAA)' : erreurListe ? 'Actualisez la liste' : 'Chargement…'} aria-label="Date d’échéance" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <select name="origine" className="form-input" value={origine} onChange={(e) => setOrigine(e.target.value as Origine)}>
              <option value="HORS_AFFAIRE">Hors affaire — exception motivée</option>
              <option value="CHANTIER">Chantier / affaire</option>
              <option value="INTERVENTION">Intervention SAV</option>
              <option value="CONTRAT">Contrat de maintenance</option>
            </select>
            {origine === 'HORS_AFFAIRE' ? (
              <input required name="motifHorsAffaire" minLength={3} className="form-input" placeholder="Motif obligatoire" />
            ) : (
              <select required name={origine === 'CHANTIER' ? 'chantierId' : origine === 'INTERVENTION' ? 'interventionId' : 'contratMaintenanceId'} className="form-input">
                <option value="">Rattachement…</option>
                {sources.map((source) => <option key={source.id} value={source.id}>{sourceName(source)}</option>)}
              </select>
            )}
          </div>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="font-medium">Lignes de facture</h3>
                <p className="text-sm text-gray-500">Ajoutez prestations et articles. Au moins une ligne est obligatoire.</p>
              </div>
              <button type="button" className="btn btn-secondary" onClick={() => setLignes((lignesActuelles) => [...lignesActuelles, nouvelleLigne()])}>
                <Plus size={16} /> Ajouter une ligne
              </button>
            </div>
            {lignes.map((ligne, index) => (
              <div key={index} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-12">
                <input required className="form-input sm:col-span-4" value={ligne.designation} onChange={(e) => modifierLigne(index, 'designation', e.target.value)} placeholder="Désignation" aria-label={`Désignation ligne ${index + 1}`} />
                <select className="form-input sm:col-span-2" value={ligne.nature} onChange={(e) => modifierLigne(index, 'nature', e.target.value as NatureLigne)} aria-label={`Nature ligne ${index + 1}`}>
                  <option value="PRESTATION">Prestation</option>
                  <option value="ARTICLE">Article</option>
                </select>
                <input required inputMode="decimal" className="form-input sm:col-span-1" value={ligne.quantite} onChange={(e) => modifierLigne(index, 'quantite', e.target.value)} placeholder="Qté" aria-label={`Quantité ligne ${index + 1}`} />
                <input required inputMode="decimal" className="form-input sm:col-span-2" value={ligne.prixUnitaireHt} onChange={(e) => modifierLigne(index, 'prixUnitaireHt', e.target.value)} placeholder="PU HT" aria-label={`Prix unitaire HT ligne ${index + 1}`} />
                <input required inputMode="decimal" className="form-input sm:col-span-1" value={ligne.tauxTva} onChange={(e) => modifierLigne(index, 'tauxTva', e.target.value)} placeholder="TVA %" aria-label={`TVA ligne ${index + 1}`} />
                <button type="button" className="btn btn-secondary sm:col-span-2" disabled={lignes.length === 1} onClick={() => supprimerLigne(index)} title={lignes.length === 1 ? 'Une facture doit conserver au moins une ligne' : 'Supprimer cette ligne'}>
                  <Trash2 size={16} /> Supprimer
                </button>
              </div>
            ))}
          </section>
          <button className="btn btn-primary" type="submit"><Send size={16} /> Créer le brouillon</button>
        </form>
      )}

      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr><th className="p-3">Type / numéro</th><th className="p-3">Client</th><th className="p-3">Émission</th><th className="p-3">Origine</th><th className="p-3">Total TTC</th><th className="p-3">Reste dû</th><th className="p-3">Statut</th><th className="p-3">Actions</th></tr>
          </thead>
          <tbody>
            {factures.map((facture) => (
              <tr key={facture.id} className="border-t">
                <td className="p-3"><strong>{facture.type === 'AVOIR' ? 'Avoir' : 'Facture'}</strong><br />{facture.numero || 'Brouillon'}{facture.factureOrigine?.numero && <span className="block text-xs text-gray-500">Origine : {facture.factureOrigine.numero}</span>}</td>
                <td className="p-3">{facture.client.raisonSociale}</td>
                <td className="p-3">{formatDate(facture.dateEmission)}</td>
                <td className="p-3">{facture.origine === 'HORS_AFFAIRE' ? `Hors affaire — ${facture.motifHorsAffaire || ''}` : facture.origine}</td>
                <td className="p-3">{formatMontant(facture.totalTtc)}</td>
                <td className="p-3">{facture.resteDu === null || facture.resteDu === undefined ? '—' : formatMontant(facture.resteDu)}</td>
                <td className="p-3">{facture.statut}{situationReglement(facture, formatMontant) && <span className="block text-xs text-gray-600">{situationReglement(facture, formatMontant)}</span>}</td>
                <td className="p-3"><div className="flex flex-wrap gap-2">
                  <button className="btn btn-secondary" aria-expanded={factureTraceId === facture.id} aria-controls="origine-facture" onClick={() => factureTraceId === facture.id ? fermerTrace() : void chargerTrace(facture.id)}>Voir l’origine</button>
                  {facture.type === 'FACTURE' && facture.statut === 'BROUILLON' && (emissionImpossible(facture)
                    ? <span className="text-sm text-amber-700"><button className="btn btn-secondary" disabled><Send size={16} /> Émission impossible</button> Date antérieure à la dernière facture numérotée du {formatDate(derniereDateEmission!)}</span>
                    : <button className="btn btn-secondary" onClick={() => void emettre(facture)}><Send size={16} /> Émettre</button>)}
                  {facture.type === 'FACTURE' && ['EMISE', 'REGLEE'].includes(facture.statut) && <button className="btn btn-secondary" onClick={() => ouvrirAvoirPartiel(facture)}><FilePlus2 size={16} /> Créer un avoir partiel</button>}
                  {facture.type === 'FACTURE' && facture.statut === 'EMISE' && <>
                    {(facture.resteDu ?? 0) > 0 && <Link className="btn btn-secondary" to={`/reglements?facture=${facture.id}`}><HandCoins size={16} /> Enregistrer un règlement</Link>}
                    {avoirsPartiels(facture).length
                      ? <span className="self-center text-xs text-gray-500">Annulation totale impossible : {avoirsPartiels(facture).length} avoir(s) partiel(s) déjà émis</span>
                      : (facture.montantRegle ?? 0) > 0
                        ? <span className="self-center text-xs text-gray-500">Annulation totale impossible : un règlement a été reçu</span>
                        : <button className="btn btn-secondary" onClick={() => void annuler(facture)}><Ban size={16} /> Annuler la facture</button>}
                  </>}
                  {facture.statut !== 'BROUILLON' && <button className="btn btn-secondary" onClick={() => void telechargerDocument(facture)}><Download size={16} /> PDF</button>}
                </div></td>
              </tr>
            ))}
            {chargement && !factures.length && <tr><td colSpan={8} role="status" className="p-5 text-center text-gray-500">Chargement des factures…</td></tr>}
            {!chargement && !factures.length && <tr><td colSpan={8} className="p-5 text-center text-gray-500">{erreurListe ? 'Factures indisponibles. Réessayez avec Actualiser.' : 'Aucune facture.'}</td></tr>}
          </tbody>
        </table>
      </div>
      <nav data-testid="pagination-factures" aria-label="Pagination des factures" className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <button type="button" className="btn btn-secondary" disabled={page <= 1} onClick={() => changerPage(page - 1)}>Page précédente</button>
        <span>{total === null ? `Page ${page}` : `Page ${page} sur ${nombrePages} — ${total} document(s)`}</span>
        <button type="button" className="btn btn-secondary" disabled={page >= nombrePages} onClick={() => changerPage(page + 1)}>Page suivante</button>
      </nav>
      {factureTraceId && (
        <section id="origine-facture" role="region" aria-label="Origine de la facture" className="rounded-xl border bg-white p-5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">Origine de la facture</h2>
            <button type="button" className="btn btn-secondary" onClick={fermerTrace}>Fermer</button>
          </div>
          {traceCharge && <p role="status">Chargement de l’origine…</p>}
          {traceErreur && <div role="alert"><p>{traceErreur}</p><button type="button" className="btn btn-secondary" onClick={() => void chargerTrace(factureTraceId)}>Réessayer</button></div>}
          {trace && (
            <div className="space-y-2 text-sm">
              <p><strong>Origine :</strong> {{ CHANTIER: 'Affaire', INTERVENTION: 'Intervention SAV', CONTRAT: 'Contrat de maintenance', HORS_AFFAIRE: 'Hors affaire' }[trace.facture.origine]}</p>
              <p><strong>Client :</strong> {trace.facture.client.raisonSociale}</p>
              {trace.facture.origine === 'HORS_AFFAIRE' && <p><strong>Motif :</strong> {trace.facture.motifHorsAffaire || 'Motif non renseigné'}</p>}
              {trace.facture.intervention && <p><strong>Intervention d’origine :</strong> {trace.facture.intervention.reference} — {trace.facture.intervention.titre}</p>}
              {trace.facture.contratMaintenance && <p><strong>Contrat :</strong> {trace.facture.contratMaintenance.titre}</p>}
              {trace.facture.chantier ? <p><strong>Affaire :</strong> {trace.facture.chantier.nom}{trace.facture.chantier.numeroDevis && ` — ${trace.facture.chantier.numeroDevis}`} <Link className="text-emerald-700 underline" to={`/chantiers/${trace.facture.chantier.id}`}>Voir l’affaire</Link></p>
                : <p>Aucune affaire liée.</p>}
              {trace.devisAmbigu ? <p role="alert"><strong>Devis :</strong> Plusieurs devis correspondent à cette affaire ; aucun lien de devis fiable ne peut être affiché.</p>
                : <p><strong>Devis :</strong> {trace.devis ? `${trace.devis.numero} — ${trace.devis.objet}` : 'Aucun devis lié.'}</p>}
              <div><strong>Interventions liées à l’affaire :</strong> {trace.interventionsLiees.length ? (
                <ul className="list-disc pl-5">{trace.interventionsLiees.map((item) => <li key={item.id}>{item.reference} — {item.titre}</li>)}</ul>
              ) : <span> Aucune intervention liée.</span>}</div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
