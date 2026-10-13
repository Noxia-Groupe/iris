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
| `RESPONSABLE` | Supervision de techniciens et/ou conducteurs rattachés ; lecture de leur travail et statistiques. | Périmètre limité à sa branche hiérarchique explicite : collaborateurs directs, puis les leurs, à tous les niveaux. |
| `DIRECTEUR` | Pilotage de toute la société : tous les chantiers non annulés, leur fiche et, si la société le laisse, leur rentabilité et ses alertes. | Lecture seule (`chantiers:read`) : ni administration, ni paramétrage, ni saisie, planning, SAV ou statistiques Travaux. Un droit supplémentaire s'accorde individuellement. |

## Règles d'implémentation

- Les comptes existants gardent leur rôle et leur niveau d'accès lors de la migration.
- L'assistante commerciale peut choisir le commercial porteur d'une affaire ; cette attribution reste traçable.
- Le technicien reçoit des données chantier sérialisées sans budgets, prix d'achat, prix vendu, marges ni commissions.
- Les relations hiérarchiques (responsable → collaborateurs, directeur commercial → commerciaux) sont des données explicites ; elles ne doivent jamais être déduites d'un intitulé de rôle.
- Le responsable hiérarchique d'un compte se règle dans Administration > Utilisateurs (`PATCH /api/users/:id/responsable-hierarchique`, administrateurs seulement). Le serveur refuse soi-même, un compte inconnu ou désactivé, et toute boucle. Seul un compte `RESPONSABLE` tire un périmètre de sa branche ; un rattachement à un autre type de compte reste une donnée d'organisation, sans effet sur ses accès.
- **Rentabilité d'un chantier** (montant vendu, marge du jour, marge estimée, alertes de perte et de marge faible, facturation de la fiche) : toujours visible des administrateurs ; visible aussi, tant que la société ne les retire pas dans Administration > Marges, du conducteur ou responsable chargé du chantier, des comptes `RESPONSABLE` dont la branche contient ce conducteur, et des comptes `DIRECTEUR`. Côté clé d'intégration, le scope `finances:read`. Ni le commercial ni le technicien n'en sont destinataires. Les dépassements et l'absence de saisie restent visibles de tous ceux qui voient le chantier.
- Les futures permissions SAV, maintenance, facturation, banque, avoir, relance, envoi et export sont documentées maintenant, mais ne seront activées qu'avec leur module métier et ses tests.
- Toute nouvelle route métier doit déclarer sa permission serveur avant son exposition interface.
