# Paramétrage cible : proposition

> **Proposition du 17-10-2026, à valider par Nelson avant tout code** (chantier technique 4). Rien de ce document n'est implémenté.
>
> L'inventaire détaillé, avec chaque règle, sa référence `fichier:ligne`, sa valeur actuelle et la raison pour laquelle elle varie, est en annexe : [`PARAMETRAGE-INVENTAIRE.md`](PARAMETRAGE-INVENTAIRE.md). Les identifiants A, B-01 à B-75 et C-01 à C-28 y renvoient.

## 1. Le besoin

Nelson, le 17-10-2026 : « Iris doit s'adapter au fonctionnement et à la taille de chaque entreprise grâce à un paramétrage fait au démarrage, plutôt que par des règles fixées dans le code. »

C'est aussi la règle permanente ajoutée le même jour à `CLAUDE.md` : toute nouvelle règle propre au fonctionnement d'une entreprise devient un paramètre, avec une valeur par défaut documentée.

## 2. Principes

1. **Valeur par défaut = comportement actuel.** Rendre une règle paramétrable ne change rien tant que la société ne modifie pas le paramètre. La valeur par défaut est écrite dans la PR et dans la passation.
2. **Aucune valeur métier inventée.**
   - Pas de prix, de commission, de compte comptable ni de délai de paiement par défaut.
   - Ce qui n'a pas de comportement actuel reste vide tant que la société ne l'a pas réglé, comme le plan comptable aujourd'hui.
   - Les valeurs déjà présentes dans le code (acompte de 30 %, seuil de marge faible de 15 %, alerte après 14 jours sans saisie…) sont présentées comme les valeurs actuelles, à confirmer par la société.
