-- Règlements clients saisis à la main et affectés aux factures (décision A3 du 16-10-2026).
-- Aucune reprise : les factures déjà marquées « réglée » sans règlement restent telles quelles
-- (aucune donnée réelle n'existe à cette date).

CREATE TABLE "Reglement" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "dateReglement" TIMESTAMP(3) NOT NULL,
    "montant" DECIMAL(12,2) NOT NULL,
    "moyen" TEXT NOT NULL,
    "reference" TEXT,
    "statut" TEXT NOT NULL DEFAULT 'ENREGISTRE',
    "motifContrepassation" TEXT,
    "contrepasseLe" TIMESTAMP(3),
    "contrepasseParId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reglement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Reglement_montant_check" CHECK ("montant" > 0),
    CONSTRAINT "Reglement_moyen_check" CHECK ("moyen" IN ('VIREMENT', 'CHEQUE', 'CARTE', 'PRELEVEMENT', 'ESPECES')),
    CONSTRAINT "Reglement_statut_check" CHECK ("statut" IN ('ENREGISTRE', 'CONTREPASSE')),
    -- Une date civile : minuit UTC, comme les dates d'émission et d'échéance des factures.
    CONSTRAINT "Reglement_date_check" CHECK ("dateReglement" = date_trunc('day', "dateReglement")),
    CONSTRAINT "Reglement_reference_check" CHECK ("reference" IS NULL OR (char_length("reference") BETWEEN 1 AND 200 AND "reference" = btrim("reference"))),
    -- Une contre-passation porte toujours son motif, son instant et son auteur ; un règlement
    -- enregistré n'en porte aucun.
    CONSTRAINT "Reglement_contrepassation_check" CHECK (
      ("statut" = 'ENREGISTRE' AND "motifContrepassation" IS NULL AND "contrepasseLe" IS NULL AND "contrepasseParId" IS NULL) OR
      ("statut" = 'CONTREPASSE' AND char_length(btrim("motifContrepassation")) BETWEEN 3 AND 500 AND "contrepasseLe" IS NOT NULL AND "contrepasseParId" IS NOT NULL)
    )
);

CREATE TABLE "AffectationReglement" (
    "id" TEXT NOT NULL,
    "reglementId" TEXT NOT NULL,
    "factureId" TEXT NOT NULL,
    "montant" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "AffectationReglement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AffectationReglement_montant_check" CHECK ("montant" > 0)
);

CREATE INDEX "Reglement_clientId_dateReglement_idx" ON "Reglement"("clientId", "dateReglement");
CREATE INDEX "Reglement_dateReglement_createdAt_idx" ON "Reglement"("dateReglement", "createdAt");
CREATE INDEX "AffectationReglement_factureId_idx" ON "AffectationReglement"("factureId");
CREATE UNIQUE INDEX "AffectationReglement_reglementId_factureId_key" ON "AffectationReglement"("reglementId", "factureId");

