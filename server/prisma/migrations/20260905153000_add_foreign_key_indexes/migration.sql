-- CreateIndex
CREATE INDEX "Chantier_responsableId_idx" ON "Chantier"("responsableId");

-- CreateIndex
CREATE INDEX "Chantier_commercialId_idx" ON "Chantier"("commercialId");

-- CreateIndex
CREATE INDEX "LigneBudgetPrevisionnel_categorieId_idx" ON "LigneBudgetPrevisionnel"("categorieId");

-- CreateIndex
CREATE INDEX "AchatReel_fournisseurId_idx" ON "AchatReel"("fournisseurId");

-- CreateIndex
CREATE INDEX "AchatReel_chantierId_idx" ON "AchatReel"("chantierId");

-- CreateIndex
CREATE INDEX "AchatReel_categorieId_idx" ON "AchatReel"("categorieId");

-- CreateIndex
CREATE INDEX "PointageHeure_intervenantId_idx" ON "PointageHeure"("intervenantId");

-- CreateIndex
CREATE INDEX "PointageHeure_chantierId_idx" ON "PointageHeure"("chantierId");

-- CreateIndex
CREATE INDEX "PlanningEvent_chantierId_idx" ON "PlanningEvent"("chantierId");