3. **Tout changement de paramètre est journalisé**, dans la même transaction (`JournalAdministration`, domaine `REGLAGES`), comme les réglages existants.
4. **« Qui fait quoi » relève des droits.** Qui clôture, qui convertit, qui facture : ces choix se règlent par les rôles de la proposition [`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md), et non par des paramètres séparés. L'assistant de démarrage les présente ensemble.
5. **Montants et conformité sous validation.**
   - Un paramètre qui touche un calcul de montant, une mention légale ou la comptabilité ne change pas de valeur par défaut sans la validation de Nelson.
   - Ceux qui touchent la loi demandent en plus celle du cabinet.

## 3. Inventaire classé

### 3.1 (A) Déjà paramétrables

| Bloc | Paramètres | Qui les modifie | Journal |
|---|---|---|---|
| Paramètres métier (`Parametres`) | marge commerciale active ; taux d'acompte proposé (30 %) ; seuil de marge faible (15 %) ; jours sans saisie (14) ; trois destinataires de la rentabilité | administrateur | oui |
| Module | Planning activé ou non (`planningActif`) | super administrateur | oui |
| Journal | durée de conservation (90 jours, de 1 à 90) | super administrateur | oui |
| Identité (`CompanySettings`) | raison sociale, SIRET, TVA, adresse, contact, logo, couleurs, préfixes de facture et d'avoir, fuseau horaire | super administrateur | oui |
| Rémunération commerciale | barèmes, objectifs, primes, libellé du barème réduit : **sans effet sur les montants depuis #159** | super administrateur | oui |
| Comptabilité | plan comptable (vide au départ), règles d'export, comptes de TVA par taux | administrateur | oui, par ses propres journaux |
| Mentions légales et CGV | versions publiées, figées | administrateur | non (passation, section 4 : à appliquer) |
| Référentiels | catégories d'achats, fournisseurs, intervenants et leurs taux, types d'événement du planning, catalogue | selon le référentiel | partiel |
| Partage public du planning | lien actif ou non | administrateur | oui |

L'inventaire relève des **paramètres saisis mais sans effet** :
- le logo, la couleur secondaire et le pied de facture ne servent nulle part ;
- les coordonnées légales (SIRET, TVA, adresse) ne sont pas imprimées : l'émetteur de la facture vient du texte libre des mentions légales.

### 3.2 (B) À rendre paramétrables

75 entrées, regroupées ici par thème. Les entrées qui touchent un montant sont signalées.

| Thème | Exemples (annexe) | Valeur ou comportement actuel | Proposition |
|---|---|---|---|
| **Qui fait quoi** | clôture et réouverture (B-01, B-02), conversion d'un devis (B-03), signature et acompte (B-04 à B-07), création et transitions SAV (B-08, B-09), coûts SAV (B-10), planning (B-11), contrats (B-12), facturation et règlements (B-13, B-14), réattributions (B-16, B-17), saisie après clôture (B-18), référentiels (B-19), gouvernance des réglages (B-20, B-21) | écrit dans les gardes de route | **Par les rôles** (chantier 3) |
| **Obligations de saisie** | titulaire obligatoire (B-22) ; commercial obligatoire dès qu'un commercial existe (B-23) ; acompte bloquant, en % du TTC (B-24, montants) | obligatoires ; acompte bloquant | Paramètres oui/non, avec le comportement actuel par défaut |
| **Durées et horaires proposés** | durée d'une curative (B-25), heure de début (B-26), plage horaire (B-27), créneaux (B-28), passage de minuit (B-29) | 60 min, 09:00, 08:00 à 12:00, interdit | Paramètres du planning ; horaires et astreintes avec le lot (j) |
| **Contrats de maintenance** | périodicité et durée proposées (B-30), couverture par défaut (B-31), génération des visites (B-32) | 12 mois, 60 min, hors forfait, manuelle | Paramètres ; génération automatique avec le lot 5 (A9) |
| **Dates automatiques** | début à la conversion, fin à la clôture (B-33) | date du jour | Paramètre oui/non |
| **Délais de facture et de règlement** | échéance proposée (B-34) ; règles d'imputation des règlements (B-35, montants) | aucun délai ; règles validées le 17-10-2026 | Délai **vide** par défaut, plafond légal à confirmer par le cabinet |
| **Seuils et méthodes** | tolérance des alertes de dépassement (B-36, montants), seuil des jauges (B-37), jours civils ou ouvrés (B-38), méthode de la marge estimée (B-39, montants), ventilation du vendu (B-40, montants), indicateurs des conducteurs (B-41), assiduité (B-42), rattachement mensuel (B-43, lot (i)) | sans tolérance ; 85 % ; jours civils | Paramètres, sous validation de Nelson pour les montants |
| **Listes de valeurs** | types de chantier (B-44, liste du métier de la sûreté) ; moyens de règlement (B-45, verrouillés aussi en base) ; priorités, aujourd'hui sans effet (B-46) ; couvertures (B-47) ; natures de ligne (B-48) ; TVA proposée (B-49) ; unité proposée (B-50) ; type de compte proposé (B-51) ; contrat « brouillon » jamais produit (B-52) | listes fermées | Listes tenues par la société, en référentiels, avec la liste actuelle en contenu initial |
| **Étapes facultatives** | figement d'un devis à l'envoi ou à la signature (B-53, question ouverte) ; révision (B-54) ; fin d'intervention sans compte rendu signé (B-55, lot 3b) ; planification automatique (B-56) ; étapes de la vision non modélisées (B-57) | comportement actuel | Paramètres, quand le lot concerné les traite |
| **Numérotation et documents** | format des numéros hors préfixe (B-58) ; modèle du PDF de facture (B-59) ; libellés des visites (B-60) ; format A4 du rapport de chantier (B-61) ; export comptable (B-62) | formats fixes ; PDF fixe ; format `letter` | Avec le lot des documents (envoi, lot 6) et #35. La continuité de la numérotation reste dans le code (C-01). |
| **Calendrier** | exercice décalé (B-63), week-end et jours fériés (B-64), planning public (B-65), périodes par défaut (B-66) | année civile ; samedi et dimanche | Paramètres ; jours travaillés avec le lot (j) |
| **Affichage** | ordre des alertes, nombre de chantiers à surveiller, tailles de page, tris, couleurs (B-67 à B-71) | valeurs fixes | **Faible enjeu** : à laisser en l'état, sauf demande |
| **Identité en dur** | « NØXIA GROUPE » sur la connexion et le planning public (B-72) ; barèmes et primes d'une société insérés par migration (B-74) | en dur | **À retirer**, pas à paramétrer : ils contredisent la règle « aucune valeur de société dans le code » |
| **Modules** | devis, SAV, contrats, Travaux, facturation, règlements et catalogue non activables (B-75) | toujours présents | Modules activables, comme le Planning |

### 3.3 (C) À garder dans le code

| Règle | Raison |
|---|---|
| Numérotation continue et chronologique des factures et des avoirs (C-01, C-02) | Légale : séquence chronologique et continue (CGI, annexe II, art. 242 nonies A, selon notre lecture). La remise à zéro annuelle est à confirmer par le cabinet. Seuls les préfixes sont paramétrables. |
| Immutabilité de la facture émise et correction par avoir (C-03, C-04) ; devis signé figé (C-05) ; règlements immuables (C-06) | Légale et intégrité. Lacunes en base : #180. |
| Arrondis, TVA par taux, comptes de TVA (C-07, C-08) | Règle fiscale et comptable ; liste des taux légaux à confirmer par le cabinet. |
| Mentions obligatoires et chronologie de l'émission (C-09, C-10) | Légale (CGI art. 289, selon notre lecture). Le contenu des mentions reste paramétrable et validé par le cabinet. |
| Plafond des montants (C-11) | Technique : colonnes `Decimal(12,2)`. |
| Écritures comptables équilibrées et scellées (C-12) | Intégrité comptable. Leur contenu (comptes, journal) est paramétrable. |
| Format des dates et jour civil de la société (C-13) | Décision de Nelson du 14-10-2026 ; le fuseau reste paramétrable. |
| Invariants de droits (C-14) | Voir [`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md), section 7. |
| Journaux en ajout seul (C-15) | Traçabilité. La durée de conservation est paramétrable. |
| Un chantier par affaire, client figé après facturation (C-16) ; squelettes des cycles de vie (C-17) ; contrats, visites et coûts figés (C-18, C-19) ; échéance contractuelle (C-20) ; origine des factures (C-21) ; client actif pour ouvrir un dossier (C-22) | Intégrité, et décisions de Nelson des 14 et 16-10-2026 |
| Formats de contrôle (C-23), semaine ISO (C-24), structures du modèle (C-25) | Validation technique et conventions |
| Paramètres de sécurité et d'exploitation (C-26) | Hors assistant métier ; réglables au besoin par variable d'environnement |
| Fuseaux limités aux fuseaux français (C-27) | Iris est un ERP natif français ; le fuseau reste au choix dans cette liste. |
| Plafond des paiements en espèces (C-28) | Absent aujourd'hui ; règle légale éventuelle, à confirmer par le cabinet avant toute implémentation. |

