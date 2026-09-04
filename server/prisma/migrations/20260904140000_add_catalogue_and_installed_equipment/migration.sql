-- Catalogue Iris : services, articles, modèles d'équipements et parc installé.
CREATE TABLE "CataloguePrestation" (
  "id" TEXT NOT NULL, "reference" TEXT NOT NULL, "nom" TEXT NOT NULL, "description" TEXT,
  "unite" TEXT NOT NULL DEFAULT 'unité', "dureeIndicativeMin" INTEGER,
  "tauxTva" DECIMAL(5,2) NOT NULL DEFAULT 20, "prixVenteHt" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "actif" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "CataloguePrestation_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CatalogueArticle" (
  "id" TEXT NOT NULL, "reference" TEXT NOT NULL, "nom" TEXT NOT NULL, "description" TEXT,
  "unite" TEXT NOT NULL DEFAULT 'unité', "tauxTva" DECIMAL(5,2) NOT NULL DEFAULT 20,
  "prixAchatHt" DECIMAL(12,2), "prixVenteHt" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "stockSuivi" BOOLEAN NOT NULL DEFAULT false, "stockActuel" DECIMAL(12,3) NOT NULL DEFAULT 0,
  "actif" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "CatalogueArticle_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CatalogueEquipement" (
  "id" TEXT NOT NULL, "reference" TEXT NOT NULL, "nom" TEXT NOT NULL, "fabricant" TEXT, "description" TEXT,
  "tauxTva" DECIMAL(5,2) NOT NULL DEFAULT 20, "prixVenteHt" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "actif" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "CatalogueEquipement_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "EquipementInstalle" (
  "id" TEXT NOT NULL, "catalogueEquipementId" TEXT NOT NULL, "clientId" TEXT NOT NULL, "clientSiteId" TEXT NOT NULL,
  "numeroSerie" TEXT, "imei" TEXT, "adresseMac" TEXT, "statut" TEXT NOT NULL DEFAULT 'INSTALLE',
  "installeLe" TIMESTAMP(3), "garantieJusquAu" TIMESTAMP(3), "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EquipementInstalle_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CataloguePrestation_reference_key" ON "CataloguePrestation"("reference");
CREATE UNIQUE INDEX "CatalogueArticle_reference_key" ON "CatalogueArticle"("reference");
CREATE UNIQUE INDEX "CatalogueEquipement_reference_key" ON "CatalogueEquipement"("reference");
CREATE UNIQUE INDEX "EquipementInstalle_catalogueEquipementId_numeroSerie_key" ON "EquipementInstalle"("catalogueEquipementId", "numeroSerie");
CREATE INDEX "EquipementInstalle_clientId_idx" ON "EquipementInstalle"("clientId");
CREATE INDEX "EquipementInstalle_clientSiteId_idx" ON "EquipementInstalle"("clientSiteId");
ALTER TABLE "EquipementInstalle" ADD CONSTRAINT "EquipementInstalle_catalogueEquipementId_fkey" FOREIGN KEY ("catalogueEquipementId") REFERENCES "CatalogueEquipement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EquipementInstalle" ADD CONSTRAINT "EquipementInstalle_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EquipementInstalle" ADD CONSTRAINT "EquipementInstalle_clientSiteId_fkey" FOREIGN KEY ("clientSiteId") REFERENCES "ClientSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
