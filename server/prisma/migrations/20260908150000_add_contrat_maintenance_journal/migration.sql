-- Le journal append-only couvre désormais aussi les contrats de maintenance.
ALTER TABLE "JournalSaisieChantier" ADD COLUMN "contratMaintenanceId" TEXT;
CREATE INDEX "JournalSaisieChantier_contratMaintenanceId_createdAt_idx"
  ON "JournalSaisieChantier"("contratMaintenanceId", "createdAt");

-- Exactement un parent métier : chantier, intervention ou contrat.
ALTER TABLE "JournalSaisieChantier" DROP CONSTRAINT "JournalSaisieChantier_parent_unique_check";
ALTER TABLE "JournalSaisieChantier" ADD CONSTRAINT "JournalSaisieChantier_parent_unique_check"
  CHECK ((("chantierId" IS NOT NULL)::int + ("interventionId" IS NOT NULL)::int + ("contratMaintenanceId" IS NOT NULL)::int) = 1);
