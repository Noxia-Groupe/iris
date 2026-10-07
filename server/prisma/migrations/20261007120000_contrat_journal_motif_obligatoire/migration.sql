-- Les créations historiques de contrats n'ont pas de motif ; toute autre action
-- contractuelle doit en porter un, sans imposer cette règle aux autres cibles.
ALTER TABLE "JournalSaisieChantier"
  ADD CONSTRAINT "JournalSaisieChantier_contrat_motif_check"
  CHECK ("cible" <> 'CONTRAT' OR "action" = 'CREATION' OR "motif" IS NOT NULL);
