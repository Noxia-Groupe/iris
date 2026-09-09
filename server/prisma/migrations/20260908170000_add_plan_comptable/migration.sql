-- CreateTable
CREATE TABLE "CompteComptable" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "libelle" TEXT NOT NULL,
    "nature" TEXT NOT NULL,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompteComptable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegleComptable" (
    "id" TEXT NOT NULL,
    "cle" TEXT NOT NULL,
    "compteId" TEXT,
    "journal" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegleComptable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompteComptable_code_key" ON "CompteComptable"("code");

-- CreateIndex
CREATE UNIQUE INDEX "RegleComptable_cle_key" ON "RegleComptable"("cle");

-- CreateIndex
CREATE INDEX "RegleComptable_compteId_idx" ON "RegleComptable"("compteId");

-- AddForeignKey
ALTER TABLE "RegleComptable" ADD CONSTRAINT "RegleComptable_compteId_fkey" FOREIGN KEY ("compteId") REFERENCES "CompteComptable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

