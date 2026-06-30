# Audit du code — Suivi de marge de chantier (NOXIA)

> Audit réalisé sur la base du code présent dans `client/` (React + Vite + TS) et
> `server/` (Express + Prisma + TS). Classé par gravité. Les corrections du bundle
> « ça remarche » (Tailwind, URL d'API par environnement, sécurisation auth de base)
> ont été appliquées — voir la section **État des corrections** en fin de document.

## Vue d'ensemble

Bonne base : architecture client/serveur propre, modèle Prisma cohérent, dockerisation,
standby IA bien pensé. Mais l'application avait deux problèmes **bloquants** (l'UI
n'était en réalité pas stylée, et la sécurité de l'API était quasi inexistante) et
présente plusieurs écarts par rapport à la vision cible.

---

## 🔴 1. Bloquants — l'app ne fonctionnait pas comme prévu

### 1.1 Tailwind n'était pas installé → UI cassée
Tout le JSX repose sur des classes Tailwind (`grid grid-cols-4`, `bg-gray-50`,
`rounded-xl`, `shadow-md`, `md:`/`lg:`/`sm:`, `bg-emerald-50`…), mais Tailwind
n'était ni installé ni configuré (pas de `tailwindcss` dans `package.json`, pas de
config, pas de directive `@tailwind`/`@import`). `index.css` ne redéfinissait qu'une
dizaine d'utilitaires. **Conséquence : ~95 % des classes ne produisaient aucun style.**
➡️ **Corrigé** : Tailwind installé + configuré, couleurs de marque mappées dans le thème.

### 1.2 URL d'API en dur → casse en production
Les 6 pages contenaient `const API_URL = 'http://localhost:3001/api'` et des images
`src="http://localhost:3001${p.url}"`. Le Dockerfile injecte pourtant `VITE_API_URL=/api`,
jamais lu par le code. En prod, le navigateur appelait `localhost:3001` → échec total.
➡️ **Corrigé** : base d'API centralisée dans `src/api.ts` lisant `import.meta.env.VITE_API_URL`.

---

## 🔴 2. Sécurité — critique

### 2.1 Aucune authentification sur les routes API
Seul `/api/login` existait ; **aucun middleware ne vérifiait le JWT**. Toutes les routes
étaient publiques. Sans aucun compte on pouvait : lister toutes les données financières,
**passer n'importe qui ADMIN** (`PATCH /api/users/:id/role`), **réinitialiser n'importe
quel mot de passe** (`PUT /api/users/:id/password`), créer achats/heures/chantiers.
➡️ **Corrigé** : middlewares `requireAuth` + `requireAdmin` appliqués aux routes.

### 2.2 Le frontend n'envoyait jamais le token
Aucun `fetch` n'ajoutait l'en-tête `Authorization`. Le JWT était stocké dans
`localStorage` puis ignoré.
➡️ **Corrigé** : wrapper `apiFetch` qui injecte le `Bearer` et gère le 401 (déconnexion).

### 2.3 Contrôle de rôle uniquement côté client
La « marge commerciale réservée aux admins » était gérée par `userRole === 'ADMIN'` en
React, alors que l'API renvoyait toutes les données (dont `commissionnement`) à tout le
monde. Un conducteur pouvait voir la marge via la réponse réseau ou en éditant
`localStorage.user.role`. **Règle métier non respectée.**
➡️ **Corrigé** : la marge commerciale et le prix de vente global ne sont calculés et
renvoyés qu'aux admins (et si la marge est activée dans les paramètres). Le calcul est
centralisé côté serveur ; un conducteur ne reçoit plus ces champs (voir §6).

### 2.4 Autres failles
- **`JWT_SECRET` par défaut en dur** → tokens forgeables si l'env manque.
  ➡️ **Corrigé** : refus de démarrer en production sans `JWT_SECRET`.
- **Mass assignment** : `PATCH /api/chantiers/:id` et la mise à jour de
  `commissionnement` faisaient `data: req.body` brut.
  ➡️ **Corrigé** : whitelist des champs autorisés.
- **Upload non sécurisé** : multer sans limite de taille ni filtre MIME.
  ➡️ **Corrigé** : limite 10 Mo + filtre images uniquement.
- **Pas de rate limiting** sur `/login` (brute force). _À faire._
- **CORS grand ouvert** (`app.use(cors())`). _À restreindre par env (faible risque
  derrière le proxy nginx en same-origin)._
- **Base de données committée dans git** : `server/dev.db` et `server/prisma/dev.db`
  contiennent des données réelles (emails, noms, rôles). `server/dist/` aussi committé.
  _À retirer du suivi git + purger l'historique (voir Roadmap §4)._

---

## 🟠 3. Architecture & scalabilité

- **Tout est calculé côté client après avoir tout téléchargé.** `GET /api/chantiers`
  renvoie chaque chantier avec **tous** ses achats, pointages et photos imbriqués.
  ➡️ Créer des endpoints d'agrégation serveur : `/api/stats/global`,
  `/api/stats/chantiers/:id`, `/api/stats/conducteurs`.
- **Pas de scoping par conducteur** : le schéma prévoit `chantiersGeres` mais l'API ne
  filtre rien — un conducteur voit tous les chantiers.
- **Logique de marge dupliquée** (`Dashboard.tsx` et `ListeChantiers.tsx`), avec un
  *magic number* `30` (taux horaire fictif du bonus/malus) codé en dur. À centraliser
  côté serveur.
