# Workflow GitHub — Iris

Chaque fonctionnalité, correctif ou phase est développée sur une branche dédiée :

1. Avant de créer une branche, vérifier les pull requests ouvertes et les branches en attente.
2. S'il en existe une, demander au responsable s'il faut la fusionner, l'abandonner ou poursuivre dessus.
3. Partir de `main` à jour puis créer une branche nommée `feat/…`, `fix/…`, `chore/…` ou `docs/…`.
4. Exécuter les builds, tests et contrôles pertinents.
5. Commiter, pousser la branche et ouvrir une pull request vers `main`.
6. Ne jamais pousser directement sur `main` : la fusion intervient uniquement après revue et CI verte.
