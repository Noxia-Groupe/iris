import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Wallet, RefreshCw, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, Clock3,
  FileText, Banknote, Eye, EyeOff, Search, Archive,
} from 'lucide-react';
import { apiFetch } from '../api';

// Suivi financier : rapprochement entre les affaires vendues côté Odoo et leur règlement.
// Deux angles complémentaires :
//   - « Chantiers suivis » : les chantiers qui ont une fiche dans l'application. Le
//     croisement avec leur avancement compte autant que le montant — un solde ouvert sur un
//     chantier EN COURS est normal, le même solde sur un chantier TERMINÉ appelle une relance.
//   - « Anciens chantiers » : les affaires vendues dans Odoo qui n'ont jamais eu de fiche
//     ici (dossiers antérieurs, interventions facturées directement...). On y traque les
//     impayés oubliés, et la marque « Vu » range ceux dont le solde ouvert est assumé.
//
// Les montants viennent tous d'Odoo, en lecture seule. La marque « Vu » est le seul
// élément écrit, et elle l'est UNIQUEMENT dans cette application.

interface Acquittement {
  le: string;
  par: string | null;
  motif: string | null;
}

interface Paiement {
  id: number;
  reference: string;
  date: string | null;
  montant: number;
  journal: string | null;
  factures: string[];
}

interface Facture {
  id: number;
  numero: string;
  date: string | null;
  dateEcheance: string | null;
  montantTTC: number;
  montantRestantDu: number;
  etatPaiement: string;
  estAvoir: boolean;
  enAttenteRapprochement: boolean;
  comptabilisee: boolean;
  etatMove: string;
}

// Indicateurs financiers communs aux deux listes.
interface Indicateurs {
  numeroDevis: string | null;
  clientOdoo: string | null;
  dateCommande: string | null;
  etatOdoo: string;
  montantTTC: number;
  montantHT: number;
  montantFacture: number;
  montantPaye: number;
  // Part de l'encaissé qui attend son rapprochement bancaire (factures « en cours »).
  montantEnAttenteRapprochement: number;
  // Somme des versements rapprochés, à comparer à l'encaissé (cf. serveur).
  montantVersements: number;
  montantRestant: number;
  pourcentagePaye: number;
  etatReglement: 'SOLDE' | 'PARTIEL' | 'AUCUN';
  dernierPaiement: { date: string | null; montant: number; reference: string } | null;
  nbPaiements: number;
  acquitte: Acquittement | null;
}

interface LigneChantier extends Indicateurs {
  id: string;
  nom: string;
  client: string;
  statut: string;
  termine: boolean;
  odooTrouve: boolean;
}

interface LigneAncien extends Indicateurs {
  numeroDevis: string;
  aTraiter: boolean;
}

interface Detail extends Indicateurs {
  nom?: string;
  termine?: boolean;
  factures: Facture[];
  paiements: Paiement[];
}

const FILTRES_SUIVIS = [
  { value: 'EN_COURS', label: 'Chantiers en cours' },
  { value: 'TERMINE', label: 'Chantiers terminés' },
  { value: 'TOUS', label: 'Tous' },
];

const FILTRES_ANCIENS = [
  { value: 'A_TRAITER', label: 'À traiter' },
  { value: 'VUS', label: 'Marqués vus' },
  { value: 'TOUS', label: 'Tous' },
];

// Nombre de lignes rendues d'un coup : le parc dépasse le millier d'affaires, toutes les
// afficher d'emblée rendrait la page lourde sans rien apporter — les lignes qui comptent
// sont triées en tête.
const PAS_AFFICHAGE = 100;

const fmtEuro = (n: number) =>
  n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('fr-FR') : '—');

// Libellés lisibles des états de paiement Odoo (payment_state), qui restent techniques.
const ETAT_FACTURE: Record<string, string> = {
  not_paid: 'Non payée',
  in_payment: 'Encaissée, à rapprocher en banque',
  paid: 'Payée',
  partial: 'Partiellement payée',
  reversed: 'Annulée par un avoir',
  invoicing_legacy: 'Ancienne facturation',
};

const ETAT_ODOO: Record<string, string> = { sale: 'Bon de commande', done: 'Verrouillé' };

