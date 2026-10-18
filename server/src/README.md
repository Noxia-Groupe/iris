# Code du serveur : organisation par domaine

**Découpage en cours** (chantier technique 2, décision de Nelson du 17-10-2026). `server/index.ts` contient encore la plupart des routes. Chaque PR du chantier en déplace un ou deux domaines vers `src/`, **sans aucun changement de comportement** : mêmes routes, mêmes réponses, mêmes codes et messages d'erreur, mêmes transactions, verrous et contraintes différées.

## Structure cible (proposition)

```
server/
  index.ts              point d'entrée : crée l'application, enregistre les domaines dans
                        l'ordre, démarre le serveur ; ré-exporte ce que lisent les tests
  src/
    env.ts              chargement de server/.env
    db.ts               client Prisma, transactionVerifiee
    http/               couche HTTP commune à tous les domaines
      auth.ts           secret JWT, requireAuth, AuthRequest, branche hiérarchique
      gardes.ts         gardes de type de compte (requireAdmin, blockCommercial…)
      requete.ts        lecture des paramètres de requête (paramId)
    droits/             types de compte, permissions, périmètres de lecture
      roles.ts
    commun/             utilitaires partagés : dates (jour civil, fuseau de la société),
                        montants, validation des saisies, journal d'administration, PDF, CSV
    domaines/<domaine>/
      routes.ts         routes HTTP du domaine : enregistrerRoutes<Domaine>(app)
      metier.ts         logique métier du domaine (calculs, contrôles, lectures et écritures
                        réutilisées), sans objet HTTP ; plusieurs fichiers si besoin
```

Domaines prévus :

| Domaine | Contenu |
|---|---|
| `referentiels` | catégories et fournisseurs des achats (**déplacé**) |
| `authentification` | SSO Microsoft, accès de secours, `/api/me`, configuration publique, santé |
| `utilisateurs` | comptes, hiérarchie, commerciaux, conducteurs, fiches intervenant |
| `administration` | clés d'intégration, journal des paramètres et des droits, modules, société |
| `parametres` | paramètres métier, rémunération, registre des entreprises |
| `clients` | clients, contacts, sites, parc d'équipements |
| `catalogue` | prestations, articles, équipements |
| `devis` | devis versionnés, signature, acompte, conversion, duplication |
| `chantiers` | affaires, achats, heures, métriques et suivi |
| `interventions` | SAV, coûts, comptes rendus, placement au planning |
| `contrats` | contrats de maintenance et visites |
| `planning` | affectations, types d'événement, partage public |
| `factures` | factures, avoirs, mentions légales, export comptable |
| `reglements` | encaissements et affectations |
| `comptabilite` | plan comptable, règles, TVA, import, écritures |
| `statistiques` | tableaux de bord et statistiques |
| `commissions` | barème et calcul des commissions |

## Règles du découpage

