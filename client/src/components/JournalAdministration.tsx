import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import { useCompanyTimezone } from '../companyTimezoneContext';
import { companyDateInputValue, formatCompanyDateTime } from '../lib/dateFormatting';
import { roleLabel } from '../roles';

// Journal des paramètres et des droits (lot (a), décision de Nelson du 13-10-2026) : qui a changé
// quoi, avant et après, filtrable par date, type et auteur, avec export CSV. Le serveur ne renvoie
// à un simple administrateur ni les entrées qui concernent un compte super administrateur, ni
// l'historique des clés d'intégration.

type Entree = {
  id: string;
  createdAt: string;
  domaine: 'DROITS' | 'REGLAGES';
  type: string;
  action: string;
  cibleLibelle: string | null;
  avant: Record<string, unknown> | null;
  apres: Record<string, unknown> | null;
  detail: string | null;
  auteurNom: string;
};

type Reponse = {
  entrees: Entree[];
  total: number;
  page: number;
  parPage: number;
  auteurs: { id: string; nom: string }[];
  conservationJours: number;
};

type Filtres = { du: string; au: string; type: string; auteur: string };

const TYPES_JOURNAL: Record<string, string> = {
  COMPTE: 'Droits d’un compte',
  PARAMETRES: 'Paramètres (marge, acompte, alertes, destinataires)',
  MODULES: 'Modules',
  REMUNERATION: 'Rémunération commerciale',
  PRIME_COMMERCIAL: 'Prime mensuelle d’un commercial',
  SOCIETE: 'Identité de la société',
  CLE_INTEGRATION: 'Clés d’intégration',
  PARTAGE_PLANNING: 'Partage public du planning',
  CONSERVATION_JOURNAL: 'Conservation du journal',
  MAIN_OEUVRE: 'Mains d’œuvre (prix de vente)',
  INTERVENANT: 'Fiche intervenant',
};

const ACTIONS_JOURNAL: Record<string, string> = {
  CREATION: 'Création',
  SUPPRESSION: 'Suppression',
  MODIFICATION: 'Modification',
  TYPE_COMPTE: 'Type de compte',
  RATTACHEMENT: 'Rattachement hiérarchique',
  AUSSI_COMMERCIAL: '« Aussi commercial »',
  PERMISSIONS: 'Permissions',
  ACCES_FINANCE: 'Accès financier',
  ACTIVATION: 'Activation',
  DESACTIVATION: 'Désactivation',
  REVOCATION: 'Révocation',
  PUBLICATION: 'Publication',
  NOUVEAU_LIEN: 'Nouveau lien',
  FICHE_INTERVENANT: 'Fiche intervenant',
  LOGO_DOCUMENTS: 'Logo des documents',
  LOGO_DOCUMENTS_RETIRE: 'Logo des documents retiré',
  REACTIVATION: 'Réactivation',
  PASSAGE_MAIN_OEUVRE: 'Prestation passée en main d’œuvre',
  RETRAIT_MAIN_OEUVRE: 'Main d’œuvre redevenue prestation',
  RATTACHEMENT_MAIN_OEUVRE: 'Main d’œuvre rattachée',
};

const FILTRES_VIDES: Filtres = { du: '', au: '', type: '', auteur: '' };

// Libellés des champs journalisés ; un champ absent de la liste garde son nom technique.
const CHAMPS_JOURNAL: Record<string, string> = {
  role: 'Type de compte',
  estCommercial: 'Aussi commercial',
  accesFinance: 'Accès financier',
  permissions: 'Permissions',
  actif: 'Actif',
  responsableHierarchique: 'Responsable hiérarchique',
  ficheIntervenant: 'Fiche intervenant',
  margeCommercialeActive: 'Marge commerciale',
  tauxAcompteDefaut: 'Acompte par défaut (%)',
  seuilMargeFaible: 'Seuil de marge faible (%)',
  joursSansSaisie: 'Jours sans saisie',
  anticipationVisitesJours: 'Anticipation des visites (jours)',
  rentabiliteConducteur: 'Rentabilité : conducteur',
  rentabiliteHierarchie: 'Rentabilité : hiérarchie',
  rentabiliteDirecteurs: 'Rentabilité : directeurs',
  planningActif: 'Planning',
  suiviAdministratif: 'Prime de suivi administratif',
  journalConservationJours: 'Conservation (jours)',
  logoDocuments: 'Logo des documents',
  estMainOeuvre: 'Main d’œuvre',
  reference: 'Référence',
  nom: 'Nom',
  description: 'Description',
  categorie: 'Catégorie',
  tauxTva: 'TVA (%)',
  prixVenteHt: 'Prix de vente HT à l’heure, hors contrat',
  prixJourHorsContratHt: 'Prix de vente HT au forfait jour, hors contrat',
  prixHeureSousContratHt: 'Prix de vente HT à l’heure, sous contrat',
  prixJourSousContratHt: 'Prix de vente HT au forfait jour, sous contrat',
  heuresParJour: 'Heures par jour',
  unite: 'Unité',
  prixAchatHt: 'Prix d’achat HT',
  dureeIndicativeMin: 'Durée indicative (min)',
  mainOeuvre: 'Main d’œuvre',
};

