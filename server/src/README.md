# Code du serveur : organisation par domaine

**Découpage terminé** (chantier technique 2, décision de Nelson du 17-10-2026). `server/index.ts` n'est plus que le point d'entrée : les routes et la logique sont dans `src/`, rangées par domaine. Les PR du chantier les y ont déplacées une à une, **sans aucun changement de comportement** : mêmes routes, mêmes réponses, mêmes codes et messages d'erreur, mêmes transactions, verrous et contraintes différées.

## Structure

```
server/
  index.ts              point d'entrée : règle l'application, enregistre les domaines dans
                        l'ordre, démarre le serveur ; ré-exporte ce que lisent les tests
  src/
    env.ts              chargement de server/.env
    db.ts               client Prisma, transactionVerifiee
    app.ts              l'application Express, créée après le chargement de .env
    demarrage.ts        initialisation de la base, comptes super administrateurs de départ,
                        délais de connexion du serveur HTTP
    http/               couche HTTP commune à tous les domaines
      auth.ts           secret JWT, requireAuth, AuthRequest, branche hiérarchique
      gardes.ts         gardes de type de compte (requireAdmin, blockCommercial…)
      requete.ts        lecture des paramètres de requête (paramId)
      cles-api.ts       scopes et clés d'intégration (requireApiKey, ApiRequest)
      routes-mixtes.ts  routeMixte : une opération montée sur /api et /api/v1
    droits/             types de compte, permissions, périmètres de lecture
      roles.ts          types de compte, isCommercialLike
      permissions.ts    droits par type de compte, requirePermission
      perimetres.ts     périmètre de lecture du domaine chantier
      visibilite.ts     montants, taux horaires et prix d'achat montrés selon le demandeur
    commun/             utilitaires partagés : dates (jour civil, fuseau de la société),
                        montants, validation des saisies, journal d'administration, CSV
      dates.ts          jour civil et année au fuseau de la société, lecture et écriture des dates
      montants.ts       Decimal Prisma en nombres, calculs exacts de montants et TVA par taux
      validation.ts     validation des saisies numériques et des motifs de correction
      csv.ts            échappement des cellules CSV
      journal-administration.ts  écriture et purge du journal des paramètres et des droits
    domaines/<domaine>/
      routes.ts         routes HTTP du domaine : enregistrerRoutes<Domaine>(app)
      metier.ts         logique métier du domaine (calculs, contrôles, lectures et écritures
                        réutilisées), sans objet HTTP ; plusieurs fichiers si besoin
    domaines/referentiels/    routes.ts
    domaines/parametres/      routes.ts, metier.ts (paramètres, singletons, rémunération)
    domaines/administration/  routes.ts (clés, société, modules), journal.ts (consultation
                              du journal), metier.ts (paramètres de la société)
    domaines/authentification/  routes.ts, sso.ts (Microsoft Entra ID), secours.ts
                                (accès de secours)
    domaines/utilisateurs/    comptes.ts (comptes, hiérarchie), equipes.ts (commerciaux,
                              conducteurs, fiches intervenant, prime mensuelle),
                              rattachement-main-oeuvre.ts (main d'œuvre d'une fiche intervenant)
    domaines/clients/         routes.ts, metier.ts (validation des saisies), equipements.ts
                              (parc d'équipements)
    domaines/catalogue/       routes.ts, metier.ts (familles, validation, fiche selon le lecteur),
                              main-oeuvre.ts (prestations main d'œuvre : prix de vente, droits, journal)
    domaines/devis/           routes.ts, metier.ts (numéro, saisie, lignes, verrous), document.ts (PDF),
                              tempsPasse.ts (devis au temps passé : ligne, pas, mention)
    domaines/chantiers/       routes.ts, saisies.ts (achats, heures, encaissé), suivi.ts
                              (indicateurs et sérialisation), droits.ts (rentabilité, montants,
                              clôture), metier.ts (types, titulaire, commercial)
    domaines/interventions/   routes.ts (SAV, coûts, comptes rendus, placement), metier.ts (dont le
                              créneau retiré à la remise et à l'annulation), lectures.ts (liste,
                              « Ma journée », fiche), comptesRendus.ts (tracé, empreinte, clé d'envoi,
                              motifs de clôture, verrou et périmètre relu, journal),
                              remiseAPlanifier.ts (remise « à planifier » d'une intervention planifiée)
    domaines/contrats/        routes.ts, metier.ts (couverture, échéances, visites, verrou),
                              generation.ts (passage quotidien des visites, alerte, minuteur)
    domaines/planning/        routes.ts (événements, types, partage, lien public), metier.ts
                              (module actif, validation des événements)
    domaines/factures/        routes.ts, metier.ts (sélection, adresse, avoirs), pdf.ts
    domaines/documents/       gabarit.ts (modèle PDF commun), identite.ts (identité de
                              l'émetteur figée à l'émission), identiteClient.ts (identité
                              minimale du client exigée à la signature d'un devis et à
                              l'émission d'une facture), logo.ts (validation), routes.ts (logo),
                              envois.ts (envoi par la messagerie : destinataire, objet et texte,
                              journal des envois ; routes dans les domaines devis et factures)
    domaines/reglements/      routes.ts, metier.ts (moyens, soldes, statut)
    domaines/comptabilite/    routes.ts (plan comptable, import, règles, TVA), metier.ts (clés
                              et natures, verrou, écritures d'une pièce, libellé d'un compte)
    domaines/statistiques/    routes.ts (tableau de bord, conducteurs, assiduité, répartition,
                              intervenants, fournisseurs, types de chantiers), metier.ts
                              (bornes de semaine et de période)
    domaines/commissions/     routes.ts (résultat commercial), metier.ts (barème progressif,
                              calcul par commercial)
```

