import type { JSX } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import ThemeToggle from './components/ThemeToggle';
import Dashboard from './pages/Dashboard';
import ChantierDetail from './pages/ChantierDetail';
import Login from './pages/Login';
import Achats from './pages/Achats';
import Heures from './pages/Heures';
import Admin from './pages/Admin';
import Statistiques from './pages/Statistiques';
import ListeChantiers from './pages/ListeChantiers';
import AccesRefuse from './pages/AccesRefuse';
import AuthCallbackMsal from './pages/AuthCallbackMsal';
import ResultatCommercial from './pages/ResultatCommercial';
import Performances from './pages/Performances';
import MesCommerciaux from './pages/MesCommerciaux';
import Planning from './pages/Planning';
import PlanningPublic from './pages/PlanningPublic';
import { ErrorBoundary } from './ErrorBoundary';

const PrivateRoute = ({ children, requiredRole, excludedRole }: { children: JSX.Element, requiredRole?: string, excludedRole?: string }) => {
  const token = localStorage.getItem('token');
  const userStr = localStorage.getItem('user');

  if (!token || !userStr) {
    return <Navigate to="/login" />;
  }

  const user = JSON.parse(userStr);

  if (requiredRole && user.role !== requiredRole) {
    return <Navigate to="/" />; // Redirect to dashboard if not authorized
  }
  if (excludedRole && user.role === excludedRole) {
    return <Navigate to="/" />;
  }

  return (
    <div className="layout">
      <Sidebar />
      <div className="content-area">
        <header className="topbar bg-white border-b border-gray-100">
          <ThemeToggle />
        </header>
        <main className="main-content">
          {children}
        </main>
      </div>
    </div>
  );
};

function App() {
  return (
    <ErrorBoundary>
      <Router>
        <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/acces-refuse" element={<AccesRefuse />} />
        <Route path="/auth/callback" element={<AuthCallbackMsal />} />
        {/* Lien de partage public (sans authentification, cf. module Planning) : hors
            PrivateRoute, aucune sidebar/topbar — page autonome pensée pour un technicien
            sans compte, sur son téléphone. */}
        <Route path="/planning/public/:token" element={<PlanningPublic />} />
        
        <Route path="/" element={
          <PrivateRoute>
            <Dashboard />
          </PrivateRoute>
        } />

        <Route path="/chantiers/:id" element={
          <PrivateRoute>
            <ChantierDetail />
          </PrivateRoute>
        } />

        <Route path="/chantiers" element={
          <PrivateRoute>
            <ListeChantiers />
          </PrivateRoute>
        } />
        
        <Route path="/achats" element={
          <PrivateRoute excludedRole="COMMERCIAL">
            <Achats />
          </PrivateRoute>
        } />

        <Route path="/heures" element={
          <PrivateRoute excludedRole="COMMERCIAL">
            <Heures />
          </PrivateRoute>
        } />

        <Route path="/planning" element={
          <PrivateRoute excludedRole="COMMERCIAL">
            <Planning />
          </PrivateRoute>
        } />

        <Route path="/admin" element={
          <PrivateRoute requiredRole="ADMIN">
            <Admin />
          </PrivateRoute>
        } />

        <Route path="/performances" element={
          <PrivateRoute requiredRole="ADMIN">
            <Performances />
          </PrivateRoute>
        } />

        <Route path="/commerciaux" element={
          <PrivateRoute requiredRole="ADMIN">
            <MesCommerciaux />
          </PrivateRoute>
        } />

        <Route path="/statistiques" element={
          <PrivateRoute excludedRole="COMMERCIAL">
            <Statistiques />
          </PrivateRoute>
        } />

        <Route path="/resultat-commercial" element={
          <PrivateRoute requiredRole="COMMERCIAL">
            <ResultatCommercial />
          </PrivateRoute>
        } />
        </Routes>
      </Router>
    </ErrorBoundary>
  );
}

export default App;
