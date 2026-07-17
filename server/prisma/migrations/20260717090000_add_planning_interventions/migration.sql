-- CreateTable
CREATE TABLE "PlanningEventType" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "couleur" TEXT NOT NULL DEFAULT '#f59e0b',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanningEventType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanningEvent" (
    "id" TEXT NOT NULL,
    "categorie" TEXT NOT NULL,
    "dateDebut" TIMESTAMP(3) NOT NULL,
    "dateFin" TIMESTAMP(3) NOT NULL,
    "creneau" TEXT NOT NULL DEFAULT 'JOURNEE',
    "heureDebut" TEXT,
    "heureFin" TEXT,
    "chantierId" TEXT,
    "titre" TEXT,
    "client" TEXT,
    "typeEventId" TEXT,
    "commentaire" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanningEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_PlanningEventIntervenants" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanningEventType_nom_key" ON "PlanningEventType"("nom");

-- CreateIndex
CREATE UNIQUE INDEX "_PlanningEventIntervenants_AB_unique" ON "_PlanningEventIntervenants"("A", "B");

-- CreateIndex
CREATE INDEX "_PlanningEventIntervenants_B_index" ON "_PlanningEventIntervenants"("B");

-- AddForeignKey
ALTER TABLE "PlanningEvent" ADD CONSTRAINT "PlanningEvent_chantierId_fkey" FOREIGN KEY ("chantierId") REFERENCES "Chantier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanningEvent" ADD CONSTRAINT "PlanningEvent_typeEventId_fkey" FOREIGN KEY ("typeEventId") REFERENCES "PlanningEventType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PlanningEventIntervenants" ADD CONSTRAINT "_PlanningEventIntervenants_A_fkey" FOREIGN KEY ("A") REFERENCES "Intervenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PlanningEventIntervenants" ADD CONSTRAINT "_PlanningEventIntervenants_B_fkey" FOREIGN KEY ("B") REFERENCES "PlanningEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

