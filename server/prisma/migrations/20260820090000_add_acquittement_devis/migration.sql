-- Marque « Vu » du Suivi financier sur un devis de vente Odoo au règlement incomplet
-- mais assumé. Purement applicative : rien n'est jamais écrit dans Odoo.
-- CreateTable
CREATE TABLE "AcquittementDevis" (
    "numeroDevis" TEXT NOT NULL,
    "motif" TEXT,
    "acquitteParId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcquittementDevis_pkey" PRIMARY KEY ("numeroDevis")
);

-- AddForeignKey
ALTER TABLE "AcquittementDevis" ADD CONSTRAINT "AcquittementDevis_acquitteParId_fkey" FOREIGN KEY ("acquitteParId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
