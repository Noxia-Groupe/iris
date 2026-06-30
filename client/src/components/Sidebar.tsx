import { NavLink } from 'react-router-dom';
import { LayoutDashboard, ShoppingCart, Clock, Settings, LogOut, FolderOpen } from 'lucide-react';
import './Sidebar.css';

const Sidebar = () => {
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
        
        <NavLink to="/chantiers" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
          <FolderOpen size={20} />
          Liste des Chantiers
        </NavLink>
        
        <NavLink to="/achats" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
          <ShoppingCart size={20} />
          Journal des Achats
        </NavLink>
        
        <NavLink to="/heures" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
          <Clock size={20} />
          Journal des Heures
        </NavLink>
        
        <NavLink to="/admin" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
          <Settings size={20} />
          Administration
        </NavLink>
      </nav>
      
      <div className="sidebar-footer">
        <button className="nav-link btn-logout">
          <LogOut size={20} />
          Déconnexion
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