- **Déplacer, ne pas réécrire.** Le texte est repris tel quel, commentaires compris. Seuls changent les `import`, le mot-clé `export` devant une déclaration, et l'indentation des routes placées dans leur fonction d'enregistrement. Une ligne qui continue une chaîne multiligne n'est jamais réindentée.
- **Ordre des routes conservé.** Chaque `enregistrerRoutes…(app)` est appelé à l'endroit exact où se trouvait le bloc déplacé, si bien qu'Express essaie toujours les routes dans le même ordre.
- **Deux preuves par PR**, à lancer depuis `server/` après `npm run build` :
  - `node scripts/routes.mjs --verifier` compare ce que l'application met en place en se chargeant à `scripts/routes-reference.txt`, écrit depuis `main` avant le découpage. La CI le rejoue. Il compare :
    - les variables d'environnement lues pendant le chargement, avant et après `dotenv.config()` (`*` pour une énumération de `process.env`), et le nombre d'appels à `dotenv.config()` : une variable de l'application lue avant le chargement de `.env` en ignorerait la valeur ;
    - les réglages et les middlewares, avec leurs chemins ;
    - les routes, dans l'ordre où Express les essaie ;
    - pour chaque gestionnaire : son nom, les valeurs confiées par sa fabrique (`{permission="…"}`, `{scope="…"}`, options) et l'empreinte de son texte compilé ;
    - les exports lus par les tests.

    Le relevé se fait dans un processus enfant dont l'environnement se réduit à `PATH`, sans terminal et sans ouvrir `server/.env` : il donne la même liste en local et en CI.
  - `node scripts/verifier-deplacement.mjs origin/main` compare, instruction par instruction, tous les fichiers TypeScript du serveur entre la base et la branche. Il s'appuie sur l'analyseur du compilateur TypeScript, et lit la base comme la branche, fonctions d'enregistrement comprises. La CI le rejoue pour les branches `refactor/serveur-*`.
    - Chaque instruction de la base doit se retrouver une fois, à l'identique, commentaires compris, et dans le même ordre. Seuls sont admis le mot-clé `export` ajouté et un décalage d'indentation uniforme dans une fonction d'enregistrement, hors lignes de gabarit multiligne.
    - Les imports conservés gardent leur ordre et les nouveaux viennent après eux. Aucun import n'est renommé : ni `as`, ni import par défaut sous un autre nom que dans la base, ni `import x = …` ou `export import`, propres à TypeScript. `export * from` est refusé : on ré-exporte chaque nom. Retirer un import chargé pour son seul effet est refusé. Une bibliothèque ne s'importe que sous un spécificateur déjà présent dans la base (`node:crypto` et `crypto` sont tenus pour le même module).
    - Chaque fonction d'enregistrement, ni asynchrone ni génératrice, prend le seul paramètre `app`, sans reste ni valeur par défaut. Elle est appelée une fois, avec `app`, au premier niveau d'`index.ts`. L'ordre d'`index.ts`, ses appels remplacés par le contenu des fonctions, est celui de la base.
    - Chaque fichier qui reçoit du code de la base est chargé depuis `index.ts` à l'exécution. Le graphe des chargements vient du code que produit le compilateur avec `tsconfig.json`, comme `npm run build` : `require` de premier niveau, sans les imports de types ni les `import()` dynamiques. Les imports sont résolus comme Node et TypeScript (`x.ts`, `x.js` lu comme `x.ts`, puis `x/index.ts`), et un import relatif non résolu fait échouer le vérificateur.
    - Aucun cycle d'imports entre modules locaux, `index.ts` compris. En CommonJS, un module d'un cycle peut s'évaluer avant que l'autre ait défini ce qu'il lui emprunte : des constantes valent alors `undefined`, par exemple les clés de la matrice des droits.
    - Une instruction qui change de fichier n'emploie ni `require`, ni `module`, ni `exports`, ni `__dirname`, ni `__filename`, ni, hors d'une fonction, `this` ou `arguments`.
    - `package.json`, `package-lock.json` et `tsconfig.json` ne changent pas. Les outils de preuve (`scripts/routes.mjs`, `scripts/routes-reference.txt` et le vérificateur) non plus, sauf avec `--outils-admis`, réservé aux PR d'outils : leur branche s'appelle `refactor/serveur-preuves-*`, et la CI ne passe cette option qu'à elles. Pour les autres branches `refactor/serveur-*`, la CI vérifie aussi, hors du vérificateur, que ces outils et son propre workflow n'ont pas changé. Cette étape vit dans le workflow de la PR : la garantie ultime reste la revue du diff et la protection de la branche `main`.
    - Aucun nom exporté n'est retiré : déplacer une déclaration exportée d'un module de `src/` vers un autre impose donc d'y laisser un ré-export.
    - Toute autre instruction nouvelle le fait échouer.
    - Il liste pour la revue les blocs déplacés, les imports et commentaires ajoutés, les imports retirés, les autres fichiers modifiés et les instructions qui s'exécutent désormais au chargement d'un autre module que le leur.
- **Ce que les preuves ne couvrent pas.**
  - **Le moment où un module s'évalue.** Une instruction déplacée au premier niveau d'un module s'exécute à son import, avant le corps d'`index.ts`. Le vérificateur liste ces instructions, et la PR justifie chacune. `routes.mjs` en contrôle l'effet le plus sensible, les lectures de l'environnement avant et après `.env`, mais seulement pendant le chargement, pas pendant le traitement des requêtes.
  - **Angles morts de `routes.mjs`** :
    - dans les fermetures, les `Set`, les objets imbriqués et les portées de bloc ;
    - les réglages dont la valeur est une fonction ;
    - le chemin d'un middleware monté sur une expression régulière ou un tableau, noté `/` ;
    - l'auteur d'une énumération de `process.env`, notée `*` sans distinguer l'application d'une bibliothèque ;
    - les sous-routeurs, non parcourus ;
    - les fonctions utilitaires, qui n'ont pas d'empreinte (seuls les gestionnaires en ont une) ;
    - la matrice des droits par rôle (`DEFAULT_USER_PERMISSIONS`, `DROITS_INTERDITS_TECHNICIEN`), absente de la référence.

    Pendant le découpage, ces cas relèvent du vérificateur : il protège le texte de la matrice, et l'interdiction des cycles protège sa valeur au chargement.
  - **Les fabriques.** Une fabrique comme `creerRouteMixte(app)`, qui enveloppe du code de la base dans une fonction nouvelle autre qu'une fonction d'enregistrement, n'est pas encore admise. La PR qui l'introduit étend le vérificateur et prouve l'extension par des mutations, à moins de retenir une autre voie (par exemple créer `app` dans un module).
