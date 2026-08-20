import { NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, ShoppingCart, Clock, Settings, LogOut, FolderOpen, PieChart, TrendingUp, Activity, Award, CalendarDays, Wallet } from 'lucide-react';
import { applyTheme } from '../theme';
import { getCurrentRole, isAdminRole, isSuperAdminRole, ROLE_COMMERCIAL } from '../roles';
import { clearCachedModules, useModules } from '../modules';
import './Sidebar.css';

const Sidebar = () => {
  const navigate = useNavigate();
  const userRole = getCurrentRole();
  const isCommercial = userRole === ROLE_COMMERCIAL;
  const isAdmin = isAdminRole(userRole);
  const isSuper = isSuperAdminRole(userRole);
  // Planning : masqué pour tous les comptes (administrateurs compris) quand un superadmin
  // a désactivé le module depuis Administration > Modules.
  const { planningActif } = useModules();

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    clearCachedModules();
    applyTheme('light');
    navigate('/login');
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2 style={{ margin: 0, fontWeight: 700 }}>NØXIA GROUPE</h2>
        <span style={{ fontSize: '0.8rem', opacity: 0.8, letterSpacing: '2px' }}>MARGE CHANTIER</span>
      </div>
      
      <nav className="sidebar-nav">
        <NavLink to="/" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
          <LayoutDashboard size={20} />
          Tableau de Bord
        </NavLink>
        
        <NavLink to="/chantiers" end className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
          <FolderOpen size={20} />
          Liste des Chantiers
        </NavLink>
        
        {!isCommercial && (
          <NavLink to="/achats" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
            <ShoppingCart size={20} />
            Journal des Achats
          </NavLink>
        )}

        {!isCommercial && (
          <NavLink to="/heures" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
            <Clock size={20} />
            Journal des Heures
          </NavLink>
        )}

        {!isCommercial && (
          <NavLink to="/statistiques" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
            <PieChart size={20} />
            Statistiques
          </NavLink>
        )}

        {!isCommercial && planningActif && (
          <NavLink to="/planning" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
            <CalendarDays size={20} />
            Planning
          </NavLink>
        )}

        {isCommercial && (
          <NavLink to="/resultat-commercial" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
            <TrendingUp size={20} />
            Résultat Commercial
          </NavLink>
        )}

        {/* Administration : complète pour les administrateurs, réduite aux référentiels
            Fournisseurs et Catégories pour les conducteurs de travaux (cf. Admin.tsx). */}
        {!isCommercial && (
          <NavLink to="/admin" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
            <Settings size={20} />
            Administration
          </NavLink>
        )}

        {/* Suivi financier (rapprochement des paiements Odoo) : réservé à la direction. */}
        {isSuper && (
          <NavLink to="/suivi-financier" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
            <Wallet size={20} />
            Suivi Financier
          </NavLink>
        )}

        {isAdmin && (
          <>
            <NavLink to="/performances" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
              <Activity size={20} />
              Performances
            </NavLink>
            <NavLink to="/commerciaux" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
              <Award size={20} />
              Mes Commerciaux
            </NavLink>
          </>
        )}
      </nav>
      
      <div className="sidebar-footer">
        <button onClick={handleLogout} className="nav-link btn-logout">
          <LogOut size={20} />
          Déconnexion
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
