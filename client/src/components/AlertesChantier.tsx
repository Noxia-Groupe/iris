import { CheckCircle2, Clock3, Package, TrendingDown, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { alertesDuChantier, explicationAlerte, libelleAlerte, type AlerteChantier, type ChantierSuivi } from '../lib/suiviChantiers';

// Couleurs déjà redéfinies pour le mode sombre (cf. index.css) : rouge pour la perte,
// orange/violet/bleu pour les postes, dans les teintes de leurs barres de consommation.
const STYLE: Record<AlerteChantier, { classes: string; icone: LucideIcon }> = {
  EN_PERTE: { classes: 'bg-red-100 text-red-700', icone: TrendingDown },
  HEURES_DEPASSEES: { classes: 'bg-purple-100 text-purple-600', icone: Clock3 },
  MAIN_OEUVRE_DEPASSEE: { classes: 'bg-orange-100 text-orange-600', icone: Wallet },
  MATERIEL_DEPASSE: { classes: 'bg-blue-100 text-blue-700', icone: Package },
};

/**
 * Pastilles des dérives d'un chantier, chiffrées (« Heures +6 h »). `afficherSiSain`
 * affiche une pastille verte quand rien ne dépasse — utile là où l'absence d'alerte est
 * elle-même l'information (fiche, tableau de bord), superflue dans une longue liste.
 */
export function AlertesChantier({ chantier, afficherSiSain = false }: { chantier: ChantierSuivi; afficherSiSain?: boolean }) {
  const alertes = alertesDuChantier(chantier);
  if (alertes.length === 0) {
    return afficherSiSain ? (
      <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
        <CheckCircle2 size={12} aria-hidden="true" /> Dans le budget
      </span>
    ) : null;
  }
  return (
    <span className="inline-flex flex-wrap gap-1.5" aria-label="Alertes du chantier">
      {alertes.map((code) => {
        const { classes, icone: Icone } = STYLE[code];
        return (
          <span
            key={code}
            title={explicationAlerte(code)}
            data-alerte={code}
            className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${classes}`}
          >
            <Icone size={12} aria-hidden="true" /> {libelleAlerte(code, chantier)}
          </span>
        );
      })}
    </span>
  );
}
