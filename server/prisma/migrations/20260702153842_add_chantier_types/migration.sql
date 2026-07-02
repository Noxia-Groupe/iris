-- AlterTable
ALTER TABLE "Chantier" ADD COLUMN     "types" TEXT[] DEFAULT ARRAY[]::TEXT[];