- **SQLite + `prisma db push --accept-data-loss`** à chaque démarrage (Dockerfile) →
  risqué. `pg` est déjà en dépendance : migrer vers **Postgres + migrations versionnées**.
- **Pas de pagination** sur achats/heures.
- **Doublon `server/index.ts` (407 l) vs `server/index.js` (155 l, périmé)** → supprimer
  le `.js`.

---

## 🟡 4. Qualité de code & UX

- **`any` partout** (`useState<any[]>`, `(a: any)`) : TypeScript sans typage réel.
  Générer les types depuis Prisma + types partagés client/serveur.
- **UX d'erreur via `alert()` / `window.prompt()`** : à remplacer par toasts/modales.
- **Pas de gestion fine du 401 / expiration** (token 7 j, aucun refresh).
  ➡️ Gestion 401 de base ajoutée (déconnexion auto) ; refresh token à faire.
- **`JSON.parse(localStorage)` sans try/catch** → crash possible.
- **`@ts-ignore`** dans l'upload masquent de vrais soucis de types multer.
- **`ErrorBoundary` affiche la stack complète** en prod (fuite d'info).
- **`nginx.conf`** : `X-Forwarded-For $proxy_addrs` → variable inexistante (devrait être
  `$proxy_add_x_forwarded_for`).
- **`App.css`** = boilerplate Vite mort (`.counter`, `.hero`, `.vite`…), non importé.
- **Aucun test, aucune CI** (`"test": exit 1`).

---

## 🟢 5. Écarts par rapport à la vision

| Besoin exprimé | État |
|---|---|
| Stats **globales / par chantier / par conducteur** | Le Dashboard ne montre qu'**un** chantier sélectionné. Onglet « Performances » = placeholder. Pas de vue agrégée ni de classement conducteurs. |
| **Marge commerciale paramétrable par les admins** | Calculée d'une seule façon, affichée d'office aux admins, non protégée côté serveur. Aucun paramètre (toggle d'affichage, mode de calcul, coefficients). |
| **Rapport IA complet** | ✅ Standby bien géré (`ai = key ? … : null` + `/api/config`). Prompt minimal (150-200 mots) — à enrichir (tendances, dépassements par poste, photos). |
| **SSO Microsoft 365** | Bouton décoratif, non câblé. |
| Budget **prévu par poste** | `LigneBudgetPrevisionnel` existe dans le schéma mais n'est jamais utilisé. |

**À garder (bons points)** : standby IA conditionné à l'env, compression d'image avant
upload (bon pour le mobile terrain), exports PDF/ZIP, séparation matériel/main-d'œuvre,
guide de déploiement détaillé.

---

## Roadmap recommandée (par priorité)

1. ✅ **Rendre l'UI réelle** : installer/configurer Tailwind.
2. ✅ **API URL via `import.meta.env`** : débloque la production.
3. ✅ **Sécuriser l'API** : `requireAuth` + `requireAdmin`, client qui envoie le token,
   `JWT_SECRET` obligatoire en prod, whitelist anti-mass-assignment, limites d'upload.
4. ✅ **Nettoyer le repo** : `*.db` et `dist/` retirés du suivi git, `index.js` supprimé,
   `.gitignore` racine réécrit en UTF-8. *(Reste : purge de l'historique git des données
   déjà committées — nécessite une réécriture d'historique + force-push.)*
5. ✅ **Endpoints d'agrégation** + scoping par conducteur : `/api/stats/global` et
   `/api/stats/conducteurs`, métriques par chantier calculées côté serveur.
   *(Reste : pagination des listes brutes achats/heures.)*
6. ✅ **Marge commerciale paramétrable** (modèle `Parametres`, éditable par les admins)
   + **masquage serveur par rôle** des champs financiers.
7. ✅ **Postgres + migrations** : datasource PostgreSQL, migration initiale versionnée
   (validée contre un PG 16 réel), `prisma migrate deploy` au démarrage, service `db`
   dans docker-compose. *(Reste : passer les montants de `Float` à `Decimal`.)*
8. Typage TS strict, toasts, tests/CI, enrichissement du rapport IA, SSO réel,
   exploitation de `LigneBudgetPrevisionnel`, pagination, rate limiting login.

---

## État des corrections (bundle « ça remarche »)

| Sujet | Statut |
|---|---|
| Tailwind installé + configuré (thème de marque) | ✅ |
| URL d'API centralisée via `VITE_API_URL` (`src/api.ts`) | ✅ |
| Images servies via la base d'API (plus de `localhost` en dur) | ✅ |
| Middlewares `requireAuth` / `requireAdmin` | ✅ |
| Client envoie le `Bearer` + gère le 401 | ✅ |
| `JWT_SECRET` obligatoire en production | ✅ |
| Whitelist anti-mass-assignment (chantier, commissionnement) | ✅ |
| Limites d'upload (taille + type MIME) | ✅ |
| Masquage serveur de la marge par rôle | ✅ |
| Marge commerciale paramétrable par les admins (`Parametres`) | ✅ |
| Stats serveur globales / par conducteur + scoping conducteur | ✅ |
| Nettoyage git (`*.db`, `dist/`, `index.js`, `.gitignore` UTF-8) | ✅ |
| PostgreSQL + migrations versionnées (`prisma migrate deploy`) | ✅ |
| Rate limiting login / CORS restreint | ⏳ Roadmap |
| Purge de l'historique git (données déjà committées) | ⏳ Roadmap §4 |
