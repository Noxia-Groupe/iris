# Tests du backend Iris

Deux niveaux, lancés ensemble par `npm test` :

| Fichier | Ce qu'il vérifie | Base de données |
|---|---|---|
| `validation.test.mjs` | Règles de saisie et calculs purs, appelés directement | non |
| `securite.test.mjs` | Empreinte des clés API, comparaison à temps constant | non |
| `serveur.test.mjs` | Délais de connexion du serveur HTTP, sur une vraie connexion TCP | non |
| `api.test.mjs` | Requêtes HTTP réelles sur l'application montée en mémoire | **oui** |
| `chantier-saisie-montants.test.mjs` | Saisie des heures vendues et des budgets du chantier (`PATCH /api/chantiers/:id`, #393) : formes admises relues exactement en base, formes refusées (400, rien n'est écrit), ordre des contrôles ; requêtes HTTP réelles sur une base jetable propre au fichier, créée à côté de celle de `TEST_DATABASE_URL`, migrée puis supprimée | **oui** |
| `envoi-rapport-chantier.test.mjs` | Envoi du rapport de chantier remis au client par la messagerie (`GET` et `POST /api/chantiers/:id/envois`, lot 6a-4e) : proposition, objet et texte sans montant ni heures, journal des envois, administration seule, ordre des contrôles, chantier annulé, verrou, migration du journal ; requêtes HTTP réelles sur une base jetable propre au fichier, créée à côté de celle de `TEST_DATABASE_URL`, migrée puis supprimée | **oui** |
| `compte-rendu-pdf.test.mjs` | PDF du compte rendu d'intervention (`GET /api/interventions/:id/document.pdf`, lot 6a-4a) : contenu, date et heure au fuseau de la société, signatures reproduites en vectoriel, « Non signé par le client » sans le motif, ni heures ni matériel ni montants, droits et refus par type de compte, identité incomplète (409), caractères hors WinAnsi ; requêtes HTTP réelles sur une base jetable propre au fichier, créée à côté de celle de `TEST_DATABASE_URL`, migrée puis supprimée | **oui** |
| `contrat-pdf.test.mjs` | PDF du contrat de maintenance (`GET /api/contrats-maintenance/:id/document.pdf`, lot 6a-4b) : contenu, visites, aucun montant, identité actuelle, dates, contrats suspendu, terminé et annulé, administration seule (403, 401, clé d'intégration refusée), 404, identité incomplète (409), nom du fichier ; requêtes HTTP réelles sur une base jetable propre au fichier, créée à côté de celle de `TEST_DATABASE_URL`, migrée puis supprimée | **oui** |
| `rapport-chantier-pdf.test.mjs` | Rapport de chantier remis au client (`GET /api/chantiers/:id/document.pdf`, lot 6a-4c) : contenu, dates au fuseau de la société, ni montant ni heures, chantier annulé, interventions imprimées et leurs comptes rendus, cas limites, administration seule, refus, nom du fichier ; requêtes HTTP réelles sur une base jetable propre au fichier, créée à côté de celle de `TEST_DATABASE_URL`, migrée puis supprimée | **oui** |
| `envoi-compte-rendu-contrat.test.mjs` | Envoi du compte rendu d'intervention et du contrat de maintenance par la messagerie (`GET` et `POST /api/interventions/:id/envois` et `/api/contrats-maintenance/:id/envois`, lot 6a-4d) : proposition du destinataire, objet et texte, journal des envois en ajout seul, droits (dont `clients:read` pour le compte rendu), ordre des contrôles, annulation, verrous, migration du journal (déclencheurs, un seul document par envoi, clés étrangères) ; requêtes HTTP réelles sur une base jetable propre au fichier, créée à côté de celle de `TEST_DATABASE_URL`, migrée puis supprimée | **oui** |
| `production-pdf.test.mjs` | Production commune des PDF (lot 6b-1a) : en-têtes, refus exacts et leur ordre, droits et périmètre des cinq routes « PDF », pièces émises figées et ordre de leurs lignes, PDF identique d'un tirage à l'autre, hors `CreationDate` et `/ID` ; requêtes HTTP réelles sur une base jetable propre au fichier, créée à côté de celle de `TEST_DATABASE_URL`, migrée puis supprimée | **oui** |
| `contrat-motif-migration.test.mjs` | Migration `20261007120000_contrat_journal_motif_obligatoire` : l'historique du journal des contrats est conservé, et une suspension, une clôture, une réactivation, un avancement d'échéance ou une modification de couverture sans motif (ou à motif blanc) est refusé (23514) ; migrations jusqu'à `20260925120000_journal_activation_comptes`, puis `20261007120000_contrat_journal_motif_obligatoire` sur une base jetable créée et supprimée par le test (`TEST_DATABASE_URL` ne sert que de connexion administrative) | **oui** |
| `date-demande-migration.test.mjs` | Migration `20261007130000_intervention_date_demande` : la date de demande historique reste vide (aucune date inventée) et ne se renseigne qu'une fois, dans le respect du début du contrat ; le rattachement d'une intervention au contrat d'un autre client est refusé (23514) ; base jetable créée et supprimée par le test | **oui** |
| `facture-ecritures-migration.test.mjs` | Migration `20261007140000_facture_ecritures_figees` : refusée (P3018, « reprise comptable validée requise ») sur une base qui porte déjà une pièce numérotée, sans la reconstruire depuis les règles actuelles ; la pièce et son statut restent intacts ; base jetable créée et supprimée par le test | **oui** |
| `envoi-microsoft-365.test.mjs` | Envoi des documents par Microsoft 365 (lot 6b-1b) : les cinq routes `POST …/envois` avec `canal: MICROSOFT_365`, contre un Microsoft Graph simulé désigné par `MICROSOFT_GRAPH_URL` ; message et PDF envoyés, journal (expéditeur, empreinte, texte), refus et leur ordre, expéditeur contrôlé, échecs de Graph (refus, issue incertaine, envoi non noté), mode d'envoi réglé par le super administrateur (`PUT /api/modules` partiel), `proposition.microsoft365`, migration du journal, jeton jamais gardé ni rendu, concurrence ; requêtes HTTP réelles sur une base jetable propre au fichier, créée à côté de celle de `TEST_DATABASE_URL`, migrée puis supprimée | **oui** |
| `matrice-droits-entrees.test.mjs` | Matrice de non-régression des droits, entrées (lot D1a-1) : pour chaque route de session, chaque type de compte et ses variantes, et chaque cible nommée de la famille de la route, la réponse à l'entrée (code, et message exact d'un refus), comparée au caractère près à la référence versionnée `matrice-droits/entrees.txt` (diff imprimé en cas d'écart) ; refus à l'authentification (401), routes du planning avec le module désactivé, lien public du planning ; écritures (a) jouées à corps vide et (b) sur un identifiant inexistant, l'empreinte de toute la base prouvant qu'aucune n'écrit ; écritures sans corps ni paramètre (c) jouées à la fin, une à la fois, notées « écrit » ou « inchangé » ; couverture des routes de l'application. Outils partagés, comptes, jeu de données et table des routes dans `matrice-droits/` (sans suffixe `.test.mjs`) ; requêtes HTTP réelles sur une base jetable propre au fichier, créée à côté de celle de `TEST_DATABASE_URL`, migrée puis supprimée | **oui** |
| `matrice-droits-cles.test.mjs` | Matrice de non-régression des droits, clés d'intégration (lot D1a-2) : chaque route `/api/v1` jouée avec une clé par scope seul (13), contre chaque cible de la famille de la route, puis avec une clé absente, sous trois formes (sans en-tête `Authorization`, `Bearer` sans le préfixe `iris_`, schéma `Basic`), inconnue, inactive, révoquée par l'API, révoquée mais active (posée en base) ou expirée, et avec le jeton de session d'un compte de chaque type ; la clé aux 13 scopes jouée sur chaque route de session ; réponse à l'entrée comparée au caractère près à la référence `matrice-droits/cles.txt` ; couverture des routes `/api/v1` (porte `requireApiKey` en tête, scope relevé sur sa fermeture conforme à la table) ; aucune écriture (empreinte de toute la base, hors dernière utilisation d'une clé, contrôlée à part clé par clé) ; dernière utilisation notée pour un appel admis sans que la réponse l'attende, jamais pour un refus 401 ou 403 ; requêtes HTTP réelles sur une base jetable propre au fichier, créée à côté de celle de `TEST_DATABASE_URL`, migrée puis supprimée | **oui** |
| `matrice-droits-donnees.test.mjs` | Matrice de non-régression des droits, données visibles (lot D1a-3) : pour chaque lecture de session, chaque type de compte et ses variantes, et chaque cible de la famille de la route, les éléments visibles de chaque liste (par le nom de leur cible ou de leur compte), les clés présentes de chaque type d'objet, le statut (« présent », « null » ou « absent », jamais la valeur) de chaque montant de la liste fermée des montants masqués (`matrice-droits/montants-masques.mjs`), les permissions de `GET /api/me` et de `GET /api/users`, les modules de `GET /api/modules` et les portées des clés de `GET /api/admin/api-keys`, le logo posé ; les lectures `/api/v1` par une clé de leur scope, avec et sans `finances:read` ; les lectures qui lisent `margeCommercialeActive`, un destinataire de la rentabilité ou `planningActif`, rejouées le réglage changé seul ; comparaison au caractère près à la référence `matrice-droits/donnees.txt` (diff imprimé en cas d'écart) ; chaque montant de la liste fermée vu présent par un compte qui le voit et masqué pour un compte qui ne le voit pas, et aucun champ masqué selon le demandeur hors de la liste ; les montants mis à zéro par un réglage (`MONTANTS_MIS_A_ZERO`), observés après la matrice sur deux affaires encaissées du commercial, non nuls par défaut et à zéro sous le réglage ; l'accès financier sans effet en session (le comptable titulaire d'un chantier qui le reçoit lit les mêmes données, montants compris) ; l'aperçu de la facture au temps passé, même réponse pour chaque administrateur et refus pour les autres comptes ; requêtes HTTP réelles sur une base jetable propre au fichier, créée à côté de celle de `TEST_DATABASE_URL`, migrée puis supprimée | **oui** |
| `matrice-droits-individuels.test.mjs` | Matrice de non-régression des droits, droits individuels sans gain d'effet (lot D1a-4) : pour chacun des dix types de compte et chaque droit individuel (les 13 scopes relus dans `GET /api/admin/api-scopes`, l'accès financier et la case « droit devis »), le droit donné au compte du type par la route d'administration (`PUT /api/users/:id/permissions`, `PATCH /api/users/:id/acces-finance`) puis retiré ; octroi refusé au technicien (`DROITS_INTERDITS_TECHNICIEN`), noté, puis droit posé en base ; cas rejoués là où le même type sans droit est refusé ou reçoit un 400 marqué `validation-avant-droit` (réponses de `matrice-droits/entrees.txt`), ou voit sur une lecture autre chose que le super administrateur ou moins de montants qu'un autre compte (outils de D1a-3), d'abord par une sonde portant tous les droits, puis par groupe de droits, puis droit par droit sur les cas que la sonde de son groupe change, avec la lecture de `GET /api/me` et une lecture de chaque montant de la liste fermée que le type ne voit pas ; ce que le droit ajoute au même type sans droit : les gains (refus devenu 2xx ou 400 sans `validation-avant-droit`, élément ou champ en plus, statut des montants sans leur valeur) comparés au caractère près à `matrice-droits/individuels.txt`, et à part les changements sans gain et les octrois refusés, à `matrice-droits/individuels-sans-gain.txt` (diff imprimé, résumé par compte, droit et route) ; chaque droit joué sur chaque montant de la liste fermée, sous son réglage pour ceux qu'un réglage seul masque, et sur les montants mis à zéro par la marge commerciale coupée, après les comparaisons ; aucune écriture (empreinte de toute la base entre l'octroi et le retrait de chaque droit) ; requêtes HTTP réelles sur une base jetable propre au fichier, créée à côté de celle de `TEST_DATABASE_URL`, migrée puis supprimée | **oui** |
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
que ni le nom de l'ancienne société, avec O ou Ø et quelle que soit la casse, ni les trois bleus
de son ancienne marque ne sont écrits dans le code livré (hors deux migrations déjà appliquées),
propriété du texte lui-même ; l'affichage du nom de l'application est prouvé par l'E2E
`identite-application`.

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