- **Un lot fonctionnel** (hors découpage) réécrit la référence avec `node scripts/routes.mjs --ecrire`, et l'écart apparaît dans le diff de sa PR, s'il :
  - ajoute, retire ou réordonne une route ;
  - modifie un gestionnaire, un middleware, un réglage, un export ou une lecture de l'environnement au chargement ;
  - met à jour une bibliothèque dont le code d'un middleware change (`cors`, `express.json`).

  `verifier-deplacement.mjs` ne concerne que les PR du découpage.
- **Imports sans renommage** : ni `import { a as b }`, ni `import x = …`, ni import par défaut renommé pendant le découpage.
- **Ordre de chargement inchangé** : `index.ts` importe `src/env.ts` après les bibliothèques, au moment où il appelait `dotenv.config()` avant le découpage. Certaines bibliothèques lisent l'environnement à leur chargement (`DEBUG`, `NO_COLOR`…).
- **Domaines dispersés dans le fichier.** Plusieurs domaines ont leurs routes en plusieurs endroits d'`index.ts` : factures, chantiers, interventions, planning, société, paramètres, commerciaux. Leur module expose alors plusieurs fonctions d'enregistrement, appelées chacune à l'emplacement de son bloc. Le vérificateur refuse tout réordonnancement : s'il en fallait un, il ferait l'objet d'une PR à part, prouvée sans recouvrement de chemins.
- **`routeMixte`** dépend de `app` : il deviendra une fabrique, `creerRouteMixte(app)`, dont le corps reste identique, pour que ses appels ne changent pas.
- **Utilitaires partagés d'abord** : une fonction dont se servent plusieurs domaines est déplacée vers `commun/`, `droits/` ou `http/` avant le premier domaine qui l'emploie.
- **Aucun test modifié.** `index.ts` ré-exporte ce que les tests importent de `dist/index.js`.
- **Pas de dépendance circulaire.** Un module importe `db`, `http`, `droits`, `commun` ou la logique d'un autre domaine, jamais `index.ts`.
- **Logique métier.** Les fonctions déjà séparées des routes passent dans le `metier.ts` de leur domaine. La logique écrite dans le corps d'un gestionnaire y reste pendant le découpage, puisque l'en extraire changerait du code ; son extraction sera proposée ensuite, domaine par domaine, si elle est utile.
- **Taille.** Aucun fichier de code applicatif ne dépasse environ 800 lignes (`CLAUDE.md`). Les grands domaines (devis, chantiers, factures, comptabilité) auront plusieurs fichiers de routes.

## Ordre prévu des PR (proposition)

1. Socle (`env`, `db`, rôles, authentification, gardes de type de compte, `paramId`), scripts de preuve, et domaine `referentiels`.
1 bis. Outils de preuve renforcés, sans déplacement de code : vérification par instruction, imports, chargement depuis `index.ts`, lectures de l'environnement, permissions des gardes, empreintes des gestionnaires, chemins des middlewares, réglages.
2. Droits : permissions, clés d'intégration (`requireApiKey`, `routeMixte`), périmètres de lecture ; dates partagées.
3. Journal d'administration ; domaines `parametres` et `administration`.
4. Domaines `authentification` et `utilisateurs`.
5. Domaines `clients` et `catalogue`.
6. Domaine `devis`.
7. Domaine `chantiers`.
8. Domaines `interventions` et `contrats`.
9. Domaine `planning`.
10. Domaines `factures` et `reglements`.
11. Domaine `comptabilite`.
12. Domaines `statistiques` et `commissions`.
13. Finalisation : `index.ts` réduit au point d'entrée, plus aucun fichier au-delà d'environ 800 lignes.
