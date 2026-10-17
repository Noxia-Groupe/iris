// Chargement de server/.env. Tout module qui lit l'environnement en se chargeant (client
// Prisma, secret JWT) l'importe en premier, comme index.ts : l'ordre ne dépend pas de celui
// des imports.
import dotenv from 'dotenv';

dotenv.config();
