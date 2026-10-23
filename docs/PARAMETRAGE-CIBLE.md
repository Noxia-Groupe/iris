# Paramétrage cible : proposition

> **Proposition du 17-10-2026, arbitrée le 18-10-2026 par délégation de Nelson** (chantier technique 4). Nelson a délégué ce jour-là les arbitrages des questions ouvertes ; ils sont consignés en section 6 et priment sur le texte de la proposition là où il différait. La proposition est validée par sa fusion le 20-10-2026 (#183), faite par Claude Code selon la décision de Nelson du même jour, « C’est toi qui fusionne TOUTES les PR » ([CLAUDE.md](../CLAUDE.md#mode-de-livraison)). Seuls le lot P0 (#280) et l'anticipation de la génération des visites (lot pilote 5, #293) en sont implémentés, non validés pour mise en service ; chaque autre lot (section 5) fait sa PR.
>
> L'inventaire détaillé est en annexe : [`PARAMETRAGE-INVENTAIRE.md`](PARAMETRAGE-INVENTAIRE.md). Pour chaque règle, il donne sa référence `fichier:ligne`, sa valeur au commit `84e27a1` et la raison pour laquelle elle varie. Les identifiants A, B-01 à B-75 et C-01 à C-28 y renvoient. Les règles « qui fait quoi » relèvent de la proposition sœur [`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md).

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
6. **Un document émis ne doit jamais lire un paramètre vivant.** Tout ce qu'une facture imprime doit être figé à son émission : c'est le cas de l'adresse du client et, depuis le lot 6a-1 (#300), de l'identité de l'émetteur, avec son logo, sa couleur et son pied de page, copiés à l'émission (décision 6) ; auparavant, l'émetteur venait du texte de la version légale et la couleur du titre était lue vivante. Une pièce émise avant ce lot garde son émetteur tiré de la version légale, imprimé dans la couleur par défaut. Depuis #217 (#180), les lignes, la ventilation de TVA, la version des mentions et la date d'émission d'une facture émise sont aussi figées en base. Un devis signé, figé en base (#161), s'imprime de même depuis l'identité de l'émetteur, le client et le fuseau de la société copiés à sa signature (lot 6a-2, #301) ; un devis non signé (brouillon ou envoyé, mais aussi refusé ou annulé avant toute signature), qui n'est pas figé en base, imprime l'identité, la fiche client et le fuseau actuels.

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
- **Émetteur de la facture** : il vient, **volontairement**, du texte de la version légale figée à l'émission, et non des paramètres vivants (commentaire du code, `server/src/domaines/factures/pdf.ts:38` au commit `4ad324b`).
- **Couleur** : seule la couleur principale sert, au titre du PDF. Elle y est lue vivante : c'est sans effet sur le contenu, mais une facture réimprimée changerait de couleur. La couleur de l'interface, elle, est écrite en dur dans `client/src/index.css`.
- **Doublon d'écrans** : le fuseau ne se règle que dans Administration > Société. L'écran Société (`/societe`) règle le reste de l'identité.

### 3.2 (B) À rendre paramétrables

75 entrées, regroupées par thème. Les entrées qui touchent un montant sont signalées.

| Thème | Entrées (annexe) | Valeur ou comportement actuel | Proposition |
|---|---|---|---|
| **Qui fait quoi** | clôture et réouverture (B-01, B-02), conversion (B-03), signature, statut, acompte et annulation d'un devis (B-04 à B-07), création et transitions SAV (B-08, B-09), coûts SAV (B-10), planning (B-11), contrats (B-12), facturation et règlements (B-13, B-14), case « Encaissé » (B-15), modification et réattributions d'un chantier (B-16, B-17), saisie après clôture (B-18), référentiels (B-19), gouvernance des mentions et des réglages (B-20, B-21) | écrit dans les gardes de route | **Par les rôles** : chaque entrée a sa permission dans [`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md), section 3.1, y compris `saisies.apresCloture`, `referentiels.gerer`, `intervenants.gerer` et `mentions.gerer` |
| **Obligations de saisie** | titulaire obligatoire (B-22) ; commercial obligatoire dès qu'un commercial existe (B-23) ; acompte bloquant, en % du TTC (B-24, montants) | obligatoires ; acompte bloquant | Paramètres oui/non, avec le comportement actuel par défaut. L'acompte bloquant touche aussi le droit de la consommation pour les particuliers (section 3.4). |
| **Durées et horaires proposés** | durée d'une curative (B-25), heure de début (B-26), plage horaire (B-27), créneaux (B-28), passage de minuit (B-29) | 60 min, 09:00, 08:00 à 12:00, interdit | B-25 : paramètre du planning. B-26 à B-29 : avec les horaires du lot (j). |
| **Contrats de maintenance** | périodicité et durée proposées (B-30), couverture par défaut (B-31), génération des visites (B-32) | 12 mois, 60 min, hors forfait ; génération quotidienne automatique depuis #293, manuelle auparavant | Paramètres ; génération automatique **implémentée** par le lot 5 (A9, #293, non validée pour mise en service), anticipation réglable (`Parametres.anticipationVisitesJours`) |
| **Dates automatiques** | début à la conversion, fin à la clôture (B-33) | date du jour | Paramètre oui/non |
| **Échéance de facture** | délai proposé (B-34) | aucun délai : l'écran préremplit l'échéance au jour d'émission | Paramètre facultatif. Vide, il garde le comportement actuel. Plafond légal des délais à confirmer par le cabinet. |
| **Règlements** | imputation (B-35, montants) | quatre règles de montants et le trop-perçu, **validés par Nelson le 17-10-2026** (C-06). Trois **choix par défaut, à confirmer** : facture soldée par avoir refusée, surplus refusé tant qu'une autre facture du règlement reste due, ordre de répartition automatique. | Les trois choix par défaut : paramètres possibles, sur décision de Nelson. Les règles de date (au plus tôt l'émission, au plus tard le jour même) passent en C (chronologie). |
| **Seuils et méthodes** | tolérance des alertes de dépassement (B-36, montants), seuil des jauges (B-37), jours civils ou ouvrés (B-38), méthode de la marge estimée (B-39, montants), ventilation du vendu (B-40, montants), indicateurs des conducteurs (B-41), assiduité (B-42), rattachement mensuel (B-43, lot (i)) | sans tolérance ; 85 % ; jours civils | Paramètres, sous validation de Nelson pour les montants |
| **Listes de valeurs** | types de chantier (B-44) ; moyens de règlement, verrouillés aussi en base (B-45) ; priorités, aujourd'hui sans effet (B-46) ; couvertures (B-47) ; natures de ligne (B-48) ; TVA proposée (B-49) ; unité proposée (B-50) ; type de compte proposé (B-51) ; contrat « brouillon » jamais produit (B-52) | listes fermées | Listes tenues par la société, en référentiels. Les types de chantier, aujourd'hui ceux de la sûreté, sont vides pour une nouvelle société dès le lot P3 ; une installation existante garde les siens (décision 2). Chaque nature de ligne reste rattachée à une catégorie fiscale fixe (bien ou service), même si son libellé devient libre. |
| **Étapes facultatives** | figement d'un devis à l'envoi ou à la signature (B-53, question ouverte de la passation) ; révision (B-54) ; clôture d'une intervention (B-55) ; planification automatique (B-56) ; étapes de la vision non modélisées (B-57) | comportement actuel. B-55 : depuis #268 (lot 3b-3), terminer exige un compte rendu, signé ou accompagné d'un motif consigné au journal (client absent, refus de signer, signature impossible, autre avec une précision), pour tous les comptes (décisions de Nelson des 19 et 20-10-2026) | Paramètres, quand le lot concerné les traite. B-55 : la règle et la liste des motifs restent dans le code (#268). Les rendre paramétrables, avec la décision de Nelson pour valeur par défaut, et dans quelles limites, est une question pour Nelson. Sans nouvelle décision de sa part, un compte rendu reste toujours exigé. |
| **Numérotation** | format des numéros hors préfixe (B-58) | formats fixes | Avec le lot des documents. La continuité reste dans le code (C-01). Le changement de préfixe suit le garde-fou de C-01. |
| **Documents** | modèle du PDF de facture (B-59), libellés des visites (B-60), export comptable (B-62) | Depuis le lot 6a-1, PDF des factures et avoirs sur un modèle commun, avec le logo, l'identité, la couleur et le pied de page copiés à l'émission ; depuis le lot 6a-2, PDF du devis sur ce modèle, copies prises à la signature ; mise en page non personnalisable ; libellés fixes ; un seul journal de ventes | Option B retenue par Nelson le 22-10-2026 : le modèle commun et l'identité figée avec le lot 6 (6a-1, #300, **implémenté**, non validé pour mise en service) ; libellés, export comptable et modèles personnalisables après le premier jour, avec #35 |
| **Format du rapport de chantier** | format `letter` (B-61) | A4 depuis #280, format américain auparavant | Pas un paramètre : passé en A4 par le lot P0 (**implémenté**, #280, non validé pour mise en service) |
| **Calendrier** | exercice décalé (B-63), week-end et jours fériés (B-64), planning public (B-65), périodes par défaut (B-66) | année civile ; samedi et dimanche | Paramètres ; jours travaillés avec le lot (j) |
| **Affichage** | ordre des alertes, nombre de chantiers à surveiller, tailles de page, tris, couleurs (B-67 à B-71) | valeurs fixes | **Faible enjeu** : à laisser en l'état, sauf demande |
| **Identité en dur** | « NØXIA GROUPE » sur la connexion et le planning public, icônes et couleur de l'interface (B-72) ; libellé de repli du barème réduit (B-73) ; barèmes et primes d'une société insérés par migration (B-74) | B-72 retiré par #280 (nom, icônes et trois bleus ; deux gris et la police gardés ; teinte de survol `#024080` restée, #299), B-74 vidé par #280 sauf valeur différente de celle insérée, en dur auparavant ; B-73 inchangé | **Retirés** par le lot P0 (**implémenté**, #280, non validé pour mise en service), pas paramétrés : ils contredisaient la règle « aucune valeur de société dans le code ». B-73 est déjà paramétrable. |
| **Modules** | devis, SAV, contrats, Travaux, facturation, règlements et catalogue non activables (B-75) | toujours présents | Modules activables, comme le Planning |

### 3.3 (C) À garder dans le code

| Règle | Raison |
|---|---|
| Numérotation continue et chronologique des factures et des avoirs (C-01, C-02) | Légale : séquence chronologique et continue (CGI, annexe II, art. 242 nonies A). Seuls les préfixes sont paramétrables. **Garde-fou à confirmer par le cabinet** : un préfixe changé en cours d'année continue la séquence (`F2026-0005` puis `X2026-0006`). En attendant l'avis, un préfixe ne se change que tant qu'aucun document de ce type n'a été numéroté dans l'année en cours (décision 1) ; la remise à zéro annuelle actuelle est gardée. |
| Chronologie des règlements (C-06 bis) : au plus tôt la date d'émission de la facture, au plus tard le jour même | Intégrité de la chronologie, issue de B-35 |
| Immutabilité de la facture émise et correction par avoir (C-03, C-04) ; devis signé figé (C-05) ; règlements immuables (C-06) | Légale et intégrité. Depuis #217 (#180), les lignes, la ventilation de TVA, la version des mentions et la date d'émission d'une facture émise sont figées en base ; le cycle des statuts et le plafond des avoirs y sont garantis (#227, #235). La cohérence interne des pièces émises reste suivie par #243. |
| Arrondis, TVA par taux, comptes de TVA (C-07, C-08) | Règle fiscale et comptable ; taux normal (CGI art. 278) ; liste des taux légaux à confirmer par le cabinet. Le territoire fiscal (DOM et taux propres) ne se déduit pas du fuseau horaire. La convention d'arrondi du coût de main-d'œuvre reste une question ouverte (passation, section 3) : ce classement n'en tranche pas la valeur. |
| Mentions obligatoires et chronologie de l'émission (C-09, C-10) | Légale (CGI art. 289 et annexe II). Le contenu des mentions reste paramétrable et validé par le cabinet. |
| Choix du site de facturation (`SITE_FACTURATION_ORDRE`) puis adresse figée à l'émission (C-13 bis) | L'adresse de facturation est une mention, et son figement une règle d'intégrité. L'ordre de choix, lui, est une **convention actuelle, gardée** (décision 1) : à défaut de site de facturation désigné, il retombe sur le site principal, le siège, puis le premier par ordre alphabétique ; « Prêt à facturer » signalera le client sans site désigné. |
| Plafond des montants (C-11) | Technique : colonnes `Decimal(12,2)` |
| Écritures comptables équilibrées et scellées (C-12) | Intégrité comptable. Leur contenu (comptes, journal) est paramétrable. |
| Format des dates et jour civil de la société (C-13) | Décision de Nelson du 14-10-2026 ; le fuseau reste paramétrable |
| Invariants de droits (C-14) | [`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md), section 8 |
| Journaux en ajout seul (C-15) | Traçabilité ; la durée de conservation est paramétrable |
| Un chantier par affaire, client figé après facturation (C-16) ; squelettes des cycles de vie (C-17) ; contrats, visites et coûts figés (C-18, C-19) ; échéance contractuelle (C-20) ; origine des factures (C-21) ; client actif pour ouvrir un dossier (C-22) | Intégrité, et décisions de Nelson des 14 et 16-10-2026 |
| Formats de contrôle (C-23), semaine ISO (C-24), structures du modèle (C-25) | Validation technique et conventions |
| Paramètres de sécurité et d'exploitation : durée du jeton, accès de secours, délais (C-26) | Constantes du code aujourd'hui ; hors assistant métier. Une variable d'environnement pourrait les régler si le besoin apparaît, documentée selon la règle permanente 3 de `CLAUDE.md` (`.env.example`, `docs/CONFIGURATION-ENVIRONNEMENT.md`, test en CI). |
| Fuseaux limités aux fuseaux français (C-27) | Iris est un ERP natif français ; le fuseau reste au choix dans cette liste |

### 3.4 Règles légales à faire confirmer par le cabinet

Iris ne les traite pas, ou seulement en partie. Elles ne sont pas tranchées ici, mais un paramétrage mal conçu pourrait les contredire. Les articles cités le sont selon notre lecture.
- **Plafond des paiements en espèces** (ancien C-28) : absent du code.
- **Facture d'acompte** : l'acompte est constaté aujourd'hui sans facture (CGI art. 289).
- **Mentions conditionnelles** : autoliquidation en sous-traitance du bâtiment ; exonérations ; taux réduits pour les travaux dans les logements.
- **Mentions de la facturation électronique** : SIREN du client, adresse de livraison, nature de l'opération, option pour la TVA sur les débits.
- **Indemnité forfaitaire de recouvrement et escompte** : la mention de l'escompte, facultative aujourd'hui (`escompte`), est peut-être obligatoire même négative.
- **Contrats conclus hors établissement avec un particulier** : paiement interdit pendant 7 jours et rétractation de 14 jours (code de la consommation). Cela touche l'acompte bloquant (B-24).
- **Durée de conservation du tracé de signature** d'un compte rendu d'intervention : à confirmer avec le cabinet (décision de Nelson du 19-10-2026, #253).
- **Conservation des pièces et piste d'audit fiable**, alors que le journal des paramètres est plafonné à 90 jours.

## 4. L'assistant de démarrage

### 4.1 Forme

- **Où** : Paramètres > « Démarrage ».
- **Qui** : réservé au super administrateur ; un administrateur le consulte (décision 3).
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
| 7. SAV et maintenance | durée d'une curative ; périodicités et couvertures habituelles ; motifs de clôture sans signature, si Nelson en fait un paramètre (Q12 en partie, Q13, Q26) | paramètres du planning, des contrats et du SAV |
| 8. Listes | activités et types de chantier, moyens de paiement, TVA et unité proposées (Q14, Q16, Q20) | référentiels (après P3) |
| 9. Facturation et comptabilité | conditions de paiement, plan comptable, exercice, envoi des documents (Q17, Q19, Q22, Q27) | renvois vers Mentions et CGV et vers Plan comptable, **à fournir par le cabinet** ; envoi des documents avec le lot 6 |
| 10. Rentabilité | qui la suit, marge affichée, seuils d'alerte (Q21) | `rentabilite.voir` des rôles ; seuils ; **montants : validation** |
| 11. Journal | durée de conservation (Q24) | conservation, **à faire trancher par le cabinet** |

Quatre questions n'ont pas encore de paramètre derrière elles. L'assistant ne les posera qu'avec leur lot :
- **horaires et jours travaillés** (Q12) : lot (j) ;
- **priorités et délais de service** (Q15) : lot P3 ;
- **figement du devis à l'envoi ou à la signature** (Q10, B-53) : question ouverte de la passation ;
- **clôture d'une intervention** (Q26, B-55) : tranchée par Nelson les 19 et 20-10-2026 et appliquée dans le code par #268 ; l'assistant ne la posera que si Nelson décide d'en faire un paramètre.

### 4.3 Préréglages

Un préréglage choisit **les rôles et la hiérarchie**, et rien d'autre. Tous les autres paramètres gardent leur valeur actuelle, ou sont posés en question par l'assistant. Aucun préréglage ne touche aux montants, aux comptes, aux prix, aux mentions légales, ni aux durées et délais.

| Paramètre | « Petite équipe, sans hiérarchie » | « Équipe avec hiérarchie » | « Iris actuel » |
|---|---|---|---|
| Rôles | Dirigeant, Bureau, Technicien ([`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md), 5.1) ; Bureau et Technicien peuvent être titulaires ¹ | rôles de la section 5.2 | les dix rôles prédéfinis |
| Rattachements hiérarchiques | aucun nouveau ; ceux qui existent sont conservés | à saisir par la société | inchangés |
| Modules | à régler par la société (étape 4) | à régler par la société | valeur actuelle (tout actif) |
| Obligations de saisie (B-22, B-23, B-24) | valeur actuelle ¹ | valeur actuelle | valeur actuelle |
| Durées, délais, seuils, listes | valeur actuelle | valeur actuelle | valeur actuelle |

¹ Le titulaire reste obligatoire à la modification (B-22), mais les écrans ne proposent aujourd'hui comme titulaires que les conducteurs de travaux ; le serveur, lui, accepte tout compte actif. Avec les seuls rôles Dirigeant, Bureau et Technicien, aucun chantier ne pourrait donc être ouvert depuis l'Administration ni recevoir de titulaire depuis la fiche chantier. Seule la conversion depuis l'écran Devis, qui laisse le titulaire vide, resterait possible. Ce préréglage suppose donc que « qui peut être titulaire » s'exprime par les rôles ([`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md), décision 9, lot D2) : le rôle Bureau porte l'attribut « peut être titulaire », comme le Technicien. Le préréglage n'est proposé qu'avec les rôles paramétrables (lot D3 des droits ; préréglage au lot P4).

Les noms décrivent l'organisation, pour ne pas se confondre avec les catégories légales qui fixent le calendrier de la facturation électronique. L'écran affiche un récapitulatif avant d'appliquer un préréglage.

### 4.4 Règles d'organisation hors des droits, à cadrer

Elles n'existent pas dans le code comme réglages. Elles sont posées ici sans valeur :
- les **destinataires des alertes et des notifications**, par exemple l'alerte de la génération des visites, livrée par le lot 5 (#293), que le code réserve aux administrateurs (choix par défaut, à confirmer, passation section 4) ;
- une **validation interne en deux temps** d'un devis avant envoi : c'est une étape de circuit, et non une permission (B-05) ;
- les **agences ou établissements**, pour une société d'une certaine taille : un lot dédié, si une société en a besoin ([`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md), décision 1).

## 5. Lots proposés

| Lot | Contenu | Placement proposé |
|---|---|---|
| **P0** | Retirer les valeurs de société écrites en dur (B-72, B-74) : « NØXIA GROUPE », icônes et couleur de l'interface, barèmes et primes insérés par migration. Pour ces derniers, une nouvelle migration les vide, sauf valeur différente de celle insérée, sans effet sur aucun montant depuis #159. Passer le rapport de chantier en A4 (B-61). | Petite PR, avant le premier jour : lecture retenue de la décision de Nelson du 21-10-2026, qui place P0 avant la fin du pilote (« il ne doit plus y avoir de noxia groupe dans l’application, c’est une application ouverte a toute les entreprise »). La page de connexion porte le nom de l'application (décision 4, confirmée par Nelson le 21-10-2026 pour cette page : « La page de connexion doit etre au nom de l’application c’est a dire IRIS. ») ; le planning public, lui aussi ouvert sans connexion, affiche le même nom (décision 4). La graphie affichée (« Iris » ou « IRIS ») est un choix par défaut du lot P0, à confirmer. **Implémenté** par #280 (non validé pour mise en service) : « IRIS » sur la connexion et le planning public ; choix par défaut en section 4 de la passation. |
| **P1** | Socle : stockage des nouveaux paramètres, écran Paramètres regroupé par thème, journal, doublon des écrans « Société » résorbé. Premier groupe : durée d'une curative (B-25), contrats (B-30, B-31), obligations de saisie (B-22, B-23), dates automatiques (B-33), échéance proposée (B-34). | Après le premier jour du pilote, sauf si l'entreprise pilote a besoin d'un de ses paramètres avant (décision 5). Le découpage du serveur, qui devait le précéder, est terminé. |
| — | Paramètres des lots 5 et 6 (anticipation de la génération des visites, mode d'envoi) | Avec ces lots, dans la table `Parametres` actuelle, sans attendre P1. L'anticipation est **implémentée** par le lot 5 (#293, `Parametres.anticipationVisitesJours`) ; le mode d'envoi viendra avec le lot 6. |
| **P2** | Modules activables (B-75) | Après P1. Il tiendra compte du choix par défaut de #272, à confirmer : la journée et le créneau d'une intervention se lisent même quand le module Planning est désactivé. |
| **P3** | Listes tenues par la société : types de chantier, moyens de paiement, priorités, couvertures, natures (B-44 à B-50). Un délai de service par priorité serait un comportement nouveau : vide par défaut, son effet est à décider par Nelson. | Après P1. Les moyens de paiement et les natures touchent la comptabilité : validation. |
| **P4** | Assistant de démarrage et préréglages | Les rôles paramétrables (lot D3 des droits) viennent après D2 : après le pilote, sauf dans les cas prévus par la section 9 de la proposition de droits (exception du lot D1). D'ici là, l'assistant existe sans l'étape « qui fait quoi » (décision 3). Il ne propose alors que le préréglage « Iris actuel », et l'étape « Rentabilité » règle les trois cases actuelles des destinataires. |
| **P5** | Documents : modèle du PDF, libellés, export comptable (B-59, B-60, B-62), avec l'envoi des documents (lot pilote 6) et #35. L'identité imprimée est copiée et figée à l'émission (décision 6). | **Partiel.** Option B retenue par Nelson le 22-10-2026 : avec le lot 6, avant le premier jour, seul ce que l'envoi exige, soit le modèle commun et l'identité figée (lot 6a-1, #300, **implémenté**, non validé pour mise en service), puis le PDF du devis sur ce modèle (lot 6a-2, #301, **implémenté**, non validé pour mise en service). Libellés, export comptable et modèles personnalisables après le premier jour. |
| — | Numérotation hors préfixe (B-58) | Sur demande, après avis du cabinet sur le garde-fou des préfixes |
| — | Seuils, méthodes et règles touchant les montants (B-35 à B-43) | Au cas par cas, sur décision de Nelson |
| — | Horaires, jours fériés et astreintes (B-26 à B-29, B-38, B-64) | Lot (j), déjà décidé hors pilote |
| — | Règle de clôture d'une intervention et liste des motifs (B-55) | Sur décision de Nelson (section 3.2) ; d'ici là, dans le code (#268) |
| — | Sans lot, sur demande : B-24, B-51, B-52, B-63, B-65, B-66, et l'affichage (B-67 à B-71) | — |

## 6. Décisions sur les questions ouvertes (arbitrées le 18-10-2026 par délégation)

Nelson a délégué ces arbitrages le 18-10-2026 : « Prend la meilleur decision possible comme tu comprend parfaitement ce que doit faire cette application alors prend le meilleur choix pour le bien de l'application pour cette partie et la facilité de l'utilisation en gardant la flexibilité. » Ce sont des arbitrages faits par délégation : la fusion de la proposition vaut sa validation, et revient à Claude Code depuis la décision de Nelson du 20-10-2026 ([CLAUDE.md](../CLAUDE.md#mode-de-livraison)).

Les principes de la section 2 s'appliquent : aucune valeur métier inventée, montants et mentions légales sous validation, et avis du cabinet pour ce qui touche la loi. La numérotation reprend celle des anciennes questions ; les sections précédentes y renvoient par « décision N ».

1. **Classement A, B, C : retenu.**
   - **Préfixes de numérotation (C-01)** : en attendant l'avis du cabinet, la règle la plus sûre s'applique. Un préfixe de facture ou d'avoir ne se change que tant qu'aucun document de ce type n'a été numéroté dans l'année en cours. Sinon, le changement est refusé avec un message clair, pour qu'aucune séquence de l'année ne change de préfixe en cours de route. La remise à zéro annuelle, qui existe déjà (séquence par année), est gardée ; le cabinet la confirmera.
   - **Listes verrouillées en base** (moyens de paiement, natures de ligne) : elles restent verrouillées jusqu'au lot P3, qui les fera tenir par la société. Ce lot demandera la validation de Nelson, car elles touchent la comptabilité.
   - **Site de facturation (C-13 bis)** : l'ordre de repli actuel est gardé (site de facturation désigné, puis site principal, siège, premier par ordre alphabétique), pour ne bloquer aucune émission. La liste de contrôle « Prêt à facturer » signalera un client sans site de facturation désigné.
2. **Valeurs initiales d'une nouvelle société.**
   - **Réglages numériques** (acompte de 30 %, seuil de marge faible de 15 %, alerte après 14 jours sans saisie, marge affichée) : la société démarre avec les valeurs actuelles du code. L'assistant les présente comme « valeurs proposées, à confirmer ». Rien n'est bloqué, et aucune valeur nouvelle n'est inventée ; aucun montant ne change pour l'installation existante.
   - **Listes propres à un métier**, comme les types de chantier de la sûreté : une nouvelle société les trouve vides dès que le lot P3 les rend paramétrables, et les saisit à l'étape « Listes ». Une installation existante garde les siennes.
3. **Assistant de démarrage.**
   - Il est réservé au super administrateur ; l'administrateur le consulte.
   - Deux parcours, un court et un complet.
   - Il est livré avant les rôles paramétrables, sans l'étape « qui fait quoi ». Il ne propose alors que le préréglage « Iris actuel », et l'étape « Rentabilité » règle les trois cases actuelles des destinataires (option du lot P4).
4. **Marque.**
   - La page de connexion affiche le nom de l'application. Confirmé par Nelson le 21-10-2026 quant au nom de l'application sur la page de connexion (citation à la ligne P0, [historique](HISTORIQUE-DECISIONS.md#décisions-du-21-10-2026)). Depuis #280, elle affiche « IRIS », comme l'écrit Nelson ; « Iris » reste le nom de l'onglet, du manifeste et du menu. La graphie reste un choix par défaut du lot P0, à confirmer.
   - Le planning public, ouvert par son lien sans connexion, affiche lui aussi le nom de l'application. Y montrer le nom de la société serait un choix séparé.
   - « NØXIA GROUPE », les icônes et les trois bleus de l'ancienne marque sont retirés par le lot P0 (#280) ; les deux gris neutres et la police de l'ancienne charte sont gardés ; la teinte de survol du bouton principal (`#024080`), dérivée de l'ancien accent, reste (suivi #299). Les barèmes et primes insérés par migration sont vidés en base, sauf valeur différente de celle insérée. Une garde statique (`client/tests/identite.test.ts`) empêche le retour du nom et des trois anciens bleus dans le code livré, hors les deux migrations déjà appliquées. Après la connexion, l'application lit l'identité de la société dans `CompanySettings`.
   - Le nom de l'éditeur reste dans le README et dans les informations du dépôt, mais pas dans l'application.
5. **Placement.** Le lot P0 au plus tôt ; mise à jour : depuis le 19-10-2026, la règle du pilote, décidée par Nelson, prime, et le 21-10-2026 Nelson a placé P0 avant la fin du pilote, avant le premier jour selon la lecture retenue (section 5). Le lot P1 après le premier jour du pilote, sauf si l'entreprise pilote a besoin d'un de ses paramètres avant : le périmètre du pilote reste la boussole.
6. **Identité de l'émetteur sur la facture : copiée et figée à l'émission (option 1).**
   - À l'émission, les coordonnées structurées de `CompanySettings` (raison sociale, SIREN et SIRET, TVA intracommunautaire, adresse) sont copiées avec la facture, puis imprimées depuis cette copie.
   - Le texte des mentions légales garde les autres mentions, sans répéter l'identité.
   - Raisons : une facture émise ne lit jamais un paramètre vivant (principe 6), et la facturation électronique exigera ces données sous forme structurée.
   - Calendrier : avec le lot 6, au lot P5. Le lot 6 étant placé avant le premier jour le 21-10-2026, la question a été posée à Nelson, qui a retenu le 22-10-2026 l'option B : la copie de l'identité accompagne le lot 6, avant le premier jour. **Implémenté** par le lot 6a-1 (#300), non validé pour mise en service ; le cabinet confirmera les champs imprimés et les champs exigés pour émettre (choix par défaut en section 4 de la passation).
