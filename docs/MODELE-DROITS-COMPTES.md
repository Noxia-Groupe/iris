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
| `TECHNICIEN` | Lire sans prix les chantiers dont il est chargé, terminés compris ; consulter l'annuaire des clients, leurs contacts et leurs sites, et l'historique des chantiers sans montant (décidé par Nelson le 13-10-2026, lot prévu) ; consulter maintenance récurrente ; sur les SAV qui lui sont affectés, commenter, renseigner la résolution et clôturer. | Aucun montant, aucune marge, aucun devis, aucun paramétrage ou pilotage ; ni modification, ni réattribution du commercial, ni clôture de l'affaire. |
| `COMPTABLE` | Gérer le périmètre comptable natif : devis/chantiers utiles à la comptabilité, puis factures, avoirs, comptes bancaires, rapprochements, relances, envois et export expert-comptable. | Les capacités non encore livrées restent indisponibles : aucune route ou écran fictif. |
| `DIRECTEUR_COMMERCIAL` | Tous les droits du commercial, visibilité sur les affaires/devis/statistiques de son équipe, objectifs mensuels, trimestriels, semestriels et annuels. | Périmètre limité à son équipe commerciale ; il ne devient pas administrateur général. |
| `RESPONSABLE` | Supervision de techniciens et/ou conducteurs rattachés ; lecture de leur travail et statistiques. | Périmètre limité à sa branche hiérarchique explicite : collaborateurs directs, puis les leurs, à tous les niveaux. |
| `DIRECTEUR` | Pilotage de toute la société : tous les chantiers non annulés, leur fiche et, si la société le laisse, leur rentabilité et ses alertes. | Lecture seule (`chantiers:read`) : ni administration, ni paramétrage, ni saisie, planning, SAV ou statistiques Travaux. Le droit devis peut s'accorder individuellement ; la saisie Travaux, elle, ne s'ouvre pas par permission (son périmètre d'écriture reste celui du conducteur du chantier, du responsable de branche et de l'administration). |

## Règles d'implémentation

- Les comptes existants gardent leur rôle et leur niveau d'accès lors de la migration.
- L'assistante commerciale peut choisir le commercial porteur d'une affaire ; cette attribution reste traçable.
- Le technicien reçoit des données chantier sérialisées sans budgets en montant, prix d'achat, prix vendu, marges ni commissions. Décisions de Nelson du 13-10-2026, appliquées :
  - il garde le budget d'heures et ses heures réalisées, sans montant ;
  - il ne voit ni budgets matériel et main-d'œuvre, ni coûts (achats, main-d'œuvre, totaux), ni taux horaires, ni alertes de dépassement (matériel, main-d'œuvre, heures), dans la liste, la fiche, les journaux d'achats, d'heures et de saisies, le tableau de bord et la liste des intervenants ;
  - il ne modifie pas l'affaire dont il est chargé, n'en réattribue pas le commercial et ne la clôture pas ; le serveur refuse avec un message explicite (403) et la fiche affiche « Consultation seule » ;
  - la clôture de son affaire revient, selon la décision, à son N+1 et au-dessus ; implémenté : aux comptes `RESPONSABLE` dont la branche contient le technicien, à tout niveau, et à l'administration. Un N+1 ou supérieur d'un autre type (conducteur, directeur…) ne la clôture pas (question ouverte dans la passation) ;
  - les droits `devis:read`, `devis:write`, `chantiers:write`, `chantiers:archive` et l'accès financier (ce dernier par déduction de #123, à confirmer par Nelson) ne lui sont jamais accordés, ni par son type de compte ni individuellement ; une permission ou un accès financier déjà enregistrés restent sans effet, sans être effacés, et retrouvent leur effet si le compte reprend un autre type ; Administration > Utilisateurs les affiche « Sans effet » et un super administrateur peut seulement les retirer (`PUT /api/users/:id/permissions` refuse tout nouvel octroi, pas le maintien ou le retrait d'un droit déjà enregistré) ;
  - Nelson a décidé de lui ouvrir l'annuaire des clients (`clients:read` : clients, contacts et sites, sans devis ni montants) et l'historique des chantiers sans montant. Aujourd'hui, seul un `clients:read` enregistré sur son compte (déjà présent, ou accordé par un super administrateur avec `PUT /api/users/:id/permissions`, que l'écran Utilisateurs ne propose pas) lui donne l'annuaire (contacts et sites), par l'API seulement, le menu Clients étant réservé aux administrateurs ; aucun historique des chantiers n'est encore exposé sur la fiche client. Déjà appliqué : décocher le droit devis d'un technicien ne retire que `devis:read` et `devis:write`, et conserve `clients:read`. Prévu dans un lot dédié : lecture de l'annuaire par défaut, menu, fiche client en consultation seule et historique des chantiers sans montant.
