import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

/**
 * Section dont le contenu reste masqué tant qu'on ne l'a pas ouverte. Sert aux listes
 * secondaires — chantiers archivés, historique de saisie — qui doivent rester consultables
 * d'un clic sans occuper l'écran en permanence ni noyer ce qui est en cours.
 *
 * L'en-tête EST le bouton : toute la barre est cliquable, le résumé (un compteur, en
 * général) reste visible même replié — savoir combien il y a d'éléments derrière fait
 * partie de l'information utile.
 *
 * L'état d'ouverture n'est volontairement pas mémorisé d'une visite à l'autre : revenir
 * sur la page retrouve la section repliée, ce qui est précisément l'intérêt.
 */
export function SectionRepliable({
  titre,
  resume,
  ouvertParDefaut = false,
  headerClassName = '',
  children,
}: {
  /** Contenu de l'en-tête (icône + libellé). */
  titre: ReactNode;
  /** Affiché à droite de l'en-tête, visible ouvert comme replié (compteur, total...). */
  resume?: ReactNode;
  ouvertParDefaut?: boolean;
  /** Espacements et fond de l'en-tête, propres à chaque page. */
  headerClassName?: string;
  children: ReactNode;
}) {
  const [ouvert, setOuvert] = useState(ouvertParDefaut);

  return (
    <>
      <button
        type="button"
        onClick={() => setOuvert((o) => !o)}
        aria-expanded={ouvert}
        className={`w-full flex items-center justify-between gap-3 text-left transition-colors hover:bg-gray-50 ${ouvert ? 'border-b border-gray-100' : ''} ${headerClassName}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {ouvert
            ? <ChevronDown size={18} className="text-gray-400 shrink-0" />
            : <ChevronRight size={18} className="text-gray-400 shrink-0" />}
          {titre}
        </div>
        {resume}
      </button>
      {ouvert && children}
    </>
  );
}
