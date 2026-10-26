-- Intervention de suivi liée, première PR : « À suivre » et la suite liée, sans montants (décisions de
-- Nelson du 24-10-2026, points 10 à 12, 16, 19, 25, 28, 29, 31, 32 et 35, et du 26-10-2026 : « Deux
-- PR », « Intervention liée », « Tout repris », « Garder »).
--
-- Le technicien qui termine une intervention coche « Terminé » ou « À suivre » : l'intervention passe
-- « terminée », avec une marque « à suivre » que voit l'encadrement ; la marque disparaît une fois la
-- suite créée. Une suite est une nouvelle intervention liée à l'intervention initiale, dont elle reprend
-- le client, le site, le contact, l'affaire et, pour une visite, le contrat. Une intervention peut avoir
-- plusieurs suites, et une suite la sienne. La facturation et la marge de la suite viendront avec la
-- seconde PR.
--
-- Aucune reprise de données (règle 4 de la méthode) : aucune intervention existante n'est marquée ni
-- liée.

ALTER TABLE "Intervention" ADD COLUMN "aSuivre" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "interventionInitialeId" TEXT;

-- Lien vers l'intervention initiale. NO ACTION, et non RESTRICT : une intervention qui a des suites ne
-- se supprime pas, sauf avec elles dans une même requête (nettoyage d'une base de test).
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_interventionInitialeId_fkey" FOREIGN KEY ("interventionInitialeId") REFERENCES "Intervention"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
CREATE INDEX "Intervention_interventionInitialeId_idx" ON "Intervention"("interventionInitialeId");

-- La marque « à suivre » ne se porte que sur une intervention terminée (point 29), statut final.
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_a_suivre_terminee_check"
  CHECK (NOT "aSuivre" OR "statut" = 'TERMINEE');

-- Une intervention n'est pas sa propre suite.
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_suite_non_reflexive_check"
  CHECK ("interventionInitialeId" IS NULL OR "interventionInitialeId" <> "id");

-- Le lien est posé à la création de la suite, puis figé. À la création, la suite reprend le client de
-- l'intervention initiale, qui ne doit pas être annulée (points 19 et 25 : depuis toute intervention SAV
-- ou de maintenance, quel que soit son statut, sauf annulée). L'API vérifie les mêmes règles sous le
-- verrou de l'intervention initiale ; la base les garantit contre une écriture directe.
CREATE FUNCTION "verifier_suite_intervention"() RETURNS trigger AS $$
DECLARE
  client_initiale text;
  statut_initiale text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."interventionInitialeId" IS DISTINCT FROM OLD."interventionInitialeId" THEN
      RAISE EXCEPTION 'Le lien d''une intervention de suivi est figé.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."interventionInitialeId" IS NOT NULL THEN
    SELECT "clientId", "statut" INTO client_initiale, statut_initiale
      FROM "Intervention" WHERE "id" = NEW."interventionInitialeId" FOR SHARE;
    IF client_initiale IS NOT NULL AND client_initiale IS DISTINCT FROM NEW."clientId" THEN
      RAISE EXCEPTION 'Une suite reprend le client de l''intervention initiale.' USING ERRCODE = 'check_violation';
    END IF;
    IF statut_initiale = 'ANNULEE' THEN
      RAISE EXCEPTION 'Une intervention annulée n''a pas de suite.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Intervention_suite_verifiee"
BEFORE INSERT OR UPDATE OF "interventionInitialeId" ON "Intervention"
FOR EACH ROW EXECUTE FUNCTION "verifier_suite_intervention"();
