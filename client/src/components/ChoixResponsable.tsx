import { useState, useRef, useCallback, type RefObject } from 'react';

export type CompteResume = { id: string; name: string };

// Liste « Responsable hiérarchique » d'un compte. Elle ne construit ses options qu'une fois
// ouverte (clic, clavier, toucher) : proposer tous les comptes sur chaque ligne faisait croître
// la page comme le carré du nombre de comptes. L'état d'ouverture est local, pour qu'ouvrir ou
// refermer une liste ne fasse pas refaire le rendu de tout le tableau.
//
// Une liste peut s'ouvrir sans recevoir le focus (toucher en faisant défiler le tableau, aide
// technique) : elle ne recevrait alors jamais de blur. La dernière liste ouverte sans focus est
// donc refermée dès qu'une autre s'ouvre ou qu'un défilement ou une annulation tactile commencent
// sur elle. Une liste qui a le focus n'est jamais refermée par une autre : au plus deux listes sont
// construites à la fois.
export function ChoixResponsable({ compte, responsableActuel, responsableDesactive, desactive, titre, proposables, onChoix, derniereOuverte }: {
  compte: CompteResume;
  responsableActuel: CompteResume | null;
  responsableDesactive: boolean;
  desactive: boolean;
  titre: string;
  proposables: (compteId: string) => CompteResume[];
  onChoix: (compteId: string, responsableId: string) => void;
  derniereOuverte: RefObject<(() => void) | null>;
}) {
  const [ouverte, setOuverte] = useState(false);
  const liste = useRef<HTMLSelectElement>(null);
  const fermerSansFocus = useCallback(() => {
    if (document.activeElement !== liste.current) setOuverte(false);
  }, []);
  const ouvrir = () => {
    if (derniereOuverte.current && derniereOuverte.current !== fermerSansFocus) derniereOuverte.current();
    derniereOuverte.current = fermerSansFocus;
    setOuverte(true);
  };
  const proposes = ouverte ? proposables(compte.id) : [];
  return (
    <select
      ref={liste}
      className="form-input py-1 px-3 text-sm rounded min-w-[11rem]"
      value={responsableActuel?.id ?? ''}
      onChange={(e) => onChoix(compte.id, e.target.value)}
      onFocus={ouvrir}
      onMouseDown={ouvrir}
      onTouchStart={ouvrir}
      onKeyDown={ouvrir}
      onTouchMove={fermerSansFocus}
      onTouchCancel={fermerSansFocus}
      onBlur={() => setOuverte(false)}
      disabled={desactive}
      aria-label={`Responsable hiérarchique de ${compte.name}`}
      title={titre}
    >
      <option value="">Aucun</option>
      {responsableActuel && !proposes.some((r) => r.id === responsableActuel.id) && (
        <option value={responsableActuel.id}>
          {responsableActuel.name}{responsableDesactive ? ' (compte désactivé)' : ''}
        </option>
      )}
      {proposes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
    </select>
  );
}
