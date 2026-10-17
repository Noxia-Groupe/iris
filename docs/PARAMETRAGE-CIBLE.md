# Paramétrage cible : proposition

> **Proposition du 17-10-2026, à valider par Nelson avant tout code** (chantier technique 4). Rien de ce document n'est implémenté.
>
> L'inventaire détaillé est en annexe : [`PARAMETRAGE-INVENTAIRE.md`](PARAMETRAGE-INVENTAIRE.md). Pour chaque règle, il donne sa référence `fichier:ligne`, sa valeur actuelle et la raison pour laquelle elle varie. Les identifiants A, B-01 à B-75 et C-01 à C-28 y renvoient. Les règles « qui fait quoi » relèvent de la proposition sœur [`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md).

## 1. Le besoin

Nelson, le 17-10-2026 : « Iris doit s'adapter au fonctionnement et à la taille de chaque entreprise grâce à un paramétrage fait au démarrage, plutôt que par des règles fixées dans le code. »

C'est aussi la règle permanente ajoutée le même jour à `CLAUDE.md` : toute nouvelle règle propre au fonctionnement d'une entreprise devient un paramètre, avec une valeur par défaut documentée.

## 2. Principes

1. **Valeur par défaut = comportement actuel.** Rendre une règle paramétrable ne change rien tant que la société ne modifie pas le paramètre. La valeur par défaut est écrite dans la PR et dans la passation.
2. **Aucune valeur métier inventée.**
   - Pas de prix, de commission, de compte comptable ni de délai de paiement par défaut.
   - Ce qui n'a pas de comportement actuel reste vide tant que la société ne l'a pas réglé, comme le plan comptable aujourd'hui.
   - Les valeurs déjà présentes dans le code sont présentées comme les valeurs actuelles, à confirmer par la société : acompte de 30 %, seuil de marge faible de 15 %, alerte après 14 jours sans saisie, etc.
