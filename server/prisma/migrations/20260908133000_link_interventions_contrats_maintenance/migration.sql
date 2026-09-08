ALTER TABLE "Intervention" ADD COLUMN "contratMaintenanceId" TEXT;
ALTER TABLE "Intervention" ADD COLUMN "echeanceContrat" TIMESTAMP(3);

CREATE INDEX "Intervention_contratMaintenanceId_idx" ON "Intervention"("contratMaintenanceId");
CREATE UNIQUE INDEX "Intervention_contratMaintenanceId_echeanceContrat_key" ON "Intervention"("contratMaintenanceId", "echeanceContrat");

ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_contratMaintenanceId_fkey" FOREIGN KEY ("contratMaintenanceId") REFERENCES "ContratMaintenance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
