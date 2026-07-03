import { NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, ShoppingCart, Clock, Settings, LogOut, FolderOpen, PieChart, TrendingUp, Activity, Award } from 'lucide-react';
import { applyTheme } from '../theme';
import './Sidebar.css';

const Sidebar = () => {
  const navigate = useNavigate();
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const userRole = user?.role || 'CONDUCTEUR_TRAVAUX';
  const isCommercial = userRole === 'COMMERCIAL';

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
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

        {isCommercial && (
          <NavLink to="/resultat-commercial" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
            <TrendingUp size={20} />
            Résultat Commercial
          </NavLink>
        )}

        {userRole === 'ADMIN' && (
          <>
            <NavLink to="/admin" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
              <Settings size={20} />
              Administration
            </NavLink>
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
