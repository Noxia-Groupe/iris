# Configuration d’environnement Iris

Iris est en développement : une nouvelle installation part d’une base PostgreSQL vierge. Les fichiers `.env` contiennent des paramètres propres à une instance et ne doivent jamais être versionnés.

## Fichiers à créer

```bash
cp .env.example .env
cp server/.env.example server/.env
```

Les deux fichiers ont des rôles différents :

- `.env` : variables interpolées par `docker-compose.yml`, principalement la création de PostgreSQL ;
- `server/.env` : variables applicatives chargées par le backend, dont Microsoft Entra ID et les secrets d’administration.

En Docker, `docker-compose.yml` injecte l’URL de base du backend à partir de `POSTGRES_USER`, `POSTGRES_PASSWORD` et `POSTGRES_DB`. En développement local sans Docker, renseigner `DATABASE_URL` dans `server/.env`.

## Variables de la stack

### PostgreSQL

| Variable | Emplacement | Requise | Usage |
|---|---|---:|---|
| `POSTGRES_USER` | `.env` | oui, Docker | utilisateur créé à l’initialisation du volume PostgreSQL ; Compose refuse de démarrer s’il manque |
| `POSTGRES_PASSWORD` | `.env` | oui, Docker | secret du compte PostgreSQL ; Compose refuse de démarrer s’il manque |
| `POSTGRES_DB` | `.env` | oui, Docker | base créée à l’initialisation ; Compose refuse de démarrer s’il manque |
| `DATABASE_URL` | `server/.env` hors Docker | oui hors Docker | connexion Prisma/backend |

Les trois variables `POSTGRES_*` ne reconfigurent pas une base déjà initialisée : pour une instance en développement, les choisir avant le premier démarrage. Ne jamais utiliser une URL de test pour une base de développement ou future production.

### Backend et sécurité

| Variable | Requise | Défaut réel | Conséquence si absente |
|---|---:|---|---|
| `NODE_ENV` | non | `development` | Docker fixe `production`; le backend refuse un `JWT_SECRET` absent en production |
| `PORT` | non | `3001` | port HTTP du backend local |
| `JWT_SECRET` | oui en production | aucune clé sûre | démarrage refusé en production |
| `SUPERADMIN_EMAILS` | oui sur base vierge | liste vide | aucun superadministrateur n’est créé |
| `BREAK_GLASS_EMAIL` | non mais recommandé | vide | accès de secours inactif |
| `BREAK_GLASS_TOKEN` | non mais recommandé | vide | accès de secours inactif; moins de 32 caractères le désactive |

`SUPERADMIN_EMAILS` est une liste d’adresses séparées par des virgules. Les comptes doivent ensuite se connecter avec Microsoft Entra ID. Le jeton de secours a les droits d’un superadministrateur et doit être généré avec `openssl rand -base64 48`, conservé uniquement dans un gestionnaire de mots de passe et changé après usage réel.

### Microsoft Entra ID

| Variable | Requise | Usage |
|---|---:|---|
| `AZURE_TENANT_ID` | oui pour la connexion Microsoft | tenant Entra ID de l’organisation |
| `AZURE_CLIENT_ID` | oui pour la connexion Microsoft | identifiant de l’application SPA |

Créer une application **Single-page application (SPA)** dans Microsoft Entra ID et déclarer l’origine HTTPS exacte de l’instance dans les URI de redirection, par exemple `https://iris.votre-societe.fr`. Aucun secret client Microsoft ne doit être créé ni placé dans un fichier `.env` pour ce flux SPA. Sans les deux identifiants, la connexion Microsoft est indisponible; un accès de secours correctement configuré reste alors la seule porte d’administration.

### Frontend et développement

| Variable | Requise | Défaut réel | Usage |
|---|---:|---|---|
| `VITE_API_URL` | non | `/api` | URL d’API compilée dans le frontend Vite |
| `VITE_DEV_API_TARGET` | non | `http://localhost:3001` | cible du proxy Vite local |

Les variables préfixées `VITE_` sont intégrées dans le JavaScript du navigateur : elles ne doivent jamais contenir de secret. Dans la stack Docker, le frontend est construit avec `VITE_API_URL=/api`.

### Tests et CI

