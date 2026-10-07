# Imputation figée des factures — migration #86

La migration `20261007140000_facture_ecritures_figees` est destinée à une instance **non productive vide de pièces numérotées**. Elle échoue explicitement si une facture/avoir numéroté existe : les règles courantes ne permettent pas de reconstituer avec certitude le journal, le compte et le libellé historiques. Ne pas supprimer ces pièces ni les rétro-imputer automatiquement pour faire passer la migration.

Sur une instance déjà peuplée, effectuer un inventaire des pièces numérotées et des exports remis, obtenir la validation explicite de la comptabilité pour chaque imputation historique puis livrer une migration de reprise dédiée, traçable et vérifiée avant d'appliquer celle-ci (ou l'adapter dans une branche non déployée). L'export retourne `409` pour toute pièce numérotée sans écriture figée ; il ne revient jamais aux règles vivantes. Aucun déploiement ni fusion avant validation comptable.

Les écritures sont créées dans la transaction d'émission/avoir ; la table interdit `UPDATE`/`DELETE` et référence la pièce en `RESTRICT`. Seul le harnais PostgreSQL jetable désactive le trigger pendant le nettoyage des fixtures, toujours réactivé en `finally`.
