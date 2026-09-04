-- Clés machine-à-machine Iris : secrets hashés, scopes et révocation.
CREATE TABLE "ApiAccessKey" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "prefixe" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "expireLe" TIMESTAMP(3),
    "dernierUsageLe" TIMESTAMP(3),
    "creeParId" TEXT NOT NULL,
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoqueLe" TIMESTAMP(3),
    CONSTRAINT "ApiAccessKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ApiAccessKey_prefixe_key" ON "ApiAccessKey"("prefixe");
CREATE UNIQUE INDEX "ApiAccessKey_secretHash_key" ON "ApiAccessKey"("secretHash");
CREATE INDEX "ApiAccessKey_actif_idx" ON "ApiAccessKey"("actif");
