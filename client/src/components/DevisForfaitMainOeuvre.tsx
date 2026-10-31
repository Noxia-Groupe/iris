import { useEffect, useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { apiFetch } from '../api';
import type { FicheCatalogueDevis, LigneDevisSaisie } from '../lib/catalogueDevis';
import {
  FORFAITS, LIBELLES_FORFAIT, LIBELLES_QUANTITE_FORFAIT, LIBELLES_TARIF_FORFAIT, TARIFS_FORFAIT, ligneForfait, prixDuForfait,
  type ForfaitMainOeuvre, type TarifForfait,
} from '../lib/forfaitMainOeuvre';
import { formatPrix } from '../lib/tempsPasse';

// Bloc « Main d'œuvre au jour ou à la demi-journée » (réponses de Nelson du 30-10-2026, « Option de la main
// d'œuvre » et « Prix à part ») : une main d'œuvre active du catalogue, son forfait (jour ou demi-journée) et
// son tarif (hors contrat ou sous contrat), avec le prix de la fiche affiché ; le bouton ajoute une ligne d'une
// unité, au prix du moment, que le serveur fixe et fige. Une main d'œuvre sans prix de la demi-journée ne se
// vend pas à la demi-journée : l'ajout reste inactif, avec la raison. Le bloc n'est pas proposé sur un devis au
// temps passé (l'appelant ne l'affiche pas).
export function ChoixForfaitMainOeuvre({ onAjouter }: { onAjouter: (ligne: LigneDevisSaisie) => void }) {
  const [mainsOeuvre, setMainsOeuvre] = useState<FicheCatalogueDevis[] | null>(null);
  const [erreur, setErreur] = useState('');
  const [ficheId, setFicheId] = useState('');
  const [forfait, setForfait] = useState<ForfaitMainOeuvre>('JOUR');
  const [tarif, setTarif] = useState<TarifForfait>('HORS_CONTRAT');
  const requete = useRef(0);

  useEffect(() => {
    const numero = ++requete.current;
    void (async () => {
      try {
        const response = await apiFetch('/devis/catalogue?mainOeuvre=1');
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || 'Lecture des mains d’œuvre impossible.');
        if (numero === requete.current) { setMainsOeuvre(data); setErreur(''); }
      } catch (e) {
        if (numero === requete.current) setErreur(e instanceof Error ? e.message : 'Lecture des mains d’œuvre impossible.');
      }
    })();
    return () => { requete.current += 1; };
  }, []);

  const fiche = mainsOeuvre?.find((f) => f.id === ficheId) ?? null;
  const prix = fiche ? prixDuForfait(fiche, forfait, tarif) : null;
  const ajouter = () => {
    const ligne = fiche ? ligneForfait(fiche, forfait, tarif) : null;
    if (ligne) onAjouter(ligne);
  };

  return <fieldset className="border rounded-lg p-3 space-y-2 bg-sky-50/40" aria-labelledby="titre-forfait-main-oeuvre">
    <legend id="titre-forfait-main-oeuvre" className="text-sm font-medium flex items-center gap-2 px-1"><CalendarDays size={16} aria-hidden="true"/>Main d’œuvre au jour ou à la demi-journée</legend>
    <p className="text-xs text-gray-600">Le prix est celui de la main d’œuvre au catalogue (forfait jour ou prix de la demi-journée), figé sur la ligne ; la quantité se compte en jours ou en demi-journées entiers : une demi-journée s’ajoute en ligne à la demi-journée.</p>
    {erreur && <p role="alert" className="text-sm text-red-600">{erreur}</p>}
    {mainsOeuvre && mainsOeuvre.length === 0 && <p role="status" className="text-sm text-gray-600">Aucune main d’œuvre active au catalogue : l’administration la crée dans Catalogue &gt; Main d’œuvre.</p>}
    <div className="grid gap-2 sm:grid-cols-3">
      <label className="text-sm">Main d’œuvre
        <select aria-label="Main d’œuvre au forfait" className="mt-1 w-full border rounded px-2 py-2 bg-white" value={ficheId} disabled={!mainsOeuvre} onChange={(e) => setFicheId(e.target.value)}>
          <option value="">Choisir une main d’œuvre…</option>
          {(mainsOeuvre ?? []).map((f) => <option key={f.id} value={f.id}>{f.nom} · Réf. {f.reference}</option>)}
        </select>
      </label>
      <label className="text-sm">Forfait
        <select aria-label="Forfait de la main d’œuvre" className="mt-1 w-full border rounded px-2 py-2 bg-white" value={forfait} onChange={(e) => setForfait(e.target.value as ForfaitMainOeuvre)}>
          {FORFAITS.map((f) => <option key={f} value={f}>{LIBELLES_FORFAIT[f]}</option>)}
        </select>
      </label>
      <label className="text-sm">Tarif
        <select aria-label="Tarif du forfait" className="mt-1 w-full border rounded px-2 py-2 bg-white" value={tarif} onChange={(e) => setTarif(e.target.value as TarifForfait)}>
          {TARIFS_FORFAIT.map((t) => {
            const prixTarif = fiche ? prixDuForfait(fiche, forfait, t) : null;
            return <option key={t} value={t}>{LIBELLES_TARIF_FORFAIT[t]}{fiche ? ` — ${prixTarif === null ? 'non réglé' : `${formatPrix(prixTarif)} HT`}` : ''}</option>;
          })}
        </select>
      </label>
    </div>
    {fiche && prix === null && <p role="status" className="text-sm text-amber-800">Cette main d’œuvre n’a pas de prix de la demi-journée {tarif === 'SOUS_CONTRAT' ? 'sous contrat' : 'hors contrat'} : elle ne se vend pas à la demi-journée tant que l’administration ne l’a pas saisi (Catalogue &gt; Main d’œuvre).</p>}
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="btn border" disabled={!fiche || prix === null} onClick={ajouter}>Ajouter la ligne au jour ou à la demi-journée</button>
      {fiche && prix !== null && <span className="text-sm text-gray-600" data-testid="prix-forfait-propose">{formatPrix(prix)} HT {forfait === 'JOUR' ? 'par jour' : 'par demi-journée'}</span>}
    </div>
  </fieldset>;
}

