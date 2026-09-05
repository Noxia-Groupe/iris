-- CreateTable
CREATE TABLE "DevisConversion" (
    "id" TEXT NOT NULL,
    "devisId" TEXT NOT NULL,
    "cibleType" TEXT NOT NULL,
    "cibleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevisConversion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DevisConversion_devisId_key" ON "DevisConversion"("devisId");

-- CreateIndex
CREATE INDEX "DevisConversion_cibleType_cibleId_idx" ON "DevisConversion"("cibleType", "cibleId");

-- AddForeignKey
ALTER TABLE "DevisConversion" ADD CONSTRAINT "DevisConversion_devisId_fkey" FOREIGN KEY ("devisId") REFERENCES "Devis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

