-- Le journal d'audit doit survivre à toute tentative de suppression de sa facture parente.
ALTER TABLE "JournalFacture" DROP CONSTRAINT "JournalFacture_factureId_fkey";
ALTER TABLE "JournalFacture"
  ADD CONSTRAINT "JournalFacture_factureId_fkey"
  FOREIGN KEY ("factureId") REFERENCES "Facture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