function lisible(valeur: unknown, champ?: string): string {
  if (champ === 'role' && typeof valeur === 'string') return roleLabel(valeur);
  if (valeur === null || valeur === undefined || valeur === '') return '—';
  if (typeof valeur === 'boolean') return valeur ? 'oui' : 'non';
  if (Array.isArray(valeur)) return valeur.length ? valeur.map((v) => lisible(v)).join(', ') : 'aucune';
  if (typeof valeur === 'object') return JSON.stringify(valeur);
  return String(valeur);
}

function Valeurs({ valeurs }: { valeurs: Record<string, unknown> | null }) {
  if (!valeurs || !Object.keys(valeurs).length) return <span className="text-gray-400">—</span>;
  return (
    <ul className="space-y-0.5">
      {Object.entries(valeurs).map(([champ, valeur]) => (
        <li key={champ}><span className="text-gray-500" title={champ}>{CHAMPS_JOURNAL[champ] ?? champ} :</span> <span className="break-all">{lisible(valeur, champ)}</span></li>
      ))}
    </ul>
  );
}

function parametresRequete(filtres: Filtres, page?: number): string {
  const parametres = new URLSearchParams();
  for (const [cle, valeur] of Object.entries(filtres)) if (valeur.trim()) parametres.set(cle, valeur.trim());
  if (page && page > 1) parametres.set('page', String(page));
  const texte = parametres.toString();
  return texte ? `?${texte}` : '';
}

