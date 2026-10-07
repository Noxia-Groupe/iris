-- Préserver les journaux historiques sans motif, tout en contrôlant les nouvelles lignes.
-- Seules les créations de contrat peuvent rester sans motif ; les autres cibles sont inchangées.
ALTER TABLE "JournalSaisieChantier"
  ADD CONSTRAINT "JournalSaisieChantier_contrat_motif_check"
  CHECK ("cible" <> 'CONTRAT' OR "action" = 'CREATION' OR ("motif" IS NOT NULL AND btrim("motif") <> '')) NOT VALID;
