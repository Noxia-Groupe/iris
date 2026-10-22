# Configuration d’environnement Iris

Iris est en développement : une nouvelle installation part d’une base PostgreSQL vierge. Les fichiers `.env` contiennent des paramètres propres à une instance et ne doivent jamais être versionnés.

## Fichiers à créer

```bash
cp .env.example .env
cp server/.env.example server/.env
```

Les deux fichiers sont obligatoires et ont des rôles différents :

- `.env` (fichier 1 sur 2) : variables interpolées par `docker-compose.yml`, c'est-à-dire les trois `POSTGRES_*`. Les autres lignes de `.env.example` documentent des variables d'outils à exporter dans le shell : ni Docker Compose ni Vite ne les lisent dans ce fichier.
- `server/.env` (fichier 2 sur 2) : variables de l'application, dont la connexion Microsoft 365, les secrets et les comptes d'administration. Docker Compose le charge (`env_file`) et refuse de démarrer s'il n'existe pas. `.env.example` en rappelle la liste.

En Docker, `docker-compose.yml` impose au backend `PORT=3001`, `NODE_ENV=production` et une `DATABASE_URL` construite à partir de `POSTGRES_USER`, `POSTGRES_PASSWORD` et `POSTGRES_DB`. Sa section `environment` l'emporte sur `server/.env` : ces trois variables y sont ignorées. En développement local sans Docker, renseigner `DATABASE_URL` dans `server/.env`.

Après une modification de `server/.env` sur un serveur Docker, recréer le conteneur, car `docker compose restart` ne relit pas `env_file` :

```bash
docker compose up -d --force-recreate backend
```

Éviter le caractère `$` dans les valeurs, que Docker Compose peut interpréter, ou entourer la valeur d'apostrophes simples.

## Variables de la stack

### PostgreSQL

| Variable | Emplacement | Requise | Usage |
|---|---|---:|---|
| `POSTGRES_USER` | `.env` | oui, Docker | utilisateur créé à l’initialisation du volume PostgreSQL ; Compose refuse de démarrer s’il manque |
| `POSTGRES_PASSWORD` | `.env` | oui, Docker | secret du compte PostgreSQL ; Compose refuse de démarrer s’il manque |
| `POSTGRES_DB` | `.env` | oui, Docker | base créée à l’initialisation ; Compose refuse de démarrer s’il manque |
| `DATABASE_URL` | `server/.env` hors Docker | oui hors Docker | connexion Prisma/backend ; ignorée sous Docker Compose, qui la construit |

Les trois variables `POSTGRES_*` ne reconfigurent pas une base déjà initialisée : pour une instance en développement, les choisir avant le premier démarrage. Ne jamais utiliser une URL de test pour une base de développement ou future production.

### Backend et sécurité

| Variable | Requise | Défaut réel | Conséquence si absente |
|---|---:|---|---|
| `NODE_ENV` | non | `development` | Docker fixe `production` (valeur de `server/.env` ignorée) ; le backend refuse un `JWT_SECRET` absent en production |
| `PORT` | non | `3001` | port HTTP du backend local ; Docker fixe `3001`, que le nginx du frontend vise en dur |
| `JWT_SECRET` | oui en production | aucune clé sûre | démarrage refusé en production, aussi pour une valeur `CHANGE_ME` ou commençant par `CHANGE_ME_` |
| `SUPERADMIN_EMAILS` | oui sur base vierge | liste vide | aucun superadministrateur n’est créé |
| `BREAK_GLASS_EMAIL` | non mais recommandé | vide | accès de secours inactif |
| `BREAK_GLASS_TOKEN` | non mais recommandé | vide | accès de secours inactif; moins de 32 caractères le désactive |
| `GENERATION_VISITES_AUTOMATIQUE` | non | vide (actif) | `0` arrête sur ce serveur le passage quotidien qui crée les visites des contrats de maintenance ; à laisser vide en production |

`JWT_SECRET` signe les sessions (JWT HS256, 7 jours pour Microsoft, 1 heure pour le secours) et les aperçus d'import du plan comptable. Le générer avec `openssl rand -base64 48`. Le changer déconnecte tout le monde et invalide les aperçus d'import en cours.

`SUPERADMIN_EMAILS` est une liste d’adresses séparées par des virgules. Ces comptes sont créés ou promus à chaque démarrage, et une liste vide ne retire personne. Chaque adresse doit être celle que Microsoft renvoie à la connexion, sans tenir compte des majuscules : le claim `email` du jeton, c'est-à-dire l'adresse de messagerie de l'utilisateur dès qu'il en a une, sinon `preferred_username`, en pratique l'UPN. Si l'adresse de messagerie diffère de l'UPN, c'est elle qui compte. Y ajouter `BREAK_GLASS_EMAIL`. L'adresse réservée du compte système (`systeme@iris.invalid`) n'y a pas sa place, ni dans `BREAK_GLASS_EMAIL` : le démarrage la signale et l'ignore, et l'accès de secours reste alors inactif.

