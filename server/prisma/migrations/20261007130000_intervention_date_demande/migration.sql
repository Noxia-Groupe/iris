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

-- Un changement de client du contrat ne doit pas invalider les interventions déjà liées.
CREATE FUNCTION "figer_client_contrat_rattache"() RETURNS trigger AS $$
BEGIN
  IF NEW."clientId" IS DISTINCT FROM OLD."clientId" AND EXISTS (
    SELECT 1 FROM "Intervention" WHERE "contratMaintenanceId" = OLD.id
  ) THEN
    RAISE EXCEPTION 'Le client du contrat rattaché est figé.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ContratMaintenance_client_rattache_immutable"
BEFORE UPDATE OF "clientId" ON "ContratMaintenance"
FOR EACH ROW EXECUTE FUNCTION "figer_client_contrat_rattache"();

CREATE FUNCTION "verifier_date_demande_intervention"() RETURNS trigger AS $$
DECLARE debut timestamp(3);
        client_contrat text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Toute date renseignée est figée, même sur une intervention libre. Seul
    -- l'historique NULL peut recevoir sa première date, sans la modifier ensuite.
    IF OLD."dateDemande" IS NOT NULL AND NEW."dateDemande" IS DISTINCT FROM OLD."dateDemande" THEN
      RAISE EXCEPTION 'La date de demande est figée.' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."contratMaintenanceId" IS NOT NULL AND
       (NEW."contratMaintenanceId" IS DISTINCT FROM OLD."contratMaintenanceId"
        OR NEW."clientId" IS DISTINCT FROM OLD."clientId") THEN
      RAISE EXCEPTION 'Le client et le rattachement contractuel sont figés.' USING ERRCODE = 'check_violation';
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
    -- Le verrou empêche de changer le client ou la date du contrat en parallèle.
    SELECT "dateDebut", "clientId" INTO debut, client_contrat
      FROM "ContratMaintenance" WHERE "id" = NEW."contratMaintenanceId" FOR SHARE;
    IF client_contrat IS NOT NULL AND NEW."clientId" IS DISTINCT FROM client_contrat THEN
      RAISE EXCEPTION 'Le client de l’intervention diffère de celui du contrat.' USING ERRCODE = 'check_violation';
    END IF;
    IF debut IS NOT NULL AND NEW."dateDemande" < debut::date THEN
      RAISE EXCEPTION 'La date de demande précède le début du contrat.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Intervention_dateDemande_contrat"
BEFORE INSERT OR UPDATE OF "dateDemande", "contratMaintenanceId", "clientId" ON "Intervention"
FOR EACH ROW EXECUTE FUNCTION "verifier_date_demande_intervention"();
