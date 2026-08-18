-- Activation/désactivation globale du module Planning (réservée au SUPERADMIN).
-- Aucune donnée du planning n'est supprimée quand le module est désactivé.
-- AlterTable
ALTER TABLE "Parametres" ADD COLUMN     "planningActif" BOOLEAN NOT NULL DEFAULT true;

-- Le rôle est une colonne texte libre (pas d'enum PostgreSQL) : le nouveau rôle
-- 'SUPERADMIN' ne nécessite aucune modification de type. Les comptes superadmin
-- de départ sont créés/promus au démarrage du serveur (cf. ensureSuperAdmins).
