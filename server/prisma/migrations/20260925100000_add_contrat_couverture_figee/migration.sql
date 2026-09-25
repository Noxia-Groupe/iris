-- Politique de couverture exclusivement qualitative, portée par le contrat.
ALTER TABLE "ContratMaintenance"
  ADD COLUMN "politiqueMainOeuvre" TEXT NOT NULL DEFAULT 'HORS_FORFAIT',
  ADD COLUMN "politiqueMateriel" TEXT NOT NULL DEFAULT 'HORS_FORFAIT',
  ADD COLUMN "noteCouverture" TEXT;

ALTER TABLE "ContratMaintenance"
  ADD CONSTRAINT "ContratMaintenance_politiqueMainOeuvre_check"
    CHECK ("politiqueMainOeuvre" IN ('INCLUSE', 'HORS_FORFAIT')),
  ADD CONSTRAINT "ContratMaintenance_politiqueMateriel_check"
    CHECK ("politiqueMateriel" IN ('INCLUS', 'HORS_FORFAIT')),
  ADD CONSTRAINT "ContratMaintenance_noteCouverture_check"
    CHECK ("noteCouverture" IS NULL OR char_length("noteCouverture") <= 1000);

-- L'intervention générée conserve exactement la politique au moment de sa création.
ALTER TABLE "Intervention" ADD COLUMN "couvertureContrat" JSONB;

-- PostgreSQL interdit les sous-requêtes directement dans une CHECK ; cette fonction
-- IMMUTABLE porte donc l'énumération exhaustive des clés autorisées.
CREATE OR REPLACE FUNCTION "couverture_contrat_valide"(couverture JSONB)
RETURNS BOOLEAN AS $$
  SELECT
    jsonb_typeof(couverture) = 'object'
    AND couverture ? 'politiqueMainOeuvre'
    AND couverture ? 'politiqueMateriel'
    AND couverture->>'politiqueMainOeuvre' IN ('INCLUSE', 'HORS_FORFAIT')
    AND couverture->>'politiqueMateriel' IN ('INCLUS', 'HORS_FORFAIT')
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_object_keys(couverture) AS cle(nom)
      WHERE cle.nom NOT IN ('politiqueMainOeuvre', 'politiqueMateriel', 'noteCouverture')
    )
    AND (
      NOT couverture ? 'noteCouverture'
      OR jsonb_typeof(couverture->'noteCouverture') IN ('string', 'null')
    )
    AND (
      NOT couverture ? 'noteCouverture'
      OR couverture->>'noteCouverture' IS NULL
      OR char_length(couverture->>'noteCouverture') <= 1000
    );
$$ LANGUAGE SQL IMMUTABLE;

ALTER TABLE "Intervention"
  ADD CONSTRAINT "Intervention_couvertureContrat_check"
    CHECK (
      "couvertureContrat" IS NULL
      OR "couverture_contrat_valide"("couvertureContrat")
    ),
  ADD CONSTRAINT "Intervention_couvertureContrat_contratMaintenance_check"
    CHECK (
      "couvertureContrat" IS NULL
      OR "contratMaintenanceId" IS NOT NULL
    );

-- L'instantané créé pour une intervention contractuelle est une preuve : aucune couche
-- applicative ne peut le réécrire, y compris via Prisma ou SQL direct.
CREATE OR REPLACE FUNCTION "verifier_couverture_contrat_figee"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."couvertureContrat" IS DISTINCT FROM NEW."couvertureContrat" THEN
    RAISE EXCEPTION 'La couverture contractuelle d''une intervention est immuable.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Intervention_couvertureContrat_immutable"
BEFORE UPDATE OF "couvertureContrat" ON "Intervention"
FOR EACH ROW EXECUTE FUNCTION "verifier_couverture_contrat_figee"();
