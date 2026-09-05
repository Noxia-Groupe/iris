-- CreateTable
CREATE TABLE "Devis" (
    "id" TEXT NOT NULL,
    "dossierId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "clientId" TEXT NOT NULL,
    "objet" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'BROUILLON',
    "totalHt" DECIMAL(12,2) NOT NULL,
    "totalTva" DECIMAL(12,2) NOT NULL,
    "totalTtc" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Devis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevisLigne" (
    "id" TEXT NOT NULL,
    "devisId" TEXT NOT NULL,
    "ordre" INTEGER NOT NULL,
    "designation" TEXT NOT NULL,
    "quantite" DECIMAL(12,3) NOT NULL,
    "prixUnitaireHt" DECIMAL(12,2) NOT NULL,
    "tauxTva" DECIMAL(5,2) NOT NULL,
    "totalHt" DECIMAL(12,2) NOT NULL,
    "totalTtc" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "DevisLigne_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Devis_clientId_idx" ON "Devis"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Devis_dossierId_version_key" ON "Devis"("dossierId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DevisLigne_devisId_ordre_key" ON "DevisLigne"("devisId", "ordre");

-- AddForeignKey
ALTER TABLE "Devis" ADD CONSTRAINT "Devis_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevisLigne" ADD CONSTRAINT "DevisLigne_devisId_fkey" FOREIGN KEY ("devisId") REFERENCES "Devis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

