-- Lot « budget et heures prévues du chantier », seconde PR (réponses de Nelson du 30-10-2026) : minutes
-- prévues pour une unité d'une ligne de devis, copiées de la fiche du catalogue à l'ajout de la ligne, puis
-- figées. Vide pour les lignes existantes (aucune reprise sans données réelles, règle 4) : elles comptent
-- leur quantité en heures, comme avant ce lot.
ALTER TABLE "DevisLigne" ADD COLUMN "minutesPrevuesUnite" DECIMAL(12,2);
ALTER TABLE "DevisLigne" ADD CONSTRAINT "DevisLigne_minutesPrevuesUnite_positif" CHECK ("minutesPrevuesUnite" IS NULL OR "minutesPrevuesUnite" >= 0);
