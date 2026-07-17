import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';

interface OdooDevis {
  id: number;
  name: string;
  amountUntaxed: number;
  clientName: string | null;
}

const fmtEuro = (n: number) => `${Math.round(n).toLocaleString()} €`;

/**
 * Champ "N° de Devis" avec recherche des devis Odoo Online (lecture seule) : au clic,
 * affiche une liste déroulante (devis les plus récents) ; taper filtre par les premières
 * lettres/chiffres. Sélectionner un devis préremplit aussi le budget global vendu (HT)
 * via `onMontantFound`, le "Dont Matériel" via `onMaterielFound` (sous-total de la section
 * "Matériel" du devis, s'il y en a une), et l'adresse du site via `onAdresseFound`
 * (adresse de livraison du devis, ou à défaut celle du client facturé) — l'utilisateur
 * reste libre de corriger ces valeurs ensuite. Reste un simple champ texte libre si Odoo n'est pas configuré,
 * injoignable, ou si le devis recherché n'existe pas côté Odoo — aucune saisie n'est
 * jamais écrite dans Odoo.
 *
 * `partnerId` (optionnel, id du client Odoo déjà sélectionné) restreint les suggestions
 * aux devis de ce client, sans empêcher de saisir librement un autre numéro.
 */
export function DevisAutocomplete({
  defaultValue = '',
  required = false,
  partnerId,
  onMontantFound,
  onMaterielFound,
  onAdresseFound,
}: {
  defaultValue?: string;
  required?: boolean;
  partnerId?: number | null;
  onMontantFound?: (montant: number) => void;
  onMaterielFound?: (montant: number) => void;
  onAdresseFound?: (adresse: string) => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const [suggestions, setSuggestions] = useState<OdooDevis[]>([]);
  const [odooAvailable, setOdooAvailable] = useState(true);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => {
      const params = new URLSearchParams({ q: value.trim() });
      if (partnerId) params.set('partnerId', String(partnerId));
      apiFetch(`/odoo/devis?${params.toString()}`)
        .then((res) => (res.ok ? res.json() : { odooAvailable: false, devis: [] }))
        .then((data) => {
          setOdooAvailable(!!data.odooAvailable);
          setSuggestions(data.devis || []);
        })
        .catch(() => {
          setOdooAvailable(false);
          setSuggestions([]);
        });
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, open, partnerId]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        name="numeroDevis"
        required={required}
        autoComplete="off"
        className="form-input"
        value={value}
        onChange={(e) => { setValue(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Rechercher un devis Odoo ou saisir librement..."
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full max-h-56 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg text-sm">
          {suggestions.map((d) => (
            <li
              key={d.id}
              className="px-3 py-2 cursor-pointer hover:bg-gray-100"
              onClick={() => {
                setValue(d.name);
                setOpen(false);
                onMontantFound?.(d.amountUntaxed);
                if (onMaterielFound) {
                  apiFetch(`/odoo/devis/${d.id}/materiel`)
                    .then((res) => (res.ok ? res.json() : { montantMateriel: null }))
                    .then((data) => {
                      if (typeof data.montantMateriel === 'number') onMaterielFound(data.montantMateriel);
                    })
                    .catch(() => {});
                }
                if (onAdresseFound) {
                  apiFetch(`/odoo/devis/${d.id}/adresse`)
                    .then((res) => (res.ok ? res.json() : { adresse: null }))
                    .then((data) => {
                      if (typeof data.adresse === 'string' && data.adresse) onAdresseFound(data.adresse);
                    })
                    .catch(() => {});
                }
              }}
            >
              <div className="font-semibold text-gray-800 flex justify-between gap-3">
                <span>{d.name}</span>
                <span className="text-gray-500 font-normal">{fmtEuro(d.amountUntaxed)} HT</span>
              </div>
              {d.clientName && <div className="text-xs text-gray-400">{d.clientName}</div>}
            </li>
          ))}
        </ul>
      )}
      {open && !odooAvailable && suggestions.length === 0 && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg text-xs text-gray-400 italic px-3 py-2">
          Recherche Odoo indisponible — saisie libre.
        </div>
      )}
    </div>
  );
}
