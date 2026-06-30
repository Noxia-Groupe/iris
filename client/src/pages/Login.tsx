const Login = () => {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--color-primary-dark)' }}>
      <div className="card" style={{ width: '100%', maxWidth: '400px' }}>
        <div style={{ textAlign: 'center', marginBottom: 'var(--spacing-4)' }}>
          <h2 className="text-primary" style={{ margin: 0, fontWeight: 700 }}>NØXIA GROUPE</h2>
          <span style={{ fontSize: '0.8rem', opacity: 0.8, letterSpacing: '2px', color: 'var(--color-text-muted)' }}>SUIVI DE MARGE</span>
        </div>
        
        <form>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input type="email" className="form-input" placeholder="nom@noxia.com" />
          </div>
          <div className="form-group mb-4">
            <label className="form-label">Mot de passe</label>
            <input type="password" className="form-input" placeholder="••••••••" />
          </div>
          
          <button type="button" className="btn btn-primary" style={{ width: '100%', marginBottom: 'var(--spacing-3)' }}>
            Se connecter
          </button>
          
          <div style={{ textAlign: 'center', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-3)' }}>
            <button type="button" className="btn btn-secondary" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
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
