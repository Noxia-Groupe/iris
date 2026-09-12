-- Avoirs : les montants restent positifs dans Facture ; `type` porte le sens comptable.
ALTER TABLE "CompanySettings" ADD COLUMN "prefixeAvoir" TEXT;

ALTER TABLE "Facture"
  ADD COLUMN "type" TEXT NOT NULL DEFAULT 'FACTURE',
  ADD COLUMN "factureOrigineId" TEXT;

-- Une annulation totale n'autorise qu'un seul avoir pour sa facture d'origine.
CREATE UNIQUE INDEX "Facture_factureOrigineId_key" ON "Facture"("factureOrigineId");
CREATE INDEX "Facture_type_statut_idx" ON "Facture"("type", "statut");

ALTER TABLE "Facture"
  ADD CONSTRAINT "Facture_factureOrigineId_fkey"
  FOREIGN KEY ("factureOrigineId") REFERENCES "Facture"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SequenceAvoir" (
  "annee" INTEGER NOT NULL,
  "dernierNumero" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "SequenceAvoir_pkey" PRIMARY KEY ("annee")
);

ALTER TABLE "Facture"
  ADD CONSTRAINT "Facture_type_check" CHECK ("type" IN ('FACTURE', 'AVOIR'));

ALTER TABLE "Facture"
  ADD CONSTRAINT "Facture_avoir_origine_check" CHECK (
    ("type" = 'FACTURE' AND "factureOrigineId" IS NULL)
    OR ("type" = 'AVOIR' AND "factureOrigineId" IS NOT NULL)
  );

-- La nature et le lien comptable restent figés dès l'émission, comme les autres snapshots.
CREATE OR REPLACE FUNCTION "interdire_modification_origine_facture_emise"() RETURNS trigger AS $$
BEGIN
  IF OLD."statut" IN ('EMISE', 'REGLEE', 'ANNULEE') AND (
    NEW."origine" IS DISTINCT FROM OLD."origine" OR
    NEW."chantierId" IS DISTINCT FROM OLD."chantierId" OR
    NEW."interventionId" IS DISTINCT FROM OLD."interventionId" OR
    NEW."contratMaintenanceId" IS DISTINCT FROM OLD."contratMaintenanceId" OR
    NEW."motifHorsAffaire" IS DISTINCT FROM OLD."motifHorsAffaire" OR
    NEW."clientRaisonSociale" IS DISTINCT FROM OLD."clientRaisonSociale" OR
    NEW."clientAdresse" IS DISTINCT FROM OLD."clientAdresse" OR
    NEW."type" IS DISTINCT FROM OLD."type" OR
    NEW."factureOrigineId" IS DISTINCT FROM OLD."factureOrigineId"
  ) THEN
    RAISE EXCEPTION 'Les mentions et liens figés d’une facture émise sont immuables.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
