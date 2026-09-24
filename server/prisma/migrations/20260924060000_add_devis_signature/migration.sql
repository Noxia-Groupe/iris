-- CreateTable
CREATE TABLE "DevisSignature" (
    "id" TEXT NOT NULL,
    "devisId" TEXT NOT NULL,
    "signataire" TEXT NOT NULL,
    "empreinte" TEXT NOT NULL,
    "signeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevisSignature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DevisSignature_devisId_key" ON "DevisSignature"("devisId");

-- AddForeignKey
ALTER TABLE "DevisSignature" ADD CONSTRAINT "DevisSignature_devisId_fkey" FOREIGN KEY ("devisId") REFERENCES "Devis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

