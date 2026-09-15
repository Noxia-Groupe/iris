-- Les avoirs partiels partagent une facture d’origine ; l’unicité historique du lien
-- empêcherait tout second avoir. On conserve toutefois le garde du seul avoir total
-- créé par l’annulation, via un index partiel PostgreSQL.
DROP INDEX IF EXISTS "Facture_factureOrigineId_key";

ALTER TABLE "Facture"
  ADD COLUMN "estAvoirAnnulation" BOOLEAN NOT NULL DEFAULT false;

-- Les avoirs #43 existants sont tous issus d’une annulation totale.
UPDATE "Facture"
SET "estAvoirAnnulation" = true
WHERE "type" = 'AVOIR';

CREATE INDEX "Facture_factureOrigineId_idx" ON "Facture"("factureOrigineId");
CREATE UNIQUE INDEX "Facture_un_avoir_annulation_par_origine"
  ON "Facture"("factureOrigineId")
  WHERE "estAvoirAnnulation" = true;

ALTER TABLE "Facture"
  ADD CONSTRAINT "Facture_avoir_annulation_check" CHECK (
    "estAvoirAnnulation" = false OR "type" = 'AVOIR'
  );

-- Le type de l’avoir (partiel ou d’annulation) est un élément du document figé.
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
    NEW."factureOrigineId" IS DISTINCT FROM OLD."factureOrigineId" OR
    NEW."estAvoirAnnulation" IS DISTINCT FROM OLD."estAvoirAnnulation"
  ) THEN
    RAISE EXCEPTION 'Les mentions et liens figés d’une facture émise sont immuables.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
