-- Catégorisation libre et hiérarchique du catalogue Iris.
CREATE TABLE "CatalogueCategorie" (
  "id" TEXT NOT NULL,
  "nom" TEXT NOT NULL,
  "description" TEXT,
  "parentId" TEXT,
  "actif" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CatalogueCategorie_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CatalogueCategorie_nom_key" ON "CatalogueCategorie"("nom");
ALTER TABLE "CatalogueCategorie" ADD CONSTRAINT "CatalogueCategorie_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "CatalogueCategorie"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CataloguePrestation" ADD COLUMN "categorieId" TEXT;
ALTER TABLE "CatalogueArticle" ADD COLUMN "categorieId" TEXT;
ALTER TABLE "CatalogueEquipement" ADD COLUMN "categorieId" TEXT;
ALTER TABLE "CataloguePrestation" ADD CONSTRAINT "CataloguePrestation_categorieId_fkey"
  FOREIGN KEY ("categorieId") REFERENCES "CatalogueCategorie"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CatalogueArticle" ADD CONSTRAINT "CatalogueArticle_categorieId_fkey"
  FOREIGN KEY ("categorieId") REFERENCES "CatalogueCategorie"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CatalogueEquipement" ADD CONSTRAINT "CatalogueEquipement_categorieId_fkey"
  FOREIGN KEY ("categorieId") REFERENCES "CatalogueCategorie"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "CataloguePrestation_categorieId_idx" ON "CataloguePrestation"("categorieId");
CREATE INDEX "CatalogueArticle_categorieId_idx" ON "CatalogueArticle"("categorieId");
CREATE INDEX "CatalogueEquipement_categorieId_idx" ON "CatalogueEquipement"("categorieId");
