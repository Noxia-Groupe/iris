import { useEffect, useState } from 'react';
import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge';

// Page de retour dédiée au SSO Microsoft ("redirect bridge" MSAL Browser v5).
// Depuis msal-browser v5, la fenêtre d'origine ne lit plus l'URL du popup directement
// (ancien mécanisme v3, cassé par les politiques COOP) : c'est cette page, chargée DANS
// le popup après le retour de Microsoft, qui doit elle-même relire la réponse dans l'URL
// et la retransmettre à la fenêtre d'origine via BroadcastChannel — d'où l'appel à
// broadcastResponseToMainFrame(). Sans cet appel, la fenêtre d'origine attend une réponse
// qui n'arrive jamais et échoue au bout de 60s avec l'erreur MSAL "timed_out".
// Cette page doit rester en dehors du routage protégé (PrivateRoute) et ne rien faire
// d'autre : toute navigation avant l'appel écraserait le hash contenant la réponse.
const AuthCallbackMsal = () => {
  const [error, setError] = useState('');

  useEffect(() => {
    broadcastResponseToMainFrame().catch((err) => {
      setError(err instanceof Error ? err.message : 'Erreur de connexion Microsoft.');
    });
  }, []);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--color-primary-dark)', color: 'white', fontSize: '0.9rem', textAlign: 'center', padding: '0 20px' }}>
      {error ? `Erreur : ${error}` : 'Connexion en cours…'}
    </div>
  );
};

export default AuthCallbackMsal;
