// Secrets du serveur jetable lancé par l'outil, et jeton de session d'un compte.
import { createHmac } from 'node:crypto';

export const JWT_SECRET = 'secret-releve-uniquement';
export const JETON_SECOURS = 'jeton-de-secours-releve-au-moins-32-caracteres';

// Même procédé que les parcours E2E : un jeton signé avec le secret du serveur jetable ouvre une
// session au nom du compte, quel que soit son type.
const base64url = (valeur) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
export function jetonPour(userId) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', JWT_SECRET).update(corps).digest('base64url')}`;
}
