-- Affectations SAV explicites et lien optionnel, unique, entre un compte Iris et son profil intervenant.
ALTER TABLE "Intervenant" ADD COLUMN "userId" TEXT;
CREATE UNIQUE INDEX "Intervenant_userId_key" ON "Intervenant"("userId");
ALTER TABLE "Intervenant" ADD CONSTRAINT "Intervenant_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "InterventionAffectation" (
  "id" TEXT NOT NULL,
  "interventionId" TEXT NOT NULL,
  "intervenantId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InterventionAffectation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InterventionAffectation_interventionId_intervenantId_key"
  ON "InterventionAffectation"("interventionId", "intervenantId");
CREATE INDEX "InterventionAffectation_intervenantId_idx" ON "InterventionAffectation"("intervenantId");
ALTER TABLE "InterventionAffectation" ADD CONSTRAINT "InterventionAffectation_interventionId_fkey"
  FOREIGN KEY ("interventionId") REFERENCES "Intervention"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterventionAffectation" ADD CONSTRAINT "InterventionAffectation_intervenantId_fkey"
  FOREIGN KEY ("intervenantId") REFERENCES "Intervenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
