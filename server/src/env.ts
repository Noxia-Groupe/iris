// Chargement de server/.env. index.ts l'importe juste après les bibliothèques, au moment où
// il appelait dotenv.config() avant le découpage ; db.ts et http/auth.ts, qui lisent
// l'environnement en se chargeant (client Prisma, secret JWT), l'importent eux aussi.
import dotenv from 'dotenv';

dotenv.config();
