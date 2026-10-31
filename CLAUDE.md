# Iris — passation pour Claude Code

Iris est un ERP français natif pour métiers techniques, **en développement et non en production**. Une installation dessert une seule société avec sa propre base. Le dépôt et ses tests, et non un ancien audit ou une issue isolée, décrivent l'état exécutable.

## Lire avant de commencer

1. [`README.md`](README.md) : vision, invariants et état de la roadmap. [`docs/PRODUCT-VISION-ERP-TECHNIQUE.md`](docs/PRODUCT-VISION-ERP-TECHNIQUE.md) précise les parcours cibles, pas nécessairement leur implémentation actuelle.
2. [`docs/ROADMAP-PASSATION.md`](docs/ROADMAP-PASSATION.md) : état par chantier, dépendances, critères de sortie et points à arbitrer. Vérifier le code et les tests avant d'affirmer qu'un lot est absent ou achevé.
3. [`.agents/AGENTS.md`](.agents/AGENTS.md) : règles de branches, PR et revues croisées. Consulter **les commentaires** des issues/PR ; les descriptions peuvent dater d'une version ancienne de `main`.
4. [`docs/MODELE-DROITS-COMPTES.md`](docs/MODELE-DROITS-COMPTES.md), [`docs/CONFIGURATION-ENVIRONNEMENT.md`](docs/CONFIGURATION-ENVIRONNEMENT.md), [`server/tests/README.md`](server/tests/README.md) pour les droits, l'installation et les tests.
5. [`.claude/agents/`](.claude/agents/) : les sous-agents de projet et leur rôle dans le circuit d'une PR (section « Circuit d'une PR et sous-agents de projet », plus bas).

## Mode de livraison

- Vérifier les PR ouvertes **avant toute nouvelle branche**. Une PR en attente est menée jusqu'à sa fusion selon la section « Fusion » ci-dessous ; demander à Nelson avant d'en abandonner une, ou si elle attend un arbitrage de sa part. Un lot autonome = branche depuis `main` à jour + PR dédiée ; jamais de push direct sur `main`.
- Cadrer la PR avec périmètre, hors périmètre, critères métier observables et tests. Ne pas inventer une règle de commission, un tarif, une qualification réglementaire ou une politique client lorsqu'elle n'est pas décidée.
- Préserver Iris comme source de vérité. Pas de reprise d'ERP tiers ; catalogue et plan comptable initialement vides et paramétrables. Aucune IA externe dans Iris : un éventuel connecteur Hermes requiert une phase et des gardes dédiées.
- Pour toute écriture ou donnée sensible, droits API avant UI, périmètre hiérarchique explicite, audit/immutabilité et refus métier testés. Dates saisies/affichées en `JJ-MM-AAAA`, fuseau d'entreprise pour la date civile, stockage technique distinct. Les factures émises et leurs montants/mentions sont figés ; une correction passe par le cycle métier prévu.
- Tests backend HTTP contre PostgreSQL **jetable**, tests Playwright dans un vrai navigateur pour les parcours critiques. Ne pas confondre un test `SKIP` sans base avec un test réussi. Rejouer les suites pertinentes deux fois sur une même base conservée lorsque des fixtures persistantes peuvent interférer. `git diff --check`, builds, lint et CI doivent être verts sur la SHA courante.
- **Audits.** Ne jamais être son propre auditeur : le verdict vient d'un autre contexte.
  - **Audit interne, obligatoire.** Dès qu'une PR est terminée et prête pour revue, l'agent qui l'a codée déploie au minimum un des auditeurs de projet, choisis selon ce que touche la PR (section « Circuit d'une PR et sous-agents de projet », plus bas). Chacun travaille dans un contexte distinct, sur le diff complet : exactitude, droits et données sensibles, tests réellement probants, écart à la vision et aux règles de ce fichier. L'agent publie leurs constats dans la PR et les traite selon la règle 3 de la méthode ci-dessous avant de la présenter. Chaque auditeur rend toutes ses remarques en un seul passage ; après un push correctif, il repasse sur la nouvelle SHA pour vérifier les seules corrections bloquantes.
  - **Audit indépendant, à la demande de Nelson.** Une IA indépendante de celle qui a codé, sollicitée manuellement par Nelson qui relaie ses retours, peut auditer une PR avant ou après sa fusion. Ses remarques sont traitées comme celles de l'audit interne, au besoin dans une PR de suivi.
  - **Traitement des remarques** (règle 3 de la méthode) : une remarque bloquante, ou qui touche un parcours de la règle 2 de la méthode, est corrigée et retestée avant fusion ; une remarque non bloquante ailleurs devient une issue étiquetée `suivi-audit` et ne retarde pas la fusion. Un test manquant seul, hors montants, ne retarde pas la fusion, même sur un autre parcours de la règle 2 (lecture retenue de la décision de Nelson du 23-10-2026, règle 3 ci-dessous).
