FROM node:20-slim

WORKDIR /app

# OpenSSL est requis par le moteur Prisma. Sur Alpine (musl), la détection échoue
# ("Could not parse schema engine response" / erreur de chargement de libssl).
# On utilise Debian slim + openssl, où Prisma auto-détecte le bon moteur.
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Copier les fichiers de configuration
COPY package*.json ./
COPY tsconfig.json ./

# Installer les dépendances
RUN npm install

# Copier le code source, le schéma Prisma et les migrations
COPY prisma ./prisma
COPY *.ts ./

# DATABASE_URL factice : nécessaire au build de `prisma generate` (aucune connexion
# réelle n'est effectuée ici). La vraie URL est injectée au runtime par docker-compose.
ENV DATABASE_URL="postgresql://user:password@localhost:5432/iris?schema=public"

# Générer le client Prisma et compiler le TypeScript
RUN npx prisma generate
RUN npm run build || npx tsc

# Exposer le port de l'API
EXPOSE 3001

# Au démarrage : applique les migrations versionnées (crée/maj le schéma) puis lance l'API.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
