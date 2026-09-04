# Iris — Administration des documents et e-mails

## Centre d'administration

Le centre **Administration** regroupe les éléments personnalisables de l'installation, sans exposer les réglages plateforme :

- identité légale, coordonnées, logo, couleurs et mentions obligatoires ;
- numérotation des documents ;
- modèles de devis, factures, avoirs, bons d'intervention et rapports ;
- modèles d'e-mails ;
- paramètres comptables, TVA et connecteurs autorisés.

Les documents déjà émis restent figés. Modifier un modèle ne change jamais un devis, une facture ou un e-mail déjà envoyé.

## Modèles de documents

Chaque type possède un modèle par défaut, rendu avec la charte de la société : en-tête, logo, couleurs, coordonnées, mentions légales, conditions et pied de page.

La personnalisation doit rester sûre : blocs et variables autorisées plutôt qu'un éditeur HTML libre sans contrôle.

Exemples de blocs :

- identité émetteur et destinataire ;
- adresses de facturation et d'intervention ;
- lignes, taxes, totaux et échéances ;
- conditions générales, RIB et mentions réglementaires ;
- signature, photos et checklist pour les rapports.

## Modèles d'e-mails et variables

Un modèle est attaché à un usage métier : envoi de devis, relance de devis, envoi de facture, relance de facture, compte rendu d'intervention, maintenance à planifier.

Les variables sont typées et affichées dans un sélecteur, par exemple :

```text
{{client.raisonSociale}}
{{contact.nomComplet}}
{{document.reference}}
{{document.montantTtc}}
{{document.dateEcheance}}
{{facture.soldeDu}}
{{site.nom}}
{{site.adresseComplete}}
{{societe.raisonSociale}}
{{societe.telephone}}
```

Avant l'envoi, Iris affiche un aperçu rendu avec les données réelles et permet une modification ponctuelle. Le rendu final, les variables résolues, les destinataires, les pièces jointes et l'identifiant d'envoi Microsoft Graph sont conservés dans l'historique client.

## Garde-fous

- une variable inconnue bloque la publication du modèle ;
- les variables sensibles ou non pertinentes ne sont jamais proposées ;
- les montants et dates utilisent les formats français ;
- les mentions obligatoires et le numéro de facture ne peuvent pas être masqués d'un modèle réglementé ;
- une relance ne peut être envoyée qu'à un contact disposant d'une adresse e-mail ;
- les badges contact sont visibles dans la fiche client : décisionnaire et signataire peuvent être cumulés, et plusieurs contacts peuvent posséder chaque rôle.
