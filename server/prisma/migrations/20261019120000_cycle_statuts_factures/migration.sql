-- Cycle des statuts des pièces (#221, décision de Nelson du 19-10-2026) : le statut ne suit que le
-- cycle métier, exactement celui de l'application.
--   - une pièce naît brouillon ou émise, jamais réglée ni annulée ;
--   - toute pièce : brouillon → émise ;
--   - facture : émise → réglée et réglée → émise (d'après ses règlements, garde
--     facture_statut_reglements) ; émise → annulée, avec son avoir d'annulation créé dans la même
--     transaction (gardes différés ci-dessous) ;
--   - « annulée » est définitif, et un avoir, né émis, le reste.
-- Le garde est nommé pour passer après facture_statut_reglements (ordre alphabétique) : ses refus
-- plus précis sur les règlements restent ceux que l'on voit (facture créée « réglée », passage à
-- « réglée » sans être soldée). Un statut hors des quatre valeurs n'est pas refusé ici à la
-- création : la contrainte Facture_statut_check s'en charge.
CREATE FUNCTION verifier_transition_statut_facture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."statut" IN ('REGLEE', 'ANNULEE') THEN
      RAISE EXCEPTION 'Création hors du cycle des pièces : une pièce naît brouillon ou émise, pas « % ».', NEW."statut";
    END IF;
    RETURN NEW;
  END IF;
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
CREATE TRIGGER facture_statut_transitions BEFORE INSERT OR UPDATE ON "Facture"
FOR EACH ROW EXECUTE FUNCTION verifier_transition_statut_facture();

-- Une facture ne s'annule qu'avec son avoir d'annulation, émis et aux mêmes montants : vérifié à la
-- validation, l'application passant la facture à « annulée » avant de créer l'avoir dans la même
-- transaction. Les pièces annulées avant cette migration (contre-passation historique sans avoir) ne
-- sont pas revérifiées.
CREATE FUNCTION verifier_avoir_annulation_facture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Facture" a
    WHERE a."factureOrigineId" = NEW."id" AND a."type" = 'AVOIR' AND a."estAvoirAnnulation" AND a."statut" = 'EMISE'
      AND a."totalHt" = NEW."totalHt" AND a."totalTva" = NEW."totalTva" AND a."totalTtc" = NEW."totalTtc"
  ) THEN
    RAISE EXCEPTION 'Une facture ne s''annule qu''avec son avoir d''annulation, émis aux mêmes montants dans la même transaction.';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER facture_annulation_avec_avoir AFTER UPDATE ON "Facture"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD."statut" IS DISTINCT FROM NEW."statut" AND NEW."statut" = 'ANNULEE')
EXECUTE FUNCTION verifier_avoir_annulation_facture();

-- Réciproquement, un avoir d'annulation est émis et n'existe qu'avec sa facture annulée, aux mêmes
-- montants : vérifié à la validation de chaque transaction qui le crée ou le modifie, sur la ligne
-- telle qu'elle est alors (et non telle qu'à l'événement qui a déclenché le contrôle). La contrainte
-- Facture_avoir_annulation_check en fait déjà un avoir, et l'index unique
-- Facture_un_avoir_annulation_par_origine le seul de sa facture. Comme « annulée » est
-- définitif et que la facture n'y passe qu'avec son avoir, les deux naissent dans la même
-- transaction : créé avant, l'avoir verrait sa facture encore émise ; créé après, il ne serait plus
-- le seul. Seule une facture annulée avant cette migration, sans avoir, peut encore en recevoir un.
CREATE FUNCTION verifier_origine_avoir_annulation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Facture" WHERE "id" = NEW."id" AND "estAvoirAnnulation") AND NOT EXISTS (
    SELECT 1 FROM "Facture" a JOIN "Facture" f ON f."id" = a."factureOrigineId"
    WHERE a."id" = NEW."id" AND a."statut" = 'EMISE' AND f."type" = 'FACTURE' AND f."statut" = 'ANNULEE'
      AND f."totalHt" = a."totalHt" AND f."totalTva" = a."totalTva" AND f."totalTtc" = a."totalTtc"
  ) THEN
    RAISE EXCEPTION 'Un avoir d''annulation est émis et n''existe qu''avec sa facture annulée, aux mêmes montants.';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER facture_avoir_annulation_origine AFTER INSERT OR UPDATE ON "Facture"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW."estAvoirAnnulation")
EXECUTE FUNCTION verifier_origine_avoir_annulation();

-- Vidage (#222) : les triggers d'immuabilité des règlements, de leurs affectations et des journaux
-- comptables en ajout seul sont des triggers de ligne, que TRUNCATE ne déclenche pas. Le vidage est
-- refusé à part, comme pour les pièces et les devis ; le message nomme la table refusée.
CREATE FUNCTION refuser_vidage_sans_suppression() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Vidage de « % » interdit (TRUNCATE) : ses lignes ne se suppriment pas.', TG_TABLE_NAME;
END $$;
CREATE TRIGGER reglement_sans_vidage BEFORE TRUNCATE ON "Reglement" FOR EACH STATEMENT EXECUTE FUNCTION refuser_vidage_sans_suppression();
CREATE TRIGGER affectation_reglement_sans_vidage BEFORE TRUNCATE ON "AffectationReglement" FOR EACH STATEMENT EXECUTE FUNCTION refuser_vidage_sans_suppression();
CREATE TRIGGER journal_compte_sans_vidage BEFORE TRUNCATE ON "JournalCompteComptable" FOR EACH STATEMENT EXECUTE FUNCTION refuser_vidage_sans_suppression();
CREATE TRIGGER journal_regle_sans_vidage BEFORE TRUNCATE ON "JournalRegleComptable" FOR EACH STATEMENT EXECUTE FUNCTION refuser_vidage_sans_suppression();
CREATE TRIGGER transition_regle_sans_vidage BEFORE TRUNCATE ON "TransitionRegleComptable" FOR EACH STATEMENT EXECUTE FUNCTION refuser_vidage_sans_suppression();

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
