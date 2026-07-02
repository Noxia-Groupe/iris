type MeterColor = 'blue' | 'purple';

const COLORS: Record<MeterColor, { normal: string; warning: string; danger: string }> = {
  blue: { normal: '#0251a1', warning: '#f59e0b', danger: '#ef4444' },
  purple: { normal: '#8b5cf6', warning: '#f59e0b', danger: '#ef4444' },
};

function fillColor(color: MeterColor, ratio: number): string {
  const c = COLORS[color];
  if (ratio > 1) return c.danger;
  if (ratio >= 0.85) return c.warning;
  return c.normal;
}

/**
 * Barre de progression réutilisable (consommation budget/heures, avancement chantier).
 * La couleur du remplissage porte la sévérité : normale, proche de la limite (85%+),
 * ou dépassée (>100%) — jamais un simple dégradé cosmétique.
 */
export function ProgressMeter({
  value,
  max,
  color = 'blue',
  size = 'md',
  striped = false,
}: {
  value: number;
  max: number;
  color?: MeterColor;
  size?: 'sm' | 'md';
  striped?: boolean;
}) {
  const ratio = max > 0 ? value / max : 0;
  const pct = Math.min(100, Math.max(0, ratio * 100));
  const height = size === 'sm' ? 'h-1.5' : 'h-3';

  return (
    <div className={`w-full ${height} bg-gray-100 rounded-full overflow-hidden shadow-inner`}>
      <div
        className={`h-full rounded-full transition-all duration-700 ease-out relative`}
        style={{ width: `${pct}%`, backgroundColor: fillColor(color, ratio) }}
      >
        {striped && (
          <div
            className="absolute inset-0 w-full"
            style={{
              backgroundImage:
                'linear-gradient(45deg,rgba(255,255,255,.15) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.15) 50%,rgba(255,255,255,.15) 75%,transparent 75%,transparent)',
              backgroundSize: '1rem 1rem',
            }}
          />
        )}
      </div>
    </div>
  );
}