3. **Tout changement de paramètre est journalisé**, dans la même transaction, comme les réglages existants (`JournalAdministration`). Une entrée par enregistrement, avec les seuls champs modifiés.
4. **« Qui fait quoi » relève des droits.** Qui clôture, qui convertit, qui facture : ces choix se règlent par les rôles de [`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md), avec ses permissions (`chantiers.cloturer`, `devis.convertir`…), et non par des paramètres séparés. L'assistant de démarrage les présente ensemble.
5. **Montants et conformité sous validation.**
   - Un paramètre qui touche un calcul de montant, une mention légale ou la comptabilité ne change pas de valeur par défaut sans la validation de Nelson.
   - Ceux qui touchent la loi demandent en plus celle du cabinet.
   - Les références légales citées ici le sont **selon notre lecture, toujours à confirmer par le cabinet**.
6. **Un document émis ne doit jamais lire un paramètre vivant.** Tout ce qu'une facture imprime doit être figé à son émission : c'est déjà le cas de l'émetteur, porté par la version légale, et de l'adresse du client. Une exception existe aujourd'hui, sans effet sur le contenu : la couleur du titre, lue vivante. Les lacunes en base sont suivies par #180.

## 3. Inventaire classé

### 3.1 (A) Déjà paramétrables

| Bloc | Paramètres | Qui les modifie | Journal |
|---|---|---|---|
| Paramètres métier (`Parametres`) | marge commerciale active ; taux d'acompte proposé (30 %) ; seuil de marge faible (15 %) ; jours sans saisie (14) | administrateur | oui |
| Destinataires de la rentabilité | conducteur, hiérarchie, directeurs (trois cases de `Parametres`) | administrateur | oui. Ils deviennent la permission `rentabilite.voir` des rôles dans la proposition de droits. |
| Module | Planning activé ou non (`planningActif`) | super administrateur | oui |
| Journal | durée de conservation (90 jours, de 1 à 90) | super administrateur | oui |
| Identité (`CompanySettings`, 18 champs) | raison sociale, SIRET, TVA, adresse, contact, logo, couleurs, préfixes de facture et d'avoir, fuseau horaire | super administrateur | oui |
| Rémunération commerciale | barèmes, objectifs, primes, libellé du barème réduit : **sans effet sur les montants depuis #159** | super administrateur | oui |
| Comptabilité | plan comptable (vide au départ), règles d'export, comptes de TVA par taux | administrateur | partiel : modifications et règles journalisées, mais pas la création d'un compte (passation, section 4 : à appliquer) |
| Mentions légales et CGV | versions publiées, figées | administrateur | non (passation, section 4 : à appliquer) |
| Référentiels | catégories d'achats, fournisseurs, intervenants et leurs taux, types d'événement du planning, catalogue | selon le référentiel | partiel |
| Partage public du planning | lien actif ou non | administrateur | oui |

Constats de l'inventaire :
- **Saisis mais sans effet** : le logo, la couleur secondaire et le pied de facture ne servent nulle part. Les coordonnées légales (SIRET, TVA, adresse) ne servent pas côté serveur.
- **Émetteur de la facture** : il vient, **volontairement**, du texte de la version légale figée à l'émission, et non des paramètres vivants (commentaire du code, `server/index.ts:1158`).
- **Couleur** : seule la couleur principale sert, au titre du PDF. Elle y est lue vivante : c'est sans effet sur le contenu, mais une facture réimprimée changerait de couleur. La couleur de l'interface, elle, est écrite en dur dans `client/src/index.css`.
- **Doublon d'écrans** : le fuseau ne se règle que dans Administration > Société. L'écran Société (`/societe`) règle le reste de l'identité.

### 3.2 (B) À rendre paramétrables

75 entrées, regroupées par thème. Les entrées qui touchent un montant sont signalées.

| Thème | Entrées (annexe) | Valeur ou comportement actuel | Proposition |
|---|---|---|---|
| **Qui fait quoi** | clôture et réouverture (B-01, B-02), conversion (B-03), signature, statut, acompte et annulation d'un devis (B-04 à B-07), création et transitions SAV (B-08, B-09), coûts SAV (B-10), planning (B-11), contrats (B-12), facturation et règlements (B-13, B-14), case « Encaissé » (B-15), modification et réattributions d'un chantier (B-16, B-17), saisie après clôture (B-18), référentiels (B-19), gouvernance des mentions et des réglages (B-20, B-21) | écrit dans les gardes de route | **Par les rôles** : chaque entrée a sa permission dans [`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md), section 3.1, y compris `saisies.apresCloture`, `referentiels.gerer`, `intervenants.gerer` et `mentions.gerer` |
| **Obligations de saisie** | titulaire obligatoire (B-22) ; commercial obligatoire dès qu'un commercial existe (B-23) ; acompte bloquant, en % du TTC (B-24, montants) | obligatoires ; acompte bloquant | Paramètres oui/non, avec le comportement actuel par défaut. L'acompte bloquant touche aussi le droit de la consommation pour les particuliers (section 3.4). |
| **Durées et horaires proposés** | durée d'une curative (B-25), heure de début (B-26), plage horaire (B-27), créneaux (B-28), passage de minuit (B-29) | 60 min, 09:00, 08:00 à 12:00, interdit | B-25 : paramètre du planning. B-26 à B-29 : avec les horaires du lot (j). |
| **Contrats de maintenance** | périodicité et durée proposées (B-30), couverture par défaut (B-31), génération des visites (B-32) | 12 mois, 60 min, hors forfait, manuelle | Paramètres ; génération automatique avec le lot 5 (A9) |
| **Dates automatiques** | début à la conversion, fin à la clôture (B-33) | date du jour | Paramètre oui/non |
| **Échéance de facture** | délai proposé (B-34) | aucun délai : l'écran préremplit l'échéance au jour d'émission | Paramètre facultatif. Vide, il garde le comportement actuel. Plafond légal des délais à confirmer par le cabinet. |
| **Règlements** | imputation (B-35, montants) | quatre règles de montants et le trop-perçu, **validés par Nelson le 17-10-2026** (C-06). Trois **choix par défaut, à confirmer** : facture soldée par avoir refusée, surplus refusé tant qu'une autre facture du règlement reste due, ordre de répartition automatique. | Les trois choix par défaut : paramètres possibles, sur décision de Nelson. Les règles de date (au plus tôt l'émission, au plus tard le jour même) passent en C (chronologie). |
| **Seuils et méthodes** | tolérance des alertes de dépassement (B-36, montants), seuil des jauges (B-37), jours civils ou ouvrés (B-38), méthode de la marge estimée (B-39, montants), ventilation du vendu (B-40, montants), indicateurs des conducteurs (B-41), assiduité (B-42), rattachement mensuel (B-43, lot (i)) | sans tolérance ; 85 % ; jours civils | Paramètres, sous validation de Nelson pour les montants |
| **Listes de valeurs** | types de chantier (B-44) ; moyens de règlement, verrouillés aussi en base (B-45) ; priorités, aujourd'hui sans effet (B-46) ; couvertures (B-47) ; natures de ligne (B-48) ; TVA proposée (B-49) ; unité proposée (B-50) ; type de compte proposé (B-51) ; contrat « brouillon » jamais produit (B-52) | listes fermées | Listes tenues par la société, en référentiels. Contenu initial d'une nouvelle instance pour les types de chantier, aujourd'hui ceux de la sûreté : question 2. Chaque nature de ligne reste rattachée à une catégorie fiscale fixe (bien ou service), même si son libellé devient libre. |
| **Étapes facultatives** | figement d'un devis à l'envoi ou à la signature (B-53, question ouverte) ; révision (B-54) ; fin d'intervention sans compte rendu signé (B-55, lot 3b) ; planification automatique (B-56) ; étapes de la vision non modélisées (B-57) | comportement actuel | Paramètres, quand le lot concerné les traite |
| **Numérotation** | format des numéros hors préfixe (B-58) | formats fixes | Avec le lot des documents. La continuité reste dans le code (C-01). Changer un préfixe en cours d'année est un risque (C-01). |
| **Documents** | modèle du PDF de facture (B-59), libellés des visites (B-60), export comptable (B-62) | PDF et libellés fixes ; un seul journal de ventes | Avec l'envoi des documents (lot 6) et #35 |
| **Format du rapport de chantier** | format `letter` (B-61) | format américain | Pas un paramètre : petite correction vers l'A4, au lot P0 |
| **Calendrier** | exercice décalé (B-63), week-end et jours fériés (B-64), planning public (B-65), périodes par défaut (B-66) | année civile ; samedi et dimanche | Paramètres ; jours travaillés avec le lot (j) |
| **Affichage** | ordre des alertes, nombre de chantiers à surveiller, tailles de page, tris, couleurs (B-67 à B-71) | valeurs fixes | **Faible enjeu** : à laisser en l'état, sauf demande |
| **Identité en dur** | « NØXIA GROUPE » sur la connexion et le planning public, icônes et couleur de l'interface (B-72) ; libellé de repli du barème réduit (B-73) ; barèmes et primes d'une société insérés par migration (B-74) | en dur | **À retirer**, pas à paramétrer (lot P0) : ils contredisent la règle « aucune valeur de société dans le code ». B-73 est déjà paramétrable. |
| **Modules** | devis, SAV, contrats, Travaux, facturation, règlements et catalogue non activables (B-75) | toujours présents | Modules activables, comme le Planning |

