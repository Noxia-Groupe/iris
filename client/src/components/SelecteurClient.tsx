import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';

export type ClientResume = { id: string; raisonSociale: string };

// Plafond de GET /api/clients : au-delà, il faut affiner la recherche.
const LIMITE_CLIENTS = 200;

type Props = {
  id: string;
  name?: string;
  label: string;
  valeur: string;
  onChange: (client: ClientResume | null) => void;
  required?: boolean;
};

/**
 * Choix d'un client actif, y compris au-delà des 200 premiers (#111) : la liste initiale montre
 * les 200 premiers par raison sociale, et une recherche serveur (`GET /api/clients?q=`) retrouve
 * les autres. Les réponses périmées sont ignorées. Modifier la recherche désélectionne le client :
 * le formulaire ne garde jamais un client qui n'est plus proposé.
 */
export function SelecteurClient({ id, name, label, valeur, onChange, required }: Props) {
  const [initiaux, setInitiaux] = useState<ClientResume[]>([]);
  const [chargementInitial, setChargementInitial] = useState(true);
  const [erreurInitiale, setErreurInitiale] = useState('');
  const [recherche, setRecherche] = useState('');
  const [resultats, setResultats] = useState<ClientResume[] | null>(null);
  const [rechercheEnCours, setRechercheEnCours] = useState(false);
  const [erreurRecherche, setErreurRecherche] = useState('');
  const requete = useRef(0);

  useEffect(() => {
    let actif = true;
    void (async () => {
      try {
        const response = await apiFetch('/clients');
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || 'Chargement des clients impossible.');
        if (actif) setInitiaux(Array.isArray(data) ? data : (data.clients || []));
      } catch (e) {
        if (actif) setErreurInitiale(e instanceof Error ? e.message : 'Chargement des clients impossible.');
      } finally {
        if (actif) setChargementInitial(false);
      }
    })();
    return () => { actif = false; };
  }, []);

  useEffect(() => {
    const q = recherche.trim();
    if (!q) return;
    const numero = requete.current;
    const minuteur = window.setTimeout(async () => {
      try {
        const response = await apiFetch(`/clients?q=${encodeURIComponent(q)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || 'Recherche impossible.');
        if (numero === requete.current) setResultats(data.clients || []);
      } catch (e) {
        if (numero === requete.current) setErreurRecherche(e instanceof Error ? e.message : 'Recherche impossible.');
      } finally {
        if (numero === requete.current) setRechercheEnCours(false);
      }
    }, 250);
    return () => window.clearTimeout(minuteur);
  }, [recherche]);

  const chercher = (texte: string) => {
    requete.current += 1;
    setRecherche(texte);
    setResultats(texte.trim() ? [] : null);
    setRechercheEnCours(Boolean(texte.trim()));
    setErreurRecherche('');
    onChange(null);
  };

  const enRecherche = resultats !== null;
  const options = resultats ?? initiaux;
  const enCours = enRecherche ? rechercheEnCours : chargementInitial;
  const erreur = enRecherche ? erreurRecherche : erreurInitiale;
  const choisir = (clientId: string) => onChange(options.find((c) => c.id === clientId) ?? null);

  return (
    <div>
      <label htmlFor={`${id}-recherche`} className="text-sm font-medium">Rechercher un client</label>
      <input id={`${id}-recherche`} type="search" className="form-input mt-1" value={recherche} onChange={(e) => chercher(e.target.value)} placeholder="Nom commercial, raison sociale ou SIREN" aria-controls={id} />
      <select id={id} name={name} aria-label={label} required={required} className="form-input mt-1" value={valeur} disabled={enCours || Boolean(erreur)} onChange={(e) => choisir(e.target.value)}>
        <option value="">Client concerné</option>
        {options.map((client) => <option key={client.id} value={client.id}>{client.raisonSociale}</option>)}
      </select>
      {enCours && <p role="status" className="text-sm text-gray-500">{enRecherche ? 'Recherche en cours…' : 'Chargement des clients…'}</p>}
      {erreur && <p role="alert" className="text-sm text-red-600">{erreur}</p>}
      {!enCours && !erreur && options.length >= LIMITE_CLIENTS && (
        <p role="status" aria-label="Limite des résultats clients" className="text-sm text-gray-500">
          {enRecherche ? `${LIMITE_CLIENTS} clients maximum affichés ; veuillez affiner votre recherche.` : `Seuls les ${LIMITE_CLIENTS} premiers clients sont listés : recherchez les autres par leur nom ou leur SIREN.`}
        </p>
      )}
      {enRecherche && !enCours && !erreur && options.length === 0 && <p role="status" className="text-sm text-gray-500">Aucun client actif trouvé.</p>}
    </div>
  );
}
