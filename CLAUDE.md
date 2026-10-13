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
- Chaque PR est auditée par une IA indépendante de celle qui l'a codée ; ne jamais auto-valider sa propre PR. **Dès qu'une PR est terminée et prête pour revue, l'agent qui l'a codée déploie au minimum un sous-agent d'audit** (contexte distinct, diff complet : exactitude, droits et données sensibles, tests réellement probants, écart à la vision et aux règles de ce fichier), publie ses constats dans la PR et corrige ceux qui s'appliquent avant de la présenter. Nelson peut en outre solliciter un auditeur externe et relayer ses retours. Toutes les remarques d'audit applicables, même dites non bloquantes, sont corrigées et retestées ; demander un nouvel audit après chaque push correctif. **Seul Nelson autorise la fusion** d'une PR, la validation comptable des changements de montants et la mise en production. Ne pas activer une mise en production par déduction d'une CI verte.
- Faire évoluer la roadmap dans une PR documentaire lorsque l'état des lots change. Distinguer systématiquement « implémenté », « partiel », « prévu » et « validé pour mise en service ».

## Commandes du dépôt

- Backend : `cd server && npm test` ; les tests HTTP exigent `TEST_DATABASE_URL` pointant vers une base jetable.
- Client : `cd client && npm run build && npm run lint && npm run test:unit`.
- E2E en local : `cd client && E2E_DATABASE_URL=… npm run test:e2e:local`. La commande régénère Prisma, recompile `server/dist` (que Playwright démarre tel quel), migre la base jetable, puis lance Playwright ; elle refuse une base sans `e2e`/`test` dans son nom et un port API/frontend déjà occupé (Playwright réutiliserait un ancien serveur). `npm run test:e2e` seul suppose ces étapes déjà faites, comme en CI. Voir `client/playwright.config.ts` et [`docs/CONFIGURATION-ENVIRONNEMENT.md`](docs/CONFIGURATION-ENVIRONNEMENT.md#tests-et-ci).
- La CI est dans `.github/workflows/ci.yml`. Vérifier les checks sur le commit exact de la PR, et pas sur l'ancien commit approuvé.

## Frontières de décision et supervision

Claude Code peut proposer et livrer de nombreux lots, un par PR. Nelson garde les arbitrages métier, la validation du cabinet comptable/juridique quand requise, l'approbation des merges et le feu vert de production. Les questions encore ouvertes sont listées dans la passation ; les présenter comme questions, pas comme exigences définitivement décidées.

L'auditeur indépendant peut superviser les PR, audits et checks, avec vérification de la SHA et de l'écart à la vision ; il ne fusionne pas. Aucun webhook de suivi de ce dépôt n'est déclaré actif par cette documentation : sa configuration éventuelle est un travail séparé, avec authentification, filtrage des événements et tests. Ne lancer ni agent IA périodique ni fusion automatique en déduisant une autorisation de travailler par phases.
