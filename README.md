# IRIS — ERP pour métiers techniques

**Propriété logicielle** : Noxia-Groupe / OrizonLab  
**Repo** : https://github.com/Noxia-Groupe/iris  
**VPS** : CommercePro 46.202.129.169  
**Déploiement** : une instance Iris dédiée par société cliente, avec sa propre base PostgreSQL

## Configuration d’une instance

La procédure de création d’une instance vierge, les variables PostgreSQL, Microsoft Entra ID, JWT, accès de secours, frontend et tests sont documentées dans [`docs/CONFIGURATION-ENVIRONNEMENT.md`](docs/CONFIGURATION-ENVIRONNEMENT.md). Les modèles versionnés sont [`.env.example`](.env.example) et [`server/.env.example`](server/.env.example) ; les fichiers `.env` réels ne doivent jamais être ajoutés au dépôt.

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
demandeur a le droit de voir : un conducteur ses chantiers, un commercial ceux qu'il a
vendus, un administrateur l'ensemble. Une clé d'intégration, qui n'a pas de rôle, est
cadrée par ses scopes — `chantiers:read` pour le domaine, `finances:read` pour y ajouter
les montants vendus et la marge.

Les deux portes (interface et `/api/v1`) exécutent le même handler, pour qu'aucune règle
ne puisse être appliquée d'un seul côté.

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

## Roadmap (ordre de travail)
- [x] Phase 0 : Nettoyage initial et renommage du projet Iris
- [x] Phase 1 : Audit final des liens hérités — configuration, identité technique, documentation et branding vérifiés ; aucun lien technique actif conservé.
- [x] Authentification : Microsoft Entra ID uniquement (suppression connexion locale, mots de passe, seed de comptes locaux)
- [x] Phase 2 : Paramétrage de l’instance — société (écran + registre des entreprises), modules, profils et rôles ; clés API d’intégration et accès de secours superadmin
- [x] Phase 3 : Référentiel clients natif — clients, contacts, sites de facturation et d’intervention
- [x] Phase 4 : Catalogue et parc d’équipements installé — modèles, migrations, catégories, API, écran de gestion, traçabilité série/IMEI/MAC, rattachement client/site, garantie et archivage historique.
- [ ] Phase 5 : Devis versionnés et conversion contrôlée — socle livré : références d’affaires annuelles, révisions, statuts, conversion après acceptation, permissions effectives, contrôles clients/devis, et cycle de vie complet de l’affaire (acompte conditionnant l’ouverture du chantier, annulation tracée avec archivage, duplication). Reste à livrer : les cibles de conversion aval — intervention, contrat, facture — quand leurs modules existeront.
- [x] Socle transversal avant Phase 6 : sécurité du suivi Travaux (issue #16) — périmètre d’écriture achats/heures borné à l’affaire, rattachement hiérarchique explicite des responsables, validation des montants et des dates, archivage tracé au lieu de la suppression, journal des saisies et statistiques cloisonnées. L’écran Travaux reste à livrer avec sa phase métier.
- [ ] Commissionnement commercial configurable (issue #15) — profils versionnés et individualisables, attributions hiérarchiques, historique non rétroactif ; dépend du socle Travaux sécurisé.
- [ ] Phase 6 : Interventions SAV + travaux, planning et application mobile technicien
- [ ] Phase 7 : Contrats et maintenance cyclique — génération des interventions à planifier avec durée prévisionnelle
- [ ] Phase 8 : Facturation française, exports comptables et conformité facturation électronique
- [ ] Phase 9 : Paiements, abonnements télécom, financeurs et rapprochement bancaire
- [ ] Phase 10 : Connecteurs Microsoft 365 (Outlook/Graph) et branding complet
- [ ] Phase 11 : Auth Microsoft configurable à l'installation + accès plateforme de secours Noxia/OrizonLab
- [ ] Phase 12 : Déploiement production dédié par client (VPS ou stack Docker + base PostgreSQL propre)

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
