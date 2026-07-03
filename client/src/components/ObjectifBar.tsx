/**
 * Barre de progression vers un objectif mensuel commercial (CA vendu, marge) — dépasser
 * la cible est une bonne nouvelle ici (contrairement à ProgressMeter, pensé pour un
 * budget à ne pas dépasser), d'où une palette de couleur inversée : vert dès l'objectif
 * atteint, accent sinon.
 */
export function ObjectifBar({ label, value, target, prime }: { label: string; value: number; target: number; prime: number }) {
  const atteint = target > 0 && value >= target;
  const pct = Math.min(100, target > 0 ? (value / target) * 100 : 0);

  return (
    <div>
      <div className="flex flex-wrap justify-between items-center gap-x-3 mb-1 text-xs font-semibold">
        <span className="text-gray-600">{label}</span>
        <span className={atteint ? 'text-emerald-600' : 'text-gray-500'}>
          {Math.round(value).toLocaleString()} € / {target.toLocaleString()} €{atteint ? ` · +${prime} €` : ''}
        </span>
      </div>
      <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{ width: `${pct}%`, backgroundColor: atteint ? '#059669' : '#0251a1' }}
        />
      </div>
    </div>
  );
}
