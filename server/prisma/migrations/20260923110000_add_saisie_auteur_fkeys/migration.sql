-- Chaque écriture Travaux doit conserver un auteur réel de création et de dernière correction.
ALTER TABLE "AchatReel"
  ALTER COLUMN "createdById" SET NOT NULL,
  ALTER COLUMN "updatedById" SET NOT NULL,
  ADD CONSTRAINT "AchatReel_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AchatReel_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PointageHeure"
  ALTER COLUMN "createdById" SET NOT NULL,
  ALTER COLUMN "updatedById" SET NOT NULL,
  ADD CONSTRAINT "PointageHeure_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PointageHeure_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- L'auteur initial est une preuve historique : une correction ne peut jamais le réécrire.
CREATE OR REPLACE FUNCTION prevent_travaux_created_by_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."createdById" IS DISTINCT FROM OLD."createdById" THEN
    RAISE EXCEPTION 'createdById est immuable pour une écriture Travaux';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AchatReel_prevent_created_by_change"
  BEFORE UPDATE ON "AchatReel"
  FOR EACH ROW EXECUTE FUNCTION prevent_travaux_created_by_change();

CREATE TRIGGER "PointageHeure_prevent_created_by_change"
  BEFORE UPDATE ON "PointageHeure"
  FOR EACH ROW EXECUTE FUNCTION prevent_travaux_created_by_change();