## 4. L'assistant de démarrage

### 4.1 Forme

- **Où** : Paramètres > « Démarrage ».
- **Qui** : réservé au super administrateur ; un administrateur le consulte.
- **Reprise** : on peut l'interrompre et le reprendre. Chaque étape s'enregistre à sa validation, avec une entrée de journal par paramètre modifié.
- **Ensuite** : tout reste modifiable dans les écrans habituels, et l'assistant peut être rejoué.
- **État « prêt à démarrer »** : une liste de contrôle montre ce qui reste à régler (identité, plan comptable, mentions légales, comptes), comme le fait déjà « Prêt à facturer » pour la facturation.
- **Pas de doublon** : l'assistant renvoie vers les écrans existants (Plan comptable, Mentions et CGV, Catalogue) au lieu de les dupliquer.

### 4.2 Étapes et questions

Questions tirées de l'annexe, section 6. L'assistant ne tranche rien : chaque réponse règle des paramètres ou choisit un préréglage.

| Étape | Questions | Ce qu'elles règlent |
|---|---|---|
| 1. La société | identité légale et visuelle, fuseau, préfixes de facture et d'avoir (Q1, Q2, Q18) | identité de la société |
| 2. Taille et organisation | combien de personnes ? une hiérarchie ? quelles fonctions existent ? (Q3, Q5) | préréglage des rôles « TPE », « PME avec hiérarchie » ou « Iris actuel » ([`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md), section 4) ; comptes et rattachements |
| 3. Domaines utilisés | devis, SAV, contrats, chantiers, planning, facturation, règlements, catalogue (Q4) | modules activés |
| 4. Qui fait quoi | clôture, conversion, acompte, SAV, planning (Q6 à Q8, Q11) | ajustement des rôles proposés |
| 5. Devis et acompte | acompte demandé, taux proposé, acompte bloquant ; figement du devis (Q9, Q10) | paramètres de devis ; **montants : validation** |
| 6. SAV et maintenance | horaires, jours travaillés, durée d'une curative, périodicités et couvertures habituelles, priorités (Q12, Q13, Q15) | paramètres du planning et des contrats |
| 7. Listes | activités et types de chantier, moyens de paiement, TVA et unité proposées (Q14, Q16, Q20) | référentiels |
| 8. Facturation et comptabilité | conditions de paiement, plan comptable, exercice (Q17, Q19, Q22) | liens vers Mentions et CGV et vers Plan comptable ; **à fournir par le cabinet** |
| 9. Rentabilité | qui la suit, marge affichée, seuils d'alerte (Q21) | permission « voir la rentabilité » des rôles ; seuils ; **montants : validation** |
| 10. Journal | durée de conservation (Q24) | conservation ; **à faire trancher par le cabinet** |

### 4.3 Préréglages

Un préréglage remplit les paramètres d'**organisation** : rôles, modules, obligations de saisie, durées proposées. Il ne touche jamais aux montants, aux comptes, aux prix ni aux mentions légales.

Trois préréglages sont proposés :
- « TPE » ;
- « PME avec hiérarchie » ;
- « Iris actuel », c'est-à-dire tout à la valeur du code d'aujourd'hui.

L'écran affiche un récapitulatif avant de les appliquer.

## 5. Lots proposés

| Lot | Contenu | Placement proposé |
|---|---|---|
| **P0** | Retirer les valeurs de société écrites en dur : « NØXIA GROUPE » des écrans (B-72) ; barèmes et primes insérés par migration, par une nouvelle migration qui les vide, sans effet sur aucun montant depuis #159 (B-74) | Au plus tôt ; petite PR |
| **P1** | Socle : stockage des nouveaux paramètres, écran Paramètres regroupé par thème, journal. Premier groupe utile au pilote SAV et maintenance : durées et horaires proposés (B-25 à B-28), contrats (B-30, B-31), obligations de saisie (B-22, B-23) | Avant ou après le premier jour du pilote, selon les besoins de l'entreprise pilote (question 4) |
| **P2** | Modules activables (B-75) | Après P1 |
| **P3** | Listes tenues par la société : types de chantier, moyens de paiement, priorités, couvertures, natures (B-44 à B-50) | Après P1 ; les moyens de paiement et les natures touchent la comptabilité (validation) |
| **P4** | Assistant de démarrage et préréglages, avec les modèles de rôles (lot D4 de [`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md)) | Après P1 à P3 et le lot D3 des droits |
| **P5** | Documents : identité imprimée, modèle du PDF, numérotation hors préfixe, format A4 (B-58 à B-61), avec l'envoi des documents (lot pilote 6) et #35 | Avec le lot 6 |
| — | Seuils, méthodes et délais touchant les montants (B-34 à B-43) | Au cas par cas, sur décision de Nelson |
| — | Horaires, jours fériés et astreintes (B-29, B-38, B-64) | Lot (j), déjà décidé hors pilote |

## 6. Questions pour Nelson

1. **Classement** : valides-tu le classement A, B, C ? En particulier :
   - en C, la remise à zéro annuelle de la numérotation et la liste des taux de TVA, à confirmer par le cabinet ;
   - en B, les listes aujourd'hui verrouillées en base, comme les moyens de paiement.
2. **Valeurs actuelles** : une nouvelle société démarre-t-elle avec les valeurs présentes dans le code (acompte de 30 %, seuil de marge faible de 15 %, alerte après 14 jours sans saisie, marge affichée) ? Ou ces paramètres restent-ils vides jusqu'à leur réglage dans l'assistant ?
3. **Assistant** : réservé au super administrateur ? Les trois préréglages proposés te conviennent-ils ?
4. **Placement** : P0 au plus tôt ; P1 avant le premier jour du pilote, ou après ?
5. **Identité sur la facture** : les coordonnées de `CompanySettings` ne sont pas imprimées ; l'émetteur vient du texte des mentions légales. Faut-il les imprimer avant le premier jour du pilote, ou avec le lot 6 ?
