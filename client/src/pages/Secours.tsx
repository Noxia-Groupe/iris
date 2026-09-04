import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { apiFetch } from '../api';
import { applyTheme } from '../theme';
import { refreshModules } from '../modules';

/**
 * Accès de secours du super administrateur.
 *
 * Porte de service, indépendante de Microsoft Entra ID : elle sert le jour où le SSO est
 * indisponible ou mal configuré et où plus personne ne peut entrer, pas même pour réparer.
 *
 * Le jeton peut arriver de deux façons :
 *   - collé dans le champ ci-dessous ;
 *   - dans le fragment de l'URL (/secours#token=…), ce qui permet d'enregistrer un signet.
 *     Le fragment n'est JAMAIS transmis au serveur : il n'apparaît ni dans les journaux
 *     nginx, ni dans ceux d'un éventuel proxy. Il est effacé de la barre d'adresse dès
 *     qu'il est lu, pour ne pas rester dans l'historique du navigateur.
 */
const Secours = () => {
  const [token, setToken] = useState('');
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [disponible, setDisponible] = useState<boolean | null>(null);
  const navigate = useNavigate();

  // Le serveur dit seulement SI le mécanisme est configuré, jamais avec quel secret.
  useEffect(() => {
    apiFetch('/auth/secours/etat')
      .then((res) => (res.ok ? res.json() : null))
      .then((etat) => setDisponible(!!etat?.disponible))
      .catch(() => setDisponible(false));
  }, []);

  // Jeton passé en signet : on le récupère puis on nettoie immédiatement l'URL.
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const depuisUrl = fragment.get('token');
    if (depuisUrl) {
      setToken(depuisUrl);
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const ouvrirSession = async (e: React.FormEvent) => {
    e.preventDefault();
    setErreur('');
    setEnCours(true);
    try {
      const res = await apiFetch('/auth/secours', { method: 'POST', body: JSON.stringify({ token }) });
      const data = await res.json();
      if (!res.ok) {
        setErreur(data.error || "L'accès de secours a été refusé.");
        return;
      }
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      applyTheme(data.user.theme === 'dark' ? 'dark' : 'light');
      await refreshModules();
      navigate('/');
    } catch {
      setErreur('Impossible de joindre le serveur.');
    } finally {
      setEnCours(false);
    }
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--color-primary-dark)' }}>
      <div className="bg-white p-8 rounded-xl shadow-lg w-full max-w-md">
        <div className="flex items-center gap-2 mb-2">
          <ShieldAlert className="text-amber-600" size={22} />
          <h1 className="text-xl font-bold text-gray-900">Accès de secours</h1>
        </div>
        <p className="text-sm text-gray-500 mb-5">
          Réservé au super administrateur, lorsque la connexion Microsoft est indisponible.
          La session ouverte ici dure une heure.
        </p>

        {disponible === false && (
          <div className="mb-4 p-3 bg-gray-100 text-gray-700 rounded-md text-sm">
            L'accès de secours n'est pas configuré sur cette instance. Renseignez
            <code className="mx-1">BREAK_GLASS_EMAIL</code> et <code className="mx-1">BREAK_GLASS_TOKEN</code>
            dans <code>server/.env</code>, puis redémarrez le backend.
          </div>
        )}
        {erreur && <div className="mb-4 p-3 bg-red-100 text-red-700 rounded-md text-sm">{erreur}</div>}

        <form onSubmit={ouvrirSession}>
          <div className="form-group mb-4">
            <label className="form-label">Jeton de secours</label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              autoComplete="off"
              className="form-input"
              placeholder="Collez le jeton de server/.env"
            />
          </div>
          <button type="submit" disabled={enCours || !token || disponible === false} className="btn btn-primary" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
            <KeyRound size={16} />
            {enCours ? 'Ouverture…' : 'Ouvrir une session de secours'}
          </button>
        </form>

        <p className="text-xs text-gray-400 mt-5">
          Chaque tentative, réussie ou non, est journalisée avec l'adresse IP.
          Après cinq échecs, l'accès est bloqué quinze minutes.
        </p>
      </div>
    </div>
  );
};

export default Secours;