// Une facture non comptabilisée n'entre dans aucun total, mais reste affichée : elle
// explique à quoi se rattachent des versements qui, sinon, sembleraient orphelins.
const ETAT_MOVE: Record<string, string> = { draft: 'Brouillon', cancel: 'Annulée' };

/**
 * Barre de progression du règlement. Volontairement distincte de <ProgressMeter/>, dont
 * la sémantique de couleur est inversée pour un paiement : ici, arriver à 100 % est
 * l'objectif, pas un dépassement à signaler.
 */
const BarreReglement = ({ pourcentage, solde }: { pourcentage: number; solde: boolean }) => {
  const largeur = Math.min(100, Math.max(0, pourcentage));
  return (
    <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden shadow-inner">
      <div
        className="h-full rounded-full transition-all duration-700 ease-out"
        style={{ width: `${largeur}%`, backgroundColor: solde ? '#16a34a' : largeur > 0 ? '#0251a1' : '#e5e7eb' }}
      />
    </div>
  );
};

const BadgeReglement = ({ etat }: { etat: Indicateurs['etatReglement'] }) => {
  const styles: Record<string, string> = {
    SOLDE: 'bg-green-100 text-green-700',
    PARTIEL: 'bg-blue-100 text-blue-700',
    AUCUN: 'bg-gray-100 text-gray-500',
  };
  const labels: Record<string, string> = { SOLDE: 'Soldé', PARTIEL: 'Partiel', AUCUN: 'Aucun paiement' };
  return <span className={`text-xs font-semibold px-2 py-1 rounded ${styles[etat]}`}>{labels[etat]}</span>;
};

const BadgeChantier = ({ termine }: { termine: boolean }) => (
  <span className={`text-xs font-semibold px-2 py-1 rounded ${termine ? 'bg-purple-100 text-purple-700' : 'bg-amber-100 text-amber-700'}`}>
    {termine ? 'Terminé' : 'En cours'}
  </span>
);

const BadgeVu = ({ acquitte }: { acquitte: Acquittement }) => (
  <span
    className="text-xs font-semibold px-2 py-1 rounded bg-slate-200 text-slate-700 flex items-center gap-1"
    title={`Marqué vu le ${fmtDate(acquitte.le)}${acquitte.par ? ` par ${acquitte.par}` : ''}${acquitte.motif ? ` — ${acquitte.motif}` : ''}`}
  >
    <Eye size={12} /> Vu
  </span>
);

/**
 * Qualifie le reste à encaisser. Sur un chantier suivi, l'avancement fait la différence :
 * un solde ouvert est un encaissement à venir tant que le chantier tourne, un impayé une
 * fois terminé. Sur un dossier ancien, la marque « Vu » joue ce rôle.
 */
type Contexte = 'EN_COURS' | 'TERMINE' | 'ANCIEN';

