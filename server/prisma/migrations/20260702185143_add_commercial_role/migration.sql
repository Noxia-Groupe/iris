-- AlterTable
ALTER TABLE "Chantier" ADD COLUMN     "commercialId" TEXT;

-- CreateTable
CREATE TABLE "CommissionnementCommercial" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'FIXE',
    "tauxFixe" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "bonusHeure" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "malusHeure" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "chantierId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionnementCommercial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommissionnementCommercial_chantierId_key" ON "CommissionnementCommercial"("chantierId");

-- AddForeignKey
ALTER TABLE "Chantier" ADD CONSTRAINT "Chantier_commercialId_fkey" FOREIGN KEY ("commercialId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionnementCommercial" ADD CONSTRAINT "CommissionnementCommercial_chantierId_fkey" FOREIGN KEY ("chantierId") REFERENCES "Chantier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
