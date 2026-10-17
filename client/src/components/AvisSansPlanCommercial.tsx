import type { ReactNode } from 'react';
import { Info } from 'lucide-react';

// Décision de Nelson du 17-10-2026 : un commercial sans plan commercial ne touche aucune
// commission ni prime, jusqu'à ce qu'un plan lui soit attribué à date. Aucun plan n'existe
// encore (lot (i)) : le serveur renvoie des commissions nulles et `sansPlanCommercial`.
export const MESSAGE_SANS_PLAN_COMMERCIAL = 'Aucune commission : aucun plan commercial attribué.';

export function AvisSansPlanCommercial({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <div role="note" className={`flex items-start gap-2 p-4 rounded-lg border border-amber-200 bg-amber-50 text-sm text-amber-800 ${className}`}>
      <Info size={18} className="shrink-0 mt-0.5" />
      <div><strong>{MESSAGE_SANS_PLAN_COMMERCIAL}</strong>{children && <> {children}</>}</div>
    </div>
  );
}
