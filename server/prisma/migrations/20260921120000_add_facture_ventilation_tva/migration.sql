-- Ventilation de TVA figée par facture et par taux. Cette migration est strictement
-- additive : les documents historiques n'ont volontairement aucune ventilation et
-- conservent leur fallback de lecture dérivé des lignes.
CREATE TABLE "FactureVentilationTva" (
  "id" TEXT NOT NULL,
  "factureId" TEXT NOT NULL,
  "tauxTva" DECIMAL(5,2) NOT NULL,
  "totalHt" DECIMAL(12,2) NOT NULL,
  "totalTva" DECIMAL(12,2) NOT NULL,
  "totalTtc" DECIMAL(12,2) NOT NULL,
  CONSTRAINT "FactureVentilationTva_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FactureVentilationTva_factureId_tauxTva_key"
  ON "FactureVentilationTva"("factureId", "tauxTva");
CREATE INDEX "FactureVentilationTva_factureId_idx"
  ON "FactureVentilationTva"("factureId");

ALTER TABLE "FactureVentilationTva"
  ADD CONSTRAINT "FactureVentilationTva_factureId_fkey"
  FOREIGN KEY ("factureId") REFERENCES "Facture"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Une ventilation attachée à un document émis ne peut jamais être réécrite ni supprimée
-- indépendamment de son document : elle est la trace comptable de l'arrondi émis.
-- La suppression en cascade avec la facture elle-même reste compatible avec le cycle
-- de rétention préexistant des documents.
CREATE OR REPLACE FUNCTION "interdire_modification_ventilation_facture_emise"() RETURNS trigger AS $$
DECLARE
  facture_id TEXT;
  statut_facture TEXT;
BEGIN
  facture_id := COALESCE(NEW."factureId", OLD."factureId");
  SELECT "statut" INTO statut_facture FROM "Facture" WHERE "id" = facture_id;
  IF statut_facture IN ('EMISE', 'REGLEE', 'ANNULEE') THEN
    RAISE EXCEPTION 'La ventilation TVA d’une facture émise est immuable.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FactureVentilationTva_immutabilite_emise"
  BEFORE UPDATE OR DELETE ON "FactureVentilationTva"
  FOR EACH ROW EXECUTE FUNCTION "interdire_modification_ventilation_facture_emise"();
