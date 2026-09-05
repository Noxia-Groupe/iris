-- Une affaire (dossier de devis) ne peut produire qu'une seule conversion, toutes versions confondues.
ALTER TABLE "DevisConversion" ADD COLUMN "dossierId" TEXT;
UPDATE "DevisConversion" c
SET "dossierId" = d."dossierId"
FROM "Devis" d
WHERE d.id = c."devisId";
ALTER TABLE "DevisConversion" ALTER COLUMN "dossierId" SET NOT NULL;
CREATE UNIQUE INDEX "DevisConversion_dossierId_key" ON "DevisConversion"("dossierId");
