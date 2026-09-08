-- Rattachement optionnel d'un dossier SAV à une affaire/chantier native.
-- Le lien est restrictif afin qu'un historique SAV ne soit jamais détaché par suppression.
ALTER TABLE "Intervention" ADD COLUMN "chantierId" TEXT;
CREATE INDEX "Intervention_chantierId_idx" ON "Intervention"("chantierId");
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_chantierId_fkey"
  FOREIGN KEY ("chantierId") REFERENCES "Chantier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
