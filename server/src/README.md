# Code du serveur : organisation par domaine

**Découpage en cours** (chantier technique 2, décision de Nelson du 17-10-2026). `server/index.ts` contient encore la plupart des routes. Chaque PR du chantier en déplace un ou deux domaines vers `src/`, **sans aucun changement de comportement** : mêmes routes, mêmes réponses, mêmes codes et messages d'erreur, mêmes transactions, verrous et contraintes différées.

## Structure cible (proposition)

```
server/
  index.ts              point d'entrée : crée l'application, enregistre les domaines dans
                        l'ordre, démarre le serveur ; ré-exporte ce que lisent les tests
  src/
    env.ts              chargement de server/.env
    db.ts               client Prisma, transactionVerifiee
    http/               couche HTTP commune à tous les domaines
      auth.ts           secret JWT, requireAuth, AuthRequest, branche hiérarchique
      gardes.ts         gardes de type de compte (requireAdmin, blockCommercial…)
      requete.ts        lecture des paramètres de requête (paramId)
    droits/             types de compte, permissions, périmètres de lecture
      roles.ts
    commun/             utilitaires partagés : dates (jour civil, fuseau de la société),
                        montants, validation des saisies, journal d'administration, PDF, CSV
    domaines/<domaine>/
      routes.ts         routes HTTP du domaine : enregistrerRoutes<Domaine>(app)
      metier.ts         logique métier du domaine (calculs, contrôles, lectures et écritures
                        réutilisées), sans objet HTTP ; plusieurs fichiers si besoin
```

Domaines prévus :

| Domaine | Contenu |
|---|---|
| `referentiels` | catégories et fournisseurs des achats (**déplacé**) |
| `authentification` | SSO Microsoft, accès de secours, `/api/me`, configuration publique, santé |
| `utilisateurs` | comptes, hiérarchie, commerciaux, conducteurs, fiches intervenant |
| `administration` | clés d'intégration, journal des paramètres et des droits, modules, société |
| `parametres` | paramètres métier, rémunération, registre des entreprises |
| `clients` | clients, contacts, sites, parc d'équipements |
| `catalogue` | prestations, articles, équipements |
| `devis` | devis versionnés, signature, acompte, conversion, duplication |
| `chantiers` | affaires, achats, heures, métriques et suivi |
| `interventions` | SAV, coûts, comptes rendus, placement au planning |
| `contrats` | contrats de maintenance et visites |
| `planning` | affectations, types d'événement, partage public |
| `factures` | factures, avoirs, mentions légales, export comptable |
| `reglements` | encaissements et affectations |
| `comptabilite` | plan comptable, règles, TVA, import, écritures |
| `statistiques` | tableaux de bord et statistiques |
| `commissions` | barème et calcul des commissions |

## Règles du découpage

- **Déplacer, ne pas réécrire.** Le texte est repris tel quel, commentaires compris. Seuls changent les `import`, le mot-clé `export` devant une déclaration, et l'indentation des routes placées dans leur fonction d'enregistrement. Une ligne qui continue une chaîne multiligne n'est jamais réindentée.
- **Ordre des routes conservé.** Chaque `enregistrerRoutes…(app)` est appelé à l'endroit exact où se trouvait le bloc déplacé, si bien qu'Express essaie toujours les routes dans le même ordre.
- **Deux preuves par PR**, à lancer depuis `server/` après `npm run build` :
  - `node scripts/routes.mjs --verifier` compare ce que l'application enregistre à `scripts/routes-reference.txt`, écrit depuis `main` avant le découpage. Il compare les réglages, les middlewares et leurs chemins, ainsi que les routes dans l'ordre où Express les essaie. Pour chaque gestionnaire, il compare aussi son nom, les valeurs confiées par sa fabrique (`{permission="…"}`, `{scope="…"}`) et l'empreinte de son texte compilé. Il compare enfin les exports lus par les tests. La CI le rejoue.
  - `node scripts/verifier-deplacement.mjs origin/main` compare, instruction par instruction, tous les fichiers TypeScript du serveur entre la base et la branche. Il s'appuie sur l'analyseur du compilateur TypeScript.
    - Chaque instruction de la base doit se retrouver une fois, à l'identique, commentaires compris, et dans le même ordre. Seuls sont admis le mot-clé `export` ajouté et un décalage d'indentation uniforme dans une fonction d'enregistrement, hors lignes de gabarit multiligne.
    - Les imports conservés gardent leur ordre et les nouveaux viennent après eux. Aucun import n'est renommé.
    - Chaque fonction d'enregistrement est appelée une fois, avec `app`, au premier niveau d'`index.ts`. L'ordre d'`index.ts`, ses appels remplacés par le contenu des fonctions, est celui de la base.
    - Toute autre instruction nouvelle le fait échouer.
    - Il liste pour la revue les blocs déplacés, les imports et commentaires ajoutés, et les instructions qui s'exécutent désormais au chargement d'un autre module qu'`index.ts`.