### 3.3 (C) À garder dans le code

| Règle | Raison |
|---|---|
| Numérotation continue et chronologique des factures et des avoirs (C-01, C-02) | Légale : séquence chronologique et continue (CGI, annexe II, art. 242 nonies A). Seuls les préfixes sont paramétrables. **Garde-fou à confirmer par le cabinet** : un préfixe changé en cours d'année continue la séquence (`F2026-0005` puis `X2026-0006`). Faut-il refuser ce changement hors début d'année, ou ouvrir une nouvelle série ? La remise à zéro annuelle est aussi à confirmer. |
| Chronologie des règlements (C-06 bis) : au plus tôt la date d'émission de la facture, au plus tard le jour même | Intégrité de la chronologie, issue de B-35 |
| Immutabilité de la facture émise et correction par avoir (C-03, C-04) ; devis signé figé (C-05) ; règlements immuables (C-06) | Légale et intégrité. Lacunes en base, dont les lignes et la version des mentions : #180. |
| Arrondis, TVA par taux, comptes de TVA (C-07, C-08) | Règle fiscale et comptable ; taux normal (CGI art. 278) ; liste des taux légaux à confirmer par le cabinet. Le territoire fiscal (DOM et taux propres) ne se déduit pas du fuseau horaire. |
| Mentions obligatoires et chronologie de l'émission (C-09, C-10) | Légale (CGI art. 289 et annexe II). Le contenu des mentions reste paramétrable et validé par le cabinet. |
| Choix du site de facturation (`SITE_FACTURATION_ORDRE`) puis adresse figée à l'émission (C-13 bis) | L'adresse de facturation est une mention, et son figement une règle d'intégrité. L'ordre de choix, lui, est une **convention actuelle, à confirmer** : à défaut de site de facturation désigné, il retombe sur le site principal, le siège, puis le premier par ordre alphabétique. Faut-il plutôt refuser l'émission sans site de facturation désigné ? |
| Plafond des montants (C-11) | Technique : colonnes `Decimal(12,2)` |
| Écritures comptables équilibrées et scellées (C-12) | Intégrité comptable. Leur contenu (comptes, journal) est paramétrable. |
| Format des dates et jour civil de la société (C-13) | Décision de Nelson du 14-10-2026 ; le fuseau reste paramétrable |
| Invariants de droits (C-14) | [`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md), section 8 |
| Journaux en ajout seul (C-15) | Traçabilité ; la durée de conservation est paramétrable |
| Un chantier par affaire, client figé après facturation (C-16) ; squelettes des cycles de vie (C-17) ; contrats, visites et coûts figés (C-18, C-19) ; échéance contractuelle (C-20) ; origine des factures (C-21) ; client actif pour ouvrir un dossier (C-22) | Intégrité, et décisions de Nelson des 14 et 16-10-2026 |
| Formats de contrôle (C-23), semaine ISO (C-24), structures du modèle (C-25) | Validation technique et conventions |
| Paramètres de sécurité et d'exploitation : durée du jeton, accès de secours, délais (C-26) | Constantes du code aujourd'hui ; hors assistant métier. Une variable d'environnement pourrait les régler si le besoin apparaît. |
| Fuseaux limités aux fuseaux français (C-27) | Iris est un ERP natif français ; le fuseau reste au choix dans cette liste |

### 3.4 Règles légales à faire confirmer par le cabinet

Iris ne les traite pas, ou seulement en partie. Elles ne sont pas tranchées ici, mais un paramétrage mal conçu pourrait les contredire. Les articles cités le sont selon notre lecture.
- **Plafond des paiements en espèces** (ancien C-28) : absent du code.
- **Facture d'acompte** : l'acompte est constaté aujourd'hui sans facture (CGI art. 289).
- **Mentions conditionnelles** : autoliquidation en sous-traitance du bâtiment ; exonérations ; taux réduits pour les travaux dans les logements.
- **Mentions de la facturation électronique** : SIREN du client, adresse de livraison, nature de l'opération, option pour la TVA sur les débits.
- **Indemnité forfaitaire de recouvrement et escompte** : la mention de l'escompte, facultative aujourd'hui (`escompte`), est peut-être obligatoire même négative.
- **Contrats conclus hors établissement avec un particulier** : paiement interdit pendant 7 jours et rétractation de 14 jours (code de la consommation). Cela touche l'acompte bloquant (B-24).
- **Conservation des pièces et piste d'audit fiable**, alors que le journal des paramètres est plafonné à 90 jours.

## 4. L'assistant de démarrage

### 4.1 Forme

- **Où** : Paramètres > « Démarrage ».
- **Qui** : réservé au super administrateur ; un administrateur le consulte (question 3).
- **Deux parcours** :
  - un **court** pour une petite équipe : société, comptes, modules, puis une liste de contrôle ;
  - un **complet**, par étapes.
- **Reprise** : on peut l'interrompre et le reprendre. Chaque étape s'enregistre à sa validation, journalisée comme les réglages actuels. Le préréglage appliqué est tracé lui aussi.
- **Ensuite** : tout reste modifiable dans les écrans habituels, et l'assistant peut être rejoué.
- **Pas de doublon** : l'assistant renvoie vers les écrans existants au lieu de les dupliquer :
  - Société, et Administration > Société pour le fuseau ;
  - Utilisateurs ;
  - Plan comptable ;
  - Mentions et CGV ;
  - Catalogue.

  Le doublon actuel des deux écrans « Société » est à résorber au lot P1.
- **État « prêt à démarrer »** : une liste de contrôle de ce qui reste à régler (identité, comptes, plan comptable, mentions légales), sur le modèle de « Prêt à facturer ».

### 4.2 Étapes et questions

Questions tirées de l'annexe, section 6. L'assistant ne tranche rien : chaque réponse règle des paramètres existants, choisit un préréglage, ou renvoie vers un écran.

| Étape | Questions (annexe) | Ce qu'elles règlent |
|---|---|---|
| 1. La société | identité légale et visuelle, fuseau, préfixes de facture et d'avoir (Q1, Q2, Q18) | identité de la société |
| 2. Facturation électronique | catégorie légale de l'entreprise (micro, PME, ETI…) et plateforme agréée retenue (Q3) | information pour le lot A2 ; rien n'est réglé avant ce lot |
| 3. Organisation | quelles fonctions existent ? y a-t-il une hiérarchie ? techniciens avec compte, ou planning public ? (Q5, Q23) | préréglage des rôles ([`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md), section 5) ; comptes et rattachements ; partage public |
| 4. Domaines utilisés | devis, SAV, contrats, chantiers, planning, facturation, règlements, catalogue (Q4) | modules activés (après P2) |
| 5. Qui fait quoi | clôture, conversion, acompte, SAV, planning, saisie après clôture, mentions légales et réglages (Q6 à Q8, Q11, Q25, Q28) | ajustement des rôles proposés (après le lot D3 des droits) |
| 6. Devis et acompte | acompte demandé, taux proposé, acompte bloquant ; figement du devis (Q9, Q10) | paramètres de devis ; **montants : validation** |
| 7. SAV et maintenance | durée d'une curative ; périodicités et couvertures habituelles ; fin d'intervention sans compte rendu signé (Q12 en partie, Q13, Q26) | paramètres du planning, des contrats et du SAV |
| 8. Listes | activités et types de chantier, moyens de paiement, TVA et unité proposées (Q14, Q16, Q20) | référentiels (après P3) |
| 9. Facturation et comptabilité | conditions de paiement, plan comptable, exercice, envoi des documents (Q17, Q19, Q22, Q27) | renvois vers Mentions et CGV et vers Plan comptable, **à fournir par le cabinet** ; envoi des documents avec le lot 6 |
| 10. Rentabilité | qui la suit, marge affichée, seuils d'alerte (Q21) | `rentabilite.voir` des rôles ; seuils ; **montants : validation** |
| 11. Journal | durée de conservation (Q24) | conservation, **à faire trancher par le cabinet** |

