-- Une intervention SAV a au plus une projection prévisionnelle dans le planning.
-- Les événements HORS_CHANTIER libres restent possibles pour les activités sans dossier SAV.
ALTER TABLE "PlanningEvent" ADD COLUMN "interventionId" TEXT;
CREATE UNIQUE INDEX "PlanningEvent_interventionId_key" ON "PlanningEvent"("interventionId");
ALTER TABLE "PlanningEvent" ADD CONSTRAINT "PlanningEvent_interventionId_fkey"
  FOREIGN KEY ("interventionId") REFERENCES "Intervention"("id") ON DELETE CASCADE ON UPDATE CASCADE;
