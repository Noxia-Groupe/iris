-- AlterTable
ALTER TABLE "User" ADD COLUMN     "responsableHierarchiqueId" TEXT;

-- CreateTable
CREATE TABLE "JournalSaisieChantier" (
    "id" TEXT NOT NULL,
    "chantierId" TEXT NOT NULL,
    "cible" TEXT NOT NULL,
    "cibleId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "auteurId" TEXT,
    "auteurNom" TEXT NOT NULL,
    "auteurEmail" TEXT NOT NULL,
    "avant" JSONB,
    "apres" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalSaisieChantier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JournalSaisieChantier_chantierId_createdAt_idx" ON "JournalSaisieChantier"("chantierId", "createdAt");

-- CreateIndex
CREATE INDEX "JournalSaisieChantier_cible_cibleId_idx" ON "JournalSaisieChantier"("cible", "cibleId");

-- CreateIndex
CREATE INDEX "User_responsableHierarchiqueId_idx" ON "User"("responsableHierarchiqueId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_responsableHierarchiqueId_fkey" FOREIGN KEY ("responsableHierarchiqueId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalSaisieChantier" ADD CONSTRAINT "JournalSaisieChantier_chantierId_fkey" FOREIGN KEY ("chantierId") REFERENCES "Chantier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalSaisieChantier" ADD CONSTRAINT "JournalSaisieChantier_auteurId_fkey" FOREIGN KEY ("auteurId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

