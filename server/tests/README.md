# Tests du backend Iris

Deux niveaux, lancés ensemble par `npm test` :

| Fichier | Ce qu'il vérifie | Base de données |
|---|---|---|
| `validation.test.mjs` | Règles de saisie et calculs purs, appelés directement | non |
| `securite.test.mjs` | Empreinte des clés API, comparaison à temps constant | non |
| `api.test.mjs` | Requêtes HTTP réelles sur l'application montée en mémoire | **oui** |

## Pourquoi pas de test qui relit le code source

Une version précédente de ces tests lisait `index.ts` en texte et vérifiait par expression
régulière que telle route y était écrite. Ces tests passaient au vert sur une branche qui
**ne compilait pas** : ils ne prouvaient que la présence de caractères dans un fichier.

Un test doit exécuter le code : appeler la fonction, ou envoyer la requête et lire la
réponse. C'est la règle ici.

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
