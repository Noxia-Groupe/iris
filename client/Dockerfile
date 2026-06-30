# Étape de build
FROM node:20-alpine AS build

WORKDIR /app

# Installer les dépendances
COPY package*.json ./
RUN npm install

# Copier le code source et compiler
COPY . .
# On passe l'URL de l'API en variable d'environnement pour la production
ENV VITE_API_URL=/api
RUN npm run build

# Étape de production avec Nginx
FROM nginx:alpine

# Copier les fichiers générés par Vite vers le dossier par défaut de Nginx
COPY --from=build /app/dist /usr/share/nginx/html

# Configuration Nginx personnalisée pour le routage React et le proxy vers le backend
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
