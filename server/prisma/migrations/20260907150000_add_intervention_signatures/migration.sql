-- Attestation électronique d'un compte rendu SAV, sans stockage de signature graphique.
CREATE TABLE "InterventionSignature" (
  "id" TEXT NOT NULL,
  "rapportId" TEXT NOT NULL,
  "signataire" TEXT NOT NULL,
  "empreinte" TEXT NOT NULL,
  "accepteLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InterventionSignature_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InterventionSignature_rapportId_key" ON "InterventionSignature"("rapportId");
CREATE INDEX "InterventionSignature_accepteLe_idx" ON "InterventionSignature"("accepteLe");
ALTER TABLE "InterventionSignature" ADD CONSTRAINT "InterventionSignature_rapportId_fkey"
  FOREIGN KEY ("rapportId") REFERENCES "InterventionRapport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