// Ligne au jour ou à la demi-journée dans le formulaire : désignation et quantité modifiables, prix, TVA et
// unité fixés par la main d'œuvre, affichés sans être saisis, comme la ligne au temps passé. La quantité est un
// nombre entier de jours ou de demi-journées, au moins 1 : une demi-journée s'ajoute en ligne à la demi-journée.
export function LigneForfaitMainOeuvre({ ligne, onDesignation, onQuantite, onRetirer }: {
  ligne: LigneDevisSaisie;
  onDesignation: (valeur: string) => void;
  onQuantite: (valeur: string) => void;
  onRetirer: (() => void) | null;
}) {
  const forfait: ForfaitMainOeuvre = ligne.forfaitMainOeuvre ?? 'JOUR';
  const tarif = ligne.tarifForfait ? LIBELLES_TARIF_FORFAIT[ligne.tarifForfait].toLowerCase() : '';
  return <div className="space-y-2 border-b border-gray-100 pb-3" aria-label="Ligne au jour ou à la demi-journée" role="group">
    <label className="text-sm block">Désignation<input required className="mt-1 w-full border rounded px-2 py-2" value={ligne.designation} onChange={(e) => onDesignation(e.target.value)}/>
      <span className="block text-xs text-gray-500 mt-0.5">Main d’œuvre {forfait === 'JOUR' ? 'au jour' : 'à la demi-journée'}, {tarif}{ligne.reference ? ` · Réf. ${ligne.reference}` : ''}</span>
    </label>
    <div className="grid gap-2 items-end grid-cols-2 md:grid-cols-[150px_1fr_1fr_1fr_auto]">
      <label className="text-sm">{LIBELLES_QUANTITE_FORFAIT[forfait]}<input required min="1" step="1" type="number" inputMode="numeric" className="mt-1 w-full border rounded px-2 py-2" value={ligne.quantite} onChange={(e) => onQuantite(e.target.value)}/></label>
      <p className="text-sm"><span className="block text-gray-600">{forfait === 'JOUR' ? 'Prix à la journée' : 'Prix de la demi-journée'}</span><strong data-testid="prix-forfait">{formatPrix(ligne.prixUnitaireHt)} HT</strong></p>
      <p className="text-sm"><span className="block text-gray-600">TVA</span>{String(ligne.tauxTva).replace('.', ',')} %</p>
      <p className="text-sm"><span className="block text-gray-600">Unité</span>{ligne.unite}</p>
      {onRetirer && <button type="button" className="btn border" onClick={onRetirer}>Retirer</button>}
    </div>
  </div>;
}
