-- Cycle des statuts des pièces (#221, décision de Nelson du 19-10-2026) : le statut ne suit que le
-- cycle métier, exactement celui de l'application.
--   - toute pièce : brouillon → émise ;
--   - facture : émise → réglée et réglée → émise (d'après ses règlements, garde
--     facture_statut_reglements) ; émise → annulée, avec son avoir d'annulation créé dans la même
--     transaction (garde différé ci-dessous) ;
--   - « annulée » est définitif, et un avoir, né émis, le reste.
-- Le garde est nommé pour passer après facture_statut_reglements (ordre alphabétique) : ses refus
-- plus précis sur les règlements restent ceux que l'on voit.
CREATE FUNCTION verifier_transition_statut_facture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."statut" IS NOT DISTINCT FROM OLD."statut" THEN
    RETURN NEW;
  END IF;
  IF (OLD."statut" = 'BROUILLON' AND NEW."statut" = 'EMISE')
     OR (NEW."type" = 'FACTURE' AND (
       (OLD."statut" = 'EMISE' AND NEW."statut" IN ('REGLEE', 'ANNULEE')) OR
       (OLD."statut" = 'REGLEE' AND NEW."statut" = 'EMISE'))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Transition de statut hors du cycle des pièces : % → %.', OLD."statut", NEW."statut";
END $$;
CREATE TRIGGER facture_statut_transitions BEFORE UPDATE ON "Facture"
FOR EACH ROW EXECUTE FUNCTION verifier_transition_statut_facture();

-- Une facture ne s'annule qu'avec son avoir d'annulation : vérifié à la validation, l'application
-- passant la facture à « annulée » avant de créer l'avoir dans la même transaction. Les pièces
-- annulées avant cette migration (contre-passation historique sans avoir) ne sont pas revérifiées.
CREATE FUNCTION verifier_avoir_annulation_facture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Facture"
    WHERE "factureOrigineId" = NEW."id" AND "type" = 'AVOIR' AND "estAvoirAnnulation" AND "statut" <> 'BROUILLON'
  ) THEN
    RAISE EXCEPTION 'Une facture ne s''annule qu''avec son avoir d''annulation, émis dans la même transaction.';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER facture_annulation_avec_avoir AFTER UPDATE ON "Facture"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD."statut" IS DISTINCT FROM NEW."statut" AND NEW."statut" = 'ANNULEE')
EXECUTE FUNCTION verifier_avoir_annulation_facture();

-- Règlements et affectations (#222) : leurs triggers d'immuabilité sont des triggers de ligne, que
-- TRUNCATE ne déclenche pas. Le vidage est refusé à part, comme pour les pièces.
CREATE FUNCTION refuser_vidage_reglements() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Règlements et affectations : vidage interdit (TRUNCATE).';
END $$;
CREATE TRIGGER reglement_sans_vidage BEFORE TRUNCATE ON "Reglement" FOR EACH STATEMENT EXECUTE FUNCTION refuser_vidage_reglements();
CREATE TRIGGER affectation_reglement_sans_vidage BEFORE TRUNCATE ON "AffectationReglement" FOR EACH STATEMENT EXECUTE FUNCTION refuser_vidage_reglements();

-- Insertion d'écritures (#222) : la pièce est verrouillée en FOR NO KEY UPDATE, comme la mise à jour
-- qui la scelle, et non plus en verrou partagé. Deux transactions qui insèrent chacune des écritures
-- dans la même pièce non scellée, puis la mettent à jour, se sérialisent au lieu de s'interbloquer
-- (même correction que pour les lignes, migration 20261018120000).
CREATE OR REPLACE FUNCTION verifier_insertion_ecriture_facture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scellee BOOLEAN;
BEGIN
  SELECT "ecrituresScellees" INTO scellee FROM "Facture" WHERE "id" = NEW."factureId" FOR NO KEY UPDATE;
  IF scellee THEN
    RAISE EXCEPTION 'Écriture comptable scellée : insertion interdite';
  END IF;
  RETURN NEW;
END $$;
