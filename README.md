# IRIS — ERP pour métiers techniques

**Propriété logicielle** : Noxia-Groupe / OrizonLab  
**Repo** : https://github.com/Noxia-Groupe/iris   
**Déploiement** : une instance Iris dédiée par société cliente, avec sa propre base PostgreSQL

## Configuration d’une instance

La procédure de création d’une instance vierge, les variables PostgreSQL, Microsoft Entra ID, JWT, accès de secours, frontend et tests sont documentées dans [`docs/CONFIGURATION-ENVIRONNEMENT.md`](docs/CONFIGURATION-ENVIRONNEMENT.md). Les modèles versionnés sont [`.env.example`](.env.example) et [`server/.env.example`](server/.env.example) ; les fichiers `.env` réels ne doivent jamais être ajoutés au dépôt.

**Portée du journal des règles comptables.** Les contraintes et triggers SQL vérifient les
transitions et journaux dans les deux sens pour un rôle SQL non propriétaire. Le propriétaire
de la base est **de confiance** : il peut désactiver les triggers, modifier les fonctions et
fabriquer des lignes dans `TransitionRegleComptable`. La configuration actuelle ne démontre
pas une garantie contre des `INSERT` SQL arbitraires faits avec ce rôle propriétaire.
Avant de revendiquer cette garantie face aux écritures directes, déployer l’application avec
un rôle non propriétaire distinct du rôle de migration, lui accorder seulement les droits
nécessaires sur les tables métier (pas d’écriture sur le ledger ni de DDL), et tester les
permissions effectives du rôle déployé. Ne jamais partager le rôle migrateur avec l’API.

## Vision
Iris est un ERP français pour métiers techniques : interventions SAV et travaux, facturation récurrente, abonnements télécom (4G/fibre), financeurs, raccordement bancaire automatique, web app mobile pour techniciens, branding personnalisé (couleurs + logo) et identité légale de la société exploitante. Une installation Iris correspond à une seule société : déploiement à la demande, sans inscription publique ni mutualisation de base de données.

## Modules prévus

> Référence fonctionnelle et UX : [`docs/PRODUCT-VISION-ERP-TECHNIQUE.md`](docs/PRODUCT-VISION-ERP-TECHNIQUE.md). Iris possède son propre référentiel clients, contacts, sites, devis, interventions, contrats et factures ; les intégrations externes ne sont jamais sa source de vérité.

1. **Interventions SAV** — suivi, historique client, rapports signés
2. **Interventions Travaux** — planning, heures, achats, devis, facture
3. **Contrats & Maintenance récurrente** — échéances automatiques, prorata, renouvellement
4. **Abonnements télécom** — 4G, fibre, box : cycle de facturation, suspension, résiliation
5. **Financeurs** — Grenke, LPB : suivi des financements liés aux équipements/interventions
6. **Rapprochement bancaire** — relevés automatiques + rapprochement factures / paiements
7. **Identité client** — logo, couleurs, informations légales (SIRET, adresse, conditions)
8. **Comptes & Droits** — profil technique, commercial, comptable, admin, super-admin ; séparation stricte plateforme/client
9. **Web mobile technicien** — planning, détails intervention, saisie info, signature numérique
10. **Déploiement** — Docker/VPS dédiée par société ; instance et base de données propres

## Règles métier : aucune valeur de société dans le code

Les barèmes de commission, objectifs mensuels, primes et le libellé du barème réduit sont
stockés en base (`ParametresRemuneration`) et s'éditent depuis **Administration >
Rémunération commerciale** par un super administrateur. Ils étaient auparavant écrits en
dur dans `server/index.ts` : changer un taux imposait un redéploiement, et chaque instance
livrée portait les règles de rémunération d'une autre société.

