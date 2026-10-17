# Modèle de droits cible : proposition

> **Proposition du 17-10-2026, à valider par Nelson avant tout code** (chantier technique 3). Rien de ce document n'est implémenté. C'est un parcours de droits : exigence maximale (règle 2 de la méthode).
>
> L'état actuel est décrit par [`MODELE-DROITS-COMPTES.md`](MODELE-DROITS-COMPTES.md). L'inventaire détaillé du code, règle par règle, avec ses références `fichier:ligne`, est en annexe : [`MODELE-DROITS-INVENTAIRE.md`](MODELE-DROITS-INVENTAIRE.md).

## 1. Le besoin

Nelson, le 17-10-2026 : « Le modèle actuel est robuste, mais il est figé dans le code et trop complexe à paramétrer. Il doit convenir aussi bien à une TPE de 10 personnes qu'à une entreprise de 75, et permettre d'ajouter un niveau de droits sans développement. »

Ce que montre l'inventaire :
- **Dix types de compte figés dans le code.** Leurs droits sont répartis entre des permissions (`devis:read`…), des gardes de type de compte (`requireAdmin`, `blockCommercial`, `blockTechnicien`…), des tests écrits dans le corps des routes (plusieurs dizaines) et trois réglages de la société (destinataires de la rentabilité). Ajouter un niveau demande du code à tous ces endroits.
- **Des permissions sans effet.** `finances:read`, `clients:write`, `catalogue:*`, `equipements:*` et `company:read` s'accordent à une personne sans rien lui ouvrir ; la case « Finance » non plus.
- **Des périmètres définis plusieurs fois.** Le « titulaire » d'un chantier a cinq définitions (liste, fiche, modification, saisies, clôture) ; devis et clients n'ont aucun périmètre.
- **Des écarts entre la documentation et le code.** Directeur commercial, assistante commerciale et comptable ne font pas ce que décrit `MODELE-DROITS-COMPTES.md` ; ils écrivent par ailleurs dans le planning et les référentiels (#179).
- **L'écran raisonne autrement que le serveur.** Il teste souvent des types de compte là où le serveur teste une permission, si bien que des droits du serveur restent invisibles.

## 2. Inventaire des règles actuelles (résumé)

Le détail, avec chaque route, sa garde et les types qu'elle admet, est dans l'[annexe](MODELE-DROITS-INVENTAIRE.md) : sections A1 à A8 pour le serveur, B pour l'écran, C pour la matrice, D pour les écarts. Les numéros de ligne y renvoient au commit `84e27a1`. Le découpage du serveur (chantier 2) les déplace, mais garde les noms des fonctions.

| Famille de règles | Où dans le code (fonctions) | Types concernés |
|---|---|---|
| Types de compte | `ROLE_*`, `ALLOWED_ROLES`, `isAdminRole`, `isSuperAdminRole` | les 10 |
| Permissions par défaut et individuelles | `DEFAULT_USER_PERMISSIONS`, `permissionsEffectives`, `requirePermission`, `PUT /api/users/:id/permissions` | tous ; le super administrateur les a toutes |
| Interdits du technicien | `DROITS_INTERDITS_TECHNICIEN` | technicien |
| Gardes de type de compte | `requireAdmin`, `requireSuperAdmin`, `blockCommercial`, `blockCommercialSeulement`, `blockTechnicien`, `requireTravauxRead`, garde en ligne de `POST /api/interventions` | selon la garde |
| Périmètres de lecture | `perimetreDemandeur`, `perimetreChantiers`, `getInterventionFilterForUser`, `brancheHierarchique` | commercial, conducteur, responsable, technicien, directeur |
| Écriture et clôture | `assertChantierWritable`, `peutCloturerChantier`, contrôles du titulaire dans `PATCH /api/chantiers/:id` | conducteur, responsable, directeur |
| Montants | `voitRentabilite` (et les réglages `rentabiliteConducteur`, `rentabiliteHierarchie`, `rentabiliteDirecteurs`), `voitMontantsChantier`, `voitCoutMainOeuvre`, `voitPrixAchatDevis`, `saisieSelonDroits` | tous |
| Administration des comptes | `refuseSuperAdminTarget`, `isLastSuperAdmin`, `journaliserDroitsCompte`, `entreesVisiblesJournal` | administrateurs |
| Modules | `requirePlanningActif` | tous sauf le super administrateur |
| Clés d'intégration | `API_SCOPES`, `requireApiKey`, `routeMixte` | clés |
| Écran | `client/src/lib/droits.ts`, `menu.ts`, `App.tsx` (`PrivateRoute`), écrans | tous |

## 3. Modèle cible

Trois notions, et une quatrième facultative.

### 3.1 Permissions élémentaires

Une permission = **un domaine et une action**, écrite en langage clair. Une seule liste sert au serveur, à l'écran et aux clés d'intégration.

| Domaine | Actions proposées |
|---|---|
| Clients (contacts, sites) | consulter ; créer et modifier ; désactiver |
| Parc d'équipements | consulter ; créer, modifier et archiver |
| Catalogue | consulter ; créer, modifier et désactiver ; voir les prix d'achat |
| Devis | consulter ; créer et modifier ; enregistrer la signature ; convertir ; constater l'acompte ; annuler ; voir et saisir les prix d'achat |
| Chantiers | consulter ; modifier la fiche ; réattribuer le titulaire et le commercial ; clôturer ; rouvrir ; voir les montants (budgets, coûts) ; voir la rentabilité (vendu, marges) ; voir le coût de main-d'œuvre et les taux |
| Saisies Travaux (achats, heures) | consulter ; saisir et corriger ; archiver et restaurer |
| Interventions SAV | consulter ; créer ; changer le statut ; placer au planning ; compte rendu et signature ; saisir ses heures ; gérer les coûts |
| Contrats de maintenance | consulter ; créer et modifier ; générer les visites |
| Planning | consulter ; modifier les affectations ; gérer les types d'événement ; partager publiquement |
| Factures et avoirs | consulter ; préparer un brouillon ; émettre ; annuler et créer un avoir |
| Règlements | consulter ; saisir ; contre-passer |
| Comptabilité | consulter ; paramétrer (plan, règles, TVA, import) ; exporter |
| Statistiques | tableau de bord ; statistiques Travaux ; statistiques commerciales |
| Commissions | voir les siennes ; voir celles des autres ; régler la prime de suivi |
| Comptes et droits | gérer les comptes ; gérer les rôles ; relier les fiches intervenant |
| Paramètres | paramètres métier ; identité de la société ; modules ; clés d'intégration |
| Journal des paramètres et des droits | consulter ; régler la conservation |

L'actuel « droit devis », par exemple, devient « Devis : consulter » plus « Devis : créer et modifier ». La liste définitive se fixe dans le premier lot (section 8). Toute nouvelle route déclare sa permission, comme le demande déjà `MODELE-DROITS-COMPTES.md`.

### 3.2 Un périmètre pour chaque permission

Chaque permission accordée porte un périmètre :

| Périmètre | Sens |
|---|---|
| **Ses dossiers** | ce dont le compte est chargé : titulaire d'un chantier, commercial d'une affaire, intervenant affecté, auteur d'une intervention |
| **Son équipe** | ses dossiers et ceux de sa branche hiérarchique (collaborateurs directs, puis les leurs) |
| **Toute l'entreprise** | sans restriction |

« Ses dossiers » reçoit **une définition par domaine**, écrite une fois dans le moteur. Au premier lot, chaque définition reprend exactement la règle actuelle, y compris ses différences d'un domaine à l'autre. Leur éventuelle harmonisation, par exemple pour le titulaire, sera une décision de Nelson, prise ensuite.

Certains domaines n'ont qu'un périmètre utile. Le paramétrage, par exemple, porte toujours sur toute l'entreprise : l'écran ne propose alors que « oui » ou « non ».

### 3.3 Des rôles paramétrables

Un **rôle** = un ensemble de permissions avec leur périmètre. Depuis Administration, on peut :
- **créer** un rôle, vide ou à partir d'un modèle ;
- **dupliquer** un rôle pour l'ajuster ;
- **renommer** un rôle ;
- **supprimer** un rôle qu'aucun compte ne porte.

Chaque compte porte **un rôle**. Proposition : plus de permissions individuelles. Une exception se traite en dupliquant un rôle (« Conducteur + archivage », par exemple), ce qui garde la matrice lisible (question 1, section 9).

### 3.4 Une hiérarchie facultative

Le rattachement hiérarchique existe déjà (`responsableHierarchiqueId`). Il ne sert qu'au périmètre « son équipe » :
- une TPE n'en règle aucun, et « son équipe » se réduit alors à « ses dossiers » ;
- une PME relie ses collaborateurs, et chaque rôle choisit, permission par permission, s'il voit l'équipe.

Aujourd'hui, seul le type `RESPONSABLE` tire un périmètre de sa branche. Le modèle cible permet à tout rôle de le faire, par exemple un directeur commercial sur son équipe de commerciaux, comme le décrit `MODELE-DROITS-COMPTES.md`.

## 4. Modèles prêts à l'emploi

Ce sont des propositions. Chaque modèle reste modifiable après son application, et aucun n'est imposé.

### 4.1 « Iris actuel » : les dix types de compte d'aujourd'hui

Ils deviennent dix rôles prédéfinis, au comportement **strictement identique** au code actuel, écarts compris (section 7). C'est le point de départ de la migration (section 6).

### 4.2 TPE : trois rôles, sans hiérarchie

| Rôle | Contenu proposé |
|---|---|
| **Dirigeant** | tout, sur toute l'entreprise (rôle « super administrateur ») |
| **Bureau** | clients, devis, chantiers, interventions et planning sur toute l'entreprise ; facturation et règlements ; montants visibles ; ni gestion des rôles ni clés d'intégration |
| **Technicien** | ses interventions (statut, compte rendu, signature, ses heures) ; planning en lecture ; annuaire des clients en lecture ; aucun montant |

### 4.3 PME : avec hiérarchie

| Rôle | Contenu proposé |
|---|---|
| **Direction** | tout, sur toute l'entreprise |
| **Administration** | comme aujourd'hui l'administrateur |
| **Comptabilité** | factures, avoirs, règlements, comptabilité, export ; chantiers et devis en lecture ; toute l'entreprise |
| **Directeur commercial** | devis et affaires de son équipe ; statistiques commerciales de son équipe |
| **Commercial** | ses devis et ses affaires ; ses statistiques |
| **Responsable travaux** | chantiers, saisies, interventions et planning de son équipe ; statistiques Travaux de son équipe |
| **Conducteur de travaux** | ses chantiers, ses saisies, les interventions qu'il crée ou qui le concernent ; planning |
| **Technicien** | comme en TPE |

Deux de ces rôles décrivent un comportement qui n'existe pas encore : l'équipe du directeur commercial et les devis rattachés à un commercial (le devis n'a pas de commercial aujourd'hui). Ils ne s'appliqueront qu'avec le lot qui les rend possibles.

## 5. L'écran

### 5.1 Tableau rôles × permissions

- Une ligne par permission, groupée par domaine, en langage clair, par exemple « Chantiers : voir la rentabilité » ; une colonne par rôle.
- Dans chaque case : « — », « Ses dossiers », « Son équipe » ou « Toute l'entreprise ».
- En tête de colonne : le nom du rôle, le nombre de comptes qui le portent, et les commandes dupliquer, renommer et supprimer.
- Le rôle « Super administrateur » s'affiche sans pouvoir être modifié (section 7).
- Chaque modification est confirmée, puis journalisée (section 7).

### 5.2 Aperçu « ce que voit ce compte »

- On choisit un compte, ou un rôle. L'écran affiche ses menus, puis, domaine par domaine, ce qu'il peut lire et faire et sur quel périmètre, et s'il voit les montants.
- Exemple : « Chantiers : les siens (3 en cours) ; montants sans rentabilité ».
- L'aperçu est **calculé par le serveur**, avec le même moteur que les routes, jamais recalculé par l'écran.
- Il peut aussi servir avant d'enregistrer une modification de rôle : « ce compte gagnerait… perdrait… ».

## 6. Migration

### 6.1 Principe

Chaque type de compte actuel devient un rôle prédéfini au comportement **strictement identique**. La preuve en est donnée **rôle par rôle**, par des tests de non-régression :

1. **Avant tout changement**, on enregistre une matrice de référence en exécutant l'API actuelle. Pour chacun des dix types et pour chaque route, sur des données couvrant chaque périmètre (ses dossiers, son équipe, hors périmètre, affaire annulée, client désactivé), elle note :
   - le code de réponse ;
   - les champs de montant présents ou masqués ;
   - les éléments visibles d'une liste.
2. La matrice devient un test : le même scénario rejoué sur le nouveau moteur doit donner **exactement** la même matrice. Le script de liste des routes du chantier 2 (`server/scripts/routes.mjs`) en fournit la colonne des routes.
3. Les routes passent ensuite au moteur domaine par domaine, la matrice restant verte à chaque PR.

Aucune donnée réelle n'existe (règle 4) : la migration des comptes se limite à associer chaque type à son rôle. Les permissions individuelles enregistrées n'ont pas à être reprises.

### 6.2 Moteur côté serveur

- **Données** : `Role` (nom, rôle système ou non, modèle d'origine) et `RolePermission` (rôle, permission, périmètre). `User.role` devient une référence à un rôle.
- **Lecture** : le rôle et ses permissions sont lus avec le compte à chaque requête, comme aujourd'hui dans `requireAuth`. Un changement de rôle prend donc effet à la requête suivante.
- **Deux fonctions** remplacent les gardes et les tests dispersés :
  - `autorise(requete, permission)` ;
  - `perimetre(requete, domaine)`, qui renvoie le filtre de base de données.

  Les fonctions de montants (`voitRentabilite`…) s'appuient sur les mêmes permissions.
- **Clés d'intégration** : elles gardent leurs scopes, qui deviennent les mêmes permissions, toujours sur toute l'entreprise.

## 7. Ce qui reste dans le code, et pourquoi

### 7.1 Invariants

| Invariant | Raison |
|---|---|
| Au moins un super administrateur **actif** ; son rôle ne se modifie ni ne se supprime, et a toujours tout | Sinon personne ne peut plus administrer l'instance. La règle actuelle compte les comptes désactivés et se vérifie hors transaction : #178. |
| Seul un super administrateur gère les comptes super administrateur, les rôles et les clés d'intégration | Sinon un administrateur pourrait s'élever lui-même (question 2). |
| Pas d'élévation : on ne donne pas un rôle plus large que le sien, et on ne modifie pas son propre rôle | Même raison. Aujourd'hui, le changement de son propre type de compte n'est pas refusé. |
| Chaque changement de rôle, de permission ou d'attribution est journalisé dans la même transaction, en ajout seul, avec la visibilité actuelle (entrées concernant un super administrateur fermées à un simple administrateur) | Décision du 13-10-2026 (#133) et règle 2. |
| Les documents d'argent émis sont immuables (factures et avoirs émis, devis signés, règlements, écritures), quelle que soit la permission | Obligation légale et d'intégrité. Lacunes en base : #180. |
| La numérotation des factures reste continue et chronologique | Obligation légale. |
| Le rôle et le statut actif sont relus en base à chaque requête | Un retrait de droit prend effet tout de suite. |
| Les permissions s'appliquent côté serveur ; l'écran ne fait qu'afficher | Une règle d'écran n'est pas une sécurité (`MODELE-DROITS-COMPTES.md`). |
| Un module désactivé est fermé à tous sauf au super administrateur | Réglage de la société, distinct des droits. |
| Les clés d'intégration ne signent pas de devis et n'accèdent ni aux comptes ni aux droits | La signature engage une personne. |

### 7.2 Exceptions actuelles : permission ou invariant

| Exception actuelle | Proposition |
|---|---|
| Un technicien garde le client, le site et le contact d'une intervention qui lui est affectée, même désactivés | **Invariant justifié**, étendu à tout rôle : un dossier accessible montre toujours son client, sinon il ne peut pas être traité. |
| Un technicien ne reçoit jamais devis, montants ni accès financier, même individuellement | **Propriété du rôle « Technicien »** : il n'a pas ces permissions. Question 3 : faut-il en plus un garde-fou qui empêche de les ajouter à un rôle de technicien ? |
| Le directeur clôture tout chantier en cours, sans le rouvrir | Permission « Chantiers : clôturer » sur toute l'entreprise, sans « rouvrir ». |
| Le responsable clôture les chantiers des seuls techniciens de sa branche | Permission « clôturer » sur « son équipe ». Au premier lot, le périmètre garde la restriction actuelle aux techniciens ; son élargissement est à décider. |
| Le conducteur ne clôture pas le chantier d'un technicien dont il est le N+1 | Conséquence du périmètre « ses dossiers ». |
| Destinataires de la rentabilité (réglages `rentabiliteConducteur`, `rentabiliteHierarchie`, `rentabiliteDirecteurs`) | Permission « Chantiers : voir la rentabilité », avec son périmètre ; les trois réglages disparaissent dans la matrice. |
| Taux horaires et coût de main-d'œuvre réservés aux administrateurs | Permission « Chantiers : voir le coût de main-d'œuvre et les taux ». |
| Prix d'achat des devis et du catalogue réservés aux administrateurs | Permission « Devis : voir et saisir les prix d'achat ». |
| Administrateur « aussi commercial » (`estCommercial`) | Reste un **attribut du compte** (il porte des affaires) et non un rôle, puisqu'il s'ajoute à n'importe quel rôle. |
| Le commercial voit la marge de chaque chantier dans ses statistiques | Permission « Commissions : voir le détail par chantier », à trancher avec la question du lot (d) (passation, section 3). |
| Création d'une intervention réservée à l'administration et au conducteur | Permission « Interventions : créer ». |
| Saisie des heures SAV réservée au technicien affecté | Permission « Interventions : saisir ses heures », sur « ses dossiers ». |
| Champs d'ouverture d'un chantier (titulaire, commercial) réservés à l'administration à la conversion | Permission « Chantiers : réattribuer », sur toute l'entreprise. |
| Le super administrateur garde le planning quand le module est désactivé | Invariant des modules (7.1). |
| Les clés d'intégration voient les taux et les clients désactivés | Scopes ; à aligner sur les choix par défaut de la passation, section 4, encore « à appliquer ». |

## 8. Lots proposés et placement par rapport au pilote

| Lot | Contenu | Placement proposé |
|---|---|---|
| **D0** | Défauts actuels de la règle 2 : dernier super administrateur (#178) ; directeur commercial, assistante et comptable dans le planning et les référentiels (#179, décision de Nelson) ; lignes de facture figées en base (#180) ; réattributions et encaissement journalisés (#181) | **Avant le premier jour du pilote**, après le découpage du serveur |
| **D1** | Moteur (`autorise`, `perimetre`), tables `Role` et `RolePermission`, dix rôles prédéfinis identiques, matrice de non-régression enregistrée puis rejouée. Aucune route ne change encore. | Après le pilote, sauf si l'organisation de l'entreprise pilote ne tient pas dans les dix types actuels (question 5) |
| **D2** | Bascule des routes sur le moteur, un ou deux domaines par PR, matrice verte à chaque fois ; l'écran lit les permissions effectives au lieu des types de compte | Après D1 |
| **D3** | Écran : tableau rôles × permissions, créer, dupliquer, renommer, supprimer ; aperçu « ce que voit ce compte » ; journal | Après D2 |
| **D4** | Modèles TPE et PME, appliqués depuis l'assistant de démarrage du paramétrage (proposition `PARAMETRAGE-CIBLE.md`) | Avec l'assistant |

Chaque lot est une PR ou une petite série de PR, avec ses tests réels sur PostgreSQL et dans le navigateur.

## 9. Questions pour Nelson

1. **Un rôle par compte**, sans permission individuelle ? Une exception passerait alors par un rôle dupliqué. Sinon, faut-il garder des ajouts individuels, au prix d'une matrice moins lisible ?
2. **Qui modifie les rôles ?** Proposition : le super administrateur seulement, comme les permissions individuelles aujourd'hui. Un administrateur attribue les rôles existants, sauf celui de super administrateur.
3. **Garde-fou du technicien** : faut-il garder une interdiction absolue (jamais de devis ni de montants pour un rôle marqué « technicien »), ou laisser chaque entreprise composer son rôle ?
4. **Rôles prédéfinis** : modifiables, avec un retour au modèle d'origine, ou verrouillés, à dupliquer pour les ajuster ?
5. **Placement** : D1 à D4 après le pilote, et D0 avant ? L'entreprise pilote a-t-elle une organisation que les dix types actuels ne couvrent pas ?
6. **Écarts actuels** (annexe, section D) : faut-il les reproduire tels quels dans les rôles prédéfinis, ou les corriger avant la migration (D0) ? En particulier :
   - le périmètre des devis et des clients ;
   - les écritures du responsable sur sa branche ;
   - la définition du titulaire.
