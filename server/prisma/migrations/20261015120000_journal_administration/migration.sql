-- Journal des paramètres et des droits (lot (a), décision de Nelson du 13-10-2026).

-- Durée de conservation, réglable de 1 à 90 jours (décision du 14-10-2026 : une durée conforme au
-- RGPD, à faire valider ; à défaut, 90 jours au plus).
ALTER TABLE "Parametres" ADD COLUMN "journalConservationJours" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "Parametres" ADD CONSTRAINT "Parametres_journalConservationJours_check" CHECK ("journalConservationJours" BETWEEN 1 AND 90);

CREATE TABLE "JournalAdministration" (
    "id" TEXT NOT NULL,
    "domaine" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "cibleId" TEXT,
    "cibleLibelle" TEXT,
    "avant" JSONB,
    "apres" JSONB,
    "detail" TEXT,
    "concerneSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "reserveSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "auteurId" TEXT,
    "auteurNom" TEXT NOT NULL,
    "auteurSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JournalAdministration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JournalAdministration_domaine_check" CHECK ("domaine" IN ('DROITS', 'REGLAGES')),
    CONSTRAINT "JournalAdministration_auteur_check" CHECK (char_length(btrim("auteurNom")) > 0)
);
CREATE INDEX "JournalAdministration_createdAt_idx" ON "JournalAdministration"("createdAt");
CREATE INDEX "JournalAdministration_type_createdAt_idx" ON "JournalAdministration"("type", "createdAt");

-- L'horodatage est celui de l'écriture, jamais une valeur fournie : une entrée antidatée pourrait
-- sinon être supprimée aussitôt comme trop ancienne.
CREATE FUNCTION "horodater_journal_administration"() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "journal_administration_horodatage" BEFORE INSERT ON "JournalAdministration"
FOR EACH ROW EXECUTE FUNCTION "horodater_journal_administration"();

-- Ajout seul : aucune modification ; une suppression seulement au-delà de la durée de conservation.
CREATE FUNCTION "proteger_journal_administration"() RETURNS trigger AS $$
DECLARE
  conservation INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Journal des paramètres et des droits immuable : modification interdite';
  END IF;
  SELECT "journalConservationJours" INTO conservation FROM "Parametres" WHERE "id" = 'singleton';
  IF OLD."createdAt" >= CURRENT_TIMESTAMP - make_interval(days => COALESCE(conservation, 90)) THEN
    RAISE EXCEPTION 'Journal des paramètres et des droits : une entrée ne se supprime qu''au-delà de la durée de conservation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "journal_administration_ajout_seul" BEFORE UPDATE OR DELETE ON "JournalAdministration"
FOR EACH ROW EXECUTE FUNCTION "proteger_journal_administration"();

CREATE FUNCTION "refuser_vidage_journal_administration"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Journal des paramètres et des droits : vidage interdit';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "journal_administration_sans_vidage" BEFORE TRUNCATE ON "JournalAdministration"
FOR EACH STATEMENT EXECUTE FUNCTION "refuser_vidage_journal_administration"();