Ces règles générales ne sont plus appliquées : sans plan commercial attribué, un commercial
ne touche aucune commission ni prime (décision du 17-10-2026, #159). Les plans commerciaux
paramétrables restent à livrer (lot (i) de la passation).

De même, aucun email d'administration n'est codé en dur : `SUPERADMIN_EMAILS` est
obligatoire au premier démarrage d'une instance neuve, faute de quoi aucun compte
d'administration n'est créé.

## Périmètre de lecture

Les listes du domaine chantier (chantiers, achats, heures) ne renvoient que ce que le
demandeur a le droit de voir : un conducteur ses chantiers, un responsable les siens et
ceux de toute sa branche hiérarchique (ses collaborateurs directs, puis les leurs), un
commercial ceux qu'il a vendus, un directeur ou un administrateur l'ensemble. Une clé
d'intégration, qui n'a pas de rôle, est cadrée par ses scopes — `chantiers:read` pour le
domaine, `finances:read` pour y ajouter les montants vendus et la marge.

La **rentabilité** d'un chantier (montant vendu global, marge du jour, marge estimée,
alertes `EN_PERTE` et `MARGE_FAIBLE`, facturation de la fiche) est décidée chantier par
chantier. Les administrateurs la voient toujours ; les autres destinataires, actifs par
défaut, se retirent un par un dans **Administration > Marges** pour s'adapter à
l'organisation : le conducteur du chantier, ses responsables hiérarchiques à tous les
niveaux (comptes Responsable), les directeurs. La chaîne hiérarchique se règle compte par
compte dans **Administration > Utilisateurs**. Les budgets par poste (matériel,
main-d'œuvre, heures) restent visibles de tous ceux qui voient le chantier, pour suivre les
dépassements (le technicien ne voit que le budget d'heures, voir ci-dessous) : ils permettent
d'en déduire le vendu, donc la marge du jour.

Le **taux horaire** de chacun et le **coût de main-d'œuvre** sont réservés à l'administration
(décisions de Nelson des 13 et 16-10-2026, #134). Les autres comptes gardent les heures,
jamais un montant horaire : ni taux (intervenants, pointages, journaux des saisies du chantier
et du SAV), ni coût de main-d'œuvre, ni dépenses qui l'incluent (fiche et liste des chantiers,
coûts SAV, statistiques), ni coût horaire de référence de la marge estimée. Les destinataires
de la rentabilité gardent la marge du jour, la marge estimée et les alertes ; le dépassement
de main-d'œuvre leur est signalé sans montant. Une clé d'intégration garde son accès.

Le **technicien** consulte le chantier dont il est chargé, avec son budget d'heures et ses
heures réalisées, sans aucun montant : ni budgets matériel et main-d'œuvre, ni coûts (achats,
main-d'œuvre, totaux), ni taux horaires, ni alertes de dépassement, dans la liste, la fiche,
les journaux d'achats, d'heures et de saisies, le tableau de bord et la liste des
intervenants. Il ne modifie pas l'affaire, n'en réattribue pas le commercial et ne la clôture
pas : le serveur refuse avec un message explicite, et la fiche l'indique. La clôture d'une
affaire revient à l'administration et aux directeurs, sur tout chantier (décision de Nelson du
14-10-2026), à son titulaire s'il n'est ni technicien ni commercial (un conducteur clôture
l'affaire dont il est chargé) et, pour l'affaire d'un technicien, aux comptes Responsable dont
la branche contient le technicien, à tout niveau. Seule l'administration rouvre un chantier
clôturé. Les droits
devis, saisie ou archivage Travaux et l'accès financier ne s'accordent pas à un technicien ;
ceux d'un compte qui devient technicien restent enregistrés, mais sans effet :
l'écran Utilisateurs les signale « Sans effet » et un super administrateur peut les retirer.
Il consulte l'**annuaire des clients** (décision de Nelson), par exemple pour retrouver une
adresse : son type de compte porte `clients:read`, et le menu Clients lui ouvre la liste et la
fiche de chaque client (coordonnées, contacts avec leur téléphone, sites avec leur adresse), en
consultation seule, sans parc d'équipements ni catalogue, donc sans prix. La fiche montre
l'historique des chantiers du client, sans montant (nom, adresse, statut, dates), limité aux
chantiers dont il est chargé (confirmé par Nelson le 14-10-2026) ; l'administration y voit
tous les chantiers non annulés reliés à la fiche. Dans l'annuaire, les clients désactivés lui
sont fermés, en liste comme à l'unité ; une intervention SAV qui lui est affectée montre
encore le client, le site et le contact, même désactivés (choix par défaut, à confirmer : il les garde ; voir la passation).
Il ne voit aucun devis.

Le **conducteur de travaux** lit lui aussi les clients (décision de Nelson du 16-10-2026, #143) :
son type de compte porte `clients:read`, pour choisir par la recherche le client d'une
intervention SAV qu'il crée. Il ne modifie pas l'annuaire et ne voit pas de devis ; l'historique
d'un client ne lui montre que ses chantiers, sans montant. Depuis #145 (décision du 16-10-2026), le
menu Clients lui ouvre l'annuaire, en consultation seule comme pour le technicien ; à la différence de celui-ci, il ouvre encore par son adresse la fiche d'un client désactivé, qui le signale (question ouverte sur les clients désactivés).

Les deux portes (interface et `/api/v1`) exécutent le même handler, pour qu'aucune règle
ne puisse être appliquée d'un seul côté. L'historique des chantiers d'un client
(`GET /api/clients/:id/chantiers`) n'existe que côté interface.

Chaque chantier porte des alertes de suivi calculées par le serveur (`metrics.alertes`) :

- `HEURES_DEPASSEES`, `MAIN_OEUVRE_DEPASSEE`, `MATERIEL_DEPASSE` : le réel dépasse ce qui a
  été vendu ;
- `SANS_SAISIE` : chantier en cours sans achat ni heure depuis le délai réglé dans
  **Administration > Marges** (14 jours par défaut, champ vide = alerte désactivée) ;
- `EN_PERTE` : dépenses réelles supérieures au montant vendu ;
- `MARGE_FAIBLE` : marge **estimée en fin de chantier** négative, ou sous le seuil réglé
  dans **Administration > Marges** (15 % par défaut, champ vide = seuil désactivé).

La marge estimée (`metrics.margeEstimee`, hypothèses dans `metrics.estimation`) compte,
pour chaque poste, le plus élevé du réel déjà dépensé et du coût attendu : heures vendues
au coût horaire moyen réellement appliqué sur le chantier (à défaut celui de la société,
à défaut le budget main-d'œuvre vendu) ; matériel vendu multiplié par le ratio achats /
matériel vendu observé sur les chantiers terminés (à défaut, au prix de vente). Un
chantier terminé est estimé à son réel. `EN_PERTE`, `MARGE_FAIBLE` et l'estimation suivent
la visibilité de la marge : ils ne sont jamais envoyés à un rôle ou une clé à qui la marge
est masquée. Les dépassements et `SANS_SAISIE` restent visibles de tous ceux qui voient le
chantier, sauf les dépassements pour le technicien. La liste des chantiers et le tableau de bord s'en servent pour mettre les
affaires à surveiller en tête.

## Cycle de vie d'une affaire

Une affaire n'existe que par un devis. La conversion d'un devis accepté crée le chantier
et vaut, par le même geste, validation définitive du devis — il n'y a pas d'autre porte :
`POST /api/chantiers` répond 410, et un chantier ne se supprime plus.

Chaque affaire a son chantier, un seul (décision de Nelson du 14-10-2026) : un devis déjà
converti, un dossier dont une autre version l'est déjà, y compris entre deux conversions
simultanées, et une référence d'affaire déjà portée par un chantier sont refusés (409). Le
chantier s'ouvre depuis l'écran Devis (« Ouvrir le chantier ») ou depuis **Administration >
Chantiers** (« Ouvrir le chantier d'une affaire »). Ce second formulaire part du devis signé,
dont le chantier reprend le client, la référence, le montant et les heures vendus, et fixe en
même temps le responsable, le commercial, les types et la date de début ; ces choix
d'ouverture sont réservés à l'administration. Le chantier se modifie et se réattribue ensuite
depuis sa fiche (bouton « Modifier »), par l'administration ou par son titulaire, par exemple
au départ d'un conducteur.

```text
BROUILLON → ENVOYÉ → ACCEPTÉ ─┬─ valider ───────────────────────→ chantier ouvert
                              └─ en attente d'acompte → acompte constaté → chantier ouvert

ACCEPTÉ ou converti ──[annulation administrateur + motif]──→ ANNULÉ (terminal)
                                                             ↳ chantier archivé, motif conservé
```

**Acompte.** Une case sur le devis initial conditionne l'ouverture du chantier à la
réception d'un acompte. Le taux par défaut se règle dans **Administration > Marges**, et
chaque devis **fige le sien à l'émission** : changer la politique de la société ne réécrit
aucun devis déjà émis. Tant que le module paiements n'existe pas, un administrateur
constate la réception à la main (date, montant, référence) ; le rapprochement bancaire
alimentera ces mêmes champs plus tard sans changer la règle.

**Annulation.** C'est le seul retour en arrière possible sur une affaire ouverte par
erreur. Réservée aux administrateurs, elle exige un motif, **archive** le chantier lié au
lieu de le détruire — sa raison doit rester lisible — et elle est **refusée dès qu'une
heure ou un achat y a été saisi** : une affaire commencée se mène à son terme, elle ne
s'efface pas. Une affaire archivée sort des listes, des coûts, des marges et des
commissions, n'accepte plus aucune écriture, mais reste consultable avec son motif.

**Reprise.** On n'annule pas une annulation. La reprise passe par la duplication du devis :
même client, même objet, mêmes lignes, mais un numéro d'affaire neuf et un retour en
brouillon — dupliquer ne contourne pas l'accord du client. Le duplicata garde le lien vers
le devis dont il est issu.

## Dates au jour et à l'heure de la société

Toutes les dates suivent le fuseau de la société qui utilise Iris (Administration > Société),
où que se trouve celui qui consulte ou saisit (décision de Nelson du 14-10-2026, #130) :

- une **date métier** (début et fin d'un chantier, date d'achat, d'heures, de facture…) est
  une date-seule, saisie et affichée en `JJ-MM-AAAA` (#132) et stockée à minuit UTC ; elle se
  lit telle quelle, sans conversion ;
- un **instant** (horodatage d'une signature, d'une écriture de journal, d'une mise à jour)
  s'affiche à la date et à l'heure de la société, la date en `JJ-MM-AAAA` ;
- « aujourd'hui » est le jour de la société : préremplissages, semaine et mois affichés par
  défaut (statistiques, performances, commissions, planning, planning public), jour surligné.
  Tant que son fuseau n'est pas lu, aucune date du jour n'est préremplie ; la période affichée
  par les écrans connectés suit Europe/Paris jusqu'à une lecture réussie du fuseau, puis se
  recale, et une réponse dépassée est ignorée ; les dates de la fiche chantier ne se modifient pas (enregistrer la
  fiche garde alors ses dates), et la création d'une facture est refusée. Le planning public
  n'affiche aucune semaine avant la première réponse du serveur, qui lui donne le jour et le
  fuseau de la société ;
- un chantier ouvert sans date choisie commence le jour civil de la société. Un début
  horodaté plus ancien (conversion antérieure) se lit dans ce fuseau, et enregistrer la fiche
  le fixe à ce même jour ;
- une date-heure ISO reçue par l'API pour une date métier lue par `dateIsoStricte` (chantier,
  heures, achats, interventions, factures, contrats, acompte, équipements, planning) retient la
  date telle qu'elle est écrite, sans tenir compte de l'heure ni du décalage, présent ou non ;
  l'heure et le décalage doivent être valides. Avec un décalage aussi, la date écrite est
  retenue, et non le jour de la société de l'instant (décision de Nelson du 15-10-2026). La date
  de demande curative n'accepte que `JJ-MM-AAAA` (choix par défaut, à confirmer : l'aligner sur les autres dates ; voir la passation) ;
- la semaine de la société commence le lundi.

Toutes les dates s'affichent et se saisissent au même format `JJ-MM-AAAA` (décision de Nelson
du 14-10-2026, #132), jusque dans les libellés de semaine, les en-têtes du planning et les
messages du journal ; aucun sélecteur de date du navigateur ne subsiste.

## Hors périmètre

- **Dépôt et galerie de photos.** La galerie photos de chantier a été retirée : Iris n'a
  pas vocation à héberger des médias, ni sur le suivi de chantier, ni sur les modules à
  venir. Cela supprime du même coup un volume disque à sauvegarder, un service de fichiers
  statiques et une route d'envoi de fichiers à sécuriser.

## Authentification
Microsoft Entra ID uniquement — adaptée par client futur (tenant client). Pas de page d'inscription publique, de connexion locale ni de mot de passe applicatif. L'application SPA utilise MSAL ; le backend vérifie la signature Microsoft (JWKS/RS256), l'issuer et l'audience avant d'appliquer sa liste blanche locale. Chaque utilisateur doit exister dans le tenant Microsoft et, actif, dans Iris (Administration > Utilisateurs), sous la même adresse.

L'application n'a plus aucun mot de passe. Deux portes complètent Entra ID sans le
remplacer — voir [`docs/ACCES-SANS-MICROSOFT.md`](docs/ACCES-SANS-MICROSOFT.md) :

- **Accès de secours** (`/secours`) : réservé au super administrateur, pour entrer quand le
  SSO est indisponible ou mal configuré. Jeton dans `server/.env`, session d'une heure,
  tentatives journalisées. Sans lui, une instance dont le SSO tombe est inadministrable.
- **Clés d'intégration** : pour un agent (Hermes) ou un connecteur, avec des scopes
  restreints et une révocation immédiate. Aucun compte Microsoft n'est créé pour un robot.

### Configuration Entra ID à réaliser
- Type d'application : **Single-page application (SPA)**.
- URI de redirection : `https://<domaine-de-l-instance>/auth/callback` (par exemple `https://iris.noxia-groupe.fr/auth/callback`), et non l'origine seule.
- Renseigner ensuite `AZURE_TENANT_ID` (GUID de l'annuaire) et `AZURE_CLIENT_ID` (GUID de l'application) uniquement dans `server/.env` sur le VPS ; ces valeurs sont publiques par nature pour une SPA. Procédure complète : [`docs/CONFIGURATION-ENVIRONNEMENT.md`](docs/CONFIGURATION-ENVIRONNEMENT.md#microsoft-entra-id-microsoft-365).
- Ne pas créer de secret client pour ce flux SPA. Aucun secret Microsoft ne doit être ajouté au dépôt.

## Stack technique
- Backend : TypeScript / Node
- Frontend : React / Vite
- Base : PostgreSQL 16 (dockerisé)
- Déploiement : Docker Compose sur VPS CommercePro 46.202.129.169
- Réseaux : `iris-network` + `nginx-proxy` (NPM) + `backup-net` (pgBackWeb)

## Propriété
Le logiciel reste la propriété de Noxia-Groupe / OrizonLab. Les clients obtiennent un accès à leur instance sans accès au code source. Chaque client dispose de son propre déploiement et de sa propre base de données ; aucune donnée métier n'est partagée entre sociétés.

## Roadmap et état de livraison

**Source de passation à jour : [`docs/ROADMAP-PASSATION.md`](docs/ROADMAP-PASSATION.md)**, qui indique en tête le commit de `main` qu'elle décrit. Le détail des lots livrés, des décisions déjà appliquées et des constats corrigés est dans [`docs/HISTORIQUE-DECISIONS.md`](docs/HISTORIQUE-DECISIONS.md). « Code présent » ne signifie ni conformité validée ni mise en production. L'état de chaque domaine, les questions ouvertes pour Nelson et les choix par défaut, à confirmer, sont détaillés dans la passation.

- [x] Phases 0–4 : identité du projet, accès Entra/secours, configuration d'instance, référentiel clients/sites/contacts, catalogue et parc d'équipements. Le catalogue et le plan comptable démarrent vides. L'écran Utilisateurs est allégé (#124) ; sur une installation neuve, la création des réglages uniques (paramètres, société) ne provoque plus d'erreur lors des premières requêtes simultanées, et une liste d'Administration qui ne se charge pas est signalée sans plantage (#125).
- [ ] Phase 5 — **partielle** : devis versionnés, signature, acompte constaté, cycle de vie et conversion en chantier livrés ; conversions en intervention et en contrat décidées (A7, lot pilote 4, à livrer avant le premier jour, décision de Nelson du 21-10-2026), à réaliser. Sélection d'un client hors des 200 premiers livrée pour Devis (#114). Lignes reprises du catalogue et copiées figées dans le devis, avec un prix d'achat prévu facultatif réservé à l'administration ; devis signé figé en base (lot pilote 2, #161).
- [ ] Suivi Travaux — **livré**, place dans le pilote en question ; commissionnement — **fermé** : sécurité, journaux, achats/heures et fiche chantier déjà présents ; suivi de rentabilité (alertes, marge estimée en fin de chantier) implémenté par #117, et adressé selon la chaîne hiérarchique et au profil Directeur depuis #121 ; ne pas recréer un écran fictif. Profils commerciaux versionnés et individualisés de l'issue #15 non livrés, et commissions du barème global fermées tant qu'aucun plan commercial n'est attribué (#159) ; réévaluer les reliquats des issues #16 et #19 contre le code.
- [ ] Phase 6 — **partielle** : SAV, rapports, planning et suivi chantier présents ; navigation utilisable sur téléphone depuis #118, et, depuis #147, écrans de l'administration (320 à 1024 px) et écrans principaux du conducteur et du technicien (320 et 375 px, hors `/admin`, voir #150) sans contenu coupé, rogné ni débordant, ni titre recouvert, dans leur état initial ; client hors des 200 premiers sélectionnable à la création d'une intervention SAV et d'un contrat de maintenance (#137), et sur la fiche chantier, où le client lié reste affiché même désactivé (#138) et où une réaffectation reprend la raison sociale du nouveau client (#142), s'écrit au journal de la fiche et se refuse tant qu'une intervention SAV y est rattachée (#146) ; une intervention SAV se rattache à un chantier par la fiche client, et non par son libellé (#144) ; la liste Clients annonce sa limite de 200 et retrouve les autres par la recherche (#139) ; comptes rendus en ajout seul et signatures figées en base (#255) ; heures du technicien sur une intervention hors contrat (#257) ; compte rendu et signature dessinée au doigt dans la page, sans fenêtre du navigateur, et clôture exigeant un compte rendu, signé ou accompagné d'un motif (#268) ; « Ma journée » et fiche intervention sur téléphone (#272) ; planning du technicien limité aux affectations dont il est chargé (#275) ; autres parcours terrain à qualifier.
- [ ] Lots décidés par Nelson : technicien sans montants ni alertes de dépassement, en consultation seule sur l'affaire — **implémenté** par #123 ; annuaire des clients pour le technicien, sans montant ni devis — **implémenté** par #127 ; clôture de tout chantier par les directeurs et clients désactivés fermés au technicien dans l'annuaire — **implémentés** par #128 ; ouverture du chantier d'une affaire depuis l'Administration, sans doublon, et réattribution par le titulaire depuis la fiche corrigée — **implémentées** par #129 ; toutes les dates au jour et à l'heure de la société — **implémenté** par #130 ; correctif « socket hang up » (connexions inactives gardées plus longtemps par le serveur, parcours E2E qui attendent leurs alertes) — **implémenté** par #131 ; toutes les dates au format `JJ-MM-AAAA` — **implémenté** par #132 ; journal des paramètres et des droits (Administration > Journal) — **implémenté** par #133 ; taux horaire et coût de main-d'œuvre réservés aux administrateurs — **implémenté** par #134 ; **prévus, hors pilote** : plan commercial (plans de commission paramétrables attribués à chaque commercial, décidé le 14-10-2026 et précisé le 16-10-2026), horaires de la société et astreintes (décidés le 14-10-2026). Ordre : le pilote d'abord, voir la passation.
- [ ] Phase 7 — **partielle** : contrats cycliques et génération idempotente d'interventions à planifier depuis une action métier ; génération automatique quotidienne des visites implémentée (A9, lot pilote 5, #293), non validée pour mise en service.
- [ ] Phase 8 — **partielle** : factures, avoirs, PDF, plan comptable paramétrable et export CSV déjà présents. La conformité de facturation électronique et l'adaptateur de plateforme restent à concevoir/valider. Requalifier les anciennes issues #31, #33 et #35 avant de coder leur reliquat.
- [ ] Phase 9 — **future comme chaîne automatisée** : paiements, abonnements télécom, financeurs, banque et rapprochement ; les règlements sont saisis à la main et affectés aux factures (lot pilote 1, P1a : reste dû, statut « réglée » déduit, contre-passation), sans banque ni rapprochement.
- [ ] Phase 10 — **partielle** : seule la connexion Entra existe ; Outlook/Graph et personnalisation documentaire restante à réaliser ou qualifier ; le SSO Entra déjà présent n'est pas un connecteur Outlook.
- [ ] Phase 11 — **partielle** : paramètres Entra et secours d'instance existants ; installation guidée et secours plateforme distinct non démontrés.
- [ ] Phase 12 — **préparée, non validée** : Compose, migrations et CI existent ; recette, isolation SQL, sauvegarde/restauration, validations client et décision de mise en service restent requises.

**Prochains découpages : le pilote (décisions de Nelson des 16 et 21-10-2026).** Option 1, SAV et maintenance. Décidés pour le premier jour : règlements, catalogue dans les devis, parcours technicien sur téléphone (tous trois implémentés, non validés pour mise en service). À livrer avant le premier jour (décision de Nelson du 21-10-2026), non encore réalisés : conversion des devis en intervention et en contrat, génération automatique des visites, envoi des documents (Microsoft 365 par défaut ; repli des PDF envoyés à la main, à confirmer). Hors pilote : banque, abonnements et locations, financeurs, télécom, plan commercial, astreintes. Détail dans la [passation](docs/ROADMAP-PASSATION.md#2-pilote) ; une CI verte seule n'autorise ni fusion ni production.

## Tests

```bash
cd server && npm test
```

Les tests appellent le code : fonctions de validation exécutées directement, requêtes HTTP
réelles sur l'application montée en mémoire. Les tests HTTP ont besoin d'une base jetable
via `TEST_DATABASE_URL` et s'annoncent ignorés sans elle — voir
[`server/tests/README.md`](server/tests/README.md).

Un test qui relit le code source en texte n'en est pas un : il reste vert sur une branche
qui ne compile même pas. Cette règle est la seule qui compte ici, avec une exception documentée
dans [`server/tests/README.md`](server/tests/README.md) : `environnement.test.mjs` relève dans le
texte les variables d'environnement lues, pour vérifier qu'elles sont documentées (consigne de
Nelson du 20-10-2026 ; l'exception est un choix par défaut, à confirmer) ; il ne prouve aucun
comportement.

Parcours navigateur (Playwright, base PostgreSQL jetable) :

```bash
cd client && E2E_DATABASE_URL=postgresql://…/iris_e2e npm run test:e2e:local
```

Cette commande recompile le backend et migre la base avant chaque exécution ; sans elle, Playwright
peut tester un ancien `server/dist`. Détails dans
[`docs/CONFIGURATION-ENVIRONNEMENT.md`](docs/CONFIGURATION-ENVIRONNEMENT.md#tests-et-ci).

## Audit de clôture des liens hérités

Contrôlé le 04/09/2026 sur la branche dédiée `chore/phase-1-anti-amalgame-final` :

- [x] Recherche complète des anciennes identités techniques (nom de dépôt, services et conteneurs Docker, base PostgreSQL, variables d'environnement, URL de connexion et comptes de démonstration) : aucune occurrence active.
- [x] `docker-compose.yml`, `.env.example` et `server/.env.example` : services, base et utilisateur PostgreSQL nommés `iris`.
- [x] `server/prisma/schema.prisma` et migrations : aucune liaison technique active à une ancienne instance.
- [x] `package.json` : aucune identité d'ancien produit exposée.
- [x] `.agents/` : aucune instruction utile au projet Iris ne renvoie vers une ancienne application.
- [x] `brand/` : uniquement des éléments de marque Noxia/CybexIA ; l'identité finale reste configurable par instance.
- [x] Documentation courante nettoyée des comparaisons et libellés historiques.

Les occurrences restantes du mot français « marge » sont intentionnelles : elles désignent la marge commerciale, les commissions et les règles métier d'Iris.
