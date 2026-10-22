# Iris — état et passation du développement

> **État de `main` au commit `395238c` (22-10-2026), après la PR [#293](https://github.com/Noxia-Groupe/iris/pull/293).** Depuis le commit `09be456` (nuit du 20 au 21-10-2026) : planning du technicien étendu aux affectations des chantiers dont il est titulaire (#279) ; Iris sans valeurs de société, « IRIS » sur la connexion et le planning public, rapport de chantier en A4 (lot P0, #280) ; directeur commercial, assistante commerciale et comptable sans planning ni écriture des référentiels (#282, #179) ; réattributions de chantier et encaissement journalisés (#283, #181) ; conversion d'un devis signé en intervention ou en contrat (lot pilote 4, #281, tests complétés par #294) ; génération automatique quotidienne des visites de maintenance (lot pilote 5, #293). État du code, pas attestation de conformité ni feu vert de production.
>
> Depuis le 20-10-2026, Nelson ne fusionne aucune PR : Claude Code fusionne toutes ses PR, montants et propositions compris, avec une CI verte et un audit interne fusionnable sur la même SHA ([CLAUDE.md](../CLAUDE.md#mode-de-livraison)). La mise en production reste à Nelson. PR ouvertes au 22-10-2026, hors cette passation :
> - [#250](https://github.com/Noxia-Groupe/iris/pull/250) (#240, pool de connexions de la modification d'un devis) : en brouillon, en pause jusqu'à la fin du pilote (règle du 19-10-2026).
> - [#298](https://github.com/Noxia-Groupe/iris/pull/298) (#295, #296) : tests restants des audits de #294 et #293, ouverte le 22-10-2026.
>
> Le détail est tenu dans chaque PR, corps et commentaires.
>
> Avant chaque lot : relire ce document, puis vérifier le code, les tests, les issues **et leurs commentaires**. Une case non cochée ou une issue ancienne ne prouve pas une absence.
>
> Le détail des lots livrés (a) à (h), des décisions déjà appliquées et des constats corrigés se trouve dans [HISTORIQUE-DECISIONS.md](HISTORIQUE-DECISIONS.md), qui tient aussi les décisions et les lots du 18 au 22-10-2026.

Iris est un ERP français natif, simple pour les métiers techniques, déployé **par société sur une instance et une base propres**. Iris est la source de vérité pour clients, sites, catalogue, devis, affaires, interventions, contrats et factures. Microsoft 365, la banque et les plateformes de facturation électronique ne sont que des connecteurs. Voir la [vision produit](PRODUCT-VISION-ERP-TECHNIQUE.md), l'[architecture d'instance](ARCHITECTURE-INSTANCE-DEDIEE.md) et le [modèle de droits](MODELE-DROITS-COMPTES.md). Aucune instance n'est déclarée en production : le déploiement et la validation comptable restent des conditions de sortie, pas des tâches acquises.

Le catalogue et le plan comptable commencent vides et sont paramétrés par la société. Aucune règle de prix ou de commission, aucun compte ni mapping comptable, aucune identité légale ni CGV ne doit être inventé ni imposé au client. Les dates métier sont saisies et présentées en `JJ-MM-AAAA` ; on distingue le jour civil, au fuseau de la société, de l'instant technique.

## 1. État actuel par domaine

Statuts : **livré**, **partiel**, **absent** ou, pour le commissionnement, **fermé**, au commit indiqué plus haut ; un statut peut porter une réserve (Travaux : livré, place dans le pilote en question). « Choix » renvoie à la section 4, « question » à la section 3.

- **Identité, accès et droits — livré.**
  - Livré :
    - authentification Entra et accès de secours de l'instance ;
    - droits par type de compte, permissions individuelles et clés d'intégration (`/api/v1`) ;
    - type Directeur et responsable hiérarchique (#121) ;
    - technicien sans montants ni devis (#123, #127, #128) ;
    - taux horaire et coût de main-d'œuvre réservés aux administrateurs (#134) ;
    - journal des paramètres et des droits, onglet Administration > Journal (#133) ;
    - garde-fous des comptes (règle 2), [détail](HISTORIQUE-DECISIONS.md#décisions-et-lots-des-18-et-19-10-2026) :
      - au moins un super administrateur actif ; suppression, changement de type (hors promotion en super administrateur) et désactivation (non la réactivation) sérialisés par un verrou, en READ COMMITTED explicite (#216) ;
      - garde des comptes super administrateurs refait sur le compte relu sous verrou ; rattachement hiérarchique sous le verrou des retraits (#224) ;
      - suppression d'un compte et de sa fiche intervenant sans interblocage ; liaison d'une fiche sous le verrou des retraits ; READ COMMITTED explicite pour les fiches, le démarrage, les permissions et l'accès financier (#228) ;
      - promotion `SUPERADMIN_EMAILS` du démarrage retentée une fois, échec signalé sans arrêter le serveur (#232) ;
      - refus du changement de type de compte et de la case « Commercial » affichés dans Administration > Utilisateurs, liste rechargée (#234) ; les autres actions de l'écran restent à aligner (#239).
    - directeur commercial, assistante commerciale et comptable refusés, comme le commercial, sur le planning et les écritures des référentiels (#282, #179 ; décision 11 de la proposition de droits) ; choix par défaut en section 4 ;
    - réattributions de chantier et encaissement journalisés (#283, #181, lot D0) ; choix par défaut en section 4.
  - Pas encore appliqués (choix) :
    - les clés d'intégration voient encore taux et coût de main-d'œuvre ;
    - les clients désactivés restent lisibles par les comptes autres que le technicien et par les clés ;
    - le journal n'enregistre ni la création d'un compte comptable, ni l'auteur des mentions légales, ni le taux d'un intervenant ;
    - le journal ne ferme pas encore à un simple administrateur les entrées dont l'auteur est un super administrateur, ni celles d'un compte devenu super administrateur depuis ;
    - un compte qui quitte le type technicien garde son `clients:read` individuel ;
    - l'échéance d'une clé d'intégration n'est pas lue au jour civil de la société.
  - Sans choix à ce jour : republier une ancienne version des mentions légales ne lui donne pas de nouvelle date de publication (question).
- **Dates — livré.** Jour et heure de la société (#130), format `JJ-MM-AAAA` (#132). Seule la date de demande curative n'accepte que `JJ-MM-AAAA` ; choix : l'aligner sur les autres dates métier.
- **Clients, sites, contacts — livré.**
  - Livré :
    - référentiel, avec sélection au-delà des 200 premiers clients (#112, #114, #137, #138, #139) ;
    - lecture par le conducteur (#143, menu ouvert par #145) et par le technicien (#127, #128) ;
    - client d'une affaire : libellé suivi (#142), rattachement SAV par la fiche client (#144), changement journalisé et refusé tant qu'une intervention est rattachée (#146).
  - Restent à arbitrer, depuis #139 (question) :
    - Factures et Devis n'utilisent pas le sélecteur commun `SelecteurClient`, si bien que leur liste initiale est tronquée à 200 sans le dire ;
    - une réponse allégée (sans contacts ni sites) pour les sélecteurs.
- **Catalogue et parc — livré.**
  - Trois familles, catégories, parc installé.
  - Prix d'achat facultatif dans les trois familles (#161), lu par une clé d'intégration avec `finances:read` seulement, y compris sur le modèle joint à un équipement du parc.
  - Écrans et routes réservés à l'administration ; recherche pour composer un devis ouverte aux porteurs de `devis:write` (#161).
  - L'écran crée, désactive et réactive une fiche, sans la modifier ; la modification ne passe que par l'API (`PUT /api/catalogue/:famille/:id`, ou v1 avec `catalogue:write`).
  - La connexion aux catalogues des fournisseurs viendra plus tard (A8).
- **Devis et affaire — partiel.**
  - Livré :
    - versions, signature avec empreinte, acompte constaté à la main, annulation, duplication, conversion en chantier ;
    - duplication lue sous le verrou du devis source, dans la transaction du duplicata (#237) ;
    - lignes reprises du catalogue et copiées figées, prix d'achat prévu réservé à l'administration ;
    - devis signé figé en base (#161) ;
    - conversion en intervention ou en contrat (lot pilote 4, #281 ; non validée pour mise en service) ;
    - PDF du devis sur le modèle commun, depuis l'écran Devis ; un devis signé s'imprime depuis l'identité de l'émetteur, le client et le fuseau de la société copiés à sa signature (lot 6a-2, #301 ; non validé pour mise en service).
  - Absent :
    - envoi d'un devis (lot pilote 6, PR 6a-3) ;
    - paiement ou rapprochement de l'acompte.
  - Un devis envoyé non signé reste modifiable (question).
- **Travaux : chantiers, heures, achats, rentabilité — livré, place dans le pilote en question.**
  - Livré :
    - fiche chantier, achats et heures avec journal, archivage et restauration ;
    - suivi de rentabilité et alertes (#117), destinataires selon la hiérarchie (#121) ; sommes en décimal exact et arrondis d'affichage justes, comme dans les statistiques (#208) ;
    - ouverture depuis l'Administration et réattribution (#129), clôture par les directeurs (#128).
  - Le prix d'achat prévu des devis n'est pas repris par le chantier (question).
  - La case « Encaissé » d'un chantier reste cochée à la main par l'administration (voir Commissionnement).
  - Appliqués à l'écran seulement (choix) : le responsable se choisit parmi les conducteurs actifs, et l'obligation de commercial ne compte que les commerciaux actifs ; le serveur vérifie seulement l'activation du compte et compte tous les commerciaux.
  - Défauts connus, plus bas.
- **SAV, planning, mobile — partiel.**
  - Livré :
    - interventions SAV, rapports, signatures, coûts, planning, file « à planifier », planning public ;
    - navigation sur téléphone (#118) ;
    - mesure des écrans de 320 à 1024 px (#147 ; suivi des remarques dans #149 à #152).
  - Livré par le lot pilote 3a (#166) :
    - l'administration relie un compte technicien à sa fiche intervenant (journalisé) ;
    - la file « à planifier » du planning propose aussi les interventions curatives ;
    - le technicien ne modifie plus le planning ni les référentiels des achats, et n'a plus l'Administration.
  - Livré par le lot pilote 3b ([#253](https://github.com/Noxia-Groupe/iris/issues/253)) :
    - comptes rendus en ajout seul et signatures figées en base, vidage refusé ; une intervention qui porte un compte rendu ne se supprime plus (3b-1, #255) ;
    - heures du technicien affecté sur une intervention hors contrat, saisies et corrigées comme sur un contrat actif, dans les coûts SAV ; l'administration voit leur coût de main-d'œuvre (« Main-d’œuvre cumulée »), le technicien ses heures sans taux ; une date d'heures future est refusée (choix par défaut, section 4 ; 3b-2, #257) ;
    - compte rendu et signature dans la page, sans fenêtre du navigateur (3b-3, #268) :
      - un compte rendu porte une clé d'envoi, si bien qu'un renvoi après une réponse perdue ne l'enregistre pas deux fois ;
      - la signature se dessine au doigt ; son tracé vectoriel est borné, figé en base et inclus dans l'empreinte, et le compte qui l'enregistre est conservé ;
      - terminer exige un compte rendu, signé ou accompagné d'un motif consigné au journal, pour tous les comptes ;
      - compte rendu, signature et clôture se font sous le verrou de l'intervention, périmètre relu ;
      - horodatages des comptes rendus et des signatures imposés par la base.
    - « Ma journée » à l'accueil du technicien (3b-4, #272) : ses interventions du jour, au jour civil de la société, triées par créneau ; terminées à part ; celles restées ouvertes les jours précédents ; jour précédent et jour suivant ; « Ma journée » remplace pour lui le tableau de bord des chantiers ; il retrouve ses chantiers dans « Liste des chantiers » ;
    - fiche intervention sur téléphone (3b-4, #272) : adresse du site, à défaut de l'affaire, téléphone du contact en lien d'appel, et les actions de l'intervention.
  - Livré par la PR du planning limité (#275, décision de Nelson du 19-10-2026), puis étendu par #279 (décision du 21-10-2026, « Des 2 ») : le technicien lit au planning les affectations où figure sa fiche intervenant et celles des chantiers dont il est titulaire ; l'écran lui montre sa ligne, puis celles des intervenants des affectations reçues pour la semaine ; la liste des chantiers du planning lui est refusée ; si la liste des intervenants ne se lit pas, l'écran le dit. Choix par défaut, à confirmer, en section 4.
  - Absent : le motif d'une clôture sans signature n'est affiché dans aucun écran ; il est consigné au journal SAV, réservé à l'encadrement (#269).
  - Ne pas qualifier « l'écran Travaux reste entièrement à créer » sans auditer la fiche actuelle.
  - Les issues [#16](https://github.com/Noxia-Groupe/iris/issues/16) et [#19](https://github.com/Noxia-Groupe/iris/issues/19) sont fermées depuis le 16-10-2026 ; leurs reliquats sont suivis dans [#135](https://github.com/Noxia-Groupe/iris/issues/135) et [#136](https://github.com/Noxia-Groupe/iris/issues/136), ouvertes : comparer leurs sous-points au code avant de les replanifier.
- **Contrats de maintenance — partiel.**
  - Livré : contrat cyclique, durée et couverture, avancement d'échéance, création idempotente d'une intervention à planifier par une action de l'écran (`POST`).
  - Génération automatique quotidienne des visites (lot pilote 5, #293 ; non validée pour mise en service) : une fois par jour civil de la société, visite créée pour l'échéance qui tombe dans l'anticipation réglée (30 jours par défaut, vide pour la désactiver), échéance d'une visite terminée avancée ; passage manuel par l'administration ; alerte en cas d'échec, d'interruption ou d'absence de passage. Choix par défaut, à confirmer, en section 4 ; questions (a) à (c) en section 3.
- **Facturation et comptabilité — partiel.**
  - Livré :
    - factures numérotées et leur PDF, avoirs, écritures, ventilation de TVA ;
    - plan comptable paramétrable, import et export CSV, préparation à la facturation ;
    - règlements saisis à la main (#155) ;
    - transactions vérifiées avant leur COMMIT (#158) ;
    - facture émise figée en base : lignes, ventilation de TVA, version des mentions légales, date d'émission et journal en ajout seul ; ni retour au brouillon, ni statut inconnu, ni vidage des lignes, de la ventilation, des écritures et du journal (#217) ;
    - cycle des statuts garanti en base (décision de Nelson du 19-10-2026 ; extension à la création des pièces et aux avoirs, choix de mise en œuvre) : une facture ne s'annule qu'avec son avoir d'annulation, émis aux mêmes montants dans la même transaction ; vidage refusé sur règlements, affectations et trois journaux comptables ; insertion des écritures sans interblocage (#227) ;
    - plafond des avoirs garanti en base : chaque avoir émis est cohérent et positif ; ensemble, les avoirs émis ne dépassent ni le HT, ni la TVA, ni le TTC de la facture, ni sa ventilation par taux ; un avoir partiel ne crédite qu'une facture émise ou réglée (#235).
  - Pas encore garanti en base : la cohérence interne des factures émises (signes, TTC, ventilation, écritures de TVA), ni celle des lignes et des écritures des avoirs (#243).
  - Absent : facturation électronique, c'est-à-dire formats structurés, adaptateur de plateforme, statuts et e-reporting ([architecture cible](INTEGRATIONS-M365-COMPTABILITE-FACTURATION-FR.md)).
  - Les issues [#31](https://github.com/Noxia-Groupe/iris/issues/31) et [#33](https://github.com/Noxia-Groupe/iris/issues/33) sont fermées depuis le 16-10-2026, leur reliquat regroupé dans [#35](https://github.com/Noxia-Groupe/iris/issues/35). Celle-ci mêle des points désormais implémentés : la requalifier point par point avant toute PR.
  - Les montants et le paramétrage légal se valident par le cabinet et Nelson.
- **Paiements, banque, télécom, financeurs — absent**, hors règlements saisis à la main (#155) et acompte constaté sur un devis.
  - Ne pas déduire une transaction bancaire d'un statut « réglée ».
  - Banque et rapprochement viennent après le pilote (A3).
  - Découper et prioriser paiements, banque, abonnements télécom et financeurs avec des critères et des dépendances explicites.
- **Commissionnement — fermé.**
  - Depuis #159, aucune commission ni prime n'est due tant qu'aucun plan commercial n'est attribué : le calcul conservé reçoit des règles neutres et rend zéro. Le CA et la marge validés restent suivis.
  - Le barème global (`ParametresRemuneration`) reste enregistrable, sans effet.
  - Le plan commercial (lot (i)) est absent. Il recouvre les profils versionnés, attribués par personne et non rétroactifs de l'[issue #15](https://github.com/Noxia-Groupe/iris/issues/15) : ne pas substituer le barème global au besoin d'individualisation.
  - La case « Encaissé » d'un chantier reste manuelle. L'« encaissé » déduit des règlements, décidé au lot pilote 1 (A3), sera repris par le plan commercial.
  - Le commercial voit la marge de chaque chantier dans ses statistiques (question, lot (d)).
- **Microsoft 365 et personnalisation — partiel.**
  - Seule la connexion Entra existe (authentification, distincte d'Outlook et de Graph) : ni envoi Outlook, ni synchronisation, ni modèles d'e-mails ([vision d'intégration](INTEGRATIONS-M365-COMPTABILITE-FACTURATION-FR.md)). Les notifications e-mail des alertes de rentabilité attendent ce connecteur (#121).
  - À définir : les parcours et consentements Graph par installation.
  - Vérifier le branding et les modèles de documents réellement disponibles avant de clôturer le volet personnalisation.
  - Identité de l'application (lot P0, #280, non validé pour mise en service ; décision de Nelson du 21-10-2026) :
    - la page de connexion ([Login.tsx](../client/src/pages/Login.tsx)) et le planning public ([PlanningPublic.tsx](../client/src/pages/PlanningPublic.tsx)) affichent « IRIS », le nom de l'application ;
    - icônes neutres de l'application (`client/public/icone.svg` et ses rendus) ; les trois bleus de l'ancienne marque remplacés par trois bleus de la palette standard de Tailwind 3, les deux gris neutres et la police de l'ancienne charte gardés ; reste la teinte de survol du bouton principal (`#024080`), dérivée de l'ancien accent et non vue par la garde statique ([#299](https://github.com/Noxia-Groupe/iris/issues/299), audit de #297) ;
    - ni le nom de l'ancienne société, avec O ou Ø et quelle que soit la casse, ni aucun des trois bleus de l'ancienne marque dans le code livré, hors les deux migrations déjà appliquées (`20260703090000`, `20260904210000`), sous la garde statique `client/tests/identite.test.ts` ; barèmes et primes insérés par migration vidés, sauf valeur différente de celle insérée (la migration de #280 ne cite ces valeurs que pour les reconnaître) ;
    - le menu, lui, affiche le nom de la société (#118) ;
    - choix par défaut en section 4.
  - La police est chargée depuis Google Fonts ; choix : l'héberger avec l'application.
- **Installation et mise en service — partiel (préparé, non validé).**
  - Compose, migrations et CI préparent une instance isolée ; accès de secours de l'instance ([configuration](CONFIGURATION-ENVIRONNEMENT.md), [accès sans Microsoft](ACCES-SANS-MICROSOFT.md)).
  - Ne sont pas attestés : portail de secours **plateforme** séparé, configuration guidée de l'authentification, recette de production, sauvegarde et restauration testées, exploitation multi-instances, validation légale ou comptable.
  - Ne pas confondre le secours de l'instance avec un accès opérateur cross-instance.
  - Séparer le rôle SQL applicatif, non propriétaire, du migrateur avant de revendiquer l'intégrité contre les écritures SQL directes (avertissement du [README](../README.md)).

### Défauts connus et points à surveiller

- Saisie sur un chantier pendant l'annulation de son devis (relevé par le cinquième audit de #129, préexistant, **non corrigé ; tranché par un choix par défaut, à appliquer (section 4)**) : une heure saisie au même moment peut rester vivante sur un chantier annulé, contre la règle « une affaire commencée ne s'annule pas » (reproduit 20 fois sur 20, sur `main` comme avec #129). La saisie lit le chantier hors transaction (`assertChantierWritable`), et l'annulation ne le verrouille pas ; les achats sont probablement concernés aussi. Piste : l'annulation verrouille le chantier après le devis, et les saisies le verrouillent puis relisent son statut. Depuis #146, la création d'une intervention SAV rattachée et celle d'une facture d'affaire font déjà ainsi (verrou partagé, statut relu) : elles attendent une annulation en cours, puis sont refusées. De même, en théorie, la conversion et la fiche chantier pourraient poser simultanément la même référence d'affaire sur deux chantiers (non reproduit). Choix par défaut, à confirmer (16-10-2026) : corriger par un verrou du chantier dans un lot dédié.
- Statut d'un chantier modifiable sans contrôle par l'API ([#289](https://github.com/Noxia-Groupe/iris/issues/289) ; relevé pendant le treizième audit de #129, préexistant, **non corrigé ; tranché par un choix par défaut, à appliquer (section 4)**) : `PATCH /api/chantiers/:id` recopie le `statut` envoyé par une session administrateur sans vérifier sa valeur (champ texte en base). Un administrateur peut ainsi annuler un chantier sans annuler son devis, sans date ni motif d'annulation, y compris un chantier qui porte déjà des heures ou des achats (que l'annulation du devis refuse), ou lui donner un statut inconnu, en contournant `PATCH /api/chantiers/:id/statut` et l'annulation du devis. Une telle annulation est sans retour : la fiche et son statut sont ensuite figés (409), et seule la duplication du devis, qui crée une nouvelle affaire, permet de la reprendre ; le devis d'origine reste « accepté », rattaché à un chantier annulé, tant qu'il n'est pas lui-même annulé (ce qui renseigne alors la date et le motif du chantier). Si le chantier portait des saisies, le devis ne peut plus être annulé (409) et ses saisies ne s'archivent plus : le chantier reste annulé sans date ni motif. Tant que le devis n'est pas annulé, l'écran Devis affiche « Chantier issu de ce devis » alors que son chantier est annulé. L'interface n'envoie jamais ce champ. Choix par défaut, à confirmer (16-10-2026) : retirer le statut de la modification générale, qui passe par les routes dédiées.
- Création d'une intervention par un conducteur hors de son périmètre (relevé en préparant cette passation, préexistant, **non corrigé ; tranché par un choix par défaut, à appliquer (section 4)**) : `POST /api/interventions` ne contrôle que le client du chantier visé et son annulation, pas le périmètre de lecture du conducteur.
- Dates du planning et de la demande curative, lues hors de `dateIsoStricte` (relevé par le huitième audit de #130, préexistant) : le planning est corrigé par #132 (lecture par `dateIsoStricte`). La demande curative n'accepte toujours que `JJ-MM-AAAA` et refuse une date-heure : choix par défaut, à confirmer, l'aligner sur les autres dates métier (lot (h)).
- « Socket hang up » (lot (g)) : une occurrence en CI E2E de #123, puis une réinitialisation de connexion (`read ECONNRESET`, `facturation.spec.ts`) en CI E2E de #129, de cause probablement identique (non reproduite). Correctif probable livré par #131 (connexions inactives gardées 65 s par le serveur) ; à surveiller en CI.
- Écrans `/admin` sur téléphone (#147) : pour le conducteur, `/admin` garde un bouton hors écran préexistant (suivi dans #150) ; le technicien n'a plus `/admin` depuis #166.
- Deux conventions d'arrondi du coût de main-d'œuvre (relevé par l'audit de #208, question en section 3) : la fiche chantier somme les produits exacts puis arrondit une fois ; l'écran Heures arrondit chaque ligne au centime, et le total SAV de #257 additionne des lignes arrondies (deux lignes de 1,025 € : 1,03 € chacune et 2,06 € au total SAV, contre 2,05 € sur la fiche).
- Périmètre des conducteurs et responsables par l'affaire ([#269](https://github.com/Noxia-Groupe/iris/issues/269), note N11 de l'audit de #268, préexistant) : depuis #268, compte rendu, signature et clôture relisent le périmètre sous le verrou de l'intervention, ce qui couvre un retrait d'affectation. Un changement du responsable de l'affaire ne prend pas ce verrou : il n'est pas sérialisé avec une écriture SAV en attente.
- Cohérence interne des pièces émises ([#243](https://github.com/Noxia-Groupe/iris/issues/243), préexistant ; conséquence nouvelle depuis #235) : une facture écrite en SQL peut porter des montants négatifs, un TTC différent de HT + TVA ou une ventilation qui ne suit pas ses totaux, ce qui fausse le plafond des avoirs ; les lignes et les écritures d'un avoir ne sont pas comparées à sa ventilation. Depuis #235, l'annulation par l'API d'une telle facture est refusée par la base à la validation et répond 500, et non un refus métier ; aucune donnée réelle n'est concernée (règle 4). Correctif proposé dans l'issue. Nelson a tranché le 19-10-2026 : « #243 on ne refuse pas une piece a emise a montant nul » ; les contrôles de cohérence n'interdiront donc pas une facture ou un avoir émis à 0 / 0 / 0 €.
- Parcours E2E `entetes-mobile` ([#152](https://github.com/Noxia-Groupe/iris/issues/152)) : en local, Chromium refusait les modules de Vite après une trentaine de navigations dans la même page. Depuis #249, chaque route est mesurée dans une page neuve et l'assertion nomme la route et la largeur ; les autres points de #152 restent ouverts.
- Sécurité de la connexion, relevée par l'inventaire des variables d'environnement (#263), questions en section 3 : derrière les proxys, toutes les tentatives de l'accès de secours comptent pour une seule adresse IP, si bien qu'un tiers peut le bloquer pour tous ([#261](https://github.com/Noxia-Groupe/iris/issues/261), lié à #168 sur `proxy-addr` et `trust proxy`) ; l'autorisation Microsoft 365 repose sur l'adresse du jeton, modifiable, plutôt que sur les identifiants `oid` et `tid` ([#264](https://github.com/Noxia-Groupe/iris/issues/264)).
- Autres suivis d'audit ouverts (étiquette `suivi-audit`) au 22-10-2026, hors ceux cités ailleurs dans ce document :
  - règle 2 : #167 (périmètre SAV du Responsable : curatives sans chantier ouvertes par un conducteur de sa branche), #285 (chantier : réattribution par l'ancien titulaire vérifiée hors verrou ; commercial et encaissement modifiables sur une affaire annulée), #286 (suppression d'un compte : chantiers privés de titulaire ou de commercial non nommés), #164 (montants du modèle d'un équipement du parc en chaîne, et non en nombre), #154 et #156 (règlements : avertir d'une double saisie probable ; règle du surplus connue du formulaire), #240 (`PATCH /api/devis/:id` lit les paramètres pendant sa transaction et peut épuiser le pool de connexions ; correctif #250 en pause), #247 (double envoi d'un avoir partiel : bloqué à l'écran par #251 ; reste la clé d'idempotence côté serveur, après le pilote), #252 (taux d'acompte invalide remplacé en silence), #256 (la suppression d'un compte ne compte pas ses comptes rendus d'intervention parmi les données tracées), #262 (un « + » du jeton de secours lu comme une espace dans le lien `#token=`), #273 (notes de l'audit de #272 : contact complet, e-mail compris, rendu par la liste, la journée et la fiche d'une intervention, préexistant ; journée sans test avec le module Planning désactivé ; charge de la journée ; écran « Ma journée » et libellés ; lien d'appel d'un texte qui commence par un petit nombre ; parcours de l'encadrement et garde de course non testés à l'écran) ;
  - écrans : #202 à #206 (anomalies relevées en préparant le découpage, à corriger après les trois déplacements), #212 (« -0 % », « ±0 h » et couleur d'une marge nulle), #254 et #258 (formulaire d'avoir partiel : autre formulaire fermé pendant l'envoi, requête sans délai d'expiration, messages bruts du navigateur), #259 (heures affichées « 1.5 h »), #260 (cadre des coûts d'intervention retiré sur un conflit concurrent), #239 (autres actions de l'Administration : erreurs réseau et réponses non JSON mal signalées, refus sans rechargement ; le refus qui révèle un compte super administrateur relève d'un choix par défaut, section 4), #276 (planning : équipe illisible, notes de l'audit de #275 : exception de lecture non testée, message trompeur sur la coupure d'un autre appel, bouton « Affectation » proposé sans équipe) ;
  - outillage et tests : #157 (vérification des contraintes différées rendue structurelle), #162 (exception en construisant une requête de test qui bloque la suite), #160 (commentaires des commissions sans plan restés au présent), #244 (jeton de session E2E recopié dans 16 parcours), #248 (préparation des E2E : port frontend sans numéro, URL invalide ; aucune garde sur le nom de `TEST_DATABASE_URL`), #265 (test des variables d'environnement : formes indirectes restantes), #284 (E2E `dates-societe` : le planning public lit la première requête sans l'attendre, course sous charge), #287 (E2E : signature au doigt sur téléphone, défilement mesuré par `window.scrollY`, instable sous forte charge), #288 (E2E `entetes-mobile` : un texte rogné par un cadre `overflow-hidden` échappe à la mesure), #290 (test sentinelle du planning : une sous-route future de `/api/planning/share` échapperait au contrôle `requireAdmin`), #291 (tests de verrou : repérer l'attente par la transaction qui tient la ligne ; nom de l'auteur quand le titulaire confie son chantier), #295 (conversion des devis : la cible de la clé du formulaire n'est pas testée, audit de #294) et #296 (notes du troisième audit de #293 : sonde du verrou tenu, table renommée après une interruption, migration modifiée après coup), dont les tests (#295 ; N1 et N2 de #296) sont repris par la PR de tests [#298](https://github.com/Noxia-Groupe/iris/pull/298) ; la règle tirée de la note N3 de #296 (migration modifiée) est reportée en section 5.

## 2. Pilote

Décisions de Nelson du 16-10-2026. Méthode : le périmètre du pilote est la boussole ([CLAUDE.md](../CLAUDE.md#méthode-de-travail-décision-de-nelson-du-16-10-2026)) ; chaque lot fait l'objet de sa propre PR.

**Périmètre (A1) : option 1, SAV et maintenance.** Clients, sites et contacts, devis, interventions SAV, contrats de maintenance et leurs visites, planning, facturation des interventions et des contrats. Ces écrans existent. Les réponses du 16-10-2026 tranchent les questions bloquantes (A) du tri de ce jour.

**Décidés pour le premier jour** (recommandation A1 acceptée, et A8) : lots 1 à 3, dans l'ordre proposé ; lots 4 à 6, placés avant le premier jour par Nelson le 21-10-2026 (« Oui », [historique](HISTORIQUE-DECISIONS.md#décisions-du-21-10-2026)), dans l'ordre 4, 5, 6 retenu par Claude Code (« Ordre de travail », plus bas).

| Lot | Statut | PR |
|---|---|---|
| 1. Règlements (A3) | **Implémenté** (P1a). P1b, sur les commissions actuelles, est sans objet. | #155, garde en base renforcée par #158 ; commissions fermées par #159 |
| 2. Catalogue dans les devis (A8) | **Implémenté** | #161 |
| 3. Parcours technicien sur téléphone | **Implémenté** : prérequis et droits (3a), parcours sur téléphone (3b-1 à 3b-4) et planning limité du technicien. Non validé pour mise en service. Le découpage du serveur qui devait le précéder est terminé (chantier technique 2, plus bas) | #166 (3a), #255 (3b-1), #257 (3b-2), #268 (3b-3), #272 (3b-4), #275 (planning limité) |
| 4. Conversion des devis (A7) | **Implémenté** : intervention et contrat depuis un devis signé ; règles (a) et (b) posées en question (section 3). Non validé pour mise en service | #281 |
| 5. Génération automatique des visites (A9) | **Implémenté** : passage quotidien côté serveur, anticipation paramétrable, alerte et passage manuel ; questions (a) à (c) posées (section 3). Non validé pour mise en service | #293 |
| 6. Envoi des documents (A10) | **Partiel** : décisions du 22-10-2026 (repli par la messagerie, option B de P5, deux temps, tous les documents) ; 6a-1 **implémenté** (modèle PDF commun, identité et logo de l'émetteur figés sur les factures et les avoirs) et 6a-2 **implémenté** (PDF du devis, copies prises à la signature), non validés pour mise en service ; 6a-3, 6a-4 et 6b prévus. **Avant le premier jour** (décision de Nelson du 21-10-2026) | #300 (6a-1), #301 (6a-2) |

1. **Règlements (A3).**
   - Périmètre : saisie manuelle des encaissements, affectés aux factures (règlements partiels, reste dû, facture partiellement réglée). Banque et rapprochement viennent plus tard. Montants : exigence maximale (règle 2).
   - Saisie et contre-passation sont réservées à l'administration, y compris pour un client désactivé (choix par défaut, à confirmer).
   - Règles de montants validées par Nelson le 17-10-2026 :
     - reste dû = TTC − avoirs émis − règlements non contre-passés ;
     - une facture est réglée dès que le montant enregistré atteint ou dépasse ce qui reste dû, le surplus devenant un trop-perçu ;
     - une facture soldée par ses seuls avoirs reste émise ;
     - une facture qui a reçu un règlement ne s'annule plus en totalité.
   - Décision A3 : l'« encaissé » qui ouvre une commission se déduit des règlements, et non plus d'une case cochée sur le chantier.
   - Commissions : sans plan commercial, aucune commission (décision du 17-10-2026). L'« encaissé » déduit des règlements sera repris par le plan commercial (lot (i)), si bien que la PR prévue sur les commissions actuelles (P1b) est sans objet. D'ici là, la case « Encaissé » du chantier reste cochée à la main.
2. **Catalogue dans les devis (A8).**
   - Lignes reprises du catalogue et copiées figées dans le devis, avec un prix d'achat prévu en option.
   - Implémenté par #161 : recherche des fiches actives, ligne pré-remplie puis copiée (référence recopiée par le serveur), prix d'achat prévu repris de la fiche et réservé à l'administration, devis signé figé en base.
   - Plus tard : connexion par API, ou autrement, aux catalogues des fournisseurs.
3. **Parcours technicien sur téléphone** : planning du jour, intervention, rapport, signature, heures, qualifiés sur téléphone.
   - **3a, prérequis et droits, implémenté par #166** : lien entre le compte technicien et sa fiche intervenant, posé par l'administration et journalisé ; file « à planifier » ouverte aux interventions curatives ; écritures hors affaire retirées au technicien (planning, types d'événement, catégories, fournisseurs, placement de sa propre intervention), planning en consultation seule, Administration fermée.
   - **3b, parcours sur téléphone, implémenté** : interventions du jour, fiche intervention (adresse, téléphone), compte rendu et signature sans fenêtres du navigateur, heures, tests à 375 px avec de vraies données. Découpage en quatre PR ([#253](https://github.com/Noxia-Groupe/iris/issues/253)) :
     - **3b-1, implémenté par #255** : comptes rendus en ajout seul et signatures figées en base (#223) ;
     - **3b-2, implémenté par #257** : heures du technicien sur une intervention hors contrat ;
     - **3b-3, implémenté par #268** : compte rendu et signature dessinée, sans fenêtres du navigateur ; tracé, enregistreur, verrous, journal, protection contre le double envoi ; règle de clôture ;
     - **3b-4, implémenté par #272** : « Ma journée » et fiche intervention sur téléphone, E2E à 375 px avec de vraies données.
   - Décisions de Nelson du 17-10-2026 :
     - le technicien saisit aussi ses heures sur une intervention SAV hors contrat (**implémenté** par #257). Une telle intervention est payante ; elle peut passer par un devis, au forfait ou au temps passé. Au temps passé, une heure au moins est facturée, et toute heure commencée est due (règle de facturation, à appliquer avec le devis et la facture d'intervention ; placement proposé, à confirmer : lot 4 ou suivant) ;
     - la signature du client se dessine au doigt, en plus du nom et de l'acceptation explicite (**implémenté** par #268).
   - Décisions de Nelson du 19-10-2026 (#253), chaque fois sur l'option recommandée :
     - terminer une intervention exige un compte rendu signé ; à défaut, un motif est choisi (client absent, refus de signer, signature impossible, autre) et consigné au journal. Précisé le 20-10-2026 : un compte rendu est toujours exigé, seule la signature peut être remplacée par le motif ; le motif « autre » exige une précision écrite courte ; la règle vaut pour le technicien comme pour l'encadrement. **Implémenté** par #268 ;
     - les heures du technicien hors contrat vont dans les coûts SAV, en durée brute sans arrondi, sans effet sur la marge des chantiers ; l'administration voit leur coût de main-d'œuvre (**implémenté** par #257, libellé « Main-d’œuvre cumulée » validé le 20-10-2026) ;
     - la signature dessinée est un tracé vectoriel figé : coordonnées normalisées, sans horodatage ni pression ; taille bornée ; tracé inclus dans l'empreinte et figé en base ; auteur de l'enregistrement conservé (**implémenté** par #268) ; durée de conservation à confirmer avec le cabinet ;
     - le planning du technicien est limité à ce dont il est chargé, dans une PR séparée, après le 3b (**implémenté** par #275 ; périmètre et choix par défaut en section 4). La décision de Nelson du 21-10-2026 l'étend (« Des 2 », **implémenté** par #279) : il voit aussi les affectations des chantiers dont il est titulaire ; le lien public reste ouvert à toute personne qui en a l'adresse.
4. **Conversion des devis (A7)** : « devis → intervention » et « devis → contrat », en plus de « devis → chantier ». Statuts et données transférées : à cadrer dans la PR du lot. Ne pas les déclarer livrées simplement parce que ces modules existent. **Implémenté** par #281 (choix par défaut en section 4, questions (a) et (b) en section 3).
5. **Génération automatique des visites de maintenance (A9)** : génération quotidienne côté serveur, avec une anticipation paramétrable et une alerte en cas d'échec, sans IA. **Implémenté** par #293 (choix par défaut en section 4, questions (a) à (c) en section 3).
6. **Envoi des documents (A10)** : mode d'envoi choisi dans les paramètres généraux, Microsoft 365 par défaut.
   - Décisions de Nelson du 22-10-2026 ([historique](HISTORIQUE-DECISIONS.md#décisions-du-22-10-2026), citations et lecture retenue) :
     - si Microsoft 365 n'est pas prêt, repli « du style mailto » : la messagerie s'ouvre avec le destinataire, l'objet et le texte remplis ; un lien `mailto:` ne joint aucun fichier, le PDF est téléchargé en même temps et joint à la main ;
     - P5, option B : seul ce que l'envoi exige accompagne le lot 6 (modèle PDF commun ; identité et logo de l'émetteur copiés à l'émission des factures et des avoirs) ; libellés des visites, export comptable et modèles personnalisables après le premier jour ;
     - deux temps : envoi manuel avec ses PDF et son journal (6a), puis Microsoft 365 (6b) ;
     - tous les documents : factures et avoirs, devis, rapport de chantier, compte rendu d'intervention, contrat de maintenance.
   - Découpage retenu par Claude Code : 6a-1, modèle commun et identité figée (**implémenté** par #300, choix par défaut en section 4) ; 6a-2, PDF du devis (**implémenté** par #301, choix par défaut en section 4) ; 6a-3, envoi par la messagerie et journal des envois ; 6a-4, PDF des autres documents et leur envoi ; 6b, Microsoft 365.
   - Journal des envois : choix par défaut, à confirmer.
   - Ne pas déclarer l'envoi Outlook ni la synchronisation réalisés du seul fait du SSO.

**Facturation électronique (A2).**
- Si l'entreprise pilote est une PME, le pilote fonctionne en PDF avec l'export comptable. Le lot Factur-X avec plateforme agréée est cadré pour l'échéance d'émission des PME (calendrier à faire confirmer par le cabinet).
- Reste à connaître la taille de l'entreprise pilote et la plateforme retenue.
- La réception des factures électroniques, obligatoire pour toutes les entreprises depuis le 01-09-2026 selon notre lecture du calendrier, est assurée hors d'Iris (plateforme de l'entreprise) : à faire confirmer par le cabinet.

**Travaux** (chantiers, heures, achats, rentabilité, facture d'affaire) : ces écrans existent, mais l'option 2 n'a pas été retenue ; leur place dans le pilote est une question ouverte. Ils touchent le pilote par la conversion « devis → chantier » existante.

**Hors pilote** : banque et rapprochement, abonnements et locations (lot (k)), télécom, financeurs, plan commercial (lot (i)), astreintes (lot (j), A6 : hors pilote, ou un simple affichage sans calcul).

### Lots décidés hors pilote

- **(i) Plan commercial** (décision du 14-10-2026). La rémunération des commerciaux se règle par des plans commerciaux paramétrables, simples à mettre en œuvre et assez souples pour laisser de la liberté au fonctionnement des commissions :
  - plusieurs plans peuvent coexister : un plan ne vaut pas forcément pour toute la société, et chaque commercial se voit attribuer le sien ;
  - le mois de rattachement d'une commission se paramètre par plan :
    - fait générateur : la fin du chantier, ou la commande signée ;
    - jour de coupure défini dans les options (par exemple le 20 de chaque mois), qui laisse à la comptabilité le temps de préparer les paies : au-delà, le rattachement passe au mois suivant (M+1) ;
  - les commissions sur les abonnements et les contrats de location peuvent être activées :
    - « en développé » : une commission sur le total des paiements prévus pendant toute la durée du contrat ;
    - ou à la prise de commande de l'abonnement ou de la location : un nombre de mois, ou un pourcentage du montant mensuel.

  Le lot recouvre les profils de commission attribués par personne et versionnés de l'[issue #15](https://github.com/Noxia-Groupe/iris/issues/15) (section 1, « Commissionnement »), dont la non-rétroactivité est décidée le 16-10-2026 (A5, ci-dessous). Existant à prendre en compte :
  - le barème progressif, les objectifs, les primes et le barème réduit (`ParametresRemuneration`, Administration > Marges & Commissions) se règlent pour toute la société, mais ne sont plus appliqués depuis #159 (plus bas). Le calcul conservé fait naître une commission d'un chantier encaissé, rattachée au mois de sa clôture, et ne reçoit plus que des règles neutres ;
  - tant qu'elles étaient appliquées, ces règles étaient relues à chaque calcul : modifier un barème recalculait aussi les mois passés. L'issue #15 prévoit le gel de la règle et du montant au fait générateur ; A5 en décide pour le plan commercial (changement de plan à la date d'affectation), reste la date qui compte pour une affaire (question plus bas) ;
  - le mois de rattachement se lit en UTC sur la date de clôture, qui retombe sur la dernière modification (un instant) quand la date de fin manque : à reprendre au jour de la société avec le fait générateur (sans objet tant qu'aucune donnée n'existe) ;
  - le devis ne porte pas de commercial, qui se fixe sur le chantier : la commande signée comme fait générateur suppose de le connaître dès le devis ;
  - les commissions sur abonnements et locations supposent des contrats qui n'existent pas encore : `ContratMaintenance` ne porte ni montant, ni durée d'engagement, ni date de signature, ni commercial, et Iris n'a pas de contrat de location (ventes récurrentes, phase 9) ;
  - les commissions sur contrats récurrents et les primes « Boost » n'ont jamais été calculées : elles figuraient en texte dans l'onglet de rémunération, comme document de référence d'une politique de société écrite en dur, retiré par #159 (plus bas).

  Tout changement de montant reste soumis à la validation comptable de Nelson.

  **Décisions du 16-10-2026 (A5)**, pour une flexibilité maximale :
  - le fait générateur de la commission se choisit dans les paramètres généraux : la commande, la fin des travaux, ou la réception du paiement complet. La décision du 14-10-2026 le réglait par plan, avec deux options (fin du chantier, commande signée) : lecture retenue, à confirmer par Nelson, le réglage général du 16-10-2026 la remplace (question plus bas) ;
  - un commercial sans plan n'a pas de commission : il faut lui affecter un plan commercial pour qu'il en ait. Précision de Nelson du 17-10-2026 : « Si pas de plan commercial alors le commercial ne touche pas de commission jusqu'à ce que le plan commercial soit défini et à date et à partir de là le commercial aura ses commissions. » Les commissions actuelles (barème global) sont fermées par #159, **implémenté** :
    - les statistiques (`/api/stats/commerciaux`, `/api/stats/global`) renvoient commissions et primes nulles, avec `sansPlanCommercial`, sans barème ni objectifs ; le CA et la marge validés restent calculés ;
    - « Résultat commercial », « Mes commerciaux », le tableau de bord et l'onglet « Marges & Commissions » affichent « Aucune commission : aucun plan commercial attribué » ;
    - choix par défaut, à confirmer :
      - les blocs de barème et de primes et la colonne de commission par chantier sont retirés des écrans, plutôt qu'affichés à zéro (le plan commercial les redéfinira) ;
      - la carte du tableau de bord s'intitule « Commission commerciale » ou « Ma commission », et non plus « versée » ou « gagnée » ;
      - la saisie du suivi administratif disparaît de « Mes commerciaux » ; sa route reste ouverte aux administrateurs (fait journalisé, sans montant) ;
      - les règles générales restent enregistrables par un super administrateur, sans effet sur aucun montant ; leur libellé du barème réduit nomme toujours la case des chantiers, gardée mais présentée « sans effet tant qu'aucun plan commercial n'est attribué » ;
      - le document de référence de l'onglet de rémunération (primes « Boost », commissions sur contrats récurrents, clauses et reliquat d'une politique de société écrite en dur) est retiré, option la plus restrictive : il contredisait la règle « aucune valeur de société dans le code » et ne s'appliquait pas ;
  - un changement de plan n'est pas rétroactif : il prend effet à la date d'affectation du nouveau plan ;
  - chaque plan a son propre barème ; on peut en créer plusieurs et attribuer celui que l'on veut à chaque commercial.

  Hors pilote.
- **(j) Horaires de la société et astreintes** (décision du 14-10-2026) : chaque société peut avoir son propre fonctionnement, avec des horaires de nuit ou de week-end. Si elle propose un service d'astreinte, Iris attribue des temps d'astreinte spécifiques et organise un roulement automatique ou semi-automatique suivant les règles de rotation de la société. Aujourd'hui, Iris ne connaît ni horaires de la société, ni jours fériés, ni astreinte. Les heures saisies ne portent ni heure de début ni type, avec un seul taux par intervenant. Une affectation du planning ne peut pas passer minuit, et le week-end n'y est que grisé. A6 (16-10-2026) : hors pilote, ou un simple affichage des astreintes sans calcul ; les questions de cadrage (plages, roulement, temps d'astreinte et sa compensation) seront posées quand le lot démarrera.

- **(k) Abonnements et locations** (décision du 16-10-2026, A4), hors pilote, pour une flexibilité maximale :
  - les abonnements sont facturés au client ; en cas de location, ce sont des financeurs, tels que Grenke, avec lesquels Iris aura une API pour faire les simulations directement dans l'ERP ;
  - terme échu ou à échoir, au choix ;
  - durées d'engagement de 12 à 60 mois ;
  - reconduction au choix : tacite ou non ;
  - augmentation automatique possible, selon le calcul habituel par défaut, mais toujours modifiable ou désactivable.

  Le squelette de données proposé est dans [MODELE-DONNEES-CIBLE.md](MODELE-DONNEES-CIBLE.md) (proposition, à valider). Reste à préciser le calcul d'augmentation « habituel » proposé par défaut (question plus bas).

### Ordre de travail (proposé, à confirmer par Nelson)

Depuis le 16-10-2026, l'ordre suit le pilote : voir le tableau des lots ci-dessus. Ordre retenu par Claude Code après les décisions du 21-10-2026 ([historique](HISTORIQUE-DECISIONS.md#décisions-du-21-10-2026)), choix de mise en œuvre : planning étendu du technicien, lot P0, #179, #181, puis les lots 4, 5 et 6 ; ensuite la matrice D1a, puis la PR C du découpage des écrans. Après le pilote, ordre indicatif, à revoir selon les vrais utilisateurs : la facturation électronique (A2) suit l'échéance légale, à confirmer par le cabinet ; puis banque et rapprochement, abonnements et locations (lot (k)), financeurs et télécom, plan commercial (lot (i)), astreintes (lot (j)). La préparation de l'instance pilote (recette métier et sécurité, configuration vide réelle, sauvegarde **et restauration testées**, supervision, validation du cabinet, autorisation explicite de mise en service) reste un préalable à la mise en service ; pas de déploiement automatique.

### Chantiers techniques (décision de Nelson du 17-10-2026)

Quatre chantiers techniques, chacun dans sa ou ses PR, selon les règles habituelles, dans l'ordre décidé : 1, puis 2, puis 3 et 4 en proposition seulement.
1. **Dépendance `xlsx`** : déclarée par le serveur sans être utilisée, et visée par des avis de sécurité. **Implémenté** : retirée par #175. Les autres failles relevées par `npm audit` font chacune l'objet d'une issue, de #168 à #174 (ouvertes).
2. **Découpage de `server/index.ts` par domaine**, sans aucun changement de comportement : mêmes routes, réponses, codes et messages d'erreur, transactions, verrous et contraintes différées.
   - **Serveur : implémenté**, en 14 PR fusionnées : #177 (socle), #184 (outils de preuve), puis #185, #187, #189 à #197 et #199. `server/index.ts`, qui comptait environ 8 000 lignes et enregistrait les 198 routes, n'est plus que le point d'entrée (204 lignes à la fin du découpage) : bibliothèques et `.env`, réglages et middlewares globaux, appels des fonctions d'enregistrement dans l'ordre d'origine, démarrage, exports lus par les tests. Les routes et la logique sont dans `server/src/`, rangées par domaine ([server/src/README.md](../server/src/README.md)). Le plus gros fichier de code applicatif du serveur comptait alors 502 lignes ; `server/src/domaines/utilisateurs/comptes.ts` en compte 576 depuis les garde-fous des comptes (#216, #224, #228).
   - Preuves :
     - le vérificateur par instruction (`server/scripts/verifier-deplacement.mjs`), rejoué par la CI, s'applique depuis #184 aux PR qui déplacent du code : il retrouve chaque instruction de la base à l'identique et dans l'ordre. Pour #177, une première version, ligne à ligne, a été complétée par un contrôle octet pour octet de l'audit ;
     - `server/scripts/routes.mjs --verifier` compare les routes, gardes, middlewares, exports et lectures de l'environnement à une référence écrite avant le découpage ;
     - les suites API et E2E ont été passées deux fois pour #177 et pour #185 à #199, sans aucun test modifié ;
     - chaque PR a eu un audit indépendant, avec une comparaison entre la base et la PR à l'exécution : droits (#185), journal (#187), différentiel HTTP de #189 à #199 ; au niveau de rigueur maximal pour #195 à #199 (factures, règlements, comptabilité, commissions, démarrage).
   - Suivi : #186 et #188 (renforcer les outils de preuve, étiquette `suivi-audit`) ; #198 (sommes en flottants des statistiques), tranchée par Nelson le 18-10-2026, corrigée par #208.
   - **Écrans du client : partiel.** Proposition [DECOUPAGE-ECRANS-CIBLE.md](DECOUPAGE-ECRANS-CIBLE.md) (#200) : déplacement pur, état laissé dans la page, fichiers à plat dans `components/` ; principe validé par Nelson le 18-10-2026.
     - Outil de comparaison du rendu : implémenté (#209, `npm run comparer:rendu`, 79 étapes) ; il n'est pas lancé par la CI, chaque PR de découpage joint son relevé.
     - PR A, Planning : implémentée (#213), `Planning.tsx` passe de 873 à 406 lignes.
     - PR B, Administration : implémentée (#214), `Admin.tsx` passe de 1 477 à 684 lignes (698 depuis #234).
     - PR C, fiche chantier : à faire. #208, qui modifiait aussi `ChantierDetail.tsx`, est fusionnée ; l'écran compte 1 480 lignes depuis #280 et reste le seul au-delà de 800. La PR C vient après le lot pilote 6 et la matrice D1a (ordre retenu par Claude Code le 21-10-2026, section « Ordre de travail » plus haut).
     - Anomalies relevées, une issue chacune (#202 à #206) : à corriger après les trois déplacements, chacune dans sa PR.
3. **Droits flexibles et simples à paramétrer** : proposition [`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md), avec son [inventaire](MODELE-DROITS-INVENTAIRE.md) (permissions élémentaires, périmètres, rôles paramétrables, hiérarchie facultative, modèles « petite équipe » et « équipe avec hiérarchie », migration rôle par rôle à comportement identique). Questions ouvertes arbitrées le 18-10-2026 par délégation de Nelson (section 10 du document). Proposition validée par sa fusion (#182), selon la décision de Nelson du 20-10-2026 (« C’est toi qui fusionne TOUTES les PR »). Parcours de droits : règle 2. Modèle cible (D1 à D4) **prévu**, rien n'en est implémenté. Lot D0 **implémenté**, non validé pour mise en service, une PR par défaut relevé par l'inventaire : #178, #179, #180 et #181 corrigés (#216, #282, #217, #283), avant la fin du pilote comme l'a décidé Nelson le 21-10-2026.
4. **Paramétrage plutôt que règles en dur** : proposition [`PARAMETRAGE-CIBLE.md`](PARAMETRAGE-CIBLE.md), avec son [inventaire](PARAMETRAGE-INVENTAIRE.md) (inventaire des règles classées en déjà paramétrables, à rendre paramétrables, ou à garder dans le code ; assistant de démarrage dans Paramètres). Aucune valeur métier inventée. Questions ouvertes arbitrées le 18-10-2026 par délégation de Nelson (section 6 du document). Proposition validée par sa fusion (#183), selon la décision de Nelson du 20-10-2026 (« C’est toi qui fusionne TOUTES les PR »). **Prévu**, sauf le lot P0, **implémenté** par #280 (non validé pour mise en service ; choix par défaut en section 4), et l'anticipation de la génération des visites, implémentée avec le lot pilote 5 (#293, non validé pour mise en service). Lot P0 placé avant la fin du pilote (décision de Nelson du 21-10-2026), et avant le premier jour selon la lecture retenue ([historique](HISTORIQUE-DECISIONS.md#décisions-du-21-10-2026)) : « il ne doit plus y avoir de noxia groupe dans l’application » ; la page de connexion porte le nom de l'application (graphie : choix par défaut du lot P0, à confirmer).

Deux règles permanentes de conception sont ajoutées le même jour à [CLAUDE.md](../CLAUDE.md#règles-permanentes-de-conception-décision-de-nelson-du-17-10-2026) et à [AGENTS.md](../.agents/AGENTS.md) : une nouvelle règle propre au fonctionnement d'une entreprise devient un paramètre, avec une valeur par défaut documentée ; aucun fichier de code applicatif ne dépasse environ 800 lignes. Une troisième, sur les variables d'environnement toujours documentées, s'y ajoute le 20-10-2026 (consigne de Nelson : CLAUDE.md par #263, AGENTS.md par la PR documentaire du 20-10-2026).

## 3. Questions ouvertes pour Nelson

Tri du 16-10-2026 : les questions bloquantes (A) sont tranchées plus haut (pilote, lots (i) et (k)). Restent ouvertes :
- **Travaux dans le pilote** : les écrans des chantiers (heures, achats, rentabilité, facture d'affaire) restent-ils ouverts au pilote en l'état, sans lot préalable ?
- **Lot (i), fait générateur** : réglage unique dans les paramètres généraux (A5, 16-10-2026) ou réglage par plan (14-10-2026) ? Lecture retenue : le réglage général remplace le réglage par plan.
- **Lot (i), jour de coupure** (montants) : la décision du 14-10-2026 le place dans les options du plan (par exemple le 20). Suit-il le fait générateur dans les paramètres généraux, ou reste-t-il propre à chaque plan ? Un fait générateur survenu le jour même (le 20) se rattache-t-il encore au mois ? « Sinon fin de chantier à mois + 1 » désigne-t-il seulement les faits générateurs postérieurs à la coupure, ou aussi un mode où toute commission se rattache au mois suivant ?
- **Lot (i), structure du barème** (montants) : A5 donne à chaque plan son propre barème. Le barème progressif, les objectifs, les primes et le barème réduit actuels deviennent-ils les règles de chaque plan, avec des valeurs propres ? Paliers, hiérarchie et validation des montants restent à préciser.
- **Lot (i), changement de plan** (montants) : la date qui compte pour une affaire est-elle celle de la commande ou celle du fait générateur ? Si le fait générateur est la commande, le commercial doit-il être connu dès le devis (il ne se fixe aujourd'hui que sur le chantier) ?
- **Acompte et encaissé** (montants, lot pilote 1) : l'acompte constaté sur un devis (`Devis.acompteMontant`, `acompteRecuLe`), rattaché à aucune facture, entre-t-il dans le reste dû des factures de l'affaire ? À quel moment une affaire devient-elle « encaissée » pour la commission : toutes ses factures réglées, ou un autre seuil ?
- **Commissions récurrentes** (montants, lots (i) et (k)) : le mode décidé le 14-10-2026 (activable, « en développé » ou à la prise de commande, en nombre de mois ou en pourcentage du montant mensuel) se règle-t-il dans le plan ou dans les paramètres généraux ?
- **Lot (d), marge du commercial** (montants) : sans être destinataire de la rentabilité, le commercial retrouve le coût de main-d'œuvre de ses affaires par la marge de chaque chantier de ses statistiques, qui sert de base à sa commission. L'accepter, ou réserver cette marge par chantier aux administrateurs ?
- **Lot (d), approche par essais successifs** (montants) : l'alerte de dépassement de main-d'œuvre, avec le droit de corriger des heures, permet d'approcher le coût de main-d'œuvre d'un chantier par essais successifs, tracés au journal. Elle reste affichée à un titulaire, ou à un compte Responsable de sa branche, à qui la société a retiré la rentabilité (réglage des destinataires de la rentabilité). L'accepter, ou réserver cette alerte aux destinataires de la rentabilité ? Limite relevée par #134, restée à arbitrer.
- **Augmentation automatique des abonnements et locations (lot (k))** : quel calcul « habituel » proposer par défaut (indice de révision, et lequel, ou pourcentage fixe) ? Il touche les montants : Iris n'en invente pas.
- **Facturation électronique (A2)** : taille de l'entreprise pilote et plateforme agréée retenue, et confirmation que la réception des factures électroniques est assurée hors d'Iris, avec le cabinet.
- **API des financeurs (lot (k))** : périmètre de l'intégration Grenke (simulations seules, ou aussi les dossiers), à préciser quand le lot démarre.
- **Sélection des clients (#139)** : Factures et Devis doivent-ils passer au sélecteur commun `SelecteurClient` (leur liste initiale est tronquée à 200 sans le dire), et les sélecteurs recevoir une réponse allégée, sans contacts ni sites ? Points restés à arbitrer depuis #139 ; s'il s'agit d'un micro-arbitrage d'affichage (règle 5), il sera tranché dans la PR qui les traite.
- **Mentions légales, date de republication** : republier une ancienne version des mentions ne lui donne pas de nouvelle date de publication (`publieeLe` n'est fixé qu'à la première publication). Faut-il la dater ? L'auteur de la création et de la publication fait déjà l'objet d'un choix par défaut (section 4) ; ce trou-ci n'en a pas.
- **Arrondi du coût de main-d'œuvre** (montants, relevé par l'audit de #208) : la fiche chantier somme les produits exacts puis arrondit une fois, alors que l'écran Heures arrondit chaque ligne au centime et que le total SAV de #257 additionne des lignes arrondies. Quelle convention retenir partout ?
- **Sécurité de la connexion (#261, #264)** : faut-il corriger avant la fin du pilote, malgré la règle du 19-10-2026, le blocage commun de l'accès de secours derrière les proxys (#261) et l'autorisation Microsoft 365 fondée sur l'adresse plutôt que sur `oid` et `tid` (#264) ? Les deux touchent la sécurité (règle 2).
- **Signature dessinée** : durée de conservation du tracé, à confirmer avec le cabinet (décision du 19-10-2026).
- **Règle de clôture d'une intervention (règle permanente 1)** : la règle décidée les 19 et 20-10-2026 et ses quatre motifs restent dans le code (#268). Faut-il en faire des paramètres, avec cette décision pour valeur par défaut (par exemple une liste de motifs tenue par la société), ou les garder dans le code comme preuve de l'intervention ? Un compte rendu reste toujours exigé (proposition de paramétrage, section 3.2).
- **Catalogue dans les devis (lot pilote 2, #161)** :
  - (montants) le prix d'achat prévu des lignes de devis doit-il alimenter le chantier ouvert (budget matériel prévu, marge estimée), à la place de la moyenne des chantiers terminés ?
  - (montants) les heures vendues d'un chantier additionnent la quantité des lignes de main-d'œuvre, quelle que soit leur unité : une prestation au forfait y compte pour une heure. Convertir par la durée indicative de la fiche, ne compter que les lignes à l'heure, ou garder ce calcul ?
  - la vision veut un devis figé dès son envoi ; le code le fige à la signature, un devis envoyé non signé restant modifiable. Lequel retenir ? Les copies imprimées sur le devis (identité de l'émetteur, client, fuseau de la société) sont prises au même moment que le figement : à la signature depuis le lot 6a-2 (#301), elles suivraient un figement à l'envoi.
- **PDF du devis (lot 6a-2, #301)** (mentions, à confirmer avec le cabinet) : faut-il imprimer sur le devis une durée de validité (paramètre de la société, absent aujourd'hui), les conditions générales de vente de la version légale active, ou d'autres mentions propres au métier (assurance professionnelle, par exemple) ? Le devis imprime aujourd'hui l'identité de la société, le client, les lignes, la ventilation de la TVA, le taux d'acompte demandé et le pied de page des documents.
- **Conversion des devis (lot pilote 4, #281)** (règles métier) :
  - (a) une affaire ne se convertit qu'une fois, quelle que soit la cible (décision du 14-10-2026 pour le chantier, étendue par #281) ; un devis qui vend une installation et son contrat de maintenance ne crée donc pas les deux. Garder cette règle, ou permettre un chantier et un contrat (ou une intervention) pour la même affaire, ce qui change le modèle (`DevisConversion.dossierId` unique) ?
  - (b) un devis converti en intervention ou en contrat ne s'annule plus (l'intervention s'annule, le contrat se suspend ou se termine depuis leurs écrans), alors qu'un devis converti en chantier s'annule avec lui. Garder, ou annuler la cible avec le devis ?
- **Génération automatique des visites (lot pilote 5, #293)** (règle nouvelle, règles métier et modèle de données ; appliquées par défaut, voir section 4) :
  - (a) anticipation de 30 jours par défaut, appliquée dès la mise en service : la garder, en retenir une autre, ou livrer la génération désactivée (vide) jusqu'au réglage par la société (règle permanente 1 : une valeur non décidée d'une règle nouvelle est posée en question) ?
  - (b) le passage avance lui-même l'échéance d'une visite terminée, et ne saute aucune échéance passée (sa visite est créée en retard, puis les suivantes une à une au fil des visites terminées) : garder, ou reprendre à la prochaine échéance à venir ?
  - (c) les écritures du passage n'ont pas de compte auteur : la base admet un auteur vide au journal SAV pour la seule « Génération automatique » (création de la visite, avancement de l'échéance), alors que #67 exigeait que toute trace désigne un compte Iris réel. Garder, ou porter ces écritures par un compte système qui ne se connecte pas ?

## 4. Choix par défaut, à confirmer

Règle 5 : sur un micro-arbitrage, l'option la plus simple et, en cas de doute, la plus restrictive. Nelson les corrige si besoin. Chaque choix porte son état : **appliqué** (avec sa PR), **appliqué à l'écran** (ce que le serveur ne vérifie pas encore est précisé) ou **à appliquer** (lot à planifier, sauf mention).

**Droits et comptes**
- Création d'intervention : refusée si le chantier visé est hors du périmètre de lecture du conducteur. **À appliquer** : le serveur ne contrôle aujourd'hui que le client et l'annulation du chantier.
- Directeur : statistiques Travaux et planning restent fermés. **Appliqué** (état actuel ; le tableau de bord lui reste ouvert).
- Directeur commercial, assistante commerciale et comptable, refusés comme le commercial sur le planning et les écritures des référentiels (décision 11, #179) : le message nomme leur type de compte (« Accès non autorisé pour un compte directeur commercial. », « … assistante commerciale. », « … comptable. »), comme ceux du commercial et du directeur, plutôt que le message du commercial. **Appliqué** (#282).
- Clients désactivés : l'annuaire et l'API clients (liste, recherche, fiche) les ferment aux comptes non administrateurs et aux clés d'intégration.
  - Option la plus restrictive, cohérente avec le retrait des taux et du coût de main-d'œuvre aux clés.
  - Comme pour le technicien, une intervention ou un chantier déjà rattaché garde le nom du client pour ceux qui y ont accès : sans lui, le dossier ne peut pas être traité (exception justifiée).
  - Les règlements, réservés à l'administration (lot pilote 1), restent possibles pour un client désactivé.
  - **À appliquer**, sauf pour le technicien (#128) et pour les règlements (#155).
- Clé d'intégration : elle expire au début du jour civil indiqué. **À appliquer** : l'échéance est lue telle quelle.
- Compte devenu super administrateur entre-temps : un simple administrateur qui agit dessus reçoit aujourd'hui « Seul un super administrateur peut gérer un compte super administrateur. », qui lui révèle un compte masqué dans sa liste. Option la plus restrictive : lui répondre « Utilisateur introuvable. », comme la liste. **À appliquer** (#239).
- Clôture : un conducteur ne clôture pas l'affaire d'un technicien ; un Responsable ne clôture pas les chantiers des conducteurs de sa branche. **Appliqué** (#123, #128). C'est aussi la lecture retenue, à confirmer par Nelson, de sa réponse du 14-10-2026 : l'affaire d'un technicien est clôturée par l'administration, les comptes Responsable dont la branche contient le technicien et les directeurs ; dans une chaîne technicien → conducteur sans compte Responsable, seuls les directeurs et l'administration la clôturent.

**Technicien**
- Pas d'alerte « heures dépassées ». **Appliqué** (#123).
- « Consultation seule » et refus explicite conservés. **Appliqué** (#123).
- Son affaire n'est modifiable que par l'administration. **Appliqué** (#123).
- Aucun accès financier : déduction de #123 (aucun montant), à confirmer. **Appliqué** (#123).
- Ses écritures hors affaire (planning, catégories, fournisseurs) lui sont retirées au lot du parcours technicien. **Appliqué** (#166), y compris le placement de sa propre intervention : il ne replanifie pas et ne change pas les intervenants de son dossier. Il garde la lecture de son planning, limitée depuis #275 aux affectations dont il est chargé, et depuis #279 aussi à celles des chantiers dont il est titulaire (plus bas), et des référentiels, et n'a plus l'Administration.
- Seul un compte technicien actif, relié à aucune autre fiche, se relie à une fiche intervenant. Un compte qui quitte ensuite le type technicien perd sa fiche (déliée et journalisée dans la même transaction) : par ses affectations, elle lui ouvrirait les interventions avec les écritures de son nouveau type. La liaison se sérialise avec le changement de type et la suppression du compte (#228) ; seule une promotion super administrateur simultanée à une liaison est refusée (409), à refaire. Un compte désactivé garde sa fiche, sans pouvoir se connecter. Un simple administrateur ne touche pas à la fiche d'un compte super administrateur. **Appliqué** (#166, #228).
- Une intervention curative placée depuis la file reçoit une durée proposée de 60 minutes, modifiable avant de confirmer. **Appliqué** (#166).
- Le mode hors ligne (zone sans réseau) reste hors du lot pilote 3.
- Sur une intervention qui lui est affectée, il garde le nom du client, l'adresse du site et le téléphone du contact, même désactivés : sans eux, il ne peut pas réaliser l'intervention qu'on lui confie. C'est une exception justifiée à l'option la plus restrictive ; la fiche du client désactivé lui reste fermée. **Appliqué** (état actuel).
- Un compte qui quitte le type technicien perd son droit individuel de lecture des clients. **À appliquer**.

**Lot pilote 3b et planning limité** (#253 ; la règle de clôture et le planning limité sont des décisions de Nelson, section 2)
- Un compte rendu est figé dès son enregistrement : une correction passe par un compte rendu complémentaire. La signature est figée à sa création et reste possible après « Terminée ». **Appliqué** : figement en base par #255 ; signature après « Terminée » : état actuel de la route.
- Une date d'heures postérieure au jour de la société est refusée (400), en saisie comme en correction, y compris sur les interventions de contrat. **Appliqué** (#257).
- « Interventions du jour » : le jour civil de la société, calculé par le serveur ; planifiées et en cours triées par créneau, terminées du jour en bas, rubrique des interventions restées ouvertes les jours précédents, annulées exclues ; navigation jour précédent et jour suivant. **Appliqué** (#272).
- Le client signe le compte rendu seul ; l'attestation des heures se reverra avec la facturation au temps passé (lot 4 ou suivant). **Appliqué** (#268).
- Tracé de la signature borné à 50 traits et 2 000 points, proportions de la zone entre 0,5 et 10 ; une signature ordinaire compte quelques centaines de points. **Appliqué** (#268).
- Précision du motif « Autre » : 3 à 200 caractères, comptés en points de code. **Appliqué** (#268) par l'API ; le champ de l'écran limite encore la saisie à 200 unités UTF-16, soit 100 emoji (#269, N-f).
- Une clôture avec au moins un compte rendu signé, même si un complément ne l'est pas, ne demande pas de motif, et un motif donné est refusé (409). **Appliqué** (#268).
- L'encadrement ajoute un compte rendu et fait signer depuis l'écran, comme l'API le permettait déjà ; la règle de clôture vaut pour lui. **Appliqué** (#268).
- Un compte rendu hors d'une intervention en cours est refusé par 409 avec un message, au lieu de 404. **Appliqué** (#268).
- L'accueil du technicien mène à « Ma journée ». Adresse affichée : celle du site, à défaut celle du chantier ; téléphone : celui du contact. **Appliqué** (#272).
- Ajoutés par #272 (« Ma journée ») :
  - une intervention terminée « du jour » est une intervention terminée dont la projection couvre le jour ; l'instant de sa clôture n'est pas lu ;
  - la rubrique des interventions restées ouvertes n'apparaît que pour aujourd'hui ;
  - une intervention affectée sans projection au planning ne figure pas dans la journée ; elle reste dans « Mes interventions » ;
  - la fiche d'une intervention annulée est introuvable, comme dans la liste ;
  - ordre des créneaux : celui du planning ;
  - la journée et le créneau de la liste se lisent même quand le module Planning est désactivé.

  **Appliqués** (#272), à confirmer.
- Ajoutés par #275 (planning limité) :
  - « chargé » veut dire que sa fiche intervenant figure parmi les intervenants de l'affectation ; être titulaire du chantier d'une affectation ne suffit pas. **Remplacé** par la décision de Nelson du 21-10-2026 : ses affectations et celles des chantiers dont il est titulaire (implémenté par #279) ;
  - une affectation partagée lui montre ses coéquipiers ;
  - la liste des chantiers du planning lui est refusée (403), et non réduite à ses chantiers, puisqu'il ne crée pas d'affectation ;
  - il garde la lecture des types d'événement ;
  - le lien public du planning reste complet : il montre tout le planning à qui en a l'adresse. **Confirmé** par Nelson le 21-10-2026 : « Lien public a tout le monde disposant de l’adresse. »

  **Appliqués** (#275). Le premier est remplacé et le dernier confirmé par Nelson le 21-10-2026 ; les trois autres restent à confirmer.
- Ajoutés par #279 (planning étendu aux chantiers dont il est titulaire) :
  - une affaire annulée sort de son planning de titulaire, comme de sa liste de chantiers ; il y garde les affectations où figure sa fiche ;
  - la projection d'une intervention rattachée à son chantier reste soumise au périmètre SAV : il ne la voit que s'il y est affecté ;
  - la ligne d'un collègue ne paraît que les semaines où l'une de ses affectations lui est envoyée, et ne montre que celles-là ; un technicien qui n'est titulaire d'aucun chantier voit ainsi la ligne du coéquipier d'une affectation partagée.

  **Appliqués** (#279), à confirmer.
- Ajoutés par #283 (#181, lot D0, réattributions et encaissement journalisés) :
  - la réattribution du titulaire et du commercial, et la case « Encaissé », s'écrivent au journal des saisies du chantier, lu dans le journal d'audit de la fiche, plutôt qu'au journal d'administration ;
  - le titulaire peut toujours confier son chantier à tout compte actif, l'écran ne proposant que les conducteurs actifs (règle reproduite en D1 ; cible D2 : décision 9 de la proposition de droits) ; chaque réattribution est journalisée.

  **Appliqués** (#283), à confirmer.

**Journal des paramètres et des droits** (lot (a), #133)
- L'auteur de la création et de la publication des mentions légales, et la création des comptes comptables, sont journalisés. **À appliquer**.
- Les taux horaires des intervenants (des montants) sont journalisés ; les autres référentiels (catégories, fournisseurs, types de planning, catégories du catalogue) et la préférence de thème d'un compte ne le sont pas. **À appliquer** pour les taux horaires ; le reste est l'état actuel.
- Les entrées faites par un super administrateur sont fermées à un simple administrateur, comme celles qui concernent un compte super administrateur (option la plus restrictive). **À appliquer** : seules les secondes sont fermées (#133).
- Une entrée est aussi fermée quand le compte concerné est devenu super administrateur depuis : son nom et son adresse ne réapparaissent pas dans le journal alors que la liste des comptes les masque (option la plus restrictive). **À appliquer**.
- La conversion d'un devis garde son auteur et le titulaire choisi. **À appliquer** : la conversion n'a pas d'auteur.

**Lot (d), taux horaire et coût de main-d'œuvre** (#134)
- Pour les destinataires de la rentabilité, qui gardent les marges par décision du 16-10-2026, la déduction du coût de main-d'œuvre par différence est acceptée en l'état. **Appliqué** (état actuel).
- Les clés d'intégration perdent taux et coût de main-d'œuvre. **À appliquer** : elles les voient encore.
- Le cas du commercial, qui touche les montants, est posé en question (section 3).

**Lot (f), ouverture et réattribution d'un chantier** (#129)
- Ouverture depuis le devis signé conservée : interprétation retenue par #129, à valider par Nelson. **Appliqué**.
- Responsable choisi parmi les conducteurs actifs seulement (16-10-2026). **Appliqué à l'écran** ; le serveur ne vérifie que l'activation du compte. Un titulaire autre qu'un conducteur (technicien, responsable) ne s'attribue que par l'API ; il s'affiche « (hors des conducteurs actifs) » depuis #129.
- Pas de réattribution groupée. **Appliqué** (état actuel).
- Réglages d'ouverture réservés à l'administration. **Appliqué** (#129).
- Le formulaire d'Administration n'ouvre toujours pas de chantier sans conducteur actif. L'API n'est pas modifiée, car l'écran Devis convertit sans titulaire (état actuel conservé). **Appliqué**.
- L'obligation de commercial ne compte que les commerciaux actifs. **Appliqué à l'écran** ; le serveur compte encore tous les commerciaux.

**Identité de l'application** (lot P0, #280)
- Graphie : « IRIS », comme l'écrit Nelson, sur la connexion et le planning public ; « Iris » reste le nom de l'onglet, du manifeste et du menu. **Appliqué** (#280).
- Icône : un anneau et une pupille sur fond bleu, dessin neutre de l'application, à remplacer par un logo d'Iris s'il en existe un. **Appliqué** (#280).
- Couleurs : trois bleus de la palette standard de Tailwind 3, blue-900 (`#1e3a8a`, déjà la couleur principale par défaut de l'écran Société), blue-950 et blue-600, et non les teintes de la palette les plus proches des anciennes ; les deux gris neutres et la police Montserrat de l'ancienne charte, non distinctifs, sont gardés. **Appliqué** (#280).
- Barèmes et primes insérés par migration : seules les valeurs restées identiques à l'insertion sont vidées, plutôt que toute la ligne ; la migration n'écrit pas au journal des réglages, aucune donnée réelle n'existant encore. **Appliqué** (#280), sans effet sur aucun montant depuis #159.

**Conversion des devis en intervention ou en contrat** (lot pilote 4, #281)
- Droits de la création directe de la cible, en plus du droit devis : l'intervention par l'administration, ou par un conducteur auquel un super administrateur a accordé individuellement le droit devis (API seulement, l'écran ne propose la conversion qu'à l'administration) ; le contrat par l'administration seule ; aucune clé d'intégration. **Appliqué** (#281).
- L'intervention reprend le client et l'objet du devis (titre modifiable), à planifier, sans ses lignes ni son montant ; date de demande au jour civil de la société, ou date passée transmise par l'API, comme à la création directe. **Appliqué** (#281).
- Le contrat reprend le client et l'objet (titre propre possible, de 3 à 200 caractères), actif, première échéance à sa date de début, sans prix. **Appliqué** (#281).
- Trace : motif « Conversion du devis N (version v). » au journal de la cible, et ligne du devis ; aucun lien depuis la fiche de la cible. **Appliqué** (#281).
- La facture se crée depuis l'écran Factures, avec l'origine Intervention ou Contrat. **Appliqué** (état actuel).
- Une seule conversion par affaire, et devis converti en intervention ou en contrat non annulable : appliqués par #281, posés en question (section 3).

**Génération automatique des visites de maintenance** (lot pilote 5, #293)
- Anticipation de 30 jours par défaut, appliquée dès la mise en service ; de 0 à 365 jours, vide pour désactiver la génération automatique. **Appliqué** (#293), posé en question (section 3).
- Le passage avance aussi l'échéance d'une visite terminée (règle de l'action « Échéance suivante »), faute de quoi seule la première visite de chaque contrat serait automatique. **Appliqué** (#293), posé en question (section 3).
- Une échéance passée n'est pas sautée : sa visite est créée en retard, comme par l'action manuelle, et les suivantes au fil des visites terminées, une par jour au plus pour chaque contrat. **Appliqué** (#293), posé en question (section 3).
- Client désactivé et visite annulée : contrat laissé de côté et signalé, sans échec. **Appliqué** (#293).
- L'alerte s'affiche aux administrateurs en tête des écrans Contrats de maintenance et Interventions ; aucun courriel (l'envoi des documents est le lot 6). **Appliqué** (#293).
- Le passage du jour a lieu peu après minuit, heure de la société (première vérification du jour) ; le passage lancé à la main est au nom de l'administrateur. **Appliqué** (#293).
- Le passage automatique écrit sans compte auteur, au nom « Génération automatique ». **Appliqué** (#293), posé en question (section 3).

**Dates**
- Date de demande curative : alignée sur les autres dates métier. **À appliquer**.

**Chantiers** (règle 2, défauts connus en section 1)
- Statut d'un chantier : retiré de la modification générale (`PATCH /api/chantiers/:id`), il passe par les routes dédiées. **À appliquer**.
- Heures et achats saisis pendant l'annulation d'un devis : corrigés par un verrou du chantier (montants, règle 2). **À appliquer**.

**Interface**
- Police de l'interface : hébergée avec l'application, sans requête vers Google. **À appliquer** : elle vient encore de Google Fonts.

**Règlements** (lot pilote 1, P1a, **appliqués** par #155)
- Saisie et contre-passation réservées à l'administration, y compris pour un client désactivé.
- Moyens : virement, chèque, carte, prélèvement, espèces, sans plafond d'espèces (règle de conformité non décidée).
- Date ni postérieure au jour de la société, ni antérieure à l'émission d'une facture visée : un paiement reçu avant la facture relève de l'acompte.
- Un règlement est entièrement affecté, sans avance client non affectée. Une part peut dépasser le reste dû : le surplus devient un trop-perçu sur cette facture (décision de Nelson du 17-10-2026). Choix par défaut, à confirmer :
  - une facture déjà soldée par avoir ne reçoit plus de règlement ;
  - un surplus ne va sur une facture que si les autres factures du même règlement sont entièrement couvertes ;
  - « Répartir le montant » place un surplus sur la facture à l'échéance la plus récente.
- Une facture soldée par avoirs, sans règlement, reste émise (« Soldée par avoir ») ; un trop-perçu est affiché, sans remboursement dans ce lot.

**Commissions sans plan commercial** (**appliqués** par #159) : les cinq choix par défaut, à confirmer, sont notés au lot (i), section 2, avec la décision A5 qu'ils appliquent ; ils ne sont pas recopiés ici, pour ne pas les tenir à deux endroits.

**Catalogue dans les devis** (lot pilote 2, **appliqués** par #161)
- Le prix d'achat prévu d'une ligne n'est lu et écrit que par l'administration (session). Une clé d'intégration le lit avec le scope `finances:read`, sans jamais l'écrire.
- Un autre porteur du droit devis ne le reçoit sous aucune route. S'il modifie le devis, chaque ligne existante garde le sien, et une nouvelle ligne du catalogue reprend celui de la fiche. Une ligne retirée puis rajoutée est une nouvelle ligne : elle reprend le prix d'achat de la fiche, et non celui qu'un administrateur y avait saisi.
- Le prix d'achat d'une fiche du catalogue suit la même règle : une clé d'intégration ne le reçoit (`/api/v1/catalogue`, et le modèle joint à chaque équipement du parc, `/api/v1/clients/:id/equipements`) qu'avec le scope `finances:read`, faute de quoi elle retrouverait par la fiche celui recopié dans une ligne de devis.
- Une clé `devis:write` qui connaît l'identifiant d'une fiche (non énumérable) apprend, en l'ajoutant à un devis, sa référence et si elle est active.
- La recherche du catalogue pour un devis est ouverte aux porteurs de `devis:write` (fiches actives, 50 au plus, sans prix d'achat hors administration) ; les écrans et routes du catalogue restent réservés à l'administration.
- Une ligne copiée reste modifiable (désignation, prix, quantité, nature, unité) tant que le devis n'est pas signé : seules la fiche d'origine et sa référence ne changent plus.
- Nature proposée par famille : une prestation en main-d'œuvre, un article ou un équipement en fourniture.
- La référence et l'unité entrent dans l'empreinte de signature ; le prix d'achat prévu, donnée interne, n'y entre pas.
- Un devis signé est figé en base, en plus du contrôle de l'API : ses lignes et son contenu, sa signature (ni modification, ni suppression) et le vidage des trois tables (`TRUNCATE`). Son cycle de vie (statut, acompte constaté, annulation, conversion) reste possible.

**Règles permanentes de conception** (décision du 17-10-2026), **appliqué** par #176 : la limite d'environ 800 lignes ne s'applique ni aux fichiers de tests, ni aux migrations, ni aux fichiers générés (lockfiles, client Prisma), ni au schéma Prisma, que Prisma 5 ne scinde qu'avec une fonction en préversion.

**Avoir partiel** (#251) : après une issue inconnue de la création (réponse perdue, erreur serveur), l'écran relit la liste des factures ; si cette relecture échoue aussi, le bouton reste désactivé avec la consigne d'actualiser la liste, jusqu'à une relecture réussie (option la plus restrictive). **Appliqué** (#251).

**Variables d'environnement** (#263) : `server/tests/environnement.test.mjs` relève dans le texte des sources les variables lues, exception documentée à la règle « un test appelle le code » de `server/tests/README.md`. **Appliqué** (#263).

**Envoi des documents** (lot pilote 6) : journal des envois, choix par défaut, à confirmer, à préciser dans la PR du lot.

**Identité de l'émetteur et modèle des documents** (lot 6a-1, #300, option B de P5 retenue le 22-10-2026), choix par défaut, à confirmer, les champs imprimés par le cabinet :
- Émettre une facture ou créer un avoir exige raison sociale, SIRET, adresse, code postal et ville ; l'écran Prêt à facturer le signale, et l'émission refusée ne consomme aucun numéro. Le format du SIRET n'est pas vérifié.
- À l'émission, la pièce copie aussi le nom commercial, la TVA intracommunautaire, le pays, le téléphone, l'e-mail, le site, le pied de page (« Pied de page des documents »), la couleur principale et le logo. La copie ne change jamais, et deux pièces de même identité la partagent ; la base refuse toute pièce qui quitte le brouillon sans copie.
- Un avoir, total ou partiel, copie l'identité du jour de sa création, et non celle de sa facture.
- Une pièce émise avant ce lot n'a pas de copie : son émetteur reste tiré du texte des mentions légales figées, comme à l'origine, mais elle s'imprime dans la couleur par défaut, et non plus dans la couleur principale actuelle, qui est un paramètre vivant, et sur le modèle commun (pagination, marge basse).
- Logo : PNG ou JPEG, 500 Ko et 2 000 pixels de côté au plus, téléversé par le super administrateur comme l'identité, journalisé ; un logo remplacé n'est supprimé que si aucune pièce ne l'imprime. Le champ « URL du logo » quitte l'écran Société ; `logoUrl` reste lisible par l'API.
- Le PDF porte en tête le logo et l'identité, et sur chaque page le pied de page et la pagination.

**PDF du devis** (lot 6a-2, #301), choix par défaut, à confirmer :
- Tout devis, quel que soit son statut, a son PDF (`GET /api/devis/:id/document.pdf`), pour les porteurs du droit de lecture des devis, en session seulement, comme le PDF des factures : ni technicien, ni clé d'intégration.
- Un devis signé, figé en base (#161), s'imprime depuis des copies prises à sa signature : l'identité de l'émetteur (la ligne figée du lot 6a-1, avec son logo, sa couleur et son pied de page), la raison sociale du client et son adresse de facturation (même choix du site que la facture ; absente si le client n'a aucun site), ainsi que le fuseau de la société, qui date le devis imprimé (création de la version, signature). La base exige ces copies pour toute nouvelle signature et les fige avec elle ; la date de création d'un devis signé, qu'il imprime, est figée avec son contenu.
- Enregistrer une signature exige donc l'identité complète de la société (mêmes champs que pour émettre une facture) ; sinon, refus 409 qui nomme les champs manquants, sans rien écrire.
- Un devis non signé (brouillon ou envoyé, mais aussi refusé ou annulé avant toute signature) s'imprime avec l'identité de la société et la fiche client actuelles, et le même refus si l'identité est incomplète. Une signature enregistrée avant ce lot n'a pas de copie : son devis s'imprime de la même façon (sans objet tant qu'aucune donnée réelle n'existe).
- Le PDF imprime le numéro, la version, la date de création du devis (jour de la société), le client, l'objet, les lignes (référence et unité comprises), la ventilation de la TVA par taux, recalculée depuis les lignes avec l'arrondi du devis, le taux d'acompte demandé, puis un cadre « Bon pour accord » à remplir, ou, pour un devis signé, le signataire, la date et l'empreinte du contenu signé. Jamais le prix d'achat prévu, ni le motif d'une annulation. Un devis annulé ou refusé l'annonce en tête, sans cadre à remplir.
- Le modèle commun imprime dans les polices standard du PDF (jeu de caractères WinAnsi) : un caractère hors de ce jeu (Ω, ≥, ł, émoji…) devient sa lettre de base (č → c) ou « ? », jamais un autre texte lisible (un exposant, un chiffre cerclé ou une barre de négation deviennent « ? » : 10⁶ ne s'imprime pas 106, ni ≠ comme =), sur tous les documents, factures comprises, au lieu de brouiller la suite de la ligne ; un accent combinant, fréquent dans un texte copié, est d'abord recomposé (é). Embarquer une police Unicode reste possible, à arbitrer.

## 5. Préalables à la mise en service et contrat d'une PR

### Contrat d'une PR et critères de sortie

Une PR doit annoncer : besoin et acteur, état du système avant/après, dépendances, périmètre/hors périmètre, droits API et UI, effets sur les montants et documents figés, migrations éventuelles et retour arrière, critères d'acceptation vérifiables. Les remarques d'audit suivent la méthode du 16-10-2026 ([CLAUDE.md](../CLAUDE.md#méthode-de-travail-décision-de-nelson-du-16-10-2026)) : une remarque bloquante, ou qui touche un parcours de la règle 2 (droits et périmètres, montants, factures et documents figés, journaux d'audit, sécurité), est corrigée et retestée avant fusion ; une remarque non bloquante ailleurs devient une issue `suivi-audit` ; si le périmètre métier change, demander l'arbitrage de Nelson. Les tests doivent échouer quand la protection visée est neutralisée ; faire tourner la vraie API/PostgreSQL et le navigateur pour les parcours critiques. Voir [CLAUDE.md](../CLAUDE.md) et [les règles Git](../.agents/AGENTS.md).

Migrations : une migration fusionnée sur `main` ne se modifie plus, pas même un commentaire. Les bases qui l'ont appliquée gardent sa somme de contrôle, et `prisma migrate dev` la signalerait comme modifiée, alors que `migrate deploy` et `migrate status` ne le signalent pas et que la CI, sur une base neuve, ne peut pas le voir ; toute correction passe par une nouvelle migration (note N3 du troisième audit de #293, [#296](https://github.com/Noxia-Groupe/iris/issues/296)).

Fusion : décision de Nelson du 20-10-2026 ([CLAUDE.md](../CLAUDE.md#mode-de-livraison)), qui remplace la délégation du 17-10-2026. Nelson ne fusionne aucune PR : Claude Code fusionne toute PR de Claude Code, y compris celles qui changent des montants ou modifient CLAUDE.md, lorsque, sur la même SHA, la CI est verte et son sous-agent d'audit la juge fusionnable, sans remarque restante à corriger avant fusion selon la règle 3 ; par commit de fusion sur la SHA de tête attendue, jamais par la fusion automatique de GitHub. Elle couvre aussi les propositions 3 et 4 (#182, #183), dont la fusion vaut validation : « C’est toi qui fusionne TOUTES les PR » (Nelson, 20-10-2026, consigné sur #182 et #183). Une fusion, quelle qu'elle soit, ne vaut ni validation comptable des montants, qui reste un préalable à la mise en service, ni mise en production, que seul Nelson décide. Lots fusionnés : [historique](HISTORIQUE-DECISIONS.md).

La phase est **livrée techniquement** lorsque ses sous-lots définis sont fusionnés, migrables depuis une base jetable vierge, testés, documentés et validés par leur CI/revue sur la SHA finale. Elle n'est **prête à être activée chez un client** qu'après validation de ses paramètres propres à l'instance, de la sécurité, des documents légaux/comptables et de la recette avec les acteurs concernés. Elle n'est **en production** qu'après décision explicite de Nelson et preuve du déploiement, de la sauvegarde/restauration et de la surveillance opérationnelle.

### Préalables à la mise en service (règle 2)

- Sécurité, sauvegarde et restauration testées, recette de l'instance pilote.
- Durée de conservation du journal et minimum de purge : à faire trancher par le cabinet.
- Préparation de l'instance pilote : recette métier et sécurité, configuration vide réelle, sauvegarde **et restauration testées**, supervision, validation du cabinet, autorisation explicite de mise en service. Pas de déploiement automatique.
- Validation par le cabinet des montants, du paramétrage légal et des documents légaux et comptables de la société.

### Sans objet tant qu'aucune donnée réelle ni instance n'existe

- Affaires « héritées » sans fiche client (#144, #146) : réparation, facture déjà émise, interventions d'avant #144. Pour une affaire déjà liée, Nelson a tranché le 16-10-2026 : pas de changement de client tant qu'une intervention SAV y est rattachée (#146).
- Mois de rattachement des commissions : seules les commissions déjà calculées en UTC sont sans objet tant qu'aucune donnée réelle n'existe ; le plan commercial (lot (i)) les rattache au jour de la société. Sans plan commercial, aucune commission n'est due pendant le pilote (décision du 17-10-2026).
- Références d'affaire regroupées (lot (f), relevé par le second audit de #129) : la référence se compare à l'identique, si bien qu'un chantier dont la référence en regroupe plusieurs (« A26-0001 / A26-0002 ») ne bloquerait pas la conversion de ces devis. Sans objet selon Nelson (14-10-2026) : l'application n'est pas en service et ne contient aucune donnée à reprendre.

**Aucune réponse à ces points n'est présumée au-delà de ce qui est écrit ici.** Nelson décide de la mise en service.
