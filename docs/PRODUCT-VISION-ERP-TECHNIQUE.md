# Iris — Vision produit et parcours métier

## Principe directeur

Iris est un ERP **natif**, simple et fluide pour les métiers techniques. Il ne dépend ni d'Odoo ni d'un autre ERP pour les clients, devis, factures, interventions, contrats ou paiements.

Une action doit toujours répondre à trois questions visibles à l'écran : **pour quel client, sur quel site, et à quelle étape du processus ?**

## Référentiel métier unique

```text
Client
├── Contacts
├── Sites
│   ├── Site de facturation
│   ├── Site d'intervention SAV
│   └── Site de travaux
├── Devis et versions de devis
├── Contrats et abonnements
├── Interventions / chantiers
└── Factures, paiements et rapprochements
```

- Le client est une société ou un particulier enregistré dans Iris.
- Les contacts sont des personnes, distinctes du client et des adresses.
- Les sites sont des lieux physiques. Un même client peut avoir plusieurs sites et les rôles **facturation** et **intervention** peuvent être différents.
- Le registre public des entreprises ne fait que préremplir une fiche : la source de vérité reste Iris.

## Flux commercial et financier

```text
Client → Devis → Versions → Acceptation/refus
       → Intervention ou chantier → Réalisation / rapport / signature
       → Facture → Paiement → Rapprochement bancaire → Soldé
```

### Devis

- Un devis est attaché à un client, un contact et un site d'intervention.
- Toute modification après émission crée une version traçable ; la version acceptée est figée.
- La transformation en intervention, chantier, contrat ou facture se fait depuis le devis, sans ressaisie.

### Facturation

- Une facture référence le client et son site de facturation.
- Elle peut provenir d'un devis, d'un chantier, d'une intervention, d'un contrat ou d'un abonnement.
- Son état reste lisible : brouillon, émise, partiellement réglée, réglée, échue, annulée.
- Le rapprochement bancaire associe un mouvement bancaire à une ou plusieurs factures sans modifier l'historique comptable.

## Interventions et chantiers

Iris distingue le **type de travail** sans disperser l'utilisateur dans des applications différentes :

- **SAV** : demande, diagnostic, déplacement, rapport, signature, éventuellement facturation.
- **Travaux / chantier** : devis accepté, phases, heures, matériel, sous-traitance, avancement, réception et facture.
- **Maintenance planifiée** : contrat, équipement/site concerné, cadence et durée prévisionnelle.

Chaque intervention possède un statut simple : à planifier, planifiée, en cours, rapport à compléter, terminée, facturée/à facturer.

## Maintenance cyclique

Un contrat de maintenance définit notamment :

- client et site(s) concernés ;
- périodicité : mensuelle, trimestrielle, semestrielle, annuelle ou règle personnalisée ;
- durée prévisionnelle ;
- fenêtre de réalisation ;
- technicien/compétence souhaitée ;
- prestations, équipements et checklist.

Le moteur de récurrence génère des **interventions à planifier**, sans créer de faux rendez-vous définitif. Le responsable planning voit une file claire :

```text
À planifier → échéance → client → site → durée estimée → compétence → contrat
```

En plaçant l'intervention dans le planning, la durée estimée est préremplie automatiquement ; le responsable choisit simplement le technicien, la date et l'heure, puis peut ajuster.

## Microsoft 365, comptabilité et conformité

- Les utilisateurs se connectent avec Microsoft Entra ID et peuvent autoriser Outlook pour les événements Iris et l'envoi de leurs documents métier.
- Iris journalise ses propres communications client (devis, facture, rapport, rappel) sans lire la boîte de réception par défaut.
- Les paramètres comptables sont configurables par installation et génèrent des exports pour le cabinet externe ; Iris ne dépend pas du logiciel comptable.
- Le module Facturation doit être conçu pour la facturation électronique française : facture structurée, piste d'audit, formats Factur-X/UBL/CII et adaptateur de plateforme agréée.

Détail d'architecture : [`docs/INTEGRATIONS-M365-COMPTABILITE-FACTURATION-FR.md`](INTEGRATIONS-M365-COMPTABILITE-FACTURATION-FR.md). Les règles de personnalisation des modèles documentaires et e-mails sont définies dans [`docs/ADMINISTRATION-DOCUMENTS-EMAILS.md`](ADMINISTRATION-DOCUMENTS-EMAILS.md).

## UX : règles non négociables

1. **Une seule source de vérité** : aucune double saisie entre devis, intervention, facture et paiement.
2. **Contexte permanent** : client, site, statut et prochaine action restent visibles dans chaque écran métier.
3. **Progressive disclosure** : l'utilisateur voit d'abord ce qui est utile à son rôle ; les détails restent accessibles sans encombrer l'écran.
4. **Actions naturelles** : « créer une intervention depuis ce devis », « planifier », « générer la facture », jamais des menus techniques.
5. **Navigation courte** : retour direct vers fiche client, site, document parent et historique.
6. **Mobile technicien dédié** : planning du jour, intervention, rapport, signature ; pas d'interface comptable réduite sur mobile.
7. **Historique traçable** : versions de devis, changements de statut, planification, rapports, factures et règlements.

## Catalogue initial et politique de prix

Chaque instance Iris démarre avec un **catalogue vide** : aucun article, équipement ou prestation n'est imposé ni préchargé. Le client crée son propre référentiel et paramètre librement, par ligne, ses références, prix d'achat HT, prix de vente HT, TVA, unités, durées indicatives et donc sa politique de marge matériel. Iris fournit le cadre et les calculs ; il ne prescrit ni tarifs ni marges.

## Ordre de construction fonctionnel

1. Référentiel Iris : clients, contacts, sites.
2. Devis versionnés et catalogue de prestations/articles.
3. Intervention SAV et planning.
4. Chantiers/travaux depuis devis accepté.
5. Contrats et générateur de maintenance cyclique.
6. Facturation liée aux documents métier.
7. Paiements et rapprochement bancaire.
8. Abonnements télécom et financeurs, sur le même moteur de contrats/facturation.