| Variable | Requise | Usage |
|---|---:|---|
| `TEST_DATABASE_URL` | seulement tests API locaux | PostgreSQL jetable pour les tests HTTP/backend |
| `E2E_DATABASE_URL` | seulement E2E locaux | PostgreSQL jetable Playwright |
| `E2E_BASE_URL` | non | URL frontend E2E, défaut `http://127.0.0.1:5199` |
| `E2E_API_PORT` | non | port API E2E, défaut `3001` |
| `CI` | non localement | fourni par GitHub Actions; modifie le reporter et l’isolation Playwright |
| `RELEVE_DATABASE_URL` | seulement comparaison du rendu | PostgreSQL jetable de l'outil de comparaison du rendu |
| `RELEVE_API_PORT`, `RELEVE_PORT_CLIENT` | non | ports de cet outil, défauts `3401` et `5401` |
| `RELEVE_SILENCE_MS` | non | durée de calme exigée avant chaque réponse libérée et chaque relevé, défaut `300` |
| `RELEVE_CHROMIUM` | non | exécutable de Chromium à employer, à défaut celui de Playwright |

Les bases de test sont destructibles. Elles ne doivent jamais viser un volume de développement, ni une instance de production.

En local, lancer les parcours Playwright avec `cd client && npm run test:e2e:local`. Avant Playwright, cette commande :

- régénère le client Prisma et recompile le backend (`server/dist`), que Playwright démarre tel quel ;
- applique les migrations sur `E2E_DATABASE_URL` ;
- refuse une base dont le nom ne contient pas `e2e` ou `test` comme mot (`iris_e2e` ou `iris-test` oui, `production_latest` non), règle commune avec l'outil de comparaison du rendu (`client/scripts/base-jetable.mjs`) ;
- refuse de démarrer si un serveur écoute déjà sur les ports API ou frontend, car Playwright le réutiliserait hors CI.

`npm run test:e2e` seul suppose que ces étapes ont déjà été faites, comme dans la CI.

Si le Chromium installé ne correspond pas à la version attendue par `@playwright/test` (« Executable doesn't exist »), par exemple dans un conteneur fourni avec une autre révision, ne modifiez pas la configuration versionnée : utilisez une surcouche non versionnée qui importe `playwright.config.ts` et fixe `use.launchOptions.executablePath` vers le Chromium disponible. Les chemins de la configuration versionnée (`testDir`, `cwd` des serveurs web) se résolvent depuis le dossier du fichier de configuration chargé : placée hors de `client/`, la surcouche les redéfinit en chemins absolus. Après la préparation de `test:e2e:local` (`node scripts/preparer-e2e.mjs`), lancer `npx playwright test -c <surcouche>` depuis `client/`. Pour l'outil de comparaison du rendu, la variable `RELEVE_CHROMIUM` joue ce rôle.

En CI, les travaux « Backend — tests » et « Frontend — parcours utilisateur » démarrent le PostgreSQL 16 préinstallé du runner Ubuntu 24.04, et non un conteneur tiré d'un registre public, dont les refus (`toomanyrequests`) faisaient échouer des jobs avant tout test. Le script `.github/scripts/postgresql-runner.sh` crée le rôle `iris` et la base jetable en UTF-8 et `C.UTF-8`. Il affiche puis vérifie la version majeure (16), le fuseau du serveur (UTC) ainsi que l'encodage et la collation de la base et de `template1`. En cas d'échec, le job affiche la fin du journal du serveur PostgreSQL.

#### Comparaison du rendu (découpage des écrans)

Les PR qui découpent un gros écran du client ([docs/DECOUPAGE-ECRANS-CIBLE.md](DECOUPAGE-ECRANS-CIBLE.md)) prouvent que le rendu ne change pas avec `cd client && npm run comparer:rendu -- --reference <dossier client de main>`.

**Préparer la référence** : un worktree complet de `main` (avec `server/`), et `npm ci` dans son dossier `client`. Le candidat est par défaut le client où l'on lance la commande (`--candidat` pour un autre). Avec `RELEVE_DATABASE_URL` pointant vers une base jetable, de préférence neuve, l'outil :

- refuse une base dont le nom ne contient pas `e2e` ou `test` comme mot (`iris_releve_test` oui, `production_latest` non), des ports occupés, un `--sortie` non vide, un client sans dépendances, et deux arbres dont le code serveur diffère (sources, schéma, migrations, dépendances, `tsconfig.json`) : il compare deux clients servis par le même serveur ;
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
3. vérifier les URI de redirection Entra ID avant d’essayer la connexion ;
4. lancer `docker compose config` pour vérifier l’interpolation des variables sans démarrer les conteneurs ;
5. démarrer la stack avec `docker compose up -d --build`.
