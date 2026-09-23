-- L’auteur d’un archivage Travaux est une preuve d’audit : il doit référencer un compte Iris existant.
ALTER TABLE "AchatReel"
  ADD CONSTRAINT "AchatReel_archivedById_fkey"
  FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PointageHeure"
  ADD CONSTRAINT "PointageHeure_archivedById_fkey"
  FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
