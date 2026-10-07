-- Ne pas attribuer rétrospectivement une date de demande aux interventions historiques.
ALTER TABLE "Intervention" ADD COLUMN "dateDemande" DATE;

-- Le début du contrat est la borne de validité de toutes ses interventions. Même une
-- écriture SQL technique ne doit pas pouvoir déplacer cette borne après rattachement.
CREATE FUNCTION "figer_date_debut_contrat"() RETURNS trigger AS $$
BEGIN
  IF NEW."dateDebut" IS DISTINCT FROM OLD."dateDebut" THEN
    RAISE EXCEPTION 'La date de début du contrat est immuable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ContratMaintenance_dateDebut_immutable"
BEFORE UPDATE OF "dateDebut" ON "ContratMaintenance"
FOR EACH ROW EXECUTE FUNCTION "figer_date_debut_contrat"();

CREATE FUNCTION "verifier_date_demande_intervention"() RETURNS trigger AS $$
DECLARE debut timestamp(3);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."contratMaintenanceId" IS NOT NULL AND
       (NEW."contratMaintenanceId" IS DISTINCT FROM OLD."contratMaintenanceId"
        OR NEW."dateDemande" IS DISTINCT FROM OLD."dateDemande") THEN
      RAISE EXCEPTION 'La date de demande et le rattachement contractuel sont figés.' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."contratMaintenanceId" IS NULL AND NEW."contratMaintenanceId" IS NOT NULL
       AND NEW."dateDemande" IS DISTINCT FROM OLD."dateDemande" THEN
      RAISE EXCEPTION 'La date de demande ne peut changer lors du rattachement.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."contratMaintenanceId" IS NOT NULL THEN
    IF NEW."dateDemande" IS NULL THEN
      RAISE EXCEPTION 'La date de demande est obligatoire pour un contrat.' USING ERRCODE = 'check_violation';
    END IF;
    -- La lecture avec verrou protège aussi les mises à jour concurrentes du contrat.
    SELECT "dateDebut" INTO debut FROM "ContratMaintenance" WHERE "id" = NEW."contratMaintenanceId" FOR SHARE;
    IF debut IS NOT NULL AND NEW."dateDemande" < debut::date THEN
      RAISE EXCEPTION 'La date de demande précède le début du contrat.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Intervention_dateDemande_contrat"
BEFORE INSERT OR UPDATE OF "dateDemande", "contratMaintenanceId" ON "Intervention"
FOR EACH ROW EXECUTE FUNCTION "verifier_date_demande_intervention"();