Quatre questions n'ont pas encore de paramètre derrière elles. L'assistant ne les posera qu'avec leur lot :
- **horaires et jours travaillés** (Q12) : lot (j) ;
- **priorités et délais de service** (Q15) : lot P3 ;
- **figement du devis à l'envoi ou à la signature** (Q10, B-53) : question ouverte de la passation ;
- **fin d'intervention sans compte rendu signé** (Q26, B-55) : lot 3b.

### 4.3 Préréglages

Un préréglage choisit **les rôles et la hiérarchie**, et rien d'autre. Tous les autres paramètres gardent leur valeur actuelle, ou sont posés en question par l'assistant. Aucun préréglage ne touche aux montants, aux comptes, aux prix, aux mentions légales, ni aux durées et délais.

| Paramètre | « Petite équipe, sans hiérarchie » | « Équipe avec hiérarchie » | « Iris actuel » |
|---|---|---|---|
| Rôles | Dirigeant, Bureau, Technicien ([`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md), 5.1) | rôles de la section 5.2 | les dix rôles prédéfinis |
| Rattachements hiérarchiques | aucun nouveau ; ceux qui existent sont conservés | à saisir par la société | inchangés |
| Modules | à régler par la société (étape 4) | à régler par la société | valeur actuelle (tout actif) |
| Obligations de saisie (B-22, B-23, B-24) | valeur actuelle ¹ | valeur actuelle | valeur actuelle |
| Durées, délais, seuils, listes | valeur actuelle | valeur actuelle | valeur actuelle |

¹ Le titulaire reste obligatoire à la modification (B-22), mais les écrans ne proposent aujourd'hui comme titulaires que les conducteurs de travaux ; le serveur, lui, accepte tout compte actif. Avec les seuls rôles Dirigeant, Bureau et Technicien, aucun chantier ne pourrait donc être ouvert depuis l'Administration ni recevoir de titulaire depuis la fiche chantier. Seule la conversion depuis l'écran Devis, qui laisse le titulaire vide, resterait possible. Ce préréglage suppose donc que « qui peut être titulaire » s'exprime par les rôles ([`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md), question 9).

