# Guide de Déploiement (Hostinger VPS & Nginx Proxy Manager)

Ce guide décrit comment déployer l'application NOXIA sur votre VPS Hostinger. L'application est entièrement dockérisée et sécurisée : **aucun port n'est exposé directement sur internet**. Tout passe par votre Nginx Proxy Manager (NPM).

## 0. Prérequis : Clé de déploiement SSH (Dépôt Privé)

Étant donné que votre dépôt Github est privé, vous devez générer une clé SSH spécifique pour ce projet sur votre VPS (afin de ne pas interférer avec vos autres clés existantes).

Connectez-vous à votre VPS en SSH et tapez la commande suivante (elle créera une clé nommée spécifiquement pour le projet Marge) :

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_noxia_marge -C "vps-hostinger-marge"
```
*(Appuyez sur Entrée pour ne pas mettre de mot de passe à la clé, afin que les pulls automatisés ne bloquent pas).*

Ensuite, nous devons dire au système SSH du VPS d'utiliser cette clé spécifique pour ce dépôt. Éditez ou créez le fichier de configuration SSH :

```bash
nano ~/.ssh/config
```

Et ajoutez-y ces lignes :
```text
Host github-marge
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_noxia_marge
    IdentitiesOnly yes
```

Enfin, affichez la clé publique générée à l'écran pour la copier :
```bash
cat ~/.ssh/id_ed25519_noxia_marge.pub
```
Allez sur **GitHub > Votre dépôt `marge` > Settings > Deploy keys > Add deploy key**, collez la clé publique, donnez-lui un nom (ex: "VPS Hostinger"), et validez.

## 1. Déploiement du code sur le VPS

Connectez-vous à votre VPS en SSH et placez-vous dans le dossier où vous souhaitez héberger le projet.
Puisque votre code est synchronisé avec GitHub, il suffit de cloner ou mettre à jour le dépôt :

```bash
# 1. Cloner (la première fois en utilisant notre Host personnalisé)
git clone git@github-marge:Noxia-Groupe/marge.git noxia-marge-chantier
cd noxia-marge-chantier

# Ou mettre à jour (les fois suivantes)
git pull origin main
```

## 2. Configuration (Fichier .env)

Créez le fichier de configuration côté serveur (`server/.env`) :

```bash
cd server
nano .env
```

Ajoutez-y ces variables :
```env
PORT=3001
NODE_ENV=production

# OPTIONNEL : Clé API pour activer l'analyse IA des chantiers (Google Gemini)
GEMINI_API_KEY=votre_cle_api_ici
```

## 3. Lancement avec Docker Compose

Revenez à la racine du projet (là où se trouve le `docker-compose.yml`) et lancez la construction et le démarrage des conteneurs :

```bash
cd ..
docker-compose up -d --build
```
*Note : Le réseau externe `nginx-proxy` doit déjà exister sur votre VPS, car il est géré par votre NPM.*

## 4. Configuration dans Nginx Proxy Manager (NPM)

Rendez-vous sur l'interface web de votre Nginx Proxy Manager pour créer le proxy de votre nom de domaine (ex: `marge.noxia.com`).

Dans **Proxy Hosts** > **Add Proxy Host** :

1. **Domain Names** : `votre-domaine.com`
2. **Scheme** : `http`
3. **Forward Hostname / IP** : `marge_frontend` *(C'est le nom exact du conteneur frontend défini dans le docker-compose)*
4. **Forward Port** : `80`
5. **Block Common Exploits** : Coché (Recommandé)
6. **Websockets Support** : Coché

Dans l'onglet **SSL** :
- Sélectionnez "Request a new SSL Certificate" (Let's Encrypt).
- Cochez "Force SSL".
- Acceptez les conditions et enregistrez.

L'application est maintenant accessible et sécurisée en HTTPS via votre nom de domaine. Le frontend se charge de communiquer avec le backend en interne via l'API, le tout protégé derrière NPM !
