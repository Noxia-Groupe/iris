# Modèle de droits des comptes Iris

## Principe

Les nouveaux types de compte **complètent** les rôles existants ; ils ne remplacent ni les comptes déjà créés ni leurs droits acquis.

Le modèle cible comporte deux étages :

1. **Type de compte** : poste et permissions accordées par défaut ;
2. **Permissions individuelles** : droits supplémentaires accordés à une personne sans changer son type de compte.

Un retrait de droit par rapport au type de compte sera traité explicitement lors d'une évolution ultérieure ; le premier socle ne doit pas casser les accès existants. `SUPERADMIN` conserve l'accès intégral.

Les permissions réutilisent le vocabulaire technique existant (`devis:read`, `devis:write`, `chantiers:read`, `finances:read`…), partagé à terme avec les clés d'intégration. Une permission côté interface ne constitue jamais une sécurité : le serveur doit appliquer la même règle.

## Types existants préservés

| Type | Périmètre actuel |
|---|---|
| `SUPERADMIN` | Accès complet, réglages réservés et gestion des superadministrateurs. |
| `ADMIN` | Administration générale, hors réglages réservés au superadministrateur. |
| `CONDUCTEUR_TRAVAUX` | Pilotage des chantiers confiés, planning et saisie/correction métier autorisée. |
| `COMMERCIAL` | Affaires et chantiers commerciaux qui lui sont rattachés. |

## Types complémentaires décidés

| Type | Droits métier attendus | Limites |
|---|---|---|
| `ASSISTANTE_COMMERCIALE` | Créer et gérer des devis pour le compte de tout commercial. | Ne consulte pas les statistiques commerciales ni le pilotage d'équipe. |
| `TECHNICIEN` | Lire les chantiers en cours sans prix ; consulter maintenance récurrente ; sur les SAV qui lui sont affectés, commenter, renseigner la résolution et clôturer. | Aucun montant, aucune marge, aucun paramétrage ou pilotage. |
| `COMPTABLE` | Gérer le périmètre comptable natif : devis/chantiers utiles à la comptabilité, puis factures, avoirs, comptes bancaires, rapprochements, relances, envois et export expert-comptable. | Les capacités non encore livrées restent indisponibles : aucune route ou écran fictif. |
| `DIRECTEUR_COMMERCIAL` | Tous les droits du commercial, visibilité sur les affaires/devis/statistiques de son équipe, objectifs mensuels, trimestriels, semestriels et annuels. | Périmètre limité à son équipe commerciale ; il ne devient pas administrateur général. |
| `RESPONSABLE` | Supervision des collaborateurs explicitement rattachés : lecture de leurs affaires, saisie et correction des achats et heures sur celles-ci, statistiques de leurs conducteurs. | Périmètre limité aux collaborateurs explicitement rattachés. Sans rattachement déclaré, il ne voit que ses propres affaires. |

## Périmètre hiérarchique d'un responsable

Le périmètre d'un compte `RESPONSABLE` est porté par une donnée, `User.responsableHierarchiqueId` :
chaque collaborateur désigne le responsable qui le supervise, depuis **Administration >
Utilisateurs**, colonne « Responsable ». Il n'est jamais déduit du rôle — un compte
« Responsable » sans rattachement déclaré ne voit et n'écrit que sur ses propres affaires.

Ce que ce rattachement ouvre, une fois déclaré :

| Capacité | Portée |
|---|---|
| Lecture des affaires, achats et heures | Affaires conduites par lui-même ou par un collaborateur rattaché. |
| Saisie, correction et suppression d'achats et d'heures | Les mêmes affaires, et uniquement celles-ci. |
| Statistiques des conducteurs (résultats et assiduité) | Les seuls conducteurs rattachés ; aucun coût ni marge au-delà. |

Garde-fous appliqués par le serveur :

- seul un compte `RESPONSABLE` actif peut être désigné responsable d'un collaborateur ;
- un compte ne peut pas être son propre responsable, ni fermer une boucle hiérarchique ;
- perdre le rôle `RESPONSABLE` détache l'équipe : elle ne réapparaît pas si le rôle est
  rendu plus tard, il faut la redéclarer ;
- l'attribution est réservée aux administrateurs.

Le périmètre commercial (directeur commercial → commerciaux) n'est pas ouvert par cette
donnée : il relève de la phase de commissionnement, avec ses propres règles.

## Règles d'implémentation

- Les comptes existants gardent leur rôle et leur niveau d'accès lors de la migration.
- L'assistante commerciale peut choisir le commercial porteur d'une affaire ; cette attribution reste traçable.
- Le technicien reçoit des données chantier sérialisées sans budgets, prix d'achat, prix vendu, marges ni commissions.
- Les relations hiérarchiques (responsable → collaborateurs, directeur commercial → commerciaux) sont des données explicites ; elles ne doivent jamais être déduites d'un intitulé de rôle.
- Les futures permissions SAV, maintenance, facturation, banque, avoir, relance, envoi et export sont documentées maintenant, mais ne seront activées qu'avec leur module métier et ses tests.
- Toute nouvelle route métier doit déclarer sa permission serveur avant son exposition interface.
