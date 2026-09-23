-- Toute trace métier du journal doit désigner un compte Iris réel ; le nom reste figé dans auteurNom.
ALTER TABLE "JournalSaisieChantier"
  ALTER COLUMN "auteurId" SET NOT NULL,
  ADD CONSTRAINT "JournalSaisieChantier_auteurId_fkey"
    FOREIGN KEY ("auteurId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
