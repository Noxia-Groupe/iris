export interface BreakdownRow {
  label: string;
  value: number;
  sublabel?: string;
}

/**
 * Répartition horizontale (une seule teinte = une seule grandeur comparée),
 * triée par magnitude décroissante. La longueur de la barre porte l'info ;
 * la couleur ne fait qu'identifier la teinte de la carte, jamais une série.
 */
export function BarBreakdown({
  rows,
  color,
  formatValue,
  emptyLabel = 'Aucune donnée',
}: {
  rows: BreakdownRow[];
  color: string;
  formatValue: (v: number) => string;
  emptyLabel?: string;
}) {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const max = sorted.reduce((m, r) => Math.max(m, r.value), 0);

  if (sorted.length === 0) {
    return <div className="text-sm text-gray-400 italic py-4 text-center">{emptyLabel}</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      {sorted.map((row) => (
        <div key={row.label}>
          <div className="flex justify-between items-baseline mb-1 gap-2">
            <span className="text-sm font-semibold text-gray-700 truncate">{row.label}</span>
            <span className="text-sm font-bold text-gray-800 whitespace-nowrap">{formatValue(row.value)}</span>
          </div>
          <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700 ease-out"
              style={{ width: `${max > 0 ? (row.value / max) * 100 : 0}%`, backgroundColor: color }}
            />
          </div>
          {row.sublabel && <div className="text-xs text-gray-400 mt-0.5">{row.sublabel}</div>}
        </div>
      ))}
    </div>
  );
}
