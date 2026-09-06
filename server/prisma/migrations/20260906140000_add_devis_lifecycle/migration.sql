-- AlterTable
ALTER TABLE "Chantier" ADD COLUMN     "annuleLe" TIMESTAMP(3),
ADD COLUMN     "annuleParId" TEXT,
ADD COLUMN     "motifAnnulation" TEXT;

-- AlterTable
ALTER TABLE "Devis" ADD COLUMN     "acompteConstateParId" TEXT,
ADD COLUMN     "acompteExige" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "acompteMontant" DECIMAL(12,2),
ADD COLUMN     "acompteRecuLe" TIMESTAMP(3),
ADD COLUMN     "acompteReference" TEXT,
ADD COLUMN     "annuleLe" TIMESTAMP(3),
ADD COLUMN     "annuleParId" TEXT,
ADD COLUMN     "motifAnnulation" TEXT,
ADD COLUMN     "origineDevisId" TEXT,
ADD COLUMN     "tauxAcompte" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "Parametres" ADD COLUMN     "tauxAcompteDefaut" DECIMAL(5,2) NOT NULL DEFAULT 30;

-- CreateIndex
CREATE INDEX "Devis_origineDevisId_idx" ON "Devis"("origineDevisId");

-- AddForeignKey
ALTER TABLE "Devis" ADD CONSTRAINT "Devis_origineDevisId_fkey" FOREIGN KEY ("origineDevisId") REFERENCES "Devis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

