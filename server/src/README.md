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
  - `node scripts/routes.mjs --verifier` compare les routes enregistrées (ordre, méthode, chemin, chaîne des gardes) à `scripts/routes-reference.txt`, écrit depuis `main` avant le découpage. La CI le rejoue.
  - `node scripts/verifier-deplacement.mjs origin/main` vérifie qu'aucune ligne de la base n'a disparu, liste les seules lignes ajoutées et indique d'où vient chaque bloc déplacé.
- **Aucun test modifié.** `index.ts` ré-exporte ce que les tests importent de `dist/index.js`.
- **Pas de dépendance circulaire.** Un module importe `db`, `http`, `droits`, `commun` ou la logique d'un autre domaine, jamais `index.ts`.
- **Logique métier.** Les fonctions déjà séparées des routes passent dans le `metier.ts` de leur domaine. La logique écrite dans le corps d'un gestionnaire y reste pendant le découpage, puisque l'en extraire changerait du code ; son extraction sera proposée ensuite, domaine par domaine, si elle est utile.
- **Taille.** Aucun fichier de code applicatif ne dépasse environ 800 lignes (`CLAUDE.md`).

## Ordre prévu des PR (proposition)

1. Socle (`env`, `db`, rôles, authentification, gardes de type de compte, `paramId`), scripts de preuve, et domaine `referentiels`.
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
