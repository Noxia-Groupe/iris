/*
  Warnings:

  - You are about to drop the `Commissionnement` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Commissionnement" DROP CONSTRAINT "Commissionnement_chantierId_fkey";

-- DropTable
DROP TABLE "Commissionnement";
