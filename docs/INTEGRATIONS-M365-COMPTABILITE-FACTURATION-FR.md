# Iris — Microsoft 365, comptabilité et facturation électronique française

## Décision produit

Iris reste le système de référence des clients, devis, interventions, contrats, factures et paiements. Microsoft 365, le cabinet comptable, la banque et la plateforme de facturation électronique sont des **connecteurs**, jamais la source de vérité métier.

## Microsoft 365 via Microsoft Graph

### Identité

Tous les utilisateurs continuent de se connecter à Iris avec Microsoft Entra ID. Les autorisations Graph sont demandées séparément, avec consentement et moindre privilège.

### Calendrier Outlook — première intégration

Iris crée ou met à jour uniquement les événements qu'il gère : interventions, rendez-vous client et maintenances planifiées.

- permission déléguée : `Calendars.ReadWrite` ;
- événement créé dans le calendrier de l'utilisateur concerné ;
- Iris conserve l'identifiant Graph de l'événement pour modifier ou annuler le bon rendez-vous ;
- date, heure, durée prévisionnelle, client, site, intervenant et lien vers la fiche Iris sont synchronisés ;
- Iris ne synchronise pas tout le calendrier Outlook au départ : moins de bruit, moins de risques de conflit et meilleure confidentialité.

### E-mail et historique client — première intégration

Iris envoie les devis, factures, rappels et comptes rendus via le compte Microsoft de l'utilisateur.

- permission déléguée minimale : `Mail.Send` ;
- le message est sauvegardé dans les éléments envoyés Outlook de l'utilisateur ;
- Iris enregistre un journal de communication lié au client, contact, site et document concerné : date, expéditeur, destinataire, objet, identifiant Graph et statut d'envoi ;
- une copie PDF du devis ou de la facture est attachée ou référencée dans l'historique Iris ;
- le contenu d'une boîte de réception ne sera **pas aspiré** par défaut.

Pour les e-mails entrants, la première version proposera l'action explicite **« Ajouter à l'historique Iris »**. Une synchronisation automatisée ou une boîte support partagée est une évolution optionnelle, nécessitant une décision RGPD, une politique de rétention et des autorisations dédiées (`Mail.Read`).

## Comptabilité externe

Iris ne tente pas de remplacer le logiciel de l'expert-comptable au lancement. Il produit des données comptables propres et paramétrables.

### Paramétrage par installation

- plan de comptes de vente par famille d'articles/prestations ;
- comptes TVA par taux et règles fiscales ;
- compte client collectif et règles de ventilation ;
- journaux de ventes, règlements et banque ;
- codes analytiques éventuels ;
- format/export sélectionné pour le cabinet : CSV structuré d'abord, adaptateurs Sage/Cegid/EBP ensuite selon besoin réel.

Une facture émise est immuable : une correction passe par avoir ou document correctif, jamais par réécriture silencieuse. Chaque export est journalisé avec période, écritures et statut.

## Facturation électronique française

### Calendrier connu au 4 septembre 2026

- **1er septembre 2026** : toutes les entreprises assujetties concernées doivent pouvoir recevoir des factures électroniques ; émission obligatoire pour grandes entreprises et ETI.
- **1er septembre 2027** : émission obligatoire pour PME et micro-entreprises.

Les règles exactes dépendent du statut fiscal et doivent être validées avec le cabinet comptable de chaque client au déploiement.

### Architecture Iris à prévoir dès le module Facturation

1. Numérotation continue et contrôlée, documents figés après émission, avoirs et piste d'audit.
2. Données structurées complètes : SIREN/SIRET, TVA, adresses facturation, lignes, taxes, conditions de paiement, références documentaires.
3. Génération interne d'un modèle canonique de facture, indépendant du PDF et de tout prestataire.
4. Exports **Factur-X**, **UBL** et **CII** selon les profils requis par la réforme.
5. Adaptateur `ElectronicInvoicingProvider` : une plateforme agréée (PA, anciennement PDP) est choisie par installation/client et connectée via API ; Iris ne se lie pas au code d'un seul prestataire.
6. Journal des statuts de cycle de vie : déposée, transmise, reçue, rejetée, encaissée, avec preuve et horodatage.
7. E-reporting et annuaire destinataire pris en charge par l'adaptateur de plateforme quand le périmètre le nécessite.

## Garde-fous de simplicité

- D'abord envoyer un devis, planifier une intervention et facturer clairement.
- Une seule fiche chronologique client, alimentée par des événements liés, pas par une copie complète de la boîte Outlook.
- Un écran « Connecteurs » par installation : Microsoft 365, banque, cabinet comptable, plateforme agréée.
- Chaque connecteur est facultatif, activable par `SUPERADMIN`, et son absence ne bloque pas le travail quotidien.
- Les permissions Microsoft sont minimales et demandées progressivement, au moment où la fonction est activée.
