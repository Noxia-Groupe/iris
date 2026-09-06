-- Rattachement hiérarchique explicite des collaborateurs.
ALTER TABLE "User" ADD COLUMN "responsableId" TEXT;
CREATE INDEX "User_responsableId_idx" ON "User"("responsableId");
ALTER TABLE "User" ADD CONSTRAINT "User_responsableId_fkey"
  FOREIGN KEY ("responsableId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