ALTER TABLE "Reglement" ADD CONSTRAINT "Reglement_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Reglement" ADD CONSTRAINT "Reglement_contrepasseParId_fkey" FOREIGN KEY ("contrepasseParId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Reglement" ADD CONSTRAINT "Reglement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AffectationReglement" ADD CONSTRAINT "AffectationReglement_reglementId_fkey" FOREIGN KEY ("reglementId") REFERENCES "Reglement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AffectationReglement" ADD CONSTRAINT "AffectationReglement_factureId_fkey" FOREIGN KEY ("factureId") REFERENCES "Facture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reste dû d'une facture : TTC, moins ses avoirs émis, moins les parts des règlements non
-- contre-passés. Même calcul que l'API (`soldesFactures`).
CREATE FUNCTION reste_du_facture(facture_id TEXT) RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT f."totalTtc"
    - COALESCE((SELECT SUM(a."totalTtc") FROM "Facture" a WHERE a."factureOrigineId" = f."id" AND a."type" = 'AVOIR' AND a."statut" <> 'BROUILLON'), 0)
    - COALESCE((SELECT SUM(p."montant") FROM "AffectationReglement" p JOIN "Reglement" r ON r."id" = p."reglementId" WHERE p."factureId" = f."id" AND r."statut" = 'ENREGISTRE'), 0)
  FROM "Facture" f WHERE f."id" = facture_id
$$;

-- Un règlement naît enregistré ; il n'est jamais supprimé ni réécrit. Seule transition :
-- ENREGISTRE → CONTREPASSE, qui renseigne motif, instant et auteur.
CREATE FUNCTION figer_reglement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."statut" <> 'ENREGISTRE' THEN
      RAISE EXCEPTION 'Un règlement est créé enregistré : la contre-passation est une transition.';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Règlement figé : suppression interdite, contre-passez-le.';
  END IF;
  IF OLD."statut" <> 'ENREGISTRE' OR NEW."statut" <> 'CONTREPASSE' OR
    NEW."id" IS DISTINCT FROM OLD."id" OR
    NEW."clientId" IS DISTINCT FROM OLD."clientId" OR
    NEW."dateReglement" IS DISTINCT FROM OLD."dateReglement" OR
    NEW."montant" IS DISTINCT FROM OLD."montant" OR
    NEW."moyen" IS DISTINCT FROM OLD."moyen" OR
    NEW."reference" IS DISTINCT FROM OLD."reference" OR
    NEW."createdById" IS DISTINCT FROM OLD."createdById" OR
    NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Règlement figé : seule la contre-passation d’un règlement enregistré est permise.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reglement_immuable BEFORE INSERT OR UPDATE OR DELETE ON "Reglement"
FOR EACH ROW EXECUTE FUNCTION figer_reglement();

CREATE FUNCTION figer_affectation_reglement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Affectation de règlement figée : modification ou suppression interdite.';
END $$;
CREATE TRIGGER affectation_reglement_immuable BEFORE UPDATE OR DELETE ON "AffectationReglement"
FOR EACH ROW EXECUTE FUNCTION figer_affectation_reglement();

-- Une part ne s'impute qu'à une facture émise du même client, sans dépasser son reste dû.
-- Le verrou de la facture sérialise les imputations concurrentes, même hors de l'API.
CREATE FUNCTION verifier_affectation_reglement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reglement RECORD; facture RECORD;
BEGIN
  SELECT "clientId", "statut" INTO reglement FROM "Reglement" WHERE "id" = NEW."reglementId";
  IF NOT FOUND THEN RETURN NEW; END IF; -- la clé étrangère refusera la ligne
  SELECT "clientId", "type", "statut" INTO facture FROM "Facture" WHERE "id" = NEW."factureId" FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF reglement."statut" <> 'ENREGISTRE' THEN
    RAISE EXCEPTION 'Un règlement contre-passé ne reçoit plus d’affectation.';
  END IF;
  IF facture."type" <> 'FACTURE' OR facture."statut" <> 'EMISE' THEN
    RAISE EXCEPTION 'Seule une facture émise non soldée reçoit un règlement.';
  END IF;
  IF facture."clientId" <> reglement."clientId" THEN
    RAISE EXCEPTION 'Un règlement ne s’affecte qu’aux factures de son client.';
  END IF;
  IF NEW."montant" > reste_du_facture(NEW."factureId") THEN
    RAISE EXCEPTION 'Affectation supérieure au reste dû de la facture %.', NEW."factureId";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER affectation_reglement_controle BEFORE INSERT ON "AffectationReglement"
FOR EACH ROW EXECUTE FUNCTION verifier_affectation_reglement();

-- Vérification différée : un règlement est entièrement affecté au COMMIT, ni plus ni moins.
CREATE FUNCTION verifier_total_affectations_reglement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reglement_id TEXT; montant_attendu NUMERIC; total_affecte NUMERIC;
BEGIN
  -- Deux branches distinctes : PL/pgSQL résout chaque champ de NEW, même dans un CASE.
  IF TG_TABLE_NAME = 'Reglement' THEN
    reglement_id := NEW."id";
  ELSE
    reglement_id := NEW."reglementId";
  END IF;
  SELECT "montant" INTO montant_attendu FROM "Reglement" WHERE "id" = reglement_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM("montant"), 0) INTO total_affecte FROM "AffectationReglement" WHERE "reglementId" = reglement_id;
  IF total_affecte <> montant_attendu THEN
    RAISE EXCEPTION 'Règlement % : ses affectations totalisent % au lieu de %.', reglement_id, total_affecte, montant_attendu;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reglement_entierement_affecte AFTER INSERT ON "Reglement"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verifier_total_affectations_reglement();
CREATE CONSTRAINT TRIGGER affectation_reglement_total AFTER INSERT ON "AffectationReglement"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verifier_total_affectations_reglement();

-- « Réglée » se déduit des règlements : une facture n'y passe que soldée, n'en sort que si un
-- règlement contre-passé rouvre un reste dû, et ne s'annule plus après un règlement.
CREATE FUNCTION verifier_statut_facture_reglements() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reste NUMERIC; regle BOOLEAN;
BEGIN
  IF NEW."statut" IS NOT DISTINCT FROM OLD."statut" OR NEW."type" <> 'FACTURE' THEN
    RETURN NEW;
  END IF;
  reste := reste_du_facture(NEW."id");
  IF OLD."statut" = 'EMISE' AND NEW."statut" = 'REGLEE' AND reste > 0 THEN
    RAISE EXCEPTION 'Une facture ne passe à « réglée » que soldée par ses règlements.';
  END IF;
  IF OLD."statut" = 'REGLEE' AND NEW."statut" = 'EMISE' AND reste <= 0 THEN
    RAISE EXCEPTION 'Une facture soldée reste « réglée ».';
  END IF;
  IF NEW."statut" = 'ANNULEE' THEN
    SELECT EXISTS (SELECT 1 FROM "AffectationReglement" p JOIN "Reglement" r ON r."id" = p."reglementId" WHERE p."factureId" = NEW."id" AND r."statut" = 'ENREGISTRE') INTO regle;
    IF regle THEN
      RAISE EXCEPTION 'Une facture qui a reçu un règlement ne peut pas être annulée.';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER facture_statut_reglements BEFORE UPDATE ON "Facture"
FOR EACH ROW EXECUTE FUNCTION verifier_statut_facture_reglements();