- **Fusion** (décision de Nelson du 20-10-2026, qui remplace la délégation du 17-10-2026). Message de Nelson, mot pour mot : « Je ne fusionne aucune PR, c’est toi apres verification zt si tout est ok que tu peux fusionner les pr ».
  - Claude Code fusionne lui-même toute PR de Claude Code, y compris celles qui changent des montants ou qui modifient ce fichier. La PR d'un autre agent suit [`.agents/AGENTS.md`](.agents/AGENTS.md). Deux conditions doivent porter sur la même SHA : la CI y est verte, et chacun de ses auditeurs l'y juge fusionnable, sans remarque restante à corriger avant fusion selon la règle 3 de la méthode (un test manquant seul, hors montants, n'en est pas une, décision du 23-10-2026). Les remarques bloquantes du passage du `controleur-coherence` avant la fusion sont traitées de même.
  - Avant de fusionner, relire la PR sur GitHub : SHA de tête, checks de cette SHA, fusion sans conflit avec le `main` courant. Fusionner par commit de fusion, en donnant la SHA de tête attendue ; jamais par la fusion automatique de GitHub.
  - Fusionner une PR qui change un montant ne vaut pas validation comptable : celle du cabinet et de Nelson reste un préalable à la mise en service ([passation](docs/ROADMAP-PASSATION.md), section 5).
  - **Seul Nelson décide de la mise en production.** Ne pas l'activer par déduction d'une CI verte ou d'une fusion.
  - **Toutes les PR, propositions comprises.** Le 20-10-2026, Nelson a confirmé la portée de sa décision, mot pour mot : « C’est toi qui fusionne TOUTES les PR » (message de la session de travail, consigné sur #182 et #183). Claude Code fusionne donc aussi les propositions 3 et 4 (#182, #183), dont la fusion vaut validation de la proposition, que Nelson s'était réservée le 17-10-2026. Les conditions sont celles de toute PR, ci-dessus : rafraîchies sur `main`, CI verte et audit interne fusionnable sur la même SHA, fusion par commit de fusion sur la SHA attendue. La PR d'un autre agent suit toujours [`.agents/AGENTS.md`](.agents/AGENTS.md).
  - La délégation du 17-10-2026 ([historique](docs/HISTORIQUE-DECISIONS.md)) excluait les PR qui changent des montants et les propositions soumises à Nelson. La décision du 20-10-2026 lève ces deux exceptions (#253, puis la confirmation ci-dessus).
- Faire évoluer la roadmap dans une PR documentaire lorsque l'état des lots change. Distinguer systématiquement « implémenté », « partiel », « prévu » et « validé pour mise en service ».

## Circuit d'une PR et sous-agents de projet (décision de Nelson du 31-10-2026)

Objectif de Nelson, mot pour mot : « aller plus vite sans perdre en solidité, en répartissant le travail entre des sous-agents spécialisés » ([historique](docs/HISTORIQUE-DECISIONS.md#décision-du-31-10-2026-sur-le-circuit-des-pr-et-les-sous-agents)).

Les sous-agents de projet sont définis dans [`.claude/agents/`](.claude/agents/), un fichier Markdown par agent (nom, description, outils, modèle). Un sous-agent ne reçoit que son propre fichier et la demande de Claude Code. Son fichier lui fait donc lire ce fichier, [`.agents/AGENTS.md`](.agents/AGENTS.md) et les sections utiles de la passation et de la vision avant d'agir.

| Sous-agent | Rôle | Écrit | Modèle |
|---|---|---|---|
| `controleur-coherence` | Cohérence fonctionnelle d'Iris, et non qualité du code : avant le lot, avant la fusion, passage hebdomadaire | Rien (il peut lancer les tests) | Celui de la session |
| `auditeur-montants` | Calculs, arrondis, TVA, factures et avoirs figés, tests de montants | Rien dans le dépôt | Celui de la session |
| `auditeur-droits-securite` | Droits et périmètres, refus côté API, journaux, données sensibles, dépendances | Rien dans le dépôt | Celui de la session |
| `redacteur-tests` | Tests d'API et E2E, écrits à partir du cadrage, en parallèle du code | Fichiers de tests seulement | Celui de la session |
| `documentaliste` | Passation et historique après chaque fusion ; passation courte, ce qui est livré archivé dans l'historique | `docs/` seulement | Sonnet |

**Circuit d'une PR.**

1. **Cadrage**, puis passage du `controleur-coherence` avant de coder. Il répond à trois questions :
   - le lot est-il dans le périmètre gelé de la bêta ?
   - contredit-il une décision consignée, la vision ou un lot prévu, comme la refonte des droits ?
   - fait-il doublon avec l'existant ?
2. **Code**, avec le `redacteur-tests` en parallèle.
3. **Auditeurs en parallèle**, choisis selon ce que touche la PR :
   - l'`auditeur-montants` pour un montant ;
   - l'`auditeur-droits-securite` pour un droit, un périmètre, un journal, une donnée sensible ou une dépendance.

   Ils assurent l'audit interne obligatoire : au moins un par PR. Avant la fusion, le `controleur-coherence` repasse. Il vérifie que le parcours de bout en bout reste cohérent, qu'une même notion porte partout le même nom, le même statut et le même format, et que les écrans affichent des libellés en français, des montants au format français et des dates `JJ-MM-AAAA`.
4. **Corrections.**
5. **Fusion**, par Claude Code seul, aux conditions de la section « Fusion », plus haut.
6. **Mise à jour de la passation et de l'historique** par le `documentaliste`, dans une PR documentaire.

Chaque auditeur rend toutes ses remarques en un seul passage, classées bloquantes ou non. Un nouveau passage ne sert qu'à vérifier les corrections bloquantes. Les remarques du `controleur-coherence` suivent la règle 3 de la méthode.

**Choix de mise en œuvre** (choix par défaut, à confirmer) :
- **Lecture retenue** : le « périmètre gelé de la bêta » est le périmètre du pilote, décrit en section 2 de la passation (option 1, SAV et maintenance ; lots décidés pour le premier jour).
- **Choix de l'auditeur** : une PR qui ne touche ni montant ni droit, ou qui touche une variable d'environnement (règle permanente 3), est auditée par l'`auditeur-droits-securite`. Une PR uniquement documentaire l'est par le `controleur-coherence`, qui vérifie les citations, les statuts et la cohérence avec les décisions.
- **Erreurs hors spécialité** : tout auditeur relève aussi celles qu'il constate sur le diff complet.
- **Classement des remarques** : dans la grille R/C/T/N, les remarques R et C sont bloquantes, tout comme un test manquant qui touche un montant, classé C (T reste réservé aux tests manquants hors montants) ; T et N ne le sont pas.
- **Rédaction des tests** : le `redacteur-tests` travaille sur la même branche que le code. Il écrit aussi les tests unitaires du client. Il possède les fichiers de tests du lot : le code ne les modifie pas sans passer par lui.
- **Passage hebdomadaire** du `controleur-coherence` :
  - Claude Code le lance lors de la première session de travail de chaque semaine, sans déclencheur automatique ;
  - son rapport est publié dans une issue ;
  - une remarque bloquante devient un correctif prioritaire (voir « Ordre pendant le pilote »), une autre une issue `suivi-audit`.
- **Lecture seule** : Nelson dit « lecture seule » des deux auditeurs, et « lecture seule, peut lancer les tests » du `controleur-coherence`. Lecture retenue : elle vaut pour le dépôt ; les auditeurs lancent tests et mutants sur une copie extraite hors du dépôt, et livrent leurs correctifs en patchs. Elle repose sur les consignes de chaque sous-agent. Après le passage d'un sous-agent en lecture seule, Claude Code vérifie que la copie de travail n'a pas changé : `git status` vide, même tête (`git rev-parse HEAD`) et même branche.
- **SHA rafraîchie sur `main`** : une nouvelle tête qui ne fait que fusionner `main` dans la branche, sans conflit ni autre changement, est vérifiée par un passage de vérification de chacun de ses auditeurs (la fusion n'apporte que les changements de `main`), avec une CI verte sur cette tête.
- **Commits et publication** : un sous-agent ne commite et ne pousse rien. Claude Code commite, pousse, ouvre les PR et publie les constats.
- **Repli** : si les agents de projet ne sont pas chargés dans la session, Claude Code lance un agent général en lui donnant le fichier de l'agent voulu comme consigne.

**Parallélisme.** Quand deux lots touchent des domaines indépendants, Claude Code les mène en parallèle, chacun dans sa branche et sa PR, avec ses propres audits. Jamais deux lots en parallèle sur le même domaine, ni sur les montants d'un même document.

**Ce qui ne change pas** : Claude Code seul fusionne. Aucun sous-agent ne fusionne ni ne pousse sur `main`. Les règles 1 à 5 de la méthode et la validation comptable des montants par Nelson restent en vigueur.

## Méthode de travail (décision de Nelson du 16-10-2026)

Iris doit avancer en largeur sur ce dont le premier client a besoin, sans relâcher l'exigence là où une erreur coûte cher.

1. **Le périmètre du pilote est la boussole.** On avance en largeur sur ce dont le premier client a besoin le premier jour ; le reste attend.
2. **Exigence maximale inchangée là où une erreur coûte cher** : droits et périmètres, montants, factures et documents figés, journaux d'audit, sécurité. Ces parcours gardent des tests réels sur PostgreSQL et dans le navigateur.
3. **Remarques d'audit.** Ailleurs, une remarque d'audit non bloquante ne retarde plus la fusion : elle devient une issue étiquetée `suivi-audit`, traitée plus tard. Une remarque bloquante, ou qui touche un parcours de la règle 2, reste corrigée et retestée avant fusion.
   - **Tests manquants** (décision de Nelson du 23-10-2026). Question posée : fusionner quand un audit ne relève que des tests manquants hors montants, et verser ces tests à une PR de suivi. Message de Nelson, mot pour mot : « Oui fusionne si ce n’eqt que des test manquant il faut eviter de tourner en rond et de provoquer des test de plus en olus longtemps et qui ne provoque pas d’erreur. Si pas d’erreur on continue ». Lecture retenue, à corriger par Nelson si besoin ([historique](docs/HISTORIQUE-DECISIONS.md#décision-du-23-10-2026-soir--tests-manquants)) : une remarque qui ne signale qu'un test manquant (cas non couvert, mutant survivant), sans erreur constatée dans le code, la documentation ou un test existant, ne retarde pas la fusion, même sur un autre parcours de la règle 2 que les montants. Elle devient une issue `suivi-audit`, qui reprend le test proposé, versé ensuite par une PR de suivi, sans nouvelle boucle d'audit. Un test manquant qui touche un montant reste ajouté et retesté avant fusion, avec un nouvel audit. Une erreur constatée suit la règle 3 ci-dessus.
4. **Rien d'historique ni de théorique sans données réelles.** Tant qu'aucune donnée réelle n'existe, ne traiter ni données historiques, ni migration de données existantes, ni déductions théoriques. Les signaler en une ligne dans la PR.
5. **Micro-arbitrages.** Sur un micro-arbitrage de droits ou d'affichage, ne pas solliciter Nelson : choisir l'option la plus simple et, en cas de doute, la plus restrictive ; la documenter dans la PR et dans `docs/ROADMAP-PASSATION.md` avec la mention « choix par défaut, à confirmer ». Ne lui remonter que ce qui touche les montants, les règles métier, le modèle de données ou un lot entier.

Ce qui ne change pas : une PR par lot, jamais de push direct sur `main`, l'audit interne, et l'audit indépendant à la demande de Nelson ; une CI verte seule n'autorise aucune fusion (conditions de la décision du 20-10-2026, plus haut) ; Nelson valide les montants avec le cabinet et décide de la mise en production ; Iris reste sa propre source de vérité, et aucune règle de prix, de commission ou de conformité n'est inventée.

**Ordre pendant le pilote** (décision de Nelson du 19-10-2026) : « La prochaine PR fonctionnelle est le lot 3b. Jusqu'à la fin du pilote, un correctif ne passe avant un lot que s'il est bloquant ou s'il touche un montant. Tout le reste devient une issue, traitée après le pilote. » Le 21-10-2026, le lot 3 étant implémenté, Nelson a placé les lots pilotes 4 à 6 avant le premier jour, et #179, #181 et le lot P0 du paramétrage avant la fin du pilote ; pour P0, la lecture retenue est avant le premier jour ([historique](docs/HISTORIQUE-DECISIONS.md#décisions-du-21-10-2026)).

Choix de mise en œuvre de la règle 3 (choix par défaut, à confirmer) : l'étiquette s'appelle `suivi-audit` ; l'issue reprend le constat, sa preuve et le correctif proposé, et la PR la cite. Chaque auditeur classe ses remarques en R (défaut de comportement ou de sûreté), C (autre erreur à corriger avant fusion : documentation inexacte, test existant faux ou instable, procédure), T (test manquant seulement, hors montants) et N (notes) ; une PR sans remarque R ni C restante à corriger avant fusion selon la règle 3 est fusionnable, quelles que soient ses T et ses N.

## Règles permanentes de conception (décision de Nelson du 17-10-2026)

1. **Un paramètre plutôt qu'une constante.** Toute nouvelle règle propre au fonctionnement d'une entreprise devient un paramètre, avec une valeur par défaut documentée, et non une constante dans le code. Exemples : qui valide, clôture ou convertit ; délais et seuils ; statuts et listes de valeurs ; modules activés. Ce qui relève des droits suit la proposition `docs/MODELE-DROITS-CIBLE.md` (#182), validée par sa fusion le 20-10-2026.
   - La valeur par défaut reprend le comportement actuel. Pour une règle nouvelle, c'est la valeur décidée par Nelson. Pour un micro-arbitrage de droits ou d'affichage, la règle 5 s'applique ; une autre valeur non décidée lui est posée en question. La valeur par défaut est écrite dans la PR et dans la passation.
   - Elle n'invente aucune valeur métier : pas de prix, de commission ni de compte comptable par défaut.
   - Un changement de paramètre est journalisé, comme les réglages existants.
   - Restent dans le code, avec leur raison écrite, les règles légales ou d'intégrité : continuité et chronologie de la numérotation, immutabilité des documents émis, règles fiscales, invariants de droits.
   - Les règles déjà écrites en dur sont inventoriées et classées par la proposition `docs/PARAMETRAGE-CIBLE.md` (#183), validée par sa fusion le 20-10-2026. Elles évoluent selon sa section 5, chacune dans sa PR : lots P0 (valeurs de société retirées, et non paramétrées) à P5 ; sur décision de Nelson pour les règles qui touchent les montants et pour la règle de clôture d'une intervention ; avec leur lot ou sur demande pour les autres. Celles qu'elle garde dans le code y restent.
2. **Des fichiers de taille raisonnable.** Aucun fichier de code applicatif ne dépasse environ 800 lignes ; au-delà, on le découpe, dans une PR sans changement de comportement.
   - Fichiers déjà trop longs : le découpage de `server/index.ts` est terminé (chantier 2 de la [passation](docs/ROADMAP-PASSATION.md#chantiers-techniques-décision-de-nelson-du-17-10-2026)) ; celui des écrans suit [docs/DECOUPAGE-ECRANS-CIBLE.md](docs/DECOUPAGE-ECRANS-CIBLE.md) : `Planning.tsx` et `Admin.tsx` sont découpés, `client/src/pages/ChantierDetail.tsx` reste à découper (PR C).
   - Choix par défaut, à confirmer : les fichiers de tests, les migrations, les fichiers générés (lockfiles, client Prisma) et le schéma Prisma (`server/prisma/schema.prisma`, que Prisma 5 ne scinde qu'avec une fonction en préversion) ne sont pas concernés.
3. **Des variables d'environnement toujours documentées** (consigne de Nelson du 20-10-2026 : « il ne faut absolument pas l'oublier de le mettre a jour au fur et a mesure que tu construit les differentes chose et pesner toujours a le mettre a jour sur le fichier .env.example »).
   - Toute PR qui lit une nouvelle variable d'environnement, ou en change le rôle, le format ou le caractère obligatoire, met à jour dans la même PR le modèle concerné : `server/.env.example` pour le backend et ses tests, `.env.example` pour `docker-compose.yml`, le frontend et les outils du client.
   - Une variable de l'application figure aussi dans la liste de rappel en tête de `.env.example`, et chaque variable est décrite dans [`docs/CONFIGURATION-ENVIRONNEMENT.md`](docs/CONFIGURATION-ENVIRONNEMENT.md) : rôle, obligatoire ou non, exemple sans secret réel, conséquence d'une absence. La connexion Microsoft 365 n'est jamais omise.
   - `server/tests/environnement.test.mjs` le vérifie en CI. Le corps de la PR liste les variables ajoutées, modifiées ou retirées.

## Commandes du dépôt

- Backend : `cd server && npm test` ; les tests HTTP exigent `TEST_DATABASE_URL` pointant vers une base jetable.
- Client : `cd client && npm run build && npm run lint && npm run test:unit`.
- E2E en local : `cd client && E2E_DATABASE_URL=… npm run test:e2e:local`. La commande régénère Prisma, recompile `server/dist` (que Playwright démarre tel quel), migre la base jetable, puis lance Playwright. Avant toute action, elle refuse une base dont le nom ne porte ni `e2e` ni `test`, quelle que soit la casse, comme mot (en bord de nom ou séparé par `_` ou `-`), ou s'écrit avec d'autres caractères que des lettres sans accent, des chiffres, `_` et `-` (règle de `client/scripts/base-jetable.mjs`, commune à l'outil de comparaison du rendu), ainsi qu'un port API/frontend déjà occupé (Playwright réutiliserait un ancien serveur). `npm run test:e2e` seul suppose ces étapes déjà faites, comme en CI. Voir `client/playwright.config.ts` et [`docs/CONFIGURATION-ENVIRONNEMENT.md`](docs/CONFIGURATION-ENVIRONNEMENT.md#tests-et-ci).
- La CI est dans `.github/workflows/ci.yml`. Vérifier les checks sur le commit exact de la PR, et pas sur l'ancien commit approuvé.

## Frontières de décision et supervision

Claude Code peut proposer et livrer de nombreux lots, un par PR. Nelson garde les arbitrages métier, la validation du cabinet comptable/juridique quand requise et le feu vert de production ; les fusions reviennent à Claude Code dans les conditions du mode de livraison (décision du 20-10-2026). Les questions encore ouvertes sont listées dans la passation ; les présenter comme questions, pas comme exigences définitivement décidées. Les micro-arbitrages de droits ou d'affichage suivent la règle 5 de la méthode (choix par défaut documenté, à confirmer).

L'auditeur indépendant peut superviser les PR, audits et checks, avec vérification de la SHA et de l'écart à la vision ; il ne fusionne pas. Aucun webhook de suivi de ce dépôt n'est déclaré actif par cette documentation : sa configuration éventuelle est un travail séparé, avec authentification, filtrage des événements et tests. Ne lancer ni agent IA périodique ni fusion automatique en déduisant une autorisation de travailler par phases. Seule exception, décidée par Nelson le 31-10-2026 : le passage hebdomadaire du `controleur-coherence` (section « Circuit d'une PR et sous-agents de projet »), que Claude Code lance lui-même dans une session de travail, sans déclencheur automatique.
