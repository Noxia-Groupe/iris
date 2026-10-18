# Découpage des gros écrans du client (proposition)

**Proposition du 18-10-2026.** Le même jour, Nelson en a validé le principe et les fichiers à plat, et il a délégué le traitement des petites anomalies. Les autres choix, dont l'ordre des PR, sont des choix techniques de Claude Code (décisions en fin de document). Chantier technique 2 du 17-10-2026, suite du découpage du serveur (terminé : `server/index.ts` n'est plus que le point d'entrée, voir [server/src/README.md](../server/src/README.md)). Relevé fait sur `main` le 18-10-2026.

Trois écrans dépassent la règle permanente des 800 lignes ([CLAUDE.md](../CLAUDE.md)) :

| Écran | Lignes | Composants internes déjà séparés |
|---|---|---|
| `client/src/pages/Admin.tsx` | 1 477 | `EditeurBareme`, `ChoixResponsable` |
| `client/src/pages/ChantierDetail.tsx` | 1 477 | aucun |
| `client/src/pages/Planning.tsx` | 873 | `ContractPlacement`, `EventModal`, `TypesModal` |

## Principe : déplacer, ne pas réécrire

Comme pour le serveur, chaque PR **déplace** du code sans changer le comportement ni le rendu. Elle ne change ni le DOM, ni les classes, ni les textes, ni les noms d'accès, ni les requêtes, ni l'ordre des chargements. Concrètement :
- **Composants internes déjà autonomes** (props seules) : déplacés tels quels dans leur propre fichier.
- **Sections du rendu** (onglets, journaux, modales) : leur JSX est déplacé tel quel dans un composant. Ce composant reçoit **par props, sous les mêmes noms**, les états, valeurs dérivées et gestionnaires qu'il lit. Les hooks restent dans la page, dans le même ordre, avant les mêmes retours anticipés. Le texte du JSX déplacé reste donc identique, et React produit le même DOM.
- Les types, constantes et petites fonctions qu'un seul composant emploie le suivent. Pour ceux que la page emploie aussi : un type ou une constante littérale est exporté depuis le nouveau fichier ; une fonction ou une constante non littérale (tableau, objet) va dans `client/src/lib/`, pour ne pas déclencher `react/only-export-components`.
- Aucun nom n'est renommé. Aucune logique n'est extraite des gestionnaires. Aucun état n'est déplacé de la page vers un composant (voir « Hors périmètre »).
- **Seul code nouveau admis**, l'équivalent des fonctions d'enregistrement du serveur :
  - la signature de chaque composant de section, avec ses props typées. Certains types d'état n'ont pas de nom : il faudra un alias de type ou `React.Dispatch<React.SetStateAction<…>>` ;
  - les points d'appel dans la page ;
  - les `import` et `export`, dont `import type` pour les types (`verbatimModuleSyntax`).

  Seules les props réellement lues sont passées (`noUnusedParameters`). Un composant qui reprend plusieurs onglets, comme `AdminReferentiels`, rend un fragment, sans nœud DOM supplémentaire.

## Preuves par PR

