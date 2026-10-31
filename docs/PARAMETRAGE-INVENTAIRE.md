# Inventaire « paramétrage plutôt que règles en dur »

> Annexe de la proposition [`PARAMETRAGE-CIBLE.md`](PARAMETRAGE-CIBLE.md) (chantier technique 4, 17-10-2026). Photographie du code à une date donnée, et non documentation tenue à jour. Le découpage du serveur par domaine (chantier 2) déplace les lignes citées, mais garde les noms des fonctions et des constantes. Depuis, #216 a remplacé `isLastSuperAdmin` par `estDernierSuperAdminActif`, et #282 refuse au directeur commercial, à l'assistante commerciale et au comptable les écritures des référentiels d'achats et leur ferme l'Administration (point 6 de la section 7, B-19). #283 journalise la réattribution du titulaire et du commercial et la case « Encaissé » (B-15, B-16, B-17).
>
> **Commit analysé : `84e27a1`** (`main`, « Merge #175 »).
> Toutes les références `fichier:ligne` portent sur ce commit. Abréviations :
> `idx` = `server/index.ts` · `schema` = `server/prisma/schema.prisma` · `mig/<dossier>` = `server/prisma/migrations/<dossier>/migration.sql` · `cli/` = `client/src/`.
>
> **Suites depuis l'analyse** (au 22-10-2026, complétées le 23-10-2026 pour C-16, le 29-10-2026 pour C-21 et C-08, et le 30-10-2026 pour B-39), sans retoucher la photographie : B-61, B-72 et B-74 traités par le lot P0 (#280 : rapport en A4 ; « IRIS » sur la connexion et le planning public, icônes neutres, trois bleus de la palette standard à la place de ceux de l'ancienne marque, ses deux gris et sa police gardés ; barèmes et primes insérés par migration vidés, sauf valeur saisie différente de celle insérée) ; B-32 par le lot pilote 5 (#293 : génération automatique quotidienne, anticipation `Parametres.anticipationVisitesJours`, vide au démarrage depuis la décision de Nelson du 22-10-2026, #302) ; C-16 étendue par le lot pilote 4 (#281 : une affaire ne se convertit qu'une fois, quelle que soit la cible, chantier, intervention ou contrat ; Nelson a répondu le 22-10-2026 « je permet que les devis creer 2 choses », lu comme deux conversions possibles pour une même affaire (lecture retenue), appliqué par le lot 4 suite : deux conversions au plus, de types différents, voir [l'historique](HISTORIQUE-DECISIONS.md#décisions-du-23-10-2026-nuit-sur-le-lot-4)) ; B-59 en partie par le lot 6a-1 (#300 : modèle commun des PDF des factures et avoirs, avec le logo téléversé, l'identité structurée, la couleur principale et le pied de page copiés à l'émission ; `logoUrl` et `couleurSecondaire` restent sans effet) ; C-21 étendue par #361 : pas de facture, à la création comme à l'émission d'un brouillon, sur une intervention annulée, une intervention d'un contrat ou d'une affaire annulés, ni sur un contrat annulé (décision de Nelson de la nuit du 26 au 27-10-2026, point 14, « pas de facture » sur une intervention ou un contrat annulés avec leur devis ; refus pour une intervention d'une affaire annulée validé par Nelson le 29-10-2026, [historique](HISTORIQUE-DECISIONS.md#décision-du-29-10-2026-sur-le-refus-de-facturer-une-intervention-dune-affaire-annulée) ; intervention annulée depuis sa fiche, visite réalisée d'un contrat annulé et refus à l'émission, lectures et choix par défaut confirmés par Nelson le même jour, [historique](HISTORIQUE-DECISIONS.md#décisions-du-29-10-2026-au-soir-sur-le-refus-de-facturer-une-origine-annulée)) ; règle d'intégrité gardée dans le code, sans paramètre, comme le refus d'une affaire annulée ; C-08 étendue par #364 : seuls les taux de 0 % (autoliquidation), 5,5 %, 10 % et 20 % se saisissent au catalogue, sur les lignes de devis et de facture, et dans une facture au temps passé (décision de Nelson de la nuit du 26 au 27-10-2026, point 13 ; réponses du 29-10-2026, [historique](HISTORIQUE-DECISIONS.md#décisions-du-29-10-2026-nuit-sur-la-tva-française)) ; les pièces saisies avant le lot gardent leur taux, et un avoir suit les taux de la facture corrigée ; règle légale gardée dans le code (`server/src/commun/tva.ts`), sans paramètre ; B-39 modifiée par #368 : pour un chantier ouvert depuis un devis, le matériel attendu de la marge estimée part du coût d'achat prévu au devis, figé à la conversion (prix d'achat prévus des fournitures et de la main-d'œuvre qui en porte un, une fourniture sans prix d'achat comptant pour zéro), au lieu du ratio des chantiers terminés, que garde un chantier ouvert avant le lot (décision de Nelson de la nuit du 26 au 27-10-2026, point 15 ; réponses du 30-10-2026, [matin](HISTORIQUE-DECISIONS.md#décisions-du-30-10-2026-sur-le-budget-et-les-heures-prévues-du-chantier) et [après-midi](HISTORIQUE-DECISIONS.md#décisions-du-30-10-2026-après-midi-sur-le-coût-prévu-et-les-heures-prévues-du-chantier)) ; méthode gardée dans le code, sans paramètre, comme le reste de B-39 (montants, validés comptablement par Nelson le 30-10-2026).
>
> **Code** = ce que le code fait. **Doc** = ce que la documentation dit. Les deux sont distingués chaque fois qu'ils diffèrent (section 5).
> Les **droits** (qui voit quoi, gardes de routes) relèvent d'un autre inventaire. Ici ne figurent que ceux qui traduisent un **choix d'organisation** (qui clôture, qui convertit, qui valide…), signalés « → droits ».
> **Aucune valeur métier nouvelle n'est proposée** : ni prix, ni commission, ni compte, ni délai, ni seuil. Les valeurs citées sont celles qui existent déjà dans le dépôt.

## 0. Vue d'ensemble

| Classe | Contenu | Volume |
|---|---|---|
| (A) Déjà paramétrable | `Parametres` (9 champs), `CompanySettings` (18 champs), `ParametresRemuneration` (8 champs, sans effet), module Planning, paramétrage comptable (comptes, règles, TVA), mentions légales et CGV versionnées, 6 référentiels, partage public du planning, organisation des comptes (→ droits), 9 variables d'environnement (8 côté serveur et `VITE_API_URL`) | 11 blocs |
| (B) En dur, à rendre paramétrable | qui fait quoi, rattachements obligatoires, durées et horaires, seuils et méthodes de calcul, listes de valeurs, étapes de cycle de vie, numérotation et modèles de documents, calendrier, affichage, identité | 75 entrées (B-01 à B-75) |
| (C) À garder dans le code | numérotation légale, immutabilité (triggers SQL), fiscalité et arrondis, intégrité métier décidée, invariants de droits, dates, plafonds techniques | 28 entrées (C-01 à C-28) |

Constats principaux :
- Plusieurs champs de `CompanySettings` sont **saisis mais sans effet** : `piedFacture`, `logoUrl`, `couleurSecondaire`, et toutes les coordonnées légales (SIRET, TVA, adresse…). L'émetteur imprimé sur la facture vient du **texte libre** de la version de mentions légales (`idx:1170-1171`).
- Une base neuve reçoit, **par migration**, les barèmes de commission d'une société précise (`mig/20260904210000_parametres_remuneration:26-37`). Ils sont sans effet depuis #159, mais contredisent la règle « aucune valeur de société dans le code » (`README.md:39`).
- La seule organisation réellement réglable porte sur la rentabilité (destinataires, seuils). Le reste de la répartition des rôles est écrit dans les gardes : qui clôture, qui convertit, qui crée une intervention, qui facture.
- Seul le **Planning** est un module activable. Les listes métier sont fermées, en code et parfois aussi par `CHECK` SQL : types de chantier, moyens de paiement, priorités, couvertures, natures de ligne.

---

## 1. (A) Paramètres existants

### 1.1 Table `Parametres` (singleton, `schema:330-372`)

- **Lecture** : `getParametres()` `idx:722-729`, qui crée la ligne au premier appel (`upsertSingleton` `idx:712-719`, `initDb` `idx:7967`).
- **Écriture** : `PUT /api/parametres` `idx:6788-6859`, garde `requireAuth` + `requireAdmin`. N'écrit jamais `planningActif`. Un champ absent du corps garde sa valeur.
- **Journal** : `journaliserAdministration`, type `PARAMETRES`, dans la même transaction (`idx:6843-6853`). Seuls les champs qui changent y figurent (`changementsJournal` `idx:4985-4997`).
- **Écran** : `cli/pages/Admin.tsx:990-1094`, onglet « Marges & Commissions » (administrateurs).

| Champ | Défaut (schéma) | Bornes | Lu dans le code | Modifié par | Journal | Écran |
|---|---|---|---|---|---|---|
| `margeCommercialeActive` | `true` (`schema:332`) | booléen strict (`idx:6793-6798`) | `computeChantierMetrics` `idx:972` (pas de marge si faux) ; estimation calculée seulement si actif (`idx:3297`, `idx:3348`) ; `/api/stats/global` `idx:7113` ; `/api/stats/conducteurs` `idx:7206` | `PUT /api/parametres` (admin) | oui | `Admin.tsx:1004` |
| `planningActif` | `true` (`schema:339`) | booléen | `requirePlanningActif` `idx:633-645` (le superadmin y échappe) ; `GET /api/modules` `idx:6866-6878` ; client `cli/modules.ts:48-63`, `cli/lib/menu.ts:47` | `PUT /api/modules` `idx:6882-6901` (**superadmin**) | oui, `MODULES` `idx:6894` | `Admin.tsx:1425-1460` (onglet Modules) |
| `tauxAcompteDefaut` | `30` (`schema:345` ; `mig/20260906140000_add_devis_lifecycle:19`) | 0 à 100 (`idx:6801-6807`) ; chaque devis fige son taux (`schema:481`) | `acompteDevisPayload` `idx:6277-6291` (création et modification d'un devis) ; duplication `idx:6648-6655` | `PUT /api/parametres` (admin) | oui | `Admin.tsx:1013-1014` (repli client 30) |
| `seuilMargeFaible` | `15` (`schema:350`) | `null` ou 0 à 100 (`idx:6811-6821`) ; `CHECK` `mig/20261013120000_alertes_suivi_chantiers:7-8` | `computeChantierMetrics` `idx:1025-1026` (alerte `MARGE_FAIBLE`) | idem | oui | `Admin.tsx:1027` |
| `joursSansSaisie` | `14` (`schema:351`) | `null` ou 1 à 365 (`idx:6822-6832`) ; `CHECK` même migration `:9-10` | `idx:965-968` (alerte `SANS_SAISIE`, chantiers `EN_COURS` seulement) | idem | oui | `Admin.tsx:1037` |
| `rentabiliteConducteur` | `true` (`schema:361`) | booléen | `voitRentabilite` `idx:442` ; garde du montant vendu `idx:3478` ; `/api/stats/conducteurs` `idx:7203` | idem | oui | `Admin.tsx:1065` |
| `rentabiliteHierarchie` | `true` (`schema:362`) | booléen | `voitRentabilite` `idx:443` | idem | oui | `Admin.tsx:1069` |
| `rentabiliteDirecteurs` | `true` (`schema:363`) | booléen | `voitRentabilite` `idx:439` | idem | oui | `Admin.tsx:1073` |
| `pasTempsPasseMinutes` (ajouté après l'analyse par le lot « devis au temps passé », décisions de Nelson des 24 et 25-10-2026, « Réglage société » et « Aucune, à régler ») | vide (migration `20261025120000_devis_temps_passe`) | `null` ou 15, 30, 45 ou 60 minutes par l'API (décision de Nelson de la nuit du 26 au 27-10-2026, appliquée par la première PR du lot « facture au temps passé », #348 : `lireReglagePasTempsPasse`, `domaines/devis/tempsPasse.ts`) ; `CHECK` de la même migration, de 1 à 60 minutes, gardé sans reprise (règle 4) ; chaque devis au temps passé fige son pas (`Devis.pasTempsPasseMinutes`) | `reglagesTempsPasseDuDevis` (création et modification d'un devis au temps passé, refus 409 tant qu'il est vide ou qu'il n'est plus admis) ; duplication (`domaines/devis/routes.ts`) | `PUT /api/parametres` (admin) | oui | `cli/components/ReglageTempsPasse.tsx` (onglet « Marges & Commissions ») |
| `tempsMinimumMinutes` (ajouté après l'analyse par la première PR du lot « facture au temps passé », #348, décisions de Nelson de la nuit du 26 au 27-10-2026, points 8 et 9) | 60 minutes (migration `20261028120000_temps_passe_minimum`) | multiple de 15 minutes, de 15 minutes à 8 heures ; vidé, il revient à 60 (`lireReglageTempsMinimum`, `domaines/devis/tempsPasse.ts`) ; `CHECK` même migration ; chaque nouveau devis au temps passé le fige (`Devis.tempsMinimumMinutes`, vide pour un devis antérieur) | `reglagesTempsPasseDuDevis` (création et modification d'un devis au temps passé) ; duplication (`domaines/devis/routes.ts`) ; quantité de la ligne au temps passé (`exigerQuantiteTempsPasse`, et vérification en base à la validation) ; mention (`mentionTempsPasse`) | `PUT /api/parametres` (admin) | oui | `cli/components/ReglageTempsPasse.tsx` (onglet « Marges & Commissions ») |
| `journalConservationJours` | `90` (`schema:368`) | 1 à 90 (`idx:7023`) ; `CHECK` `mig/20261015120000_journal_administration:6` | `purgerJournalAdministration` `idx:5003-5005` (repli 90), au démarrage `idx:7971` et à chaque consultation ou export `idx:6958`, `idx:6995` ; trigger `proteger_journal_administration` (`mig/20261015120000…:45-59`) | `PUT /api/journal-administration/conservation` `idx:7020-7039` (**superadmin**) | oui, `CONSERVATION_JOURNAL` `idx:7032` | `cli/components/JournalAdministration.tsx:273` (onglet Journal) |

### 1.2 Table `CompanySettings` (identité de l'instance, singleton, `schema:406-431`)

- **Lecture** : `getCompanySettings()` `idx:869-875` ; `GET /api/company` `idx:6665-6671` (tout compte connecté) ; `GET /api/v1/company` `idx:5558-5564` (scope `company:read`).
- **Écriture** : `PUT /api/company` `idx:6673-6694`, garde `requireSuperAdmin`. Validation `companySettingsPayload` `idx:781-802` : texte de 2 000 caractères au plus, couleurs `#RRGGBB`, fuseau pris dans la liste `FUSEAUX_HORAIRES_FRANCAIS`.
- **Journal** : type `SOCIETE`, `idx:6684-6685`.
- **Écrans** : `cli/pages/Societe.tsx` (route `/societe`, `cli/App.tsx:180-183`). Un admin la consulte, seul un superadmin la modifie (`cli/App.tsx:91-93`). Le fuseau, lui, ne se règle **que** dans `cli/pages/Admin.tsx:974-990`, onglet « Société » (superadmin).

| Champ | Défaut | Ce que le code en fait |
|---|---|---|
| `raisonSociale`, `nomCommercial` | `null` | Nom affiché en tête de menu (`cli/companyTimezone.tsx:30`). **Pas imprimés sur la facture** : l'émetteur vient du texte `mentions` de la version légale (`idx:1170-1171`) |
| `siret`, `tvaIntra`, `adresse`, `codePostal`, `ville`, `telephone`, `email`, `siteWeb` | `null` | Stockés et exposés par l'API ; **aucun usage côté serveur** (recherche sans résultat dans `idx`) |
| `pays` | `'France'` (`schema:415`) | idem |
| `logoUrl` | `null` | **aucun usage** |
| `couleurPrimaire` | `'#1e3a8a'` (`schema:420`) | Couleur du titre du PDF de facture (`idx:1153-1159`, même repli) |
| `couleurSecondaire` | `'#f59e0b'` (`schema:421`) | **aucun usage** |
| `prefixeFacture` | `null` | Numéro de facture (`idx:2067-2069`) : repli `'F'`, mis en majuscules, caractères hors `[A-Z0-9-]` retirés. Contrôle non bloquant du « Prêt à facturer » (`idx:1502`, `idx:1508`) |
| `prefixeAvoir` | `null` | Numéro d'avoir (`idx:2121`, `idx:2199`), repli `'A'` |
| `piedFacture` | `null` | **aucun usage** : le PDF imprime les CGV, pénalités et escompte de la version légale (`idx:1192-1195`) |
| `fuseauHoraire` | `'Europe/Paris'` (`schema:428`) ; liste fermée de 12 fuseaux français (`idx:736-741`) | Jour civil de l'entreprise : `contexteSuivi` `idx:894`, création de facture `idx:1423`, date et année des avoirs `idx:2116-2119` et `idx:2194-2197`, règlements `idx:2282-2283`, année des références d'intervention `idx:2534-2535` et `idx:2600-2604`, date de clôture `idx:3624-3625`, planning public `idx:4722`, numéro de devis `idx:6293-6294`, conversion `idx:6460-6461`, filtres du journal `idx:6920`, statistiques `idx:7056-7057`, `idx:7321-7323`… Client : `cli/companyTimezone.tsx:13-49` |

### 1.3 `ParametresRemuneration` (singleton, `schema:1030-1052`) et données liées — sans effet sur les montants

- **Défauts du schéma** : barèmes JSON sans défaut, `libelleBaremeReduit = 'Barème réduit'` (`schema:1039`), objectifs et primes à 0 (`schema:1042-1048`).
- **Code** : la migration `mig/20260904210000_parametres_remuneration:26-37` insère dans toute base neuve les valeurs d'une société :
  - barème standard 16 / 20 / 25 % et barème réduit 8 / 10 / 12,5 %, plafonds 20 000 et 30 000 ;
  - objectifs 70 000 et 17 000 ;
  - primes 450, 450 et 250 ;
  - libellé « Dossier apporté par la société ».
  **Doc** : « aucune valeur de société dans le code » (`README.md:39-49`).
- **Lecture** : `getReglesRemuneration` `idx:7659-7673`. Seul `libelleBaremeReduit` sert encore (`GET /api/modules` `idx:6873`, `/api/stats/commerciaux` `idx:7812`, client `cli/modules.ts:17-26`). Le calcul utilise `remunerationNeutre()` (`idx:7723-7724`) : aucune commission.
- **Écriture** : `PUT /api/parametres/remuneration` `idx:6748-6783` (superadmin), avec `validerBareme` `idx:6713-6740` (20 tranches au plus, taux de 0 à 100) et un libellé de 80 caractères au plus. Lecture `GET` `idx:6700` (admin).
- **Journal** : `REMUNERATION`, `idx:6774`.
- **Écran** : `Admin.tsx:1094-1160`.
- **Liés** :
  - `Chantier.baremeReduit` (`schema:122`), case par chantier écrite par `PATCH /api/chantiers/:id` `idx:3499`, sans effet ;
  - `PrimeMensuelleCommercial.suiviAdministratif` : `PUT /api/commerciaux/:id/prime-mensuelle` `idx:5397-5432` (admin), journal `PRIME_COMMERCIAL`, plus d'écran.

### 1.4 Modules activables
- Un seul module : **Planning** (`planningActif`, voir 1.1).
- Le désactiver ferme les routes `/api/planning/*` et `PUT /api/interventions/:id/planning` (`idx:2951`, `idx:2981`, `idx:4440-4703`) aux comptes autres que superadmin, et masque le menu (`cli/lib/menu.ts:47`). Aucune donnée n'est supprimée.
- Les autres domaines ne sont pas activables : voir B-75.

### 1.5 Paramétrage comptable (plan vide au départ, `schema:751`)

| Objet | Contenu | Routes (garde) | Journal | Lu par | Écran |
|---|---|---|---|---|---|
| `CompteComptable` (`schema:752-763`) | Code de 3 à 12 chiffres ; natures ACTIF, PASSIF, PRODUIT, CHARGE, TVA (`idx:1523`) ; code immuable (trigger `compte_code_immutable`, `mig/20261009100000_modification_compte_comptable:37-45`) | `POST /api/comptabilite/comptes` `idx:1521` ; `PATCH` libellé et nature `idx:1573` ; activation `idx:1612` ; import CSV de 5 000 lignes au plus `idx:1710-1774` (tous `requireAdmin`, motif de 3 à 500 caractères) | Modification et activation : `JournalCompteComptable` (`idx:1566-1570`, `idx:1633-1637`) et trigger `compte_modification_journal`. **La création d'un compte n'est pas journalisée** (passation §4 : « à appliquer ») | `ecrituresPourPiece` `idx:1930-1980` | `cli/pages/Comptabilite.tsx` (`/comptabilite`, admin) |
| `RegleComptable` (`schema:786-795`) | Clés `CLES_COMPTABLES` : CLIENT, VENTE_PRESTATION, VENTE_ARTICLE, JOURNAL_VENTES (`idx:1483`) ; natures attendues `NATURES_ATTENDUES` `idx:1484` ; code journal de 8 caractères alphanumériques majuscules au plus (`idx:1786`) | `PUT /api/comptabilite/regles/:cle` `idx:1782` ; `DELETE` `idx:1827` (admin, motif, version attendue) | `JournalRegleComptable` et triggers de preuve (`mig/20261009120000_journal_regles_comptables`) | Émission `idx:1949-1970` ; « Prêt à facturer » `idx:1485-1513` | idem |
| `RegleTvaComptable` (`schema:832-840`) | Un taux, un compte de nature TVA | `PUT /api/comptabilite/tva/:taux` `idx:1883` ; `DELETE` `idx:1855` | idem | `idx:1959-1962` ; le taux 0 % n'exige pas de compte (`idx:1498-1501`) | idem |

### 1.6 Mentions légales et CGV (versionnées)
- **Modèle** : `MentionsLegalesVersion` `schema:727-738`. Champs `mentions`, `cgv` et `penalites`, tous obligatoires (`idx:2037`) ; `escompte` facultatif.
- **Routes** : création `POST /api/mentions-legales` `idx:2033-2042` ; publication `POST /api/mentions-legales/:version/publier` `idx:2018-2031`, qui ne fixe `publieeLe` qu'à la première publication ; lecture `idx:2044`. Garde : **`requireAdmin`**, alors que l'identité de la société exige un superadmin (B-20).
- **Journal** : aucun dans `JournalAdministration` (passation §4 : « à appliquer »). Une version publiée est immuable (trigger `mig/20261010120000_freeze_mentions_premiere_publication:2-17`).
- **Usage** : l'émission exige une version active publiée (`idx:2061-2062`) ; le PDF imprime son texte (`idx:1152-1195`).
- **Écran** : `cli/pages/MentionsLegales.tsx` (`/mentions-legales`, admin).

### 1.7 Référentiels tenus par la société

| Référentiel | Modèle | Routes et garde | Journal | Écran |
|---|---|---|---|---|
| Catégories d'achats | `Categorie` `schema:156-163` | `idx:4761-4802` : lecture par tout compte ; écriture `blockCommercial` + `blockTechnicien` | non | `Admin.tsx`, onglet Catégories |
| Fournisseurs | `Fournisseur` `schema:79-89` | `idx:4804-4845`, mêmes gardes | non | onglet Fournisseurs |
| Intervenants (nom, fonction, taux horaire chargé) | `Intervenant` `schema:238-252` | `POST` `idx:4205`, `PUT` `idx:4221`, `DELETE` `idx:4295` (admin) ; lien au compte `idx:4239` (admin) | Taux : **non** (passation §4 : « à appliquer »). Lien au compte : oui (`FICHE_INTERVENANT`, `idx:4268-4280`) | onglet Intervenants |
| Rattachement d'un intervenant à une main d'œuvre (lot « main d'œuvre au catalogue », décision de Nelson du 24-10-2026, « Liée à l'intervenant ») | `IntervenantMainOeuvre` (une ligne au plus par fiche ; clé étrangère composite vers une main d'œuvre, migration `20261024120000_main_oeuvre_catalogue`) | `PUT /api/intervenants/:id/main-oeuvre` (`requireAdmin`, session, `domaines/utilisateurs/rattachement-main-oeuvre.ts`) ; lu par l'administration seule (`GET /api/intervenants`) | oui (`JournalAdministration`, type `INTERVENANT`, action `RATTACHEMENT_MAIN_OEUVRE`), suppression de la fiche comprise | onglet Intervenants, colonne « Main d’œuvre (prix de vente) » |
| Types d'événement du planning (libellé, couleur) | `PlanningEventType` `schema:1198-1207` | `idx:4569-4615` (`blockCommercial`, `blockTechnicien`, `requirePlanningActif`) | non | `cli/pages/Planning.tsx:757-860` (modale Types) |
| Catalogue : prestations, articles, équipements, et catégories hiérarchiques | `schema:1082-1160` | `routeMixte` `idx:6052-6057` (garde par défaut `requireAdmin` `idx:361` ; v1 : `catalogue:write`) ; payload `idx:5897-5932` | non | `cli/pages/Catalogue.tsx` (`/catalogue`, admin) |
| Mains d'œuvre en prix de vente (lot « main d'œuvre au catalogue », décisions de Nelson du 24-10-2026, « Dans le catalogue » et « Par main d'œuvre ») : prestations marquées `estMainOeuvre`, prix à l'heure hors contrat (`prixVenteHt`), au forfait jour hors contrat, à l'heure et au forfait jour sous contrat, heures par jour ; depuis la troisième PR du lot « budget et heures prévues du chantier » (#379, réponse de Nelson du 30-10-2026, « Prix à part »), prix facultatifs de la demi-journée hors contrat et sous contrat ; paramétrage vide au départ, aucun tarif livré | `CataloguePrestation` (contraintes `CataloguePrestation_main_oeuvre_check`, migration `20261024120000_main_oeuvre_catalogue`, et `CataloguePrestation_demi_journee_check`, migration `20261030230000_forfait_main_oeuvre_devis`) | mêmes routes que les prestations ; écriture d'une main d'œuvre : administration en session seulement, aucune clé d'intégration (403) ; lecture `catalogue:read` (`domaines/catalogue/main-oeuvre.ts`) | oui (`JournalAdministration`, type `MAIN_OEUVRE` : création, modification, désactivation, réactivation, passage en main d'œuvre et retour) | `cli/pages/Catalogue.tsx`, onglet « Main d’œuvre » (`cli/components/CatalogueMainOeuvre.tsx`) : création, modification des prix (demi-journée comprise) et des heures par jour, désactivation, réactivation |

Les valeurs proposées par défaut à la création d'une fiche relèvent de B : unité « unité » et TVA 20 (B-49, B-50) ; le prix de vente initial à 0 n'a pas d'entrée B (valeur technique d'un champ obligatoire). Une main d'œuvre n'a pas de prix par défaut : ses quatre prix et ses heures par jour sont obligatoires (choix par défaut, à confirmer, passation §4), ses deux prix de la demi-journée facultatifs, vides sans saisie (une main d'œuvre sans prix de la demi-journée ne se vend pas à la demi-journée ; choix par défaut, à confirmer, #379) ; son unité est l'heure (choix par défaut, à confirmer).

### 1.8 Partage public du planning
- **Modèle** : `PlanningPublicShare` `schema:1186-1193` ; un lien à la fois, actif ou non.
- **Routes** : `GET`, `POST` et `PATCH /api/planning/share` `idx:4642-4703` (`requireAdmin`, `requirePlanningActif`).
- **Journal** : `PARTAGE_PLANNING`, `idx:4666-4670` et `idx:4691-4694`.
- **Écran** : `cli/components/PlanningShareModal.tsx:34`.

### 1.9 Organisation des comptes (→ droits, pour mémoire)
- **Réglages par compte** :
  - type de compte (`ALLOWED_ROLES` `idx:3708`) ;
  - responsable hiérarchique (`idx:3970-4020`) ;
  - « aussi commercial » (`idx:4026-4053`) ;
  - accès finance (`idx:4089`, superadmin) ;
  - permissions individuelles (`idx:4057`, superadmin) ;
  - activation (`idx:4120`) ;
  - fiche intervenant (`idx:4239`).
- **Journal** : tous ces réglages sont journalisés (DROITS / COMPTE).
- **Clés d'intégration** : `idx:5488-5554` (superadmin, entrées de journal réservées au superadmin).
- **Écrans** : Administration > Utilisateurs ; `cli/pages/ApiKeys.tsx`. Le détail relève de l'inventaire des droits.

### 1.10 Variables d'environnement de l'instance (sans écran ni journal)
`SUPERADMIN_EMAILS` (`idx:7919`), `BREAK_GLASS_EMAIL` et `BREAK_GLASS_TOKEN` (`idx:3112-3115`), `AZURE_TENANT_ID` et `AZURE_CLIENT_ID` (`idx:59-61`), `JWT_SECRET` (`idx:46-55`), `PORT` (`idx:30`), `NODE_ENV`, `VITE_API_URL` (`cli/api.ts:6`). Liste incomplète à cette date (`DATABASE_URL`, lue par Prisma, y manque). La liste exhaustive et tenue à jour est depuis #263 dans [`CONFIGURATION-ENVIRONNEMENT.md`](CONFIGURATION-ENVIRONNEMENT.md) (règle permanente 3).

### 1.11 Préférence par compte
`User.theme` (`schema:22`), réglée par `PUT /api/me/theme` (`idx:3217-3230`).

---

## 2. (B) Règles en dur qui pourraient varier d'une entreprise à l'autre

Pour chaque entrée : où elle se trouve, la valeur actuelle, le comportement du code, et pourquoi elle dépend de l'organisation. Les entrées marquées « montants » touchent un calcul financier : leur paramétrage relève de l'arbitrage de Nelson et du cabinet.

### 2.1 Qui fait quoi : choix d'organisation (→ droits)

| ID | Règle | Où (fonction ou constante) | Code actuel | Pourquoi cela varie |
|---|---|---|---|---|
| B-01 | Clôture d'une affaire | `peutCloturerChantier` `idx:539-546` ; `PATCH /api/chantiers/:id/statut` `idx:3588-3633` | Administration et directeurs sur tout chantier ; titulaire s'il n'est pas technicien ; compte Responsable dont la branche contient le titulaire technicien. Non-admin : passage `EN_COURS` → `TERMINE` seulement (`idx:3613`). Clôture non journalisée (à vérifier) | La clôture vaut réception ou fin de facturation dans certaines sociétés et revient alors à la direction ou à la comptabilité ; d'autres la laissent au chef de chantier |
| B-02 | Réouverture d'une affaire close | `idx:3613-3615` | Administration seule | Peut relever d'un responsable de service |
| B-03 | Conversion devis → chantier | `convertirDevis` `idx:6450-6519`, garde `devis:write` ; champs d'ouverture (titulaire, commercial, types, date) réservés à l'admin (`idx:6454-6456`) | Tout porteur de `devis:write`. Par défaut ADMIN, COMMERCIAL, ASSISTANTE_COMMERCIALE, COMPTABLE, DIRECTEUR_COMMERCIAL (`DEFAULT_USER_PERMISSIONS` `idx:219-230`). La conversion n'a pas d'auteur journalisé (passation §4) | Qui ouvre l'affaire (ADV, conduite de travaux, direction) dépend de l'organisation |
| B-04 | Enregistrement de l'accord du client sur un devis | `signerDevis` `idx:6347-6363`, route `idx:6369` (`devis:write`, session humaine) | Signataire en texte libre, de 2 à 200 caractères. L'écran propose les contacts `estSignataire` ou une saisie libre (`cli/pages/Devis.tsx:201-204`) | Habilitation de qui recueille l'accord ; obligation, ou non, d'un signataire habilité du client |
| B-05 | Statut d'un devis : envoyer, refuser, attendre l'acompte | `changerStatutDevis` `idx:6391-6409` | `devis:write` | Validation interne éventuelle avant envoi |
| B-06 | Constatation de l'acompte | `POST /api/devis/:id/acompte` `idx:6552` | `requireAdmin` | Comptabilité, ADV ou direction |
| B-07 | Annulation d'un devis et de son chantier | `POST /api/devis/:id/annulation` `idx:6592-6635` | `requireAdmin`. Motif non vide, sans longueur minimale : ailleurs, 3 à 500 caractères (à vérifier) | Délégation possible à un responsable |
| B-08 | Création d'une intervention SAV | `POST /api/interventions` `idx:2576-2578` | Admin ou `CONDUCTEUR_TRAVAUX` seulement : le compte Responsable est exclu. Écran : `cli/pages/Interventions.tsx:51`, `:198` | Selon la société, le SAV est ouvert par un standard, un assistant, un responsable SAV ou un technicien |
| B-09 | Transitions d'une intervention | `PATCH /api/interventions/:id/statut` `idx:2913-2947` | Technicien : démarrer ou terminer seulement (`idx:2931`). Autres comptes, hors commercial et directeur : toutes les transitions de leur périmètre | Qui annule, qui planifie |
| B-10 | Saisie des coûts SAV | heures `idx:2742` ; matériel `idx:2658`, `idx:2768` ; éligibilité `interventionCoutEligible` `idx:2666-2668` | Heures : technicien affecté seulement (l'encadrement ne saisit pas à sa place). Matériel : admin ou conducteur. Interventions hors contrat ou d'un contrat `ACTIF` (heures : lot 3b, décision du 17-10-2026 ; matériel : lot « matériel d'une intervention curative », #357, décisions des 28 et 29-10-2026, non validé pour mise en service) | Saisie pour autrui, ou par le bureau |
| B-11 | Planification (affectations, placement SAV, types d'événement) | `idx:2981`, `idx:4471-4615` (`blockCommercial` + `blockTechnicien` + `requirePlanningActif`) | Admin, conducteur, responsable et les autres types non exclus | Un responsable planning dédié, ou non |
| B-12 | Contrats de maintenance : création, couverture, statut, génération, échéance | `idx:2376-2573` (`requireAdmin`) ; menu `cli/lib/menu.ts:53` | Administration seule | Un responsable maintenance, ou l'ADV |
| B-13 | Facturation : brouillon, émission, avoirs, annulation | `idx:1415`, `idx:2051`, `idx:2099`, `idx:2157` (`requireAdmin`) | Administration seule ; `accesFinance` n'ouvre pas ces routes | Comptabilité interne ou externe, ADV |
| B-14 | Règlements : saisie et contre-passation | `idx:2255`, `idx:2338` (`requireAdmin`) | Administration seule (choix par défaut, passation §4) | Comptabilité |
| B-15 | Case « Encaissé » du chantier | `PATCH /api/chantiers/:id/encaisse` `idx:5380-5391` | Admin ; non journalisée ; `dateEncaissement` est un instant, pas une date civile | Décision A3 : elle se déduira des règlements (prévu) |
| B-16 | Modification de la fiche chantier par son titulaire | `idx:3430-3499` | Un conducteur titulaire modifie le nom, la référence, **le titulaire** (il peut transférer son chantier), les budgets, les dates, l'adresse, les types et le barème réduit. Le montant vendu seulement s'il suit la rentabilité (`idx:3478`) | Degré d'autonomie du conducteur |
| B-17 | Réattribution du commercial d'un chantier | `idx:3639-3669` | Admin ou titulaire | Peut relever de la direction commerciale |
| B-18 | Saisie Travaux après clôture | `assertChantierWritable` `idx:4854-4882` (`idx:4877-4880`) | Non-admin : chantier `EN_COURS` seulement. Admin : tout statut sauf `ANNULE` | Factures fournisseurs tardives saisies par le conducteur, ou non |
| B-19 | Tenue des référentiels d'achats | `idx:4764-4845` | Côté API, tout compte sauf commercial, directeur et technicien : admin, conducteur, responsable, et aussi assistante, comptable et directeur commercial. Le menu les ouvre via `peutOuvrirAdministration` (`cli/lib/droits.ts:90-92`) | Centralisation des achats, ou non |
| B-20 | Niveau d'habilitation des documents légaux | mentions `idx:2018`, `idx:2033` (admin) ; identité `idx:6673` (superadmin) | Les mentions et CGV imprimées sont écrites par un admin ; l'identité, par un superadmin | Choix de gouvernance |
| B-21 | Répartition admin / superadmin des réglages | `idx:6788` (marges, acompte, alertes, rentabilité : admin) ; `idx:6882`, `idx:6748`, `idx:7020` (modules, rémunération, conservation : superadmin) | Fixée dans le code | Choix de gouvernance |

### 2.2 Rattachements et obligations

| ID | Règle | Où | Code actuel | Pourquoi cela varie |
|---|---|---|---|---|
| B-22 | Titulaire obligatoire, et qui peut l'être | `refusTitulaire` `idx:3263-3267` ; `ouvertureChantier` `idx:6426-6433` ; `/api/conducteurs` `idx:4181-4192` ; `cli/pages/ChantierDetail.tsx:1394-1397` ; `cli/components/OuvrirChantierAffaire.tsx:170-172` | Obligatoire à la modification. La conversion depuis l'écran Devis peut le laisser vide, et le chantier reste alors invisible aux conducteurs (`idx:3276-3278`). L'écran propose les seuls `CONDUCTEUR_TRAVAUX` actifs ; le serveur accepte tout compte actif | Titulaires possibles : chef d'équipe, technicien, responsable |
| B-23 | Commercial obligatoire | `refusCommercial` `idx:3268-3274` ; écran `ChantierDetail.tsx:1401-1407` | Obligatoire dès qu'**un** compte commercial existe, inactifs compris côté serveur, actifs seulement à l'écran | Sociétés sans fonction commerciale, ou affaires sans vendeur |
| B-24 | Acompte bloquant et base de calcul | `convertirDevis` `idx:6474`, `idx:6481` ; `schema:340` ; écran `Admin.tsx:1018` (« % du TTC ») ; constatation `idx:6563` | Un acompte exigé bloque l'ouverture du chantier tant qu'il n'est pas constaté. Taux exprimé en % du TTC. Le montant constaté est libre, sans contrôle par rapport au taux (montants) | Politique d'acompte : bloquante ou indicative, base HT ou TTC |

### 2.3 Durées, délais, horaires

| ID | Règle | Où | Valeur actuelle | Pourquoi cela varie |
|---|---|---|---|---|
| B-25 | Durée proposée pour placer une curative | `DUREE_CURATIVE_MINUTES` `cli/pages/Planning.tsx:35`, utilisée `:475` | 60 min, modifiable avant confirmation (choix par défaut appliqué par #166) | Durée type d'un dépannage selon le métier |
| B-26 | Heure de début proposée au placement d'une intervention | `cli/pages/Planning.tsx:474` | 09:00 | Horaires de l'entreprise (lot (j)) |
| B-27 | Plage proposée pour le créneau « heures précises » ; créneau par défaut | `cli/pages/Planning.tsx:726`, `:730` ; `:512` ; serveur `validatePlanningEvent` `idx:4391` | 08:00 à 12:00 ; créneau `JOURNEE` | Horaires de l'entreprise |
| B-28 | Créneaux sans horaires associés | `PLANNING_CRENEAUX` `idx:4350` | JOURNEE, MATIN, APRES_MIDI, HEURES ; « matin » et « après-midi » sans définition horaire | Horaires de l'entreprise |
| B-29 | Aucune affectation ne passe minuit | `parsePlanningHeure` `idx:4360-4363`, fin > début `idx:4398` ; `cli/pages/Planning.tsx:448-452` | Interdit | Travail de nuit et astreintes (lot (j)) |
| B-30 | Contrat : périodicité, durée de visite, titre, date de début | bornes `idx:2402-2404` ; propositions `cli/pages/ContratsMaintenance.tsx:148-149` | Périodicité proposée 12 mois, bornes 1 à 60 mois ; durée proposée 60 min, bornes 15 à 1 440 min ; titre de 3 à 200 caractères ; début proposé : le jour de la société | Cadences et durées types du métier |
| B-31 | Couverture contractuelle par défaut | `lirePolitiqueCouverture` `idx:1082-1092` (`idx:1083-1084`) ; `schema:857-858` ; `cli/pages/ContratsMaintenance.tsx:150` | Main-d'œuvre et matériel `HORS_FORFAIT` | Offre type de la société |
| B-32 | Génération des visites de maintenance | `POST …/generer-intervention` `idx:2520-2573` ; `…/avancer-echeance` `idx:2493-2518` | Action manuelle, sur l'échéance courante, sans anticipation. Dates de demande et souhaitée = échéance (`idx:2545`). L'échéance n'avance qu'après une visite `TERMINEE` (`idx:2499-2503`). **Doc** : A9 décide une génération quotidienne avec anticipation paramétrable (passation §2, lot 5, prévu) | Délai de prévenance et fenêtre de réalisation propres à chaque contrat ou société |
| B-33 | Dates posées automatiquement sur un chantier | conversion `idx:6461` ; clôture `idx:3621-3626` | Début = jour de la conversion ; fin = jour de la clôture si elle n'a pas été saisie | Date de démarrage réelle, date de réception |
| B-34 | Échéance de facture | `POST /api/factures` `idx:1421` ; `cli/pages/Factures.tsx:451-452` | Aucun délai par défaut. L'écran préremplit l'émission **et** l'échéance au jour même ; le serveur exige seulement échéance ≥ émission | Conditions de paiement de la société, dans les limites légales (C-09) |
| B-35 | Règles de saisie des règlements (dans la proposition, les règles de date sont reclassées en C-06 bis) | `idx:2283`, `idx:2300`, `idx:2310`, `idx:2312-2314` ; répartition `cli/lib/reglements.ts:28-42`, ordre `idx:1336` | Date au plus tard le jour même, au plus tôt l'émission de chaque facture. Un paiement antérieur relève de l'acompte. Facture soldée par avoir refusée. Surplus refusé tant qu'une autre facture du règlement reste due. La répartition automatique commence par l'échéance la plus ancienne et place le surplus sur la dernière (choix par défaut, passation §4 ; montants) | Pratiques d'imputation de la comptabilité |

### 2.4 Seuils, alertes, méthodes de calcul

| ID | Règle | Où | Code actuel | Pourquoi cela varie |
|---|---|---|---|---|
| B-36 | Alertes de dépassement sans tolérance | `computeChantierMetrics` `idx:952-954`, `idx:987` | `HEURES_DEPASSEES`, `MATERIEL_DEPASSE` et `MAIN_OEUVRE_DEPASSEE` dès que le réel dépasse le vendu ; `EN_PERTE` si la marge est négative | Tolérance d'alerte propre à chaque société (montants) |
| B-37 | Seuils visuels des jauges | `fillColor` `cli/components/ProgressMeter.tsx:9-14` | « Proche de la limite » à partir de 85 %, « dépassé » au-delà de 100 % | Seuil d'attention |
| B-38 | Délai sans saisie en jours civils | `joursEntre` `idx:921-923` ; `idx:965-966` | Jours civils, week-ends compris, chantiers `EN_COURS` seulement. Sans aucune saisie, le délai court depuis le début du chantier | Jours ouvrés de l'entreprise (lot (j)) |
| B-39 | Méthode de la marge estimée | `contexteSuivi` `idx:892-911` ; `idx:1003-1027` | Coût horaire de référence : celui réellement appliqué sur le chantier, sinon la moyenne pondérée de la société (`idx:897-900`), sinon le budget main-d'œuvre. Matériel : ratio d'achat des chantiers `TERMINE` (`idx:901-907`), sinon 1, c'est-à-dire le prix de vente (`idx:1015-1017`). (montants) | Méthode d'estimation retenue par la direction |
| B-40 | Ventilation du vendu à la conversion | `idx:6497-6499` | Matériel = lignes `FOURNITURE` ; main-d'œuvre = le reste ; heures vendues = heures prévues des lignes `MAIN_OEUVRE` du devis : durée indicative de la prestation du catalogue qui n'est pas une main d'œuvre × quantité, 0 sans durée, même vendue à l'heure (lecture retenue de « Durée indicative », à confirmer), 0 aussi pour un article ou un équipement passé en main-d'œuvre (choix par défaut, à confirmer) ; la quantité pour une main d'œuvre à l'heure, une ligne au temps passé ou une ligne saisie à la main (seconde PR du lot « budget et heures prévues du chantier », #376), ainsi que pour une ligne enregistrée avant le lot (choix par défaut, à confirmer) ; une ligne de main d'œuvre au jour compte les heures par jour de sa main d'œuvre, une ligne à la demi-journée leur moitié, copiées à l'ajout en minutes prévues par unité (décision de Nelson de la nuit du 26 au 27-10-2026, point 16 ; troisième PR du lot, #379 ; montants) | Unités de vente propres à la société |
| B-41 | Définition des indicateurs des conducteurs | `/api/stats/conducteurs` `idx:7223`, `idx:7231-7233`, `idx:7256` ; répartition `idx:7414-7415` | « Objectifs respectés » = heures réalisées ≤ heures vendues **et** matériel ≤ budget. Manque à gagner = heures en trop × taux moyen. Classement par marge | Indicateurs de pilotage choisis par la direction |
| B-42 | Mesure de l'assiduité | `JOURS_OUVRES` `idx:7314` ; `weekBoundsFrom` `idx:7299-7312` ; `idx:7330`, `idx:7357` ; `HOUR_RANGE` `cli/pages/Performances.tsx:9` | Semaine du lundi au vendredi ; mesurée sur l'**instant de saisie** (`createdAt`) ; heures affichées de 6 h à 19 h | Jours et horaires travaillés |
| B-43 | Rattachement mensuel du CA et de la marge commerciale | `dateClotureChantier` `idx:7708-7711` ; `idx:7741-7744` | Chantier `TERMINE` et encaissé, rattaché au mois **UTC** de sa date de clôture, avec repli sur `updatedAt` (lot (i)) | Fait générateur et jour de coupure (A5, questions §3) |

### 2.5 Listes de valeurs fermées

| ID | Liste | Où | Valeurs actuelles | Pourquoi cela varie |
|---|---|---|---|---|
| B-44 | Types de chantier | `TYPES_CHANTIER` `idx:3253` et `sanitizeTypes` `idx:3254-3257` ; statistiques `idx:7580` ; doublon client `cli/chantierTypes.ts:3` | Vidéo, Alarme, Contrôle d'accès, Interphonie, Câblage réseau | Liste propre au métier de la sûreté ; une autre entreprise technique a d'autres activités |
| B-45 | Moyens de règlement | `MOYENS_REGLEMENT` et `LIBELLES_MOYEN_REGLEMENT` `idx:1245-1246` ; `CHECK` `mig/20261016120000_reglements:21` ; client `cli/lib/reglements.ts:4-10` | Virement, chèque, carte, prélèvement, espèces. **Doc cible** : « liste paramétrable » (`docs/MODELE-DONNEES-CIBLE.md:30`) | Moyens acceptés par la société (traite, LCR, plateformes…) |
| B-46 | Priorités d'intervention | `idx:2584-2586` ; `schema:898` ; `cli/pages/Interventions.tsx:25`, `:208` | BASSE, NORMALE, HAUTE, URGENTE ; NORMALE par défaut ; **aucun effet** (pas de délai associé ; la file est triée par date due, `idx:2967`) | Niveaux de service et délais d'intervention contractuels |
| B-47 | Politiques de couverture d'un contrat | `POLITIQUES_MAIN_OEUVRE` et `POLITIQUES_MATERIEL` `idx:1074-1075` ; `CHECK` `mig/20260925100000_add_contrat_couverture_figee:9-11` | INCLUSE ou HORS_FORFAIT ; INCLUS ou HORS_FORFAIT | Formules de contrat (pièces plafonnées, déplacement…) |
| B-48 | Natures de ligne | Devis : `idx:6103`, `idx:6110`, `CHECK` `mig/20261017120000_catalogue_devis:23`, `NATURE_DEVIS_PAR_FAMILLE` `idx:6142`. Facture : `idx:1447-1448`, `idx:1232-1233`, règles `VENTE_PRESTATION` et `VENTE_ARTICLE` `idx:1483`, `idx:1933-1936` | Devis : MAIN_OEUVRE ou FOURNITURE. Facture : PRESTATION ou ARTICLE. Deux vocabulaires, et une ventilation comptable limitée à deux natures. **Doc** : plan de comptes de vente « par famille d'articles/prestations » (`docs/INTEGRATIONS-M365-COMPTABILITE-FACTURATION-FR.md:41`) | Plan de comptes du cabinet (sous-traitance, location, déplacement…) |
| B-49 | Taux de TVA proposé par défaut | Ligne de devis `idx:6108` ; fiche catalogue `idx:5908` et `schema:1109`, `:1130`, `:1151` ; écrans `cli/pages/Devis.tsx:24`, `cli/pages/Factures.tsx:44`, `cli/pages/Catalogue.tsx:34` | 20 | Le taux usuel dépend de l'activité ; les taux légaux eux-mêmes relèvent de C-08 |
| B-50 | Unité par défaut | `idx:5918`, `idx:5924` ; `schema:1107`, `:1129` ; `cli/pages/Catalogue.tsx:35` | « unité » ; unités libres ensuite (40 caractères sur une ligne de devis, `idx:6110`) | Unités du métier (h, forfait, ml…) |
| B-51 | Type proposé pour un nouveau compte | `idx:3777` (repli si type invalide) ; `cli/pages/Admin.tsx:181` | CONDUCTEUR_TRAVAUX | Type de compte majoritaire (→ droits) |
| B-52 | Statut « brouillon » d'un contrat | `schema:851` ; `cli/pages/ContratsMaintenance.tsx:16` | Prévu dans les commentaires et les libellés, **jamais produit** : un contrat naît `ACTIF` (`idx:2417-2419`, défaut `schema:851`) | Circuit de signature d'un contrat |

### 2.6 Étapes de cycle de vie qui pourraient être facultatives (le squelette reste en C-17)

| ID | Règle | Où | Code actuel | Pourquoi cela varie |
|---|---|---|---|---|
| B-53 | Moment où le devis se fige | `modifierDevis` `idx:6315` ; `TRANSITIONS_DEVIS` `idx:6375-6382` ; `signerDevis` `idx:6355` | Modifiable tant qu'il est BROUILLON ou ENVOYE et non signé. Retour ENVOYE → BROUILLON permis. Signature possible dès BROUILLON (refus seulement si ANNULE ou REFUSE). **Doc vision** : figé dès l'émission (`docs/PRODUCT-VISION-ERP-TECHNIQUE.md:40`) ; question ouverte (passation §3) | Pratique commerciale et preuve |
| B-54 | Révision réservée au devis signé | `creerRevision` `idx:6331` | Seul un devis signé ouvre une révision | Versionner dès l'envoi |
| B-55 | Fin d'intervention sans compte rendu signé | `idx:2913-2947` (aucun contrôle) ; compte rendu possible seulement `EN_COURS` (`idx:2876`) | Permis (choix par défaut, « à revoir au lot 3b », passation §4) | Exigence de bon d'intervention signé |
| B-56 | Passage automatique à PLANIFIEE | `idx:3010-3013` | Au premier placement dans le planning | Validation de la planification |
| B-57 | Étapes de la vision non modélisées | `idx:2916-2922` | Pas d'étapes « rapport à compléter » ni « à facturer / facturée ». **Doc** : `docs/PRODUCT-VISION-ERP-TECHNIQUE.md:58` | Circuit SAV → facturation |

### 2.7 Numérotation et modèles de documents

| ID | Règle | Où | Code actuel | Pourquoi cela varie |
|---|---|---|---|---|
| B-58 | Format des numéros, hors préfixe | Facture `idx:2069` ; avoir `idx:2122`, `idx:2200` ; devis et affaire `nouveauNumeroDevis` `idx:6292-6297` et `FORMAT_NUMERO_DEVIS` `idx:652` ; intervention `idx:2539`, `idx:2618` ; séquences annuelles `schema:740-749`, `:872-875`, `:967-970` | Facture `<préfixe><AAAA>-<NNNN>`. Avoir idem (préfixe `A` par défaut). Devis `A<AA>-<NNNN>`, sans préfixe paramétrable. Intervention `I<AA>-<NNNN>`. Quatre chiffres, tiret, remise à zéro chaque année civile. Seuls les préfixes facture et avoir sont paramétrables. **Doc** : « numérotation des documents » dans le centre d'administration (`docs/ADMINISTRATION-DOCUMENTS-EMAILS.md:8`). Le préfixe d'avoir par défaut (`A2026-…`) et la référence d'affaire (`A26-…`) commencent par la même lettre | Convention de la société et reprise d'une numérotation de devis. La continuité de la séquence reste en C-01 |
| B-59 | Modèle du PDF de facture | `rendreDocumentFacturePdf` `idx:1124-1198` | Format A4, marge 48, polices standard, colonnes et libellés fixes ; ni logo, ni pied de page, ni couleur secondaire. **Doc** : modèles par défaut personnalisables par blocs, avec logo et pied (`docs/ADMINISTRATION-DOCUMENTS-EMAILS.md:15-27`) | Charte documentaire de la société |
| B-60 | Libellés générés pour une visite | `idx:2543-2544` | « Maintenance préventive — <titre> », « Intervention prévisionnelle issue du contrat. Durée prévue : N minutes. » | Vocabulaire de la société |
| B-61 | Format papier du rapport de chantier | `handleExportPDF` `cli/pages/ChantierDetail.tsx:439-448` | `letter` (format américain) | Format A4 attendu en France |
| B-62 | Format de l'export comptable | `idx:1986-2014` (colonnes `idx:2001`, fichier `export-ventes.csv` `idx:2012`) | Un seul CSV, un seul journal (`JOURNAL_VENTES`), non journalisé. **Doc** : format choisi pour le cabinet, journaux de ventes, de règlements et de banque, export journalisé (`docs/INTEGRATIONS-M365-COMPTABILITE-FACTURATION-FR.md:39-48`) | Logiciel du cabinet |

### 2.8 Calendrier et périodes

| ID | Règle | Où | Code actuel | Pourquoi cela varie |
|---|---|---|---|---|
| B-63 | Année et trimestres civils dans les statistiques | `periodBounds` `idx:7443-7469` | Année civile ; trimestres janvier-mars, avril-juin, etc. L'exercice social n'est pas pris en compte | Exercice décalé |
| B-64 | Week-end | `estWeekEnd` `cli/planningUtils.ts:45-48` ; `cli/pages/Planning.tsx:357` | Samedi et dimanche grisés ; pas de jours fériés | Jours travaillés (lot (j)) |
| B-65 | Planning public | `idx:4724-4728` ; `POLL_MS` `cli/pages/PlanningPublic.tsx:29` | Semaine en cours par défaut ; rafraîchissement toutes les 60 s | Préférence d'usage |
| B-66 | Période par défaut des écrans | `cli/pages/Dashboard.tsx:24` ; `cli/pages/Statistiques.tsx:152`, `:205`, `:256` ; `cli/pages/MesCommerciaux.tsx:37` ; `cli/pages/ResultatCommercial.tsx:26` ; serveur `idx:7053-7055`, `idx:7476`, `idx:7518`, `idx:7558`, `idx:7805-7807` | Mois (tableau de bord, fournisseurs, types, commerciaux) ; semaine (intervenants) | Rythme de pilotage |

### 2.9 Affichage, tri, valeurs proposées (faible enjeu)

| ID | Règle | Où | Valeur actuelle |
|---|---|---|---|
| B-67 | Ordre de gravité des alertes et tri par défaut des chantiers | `ALERTES_CHANTIER` `cli/lib/suiviChantiers.ts:9` ; `trierChantiers` `:113-138` ; `cli/pages/ListeChantiers.tsx:62-63` | EN_PERTE > MARGE_FAIBLE > HEURES > MAIN_OEUVRE > MATERIEL > SANS_SAISIE ; tri « À surveiller d'abord » |
| B-68 | Nombre de chantiers « à surveiller » au tableau de bord | `NB_A_SURVEILLER_AFFICHES` `cli/pages/Dashboard.tsx:76` | 5 |
| B-69 | Tailles de page et limites de liste | `cli/pages/Factures.tsx:68` ; `cli/pages/Reglements.tsx:26` ; `idx:2234` ; maximum `idx:1351`, `idx:2235` ; journal `idx:6909` ; clients `idx:5613` et `LIMITE_CLIENTS` `cli/components/SelecteurClient.tsx:8` ; catalogue du devis `idx:6223` | 25, 25 (maximum 100), 50, 200, 50. Factures et Devis tronquent la liste des clients à 200 sans le dire (#139) |
| B-70 | Tris côté serveur | interventions `idx:2648` ; contrats `idx:2379` ; file à planifier `idx:2967-2968` ; factures à régler `idx:1336` ; devis `idx:6306` | Par date souhaitée, échéance, date due, échéance, création décroissante |
| B-71 | Couleurs fixes | type d'événement `idx:4581` (et `cli/pages/Planning.tsx:670`, `:831`) ; `CHANTIER_COLORS` et `HORS_CHANTIER_COLOR` `cli/planningUtils.ts:82-83` ; `cli/pages/Statistiques.tsx:64-69` ; `cli/components/ProgressMeter.tsx:3-7` | `#f59e0b`, palettes fixes |

### 2.10 Identité et libellés en dur

| ID | Règle | Où | Code actuel |
|---|---|---|---|
| B-72 | Nom d'une société affiché | `cli/pages/Login.tsx:91` ; `cli/pages/PlanningPublic.tsx:135` ; favicons et `theme-color` `client/index.html:5-15` | « NØXIA GROUPE », icônes, `#002359` ; la même couleur est écrite en dur dans `cli/index.css:9` et `:22`, alors que `couleurPrimaire` n'agit que sur le PDF. Contraire à la règle « aucune valeur de société dans le code » (passation §1) |
| B-73 | Libellé de repli du barème réduit | `remunerationNeutre` `idx:7635` ; `cli/modules.ts:26` | « Barème réduit » (le libellé est déjà paramétrable, voir 1.3) |
| B-74 | Valeurs par défaut de rémunération insérées par migration | `mig/20260904210000_parametres_remuneration:26-37` | Barèmes et primes d'une société (voir 1.3), sans effet depuis #159 |

### 2.11 Modules

| ID | Règle | Où | Code actuel | Pourquoi cela varie |
|---|---|---|---|---|
| B-75 | Domaines non activables | `Parametres` `schema:330-372` (seul `planningActif`) ; `cli/lib/menu.ts:38-80` | Devis, SAV, contrats, Travaux (chantiers, achats, heures, rentabilité), facturation, règlements et catalogue sont toujours présents pour les rôles concernés | Périmètre réellement utilisé. Exemple : le pilote A1 porte sur le SAV et la maintenance, et la place de Travaux y est une question ouverte (passation §2) |

---

## 3. (C) À garder dans le code (légal ou intégrité)

Raison légale : les articles sont cités selon notre lecture, et **toujours à confirmer par le cabinet**.

| ID | Règle | Où | Raison |
|---|---|---|---|
| C-01 | Numérotation continue et chronologique des factures | Séquence annuelle `SequenceFacture` (`schema:740-743`, incrément `idx:2066`) ; numéro unique (`mig/20260908160000_add_factures:45`) ; numéro attribué à l'émission, jamais à un brouillon (`schema:568-569`, `idx:2051-2070`) ; chronologie, l'émission devant être datée au plus tôt de la dernière facture numérotée (`derniereDateFactureNumerotee` `idx:1319-1320`, `idx:2059-2060`, `idx:2078`) ; sérialisation par verrou consultatif (`verrouillerParametrageComptable` `idx:1543-1545`, `idx:2054`) | **Légale** : numéro unique fondé sur une séquence chronologique et continue (CGI, annexe II, art. 242 nonies A, selon notre lecture). La remise à zéro annuelle et l'année civile sont à confirmer par le cabinet. Seule l'API garantit la continuité : en SQL, seule l'unicité est vérifiée |
| C-02 | Séquence d'avoirs autonome, avoir daté du jour civil de la société | `schema:745-749` ; `idx:2116-2122`, `idx:2194-2200` | Légale et intégrité : un avoir ne consomme pas un numéro de facture. À confirmer par le cabinet |
| C-03 | Immutabilité de la facture émise | Triggers : `facture_identite_figee` (`mig/20261016120000_reglements:186-206`) ; `Facture_immutabilite_origine_emise` (dernière version `mig/20260914160000_add_avoirs_partiels:25-43`) ; `FactureVentilationTva_immutabilite_emise` (`mig/20260921120000_add_facture_ventilation_tva:27-42`) ; écritures scellées (`mig/20261007140000_facture_ecritures_figees:32-93`) ; adresse et raison sociale du client figées (`idx:2070`, `schema:576-579`) | Légale : document émis figé, correction par avoir (CLAUDE.md). **À vérifier** : `FactureLigne` n'a pas de trigger (seule l'absence de route de modification la protège) et `mentionsLegalesVersionId` ne figure pas dans les colonnes figées |
| C-04 | Correction par avoir | Annulation = avoir total `idx:2099-2152`, refusée s'il existe un avoir partiel ou un règlement (`idx:2109`, `idx:2113` ; trigger `mig/20261016120000_reglements:176-178`) ; avoirs partiels plafonnés par taux et au total (`idx:2185-2191`), taux présents sur l'origine (`idx:2168`) ; un seul avoir total par facture (`mig/20260914160000…:15`) | Légale et intégrité (montants validés) |
| C-05 | Devis signé figé | Triggers `mig/20261017120000_catalogue_devis:29-90` (lignes, contenu, signature, `TRUNCATE`) ; empreinte SHA-256 (`contenuDevisSigne` `idx:6247-6264`, `idx:6356`) | Intégrité et preuve de l'accord |
| C-06 | Règlements immuables, contre-passation, statut « réglée » déduit | Triggers `mig/20261016120000_reglements:66-182` ; `mig/20261017090000_statut_reglement_differe` ; `synchroniserStatutReglement` `idx:1294-1304` ; `reste_du_facture` (`mig/…reglements:57`) | Intégrité. Règles de montants validées par Nelson le 17-10-2026 |
| C-07 | Arrondis | TVA arrondie sur la base HT cumulée de chaque taux (`tvaDuTaux` `idx:1209-1213` ; `idx:1455-1457` ; `idx:6133`) ; arrondi commercial au centime d'une ligne, moitié vers le haut (`arrondiCommercialLigneHt` `idx:6077-6083`, `centimesTtcLigne` `idx:6085-6091`) ; coûts de main-d'œuvre SAV arrondis ligne par ligne (`totalHeuresInterventionAuCentime` `idx:2695-2702`) | Règle fiscale et comptable : à confirmer par le cabinet |
| C-08 | Taux de TVA et comptes TVA | Taux saisi entre 0 et 100, au centième (trois chiffres entiers au plus, deux décimales : `nombreDecimalNonNegatif(…, 3, true)`, `idx:1446-1448`, `idx:6108-6110`) ; compte TVA exigé par taux non nul pour émettre (`idx:1959-1970`) ; ventilation par taux (`schema:714-725`, `schema:831`) | Légale : taux fixés par la loi (taux normal : CGI art. 278, selon notre lecture). Le code ne vérifie pas que le taux saisi est un taux légal. Décision de Nelson de la nuit du 26 au 27-10-2026 : liste fermée de quatre taux, 0 % (autoliquidation), 5,5 %, 10 % et 20 %, au catalogue, sur les devis et sur les factures créées ensuite (lot « TVA française », implémenté par #364, voir les suites en tête ; mention d'autoliquidation, usage du 0 % et autres taux légaux à voir avec le cabinet, passation §3) |
| C-09 | Mentions obligatoires de la facture | Émission refusée sans version légale publiée et active (`idx:2061-2062`) ni adresse de facturation (`idx:2063-2064` ; PDF `idx:1376`) ; le PDF imprime numéro, dates, client, lignes, ventilation, mentions, CGV, pénalités, escompte (`idx:1160-1195`) et « FACTURE ANNULÉE » (`idx:1167`) | Légale (CGI art. 289 et annexe II art. 242 nonies A pour les mentions, selon notre lecture ; pénalités et indemnité de recouvrement : code de commerce, article à confirmer par le cabinet). Plafond légal des délais de paiement (B-34) : à confirmer par le cabinet. Le contenu des mentions est libre : à valider par le cabinet |
| C-10 | Date d'émission non future ; échéance ≥ émission | `dateEmissionEstFuture` `idx:770-772`, `idx:1424` ; `idx:1421` | Intégrité de la chronologie (à confirmer par le cabinet) |
| C-11 | Plafond des montants | `PLAFOND_MONTANT` `idx:1199` (9 999 999 999,99), utilisé `idx:1236`, `idx:1451`, `idx:1459`, `idx:2183`, `idx:2267`, `idx:6114`, `idx:6135` | Technique : colonnes `Decimal(12,2)` |
| C-12 | Écritures comptables | Équilibre et scellement (`ecrituresPourPiece` `idx:1930-1980` ; triggers `mig/20261007140000…`) ; un avoir reprend comptes et journal de l'origine (`idx:1939-1946`) ; plan comptable vide au départ ; journaux comptables en ajout seul (`mig/20260925120000_journal_activation_comptes:22-27`, `mig/20261009120000…:35-40`) | Intégrité comptable. Le contenu (comptes, journal) est paramétrable (A, 1.5) |
| C-13 | Format et lecture des dates | `dateIsoStricte` `idx:4884-4908` (JJ-MM-AAAA, ou AAAA-MM-JJ pour les champs natifs) ; `formatDateFacture` `idx:1120-1122` ; `cli/lib/dateFormatting.ts:18-25` ; jour civil au fuseau de la société (`jourCivilEntreprise` `idx:749-755`) ; dates seules stockées à minuit UTC (`dateSeuleEnJourCivil` `idx:774-779`) | Décision de Nelson (14-10-2026) et intégrité. La demande curative n'accepte que JJ-MM-AAAA (`dateDemandeCurative` `idx:4910-4915`) ; alignement prévu (passation §4) |
| C-13 bis | Choix du site de facturation | `SITE_FACTURATION_ORDRE` `idx:1111`, utilisé à l'émission (`idx:2063`) ; adresse ensuite figée sur la facture (`idx:2070`) | L'adresse de facturation est une mention obligatoire ; l'ordre de choix (site de facturation, principal, siège, nom) est une règle d'intégrité. Omission relevée par l'audit du 17-10-2026 |
| C-14 | Invariants de droits (→ droits) | `isLastSuperAdmin` `idx:3766-3771` (`idx:3837`, `idx:3932`, `idx:4137`) ; pas de suppression ni de désactivation de son propre compte (`idx:3826`, `idx:4134`) ; un admin ne gère pas un superadmin (`refuseSuperAdminTarget` `idx:3714-3718`) ; pas de suppression d'un compte auteur de données tracées (`idx:3842-3860`) ; un technicien ne reçoit jamais certains droits (`DROITS_INTERDITS_TECHNICIEN` `idx:243`) | Intégrité de la gouvernance et de la traçabilité |
| C-15 | Journaux en ajout seul | `JournalAdministration` : triggers `mig/20261015120000_journal_administration:35-67`, conservation de 1 à 90 jours (`CHECK` `:6`) ; journal des saisies, journal des factures (`mig/20260909180000_restrict_journal_facture`) | Traçabilité. La durée de conservation est réglable (A) ; le minimum est à faire trancher par le cabinet (passation §5) |
| C-16 | Un chantier par affaire ; affaire commencée non annulable ; client figé après facturation | Conversion unique (`DevisConversion` `schema:556-566` ; `idx:6472-6496`) ; annulation refusée s'il existe des saisies vivantes (`idx:6611-6619`) ; changement de client refusé si l'affaire est facturée ou porte une intervention SAV (`idx:3510-3526`) | Décisions de Nelson (14 et 16-10-2026) et intégrité des coûts |
| C-17 | Squelettes des cycles de vie et états terminaux | Facture : BROUILLON → EMISE → REGLEE ou ANNULEE (`schema:580`). Devis : `TRANSITIONS_DEVIS` `idx:6375-6382`. Intervention : `idx:2916-2922`. Contrat : `idx:2475` (TERMINE terminal, `idx:2474`). Chantier : EN_COURS, TERMINE, ANNULE (`idx:3593`, `idx:3609-3611`) | Intégrité. Les étapes facultatives relèvent de B-53 à B-57 |
| C-18 | Contrat et visites figés | Date de début et client du contrat immuables, date de demande figée (triggers `mig/20261007130000_intervention_date_demande:6-70`) ; couverture copiée sur la visite (`mig/20260925100000…:58-69`) | Intégrité contractuelle |
| C-19 | Coûts SAV figés | Taux appliqué immuable et champs communs (`mig/20260924120000_add_couts_intervention_contractuels:57-82`) ; taux des heures de chantier figé à la saisie (`idx:5253`) | Intégrité des montants |
| C-20 | Échéance contractuelle | `echeanceSuivante` `idx:4926-4933` ; `ajouterMoisUTC` `idx:4917-4924` | Conserve le jour contractuel (le 31 revient dès que le mois le permet) |
| C-21 | Facture rattachée à une origine ; « hors affaire » motivé | `idx:1433-1434` ; `CHECK` `mig/20260909130000_add_facture_origine:20-26` ; pas de facture d'une affaire annulée (`idx:1468`) | Traçabilité |
| C-22 | Client actif pour ouvrir un dossier | Facture `idx:1425`, intervention `idx:2587`, contrat `idx:2409` | Intégrité. La création d'un devis ne vérifie pas que le client est actif (`idx:6300`, à vérifier) |
| C-23 | Formats de contrôle | SIREN à 9 chiffres (`idx:826-827`) ; e-mail (`idx:804`) ; code comptable (`idx:1523`) ; code journal (`idx:1786`) ; heure HH:MM (`idx:4360-4363`) ; couleurs (`idx:735`) | Validation technique |
| C-24 | Semaine du lundi, numéro de semaine ISO | `lundiDe` `cli/planningUtils.ts:36-39` ; `numeroSemaineIso` `:53-59` ; `periodBounds` `idx:7465-7468` | Convention française (ISO 8601) |
| C-25 | Structures | Catégories de planning `PLANNING_CATEGORIES` `idx:4349` ; familles du catalogue `idx:5870-5880` ; rôles `ALLOWED_ROLES` `idx:3708` (→ droits) | Structure du modèle de données. Les contenus sont paramétrables (types d'événement, fiches) |
| C-26 | Sécurité et paramètres techniques | Jeton de 7 jours (`idx:3089`) ; secours d'une heure (`idx:3188`), secret de 32 caractères au moins (`idx:3114`), 5 essais par quart d'heure (`idx:3141-3142`) ; `keepAliveTimeout` de 65 s (`idx:7987`) ; import de 5 Mo (`idx:37`) ; aperçu d'import valable 10 min (`idx:1707`) ; export du journal plafonné à 10 000 entrées (`idx:6910`) ; registre : 8 résultats, délai de 5 s (`idx:5454-5456`) | Politique de sécurité et d'exploitation, réglable au besoin par variable d'environnement, hors assistant métier |
| C-27 | Fuseaux limités aux fuseaux français | `FUSEAUX_HORAIRES_FRANCAIS` `idx:736-741` ; `cli/pages/Admin.tsx:980-982` | ERP natif français. La valeur reste paramétrable (A) |
| C-28 | Plafond des paiements en espèces (classé dans la proposition parmi les règles légales à faire confirmer, faute d'exister dans le code) | **Absent** (`MOYENS_REGLEMENT` `idx:1245` sans plafond ; passation §4 : « règle de conformité non décidée ») | Règle légale éventuelle (code monétaire et financier), à confirmer par le cabinet avant toute implémentation |

---

## 4. Politiques ni codées ni paramétrées (prévues ou à cadrer)

Elles serviront à l'assistant de démarrage. Aucune valeur n'est proposée ici.
- **Validité d'un devis** : aucun champ (`schema:458-510`).
- **Conditions et délai de paiement par défaut** : seulement le texte libre des mentions (1.6) ; aucun champ structuré.
- **Relances** de devis et de factures.
- **Horaires, jours fériés, astreintes** de la société : lot (j), A6 (passation §2).
- **Anticipation de la génération des visites** et alerte d'échec : A9, lot 5.
- **Mode d'envoi des documents** (Microsoft 365 ou envoi manuel) : A10, lot 6.
- **Fait générateur et jour de coupure des commissions** ; plans commerciaux : lot (i), A5.
- **Facturation au temps passé** des interventions hors contrat : « une heure au moins, toute heure commencée est due » (décision du 17-10-2026, passation §2.3), précisée depuis. Le pas du temps au-delà du minimum est un réglage de la société, toujours arrondi au pas supérieur (décision de Nelson du 24-10-2026, « Réglage société » ; au-delà du minimum, et non plus de la première heure : décision de la nuit du 26 au 27-10-2026), créé par le lot « devis au temps passé » (`pasTempsPasseMinutes`, 1.1), vide au démarrage (décision du 25-10-2026), par multiples de 15 minutes, de 15 à 60 (décision de la nuit du 26 au 27-10-2026). Le temps minimum facturé est un réglage de la société (`tempsMinimumMinutes`, 1.1), d'une heure à l'installation (décision du 26-10-2026), par multiples de 15 minutes, de 15 minutes à 8 heures, qui revient à une heure quand on le vide (décision de la nuit du 26 au 27-10-2026) ; chaque devis au temps passé fait depuis le lot le fige, comme le pas, et sa ligne au temps passé vaut ce minimum, puis des multiples du pas, un devis antérieur gardant un minimum vide. Ces réglages et la ligne au pas sont implémentés par la première PR du lot « facture au temps passé » (#348), validée comptablement par Nelson le 28-10-2026, non validée pour mise en service. Le devis au temps passé prend le prix de l'heure d'une main d'œuvre du catalogue (1.7), à l'heure hors contrat ou sous contrat. La facture, qui reprend les heures saisies, arrondies au pas au-delà du minimum, avec au moins ce minimum, vient dans la seconde PR de ce lot (#351 ; décision « Lot suivant » du 25-10-2026), **implémentée**, validée comptablement par Nelson le 28-10-2026, non validée pour mise en service : elle ne lit aucun réglage de la société, seulement le minimum et le pas figés sur le devis. Décisions de Nelson du 28-10-2026 pour cette facture ([historique](HISTORIQUE-DECISIONS.md#décisions-du-28-10-2026-sur-la-facture-au-temps-passé)) : une seule facture pour l'intervention et ses suites, le minimum et l'arrondi au pas appliqués une fois au total des heures ; un devis fait avant le temps minimum a pour plancher les heures de sa ligne.
- **Valorisation des heures d'un SAV hors contrat** au prix de vente de la main d'œuvre de l'intervenant (décision de Nelson du 24-10-2026, « Liée à l'intervenant ») : le rattachement existe (1.7), le calcul de la marge est **implémenté** par le lot « marge d'un SAV hors contrat » (#354), validé comptablement par Nelson le 28-10-2026 (sans le matériel qu'y ajoute depuis le lot « matériel d'une intervention curative », #357, que cette validation ne couvre pas), non validé pour mise en service (prix copié dans `CoutInterventionHeure.prixVenteHoraireApplique`, choix par défaut en section 4 de la passation) : à l'heure, au prix copié sur l'heure à sa saisie, une main d'œuvre désactivée valorisant encore les heures (décisions de la nuit du 26 au 27-10-2026), au prix à l'heure que porte la main d'œuvre du catalogue, hors contrat ou sous contrat, sans réglage général de la société (décision du 27-10-2026 à 10:27 UTC, [historique](HISTORIQUE-DECISIONS.md#décisions-du-27-10-2026-sur-la-marge-des-suites-et-lintervention-dun-devis)) ; le lot n'applique que le prix hors contrat, la valorisation des visites de contrat et de leurs suites au prix sous contrat relevant d'un lot à part, prévu.
- **Abonnements et locations** (terme échu ou à échoir, engagement de 12 à 60 mois, reconduction, révision) : lot (k).
- **Facturation électronique** : taille de l'entreprise, plateforme agréée (A2).

---

## 5. Écarts entre la documentation et le code

| Sujet | Doc dit | Code fait |
|---|---|---|
| Valeurs de société | « aucune valeur de société dans le code » (`README.md:39`) | Barèmes et primes d'une société insérés par migration (`mig/20260904210000_parametres_remuneration:26-37`) ; « NØXIA GROUPE » dans `cli/pages/Login.tsx:91` et `cli/pages/PlanningPublic.tsx:135` (ce dernier point est reconnu par la passation §1) |
| Moyens de paiement | « liste paramétrable » (`docs/MODELE-DONNEES-CIBLE.md:30`, proposition cible) | Liste fermée en code et en `CHECK` SQL (B-45) |
| Centre d'administration documentaire | Identité, logo, numérotation, modèles de documents et d'e-mails (`docs/ADMINISTRATION-DOCUMENTS-EMAILS.md:5-27`) | Préfixes facture et avoir seulement ; PDF figé ; logo, pied de page et couleur secondaire sans effet (1.2, B-58, B-59) |
| Export comptable | Format choisi par le cabinet ; journaux de ventes, règlements, banque ; « chaque export est journalisé » (`docs/INTEGRATIONS-M365-COMPTABILITE-FACTURATION-FR.md:39-48`) | Un CSV, un seul journal de ventes, aucune journalisation (B-62) |
| Statuts d'intervention | « à planifier, planifiée, en cours, rapport à compléter, terminée, facturée/à facturer » (`docs/PRODUCT-VISION-ERP-TECHNIQUE.md:58`) | A_PLANIFIER, PLANIFIEE, EN_COURS, TERMINEE, ANNULEE (`idx:2916-2922`) |
| États de facture | « brouillon, émise, partiellement réglée, réglée, échue, annulée » (`docs/PRODUCT-VISION-ERP-TECHNIQUE.md:47`) | Stockés : BROUILLON, EMISE, REGLEE, ANNULEE. « Partiellement réglée » n'est qu'un libellé affiché (`cli/lib/reglements.ts:47-53`) ; « échue » n'existe pas |
| Devis | « Toute modification après émission crée une version ; la version acceptée est figée » (`docs/PRODUCT-VISION-ERP-TECHNIQUE.md:40`) | Un devis envoyé non signé reste modifiable (B-53, question ouverte §3) |
| Maintenance | Périodicité avec « règle personnalisée », fenêtre de réalisation, compétence, checklist (`docs/PRODUCT-VISION-ERP-TECHNIQUE.md:62-69`) | `periodiciteMois` et durée seulement (`schema:852-853`) |
| Identité société | « alimenteront l'en-tête des devis et factures » (`cli/pages/Societe.tsx:9-12`, au futur) | Exact : rien n'est encore imprimé depuis `CompanySettings`, hors couleur principale |
| Clé comptable `TVA_COLLECTEE` | Citée dans le commentaire du schéma (`schema:788`) | Absente de `CLES_COMPTABLES` (`idx:1483`) ; la TVA passe par `RegleTvaComptable` |
| Contrat « brouillon » | Statut prévu (`schema:851`) | Jamais produit (B-52) |

---

## 6. Questions de démarrage (assistant de première configuration)

Elles ne tranchent rien. Chaque réponse réglerait les paramètres (A) ou les règles (B) indiqués. Si un paramètre touche les montants, une mention légale ou la comptabilité, la réponse doit être validée par Nelson ou le cabinet.

| # | Question | Paramètres (A) réglés | Règles (B) à rendre paramétrables | Remarque |
|---|---|---|---|---|
| Q1 | Quelle est l'identité légale et visuelle de la société (raison sociale, SIRET, TVA, adresse, logo, couleurs) ? | `CompanySettings` (1.2) | B-59, B-72 | Seule la couleur principale est utilisée aujourd'hui |
| Q2 | Dans quel fuseau la société travaille-t-elle (métropole, outre-mer) ? | `fuseauHoraire` | — | Réglage initial (`cli/pages/Admin.tsx:977`) |
| Q3 | Quelle est la taille de l'entreprise (PME, ETI…), et quelle plateforme agréée est retenue pour la facturation électronique ? | — | — | A2 ; calendrier à faire confirmer par le cabinet |
| Q4 | Quels domaines la société utilise-t-elle : devis, SAV, contrats de maintenance, chantiers (Travaux), planning, facturation, règlements, catalogue ? | `planningActif` | B-75 | |
| Q5 | Comment l'équipe est-elle organisée : direction, comptes Responsable, conducteurs, techniciens avec ou sans compte, commerciaux, assistance ou comptabilité internes ? | Rôles, rattachement hiérarchique, fiches intervenant (1.9, → droits) | B-22, B-23, B-51 | |
| Q6 | Qui clôture une affaire, et qui peut la rouvrir ? | — | B-01, B-02, B-33 | → droits |
| Q7 | Qui convertit un devis en chantier, et qui en désigne le titulaire et le commercial ? | — | B-03, B-16, B-17, B-22, B-23 | → droits |
| Q8 | Qui enregistre l'accord du client, qui constate l'acompte, qui annule un devis ? | — | B-04, B-05, B-06, B-07 | → droits |
| Q9 | La société demande-t-elle un acompte ? Selon quel taux proposé et sur quelle base ? L'acompte bloque-t-il l'ouverture du chantier ? | `tauxAcompteDefaut` | B-24 | Montants : validation de Nelson |
| Q10 | Un devis se fige-t-il à l'envoi ou à la signature ? Faut-il un signataire habilité côté client ? | — | B-53, B-54, B-04 | Question ouverte de la passation (§3) |
| Q11 | Qui crée une intervention SAV, qui la planifie, qui saisit les heures et le matériel ? | — | B-08 à B-11 | → droits |
| Q12 | Quels sont les horaires et les jours travaillés ? Y a-t-il du travail de nuit, de week-end, des astreintes ? Quelle est la durée type d'une curative ? | — | B-25 à B-29, B-38, B-42, B-64 | Lot (j) |
| Q13 | Pour les contrats : périodicités et durées de visite habituelles, couverture par défaut, délai d'anticipation de la génération des visites ? | — | B-30, B-31, B-32 | A9 (lot 5) |
| Q14 | Quelles sont les activités et types de chantier ? | — | B-44 | |
| Q15 | Quelles priorités d'intervention et quels délais de service la société pratique-t-elle ? | — | B-46 | |
| Q16 | Quels moyens de paiement la société accepte-t-elle ? | — | B-45 ; C-28 | Plafond des espèces : à confirmer par le cabinet |
| Q17 | Quelles conditions de paiement (délai, pénalités, escompte) la société applique-t-elle ? | `MentionsLegalesVersion` (texte) | B-34 | Validation par le cabinet (C-09) |
| Q18 | Quels préfixes de facture et d'avoir ? Faut-il un format de numéro particulier ? | `prefixeFacture`, `prefixeAvoir` | B-58 | La continuité reste en C-01 ; pas de reprise d'un ERP tiers (CLAUDE.md) |
| Q19 | Quel plan comptable, quel journal des ventes, quels comptes de TVA ? Quelle ventilation des ventes ? | Comptes, règles, TVA (1.5) | B-48, B-62 | À fournir par le cabinet ; rien n'est préchargé |
| Q20 | Quel taux de TVA et quelle unité proposer par défaut ? | Fiches du catalogue | B-49, B-50 | Taux légaux : C-08 |
| Q21 | Qui suit la rentabilité des chantiers ? La marge est-elle affichée ? Quels seuils d'alerte ? | `margeCommercialeActive`, `rentabilite*`, `seuilMargeFaible`, `joursSansSaisie` | B-36, B-37, B-39 | Montants : validation de Nelson |
| Q22 | Quand l'exercice comptable se clôt-il ? | — | B-63 ; C-01 (année de numérotation) | À confirmer par le cabinet |
| Q23 | Les techniciens sans compte consultent-ils un planning public ? | `PlanningPublicShare` | B-65 | |
| Q24 | Combien de temps conserver le journal des paramètres et des droits ? | `journalConservationJours` | — | À faire trancher par le cabinet (passation §5) |
| Q25 | Peut-on saisir sur un chantier clos ? Qui archive une écriture ? | — | B-18 (→ droits : `chantiers:archive`) | |
| Q26 | Une intervention peut-elle être terminée sans compte rendu signé ? | — | B-55 | À revoir au lot 3b |
| Q27 | Comment envoyer les documents : Microsoft 365 ou téléchargement puis envoi manuel ? | — | — | A10 (lot 6) |
| Q28 | Qui règle les mentions légales, et qui règle l'identité ? | — | B-20, B-21 | Gouvernance |

---

## 7. Points « à vérifier » relevés pendant l'inventaire

1. `FactureLigne` n'est pas figée en SQL après émission, et `mentionsLegalesVersionId` ne figure pas dans les colonnes figées par trigger (C-03).
2. La clôture et la réouverture d'un chantier (`idx:3588-3633`) et la case « Encaissé » (`idx:5380-5391`) ne laissent aucune trace dans un journal.
3. Le motif d'annulation d'un devis n'a pas de longueur minimale (`idx:6593-6594`) ; les autres motifs exigent 3 à 500 caractères.
4. La création d'un devis ne vérifie pas que le client est actif (`idx:6300`).
5. `GET /api/planning/chantiers` liste aussi les chantiers terminés et annulés (`idx:4440-4450`).
6. Les comptes assistante commerciale, comptable et directeur commercial peuvent écrire les référentiels d'achats côté API (B-19), et l'écran Administration leur est ouvert.
7. Les coordonnées de `CompanySettings` n'ont aucun usage côté serveur (recherche dans `idx`) : à confirmer avant de les présenter dans l'assistant comme « imprimées ».
