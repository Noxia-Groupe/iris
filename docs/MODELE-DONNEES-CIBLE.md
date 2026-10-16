# Modèle de données cible : contrats récurrents, règlements, banque, commissions

> **Proposition à valider par Nelson (16-10-2026). Rien n'est implémenté.** Ce squelette vérifie que la facturation et les commissions n'auront pas à être refaites quand viendront les abonnements, les locations, les paiements et la banque. Il ne fixe aucune règle de prix, de commission ou de conformité : les champs dont la règle n'est pas décidée restent sans valeur par défaut métier.

## Principes

- La `Facture` actuelle reste le **seul document facturé**, avec ses montants figés, sa numérotation et ses avoirs. Règlements, banque et contrats s'y raccordent par des liens ; ils ne la réécrivent jamais.
- Toute écriture d'argent est **immuable** : une erreur se corrige par une contre-écriture motivée et journalisée, jamais par une modification.
- Une génération récurrente (échéances, visites) est **idempotente** : une clé unique empêche les doublons.
- Les montants qui ouvrent une commission sont **figés au fait générateur**, avec la version du plan appliqué.

## Contrats récurrents (lot (k), décisions A4)

| Entité | Rôle | Champs principaux |
|---|---|---|
| `Contrat` | engagement commercial récurrent | client, site de facturation, type (`MAINTENANCE`, `ABONNEMENT`, `LOCATION`), statut, commercial, date de signature, date de début, durée d'engagement (12 à 60 mois), périodicité de facturation, terme (`ECHU` ou `A_ECHOIR`, au choix), reconduction (tacite ou non, au choix), financeur (pour une location) |
| `ContratLigne` | ce qui est facturé | désignation, référence au catalogue, quantité, prix unitaire HT, TVA, dates d'effet. Un changement de prix crée une nouvelle ligne datée ; l'ancienne reste. |
| `RevisionContrat` | augmentation automatique, désactivable | mode (`AUCUNE`, ou le calcul par défaut à préciser), paramètres du calcul, date anniversaire, et l'historique de chaque révision appliquée (avant, après, auteur). Modifiable contrat par contrat. |
| `EcheanceContrat` | échéancier | contrat, période (unique par contrat), date de facturation prévue, montant figé, statut (`A_FACTURER`, `FACTUREE`, `ANNULEE`), facture produite |
| `ContratMaintenance` (existant) | visites de maintenance | gagne un lien facultatif vers `Contrat` : le moteur de visites et la file à planifier ne changent pas |

`Facture` gagne deux origines facultatives, `contratId` et `echeanceId`. Une échéance ne produit qu'une facture.

**Location et financeurs** : `Financeur` porte l'identité de l'organisme (par exemple Grenke). Une location est facturée par le financeur, un abonnement par l'entreprise à son client (A4). Les simulations passeront par l'API du financeur ; elles ne créent rien dans Iris tant qu'elles ne sont pas acceptées (`SimulationFinancement` : contrat ou devis, financeur, paramètres envoyés, réponse reçue, date).

## Règlements (lot pilote 1, décision A3)

| Entité | Rôle | Champs principaux |
|---|---|---|
| `Reglement` | un encaissement reçu | payeur (client), date civile, montant, moyen de paiement (liste paramétrable), référence, auteur, statut (`ENREGISTRE` ou `CONTREPASSE`, avec motif) |
| `AffectationReglement` | répartition sur les factures | règlement, facture, montant. Elle permet les règlements partiels et les règlements de plusieurs factures. |

- Le **reste dû** d'une facture se calcule : TTC moins ses avoirs, moins ses affectations. Les statuts « partiellement réglée » et « réglée » s'en déduisent, au lieu de la transition manuelle actuelle « Réglée ».
- L'**encaissé** qui ouvre une commission se déduit des règlements, et non plus de la case `Chantier.encaisse`.
- Les écritures d'encaissement sont scellées comme celles des factures. Les comptes (banque, clients) se paramètrent par les règles comptables existantes, sans compte imposé.

## Banque et rapprochement (après le pilote)

| Entité | Rôle | Champs principaux |
|---|---|---|
| `CompteBancaire` | compte de l'entreprise | libellé, IBAN masqué, compte comptable |
| `ImportReleve` | relevé importé | compte, format (CSV, OFX ou CAMT.053), empreinte du fichier (pas d'import en double), période, auteur |
| `MouvementBancaire` | une ligne du relevé | date d'opération, date de valeur, montant signé, libellé, référence, empreinte unique, statut |
| `RapprochementLigne` | lien mouvement ↔ règlement | mouvement, règlement, montant. Le lien va dans les deux sens, ce qui couvre une remise de plusieurs chèques. |

Rapprocher ne modifie jamais une facture. Le prélèvement SEPA demanderait un `MandatSepa` (données sensibles) : seulement sur décision.

## Commissions (lot (i), décisions A5)

| Entité | Rôle | Champs principaux |
|---|---|---|
| paramètre général | fait générateur | commande, fin des travaux ou réception du paiement complet |
| `PlanCommercial` | un plan et son barème | nom, barème propre, versions datées |
| `AttributionPlan` | plan d'un commercial | commercial, plan, date d'effet. Un changement prend effet à cette date, sans rétroactivité. Un commercial sans attribution n'a pas de commission. |
| `CommissionCalculee` | commission figée | commercial, source (affaire, contrat ou échéance), montant de base, plan et version appliqués, fait générateur, mois de rattachement |

Ce dont les commissions ont besoin existe dans le squelette :
- le commercial du contrat et de l'affaire ;
- la date de signature ;
- les montants figés par échéance ;
- les encaissements par facture.

Une commission « en développé » se calcule sur la somme des échéances prévues, une commission « à la prise de commande » sur les lignes du contrat. Aucune des deux ne demande de refaire la facturation.

## Points encore ouverts

- Le calcul d'augmentation proposé par défaut (indice de révision, et lequel, ou pourcentage fixe).
- Le périmètre de l'intégration Grenke : simulations seules, ou aussi les dossiers.
- Le moment où le commercial doit être connu : dès le devis, si le fait générateur est la commande.
