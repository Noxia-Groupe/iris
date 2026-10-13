-- Alertes de suivi des chantiers : seuil de marge faible (en % du vendu, comparé à la marge
-- estimée en fin de chantier) et délai sans saisie (jours civils). NULL désactive l'alerte.
ALTER TABLE "Parametres" ADD COLUMN "seuilMargeFaible" DECIMAL(5,2) DEFAULT 15;
ALTER TABLE "Parametres" ADD COLUMN "joursSansSaisie" INTEGER DEFAULT 14;

-- Une valeur hors bornes ne doit pas pouvoir être écrite, même hors de l'API.
ALTER TABLE "Parametres" ADD CONSTRAINT "parametres_seuil_marge_faible_borne"
  CHECK ("seuilMargeFaible" IS NULL OR ("seuilMargeFaible" >= 0 AND "seuilMargeFaible" <= 100));
ALTER TABLE "Parametres" ADD CONSTRAINT "parametres_jours_sans_saisie_borne"
  CHECK ("joursSansSaisie" IS NULL OR ("joursSansSaisie" >= 1 AND "joursSansSaisie" <= 365));
