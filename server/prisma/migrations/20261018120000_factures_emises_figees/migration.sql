-- Une facture émise est un document figé (règle 2, #180) : ses totaux, son identité et ses
-- écritures l'étaient déjà en base ; ses lignes, sa ventilation de TVA (ajouts compris), ses
-- mentions légales et son journal ne l'étaient pas, ou seulement en partie.

-- Lignes et ventilation de TVA. Une ligne ne s'ajoute plus une fois les écritures de la pièce
-- scellées : le scellement accompagne toujours l'émission (garde différé facture_equilibre_ecritures)
-- et ne se défait pas. Un avoir, créé émis avec son contenu puis scellé dans la même transaction,
-- reste donc possible. Une ligne ne se modifie ni ne se supprime hors brouillon ni sur une pièce
-- scellée, ni vers une pièce qui n'est plus un brouillon. La pièce est verrouillée (FOR NO KEY
-- UPDATE, comme la mise à jour qui l'émet ou la scelle) : ces écritures se sérialisent avec son
-- émission, sans qu'une transaction tenant un verrou partagé ne doive ensuite le renforcer.
-- La suppression en cascade d'une pièce ne voit plus la pièce et reste possible, comme avant.
CREATE FUNCTION figer_contenu_facture_emise() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE piece RECORD;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT "statut", "ecrituresScellees" INTO piece FROM "Facture" WHERE "id" = OLD."factureId" FOR NO KEY UPDATE;
    IF piece."statut" <> 'BROUILLON' OR piece."ecrituresScellees" THEN
      RAISE EXCEPTION '%', TG_ARGV[0];
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  SELECT "statut", "ecrituresScellees" INTO piece FROM "Facture" WHERE "id" = NEW."factureId" FOR NO KEY UPDATE;
  IF piece."ecrituresScellees" OR (TG_OP = 'UPDATE' AND piece."statut" <> 'BROUILLON') THEN
    RAISE EXCEPTION '%', TG_ARGV[0];
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER facture_ligne_figee BEFORE INSERT OR UPDATE OR DELETE ON "FactureLigne"
FOR EACH ROW EXECUTE FUNCTION figer_contenu_facture_emise('Les lignes d’une facture émise sont immuables.');

-- La ventilation n'était gardée qu'en modification et suppression, et seulement pour trois statuts
-- nommés : un ajout passait, et un statut inconnu rouvrait la modification.
DROP TRIGGER "FactureVentilationTva_immutabilite_emise" ON "FactureVentilationTva";
DROP FUNCTION "interdire_modification_ventilation_facture_emise"();
CREATE TRIGGER "FactureVentilationTva_immutabilite_emise" BEFORE INSERT OR UPDATE OR DELETE ON "FactureVentilationTva"
FOR EACH ROW EXECUTE FUNCTION figer_contenu_facture_emise('La ventilation TVA d’une facture émise est immuable.');

-- Journal des factures : ajout seul, horodaté par la base, comme le journal des paramètres et des
-- droits (l'export date une contre-passation historique par son entrée d'annulation).
CREATE FUNCTION horodater_journal_facture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."createdAt" := clock_timestamp() AT TIME ZONE 'UTC';
  RETURN NEW;
END $$;
CREATE TRIGGER journal_facture_horodatage BEFORE INSERT ON "JournalFacture"
FOR EACH ROW EXECUTE FUNCTION horodater_journal_facture();

CREATE FUNCTION proteger_journal_facture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Journal des factures immuable : modification et suppression interdites.';
END $$;
CREATE TRIGGER journal_facture_ajout_seul BEFORE UPDATE OR DELETE ON "JournalFacture"
FOR EACH ROW EXECUTE FUNCTION proteger_journal_facture();

-- TRUNCATE ne déclenche pas les triggers de ligne : il est refusé à part, pour le contenu, les
-- écritures et le journal des pièces.
CREATE FUNCTION refuser_vidage_facture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Lignes, ventilation, écritures et journal des factures : vidage interdit (TRUNCATE).';
END $$;
CREATE TRIGGER facture_ligne_sans_vidage BEFORE TRUNCATE ON "FactureLigne" FOR EACH STATEMENT EXECUTE FUNCTION refuser_vidage_facture();
CREATE TRIGGER facture_ventilation_sans_vidage BEFORE TRUNCATE ON "FactureVentilationTva" FOR EACH STATEMENT EXECUTE FUNCTION refuser_vidage_facture();
CREATE TRIGGER ecriture_facture_sans_vidage BEFORE TRUNCATE ON "EcritureFacture" FOR EACH STATEMENT EXECUTE FUNCTION refuser_vidage_facture();
CREATE TRIGGER journal_facture_sans_vidage BEFORE TRUNCATE ON "JournalFacture" FOR EACH STATEMENT EXECUTE FUNCTION refuser_vidage_facture();

-- Statut : seules les valeurs du cycle documenté (schéma Prisma) sont admises. Une valeur inconnue
-- sortait la pièce de l'export comptable et rouvrait les gardes écrits pour des statuts nommés.
ALTER TABLE "Facture" ADD CONSTRAINT "Facture_statut_check" CHECK ("statut" IN ('BROUILLON', 'EMISE', 'REGLEE', 'ANNULEE'));

-- Mentions et liens figés : la version des mentions légales et des CGV imprimées sur la pièce, et
-- l'instant d'émission, s'ajoutent aux colonnes figées hors brouillon. Une pièce émise ne
-- redevient jamais brouillon : ce retour rouvrirait d'un coup tous les gardes qui ne figent que
-- hors brouillon. Le garde porte désormais sur tout statut autre que le brouillon.
CREATE OR REPLACE FUNCTION "interdire_modification_origine_facture_emise"() RETURNS trigger AS $$
BEGIN
  IF OLD."statut" <> 'BROUILLON' AND NEW."statut" = 'BROUILLON' THEN
    RAISE EXCEPTION 'Une facture émise ne redevient jamais brouillon.';
  END IF;
  IF OLD."statut" <> 'BROUILLON' AND (
    NEW."origine" IS DISTINCT FROM OLD."origine" OR
    NEW."chantierId" IS DISTINCT FROM OLD."chantierId" OR
    NEW."interventionId" IS DISTINCT FROM OLD."interventionId" OR
    NEW."contratMaintenanceId" IS DISTINCT FROM OLD."contratMaintenanceId" OR
    NEW."motifHorsAffaire" IS DISTINCT FROM OLD."motifHorsAffaire" OR
    NEW."clientRaisonSociale" IS DISTINCT FROM OLD."clientRaisonSociale" OR
    NEW."clientAdresse" IS DISTINCT FROM OLD."clientAdresse" OR
    NEW."type" IS DISTINCT FROM OLD."type" OR
    NEW."factureOrigineId" IS DISTINCT FROM OLD."factureOrigineId" OR
    NEW."estAvoirAnnulation" IS DISTINCT FROM OLD."estAvoirAnnulation" OR
    NEW."mentionsLegalesVersionId" IS DISTINCT FROM OLD."mentionsLegalesVersionId" OR
    NEW."emisLe" IS DISTINCT FROM OLD."emisLe"
  ) THEN
    RAISE EXCEPTION 'Les mentions et liens figés d’une facture émise sont immuables.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
