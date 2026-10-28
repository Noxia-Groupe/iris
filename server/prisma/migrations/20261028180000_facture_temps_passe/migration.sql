-- Facture au temps passé (lot « facture au temps passé », seconde PR ; décisions de Nelson de la nuit
-- du 26 au 27-10-2026, points 3 et 8 à 12, et du 28-10-2026).
--
-- La facture d'une intervention au temps passé reprend les heures saisies sur l'intervention et sur ses
-- suites, au prix figé sur le devis, arrondies au pas au-delà du temps minimum figé, avec au moins ce
-- minimum : une seule facture, le minimum et l'arrondi appliqués une fois au total des heures. L'API la
-- calcule ; la base garde ici sa marque, figée, et son unicité. Aucune reprise de données (règle 4).

ALTER TABLE "Facture" ADD COLUMN "tempsPasse" BOOLEAN NOT NULL DEFAULT false;

-- Seule une facture (jamais un avoir) d'une intervention porte la marque.
ALTER TABLE "Facture" ADD CONSTRAINT "Facture_temps_passe_check" CHECK (
  NOT "tempsPasse" OR ("type" = 'FACTURE' AND "origine" = 'INTERVENTION' AND "interventionId" IS NOT NULL)
);

-- Une seule facture au temps passé vivante par intervention : brouillon, émise ou réglée. Une facture
-- annulée par son avoir total libère la place (cycle de correction prévu).
CREATE UNIQUE INDEX "Facture_temps_passe_unique" ON "Facture" ("interventionId")
  WHERE "tempsPasse" AND "statut" <> 'ANNULEE';

-- La marque est posée à la création, puis figée.
CREATE FUNCTION figer_marque_temps_passe_facture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'La marque « au temps passé » d''une facture est figée.' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER facture_temps_passe_figee BEFORE UPDATE ON "Facture"
FOR EACH ROW
WHEN (OLD."tempsPasse" IS DISTINCT FROM NEW."tempsPasse")
EXECUTE FUNCTION figer_marque_temps_passe_facture();

-- L'intervention facturée au temps passé l'est elle-même (marqueur reporté de son devis) et n'est pas
-- une suite : une suite se facture avec son intervention initiale. Vérifié à la validation de la
-- transaction, comme les autres gardes du temps passé, à la création comme au changement d'intervention
-- d'un brouillon (une facture émise garde déjà son origine).
CREATE FUNCTION verifier_intervention_facture_temps_passe() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  marqueur boolean;
  initiale text;
BEGIN
  SELECT "auTempsPasse", "interventionInitialeId" INTO marqueur, initiale
    FROM "Intervention" WHERE "id" = NEW."interventionId";
  IF marqueur IS DISTINCT FROM true OR initiale IS NOT NULL THEN
    RAISE EXCEPTION 'Une facture au temps passé porte sur une intervention au temps passé, et non sur une suite.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER facture_temps_passe_intervention AFTER INSERT OR UPDATE OF "interventionId" ON "Facture"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW."tempsPasse")
EXECUTE FUNCTION verifier_intervention_facture_temps_passe();
