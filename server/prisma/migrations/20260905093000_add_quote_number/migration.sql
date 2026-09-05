-- Numéro visible et permanent d'un devis. La colonne est ajoutée nullable afin que les
-- devis éventuellement créés avant cette migration reçoivent aussi un identifiant stable.
ALTER TABLE "Devis" ADD COLUMN "numero" TEXT;
UPDATE "Devis"
SET "numero" = 'DV-HIST-' || upper(substr(replace("id"::text, '-', ''), 1, 10))
WHERE "numero" IS NULL;
ALTER TABLE "Devis" ALTER COLUMN "numero" SET NOT NULL;
CREATE INDEX "Devis_numero_idx" ON "Devis"("numero");
