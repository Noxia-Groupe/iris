# Modèle de droits cible : proposition

> **Proposition du 17-10-2026, à valider par Nelson avant tout code** (chantier technique 3). Rien de ce document n'est implémenté. C'est un parcours de droits : exigence maximale (règle 2 de la méthode).
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
- **Des écarts entre la documentation et le code.** Directeur commercial, assistante commerciale et comptable ne font pas ce que décrit `MODELE-DROITS-COMPTES.md`. Ils écrivent par ailleurs dans le planning et les référentiels (#179).
- **L'écran raisonne autrement que le serveur.** Il teste souvent des types de compte là où le serveur teste une permission ou un périmètre. Il est donc parfois plus restrictif que l'API (annexe, B5).

## 2. Inventaire des règles actuelles (résumé)

Le détail est dans l'[annexe](MODELE-DROITS-INVENTAIRE.md) : chaque route, ses gardes et les types qu'elle admet. Les sections sont A1 à A8 pour le serveur, B pour l'écran, C pour la matrice et D pour les écarts. Le découpage du serveur (chantier 2) déplace les lignes citées, mais garde les noms des fonctions.

| Famille de règles | Où dans le code (fonctions) | Types concernés |
|---|---|---|
| Types de compte | `ROLE_*`, `ALLOWED_ROLES`, `isAdminRole`, `isSuperAdminRole` | les 10 |
| Permissions par défaut et individuelles | `DEFAULT_USER_PERMISSIONS`, `permissionsEffectives`, `requirePermission`, `PUT /api/users/:id/permissions` | tous ; le super administrateur les a toutes |
| Interdits du technicien | `DROITS_INTERDITS_TECHNICIEN` | technicien |
| Gardes de type de compte | `requireAdmin`, `requireSuperAdmin`, `blockCommercial`, `blockCommercialSeulement`, `blockTechnicien`, `requireTravauxRead`, garde en ligne de `POST /api/interventions` | selon la garde |
| Périmètres de lecture | `perimetreDemandeur`, `perimetreChantiers`, `getInterventionFilterForUser`, `brancheHierarchique`, contrôle `isOwner` de la fiche chantier | tous ; « autres » pour DC, AC, CPT et technicien (annexe, A4) |
| Écriture et clôture | `assertChantierWritable`, `peutCloturerChantier`, contrôles du titulaire dans `PATCH /api/chantiers/:id` | conducteur, responsable, directeur, titulaires |
| Montants | `voitRentabilite` (et les réglages `rentabiliteConducteur`, `rentabiliteHierarchie`, `rentabiliteDirecteurs`), `voitMontantsChantier`, `voitCoutMainOeuvre`, `voitPrixAchatDevis`, `ecritPrixAchatDevis`, `saisieSelonDroits` | tous |
| Administration des comptes | `refuseSuperAdminTarget`, `isLastSuperAdmin`, `journaliserDroitsCompte`, `entreesVisiblesJournal` | administrateurs |
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
| | `devis.annuler` | Annuler un devis, et le chantier qui en est issu |
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

Pour une TPE, l'écran regroupe ces permissions en une quinzaine de **groupes** : « Devis », « Chantiers », « Montants », « SAV »… Une case par groupe ; le détail ne s'ouvre qu'à la demande (section 5).

### 3.2 Un périmètre pour chaque permission

Chaque permission accordée porte un périmètre parmi quatre, comme le demande Nelson :

| Périmètre | Sens |
|---|---|
| **Ses dossiers** | ce dont le compte est chargé, par une **relation** au dossier (ci-dessous) |
| **Son équipe** | ses dossiers et ceux de ses collaborateurs **directs** |
| **Sa branche** | ses dossiers et ceux de toute sa branche hiérarchique : collaborateurs directs, puis les leurs, à tous les niveaux |
| **Toute l'entreprise** | sans restriction |

**Équipe et branche.** Aujourd'hui, seul le compte `RESPONSABLE` a un périmètre hiérarchique, et c'est toujours la branche entière (`brancheHierarchique`). Le périmètre « son équipe », limité aux collaborateurs directs, n'existe pas encore. « Sa branche » pourrait aussi désigner une agence ou un établissement : Iris ne connaît aucune de ces notions (question 1).

**Relations.** « Ses dossiers » se définit par une ou plusieurs relations, choisies **pour chaque permission** du rôle :
- **chantiers** : titulaire (`responsableId`), commercial (`commercialId`) ;
- **interventions** : intervenant affecté (par sa fiche), créateur, titulaire du chantier lié ;
- **devis** : aucune relation n'existe aujourd'hui (le devis n'a ni commercial ni auteur).

« Son équipe » et « sa branche » appliquent les mêmes relations aux collaborateurs concernés.

**Pourquoi pas un périmètre par domaine.** Le code actuel donne à un même compte des périmètres différents selon l'action, dans le même domaine. Par exemple, le commercial voit dans sa liste les chantiers dont il est le commercial, mais sa fiche s'ouvre aussi s'il en est titulaire. Le moteur calcule donc le filtre **par permission**, avec les relations retenues pour elle. La section 4.2 donne les définitions actuelles.

Certaines permissions n'ont qu'un périmètre utile. Le paramétrage, par exemple, porte toujours sur toute l'entreprise : l'écran ne propose alors que « oui » ou « non ».

### 3.3 Des rôles paramétrables

Un **rôle** = un ensemble de permissions, chacune avec son périmètre et ses relations. Depuis Administration, on peut :
- **créer** un rôle, vide ou à partir d'un modèle ;
- **dupliquer** un rôle pour l'ajuster ;
- **renommer** un rôle ;
- **supprimer** un rôle qu'aucun compte ne porte. La suppression est refusée en base tant qu'un compte le porte (clé étrangère `RESTRICT`), ce qui exclut une course avec une attribution simultanée.

Chaque compte porte **un rôle**. Proposition : plus de permissions individuelles. Une exception se traite en dupliquant un rôle (« Conducteur + archivage », par exemple) (question 2). `MODELE-DROITS-COMPTES.md` prévoyait deux étages, le type de compte puis les permissions individuelles : c'est ce choix que la question remet en cause.

### 3.4 Une hiérarchie facultative

Le rattachement hiérarchique existe déjà (`responsableHierarchiqueId`). Il ne sert qu'aux périmètres « son équipe » et « sa branche » :
- une TPE n'en règle aucun, et ces deux périmètres se réduisent alors à « ses dossiers » ;
- une PME relie ses collaborateurs, et chaque rôle choisit, permission par permission, jusqu'où il voit.

C'est une décision d'accès, comme le dit déjà le code : le rattachement reste réservé à un compte qui a `comptes.gerer` sur toute l'entreprise (section 7.1).

### 3.5 Attributs du compte, hors rôle

| Attribut | Aujourd'hui | Proposition |
|---|---|---|
| « Aussi commercial » (`estCommercial`) | réservé aux administrateurs (création, changement de type, route dédiée) ; l'administrateur apparaît alors comme commercial (sélecteurs, commissions, prime) et garde son périmètre | Reste un attribut du compte, **réservé aux rôles système** (administrateur, super administrateur) au premier lot. L'ouvrir à d'autres rôles serait un élargissement, à décider (question 7). |
| Fiche intervenant reliée | seul un compte technicien actif se relie ; un compte qui quitte le type technicien perd sa fiche (#166) | Un rôle porte la propriété « peut porter une fiche intervenant ». Changer un compte vers un rôle qui ne l'a pas délie sa fiche, journalisé, comme aujourd'hui. |

## 4. Les dix rôles prédéfinis « Iris actuel »

### 4.1 Table de correspondance

Chaque type de compte actuel devient un rôle prédéfini. La table l'exprime dans le vocabulaire de la section 3.1. C'est la cible de la preuve de non-régression (section 6).

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
| `referentiels.gerer` | T | T | — | T | T | — | T ⁷ | T ⁷ | T ⁷ | — |
| `intervenants.gerer`, `intervenants.relierCompte` | T | T | — | — | — | — | — | — | — | — |
| `interventions.consulter` | T | T | — | D af, B cl ⁸ | D af cr cl | — | D af ⁷ | D af ⁷ | D af ⁷ | D af |
| `interventions.creer` | T | T | — | — | T | — | — | — | — | — |
| `interventions.statut`, `interventions.placer` | T | T | — | D af, B cl | D af cr cl | — | D af ⁷ | D af ⁷ | D af ⁷ | — |
| `interventions.demarrerTerminer` | T ¹⁵ | T ¹⁵ | — | D af, B cl ¹⁵ | D af cr cl ¹⁵ | — | D af ⁷ ¹⁵ | D af ⁷ ¹⁵ | D af ⁷ ¹⁵ | D af |
| `interventions.compteRendu` | T | T | — | D af, B cl | D af cr cl | — | D af ⁷ | D af ⁷ | D af ⁷ | D af ¹⁵ |
| `interventions.sesHeures` | — | — | — | — | — | — | — | — | — | D af |
| `interventions.couts`, `interventions.journal` | T | T | — | — ⁸ | D af cr cl | — | — | — | — | — |
| `contrats.*` | T | T | — | — | — | — | — | — | — | — |
| `planning.consulter` | T | T | — | T ¹¹ | T ¹¹ | — | T ¹¹ | T ¹¹ | T ¹¹ | T ¹¹ |
| `planning.modifier`, `planning.types` | T | T | — | T | T | — | T ⁷ | T ⁷ | T ⁷ | — |
| `planning.partager` | T | T | — | — | — | — | — | — | — | — |
| `factures.*`, `mentions.gerer`, `reglements.*`, `comptabilite.*` | T | T | — | — | — | — | — | — | — | — |
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

Ces règles sont celles du code d'aujourd'hui (annexe, A3 à A8). Plusieurs ne tiennent pas dans un modèle à relations simples. Au premier lot (D1), elles sont reproduites telles quelles par des **règles historiques nommées**, rattachées aux rôles prédéfinis et prouvées par la matrice (section 6). Leur harmonisation est une décision de Nelson (question 8).

1. **Consultation des chantiers.**
   - **Liste** (`perimetreDemandeur`) : directeur toute l'entreprise ; commercial par `commercialId` ; responsable par titulaire dans sa branche, lui compris ; tous les autres par `responsableId`. Affaires annulées exclues pour tous, administrateurs compris.
   - **Fiche** (`isOwner`) : directeur, commercial **ou** titulaire, quel que soit le type de compte, responsable sur sa branche ; affaire annulée lisible. Un commercial titulaire voit donc la fiche, mais pas le chantier dans sa liste.
   - **Journal d'une affaire annulée** : fermé à tous (#136).
2. **Modification par le titulaire.** L'API l'admet pour tout titulaire non commercial, non directeur et non technicien ; l'écran ne la propose qu'au conducteur titulaire. Le titulaire peut confier son chantier à tout compte actif (#181, question 9). Le montant vendu ne s'écrit qu'avec `rentabilite.voir`. Le statut et le client envoyés par un non-administrateur sont ignorés en silence.
3. **Clôture par le responsable** : ses propres chantiers, et ceux des **techniciens** de sa branche seulement. Il faut un attribut du rôle du titulaire (« rôle terrain ») pour l'exprimer.
4. **Rentabilité.** Le code croise le type et trois réglages :
   - directeur : si `rentabiliteDirecteurs` ;
   - conducteur ou responsable titulaire : si `rentabiliteConducteur` ;
   - responsable sur les chantiers de sa branche : si `rentabiliteHierarchie`.

   La combinaison « branche oui, ses propres chantiers non » n'est pas exprimable avec des périmètres emboîtés : une relation « branche hors ses dossiers » est nécessaire, ou bien une décision de ne plus la permettre (question 10). Côté clé, la rentabilité exige `finances:read`.
5. **Saisies en lecture.** L'API sert les journaux d'achats et d'heures à tous, dans leur périmètre de chantiers : directeur et commercial compris, sans écran pour eux.
6. **Archivage par le conducteur** : uniquement par permission individuelle aujourd'hui. Avec un rôle par compte, un rôle « Conducteur + archivage » le remplace (question 2).
7. **Directeur commercial, assistante commerciale et comptable** franchissent `blockCommercial` : écritures du planning et des référentiels, routes SAV au filtre vide (#179, question 11).
8. **SAV du responsable** : interventions où il est affecté, ou dont le chantier lié a pour titulaire un membre de sa branche ou lui-même. Il ne voit pas une intervention sans chantier affectée à un membre de sa branche. Coûts SAV : 403 dans son périmètre.
9. **Annuaire du commercial, du directeur commercial, de l'assistante et du comptable** : l'API le leur sert, mais l'écran le leur ferme (`ROLES_ANNUAIRE`).
10. **Technicien et clients désactivés** : l'annuaire les lui ferme (404 sur la fiche et l'historique, filtre ignoré). L'intervention qui lui est affectée lui montre pourtant client, site et contact (invariant, section 7.2).
11. **Planning en lecture** : les événements sans intervention de toute l'entreprise, les projections d'interventions dans le périmètre SAV, et la liste de **tous** les chantiers, annulés compris.
12. **Tableau de bord** : le contenu varie selon le type.
    - Les achats ne sont envoyés ni au commercial ni au technicien.
    - Les heures ne sont envoyées ni à l'administrateur ni au commercial.
    - Le chiffre d'affaires, la marge et les commissions de la société vont aux administrateurs ; le commercial reçoit sa marge et sa commission.
13. **Statistiques Travaux** : celles des fournisseurs portent sur toute l'entreprise, sans périmètre.
14. **Séparation entre administrateur et super administrateur.** Un administrateur ne voit ni ne gère les comptes super administrateur. Il ne voit pas les entrées de journal qui les concernent, ni celles des clés d'intégration.
15. **Transitions et compte rendu SAV.** `interventions.statut` comprend démarrer et terminer. Le technicien n'a que ces deux transitions. L'écran ne lui propose qu'à lui le compte rendu et la signature, que l'API ouvre à tout compte de la ligne `interventions.consulter`.

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

## 5. Modèles prêts à l'emploi

Ce sont des propositions. Chaque modèle reste modifiable après son application, et aucun n'est imposé. Les noms décrivent une organisation, pour éviter la confusion avec les catégories légales TPE et PME, qui fixent le calendrier de la facturation électronique.

### 5.1 « Petite équipe, sans hiérarchie » (trois rôles)

| Rôle | Contenu proposé |
|---|---|
| **Dirigeant** | rôle système « super administrateur » : tout, sur toute l'entreprise |
| **Bureau** | clients, devis, chantiers, interventions et planning sur toute l'entreprise ; facturation et règlements ; montants et rentabilité ; ni rôles, ni clés d'intégration, ni modules |
| **Technicien** | comme le rôle prédéfini Technicien : ses interventions, planning en lecture, annuaire des clients actifs en lecture, aucun montant |

### 5.2 « Équipe avec hiérarchie »

| Rôle | Contenu proposé |
|---|---|
| **Direction** | tout, sur toute l'entreprise |
| **Administration** | comme le rôle prédéfini Administrateur |
| **Comptabilité** | factures, avoirs, comptabilité, export ; chantiers et devis en lecture ; toute l'entreprise. Les règlements, réservés aujourd'hui à l'administration (choix par défaut de `MODELE-DROITS-COMPTES.md`), restent à décider. |
| **Directeur commercial** | devis et affaires de son équipe ou de sa branche ; statistiques commerciales de son équipe |
| **Commercial** | ses affaires ; ses statistiques |
| **Assistante commerciale** | devis de tous les commerciaux ; choix traçable du commercial porteur (décrit par `MODELE-DROITS-COMPTES.md`, non implémenté) |
| **Responsable travaux** | chantiers, saisies, interventions et planning de sa branche ; statistiques Travaux de sa branche |
| **Conducteur de travaux** | ses chantiers, ses saisies, les interventions qu'il crée ou qui le concernent ; planning |
| **Technicien** | comme en petite équipe |

Trois de ces rôles décrivent un comportement qui n'existe pas encore : l'équipe du directeur commercial, les devis rattachés à un commercial, le choix traçable par l'assistante. Le devis n'a pas de commercial aujourd'hui : ces rôles ne s'appliqueront qu'avec le lot qui les rend possibles.

### 5.3 « Iris actuel »

Les dix rôles de la section 4, au comportement strictement identique. C'est le point de départ de la migration.

## 6. Migration et moteur

### 6.1 Matrice de non-régression

Chaque type de compte actuel devient le rôle prédéfini correspondant, au comportement **strictement identique**. La preuve est donnée **rôle par rôle**, par une matrice enregistrée en exécutant l'API **avant** tout changement, puis rejouée sur le nouveau moteur.

**Données couvertes** :
- un chantier de chaque statut, y compris annulé ;
- un titulaire de chaque type ;
- un commercial, et un administrateur « aussi commercial » ;
- une branche de techniciens et une branche de conducteurs ;
- des interventions avec et sans contrat, et une fiche intervenant reliée ;
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

La colonne des routes vient du script `server/scripts/routes.mjs` du chantier 2. Il est encore dans la PR #177, non fusionnée.

**Ordre.** La matrice est enregistrée **tôt**, comme un lot de tests seul. Elle protège alors aussi les PR du découpage du serveur. Un lot qui change volontairement un droit met la matrice à jour dans sa propre PR, l'écart restant visible au diff, comme la liste des routes. Cela vaut pour les choix « à appliquer » de la passation, section 4, et pour les corrections de D0.

**Écran.** D2 fait lire à l'écran les permissions effectives au lieu des types de compte. L'écran s'ouvrirait alors partout où il est plus restrictif que le serveur : annuaire du commercial, Performances du responsable, journaux d'achats du directeur. D2 doit donc soit garder ces restrictions comme règles historiques, soit les faire trancher avant (question 12).

### 6.2 Moteur côté serveur

- **Données** :
  - `Role` : nom ; clé système non renommable pour les rôles système ; modèle d'origine ;
  - `RolePermission` : rôle, permission, périmètre et relations ;
  - `User.roleId`, en clé étrangère `RESTRICT`.
- **Lecture** : le rôle et ses permissions sont relus avec le compte à **chaque requête**, comme aujourd'hui dans `requireAuth`. Il n'y a aucun cache des permissions entre deux requêtes, si bien qu'un retrait prend effet à la requête suivante.
- **Deux fonctions** remplacent les gardes et les tests dispersés :
  - `autorise(requete, permission, dossier?)` ;
  - `perimetre(requete, permission)`, qui renvoie le filtre de base de données de **cette permission**, avec ses relations et ses éventuelles règles historiques.

  Les fonctions de montants (`voitRentabilite`…) s'appuient sur les mêmes permissions.
- **Compatibilité** : au premier lot, `/api/me` garde `role` (la clé du rôle prédéfini) et les noms actuels des permissions. L'écran passe aux nouvelles permissions en D2. Les routes des permissions individuelles et de l'accès financier sont retirées quand la question 2 est tranchée.
- **Clés d'intégration** : elles gardent leurs scopes, traduits par la correspondance de la section 4.2.

Aucune donnée réelle n'existe (règle 4) : la migration des comptes se limite à associer chaque type à son rôle prédéfini.

## 7. Ce qui reste dans le code, et pourquoi

### 7.1 Invariants

| Invariant | Raison |
|---|---|
| Au moins un super administrateur **actif**. Son rôle, repéré par une clé système non renommable, ne se modifie ni ne se supprime, et a toujours tout. | Sinon personne ne peut plus administrer l'instance. La règle actuelle compte les comptes désactivés et se vérifie hors transaction : #178. |
| L'accès de secours et `SUPERADMIN_EMAILS` visent le rôle système « super administrateur », par sa clé. | Ce sont les seules portes de reprise de l'instance. |
| Seul un super administrateur gère les comptes super administrateur, les rôles et les clés d'intégration (question 3). | Sinon un administrateur pourrait s'élever lui-même. |
| **Pas d'élévation.** Un compte n'attribue un rôle que s'il est **inclus** dans le sien. Inclus veut dire que chaque permission du rôle attribué figure dans le sien, avec un périmètre au moins aussi large (ses dossiers ⊂ son équipe ⊂ sa branche ⊂ toute l'entreprise) et des relations comprises dans les siennes. Deux rôles incomparables : refus. | Empêcher l'auto-élévation, y compris par un rôle « de côté ». |
| On ne modifie pas son propre rôle. | Même raison. **Changement assumé** : aujourd'hui, le changement de son propre type de compte n'est pas refusé. Il entre au lot D1. |
| Le rattachement hiérarchique est réservé à `comptes.gerer` sur toute l'entreprise. | Il élargit la branche, donc l'accès, de toute la chaîne au-dessus du compte. |
| L'aperçu « ce que voit ce compte » respecte la séparation : un administrateur ne prévisualise pas un compte super administrateur. | Même séparation qu'aujourd'hui dans la liste des comptes. |
| Chaque changement de rôle, de permission ou d'attribution est journalisé dans la même transaction, en ajout seul. Une entrée qui concerne un compte super administrateur reste fermée à un simple administrateur ; les autres lui sont visibles, comme les changements de permissions aujourd'hui. | Décision du 13-10-2026 (#133) et règle 2. |
| Les documents d'argent émis sont immuables (factures et avoirs émis, devis signés, règlements, écritures), quelle que soit la permission. | Obligation légale et d'intégrité. Lacunes en base, dont les lignes de facture et la version des mentions : #180. |
| La numérotation des factures reste continue et chronologique. | Obligation légale. |
| Le rôle et le statut actif sont relus en base à chaque requête. | Un retrait de droit prend effet tout de suite. |
| Les permissions s'appliquent côté serveur ; l'écran ne fait qu'afficher. | Une règle d'écran n'est pas une sécurité. |
| Un module désactivé est fermé à tous, sauf au super administrateur. | Réglage de la société, distinct des droits. |
| Une clé d'intégration ne signe pas de devis et n'accède ni aux comptes ni aux droits. | La signature engage une personne. |

### 7.2 Exceptions actuelles : permission ou invariant

| Exception actuelle | Proposition |
|---|---|
| Un technicien garde le client, le site et le contact d'une intervention qui lui est affectée, même désactivés | **Invariant justifié**, étendu à tout rôle : un dossier accessible montre toujours son client, sinon il ne peut pas être traité. |
| L'annuaire ferme les clients désactivés au technicien (404 sur la fiche et l'historique) | Absence de `clients.desactives` dans son rôle. |
| Le technicien ne reçoit jamais devis, montants ni accès financier, même individuellement | **Propriété du rôle « Technicien »** : il n'a pas ces permissions. Question 4 : faut-il un garde-fou qui empêche de les ajouter à un rôle de technicien ? |
| Refus explicites du technicien (403 et message, et non 404) | Règle historique reproduite par la matrice. |
| Alerte d'heures dépassées retirée au technicien, alors que ce n'est pas un montant | Suit `montants.voir`, comme les autres alertes de dépassement. |
| Le directeur clôture tout chantier en cours, sans le rouvrir | `chantiers.cloturer` sur toute l'entreprise, sans `chantiers.rouvrir`. |
| La saisie Travaux du directeur ne s'ouvre pas par permission (`assertChantierWritable` teste le type) | Son rôle n'a pas `saisies.saisir`. La lui accorder deviendrait possible : à décider (question 8). |
| Le responsable clôture les chantiers des seuls techniciens de sa branche | Règle historique (note 3). Elle demande l'attribut « rôle terrain » du titulaire. |
| Le conducteur ne clôture pas le chantier d'un technicien dont il est le N+1 | Conséquence du périmètre « ses dossiers ». |
| Destinataires de la rentabilité (trois réglages) | `rentabilite.voir`, avec son périmètre (note 4). Le réglage passe de l'administrateur (`PUT /api/parametres`) à la matrice des rôles. Si seul le super administrateur modifie les rôles, l'administrateur perd ce pouvoir (question 3). |
| Taux horaires et coût de main-d'œuvre réservés aux administrateurs (décisions du 13, 14 et 16-10-2026) | `mainOeuvre.voir`. Plancher éventuel : question 5. |
| Prix d'achat lisibles et saisissables par les seuls administrateurs ; une clé les lit sans jamais les écrire | `prixAchat.voir` et `prixAchat.saisir`, séparés. |
| Administrateur « aussi commercial » | Attribut du compte réservé aux rôles système (section 3.5). |
| Le commercial voit la marge de chaque chantier dans ses statistiques | `commissions.detail`, à trancher avec la question du lot (d) (passation, section 3). |
| Création d'une intervention réservée à l'administration et au conducteur, sans contrôle du périmètre du chantier | `interventions.creer`. Le contrôle du périmètre est un choix « à appliquer » (passation, section 4). |
| Saisie des heures SAV réservée au technicien affecté | `interventions.sesHeures`, sur « ses dossiers ». |
| Champs d'ouverture d'un chantier réservés à l'administration à la conversion | `devis.ouvrirChantier`, distinct de `chantiers.reattribuer`. |
| Fiche intervenant reliée seulement à un technicien actif, perdue en quittant ce type | Propriété du rôle « peut porter une fiche intervenant » (section 3.5). |
| Éligibilité au titulariat : le serveur accepte tout compte actif, l'écran ne propose que des conducteurs | À décider (question 9, #181). |
| Le super administrateur garde le planning quand le module est désactivé | Invariant des modules (7.1). |
| Accès de secours et `SUPERADMIN_EMAILS` | Invariants (7.1). |
| Les clés d'intégration voient les taux et les clients désactivés | Correspondance des scopes (section 4.2), à aligner sur les choix « à appliquer » de la passation, section 4. |

### 7.3 Montants : ce qui se déduit d'autre chose

Certaines permissions redonnent une information réservée par une autre, par simple calcul. Les cas sont déjà relevés par `MODELE-DROITS-COMPTES.md` :
- les budgets par poste (`montants.voir`) redonnent le montant vendu, donc la marge (`rentabilite.voir`) ;
- la rentabilité, avec les montants, redonne le coût de main-d'œuvre (`mainOeuvre.voir`) ;
- le prix d'achat du catalogue redonne celui du devis ;
- le détail des commissions par chantier redonne la marge.

Proposition : l'écran des rôles **avertit** quand une permission en révèle une autre par déduction. Il peut aussi proposer de les accorder ensemble. Faut-il en plus un plancher dans le code, qui réserve certains montants (taux, coût de main-d'œuvre, prix d'achat) aux rôles système, quel que soit le paramétrage ? C'est la question 5 : les montants reviennent à Nelson (règle 5).

## 8. Lots proposés et placement par rapport au pilote

| Lot | Contenu | Placement proposé |
|---|---|---|
| **D0** | Défauts actuels de la règle 2, chacun dans sa PR : dernier super administrateur (#178) ; lignes et mentions de facture figées en base (#180) ; réattributions et encaissement journalisés (#181) ; directeur commercial, assistante et comptable dans le planning et les référentiels (#179, sur décision de Nelson) | **Au plus tôt, sans attendre la fin du découpage du serveur** : chaque correction est une petite PR, rebasée au besoin sur les PR du découpage |
| **D1a** | Matrice de non-régression enregistrée sur le code actuel, en tests seuls (section 6.1) | Tôt : elle protège aussi le découpage du serveur |
| **D1** | Moteur (`autorise`, `perimetre` par permission, règles historiques), tables `Role` et `RolePermission`, dix rôles prédéfinis identiques, refus de modifier son propre rôle (changement assumé). Aucune route ne change encore de comportement. | Après le pilote, sauf si l'organisation de l'entreprise pilote ne tient pas dans les dix types actuels (question 6) |
| **D2** | Bascule des routes sur le moteur, un ou deux domaines par PR, matrice verte à chaque fois ; l'écran lit les permissions effectives (section 6.1, Écran) | Après D1 |
| **D3** | Écran : tableau rôles × permissions, en groupes ou en détail ; créer, dupliquer, renommer, supprimer ; avertissement des déductions ; aperçu « ce que voit ce compte » ; journal | Après D2 |
| **D4** | Modèles « petite équipe » et « équipe avec hiérarchie », appliqués depuis l'assistant de démarrage du paramétrage (proposition `PARAMETRAGE-CIBLE.md`) | Avec l'assistant |

Chaque lot est une PR ou une petite série de PR, avec ses tests réels sur PostgreSQL et dans le navigateur.

## 9. Questions pour Nelson

1. **Équipe, branche, agence.** « Son équipe » = collaborateurs directs, et « sa branche » = tous les niveaux, comme le responsable aujourd'hui : est-ce ta lecture ? Ou « sa branche » désigne-t-elle une agence ou un établissement, notion qu'Iris n'a pas encore ?
2. **Un rôle par compte**, sans permission individuelle ? Une exception passerait alors par un rôle dupliqué. Sinon, garde-t-on les deux étages prévus par `MODELE-DROITS-COMPTES.md` ?
3. **Qui modifie les rôles ?** Proposition : le super administrateur seulement. Un administrateur attribue les rôles inclus dans le sien, sauf celui de super administrateur. Conséquence : l'administrateur ne règle plus lui-même les destinataires de la rentabilité, comme il le fait aujourd'hui. Faut-il lui laisser ce réglage ?
4. **Garde-fou du technicien** : faut-il garder une interdiction absolue (jamais de devis ni de montants pour un rôle marqué « technicien »), ou laisser chaque entreprise composer son rôle ?
5. **Plancher des montants** : faut-il réserver dans le code les taux, le coût de main-d'œuvre et les prix d'achat aux rôles système, quel que soit le paramétrage ? Ou suffit-il d'un avertissement à l'écran ?
6. **Placement** : D0 et D1a au plus tôt, D1 à D4 après le pilote ? L'entreprise pilote a-t-elle une organisation que les dix types actuels ne couvrent pas ?
7. **« Aussi commercial »** : le garder réservé aux administrateurs, ou l'ouvrir à d'autres rôles ?
8. **Règles historiques** (section 4.2) : les reproduire telles quelles dans les rôles prédéfinis, puis les harmoniser une à une, ou les corriger avant la migration ? En particulier :
   - les cinq définitions du titulaire ;
   - la clôture du responsable limitée aux techniciens ;
   - la saisie du directeur ;
   - le tableau de bord ;
   - les statistiques des fournisseurs sans périmètre ;
   - le planning qui liste tous les chantiers.
9. **Titulaire** (#181) : le titulaire d'un chantier peut-il le confier à tout compte actif, comme le permet l'API, ou seulement à un rôle admis, comme le suggère l'écran ?
10. **Rentabilité** : faut-il garder la combinaison « sa branche oui, ses propres chantiers non », ou les deux réglages vont-ils ensemble ?
11. **Directeur commercial, assistante commerciale et comptable** (#179) : leurs écritures dans le planning et les référentiels sont-elles voulues, ou faut-il les leur retirer comme au commercial ?
12. **Écran plus restrictif que le serveur** (annuaire du commercial, Performances du responsable, journaux d'achats du directeur) : l'écran doit-il s'aligner sur le serveur en D2, ou le serveur se restreindre ?