const ResteAEncaisser = ({ ligne, contexte }: { ligne: Indicateurs; contexte: Contexte }) => {
  if (ligne.etatReglement === 'SOLDE') {
    return (
      <div className="flex items-center gap-2 text-green-700">
        <CheckCircle2 size={16} className="shrink-0" />
        <span className="text-sm font-semibold">Entièrement réglé</span>
      </div>
    );
  }
  if (ligne.acquitte) {
    return (
      <div className="flex items-center gap-2 text-slate-600">
        <Eye size={16} className="shrink-0" />
        <span className="text-sm font-semibold">
          Reste {fmtEuro(ligne.montantRestant)} — marqué vu{ligne.acquitte.par ? ` par ${ligne.acquitte.par}` : ''} le {fmtDate(ligne.acquitte.le)}
          {ligne.acquitte.motif ? ` : ${ligne.acquitte.motif}` : ''}
        </span>
      </div>
    );
  }
  if (contexte === 'EN_COURS') {
    return (
      <div className="flex items-center gap-2 text-amber-700">
        <Clock3 size={16} className="shrink-0" />
        <span className="text-sm font-semibold">
          Paiement à venir : {fmtEuro(ligne.montantRestant)} — chantier encore en cours
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-red-700">
      <AlertTriangle size={16} className="shrink-0" />
      <span className="text-sm font-semibold">
        Reste à encaisser : {fmtEuro(ligne.montantRestant)} —{' '}
        {contexte === 'TERMINE'
          ? 'chantier terminé, paiement à relancer'
          : "affaire close côté Odoo, paiement à relancer ou à marquer vu"}
      </span>
    </div>
  );
};

/** Pose ou retire la marque « Vu » sur un devis. N'écrit jamais rien dans Odoo. */
const BoutonAcquittement = ({
  numeroDevis,
  acquitte,
  onChange,
}: {
  numeroDevis: string;
  acquitte: Acquittement | null;
  onChange: (numeroDevis: string, acquitte: Acquittement | null) => void;
}) => {
  const [enCours, setEnCours] = useState(false);

  const basculer = async () => {
    setEnCours(true);
    try {
      if (acquitte) {
        const res = await apiFetch(`/suivi-financier/acquittements/${encodeURIComponent(numeroDevis)}`, { method: 'DELETE' });
        if (res.ok) onChange(numeroDevis, null);
        return;
      }
      const motif = window.prompt(
        `Marquer ${numeroDevis} comme vu — le solde restant est connu et assumé.\n\nMotif (facultatif : retenue de garantie, geste commercial, écriture ancienne…) :`,
        '',
      );
      if (motif === null) return; // annulé
      const res = await apiFetch(`/suivi-financier/acquittements/${encodeURIComponent(numeroDevis)}`, {
        method: 'PUT',
        body: JSON.stringify({ motif }),
      });
      if (res.ok) {
        const data = await res.json();
        onChange(numeroDevis, data.acquitte);
      } else {
        const d = await res.json().catch(() => ({}));
        alert(d.error || "Impossible d'enregistrer la marque « Vu ».");
      }
    } catch {
      alert('Impossible de joindre le serveur.');
    } finally {
      setEnCours(false);
    }
  };

  return (
    <button
      type="button"
      disabled={enCours}
      onClick={(e) => { e.stopPropagation(); basculer(); }}
      title={acquitte ? 'Retirer la marque « Vu »' : 'Marquer ce dossier comme vu (aucune écriture dans Odoo)'}
      className={`text-sm px-3 py-1.5 rounded font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-40 ${
        acquitte ? 'bg-slate-200 hover:bg-slate-300 text-slate-700' : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
      }`}
    >
      {acquitte ? <><EyeOff size={14} /> Retirer « Vu »</> : <><Eye size={14} /> Marquer vu</>}
    </button>
  );
};

/** Fiche détaillée : factures émises et versements reçus. */
const DetailDevis = ({ path, contexte }: { path: string; contexte: Contexte }) => {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    let annule = false;
    apiFetch(path)
      .then(async (res) => {
        const data = await res.json();
        if (annule) return;
        if (!res.ok) setErreur(data.error || 'Détail indisponible.');
        else setDetail(data);
      })
      .catch(() => { if (!annule) setErreur('Impossible de joindre le serveur.'); });
    return () => { annule = true; };
  }, [path]);

  if (erreur) return <div className="p-4 text-sm text-red-700 bg-red-50 rounded">{erreur}</div>;
  if (!detail) return <div className="p-4 text-sm text-gray-400 italic">Chargement du détail…</div>;

  return (
    <div className="p-4 bg-gray-50 border-t border-gray-100 flex flex-col gap-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <div className="text-xs text-muted uppercase">Client (Odoo)</div>
          <div className="font-bold text-gray-800">{detail.clientOdoo || '—'}</div>
        </div>
        <div>
          <div className="text-xs text-muted uppercase">Montant vendu (TTC)</div>
          <div className="font-bold text-gray-800">{fmtEuro(detail.montantTTC)}</div>
        </div>
        <div>
          <div className="text-xs text-muted uppercase">Facturé</div>
          <div className="font-bold text-gray-800">{fmtEuro(detail.montantFacture)}</div>
        </div>
        <div>
          <div className="text-xs text-muted uppercase">Encaissé</div>
          <div className="font-bold text-green-700">{fmtEuro(detail.montantPaye)}</div>
          {detail.montantEnAttenteRapprochement > 0 && (
            <div className="text-xs text-blue-700 mt-0.5">
              dont {fmtEuro(detail.montantEnAttenteRapprochement)} en attente de rapprochement bancaire
            </div>
          )}
        </div>
      </div>

      <ResteAEncaisser ligne={detail} contexte={contexte} />

      <div>
        <div className="flex items-center gap-2 text-sm font-bold text-gray-700 mb-2">
          <FileText size={16} /> Factures émises ({detail.factures.length})
        </div>
        {detail.factures.length === 0 ? (
          <p className="text-sm text-gray-400 italic">Aucune facture comptabilisée pour ce devis.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left border-collapse bg-white border rounded">
              <thead>
                <tr className="bg-gray-50 text-xs uppercase text-gray-500 border-b">
                  <th className="px-3 py-2 font-semibold">Numéro</th>
                  <th className="px-3 py-2 font-semibold">Date</th>
                  <th className="px-3 py-2 font-semibold">Échéance</th>
                  <th className="px-3 py-2 font-semibold text-right">Montant TTC</th>
                  <th className="px-3 py-2 font-semibold text-right">Restant dû</th>
                  <th className="px-3 py-2 font-semibold">État</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {detail.factures.map((f) => (
                  <tr key={f.id} className={f.comptabilisee ? '' : 'bg-gray-50 text-gray-400'}>
                    <td className="px-3 py-2 font-semibold text-gray-800">
                      {f.numero}
                      {f.estAvoir && <span className="ml-2 text-xs font-semibold px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded">Avoir</span>}
                      {!f.comptabilisee && (
                        <span className="ml-2 text-xs font-semibold px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded">
                          {ETAT_MOVE[f.etatMove] || 'Non comptabilisée'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-600">{fmtDate(f.date)}</td>
                    <td className="px-3 py-2 text-gray-600">{fmtDate(f.dateEcheance)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{fmtEuro(f.montantTTC)}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${!f.comptabilisee ? 'text-gray-400' : Math.abs(f.montantRestantDu) > 0.01 ? 'text-amber-700' : 'text-green-700'}`}>
                      {f.comptabilisee ? fmtEuro(f.montantRestantDu) : '—'}
                    </td>
                    <td className={`px-3 py-2 ${f.enAttenteRapprochement ? 'text-blue-700' : 'text-gray-600'}`}>
                      {f.comptabilisee ? (ETAT_FACTURE[f.etatPaiement] || f.etatPaiement) : 'Hors totaux'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail.factures.some((f) => !f.comptabilisee) && (
              <p className="text-xs text-muted mt-2">
                Les factures grisées ne sont pas comptabilisées dans Odoo (brouillon ou annulation) : elles n'entrent
                dans aucun total, mais sont listées car des versements peuvent y être rattachés.
              </p>
            )}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center gap-2 text-sm font-bold text-gray-700 mb-2">
          <Banknote size={16} /> Versements reçus ({detail.paiements.length})
        </div>
        {detail.paiements.length === 0 ? (
          <p className="text-sm text-gray-400 italic">Aucun versement rapproché pour ce devis.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left border-collapse bg-white border rounded">
              <thead>
                <tr className="bg-gray-50 text-xs uppercase text-gray-500 border-b">
                  <th className="px-3 py-2 font-semibold">Date</th>
                  <th className="px-3 py-2 font-semibold">Référence</th>
                  <th className="px-3 py-2 font-semibold">Journal</th>
                  <th className="px-3 py-2 font-semibold">Facture(s) réglée(s)</th>
                  <th className="px-3 py-2 font-semibold text-right">Montant</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {detail.paiements.map((p) => (
                  <tr key={p.id}>
                    <td className="px-3 py-2 text-gray-600">{fmtDate(p.date)}</td>
                    <td className="px-3 py-2 font-semibold text-gray-800">{p.reference}</td>
                    <td className="px-3 py-2 text-gray-600">{p.journal || '—'}</td>
                    <td className="px-3 py-2 text-gray-600">{p.factures.join(', ') || '—'}</td>
                    <td className="px-3 py-2 text-right font-semibold text-green-700">{fmtEuro(p.montant)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {Math.abs(detail.montantVersements - detail.montantPaye) > 1 && (
              <p className="text-xs text-muted mt-2">
                Total des versements rapprochés : <strong>{fmtEuro(detail.montantVersements)}</strong>, contre{' '}
                <strong>{fmtEuro(detail.montantPaye)}</strong> d'encaissé retenu ici. L'écart vient de versements lettrés
                sur une facture non comptabilisée (ci-dessus) ou partagés avec une autre commande : c'est la
                comptabilité des factures qui fait foi pour la progression du règlement.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/** Colonne centrale commune aux deux listes : progression du règlement et dernier versement. */
const ColonnesReglement = ({ ligne }: { ligne: Indicateurs }) => (
  <>
    <div className="flex-1 min-w-0">
      <div className="flex justify-between items-baseline mb-1 gap-2 text-sm">
        <span className="font-semibold text-gray-700">
          {fmtEuro(ligne.montantPaye)} <span className="text-muted font-normal">sur {fmtEuro(ligne.montantTTC)}</span>
        </span>
        <span className="font-bold text-gray-800">{Math.round(ligne.pourcentagePaye)} %</span>
      </div>
      <BarreReglement pourcentage={ligne.pourcentagePaye} solde={ligne.etatReglement === 'SOLDE'} />
      {ligne.etatReglement !== 'SOLDE' && (
        <div className="text-xs text-amber-700 font-semibold mt-1">Reste {fmtEuro(ligne.montantRestant)}</div>
      )}
      {ligne.montantEnAttenteRapprochement > 0 && (
        <div className="text-xs text-blue-700 mt-1">
          dont {fmtEuro(ligne.montantEnAttenteRapprochement)} à rapprocher en banque
        </div>
      )}
    </div>

    <div className="lg:w-52 shrink-0 text-sm">
      {ligne.dernierPaiement ? (
        <div className="text-muted">
          Dernier versement : <strong className="text-gray-700">{fmtEuro(ligne.dernierPaiement.montant)}</strong>
          <br />le {fmtDate(ligne.dernierPaiement.date)}
        </div>
      ) : (
        <div className="text-muted">Aucun versement enregistré</div>
      )}
    </div>
  </>
);

const SuiviFinancier = () => {
  // Onglet principal : chantiers suivis dans l'application, ou anciens dossiers Odoo.
  const [vue, setVue] = useState<'SUIVIS' | 'ANCIENS'>('SUIVIS');
  const [filtreSuivis, setFiltreSuivis] = useState('EN_COURS');
  const [filtreAnciens, setFiltreAnciens] = useState('A_TRAITER');
  const [chantiers, setChantiers] = useState<LigneChantier[]>([]);
  const [anciens, setAnciens] = useState<LigneAncien[]>([]);
  const [resumeAnciens, setResumeAnciens] = useState({ total: 0, aTraiter: 0, vus: 0, tronque: false });
  const [sansDevis, setSansDevis] = useState(0);
  const [odooAvailable, setOdooAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState('');
  const [ouvert, setOuvert] = useState<string | null>(null);
  const [recherche, setRecherche] = useState('');
  const [visibles, setVisibles] = useState(PAS_AFFICHAGE);

  const charger = useCallback(async (forcer = false) => {
    setLoading(true);
    setErreur('');
    const refresh = forcer ? '&refresh=1' : '';
    try {
      const url = vue === 'SUIVIS'
        ? `/suivi-financier?statut=${filtreSuivis}${refresh}`
        : `/suivi-financier/anciens?filtre=${filtreAnciens}${refresh}`;
      const res = await apiFetch(url);
      const data = await res.json();
      if (!res.ok) {
        setErreur(data.error || 'Chargement impossible.');
        setChantiers([]);
        setAnciens([]);
        return;
      }
      setOdooAvailable(data.odooAvailable !== false);
      if (vue === 'SUIVIS') {
        setChantiers(data.chantiers || []);
        setSansDevis(data.sansDevis || 0);
      } else {
        setAnciens(data.commandes || []);
        setResumeAnciens({ total: data.total || 0, aTraiter: data.aTraiter || 0, vus: data.vus || 0, tronque: !!data.tronque });
      }
    } catch {
      setErreur('Impossible de joindre le serveur.');
    } finally {
      setLoading(false);
    }
  }, [vue, filtreSuivis, filtreAnciens]);

  useEffect(() => { charger(); }, [charger]);
  useEffect(() => { setVisibles(PAS_AFFICHAGE); setOuvert(null); }, [vue, filtreSuivis, filtreAnciens, recherche]);

  // Marque « Vu » posée ou retirée : les deux listes portent le même devis, on les tient
  // toutes les deux à jour plutôt que de recharger la page entière.
  const majAcquittement = (numeroDevis: string, acquitte: Acquittement | null) => {
    setChantiers((liste) => liste.map((l) => (l.numeroDevis === numeroDevis ? { ...l, acquitte } : l)));
    setAnciens((liste) => liste.map((l) => (
      l.numeroDevis === numeroDevis
        ? { ...l, acquitte, aTraiter: l.etatReglement !== 'SOLDE' && !acquitte }
        : l
    )));
  };

  const lignesFiltrees = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    const filtrer = <T extends { numeroDevis: string | null; clientOdoo: string | null }>(liste: T[], nom?: (l: T) => string) =>
      !q ? liste : liste.filter((l) =>
        (l.numeroDevis || '').toLowerCase().includes(q) ||
        (l.clientOdoo || '').toLowerCase().includes(q) ||
        (nom ? nom(l).toLowerCase().includes(q) : false));
    return vue === 'SUIVIS'
      ? { chantiers: filtrer(chantiers, (l) => `${l.nom} ${l.client}`), anciens: [] as LigneAncien[] }
      : { chantiers: [] as LigneChantier[], anciens: filtrer(anciens) };
  }, [vue, chantiers, anciens, recherche]);

  const listeCourante: Indicateurs[] = vue === 'SUIVIS' ? lignesFiltrees.chantiers : lignesFiltrees.anciens;

  // Totaux de la sélection affichée : le montant encore à encaisser est la vraie question
  // de cet écran, autant y répondre d'emblée sans faire la somme des lignes à la main.
  const totalVendu = listeCourante.reduce((s, l) => s + l.montantTTC, 0);
  const totalPaye = listeCourante.reduce((s, l) => s + l.montantPaye, 0);
  const aRelancer = vue === 'SUIVIS'
    ? lignesFiltrees.chantiers.filter((l) => l.termine && l.etatReglement !== 'SOLDE' && !l.acquitte).length
    : lignesFiltrees.anciens.filter((l) => l.aTraiter).length;

  return (
    <div>
      <div className="flex flex-wrap justify-between items-center gap-3 mb-4 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-primary-dark m-0 leading-tight flex items-center gap-2">
            <Wallet size={22} /> Suivi financier
          </h1>
          <p className="text-sm text-muted mt-1">
            Rapprochement des affaires vendues avec leur règlement dans Odoo : acomptes versés, restant dû, impayés.
          </p>
        </div>
        <button onClick={() => charger(true)} disabled={loading} className="btn btn-secondary flex items-center gap-2">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Actualiser
        </button>
      </div>

      {/* Bascule entre les chantiers suivis dans l'application et les dossiers anciens. */}
      <div className="flex gap-2 mb-3 overflow-x-auto pb-1">
        <button
          onClick={() => setVue('SUIVIS')}
          className={`btn flex items-center gap-2 ${vue === 'SUIVIS' ? 'btn-primary' : 'bg-white'}`}
        >
          <Wallet size={16} /> Chantiers suivis
        </button>
        <button
          onClick={() => setVue('ANCIENS')}
          className={`btn flex items-center gap-2 ${vue === 'ANCIENS' ? 'btn-primary' : 'bg-white'}`}
        >
          <Archive size={16} /> Anciens chantiers (non suivis)
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4 items-center">
        {(vue === 'SUIVIS' ? FILTRES_SUIVIS : FILTRES_ANCIENS).map((f) => {
          const actif = (vue === 'SUIVIS' ? filtreSuivis : filtreAnciens) === f.value;
          return (
            <button
              key={f.value}
              onClick={() => (vue === 'SUIVIS' ? setFiltreSuivis(f.value) : setFiltreAnciens(f.value))}
              className={`btn ${actif ? 'btn-primary' : 'bg-white'}`}
            >
              {f.label}
            </button>
          );
        })}
        <div className="relative ml-auto">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
            placeholder="Rechercher un devis ou un client…"
            className="form-input py-2 w-72"
            style={{ paddingLeft: '2.25rem' }}
          />
        </div>
      </div>

      {vue === 'ANCIENS' && (
        <p className="text-sm text-muted mb-4">
          Affaires <strong>vendues dans Odoo</strong> (bon de commande ou dossier verrouillé) qui n'ont jamais eu de fiche
          chantier dans l'application. Un solde ouvert n'est pas toujours une anomalie : la marque{' '}
          <strong>« Vu »</strong> classe le dossier avec les affaires réglées, sans rien écrire dans Odoo, et se retire
          d'un clic.
        </p>
      )}

      {!odooAvailable && (
        <div className="mb-4 p-4 rounded-xl border border-amber-300 bg-amber-50 text-amber-900 flex items-start gap-3">
          <AlertTriangle size={20} className="shrink-0 mt-0.5" />
          <div className="text-sm">
            <strong className="block">Connexion Odoo indisponible.</strong>
            Les montants facturés et encaissés proviennent d'Odoo : sans cette connexion, l'écran ne peut rien afficher.
            Vérifiez les variables ODOO_URL, ODOO_DB, ODOO_USERNAME et ODOO_API_KEY côté serveur.
          </div>
        </div>
      )}

      {erreur && <div className="mb-4 p-3 bg-red-50 text-red-700 rounded text-sm">{erreur}</div>}

      {odooAvailable && !loading && listeCourante.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
            <div className="text-xs text-muted uppercase">Vendu (TTC)</div>
            <div className="text-xl font-bold text-gray-800">{fmtEuro(totalVendu)}</div>
          </div>
          <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
            <div className="text-xs text-muted uppercase">Encaissé</div>
            <div className="text-xl font-bold text-green-700">{fmtEuro(totalPaye)}</div>
          </div>
          <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
            <div className="text-xs text-muted uppercase">Restant à encaisser</div>
            <div className="text-xl font-bold text-amber-700">{fmtEuro(totalVendu - totalPaye)}</div>
          </div>
          <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
            <div className="text-xs text-muted uppercase">{vue === 'SUIVIS' ? 'Terminés non soldés' : 'Dossiers à traiter'}</div>
            <div className={`text-xl font-bold ${aRelancer > 0 ? 'text-red-700' : 'text-gray-800'}`}>{aRelancer}</div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-muted animate-pulse">Interrogation d'Odoo…</div>
      ) : listeCourante.length === 0 ? (
        <div className="bg-white p-8 rounded-xl shadow-sm border border-gray-100 text-center text-muted">
          {vue === 'ANCIENS' && filtreAnciens === 'A_TRAITER'
            ? 'Aucun dossier ancien en attente de règlement. Tout est soldé ou marqué vu.'
            : 'Aucune affaire à afficher pour cette sélection.'}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {vue === 'SUIVIS' && lignesFiltrees.chantiers.slice(0, visibles).map((l) => {
            const estOuvert = ouvert === l.id;
            return (
              <div key={l.id} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setOuvert(estOuvert ? null : l.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOuvert(estOuvert ? null : l.id); }}
                  className="w-full text-left p-4 hover:bg-gray-50 transition-colors flex flex-col lg:flex-row lg:items-center gap-3 cursor-pointer"
                >
                  <div className="flex items-start gap-3 lg:w-1/3 min-w-0">
                    {estOuvert ? <ChevronDown size={18} className="shrink-0 mt-1 text-gray-400" /> : <ChevronRight size={18} className="shrink-0 mt-1 text-gray-400" />}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-bold px-2 py-0.5 bg-primary/10 text-primary rounded font-mono">{l.numeroDevis}</span>
                        <BadgeChantier termine={l.termine} />
                        {l.acquitte && <BadgeVu acquitte={l.acquitte} />}
                      </div>
                      <div className="font-bold text-gray-800 truncate mt-1">{l.nom}</div>
                      <div className="text-sm text-muted truncate">{l.clientOdoo || l.client}</div>
                    </div>
                  </div>

                  {l.odooTrouve ? (
                    <>
                      <ColonnesReglement ligne={l} />
                      <div className="lg:w-40 shrink-0 flex flex-col items-start gap-2">
                        <BadgeReglement etat={l.etatReglement} />
                        {l.etatReglement !== 'SOLDE' && l.numeroDevis && (
                          <BoutonAcquittement numeroDevis={l.numeroDevis} acquitte={l.acquitte} onChange={majAcquittement} />
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="flex-1 flex items-center gap-2 text-amber-700 text-sm">
                      <AlertTriangle size={16} className="shrink-0" />
                      Devis introuvable dans Odoo — vérifiez le numéro saisi sur le chantier.
                    </div>
                  )}
                </div>

                {estOuvert && l.odooTrouve && <DetailDevis path={`/suivi-financier/${l.id}`} contexte={l.termine ? 'TERMINE' : 'EN_COURS'} />}
              </div>
            );
          })}

          {vue === 'ANCIENS' && lignesFiltrees.anciens.slice(0, visibles).map((l) => {
            const estOuvert = ouvert === l.numeroDevis;
            return (
              <div
                key={l.numeroDevis}
                className={`bg-white rounded-xl shadow-sm border overflow-hidden ${l.aTraiter ? 'border-red-200' : 'border-gray-100'}`}
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setOuvert(estOuvert ? null : l.numeroDevis)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOuvert(estOuvert ? null : l.numeroDevis); }}
                  className="w-full text-left p-4 hover:bg-gray-50 transition-colors flex flex-col lg:flex-row lg:items-center gap-3 cursor-pointer"
                >
                  <div className="flex items-start gap-3 lg:w-1/3 min-w-0">
                    {estOuvert ? <ChevronDown size={18} className="shrink-0 mt-1 text-gray-400" /> : <ChevronRight size={18} className="shrink-0 mt-1 text-gray-400" />}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-bold px-2 py-0.5 bg-primary/10 text-primary rounded font-mono">{l.numeroDevis}</span>
                        <span className="text-xs font-semibold px-2 py-1 rounded bg-gray-100 text-gray-500">
                          {ETAT_ODOO[l.etatOdoo] || l.etatOdoo}
                        </span>
                        {l.acquitte && <BadgeVu acquitte={l.acquitte} />}
                      </div>
                      <div className="font-bold text-gray-800 truncate mt-1">{l.clientOdoo || 'Client inconnu'}</div>
                      <div className="text-sm text-muted">Commande du {fmtDate(l.dateCommande)}</div>
                    </div>
                  </div>

                  <ColonnesReglement ligne={l} />

                  <div className="lg:w-40 shrink-0 flex flex-col items-start gap-2">
                    <BadgeReglement etat={l.etatReglement} />
                    {l.etatReglement !== 'SOLDE' && (
                      <BoutonAcquittement numeroDevis={l.numeroDevis} acquitte={l.acquitte} onChange={majAcquittement} />
                    )}
                  </div>
                </div>

                {estOuvert && <DetailDevis path={`/suivi-financier/devis/${encodeURIComponent(l.numeroDevis)}`} contexte="ANCIEN" />}
              </div>
            );
          })}

          {listeCourante.length > visibles && (
            <button onClick={() => setVisibles((v) => v + PAS_AFFICHAGE)} className="btn bg-white self-center mt-2">
              Afficher {Math.min(PAS_AFFICHAGE, listeCourante.length - visibles)} affaires de plus
              <span className="text-muted font-normal"> ({visibles} sur {listeCourante.length})</span>
            </button>
          )}
        </div>
      )}

      {vue === 'SUIVIS' && sansDevis > 0 && (
        <p className="text-xs text-muted mt-4">
          {sansDevis} chantier{sansDevis > 1 ? 's' : ''} de cette sélection {sansDevis > 1 ? 'sont exclus' : 'est exclu'} du
          rapprochement, faute de numéro de devis renseigné.
        </p>
      )}

      {vue === 'ANCIENS' && !loading && (
        <p className="text-xs text-muted mt-4">
          {resumeAnciens.total} affaire{resumeAnciens.total > 1 ? 's' : ''} non suivie{resumeAnciens.total > 1 ? 's' : ''} dans
          l'application · {resumeAnciens.aTraiter} à traiter · {resumeAnciens.vus} marquée{resumeAnciens.vus > 1 ? 's' : ''} vue
          {resumeAnciens.vus > 1 ? 's' : ''}.
          {resumeAnciens.tronque && ' La lecture Odoo a atteint son plafond : les affaires les plus anciennes ne sont pas listées.'}
        </p>
      )}
    </div>
  );
};

export default SuiviFinancier;
