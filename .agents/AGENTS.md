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
