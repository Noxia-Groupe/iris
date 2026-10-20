-- Lot pilote 3b-3 : la signature d'un compte rendu se dessine au doigt (décision de Nelson du
-- 19-10-2026). Elle porte le tracé vectoriel, qui entre dans son empreinte, et le compte qui
-- l'enregistre. Comptes rendus et signatures reçoivent leur horodatage de la base.

-- Une signature est une preuve : une signature antérieure ne porte ni tracé ni enregistreur, et ne
-- peut pas être complétée, le garde de #223 refusant toute modification. Comme pour DevisSignature
-- (migration 20260924100000), la migration est refusée plutôt que d'inventer une provenance. Aucune
-- donnée réelle n'existe à ce jour.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "InterventionSignature") THEN
    RAISE EXCEPTION 'Impossible de migrer InterventionSignature : des signatures existantes ne portent ni tracé ni enregistreur.';
  END IF;
END $$;

ALTER TABLE "InterventionSignature" ADD COLUMN "trace" JSONB NOT NULL;
ALTER TABLE "InterventionSignature" ADD COLUMN "enregistreParId" TEXT NOT NULL;
-- La forme détaillée du tracé est contrôlée par l'API ; la base refuse au moins un tracé qui n'est
-- pas un objet, ou démesuré.
ALTER TABLE "InterventionSignature" ADD CONSTRAINT "InterventionSignature_trace_objet"
  CHECK (jsonb_typeof("trace") = 'object' AND octet_length("trace"::text) <= 65536);

CREATE INDEX "InterventionSignature_enregistreParId_idx" ON "InterventionSignature"("enregistreParId");

ALTER TABLE "InterventionSignature" ADD CONSTRAINT "InterventionSignature_enregistreParId_fkey"
  FOREIGN KEY ("enregistreParId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Clé d'envoi d'un compte rendu : un envoi répété après une réponse perdue retrouve le compte rendu
-- déjà enregistré, au lieu d'en figer un second, qui ne pourrait plus être retiré.
ALTER TABLE "InterventionRapport" ADD COLUMN "cleEnvoi" UUID;
CREATE UNIQUE INDEX "InterventionRapport_cleEnvoi_key" ON "InterventionRapport"("cleEnvoi");

-- Horodatage imposé par la base (note N4 de l'audit de #255) : ces lignes sont figées dès leur
-- insertion, si bien qu'une date fournie par l'application ne se corrigerait plus. Même principe
-- que le journal des factures (migration 20261018120000).
CREATE FUNCTION horodater_compte_rendu_intervention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."createdAt" := clock_timestamp() AT TIME ZONE 'UTC';
  RETURN NEW;
END $$;
CREATE TRIGGER intervention_rapport_horodatage BEFORE INSERT ON "InterventionRapport"
FOR EACH ROW EXECUTE FUNCTION horodater_compte_rendu_intervention();

CREATE FUNCTION horodater_signature_intervention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."createdAt" := clock_timestamp() AT TIME ZONE 'UTC';
  NEW."accepteLe" := NEW."createdAt";
  RETURN NEW;
END $$;
CREATE TRIGGER intervention_signature_horodatage BEFORE INSERT ON "InterventionSignature"
FOR EACH ROW EXECUTE FUNCTION horodater_signature_intervention();
