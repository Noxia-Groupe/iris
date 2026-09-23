# Audit fonctionnel et technique d'Iris — 23/09/2026

> Relu sur `main` à `4437cba` (PR #71). Tout ce qui est affirmé ici a été vérifié dans le
> code, le schéma Prisma ou par exécution — pas de mémoire.
>
> **Exécution** : `tsc` serveur et client sans erreur ; `npm test` serveur **194/194 verts**
> contre un PostgreSQL 16 jetable (migrations appliquées de zéro).

Ce document complète [`PRODUCT-VISION-ERP-TECHNIQUE.md`](PRODUCT-VISION-ERP-TECHNIQUE.md)
et la roadmap du [`README`](../README.md). Il confronte la cible — un ERP complet pour
métiers techniques — à ce qui existe réellement, puis propose un ordre de construction.

---

## 1. Ce qu'Iris doit être

Un ERP **natif, mono-société par instance**, pour des entreprises d'installation et de
maintenance (vidéo, alarme, contrôle d'accès, réseau, télécom…). Il doit couvrir tout le
cycle :

```text
Client/Site ─► Devis personnalisé ─► Chantier (planning, heures, achats, rentabilité)
          │                       └► Contrat de maintenance / abonnement (récurrence)
          │                       └► Financement locatif (Grenke, LPB…)
          └► SAV (ticket, intervention, coût, rentabilité par client)
                         ▼
          Facture / avoir ─► Paiement ─► Rapprochement ─► Export comptable
```

Avec une interface **aux couleurs et au logo de la société cliente**, une app mobile
technicien, et Microsoft Entra ID comme unique porte d'entrée humaine.

---

## 2. Tableau de couverture

Légende : ✅ livré et testé · 🟡 socle présent, incomplet · ❌ absent

| Domaine | État | Constat vérifié |
|---|---|---|
| Authentification Entra ID, secours, clés API | ✅ | JWKS/RS256, liste blanche, break-glass 1 h, clés à scopes révocables. |
| Rôles et permissions | 🟡 | `SUPERADMIN/ADMIN/CONDUCTEUR_TRAVAUX/COMMERCIAL` en place ; `TECHNICIEN`, `COMPTABLE`, `ASSISTANTE_COMMERCIALE`, `DIRECTEUR_COMMERCIAL` décidés (`MODELE-DROITS-COMPTES.md`) mais non livrés. `role` est une chaîne libre, pas un enum. |
| Société (identité légale, fuseau) | ✅ | `CompanySettings` singleton, registre des entreprises. |
| **Branding (couleurs + logo)** | 🟡 | Couleurs et `logoUrl` **stockées mais appliquées uniquement au PDF de facture**. L'interface garde les couleurs Noxia codées en dur dans `client/src/index.css` (`--color-primary: #002359`…). Aucun composant React ne lit `couleurPrimaire`. |
| Clients / contacts / sites | ✅ | Rôles de site facturation/intervention, désactivation non destructive. |
| Catalogue + parc installé | ✅ | Prestations, articles (prix d'achat), équipements, n° série/IMEI/MAC, garantie. |
| **Devis** | 🟡 | Numérotation d'affaire, versions, statuts, acompte figé, annulation, duplication, conversion → chantier. **Voir §3.1 : le contenu d'un devis ne peut pas être modifié.** Pas de PDF, pas de lien catalogue. |
| Chantiers : achats, heures, marge | ✅ | Budget vendu vs réel, archivage tracé, journal avant/après, périmètres par rôle. |
| Rentabilité chantier | 🟡 | Marge calculée côté serveur ; `LigneBudgetPrevisionnel` (budget par poste) toujours inutilisée ; pas de suivi d'avancement % ni de reste à dépenser par poste. |
| Planning | 🟡 | Événements, types, créneaux, partage public, placement d'intervention. Pas de vue par compétence ni de détection de surcharge. |
| Interventions SAV | 🟡 | Références, priorité, affectations, rapport, signature par empreinte. **Aucun coût possible** (§3.2). Pas de notion de ticket / demande entrante, ni de SLA. |
| Contrats de maintenance | 🟡 | Périodicité en mois, échéance, génération manuelle d'intervention. **Aucun montant, aucune facturation récurrente, aucun renouvellement, aucune génération automatique** (pas de tâche planifiée dans le serveur). |
| Facturation | ✅/🟡 | Multi-lignes, numérotation chronologique, mentions légales versionnées figées, PDF, avoirs totaux/partiels, ventilation TVA, plan comptable, export CSV. Manque : Factur-X/UBL, factures d'acompte et de situation, relances. |
| **Abonnements télécom** | ❌ | Aucun modèle. |
| **Financement (Grenke, LPB…)** | ❌ | Aucun modèle. |
| Paiements / rapprochement bancaire | ❌ | L'acompte est constaté à la main. |
| **Coût SAV par client / global** | ❌ | Impossible faute de coûts imputables aux interventions (§3.2). |
| Stock | ❌ | `CatalogueArticle.stockActuel` existe, aucune route ne le fait bouger. |
| Commandes fournisseurs | ❌ | Les achats sont saisis a posteriori. |
| Mobile technicien | ❌ | Aucun écran dédié. |
| Commissions configurables | 🟡 | Barème global en base ; profils individualisés (#15) à faire. |

---

## 3. Écarts bloquants pour la cible métier

### 3.1 Un devis ne peut pas être modifié — la révision est une copie à l'identique

`creerRevision` (`server/index.ts`, bloc « Devis ») recopie les lignes et totaux de la
version précédente ; **aucune route ne modifie les lignes** d'un devis (seuls `statut`,
acompte et annulation passent par `devis.update`). Côté écran, `Devis.tsx` n'offre qu'un
formulaire de création.

Conséquence : pour corriger une quantité, il faut dupliquer — ce qui crée un **nouveau
numéro d'affaire**, contraire à la vision (« toute modification après émission crée une
version traçable »).

**À faire** : `PUT /api/devis/:id` réservé au statut `BROUILLON` (remplacement des lignes,
recalcul serveur) ; la révision d'un devis `ENVOYE`/`REFUSE` crée la version N+1 en
brouillon **éditable**.

### 3.2 Les coûts ne peuvent être imputés qu'à un chantier

`PointageHeure.chantierId` et `AchatReel.chantierId` sont **obligatoires**. Une intervention
SAV ou de maintenance ne peut donc porter ni heure, ni pièce, ni déplacement. C'est ce qui
rend impossibles :

- le coût d'un SAV, par client et global ;
- la rentabilité d'un contrat de maintenance (coût réel vs montant facturé) ;
- la vérification « sous garantie / hors garantie » d'une intervention.

**Recommandation** : rendre `chantierId` optionnel et ajouter `interventionId` optionnel,
avec une contrainte SQL `CHECK (num_nonnulls("chantierId", "interventionId") = 1)` : chaque
coût a exactement un porteur. Les règles de périmètre, d'archivage et de journal déjà
écrites pour Travaux s'appliquent telles quelles. Ajouter aussi sur l'intervention :
temps de trajet, kilomètres, pièces consommées (liées au catalogue → mouvement de stock).

### 3.3 Le contrat de maintenance n'a pas d'argent

`ContratMaintenance` n'a ni prix, ni périodicité de facturation, ni date de fin, ni
reconduction, ni indexation. La facturation récurrente — cœur d'un modèle
maintenance/abonnement — n'a donc aucune base.

### 3.4 Le branding n'atteint pas l'interface

Les couleurs de `CompanySettings` doivent être injectées comme variables CSS au démarrage
(`document.documentElement.style.setProperty('--color-primary', …)`), avec calcul des
teintes dérivées et du contraste du texte, et le logo affiché dans la barre latérale,
l'écran de connexion et le favicon. Le README exclut l'hébergement de médias : le logo
peut être stocké **en base** (≤ 200 Ko, PNG/SVG assaini) plutôt que par URL externe, qui
casse dès que le site du client change.

---

## 4. Modules à concevoir

### 4.1 Moteur de récurrence unique (contrats + abonnements)

La vision prévoit que abonnements et financeurs reposent « sur le même moteur de contrats
/ facturation ». Proposition :

```text
Contrat (client, site, type: MAINTENANCE | ABONNEMENT | LOCATION, statut, dateDebut,
         dateFin, dureeEngagementMois, reconductionTacite, preavisJours,
         indexation: aucune | Syntec | taux fixe, dateProchaineIndexation)
 ├── ContratLigne (catalogue, quantité, PU HT, TVA, periodiciteFacturation,
 │                 termeEchu | termeAEchoir, prorataPremierePeriode)
 ├── ContratPlanMaintenance (périodicité, durée prévue, compétence, checklist,
 │                           équipements couverts)          ← l'actuel ContratMaintenance
 └── EcheanceFacturation (période, montant figé, factureId?)  ← idempotence
```

Un **job quotidien** (dans le conteneur serveur, ou conteneur `worker` dédié) :

1. génère les interventions à planifier dont l'échéance entre dans la fenêtre ;
2. génère les factures récurrentes **en brouillon** (validation humaine avant émission, au
   moins au début) ;
3. signale les contrats à renouveler / résilier (préavis) et les indexations dues.

L'unicité `(contratId, periode)` sur `EcheanceFacturation` garantit qu'un job rejoué ne
facture jamais deux fois.

Pour le télécom : `LigneTelecom` (n° SIM/ICCID, n° de ligne, opérateur, forfait, statut
ACTIVE/SUSPENDUE/RÉSILIÉE, date de portabilité) rattachée à un contrat `ABONNEMENT` et à
un `EquipementInstalle` (routeur 4G/box).

### 4.2 Financement locatif (Grenke, LPB…)

Le schéma type de la location financière : Iris vend le matériel **au financeur**, qui
loue au client final ; l'entreprise peut garder une prestation de maintenance facturée à
part.

```text
Financeur (raison sociale, SIREN, contact, coefficients par durée/palier, délai de
           paiement moyen)
DossierFinancement (financeur, client, devis/chantier, statut: ÉTUDE → ACCORD → PV_SIGNÉ
                    → PAYÉ | REFUSÉ | EXPIRÉ, montantFinance, durée, périodicité,
                    loyer, coefficient figé, n° de dossier financeur, dateAccord,
                    dateFinContrat, VR/option d'achat)
 ├── équipements financés (EquipementInstalle[])
 └── documents attendus (PV de livraison, mandat SEPA…) : case + date, pas de fichier
```

Points métier indispensables :

- la **facture de vente au financeur** (client de facturation = financeur, site de livraison
  = client final) — les sites facturation/intervention distincts existent déjà ;
- le **simulateur de loyer** dans le devis (montant × coefficient du palier) pour vendre en
  mensualité ;
- l'alerte de **fin de contrat** (N mois avant) = opportunité de renouvellement du parc ;
- la créance financeur suivie jusqu'au paiement (rapprochement §4.5).

### 4.3 SAV complet

- **Demande / ticket** avant l'intervention : canal, symptôme, équipement concerné
  (parc installé), sous contrat ou non, garantie calculée depuis `garantieJusquAu`.
- **SLA** issus du contrat (délai d'intervention / de rétablissement) et échéance affichée.
- **Coûts** (§3.2) + **refacturation** : forfait déplacement, heures, pièces ; ou « inclus au
  contrat » tracé à 0 € mais coûté.
- **Tableaux de bord** : coût SAV par client, par site, par type d'équipement, par
  technicien ; ratio coût SAV / CA contrat (rentabilité du contrat) ; taux de retour
  (même équipement en SAV sous N jours) ; délai moyen de résolution.

### 4.4 Devis personnalisés

- Édition des lignes en brouillon (§3.1), **sélection depuis le catalogue** (prix de vente
  et prix d'achat prérempli, modifiable), lignes libres conservées.
- **Sections / titres, sous-totaux, lignes optionnelles, remise ligne et globale.**
- **Marge prévisionnelle visible** en édition (réservée aux rôles habilités, comme la marge
  chantier aujourd'hui).
- **Contact et site d'intervention** sur le devis (la vision l'exige, le modèle ne l'a pas).
- Date de validité, conditions de paiement, échéancier d'acompte.
- **PDF de devis** aux couleurs de la société (réutiliser le moteur `pdfkit` de la facture),
  avec textes d'introduction/conclusion **par modèle de devis** paramétrable
  (`ADMINISTRATION-DOCUMENTS-EMAILS.md`), et bloc « Financement : xx €/mois sur 60 mois ».
- Signature électronique simple (lien public à jeton, nom + horodatage + empreinte, comme
  `InterventionSignature`) → passage automatique en `ACCEPTE`.
- Conversions aval manquantes : devis → contrat, devis → intervention, devis → facture
  d'acompte.

### 4.5 Paiements et rapprochement

`Paiement` (date, montant, mode, référence) ventilé sur 1..n factures (`PaiementAffectation`)
→ statut `PARTIELLEMENT_REGLEE` calculé. Import de relevés CAMT.053/OFX, puis agrégateur
bancaire en seconde étape. Relances automatiques paramétrables. Le constat manuel
d'acompte devient un `Paiement` lié au devis.

### 4.6 Rentabilité et pilotage

- Chantier : exploiter `LigneBudgetPrevisionnel` (généré depuis les sections du devis),
  avancement %, reste à engager, marge à terminaison projetée.
- Tableau de bord direction : CA facturé/encaissé, carnet de commandes, récurrent mensuel
  (MRR) des contrats et abonnements, encours financeurs, coût SAV, marge par activité.

---

## 5. Dette technique et risques

| Priorité | Sujet | Constat |
|---|---|---|
| Haute | Monolithe serveur | `server/index.ts` = **5 253 lignes**, toutes les routes et règles dans un seul fichier. Chaque nouveau module aggrave les conflits entre agents. Découper par domaine (`routes/devis.ts`, `domain/facturation.ts`…) **avant** d'attaquer contrats/abonnements/financement. |
| Haute | Statuts et rôles en `String` | `role`, `statut`, `nature`, `type` sont des chaînes libres : la base accepte `"ACCPETE"`. Passer aux `enum` Prisma ou à des `CHECK` SQL. |
| Moyenne | Dépendance `xlsx@0.18.5` | Déclarée dans `server/package.json` mais **plus importée nulle part** ; cette version npm n'est plus maintenue et porte des CVE connues (pollution de prototype, ReDoS). La retirer. |
| Moyenne | `cors()` ouvert | `app.use(cors())` sans liste d'origines ; faible risque derrière nginx en même origine, mais à borner par variable d'environnement. |
| Moyenne | Donnée dupliquée | `Chantier.client` (texte) coexiste avec `clientId` ; `PlanningEvent.client/adresse` idem. Source de divergence dès qu'un client est renommé. |
| Moyenne | UX `window.prompt` / `alert` | 66 occurrences dans le client (constat d'acompte, motifs d'annulation…). Remplacer par des modales avec validation. |
| Moyenne | Grosses pages | `Admin.tsx` 1 362 l., `ChantierDetail.tsx` 1 307 l. |
| Basse | Pagination | Listes devis, factures, interventions sans pagination ; export comptable chargé en mémoire. |
| Basse | Marque Noxia dans le client | Favicon et couleurs par défaut Noxia : acceptable comme valeurs par défaut, à surcharger par instance (§3.4). |

Points forts à préserver : tests qui exécutent le code (règle explicite du README),
arrondis monétaires en entiers (`BigInt`), gel des mentions légales et des taux au fait
générateur, archivage au lieu de suppression, journal avant/après, même handler pour
l'interface et `/api/v1`, CI qui valide les gardes PostgreSQL.

---

## 6. Ordre de construction recommandé

Chaque étape est livrable et utile seule ; l'ordre suit les dépendances.

1. **Fondations** (court) — découper `index.ts` par domaine sans changer de comportement
   (les 194 tests servent de filet) ; enums de statuts ; retrait de `xlsx` ; branding
   appliqué à l'interface (§3.4).
2. **Devis personnalisés** — édition brouillon, catalogue, sections/options/remises,
   contact/site, PDF de devis, modèles de textes, signature en ligne (§4.4).
3. **Coûts imputables aux interventions** (§3.2) — débloque SAV et rentabilité contrats.
4. **SAV complet** — demande/ticket, garantie, SLA, refacturation, tableaux de coût (§4.3).
5. **Moteur de contrats récurrents** — lignes tarifées, échéances de facturation,
   indexation, reconduction, job quotidien (§4.1). Migration de `ContratMaintenance`.
6. **Abonnements télécom** sur ce moteur (lignes, SIM, suspension, résiliation).
7. **Financement locatif** — financeurs, dossiers, simulateur dans le devis, facture au
   financeur, alertes de fin (§4.2).
8. **Paiements, relances, rapprochement** (§4.5).
9. **Mobile technicien** — planning du jour, intervention, pièces/heures, rapport, signature.
10. **Pilotage** — tableaux de bord direction, MRR, rentabilité consolidée (§4.6) ;
    Factur-X et plateforme agréée (échéance légale de réception au 1ᵉʳ septembre 2026
    déjà passée, émission obligatoire pour les PME/TPE au 1ᵉʳ septembre 2027).

Les phases 5 à 12 du README restent valables ; cet ordre les précise en plaçant
**devis** et **coûts SAV** avant la récurrence, car tous les modules suivants en dépendent.
