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

## Méthode et remarques d'audit (décision du 16-10-2026)

Les règles complètes sont dans [`CLAUDE.md`](../CLAUDE.md#méthode-de-travail-décision-de-nelson-du-16-10-2026). Pour les revues :

1. Le périmètre du pilote guide les priorités : une PR dit à quel besoin du premier client elle répond.
2. Droits et périmètres, montants, factures et documents figés, journaux d'audit et sécurité gardent l'exigence maximale : une remarque qui les touche est bloquante pour la fusion et se corrige avant.
3. Toute autre remarque non bloquante ne retarde pas la fusion : l'auteur ouvre une issue étiquetée `suivi-audit` (constat, preuve, correctif proposé) et la cite dans la PR. Elle remplace l'obligation de corriger toute remarque non bloquante avant fusion.
4. Pas de traitement de données historiques, de migration de données existantes ni de déduction théorique tant qu'aucune donnée réelle n'existe : une ligne dans la PR suffit.
5. Un micro-arbitrage de droits ou d'affichage prend l'option la plus simple et, en cas de doute, la plus restrictive, documentée « choix par défaut, à confirmer » dans la PR et la passation, sans solliciter le responsable.
