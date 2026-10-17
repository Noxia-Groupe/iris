# Iris — passation pour Claude Code

Iris est un ERP français natif pour métiers techniques, **en développement et non en production**. Une installation dessert une seule société avec sa propre base. Le dépôt et ses tests, et non un ancien audit ou une issue isolée, décrivent l'état exécutable.

## Lire avant de commencer

1. [`README.md`](README.md) : vision, invariants et état de la roadmap. [`docs/PRODUCT-VISION-ERP-TECHNIQUE.md`](docs/PRODUCT-VISION-ERP-TECHNIQUE.md) précise les parcours cibles, pas nécessairement leur implémentation actuelle.
2. [`docs/ROADMAP-PASSATION.md`](docs/ROADMAP-PASSATION.md) : état par chantier, dépendances, critères de sortie et points à arbitrer. Vérifier le code et les tests avant d'affirmer qu'un lot est absent ou achevé.
3. [`.agents/AGENTS.md`](.agents/AGENTS.md) : règles de branches, PR et revues croisées. Consulter **les commentaires** des issues/PR ; les descriptions peuvent dater d'une version ancienne de `main`.
4. [`docs/MODELE-DROITS-COMPTES.md`](docs/MODELE-DROITS-COMPTES.md), [`docs/CONFIGURATION-ENVIRONNEMENT.md`](docs/CONFIGURATION-ENVIRONNEMENT.md), [`server/tests/README.md`](server/tests/README.md) pour les droits, l'installation et les tests.

## Mode de livraison

- Vérifier les PR ouvertes **avant toute nouvelle branche**. Si une PR est en attente, demander à Nelson s'il faut continuer, fusionner ou abandonner. Un lot autonome = branche depuis `main` à jour + PR dédiée ; jamais de push direct sur `main`.
- Cadrer la PR avec périmètre, hors périmètre, critères métier observables et tests. Ne pas inventer une règle de commission, un tarif, une qualification réglementaire ou une politique client lorsqu'elle n'est pas décidée.
- Préserver Iris comme source de vérité. Pas de reprise d'ERP tiers ; catalogue et plan comptable initialement vides et paramétrables. Aucune IA externe dans Iris : un éventuel connecteur Hermes requiert une phase et des gardes dédiées.
- Pour toute écriture ou donnée sensible, droits API avant UI, périmètre hiérarchique explicite, audit/immutabilité et refus métier testés. Dates saisies/affichées en `JJ-MM-AAAA`, fuseau d'entreprise pour la date civile, stockage technique distinct. Les factures émises et leurs montants/mentions sont figés ; une correction passe par le cycle métier prévu.
- Tests backend HTTP contre PostgreSQL **jetable**, tests Playwright dans un vrai navigateur pour les parcours critiques. Ne pas confondre un test `SKIP` sans base avec un test réussi. Rejouer les suites pertinentes deux fois sur une même base conservée lorsque des fixtures persistantes peuvent interférer. `git diff --check`, builds, lint et CI doivent être verts sur la SHA courante.
- Chaque PR est auditée par une IA indépendante de celle qui l'a codée, sollicitée manuellement par Nelson qui relaie ses retours ; ne jamais auto-valider sa propre PR. **En complément, dès qu'une PR est terminée et prête pour revue, l'agent qui l'a codée déploie au minimum un sous-agent d'audit** (contexte distinct, diff complet : exactitude, droits et données sensibles, tests réellement probants, écart à la vision et aux règles de ce fichier), publie ses constats dans la PR et les traite selon la règle 3 de la méthode ci-dessous avant de la présenter. Cet audit interne ne remplace pas l'audit indépendant sollicité par Nelson et ne vaut pas validation. Le traitement des remarques d'audit suit la règle 3 : une remarque bloquante, ou qui touche un parcours de la règle 2, est corrigée et retestée avant fusion ; une remarque non bloquante ailleurs devient une issue étiquetée `suivi-audit` et ne retarde pas la fusion. Après chaque push correctif, relancer le sous-agent d'audit puis demander un nouvel audit indépendant. **Seul Nelson autorise la fusion** d'une PR, la validation comptable des changements de montants et la mise en production. Ne pas activer une mise en production par déduction d'une CI verte.
- Faire évoluer la roadmap dans une PR documentaire lorsque l'état des lots change. Distinguer systématiquement « implémenté », « partiel », « prévu » et « validé pour mise en service ».

## Méthode de travail (décision de Nelson du 16-10-2026)

Iris doit avancer en largeur sur ce dont le premier client a besoin, sans relâcher l'exigence là où une erreur coûte cher.

1. **Le périmètre du pilote est la boussole.** On avance en largeur sur ce dont le premier client a besoin le premier jour ; le reste attend.
2. **Exigence maximale inchangée là où une erreur coûte cher** : droits et périmètres, montants, factures et documents figés, journaux d'audit, sécurité. Ces parcours gardent des tests réels sur PostgreSQL et dans le navigateur.
3. **Remarques d'audit.** Ailleurs, une remarque d'audit non bloquante ne retarde plus la fusion : elle devient une issue étiquetée `suivi-audit`, traitée plus tard. Une remarque bloquante, ou qui touche un parcours de la règle 2, reste corrigée et retestée avant fusion.
4. **Rien d'historique ni de théorique sans données réelles.** Tant qu'aucune donnée réelle n'existe, ne traiter ni données historiques, ni migration de données existantes, ni déductions théoriques. Les signaler en une ligne dans la PR.
5. **Micro-arbitrages.** Sur un micro-arbitrage de droits ou d'affichage, ne pas solliciter Nelson : choisir l'option la plus simple et, en cas de doute, la plus restrictive ; la documenter dans la PR et dans `docs/ROADMAP-PASSATION.md` avec la mention « choix par défaut, à confirmer ». Ne lui remonter que ce qui touche les montants, les règles métier, le modèle de données ou un lot entier.