- Les relations hiérarchiques (responsable → collaborateurs, directeur commercial → commerciaux) sont des données explicites ; elles ne doivent jamais être déduites d'un intitulé de rôle.
- Le responsable hiérarchique d'un compte se règle dans Administration > Utilisateurs (`PATCH /api/users/:id/responsable-hierarchique`, administrateurs seulement). Le serveur refuse soi-même, un compte inconnu ou désactivé, et toute boucle. Seul un compte `RESPONSABLE` tire un périmètre de sa branche ; un rattachement à un autre type de compte reste une donnée d'organisation, sans effet sur ses accès.
- **Rentabilité d'un chantier** (montant vendu global, marge du jour, marge estimée, alertes de perte et de marge faible, facturation de la fiche) : toujours visible des administrateurs ; visible aussi, tant que la société ne les retire pas dans Administration > Marges, du conducteur ou responsable chargé du chantier, des comptes `RESPONSABLE` dont la branche contient ce conducteur, et des comptes `DIRECTEUR`. Les mêmes conditions valent pour les réponses des écritures sur un chantier et pour le CA et la marge des statistiques Travaux d'un responsable (la marge, comme partout, seulement si la marge commerciale est active) ; l'affaire liée à une intervention SAV n'expose jamais son montant vendu. Côté clé d'intégration, le scope `finances:read`. Ni le commercial ni le technicien n'en sont destinataires. Les dépassements, l'absence de saisie et les budgets par poste (matériel, main-d'œuvre, heures) restent visibles de tous ceux qui voient le chantier ; le technicien n'en garde que l'absence de saisie et le budget d'heures, sans montant ni alerte de dépassement (voir plus haut). Les budgets par poste permettent d'en déduire le montant vendu, donc la marge du jour.
- **Taux horaire de chacun (décidé par Nelson le 13-10-2026, lot prévu)** : réservé aux administrateurs, en consultation comme en modification. Déjà appliqué : la création, la modification et la suppression d'un intervenant, donc de son taux, sont réservées aux administrateurs par l'API (`POST /api/intervenants`, `PUT` et `DELETE /api/intervenants/:id`), et le technicien ne reçoit plus aucun taux des heures saisies sur les chantiers ni de la liste des intervenants (#123). Les autres profils non administrateurs en reçoivent encore, notamment par : `GET /api/intervenants` (taux chargé) ; les pointages de la fiche et du journal des heures (taux appliqué de chaque ligne et taux chargé de l'intervenant joint) ; les instantanés des journaux des saisies (chantier et SAV) ; les coûts SAV, pour un conducteur ; le coût par intervenant des statistiques et le coût horaire de référence (€/h) des hypothèses de la marge estimée, d'où l'on retrouve un taux.
- **Historisation (décidée par Nelson le 13-10-2026, lot prévu)** : tout changement de paramètres, dans leur globalité, et tout changement de droits d'un utilisateur seront journalisés. Seuls les administrateurs pourront consulter et récupérer ces journaux, selon l'option retenue par Nelson : un onglet « Journal » dans Administration, filtrable par date, type et auteur, indiquant qui a changé quoi, avant et après, avec export CSV. Périmètre retenu par Nelson :
  - **droits** : création, type de compte, permissions, accès finance, activation, rattachement hiérarchique, suppression, ainsi que « aussi commercial » au titre de tous les changements de droits ;
  - **réglages** : paramètres, rémunération commerciale, modules, identité de la société, clés d'intégration ;
  - la comptabilité et les mentions légales gardent leur traçabilité propre ; leurs trous (création d'un compte comptable, auteur de la création et de la publication d'une version des mentions, date d'une republication) sont une question ouverte de la passation, comme l'extension à des réglages hors de cette liste.
- Les futures permissions SAV, maintenance, facturation, banque, avoir, relance, envoi et export sont documentées maintenant, mais ne seront activées qu'avec leur module métier et ses tests.
- Toute nouvelle route métier doit déclarer sa permission serveur avant son exposition interface.
