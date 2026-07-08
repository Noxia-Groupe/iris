import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';

interface OdooClient {
  id: number;
  name: string;
  email: string | null;
  city: string | null;
}

/**
 * Champ "Client" avec recherche des contacts Odoo Online (lecture seule) : au clic,
 * affiche une liste déroulante (premiers clients par ordre alphabétique) ; taper filtre
 * la liste par les premières lettres. Reste un simple champ texte libre si Odoo n'est
 * pas configuré, injoignable, ou si le client recherché n'existe pas côté Odoo — aucune
 * saisie n'est jamais écrite dans Odoo.
 */
export function ClientAutocomplete({ defaultValue = '', required = false }: { defaultValue?: string; required?: boolean }) {
  const [value, setValue] = useState(defaultValue);
  const [suggestions, setSuggestions] = useState<OdooClient[]>([]);
  const [odooAvailable, setOdooAvailable] = useState(true);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => {
      apiFetch(`/odoo/clients?q=${encodeURIComponent(value.trim())}`)
        .then((res) => (res.ok ? res.json() : { odooAvailable: false, clients: [] }))
        .then((data) => {
          setOdooAvailable(!!data.odooAvailable);
          setSuggestions(data.clients || []);
        })
        .catch(() => {
          setOdooAvailable(false);
          setSuggestions([]);
        });
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, open]);

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
        name="client"
        required={required}
        autoComplete="off"
        className="form-input"
        value={value}
        onChange={(e) => { setValue(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Rechercher un client Odoo ou saisir librement..."
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full max-h-56 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg text-sm">
          {suggestions.map((c) => (
            <li
              key={c.id}
              className="px-3 py-2 cursor-pointer hover:bg-gray-100"
              onClick={() => { setValue(c.name); setOpen(false); }}
            >
              <div className="font-semibold text-gray-800">{c.name}</div>
              {(c.email || c.city) && (
                <div className="text-xs text-gray-400">{[c.email, c.city].filter(Boolean).join(' · ')}</div>
              )}
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
