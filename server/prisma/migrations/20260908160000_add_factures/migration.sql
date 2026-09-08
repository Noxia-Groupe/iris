-- CreateTable
CREATE TABLE "Facture" (
    "id" TEXT NOT NULL,
    "numero" TEXT,
    "annee" INTEGER,
    "clientId" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'BROUILLON',
    "dateEmission" TIMESTAMP(3) NOT NULL,
    "dateEcheance" TIMESTAMP(3) NOT NULL,
    "totalHt" DECIMAL(12,2) NOT NULL,
    "totalTva" DECIMAL(12,2) NOT NULL,
    "totalTtc" DECIMAL(12,2) NOT NULL,
    "createdById" TEXT,
    "emisLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Facture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactureLigne" (
    "id" TEXT NOT NULL,
    "factureId" TEXT NOT NULL,
    "ordre" INTEGER NOT NULL,
    "designation" TEXT NOT NULL,
    "quantite" DECIMAL(12,3) NOT NULL,
    "prixUnitaireHt" DECIMAL(12,2) NOT NULL,
    "tauxTva" DECIMAL(5,2) NOT NULL,
    "totalHt" DECIMAL(12,2) NOT NULL,
    "totalTtc" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "FactureLigne_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceFacture" (
    "annee" INTEGER NOT NULL,
    "dernierNumero" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SequenceFacture_pkey" PRIMARY KEY ("annee")
);

-- CreateIndex
CREATE UNIQUE INDEX "Facture_numero_key" ON "Facture"("numero");

-- CreateIndex
CREATE INDEX "Facture_clientId_statut_idx" ON "Facture"("clientId", "statut");

-- CreateIndex
CREATE INDEX "Facture_statut_dateEcheance_idx" ON "Facture"("statut", "dateEcheance");

-- CreateIndex
CREATE UNIQUE INDEX "FactureLigne_factureId_ordre_key" ON "FactureLigne"("factureId", "ordre");

-- AddForeignKey
ALTER TABLE "Facture" ADD CONSTRAINT "Facture_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactureLigne" ADD CONSTRAINT "FactureLigne_factureId_fkey" FOREIGN KEY ("factureId") REFERENCES "Facture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

