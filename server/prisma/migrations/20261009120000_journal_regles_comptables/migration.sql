-- Chaque création, remappage et retrait est motivé dans la transaction courante.
CREATE TABLE "JournalRegleComptable" (
  "id" TEXT PRIMARY KEY,
  "type" TEXT NOT NULL,
  "cible" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "avant" TEXT,
  "apres" TEXT,
  "avantCode" TEXT,
  "avantLibelle" TEXT,
  "apresCode" TEXT,
  "apresLibelle" TEXT,
  "motif" TEXT NOT NULL,
  "auteurId" TEXT NOT NULL,
  "auteurNom" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JournalRegleComptable_transition_check" CHECK (
    (("type" = 'REGLE' AND "cible" IN ('CLIENT', 'VENTE_PRESTATION', 'VENTE_ARTICLE', 'JOURNAL_VENTES')) OR
     ("type" = 'TVA' AND "cible" ~ '^(100(\.0{1,2})?|([0-9]|[1-9][0-9])(\.[0-9]{1,2})?)$'))
    AND (("action" = 'CREATION' AND "avant" IS NULL AND "apres" IS NOT NULL) OR
         ("action" = 'REMAPPAGE' AND "avant" IS NOT NULL AND "apres" IS NOT NULL AND "avant" <> "apres") OR
         ("action" = 'RETRAIT' AND "avant" IS NOT NULL AND "apres" IS NULL))
    AND char_length("auteurNom") > 0
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

CREATE FUNCTION "figer_comptes_journal_regle"() RETURNS trigger AS $$
BEGIN
  IF NEW."type" = 'REGLE' AND NEW."cible" = 'JOURNAL_VENTES' THEN
    NEW."avantCode" := NEW."avant";
    NEW."avantLibelle" := CASE WHEN NEW."avant" IS NULL THEN NULL ELSE 'Journal des ventes' END;
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
  IF (NEW."avant" IS NOT NULL AND (NEW."avantCode" IS NULL OR NEW."avantLibelle" IS NULL)) OR
     (NEW."apres" IS NOT NULL AND (NEW."apresCode" IS NULL OR NEW."apresLibelle" IS NULL)) THEN
    RAISE EXCEPTION 'Compte du journal introuvable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "journal_regle_figer_comptes" BEFORE INSERT ON "JournalRegleComptable"
  FOR EACH ROW EXECUTE FUNCTION "figer_comptes_journal_regle"();

-- Capturer chaque transition immédiatement (avant qu'un autre UPDATE ne masque son
-- état), puis comparer les cardinalités au commit dans les DEUX sens. Une preuve
-- similaire ne peut plus être réutilisée et une insertion isolée est rejetée.
CREATE TABLE "TransitionRegleComptable" (
  "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "transactionId" BIGINT NOT NULL,
  "type" TEXT NOT NULL,
  "cible" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "avant" TEXT,
  "apres" TEXT
);
CREATE INDEX "TransitionRegleComptable_transactionId_idx" ON "TransitionRegleComptable"("transactionId");
-- Ce ledger compte les transitions identiques dans une transaction : sans lui,
-- un journal A→B pourrait prouver deux mutations A→B successives. Le rôle SQL
-- propriétaire/migrateur est de confiance (il peut déjà désactiver les triggers) ;
-- les rôles applicatifs non propriétaires ne doivent recevoir aucun droit direct.
-- Ne pas inférer une provenance de pg_trigger_depth(), qui varie si un trigger
-- supplémentaire enveloppe la mutation. L'insertion est faite par les triggers
-- des règles ; toute altération ultérieure du ledger est interdite.
REVOKE ALL ON "TransitionRegleComptable" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "TransitionRegleComptable_id_seq" FROM PUBLIC;
CREATE FUNCTION "proteger_transition_regle"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Preuve de transition immuable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "transition_regle_guard" BEFORE UPDATE OR DELETE ON "TransitionRegleComptable"
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
CREATE TRIGGER "regle_capturer_transition" AFTER UPDATE OR DELETE ON "RegleComptable"
  FOR EACH ROW EXECUTE FUNCTION "capturer_transition_regle"();
CREATE TRIGGER "tva_capturer_transition" AFTER UPDATE OR DELETE ON "RegleTvaComptable"
  FOR EACH ROW EXECUTE FUNCTION "capturer_transition_regle"();

-- INSERT utilise NEW uniquement : aucune lecture de OLD pour une création.
CREATE FUNCTION "capturer_creation_regle"() RETURNS trigger AS $$
BEGIN
  INSERT INTO "TransitionRegleComptable" ("transactionId", "type", "cible", "action", "avant", "apres")
  VALUES (txid_current(), 'REGLE', NEW."cle", 'CREATION', NULL, COALESCE(NEW."journal", NEW."compteId"));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
CREATE TRIGGER "regle_capturer_creation" AFTER INSERT ON "RegleComptable"
  FOR EACH ROW EXECUTE FUNCTION "capturer_creation_regle"();
-- La TVA ne possède pas de colonne journal : fonction dédiée.
CREATE FUNCTION "capturer_creation_tva"() RETURNS trigger AS $$
BEGIN
  INSERT INTO "TransitionRegleComptable" ("transactionId", "type", "cible", "action", "avant", "apres")
  VALUES (txid_current(), 'TVA', trim(trailing '.' FROM trim(trailing '0' FROM NEW."taux"::text)), 'CREATION', NULL, NEW."compteId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
CREATE TRIGGER "tva_capturer_creation" AFTER INSERT ON "RegleTvaComptable"
  FOR EACH ROW EXECUTE FUNCTION "capturer_creation_tva"();

-- Vérifier au commit les deux sens de la preuve, avec cardinalité par transition.
-- Un UPDATE sans changement de mapping ne produit aucune transition.
CREATE FUNCTION "verifier_journal_regle"() RETURNS trigger AS $$
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
    famille := 'REGLE'; identifiant := CASE WHEN TG_OP = 'INSERT' THEN NEW."cle" ELSE OLD."cle" END;
    ancienne := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE COALESCE(OLD."journal", OLD."compteId") END;
    nouvelle := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE COALESCE(NEW."journal", NEW."compteId") END;
  ELSE
    famille := 'TVA'; identifiant := CASE WHEN TG_OP = 'INSERT' THEN trim(trailing '.' FROM trim(trailing '0' FROM NEW."taux"::text)) ELSE trim(trailing '.' FROM trim(trailing '0' FROM OLD."taux"::text)) END;
    ancienne := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."compteId" END;
    nouvelle := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."compteId" END;
  END IF;
  IF TG_TABLE_NAME <> 'JournalRegleComptable' THEN
    IF TG_OP = 'UPDATE' AND ancienne IS NOT DISTINCT FROM nouvelle THEN RETURN NULL; END IF;
    operation := CASE WHEN TG_OP = 'INSERT' THEN 'CREATION' WHEN TG_OP = 'DELETE' THEN 'RETRAIT' ELSE 'REMAPPAGE' END;
  END IF;
  SELECT count(*) INTO nb_transitions FROM "TransitionRegleComptable" t
    WHERE t."transactionId" = txid_current() AND t."type" = famille AND t."cible" = identifiant AND t."action" = operation
      AND t."avant" IS NOT DISTINCT FROM ancienne AND t."apres" IS NOT DISTINCT FROM nouvelle;
  SELECT count(*) INTO nb_journal FROM "JournalRegleComptable" j
    WHERE j."type" = famille AND j."cible" = identifiant AND j."action" = operation
      AND j."avant" IS NOT DISTINCT FROM ancienne AND j."apres" IS NOT DISTINCT FROM nouvelle
      AND j.xmin::text = (txid_current() % 4294967296)::text;
  IF nb_transitions <> nb_journal THEN
    RAISE EXCEPTION 'Transition de règle sans journal motivé ou journal sans transition dans la même transaction';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
CREATE CONSTRAINT TRIGGER "journal_regle_preuve" AFTER INSERT ON "JournalRegleComptable"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verifier_journal_regle"();
CREATE CONSTRAINT TRIGGER "regle_journal_creation" AFTER INSERT ON "RegleComptable"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verifier_journal_regle"();
CREATE CONSTRAINT TRIGGER "tva_journal_creation" AFTER INSERT ON "RegleTvaComptable"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verifier_journal_regle"();
CREATE CONSTRAINT TRIGGER "regle_journal_transition" AFTER UPDATE ON "RegleComptable"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verifier_journal_regle"();
CREATE CONSTRAINT TRIGGER "regle_journal_transition_delete" AFTER DELETE ON "RegleComptable"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verifier_journal_regle"();
CREATE CONSTRAINT TRIGGER "tva_journal_transition_update" AFTER UPDATE ON "RegleTvaComptable"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verifier_journal_regle"();
CREATE CONSTRAINT TRIGGER "tva_journal_transition_delete" AFTER DELETE ON "RegleTvaComptable"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verifier_journal_regle"();
