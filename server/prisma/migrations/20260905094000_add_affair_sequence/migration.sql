CREATE TABLE "SequenceAffaire" (
  "annee" INTEGER NOT NULL,
  "dernierNumero" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "SequenceAffaire_pkey" PRIMARY KEY ("annee")
);
