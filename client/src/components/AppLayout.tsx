import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import Sidebar from './Sidebar';
import ThemeToggle from './ThemeToggle';

const GRAND_ECRAN = '(min-width: 1024px)';

/**
 * Cadre des écrans connectés : menu, barre du haut et contenu. Sous 1024 px, le menu est
 * un tiroir fermé par défaut, pour que la page occupe toute la largeur du téléphone.
 *
 * Tiroir ouvert : il est modal — le reste de la page est inerte et ne défile plus — et se
 * referme par Échap, le voile, son bouton ou le choix d'une page. Le focus revient alors au
 * bouton « Menu », ou au contenu de la nouvelle page après une navigation.
 */
export function AppLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  // Le tiroir est ouvert « sur » une page : changer de page (lien du menu, retour arrière
  // du navigateur) le referme sans effet de bord à orchestrer.
  const [ouvertSur, setOuvertSur] = useState<string | null>(null);
  const menuOuvert = ouvertSur === pathname;
  const boutonMenu = useRef<HTMLButtonElement>(null);
  const contenu = useRef<HTMLElement>(null);
  // Où rendre le focus une fois le tiroir refermé : après le rendu seulement, car la page
  // est encore inerte au moment où la fermeture est demandée.
  const focusApresFermeture = useRef<'bouton' | 'contenu' | null>(null);

  const fermer = useCallback((cible: 'bouton' | 'contenu' = 'bouton') => {
    focusApresFermeture.current = cible;
    setOuvertSur(null);
  }, []);

  useEffect(() => {
    if (menuOuvert || !focusApresFermeture.current) return;
    (focusApresFermeture.current === 'contenu' ? contenu.current : boutonMenu.current)?.focus();
    focusApresFermeture.current = null;
  }, [menuOuvert]);

  // Repasser en grand écran referme le tiroir : il n'y existe plus, et la page ne doit pas
  // rester inerte derrière un menu devenu fixe.
  useEffect(() => {
    const grandEcran = window.matchMedia(GRAND_ECRAN);
    const surChangement = () => { if (grandEcran.matches) setOuvertSur(null); };
    grandEcran.addEventListener('change', surChangement);
    return () => grandEcran.removeEventListener('change', surChangement);
  }, []);

  useEffect(() => {
    if (!menuOuvert) return;
    const surTouche = (e: KeyboardEvent) => { if (e.key === 'Escape') fermer(); };
    window.addEventListener('keydown', surTouche);
    const racine = document.documentElement;
    const debordement = racine.style.overflow;
    racine.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', surTouche);
      racine.style.overflow = debordement;
    };
  }, [menuOuvert, fermer]);

  return (
    <div className="layout">
      <Sidebar ouvert={menuOuvert} onFermer={() => fermer()} onNaviguer={() => fermer('contenu')} />
      {menuOuvert && <div className="sidebar-voile" onClick={() => fermer()} aria-hidden="true" />}
      <div className="content-area" inert={menuOuvert}>
        <header className="topbar bg-white border-b border-gray-100">
          <button
            ref={boutonMenu}
            type="button"
            className="menu-ouvrir"
            onClick={() => setOuvertSur(pathname)}
            aria-controls="menu-principal"
            aria-expanded={menuOuvert}
          >
            <Menu size={20} aria-hidden="true" />
            Menu
          </button>
          <ThemeToggle />
        </header>
        <main ref={contenu} className="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
