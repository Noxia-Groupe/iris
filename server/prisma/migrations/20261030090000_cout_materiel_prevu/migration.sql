-- Lot « budget et heures prévues du chantier » (décision de Nelson de la nuit du 26 au 27-10-2026,
-- point 15) : coût d'achat prévu du matériel, figé à la conversion du devis en chantier. Vide pour les
-- chantiers existants (aucune reprise sans données réelles, règle 4) : leur marge estimée garde le ratio
-- des chantiers terminés.
ALTER TABLE "Chantier" ADD COLUMN "coutMaterielPrevu" DECIMAL(12,2);
ALTER TABLE "Chantier" ADD CONSTRAINT "Chantier_coutMaterielPrevu_positif" CHECK ("coutMaterielPrevu" IS NULL OR "coutMaterielPrevu" >= 0);
