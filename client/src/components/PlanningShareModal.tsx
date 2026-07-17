import { useState } from 'react';
import { Copy, Check, X, RefreshCw, Power, Share2 } from 'lucide-react';
import { apiFetch } from '../api';

export interface PlanningShareState {
  published: boolean;
  active: boolean;
  token: string | null;
  updatedAt: string | null;
}

// Modale de gestion du partage public du planning (lien type "OneDrive", sans
// authentification, cf. server GET /api/planning/public/:token). Le bouton d'en-tête qui
// ouvre cette modale se contente de refléter l'état (Publier / Renouveler le lien /
// Partage désactivé) ; les actions réelles — notamment la régénération, qui invalide
// aussitôt l'ancien lien déjà transmis aux techniciens — sont ici, avec confirmation.
export default function PlanningShareModal({
  share,
  onClose,
  onChanged,
}: {
  share: PlanningShareState | null;
  onClose: () => void;
  onChanged: (s: PlanningShareState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const publicUrl = share?.token ? `${window.location.origin}/planning/public/${share.token}` : '';

  const call = async (method: 'POST' | 'PATCH', body?: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await apiFetch('/planning/share', { method, body: body ? JSON.stringify(body) : undefined });
      const data = await res.json();
      if (res.ok) onChanged(data);
      else alert(data.error || 'Erreur lors de la mise à jour du partage.');
    } catch {
      alert('Impossible de joindre le serveur.');
    } finally {
      setBusy(false);
    }
  };

  const handlePublish = () => call('POST');

  const handleRegenerate = () => {
    if (!confirm("Renouveler le lien ? L'ancien lien cessera immédiatement de fonctionner pour les techniciens qui l'ont déjà reçu.")) return;
    call('POST');
  };

  const handleToggleActive = (active: boolean) => call('PATCH', { active });

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Presse-papiers indisponible (contexte non sécurisé, permission refusée...) : le
      // champ readonly reste sélectionnable manuellement, la copie n'est qu'un raccourci.
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className="text-lg font-bold text-primary-dark m-0 flex items-center gap-2"><Share2 size={18} /> Partage public du planning</h2>
            <p className="text-xs text-muted mt-1">Lien en lecture seule, sans identifiant, destiné aux techniciens.</p>
          </div>
          <button onClick={onClose} className="p-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors" title="Fermer">
            <X size={16} />
          </button>
        </div>

        {!share?.published && (
          <div className="text-center py-4">
            <p className="text-sm text-gray-600 mb-4">Ce planning n'est pas encore partagé publiquement.</p>
            <button disabled={busy} onClick={handlePublish} className="btn btn-primary px-6">
              {busy ? 'Publication…' : 'Publier le planning'}
            </button>
          </div>
        )}

        {share?.published && (
          <div className="flex flex-col gap-4">
            <div className={`flex items-center gap-2 text-sm font-semibold px-3 py-2 rounded-lg ${share.active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
              <span className={`w-2 h-2 rounded-full shrink-0 ${share.active ? 'bg-emerald-500' : 'bg-gray-400'}`}></span>
              {share.active ? 'Partage actif' : "Partage désactivé — les techniciens n'y ont plus accès"}
            </div>

            <div className="form-group mb-0">
              <label className="form-label">Lien à transmettre aux techniciens</label>
              <div className="flex gap-2">
                <input readOnly value={publicUrl} className="form-input flex-1 text-sm" onFocus={(e) => e.currentTarget.select()} />
                <button type="button" onClick={handleCopy} className="btn btn-secondary flex items-center gap-1.5 shrink-0" title="Copier le lien">
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  {copied ? 'Copié' : 'Copier'}
                </button>
              </div>
              {share.updatedAt && (
                <p className="text-xs text-gray-400 mt-1">
                  Dernière mise à jour le {new Date(share.updatedAt).toLocaleString('fr-FR')}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <button disabled={busy} onClick={handleRegenerate} className="btn btn-secondary flex items-center gap-1.5">
                <RefreshCw size={15} /> Renouveler le lien
              </button>
              {share.active ? (
                <button disabled={busy} onClick={() => handleToggleActive(false)} className="btn flex items-center gap-1.5 bg-red-100 hover:bg-red-200 text-red-700">
                  <Power size={15} /> Désactiver le partage
                </button>
              ) : (
                <button disabled={busy} onClick={() => handleToggleActive(true)} className="btn flex items-center gap-1.5 bg-emerald-100 hover:bg-emerald-200 text-emerald-700">
                  <Power size={15} /> Réactiver le partage
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
