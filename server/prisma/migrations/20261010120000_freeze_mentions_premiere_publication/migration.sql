-- Une version publiée conserve son horodatage de première publication ; seule son activation peut évoluer.
CREATE OR REPLACE FUNCTION "interdire_modification_mentions_publiees"() RETURNS trigger AS $$
BEGIN
  IF OLD."publieeLe" IS NOT NULL AND (
    NEW."id" IS DISTINCT FROM OLD."id" OR
    NEW."version" IS DISTINCT FROM OLD."version" OR
    NEW."mentions" IS DISTINCT FROM OLD."mentions" OR
    NEW."cgv" IS DISTINCT FROM OLD."cgv" OR
    NEW."penalites" IS DISTINCT FROM OLD."penalites" OR
    NEW."escompte" IS DISTINCT FROM OLD."escompte" OR
    NEW."publieeLe" IS DISTINCT FROM OLD."publieeLe"
  ) THEN
    RAISE EXCEPTION 'Une version légale publiée est immuable.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
