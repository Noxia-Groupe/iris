# Modèle de droits cible : proposition

> **Proposition du 17-10-2026, arbitrée le 18-10-2026 par délégation de Nelson** (chantier technique 3). Nelson a délégué ce jour-là les arbitrages des questions ouvertes ; ils sont consignés en section 10 et priment sur le texte de la proposition là où il différait. La proposition est validée par sa fusion le 20-10-2026 (#182), faite par Claude Code selon la décision de Nelson du même jour, « C’est toi qui fusionne TOUTES les PR » ([CLAUDE.md](../CLAUDE.md#mode-de-livraison)). Le modèle cible (lots D1 à D4) n'est pas implémenté : chaque lot (section 9) fait sa PR. Le lot D0 est implémenté, non validé pour mise en service : #178, #179, #180 et #181 sont corrigés (#216, #282, #217, #283). C'est un parcours de droits : exigence maximale (règle 2 de la méthode).
>
> L'état décidé des droits est décrit par [`MODELE-DROITS-COMPTES.md`](MODELE-DROITS-COMPTES.md) et par l'[historique des décisions](HISTORIQUE-DECISIONS.md). L'inventaire détaillé du code, règle par règle, avec ses références `fichier:ligne` au commit `84e27a1`, est en annexe : [`MODELE-DROITS-INVENTAIRE.md`](MODELE-DROITS-INVENTAIRE.md).

## 1. Le besoin

Nelson, le 17-10-2026 : « Le modèle actuel est robuste, mais il est figé dans le code et trop complexe à paramétrer. Il doit convenir aussi bien à une TPE de 10 personnes qu'à une entreprise de 75, et permettre d'ajouter un niveau de droits sans développement. »

Ce que montre l'inventaire :
- **Dix types de compte figés dans le code.** Leurs droits sont répartis entre :
  - des permissions (`devis:read`…) ;
  - des gardes de type de compte (`requireAdmin`, `blockCommercial`, `blockTechnicien`…) ;
  - plusieurs dizaines de tests écrits dans le corps des routes ;
  - trois réglages de la société (les destinataires de la rentabilité).

  Ajouter un niveau demande du code à tous ces endroits.
- **Des permissions sans effet.** `finances:read`, `clients:write`, `catalogue:*`, `equipements:*` et `company:read` s'accordent à une personne sans rien lui ouvrir. La case « Finance » non plus.
- **Des périmètres qui varient selon l'action et le type de compte**, à l'intérieur d'un même domaine. Le titulaire d'un chantier a cinq définitions (liste, fiche, modification, saisies, clôture). Devis et clients n'ont aucun périmètre.
- **Des écarts entre la documentation et le code.** Directeur commercial, assistante commerciale et comptable ne font pas ce que décrit `MODELE-DROITS-COMPTES.md`. Ils écrivent par ailleurs dans le planning et les référentiels (#179, corrigé par #282).
- **L'écran raisonne autrement que le serveur.** Il teste souvent des types de compte là où le serveur teste une permission ou un périmètre. Il est donc parfois plus restrictif que l'API (annexe, B5).

## 2. Inventaire des règles actuelles (résumé)

Le détail est dans l'[annexe](MODELE-DROITS-INVENTAIRE.md) : chaque route, ses gardes et les types qu'elle admet. Les sections sont A1 à A8 pour le serveur, B pour l'écran, C pour la matrice et D pour les écarts. Le découpage du serveur (chantier 2) déplace les lignes citées, mais garde les noms des fonctions.

| Famille de règles | Où dans le code (fonctions) | Types concernés |
|---|---|---|
| Types de compte | `ROLE_*`, `ALLOWED_ROLES`, `isAdminRole`, `isSuperAdminRole` | les 10 |
| Permissions par défaut et individuelles | `DEFAULT_USER_PERMISSIONS`, `permissionsEffectives`, `requirePermission`, `PUT /api/users/:id/permissions` | tous ; le super administrateur les a toutes |
| Interdits du technicien | `DROITS_INTERDITS_TECHNICIEN` | technicien |
| Gardes de type de compte | `requireAdmin`, `requireSuperAdmin`, `blockCommercial`, `blockCommercialEtAssimiles` (depuis #282), `blockCommercialSeulement`, `blockTechnicien`, `requireTravauxRead`, garde en ligne de `POST /api/interventions` | selon la garde |
| Périmètres de lecture | `perimetreDemandeur`, `perimetreChantiers`, `getInterventionFilterForUser`, `brancheHierarchique`, contrôle `isOwner` de la fiche chantier | tous ; « autres » pour DC, AC, CPT et technicien (annexe, A4) |
| Écriture et clôture | `assertChantierWritable`, `peutCloturerChantier`, contrôles du titulaire dans `PATCH /api/chantiers/:id` | conducteur, responsable, directeur, titulaires |
| Montants | `voitRentabilite` (et les réglages `rentabiliteConducteur`, `rentabiliteHierarchie`, `rentabiliteDirecteurs`), `voitMontantsChantier`, `voitCoutMainOeuvre`, `voitPrixAchatDevis`, `ecritPrixAchatDevis`, `saisieSelonDroits` | tous |
| Administration des comptes | `refuseSuperAdminTarget`, `estDernierSuperAdminActif` (qui remplace `isLastSuperAdmin` depuis #216), `journaliserDroitsCompte`, `entreesVisiblesJournal` | administrateurs |
| Modules | `requirePlanningActif` | tous sauf le super administrateur |
| Clés d'intégration | `API_SCOPES`, `requireApiKey`, `routeMixte` | clés |
| Écran | `client/src/lib/droits.ts`, `menu.ts`, `App.tsx` (`PrivateRoute`), écrans | tous |

## 3. Modèle cible

### 3.1 Permissions élémentaires

Une permission = **un domaine et une action**, écrite en langage clair. Une seule liste sert au serveur, à l'écran et aux clés d'intégration. Le catalogue ci-dessous couvre tout ce que le code fait aujourd'hui. Chaque permission porte un identifiant stable, utilisé dans la table des rôles prédéfinis (section 4).

| Domaine | Identifiant | Permission |
|---|---|---|
| Clients | `clients.consulter` | Consulter l'annuaire (clients, contacts, sites) et l'historique d'un client |
| | `clients.desactives` | Voir aussi les clients désactivés dans l'annuaire |
| | `clients.gerer` | Créer, modifier et désactiver clients, contacts et sites |
| Parc d'équipements | `parc.consulter` | Consulter le parc d'un client |
| | `parc.gerer` | Créer, modifier et archiver un équipement |
| Catalogue | `catalogue.consulter` | Ouvrir le catalogue |
| | `catalogue.gerer` | Créer, modifier et désactiver une fiche |
| Prix d'achat | `prixAchat.voir` | Voir les prix d'achat (catalogue, parc, devis) |
| | `prixAchat.saisir` | Saisir le prix d'achat prévu d'une ligne de devis |
| Devis | `devis.consulter` | Consulter les devis |
| | `devis.modifier` | Créer, modifier, réviser, dupliquer un devis et changer son statut. Cette permission ouvre aussi la recherche des fiches actives du catalogue. |
| | `devis.signer` | Enregistrer l'accord du client |
| | `devis.convertir` | Convertir un devis signé |
| | `devis.ouvrirChantier` | Choisir le titulaire, le commercial, les types et la date de début lors de la conversion |
| | `devis.acompte` | Constater l'acompte |
| | `devis.annuler` | Annuler un devis, et ce qu'il a créé : le chantier, le contrat de maintenance et ses visites non réalisées, l'intervention (lot 4 suite) |
| Chantiers | `chantiers.consulter` | Consulter la liste, la fiche et le journal d'un chantier |
| | `chantiers.modifier` | Modifier la fiche (nom, référence, budgets, dates, adresse, types, barème réduit) |
| | `chantiers.reattribuer` | Changer le titulaire ou le commercial d'un chantier existant |
| | `chantiers.client` | Changer le client d'un chantier |
| | `chantiers.cloturer` | Clôturer un chantier en cours |
| | `chantiers.rouvrir` | Rouvrir un chantier clôturé |
| | `chantiers.encaisser` | Cocher la case « Encaissé » |
| Montants des chantiers | `montants.voir` | Voir les budgets par poste, les coûts sans taux et les alertes de dépassement |
| | `rentabilite.voir` | Voir le montant vendu, les marges et les alertes de perte et de marge faible |
| | `mainOeuvre.voir` | Voir les taux horaires et le coût de main-d'œuvre |
| Saisies Travaux | `saisies.consulter` | Consulter les journaux des achats et des heures |
| | `saisies.saisir` | Saisir et corriger achats et heures |
| | `saisies.archiver` | Archiver et restaurer une saisie |
| | `saisies.apresCloture` | Saisir sur un chantier clôturé |
| Référentiels | `referentiels.gerer` | Gérer les catégories d'achats et les fournisseurs |
| | `intervenants.gerer` | Gérer les fiches intervenant et leurs taux |
| | `intervenants.relierCompte` | Relier un compte à une fiche intervenant |
| Interventions SAV | `interventions.consulter` | Consulter les interventions |
| | `interventions.creer` | Créer une intervention |
| | `interventions.demarrerTerminer` | Démarrer et terminer une intervention |
| | `interventions.statut` | Toutes les transitions, annulation comprise |
| | `interventions.placer` | Placer une intervention au planning |
| | `interventions.compteRendu` | Écrire un compte rendu et enregistrer la signature du client |
| | `interventions.sesHeures` | Saisir ses propres heures |
| | `interventions.couts` | Consulter et gérer les coûts (achats, archivage) |
| | `interventions.journal` | Consulter le journal d'une intervention |
| Contrats de maintenance | `contrats.consulter` | Consulter les contrats |
| | `contrats.gerer` | Créer, modifier, changer le statut, générer les visites, avancer l'échéance |
| Planning | `planning.consulter` | Consulter le planning |
| | `planning.modifier` | Créer, déplacer et supprimer des affectations |
| | `planning.types` | Gérer les types d'événement |
| | `planning.partager` | Gérer le lien public |
| Factures et avoirs | `factures.consulter` | Consulter les factures et le « prêt à facturer » |
| | `factures.preparer` | Préparer un brouillon |
| | `factures.emettre` | Émettre une facture |
| | `factures.avoir` | Annuler une facture et créer un avoir |
| | `mentions.gerer` | Rédiger et publier les mentions légales et les CGV |
| Règlements | `reglements.consulter` | Consulter les règlements |
| | `reglements.saisir` | Saisir un règlement |
| | `reglements.contrepasser` | Contre-passer un règlement |
| Suivi financier | `finances.suivi` | Suivi financier (encaissements, impayés). Réservée aux lots de facturation et de paiements : sans effet tant qu'aucune route ne l'emploie, comme la case « Finance » aujourd'hui (décision 2) |
| Comptabilité | `comptabilite.consulter` | Consulter le plan, les règles et la TVA |
| | `comptabilite.parametrer` | Modifier le plan, les règles et la TVA, importer |
| | `comptabilite.exporter` | Exporter les écritures |
| Statistiques | `stats.tableauDeBord` | Tableau de bord |
| | `stats.conducteurs` | Statistiques par conducteur et assiduité |
| | `stats.travaux` | Statistiques par intervenant, fournisseur et type de chantier |
| | `stats.repartition` | Répartition des chantiers |
| | `stats.commerciales` | Statistiques commerciales |
| Commissions | `commissions.voir` | Voir des commissions |
| | `commissions.detail` | Voir le détail par chantier, marge comprise |
| | `commissions.prime` | Régler la prime de suivi d'un commercial |
| Comptes et droits | `comptes.gerer` | Créer, modifier, désactiver et supprimer des comptes ; rattachement hiérarchique |
| | `roles.gerer` | Créer, modifier, dupliquer, renommer et supprimer des rôles |
| Paramètres | `parametres.metier` | Paramètres métier (marge, acompte, alertes) |
| | `remuneration.consulter` | Consulter les règles de rémunération |
| | `remuneration.modifier` | Modifier les règles de rémunération |
| | `societe.modifier` | Modifier l'identité de la société |
| | `modules.gerer` | Activer ou désactiver des modules |
| | `cles.gerer` | Gérer les clés d'intégration |
| | `registre.consulter` | Interroger le registre des entreprises |
| Journal | `journal.consulter` | Consulter et exporter le journal des paramètres et des droits |
| | `journal.conservation` | Régler la durée de conservation |

La lecture de l'identité de la société, des modules actifs, des listes de commerciaux et de conducteurs, des catégories, des fournisseurs et des intervenants sans leur taux reste ouverte à tout compte connecté, comme aujourd'hui. Toute nouvelle route déclare sa permission, comme le demande déjà `MODELE-DROITS-COMPTES.md`.

Pour une TPE, l'écran regroupe ces permissions en une quinzaine de **groupes** : « Devis », « Chantiers », « Montants », « SAV »… Une case par groupe ; le détail ne s'ouvre qu'à la demande (section 6).

### 3.2 Un périmètre pour chaque permission

Chaque permission accordée porte un périmètre parmi quatre, comme le demande Nelson :

| Périmètre | Sens |
|---|---|
| **Ses dossiers** | ce dont le compte est chargé, par une **relation** au dossier (ci-dessous) |
| **Son équipe** | ses dossiers et ceux de ses collaborateurs **directs** |
| **Sa branche** | ses dossiers et ceux de toute sa branche hiérarchique : collaborateurs directs, puis les leurs, à tous les niveaux |
| **Toute l'entreprise** | sans restriction |

**Équipe et branche.** Aujourd'hui, seul le compte `RESPONSABLE` a un périmètre hiérarchique, et c'est toujours la branche entière (`brancheHierarchique`). Le périmètre « son équipe », limité aux collaborateurs directs, n'existe pas encore. Une agence ou un établissement n'est pas un périmètre hiérarchique : Iris ne connaît aucune de ces notions, et un lot dédié les ajoutera si une société en a besoin (décision 1).

**Relations.** « Ses dossiers » se définit par une ou plusieurs relations, choisies **pour chaque permission** du rôle :
- **chantiers** : titulaire (`responsableId`), commercial (`commercialId`) ;
- **interventions** : intervenant affecté (par sa fiche), créateur, titulaire du chantier lié ;
- **planning** : intervenant affecté à l'événement (`PlanningEvent.intervenants`, par sa fiche), intervention affectée projetée, chantier dont il est titulaire. Pour le technicien, les relations retenues sont l'intervenant affecté à l'événement (#275) et le chantier dont il est titulaire (décision de Nelson du 21-10-2026, #279), sans l'intervention affectée projetée, qui reste soumise au périmètre SAV (note 11) ;
- **devis** : aucune relation n'existe aujourd'hui (le devis n'a ni commercial ni auteur).

« Son équipe » et « sa branche » appliquent les mêmes relations aux collaborateurs concernés.

**Pourquoi pas un périmètre par domaine.** Le code actuel donne à un même compte des périmètres différents selon l'action, dans le même domaine. Par exemple, le commercial voit dans sa liste les chantiers dont il est le commercial, mais sa fiche s'ouvre aussi s'il en est titulaire. Le moteur calcule donc le filtre **par permission**, avec les relations retenues pour elle. La section 4.2 donne les définitions actuelles.

Certaines permissions n'ont qu'un périmètre utile. Le paramétrage, par exemple, porte toujours sur toute l'entreprise : l'écran ne propose alors que « oui » ou « non ».

### 3.3 Des rôles paramétrables

Un **rôle** = un ensemble de permissions. Chacune porte un ou plusieurs couples (périmètre, relations), réunis : le responsable voit par exemple les interventions où il est affecté, **et** celles des chantiers de sa branche. Depuis Administration, on peut :
- **créer** un rôle, vide ou à partir d'un modèle ;
- **dupliquer** un rôle pour l'ajuster ;
- **renommer** un rôle ;
- **supprimer** un rôle qu'aucun compte ne porte. La suppression est refusée en base tant qu'un compte le porte (clé étrangère `RESTRICT`), ce qui exclut une course avec une attribution simultanée.

Chaque compte porte **un rôle**, et peut recevoir en plus des **permissions individuelles, en ajout seulement** : les deux étages de `MODELE-DROITS-COMPTES.md` sont gardés (décision 2, section 10). Une exception se règle donc en cochant un ajout sur le compte, sans dupliquer de rôle ; un rôle dupliqué reste possible pour une exception partagée par plusieurs comptes. Comme aujourd'hui, seul le super administrateur fait un ajout individuel.

### 3.4 Une hiérarchie facultative

Le rattachement hiérarchique existe déjà (`responsableHierarchiqueId`). Il ne sert qu'aux périmètres « son équipe » et « sa branche » :
- une TPE n'en règle aucun, et ces deux périmètres se réduisent alors à « ses dossiers » ;
- une PME relie ses collaborateurs, et chaque rôle choisit, permission par permission, jusqu'où il voit.

C'est une décision d'accès, comme le dit déjà le code : le rattachement reste réservé à un compte qui a `comptes.gerer` sur toute l'entreprise (section 8.1).

### 3.5 Attributs du compte, hors rôle

| Attribut | Aujourd'hui | Proposition |
|---|---|---|
| « Aussi commercial » (`estCommercial`) | réservé aux administrateurs (création, changement de type, route dédiée) ; l'administrateur apparaît alors comme commercial (sélecteurs, commissions, prime) et garde son périmètre | Reste un attribut du compte, **réservé aux rôles système** (administrateur, super administrateur) au premier lot. L'ouvrir à d'autres rôles deviendra un attribut de rôle si une société le demande (décision 7). |
| Fiche intervenant reliée | seul un compte technicien actif se relie ; un compte qui quitte le type technicien perd sa fiche (#166) | Un rôle porte la propriété « peut porter une fiche intervenant ». Changer un compte vers un rôle qui ne l'a pas délie sa fiche, journalisé, comme aujourd'hui. |

## 4. Les dix rôles prédéfinis « Iris actuel »

### 4.1 Table de correspondance

Chaque type de compte actuel devient un rôle prédéfini. La table l'exprime dans le vocabulaire de la section 3.1. C'est la cible de la preuve de non-régression (section 7). Elle décrit le comportement après les corrections du lot D0 (note 7), que la matrice D1a enregistre.

Légende des colonnes :
- SA = super administrateur, AD = administrateur, DIR = directeur, RESP = responsable, CT = conducteur de travaux ;
- COM = commercial, DC = directeur commercial, AC = assistante commerciale, CPT = comptable, TECH = technicien.

Légende des cases :
- **T** : toute l'entreprise ;
- **B** : sa branche ;
- **D** : ses dossiers, avec la relation en indice (ti = titulaire, co = commercial, af = affecté, cr = créateur, cl = titulaire du chantier lié) ;
- **—** : aucun accès ;
- un appel de note (¹, ²…) renvoie à la section 4.2.

| Permission | SA | AD | DIR | RESP | CT | COM | DC | AC | CPT | TECH |
|---|---|---|---|---|---|---|---|---|---|---|
| `clients.consulter` | T | T | — | — | T | T⁹ | T⁹ | T⁹ | T⁹ | T |
| `clients.desactives` | T | T | — | — | T | T | T | T | T | — ¹⁰ |
| `clients.gerer`, `parc.*`, `catalogue.*`, `prixAchat.*` | T | T | — | — | — | — | — | — | — | — |
| `devis.consulter`, `devis.modifier`, `devis.signer`, `devis.convertir` | T | T | — | — | — | T | T | T | T | — |
| `devis.ouvrirChantier`, `devis.acompte`, `devis.annuler` | T | T | — | — | — | — | — | — | — | — |
| `chantiers.consulter` | T | T | T ¹ | B ¹ | D ti ¹ | D co ¹ | D ti ¹ | D ti ¹ | D ti ¹ | D ti |
| `chantiers.modifier`, `chantiers.reattribuer` | T | T | — | D ti | D ti | — | D ti ² | D ti ² | D ti ² | — |
| `chantiers.client`, `chantiers.rouvrir`, `chantiers.encaisser` | T | T | — | — | — | — | — | — | — | — |
| `chantiers.cloturer` | T | T | T | D ti ³ | D ti | — | D ti | D ti | D ti | — |
| `montants.voir` | T | T | T | B | D ti | D co | D ti | D ti | D ti | — |
| `rentabilite.voir` ⁴ | T | T | T ⁴ | D ti ⁴, B ⁴ | D ti ⁴ | — | — | — | — | — |
| `mainOeuvre.voir` | T | T | — | — | — | — | — | — | — | — |
| `saisies.consulter` | T | T | T ⁵ | B | D ti | D co ⁵ | D ti ⁵ | D ti ⁵ | D ti ⁵ | D ti (sans montants) |
| `saisies.saisir` | T | T | — | B | D ti | — | — | — | — | — |
| `saisies.archiver` | T | T | — | B | — ⁶ | — | — | — | — | — |
| `saisies.apresCloture` | T | T | — | — | — | — | — | — | — | — |
| `referentiels.gerer` | T | T | — | T | T | — | — ⁷ | — ⁷ | — ⁷ | — |
| `intervenants.gerer`, `intervenants.relierCompte` | T | T | — | — | — | — | — | — | — | — |
| `interventions.consulter` | T | T | — | D af, B cl ⁸ | D af cr cl | — | D af ⁷ | D af ⁷ | D af ⁷ | D af |
| `interventions.creer` | T | T | — | — | T | — | — | — | — | — |
| `interventions.statut`, `interventions.placer` | T | T | — | D af, B cl | D af cr cl | — | D af ⁷ | D af ⁷ | D af ⁷ | — |
| `interventions.demarrerTerminer` | T ¹⁵ | T ¹⁵ | — | D af, B cl ¹⁵ | D af cr cl ¹⁵ | — | D af ⁷ ¹⁵ | D af ⁷ ¹⁵ | D af ⁷ ¹⁵ | D af |
| `interventions.compteRendu` | T | T | — | D af, B cl | D af cr cl | — | D af ⁷ | D af ⁷ | D af ⁷ | D af ¹⁵ |
| `interventions.sesHeures` | — | — | — | — | — | — | — | — | — | D af |
| `interventions.couts` | T | T | — | — ⁸ | D af cr cl | — | — | — | — | — ¹⁶ |
| `interventions.journal` | T | T | — | D af, B cl | D af cr cl | — | D af ⁷ | D af ⁷ | D af ⁷ | — |
| `contrats.*` | T | T | — | — | — | — | — | — | — | — |
| `planning.consulter` | T | T | — | T ¹¹ | T ¹¹ | — | — ⁷ | — ⁷ | — ⁷ | D af ti ¹¹ |
| `planning.modifier`, `planning.types` | T | T | — | T | T | — | — ⁷ | — ⁷ | — ⁷ | — |
| `planning.partager` | T | T | — | — | — | — | — | — | — | — |
| `factures.*`, `mentions.gerer`, `reglements.*`, `comptabilite.*` | T | T | — | — | — | — | — | — | — | — |
| `finances.suivi` ¹⁷ | T | — | — | — | — | — | — | — | — | — |
| `stats.tableauDeBord` ¹² | T | T | T | B | D ti | D co | D ti | D ti | D ti | D ti |
| `stats.conducteurs` | T | T | — | B | — | — | — | — | — | — |
| `stats.travaux` | T | T | — | B ¹³ | D ti ¹³ | — | — | — | — | — |
| `stats.repartition` | T | T | — | — | — | — | — | — | — | — |
| `stats.commerciales`, `commissions.voir`, `commissions.detail` | T | T | — | — | — | D co | — | — | — | — |
| `commissions.prime`, `parametres.metier`, `remuneration.consulter`, `registre.consulter` | T | T | — | — | — | — | — | — | — | — |
| `comptes.gerer` | T | T ¹⁴ | — | — | — | — | — | — | — | — |
| `roles.gerer`, `remuneration.modifier`, `societe.modifier`, `modules.gerer`, `cles.gerer`, `journal.conservation` | T | — | — | — | — | — | — | — | — | — |
| `journal.consulter` | T | T ¹⁴ | — | — | — | — | — | — | — | — |

### 4.2 Notes : définitions actuelles et règles à reproduire

Ces règles sont celles du code d'aujourd'hui (annexe, A3 à A8). Plusieurs ne tiennent pas dans un modèle à relations simples. Au premier lot (D1), elles sont reproduites telles quelles par des **règles historiques nommées**, rattachées aux rôles prédéfinis et prouvées par la matrice (section 7). Leur harmonisation vient en D2, une règle à la fois (décision 8).

1. **Consultation des chantiers.**
   - **Liste** (`perimetreDemandeur`) : directeur toute l'entreprise ; commercial par `commercialId` ; responsable par titulaire dans sa branche, lui compris ; tous les autres par `responsableId`. Affaires annulées exclues pour tous, administrateurs compris.
   - **Fiche** (`isOwner`) : directeur, commercial **ou** titulaire, quel que soit le type de compte, responsable sur sa branche ; affaire annulée lisible. Un commercial titulaire voit donc la fiche, mais pas le chantier dans sa liste.
   - **Journal d'une affaire annulée** : fermé à tous (#136).
   - **Historique d'un client** (compris dans `clients.consulter`) : il suit le périmètre des chantiers. Un conducteur qui consulte tout l'annuaire n'y voit que ses chantiers.
2. **Modification par le titulaire.** L'API l'admet pour tout titulaire non commercial, non directeur et non technicien ; l'écran ne la propose qu'au conducteur titulaire. Le titulaire peut confier son chantier à tout compte actif (cible en D2 : décision 9) ; depuis la correction de #181, chaque réattribution est journalisée. Le montant vendu ne s'écrit qu'avec `rentabilite.voir`. Le statut et le client envoyés par un non-administrateur sont ignorés en silence.
3. **Clôture par le responsable** : ses propres chantiers, et ceux des **techniciens** de sa branche seulement. Il faut un attribut du rôle du titulaire (« rôle terrain ») pour l'exprimer.
4. **Rentabilité.** Le code croise le type et trois réglages :
   - directeur : si `rentabiliteDirecteurs` ;
   - conducteur ou responsable titulaire : si `rentabiliteConducteur` ;
   - responsable sur les chantiers de sa branche : si `rentabiliteHierarchie`.

   La combinaison « branche oui, ses propres chantiers non » n'est pas exprimable avec des périmètres emboîtés. D1 la reproduit par une règle historique (« branche hors ses dossiers ») ; en D2, le super administrateur tranche à la migration, avec par défaut la variante restrictive (décision 10). Côté clé, la rentabilité exige `finances:read`.
5. **Saisies en lecture.** L'API sert les journaux d'achats et d'heures à tous, dans leur périmètre de chantiers : directeur et commercial compris, sans écran pour eux.
6. **Archivage par le conducteur** : uniquement par permission individuelle aujourd'hui, accordée par le super administrateur. Il le reste, comme ajout individuel de `saisies.archiver` sur ses dossiers (titulaire), le seul périmètre où la case agit aujourd'hui (`assertChantierWritable`, décision 2).
7. **Directeur commercial, assistante commerciale et comptable** franchissaient `blockCommercial` (#179). Depuis sa correction (lot D0), ils sont refusés comme le commercial sur toutes les routes du planning (`/api/planning/…`, lectures comprises) et sur les écritures des référentiels, par la garde `blockCommercialEtAssimiles` ; la table décrit cet état (décision 11). Les routes SAV leur répondent encore, avec un filtre par affectation vide en pratique (aucune fiche intervenant ne peut être reliée à leur compte, #166) : d'où les cases « D af ⁷ », reproduites en D1 et retirées en D2.
8. **SAV du responsable** : interventions où il est affecté, ou dont le chantier lié a pour titulaire un membre de sa branche ou lui-même. Il ne voit pas une intervention sans chantier affectée à un membre de sa branche. Coûts SAV : 403 dans son périmètre.
9. **Annuaire du commercial, du directeur commercial, de l'assistante et du comptable** : l'API le leur sert, mais l'écran le leur ferme (`ROLES_ANNUAIRE`).
10. **Technicien et clients désactivés** : l'annuaire les lui ferme (404 sur la fiche et l'historique, filtre ignoré). L'intervention qui lui est affectée lui montre pourtant client, site et contact (invariant, section 8.2).
11. **Planning en lecture** : les événements sans intervention de toute l'entreprise, les projections d'interventions dans le périmètre SAV, et la liste de **tous** les chantiers, annulés compris. Le directeur commercial, l'assistante et le comptable n'y ont plus accès après D0 (note 7). **Technicien** : Nelson a décidé le 19-10-2026 (#253) que son planning est limité à ce dont il est chargé, dans une PR séparée après le lot pilote 3b, sans attendre D1 ni D2. Depuis cette PR (#275), il lit les affectations où figure sa fiche intervenant (relation « affecté »), événements libres comme projections d'interventions, avec leurs coéquipiers. Le 21-10-2026, Nelson a étendu ce planning aux affectations des chantiers dont il est titulaire (« Des 2 », #279) : il lit aussi, quel que soit l'intervenant, les affectations de catégorie chantier dont le chantier est dans son périmètre de lecture des chantiers, c'est-à-dire dont il est titulaire (relation « titulaire ») ; une affaire annulée en sort (choix par défaut, ci-dessous). L'écran lui montre sa ligne, puis celles des intervenants des affectations qu'il reçoit pour la semaine affichée : intervenants des affectations de ses chantiers, et coéquipiers de ses affectations partagées, même s'il n'est titulaire d'aucun chantier. Sans fiche reliée ni chantier, il ne lit aucune affectation. La liste des chantiers du planning lui est refusée (403), puisqu'il ne crée pas d'affectation ; il garde la lecture des types d'événement. D'où la case « D af ti ¹¹ », qui remplace « T ¹¹ ». Confirmé par Nelson le 21-10-2026 : le lien public inchangé, qui montre tout le planning à qui en a l'adresse (« Lien public a tout le monde disposant de l’adresse. »). Choix par défaut, à confirmer : les coéquipiers visibles ; la liste des chantiers refusée plutôt que réduite ; les types lisibles ; l'affaire annulée qui sort de son planning de titulaire (il y garde les affectations où figure sa fiche) ; la projection d'une intervention rattachée à son chantier, qui reste soumise au périmètre SAV (il ne la lit que s'il y est affecté) ; la ligne d'un collègue ne paraît que les semaines où l'une de ses affectations lui est envoyée, et ne montre que celles-là. La matrice (section 7.1), enregistrée après, reprendra ce comportement. Pour les autres comptes, la liste des chantiers est harmonisée en D2 (décision 8). En écriture, `planning.modifier` sur toute l'entreprise ne vaut que pour les événements libres : une projection d'intervention reste limitée au périmètre SAV.
12. **Tableau de bord** : le contenu varie selon le type.
    - Les achats ne sont envoyés ni au commercial ni au technicien.
    - Les heures ne sont envoyées ni à l'administrateur ni au commercial.
    - Le chiffre d'affaires, la marge et les commissions de la société vont aux administrateurs ; le commercial reçoit sa marge et sa commission.
    - Depuis #272, l'accueil du technicien est « Ma journée » : aucun écran ne lui montre le tableau de bord, que `GET /api/stats/global` lui sert encore. C'est un cas d'écran plus restrictif que le serveur (décision 12).
13. **Statistiques Travaux** : celles des fournisseurs portent sur toute l'entreprise, sans périmètre.
14. **Séparation entre administrateur et super administrateur.** Un administrateur ne voit ni ne gère les comptes super administrateur. Il ne voit pas les entrées de journal qui les concernent, ni celles des clés d'intégration.
15. **Transitions et compte rendu SAV.** `interventions.statut` comprend démarrer et terminer. Le technicien n'a que ces deux transitions. Compte rendu et signature sont ouverts par l'API à tout compte de la ligne `interventions.consulter`. Depuis #268, l'écran les propose aussi à l'encadrement (passation, section 4). Terminer exige un compte rendu, signé ou accompagné d'un motif consigné au journal, pour tous les comptes (décisions de Nelson des 19 et 20-10-2026) : c'est une règle métier, distincte des permissions.
16. **Coûts SAV du technicien** : il lit ses propres heures, sans montant (`GET /api/interventions/:id/couts`), au titre de `interventions.sesHeures`.
17. **Accès financier** : aujourd'hui la case « Finance » (`accesFinance`), que seul le super administrateur coche ; elle n'ouvre rien en session (`peutVoirFinance` n'est employée par aucune route). Elle devient un ajout individuel de `finances.suivi`, sans effet lui aussi (décision 2). Le super administrateur a toutes les permissions.

Correspondance des **clés d'intégration** (portée toujours « toute l'entreprise ») :

| Scope actuel | Permissions |
|---|---|
| `clients:read` | `clients.consulter`, `clients.desactives` |
| `clients:write` | `clients.gerer` |
| `catalogue:read`, `catalogue:write` | `catalogue.consulter`, `catalogue.gerer` |
| `equipements:read`, `equipements:write` | `parc.consulter`, `parc.gerer` |
| `devis:read` | `devis.consulter` |
| `devis:write` | `devis.modifier`, `devis.convertir`, sans `devis.signer` ni `devis.ouvrirChantier` |
| `company:read` | lecture de l'identité de la société |
| `chantiers:read` | `chantiers.consulter`, `saisies.consulter`, `montants.voir`, et **`mainOeuvre.voir`** (passation, section 4 : à retirer aux clés, à appliquer) |
| `chantiers:write`, `chantiers:archive` | aucune route ne les utilise |
| `finances:read` | `rentabilite.voir`, `prixAchat.voir` ; jamais `prixAchat.saisir` |

Cette correspondance vaut pour les clés seulement. Elle ne sert jamais à migrer un droit individuel d'un compte : ceux-ci migrent selon leur effet en session (décision 2).

## 5. Modèles prêts à l'emploi

Ce sont des propositions. Chaque modèle reste modifiable après son application, et aucun n'est imposé. Les noms décrivent une organisation, pour éviter la confusion avec les catégories légales TPE et PME, qui fixent le calendrier de la facturation électronique.

### 5.1 « Petite équipe, sans hiérarchie » (trois rôles)

| Rôle | Contenu proposé |
|---|---|
| **Dirigeant** | rôle système « super administrateur » : tout, sur toute l'entreprise |
| **Bureau** | clients, devis, chantiers, interventions et planning sur toute l'entreprise ; facturation et règlements ; montants et rentabilité ; attribut « peut être titulaire » (décision 9) ; ni rôles, ni clés d'intégration, ni modules |
| **Technicien** | comme le rôle prédéfini Technicien : ses interventions, planning en lecture limité à ses affectations et à celles des chantiers dont il est titulaire (décisions de Nelson du 19 et du 21-10-2026, #275 et #279, note 11), annuaire des clients actifs en lecture, aucun montant |

### 5.2 « Équipe avec hiérarchie »

| Rôle | Contenu proposé |
|---|---|
| **Direction** | tout, sur toute l'entreprise |
| **Administration** | comme le rôle prédéfini Administrateur |
| **Comptabilité** | factures, avoirs, comptabilité, export ; chantiers et devis en lecture ; toute l'entreprise. Les règlements, réservés aujourd'hui à l'administration (choix par défaut de `MODELE-DROITS-COMPTES.md`), font partie de ce modèle : saisir, affecter et contre-passer un règlement est le travail de la comptabilité (décision 14). Le rôle prédéfini Comptable d'« Iris actuel » ne change pas. |
| **Directeur commercial** | devis et affaires de son équipe ou de sa branche ; statistiques commerciales de son équipe |
| **Commercial** | ses affaires ; ses statistiques |
| **Assistante commerciale** | devis de tous les commerciaux ; choix traçable du commercial porteur (décrit par `MODELE-DROITS-COMPTES.md`, non implémenté) |
| **Responsable travaux** | chantiers, saisies, interventions et planning de sa branche ; statistiques Travaux de sa branche |
| **Conducteur de travaux** | ses chantiers, ses saisies, les interventions qu'il crée ou qui le concernent ; planning |
| **Technicien** | comme en petite équipe |

Trois de ces rôles décrivent un comportement qui n'existe pas encore : l'équipe du directeur commercial, les devis rattachés à un commercial, le choix traçable par l'assistante. Le devis n'a pas de commercial aujourd'hui : ces rôles ne s'appliqueront qu'avec le lot qui les rend possibles.

### 5.3 « Iris actuel »

Les dix rôles de la section 4, au comportement strictement identique. C'est le point de départ de la migration.

## 6. L'écran

### 6.1 Tableau rôles × permissions

- **Disposition** : une ligne par permission, groupée par domaine, en langage clair (« Chantiers : voir la rentabilité ») ; une colonne par rôle.
- **Cases** : « — », « Ses dossiers », « Son équipe », « Sa branche » ou « Toute l'entreprise ».
  - Pour « ses dossiers », l'écran précise les relations retenues : « dont il est titulaire », « dont il est le commercial », « où il est affecté »…
  - Une case peut combiner plusieurs périmètres, réunis : par exemple « où il est affecté, et sur sa branche les interventions des chantiers qu'elle porte ».
- **Deux vues** :
  - **groupes** : une quinzaine de cases par rôle, pour une petite équipe (section 3.1) ;
  - **détail** : une case par permission.
- **En-tête de colonne** :
  - le nom du rôle et le nombre de comptes qui le portent ;
  - les commandes dupliquer, renommer, supprimer ;
  - pour un rôle prédéfini, « revenir au modèle d'origine » (décision 13).
- **Rôle « Super administrateur »** : il s'affiche sans pouvoir être modifié (section 8.1).
- **Avertissement des déductions** : accorder une permission qui en révèle une autre par calcul affiche un avertissement, et propose d'accorder les deux (section 8.3).
- **Enregistrement** : chaque modification est confirmée, puis journalisée (section 8.1).

### 6.2 Aperçu « ce que voit ce compte »

- **Contenu** : on choisit un compte, ou un rôle. L'écran affiche ses menus, puis, domaine par domaine, ce qu'il peut lire et faire, sur quel périmètre, et s'il voit les montants. Exemple : « Chantiers : les siens (3 en cours) ; montants sans rentabilité ».
- **Calcul** : l'aperçu est **calculé par le serveur**, avec le même moteur que les routes, jamais recalculé par l'écran.
- **Avant d'enregistrer** une modification de rôle, il montre l'écart : « ces 4 comptes gagneraient… perdraient… ».
- **Séparation** : un administrateur ne prévisualise pas un compte super administrateur (section 8.1).

## 7. Migration et moteur

### 7.1 Matrice de non-régression

Chaque type de compte actuel devient le rôle prédéfini correspondant, au comportement **strictement identique**. La preuve est donnée **rôle par rôle**, par une matrice enregistrée en exécutant l'API **avant** tout changement, puis rejouée sur le nouveau moteur.

**Données couvertes** :
- un chantier de chaque statut, y compris annulé ;
- un titulaire de chaque type ;
- un commercial, et un administrateur « aussi commercial » ;
- une branche de techniciens et une branche de conducteurs ;
- des interventions avec et sans contrat, de chaque statut, annulée comprise, avec et sans projection au planning (dont une sur le jour lu par « Ma journée »), et une fiche intervenant reliée ;
- un compte rendu signé, un compte rendu non signé et une clôture avec motif ;
- des heures du technicien sur une intervention hors contrat ;
- un client actif et un client désactivé ;
- un devis signé et un devis non signé ;
- une facture émise et un brouillon.

**Ce que la matrice enregistre**, pour chaque rôle, chaque route et chaque cas :

| Dimension | Ce qui est comparé |
|---|---|
| Réponse | code HTTP et message d'erreur exacts (404 ou 403, refus explicite du technicien) |
| Données renvoyées | éléments visibles d'une liste ; champs présents ou masqués, montants et autres (`peutCloturer`, rôle du responsable, comptes super administrateur, client désactivé, permissions de `/api/me` et de `/api/users`) |
| État de la base | après chaque écriture : un refus est sans effet ; un champ ignoré en silence (statut ou client envoyé par un non-administrateur) reste inchangé |
| Journaux | entrées écrites, avec leur visibilité pour un administrateur et un super administrateur |
| Réglages | les combinaisons des trois destinataires de la rentabilité, de `margeCommercialeActive` et de `planningActif` |
| Clés d'intégration | chaque scope, seul |
| Écran | parcours E2E rôle par rôle : menus, routes accessibles, boutons proposés |

La colonne des routes vient du script `server/scripts/routes.mjs` du chantier 2 (PR #177, fusionnée).

**Ordre.** La matrice est enregistrée comme un lot de tests seul, juste après les corrections du lot D0 et avant tout lot du moteur (décision 6) ; la section 9 en donne le placement par rapport au pilote. Un lot qui change ensuite volontairement un droit met la matrice à jour dans sa propre PR, l'écart restant visible au diff, comme la liste des routes. Cela vaut pour les choix « à appliquer » de la passation, section 4, pour les décisions de Nelson encore à appliquer (le planning limité du technicien l'a été par #275, puis étendu par #279, avant l'enregistrement de la matrice : note 11), et pour chaque harmonisation de D2.

**Écran.** D2 fait lire à l'écran les permissions effectives au lieu des types de compte. L'écran s'ouvrirait alors partout où il est plus restrictif que le serveur : annuaire du commercial, Performances du responsable, journaux d'achats du directeur. La décision 12 tranche : par défaut, le serveur se restreint à ce que l'écran montre, sauf si un écran que le rôle utilise a besoin de la donnée.

### 7.2 Moteur côté serveur

- **Données** :
  - `Role` : nom ; clé système non renommable pour les rôles système ; modèle d'origine ;
  - `RolePermission` : rôle, permission, périmètre et relations ; plusieurs lignes par permission, réunies ;
  - `User.roleId`, en clé étrangère `RESTRICT`.
- **Lecture** : le rôle et ses permissions sont relus avec le compte à **chaque requête**, comme aujourd'hui dans `requireAuth`. Il n'y a aucun cache des permissions entre deux requêtes, si bien qu'un retrait prend effet à la requête suivante.
- **Deux fonctions** remplacent les gardes et les tests dispersés :
  - `autorise(requete, permission, dossier?)` ;
  - `perimetre(requete, permission)`, qui renvoie le filtre de base de données de **cette permission**, avec ses relations et ses éventuelles règles historiques.

  Les fonctions de montants (`voitRentabilite`…) s'appuient sur les mêmes permissions.
- **Compatibilité** : au premier lot, `/api/me` garde `role` (la clé du rôle prédéfini) et les noms actuels des permissions. L'écran passe aux nouvelles permissions en D2. Les permissions individuelles deviennent les ajouts individuels (décision 2) : `UserPermission` (compte, permission, périmètre), que seul le super administrateur écrit, comme aujourd'hui. Chaque droit individuel migre vers ce qu'il fait aujourd'hui en session, avec le même périmètre, et vers aucune permission s'il est sans effet (décision 2). Il ne passe jamais par la correspondance des clés, où `finances:read` deviendrait `rentabilite.voir`. L'accès financier devient l'ajout de `finances.suivi`, sans effet.
- **Clés d'intégration** : elles gardent leurs scopes, traduits par la correspondance de la section 4.2. `/api/v1` reste limité à ses routes actuelles : une permission comme `devis.modifier`, qui ouvre en session la duplication et la recherche du catalogue, n'ouvre pas ces routes à une clé.

Aucune donnée réelle n'existe (règle 4) : la migration des comptes se limite à associer chaque type à son rôle prédéfini.

## 8. Ce qui reste dans le code, et pourquoi

### 8.1 Invariants

| Invariant | Raison |
|---|---|
| Au moins un super administrateur **actif**. Son rôle, repéré par une clé système non renommable, ne se modifie ni ne se supprime, et a toujours tout. | Sinon personne ne peut plus administrer l'instance. Depuis #216 (#178), les routes de comptes ne comptent que les super administrateurs actifs, et les retraits se sérialisent par un verrou dans leur transaction. |
| L'accès de secours et `SUPERADMIN_EMAILS` visent le rôle système « super administrateur », par sa clé. | Ce sont les seules portes de reprise de l'instance. |
| Seul un super administrateur gère les comptes super administrateur, les rôles et les clés d'intégration (décision 3). | Sinon un administrateur pourrait s'élever lui-même. |
| **Pas d'élévation.** Un compte n'attribue un rôle que s'il est **inclus** dans le sien. Inclus veut dire que chaque couple (permission, périmètre, relations) du rôle attribué est couvert par un couple du sien : même permission, périmètre au moins aussi large (ses dossiers ⊂ son équipe ⊂ sa branche ⊂ toute l'entreprise), relations comprises. Deux rôles incomparables : refus. | Empêcher l'auto-élévation, y compris par un rôle « de côté ». |
| **Ajouts individuels réservés au super administrateur**, comme aujourd'hui (`PUT /api/users/:id/permissions`, `PATCH /api/users/:id/acces-finance`). | Un ajout passe à côté du rôle : c'est une décision de dirigeant, journalisée (décision 2). |
| **Permissions de montant** : une liste unique dans le code, testée (décision 5). Seul le super administrateur les accorde, par un rôle ou par un ajout. Un test classe chaque permission du catalogue dans la liste ou hors d'elle : une permission nouvelle non classée fait échouer la suite. | Aucun montant ne s'ouvre à qui ne le voit pas aujourd'hui sans une décision explicite du super administrateur. |
| **Attribut « sans montants »** d'un rôle, coché sur Technicien : le serveur refuse d'accorder à ce rôle, ou à un compte qui le porte, les permissions de montant, les saisies Travaux et `chantiers.modifier` (décision 4). Seul le super administrateur le décoche, après confirmation, journalisé. | Reprend au moins `DROITS_INTERDITS_TECHNICIEN` (décisions de Nelson du 13-10-2026). |
| **Migration sans gain d'effet.** Avant D1, un test enregistre, pour un compte de chaque type portant chaque droit individuel possible, les cases comme chaque scope seul, ce que ce compte peut lire et faire. Après la migration, le même test doit donner un résultat identique. Les droits individuels ne passent jamais par la correspondance des clés. | Un droit enregistré sans effet, comme `finances:read` sur un compte, ne doit pas en gagner un, par exemple les marges (décision 2). |
| On ne modifie pas son propre rôle. | Même raison. **Changement assumé** : aujourd'hui, le changement de son propre type de compte n'est pas refusé. Il entre au lot D1. |
| Le rattachement hiérarchique est réservé à `comptes.gerer` sur toute l'entreprise. Il est refusé s'il fait entrer un compte dans l'équipe ou la branche du demandeur, sauf si le rôle du demandeur a « toute l'entreprise » partout où il a « son équipe » ou « sa branche ». | Le rattachement élargit l'équipe ou la branche, donc l'accès, de toute la chaîne au-dessus du compte : il ne doit pas servir à s'élargir soi-même. |
| L'aperçu « ce que voit ce compte » respecte la séparation : un administrateur ne prévisualise pas un compte super administrateur. | Même séparation qu'aujourd'hui dans la liste des comptes. |
| Chaque changement de rôle, de permission ou d'attribution est journalisé dans la même transaction, en ajout seul. Une entrée qui concerne un compte super administrateur reste fermée à un simple administrateur ; les autres lui sont visibles, comme les changements de permissions aujourd'hui. Le choix « à appliquer » de la passation (section 4), qui ferme aussi à l'administrateur les entrées **écrites** par un super administrateur, lui fermerait toutes les modifications de rôles. | Décision du 13-10-2026 (#133) et règle 2. |
| Les documents d'argent émis sont immuables (factures et avoirs émis, devis signés, règlements, écritures), quelle que soit la permission. | Obligation légale et d'intégrité. Depuis #217 (#180), les lignes, la ventilation de TVA, la version des mentions et la date d'émission d'une facture émise sont figées en base ; le cycle des statuts et le plafond des avoirs y sont garantis (#227, #235). |
| Les comptes rendus d'intervention et les signatures sont figés en base, quelle que soit la permission (#255, #268). Le figement d'un compte rendu dès son enregistrement, une correction passant par un compte rendu complémentaire, est un choix par défaut de #253, à confirmer (passation, section 4). | Preuve de l'intervention (règle 2). |
| La numérotation des factures reste continue et chronologique. | Obligation légale. |
| Le rôle et le statut actif sont relus en base à chaque requête. | Un retrait de droit prend effet tout de suite. |
| Les permissions s'appliquent côté serveur ; l'écran ne fait qu'afficher. | Une règle d'écran n'est pas une sécurité. |
| Un module désactivé ferme ses routes à tous, sauf au super administrateur ; les créneaux d'une intervention restent lisibles par les routes SAV (choix par défaut de #272, à confirmer). | Réglage de la société, distinct des droits. |
| Une clé d'intégration ne signe pas de devis et n'accède ni aux comptes ni aux droits. | La signature engage une personne. |

### 8.2 Exceptions actuelles : permission ou invariant

| Exception actuelle | Proposition |
|---|---|
| Un technicien garde le client, le site et le contact d'une intervention qui lui est affectée, même désactivés | **Invariant justifié**, étendu à tout rôle : un dossier accessible montre toujours son client, sinon il ne peut pas être traité. |
| L'annuaire ferme les clients désactivés au technicien (404 sur la fiche et l'historique) | Absence de `clients.desactives` dans son rôle. |
| Le technicien ne reçoit jamais devis, montants, saisie Travaux ni accès financier, même individuellement | **Propriété du rôle « Technicien »** : il n'a pas ces permissions, et son attribut « sans montants » empêche de les lui ajouter (décision 4). |
| Refus explicites du technicien (403 et message, et non 404) | Règle historique reproduite par la matrice. |
| Alerte d'heures dépassées retirée au technicien, alors que ce n'est pas un montant | Suit `montants.voir`, comme les autres alertes de dépassement. |
| Le directeur clôture tout chantier en cours, sans le rouvrir | `chantiers.cloturer` sur toute l'entreprise, sans `chantiers.rouvrir`. |
| La saisie Travaux du directeur ne s'ouvre pas par permission (`assertChantierWritable` teste le type) | Son rôle n'a pas `saisies.saisir`, et la saisie lui reste fermée (décision 8). |
| Le responsable clôture les chantiers des seuls techniciens de sa branche | Règle historique (note 3). Elle demande l'attribut « rôle terrain » du titulaire. |
| Le conducteur ne clôture pas le chantier d'un technicien dont il est le N+1 | Conséquence du périmètre « ses dossiers ». |
| Destinataires de la rentabilité (trois réglages) | `rentabilite.voir`, avec son périmètre (note 4). Le réglage passe de l'administrateur (`PUT /api/parametres`) à la matrice des rôles, que seul le super administrateur modifie (décision 3). La combinaison « branche oui, propres non » : règle historique en D1, choix du super administrateur à la migration en D2 (décision 10). |
| Taux horaires et coût de main-d'œuvre réservés aux administrateurs (décisions du 13, 14 et 16-10-2026) | `mainOeuvre.voir`, que seul le super administrateur accorde (décision 5). |
| Prix d'achat lisibles et saisissables par les seuls administrateurs ; une clé les lit sans jamais les écrire | `prixAchat.voir` et `prixAchat.saisir`, séparés. |
| Administrateur « aussi commercial » | Attribut du compte réservé aux rôles système (section 3.5). |
| Le commercial voit la marge de chaque chantier dans ses statistiques | `commissions.detail`, à trancher avec la question du lot (d) (passation, section 3). |
| Création d'une intervention réservée à l'administration et au conducteur, sans contrôle du périmètre du chantier | `interventions.creer`. Le contrôle du périmètre est un choix « à appliquer » (passation, section 4). |
| Saisie des heures SAV réservée au technicien affecté | `interventions.sesHeures`, sur « ses dossiers ». |
| Champs d'ouverture d'un chantier réservés à l'administration à la conversion | `devis.ouvrirChantier`, distinct de `chantiers.reattribuer`. |
| Conversion d'un devis en intervention ou en contrat (lot pilote 4) : droit devis et droit de création de la cible, en session seulement | `devis.convertir` avec `interventions.creer` pour l'intervention ; avec `contrats.gerer`, réservée à l'administration, pour le contrat. Aucune clé ne crée l'un ou l'autre. Pour l'intervention, le commercial et le directeur porteurs du droit devis reçoivent 403 « Création réservée à l’encadrement SAV. », et non le message de `blockCommercial` de la création directe (« Accès non autorisé pour un compte commercial. », « … directeur. ») ; les autres porteurs du droit devis hors de l'encadrement SAV (assistante commerciale, comptable et directeur commercial, qui l'ont par défaut) reçoivent le même message par les deux chemins. Sans le droit devis, la conversion répond d'abord 403 « Permission requise : devis:write ». Même code, message différent, que la matrice D1a enregistre tel quel (note de l'audit de #281). |
| Annulation d'un devis (lot 4 suite), réservée à l'administration : elle annule aussi le contrat de maintenance, ses visites non réalisées et l'intervention que le devis a créés, avec ses suites depuis #341 | `devis.annuler` (section 3.1). Sort des visites non réalisées : choix par défaut, à confirmer (passation, section 4). Question pour D1 : faut-il exiger aussi `contrats.gerer` et `interventions.statut` (annulation d'une intervention), pour qu'un rôle ne puisse pas annuler par le devis ce qu'il ne peut pas annuler directement ? |
| Coûts d'une suite rattachée à une affaire, et de l'intervention du devis rattachée au chantier que ce devis a ouvert (#341, #344) : refus pour tous sur une affaire annulée, hors administration sur une affaire clôturée ; aucune suite créée sur une affaire clôturée ou annulée, administration comprise | Ces coûts entrent dans la marge du chantier : leur saisie suit celle du chantier, `saisies.apresCloture` sur une affaire clôturée, une affaire annulée restant fermée à tous par règle métier. Le refus de créer une suite sur une affaire clôturée, administration comprise, est un choix par défaut, à confirmer (passation, section 4) : en D1, le reproduire tel quel ou l'ouvrir avec `saisies.apresCloture`, à trancher. |
| Ouverture du chantier d'un devis qui a déjà créé son intervention (#344) : droit devis et droit de création de l'intervention (encadrement SAV), en session | `devis.convertir` avec `interventions.creer`, comme la conversion en intervention : l'ouverture rattache au chantier l'intervention et ses suites, avec une écriture au journal SAV. Aucune clé ne l'ouvre. Choix par défaut, à confirmer, le plus restrictif (passation, section 4) ; le directeur le recevra avec le lot « Directeur aligné sur l'administration » (#345). |
| Génération automatique des visites de maintenance (lot pilote 5) : réglage, état et passage manuel réservés à l'administration ; passage quotidien au nom du compte système | `parametres.metier` pour le réglage (`PUT /api/parametres`) ; `contrats.*` pour l'état et le passage manuel. Le passage quotidien agit au nom d'un compte système (décision de Nelson du 22-10-2026), nommé « Iris (automatique) » (choix par défaut, à confirmer, passation section 4) : un compte sans permission, qui ne se connecte jamais et que la gestion des comptes ne montre pas ; toute nouvelle écriture du journal SAV désigne un compte. Le type `SYSTEME` est hors des dix rôles : les tables de rôles de D1 devront le traiter à part et exclure sa ligne de toute mise à jour (déclencheur `compte_systeme_fige`). |
| Fiche intervenant reliée seulement à un technicien actif, perdue en quittant ce type | Propriété du rôle « peut porter une fiche intervenant » (section 3.5). |
| Éligibilité au titulariat : le serveur accepte tout compte actif, l'écran ne propose que des conducteurs | Règle actuelle reproduite en D1 ; attribut de rôle « peut être titulaire » en D2 (décision 9). #181 journalise les réattributions dès D0. |
| Le super administrateur garde le planning quand le module est désactivé | Invariant des modules (8.1). |
| Accès de secours et `SUPERADMIN_EMAILS` | Invariants (8.1). |
| Les clés d'intégration voient les taux et les clients désactivés | Correspondance des scopes (section 4.2), à aligner sur les choix « à appliquer » de la passation, section 4. |

### 8.3 Montants : ce qui se déduit d'autre chose

Certaines permissions redonnent une information réservée par une autre, par simple calcul. Les cas sont déjà relevés par `MODELE-DROITS-COMPTES.md` :
- les budgets par poste (`montants.voir`) redonnent le montant vendu, donc la marge (`rentabilite.voir`) ;
- la rentabilité, avec les montants, redonne le coût de main-d'œuvre (`mainOeuvre.voir`) ;
- le prix d'achat du catalogue redonne celui du devis ;
- le détail des commissions par chantier redonne la marge.

L'écran des rôles **avertit** quand une permission en révèle une autre par déduction, et propose de les accorder ensemble. Pas de plancher figé dans le code (décision 5) : en contrepartie, seul le super administrateur peut accorder une permission de la liste des montants, tenue dans le code, par un rôle ou un ajout individuel, et chaque octroi est journalisé.

## 9. Lots proposés et placement par rapport au pilote

| Lot | Contenu | Placement proposé |
|---|---|---|
| **D0** | Défauts de la règle 2 relevés par l'inventaire, une PR chacun : dernier super administrateur (#178, corrigé par #216) ; lignes et mentions de facture figées en base (#180, corrigé par #217) ; réattributions et encaissement journalisés (#181, corrigé par #283) ; directeur commercial, assistante et comptable refusés comme le commercial sur le planning et les écritures des référentiels (#179, décision 11, corrigé par #282) | Avant la fin du pilote, chacun dans sa PR (décision de Nelson du 21-10-2026, qui tranche la règle du pilote du 19-10-2026 pour #179 et #181). #178, #179, #180 et #181 sont corrigés (#216, #282, #217, #283) |
| **D1a** | Matrice de non-régression enregistrée sur le code actuel, en tests seuls (section 7.1) | Après D0 : elle enregistre le comportement corrigé (section 4.1) et protège les lots suivants. #179 et #181 passant avant la fin du pilote (décision de Nelson du 21-10-2026), D1a suit leur correction, après les lots pilotes 4 à 6 (ordre retenu par Claude Code, passation). Dans l'exception de D1, D1a, et donc #179 et #181, précèdent D1 et passent avant le premier jour |
| **D1** | Moteur (`autorise`, `perimetre` par permission, règles historiques), tables `Role` et `RolePermission`, dix rôles prédéfinis identiques, droits individuels migrés selon leur effet en session, sans gain (décision 2), refus de modifier son propre rôle (changement assumé). Aucune autre route ne change de comportement. | Après le premier jour du pilote (décision 6). Exception : si l'organisation de l'entreprise pilote ne tient pas dans les dix types actuels, D1, D2 et D3 avancent avant ce premier jour |
| **D2** | Bascule des routes sur le moteur, un ou deux domaines par PR, matrice verte à chaque fois ; l'écran lit les permissions effectives (section 7.1, Écran) | Après D1 |
| **D3** | Écran : tableau rôles × permissions, en groupes ou en détail ; créer, dupliquer, renommer, supprimer ; avertissement des déductions ; aperçu « ce que voit ce compte » ; journal | Après D2 (voir D1 pour l'exception) |
| **D4** | Modèles « petite équipe » et « équipe avec hiérarchie », appliqués depuis l'assistant de démarrage du paramétrage (proposition [`PARAMETRAGE-CIBLE.md`](PARAMETRAGE-CIBLE.md)) | Avec l'assistant |

Chaque lot est une PR ou une petite série de PR, avec ses tests réels sur PostgreSQL et dans le navigateur.

## 10. Décisions sur les questions ouvertes (arbitrées le 18-10-2026 par délégation)

Nelson a délégué ces arbitrages le 18-10-2026 : « Prend la meilleur decision possible comme tu comprend parfaitement ce que doit faire cette application alors prend le meilleur choix pour le bien de l'application pour cette partie et la facilité de l'utilisation en gardant la flexibilité. » Ce sont des arbitrages faits par délégation. La fusion de la proposition vaut sa validation ; elle revient à Claude Code (décision de Nelson du 20-10-2026, [CLAUDE.md](../CLAUDE.md#mode-de-livraison)).

Critères retenus :
- simple pour une petite équipe, et flexible pour une plus grande ;
- aucune garde de sécurité affaiblie ;
- aucun montant rendu visible à qui ne le voit pas aujourd'hui sans un réglage explicite du super administrateur ;
- en D1, un comportement strictement identique, prouvé par la matrice ; les changements voulus viennent en D0 (défauts) ou en D2 (harmonisation), chacun dans sa PR.

La numérotation reprend celle des anciennes questions ; les sections précédentes y renvoient par « décision N ». La décision 14 tranche un point que le texte laissait ouvert (section 5.2).

1. **Équipe et branche.** « Son équipe » désigne les collaborateurs directs. « Sa branche » désigne tous les niveaux, comme pour le responsable aujourd'hui. Une agence ou un établissement n'est pas un périmètre hiérarchique : si une société en a besoin, un lot dédié ajoutera cette notion ([`PARAMETRAGE-CIBLE.md`](PARAMETRAGE-CIBLE.md), section 4.4).
2. **Un rôle par compte, avec des ajouts individuels.** Les deux étages de `MODELE-DROITS-COMPTES.md` sont gardés : un rôle, plus des permissions individuelles **en ajout seulement**, sans retrait individuel.
   - Raisons : une petite équipe coche une case au lieu de dupliquer un rôle.
   - Les droits individuels enregistrés migrent sans multiplier les rôles. Chacun migre vers **ce qu'il fait aujourd'hui en session, avec le même périmètre, ni plus ni moins** (vérifié sur `main` `4ad324b`) :
     - **droit devis** : la case enregistre `DROITS_DEVIS`, soit `devis:read`, `devis:write` et `clients:read`. Elle migre vers `devis.consulter`, `devis.modifier`, `devis.signer`, `devis.convertir` et `clients.consulter`, avec `clients.desactives` (que le technicien n'a pas), sans quoi le compte perdrait le choix du client dans un devis. Un de ces droits enregistré seul migre seul, vers sa part de cette liste ;
     - **corriger Travaux** (`chantiers:write`) et **archiver Travaux** (`chantiers:archive`) : ces cases n'agissent que si `assertChantierWritable` admet le compte, c'est-à-dire administrateur, conducteur titulaire ou responsable sur sa branche. Elles migrent vers `saisies.saisir` et `saisies.archiver` là où la case agit aujourd'hui, avec le même périmètre : par exemple l'archivage accordé à un conducteur, sur ses dossiers (titulaire, note 6). Ailleurs, elles ne migrent vers aucune permission : un commercial, un comptable ou un directeur coché ne gagne aucune saisie ;
     - **accès financier** (`accesFinance`) : `finances.suivi`, sans effet comme aujourd'hui (note 17) ;
     - **tous les autres droits individuels**, que `PUT /api/users/:id/permissions` accepte puisqu'il admet tout scope d'`API_SCOPES` : `finances:read`, `clients:write`, `catalogue:*`, `equipements:*`, `company:read`, `chantiers:read`. Ils n'ont aucun effet en session aujourd'hui, pour trois raisons. Les routes de session de ces domaines gardent `requireAdmin` (garde par défaut de `routeMixte`). La rentabilité ne lit `finances:read` que pour une clé (`voitRentabilite`). Enfin, l'identité de la société et `chantiers:read` sont déjà ouverts à tous les types de compte. Ces droits ne migrent donc vers aucune permission.
   - **Jamais par la correspondance des clés.** Un droit individuel ne passe jamais par la table de correspondance des clés d'intégration (section 4.2). Par elle, `finances:read` deviendrait `rentabilite.voir` et `prixAchat.voir`, et ouvrirait les marges et les prix d'achat.
   - Un test de la migration le garantit (section 8.1) : aucune case ni aucun droit individuel ne gagne d'effet à la migration.
   - **Seul le super administrateur fait un ajout**, comme aujourd'hui : `PUT /api/users/:id/permissions` et `PATCH /api/users/:id/acces-finance` lui sont réservés. Si un lot ouvrait un jour les ajouts à l'administrateur, il suivrait la règle « pas d'élévation » (on n'ajoute qu'une permission que l'on a soi-même, sur un périmètre au plus égal) et exclurait toujours la liste des montants (décision 5).
   - Un ajout est journalisé dans la même transaction. La liste des comptes et l'aperçu « ce que voit ce compte » le montrent (« Conducteur + 1 ajout »).
3. **Qui modifie les rôles : le super administrateur seul.** L'administrateur attribue les rôles inclus dans le sien, sauf celui de super administrateur. Il ne règle plus les destinataires de la rentabilité quand ce réglage passe dans les rôles (D2) : qui voit les marges est une décision de dirigeant. C'est un changement assumé, annoncé dans la PR qui le fait.
4. **Technicien : un garde-fou dans le code, désactivable explicitement.**
   - Chaque rôle porte un attribut « sans montants », coché sur le rôle prédéfini Technicien.
   - Tant qu'il est coché, le serveur refuse d'accorder à ce rôle, ou à un compte qui le porte par un ajout individuel :
     - toute la liste des montants (décision 5), devis compris ;
     - `saisies.saisir`, `saisies.archiver` et `saisies.apresCloture` ;
     - `chantiers.modifier`, qui écrit les budgets, et que l'API refuse déjà au technicien titulaire (note 2).
   - C'est au moins l'actuel `DROITS_INTERDITS_TECHNICIEN` : `devis:read` et `devis:write` (`devis.*`), `chantiers:write` (`saisies.saisir`), `chantiers:archive` (`saisies.archiver`) et `finances:read` (`finances.suivi`, `rentabilite.voir`, `prixAchat.*`). Comme aujourd'hui, une permission déjà enregistrée reste sans effet et peut seulement être retirée.
   - La saisie de ses propres heures d'intervention (`interventions.sesHeures`, lot 3a, #166, étendue hors contrat par #257, lot 3b-2) n'est pas concernée : elle ne montre aucun montant.
   - Seul le super administrateur peut décocher l'attribut, après confirmation, et c'est journalisé.
   - « Peut porter une fiche intervenant » est un attribut distinct. Un chef d'équipe terrain qui voit des montants reste donc possible, par un rôle composé explicitement.
5. **Montants : une liste unique, pas de plancher figé, un contrôle fort.** Rien n'est réservé en dur aux rôles système, pour rester paramétrable : un rôle « Comptabilité » peut avoir besoin des coûts. En contrepartie :
   - le code tient **une seule liste** des permissions qui montrent un montant ou permettent d'en déduire un (section 8.3) :
     - `montants.voir`, `rentabilite.voir`, `mainOeuvre.voir`, `prixAchat.voir` et `prixAchat.saisir` ;
     - `devis.*` et `catalogue.*` (prix de vente) ;
     - `interventions.couts` ;
     - `factures.*`, `reglements.*`, `comptabilite.*` et `finances.suivi` ;
     - `stats.travaux` (totaux d'achats par fournisseur), `stats.commerciales` et `commissions.*` ;
     - `remuneration.consulter` et `remuneration.modifier` ;
     - `journal.consulter`, dont les entrées montrent barèmes et taux ;
   - un test classe chaque permission du catalogue dans cette liste ou explicitement hors d'elle : une permission nouvelle non classée fait échouer la suite. Restent hors liste, par exemple, `saisies.consulter`, `stats.tableauDeBord` et `stats.conducteurs`, dont les montants suivent `montants.voir`, `rentabilite.voir` ou `mainOeuvre.voir` (décision 8) ;
   - seul le super administrateur accorde une permission de cette liste, par un rôle (décision 3) ou par un ajout individuel (décision 2). L'attribut « sans montants » les refuse toutes (décision 4) ;
   - l'écran avertit des déductions (section 8.3) et montre l'écart avant l'enregistrement (section 6.2) ;
   - chaque octroi est journalisé ;
   - les rôles prédéfinis gardent les réservations actuelles.
6. **Placement.** Le lot D0 tout de suite, chaque défaut dans sa PR (#178, #179, #180, #181). D1a ensuite. D1 à D4 après le premier jour du pilote. Seule exception : si l'organisation de l'entreprise pilote ne tient pas dans les dix types actuels, D1, D2 et D3 avancent avant ce premier jour. Un rôle sur mesure se crée par l'écran D3, mais n'agit qu'une fois les routes basculées sur le moteur (D2). Mise à jour : depuis le 19-10-2026, la règle du pilote, décidée par Nelson, prime pour #179 et #181 ; le 21-10-2026, Nelson les a placés avant la fin du pilote. D1a et D1 les suivent (section 9).
7. **« Aussi commercial »** : réservé aux rôles système au premier lot, au comportement identique. Si une société le demande, il deviendra un attribut de rôle.
8. **Règles historiques.** En D1, elles sont reproduites telles quelles, et la matrice le prouve. En D2, elles sont harmonisées une à une, chacune dans sa PR avec la matrice mise à jour. La cible est la variante la plus cohérente, et à défaut la plus restrictive :
   - **titulaire** : une seule définition de « ses dossiers » par permission, la même pour la liste et pour la fiche. Un commercial titulaire verra donc aussi le chantier dans sa liste ;
   - **clôture du responsable**, limitée aux chantiers des techniciens : gardée telle quelle, faute de besoin connu ;
   - **saisie du directeur** : reste fermée ;
   - **tableau de bord** : chaque bloc suit la permission qui lui correspond, au lieu du type de compte ;
   - **statistiques des fournisseurs** : restreintes au périmètre des chantiers du demandeur ;
   - **planning** : les chantiers proposés excluent les affaires annulées et suivent le périmètre de `chantiers.consulter`. Pour le technicien, la décision de Nelson du 19-10-2026 (note 11) prime : elle s'applique avant, dans sa propre PR (#275), étendue par celle du 21-10-2026 (#279).
9. **Titulaire.**
   - **D1** : la règle actuelle, à l'identique. Le serveur accepte tout compte actif ; l'écran ne propose que les conducteurs. La correction D0 (#181) journalise les réattributions sans changer qui peut être titulaire.
   - **D2** : seul peut être **désigné** titulaire un compte actif dont le rôle a l'attribut « peut être titulaire ». L'écran propose alors tous ces comptes.
   - À la migration, l'attribut est coché sur Conducteur, Responsable et Technicien, et sur les rôles système (administrateur, super administrateur). Il est décoché sur Directeur, Commercial, Directeur commercial, Assistante commerciale et Comptable. Raisons : le conducteur est le titulaire que l'écran propose ; le responsable titulaire a ses règles (notes 1 et 4) ; le technicien titulaire aussi (clôture par le responsable, note 3, gardée par la décision 8).
   - Les titulaires existants gardent leurs chantiers : l'attribut ne joue qu'à une nouvelle désignation. L'écran de migration liste les chantiers dont le titulaire a un rôle sans l'attribut, pour que le super administrateur le coche s'il le souhaite.
10. **Rentabilité.** Cible D2 : des portées emboîtées, où « sa branche » comprend ses propres chantiers.
    - **D1** : la combinaison « branche oui, ses propres chantiers non » (`rentabiliteHierarchie` sans `rentabiliteConducteur`) est reproduite par une règle historique : comportement identique, prouvé par la matrice.
    - **D2** : cette combinaison n'existe plus. Si une société l'a réglée, l'écran de migration demande au super administrateur de choisir, pour le responsable, entre « aucune rentabilité » et « sa branche, ses propres chantiers compris ». Le choix par défaut est « aucune rentabilité » : c'est la seule portée emboîtée qui ne montre aucun montant de plus qu'aujourd'hui, puisque « son équipe » comprend aussi ses propres chantiers. L'écran dit ce que le responsable perd (la rentabilité de sa branche) ou gagne (celle de ses propres chantiers), et le choix est journalisé.
    - Les autres combinaisons s'expriment sans perte : titulaire seul, « ses dossiers » (titulaire) ; branche et propres chantiers, « sa branche » ; directeurs, « toute l'entreprise » ou rien.
11. **Directeur commercial, assistante commerciale et comptable (#179).** Ces types franchissent `blockCommercial`, qui ne refuse que le commercial et le directeur. Au lot D0, ils sont refusés comme le commercial, avec les mêmes messages, et l'écran est aligné (menu, Administration). **Appliqué** (#282) ; le message nomme le type de compte (« Accès non autorisé pour un compte comptable. »), comme ceux du commercial et du directeur (choix par défaut, à confirmer) :
    - **écritures** du planning, des types d'événement et des référentiels : rien ne les prévoit dans `MODELE-DROITS-COMPTES.md` ;
    - **lectures du planning** (`/api/planning/…`) : la liste de **tous** les chantiers, annulés compris, et les affectations de toute l'entreprise sortent de leur périmètre, puisqu'ils ne consultent que les chantiers dont ils sont titulaires.
    - Les **routes SAV** leur répondent, mais avec un filtre par affectation vide en pratique : aucune fiche intervenant ne peut être reliée à leur compte (#166), et aucune donnée n'en sort. Elles sont reproduites telles quelles en D1, puis retirées en D2, comme pour le commercial.

    Une société qui veut qu'une assistante consulte ou modifie le planning lui donnera `planning.consulter` ou `planning.modifier`, par son rôle (D3) ou par un ajout individuel du super administrateur.
12. **Écran plus restrictif que le serveur.** Par défaut, le serveur se restreint à ce que l'écran montre. Exception : si un écran que le rôle utilise a besoin de la donnée, comme le choix d'un client dans un devis, c'est l'écran qui s'aligne sur le serveur. Chaque cas est tranché ainsi en D2, matrice à l'appui.
13. **Rôles prédéfinis** : modifiables, sauf le super administrateur, qui est verrouillé. Un repère « modifié » les signale, avec la commande « revenir au modèle d'origine ». L'attribut « sans montants » du Technicien suit la décision 4.
14. **Règlements dans le modèle « Comptabilité »** (section 5.2). Saisir, affecter et contre-passer un règlement est le travail de la comptabilité : le modèle « équipe avec hiérarchie » les lui donne. Rien ne change pour le rôle prédéfini Comptable d'« Iris actuel », ni pour les comptes existants : les règlements restent à l'administration tant que le super administrateur n'applique pas ce modèle (D4). `reglements.*` fait partie de la liste des montants (décision 5).
