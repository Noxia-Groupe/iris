import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import Achats from './pages/Achats';
import Heures from './pages/Heures';
import Admin from './pages/Admin';
import ListeChantiers from './pages/ListeChantiers';
import { ErrorBoundary } from './ErrorBoundary';

// Mock auth state for prototype
const isAuthenticated = true;

const PrivateRoute = ({ children }: { children: JSX.Element }) => {
  return isAuthenticated ? (
    <div className="layout">
      <Sidebar />
      <main className="main-content">
        {children}
      </main>
    </div>
  ) : (
    <Navigate to="/login" />
  );
};

function App() {
  return (
    <ErrorBoundary>
      <Router>
        <Routes>
        <Route path="/login" element={<Login />} />
        
        <Route path="/" element={
          <PrivateRoute>
            <Dashboard />
          </PrivateRoute>
        } />
        
        <Route path="/chantiers" element={
          <PrivateRoute>
            <ListeChantiers />
          </PrivateRoute>
        } />
        
        <Route path="/achats" element={
          <PrivateRoute>
            <Achats />
          </PrivateRoute>
        } />
        
        <Route path="/heures" element={
          <PrivateRoute>
            <Heures />
          </PrivateRoute>
        } />
        
        <Route path="/admin" element={
          <PrivateRoute>
            <Admin />
          </PrivateRoute>
        } />
        </Routes>
      </Router>
    </ErrorBoundary>
  );
}

export default App;
