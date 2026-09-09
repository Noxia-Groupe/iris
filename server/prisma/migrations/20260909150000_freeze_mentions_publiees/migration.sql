-- Une version publiée reste juridiquement figée : seule son activation peut évoluer.
CREATE OR REPLACE FUNCTION "interdire_modification_mentions_publiees"() RETURNS trigger AS $$
BEGIN
  IF OLD."publieeLe" IS NOT NULL AND (
    NEW."version" IS DISTINCT FROM OLD."version" OR
    NEW."mentions" IS DISTINCT FROM OLD."mentions" OR
    NEW."cgv" IS DISTINCT FROM OLD."cgv" OR
    NEW."penalites" IS DISTINCT FROM OLD."penalites" OR
    NEW."escompte" IS DISTINCT FROM OLD."escompte"
  ) THEN
    RAISE EXCEPTION 'Une version légale publiée est immuable.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MentionsLegalesVersion_immutabilite_publiee"
BEFORE UPDATE ON "MentionsLegalesVersion"
FOR EACH ROW EXECUTE FUNCTION "interdire_modification_mentions_publiees"();
