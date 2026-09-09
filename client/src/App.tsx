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
import Clients from './pages/Clients';
import ClientDetail from './pages/ClientDetail';
import ApiKeys from './pages/ApiKeys';
import Societe from './pages/Societe';
import Catalogue from './pages/Catalogue';
import Secours from './pages/Secours';
import Devis from './pages/Devis';
import Interventions from './pages/Interventions';
import ContratsMaintenance from './pages/ContratsMaintenance';
import Factures from './pages/Factures';
import Comptabilite from './pages/Comptabilite';
import MentionsLegales from './pages/MentionsLegales';
import { ErrorBoundary } from './ErrorBoundary';
import { useCurrentUser, peutAccederAuxDevis, ROLE_ADMIN, ROLE_COMMERCIAL, ROLE_CONDUCTEUR, ROLE_RESPONSABLE, ROLE_SUPERADMIN, ROLE_TECHNICIEN } from './roles';
import { useModules } from './modules';

// Rôles autorisés sur les écrans d'administration : un SUPERADMIN a tous les droits d'un
// ADMIN, il doit donc figurer partout où l'ADMIN était jusqu'ici seul admis.
const ROLES_ADMIN = [ROLE_SUPERADMIN, ROLE_ADMIN];
const ROLES_INTERVENTIONS = [ROLE_SUPERADMIN, ROLE_ADMIN, ROLE_CONDUCTEUR, ROLE_RESPONSABLE, ROLE_TECHNICIEN];
const ROLES_TRAVAUX = [ROLE_SUPERADMIN, ROLE_ADMIN, ROLE_CONDUCTEUR, ROLE_RESPONSABLE];

const PrivateRoute = ({ children, requiredRoles, excludedRole }: { children: JSX.Element, requiredRoles?: string[], excludedRole?: string }) => {
  const token = localStorage.getItem('token');
  const userStr = localStorage.getItem('user');
  // Compte resynchronisé avec le serveur à chaque changement d'écran : une promotion, une
  // rétrogradation ou un accès accordé depuis la connexion se répercute aussitôt sur les
  // menus et les écrans accessibles, sans obliger à se reconnecter.
  const utilisateur = useCurrentUser();
  const role = utilisateur?.role || '';

  if (!token || !userStr) {
    return <Navigate to="/login" />;
  }

  if (requiredRoles && !requiredRoles.includes(role)) {
    return <Navigate to="/" />; // Redirect to dashboard if not authorized
  }
  if (excludedRole && role === excludedRole) {
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

// Module Planning désactivé par le superadmin : la page n'est plus atteignable, même en
// tapant l'URL. Le serveur refuse de toute façon les appels /api/planning/* (403).
const PlanningRoute = () => {
  const { planningActif } = useModules();
  return planningActif ? <Planning /> : <Navigate to="/" replace />;
};

const RouteDevis = () => {
  const utilisateur = useCurrentUser();
  return peutAccederAuxDevis(utilisateur) ? <Devis /> : <Navigate to="/" replace />;
};

// Identité de la société : consultable par un administrateur, modifiable par le seul
// super administrateur — c'est aussi ce qu'applique le serveur (PUT /api/company).
const RouteSociete = () => {
  const utilisateur = useCurrentUser();
  return <Societe modifiable={utilisateur?.role === ROLE_SUPERADMIN} />;
};

function App() {
  return (
    <ErrorBoundary>
      <Router>
        <Routes>
        <Route path="/login" element={<Login />} />
        {/* Accès de secours : volontairement hors de toute session, puisqu'il sert
            précisément quand plus aucune connexion Microsoft n'est possible. */}
        <Route path="/secours" element={<Secours />} />
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

        <Route path="/devis" element={
          <PrivateRoute>
            <RouteDevis />
          </PrivateRoute>
        } />
        <Route path="/interventions" element={
          <PrivateRoute requiredRoles={ROLES_INTERVENTIONS}>
            <Interventions />
          </PrivateRoute>
        } />
        <Route path="/contrats-maintenance" element={
          <PrivateRoute requiredRoles={ROLES_ADMIN}>
            <ContratsMaintenance />
          </PrivateRoute>
        } />
        <Route path="/factures" element={
          <PrivateRoute requiredRoles={ROLES_ADMIN}>
            <Factures />
          </PrivateRoute>
        } />
        <Route path="/mentions-legales" element={
          <PrivateRoute requiredRoles={ROLES_ADMIN}>
            <MentionsLegales />
          </PrivateRoute>
        } />
        <Route path="/comptabilite" element={
          <PrivateRoute requiredRoles={ROLES_ADMIN}>
            <Comptabilite />
          </PrivateRoute>
        } />
        <Route path="/clients" element={
          <PrivateRoute requiredRoles={ROLES_ADMIN}>
            <Clients />
          </PrivateRoute>
        } />
        <Route path="/clients/:id" element={
          <PrivateRoute requiredRoles={ROLES_ADMIN}>
            <ClientDetail />
          </PrivateRoute>
        } />
        <Route path="/societe" element={
          <PrivateRoute requiredRoles={ROLES_ADMIN}>
            <RouteSociete />
          </PrivateRoute>
        } />
        <Route path="/catalogue" element={
          <PrivateRoute requiredRoles={ROLES_ADMIN}>
            <Catalogue />
          </PrivateRoute>
        } />
        <Route path="/administration/api" element={
          <PrivateRoute requiredRoles={[ROLE_SUPERADMIN]}>
            <ApiKeys />
          </PrivateRoute>
        } />
        
        <Route path="/achats" element={
          <PrivateRoute requiredRoles={ROLES_TRAVAUX}>
            <Achats />
          </PrivateRoute>
        } />

        <Route path="/heures" element={
          <PrivateRoute requiredRoles={ROLES_TRAVAUX}>
            <Heures />
          </PrivateRoute>
        } />

        <Route path="/planning" element={
          <PrivateRoute excludedRole="COMMERCIAL">
            <PlanningRoute />
          </PrivateRoute>
        } />

        {/* Administration : accessible aussi aux conducteurs de travaux, qui n'y voient
            que les référentiels Fournisseurs et Catégories (cf. pages/Admin.tsx). */}
        <Route path="/admin" element={
          <PrivateRoute excludedRole="COMMERCIAL">
            <Admin />
          </PrivateRoute>
        } />

        <Route path="/performances" element={
          <PrivateRoute requiredRoles={ROLES_ADMIN}>
            <Performances />
          </PrivateRoute>
        } />

        <Route path="/commerciaux" element={
          <PrivateRoute requiredRoles={ROLES_ADMIN}>
            <MesCommerciaux />
          </PrivateRoute>
        } />

        <Route path="/statistiques" element={
          <PrivateRoute requiredRoles={[ROLE_SUPERADMIN, ROLE_ADMIN, ROLE_RESPONSABLE, ROLE_CONDUCTEUR]}>
            <Statistiques />
          </PrivateRoute>
        } />

        <Route path="/resultat-commercial" element={
          <PrivateRoute requiredRoles={[ROLE_COMMERCIAL]}>
            <ResultatCommercial />
          </PrivateRoute>
        } />
        </Routes>
      </Router>
    </ErrorBoundary>
  );
}

export default App;
