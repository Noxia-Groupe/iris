CREATE TABLE "JournalFacture" (
  "id" TEXT NOT NULL,
  "factureId" TEXT NOT NULL,
  "acteurId" TEXT,
  "action" TEXT NOT NULL,
  "detail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JournalFacture_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JournalFacture_factureId_fkey" FOREIGN KEY ("factureId") REFERENCES "Facture"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "JournalFacture_factureId_createdAt_idx" ON "JournalFacture"("factureId", "createdAt");
