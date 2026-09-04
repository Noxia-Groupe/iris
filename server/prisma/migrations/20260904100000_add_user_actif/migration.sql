-- Désactivation d'un compte : la connexion est refusée et le compte disparaît des listes
-- d'attribution, mais tout son historique reste rattaché (contrairement à une révocation,
-- qui détache les chantiers). Tous les comptes existants restent actifs.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "actif" BOOLEAN NOT NULL DEFAULT true;
