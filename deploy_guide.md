# Guide technique de préparation au déploiement d'Iris (Hostinger VPS & Nginx Proxy Manager)

**Iris est encore en développement : ce document n'est pas une attestation de mise en production.** Consulter d'abord la [passation et ses critères de sortie](docs/ROADMAP-PASSATION.md) et la [configuration d'environnement](docs/CONFIGURATION-ENVIRONNEMENT.md). Les étapes ci-dessous décrivent une stack Docker derrière Nginx Proxy Manager (NPM), non une recette de sécurité, de sauvegarde/restauration ou de conformité déjà validée.

## 0. Prérequis : Clé de déploiement SSH (Dépôt Privé)

Étant donné que votre dépôt Github est privé, vous devez générer une clé SSH spécifique pour ce projet sur votre VPS (afin de ne pas interférer avec vos autres clés existantes).

Connectez-vous à votre VPS en SSH et tapez la commande suivante (elle créera une clé nommée spécifiquement pour le projet Iris) :

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_noxia_iris -C "vps-hostinger-iris"
```
*(Appuyez sur Entrée pour ne pas mettre de mot de passe à la clé, afin que les pulls automatisés ne bloquent pas).*

Ensuite, nous devons dire au système SSH du VPS d'utiliser cette clé spécifique pour ce dépôt. Éditez ou créez le fichier de configuration SSH :

```bash
nano ~/.ssh/config
```

Et ajoutez-y ces lignes :
```text
Host github-iris
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_noxia_iris
    IdentitiesOnly yes
```

Enfin, affichez la clé publique générée à l'écran pour la copier :
```bash
cat ~/.ssh/id_ed25519_noxia_iris.pub
```
Allez sur **GitHub > Votre dépôt `iris` > Settings > Deploy keys > Add deploy key**, collez la clé publique, donnez-lui un nom (ex: "VPS Hostinger"), et validez.

## 1. Déploiement du code sur le VPS

Connectez-vous à votre VPS en SSH et placez-vous dans le dossier où vous souhaitez héberger le projet.
Puisque votre code est synchronisé avec GitHub, il suffit de cloner ou mettre à jour le dépôt :

```bash
# 1. Cloner (la première fois en utilisant notre Host personnalisé)
git clone git@github-iris:Noxia-Groupe/iris.git noxia-iris-chantier
cd noxia-iris-chantier

# Ou mettre à jour (les fois suivantes)
git pull origin main
```

## 2. Configuration (Fichiers .env)

L'application utilise désormais **PostgreSQL** (conteneurisé). Deux fichiers de
configuration sont nécessaires. Des modèles sont fournis (`.env.example`).

**a) `.env` à la racine** (identifiants de la base, lus par docker-compose) :

```bash
cp .env.example .env
nano .env
```
```env
POSTGRES_USER=iris
POSTGRES_PASSWORD=un_mot_de_passe_base_robuste
POSTGRES_DB=iris
```

**b) `server/.env`** (secrets applicatifs) :

```bash
cp server/.env.example server/.env
nano server/.env
```

- Remplacer `JWT_SECRET` par une valeur aléatoire longue ; il est obligatoire en production.
- Renseigner `SUPERADMIN_EMAILS` **avant le premier démarrage d'une base vierge**. Aucune adresse administrateur par défaut n'est créée lorsque la liste est vide.
- Renseigner `AZURE_TENANT_ID` (« ID de l'annuaire (locataire) ») et `AZURE_CLIENT_ID` (« ID d'application (client) »), deux GUID, pour la connexion normale Microsoft 365. Dans Entra ID, l'application est de type « Application monopage (SPA) » et son URI de redirection est exactement `https://<domaine-de-l-instance>/auth/callback` ; pas de secret client. Procédure complète : [guide de configuration](docs/CONFIGURATION-ENVIRONNEMENT.md#microsoft-entra-id-microsoft-365). Aucun mot de passe local `ADMIN_PASSWORD` ni `ADMIN_EMAIL` n'est utilisé pour créer un compte.
- Prévoir `BREAK_GLASS_EMAIL` (compte `SUPERADMIN` actif, aussi présent dans `SUPERADMIN_EMAILS`) et `BREAK_GLASS_TOKEN` (`openssl rand -hex 32`) pour le secours, conservés hors Git. Ce secours est propre à l'instance, **pas** un accès plateforme universel.

Utiliser [`server/.env.example`](server/.env.example) et le [guide de configuration](docs/CONFIGURATION-ENVIRONNEMENT.md) comme références détaillées. Ne jamais recopier les valeurs d'exemple dans une instance réelle.

> Note : en Docker, `DATABASE_URL` est construite et injectée **automatiquement** par
> docker-compose à partir du service `db` — inutile de la définir vous-même ici ; `PORT` et
> `NODE_ENV` sont aussi imposés par docker-compose. `server/.env` doit exister avant toute
> commande `docker compose` (il est chargé par `env_file`). Après une modification, recréer
> le conteneur : `docker compose up -d --force-recreate backend`.

## 3. Lancement avec Docker Compose

Vérifiez que vous êtes à la racine du dépôt (là où se trouve `docker-compose.yml`), puis contrôlez la configuration avant de construire les services :

```bash
docker compose config
docker compose up -d --build
```
*Note : Le réseau externe `nginx-proxy` doit déjà exister sur votre VPS, car il est géré par votre NPM.*

*Note : Le réseau externe `backup-net` doit également exister avant le premier démarrage — il permet à pgBackWeb (autre stack Docker sur le même VPS) d'atteindre le service `db` pour les sauvegardes. Créez-le une seule fois avec :*
```bash
docker network create backup-net
```
*Ajoutez ensuite ce même réseau externe `backup-net` au service pgBackWeb dans son propre `docker-compose.yml`, puis connectez-vous à la base depuis pgBackWeb avec l'hôte `iris_db` (nom du conteneur), le port `5432` et les identifiants définis dans votre `.env`.*

*Note : depuis le lot P0 (#280), le réseau interne de la stack s'appelle `iris-network` (auparavant `noxia-network`). Sur une installation existante, `docker compose up -d --build` crée le nouveau réseau et y recrée les trois conteneurs (coupure de quelques secondes ; volumes, réseaux externes et noms de conteneurs inchangés) ; l'ancien réseau, désormais inutilisé, reste. Repérez-le avec `docker network ls` (son nom est préfixé par celui du projet Compose, par défaut le dossier du dépôt : `noxia-iris-chantier_noxia-network` avec le clonage de la section 1), puis supprimez-le : `docker network rm <projet>_noxia-network`.*

### Migrations de base de données

Les **migrations Prisma sont appliquées automatiquement** au démarrage du conteneur
backend (`prisma migrate deploy`). Pour faire évoluer le schéma par la suite :

1. En local, modifiez `server/prisma/schema.prisma` puis créez la migration :
   `npx prisma migrate dev --name description_du_changement`
2. Commitez le dossier généré dans `server/prisma/migrations/`.
3. Sur le VPS, `docker compose up -d --build` rejoue les nouvelles migrations.

### Sauvegarde de la base

Les données vivent dans le volume Docker `postgres_data`. Pour un export :

```bash
docker exec iris_db pg_dump -U iris iris > sauvegarde_$(date +%F).sql
```

## 4. Configuration dans Nginx Proxy Manager (NPM)

Rendez-vous sur l'interface web de votre Nginx Proxy Manager pour créer le proxy de votre nom de domaine (ex: `iris.noxia.com`).

Dans **Proxy Hosts** > **Add Proxy Host** :

1. **Domain Names** : `votre-domaine.com`
2. **Scheme** : `http`
3. **Forward Hostname / IP** : `iris_frontend` *(C'est le nom exact du conteneur frontend défini dans le docker-compose)*
4. **Forward Port** : `80`
5. **Block Common Exploits** : Coché (Recommandé)
6. **Websockets Support** : Coché

Dans l'onglet **SSL** :
- Sélectionnez "Request a new SSL Certificate" (Let's Encrypt).
- Cochez "Force SSL".
- Acceptez les conditions et enregistrez.

Si le proxy HTTPS est configuré et la stack saine, vérifier l'accès, l'authentification Entra, le secours, les migrations et les parcours métier. Une sauvegarde ponctuelle ne valide pas une stratégie de reprise : tester aussi la restauration sur une base isolée. Le feu vert de production dépend de la [recette de sortie](docs/ROADMAP-PASSATION.md) et de la décision de Nelson.
