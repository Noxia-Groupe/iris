FROM node:20-alpine

WORKDIR /app

# Copier les fichiers de configuration
COPY package*.json ./
COPY tsconfig.json ./

# Installer les dépendances
RUN npm install

# Copier le code source et le schéma Prisma
COPY prisma ./prisma
COPY *.ts ./

# Générer le client Prisma et compiler le TypeScript
RUN npx prisma generate
RUN npm run build || npx tsc

# Créer le dossier uploads pour les photos
RUN mkdir -p uploads

# Exposer le port de l'API
EXPOSE 3001

# Lancer le serveur (assurez-vous de faire un db push ou db deploy selon votre CI/CD)
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/index.js"]
