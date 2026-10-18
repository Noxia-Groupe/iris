const fmtEuro = (n: number) => `${Math.round(n).toLocaleString()} €`;

// Éditeur d'un barème progressif. Une tranche = un plafond et un taux ; la DERNIÈRE peut
// avoir un plafond vide, ce qui signifie « au-delà, sans borne » (JSON ne représente pas
// Infinity, le serveur stocke null). Les plafonds doivent rester croissants — le serveur
// le revérifie et refuse l'enregistrement sinon.
type Tranche = { plafond: number | string | null; taux: number | string };

export const EditeurBareme = ({ titre, tranches, modifiable, accent, onChange }: {
  titre: string;
  tranches?: Tranche[];
  modifiable: boolean;
  accent?: boolean;
  onChange: (t: Tranche[]) => void;
}) => {
  const lignes = tranches ?? [];
  const maj = (i: number, champ: 'plafond' | 'taux', valeur: string) => {
    const copie = lignes.map((t, j) => (j === i ? { ...t, [champ]: valeur } : t));
    onChange(copie);
  };
  let plancher = 0;
  return (
    <div className={`p-4 rounded border ${accent ? 'bg-amber-50 border-amber-200' : 'bg-gray-50'}`}>
      <div className={`text-xs font-bold uppercase tracking-wide mb-3 ${accent ? 'text-amber-700' : 'text-gray-500'}`}>{titre}</div>
      {lignes.length === 0 && <p className="text-sm text-gray-400 italic mb-3">Aucune tranche.</p>}
      <div className="space-y-2">
        {lignes.map((t, i) => {
          const plafondCourant = t.plafond === null || t.plafond === '' ? null : Number(t.plafond);
          const depuis = plancher;
          plancher = plafondCourant ?? plancher;
          return (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs text-gray-500 w-20 shrink-0">dès {fmtEuro(depuis)}</span>
              <input
                type="number" min="0" step="any" className="form-input flex-1" style={{ margin: 0 }}
                placeholder="sans plafond"
                value={t.plafond ?? ''}
                disabled={!modifiable}
                onChange={(e) => maj(i, 'plafond', e.target.value)}
              />
              <input
                type="number" min="0" max="100" step="any" className="form-input w-24" style={{ margin: 0 }}
                value={t.taux}
                disabled={!modifiable}
                onChange={(e) => maj(i, 'taux', e.target.value)}
              />
              <span className="text-sm text-gray-500">%</span>
              {modifiable && (
                <button type="button" title="Retirer cette tranche" className="text-red-600 px-2"
                  onClick={() => onChange(lignes.filter((_, j) => j !== i))}>×</button>
              )}
            </div>
          );
        })}
      </div>
      {modifiable && (
        <button type="button" className="btn btn-secondary mt-3 text-sm"
          onClick={() => onChange([...lignes, { plafond: '', taux: 0 }])}>
          Ajouter une tranche
        </button>
      )}
    </div>
  );
};
