import { NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, ShoppingCart, Clock, Settings, LogOut, FolderOpen, PieChart, TrendingUp, Activity, Award, CalendarDays, Wallet, Building2, BookOpen, Landmark, KeyRound } from 'lucide-react';
import { applyTheme } from '../theme';
import { isAdminRole, isSuperAdminRole, peutVoirFinance, useCurrentUser, ROLE_COMMERCIAL, ROLE_CONDUCTEUR } from '../roles';
import { clearCachedModules, useModules } from '../modules';
import './Sidebar.css';

const Sidebar = () => {
  const navigate = useNavigate();
  // Compte resynchronisé avec le serveur : un accès accordé (ou retiré) apparaît dans le
  // menu sans attendre une reconnexion.
  const user = useCurrentUser();
  const userRole = user?.role || ROLE_CONDUCTEUR;
  const isCommercial = userRole === ROLE_COMMERCIAL;
  const isAdmin = isAdminRole(userRole);
  const isSuperAdmin = isSuperAdminRole(userRole);
  const voitFinance = peutVoirFinance(user);
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
        
        {isAdmin && (
          <NavLink to="/clients" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
            <Building2 size={20} />
            Clients
          </NavLink>
        )}

        {isAdmin && (
          <NavLink to="/catalogue" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
            <BookOpen size={20} />
            Catalogue
          </NavLink>
        )}

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

        {/* Suivi financier : superadmin, ou tout compte autorisé (case « Finance »). */}
        {voitFinance && (
          <NavLink to="/suivi-financier" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
            <Wallet size={20} />
            Suivi Financier
          </NavLink>
        )}

        {isAdmin && (
          <NavLink to="/societe" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
            <Landmark size={20} />
            Société
          </NavLink>
        )}

        {isSuperAdmin && (
          <NavLink to="/administration/api" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
            <KeyRound size={20} />
            API d'intégration
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
