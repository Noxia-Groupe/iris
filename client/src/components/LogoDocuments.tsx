import { useEffect, useRef, useState } from 'react';
import { ImageUp, Trash2 } from 'lucide-react';
import { apiFetch } from '../api';

// Mêmes bornes que le serveur (server/src/domaines/documents/logo.ts) : le contrôle ici évite
// seulement d'envoyer un fichier que le serveur refuserait.
const TAILLE_MAX = 500 * 1024;
const TYPES = ['image/png', 'image/jpeg'];

type Societe = Record<string, unknown> & { logoDocumentId: string | null };

const lireEnDataUrl = (fichier: File) => new Promise<string>((resolve, reject) => {
  const lecteur = new FileReader();
  lecteur.onload = () => resolve(String(lecteur.result));
  lecteur.onerror = () => reject(lecteur.error);
  lecteur.readAsDataURL(fichier);
});

/**
 * Logo imprimé sur les documents (lot 6a-1). Il est copié avec l'identité de la société sur chaque
 * pièce à son émission : le remplacer ou le retirer ne change pas les pièces déjà émises.
 */
export default function LogoDocuments({ logoDocumentId, modifiable, apresChangement }: {
  logoDocumentId: string | null;
  modifiable: boolean;
  apresChangement: (societe: Societe) => void;
}) {
  const [apercu, setApercu] = useState<string | null>(null);
  const [erreur, setErreur] = useState('');
  const [message, setMessage] = useState('');
  const [enCours, setEnCours] = useState(false);
  const champ = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!logoDocumentId) { setApercu(null); return undefined; }
    let actif = true;
    let url: string | null = null;
    void (async () => {
      try {
        const res = await apiFetch('/company/logo');
        if (!res.ok) { if (actif) setApercu(null); return; }
        url = URL.createObjectURL(await res.blob());
        if (actif) setApercu(url); else URL.revokeObjectURL(url);
      } catch {
        if (actif) setErreur('Aperçu du logo indisponible.');
      }
    })();
    return () => { actif = false; if (url) URL.revokeObjectURL(url); };
  }, [logoDocumentId]);

  const envoyer = async (fichier: File | undefined) => {
    setErreur(''); setMessage('');
    if (!fichier) return;
    if (!TYPES.includes(fichier.type)) { setErreur('Le logo doit être un fichier PNG ou JPEG.'); return; }
    if (fichier.size > TAILLE_MAX) { setErreur('Logo trop volumineux (limite : 500 Ko).'); return; }
    setEnCours(true);
    try {
      const res = await apiFetch('/company/logo', { method: 'PUT', body: JSON.stringify({ fichier: await lireEnDataUrl(fichier) }) });
      const data = await res.json();
      if (!res.ok) { setErreur(data.error || 'Enregistrement du logo impossible.'); return; }
      apresChangement(data);
      setMessage('Logo enregistré. Il sera copié sur les prochaines pièces émises.');
    } catch {
      setErreur('Impossible de joindre le serveur.');
    } finally {
      setEnCours(false);
      if (champ.current) champ.current.value = '';
    }
  };

  const retirer = async () => {
    setErreur(''); setMessage(''); setEnCours(true);
    try {
      const res = await apiFetch('/company/logo', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) { setErreur(data.error || 'Retrait du logo impossible.'); return; }
      apresChangement(data);
      setMessage('Logo retiré. Les pièces déjà émises gardent le leur.');
    } catch {
      setErreur('Impossible de joindre le serveur.');
    } finally {
      setEnCours(false);
    }
  };

  return (
    <section className="space-y-3" aria-labelledby="titre-logo-documents">
      <h2 id="titre-logo-documents" className="font-semibold flex items-center gap-2 text-gray-800"><ImageUp size={18} /> Logo des documents</h2>
      <p className="text-sm text-gray-500">PNG ou JPEG, 500 Ko et 2 000 pixels de côté au plus. Il est copié sur chaque facture et chaque avoir à son émission : le remplacer ne change pas les pièces déjà émises.</p>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex h-20 w-48 items-center justify-center rounded-lg border border-dashed border-gray-300 bg-white p-2">
          {apercu ? <img src={apercu} alt="Logo des documents" className="max-h-full max-w-full object-contain" /> : <span className="text-sm text-gray-400">Aucun logo</span>}
        </div>
        {modifiable && (
          <div className="flex flex-wrap gap-2">
            {/* Le champ de fichier, masqué, garde le focus clavier : le libellé qui lui sert de bouton le montre. */}
            <label className={`btn btn-secondary focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2 ${enCours ? 'pointer-events-none opacity-60' : 'cursor-pointer'}`}>
              {logoDocumentId ? 'Remplacer le logo' : 'Choisir un logo'}
              <input ref={champ} type="file" accept="image/png,image/jpeg" className="sr-only" disabled={enCours} onChange={(e) => void envoyer(e.target.files?.[0])} />
            </label>
            {logoDocumentId && (
              <button type="button" className="btn btn-secondary flex items-center gap-2" disabled={enCours} onClick={() => void retirer()}>
                <Trash2 size={16} /> Retirer le logo
              </button>
            )}
          </div>
        )}
      </div>
      {erreur && <div role="alert" className="p-3 bg-red-100 text-red-700 rounded-md text-sm">{erreur}</div>}
      {message && <div role="status" className="p-3 bg-emerald-50 text-emerald-800 rounded-md text-sm">{message}</div>}
    </section>
  );
}
