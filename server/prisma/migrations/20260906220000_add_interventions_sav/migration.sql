-- Dossiers d'intervention SAV natifs et compteur annuel atomique.
CREATE TABLE "SequenceIntervention" (
  "annee" INTEGER NOT NULL,
  "dernierNumero" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "SequenceIntervention_pkey" PRIMARY KEY ("annee")
);

CREATE TABLE "Intervention" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "titre" TEXT NOT NULL,
  "description" TEXT,
  "priorite" TEXT NOT NULL DEFAULT 'NORMALE',
  "statut" TEXT NOT NULL DEFAULT 'A_PLANIFIER',
  "dateSouhaitee" TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Intervention_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Intervention_reference_key" ON "Intervention"("reference");
CREATE INDEX "Intervention_clientId_statut_idx" ON "Intervention"("clientId", "statut");
CREATE INDEX "Intervention_statut_dateSouhaitee_idx" ON "Intervention"("statut", "dateSouhaitee");
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
