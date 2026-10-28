import { useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { apiFetch } from '../api';
import { ligneVierge, type FicheCatalogueDevis, type LigneDevisSaisie } from '../lib/catalogueDevis';
import { LIBELLES_TARIF, TARIFS_TEMPS_PASSE, dureeTempsPasse, formatPrix, ligneTempsPasse, prixDuTarif, type ReglagesTempsPasse, type TarifTempsPasse } from '../lib/tempsPasse';

const LIGNE_VIDE: LigneDevisSaisie = { designation: '', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 0, tauxTva: 20 };

// Case « Devis au temps passé » et choix de la ligne de main d'œuvre au temps passé (décisions de Nelson
// des 24 et 25-10-2026) : une main d'œuvre active du catalogue et son tarif à l'heure, hors contrat ou
// sous contrat, avec le prix affiché ; la ligne est créée à une heure (sa quantité suit ensuite le minimum
// et le pas du devis, cf. LigneTempsPasse). Changer de main d'œuvre ou de
// tarif crée une nouvelle ligne, au prix du moment ; une ligne existante garde le sien, figé.
export function ChoixTempsPasse({ auTempsPasse, lignes, onChange }: {
  auTempsPasse: boolean;
  lignes: LigneDevisSaisie[];
  onChange: (auTempsPasse: boolean, lignes: LigneDevisSaisie[]) => void;
}) {
  const [mainsOeuvre, setMainsOeuvre] = useState<FicheCatalogueDevis[] | null>(null);
  const [erreur, setErreur] = useState('');
  const requete = useRef(0);
  const ligne = lignes.find((l) => l.tempsPasse) ?? null;

  useEffect(() => {
    if (!auTempsPasse || mainsOeuvre) return;
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
  }, [auTempsPasse, mainsOeuvre]);

  const sansLigneTempsPasse = lignes.filter((l) => !l.tempsPasse);
  const cocher = (coche: boolean) => {
    if (coche) return onChange(true, lignes);
    // Décocher retire la ligne au temps passé ; un devis garde au moins une ligne.
    onChange(false, sansLigneTempsPasse.length ? sansLigneTempsPasse : [{ ...LIGNE_VIDE }]);
  };
  const choisir = (ficheId: string, tarif: TarifTempsPasse) => {
    const fiche = mainsOeuvre?.find((f) => f.id === ficheId);
    const nouvelle = fiche ? ligneTempsPasse(fiche, tarif) : null;
    if (!nouvelle) return;
    // Comme une fiche du catalogue, la ligne remplace une ligne encore vierge ; elle vient en tête.
    const autres = sansLigneTempsPasse.filter((l) => !ligneVierge(l));
    onChange(true, [nouvelle, ...autres]);
  };
  const ficheChoisie = ligne?.catalogueId ? mainsOeuvre?.find((f) => f.id === ligne.catalogueId) ?? null : null;
  const tarif: TarifTempsPasse = ligne?.tarifTempsPasse ?? 'HORS_CONTRAT';

  return <fieldset className="border rounded-lg p-3 space-y-2 bg-amber-50/40">
    <legend className="sr-only">Devis au temps passé</legend>
    <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" className="w-4 h-4" checked={auTempsPasse} onChange={(e) => cocher(e.target.checked)}/><Clock size={16} aria-hidden="true"/><span>Devis au temps passé</span></label>
    {auTempsPasse && <>
      <p className="text-xs text-gray-600">Une ligne de main d’œuvre au temps passé, au prix de l’heure choisi, figé et compté dans le total ; le matériel s’ajoute en lignes à part. Le temps minimum facturé et le pas du temps passé, réglés par la société, sont figés sur le devis.</p>
      {erreur && <p role="alert" className="text-sm text-red-600">{erreur}</p>}
      {mainsOeuvre && mainsOeuvre.length === 0 && <p role="status" className="text-sm text-gray-600">Aucune main d’œuvre active au catalogue : l’administration la crée dans Catalogue &gt; Main d’œuvre.</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-sm">Main d’œuvre
          <select aria-label="Main d’œuvre au temps passé" className="mt-1 w-full border rounded px-2 py-2 bg-white" value={ligne?.catalogueId ?? ''} disabled={!mainsOeuvre} onChange={(e) => choisir(e.target.value, tarif)}>
            <option value="">Choisir une main d’œuvre…</option>
            {(mainsOeuvre ?? []).map((fiche) => <option key={fiche.id} value={fiche.id}>{fiche.nom} · Réf. {fiche.reference}</option>)}
            {ligne?.catalogueId && mainsOeuvre && !ficheChoisie && <option value={ligne.catalogueId}>{ligne.reference ? `Réf. ${ligne.reference}` : 'Main d’œuvre'} (désactivée depuis)</option>}
          </select>
        </label>
        <label className="text-sm">Prix de l’heure
          <select aria-label="Tarif de l’heure" className="mt-1 w-full border rounded px-2 py-2 bg-white" value={tarif} disabled={!ficheChoisie} onChange={(e) => choisir(ligne!.catalogueId!, e.target.value as TarifTempsPasse)}>
            {TARIFS_TEMPS_PASSE.map((t) => {
              const prix = ficheChoisie ? prixDuTarif(ficheChoisie, t) : null;
              return <option key={t} value={t}>{LIBELLES_TARIF[t]}{prix !== null ? ` — ${formatPrix(prix)} HT` : ''}</option>;
            })}
          </select>
        </label>
      </div>
    </>}
  </fieldset>;
}

// Ligne au temps passé dans le formulaire : désignation et quantité modifiables, prix, TVA et unité fixés
// par la main d'œuvre, affichés sans être saisis. La quantité vaut le temps minimum facturé, puis des
// tranches du pas : ceux figés sur le devis modifié, sinon ceux réglés par la société, que le serveur
// applique (`reglages` null) ; un devis antérieur au lot « facture au temps passé » garde une heure au
// moins, au millième.
export function LigneTempsPasse({ ligne, reglages, onDesignation, onQuantite }: {
  ligne: LigneDevisSaisie;
  reglages: ReglagesTempsPasse | null;
  onDesignation: (valeur: string) => void;
  onQuantite: (valeur: string) => void;
}) {
  const ancien = reglages !== null && reglages.tempsMinimumMinutes === null;
  const minimum = reglages?.tempsMinimumMinutes ?? null;
  const pas = reglages?.pasTempsPasseMinutes ?? null;
  const libelle = ancien ? 'Heures (1 minimum)' : minimum !== null ? `Heures (${dureeTempsPasse(minimum)} minimum)` : 'Heures';
  const champ = ancien ? { min: 1, step: 0.001 } : minimum !== null && pas !== null ? { min: minimum / 60, step: pas / 60 } : { min: 0.25, step: 0.25 };
  const aide = ancien
    ? 'Une heure au moins ; la quantité se modifie vers le haut. Le prix est celui de la main d’œuvre, figé sur le devis.'
    : minimum !== null && pas !== null
      ? `Le temps minimum facturé du devis (${dureeTempsPasse(minimum)}), puis des tranches de ${pas} minutes. Le prix est celui de la main d’œuvre, figé sur le devis.`
      : 'Le temps minimum facturé, puis des tranches du pas, tous deux réglés par la société et figés sur le devis (par exemple 1 ; 1,25 ; 1,5 pour un minimum d’une heure et un pas de 15 minutes). Le prix est celui de la main d’œuvre, figé sur le devis.';
  return <div className="space-y-2 border-b border-gray-100 pb-3" aria-label="Ligne au temps passé" role="group">
    <label className="text-sm block">Désignation<input required className="mt-1 w-full border rounded px-2 py-2" value={ligne.designation} onChange={(e) => onDesignation(e.target.value)}/>
      <span className="block text-xs text-gray-500 mt-0.5">Main d’œuvre au temps passé{ligne.reference ? ` · Réf. ${ligne.reference}` : ''} · {ligne.tarifTempsPasse ? LIBELLES_TARIF[ligne.tarifTempsPasse] : ''}</span>
    </label>
    <div className="grid gap-2 items-end grid-cols-2 md:grid-cols-[150px_1fr_1fr_1fr]">
      <label className="text-sm">{libelle}<input required aria-describedby="aide-quantite-temps-passe" min={champ.min} step={champ.step} type="number" inputMode="decimal" className="mt-1 w-full border rounded px-2 py-2" value={ligne.quantite} onChange={(e) => onQuantite(e.target.value)}/></label>
      <p className="text-sm"><span className="block text-gray-600">Prix de l’heure</span><strong data-testid="prix-heure-temps-passe">{formatPrix(ligne.prixUnitaireHt)} HT</strong></p>
      <p className="text-sm"><span className="block text-gray-600">TVA</span>{String(ligne.tauxTva).replace('.', ',')} %</p>
      <p className="text-sm"><span className="block text-gray-600">Unité</span>{ligne.unite ?? 'heure'}</p>
    </div>
    <p id="aide-quantite-temps-passe" className="text-xs text-gray-500">{aide}</p>
  </div>;
}