Le passage quotidien de la génération des visites (lot pilote 5) tourne dans le processus du backend : à son démarrage, puis toutes les 15 minutes, il vérifie si le passage du jour civil de la société a eu lieu. L'anticipation se règle dans l'écran Contrats de maintenance ; vide, ce qui est le cas au démarrage d'une nouvelle instance, la génération automatique est désactivée. `GENERATION_VISITES_AUTOMATIQUE=0` n'arrête que ce passage, sur ce serveur : les tests de bout en bout et l'outil de comparaison du rendu le fixent pour qu'aucune visite ne se crée pendant qu'ils tournent. L'écran l'indique, et le passage lancé à la main reste possible.

Le jeton de secours a les droits d’un superadministrateur. Le générer avec `openssl rand -hex 32` : un jeton en base64 contenant `+` échoue dans le lien `#token=`, qui lit ce caractère comme une espace (#262). Le conserver uniquement dans `server/.env` et dans un gestionnaire de mots de passe, et le changer après usage réel. Le compte de `BREAK_GLASS_EMAIL` doit exister, être actif et avoir le rôle SUPERADMIN. La session dure une heure ; cinq essais manqués en quinze minutes bloquent l'accès. Derrière les proxys de production, ce blocage est aujourd'hui commun à tous les clients, faute de réglage `trust proxy` (#261).

### Microsoft Entra ID (Microsoft 365)

| Variable | Requise | Usage |
|---|---:|---|
| `AZURE_TENANT_ID` | oui pour la connexion Microsoft | « ID de l'annuaire (locataire) », un GUID : construit l'émetteur attendu (`https://login.microsoftonline.com/<GUID>/v2.0`) et l'adresse des clés de signature |
| `AZURE_CLIENT_ID` | oui pour la connexion Microsoft | « ID d'application (client) », un GUID : audience attendue du jeton d'ID et identifiant de l'application pour MSAL |

Ces deux valeurs se renseignent dans `server/.env` seulement. Elles sont publiques par nature pour une application monopage : le navigateur les reçoit par `GET /api/config`, et le frontend n'a aucune variable `VITE_` à renseigner pour Microsoft 365. Sans elles, la page de connexion affiche « La connexion Microsoft 365 n'est pas activée sur ce serveur » ; un accès de secours correctement configuré reste alors la seule porte d’administration. `AZURE_TENANT_ID` doit être le GUID, et non un nom de domaine, ni `common` ou `organizations` : l'émetteur du jeton est vérifié strictement contre lui. Avec un nom de domaine, Microsoft connecte l'utilisateur, puis Iris refuse le jeton : l'API répond `SSO_TOKEN_INVALID` et la page affiche « Jeton Microsoft invalide ou non vérifié. ». Avec `common`, Microsoft refuse dès sa fenêtre une application à locataire unique (AADSTS50194). Le même message « Jeton Microsoft invalide ou non vérifié. » apparaît aussi quand le backend ne joint pas `login.microsoftonline.com` ou que son horloge dérive.

Inscription d'application à créer dans le portail Azure (Microsoft Entra ID > Inscriptions d'applications > Nouvelle inscription), nommée « Iris » : Microsoft affiche ce nom à la connexion et au consentement, et l'application ne porte le nom d'aucune société (lot P0, #280). Une inscription existante qui porte un autre nom se renomme dans « Personnalisation et propriétés ».

1. **Types de comptes** : « Comptes dans cet annuaire organisationnel uniquement ».
2. **Plateforme** : « Application monopage (SPA) ». **URI de redirection exacte : `https://<domaine-de-l-instance>/auth/callback`.** Pas l'origine seule : Microsoft refuserait la connexion (erreur AADSTS50011). Déclarer une URI par nom d'hôte réellement utilisé. Une URI déclarée sur la plateforme « Web » ne fonctionne pas. En développement local, `http://localhost:5173/auth/callback` (port par défaut de Vite).
3. **Aucun secret client ni certificat**, aucun « Exposer une API », aucune URI d'ID d'application. Octroi implicite : ne cocher ni « Jetons d'accès » ni « Jetons d'ID » (MSAL utilise le code d'autorisation avec PKCE).
4. **Autorisations** : déléguées Microsoft Graph `openid`, `profile` et `email`, auxquelles la bibliothèque ajoute `offline_access`. Si le tenant restreint le consentement des utilisateurs, un administrateur doit l'accorder.
5. **Claim `email` : rien à configurer.** La portée `email` demandée par Iris suffit pour que le jeton d'ID porte le claim `email`, l'adresse de messagerie de l'utilisateur, dès qu'il en a une ; le claim optionnel `email` de « Configuration du jeton » n'y ajoute rien. À défaut d'adresse de messagerie, Iris prend `preferred_username`, en pratique l'UPN.
6. Recopier « ID de l'annuaire (locataire) » dans `AZURE_TENANT_ID` et « ID d'application (client) » dans `AZURE_CLIENT_ID`, puis recréer le conteneur du backend.

Conditions de fonctionnement :

- chaque utilisateur doit aussi exister, actif, dans Iris (Administration > Utilisateurs), sous l'adresse renvoyée par Microsoft (claim `email`, c'est-à-dire l'adresse de messagerie, sinon UPN). Il n'y a pas de création automatique, hors `SUPERADMIN_EMAILS` ;
- le backend doit joindre `https://login.microsoftonline.com` en HTTPS sortant direct pour lire les clés de signature (le `fetch` de Node 20 ignore `HTTPS_PROXY`), et son horloge doit être synchronisée (NTP) : l'expiration des jetons est vérifiée sans tolérance ;
- les fenêtres surgissantes doivent être autorisées dans le navigateur, car la connexion s'ouvre dans une fenêtre Microsoft ;
- vérification : `https://<domaine>/api/config` doit répondre `"ssoConfigured":true`.

### Frontend et développement

| Variable | Requise | Défaut réel | Usage |
|---|---:|---|---|
| `VITE_API_URL` | non | `/api` | URL d’API compilée dans le frontend Vite, au moment du build |
| `VITE_DEV_API_TARGET` | non | `http://localhost:3001` | cible du proxy Vite local, lue au démarrage de `npm run dev` |

Les variables préfixées `VITE_` sont intégrées dans le JavaScript du navigateur : elles ne doivent jamais contenir de secret. Dans la stack Docker, le frontend est construit avec `VITE_API_URL=/api` (`client/Dockerfile`). La ligne `VITE_API_URL=/api` de la section `environment` du service `frontend` de `docker-compose.yml` est sans effet, puisque la valeur est déjà compilée. Hors Docker, ces deux variables s'exportent dans le shell avant la commande : Vite ne lit pas `VITE_DEV_API_TARGET` dans un fichier `.env`, et le `.env` racine n'est lu par aucun des deux.

### Tests et CI

| Variable | Requise | Usage |
|---|---:|---|
| `TEST_DATABASE_URL` | seulement tests API locaux | PostgreSQL jetable pour les tests HTTP/backend, sur `localhost` ou `127.0.0.1` ; les tests de migration y créent leurs propres bases (droit CREATEDB) |
| `E2E_DATABASE_URL` | seulement E2E locaux | PostgreSQL jetable Playwright |
| `E2E_BASE_URL` | non | URL frontend E2E, défaut `http://127.0.0.1:5199` |
| `E2E_API_PORT` | non | port API E2E, défaut `3001` |
| `CI` | non localement | fourni par GitHub Actions; modifie le reporter et l’isolation Playwright |
| `RELEVE_DATABASE_URL` | seulement comparaison du rendu | PostgreSQL jetable de l'outil de comparaison du rendu |
| `RELEVE_API_PORT`, `RELEVE_PORT_CLIENT` | non | ports de cet outil, défauts `3401` et `5401` |
| `RELEVE_SILENCE_MS` | non | durée de calme exigée avant chaque réponse libérée et chaque relevé, défaut `300` |
| `RELEVE_CHROMIUM` | non | exécutable de Chromium à employer, à défaut celui de Playwright |

Les bases de test sont destructibles. Elles ne doivent jamais viser un volume de développement, ni une instance de production. Ces variables s'exportent dans le shell avant la commande de test : aucune n'est lue dans un fichier `.env`. En particulier, `TEST_DATABASE_URL` écrite dans `server/.env` est ignorée, et les tests HTTP et de migration sont alors ignorés (`SKIP`), ce qui n'est pas une réussite.

En local, lancer les parcours Playwright avec `cd client && npm run test:e2e:local`. Avant Playwright, cette commande :

- régénère le client Prisma et recompile le backend (`server/dist`), que Playwright démarre tel quel ;
- applique les migrations sur `E2E_DATABASE_URL` ;
- refuse une base dont le nom ne porte ni `e2e` ni `test`, quelle que soit la casse, comme mot, en bord de nom ou séparé par `_` ou `-`, ou s'écrit avec d'autres caractères que des lettres sans accent, des chiffres, `_` et `-` (`iris_e2e`, `iris-test`, `iris_e2e_2` oui ; `production_latest`, `iris_tests`, `iris_test2`, `iris.test`, `production/iris_e2e` non). C'est la règle commune avec l'outil de comparaison du rendu (`client/scripts/base-jetable.mjs`) ;
- refuse de démarrer si un serveur écoute déjà sur les ports API ou frontend, car Playwright le réutiliserait hors CI.

`npm run test:e2e` seul suppose que ces étapes ont déjà été faites, comme dans la CI.

Pour lancer en même temps les parcours de deux copies de travail, donner à chacune sa propre base (`E2E_DATABASE_URL`), son port d'API (`E2E_API_PORT`) et son port de frontend (celui de `E2E_BASE_URL`) ; la cible du proxy Vite suit `E2E_API_PORT`. Hors CI, Playwright réutilise sans avertissement un serveur qui répond déjà sur ces ports : avec les ports par défaut, la seconde copie testerait le serveur, le client et la base de la première. La préparation de `test:e2e:local` ne vérifie les ports qu'une fois, avant la compilation : ni le `playwright test` qui la suit, ni un `npx playwright test` lancé à part ne le refont.

Si le Chromium installé ne correspond pas à la version attendue par `@playwright/test` (« Executable doesn't exist »), par exemple dans un conteneur fourni avec une autre révision, ne modifiez pas la configuration versionnée : utilisez une surcouche non versionnée qui importe `playwright.config.ts` et fixe `use.launchOptions.executablePath` vers le Chromium disponible. Les chemins de la configuration versionnée (`testDir`, `cwd` des serveurs web) se résolvent depuis le dossier du fichier de configuration chargé : placée hors de `client/`, la surcouche les redéfinit en chemins absolus. Après la préparation de `test:e2e:local` (`node scripts/preparer-e2e.mjs`), lancer `npx playwright test -c <surcouche>` depuis `client/`. Pour l'outil de comparaison du rendu, la variable `RELEVE_CHROMIUM` joue ce rôle.

En CI, les travaux « Backend — tests » et « Frontend — parcours utilisateur » démarrent le PostgreSQL 16 préinstallé du runner Ubuntu 24.04, et non un conteneur tiré d'un registre public, dont les refus (`toomanyrequests`) faisaient échouer des jobs avant tout test. Le script `.github/scripts/postgresql-runner.sh` crée le rôle `iris` et la base jetable en UTF-8 et `C.UTF-8`. Il affiche puis vérifie la version majeure (16), le fuseau du serveur (UTC) ainsi que l'encodage et la collation de la base et de `template1`. En cas d'échec, le job affiche la fin du journal du serveur PostgreSQL.

#### Comparaison du rendu (découpage des écrans)

Les PR qui découpent un gros écran du client ([docs/DECOUPAGE-ECRANS-CIBLE.md](DECOUPAGE-ECRANS-CIBLE.md)) prouvent que le rendu ne change pas avec `cd client && npm run comparer:rendu -- --reference <dossier client de main>`.

**Préparer la référence** : un worktree complet de `main` (avec `server/`), et `npm ci` dans son dossier `client`. Le candidat est par défaut le client où l'on lance la commande (`--candidat` pour un autre). Avec `RELEVE_DATABASE_URL` pointant vers une base jetable, de préférence neuve, l'outil :

- refuse une base dont le nom ne suit pas la règle commune des bases jetables, décrite plus haut (`iris_releve_test` oui, `production_latest` non ; `client/scripts/base-jetable.mjs`), des ports occupés, un `--sortie` non vide, un client sans dépendances, et deux arbres dont le code serveur diffère (sources, schéma, migrations, dépendances, `tsconfig.json`) : il compare deux clients servis par le même serveur ;
- régénère le client Prisma et recompile le serveur **du candidat** (son `server/dist` est réécrit), migre la base, démarre le serveur, puis crée par l'API un jeu de données qui rend les sections que le découpage déplace ;
- sert l'un après l'autre, sur le même port, le client de référence puis le candidat, et y relève les mêmes étapes sans aucune écriture (toute requête autre que GET est bloquée et relevée) :
  - **administration** : les neuf onglets, l'édition en ligne avec saisie, le formulaire d'autorisation et le choix d'un responsable hiérarchique ouvert, pour le super administrateur ; l'administrateur et le conducteur ;
  - **fiche chantier** : la modale, les corrections, les filtres, le tri et la recherche des journaux, le choix du commercial ouvert, pour l'administration ; le conducteur et le technicien titulaires ; des chantiers terminés en attente d'encaissement et encaissé ;
  - **planning** : la grille, la file, chaque modale et chaque branche de la modale d'affectation (heures précises, événement, nouveau type, affectation issue d'une intervention), le placement d'une visite et d'une curative, le partage, pour l'administration ; le conducteur et le technicien ;
- relève à chaque étape l'URL, la liste ordonnée des requêtes API, l'état des champs et le HTML de `<main>`, où sont rendues les modales, ainsi que tout dialogue ou calque fixe rendu hors de `<main>`. L'horloge du navigateur est figée au même instant pour les deux relevés. Les réponses API sont libérées une à une, dans l'ordre d'émission. Avant chaque libération et chaque relevé, l'outil attend que toutes les requêtes émises par la page soient interceptées et que le DOM n'ait pas changé pendant `RELEVE_SILENCE_MS` (300 ms par défaut). Les requêtes hors de l'origine du client (polices en ligne, services du navigateur) sont abandonnées ;
- compare les deux relevés. **Codes de sortie** : 0 s'ils sont identiques, 1 s'ils diffèrent (avec la première ligne qui diffère pour chaque étape), 2 en cas de refus ou d'erreur de l'outil. Les relevés, écrits au fil des étapes, et les journaux du serveur et de Vite restent dans `--sortie` (par défaut, un dossier temporaire).

L'horloge du serveur n'est pas figée : l'outil refuse une exécution à cheval sur minuit (Europe/Paris), dont les durées et alertes calculées par le serveur différeraient. `RELEVE_CHROMIUM` désigne au besoin l'exécutable de Chromium (`/opt/pw-browsers/chromium` dans le conteneur de Claude Code). L'outil ne fait pas partie de la CI : une exécution prend environ neuf minutes (dix sous charge).

## Vérifier avant démarrage

1. vérifier que les deux `.env` sont ignorés par Git : `git status --short` ne doit pas les afficher ;
2. s’assurer que `POSTGRES_PASSWORD`, `JWT_SECRET` et `BREAK_GLASS_TOKEN` ne sont pas des valeurs d’exemple ;
3. vérifier que `AZURE_TENANT_ID` et `AZURE_CLIENT_ID` sont les deux GUID de l'inscription Entra ID, et que son URI de redirection est `https://<domaine>/auth/callback` sur la plateforme « Application monopage (SPA) » ;
4. vérifier que `SUPERADMIN_EMAILS` contient l'adresse Microsoft d'au moins un administrateur, et `BREAK_GLASS_EMAIL` ;
5. lancer `docker compose config` pour vérifier l’interpolation des variables sans démarrer les conteneurs ;
6. démarrer la stack avec `docker compose up -d --build` ;
7. vérifier que `https://<domaine>/api/config` répond `"ssoConfigured":true`, puis se connecter avec Microsoft.

## Tenir les modèles à jour

Consigne de Nelson du 20-10-2026 : toute variable d'environnement lue par le code figure dans un modèle versionné et dans ce document, au fil des lots.

- Une PR qui lit une nouvelle variable, ou qui change le rôle, le format ou le caractère obligatoire d'une variable existante, met à jour dans la même PR le modèle concerné et ce document. Le modèle est `server/.env.example` pour le backend et ses tests, `.env.example` pour `docker-compose.yml`, le frontend et les outils du client. Elle indique pour chaque variable son rôle, si elle est obligatoire, un exemple sans secret réel et la conséquence d'une absence.
- Une variable de l'application est aussi rappelée dans la liste en tête de `.env.example`, pour qu'une installation trouve tout à partir de ce fichier.
- Un modèle ne garde aucune variable que plus rien ne lit.
- `server/tests/environnement.test.mjs` vérifie ces règles à chaque `npm test` du backend, donc en CI. Il relève les lectures `process.env`, `import.meta.env`, `env()` de Prisma et les interpolations de `docker-compose.yml`. Seules exceptions : `PATH`, transmise par un outil, et les variables intégrées de Vite (`MODE`, `DEV`, `PROD`, `SSR`, `BASE_URL`) lues par `import.meta.env` ou dans `index.html` ; lues par `process.env`, elles se documentent comme les autres.
- Aucune valeur `CHANGE_ME` non commentée ne doit être ajoutée à `server/.env.example`, hors `JWT_SECRET` : la CI refuse une configuration Docker Compose qui en contient (job « Docker Compose — gardes PostgreSQL »).
