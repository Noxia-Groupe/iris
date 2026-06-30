-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'CONDUCTEUR_TRAVAUX',
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fournisseur" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "contact" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Fournisseur_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chantier" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "numeroDevis" TEXT,
    "client" TEXT NOT NULL,
    "dateDebut" TIMESTAMP(3) NOT NULL,
    "dateFin" TIMESTAMP(3),
    "statut" TEXT NOT NULL DEFAULT 'EN_COURS',
    "budgetGlobalVendu" DECIMAL(12,2) NOT NULL,
    "budgetMaterielVendu" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "budgetMainOeuvreVendu" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "heuresVendues" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "responsableId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chantier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Categorie" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "Categorie_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LigneBudgetPrevisionnel" (
    "id" TEXT NOT NULL,
    "chantierId" TEXT NOT NULL,
    "categorieId" TEXT NOT NULL,
    "montantAlloue" DECIMAL(12,2) NOT NULL,
    "heuresAllouees" DECIMAL(10,2),

    CONSTRAINT "LigneBudgetPrevisionnel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AchatReel" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "fournisseurId" TEXT NOT NULL,
    "numeroFacture" TEXT,
    "description" TEXT NOT NULL,
    "montantHT" DECIMAL(12,2) NOT NULL,
    "chantierId" TEXT NOT NULL,
    "categorieId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AchatReel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Intervenant" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tauxHoraireCharge" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "Intervenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointageHeure" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "intervenantId" TEXT NOT NULL,
    "chantierId" TEXT NOT NULL,
    "nbrHeures" DECIMAL(10,2) NOT NULL,
    "tauxHoraireApplique" DECIMAL(10,2) NOT NULL,
    "commentaire" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointageHeure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhotoChantier" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "legende" TEXT,
    "chantierId" TEXT NOT NULL,
    "auteurId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhotoChantier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Parametres" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "margeCommercialeActive" BOOLEAN NOT NULL DEFAULT true,
    "tauxHoraireMoyen" DECIMAL(10,2) NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Parametres_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commissionnement" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'FIXE',
    "tauxFixe" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "bonusHeure" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "malusHeure" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "chantierId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Commissionnement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Fournisseur_nom_key" ON "Fournisseur"("nom");

-- CreateIndex
CREATE UNIQUE INDEX "Categorie_nom_key" ON "Categorie"("nom");

-- CreateIndex
CREATE UNIQUE INDEX "LigneBudgetPrevisionnel_chantierId_categorieId_key" ON "LigneBudgetPrevisionnel"("chantierId", "categorieId");

-- CreateIndex
CREATE UNIQUE INDEX "Commissionnement_chantierId_key" ON "Commissionnement"("chantierId");

-- AddForeignKey
ALTER TABLE "Chantier" ADD CONSTRAINT "Chantier_responsableId_fkey" FOREIGN KEY ("responsableId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LigneBudgetPrevisionnel" ADD CONSTRAINT "LigneBudgetPrevisionnel_chantierId_fkey" FOREIGN KEY ("chantierId") REFERENCES "Chantier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LigneBudgetPrevisionnel" ADD CONSTRAINT "LigneBudgetPrevisionnel_categorieId_fkey" FOREIGN KEY ("categorieId") REFERENCES "Categorie"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AchatReel" ADD CONSTRAINT "AchatReel_fournisseurId_fkey" FOREIGN KEY ("fournisseurId") REFERENCES "Fournisseur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AchatReel" ADD CONSTRAINT "AchatReel_chantierId_fkey" FOREIGN KEY ("chantierId") REFERENCES "Chantier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AchatReel" ADD CONSTRAINT "AchatReel_categorieId_fkey" FOREIGN KEY ("categorieId") REFERENCES "Categorie"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointageHeure" ADD CONSTRAINT "PointageHeure_intervenantId_fkey" FOREIGN KEY ("intervenantId") REFERENCES "Intervenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointageHeure" ADD CONSTRAINT "PointageHeure_chantierId_fkey" FOREIGN KEY ("chantierId") REFERENCES "Chantier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotoChantier" ADD CONSTRAINT "PhotoChantier_chantierId_fkey" FOREIGN KEY ("chantierId") REFERENCES "Chantier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotoChantier" ADD CONSTRAINT "PhotoChantier_auteurId_fkey" FOREIGN KEY ("auteurId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commissionnement" ADD CONSTRAINT "Commissionnement_chantierId_fkey" FOREIGN KEY ("chantierId") REFERENCES "Chantier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
