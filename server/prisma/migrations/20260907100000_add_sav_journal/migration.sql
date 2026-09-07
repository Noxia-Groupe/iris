-- Le journal append-only, initialement dédié aux écritures Travaux, couvre aussi les dossiers
-- SAV. Les anciennes entrées conservent leur chantierId ; les nouvelles entrées SAV portent
-- interventionId. Aucun historique n'est réécrit.
ALTER TABLE "JournalSaisieChantier" ALTER COLUMN "chantierId" DROP NOT NULL;
ALTER TABLE "JournalSaisieChantier" ADD COLUMN "interventionId" TEXT;
CREATE INDEX "JournalSaisieChantier_interventionId_createdAt_idx"
  ON "JournalSaisieChantier"("interventionId", "createdAt");
