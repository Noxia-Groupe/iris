-- Vérification différée du statut « réglée » (suite de la PR #155) : au COMMIT, toute facture
-- émise ou réglée touchée par la transaction a le statut que ses règlements imposent. Le trigger
-- immédiat `facture_statut_reglements` ne contrôle que les changements de statut de la facture
-- elle-même ; celui-ci couvre aussi une contre-passation, une affectation ou un avoir écrits
-- directement en base, sans resynchronisation du statut.
-- Règle (décisions de Nelson des 16 et 17-10-2026) : « réglée » ⇔ reste dû nul ou négatif et au
-- moins un règlement non contre-passé.
CREATE FUNCTION verifier_statut_reglement_facture(facture_id TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE facture RECORD; regle BOOLEAN; soldee BOOLEAN;
BEGIN
  SELECT "type", "statut" INTO facture FROM "Facture" WHERE "id" = facture_id;
  IF NOT FOUND OR facture."type" <> 'FACTURE' OR facture."statut" NOT IN ('EMISE', 'REGLEE') THEN
    RETURN;
  END IF;
  SELECT EXISTS (SELECT 1 FROM "AffectationReglement" p JOIN "Reglement" r ON r."id" = p."reglementId" WHERE p."factureId" = facture_id AND r."statut" = 'ENREGISTRE') INTO regle;
  soldee := regle AND reste_du_facture(facture_id) <= 0;
  IF (facture."statut" = 'REGLEE') <> soldee THEN
    RAISE EXCEPTION 'Facture % : statut % incohérent avec ses règlements (réglée si le reste dû est nul ou négatif avec au moins un règlement non contre-passé).', facture_id, facture."statut";
  END IF;
END $$;

CREATE FUNCTION declencher_statut_reglement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE facture_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'AffectationReglement' THEN
    PERFORM verifier_statut_reglement_facture(NEW."factureId");
  ELSIF TG_TABLE_NAME = 'Reglement' THEN
    FOR facture_id IN SELECT "factureId" FROM "AffectationReglement" WHERE "reglementId" = NEW."id" LOOP
      PERFORM verifier_statut_reglement_facture(facture_id);
    END LOOP;
  ELSIF NEW."type" = 'AVOIR' THEN
    IF NEW."factureOrigineId" IS NOT NULL THEN
      PERFORM verifier_statut_reglement_facture(NEW."factureOrigineId");
    END IF;
  ELSE
    PERFORM verifier_statut_reglement_facture(NEW."id");
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER affectation_statut_facture AFTER INSERT ON "AffectationReglement"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION declencher_statut_reglement();
CREATE CONSTRAINT TRIGGER reglement_statut_factures AFTER UPDATE ON "Reglement"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION declencher_statut_reglement();
CREATE CONSTRAINT TRIGGER facture_statut_reglement_differe AFTER INSERT OR UPDATE ON "Facture"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION declencher_statut_reglement();
