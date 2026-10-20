import { useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { apiFetch } from '../api';
import type { PlanningType } from '../planningUtils';

// ---------------------------------------------------------------------------
// Modale de gestion des types d'événements réutilisables (libellé + couleur).
// ---------------------------------------------------------------------------
export const TypesModal = ({ types, onClose, onChanged }: { types: PlanningType[]; onClose: () => void; onChanged: () => void }) => {
  const [edit, setEdit] = useState<PlanningType | null>(null);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    try {
      const res = await apiFetch('/planning/types', {
        method: 'POST',
        body: JSON.stringify({ nom: fd.get('nom'), couleur: fd.get('couleur') }),
      });
      if (res.ok) {
        form.reset();
        onChanged();
      } else {
        const d = await res.json();
        alert(d.error || 'Erreur lors de la création du type.');
      }
    } catch {
      alert('Impossible de joindre le serveur.');
    }
  };

  const handleSave = async () => {
    if (!edit) return;
    try {
      const res = await apiFetch(`/planning/types/${edit.id}`, {
        method: 'PUT',
        body: JSON.stringify({ nom: edit.nom, couleur: edit.couleur }),
      });
      if (res.ok) {
        setEdit(null);
        onChanged();
      } else {
        const d = await res.json();
        alert(d.error || 'Erreur lors de la modification du type.');
      }
    } catch {
      alert('Impossible de joindre le serveur.');
    }
  };

  const handleDelete = async (t: PlanningType) => {
    if (!confirm(`Supprimer le type « ${t.nom} » ?`)) return;
    try {
      const res = await apiFetch(`/planning/types/${t.id}`, { method: 'DELETE' });
      if (res.ok) onChanged();
      else {
        const d = await res.json();
        alert(d.error || 'Suppression impossible.');
      }
    } catch {
      alert('Impossible de joindre le serveur.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-lg w-full max-w-md max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className="text-lg font-bold text-primary-dark m-0">Types d'événements</h2>
            <p className="text-xs text-muted mt-1">Libellés réutilisables (congés, formation...) avec leur couleur dans le planning.</p>
          </div>
          <button onClick={onClose} className="p-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors" title="Fermer">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleAdd} className="flex gap-2 items-center mb-4">
          <input required name="nom" className="form-input flex-1" placeholder="Nouveau type (ex: Congés)" />
          <input type="color" name="couleur" defaultValue="#f59e0b" className="h-9 w-14 p-0.5 border border-gray-200 rounded cursor-pointer" title="Couleur" />
          <button className="btn btn-primary px-3 py-2" title="Ajouter"><Plus size={16} /></button>
        </form>

        <div className="flex flex-col gap-2">
          {types.length === 0 && <p className="text-sm text-gray-400 italic text-center py-4">Aucun type pour le moment.</p>}
          {types.map((t) => (
            <div key={t.id} className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg">
              {edit?.id === t.id ? (
                <>
                  <input
                    className="form-input flex-1"
                    value={edit.nom}
                    onChange={(e) => setEdit({ ...edit, nom: e.target.value })}
                  />
                  <input
                    type="color"
                    value={edit.couleur}
                    onChange={(e) => setEdit({ ...edit, couleur: e.target.value })}
                    className="h-9 w-12 p-0.5 border border-gray-200 rounded cursor-pointer"
                  />
                  <button type="button" onClick={handleSave} className="text-sm px-3 py-1 bg-primary text-white font-semibold rounded">OK</button>
                  <button type="button" onClick={() => setEdit(null)} className="text-sm px-2 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded">✕</button>
                </>
              ) : (
                <>
                  <span className="w-4 h-4 rounded shrink-0" style={{ backgroundColor: t.couleur }}></span>
                  <span className="flex-1 text-sm font-semibold text-gray-800">{t.nom}</span>
                  <button type="button" onClick={() => setEdit(t)} className="text-sm px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded">Modifier</button>
                  <button type="button" onClick={() => handleDelete(t)} className="text-sm px-2 py-1 bg-red-100 hover:bg-red-200 text-red-700 font-semibold rounded" title="Supprimer">
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
