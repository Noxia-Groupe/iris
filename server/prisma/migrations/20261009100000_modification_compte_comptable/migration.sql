-- Extension additive du journal : les activations historiques gardent leur forme.
ALTER TABLE "JournalCompteComptable"
  ALTER COLUMN "avant" DROP NOT NULL,
  ALTER COLUMN "apres" DROP NOT NULL,
  ADD COLUMN "avantLibelle" TEXT,
  ADD COLUMN "apresLibelle" TEXT,
  ADD COLUMN "avantNature" TEXT,
  ADD COLUMN "apresNature" TEXT;

ALTER TABLE "JournalCompteComptable" DROP CONSTRAINT "JournalCompteComptable_transition_check";
ALTER TABLE "JournalCompteComptable" ADD CONSTRAINT "JournalCompteComptable_transition_check" CHECK (
  ("action" = 'DESACTIVATION' AND "avant" IS TRUE AND "apres" IS FALSE
    AND "avantLibelle" IS NULL AND "apresLibelle" IS NULL AND "avantNature" IS NULL AND "apresNature" IS NULL)
  OR ("action" = 'REACTIVATION' AND "avant" IS FALSE AND "apres" IS TRUE
    AND "avantLibelle" IS NULL AND "apresLibelle" IS NULL AND "avantNature" IS NULL AND "apresNature" IS NULL)
  OR ("action" = 'MODIFICATION' AND "avant" IS NULL AND "apres" IS NULL
    AND "avantLibelle" IS NOT NULL AND "apresLibelle" IS NOT NULL
    AND "avantNature" IS NOT NULL AND "apresNature" IS NOT NULL
    AND char_length(btrim("avantLibelle")) > 0 AND char_length(btrim("apresLibelle")) > 0
    AND "avantLibelle" = btrim("avantLibelle") AND "apresLibelle" = btrim("apresLibelle")
    -- L'instantané avant peut conserver un caractère C1 accepté historiquement.
    AND "apresLibelle" !~ '[[:cntrl:]]'
    AND "apresLibelle" !~ U&'[\200B-\200F\202A-\202E\2060-\206F\FEFF]'
    AND "avantNature" IN ('ACTIF', 'PASSIF', 'PRODUIT', 'CHARGE', 'TVA')
    AND "apresNature" IN ('ACTIF', 'PASSIF', 'PRODUIT', 'CHARGE', 'TVA')
    AND ("avantLibelle" <> "apresLibelle" OR "avantNature" <> "apresNature"))
);

-- Motif commun aux activations et aux modifications, sans contrôles invisibles.
ALTER TABLE "JournalCompteComptable" DROP CONSTRAINT "JournalCompteComptable_motif_check";
ALTER TABLE "JournalCompteComptable" ADD CONSTRAINT "JournalCompteComptable_motif_check" CHECK (
  char_length(btrim("motif")) BETWEEN 3 AND 500 AND "motif" = btrim("motif")
  AND "motif" !~ '[[:cntrl:]]'
  AND "motif" !~ U&'[\200B-\200F\202A-\202E\2060-\206F\FEFF]'
);

CREATE FUNCTION "interdire_changement_code_compte"() RETURNS trigger AS $$
BEGIN
  IF NEW."code" IS DISTINCT FROM OLD."code" THEN
    RAISE EXCEPTION 'Code du compte comptable immuable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "compte_code_immutable" BEFORE UPDATE ON "CompteComptable"
FOR EACH ROW EXECUTE FUNCTION "interdire_changement_code_compte"();

-- Le jeton de version est un instant Prisma (précision milliseconde). Garantir sa
-- progression même lors de deux écritures dans la même milliseconde, y compris en SQL.
CREATE FUNCTION "avancer_version_compte"() RETURNS trigger AS $$
BEGIN
  NEW."updatedAt" := date_trunc('milliseconds', greatest(NEW."updatedAt", OLD."updatedAt" + interval '1 millisecond'));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "compte_version_monotone" BEFORE UPDATE ON "CompteComptable"
FOR EACH ROW EXECUTE FUNCTION "avancer_version_compte"();

-- Un UPDATE direct reste possible uniquement si sa transition exacte possède un
-- journal motivé inséré dans LA MÊME transaction. Le contrôle différé autorise
-- l'ordre UPDATE puis INSERT utilisé par l'API, sans variable de session/bypass.
CREATE FUNCTION "verifier_journal_modification_compte"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "JournalCompteComptable" j
    WHERE j."compteId" = NEW."id" AND j."action" = 'MODIFICATION'
      AND j."avantLibelle" = OLD."libelle" AND j."apresLibelle" = NEW."libelle"
      AND j."avantNature" = OLD."nature" AND j."apresNature" = NEW."nature"
      AND j.xmin::text = (txid_current() % 4294967296)::text
  ) THEN
    RAISE EXCEPTION 'Modification du compte sans journal motivé dans la même transaction';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "compte_modification_journal"
AFTER UPDATE ON "CompteComptable" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (OLD."libelle" IS DISTINCT FROM NEW."libelle" OR OLD."nature" IS DISTINCT FROM NEW."nature")
EXECUTE FUNCTION "verifier_journal_modification_compte"();
