-- L'origine métier d'une facture émise est une donnée comptable et de traçabilité figée.
CREATE OR REPLACE FUNCTION "interdire_modification_origine_facture_emise"() RETURNS trigger AS $$
BEGIN
  IF OLD."statut" = 'EMISE' AND (
    NEW."origine" IS DISTINCT FROM OLD."origine" OR
    NEW."chantierId" IS DISTINCT FROM OLD."chantierId" OR
    NEW."interventionId" IS DISTINCT FROM OLD."interventionId" OR
    NEW."contratMaintenanceId" IS DISTINCT FROM OLD."contratMaintenanceId" OR
    NEW."motifHorsAffaire" IS DISTINCT FROM OLD."motifHorsAffaire"
  ) THEN
    RAISE EXCEPTION 'L’origine métier d’une facture émise est immuable.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Facture_immutabilite_origine_emise"
BEFORE UPDATE ON "Facture"
FOR EACH ROW EXECUTE FUNCTION "interdire_modification_origine_facture_emise"();