Domaines :

| Domaine | Contenu |
|---|---|
| `referentiels` | catégories et fournisseurs des achats (**déplacé**) |
| `authentification` | SSO Microsoft, accès de secours, `/api/me`, configuration publique, santé (**déplacé**) |
| `utilisateurs` | comptes, hiérarchie, commerciaux, conducteurs, fiches intervenant (**déplacé**), rattachement d'une fiche intervenant à une main d'œuvre du catalogue (lot « main d'œuvre au catalogue », `rattachement-main-oeuvre.ts`) |
| `administration` | clés d'intégration, journal des paramètres et des droits, modules, société (**déplacé**) |
| `parametres` | paramètres métier, rémunération, registre des entreprises (**déplacé**) |
| `clients` | clients, contacts, sites, parc d'équipements (**déplacé**) |
| `catalogue` | prestations, articles, équipements (**déplacé**) ; mains d'œuvre en prix de vente, prestations marquées, quatre prix et heures par jour, écriture réservée à l'administration en session et journalisée (lot « main d'œuvre au catalogue », `main-oeuvre.ts`) |
| `devis` | devis versionnés, signature, acompte, conversion, duplication (**déplacé**), PDF du devis (lot 6a-2), envoi par la messagerie (lot 6a-3), deux conversions par affaire et annulation en cascade sur ce que le devis a créé (lot 4 suite, `annulation.ts`), devis au temps passé : ligne de main d'œuvre au prix fixé par le serveur, pas du temps passé figé, mention, marqueur reporté sur l'intervention (lot « devis au temps passé », `tempsPasse.ts`) |
| `chantiers` | affaires, achats, heures, métriques et suivi (**déplacé**) |
| `interventions` | SAV, coûts, comptes rendus, placement au planning (**déplacé**), remise « à planifier » d'une intervention planifiée, visite de contrat ou curative, son créneau libéré (lot « visite à replanifier », `remiseAPlanifier.ts`, étendue par le lot « remise et annulation » du 24-10-2026), créneau retiré du planning à l'annulation (`retirerCreneauIntervention`, `metier.ts`), motif obligatoire de la remise et de l'annulation (`motifInterventionValide`, `comptesRendus.ts`) |
| `contrats` | contrats de maintenance et visites (**déplacé**), statut « annulé » avec le devis (lot 4 suite) |
| `planning` | affectations, types d'événement, partage public (**déplacé**) |
| `factures` | factures, avoirs, mentions légales, export comptable (**déplacé**), envoi par la messagerie (lot 6a-3) |
| `documents` | modèle PDF commun, identité de l'émetteur figée à l'émission, logo des documents (lot 6a-1) ; identité minimale du client pour signer un devis et émettre une facture (lot 6a-2 bis) ; envoi d'un document par la messagerie et journal des envois (lot 6a-3) |
| `reglements` | encaissements et affectations (**déplacé**) |
| `comptabilite` | plan comptable, règles, TVA, import, écritures (**déplacé**) |
| `statistiques` | tableaux de bord et statistiques (**déplacé**) |
| `commissions` | barème et calcul des commissions, résultat commercial (**déplacé**) |

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
    - Le code compile sans erreur de type, et aucune directive qui suspend ce contrôle n'est ajoutée (`@ts-nocheck`, `@ts-ignore`, `@ts-expect-error`, `/// <reference …>`). Le vérificateur lit les directives telles que le compilateur les reconnaît, quelle que soit leur casse. C'est le contrôle de types qui garantit qu'un nom d'une instruction déplacée désigne la même déclaration qu'avant.
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
  - **Les fabriques.** Une fabrique, qui envelopperait du code de la base dans une fonction nouvelle autre qu'une fonction d'enregistrement, n'est pas admise. La PR qui en introduirait une étendrait le vérificateur et prouverait l'extension par des mutations.
- **Un lot fonctionnel** (hors découpage) réécrit la référence avec `node scripts/routes.mjs --ecrire`, et l'écart apparaît dans le diff de sa PR, s'il :
  - ajoute, retire ou réordonne une route ;
  - modifie un gestionnaire, un middleware, un réglage, un export ou une lecture de l'environnement au chargement ;
  - met à jour une bibliothèque dont le code d'un middleware change (`cors`, `express.json`).

  `verifier-deplacement.mjs` ne concerne que les PR du découpage.
- **Imports sans renommage** : ni `import { a as b }`, ni `import x = …`, ni import par défaut renommé pendant le découpage.
- **Ordre de chargement inchangé** : `index.ts` importe `src/env.ts` après les bibliothèques, au moment où il appelait `dotenv.config()` avant le découpage. Certaines bibliothèques lisent l'environnement à leur chargement (`DEBUG`, `NO_COLOR`…). Le compilateur retire le `require` d'un import dont aucun nom n'est plus employé : quand le dernier emploi d'une bibliothèque quitte `index.ts`, son import y devient un import pour son seul effet (`import 'jsonwebtoken';`), à la même place, sans quoi elle se chargerait plus tard, depuis `src/`, après `.env`. `routes.mjs` le détecte quand la bibliothèque lit l'environnement.
- **Domaines dispersés dans le fichier.** Plusieurs domaines ont leurs routes en plusieurs endroits d'`index.ts` : factures, chantiers, interventions, planning, société, paramètres, commerciaux. Leur module expose alors plusieurs fonctions d'enregistrement, appelées chacune à l'emplacement de son bloc. Le vérificateur refuse tout réordonnancement : s'il en fallait un, il ferait l'objet d'une PR à part, prouvée sans recouvrement de chemins.
- **`routeMixte`** monte ses routes sur `app` hors d'une fonction d'enregistrement. Plutôt qu'en faire une fabrique, `app` est créée dans `src/app.ts`, importé après `src/env.ts` : `routeMixte` l'importe, et son texte comme ses appels restent identiques.
- **Utilitaires partagés d'abord** : une fonction dont se servent plusieurs domaines est déplacée vers `commun/`, `droits/` ou `http/` avant le premier domaine qui l'emploie.
- **Aucun test modifié.** `index.ts` ré-exporte ce que les tests importent de `dist/index.js`.
- **Pas de dépendance circulaire.** Un module importe `db`, `http`, `droits`, `commun` ou la logique d'un autre domaine, jamais `index.ts`.
- **Logique métier.** Les fonctions déjà séparées des routes passent dans le `metier.ts` de leur domaine. La logique écrite dans le corps d'un gestionnaire y reste pendant le découpage, puisque l'en extraire changerait du code ; son extraction sera proposée ensuite, domaine par domaine, si elle est utile.
- **Taille.** Aucun fichier de code applicatif ne dépasse environ 800 lignes (`CLAUDE.md`). Un domaine qui grandit se répartit en plusieurs fichiers, comme `chantiers` (routes, saisies, suivi, droits).

## Ordre des PR

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
