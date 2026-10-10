-- Les créations initiales restent hors journal ; seules les transitions sont motivées.
CREATE TABLE "JournalRegleComptable" (
  "id" TEXT PRIMARY KEY,
  "type" TEXT NOT NULL,
  "cible" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "avant" TEXT NOT NULL,
  "apres" TEXT,
  "motif" TEXT NOT NULL,
  "auteurId" TEXT NOT NULL,
  "auteurNom" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JournalRegleComptable_transition_check" CHECK (
    (("type" = 'REGLE' AND "cible" IN ('CLIENT', 'VENTE_PRESTATION', 'VENTE_ARTICLE', 'JOURNAL_VENTES')) OR
     ("type" = 'TVA' AND "cible" ~ '^(0|[1-9][0-9]?|100)(\.[0-9]{1,2})?$'))
    AND (("action" = 'REMAPPAGE' AND "apres" IS NOT NULL AND "avant" <> "apres") OR
         ("action" = 'RETRAIT' AND "type" = 'TVA' AND "apres" IS NULL))
    AND char_length("avant") > 0 AND char_length("auteurNom") > 0
  ),
  CONSTRAINT "JournalRegleComptable_motif_check" CHECK (
    char_length(btrim("motif")) BETWEEN 3 AND 500 AND "motif" = btrim("motif")
    AND "motif" !~ '[[:cntrl:]]'
    AND "motif" !~ U&'[\200B-\200F\202A-\202E\2060-\206F\FEFF]'
  )
);
CREATE INDEX "JournalRegleComptable_type_cible_createdAt_idx" ON "JournalRegleComptable"("type", "cible", "createdAt");
CREATE INDEX "JournalRegleComptable_auteurId_idx" ON "JournalRegleComptable"("auteurId");
ALTER TABLE "JournalRegleComptable" ADD CONSTRAINT "JournalRegleComptable_auteurId_fkey"
  FOREIGN KEY ("auteurId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE FUNCTION "interdire_changement_journal_regle"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Journal des règles immuable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "journal_regle_append_only" BEFORE UPDATE OR DELETE ON "JournalRegleComptable"
  FOR EACH ROW EXECUTE FUNCTION "interdire_changement_journal_regle"();

-- Le contrôle différé vérifie la preuve créée dans la transaction courante, pas
-- une ancienne ligne ressemblante. L'UPDATE initial sans effet n'est pas une transition.
CREATE FUNCTION "verifier_journal_regle"() RETURNS trigger AS $$
DECLARE ancienne TEXT;
DECLARE nouvelle TEXT;
DECLARE identifiant TEXT;
DECLARE famille TEXT;
DECLARE operation TEXT;
BEGIN
  IF TG_TABLE_NAME = 'RegleComptable' THEN
    ancienne := COALESCE(OLD."journal", OLD."compteId");
    nouvelle := COALESCE(NEW."journal", NEW."compteId");
    identifiant := OLD."cle";
    famille := 'REGLE';
  ELSE
    ancienne := OLD."compteId";
    nouvelle := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."compteId" END;
    identifiant := trim(trailing '.' FROM trim(trailing '0' FROM OLD."taux"::text));
    famille := 'TVA';
  END IF;
  IF TG_OP = 'UPDATE' AND ancienne IS NOT DISTINCT FROM nouvelle THEN RETURN NULL; END IF;
  operation := CASE WHEN TG_OP = 'DELETE' THEN 'RETRAIT' ELSE 'REMAPPAGE' END;
  IF NOT EXISTS (SELECT 1 FROM "JournalRegleComptable" j
    WHERE j."type" = famille AND j."cible" = identifiant AND j."action" = operation
      AND j."avant" = ancienne AND j."apres" IS NOT DISTINCT FROM nouvelle
      AND j.xmin::text = (txid_current() % 4294967296)::text) THEN
    RAISE EXCEPTION 'Transition de règle sans journal motivé dans la même transaction';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "regle_journal_transition"
  AFTER UPDATE ON "RegleComptable" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "verifier_journal_regle"();
CREATE CONSTRAINT TRIGGER "tva_journal_transition_update"
  AFTER UPDATE ON "RegleTvaComptable" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "verifier_journal_regle"();
CREATE CONSTRAINT TRIGGER "tva_journal_transition_delete"
  AFTER DELETE ON "RegleTvaComptable" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "verifier_journal_regle"();
