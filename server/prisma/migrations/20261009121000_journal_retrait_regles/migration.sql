ALTER TABLE "JournalRegleComptable"
  ADD COLUMN "avantCode" TEXT,
  ADD COLUMN "avantLibelle" TEXT,
  ADD COLUMN "apresCode" TEXT,
  ADD COLUMN "apresLibelle" TEXT;
CREATE FUNCTION "figer_comptes_journal_regle"() RETURNS trigger AS $$
BEGIN
  IF NEW."type" = 'REGLE' AND NEW."cible" = 'JOURNAL_VENTES' THEN
    NEW."avantCode" := NEW."avant";
    NEW."avantLibelle" := 'Journal des ventes';
    NEW."apresCode" := NEW."apres";
    NEW."apresLibelle" := CASE WHEN NEW."apres" IS NULL THEN NULL ELSE 'Journal des ventes' END;
  ELSE
    SELECT "code", "libelle" INTO NEW."avantCode", NEW."avantLibelle"
      FROM "CompteComptable" WHERE "id" = NEW."avant";
    IF NEW."apres" IS NOT NULL THEN
      SELECT "code", "libelle" INTO NEW."apresCode", NEW."apresLibelle"
        FROM "CompteComptable" WHERE "id" = NEW."apres";
    ELSE
      NEW."apresCode" := NULL; NEW."apresLibelle" := NULL;
    END IF;
  END IF;
  IF NEW."avantCode" IS NULL OR NEW."avantLibelle" IS NULL OR
     (NEW."apres" IS NOT NULL AND (NEW."apresCode" IS NULL OR NEW."apresLibelle" IS NULL)) THEN
    RAISE EXCEPTION 'Compte du journal introuvable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "journal_regle_figer_comptes" BEFORE INSERT ON "JournalRegleComptable"
  FOR EACH ROW EXECUTE FUNCTION "figer_comptes_journal_regle"();

-- Les règles standards retirées sont soumises à la même preuve que la TVA.
ALTER TABLE "JournalRegleComptable" DROP CONSTRAINT "JournalRegleComptable_transition_check";
ALTER TABLE "JournalRegleComptable" ADD CONSTRAINT "JournalRegleComptable_transition_check" CHECK (
  (("type" = 'REGLE' AND "cible" IN ('CLIENT', 'VENTE_PRESTATION', 'VENTE_ARTICLE', 'JOURNAL_VENTES')) OR
   ("type" = 'TVA' AND "cible" ~ '^(100(\.0{1,2})?|([0-9]|[1-9][0-9])(\.[0-9]{1,2})?)$'))
  AND (("action" = 'REMAPPAGE' AND "apres" IS NOT NULL AND "avant" <> "apres") OR
       ("action" = 'RETRAIT' AND "apres" IS NULL))
  AND char_length("avant") > 0 AND char_length("auteurNom") > 0
);
CREATE OR REPLACE FUNCTION "verifier_journal_regle"() RETURNS trigger AS $$
DECLARE ancienne TEXT;
DECLARE nouvelle TEXT;
DECLARE identifiant TEXT;
DECLARE famille TEXT;
DECLARE operation TEXT;
BEGIN
  IF TG_TABLE_NAME = 'RegleComptable' THEN
    ancienne := COALESCE(OLD."journal", OLD."compteId");
    nouvelle := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE COALESCE(NEW."journal", NEW."compteId") END;
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
CREATE CONSTRAINT TRIGGER "regle_journal_transition_delete"
  AFTER DELETE ON "RegleComptable" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "verifier_journal_regle"();

-- Capturer chaque transition immédiatement (avant qu'un autre UPDATE ne masque son
-- état), puis comparer les cardinalités au commit dans les DEUX sens. Une preuve
-- similaire ne peut plus être réutilisée et une insertion isolée est rejetée.
CREATE TABLE "TransitionRegleComptable" (
  "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "transactionId" BIGINT NOT NULL,
  "type" TEXT NOT NULL,
  "cible" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "avant" TEXT NOT NULL,
  "apres" TEXT
);
CREATE INDEX "TransitionRegleComptable_transactionId_idx" ON "TransitionRegleComptable"("transactionId");
CREATE FUNCTION "proteger_transition_regle"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' OR pg_trigger_depth() <> 2 THEN
    RAISE EXCEPTION 'Preuve de transition immuable et réservée au trigger';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "transition_regle_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TransitionRegleComptable"
  FOR EACH ROW EXECUTE FUNCTION "proteger_transition_regle"();
