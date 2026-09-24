-- Une signature existante était supprimée avec son devis et n'identifiait pas l'humain
-- qui l'avait enregistrée. Cette migration est un delta depuis 20260924060000, jamais une
-- recréation du schéma : elle conserve les attestations déjà émises en les attribuant à un
-- compte utilisateur existant avant de rendre l'auteur obligatoire.
ALTER TABLE "DevisSignature" DROP CONSTRAINT "DevisSignature_devisId_fkey";

ALTER TABLE "DevisSignature" ADD COLUMN "enregistreParId" TEXT;

UPDATE "DevisSignature"
SET "enregistreParId" = (
  SELECT "id" FROM "User" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1
)
WHERE "enregistreParId" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DevisSignature" WHERE "enregistreParId" IS NULL) THEN
    RAISE EXCEPTION 'Impossible de migrer DevisSignature : aucun utilisateur ne peut enregistrer les signatures existantes.';
  END IF;
END $$;

ALTER TABLE "DevisSignature" ALTER COLUMN "enregistreParId" SET NOT NULL;

CREATE INDEX "DevisSignature_enregistreParId_idx" ON "DevisSignature"("enregistreParId");

ALTER TABLE "DevisSignature"
  ADD CONSTRAINT "DevisSignature_devisId_fkey"
    FOREIGN KEY ("devisId") REFERENCES "Devis"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "DevisSignature_enregistreParId_fkey"
    FOREIGN KEY ("enregistreParId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
