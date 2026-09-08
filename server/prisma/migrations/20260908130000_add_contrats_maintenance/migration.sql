CREATE TABLE "ContratMaintenance" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "siteId" TEXT,
    "titre" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'ACTIF',
    "periodiciteMois" INTEGER NOT NULL,
    "dureePrevisionnelleMinutes" INTEGER NOT NULL,
    "dateDebut" TIMESTAMP(3) NOT NULL,
    "prochaineEcheance" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContratMaintenance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContratMaintenance_clientId_statut_idx" ON "ContratMaintenance"("clientId", "statut");
CREATE INDEX "ContratMaintenance_siteId_idx" ON "ContratMaintenance"("siteId");
CREATE INDEX "ContratMaintenance_statut_prochaineEcheance_idx" ON "ContratMaintenance"("statut", "prochaineEcheance");

ALTER TABLE "ContratMaintenance" ADD CONSTRAINT "ContratMaintenance_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContratMaintenance" ADD CONSTRAINT "ContratMaintenance_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "ClientSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
