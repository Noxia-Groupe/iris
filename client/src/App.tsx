import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import Achats from './pages/Achats';
import Heures from './pages/Heures';
import Admin from './pages/Admin';
import ListeChantiers from './pages/ListeChantiers';
import { ErrorBoundary } from './ErrorBoundary';

const PrivateRoute = ({ children, requiredRole }: { children: JSX.Element, requiredRole?: string }) => {
  const token = localStorage.getItem('token');
  const userStr = localStorage.getItem('user');
  
  if (!token || !userStr) {
    return <Navigate to="/login" />;
  }

  const user = JSON.parse(userStr);
  
  if (requiredRole && user.role !== requiredRole) {
    return <Navigate to="/" />; // Redirect to dashboard if not authorized
  }

  return (
    <div className="layout">
      <Sidebar />
      <main className="main-content">
        {children}
      </main>
    </div>
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
          <PrivateRoute requiredRole="ADMIN">
            <Admin />
          </PrivateRoute>
        } />
        </Routes>
      </Router>
    </ErrorBoundary>
  );
}

export default App;
