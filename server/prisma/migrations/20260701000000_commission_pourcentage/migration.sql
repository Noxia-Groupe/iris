-- Passage à un commissionnement 100 % en pourcentage de la marge.
-- La valorisation horaire (€/h) du bonus/malus n'est plus utilisée : on retire la colonne.
ALTER TABLE "Parametres" DROP COLUMN "tauxHoraireMoyen";