Côté client, il n'existe pas d'équivalent de `server/scripts/verifier-deplacement.mjs`. Je propose :
1. **Un outil de comparaison du rendu, dans une PR préalable sans déplacement**, à l'image de la PR 1 bis du serveur :
   - un script Playwright hors de la suite de tests ouvre chaque écran et chaque onglet (Admin : les 9 onglets ; fiche chantier : administrateur, conducteur, technicien ; Planning : grille, file et chaque modale ouverte) ;
   - il le fait sur une base jetable aux données fixes, avec une horloge figée ;
   - il enregistre le HTML de `<main>` et des dialogues ouverts, ainsi que la liste ordonnée des requêtes API.

   La preuve d'une PR : un relevé **identique** entre `main` et la branche.

   **Livré** : `cd client && npm run comparer:rendu -- --reference <dossier client de main>` ([client/scripts/comparer-rendu/](../client/scripts/comparer-rendu/index.mjs), mode d'emploi dans [CONFIGURATION-ENVIRONNEMENT.md](CONFIGURATION-ENVIRONNEMENT.md#comparaison-du-rendu-découpage-des-écrans)). Il sert les deux clients avec le même serveur et la même base, ce qui évite toute normalisation des identifiants et des dates, et libère les réponses API une à une pour fixer l'ordre des requêtes.

   Couverture (79 étapes) : chaque section que les PR A, B et C déplacent est rendue au moins une fois. Pour PR A : les branches de la modale d'affectation (création, heures précises, événement et nouveau type, modification d'une affectation, d'un événement et d'une affectation issue d'une intervention), les types et leur édition, le placement d'une visite et d'une curative, le partage. Pour PR B : les neuf onglets, l'édition en ligne avec saisie, le choix d'un responsable ouvert (dont un responsable désactivé), les vues de l'administrateur (référentiels compris) et du conducteur. Pour PR C : la modale, les corrections, chaque filtre, le tri, la recherche et la réinitialisation des deux journaux, le commercial en place, le barème réduit, les chantiers terminés en attente d'encaissement et encaissé, les vues du conducteur et du technicien.

   Limites : aucune action qui écrit (enregistrement, glisser-déposer, suppression) n'est relevée, ni l'état qui suivrait une écriture ; ces parcours restent couverts par les E2E. Les branches de l'onglet Utilisateurs qui affichent le message réservé aux comptes super administrateur ne se rendent pas : le serveur ne renvoie pas ces comptes à un administrateur. L'horloge du serveur n'est pas figée (exécution refusée à cheval sur minuit). L'outil ne compte que les requêtes API parties par `fetch` : une requête partie autrement l'arrêterait au bout de 120 s (code 2). Une PR de découpage qui touche une zone non couverte ajoute d'abord le scénario qui la rend.
2. `npm run build` (`tsc -b`, dont `noUnusedLocals` et `verbatimModuleSyntax`) et `npm run lint`, avec un nombre d'avertissements égal ou inférieur au départ : Admin 10, ChantierDetail 8, Planning 0. Les directives `eslint-disable-next-line` positionnelles (Planning l.126, 137, 153 ; ChantierDetail l.135) restent attachées à leur ligne.
3. `npm run test:unit`, puis les E2E deux fois sur la même base. 134 parcours, dont plus de trente touchent ces trois écrans. Plusieurs de leurs sélecteurs dépendent de la structure du DOM, ce qui en fait aussi une preuve de non-régression du rendu.
4. Un audit indépendant par PR, puis la fusion selon la délégation habituelle (aucun montant ne change).

## Découpage proposé

Les fichiers rejoignent `client/src/components/`, selon la convention actuelle : dossier plat, noms en PascalCase. Exports par défaut (5 composants) et nommés (7) y coexistent ; je propose l'export nommé. La logique sans composant va dans `client/src/lib/`, pour ne pas ajouter d'avertissement `react/only-export-components` (un fichier de composant qui exporte aussi une fonction). Le préfixe nomme l'écran (`Admin…`, `Chantier…`, `Planning…`). Pas de sous-dossier par écran : la convention actuelle est gardée (décision 2).

### PR A : Planning (873 → environ 440 lignes)

Les trois modales ne reçoivent déjà que des props. C'est le cas le plus simple, qui servira à éprouver l'outil de comparaison.

| Nouveau fichier | Contenu déplacé (lignes de `Planning.tsx`) |
|---|---|
| `PlanningPlacementIntervention.tsx` | `ContractPlacement` (433-481), avec `DUREE_CURATIVE_MINUTES` (34-35), qu'il est seul à employer |
| `lib/fileAPlanifier.ts` | `ContractQueueItem` (26-33) et `dateDue` (36-37), qu'emploient la page et la modale de placement |
| `PlanningModaleAffectation.tsx` | `EventModal` (483-754), avec `ModalState` (39-41, exporté), `CATEGORIES` (43-47) et `CRENEAUX` (49-54) |
| `PlanningModaleTypes.tsx` | `TypesModal` (756-871) |

La grille (316-404) reste dans la page : elle partage `dragRef`, `handleDrop`, `eventsCellule` et `setModal` avec le composant.

### PR B : Admin (1 477 → environ 700 lignes)

| Nouveau fichier | Contenu déplacé (lignes d'`Admin.tsx`) |
|---|---|
| `EditeurBareme.tsx` | `EditeurBareme` (20-75), avec `fmtEuro` (12) et `Tranche` (14-18) |
| `ChoixResponsable.tsx` | `ChoixResponsable` (87-144), avec `CompteResume` (85, exporté) |
| `AdminUtilisateurs.tsx` | onglet Utilisateurs (1163-1411) : texte, formulaire « Autoriser un compte », tableau des comptes ; `MESSAGE_COMPTE_SUPERADMIN` et les `DROIT_*` le suivent |
| `AdminMarges.tsx` | onglet Marges et commissions (991-1161) : paramètres, rémunération |
| `AdminReferentiels.tsx` | onglets Intervenants, Fournisseurs et Catégories (736-972), qui partagent l'édition en ligne (`editRow`, `editField`, `saveEdit`, `deleteEntity`, `handleSubmit`) |
| `AdminModules.tsx` | onglet Modules (1413-1471) |

Restent dans la page :
- les états ;
- `fetchData`, le chargement central (202-269). Le parcours E2E `administration-chargement` vérifie sa séquence exacte : rechargement de l'onglet affiché, réponse périmée ignorée, nouveau clic sur Marges ;
- les gestionnaires, la barre d'onglets ;
- les petits onglets Chantiers (680-734) et Société (974-989).

L'onglet Utilisateurs recevra une vingtaine de props : c'est le prix d'un déplacement sans changement d'état.

### PR C : fiche chantier (1 477 → environ 750 lignes)

| Nouveau fichier | Contenu déplacé (lignes de `ChantierDetail.tsx`) |
|---|---|
| `ChantierJournalAchats.tsx` | journal des achats (1021-1159) : filtres, lignes, correction, sous-total |
| `ChantierJournalHeures.tsx` | journal des heures (1163-1288) |
| `ChantierJournalAudit.tsx` | journal d'audit des saisies (1291-1344) |
| `ChantierModaleModification.tsx` | modale « Modifier le chantier » (1349-1472) |
| `ChantierEnTete.tsx` | en-tête (titre, statut, client, dates, commercial modifiable en place), alertes et bannière d'encaissement (695-798), avec `STATUT_LABELS` |
| `ChantierIndicateurs.tsx` | indicateurs clés et factures liées, marge et estimation, barres de progression, répartitions (801-1012), avec `FactureLiee` (exporté : la page l'emploie aussi) |
| `lib/formatsChantier.ts` | `toDateFrancaise`, `fmtDate`, `fmtEuro` et `fmtHeures` (22-32), tels quels : plusieurs sections les emploient |

Restent dans la page, inchangés :
- tous les hooks (avant les retours anticipés l.595 et 601) et les valeurs dérivées de `metrics` (612-653) ;
- la barre d'actions (681-693). Son bouton « Modifier » précède toujours dans le DOM celui du commercial, rendu ensuite par `ChantierEnTete` : plusieurs parcours E2E prennent le premier.

**Estimation et mise en forme des props.** Les six sections reçoivent environ 120 props au total : en-tête 17, indicateurs 20, journal des achats 28, journal des heures 26, journal d'audit 9, modale 21. La page garde environ 690 lignes avant les points d'appel. Les « environ 750 lignes » supposent des props passées en écriture compacte, plusieurs par ligne. Avec une prop par ligne, la page atteindrait environ 820 à 830 lignes, au-delà de la limite : la forme compacte, plusieurs attributs par ligne, est donc retenue pour les points d'appel de cette page.

La page garde environ 600 lignes de hooks et de gestionnaires. Les regrouper en hooks propres (par exemple les filtres d'un journal), appelés au même rang, serait possible plus tard, mais ce ne serait plus un simple déplacement.

La zone exportée en PDF (`ref={printRef}`, 677-1014) garde le même conteneur. Les composants qu'elle contient rendent les mêmes éléments, donc `html2pdf` lit le même DOM.

## Ordre et dépendances

1. Outil de comparaison du rendu (sans déplacement).
2. PR A, Planning.
3. PR B, Admin.
4. PR C, fiche chantier.

Une PR à la fois, chacune depuis `main` à jour, avec le même contrat que pour le serveur : périmètre, plages déplacées, preuves, audit. Le lot pilote 3b (« Ma journée » du technicien) peut avancer en parallèle s'il ne touche pas ces écrans. Sinon, il passe après la PR concernée.

## Hors périmètre de ces PR (à proposer à part si utile)

- **Déplacer l'état dans les composants** : par exemple, que chaque onglet d'Admin charge ses données comme ceux de `Statistiques.tsx`, ou que les filtres des journaux du chantier vivent dans leur composant. Ce serait plus lisible, mais cela changerait la séquence des chargements, que des parcours E2E vérifient, ou le moment où un état se réinitialise. C'est un changement de comportement, donc un lot à part.
- **Petites anomalies relevées pendant le relevé**, à corriger chacune dans sa PR, avec un test :
  - Admin, onglet Intervenants : une branche inaccessible (l.738 et 757-761), `colSpan={4}` pour 5 colonnes (l.832) : #202 ;
  - Admin, onglet Utilisateurs : les options de rôle dupliquées entre le formulaire (l.1194-1204) et le tableau (l.1290-1299) : #203 ;
  - fiche chantier : deux références jamais lues (`editChantierBudgetRef`, `editChantierAdresseRef`, l.97-98), alors que le commentaire l.94-96 annonce un préremplissage qui n'existe pas : #204 ;
  - utilitaires de format dupliqués entre écrans (`fmtEuro`, `fmtHeures`, `toDateFrancaise`, alors que `jourFrancais` existe dans `lib/dateFormatting.ts`) : #205 ;
  - lecture du rôle : Planning et la fiche chantier lisent `localStorage.user` directement, quand Admin passe par `getCurrentUser` et `useCurrentRole` : #206.

## Décisions du 18-10-2026

Réponse de Nelson aux trois questions de la proposition : « 1. Oui je valide le principe. Oui a plat comme aujourd'hui. Fait ce qui est le mieux a corriger apres ou en issu je te laisse le choix de la meulleur des facon. »

1. **Principe validé par Nelson** : déplacement pur, état laissé dans la page. **Ordre retenu par Claude Code**, Nelson ne s'étant pas prononcé sur ce point de la question : outil de comparaison du rendu, puis Planning, Admin et fiche chantier.
2. **Fichiers dans `components/`, à plat**, comme aujourd'hui (décision de Nelson).
3. **Petites anomalies** : le seul point délégué par Nelson. Chacune a son issue : #202, #203, #204, #205 et #206. Sa correction vient **après** les trois PR de déplacement, dans sa propre PR avec un test. Corriger pendant un déplacement fausserait la preuve d'un rendu identique.