- **Ce que les preuves ne couvrent pas.** Le moment où un module s'évalue : une instruction déplacée au premier niveau d'un module s'exécute à son import, avant le corps d'`index.ts`. Le vérificateur liste ces instructions ; la PR justifie chacune. Une fabrique comme `creerRouteMixte(app)`, qui enveloppe du code de la base dans une fonction nouvelle autre qu'une fonction d'enregistrement, n'est pas encore admise : la PR qui l'introduit étend le vérificateur et prouve l'extension par des mutations.
- **Un lot fonctionnel** (hors découpage) réécrit la référence avec `node scripts/routes.mjs --ecrire`, et l'écart apparaît dans le diff de sa PR, s'il :
  - ajoute, retire ou réordonne une route ;
  - modifie un gestionnaire, un middleware, un réglage ou un export ;
  - met à jour une bibliothèque dont le code d'un middleware change (`cors`, `express.json`).

  `verifier-deplacement.mjs` ne concerne que les PR du découpage.
- **Imports sans renommage** : aucun `import { a as b }` pendant le découpage.
- **Ordre de chargement inchangé** : `index.ts` importe `src/env.ts` après les bibliothèques, au moment où il appelait `dotenv.config()` avant le découpage. Certaines bibliothèques lisent l'environnement à leur chargement (`DEBUG`, `NO_COLOR`…).
- **Domaines dispersés dans le fichier.** Plusieurs domaines ont leurs routes en plusieurs endroits d'`index.ts` : factures, chantiers, interventions, planning, société, paramètres, commerciaux. Leur module expose alors plusieurs fonctions d'enregistrement, appelées chacune à l'emplacement de son bloc. Le vérificateur refuse tout réordonnancement : s'il en fallait un, il ferait l'objet d'une PR à part, prouvée sans recouvrement de chemins.
- **`routeMixte`** dépend de `app` : il deviendra une fabrique, `creerRouteMixte(app)`, dont le corps reste identique, pour que ses appels ne changent pas.
- **Utilitaires partagés d'abord** : une fonction dont se servent plusieurs domaines est déplacée vers `commun/`, `droits/` ou `http/` avant le premier domaine qui l'emploie.
- **Aucun test modifié.** `index.ts` ré-exporte ce que les tests importent de `dist/index.js`.
- **Pas de dépendance circulaire.** Un module importe `db`, `http`, `droits`, `commun` ou la logique d'un autre domaine, jamais `index.ts`.
- **Logique métier.** Les fonctions déjà séparées des routes passent dans le `metier.ts` de leur domaine. La logique écrite dans le corps d'un gestionnaire y reste pendant le découpage, puisque l'en extraire changerait du code ; son extraction sera proposée ensuite, domaine par domaine, si elle est utile.
- **Taille.** Aucun fichier de code applicatif ne dépasse environ 800 lignes (`CLAUDE.md`). Les grands domaines (devis, chantiers, factures, comptabilité) auront plusieurs fichiers de routes.

## Ordre prévu des PR (proposition)

1. Socle (`env`, `db`, rôles, authentification, gardes de type de compte, `paramId`), scripts de preuve, et domaine `referentiels`.
1 bis. Outils de preuve renforcés (vérification par instruction, imports, permissions des gardes, empreintes des gestionnaires), sans déplacement de code.
2. Droits : permissions, clés d'intégration (`requireApiKey`, `routeMixte`), périmètres de lecture ; dates partagées.
3. Journal d'administration ; domaines `parametres` et `administration`.
4. Domaines `authentification` et `utilisateurs`.
5. Domaines `clients` et `catalogue`.
6. Domaine `devis`.
7. Domaine `chantiers`.
8. Domaines `interventions` et `contrats`.
9. Domaine `planning`.
10. Domaines `factures` et `reglements`.
11. Domaine `comptabilite`.
12. Domaines `statistiques` et `commissions`.
13. Finalisation : `index.ts` réduit au point d'entrée, plus aucun fichier au-delà d'environ 800 lignes.
