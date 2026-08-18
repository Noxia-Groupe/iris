import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { PublicClientApplication } from '@azure/msal-browser';
import { apiFetch } from '../api';
import { applyTheme } from '../theme';
import { refreshModules } from '../modules';

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [ssoInfo, setSsoInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  // Instance MSAL + promesse d'initialisation, créées dès le chargement de la page (pas au
  // clic) : `initialize()` est asynchrone, et si on l'attend DANS le gestionnaire de clic,
  // le délai introduit entre le geste utilisateur et l'appel réel à `window.open` fait que
  // certains navigateurs bloquent silencieusement le popup (aucune erreur, rien ne s'ouvre).
  const msalRef = useRef<PublicClientApplication | null>(null);
  const msalReadyRef = useRef<Promise<void> | null>(null);

  // Récupère la configuration SSO (clientId + tenant Azure) et initialise MSAL en avance.
  useEffect(() => {
    apiFetch('/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((cfg) => {
        if (!cfg?.ssoConfigured || !cfg?.ssoClientId || !cfg?.ssoTenantId) return;
        const msal = new PublicClientApplication({
          auth: {
            clientId: cfg.ssoClientId,
            authority: `https://login.microsoftonline.com/${cfg.ssoTenantId}`,
            // Page dédiée (hors PrivateRoute) : évite que le routeur redirige vers /login
            // et écrase la réponse Microsoft avant que MSAL ait pu la lire dans le popup.
            redirectUri: `${window.location.origin}/auth/callback`,
          },
          cache: { cacheLocation: 'sessionStorage' },
        });
        msalRef.current = msal;
        msalReadyRef.current = msal.initialize();
      })
      .catch(() => { /* config indisponible : SSO considéré inactif */ });
  }, []);

  // Connexion via SSO Microsoft 365 (MSAL) : ouvre la fenêtre Microsoft, récupère le jeton
  // d'identité, puis l'échange contre un jeton applicatif via POST /api/auth/sso. Compte
  // autorisé => connexion ; compte non autorisé => page « accès refusé ».
  const handleSso = async () => {
    setError('');
    setSsoInfo('');
    const msal = msalRef.current;
    if (!msal) {
      setSsoInfo("La connexion Microsoft 365 n'est pas activée sur ce serveur. Les autorisations d'accès sont gérées par votre administrateur.");
      return;
    }
    setLoading(true);
    try {
      if (msalReadyRef.current) await msalReadyRef.current; // déjà résolue en temps normal
      const result = await msal.loginPopup({ scopes: ['openid', 'profile', 'email'] });
      const res = await apiFetch('/auth/sso', { method: 'POST', body: JSON.stringify({ idToken: result.idToken }) });
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));
        applyTheme(data.user.theme === 'dark' ? 'dark' : 'light');
        // Modules activés pour ce compte (cf. Administration > Modules) : chargés dès la
        // connexion pour que le menu latéral soit juste dès le premier écran.
        await refreshModules();
        navigate('/');
      } else if (res.status === 403) {
        navigate('/acces-refuse');
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.error || 'Échec de la connexion Microsoft.');
      }
    } catch (err) {
      const code = (err as { errorCode?: string })?.errorCode;
      const detail = (err as { errorMessage?: string })?.errorMessage || (err instanceof Error ? err.message : '');
      if (code === 'user_cancelled') setSsoInfo('Connexion Microsoft annulée.');
      else if (code === 'popup_window_error' || code === 'empty_window_error') setError('La fenêtre de connexion Microsoft a été bloquée. Autorisez les popups pour ce site.');
      // Code + message MSAL affichés tels quels : diagnostic direct sans avoir besoin de la console.
      else setError(`Erreur lors de la connexion Microsoft${code ? ` [${code}]` : ''}${detail ? ` : ${detail}` : ''}`);
    } finally {
      setLoading(false);
    }
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
        applyTheme(data.user.theme === 'dark' ? 'dark' : 'light');
        await refreshModules();
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
            <button type="button" onClick={handleSso} disabled={loading} className="btn btn-secondary" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
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
