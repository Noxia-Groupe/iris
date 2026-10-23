# Workflow GitHub — Iris

Chaque fonctionnalité, correctif ou phase est développée sur une branche dédiée :

1. Avant de créer une branche, vérifier les pull requests ouvertes et les branches en attente.
2. S'il en existe une, demander au responsable s'il faut la fusionner, l'abandonner ou poursuivre dessus.
3. Partir de `main` à jour puis créer une branche nommée `feat/…`, `fix/…`, `chore/…` ou `docs/…`.
4. Exécuter les builds, tests et contrôles pertinents.
5. Commiter, pousser la branche et ouvrir une pull request vers `main`.
6. Ne jamais pousser directement sur `main` : la fusion intervient uniquement après revue et CI verte.

## Revue croisée entre agents

Plusieurs agents travaillent sur ce dépôt. Une branche et sa pull request
appartiennent à l'agent qui les a ouvertes.

1. Relire le travail d'un autre agent se fait **par commentaire de revue** sur sa pull
   request : constat, preuve de reproduction, correctif proposé prêt à reprendre.
2. Ne jamais pousser sur la branche d'un autre agent, même pour un correctif jugé petit
   et sûr. C'est l'auteur qui applique, amende ou écarte — il connaît son intention et a
   peut-être du travail en cours en local.
3. La seule exception est une demande explicite du responsable, pour un correctif nommé.
4. Un constat de revue s'accompagne de ce qui permet de le vérifier : commande exécutée,
   sortie obtenue, ou test qui passe au rouge quand on retire le correctif. Une affirmation
   sans reproduction n'est pas un constat.
5. L'auteur résout les fils qu'il a traités ; le relecteur résout les siens une fois la
   correction livrée par l'auteur.

## Méthode de travail (décision du 16-10-2026)

Mêmes règles que dans [`CLAUDE.md`](../CLAUDE.md#méthode-de-travail-décision-de-nelson-du-16-10-2026), à appliquer aussi aux revues entre agents :

1. **Le périmètre du pilote est la boussole.** On avance en largeur sur ce dont le premier client a besoin le premier jour ; le reste attend.
2. **Exigence maximale inchangée là où une erreur coûte cher** : droits et périmètres, montants, factures et documents figés, journaux d'audit, sécurité. Ces parcours gardent des tests réels sur PostgreSQL et dans le navigateur.
3. **Remarques d'audit.** Ailleurs, une remarque d'audit non bloquante ne retarde plus la fusion : elle devient une issue étiquetée `suivi-audit`, traitée plus tard. Une remarque bloquante, ou qui touche un parcours de la règle 2, reste corrigée et retestée avant fusion. Un test manquant seul (cas non couvert, mutant survivant), sans erreur constatée dans le code, la documentation ou un test existant, ne retarde pas la fusion, même sur un autre parcours de la règle 2 que les montants : il devient une issue `suivi-audit` avec le test proposé, versé ensuite par une PR de suivi (lecture retenue de la décision de Nelson du 23-10-2026, citée dans [`CLAUDE.md`](../CLAUDE.md#méthode-de-travail-décision-de-nelson-du-16-10-2026)).
4. **Rien d'historique ni de théorique sans données réelles.** Tant qu'aucune donnée réelle n'existe, ne traiter ni données historiques, ni migration de données existantes, ni déductions théoriques. Les signaler en une ligne dans la PR.
5. **Micro-arbitrages.** Sur un micro-arbitrage de droits ou d'affichage, ne pas solliciter Nelson : choisir l'option la plus simple et, en cas de doute, la plus restrictive ; la documenter dans la PR et dans `docs/ROADMAP-PASSATION.md` avec la mention « choix par défaut, à confirmer ». Ne lui remonter que ce qui touche les montants, les règles métier, le modèle de données ou un lot entier.

Ce qui ne change pas : une PR par lot, jamais de push direct sur `main`, l'audit interne, et l'audit indépendant à la demande de Nelson ; une CI verte seule n'autorise aucune fusion : Nelson a confié à Claude Code la fusion des PR de Claude Code, dans les conditions de sa décision du 20-10-2026 ([`CLAUDE.md`](../CLAUDE.md#mode-de-livraison)) ; Nelson valide les montants avec le cabinet et décide de la mise en production ; Iris reste sa propre source de vérité, et aucune règle de prix, de commission ou de conformité n'est inventée.

**Ordre pendant le pilote** (décision de Nelson du 19-10-2026) : « La prochaine PR fonctionnelle est le lot 3b. Jusqu'à la fin du pilote, un correctif ne passe avant un lot que s'il est bloquant ou s'il touche un montant. Tout le reste devient une issue, traitée après le pilote. » Le 21-10-2026, le lot 3 étant implémenté, Nelson a placé les lots pilotes 4 à 6 avant le premier jour, et #179, #181 et le lot P0 du paramétrage avant la fin du pilote ; pour P0, la lecture retenue est avant le premier jour ([historique](../docs/HISTORIQUE-DECISIONS.md#décisions-du-21-10-2026)).

Choix de mise en œuvre de la règle 3 (choix par défaut, à confirmer) : l'étiquette s'appelle `suivi-audit` ; l'issue reprend le constat, sa preuve et le correctif proposé, et la PR la cite. Une revue classe ses remarques en R (défaut de comportement ou de sûreté), C (autre erreur à corriger avant fusion : documentation inexacte, test existant faux ou instable, procédure), T (test manquant seulement, hors montants) et N (notes).

## Règles permanentes de conception (décision du 17-10-2026)

Mêmes règles que dans [`CLAUDE.md`](../CLAUDE.md#règles-permanentes-de-conception-décision-de-nelson-du-17-10-2026), à vérifier aussi en revue :

1. **Un paramètre plutôt qu'une constante.** Toute nouvelle règle propre au fonctionnement d'une entreprise devient un paramètre, avec une valeur par défaut documentée, et non une constante dans le code. La valeur par défaut n'invente aucune valeur métier (ni prix, ni commission, ni compte comptable). Les règles légales ou d'intégrité restent dans le code, avec leur raison écrite.
2. **Des fichiers de taille raisonnable.** Aucun fichier de code applicatif ne dépasse environ 800 lignes ; au-delà, on le découpe, dans une PR sans changement de comportement. Les fichiers de tests, les migrations, les fichiers générés et le schéma Prisma ne sont pas concernés (choix par défaut, à confirmer).
3. **Des variables d'environnement toujours documentées** (consigne de Nelson du 20-10-2026). Toute PR qui lit une nouvelle variable, ou en change le rôle, le format ou le caractère obligatoire, met à jour dans la même PR `server/.env.example` ou `.env.example` et `docs/CONFIGURATION-ENVIRONNEMENT.md` ; `server/tests/environnement.test.mjs` le vérifie en CI.

Une revue signale tout nouveau seuil, délai, statut ou circuit de validation écrit en dur. Elle signale aussi tout fichier applicatif qui dépasse cette taille, ou qui la dépassait déjà et grossit encore. Ces remarques suivent la règle 3 de la méthode.
