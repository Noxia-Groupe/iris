import { useNavigate } from 'react-router-dom';

// Page affichée lorsqu'un compte s'authentifie via SSO Microsoft mais ne figure pas
// dans la liste blanche d'autorisation (géré par un administrateur dans l'onglet
// Administration > Utilisateurs). L'accès au service est refusé.
const AccesRefuse = () => {
  const navigate = useNavigate();

  const retourConnexion = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    navigate('/login');
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--color-primary-dark)' }}>
      <div className="card" style={{ width: '100%', maxWidth: '460px', textAlign: 'center' }}>
        <div className="mx-auto mb-4 flex items-center justify-center" style={{ width: 64, height: 64, borderRadius: '50%', backgroundColor: '#fee2e2' }}>
          <svg width="32" height="32" fill="none" stroke="#dc2626" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M12 3l9 16H3l9-16z" />
          </svg>
        </div>
        <h2 className="text-primary" style={{ marginTop: 0, fontWeight: 700 }}>Accès refusé</h2>
        <p className="text-sm" style={{ color: 'var(--color-text-muted)', marginBottom: 'var(--spacing-4)' }}>
          Votre compte n'est pas autorisé à utiliser ce service.
          Si vous pensez qu'il s'agit d'une erreur, veuillez contacter votre administrateur
          afin qu'il ajoute votre compte à la liste des accès autorisés.
        </p>
        <button onClick={retourConnexion} className="btn btn-primary" style={{ width: '100%' }}>
          Retour à la connexion
        </button>
      </div>
    </div>
  );
};

export default AccesRefuse;
