-- Choix non-production : refuser la migration si des pièces numérotées existent.
-- Aucun backfill depuis les règles vivantes n'est fiable pour reconstruire le passé.
-- Avant déploiement sur une instance peuplée, faire valider les imputations historiques
-- par la comptabilité puis livrer une migration de reprise dédiée et auditable.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Facture" WHERE "numero" IS NOT NULL) THEN
    RAISE EXCEPTION 'Pièces historiques présentes : reprise comptable validée requise avant migration';
  END IF;
END $$;

CREATE TABLE "EcritureFacture" (
  "id" TEXT NOT NULL,
  "factureId" TEXT NOT NULL,
  "ordre" INTEGER NOT NULL,
  "cle" TEXT NOT NULL,
  "tauxTva" DECIMAL(5,2),
  "journalCode" TEXT NOT NULL,
  "compteNum" TEXT NOT NULL,
  "compteLib" TEXT NOT NULL,
  "debit" DECIMAL(12,2) NOT NULL,
  "credit" DECIMAL(12,2) NOT NULL,
  CONSTRAINT "EcritureFacture_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EcritureFacture_montants_check" CHECK ("debit" >= 0 AND "credit" >= 0 AND NOT ("debit" > 0 AND "credit" > 0)),
  CONSTRAINT "EcritureFacture_identite_check" CHECK (length("journalCode") > 0 AND length("compteNum") > 0 AND length("compteLib") > 0)
);
CREATE UNIQUE INDEX "EcritureFacture_factureId_ordre_key" ON "EcritureFacture"("factureId", "ordre");
CREATE INDEX "EcritureFacture_factureId_idx" ON "EcritureFacture"("factureId");
ALTER TABLE "EcritureFacture" ADD CONSTRAINT "EcritureFacture_factureId_fkey" FOREIGN KEY ("factureId") REFERENCES "Facture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Facture" ADD COLUMN "ecrituresScellees" BOOLEAN NOT NULL DEFAULT false;

CREATE FUNCTION figer_ecriture_facture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Écriture comptable figée : modification ou suppression interdite';
END $$;
CREATE TRIGGER ecriture_facture_immutable BEFORE UPDATE OR DELETE ON "EcritureFacture"
FOR EACH ROW EXECUTE FUNCTION figer_ecriture_facture();

-- Le verrou sur la pièce sérialise INSERT et scellement, même hors de l'API.
CREATE FUNCTION verifier_insertion_ecriture_facture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scellee BOOLEAN;
BEGIN
  SELECT "ecrituresScellees" INTO scellee FROM "Facture" WHERE "id" = NEW."factureId" FOR SHARE;
  IF scellee THEN
    RAISE EXCEPTION 'Écriture comptable scellée : insertion interdite';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ecriture_facture_insert BEFORE INSERT ON "EcritureFacture"
FOR EACH ROW EXECUTE FUNCTION verifier_insertion_ecriture_facture();

CREATE FUNCTION empecher_descellement_facture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."ecrituresScellees" AND NOT NEW."ecrituresScellees" THEN
    RAISE EXCEPTION 'Écriture comptable scellée : retour interdit';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER facture_ecritures_scellement BEFORE UPDATE ON "Facture"
FOR EACH ROW EXECUTE FUNCTION empecher_descellement_facture();

-- Vérification différée : émission et création des lignes peuvent se produire dans
-- n'importe quel ordre au sein de la même transaction, mais pas au-delà du COMMIT.
CREATE FUNCTION verifier_equilibre_ecritures_facture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE piece_id TEXT; piece RECORD;
BEGIN
  IF TG_TABLE_NAME = 'Facture' THEN
    piece_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    piece_id := OLD."factureId";
  ELSE
    piece_id := NEW."factureId";
  END IF;
  SELECT "statut", "ecrituresScellees", "totalTtc", "type" INTO piece FROM "Facture" WHERE "id" = piece_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF piece."statut" <> 'BROUILLON' THEN
    IF NOT piece."ecrituresScellees" OR
      (SELECT COUNT(*) = 0 OR SUM("debit" - "credit") <> 0 OR
        SUM("debit") <> CASE WHEN piece."type" = 'AVOIR' THEN 0 ELSE piece."totalTtc" END AND piece."type" <> 'AVOIR' OR
        SUM("credit") <> piece."totalTtc" AND piece."type" = 'AVOIR'
       FROM "EcritureFacture" WHERE "factureId" = piece_id) THEN
      RAISE EXCEPTION 'Écritures comptables non scellées, absentes ou déséquilibrées pour la pièce %', piece_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER facture_equilibre_ecritures AFTER INSERT OR UPDATE ON "Facture"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verifier_equilibre_ecritures_facture();
CREATE CONSTRAINT TRIGGER ecriture_facture_equilibre AFTER INSERT OR UPDATE OR DELETE ON "EcritureFacture"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verifier_equilibre_ecritures_facture();
-- Une suppression dérogatoire (trigger d'immuabilité retiré) doit aussi être
-- refusée immédiatement si elle rompt l'équilibre de la pièce encore présente.
CREATE TRIGGER ecriture_facture_equilibre_immediat AFTER DELETE ON "EcritureFacture"
FOR EACH ROW EXECUTE FUNCTION verifier_equilibre_ecritures_facture();
