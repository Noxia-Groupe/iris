import { apiFetch } from './api';

export type Theme = 'light' | 'dark';

function getStoredUser(): any {
  const raw = localStorage.getItem('user');
  return raw ? JSON.parse(raw) : null;
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

// À appeler une fois au démarrage de l'app : applique le thème du compte déjà
// connecté (localStorage), clair par défaut si personne n'est connecté.
export function applyStoredTheme() {
  const user = getStoredUser();
  applyTheme(user?.theme === 'dark' ? 'dark' : 'light');
}

// Change le thème (applique + persiste sur le compte, pour le retrouver sur un
// autre appareil). Chaque utilisateur — conducteur ou admin — ne modifie que le sien.
export async function setTheme(theme: Theme): Promise<void> {
  applyTheme(theme);
  const user = getStoredUser();
  if (user) {
    localStorage.setItem('user', JSON.stringify({ ...user, theme }));
  }
  try {
    await apiFetch('/me/theme', { method: 'PUT', body: JSON.stringify({ theme }) });
  } catch {
    // La préférence reste appliquée localement même si la synchronisation échoue.
  }
}
