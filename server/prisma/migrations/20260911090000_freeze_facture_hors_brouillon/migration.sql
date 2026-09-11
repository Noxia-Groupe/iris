-- Toute facture post-brouillon conserve ses mentions métier et son identité client figées.
-- Le règlement et l'annulation ne doivent pas rouvrir ces champs en accès direct base.
CREATE OR REPLACE FUNCTION "interdire_modification_origine_facture_emise"() RETURNS trigger AS $$
BEGIN
  IF OLD."statut" IN ('EMISE', 'REGLEE', 'ANNULEE') AND (
    NEW."origine" IS DISTINCT FROM OLD."origine" OR
    NEW."chantierId" IS DISTINCT FROM OLD."chantierId" OR
    NEW."interventionId" IS DISTINCT FROM OLD."interventionId" OR
    NEW."contratMaintenanceId" IS DISTINCT FROM OLD."contratMaintenanceId" OR
    NEW."motifHorsAffaire" IS DISTINCT FROM OLD."motifHorsAffaire" OR
    NEW."clientRaisonSociale" IS DISTINCT FROM OLD."clientRaisonSociale" OR
    NEW."clientAdresse" IS DISTINCT FROM OLD."clientAdresse"
  ) THEN
    RAISE EXCEPTION 'Les mentions figées d’une facture émise (origine métier, identité du client) sont immuables.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
