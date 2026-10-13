import { useEffect, useState, type ReactNode } from 'react';
import { Menu } from 'lucide-react';
import Sidebar from './Sidebar';
import ThemeToggle from './ThemeToggle';

/**
 * Cadre des écrans connectés : menu, barre du haut et contenu. Sous 1024 px, le menu est
 * un tiroir fermé par défaut, pour que la page occupe toute la largeur du téléphone ; le
 * bouton « Menu » l'ouvre, Échap ou un clic sur le voile le referme.
 */
export function AppLayout({ children }: { children: ReactNode }) {
  const [menuOuvert, setMenuOuvert] = useState(false);

  useEffect(() => {
    if (!menuOuvert) return;
    const surTouche = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOuvert(false); };
    window.addEventListener('keydown', surTouche);
    return () => window.removeEventListener('keydown', surTouche);
  }, [menuOuvert]);

  return (
    <div className="layout">
      <Sidebar ouvert={menuOuvert} onFermer={() => setMenuOuvert(false)} />
      {menuOuvert && <div className="sidebar-voile" onClick={() => setMenuOuvert(false)} aria-hidden="true" />}
      <div className="content-area">
        <header className="topbar bg-white border-b border-gray-100">
          <button
            type="button"
            className="menu-ouvrir"
            onClick={() => setMenuOuvert(true)}
            aria-controls="menu-principal"
            aria-expanded={menuOuvert}
          >
            <Menu size={20} aria-hidden="true" />
            Menu
          </button>
          <ThemeToggle />
        </header>
        <main className="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}