CREATE FUNCTION "capturer_transition_regle"() RETURNS trigger AS $$
DECLARE ancienne TEXT;
DECLARE nouvelle TEXT;
DECLARE identifiant TEXT;
DECLARE famille TEXT;
BEGIN
  IF TG_TABLE_NAME = 'RegleComptable' THEN
    IF TG_OP = 'UPDATE' AND (OLD."id" IS DISTINCT FROM NEW."id" OR OLD."cle" IS DISTINCT FROM NEW."cle") THEN
      RAISE EXCEPTION 'Identité de règle immuable';
    END IF;
    ancienne := COALESCE(OLD."journal", OLD."compteId");
    nouvelle := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE COALESCE(NEW."journal", NEW."compteId") END;
    identifiant := OLD."cle";
    famille := 'REGLE';
  ELSE
    IF TG_OP = 'UPDATE' AND (OLD."id" IS DISTINCT FROM NEW."id" OR OLD."taux" IS DISTINCT FROM NEW."taux") THEN
      RAISE EXCEPTION 'Identité de taux immuable';
    END IF;
    ancienne := OLD."compteId";
    nouvelle := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."compteId" END;
    identifiant := trim(trailing '.' FROM trim(trailing '0' FROM OLD."taux"::text));
    famille := 'TVA';
  END IF;
  IF TG_OP = 'UPDATE' AND ancienne IS NOT DISTINCT FROM nouvelle THEN RETURN NULL; END IF;
  INSERT INTO "TransitionRegleComptable" ("transactionId", "type", "cible", "action", "avant", "apres") VALUES
    (txid_current(), famille, identifiant, CASE WHEN TG_OP = 'DELETE' THEN 'RETRAIT' ELSE 'REMAPPAGE' END, ancienne, nouvelle);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "regle_capturer_transition" AFTER UPDATE OR DELETE ON "RegleComptable"
  FOR EACH ROW EXECUTE FUNCTION "capturer_transition_regle"();
CREATE TRIGGER "tva_capturer_transition" AFTER UPDATE OR DELETE ON "RegleTvaComptable"
  FOR EACH ROW EXECUTE FUNCTION "capturer_transition_regle"();

CREATE OR REPLACE FUNCTION "verifier_journal_regle"() RETURNS trigger AS $$
DECLARE famille TEXT;
DECLARE identifiant TEXT;
DECLARE operation TEXT;
DECLARE ancienne TEXT;
DECLARE nouvelle TEXT;
DECLARE nb_transitions BIGINT;
DECLARE nb_journal BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'JournalRegleComptable' THEN
    famille := NEW."type"; identifiant := NEW."cible"; operation := NEW."action";
    ancienne := NEW."avant"; nouvelle := NEW."apres";
  ELSIF TG_TABLE_NAME = 'RegleComptable' THEN
    famille := 'REGLE'; identifiant := OLD."cle";
    ancienne := COALESCE(OLD."journal", OLD."compteId");
    nouvelle := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE COALESCE(NEW."journal", NEW."compteId") END;
  ELSE
    famille := 'TVA'; identifiant := trim(trailing '.' FROM trim(trailing '0' FROM OLD."taux"::text));
    ancienne := OLD."compteId";
    nouvelle := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."compteId" END;
  END IF;
  IF TG_TABLE_NAME <> 'JournalRegleComptable' THEN
    IF TG_OP = 'UPDATE' AND ancienne IS NOT DISTINCT FROM nouvelle THEN RETURN NULL; END IF;
    operation := CASE WHEN TG_OP = 'DELETE' THEN 'RETRAIT' ELSE 'REMAPPAGE' END;
  END IF;
  SELECT count(*) INTO nb_transitions FROM "TransitionRegleComptable" t
    WHERE t."transactionId" = txid_current() AND t."type" = famille AND t."cible" = identifiant AND t."action" = operation
      AND t."avant" = ancienne AND t."apres" IS NOT DISTINCT FROM nouvelle;
  SELECT count(*) INTO nb_journal FROM "JournalRegleComptable" j
    WHERE j."type" = famille AND j."cible" = identifiant AND j."action" = operation
      AND j."avant" = ancienne AND j."apres" IS NOT DISTINCT FROM nouvelle
      AND j.xmin::text = (txid_current() % 4294967296)::text;
  IF nb_transitions <> nb_journal THEN
    RAISE EXCEPTION 'Transition de règle sans journal motivé ou journal sans transition dans la même transaction';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "journal_regle_preuve" AFTER INSERT ON "JournalRegleComptable"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verifier_journal_regle"();