Ce qui ne change pas : une PR par lot, jamais de push direct sur `main`, l'audit interne et l'audit indépendant ; seul Nelson autorise les fusions (une CI verte n'y suffit pas), valide les montants et décide de la mise en production ; Iris reste sa propre source de vérité, et aucune règle de prix, de commission ou de conformité n'est inventée.

Choix de mise en œuvre de la règle 3 (choix par défaut, à confirmer) : l'étiquette s'appelle `suivi-audit` ; l'issue reprend le constat, sa preuve et le correctif proposé, et la PR la cite.

## Règles permanentes de conception (décision de Nelson du 17-10-2026)

1. **Un paramètre plutôt qu'une constante.** Toute nouvelle règle propre au fonctionnement d'une entreprise devient un paramètre, avec une valeur par défaut documentée, et non une constante dans le code. Exemples : qui valide, clôture ou convertit ; délais et seuils ; statuts et listes de valeurs ; modules activés. Ce qui relève des droits suit la proposition `docs/MODELE-DROITS-CIBLE.md`, à valider par Nelson.
   - La valeur par défaut reprend le comportement actuel. Pour une règle nouvelle, c'est la valeur décidée par Nelson. Pour un micro-arbitrage de droits ou d'affichage, la règle 5 s'applique ; une autre valeur non décidée lui est posée en question. La valeur par défaut est écrite dans la PR et dans la passation.
   - Elle n'invente aucune valeur métier : pas de prix, de commission ni de compte comptable par défaut.
   - Un changement de paramètre est journalisé, comme les réglages existants.
   - Restent dans le code, avec leur raison écrite, les règles légales ou d'intégrité : continuité et chronologie de la numérotation, immutabilité des documents émis, règles fiscales, invariants de droits.
   - Les règles déjà écrites en dur seront inventoriées par la proposition `docs/PARAMETRAGE-CIBLE.md`, à valider par Nelson ; elles ne sont pas converties avant cette validation.
2. **Des fichiers de taille raisonnable.** Aucun fichier de code applicatif ne dépasse environ 800 lignes ; au-delà, on le découpe, dans une PR sans changement de comportement.
   - Fichiers déjà trop longs : `server/index.ts` sera découpé par le chantier 2 de la [passation](docs/ROADMAP-PASSATION.md#chantiers-techniques-décision-de-nelson-du-17-10-2026) ; le découpage des écrans `client/src/pages/ChantierDetail.tsx`, `Admin.tsx` et `Planning.tsx` sera proposé ensuite.
   - Choix par défaut, à confirmer : les fichiers de tests, les migrations, les fichiers générés (lockfiles, client Prisma) et le schéma Prisma (`server/prisma/schema.prisma`, que Prisma 5 ne scinde qu'avec une fonction en préversion) ne sont pas concernés.

## Commandes du dépôt

- Backend : `cd server && npm test` ; les tests HTTP exigent `TEST_DATABASE_URL` pointant vers une base jetable.
- Client : `cd client && npm run build && npm run lint && npm run test:unit`.
- E2E en local : `cd client && E2E_DATABASE_URL=… npm run test:e2e:local`. La commande régénère Prisma, recompile `server/dist` (que Playwright démarre tel quel), migre la base jetable, puis lance Playwright ; elle refuse une base sans `e2e`/`test` dans son nom et un port API/frontend déjà occupé (Playwright réutiliserait un ancien serveur). `npm run test:e2e` seul suppose ces étapes déjà faites, comme en CI. Voir `client/playwright.config.ts` et [`docs/CONFIGURATION-ENVIRONNEMENT.md`](docs/CONFIGURATION-ENVIRONNEMENT.md#tests-et-ci).
- La CI est dans `.github/workflows/ci.yml`. Vérifier les checks sur le commit exact de la PR, et pas sur l'ancien commit approuvé.

## Frontières de décision et supervision

Claude Code peut proposer et livrer de nombreux lots, un par PR. Nelson garde les arbitrages métier, la validation du cabinet comptable/juridique quand requise, l'approbation des merges et le feu vert de production. Les questions encore ouvertes sont listées dans la passation ; les présenter comme questions, pas comme exigences définitivement décidées. Les micro-arbitrages de droits ou d'affichage suivent la règle 5 de la méthode (choix par défaut documenté, à confirmer).

L'auditeur indépendant peut superviser les PR, audits et checks, avec vérification de la SHA et de l'écart à la vision ; il ne fusionne pas. Aucun webhook de suivi de ce dépôt n'est déclaré actif par cette documentation : sa configuration éventuelle est un travail séparé, avec authentification, filtrage des événements et tests. Ne lancer ni agent IA périodique ni fusion automatique en déduisant une autorisation de travailler par phases.
