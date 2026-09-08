-- Compte rendu terrain append-only pour les interventions SAV.
CREATE TABLE "InterventionRapport" (
  "id" TEXT NOT NULL,
  "interventionId" TEXT NOT NULL,
  "auteurId" TEXT NOT NULL,
  "contenu" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InterventionRapport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InterventionRapport_interventionId_createdAt_idx" ON "InterventionRapport"("interventionId", "createdAt");
CREATE INDEX "InterventionRapport_auteurId_idx" ON "InterventionRapport"("auteurId");
ALTER TABLE "InterventionRapport" ADD CONSTRAINT "InterventionRapport_interventionId_fkey"
  FOREIGN KEY ("interventionId") REFERENCES "Intervention"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterventionRapport" ADD CONSTRAINT "InterventionRapport_auteurId_fkey"
  FOREIGN KEY ("auteurId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
