# Tests du backend Iris

Deux niveaux, lancés ensemble par `npm test` :

| Fichier | Ce qu'il vérifie | Base de données |
|---|---|---|
| `validation.test.mjs` | Règles de saisie et calculs purs, appelés directement | non |
| `securite.test.mjs` | Empreinte des clés API, comparaison à temps constant | non |
| `serveur.test.mjs` | Délais de connexion du serveur HTTP, sur une vraie connexion TCP | non |
| `api.test.mjs` | Requêtes HTTP réelles sur l'application montée en mémoire | **oui** |
| `environnement.test.mjs` | Chaque variable d'environnement lue par le code est documentée dans un modèle `.env.example` et dans `docs/CONFIGURATION-ENVIRONNEMENT.md` | non |

## Pourquoi pas de test qui relit le code source

Une version précédente de ces tests lisait `index.ts` en texte et vérifiait par expression
régulière que telle route y était écrite. Ces tests passaient au vert sur une branche qui
**ne compilait pas** : ils ne prouvaient que la présence de caractères dans un fichier.

Un test doit exécuter le code : appeler la fonction, ou envoyer la requête et lire la
réponse. C'est la règle ici.

Seule exception : `environnement.test.mjs`, qui met en œuvre la consigne de Nelson du
20-10-2026 (choix par défaut, à confirmer). Il ne prétend rien prouver du comportement : la
propriété qu'il vérifie porte sur le texte lui-même, à savoir que chaque variable
d'environnement que le code lit figure dans un modèle et dans la documentation de
configuration. Son premier test est un témoin du relevé : il éprouve chaque motif sur un
échantillon, puis vérifie que les variables connues (Microsoft 365, secret JWT, base…) sont
trouvées dans chaque groupe ; un motif cassé fait donc échouer le test au lieu de laisser les
autres passer à vide. Le relevé ne voit que les formes écrites en toutes lettres : une lecture
par un nom calculé (`process.env[nom]`) lui échappe, et un accès indirect est refusé : alias
(`const env = process.env`, typé ou converti par `as`), `const { env } = process`,
`process['env']`. Le relevé lit aussi les commentaires et les chaînes : une lecture citée en
exemple y compte comme une vraie lecture. Pour qu'elle ne compte pas, la citer sous une autre
forme, par exemple « la variable X de process.env ».

Côté client, `client/tests/identite.test.ts` (lot P0) relève de la même exception : il vérifie
que ni le nom de l'ancienne société, sous aucune graphie, ni les trois bleus de son ancienne
marque ne sont écrits dans le code livré (hors deux migrations déjà appliquées), propriété du
texte lui-même ; l'affichage du nom de l'application est prouvé par l'E2E `identite-application`.

## Lancer les tests

```bash
npm test          # tout ; les tests HTTP sont ignorés s'il n'y a pas de base de test
```

`npm test` compile d'abord (`tsc`) puis exécute `tests/run.mjs`, qui découvre les fichiers
`*.test.mjs` de ce dossier et les passe à `node --test`.

Ce petit lanceur remplace un glob `node --test "tests/**/*.test.mjs"` : les globs ne sont
développés qu'à partir de Node 21, alors que la production et la CI tournent sous Node 20
(cf. les Dockerfile) — la commande y échouait sur « Could not find ». Lister les fichiers à
la main dans `package.json` marcherait aussi, mais rouvrirait le piège que ces tests
existent pour fermer : un test ajouté et jamais exécuté faute d'avoir été inscrit quelque
part. La découverte est donc automatique.

Node 20.11 au moins : deux tests du jour de la société figent l'horloge du processus avec
`mock.timers` (`Date`), que Node ne simule qu'à partir de cette version. La CI installe la
dernière version 20.

Les tests HTTP ont besoin d'une base PostgreSQL **jetable** (ils écrivent et suppriment des
données). Ne pointez jamais `TEST_DATABASE_URL` vers une base de production.

```bash
# Une base de test avec Docker
docker run --rm -d --name iris_test_db -e POSTGRES_PASSWORD=test -e POSTGRES_USER=iris \
  -e POSTGRES_DB=iris_test -p 5433:5432 postgres:16-alpine

export TEST_DATABASE_URL="postgresql://iris:test@localhost:5433/iris_test?schema=public"
npm test
docker stop iris_test_db
```

Sans `TEST_DATABASE_URL`, `api.test.mjs` s'annonce ignoré au lieu d'échouer : la suite
reste utilisable sur un poste sans Docker, sans faire croire à une couverture qui n'existe
pas.