Les noms décrivent l'organisation, pour ne pas se confondre avec les catégories légales qui fixent le calendrier de la facturation électronique. L'écran affiche un récapitulatif avant d'appliquer un préréglage.

### 4.4 Règles d'organisation hors des droits, à cadrer

Elles n'existent pas dans le code. Elles sont posées ici sans valeur :
- les **destinataires des alertes et des notifications**, par exemple l'alerte d'échec de la génération des visites, prévue par le lot 5 ;
- une **validation interne en deux temps** d'un devis avant envoi : c'est une étape de circuit, et non une permission (B-05) ;
- les **agences ou établissements**, pour une société d'une certaine taille ([`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md), question 1).

## 5. Lots proposés

| Lot | Contenu | Placement proposé |
|---|---|---|
| **P0** | Retirer les valeurs de société écrites en dur (B-72, B-74) : « NØXIA GROUPE », icônes et couleur de l'interface, barèmes et primes insérés par migration. Pour ces derniers, une nouvelle migration les vide, sans effet sur aucun montant depuis #159. Passer le rapport de chantier en A4 (B-61). | Au plus tôt, petite PR. La page de connexion précède l'authentification et ne peut pas lire l'identité de la société : elle afficherait « Iris » (question 4). |
| **P1** | Socle : stockage des nouveaux paramètres, écran Paramètres regroupé par thème, journal, doublon des écrans « Société » résorbé. Premier groupe : durée d'une curative (B-25), contrats (B-30, B-31), obligations de saisie (B-22, B-23), dates automatiques (B-33), échéance proposée (B-34). | Après les PR du découpage du serveur qui touchent ces domaines. Avant ou après le premier jour du pilote, selon les besoins de l'entreprise pilote (question 5). |
| — | Paramètres des lots 5 et 6 (anticipation de la génération des visites, mode d'envoi) | Avec ces lots, dans la table `Parametres` actuelle, sans attendre P1 |
| **P2** | Modules activables (B-75) | Après P1 |
| **P3** | Listes tenues par la société : types de chantier, moyens de paiement, priorités, couvertures, natures (B-44 à B-50). Un délai de service par priorité serait un comportement nouveau : vide par défaut, son effet est à décider par Nelson. | Après P1. Les moyens de paiement et les natures touchent la comptabilité : validation. |
| **P4** | Assistant de démarrage et préréglages | Les rôles paramétrables (lot D3 des droits) viennent après le pilote. D'ici là, l'assistant peut exister sans l'étape « qui fait quoi » (option, question 3). Il ne propose alors que le préréglage « Iris actuel », et l'étape « Rentabilité » règle les trois cases actuelles des destinataires. |
| **P5** | Documents : modèle du PDF, libellés, export comptable (B-59, B-60, B-62), avec l'envoi des documents (lot pilote 6) et #35. L'identité imprimée est copiée et figée à l'émission, ou préremplie dans le texte des mentions légales (question 6). | Avec le lot 6 |
| — | Numérotation hors préfixe (B-58) | Sur demande, après avis du cabinet sur le garde-fou des préfixes |
| — | Seuils, méthodes et règles touchant les montants (B-35 à B-43) | Au cas par cas, sur décision de Nelson |
| — | Horaires, jours fériés et astreintes (B-26 à B-29, B-38, B-64) | Lot (j), déjà décidé hors pilote |
| — | Sans lot, sur demande : B-24, B-51, B-52, B-63, B-65, B-66, et l'affichage (B-67 à B-71) | — |

## 6. Questions pour Nelson

1. **Classement** : valides-tu le classement A, B, C ? En particulier :
   - le garde-fou des préfixes et la remise à zéro annuelle (C-01, à confirmer par le cabinet) ;
   - les listes aujourd'hui verrouillées en base, comme les moyens de paiement.
2. **Valeurs initiales d'une nouvelle société** : démarre-t-elle avec les valeurs présentes dans le code, ou avec des paramètres vides jusqu'à leur réglage dans l'assistant ? C'est le cas de l'acompte de 30 %, du seuil de marge faible de 15 %, de l'alerte après 14 jours sans saisie, de la marge affichée et de la liste des types de chantier de la sûreté.
3. **Assistant** : réservé au super administrateur ? Un parcours court et un complet ? Faut-il le livrer avant les rôles paramétrables, sans l'étape « qui fait quoi » ?
4. **Marque** : la page de connexion affiche-t-elle « Iris » ? Le nom de l'éditeur (Noxia-Groupe / OrizonLab, cité par le README) est-il une valeur de société à retirer, ou la marque du produit ?
5. **Placement** : P0 au plus tôt ; P1 avant le premier jour du pilote, ou après ?
6. **Identité sur la facture** : l'émetteur vient aujourd'hui du texte figé des mentions légales. Deux options :
   - copier à l'émission les coordonnées de `CompanySettings` (raison sociale, SIRET, TVA, adresse) et les figer avec la facture ;
   - les reprendre seulement pour préremplir le texte des mentions, qui reste la seule source imprimée.

   Laquelle retenir, et pour quand : avant le premier jour du pilote, ou avec le lot 6 ?
