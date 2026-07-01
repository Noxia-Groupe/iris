import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../api';

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [ssoInfo, setSsoInfo] = useState('');
  const [ssoConfigured, setSsoConfigured] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  // Indique si le SSO Microsoft est réellement configuré côté serveur (app Azure AD).
  useEffect(() => {
    apiFetch('/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((cfg) => { if (cfg) setSsoConfigured(!!cfg.ssoConfigured); })
      .catch(() => { /* config indisponible : SSO considéré inactif */ });
  }, []);

  // Connexion Microsoft 365. Le câblage OAuth complet est une étape ultérieure : tant que
  // le SSO n'est pas activé, on informe l'utilisateur. Les autorisations d'accès (qui peut
  // se connecter et avec quel rôle) sont déjà gérées par l'administrateur.
  const handleSso = () => {
    setError('');
    if (!ssoConfigured) {
      setSsoInfo("La connexion Microsoft 365 n'est pas encore activée sur ce serveur. Les autorisations d'accès sont gérées par votre administrateur.");
      return;
    }
    setSsoInfo('Redirection vers Microsoft 365…');
    // TODO (étape ultérieure) : lancer le flux OAuth Microsoft (MSAL), puis échanger le
    // jeton d'identité vérifié contre un jeton applicatif via POST /api/auth/sso.
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await apiFetch('/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();
      
      if (res.ok) {
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));
        navigate('/');
      } else {
        setError(data.error || 'Erreur de connexion');
      }
    } catch (err) {
      setError('Impossible de joindre le serveur');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--color-primary-dark)' }}>
      <div className="card" style={{ width: '100%', maxWidth: '400px' }}>
        <div style={{ textAlign: 'center', marginBottom: 'var(--spacing-4)' }}>
          <h2 className="text-primary" style={{ margin: 0, fontWeight: 700 }}>NØXIA GROUPE</h2>
          <span style={{ fontSize: '0.8rem', opacity: 0.8, letterSpacing: '2px', color: 'var(--color-text-muted)' }}>SUIVI DE MARGE</span>
        </div>
        
        {error && <div className="mb-4 p-3 bg-red-100 text-red-700 rounded-md text-sm">{error}</div>}
        {ssoInfo && <div className="mb-4 p-3 bg-blue-50 text-blue-700 rounded-md text-sm">{ssoInfo}</div>}

        <form onSubmit={handleLogin}>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required className="form-input" placeholder="nom@noxia.com" />
          </div>
          <div className="form-group mb-4">
            <label className="form-label">Mot de passe</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required className="form-input" placeholder="••••••••" />
          </div>
          
          <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%', marginBottom: 'var(--spacing-3)' }}>
            {loading ? 'Connexion...' : 'Se connecter'}
          </button>
          
          <div style={{ textAlign: 'center', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-3)' }}>
            <button type="button" onClick={handleSso} className="btn btn-secondary" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 23 23">
                <path fill="#f3f3f3" d="M0 0h23v23H0z"/>
                <path fill="#f35325" d="M1 1h10v10H1z"/>
                <path fill="#81bc06" d="M12 1h10v10H12z"/>
                <path fill="#05a6f0" d="M1 12h10v10H1z"/>
                <path fill="#ffba08" d="M12 12h10v10H12z"/>
              </svg>
              Connexion Microsoft 365
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Login;
