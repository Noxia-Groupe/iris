-- Le contenu légal est un paramétrage d'installation : aucune donnée ni texte par défaut.
CREATE TABLE "MentionsLegalesVersion" (
  "id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "mentions" TEXT NOT NULL,
  "cgv" TEXT NOT NULL,
  "penalites" TEXT NOT NULL,
  "escompte" TEXT,
  "actif" BOOLEAN NOT NULL DEFAULT false,
  "publieeLe" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MentionsLegalesVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MentionsLegalesVersion_version_key" ON "MentionsLegalesVersion"("version");
CREATE UNIQUE INDEX "MentionsLegalesVersion_actif_unique" ON "MentionsLegalesVersion"("actif") WHERE "actif";

ALTER TABLE "Facture" ADD COLUMN "mentionsLegalesVersionId" TEXT;
ALTER TABLE "Facture" ADD CONSTRAINT "Facture_mentionsLegalesVersionId_fkey" FOREIGN KEY ("mentionsLegalesVersionId") REFERENCES "MentionsLegalesVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Facture_mentionsLegalesVersionId_idx" ON "Facture"("mentionsLegalesVersionId");
