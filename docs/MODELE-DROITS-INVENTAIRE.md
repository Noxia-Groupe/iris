# Inventaire des règles de droits d'Iris (état du code à `84e27a1`)

> Annexe de la proposition [`MODELE-DROITS-CIBLE.md`](MODELE-DROITS-CIBLE.md) (chantier technique 3, 17-10-2026). Photographie du code à une date donnée, et non documentation tenue à jour : l'état décidé des droits reste décrit par [`MODELE-DROITS-COMPTES.md`](MODELE-DROITS-COMPTES.md). Le découpage du serveur par domaine (chantier 2) déplace les lignes citées, mais garde les noms des fonctions.

Commit de référence : `84e27a18eb1abcc1cf21b78def7de5a65dac4dac` (« Merge #175 », `main`). Toutes les références `fichier:ligne` portent sur ce commit (`git show 84e27a1:server/index.ts`).

Les renvois « roadmap §4:NNN » visent les lignes de `docs/ROADMAP-PASSATION.md` à ce même commit. La passation a reçu depuis une sous-section sur les chantiers techniques : chercher le choix par son libellé dans la section 4.

## 0. Méthode et conventions

- **Sources lues** : `server/index.ts` (8 043 lignes, lu en entier dans ses parties relatives aux droits), `server/prisma/schema.prisma`, les 85 migrations de `server/prisma/migrations` (triggers), `client/src/lib/droits.ts`, `client/src/lib/menu.ts`, `client/src/App.tsx`, `client/src/roles.ts`, les écrans de `client/src/pages`, ainsi que `docs/MODELE-DROITS-COMPTES.md`, `CLAUDE.md` et la section 4 de `docs/ROADMAP-PASSATION.md`.
- **Énumération des routes** : `npm ci`, `prisma generate` et `tsc` dans la copie de travail, puis `require('dist/index.js')` sans ouvrir de port ni de base. L'objet `app.router.stack` d'Express 5 compte **198 routes** : 144 routes `app.<méthode>(...)` et 27 appels `routeMixte(...)`, chacun montant une route `/api/...` et une route `/api/v1/...`. Les quatre middlewares globaux sont `cors`, deux `express.json` et le gestionnaire « 413 » (`server/index.ts:35-42`). Il n'y a ni middleware global d'authentification ni routeur imbriqué. Express nomme `<anonymous>` les gardes créées par fabrique (`requirePermission(...)`, `requireApiKey(...)`), d'où le recoupement avec le source de chaque définition (tableaux de la section A3).
- **« Code »** désigne ce que le code fait, **« Doc »** ce que dit `docs/MODELE-DROITS-COMPTES.md` (abrégé MDC, suivi du numéro de ligne). Les écarts sont signalés par **ÉCART** et regroupés en section D. Ce qui n'a pas pu être établi avec certitude porte la mention **à vérifier**.
- **Abréviations des types de compte** : SA = `SUPERADMIN`, AD = `ADMIN`, DIR = `DIRECTEUR`, RESP = `RESPONSABLE`, CT = `CONDUCTEUR_TRAVAUX`, COM = `COMMERCIAL`, DC = `DIRECTEUR_COMMERCIAL`, AC = `ASSISTANTE_COMMERCIALE`, CPT = `COMPTABLE`, TECH = `TECHNICIEN`. « Admins » = SA + AD (`isAdminRole`).

---

# A. Serveur

## A1. Types de compte (rôles)

| Élément | Référence | Contenu |
|---|---|---|
| `ROLE_SUPERADMIN` … `ROLE_DIRECTEUR` | `server/index.ts:205-214` | Constantes pour `SUPERADMIN`, `ASSISTANTE_COMMERCIALE`, `TECHNICIEN`, `COMPTABLE`, `DIRECTEUR_COMMERCIAL`, `RESPONSABLE` et `DIRECTEUR`. **`'ADMIN'`, `'CONDUCTEUR_TRAVAUX'` et `'COMMERCIAL'` n'ont pas de constante** : ils sont écrits en littéraux partout (par exemple 220, 226, 227, 395, 442, 542, 579, 590, 622-623, 2577, 2658, 3031, 3033, 3581, 4184, 4862, 7051, 7163, 7802, 7815). |
| `ALLOWED_ROLES` | `server/index.ts:3708` | Liste des 10 types acceptés par `POST /api/users` (3777) et `PATCH /api/users/:id/role` (3919). |
| Rôle par défaut | `server/index.ts:3777` ; `schema.prisma:20` | Un rôle inconnu à la création devient `CONDUCTEUR_TRAVAUX`, qui est aussi la valeur par défaut de la colonne `User.role`. |
| `isAdminRole` | `server/index.ts:265-267` | Vrai pour `ADMIN` ou `SUPERADMIN`. |
| `isSuperAdminRole` | `server/index.ts:268-270` | Vrai pour `SUPERADMIN` seulement. |
| Lecture du rôle | `server/index.ts:163-196` (`requireAuth`) | Le JWT n'authentifie que l'identifiant ; le rôle, `accesFinance`, `permissions` et `actif` sont relus en base à chaque requête (177). Un compte désactivé reçoit 401 `COMPTE_DESACTIVE` (184-187). |
| Champs du compte | `schema.prisma:10-76` | `role`, `estCommercial` (27), `accesFinance` (33), `permissions String[]` (37), `responsableHierarchiqueId` (42), `actif` (49). |

## A2. Permissions élémentaires

### A2.1 Droits par défaut des types de compte (`DEFAULT_USER_PERMISSIONS`, `server/index.ts:219-238`)

| Type | Droits par défaut (code) |
|---|---|
| ADMIN | `devis:read`, `devis:write`, `clients:read`, `chantiers:read`, `chantiers:write`, `chantiers:archive` (220) |
| CONDUCTEUR_TRAVAUX | `chantiers:read`, `chantiers:write`, `clients:read` (226) |
| COMMERCIAL | `devis:read`, `devis:write`, `clients:read`, `chantiers:read` (227) |
| ASSISTANTE_COMMERCIALE | identique à COMMERCIAL (228) |
| COMPTABLE | identique à COMMERCIAL (229) |
| DIRECTEUR_COMMERCIAL | identique à COMMERCIAL (230) |
| RESPONSABLE | `chantiers:read`, `chantiers:write`, `chantiers:archive` (231). **Pas de `clients:read`.** |
| TECHNICIEN | `chantiers:read`, `clients:read` (234) |
| DIRECTEUR | `chantiers:read` (237) |
| SUPERADMIN | absent de la table : `permissionsEffectives` lui ajoute **tous** les `API_SCOPES` (249). |

### A2.2 Calcul des droits effectifs

- `permissionsEffectives` (`server/index.ts:245-252`) réunit les droits du type et `User.permissions`, ajoute `finances:read` si `accesFinance` (247) et tous les scopes pour un SA (249). Pour un TECH, elle retire `DROITS_INTERDITS_TECHNICIEN` (250).
- `DROITS_INTERDITS_TECHNICIEN` (`server/index.ts:243`) : `devis:read`, `devis:write`, `chantiers:write`, `chantiers:archive`, `finances:read`.
- `hasUserPermission` (254-256) appelle `permissionsEffectives`. `requirePermission(p)` (258-263) répond 403 « Permission requise : p ».
- Les droits effectifs sont renvoyés au client par `POST /api/auth/sso` (3090), `POST /api/auth/secours` (3191) et `GET /api/me` (3209). `GET /api/users` (3692-3693) renvoie les droits effectifs **et** les droits individuels.

### A2.3 Permissions individuelles (`User.permissions`)

- Seul un SA les écrit : `PUT /api/users/:id/permissions` (`server/index.ts:4057-4083`, `requireSuperAdmin`). Les valeurs doivent appartenir à `API_SCOPES` (4063). Pour un TECH, tout **nouvel** octroi d'un droit de `DROITS_INTERDITS_TECHNICIEN` est refusé (400) ; un droit déjà enregistré peut être conservé ou retiré (4069-4074). Le changement est journalisé `PERMISSIONS` (4078).
- Les permissions **ajoutent** des droits et n'en retirent jamais, sauf pour le TECH (250). Cela correspond à MDC:12.
- **Effet réel de chaque permission sur une session humaine** (relevé des appels `requirePermission`, `server/index.ts:573-574, 5825, 5827, 5845, 6213, 6364-6369, 6409, 6519, 6526, 6645`) :

| Permission | Routes de session qui la vérifient | Effet d'un octroi individuel |
|---|---|---|
| `devis:read` | `GET /api/devis` (6364), `GET /api/devis/a-convertir` (6526, avec `devis:write`) | Ouvre la lecture de **tous** les devis. |
| `devis:write` | `POST`/`PATCH /api/devis…` (6365-6367), signature (6369), statut (6409), conversion (6519), duplication (6645), `GET /api/devis/catalogue` (6213), à-convertir (6526) | Ouvre l'écriture de tous les devis. |
| `clients:read` | `GET /api/clients` (5825), `GET /api/clients/:id` (5827), `GET /api/clients/:id/chantiers` (5845) | Ouvre l'annuaire, par exemple à RESP ou DIR. L'interface ne le suit pas (voir B). |
| `chantiers:read` | seulement `GET /api/clients/:id/chantiers` (5845) | **Aucune** route chantier de session ne la vérifie (3308 avec `[]`, 3313, 3368). |
| `chantiers:write` | `POST`/`PATCH /api/achats` (5080, 5110), `POST`/`PATCH /api/heures` (5239, 5274) | Effectif seulement si `assertChantierWritable` (4854) admet aussi le compte : un admin, le CT titulaire, ou un RESP sur sa branche. Accordé à DIR, COM, DC, AC ou CPT, il reste sans effet (refus 404). |
| `chantiers:archive` | `DELETE /api/achats/:id`, `…/restaurer`, `DELETE /api/heures/:id`, `…/restaurer` (5163, 5189, 5324, 5350) | Même condition. Effectif individuellement pour un CT (commentaire 221-223). |
| `finances:read` | **aucune** | Côté session, `voitRentabilite` (433) et `voitPrixAchatDevis` (6148) ne regardent que le rôle : la permission n'a aucun effet. |
| `clients:write`, `catalogue:read`, `catalogue:write`, `equipements:read`, `equipements:write`, `company:read` | **aucune** (les routes de session sont sous `requireAdmin` par défaut de `routeMixte`, 361, ou ouvertes à tous) | Aucun effet pour une session ; ces scopes ne valent que pour une clé. |

### A2.4 Accès financier (`accesFinance`) et `peutVoirFinance`

- `peutVoirFinance` (`server/index.ts:565-569`, exportée) : jamais pour un TECH (567) ; vraie pour un SA ou si `accesFinance`. **Aucune route ne l'appelle** : les seuls appels sont dans `server/tests/validation.test.mjs:543-547`. Le commentaire 556-564 le reconnaît (« aucun écran ne l'utilise aujourd'hui »).
- `accesFinance` ajoute `finances:read` (247), elle aussi sans effet sur une session (A2.3). **Conséquence : la case « Finance » n'ouvre aujourd'hui rien côté serveur.**
- Écriture : création par un SA seulement, refus si TECH (3788-3791) ; `PATCH /api/users/:id/acces-finance` sous `requireSuperAdmin`, refus d'une valeur vraie pour un TECH (4089-4112, 4095), changement journalisé `ACCES_FINANCE` (4105). Un changement de type ne touche pas `accesFinance` (commentaire 3945-3948).

### A2.5 « Aussi commercial » (`estCommercial`)

- `isCommercialLike` (`server/index.ts:618-620`) : vrai pour COM, ou pour un admin dont `estCommercial` est vrai. `COMMERCIAL_OR_FILTER` (621-625) traduit la même règle en filtre Prisma.
- À la création, le drapeau n'est conservé que pour un admin (3785). Il est forcé à faux quand le compte quitte le type admin (3949). `PATCH /api/users/:id/est-commercial` refuse une cible non admin (4032) ; il est journalisé `AUSSI_COMMERCIAL` (4046).
- Usages : sélecteur `GET /api/commerciaux` (4167), contrôle du commercial d'un chantier `refusCommercial` (3268-3274), prime mensuelle (5404), CA de `GET /api/stats/global` (7119), liste de `GET /api/stats/commerciaux` (7815). Un admin `estCommercial` garde son périmètre d'admin, car `perimetreDemandeur` teste `isAdminRole` avant le rôle (394).

### A2.6 Clés d'intégration (`API_SCOPES`, `requireApiKey`, `routeMixte`)

- `API_SCOPES` (`server/index.ts:298-314`) : `clients:read`, `clients:write`, `catalogue:read`, `catalogue:write`, `equipements:read`, `equipements:write`, `devis:read`, `devis:write`, `company:read`, `chantiers:read`, `chantiers:write`, `chantiers:archive`, `finances:read`. **Aucune route `/api/v1` n'utilise `chantiers:write` ni `chantiers:archive`** (relevé des 27 `routeMixte` et de `GET /api/v1/company`, 5558).
- `requireApiKey(scope)` (322-342) : en-tête `Bearer iris_…`, empreinte SHA-256 ; une clé inactive, révoquée ou expirée reçoit 401 (328), un scope absent 403 (331-333). L'échéance se lit telle quelle (`expireLe <= new Date()`, 328 ; date de création 5508). Cela correspond à la roadmap §4:264 (« à appliquer »).
- `routeMixte` (356-365) monte `/api{chemin}` avec `requireAuth` et les gardes données, `requireAdmin` par défaut (361), puis `/api/v1{chemin}` avec la seule `requireApiKey(scope)` (364).
- Gestion : `GET`/`POST /api/admin/api-keys`, `…/revoke`, `GET /api/admin/api-scopes`, toutes sous `requireSuperAdmin` (5488-5554). Création et révocation sont journalisées avec `reserveSuperAdmin: true` (5520, 5543).
- Comportement des fonctions de droits pour une clé : `perimetreDemandeur` renvoie `{}` (392) ; `voitRentabilite` exige `finances:read` (434-435) ; `voitMontantsChantier` est toujours vraie (453) ; `voitCoutMainOeuvre` aussi (476 : taux et coûts de main-d'œuvre visibles avec `chantiers:read`, roadmap §4:290 « à appliquer ») ; `voitPrixAchatDevis` exige `finances:read` (6150) ; `ecritPrixAchatDevis` est toujours fausse (6154) ; une clé ne peut pas choisir les champs d'ouverture d'une conversion (6454) ; `clientsActifsSeulement` est fausse (5603 : clients désactivés visibles) ; `avecDroitDeCloture` n'envoie pas `peutCloturer` (3247) ; une clé ne signe pas un devis (aucune route v1, 6368-6369, et contrôle 6358-6359).

## A3. Gardes de route

### A3.1 Définition des gardes

| Garde | Référence | Laisse passer | Refuse |
|---|---|---|---|
| `requireAuth` | 163-196 | toute session valide d'un compte actif ; calcule `equipeIds` (pour RESP seulement, 190) | 401 |
| `requireAdmin` | 272-278 | SA, AD | 403 tous les autres |
| `requireSuperAdmin` | 281-287 | SA | 403 |
| `requirePermission(p)` | 258-263 | les porteurs effectifs de `p` (A2) | 403 |
| `requireTravauxWrite` | 573 | `requirePermission('chantiers:write')` : SA, AD, CT, RESP, plus tout octroi individuel (sauf TECH) | 403 |
| `requireTravauxArchive` | 574 | `requirePermission('chantiers:archive')` : SA, AD, RESP, plus octroi individuel (sauf TECH) | 403 |
| `requireTravauxRead` | 577-581 | SA, AD, RESP, CT | 403 « Accès réservé au suivi Travaux » |
| `blockCommercial` | 588-599 | **tous sauf COM et DIR** : SA, AD, RESP, CT, **DC, AC, CPT**, TECH | 403 COM, 403 DIR |
| `blockCommercialSeulement` | 3580-3586 | tous sauf COM | 403 COM |
| `blockTechnicien` | 604-610 | tous sauf TECH | 403 TECH |
| `requirePlanningActif` | 633-645 | un SA toujours (635) ; les autres si `Parametres.planningActif` | 403 `PLANNING_DESACTIVE` |
| `requireApiKey(scope)` | 322-342 | une clé valide portant le scope | 401 ou 403 |
| garde en ligne de `POST /api/interventions` | 2576-2578 | SA, AD, CT | 403 « Création réservée à l'encadrement SAV » |

> Note : `blockCommercial` ne vise que les littéraux `'COMMERCIAL'` et `ROLE_DIRECTEUR`. **DC, AC et CPT, les types complémentaires commerciaux et comptable, le franchissent partout** (planning, SAV, référentiels, modification de chantier). Les commentaires (583-587, 4756-4760) ne parlent que du commercial et du directeur.

### A3.2 Chaîne de gardes de chaque route, par domaine

Dans les tableaux, « blockCommercial » se lit « tous sauf COM et DIR » et « bC+bT » se lit « blockCommercial + blockTechnicien = SA, AD, RESP, CT, DC, AC, CPT ». La colonne « Types autorisés » donne ce qui passe **gardes et contrôles du corps** réunis. Le périmètre est précisé en A4.

#### Authentification et compte courant

| Route | Ligne | Gardes | Règles dans le corps | Types autorisés |
|---|---|---|---|---|
| GET `/api/health` | 3057 | aucune | — | public |
| GET `/api/config` | 3062 | aucune | — | public |
| POST `/api/auth/sso` | 3076 | aucune | compte actif de la liste blanche (`resolveAuthorizedSsoUser`, 75-82) ; jeton de 7 jours | tout compte actif |
| GET `/api/auth/secours/etat` | 3159 | aucune | — | public |
| POST `/api/auth/secours` | 3163 | aucune | secret ≥ 32 car., 5 essais par 15 min et par IP, compte `BREAK_GLASS_EMAIL` **actif et SA** (3178-3186) ; jeton d'une heure | un seul SA nommé |
| GET `/api/me` | 3201 | requireAuth | droits effectifs | tous |
| PUT `/api/me/theme` | 3217 | requireAuth | uniquement le compte du jeton | tous |

#### Chantiers

| Route | Ligne | Gardes | Règles dans le corps | Types autorisés |
|---|---|---|---|---|
| GET `/api/chantiers` + `/api/v1/chantiers` | 3308 (gestionnaire 3282) | requireAuth, `[]` ; v1 : `chantiers:read` | `perimetreChantiers` (3286) ; masquage `voitRentabilite`, `voitMontantsChantier`, `voitCoutMainOeuvre` (3296-3301) | **tous** (le périmètre trie) |
| GET `/api/chantiers/:id` | 3313 | requireAuth | admin ou `isOwner` (3332-3339), sinon 404 ; factures et facturation seulement si `canSeeMarge` (3344-3359) | tous, sur leur périmètre propre à la fiche (A4.2) |
| GET `/api/chantiers/:id/journal-saisies` | 3368 | requireAuth | `perimetreChantiers` (3372) ; instantanés masqués par `saisieSelonDroits` (3381) | tous (périmètre) |
| POST `/api/chantiers` | 3394 | requireAuth, blockCommercial | répond toujours 410 | personne |
| PATCH `/api/chantiers/:id` | 3404 | requireAuth, blockCommercial | admin ou titulaire (`responsableId`), sinon 404 (3411) ; TECH 403 (3416) ; affaire annulée 409 (3421) ; champs autorisés (3430-3432) ; `budgetGlobalVendu` seulement si `voitRentabilite` (3478) ; `clientId` admin seulement (3447) | SA, AD ; le titulaire s'il est CT, RESP, DC, AC ou CPT |
| DELETE `/api/chantiers/:id` | 3573 | requireAuth, requireAdmin | toujours 410 | personne |
| PATCH `/api/chantiers/:id/statut` | 3588 | requireAuth, blockCommercialSeulement | admin, titulaire, ou tiers admis par `peutCloturerChantier`, sinon 404 (3597-3603) ; TECH 403 (3604) ; annulée 409 ; hors admin, uniquement EN_COURS → TERMINE (3613-3615) | SA, AD (clôture et réouverture) ; DIR (clôture de tout chantier) ; titulaire non TECH (clôture) ; RESP (clôture d'un chantier d'un TECH de sa branche) |
| PATCH `/api/chantiers/:id/commercial` | 3639 | requireAuth, blockCommercial | admin ou titulaire, sinon 404 (3649) ; TECH 403 (3652) ; `refusCommercial` (3657) | SA, AD ; titulaire CT, RESP, DC, AC ou CPT |
| PATCH `/api/chantiers/:id/encaisse` | 5380 | requireAuth, requireAdmin | **non journalisé** | SA, AD |
| POST `/api/chantiers/:id/analyze` | 7899 | requireAuth | toujours 410 | personne |

#### Achats et heures (Travaux)

| Route | Ligne | Gardes | Règles dans le corps | Types autorisés |
|---|---|---|---|---|
| GET `/api/achats` + `/api/v1/achats` | 5236 (gestionnaire 5062) | requireAuth, `[]` ; v1 : `chantiers:read` | `perimetreChantiers` (5065) ; TECH sans montants (5074) | **tous**, COM et DIR compris (le menu masque l'écran à DIR, COM, DC, AC, CPT et TECH) |
| GET `/api/heures` + `/api/v1/heures` | 5237 (gestionnaire 5217) | requireAuth, `[]` ; v1 : `chantiers:read` | `perimetreChantiers` (5220) ; `saisieSelonDroits` (5228) | tous |
| POST `/api/achats` | 5080 | requireAuth, requireTravauxWrite | `assertChantierWritable` (5086) | SA, AD ; CT titulaire ; RESP sur sa branche |
| PATCH `/api/achats/:id` | 5110 | requireAuth, requireTravauxWrite | `assertChantierWritable` (5115) ; motif obligatoire | idem |
| DELETE `/api/achats/:id` (archivage) | 5163 | requireAuth, requireTravauxArchive | `assertChantierWritable` (5168) | SA, AD ; RESP sur sa branche ; CT titulaire **avec la permission individuelle** |
| POST `/api/achats/:id/restaurer` | 5189 | requireAuth, requireTravauxArchive | `assertChantierWritable` (5194) | idem |
| POST `/api/heures` | 5239 | requireAuth, requireTravauxWrite | `assertChantierWritable` (5247) ; réponse masquée (5263) | SA, AD ; CT titulaire ; RESP sur sa branche |
| PATCH `/api/heures/:id` | 5274 | requireAuth, requireTravauxWrite | `assertChantierWritable` (5279) | idem |
| DELETE `/api/heures/:id` | 5324 | requireAuth, requireTravauxArchive | `assertChantierWritable` (5329) | comme l'archivage d'un achat |
| POST `/api/heures/:id/restaurer` | 5350 | requireAuth, requireTravauxArchive | `assertChantierWritable` (5355) | idem |

#### Référentiels Travaux et listes d'attribution

| Route | Ligne | Gardes | Règles dans le corps | Types autorisés |
|---|---|---|---|---|
| GET `/api/categories` | 4761 | requireAuth | — | tous |
| POST, PUT, DELETE `/api/categories…` | 4764, 4776, 4789 | requireAuth, bC+bT | — | SA, AD, RESP, CT, **DC, AC, CPT** |
| GET `/api/fournisseurs` | 4804 | requireAuth | — | tous |
| POST, PUT, DELETE `/api/fournisseurs…` | 4805, 4817, 4830 | requireAuth, bC+bT | — | SA, AD, RESP, CT, DC, AC, CPT |
| GET `/api/intervenants` | 4195 | requireAuth | `saisieSelonDroits` (4199) : le taux n'est envoyé qu'aux admins | tous |
| POST `/api/intervenants`, PUT `/api/intervenants/:id` | 4205, 4221 | requireAuth, requireAdmin | taux modifiable, **non journalisé** | SA, AD |
| PUT `/api/intervenants/:id/compte` | 4239 | requireAuth, requireAdmin | `refuseSuperAdminTarget` sur l'ancien compte (4256) ; cible obligatoirement TECH actif (4261), reliée à aucune autre fiche (4262) ; journalisé `FICHE_INTERVENANT` (4269, 4276) | SA, AD |
| DELETE `/api/intervenants/:id` | 4295 | requireAuth, requireAdmin | `refuseSuperAdminTarget` sur le compte relié (4319) ; journalisé (4325) | SA, AD |
| GET `/api/commerciaux` | 4164 | requireAuth | actifs de `COMMERCIAL_OR_FILTER` | tous |
| GET `/api/conducteurs` | 4181 | requireAuth | CT actifs | tous |

#### Interventions SAV

| Route | Ligne | Gardes | Règles dans le corps | Types autorisés |
|---|---|---|---|---|
| POST `/api/interventions` | 2576 | requireAuth, blockCommercial, garde en ligne (2577) | client actif (2587) ; chantier du client non annulé (2612) ; **pas de contrôle de périmètre sur le chantier** (roadmap §4:257) | SA, AD, CT |
| GET `/api/interventions` | 2636 | requireAuth, blockCommercial | `getInterventionFilterForUser` (2639) ; `?inclureAnnulees=true` ouvert à tous (2638) | SA, AD, RESP, CT, TECH ; DC, AC et CPT passent mais leur filtre (affectation) est vide (A4.5) |
| GET `/api/interventions/:id/couts` | 2705 | requireAuth, blockCommercial | filtre de périmètre (2662) ; encadrement (`estEncadrementCoutIntervention`, 2658) ou TECH, sinon 403 (2710) ; TECH : ses heures actives sans montant (2714-2720) ; encadrement non admin : sans taux ni totaux de main-d'œuvre (2733) | SA, AD, CT, TECH (RESP : 403 dans son périmètre, 404 au-delà ; DC, AC, CPT : 404, leur filtre étant vide) |
| POST `/api/interventions/:id/couts/heures` | 2738 | requireAuth, blockCommercial | **TECH seulement** (2742) ; intervention de contrat éligible ; fiche affectée (2748) | TECH |
| POST `/api/interventions/:id/couts/achats` | 2764 | requireAuth, blockCommercial | encadrement seulement (2768) | SA, AD, CT |
| PATCH `/api/interventions/:id/couts/:type/:coutId` | 2790 | requireAuth, blockCommercial | heures : TECH seulement, sur sa propre ligne (2796, 2810) ; achats : encadrement (2796) | TECH (heures) ; SA, AD, CT (achats) |
| POST `/api/interventions/:id/couts/:type/:coutId/:action` (archiver, restaurer) | 2836 | requireAuth, blockCommercial | encadrement seulement (2844) | SA, AD, CT |
| GET `/api/interventions/:id/journal-saisies` | 2856 | requireAuth, blockCommercial | périmètre (2858) ; TECH 403 (2860) ; masquage (2862) | SA, AD, RESP, CT |
| POST `/api/interventions/:id/rapports` | 2872 | requireAuth, blockCommercial | intervention EN_COURS dans le périmètre (2876) | tous ceux de la ligne GET, sur leur périmètre |
| POST `/api/interventions/rapports/:rapportId/signature` | 2892 | requireAuth, blockCommercial | rapport d'une intervention du périmètre (2896) | idem |
| PATCH `/api/interventions/:id/statut` | 2913 | requireAuth, blockCommercial | périmètre (2927) ; TECH : EN_COURS ou TERMINEE seulement (2931) | SA, AD, RESP, CT (toute transition permise) ; TECH (démarrer, terminer) |
| GET `/api/planning/interventions-a-planifier` | 2951 | requireAuth, blockCommercial, requirePlanningActif | périmètre (2959) | SA, AD, RESP, CT, TECH (vide en pratique), DC, AC, CPT (vide) |
| PUT `/api/interventions/:id/planning` | 2981 | requireAuth, blockCommercial, blockTechnicien, requirePlanningActif | périmètre (2984, 2991) | SA, AD, RESP, CT |

#### Contrats de maintenance

| Route | Ligne | Gardes | Types autorisés |
|---|---|---|---|
| GET `/api/contrats-maintenance` ; GET `…/:id/journal-saisies` ; POST ; PATCH `…/:id` ; PATCH `…/:id/statut` ; POST `…/:id/avancer-echeance` ; POST `…/:id/generer-intervention` | 2376, 2384, 2395, 2430, 2464, 2493, 2520 | requireAuth, requireAdmin | SA, AD seulement (aucune règle de droits dans le corps) |

#### Planning

| Route | Ligne | Gardes | Règles dans le corps | Types autorisés |
|---|---|---|---|---|
| GET `/api/planning/chantiers` | 4440 | requireAuth, blockCommercial, requirePlanningActif | **tous les chantiers**, annulés compris (nom, client, statut) | SA, AD, RESP, CT, TECH, DC, AC, CPT |
| GET `/api/planning/events` | 4453 | idem | événements sans intervention : tous ; projections d'interventions : périmètre (4459-4461) | idem |
| POST, PATCH, DELETE `/api/planning/events…` | 4471, 4487, 4552 | requireAuth, blockCommercial, blockTechnicien, requirePlanningActif | projection liée : intervention du périmètre (4495, 4524, 4557) ; suppression d'une projection : 409 | SA, AD, RESP, CT, **DC, AC, CPT** |
| GET `/api/planning/types` | 4569 | requireAuth, blockCommercial, requirePlanningActif | — | SA, AD, RESP, CT, TECH, DC, AC, CPT |
| POST, PUT, DELETE `/api/planning/types…` | 4577, 4589, 4603 | requireAuth, blockCommercial, blockTechnicien, requirePlanningActif | — | SA, AD, RESP, CT, DC, AC, CPT |
| GET, POST, PATCH `/api/planning/share` | 4642, 4654, 4682 | requireAuth, requireAdmin, requirePlanningActif | journalisé `PARTAGE_PLANNING` (4666, 4691) | SA, AD |
| GET `/api/planning/public/:token` | 4711 | aucune | jeton actif (4715) ; aucune donnée de gestion | public, avec le lien |

#### Clients et parc d'équipements

| Route | Ligne | Gardes | Règles dans le corps | Types autorisés |
|---|---|---|---|---|
| GET `/api/clients` + v1 | 5825 (gestionnaire 5606) | requireAuth, `requirePermission('clients:read')` ; v1 : `clients:read` | `actif=false` ignoré pour un TECH (5608) ; 200 résultats au plus, contacts et sites inclus | SA, AD, CT, COM, DC, AC, CPT, TECH (+ octroi individuel à RESP ou DIR) |
| GET `/api/clients/:id` + v1 | 5827 (5622) | idem | client désactivé : 404 pour un TECH (5625) | idem |
| POST, PUT, DELETE `/api/clients…`, contacts, sites + v1 | 5826, 5828-5833 | requireAuth, requireAdmin (défaut) ; v1 : `clients:write` | — | SA, AD |
| GET `/api/clients/:clientId/equipements` + v1 | 5834 | requireAuth, requireAdmin ; v1 : `equipements:read` | `equipementPourLecteur` (5797) | SA, AD |
| POST `…/equipements`, POST `…/equipements/:id/archiver` + v1 | 5835, 5836 | requireAuth, requireAdmin ; v1 : `equipements:write` | — | SA, AD |
| GET `/api/clients/:id/chantiers` | 5845 | requireAuth, `requirePermission('clients:read')`, `requirePermission('chantiers:read')` | client désactivé : 404 pour un TECH (5848) ; `perimetreChantiers` (5850) ; aucun montant (5844) ; pas de porte v1 | les porteurs de `clients:read` (`chantiers:read` étant universel) |

#### Catalogue

| Route | Ligne | Gardes | Types autorisés |
|---|---|---|---|
| GET, POST `/api/catalogue/categories` + v1 | 6052, 6053 | requireAuth, requireAdmin ; v1 : `catalogue:read` ou `:write` | SA, AD |
| GET, POST, PUT, DELETE `/api/catalogue/:family…` + v1 | 6054-6057 | requireAuth, requireAdmin ; v1 : `catalogue:read` ou `:write` ; prix d'achat masqué par `ficheCataloguePourLecteur` (5973) | SA, AD |
| GET `/api/devis/catalogue` | 6213 | requireAuth, `requirePermission('devis:write')` | fiches actives, 50 au plus ; prix d'achat seulement si `voitPrixAchatDevis` (6220, 6228) | SA, AD, COM, DC, AC, CPT (+ octroi individuel) |

#### Devis

| Route | Ligne | Gardes | Règles dans le corps | Types autorisés |
|---|---|---|---|---|
| GET `/api/devis` + v1 | 6364 (6306) | `requirePermission('devis:read')` ; v1 : `devis:read` | **tous les devis, sans périmètre** ; prix d'achat masqué (`devisPourLecteur`) | SA, AD, COM, DC, AC, CPT (+ octroi individuel, jamais TECH) |
| POST `/api/devis` + v1 | 6365 (6298) | `devis:write` | prix d'achat écrit par un admin seulement, sinon 403 (`resoudreLignesDevis`, 6180-6182) ; client existant (non contrôlé comme actif) (6300) | idem (écriture) |
| PATCH `/api/devis/:id` + v1 | 6366 (6307) | `devis:write` | refus si signé, converti ou hors BROUILLON/ENVOYE (6313-6315) | idem |
| POST `/api/devis/:id/revisions` + v1 | 6367 (6327) | `devis:write` | — | idem |
| POST `/api/devis/:id/signature` | 6369 (6347) | requireAuth, `devis:write` | session humaine obligatoire (6358-6359) ; `enregistreParId` | SA, AD, COM, DC, AC, CPT |
| PUT `/api/devis/:id/statut` + v1 | 6409 (6391) | `devis:write` | transitions (6375-6382) | idem |
| POST `/api/devis/:id/convertir` + v1 | 6519 (6450) | `devis:write` | champs d'ouverture (`responsableId`, `commercialId`, `types`, `dateDebut`) réservés à une session admin, 403 sinon (6454-6456) | idem ; titulaire et commercial choisis par SA ou AD seulement |
| GET `/api/devis/a-convertir` | 6526 | `devis:read` + `devis:write` | pas de porte v1 | SA, AD, COM, DC, AC, CPT |
| POST `/api/devis/:id/acompte` | 6552 | requireAuth, requireAdmin | `acompteConstateParId` (6572) | SA, AD |
| POST `/api/devis/:id/annulation` | 6592 | requireAuth, requireAdmin | `annuleParId` (6622, 6629) | SA, AD |
| POST `/api/devis/:id/duplication` | 6645 | requireAuth, `devis:write` | — | SA, AD, COM, DC, AC, CPT |

#### Factures et avoirs

| Route | Ligne | Gardes | Types autorisés |
|---|---|---|---|
| GET `/api/factures/chronologie`, GET `/api/factures/a-regler`, GET `/api/factures`, GET `/api/factures/:id/document.pdf`, GET `…/:id/journal`, GET `…/:id/tracabilite`, POST `/api/factures`, POST `…/:id/emettre`, POST `…/:id/regler` (410), POST `…/:id/annuler`, POST `…/:id/avoirs` | 1322, 1331, 1342, 1370, 1385, 1394, 1415, 2051, 2093, 2099, 2157 | requireAuth, requireAdmin | SA, AD (COMPTABLE exclu) |

#### Règlements

| Route | Ligne | Gardes | Types autorisés |
|---|---|---|---|
| GET `/api/reglements`, POST `/api/reglements`, POST `…/:id/contrepasser` | 2227, 2255, 2338 | requireAuth, requireAdmin | SA, AD (COMPTABLE exclu, conformément à MDC:62) |

#### Comptabilité, mentions légales, prêt à facturer

| Route | Ligne | Gardes | Types autorisés |
|---|---|---|---|
| GET `/api/facturation/prete-a-facturer` | 1485 | requireAuth, requireAdmin | SA, AD |
| GET `/api/comptabilite` ; POST `…/comptes` ; PATCH `…/comptes/:id` ; GET `…/comptes/:id/journal` ; PATCH `…/comptes/:id/activation` ; POST `…/importer` ; GET `…/regles/journal` ; PUT et DELETE `…/regles/:cle` ; PUT et DELETE `…/tva/:taux` | 1514, 1521, 1573, 1605, 1612, 1710, 1775, 1782, 1827, 1883, 1855 | requireAuth, requireAdmin | SA, AD |
| GET `/api/factures/export-comptable.csv` | 1986 | requireAuth, requireAdmin | SA, AD |
| POST `/api/mentions-legales/:version/publier` ; POST et GET `/api/mentions-legales` | 2018, 2033, 2044 | requireAuth, requireAdmin ; **sans auteur enregistré** (2018-2042) | SA, AD |

#### Utilisateurs

| Route | Ligne | Gardes | Règles dans le corps | Types autorisés |
|---|---|---|---|---|
| GET `/api/users` | 3674 | requireAuth, requireAdmin | les SA sont retirés de la liste d'un AD (3680-3682) ; un responsable hiérarchique SA est masqué (3697) | SA, AD |
| POST `/api/users` | 3773 | requireAuth, requireAdmin | création d'un SA par un SA seulement (3778) ; `accesFinance` posé par un SA seulement (3788), jamais pour un TECH (3789) ; journal `CREATION` (3808) | SA, AD |
| DELETE `/api/users/:id` | 3823 | requireAuth, requireAdmin | pas soi-même (3826) ; `refuseSuperAdminTarget` (3833) ; dernier SA (3837) ; refus si le compte est auteur de données tracées (3842-3860) ; journal `SUPPRESSION` et `RATTACHEMENT` (3891, 3900) | SA, AD |
| PATCH `/api/users/:id/role` | 3916 | requireAuth, requireAdmin | type valide (3919) ; `refuseSuperAdminTarget`, cible et nouveau rôle (3928) ; dernier SA (3932) ; `estCommercial` retiré hors admin (3949) ; fiche intervenant déliée (3953) ; journal `TYPE_COMPTE` (3952) ; **pas de refus pour son propre compte** | SA, AD |
| PATCH `/api/users/:id/responsable-hierarchique` | 3970 | requireAuth, requireAdmin | `refuseSuperAdminTarget` (3985) ; ni soi-même (3989), ni compte inconnu, désactivé, ou SA pour un AD (3993), ni boucle (3996) ; journal `RATTACHEMENT` (4007) | SA, AD |
| PATCH `/api/users/:id/est-commercial` | 4026 | requireAuth, requireAdmin | cible admin seulement (4032) ; `refuseSuperAdminTarget` (4035) ; journal (4046) | SA, AD |
| PUT `/api/users/:id/permissions` | 4057 | requireAuth, requireSuperAdmin | A2.3 | SA |
| PATCH `/api/users/:id/acces-finance` | 4089 | requireAuth, requireSuperAdmin | A2.4 | SA |
| PATCH `/api/users/:id/actif` | 4120 | requireAuth, requireAdmin | `refuseSuperAdminTarget` (4127) ; pas de désactivation de soi (4134) ; dernier SA (4137) ; journal (4147) | SA, AD |

#### Paramètres, société, modules, rémunération, clés

| Route | Ligne | Gardes | Types autorisés |
|---|---|---|---|
| GET `/api/parametres` | 5435 | requireAuth, requireAdmin | SA, AD |
| PUT `/api/parametres` (marge, acompte, alertes, destinataires de la rentabilité) | 6788 | requireAuth, requireAdmin ; journal `PARAMETRES` (6852) ; `planningActif` exclu (6785-6787) | SA, AD |
| GET `/api/modules` | 6866 | requireAuth ; `planningActif` effectif (vrai pour un SA) (6869-6874) | tous |
| PUT `/api/modules` | 6882 | requireAuth, requireSuperAdmin ; journal `MODULES` (6894) | SA |
| GET `/api/company` | 6665 | requireAuth | tous |
| PUT `/api/company` | 6673 | requireAuth, requireSuperAdmin ; journal `SOCIETE` (6685) | SA |
| GET `/api/parametres/remuneration` | 6700 | requireAuth, requireAdmin | SA, AD |
| PUT `/api/parametres/remuneration` | 6748 | requireAuth, requireSuperAdmin ; journal `REMUNERATION` (6774) | SA |
| PUT `/api/commerciaux/:id/prime-mensuelle` | 5397 | requireAuth, requireAdmin ; cible `isCommercialLike` (5404) ; journal `PRIME_COMMERCIAL` (5421) | SA, AD |
| GET `/api/registry/companies` | 5447 | requireAuth, requireAdmin | SA, AD |
| Clés API (4 routes) | 5488-5554 | requireAuth, requireSuperAdmin | SA |
| GET `/api/v1/company` | 5558 | `requireApiKey('company:read')` | clé |

#### Journal des paramètres et des droits

| Route | Ligne | Gardes | Règles dans le corps | Types autorisés |
|---|---|---|---|---|
| GET `/api/journal-administration` | 6956 | requireAuth, requireAdmin | `entreesVisiblesJournal` (6912-6914) : un AD ne voit que les entrées où `concerneSuperAdmin` et `reserveSuperAdmin` sont faux ; purge à chaque lecture (6958) | SA (tout), AD (filtré) |
| GET `/api/journal-administration/export.csv` | 6993 | requireAuth, requireAdmin | même filtre | idem |
| PUT `/api/journal-administration/conservation` | 7020 | requireAuth, requireSuperAdmin | 1 à 90 jours ; journalisé (7032) | SA |

#### Statistiques et commissions

| Route | Ligne | Gardes | Règles dans le corps | Types autorisés |
|---|---|---|---|---|
| GET `/api/stats/global` | 7047 | requireAuth | `perimetreChantiers` (7059) ; `nbTerminesNonEncaisses` aux admins (7096) ; `achatsTotal` si ni COM ni TECH (7102) ; `heuresTotal` si ni admin ni COM (7108) ; CA, marge et commissions de tous les commerciaux aux admins (7114-7132) ; marge et commission personnelles au COM (7133-7139) | **tous** (contenu variable) |
| GET `/api/stats/conducteurs` | 7157 | requireAuth, requireTravauxRead | admin ou RESP seulement, sinon 403 (7161) ; RESP : CT de sa branche (7163) ; CA et marge selon `voitRentabilite` (7203-7210) ; dépenses et manque à gagner aux admins seulement (7243-7244) | SA, AD, RESP (CT : 403) |
| GET `/api/stats/conducteurs/assiduite` | 7317 | requireAuth, requireTravauxRead | admin ou RESP (7320) ; RESP : sa branche (7324) | SA, AD, RESP |
| GET `/api/stats/chantiers-repartition` | 7403 | requireAuth, requireAdmin | — | SA, AD |
| GET `/api/stats/intervenants` | 7474 | requireAuth, requireTravauxRead | `perimetreChantiers` (7482) ; coût aux admins seulement (7496-7498) | SA, AD, RESP, CT |
| GET `/api/stats/fournisseurs` | 7516 | requireAuth, requireTravauxRead | **sans périmètre** : montants d'achats de toute la société (7513-7526) | SA, AD, RESP, CT |
| GET `/api/stats/types-chantiers` | 7556 | requireAuth, requireTravauxRead | `perimetreChantiers` (7571) | SA, AD, RESP, CT |
| GET `/api/stats/commerciaux` | 7798 | requireAuth | admin ou COM seulement, sinon 403 (7802-7804) ; admin : tous les `COMMERCIAL_OR_FILTER` ; COM : lui-même (7815) ; détail par chantier avec `margeCommerciale` (7868) | SA, AD, COM (DC, AC : 403) |

## A4. Périmètres de lecture et d'écriture (« qui voit quoi »)

### A4.1 Liste des chantiers : `perimetreDemandeur` et `perimetreChantiers`

`server/index.ts:385-398` :

| Demandeur | Filtre |
|---|---|
| clé d'intégration | `{}` (392) |
| SA, AD, DIR | `{}` (394) |
| COM (littéral `'COMMERCIAL'`) | `commercialId = moi` (395) |
| RESP | `responsableId ∈ [moi, …equipeIds]` (396) |
| **tous les autres** : CT, TECH, **DC, AC, CPT** | `responsableId = moi` (397) |

`perimetreChantiers` (387-389) ajoute `statut ≠ ANNULE` pour tout le monde, administrateurs compris (`AFFAIRE_NON_ANNULEE`, 385). Elle sert à la liste (3286), au journal d'un chantier (3372), aux achats (5065), aux heures (5220), à l'historique d'un client (5850) et aux statistiques (7059, 7165, 7482, 7571). Conséquence : le journal des saisies d'une affaire annulée est fermé à tous, administrateurs compris, alors que sa fiche reste lisible (A4.2).

### A4.2 Fiche d'un chantier (`GET /api/chantiers/:id`) : règle propre, `server/index.ts:3332-3339`

Lecture admise pour un admin, ou si `isOwner` : compte DIR, **ou `commercialId = moi` (tout rôle), ou `responsableId = moi` (tout rôle)**, ou RESP dont la branche contient le titulaire. Pas de filtre sur `ANNULE` : la fiche d'une affaire annulée reste lisible. Écart interne : un COM titulaire d'un chantier voit sa fiche, mais pas ce chantier dans sa liste (395).

### A4.3 Branche hiérarchique : `brancheHierarchique` et `equipeIds`

- `brancheHierarchique` (`server/index.ts:148-157`) : CTE récursive sur `responsableHierarchiqueId` ; elle inclut les collaborateurs inactifs et exclut le compte lui-même.
- Elle n'est calculée **que pour un RESP** (190). Pour tout autre type, `equipeIds = []`, ce qui correspond à MDC:52. **Aucune notion d'équipe pour DC** (ÉCART avec MDC:32).
- Usages : 396, 443, 545, 3041, 3336, 4865, 7163, 7324.

### A4.4 Écriture Travaux : `assertChantierWritable` (`server/index.ts:4854-4882`)

Écriture admise pour un admin, un **CT titulaire** (`role === 'CONDUCTEUR_TRAVAUX'`, 4862) ou un **RESP** titulaire ou dont la branche contient le titulaire (4863-4865). Hors périmètre : 404. Affaire annulée : 409 pour tous (4873). Hors admin, un chantier qui n'est pas EN_COURS reçoit 403 (4877). Elle s'ajoute à `requireTravauxWrite` ou `requireTravauxArchive`. Un TECH, un DIR, un COM, un DC, un AC ou un CPT titulaire n'y entre jamais, même avec la permission.

### A4.5 Interventions SAV : `getInterventionFilterForUser` (`server/index.ts:3030-3045`)

| Demandeur | Filtre |
|---|---|
| `'SUPERADMIN'`, `'ADMIN'` (littéraux, et non `isAdminRole`) | `{}` (3031) |
| CT | affecté (fiche reliée) **ou** créateur (`createdById`) **ou** titulaire du chantier lié non annulé (3036) |
| RESP | affecté **ou** chantier lié dont le titulaire est lui ou un membre de sa branche, non annulé (3039-3042) |
| tous les autres (TECH, DC, AC, CPT) | affecté, c'est-à-dire `affectations.some.intervenant.userId = moi` (3044) |

La fiche intervenant ne se relie qu'à un TECH actif (4261), et un compte qui quitte le type TECH perd la sienne (`delierFicheSiPlusTechnicien`, 3734-3749). Pour DC, AC et CPT, le filtre est donc vide en pratique. Ce filtre est réutilisé par les coûts (2662), le journal (2858), les rapports (2876), les signatures (2896), le statut (2927), la file (2959), le placement (2984, 2991) et le planning (4460, 4495, 4524, 4557).

### A4.6 Modification de la fiche, du commercial et clôture

- `PATCH /api/chantiers/:id` (3411) et `PATCH /api/chantiers/:id/commercial` (3649) : admin ou `responsableId = moi`, **sans condition de rôle** au-delà de `blockCommercial` (COM et DIR exclus) et du refus explicite du TECH. Champs ouverts à un non-admin (3430-3432, 3481-3499) : `nom`, `numeroDevis`, `responsableId` (le titulaire peut **confier** son chantier à tout compte actif : `refusTitulaire` ne vérifie que `actif`, 3263-3267), budgets matériel et main-d'œuvre, `heuresVendues`, dates, `adresse`, `types`, **`baremeReduit`** (barème de commission). `budgetGlobalVendu` ne passe que si `voitRentabilite` (3478). `statut` et `clientId` sont réservés aux admins. **Réattributions du titulaire et du commercial non journalisées** (seul le changement de client l'est, 3540).
- `peutCloturerChantier` (539-546) : un admin ou un DIR, toujours ; jamais un COM ni un TECH (542) ; le titulaire (543) ; un RESP pour le chantier d'un **TECH** de sa branche (544-545). Le résultat est envoyé au client sous la forme `peutCloturer` (`avecDroitDeCloture`, 3240-3249) et appliqué par `PATCH /statut` (3599-3601). La réouverture est réservée aux admins (3613-3615).

### A4.7 Filtres « commercial »

- Chantiers : `commercialId` (395) pour le seul COM littéral. Un admin `estCommercial` voit tout ; DC, AC et CPT ne sont pas « commerciaux » au sens du code (`isCommercialLike`, 618).
- Commissions : `computeCommissionsParCommercial(commercialIds…)` (7723-7784), affaires non annulées (7728) et encaissées.
- Devis : **aucun périmètre**. Le modèle `Devis` n'a ni commercial ni auteur de création (`schema.prisma:458-510`).
- Clients : **aucun périmètre**, tous les porteurs de `clients:read` voient tous les clients (5606-5620).

### A4.8 Directeur et technicien

- DIR : périmètre global (394), fiche de tout chantier, y compris annulé (3333).
- TECH : chantiers dont il est titulaire (397) ; interventions par sa fiche intervenant (3044) ; annuaire des clients actifs (5602-5604).

### A4.9 Données lisibles sans périmètre

`GET /api/planning/chantiers` (tous les chantiers, 4440-4450), `GET /api/stats/fournisseurs` (montants globaux, 7516), `GET /api/intervenants` (noms, fonctions, comptes reliés, 4195), `GET /api/categories`, `GET /api/fournisseurs`, `GET /api/commerciaux`, `GET /api/conducteurs`, `GET /api/company`, `GET /api/modules`, ainsi que la liste de tous les devis et de tous les clients pour leurs porteurs.

## A5. Visibilité des montants

| Fonction | Référence | Règle (code) | Appliquée à |
|---|---|---|---|
| `voitRentabilite(req, chantier, params)` | 433-445 | Clé : `finances:read`. Admin : oui. DIR : `rentabiliteDirecteurs`. Titulaire CT ou RESP : `rentabiliteConducteur`. RESP dont la branche contient le titulaire : `rentabiliteHierarchie`. Personne d'autre. | Liste (3296), fiche (3344), réponses d'écriture (`chantierSelonRentabilite`, 551-554), écriture de `budgetGlobalVendu` (3478), statistiques des conducteurs (7203) |
| `computeChantierMetrics(..., canSeeMarge)` | 929-1030 | Sans `canSeeMarge` ou sans marge commerciale active : marges et estimation nulles (972-974). `EN_PERTE` (987) et `MARGE_FAIBLE` (1026) ne sortent que pour qui voit la marge. | Toutes les sérialisations de chantier |
| `serializeChantier` | 1039-1048 | `budgetGlobalVendu` mis à null hors rentabilité (1043) ; facturation de la fiche seulement si `canSeeMarge` (3350-3359) | Liste, fiche |
| `voitMontantsChantier` | 452-455 | Clé : oui ; sinon tout sauf TECH | 1046, 3298, 3349, 5074, 7102 |
| `chantierSansMontants` | 516-529 | TECH : budgets matériel et main-d'œuvre, achats et pointages sans montants, `materielReel`, `moReel`, `totalDepenses`, `pctMateriel`, `pctMainOeuvre` à null, alertes de dépassement retirées (`ALERTES_DEPASSEMENT`, 457) | `serializeChantier` (1046) |
| `sansMontantsSaisie` | 460-468 | Retire `montantHT`, `tauxHoraireApplique` et `tauxHoraireCharge`, y compris sur l'intervenant joint | `saisieSelonDroits`, achats (5074), `chantierSansMontants` |
| `voitCoutMainOeuvre` | 475-478 | Clé : oui (`chantiers:read`) ; sinon admins seulement | 1047, 2733, 3300, 3349, 7496 |
| `sansTauxHoraire` | 480-488 | Retire `tauxHoraireApplique` et `tauxHoraireCharge` | `saisieSelonDroits`, `chantierSansCoutMainOeuvre`, 2733 |
| `saisieSelonDroits(req)` | 492-496 | TECH : `sansMontantsSaisie` ; non-admin : `sansTauxHoraire` ; admin ou clé : intact | Heures (5228, 5263, 5316, 5370), intervenants (4199), journaux du chantier (3381) et du SAV (2862), archivage des coûts SAV (2850) |
| `chantierSansCoutMainOeuvre` | 501-512 | Non-admin : `moReel`, `totalDepenses`, `pctMainOeuvre`, `estimation.coutEstime`, `coutMainOeuvreAttendu` et `coutHoraireReference` à null ; marges et alertes conservées | `serializeChantier` (1047) |
| `CHANTIER_LITE_SELECT`, `CHANTIER_INTERVENTION_SELECT`, `chantierDuJournalReduit` | 405, 408, 411-417 | Chantier joint à un achat, un pointage ou une intervention : jamais de montant vendu | 5067, 5222, 2531 et suivantes, 2863 |
| Statistiques des conducteurs | 7203-7247 | CA si `voitRentabilite` ; marge si de plus la marge commerciale est active ; `depensesTotal` et `manqueAGagnerMainOeuvre` aux admins seulement | — |
| `GET /api/stats/global` | 7096-7139 | `achatsTotal` si ni COM ni TECH ; CA, marge et commissions de la société aux admins ; marge et commission propres au COM | — |
| `GET /api/stats/commerciaux` | 7836-7872 | `budgetGlobalVendu` et `margeCommerciale` **par chantier** pour le COM, sans passer par `voitRentabilite` | MDC:54 et roadmap §3 le signalent |
| Coûts SAV | 2705-2734 | TECH : heures sans montant ; CT : sans taux ni total de main-d'œuvre ; admin : complet | — |
| `voitPrixAchatDevis` | 6148-6152 | Clé : `finances:read` ; session : admin | `devisPourLecteur` (6157-6164), `ficheCataloguePourLecteur` (5973-5981), `equipementPourLecteur` (5730-5738), `GET /api/devis/catalogue` (6220-6228) |
| `ecritPrixAchatDevis` | 6153-6155 | Session admin seulement ; 403 si un autre envoie `prixAchatUnitaireHt` (6180-6182) | Création et modification de devis |
| `Parametres` (`rentabiliteConducteur`, `rentabiliteHierarchie`, `rentabiliteDirecteurs`, `margeCommercialeActive`) | interface 702-706 ; écriture 6836-6842 (booléens stricts, `requireAdmin`) | Destinataires de la rentabilité | — |

## A6. Règles inscrites dans le corps des gestionnaires (hors gardes)

Relevé systématique des motifs `role ===`, `role !==`, `isAdminRole(`, `isSuperAdminRole(`, `ROLE_`, `hasUserPermission(`, `refuseSuperAdminTarget` et `isLastSuperAdmin`, ainsi que des comparaisons d'identité (`=== authUser.id`). Les définitions de fonctions de la section A5 ne sont pas répétées.

| Ligne | Fonction ou route | Règle |
|---|---|---|
| 190 | `requireAuth` | `equipeIds` calculé pour le seul RESP |
| 249-250 | `permissionsEffectives` | SA : tous les scopes ; TECH : droits interdits retirés |
| 394-397 | `perimetreDemandeur` | admin, DIR, COM, RESP, autres (A4.1) |
| 438-443 | `voitRentabilite` | admin, DIR, titulaire CT ou RESP, branche RESP |
| 454 | `voitMontantsChantier` | `role !== TECHNICIEN` |
| 477 | `voitCoutMainOeuvre` | `isAdminRole` |
| 541-545 | `peutCloturerChantier` | admin et DIR ; COM et TECH jamais ; titulaire ; RESP et TECH de sa branche |
| 567-568 | `peutVoirFinance` | jamais TECH ; SA ou `accesFinance` (non utilisée) |
| 579 | `requireTravauxRead` | admin, RESP, CT |
| 590, 594 | `blockCommercial` | COM et DIR refusés |
| 605 | `blockTechnicien` | TECH refusé |
| 619 | `isCommercialLike` | COM, ou admin `estCommercial` |
| 635 | `requirePlanningActif` | SA dispensé |
| 2577 | POST `/api/interventions` | admin ou CT |
| 2658, 2709-2710 | `estEncadrementCoutIntervention`, GET coûts | encadrement = admin ou CT ; sinon TECH seulement |
| 2733 | GET coûts | sans taux hors admin (`voitCoutMainOeuvre`) |
| 2742 | POST coûts/heures | TECH seulement |
| 2768 | POST coûts/achats | encadrement |
| 2796, 2810 | PATCH coûts | heures : TECH, sa ligne ; achats : encadrement |
| 2844 | archiver ou restaurer un coût | encadrement |
| 2860 | journal SAV | TECH refusé |
| 2931 | statut d'une intervention | TECH : EN_COURS ou TERMINEE |
| 3031-3044 | `getInterventionFilterForUser` | A4.5 |
| 3179 | secours | compte SA actif seulement |
| 3247 | `avecDroitDeCloture` | `peutCloturer` pour les sessions seulement |
| 3270-3273 | `refusCommercial` | commercial `isCommercialLike` et actif (sauf l'actuel) ; obligatoire s'il existe au moins un commercial, **actifs et inactifs confondus** (3270 ; roadmap §4:299) |
| 3316, 3332-3338 | GET chantier | admin ou `isOwner` |
| 3411 | PATCH chantier | admin ou titulaire |
| 3416 | PATCH chantier | TECH 403 |
| 3430-3432 | PATCH chantier | champs admin et non-admin |
| 3447 | PATCH chantier | changement de client réservé à l'admin |
| 3478 | PATCH chantier | `budgetGlobalVendu` réservé aux destinataires de la rentabilité |
| 3581 | `blockCommercialSeulement` | COM refusé |
| 3591, 3599-3601 | PATCH statut | admin, titulaire ou `peutCloturerChantier` |
| 3604 | PATCH statut | TECH 403 |
| 3613 | PATCH statut | non-admin : EN_COURS → TERMINE seulement |
| 3642, 3649 | PATCH commercial | admin ou titulaire |
| 3652 | PATCH commercial | TECH 403 |
| 3680-3682, 3697 | GET users | les SA sont invisibles d'un AD |
| 3714-3718 | `refuseSuperAdminTarget` | une cible SA n'est gérable que par un SA. Appels : 3778, 3833, 3928 (deux fois), 3985, 4035, 4127, 4256, 4319 |
| 3735 | `delierFicheSiPlusTechnicien` | le compte quitte le type TECH : sa fiche est déliée |
| 3762 | `journaliserDroitsCompte` | `concerneSuperAdmin` si SA avant ou après |
| 3766-3771 | `isLastSuperAdmin` | `count(role = SUPERADMIN) ≤ 1`. **Les SA inactifs sont comptés** et le contrôle est fait **hors transaction**. Appels : 3837, 3932, 4137 |
| 3785 | POST users | `estCommercial` pour un admin seulement |
| 3788-3789 | POST users | `accesFinance` posé par un SA seulement, jamais pour un TECH |
| 3826 | DELETE user | pas soi-même |
| 3932 | PATCH role | dernier SA |
| 3949 | PATCH role | `estCommercial` à faux hors admin |
| 3972, 3993 | PATCH responsable | un AD ne peut pas choisir un SA comme responsable |
| 4032 | PATCH est-commercial | cible admin |
| 4069-4074 | PUT permissions | TECH : aucun nouvel octroi interdit |
| 4095 | PATCH acces-finance | TECH refusé |
| 4134, 4137 | PATCH actif | pas soi-même ; dernier SA |
| 4184 | GET conducteurs | `role = CONDUCTEUR_TRAVAUX` |
| 4261 | PUT intervenant/compte | cible TECH active |
| 4862-4865 | `assertChantierWritable` | A4.4 |
| 4978 | `journaliserAdministration` | `auteurSuperAdmin` enregistré (non utilisé par le filtre) |
| 5404 | prime mensuelle | `isCommercialLike` |
| 5603 | `clientsActifsSeulement` | TECH en session |
| 6151, 6154 | `voitPrixAchatDevis`, `ecritPrixAchatDevis` | admin |
| 6454 | conversion | champs d'ouverture : session admin |
| 6869 | GET modules | SA : planning toujours effectif |
| 6913 | `entreesVisiblesJournal` | SA : tout ; sinon filtre |
| 7050-7051 | stats/global | `isAdmin`, `isCommercial` (littéral `'COMMERCIAL'` : un admin `estCommercial` n'est pas « commercial » ici) |
| 7160-7163 | stats/conducteurs | admin ou RESP ; RESP : sa branche |
| 7320-7324 | assiduité | idem |
| 7801-7802, 7815 | stats/commerciaux | admin ou COM |
| 7929-7934 | `ensureSuperAdmins` | promotion des adresses de `SUPERADMIN_EMAILS`, journalisée sans auteur |

## A7. Invariants

### A7.1 Séparation entre ADMIN et SUPERADMIN

- Les SA disposent de tous les droits d'admin (`isAdminRole`, 265). Leur sont réservés : les permissions individuelles (4057), l'accès financier (4089), les clés API (5488-5554), l'identité de la société en écriture (6673), la rémunération en écriture (6748), les modules (6882), la conservation du journal (7020), la gestion des comptes SA (`refuseSuperAdminTarget`, 3714) et le planning quand il est désactivé (635, 6874).
- Un AD ne voit pas les SA dans `GET /api/users` (3680-3682), ni comme responsable hiérarchique (3697), ni dans le choix d'un responsable (3993). Il ne peut ni promouvoir, ni rétrograder, ni désactiver, ni supprimer un SA, ni toucher à la fiche intervenant d'un SA (4256, 4319).
- Un AD peut créer, promouvoir, rétrograder et désactiver d'autres AD : aucune protection entre administrateurs (constat).

### A7.2 Dernier super administrateur

`isLastSuperAdmin` (3766-3771) protège la suppression (3837), la rétrogradation (3932) et la désactivation (4137). **Constats du code** : (1) le décompte inclut les SA désactivés, si bien qu'un SA actif peut être désactivé ou rétrogradé tant qu'un SA **inactif** existe ; l'accès de secours exige un SA actif (3179) et `ensureSuperAdmins` ne réactive pas un compte (7928-7938). (2) Le contrôle a lieu hors de la transaction d'écriture : deux rétrogradations simultanées ne sont pas sérialisées. **À vérifier** par un test.

### A7.3 Journal des paramètres et des droits (`JournalAdministration`)

- Écriture : `journaliserAdministration` (4962-4981), dans la même transaction que le changement. `journaliserDroitsCompte` (3757-3764) ne garde que les champs modifiés (`changementsJournal`, 4985-4997).
- Entrées existantes. Droits : `CREATION` (3808, 7948), `SUPPRESSION` et `RATTACHEMENT` (3891, 3900), `TYPE_COMPTE` (3952, 7933), `RATTACHEMENT` (4007), `AUSSI_COMMERCIAL` (4046), `PERMISSIONS` (4078), `ACCES_FINANCE` (4105), `ACTIVATION` et `DESACTIVATION` (4147), `FICHE_INTERVENANT` (3743, 4269, 4276, 4325). Réglages : `PARTAGE_PLANNING` (4666, 4691), `PRIME_COMMERCIAL` (5421), `CLE_INTEGRATION` (5519, 5542), `SOCIETE` (6685), `REMUNERATION` (6774), `PARAMETRES` (6852), `MODULES` (6894), `CONSERVATION_JOURNAL` (7032).
- Visibilité : `concerneSuperAdmin` (le compte concerné, ou son responsable, est SA avant ou après) et `reserveSuperAdmin` (clés) ferment l'entrée à un AD (6912-6914). `auteurSuperAdmin` est enregistré (4978) **sans servir de filtre**, ce que la roadmap §4:284 classe « à appliquer ». Une entrée n'est pas fermée si le compte est devenu SA depuis (roadmap §4:285, « à appliquer »).
- Conservation : 1 à 90 jours, 90 par défaut ; purge au démarrage (7971) et à chaque consultation (6958, 6995).
- Triggers : `journal_administration_horodatage`, `journal_administration_ajout_seul` (modification interdite ; suppression permise seulement au-delà de la durée de conservation), `journal_administration_sans_vidage` (`server/prisma/migrations/20261015120000_journal_administration/migration.sql:35-68`).
- **Non journalisés** (code) : création et publication des mentions légales (2018-2042), création d'un compte comptable (1521-1529), taux horaire d'un intervenant (4205-4232), réattribution du titulaire ou du commercial d'un chantier (3470-3475, 3660-3664), encaissement (5380-5391), création, modification, statut, conversion et duplication d'un devis (aucun auteur ; seuls la signature 6360, l'acompte 6572 et l'annulation 6622/6629 en gardent un). La roadmap §4:282-286 traite les quatre premiers points.

### A7.4 Autres traces métier

`journaliserSaisieTravaux` (5014-5032), `journaliserIntervention` (1051-1060), `journaliserContrat` (1062-1072), `journaliserCoutIntervention` (2688-2693) écrivent dans `JournalSaisieChantier`. `JournalFacture` reçoit création du brouillon, émission, annulation, avoirs et règlements (1471, 2073, 2136-2137, 2210, 2324, 2360, 1303). **Aucun trigger « ajout seul » n'a été trouvé** pour `JournalSaisieChantier`, `JournalFacture`, `InterventionRapport` ou `InterventionSignature` dans les migrations : la règle « append-only » (commentaires 2854, 2870, 3366) ne tient que par l'absence de route d'écriture. Le journal des comptes comptables (`journal_compte_append_only`, `20260925120000…:27`) et celui des règles (`journal_regle_append_only`, `20261009120000…:40`) en ont un.

### A7.5 Modules activables

`Parametres.planningActif` : écriture par un SA seulement (`PUT /api/modules`, 6882), jamais par `PUT /api/parametres` (6785-6787). Application côté serveur par `requirePlanningActif` sur toutes les routes `/api/planning/*` authentifiées et sur `PUT /api/interventions/:id/planning` (2951, 2981, 4440-4703). Le lien public a son propre interrupteur (4715).

### A7.6 Documents d'argent et données figés (triggers SQL)

| Objet | Trigger (migration:ligne) | Règle |
|---|---|---|
| Facture émise | `Facture_immutabilite_origine_emise` (`20260909170000…:17`), fonction dans sa dernière version `20260914160000_add_avoirs_partiels:25-43` | Origine, rattachements, motif, raison sociale, adresse, type, facture d'origine et indicateur d'annulation figés dès `EMISE`, `REGLEE` ou `ANNULEE` |
| Facture émise | `facture_identite_figee` (`20261016120000_reglements:186-206`) | Client, numéro, année, type, dates et totaux HT, TVA et TTC figés hors brouillon |
| Ventilation TVA | `FactureVentilationTva_immutabilite_emise` (`20260921120000…:27-44`) | Ni modification ni suppression une fois la facture émise |
| Écritures comptables | `ecriture_facture_immutable`, `ecriture_facture_insert`, `facture_ecritures_scellement`, `facture_equilibre_ecritures`, `ecriture_facture_equilibre`, `ecriture_facture_equilibre_immediat` (`20261007140000…:32-94`) | Écritures figées et scellées ; équilibre vérifié en différé |
| Règlements | `reglement_immuable`, `affectation_reglement_immuable`, `affectation_reglement_controle`, `reglement_entierement_affecte`, `affectation_reglement_total`, `facture_statut_reglements` (`20261016120000_reglements:66-182`) ; `affectation_statut_facture`, `reglement_statut_factures`, `facture_statut_reglement_differe` (`20261017090000…:9-49`) | Seule transition ENREGISTRE → CONTREPASSE ; affectation figée ; statut « réglée » déduit ; pas d'annulation d'une facture réglée |
| Mentions légales | `MentionsLegalesVersion_immutabilite_publiee` (`20260909150000…:17`), fonction remplacée par `20261010120000…:2-17` | Version publiée immuable, `publieeLe` compris |
| Devis signé | `devis_ligne_figee_si_signe`, `devis_contenu_fige_si_signe`, `devis_signature_figee`, et trois `…_sans_vidage` (`20261017120000_catalogue_devis:29-90`) | Lignes, contenu, montants et acompte exigé figés ; signature ni modifiable ni supprimable ; pas de `TRUNCATE` |
| Comptes et règles comptables | `compte_code_immutable`, `compte_version_monotone`, `compte_modification_journal` (`20261009100000…`) ; famille `journal_regle_*` et `transition_regle_*` (`20261009120000…`) | Code immuable ; toute modification exige un journal motivé dans la transaction |
| Saisies Travaux | `AchatReel_prevent_created_by_change`, `PointageHeure_prevent_created_by_change` (`20260923110000…:19-33`) | `createdById` immuable |
| Coûts SAV | `CoutIntervention*_immutable_fields`, `CoutInterventionHeure_taux_immutable` (`20260924120000…:57-82`) | Champs et taux appliqué immuables |
| Contrat et intervention | `Intervention_couvertureContrat_immutable` (`20260925100000…:58-69`), `ContratMaintenance_dateDebut_immutable`, `ContratMaintenance_client_rattache_immutable`, `Intervention_dateDemande_contrat` (`20261007130000…`) | Couverture, date de début, client et date de demande figés |

**Constats** : `Facture.mentionsLegalesVersionId`, qui fixe les mentions imprimées, n'est figé par aucun trigger (#180). Aucun trigger ne fige `FactureLigne` (`grep FactureLigne` dans les migrations : seulement la clé primaire, `20260908160000_add_factures:33`). Aucun trigger `DELETE` ne porte sur `Facture` ; la suppression d'une facture émise n'est empêchée que par la clé étrangère `RESTRICT` d'`EcritureFacture` (`20261007140000…:28`). L'API n'expose aucune route de modification ou de suppression d'une facture. Pour un devis, le figement repose sur la signature (MDC:61) ; la roadmap §3 pose la question d'un figement dès l'envoi.

## A8. Exceptions et cas particuliers par type de compte

- **TECH, client désactivé sur ses interventions** : `GET /api/interventions` renvoie `client`, `site` et `contact` sans filtre sur `actif` (2647). La fiche et l'historique du client lui répondent 404 (5625, 5848), et le filtre `actif=false` de la liste est ignoré pour lui (5608). Cela correspond à MDC:46 et à la roadmap §4:278.
- **TECH, données gardées** : heures vendues et réalisées, alerte `SANS_SAISIE` (`chantierSansMontants` ne filtre que `ALERTES_DEPASSEMENT`, 526) ; journal des saisies du chantier sans montants (3381) ; aucun droit devis ni finance, même individuellement (243, 250, 4069, 4095, 3789) ; refus explicites (531-533) ; planning en lecture (604-610) ; heures SAV saisies sur ses seules interventions de contrat éligibles (2742-2757).
- **DIR** : lit tout, y compris la fiche d'une affaire annulée (3333) ; clôture tout chantier EN_COURS (541, garde `blockCommercialSeulement`) ; rentabilité selon `rentabiliteDirecteurs` (439) ; aucune saisie, même avec la permission (4862-4866) ; exclu du planning, du SAV et des référentiels par `blockCommercial` (594) ; pas de statistiques Travaux (577), mais un tableau de bord ouvert (7047, avec `achatsTotal` et `heuresTotal` sur toute la société) ; lit aussi `GET /api/achats` et `GET /api/heures` de toute la société, avec montants et sans taux (5236-5237), routes que l'interface ne lui propose pas.
- **COM** : chantiers par `commercialId` (395) ; pas de rentabilité, mais budgets par poste et coûts (sans taux) sur la fiche, donc vendu et marge déductibles (MDC:53-54) ; marge par chantier dans `stats/commerciaux` (7868) ; tous les devis (6306) et tous les clients (5606), mais pas le menu Clients (B) ; aucune écriture Travaux, SAV ou planning (590, 3581).
- **DC, AC, CPT** : traités comme des comptes « autres » partout. Ils ont tous les devis et l'annuaire, aucun chantier sauf comme titulaire (397), et **ne sont pas bloqués** par `blockCommercial` (référentiels, planning et routes SAV ouverts, filtre SAV vide). `stats/commerciaux` leur répond 403 (7802). Aucune route de facturation pour CPT (`requireAdmin`).
- **Admin `estCommercial`** : apparaît comme commercial (sélecteurs, commissions, prime) et garde le périmètre et les montants d'un admin (394, 438). `stats/global` le traite en admin (7051).
- **CT** : lit l'annuaire (226) ; crée des SAV (2577) et voit ceux qu'il a créés (3036) ; n'archive des saisies Travaux qu'avec la permission individuelle (221-223) ; gère les achats SAV et l'archivage des coûts SAV (2658), pas les heures SAV (2742).
- **RESP** : branche explicite (190) ; écriture et archivage Travaux sur toute la branche (4863-4865) ; clôture limitée à ses chantiers et à ceux des TECH de sa branche (544-545) ; pas d'annuaire (231) ; pas de création SAV (2577) mais transitions, y compris l'annulation, et placement sur sa branche ; pas de coûts SAV (2710).
- **SA** : tous les scopes (249) ; planning même désactivé (635) ; seul compte admis par l'accès de secours (3179).
- **Clé d'intégration** : section A2.6.

---

# B. Client (`client/src`)

## B1. `client/src/lib/droits.ts` (réexporté par `client/src/roles.ts:5`)

| Fonction ou constante | Ligne | Règle | Règle serveur doublée | Concordance |
|---|---|---|---|---|
| `ROLE_*` (10 constantes, dont `ROLE_ADMIN`, `ROLE_CONDUCTEUR`, `ROLE_COMMERCIAL`) | 7-17 | — | `server/index.ts:205-214` | le client a les 10 constantes, le serveur 7 |
| `isAdminRole`, `isSuperAdminRole` | 20-27 | identiques | 265-270 | oui |
| `roleLabel` | 29-42 | un type inconnu s'affiche « Conducteur » | — | — |
| `peutVoirFinance` | 64-68 | jamais TECH ; SA ou `accesFinance` | 565-569 | oui ; **inutilisée** des deux côtés |
| `peutVoirStatistiques` | 71-73 | admin, RESP, CT | `requireTravauxRead` (577) | oui |
| `estExcluDesOperations` | 81-83 | COM, DIR | `blockCommercial` (588) | oui |
| `peutOuvrirAdministration` | 90-92 | ni COM, ni DIR, ni TECH | `blockCommercial` + `blockTechnicien` sur les référentiels | oui ; l'écran ouvre donc l'Administration (onglets Fournisseurs et Catégories) à **RESP, DC, AC et CPT** |
| `ROLES_ANNUAIRE`, `peutConsulterAnnuaire` | 100-104 | SA, AD, TECH, CT (**liste de rôles**) | `requirePermission('clients:read')` (5825) | **non** : le serveur ouvre aussi COM, DC, AC et CPT, et tout octroi individuel ; le client les ferme |
| `peutAccederAuxDevis` | 107-109 | SA ou `permissions` contient `devis:read` | `requirePermission('devis:read')` | oui (fondé sur la permission) |

Défaut côté client : `getCurrentRole()` et `useCurrentRole()` renvoient `CONDUCTEUR_TRAVAUX` en l'absence de rôle (`roles.ts:17-19, 58-60`), tout comme `menu.ts:31`. `useCurrentUser` relit `/api/me` au montage (`roles.ts:43-55`).

## B2. `client/src/lib/menu.ts` (`sectionsMenu`, 30-88)

| Entrée | Ligne | Condition d'affichage | Règle serveur |
|---|---|---|---|
| Tableau de bord, Liste des chantiers | 40, 43 | tous | `stats/global` et `chantiers` ouverts (périmètre) |
| Devis | 44 | `peutAccederAuxDevis` | `devis:read` |
| Planning | 47 | ni COM ni DIR, et planning actif | `blockCommercial` + `requirePlanningActif` (le menu l'ouvre aussi à TECH, DC, AC et CPT) |
| Journal des achats, Journal des heures | 48-49 | `peutVoirTravaux` = admin, CT, RESP (36) | GET ouvert à tous (5236-5237) ; écriture `chantiers:write` + `assertChantierWritable` |
| Interventions SAV | 52 | admin, CT, RESP, TECH (35) | `blockCommercial` (DC, AC et CPT passent côté serveur avec un filtre vide) |
| Contrats, Prêt à facturer, Factures, Règlements, Mentions et CGV, Plan comptable, Performances, Mes commerciaux, Catalogue, Société | 53, 56-60, 65-66, 70, 77 | admin | `requireAdmin` ; **Performances** : le serveur ouvre aussi `stats/conducteurs` et l'assiduité à RESP (7161, 7320) ; **Société** : `GET /api/company` est ouvert à tous, l'écriture est réservée au SA |
| Statistiques | 63 | `peutVoirStatistiques` | `requireTravauxRead` ; l'onglet « Chantiers » est réservé aux admins (`Statistiques.tsx:341, 358`), ce qui correspond à `requireAdmin` (7403) |
| Résultat commercial | 64 | COM | `stats/commerciaux` (admin ou COM) |
| Clients | 69 | `peutConsulterAnnuaire` | voir B1 (divergence) |
| Administration | 76 | `peutOuvrirAdministration` | voir B1 |
| API d'intégration | 78 | SA | `requireSuperAdmin` |

## B3. `client/src/App.tsx` : `PrivateRoute` et routes

- `PrivateRoute` (44-75) : sans jeton ou sans utilisateur en `localStorage`, redirection vers `/login` ; `requiredRoles` (58) ; `horsOperations` → `estExcluDesOperations` (62) ; `administration` → `peutOuvrirAdministration` (66).
- Listes de rôles : `ROLES_ADMIN` = SA, AD (40) ; `ROLES_INTERVENTIONS` = SA, AD, CT, RESP, TECH (41) ; `ROLES_TRAVAUX` = SA, AD, CT, RESP (42).
- Routes : `/devis` → `RouteDevis` (`peutAccederAuxDevis`, 84-87) ; `/interventions` → `ROLES_INTERVENTIONS` (136) ; contrats, factures, règlements, prêt à facturer, mentions, comptabilité, société, catalogue, performances et commerciaux → `ROLES_ADMIN` (141-232) ; `/clients` et `/clients/:id` → `ROLES_ANNUAIRE` (171, 176) ; `/administration/api` → SA (191) ; `/achats` et `/heures` → `ROLES_TRAVAUX` (197, 203) ; `/planning` → `horsOperations` et `PlanningRoute`, qui suit le module (79-82, 209) ; `/admin` → `administration` (217) ; `/statistiques` → SA, AD, RESP, CT (235) ; `/resultat-commercial` → COM (241). `/`, `/chantiers` et `/chantiers/:id` n'ont aucune condition de rôle (112-128).
- `RouteSociete` (91-94) : modifiable par le seul SA, ce qui double `requireSuperAdmin` (6673).

## B4. Écrans qui testent le rôle ou une permission

| Fichier:ligne | Règle d'affichage | Règle serveur doublée ou écart |
|---|---|---|
| `pages/Admin.tsx:81, 163, 199` | non-admin : onglets `fournisseurs` et `categories` seulement | bC+bT sur les référentiels |
| `pages/Admin.tsx:147` | `DROITS_INTERDITS_TECHNICIEN` client = `devis:read`, `devis:write`, `chantiers:write`, `chantiers:archive` | serveur 243 (plus `finances:read`, géré à part par la case Finance) |
| `pages/Admin.tsx:160-161, 643-662` | onglets Chantiers, Intervenants, Marges, Utilisateurs, Journal aux admins ; Société et Modules au SA | `requireAdmin` et `requireSuperAdmin` |
| `pages/Admin.tsx:370` (`peutGererCompte`) | un compte SA n'est gérable que par un SA | `refuseSuperAdminTarget` (3714) |
| `pages/Admin.tsx:1204, 1299` | option « Super Administrateur » proposée au SA seulement | 3778, 3928 |
| `pages/Admin.tsx:1283, 1376, 1393` | commandes désactivées sur son propre compte | serveur : refus pour la suppression (3826) et la désactivation (4134) ; **pas** pour le changement de type (3916) |
| `pages/Admin.tsx:1336-1365` | cases Finance, Droit devis, Corriger Travaux, Archiver Travaux actives pour le SA seulement ; « Sans effet » pour un TECH | `requireSuperAdmin` (4057, 4089) ; 4069-4074 |
| `pages/Admin.tsx:801-802` | compte proposé pour une fiche : TECH actif, libre | 4261-4263 |
| `lib/droitDevis.ts:3-24` | la case « Droit devis » accorde `devis:read`, `devis:write` et `clients:read`, et n'en retire que les deux premiers | MDC:49 |
| `pages/ChantierDetail.tsx:61-62` | boutons Corriger et Archiver selon `chantiers:write` et `chantiers:archive` | `requireTravauxWrite` et `requireTravauxArchive` (sans le périmètre de `assertChantierWritable`) |
| `pages/ChantierDetail.tsx:641, 649` | `canEditChantier` = admin, ou **CT titulaire** | serveur 3411 : admin ou titulaire de **tout** rôle non bloqué (RESP, DC, AC ou CPT titulaire admis par l'API, pas par l'écran) |
| `pages/ChantierDetail.tsx:644-647` | TECH : aucun montant ; coût de main-d'œuvre affiché seulement s'il est reçu | `voitMontantsChantier`, `voitCoutMainOeuvre` |
| `pages/ChantierDetail.tsx:203, 232, 1364-1365` | sélecteur de client réservé aux admins | 3447 |
| `pages/ChantierDetail.tsx:707, 781` | bascule « encaissé » réservée aux admins | `requireAdmin` (5380) |
| `pages/ChantierDetail.tsx:838` | PDF des factures aux admins | `requireAdmin` (1370) |
| `pages/ListeChantiers.tsx:254` | « Clôturer » si `c.peutCloturer`, calculé par le serveur | pas de doublon : le serveur décide |
| `pages/ListeChantiers.tsx:263` | « Réouvrir » aux admins | 3613 |
| `pages/ListeChantiers.tsx:135` | colonnes de montants masquées au TECH | `voitMontantsChantier` |
| `pages/ListeChantiers.tsx:326` | bouton « Créer une affaire (devis) » affiché si `!estExcluDesOperations` | **incohérent** : affiché à CT, RESP et TECH, qui n'ont pas `devis:read` (redirection par `RouteDevis`), et masqué au COM, qui a le droit devis |
| `pages/Dashboard.tsx:235, 251` | libellé de la commission ; lien « Aller aux devis » selon `peutAccederAuxDevis` | — |
| `pages/Interventions.tsx:51-52, 199, 217, 222` | encadrement = admin ou CT : création, coûts, achats SAV | 2577, 2658 |
| `pages/Interventions.tsx:224-225` | TECH : transitions EN_COURS et TERMINEE, boutons compte rendu et signature réservés au TECH | 2931 ; le serveur permet compte rendu et signature à **tout** le périmètre (2876, 2896) |
| `pages/Planning.tsx:66, 138, 253-381` | TECH : lecture seule, sans file | `blockTechnicien` |
| `pages/Planning.tsx:63, 247, 426` | partage public aux admins | `requireAdmin` (4642) |
| `pages/Devis.tsx:31, 34, 226` | prix d'achat, constat d'acompte, annulation et lien vers la fiche du chantier aux admins | `voitPrixAchatDevis` et `requireAdmin` (6552, 6592) ; le lien vers la fiche est un choix d'affichage |
| `pages/Heures.tsx:16` | coût aux admins | `voitCoutMainOeuvre` |
| `pages/Achats.tsx:55` | non-admin : chantiers EN_COURS seulement | `assertChantierWritable` (4877) |
| `pages/Clients.tsx:20`, `pages/ClientDetail.tsx:27, 79` | modification par les admins ; sinon « Consultation seule » | `requireAdmin` sur les écritures |
| `pages/Statistiques.tsx:324, 341, 358` | onglet Chantiers aux admins | `requireAdmin` (7403) |
| `lib/coutsIntervention.ts:9-13` | total affiché selon ce que le serveur envoie | pas de doublon |

## B5. Synthèse des doublons et des divergences client/serveur

- **Doublons concordants** : `isAdminRole` et `isSuperAdminRole`, `peutVoirStatistiques` ↔ `requireTravauxRead`, `estExcluDesOperations` ↔ `blockCommercial`, `peutAccederAuxDevis` ↔ `devis:read`, `peutGererCompte` ↔ `refuseSuperAdminTarget`, encadrement SAV, TECH en lecture seule sur le planning, masquage des montants pour le TECH, réouverture réservée aux admins.
- **Divergences** (le client est plus restrictif que le serveur, ce qui ne fait pas défaut de sécurité mais rend des droits serveur invisibles) : annuaire (rôles côté client, permission côté serveur) ; Performances fermées à RESP ; journaux des achats et des heures masqués à DIR et COM alors que le serveur les leur renvoie ; fiche chantier modifiable par l'écran pour le seul CT titulaire ; compte rendu et signature SAV proposés au seul TECH.
- **Incohérence d'affichage** : bouton « Créer une affaire (devis) » (`ListeChantiers.tsx:326`).
- **Rôle déduit par défaut** : sans rôle connu, le client traite le compte en CT (`menu.ts:31`, `roles.ts:18`).

---

# C. Matrice de synthèse

Légende : **L** lecture, **E** écriture, **V** validation (signature, conversion, clôture, émission…), **M** montants visibles ; périmètre **[P]** ses dossiers (titulaire, commercial, affectation), **[B]** sa branche, **[S]** toute l'entreprise ; « — » : aucun accès. Références : `server/index.ts`, sauf mention. Les 16 domaines sont répartis en quatre tableaux qui ont les mêmes lignes.

### C1. Clients, catalogue, devis, chantiers

| Type | Clients | Catalogue | Devis | Chantiers |
|---|---|---|---|---|
| SUPERADMIN | L/E [S], désactivés compris, parc d'équipements (5825-5836) | L/E [S], prix d'achat (6052-6057) | L/E/V [S] ; acompte et annulation ; prix d'achat L/E ; champs d'ouverture (6148-6155, 6454, 6552, 6592) | L [S] (fiche d'une affaire annulée comprise) ; E tous champs ; clôture et réouverture ; encaissé ; M complets, taux compris (394, 3430, 3613, 5380) |
| ADMIN | idem | idem | idem | idem |
| DIRECTEUR | — (pas de `clients:read`, 237), sauf octroi individuel | — | — sauf octroi individuel (MDC:34) | L [S] ; V clôture de tout chantier EN_COURS (541, 3599) ; pas de E fiche (594) ; M : rentabilité si `rentabiliteDirecteurs` (439), budgets et coûts sans taux |
| RESPONSABLE | — (231) | — | — | L [B] (396, 3336) ; E fiche et commercial seulement comme titulaire (3411, 3649) ; V clôture des siens et de ceux des TECH de sa branche (543-545) ; M : rentabilité selon `rentabiliteConducteur` ou `rentabiliteHierarchie` (442-443), sans taux |
| CONDUCTEUR_TRAVAUX | L [S] clients, contacts, sites, désactivés compris par `actif=false` (226, 5608) ; historique [P] (5850) ; pas de parc | — | — | L [P] (397) ; E fiche (champs limités) et commercial, comme titulaire (3411-3499, 3649) ; V clôture des siens (543) ; M : rentabilité si `rentabiliteConducteur` (442), sans taux |
| COMMERCIAL | L [S] (227), écran Clients masqué (`droits.ts:100`) | L fiches actives via `/api/devis/catalogue`, sans prix d'achat (6213) | L/E/V [S] **sans périmètre** : créer, modifier, réviser, signer, statut, convertir sans champs d'ouverture, dupliquer (6306-6645) ; pas d'acompte ni d'annulation | L [P] `commercialId` (395), fiche aussi comme titulaire (3335) ; E — (590, 3581) ; M : pas de rentabilité, mais budgets par poste et coûts sans taux (452, 475) |
| DIRECTEUR_COMMERCIAL | comme COM (230) | comme COM | comme COM (230) | L [P] titulaire seulement (397), ni commercial ni équipe ; E et V comme titulaire (non bloqué) ; M sans rentabilité |
| ASSISTANTE_COMMERCIALE | comme COM (228) | comme COM | comme COM (228) ; ne choisit pas le commercial (6454) | comme DC |
| COMPTABLE | comme COM (229) | comme COM | comme COM (229) | comme DC |
| TECHNICIEN | L [S] **clients actifs seulement** (234, 5602-5625) ; historique [P] (5845-5853) | — | — jamais (243, 250, 4069) | L [P] titulaire (397) ; E et V — (403 : 3416, 3604, 3652) ; M — (`chantierSansMontants`, 516) |

### C2. Achats et heures, interventions SAV, contrats, planning

| Type | Achats et heures | Interventions SAV | Contrats | Planning |
|---|---|---|---|---|
| SUPERADMIN | L/E/archivage [S], tout statut sauf annulé ; M taux compris (4856-4880) | L/E [S] (3031) ; toutes transitions ; coûts complets ; archivage des coûts ; **pas de saisie d'heures SAV** (TECH seul, 2742) | L/E [S] (2376-2573) | L/E [S] ; même si le module est désactivé (635) ; partage public (4642) |
| ADMIN | idem | idem | idem | idem, sauf module désactivé (636) |
| DIRECTEUR | L [S] via l'API (5236-5237), M sans taux ; E — (4862-4866) | — (594) | — | — (594) |
| RESPONSABLE | L [B] ; E et archivage [B], chantiers EN_COURS (231, 4863-4877) ; M sans taux | L : affectation ou chantier de sa branche (3039-3042) ; E transitions, placement, comptes rendus, signature ; création — (2577) ; coûts — (2710) ; journal sans taux | — | L/E événements libres et types ; projections sur son périmètre ; liste de **tous** les chantiers (4440) |
| CONDUCTEUR_TRAVAUX | L [P] ; E [P] EN_COURS (4862) ; archivage avec la permission individuelle seulement (574) ; M sans taux | création (client actif) ; L : affectation, créées par lui ou chantier dont il est titulaire (3036) ; E transitions, placement ; coûts sans taux, achats SAV E, archivage (2658, 2733, 2768, 2844) | — | comme RESP |
| COMMERCIAL | L [P] via l'API (UI masquée) ; E — | — (590) | — | — (590) |
| DIRECTEUR_COMMERCIAL | L [P] titulaire ; E — (assert) | routes ouvertes, filtre par affectation vide (3044) ; création — | — | **L/E** événements libres et types (non bloqué, 4471-4615) |
| ASSISTANTE_COMMERCIALE | idem DC | idem DC | — | idem DC |
| COMPTABLE | idem DC | idem DC | — | idem DC |
| TECHNICIEN | L [P] **sans montants** (5074, 5228) ; E — (243) | L : interventions de sa fiche (3044), client désactivé compris ; E EN_COURS et TERMINEE (2931), comptes rendus, signature, ses heures SAV (2742-2810) ; journal — (2860) ; placement — | — (pas de route contrat) | L seulement (604-610) ; liste de tous les chantiers (4440) |

### C3. Factures, règlements, comptabilité, statistiques

| Type | Factures | Règlements | Comptabilité | Statistiques |
|---|---|---|---|---|
| SUPERADMIN | L/E/V [S] (1322-2213) | L/E [S] (2227-2370) | L/E [S], mentions et export (1485-2049) | toutes [S], coûts et dépenses compris (7047-7600) |
| ADMIN | idem | idem | idem | idem |
| DIRECTEUR | — | — | — | tableau de bord [S] : nombre de chantiers, achats, heures, sans CA ni marge (7096-7139) ; Travaux — (577) |
| RESPONSABLE | — | — | — | Travaux [B] : conducteurs (CA et marge selon la rentabilité, sans dépenses), assiduité, intervenants sans coût, types ; fournisseurs [S] ; tableau de bord [B] (7161-7600) |
| CONDUCTEUR_TRAVAUX | — | — | — | intervenants [P] sans coût, types [P], fournisseurs [S] ; conducteurs et assiduité 403 (7161, 7320) ; tableau de bord [P] |
| COMMERCIAL | — | — | — | tableau de bord [P] : marge et commission personnelles (7133-7138) ; Travaux — |
| DIRECTEUR_COMMERCIAL | — | — | — | tableau de bord [P] (achats, heures) ; Travaux — ; commerciaux 403 |
| ASSISTANTE_COMMERCIALE | — | — | — | idem DC |
| COMPTABLE | — (**`requireAdmin`**) | — | — | idem DC |
| TECHNICIEN | — | — | — | tableau de bord [P] : heures seulement (7102-7111) |

### C4. Commissions, utilisateurs et administration, paramètres, journal

| Type | Commissions | Utilisateurs et administration | Paramètres | Journal |
|---|---|---|---|---|
| SUPERADMIN | `stats/commerciaux` [S] ; encaissé ; prime ; rémunération L/E (5380, 5397, 6700, 6748) | tout, comptes SA compris ; permissions individuelles ; accès finance (3674-4154) | paramètres L/E ; modules ; société E ; clés API ; conservation (5435-7039) | L complet, export (6912) |
| ADMIN | idem, rémunération en lecture seule | tout sauf comptes SA, permissions et accès finance ; intervenants et fiches (4205-4340) | paramètres L/E ; société et modules en lecture ; pas de clés | L filtré (`concerneSuperAdmin`, `reserveSuperAdmin`) |
| DIRECTEUR | — | — | lecture de `company` et `modules` | — |
| RESPONSABLE | — | — ; référentiels catégories et fournisseurs E (4764-4845) | idem | — |
| CONDUCTEUR_TRAVAUX | — | — ; référentiels E | idem | — |
| COMMERCIAL | sa ligne de `stats/commerciaux` (7815), commission nulle sans plan (7724) | — | idem | — |
| DIRECTEUR_COMMERCIAL | — (403, 7802) | — ; référentiels E (non bloqué) | idem | — |
| ASSISTANTE_COMMERCIALE | — (403) | — ; référentiels E | idem | — |
| COMPTABLE | — | — ; référentiels E | idem | — |
| TECHNICIEN | — | — ; référentiels en lecture seule | idem | — |

### C5. Ligne supplémentaire : clé d'intégration

Périmètre global (392). Scopes : clients (L/E, désactivés compris), catalogue, équipements, devis (L/E/V conversion sans champs d'ouverture, **pas de signature**), chantiers, achats et heures en lecture, **taux et coût de main-d'œuvre compris** (476), rentabilité et prix d'achat avec `finances:read` (435, 6150), identité de la société. Aucun accès aux interventions, contrats, planning, factures, règlements, comptabilité, statistiques ni administration.

---

# D. Écarts entre la documentation et le code, et points à vérifier

1. **DIRECTEUR_COMMERCIAL** : MDC:32 attribue « tous les droits du commercial, [la] visibilité sur les affaires, devis et statistiques de son équipe, [des] objectifs ». **Code** : mêmes droits par défaut que COM (230), mais aucun traitement de commercial. Périmètre chantiers limité au titulaire (397), non éligible comme commercial (618, 3273), aucune équipe (`equipeIds` réservé à RESP, 190), `stats/commerciaux` refusé (7802), pas d'objectifs. Il franchit en revanche `blockCommercial`, d'où planning et référentiels en écriture.
2. **ASSISTANTE_COMMERCIALE** : MDC:39 dit qu'elle « peut choisir le commercial porteur d'une affaire ; cette attribution reste traçable ». **Code** : le devis n'a pas de champ commercial (`schema.prisma:458-510`), le commercial d'une conversion est réservé à l'admin (6454), la route de réattribution est réservée à l'admin ou au titulaire (3649), et aucune réattribution n'est journalisée (3660-3664). Elle a de plus planning et référentiels en écriture, que MDC:29 ne mentionne pas.
3. **COMPTABLE** : MDC:31 parle de « devis et chantiers utiles à la comptabilité, puis factures, avoirs… ». **Code** : tous les devis en lecture et en écriture, signature et conversion comprises (229) ; aucun chantier hors titularité (397) ; factures, avoirs, comptabilité et mentions, pourtant livrés, réservés aux admins (`requireAdmin`, 1322-2049). MDC:62 ne vise que les règlements. Planning et référentiels en écriture.
4. **COMMERCIAL** : MDC:23 limite le COM aux « affaires et chantiers commerciaux qui lui sont rattachés ». **Code** : chantiers rattachés ✓ (395), mais **tous les devis** sans périmètre (6306) et tous les clients (5606). Le modèle ne permet pas de rattacher un devis à un commercial.
5. **RESPONSABLE** : MDC:33 parle de « lecture de leur travail et statistiques ». Les écritures sur sa branche ont pourtant été livrées volontairement par #121 (`HISTORIQUE-DECISIONS.md` : « il y saisit, archive et restaure achats et heures ») : l'écart est un oubli de MDC, pas une anomalie du code. **Code** : il a aussi l'écriture et l'archivage Travaux sur toute la branche (231, 4863-4865), les transitions SAV (y compris l'annulation) et le placement sur sa branche (3039-3042, 2913, 2981), et le planning et les référentiels en écriture. Il n'a pas l'annuaire (231). L'écran Performances lui est fermé alors que le serveur lui ouvre `stats/conducteurs` (7161).
6. **TECHNICIEN, « consulter maintenance récurrente »** (MDC:30) : aucune route de contrat ne lui est ouverte (`requireAdmin`, 2376-2573) ; il voit seulement les interventions affectées, avec `couvertureContrat`. Sens exact **à vérifier**.
7. **DIRECTEUR** : MDC:34 est respecté (lecture, clôture, rentabilité paramétrable, ni planning, ni SAV, ni statistiques Travaux). MDC ne dit pas qu'il lit aussi `GET /api/achats` et `GET /api/heures` de toute la société, avec montants (5236-5237), ni qu'il voit le tableau de bord global (achats et heures, 7102-7111). La roadmap §4:258 mentionne le tableau de bord.
8. **« Toute nouvelle route métier doit déclarer sa permission serveur »** (MDC:64) et vocabulaire partagé (MDC:14) : la plupart des routes reposent sur des gardes de **rôle** (`requireAdmin`, `blockCommercial`…), pas sur des permissions. `clients:write`, `catalogue:*`, `equipements:*`, `company:read` et `finances:read` sont accordables individuellement (4063) **sans aucun effet** pour une session (A2.3). `accesFinance` et `peutVoirFinance` n'ont aucun effet serveur (A2.4).
9. **Annuaire côté interface** : MDC:14 (« Une permission côté interface ne constitue jamais une sécurité ») est respecté dans le sens de la sécurité, mais le client raisonne par rôles (`ROLES_ANNUAIRE`, `droits.ts:100`) et le serveur par permission : COM, DC, AC et CPT lisent l'annuaire par l'API sans écran.
10. **Journalisation des droits** (MDC:55-56) : le titulaire d'un chantier ouvre l'accès en lecture et en écriture (A4), mais sa réattribution n'est pas journalisée, pas plus que celle du commercial, qui alimente les commissions (3470-3475, 3660-3664). L'encaissement, qui conditionne le résultat commercial, n'est pas journalisé (5380). Création et modification d'un devis sans auteur. La roadmap §4:282-286 couvre les mentions, les comptes comptables, les taux et la conversion.
11. **Clé d'intégration et taux** : MDC:54 décrit le code (« une clé garde son accès »), contre le choix de la roadmap §4:290, « à appliquer ». Concordance doc/code, la décision n'est pas appliquée.
12. **Clients désactivés pour les autres porteurs** : MDC:46 décrit le code, contre le choix de la roadmap §4:259-263, « à appliquer ». Concordance, non appliquée. Au passage : un devis peut être créé pour un client désactivé (6300, `findUnique` sans `actif`), contrairement aux factures (1425), interventions (2587) et contrats (2409). Intention **à vérifier**.
13. **Fiche chantier modifiable « par l'administration et le titulaire »** (MDC:50) : le titulaire peut être de n'importe quel type non bloqué (RESP, DC, AC, CPT), et il peut changer `baremeReduit` (barème de commission) et les budgets par poste sans voir la rentabilité (3481-3499). L'interface limite l'écriture au CT titulaire (`ChantierDetail.tsx:641`). Le titulaire peut aussi confier son chantier à **tout** compte actif (`refusTitulaire`, 3263-3267 ; roadmap §4:295, « appliqué à l'écran »).
14. **Dernier super administrateur** (MDC:20) : il compte les SA inactifs et le contrôle se fait hors transaction (A7.2). **À vérifier** par un test.
15. **Factures émises figées** (`CLAUDE.md` : « les factures émises et leurs montants et mentions sont figés ») : totaux, identité, mentions, ventilation et écritures sont figés en base ; **les lignes (`FactureLigne`) ne le sont pas**, faute de trigger (A7.6) ; seule l'API ne les modifie pas. Les journaux `JournalFacture` et `JournalSaisieChantier` et les comptes rendus SAV n'ont pas de trigger « ajout seul ».
16. **`?inclureAnnulees=true`** (2634-2638) : le commentaire le réserve à « administration/contrôle », mais le paramètre est accepté de tout compte dans son périmètre.
17. **Planning du technicien** (roadmap §4:277, « à appliquer ») : `GET /api/planning/chantiers` renvoie à tout compte non COM et non DIR la liste de tous les chantiers, annulés compris (4440-4450).
18. **Création d'une intervention hors périmètre** (roadmap §4:257, « à appliquer ») : confirmé, seul le client et l'annulation du chantier sont contrôlés (2612).
19. **Commentaires obsolètes dans le code** (pour mémoire) : « module réservé aux administrateurs » sur le planning (4342) ; « tout compte non-commercial » sur la correction des achats et des heures (5107, 5270), alors qu'il faut `chantiers:write` et `assertChantierWritable`.

---

# E. Résumé : les 15 constats les plus importants

1. Les types DC, AC et CPT sont, **côté serveur, trois copies du COMMERCIAL sans son périmètre** : tous les devis, l'annuaire, aucun chantier hors titularité, ni équipe, ni statistiques commerciales, ni facturation (219-238, 397, 7802).
2. `blockCommercial` (588) n'exclut que COM et DIR : **DC, AC et CPT écrivent le planning et les référentiels** et entrent sur les routes SAV (le filtre les vide), ce qu'aucune ligne de MDC ne prévoit.
3. **MDC:32 (DIRECTEUR_COMMERCIAL), MDC:39 (choix traçable du commercial par l'AC) et MDC:31 (périmètre comptable) ne sont pas implémentés.**
4. **Aucun périmètre sur les devis ni sur les clients** : un COM voit et modifie tous les devis ; le modèle `Devis` n'a ni commercial ni auteur de création.
5. Le RESPONSABLE a **l'écriture et l'archivage** sur toute sa branche, et les transitions SAV, au-delà de la « lecture » décrite par MDC:33 ; il n'a pas l'annuaire.
6. **Cinq définitions distinctes du « titulaire »** : liste (395-397), fiche (3332-3337), modification de la fiche (3411), écriture Travaux (4862-4865), clôture (539-546). Un COM titulaire voit la fiche, pas la liste ; un RESP, un DC, un AC ou un CPT titulaire modifie la fiche par l'API, pas par l'écran.
7. Plusieurs permissions accordables (`finances:read`, `clients:write`, `catalogue:*`, `equipements:*`, `company:read`) et **`accesFinance` n'ont aucun effet serveur** ; `peutVoirFinance` n'est appelée que par les tests.
8. Le titulaire d'un chantier peut le **confier à tout compte actif** et modifier `baremeReduit` ; **ni la réattribution du titulaire ni celle du commercial ne sont journalisées**, pas plus que l'encaissement.
9. Le garde-fou du **dernier super administrateur compte les SA désactivés** et s'exécute hors transaction (3766-3771).
10. **Montants** : règles cohérentes (`voitRentabilite`, `voitMontantsChantier`, `voitCoutMainOeuvre`, `voitPrixAchatDevis`), mais DIR et COM lisent les journaux d'achats par l'API sans écran, et le COM a la marge par chantier (7868).
11. **Côté client**, des règles par rôle (`ROLES_ANNUAIRE`, `ROLES_INTERVENTIONS`, `ROLES_TRAVAUX`, `canEditChantier`) doublent des règles serveur par permission ou par périmètre : l'interface est plus restrictive que l'API (annuaire, Performances, journaux).
12. Le **TECHNICIEN** est le type le mieux verrouillé : retrait forcé de droits (250), refus 403 explicites, masquage dédié, client désactivé conservé sur ses SAV (2647). Restent à appliquer son planning limité et la perte de `clients:read` au changement de type.
13. Documents figés : devis signés, factures (hors lignes), règlements, écritures, mentions et journal d'administration sont protégés par triggers ; **`FactureLigne`, `JournalFacture`, `JournalSaisieChantier` et les comptes rendus SAV n'en ont pas**.
14. La séparation ADMIN/SUPERADMIN est complète (liste, cibles, journal filtré), mais le filtre du journal ignore l'auteur SA (`auteurSuperAdmin` stocké, non filtré, roadmap §4:284).
15. Les clés d'intégration voient tout le périmètre, les taux et le coût de main-d'œuvre (`chantiers:read`) et les clients désactivés : la doc décrit ce comportement, mais il va à l'encontre des choix de la roadmap §4, encore « à appliquer ».
