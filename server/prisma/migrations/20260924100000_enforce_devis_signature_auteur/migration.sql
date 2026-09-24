-- Une signature est une preuve : une version antérieure ne porte pas l'identité de
-- l'employé qui l'a enregistrée. Ne jamais inventer cette provenance en l'attribuant à un
-- utilisateur arbitraire : l'administrateur doit d'abord la réparer explicitement.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DevisSignature") THEN
    RAISE EXCEPTION 'Impossible de migrer DevisSignature : des signatures existantes ne permettent pas d’établir leur enregistreur interne.';
  END IF;
END $$;

ALTER TABLE "DevisSignature" DROP CONSTRAINT "DevisSignature_devisId_fkey";

ALTER TABLE "DevisSignature" ADD COLUMN "enregistreParId" TEXT;

ALTER TABLE "DevisSignature" ALTER COLUMN "enregistreParId" SET NOT NULL;

CREATE INDEX "DevisSignature_enregistreParId_idx" ON "DevisSignature"("enregistreParId");

ALTER TABLE "DevisSignature"
  ADD CONSTRAINT "DevisSignature_devisId_fkey"
    FOREIGN KEY ("devisId") REFERENCES "Devis"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "DevisSignature_enregistreParId_fkey"
    FOREIGN KEY ("enregistreParId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
