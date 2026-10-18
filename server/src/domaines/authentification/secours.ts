import '../../env';
import crypto from 'crypto';
import { normalizeEmail } from './sso';

// --- Accès de secours (« break-glass ») du super administrateur ---
// Microsoft Entra ID est la porte d'entrée normale, et la seule pour les comptes de la
// société. Mais faire dépendre 100 % des accès d'un service extérieur crée une panne
// unique : tenant Microsoft indisponible, application Azure supprimée ou mal reconfigurée,
// migration de tenant, compte de direction verrouillé — et plus PERSONNE ne peut entrer,
// pas même pour réparer. Cette route est la porte de service : elle n'ouvre qu'à UN compte
// superadmin nommé, avec un secret qui ne vit que dans server/.env sur le VPS.
//
// Elle est volontairement plus stricte qu'une connexion normale :
//   - il faut connaître un secret d'au moins 32 caractères, jamais versionné ;
//   - le compte visé doit exister, être actif ET être SUPERADMIN ;
//   - la session ouverte dure 1 h, pas 7 jours (c'est un accès de dépannage) ;
//   - 5 tentatives par quart d'heure et par IP, puis blocage ;
//   - chaque tentative, réussie ou non, laisse une trace dans les journaux du conteneur.
// Sans BREAK_GLASS_EMAIL + BREAK_GLASS_TOKEN dans l'environnement, la route est inactive
// et répond 503 : une instance qui n'en veut pas n'a rien à désactiver.
export const BREAK_GLASS_EMAIL = normalizeEmail(process.env.BREAK_GLASS_EMAIL || '');
export const BREAK_GLASS_TOKEN = process.env.BREAK_GLASS_TOKEN || '';
export const BREAK_GLASS_MIN_LONGUEUR = 32;
export const BREAK_GLASS_ACTIF = !!BREAK_GLASS_EMAIL && BREAK_GLASS_TOKEN.length >= BREAK_GLASS_MIN_LONGUEUR;

// Comparaison à temps constant. On compare les EMPREINTES et non les secrets eux-mêmes :
// timingSafeEqual exige deux tampons de même longueur, et hacher d'abord évite à la fois
// l'exception sur des longueurs différentes et la fuite de la longueur du secret attendu.
export function secretIdentique(fourni: string, attendu: string): boolean {
  const a = crypto.createHash('sha256').update(fourni).digest();
  const b = crypto.createHash('sha256').update(attendu).digest();
  return crypto.timingSafeEqual(a, b);
}

// Limitation du nombre d'essais, en mémoire du processus. Suffisant ici : il n'y a qu'un
// backend, et un redémarrage qui remettrait les compteurs à zéro n'aide pas un attaquant
// à deviner 256 bits d'entropie. (Un rate limiting partagé deviendra nécessaire le jour où
// l'API tournera en plusieurs instances.)
const BREAK_GLASS_FENETRE_MS = 15 * 60 * 1000;
const BREAK_GLASS_MAX_ESSAIS = 5;
export const essaisSecours = new Map<string, { count: number; depuis: number }>();

export function tropDEssaisSecours(ip: string): boolean {
  const maintenant = Date.now();
  const suivi = essaisSecours.get(ip);
  if (!suivi || maintenant - suivi.depuis > BREAK_GLASS_FENETRE_MS) {
    essaisSecours.set(ip, { count: 1, depuis: maintenant });
    return false;
  }
  suivi.count += 1;
  return suivi.count > BREAK_GLASS_MAX_ESSAIS;
}
