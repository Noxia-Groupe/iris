// Page de retour dédiée au SSO Microsoft (popup MSAL).
// MSAL surveille l'URL de cette fenêtre depuis la fenêtre d'origine (opener) et récupère
// la réponse Microsoft (jeton) directement dans le hash de l'URL, PUIS ferme le popup —
// cette page n'a rien à faire elle-même. Elle doit rester en dehors du routage protégé
// (PrivateRoute) : si elle redirigeait vers /login comme le reste de l'app, la navigation
// écraserait le hash contenant la réponse avant que MSAL ait pu la lire, et la connexion
// échouerait silencieusement.
const AuthCallbackMsal = () => (
  <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--color-primary-dark)', color: 'white', fontSize: '0.9rem' }}>
    Connexion en cours…
  </div>
);

export default AuthCallbackMsal;
