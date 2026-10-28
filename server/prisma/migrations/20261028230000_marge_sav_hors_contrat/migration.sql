-- Lot « marge d'un SAV hors contrat » (décisions de Nelson de la nuit du 26 au 27-10-2026, points 4
-- à 7, et du 27-10-2026 à 10:27 UTC) : le prix de vente à l'heure hors contrat de la main d'œuvre de
-- l'intervenant est copié sur l'heure le jour de sa saisie, comme le taux horaire chargé. Aucune reprise :
-- les heures déjà saisies gardent un prix vide (règle 4).
ALTER TABLE "CoutInterventionHeure" ADD COLUMN "prixVenteHoraireApplique" DECIMAL(12,2);

ALTER TABLE "CoutInterventionHeure" ADD CONSTRAINT "CoutInterventionHeure_prix_vente_check"
  CHECK ("prixVenteHoraireApplique" IS NULL OR "prixVenteHoraireApplique" >= 0);

-- Figé à la création, comme le taux appliqué : une correction de l'heure, un changement de tarif ou de
-- rattachement ne le modifient pas.
CREATE OR REPLACE FUNCTION prevent_cout_intervention_heure_prix_vente_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."prixVenteHoraireApplique" IS DISTINCT FROM OLD."prixVenteHoraireApplique" THEN
    RAISE EXCEPTION 'prix de vente horaire appliqué immuable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "CoutInterventionHeure_prix_vente_immutable" BEFORE UPDATE ON "CoutInterventionHeure"
  FOR EACH ROW EXECUTE FUNCTION prevent_cout_intervention_heure_prix_vente_immutable();
