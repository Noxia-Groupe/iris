import { useEffect, useRef } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { LogOut, X } from 'lucide-react';
import { applyTheme } from '../theme';
import { roleLabel, useCurrentUser } from '../roles';
import { clearCachedModules, useModules } from '../modules';
import { useSociete } from '../companyTimezoneContext';
import { effacerCacheSociete } from '../lib/cacheSociete';
import { viderCacheMicrosoft365 } from '../lib/microsoft365';
import { sectionsMenu } from '../lib/menu';
import './Sidebar.css';

/**
 * Menu principal, regroupé par thème. Sur grand écran il reste affiché à gauche ; sous
 * 1024 px il devient un tiroir, ouvert par le bouton « Menu » de la barre du haut (cf.
 * AppLayout) et refermé par son bouton, la touche Échap, un clic à côté ou le choix d'une page.
 * L'en-tête porte le nom de la société exploitante (Administration > Société), à défaut
 * « Iris » : le menu n'écrit aucune identité de société en dur.
 */
const Sidebar = ({ ouvert = false, onFermer = () => {}, onNaviguer = () => {} }: { ouvert?: boolean; onFermer?: () => void; onNaviguer?: () => void }) => {
  const navigate = useNavigate();
  // Compte relu auprès du serveur au chargement de l'application : un accès accordé (ou
  // retiré) apparaît dans le menu sans attendre une reconnexion.
  const user = useCurrentUser();
  const { planningActif } = useModules();
  const sections = sectionsMenu(user, planningActif);
  const { nom: nomSociete } = useSociete();
  const boutonFermer = useRef<HTMLButtonElement>(null);

  // Tiroir ouvert : le focus passe sur le bouton de fermeture pour qu'un clavier ou un
  // lecteur d'écran parte du menu, et non de la page masquée derrière.
  useEffect(() => {
    if (ouvert) boutonFermer.current?.focus();
  }, [ouvert]);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    effacerCacheSociete();
    // Cache MSAL de l'onglet (jeton de l'envoi par Microsoft 365, lot 6b-2), sans fermer la session
    // Microsoft du navigateur.
    viderCacheMicrosoft365();
    clearCachedModules();
    applyTheme('light');
    navigate('/login');
  };

  return (
    <aside id="menu-principal" className={`sidebar ${ouvert ? 'sidebar--ouvert' : ''}`} aria-label="Menu principal">
      <div className="sidebar-header">
        <div className="min-w-0">
          <h2 className="sidebar-titre">{nomSociete || 'Iris'}</h2>
          {nomSociete && <span className="sidebar-sous-titre">Iris</span>}
        </div>
        <button ref={boutonFermer} type="button" className="sidebar-fermer" onClick={onFermer} aria-label="Fermer le menu">
          <X size={20} />
        </button>
      </div>

      <nav className="sidebar-nav">
        {sections.map((section, index) => (
          <div key={section.titre ?? index} className="nav-section" role="group" aria-label={section.titre ?? 'Accueil'}>
            {section.titre && <div className="nav-section-titre" aria-hidden="true">{section.titre}</div>}
            {section.entrees.map(({ to, libelle, icone: Icone, exact }) => (
              <NavLink key={to} to={to} end={exact} onClick={onNaviguer} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                <Icone size={18} aria-hidden="true" />
                {libelle}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        {user?.name && (
          <div className="sidebar-compte">
            <span className="sidebar-compte-nom">{user.name}</span>
            <span className="sidebar-compte-role">{roleLabel(user.role)}</span>
          </div>
        )}
        <button onClick={handleLogout} className="nav-link btn-logout">
          <LogOut size={18} aria-hidden="true" />
          Déconnexion
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
