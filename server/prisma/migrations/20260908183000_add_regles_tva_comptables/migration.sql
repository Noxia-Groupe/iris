-- CreateTable
CREATE TABLE "RegleTvaComptable" (
    "id" TEXT NOT NULL,
    "taux" DECIMAL(5,2) NOT NULL,
    "compteId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegleTvaComptable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RegleTvaComptable_taux_key" ON "RegleTvaComptable"("taux");

-- CreateIndex
CREATE INDEX "RegleTvaComptable_compteId_idx" ON "RegleTvaComptable"("compteId");

-- AddForeignKey
ALTER TABLE "RegleTvaComptable" ADD CONSTRAINT "RegleTvaComptable_compteId_fkey" FOREIGN KEY ("compteId") REFERENCES "CompteComptable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

