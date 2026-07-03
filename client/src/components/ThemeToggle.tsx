import { useState } from 'react';
import { Sun, Moon } from 'lucide-react';
import { setTheme } from '../theme';
import './ThemeToggle.css';

// Interrupteur jour/nuit global (en-tête, en haut à droite de l'écran) — remplace
// l'ancien bouton texte qui vivait dans le menu latéral.
const ThemeToggle = () => {
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const [isDark, setIsDark] = useState(user?.theme === 'dark');

  const toggle = () => {
    const next = !isDark;
    setIsDark(next);
    setTheme(next ? 'dark' : 'light');
  };

  return (
    <button
      type="button"
      onClick={toggle}
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? 'Passer en mode clair' : 'Passer en mode sombre'}
      title={isDark ? 'Mode clair' : 'Mode sombre'}
      className={`theme-toggle ${isDark ? 'is-dark' : ''}`}
    >
      <span className="theme-toggle-thumb">
        {isDark ? <Moon size={13} /> : <Sun size={13} />}
      </span>
    </button>
  );
};

export default ThemeToggle;
