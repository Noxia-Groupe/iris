-- Lot « budget et heures prévues du chantier », troisième PR : ligne de main d'œuvre au jour ou à la
-- demi-journée (réponses de Nelson du 30-10-2026 : « Option de la main d'œuvre », « Prix à part » ; point 16
-- de la nuit du 26 au 27-10-2026 : « Un forfait compte pour un forfait donc d’une journee ou d’une demi
-- journée », « Heures par jour de la MO »).
--
-- Aucune reprise de données (règle 4) : les mains d'œuvre existantes n'ont pas de prix de la demi-journée
-- (elles ne se vendent donc pas à la demi-journée tant que l'administration ne l'a pas saisi), et les lignes
-- de devis existantes restent des lignes ordinaires ou au temps passé.

-- Prix de vente de la demi-journée, hors contrat et sous contrat (« Prix à part ») : facultatifs (choix par
-- défaut, à confirmer), positifs ou nuls, au centime par le type de la colonne (l'API refuse une troisième
-- décimale plutôt que de laisser PostgreSQL arrondir), réservés à une main d'œuvre, comme ses quatre autres
-- prix (contrainte CataloguePrestation_main_oeuvre_check, inchangée).
ALTER TABLE "CataloguePrestation" ADD COLUMN "prixDemiJourneeHorsContratHt" DECIMAL(12,2),
ADD COLUMN "prixDemiJourneeSousContratHt" DECIMAL(12,2);
ALTER TABLE "CataloguePrestation" ADD CONSTRAINT "CataloguePrestation_demi_journee_check" CHECK (
  CASE WHEN "estMainOeuvre" THEN
    ("prixDemiJourneeHorsContratHt" IS NULL OR "prixDemiJourneeHorsContratHt" >= 0)
    AND ("prixDemiJourneeSousContratHt" IS NULL OR "prixDemiJourneeSousContratHt" >= 0)
  ELSE
    "prixDemiJourneeHorsContratHt" IS NULL AND "prixDemiJourneeSousContratHt" IS NULL
  END
);

-- Ligne au jour ou à la demi-journée : le forfait (JOUR, DEMI_JOURNEE) et le tarif (HORS_CONTRAT,
-- SOUS_CONTRAT), tous deux vides sur une autre ligne. Une ligne au forfait est une copie d'une main d'œuvre
-- du catalogue (prestation), de la main-d'œuvre, jamais au temps passé, avec son unité (« jour » ou
-- « demi-journée »), ses minutes prévues par unité (les heures par jour de la main d'œuvre × 60, ou × 30,
-- strictement positives), sans prix d'achat prévu (choix par défaut, à confirmer : une main d'œuvre n'a pas
-- de prix d'achat), et des totaux exacts, calculés comme ceux de la ligne au temps passé : HT = quantité ×
-- prix unitaire et TTC = HT × (100 + TVA) / 100, chacun arrondi au centime, moitié vers le haut. Chaque terme
-- est écrit pour ne jamais valoir NULL, qu'une contrainte CHECK laisserait passer.
ALTER TABLE "DevisLigne" ADD COLUMN "forfaitMainOeuvre" TEXT,
ADD COLUMN "tarifForfait" TEXT;
ALTER TABLE "DevisLigne" ADD CONSTRAINT "DevisLigne_forfait_main_oeuvre_check" CHECK (
  CASE WHEN "forfaitMainOeuvre" IS NULL AND "tarifForfait" IS NULL THEN true
  WHEN "forfaitMainOeuvre" IS NOT NULL AND "tarifForfait" IS NOT NULL THEN
    "forfaitMainOeuvre" IN ('JOUR', 'DEMI_JOURNEE') AND "tarifForfait" IN ('HORS_CONTRAT', 'SOUS_CONTRAT')
    AND "nature" = 'MAIN_OEUVRE' AND NOT "tempsPasse"
    AND "catalogueFamille" IS NOT NULL AND "catalogueFamille" = 'prestations'
    AND "catalogueId" IS NOT NULL AND "reference" IS NOT NULL
    AND "unite" IS NOT NULL AND "unite" = CASE "forfaitMainOeuvre" WHEN 'JOUR' THEN 'jour' ELSE 'demi-journée' END
    AND "minutesPrevuesUnite" IS NOT NULL AND "minutesPrevuesUnite" > 0
    AND "prixAchatUnitaireHt" IS NULL AND "quantite" > 0
    AND "totalHt" = round("quantite" * "prixUnitaireHt", 2)
    AND "totalTtc" = round("totalHt" * (100 + "tauxTva") / 100, 2)
  ELSE false
  END
);
