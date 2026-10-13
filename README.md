# IRIS — ERP pour métiers techniques

**Propriété logicielle** : Noxia-Groupe / OrizonLab  
**Repo** : https://github.com/Noxia-Groupe/iris  
**VPS** : CommercePro 46.202.129.169  
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

Le **technicien** consulte le chantier dont il est chargé, avec son budget d'heures et ses
heures réalisées, sans aucun montant : ni budgets matériel et main-d'œuvre, ni coûts (achats,
main-d'œuvre, totaux), ni taux horaires, ni alertes de dépassement, dans la liste, la fiche,
les journaux d'achats, d'heures et de saisies, le tableau de bord et la liste des
intervenants. Il ne modifie pas l'affaire, n'en réattribue pas le commercial et ne la clôture
pas : le serveur refuse avec un message explicite, et la fiche l'indique. La clôture d'une
affaire revient à l'administration, à son responsable s'il n'est pas technicien et, pour
l'affaire d'un technicien, aux responsables de sa branche (N+1 et au-dessus). Les droits
devis, saisie ou archivage Travaux et l'accès financier ne s'accordent pas à un technicien ;
ceux d'un compte qui devient technicien restent enregistrés, mais sans effet :
l'écran Utilisateurs les signale « Sans effet » et un super administrateur peut les retirer.
Nelson a décidé de lui ouvrir l'annuaire des clients (contacts et sites, sans devis ni
montants) et l'historique des chantiers sans montant. Aujourd'hui, seul un droit `clients:read`
enregistré sur son compte (déjà présent, ou accordé par un super administrateur par l'API, que
l'écran Utilisateurs ne propose pas) lui donne l'annuaire (contacts et sites) ; le retrait de son
droit devis le conserve ; un lot prévu le lui donnera par défaut, avec un menu, une fiche client en consultation
seule et l'historique des chantiers sans montant.

Les deux portes (interface et `/api/v1`) exécutent le même handler, pour qu'aucune règle
ne puisse être appliquée d'un seul côté.

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

```text
BROUILLON → ENVOYÉ → ACCEPTÉ ─┬─ valider ───────────────────────→ chantier ouvert
                              └─ en attente d'acompte → acompte constaté → chantier ouvert

ACCEPTÉ ou converti ──[annulation administrateur + motif]──→ ANNULÉ (terminal)
                                                             ↳ chantier archivé, motif conservé
```

**Acompte.** Une case sur le devis initial conditionne l'ouverture du chantier à la
réception d'un acompte. Le taux par défaut se règle dans **Administration > Marges**, et
chaque devis **fige le sien à l'émission** : changer la politique de la société ne réécrit
aucun devis déjà émis, même règle de non-rétroactivité que les barèmes de commission. Tant
que le module paiements n'existe pas, un administrateur constate la réception à la main
(date, montant, référence) ; le rapprochement bancaire alimentera ces mêmes champs plus
tard sans changer la règle.

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

## Hors périmètre

- **Dépôt et galerie de photos.** La galerie photos de chantier a été retirée : Iris n'a
  pas vocation à héberger des médias, ni sur le suivi de chantier, ni sur les modules à
  venir. Cela supprime du même coup un volume disque à sauvegarder, un service de fichiers
  statiques et une route d'envoi de fichiers à sécuriser.

## Authentification
Microsoft Entra ID uniquement — adaptée par client futur (tenant client). Pas de page d'inscription publique, de connexion locale ni de mot de passe applicatif. L'application SPA utilise MSAL ; le backend vérifie la signature Microsoft (JWKS/RS256), l'issuer et l'audience avant d'appliquer sa liste blanche locale. Utilisateurs créés par un admin du tenant.

L'application n'a plus aucun mot de passe. Deux portes complètent Entra ID sans le
remplacer — voir [`docs/ACCES-SANS-MICROSOFT.md`](docs/ACCES-SANS-MICROSOFT.md) :

- **Accès de secours** (`/secours`) : réservé au super administrateur, pour entrer quand le
  SSO est indisponible ou mal configuré. Jeton dans `server/.env`, session d'une heure,
  tentatives journalisées. Sans lui, une instance dont le SSO tombe est inadministrable.
- **Clés d'intégration** : pour un agent (Hermes) ou un connecteur, avec des scopes
  restreints et une révocation immédiate. Aucun compte Microsoft n'est créé pour un robot.

### Configuration Entra ID à réaliser
- Type d'application : **Single-page application (SPA)**.
- URI de redirection : `https://iris.noxia-groupe.fr/auth/callback`.
- Renseigner ensuite `AZURE_TENANT_ID` et `AZURE_CLIENT_ID` uniquement dans `server/.env` sur le VPS ; ces valeurs sont publiques par nature pour une SPA.
- Ne pas créer de secret client pour ce flux SPA. Aucun secret Microsoft ne doit être ajouté au dépôt.

## Stack technique
- Backend : TypeScript / Node
- Frontend : React / Vite
- Base : PostgreSQL 16 (dockerisé)
- Déploiement : Docker Compose sur VPS CommercePro 46.202.129.169
- Réseaux : `noxia-network` + `nginx-proxy` (NPM) + `backup-net` (pgBackWeb)

## Propriété
Le logiciel reste la propriété de Noxia-Groupe / OrizonLab. Les clients obtiennent un accès à leur instance sans accès au code source. Chaque client dispose de son propre déploiement et de sa propre base de données ; aucune donnée métier n'est partagée entre sociétés.

## Roadmap et état de livraison

**Source de passation à jour : [`docs/ROADMAP-PASSATION.md`](docs/ROADMAP-PASSATION.md).** État constaté sur `main` au commit `8aa9279`, après la PR #121. « Code présent » ne signifie ni conformité validée ni mise en production. Chaque phase incomplète est détaillée dans la passation avec ses dépendances et les décisions à demander à Nelson.

- [x] Phases 0–4 : identité du projet, accès Entra/secours, configuration d'instance, référentiel clients/sites/contacts, catalogue et parc d'équipements. Le catalogue et le plan comptable démarrent vides.
- [ ] Phase 5 — **partielle** : devis versionnés, signature, acompte constaté, cycle de vie et conversion en chantier livrés ; cibles intervention/contrat/facture à cadrer et à réaliser. Sélection d'un client hors des 200 premiers livrée pour Devis (#114).
- [ ] Suivi Travaux et commissionnement — **partiels** : sécurité, journaux, achats/heures et fiche chantier déjà présents ; suivi de rentabilité (alertes, marge estimée en fin de chantier) implémenté par #117, et adressé selon la chaîne hiérarchique et au profil Directeur depuis #121 ; ne pas recréer un écran fictif. Profils commerciaux versionnés et individualisés de l'issue #15 non livrés ; réévaluer les reliquats des issues #16 et #19 contre le code.
- [ ] Phase 6 — **partielle** : SAV, rapports, planning et suivi chantier présents ; navigation utilisable sur téléphone depuis #118 ; parcours mobile technicien dédié et autres parcours terrain à qualifier.
- [ ] Lots décidés par Nelson, **prévus** : budgets matériel et main-d'œuvre masqués au technicien, puis journal des paramètres et des droits réservé aux administrateurs (voir la passation).
- [ ] Phase 7 — **partielle** : contrats cycliques et génération idempotente d'interventions à planifier depuis une action métier ; automatisation de l'échéance et ses règles de déclenchement à arbitrer.
- [ ] Phase 8 — **partielle** : factures, avoirs, PDF, plan comptable paramétrable et export CSV déjà présents. La conformité de facturation électronique et l'adaptateur de plateforme restent à concevoir/valider. Requalifier les anciennes issues #31, #33 et #35 avant de coder leur reliquat.
- [ ] Phase 9 — **future comme chaîne automatisée** : paiements, abonnements télécom, financeurs, banque et rapprochement ; un statut de règlement manuel n'est pas un module bancaire.
- [ ] Phase 10 — **à réaliser/qualifier** : Outlook/Graph et personnalisation documentaire restante ; le SSO Entra déjà présent n'est pas un connecteur Outlook.
- [ ] Phase 11 — **partielle** : paramètres Entra et secours d'instance existants ; installation guidée et secours plateforme distinct non démontrés.
- [ ] Phase 12 — **préparée, non validée** : Compose, migrations et CI existent ; recette, isolation SQL, sauvegarde/restauration, validations client et décision de mise en service restent requises.

**Prochains découpages candidats, à ordonner avec Nelson :** achever les autres écrans de l'issue [#111](https://github.com/Noxia-Groupe/iris/issues/111) par lots, adapter au téléphone les en-têtes des écrans encore serrés, puis revoir les véritables reliquats par domaine. L'ordre de développement et la définition du premier périmètre pilote doivent être confirmés avec Nelson ; une CI verte n'autorise ni fusion ni production.

## Tests

```bash
cd server && npm test
```

Les tests appellent le code : fonctions de validation exécutées directement, requêtes HTTP
réelles sur l'application montée en mémoire. Les tests HTTP ont besoin d'une base jetable
via `TEST_DATABASE_URL` et s'annoncent ignorés sans elle — voir
[`server/tests/README.md`](server/tests/README.md).

Un test qui relit le code source en texte n'en est pas un : il reste vert sur une branche
qui ne compile même pas. Cette règle est la seule qui compte ici.

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
