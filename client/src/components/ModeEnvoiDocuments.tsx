import { useEffect, useId, useState } from 'react';
import { apiFetch } from '../api';
import { CANAL_MESSAGERIE, CANAL_MICROSOFT_365, LIBELLES_MODE_ENVOI } from '../lib/envoiMicrosoft365';

// Mode d'envoi des documents (lot 6b-2 ; paramètre du lot 6b-1b, Parametres.modeEnvoi) : Microsoft 365,
// la valeur par défaut (décision A10), ou la messagerie seule. Onglet Modules, réservé au super
// administrateur comme PUT /api/modules (placement : choix par défaut, à confirmer). Le mode se lit par
// GET /api/modules et se règle par PUT /api/modules { modeEnvoi }, journalisé par le serveur. GET
// /api/config (ssoConfigured) dit si la connexion Microsoft est configurée : sans elle, l'envoi par
// Microsoft 365 n'est jamais proposé, quel que soit le mode.
type Mode = typeof CANAL_MICROSOFT_365 | typeof CANAL_MESSAGERIE;

const libelleMode = (mode: string) => (Object.hasOwn(LIBELLES_MODE_ENVOI, mode) ? LIBELLES_MODE_ENVOI[mode] : mode);

export function ModeEnvoiDocuments() {
  const titre = useId();
  const [mode, setMode] = useState<string | null>(null);
  const [connexionConfiguree, setConnexionConfiguree] = useState<boolean | null>(null);
  const [message, setMessage] = useState('');
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);

  useEffect(() => {
    let actif = true;
    (async () => {
      try {
        const res = await apiFetch('/modules');
        const donnees = await res.json().catch(() => ({}));
        if (!actif) return;
        if (!res.ok || typeof donnees?.modeEnvoi !== 'string') setErreur(donnees?.error || 'Le mode d’envoi des documents n’a pas pu être lu.');
        else setMode(donnees.modeEnvoi);
      } catch {
        if (actif) setErreur('Impossible de joindre le serveur.');
      }
    })();
    (async () => {
      try {
        const res = await apiFetch('/config');
        const config = res.ok ? await res.json() : null;
        if (actif && config) setConnexionConfiguree(config.ssoConfigured === true);
      } catch {
        // Configuration illisible : rien n'est affiché sur la connexion Microsoft.
      }
    })();
    return () => { actif = false; };
  }, []);

  const regler = async (modeEnvoi: Mode) => {
    setMessage('');
    setErreur('');
    setEnCours(true);
    try {
      const res = await apiFetch('/modules', { method: 'PUT', body: JSON.stringify({ modeEnvoi }) });
      const donnees = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErreur(donnees?.error || 'Le mode d’envoi des documents n’a pas pu être enregistré.');
        return;
      }
      const nouveau = typeof donnees?.modeEnvoi === 'string' ? donnees.modeEnvoi : modeEnvoi;
      setMode(nouveau);
      // « de nouveau » n'est vrai que si la connexion Microsoft est configurée (V-N5).
      if (nouveau === CANAL_MICROSOFT_365) setMessage(connexionConfiguree === true ? 'Les documents peuvent de nouveau partir par Microsoft 365.' : 'Mode d’envoi : Microsoft 365.');
      else setMessage('L’envoi par Microsoft 365 est désactivé : seule la messagerie est proposée.');
    } catch {
      setErreur('Impossible de joindre le serveur.');
    } finally {
      setEnCours(false);
    }
  };

  return (
    <section className="card mt-6" aria-labelledby={titre} data-testid="mode-envoi">
      <h2 id={titre} className="mb-2 text-primary-dark">Mode d’envoi des documents</h2>
      <p className="text-sm text-muted mb-4">
        Choisissez comment les documents (devis, factures et avoirs, comptes rendus, contrats, rapports de chantier) peuvent être envoyés. La messagerie de l’utilisateur reste toujours proposée.
      </p>

      {connexionConfiguree === false && (
        <p className="mb-4 p-3 bg-amber-50 text-amber-800 rounded text-sm">
          La connexion Microsoft 365 n’est pas configurée sur ce serveur : l’envoi par Microsoft 365 ne sera pas proposé, quel que soit le mode.
        </p>
      )}
      {message && <p role="status" className="mb-4 p-3 bg-blue-50 text-blue-800 rounded text-sm">{message}</p>}
      {erreur && <p role="alert" className="mb-4 p-3 bg-red-50 text-red-800 rounded text-sm">{erreur}</p>}

      {mode === null ? (
        !erreur && <p className="text-sm text-gray-400 italic">Chargement du mode d’envoi…</p>
      ) : (
        <div className="p-4 rounded border bg-gray-50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="text-sm">
            Mode actuel : <strong>{libelleMode(mode)}</strong>
          </div>
          <div className="flex flex-wrap gap-2 shrink-0">
            <button
              type="button"
              data-testid="mode-envoi-microsoft-365"
              onClick={() => regler(CANAL_MICROSOFT_365)}
              disabled={enCours || mode === CANAL_MICROSOFT_365}
              className="btn btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {LIBELLES_MODE_ENVOI.MICROSOFT_365}
            </button>
            <button
              type="button"
              data-testid="mode-envoi-messagerie"
              onClick={() => regler(CANAL_MESSAGERIE)}
              disabled={enCours || mode === CANAL_MESSAGERIE}
              className="btn bg-white border disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {LIBELLES_MODE_ENVOI.MESSAGERIE}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
