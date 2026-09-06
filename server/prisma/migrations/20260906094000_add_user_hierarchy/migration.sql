-- Rattachement hiérarchique explicite des collaborateurs.
ALTER TABLE "User" ADD COLUMN "responsableHierarchiqueId" TEXT;
CREATE INDEX "User_responsableHierarchiqueId_idx" ON "User"("responsableHierarchiqueId");
ALTER TABLE "User" ADD CONSTRAINT "User_responsableHierarchiqueId_fkey"
  FOREIGN KEY ("responsableHierarchiqueId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Piste d'audit et archivage non destructif des écritures Travaux.
ALTER TABLE "AchatReel"
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "updatedById" TEXT,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "archivedById" TEXT,
  ADD COLUMN "motifArchivage" TEXT;
CREATE INDEX "AchatReel_archivedAt_idx" ON "AchatReel"("archivedAt");

ALTER TABLE "PointageHeure"
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "updatedById" TEXT,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "archivedById" TEXT,
  ADD COLUMN "motifArchivage" TEXT;
CREATE INDEX "PointageHeure_archivedAt_idx" ON "PointageHeure"("archivedAt");
-- Prisma @updatedAt est piloté par le client, sans DEFAULT en base.
ALTER TABLE "PointageHeure" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- Journal append-only des créations, corrections et archivages Travaux.
CREATE TABLE "JournalSaisieChantier" (
  "id" TEXT NOT NULL,
  "chantierId" TEXT NOT NULL,
  "cible" TEXT NOT NULL,
  "cibleId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "auteurId" TEXT,
  "auteurNom" TEXT NOT NULL,
  "avant" JSONB,
  "apres" JSONB,
  "motif" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JournalSaisieChantier_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JournalSaisieChantier_chantierId_createdAt_idx" ON "JournalSaisieChantier"("chantierId", "createdAt");
CREATE INDEX "JournalSaisieChantier_cible_cibleId_createdAt_idx" ON "JournalSaisieChantier"("cible", "cibleId", "createdAt");