export default function JournalAdministration({ isSuper }: { isSuper: boolean }) {
  const fuseau = useCompanyTimezone();
  const [brouillon, setBrouillon] = useState<Filtres>(FILTRES_VIDES);
  const [filtres, setFiltres] = useState<Filtres>(FILTRES_VIDES);
  const [page, setPage] = useState(1);
  const [donnees, setDonnees] = useState<Reponse | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [conservation, setConservation] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const derniereRequete = useRef(0);

  const charger = useCallback(async () => {
    const requete = ++derniereRequete.current;
    try {
      const res = await apiFetch(`/journal-administration${parametresRequete(filtres, page)}`);
      const data = await res.json();
      if (requete !== derniereRequete.current) return;
      if (!res.ok) {
        setErreur(data.error || 'Le journal n’a pas pu être chargé.');
        return;
      }
      setErreur(null);
      setDonnees(data);
      setConservation((actuelle) => actuelle || String(data.conservationJours));
    } catch {
      if (requete === derniereRequete.current) setErreur('Impossible de joindre le serveur.');
    }
  }, [filtres, page]);

  useEffect(() => { charger(); }, [charger]);

  const appliquer = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setFiltres({ ...brouillon });
  };

  const exporter = async () => {
    setErreur(null);
    try {
      const res = await apiFetch(`/journal-administration/export.csv${parametresRequete(filtres)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErreur(data.error || 'Export impossible.');
        return;
      }
      const nom = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'journal-parametres-droits.csv';
      const url = URL.createObjectURL(await res.blob());
      const lien = document.createElement('a');
      lien.href = url;
      lien.download = nom;
      lien.click();
      URL.revokeObjectURL(url);
    } catch {
      setErreur('Impossible de joindre le serveur.');
    }
  };

  const enregistrerConservation = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    const res = await apiFetch('/journal-administration/conservation', { method: 'PUT', body: JSON.stringify({ jours: conservation }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErreur(data.error || 'Enregistrement impossible.');
      return;
    }
    setErreur(null);
    setMessage(`Durée de conservation : ${data.conservationJours} jours.`);
    setConservation(String(data.conservationJours));
    await charger();
  };

  const pages = donnees ? Math.max(1, Math.ceil(donnees.total / donnees.parPage)) : 1;

  return (
    <section className="card space-y-4" aria-labelledby="journal-administration">
      <div>
        <h2 id="journal-administration" className="text-lg font-bold">Journal des paramètres et des droits</h2>
        <p className="text-sm text-gray-500">
          Qui a changé quoi, avant et après : réglages de l’instance et droits des comptes.
          {donnees && <> Les entrées sont conservées {donnees.conservationJours} jours.</>}
        </p>
      </div>

      <form onSubmit={appliquer} className="grid gap-3 md:grid-cols-5 items-end" aria-label="Filtres du journal">
        <label className="text-sm">Du
          <input className="form-input" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" value={brouillon.du} onChange={(e) => setBrouillon({ ...brouillon, du: e.target.value })} />
        </label>
        <label className="text-sm">Au
          <input className="form-input" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" value={brouillon.au} onChange={(e) => setBrouillon({ ...brouillon, au: e.target.value })} />
        </label>
        <label className="text-sm">Type
          <select className="form-input" value={brouillon.type} onChange={(e) => setBrouillon({ ...brouillon, type: e.target.value })}>
            <option value="">Tous</option>
            {Object.entries(TYPES_JOURNAL)
              .filter(([type]) => isSuper || type !== 'CLE_INTEGRATION')
              .map(([type, libelle]) => <option key={type} value={type}>{libelle}</option>)}
          </select>
        </label>
        <label className="text-sm">Auteur
          <select className="form-input" value={brouillon.auteur} onChange={(e) => setBrouillon({ ...brouillon, auteur: e.target.value })}>
            <option value="">Tous</option>
            {(donnees?.auteurs ?? []).map((auteur) => <option key={`${auteur.id}-${auteur.nom}`} value={auteur.id}>{auteur.nom}</option>)}
          </select>
        </label>
        <div className="flex gap-2">
          <button className="btn btn-primary" type="submit">Filtrer</button>
          <button className="btn bg-white" type="button" onClick={exporter}>Exporter en CSV</button>
        </div>
      </form>

      {erreur && <p role="alert" className="p-3 bg-red-50 text-red-800 rounded text-sm">{erreur}</p>}
      {message && <p role="status" className="p-3 bg-green-50 text-green-800 rounded text-sm">{message}</p>}

      {!donnees ? (
        <p className="text-sm text-gray-400 italic">Chargement…</p>
      ) : donnees.entrees.length === 0 ? (
        <p className="text-sm text-gray-500">Aucune entrée pour ces filtres.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Entrées du journal">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="py-2 pr-3">Date</th><th className="py-2 pr-3">Auteur</th><th className="py-2 pr-3">Type</th>
                <th className="py-2 pr-3">Action</th><th className="py-2 pr-3">Cible</th><th className="py-2 pr-3">Avant</th><th className="py-2 pr-3">Après</th>
              </tr>
            </thead>
            <tbody>
              {donnees.entrees.map((entree) => (
                <tr key={entree.id} className="border-b align-top">
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {companyDateInputValue(fuseau, new Date(entree.createdAt))} {formatCompanyDateTime(entree.createdAt, fuseau, { hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="py-2 pr-3">{entree.auteurNom}</td>
                  <td className="py-2 pr-3">{TYPES_JOURNAL[entree.type] ?? entree.type}</td>
                  <td className="py-2 pr-3">{ACTIONS_JOURNAL[entree.action] ?? entree.action}</td>
                  <td className="py-2 pr-3">{entree.cibleLibelle ?? '—'}{entree.detail && <div className="text-xs text-gray-500">{entree.detail}</div>}</td>
                  <td className="py-2 pr-3"><Valeurs valeurs={entree.avant} /></td>
                  <td className="py-2 pr-3"><Valeurs valeurs={entree.apres} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between mt-3 text-sm">
            <span>{donnees.total} entrée{donnees.total > 1 ? 's' : ''}</span>
            <div className="flex items-center gap-2">
              <button className="btn bg-white" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Précédente</button>
              <span>Page {page} sur {pages}</span>
              <button className="btn bg-white" type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>Suivante</button>
            </div>
          </div>
        </div>
      )}

      {isSuper && (
        <form onSubmit={enregistrerConservation} className="flex flex-wrap items-end gap-2 border-t pt-4" aria-label="Conservation du journal">
          <label className="text-sm">Durée de conservation (jours, 90 au plus)
            <input className="form-input w-32" type="number" min={1} max={90} required value={conservation} onChange={(e) => setConservation(e.target.value)} />
          </label>
          <button className="btn bg-white" type="submit">Enregistrer la durée</button>
          <p className="text-xs text-gray-500 w-full">
            Réduire la durée supprime aussitôt les entrées plus anciennes. La durée conforme au RGPD reste à faire valider par le cabinet juridique.
          </p>
        </form>
      )}
    </section>
  );
}
