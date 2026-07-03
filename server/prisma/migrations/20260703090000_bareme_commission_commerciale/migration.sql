-- Passage du commissionnement commercial d'un taux réglé à la main par chantier à un
-- barème progressif mensuel (cf. document "Système de rémunération commerciale") :
-- taux réduits pour les dossiers NOXIA, gate sur le statut Terminé + Encaissé, et
-- prime "suivi administratif" validée mensuellement par un administrateur.

-- AlterTable
ALTER TABLE "Chantier" ADD COLUMN     "dossierNoxia" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Chantier" ADD COLUMN     "encaisse" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Chantier" ADD COLUMN     "dateEncaissement" TIMESTAMP(3);

-- DropForeignKey
ALTER TABLE "CommissionnementCommercial" DROP CONSTRAINT "CommissionnementCommercial_chantierId_fkey";

-- DropTable
DROP TABLE "CommissionnementCommercial";

-- CreateTable
CREATE TABLE "PrimeMensuelleCommercial" (
    "id" TEXT NOT NULL,
    "periode" TEXT NOT NULL,
    "suiviAdministratif" BOOLEAN NOT NULL DEFAULT false,
    "commercialId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrimeMensuelleCommercial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrimeMensuelleCommercial_commercialId_periode_key" ON "PrimeMensuelleCommercial"("commercialId", "periode");

-- AddForeignKey
ALTER TABLE "PrimeMensuelleCommercial" ADD CONSTRAINT "PrimeMensuelleCommercial_commercialId_fkey" FOREIGN KEY ("commercialId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
