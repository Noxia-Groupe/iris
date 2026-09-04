-- Identité légale et visuelle singleton de l'instance Iris.
CREATE TABLE "CompanySettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "raisonSociale" TEXT,
    "nomCommercial" TEXT,
    "siret" TEXT,
    "tvaIntra" TEXT,
    "adresse" TEXT,
    "codePostal" TEXT,
    "ville" TEXT,
    "pays" TEXT DEFAULT 'France',
    "telephone" TEXT,
    "email" TEXT,
    "siteWeb" TEXT,
    "logoUrl" TEXT,
    "couleurPrimaire" TEXT DEFAULT '#1e3a8a',
    "couleurSecondaire" TEXT DEFAULT '#f59e0b',
    "prefixeFacture" TEXT,
    "piedFacture" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CompanySettings_pkey" PRIMARY KEY ("id")
);
