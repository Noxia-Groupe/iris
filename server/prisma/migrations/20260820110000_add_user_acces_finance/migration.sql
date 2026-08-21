-- Accès au Suivi financier, accordable à n'importe quel compte indépendamment de son
-- rôle (cf. User.accesFinance). Un SUPERADMIN y accède sans cette autorisation.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "accesFinance" BOOLEAN NOT NULL DEFAULT false;
