-- Main d'œuvre au catalogue (décisions de Nelson du 24-10-2026 : « Dans le catalogue », heures d'une
-- journée « Par main d'œuvre », valorisation « Liée à l'intervenant »).
--
-- Une prestation du catalogue peut être une main d'œuvre. Ses quatre prix sont des PRIX DE VENTE,
-- jamais des coûts : le coût reste le taux horaire chargé de l'intervenant. Choix par défaut, à
-- confirmer : le prix de vente existant (`prixVenteHt`) est le prix à l'heure hors contrat, l'unité
-- est l'heure ; s'y ajoutent le forfait jour hors contrat, l'heure sous contrat, le forfait jour sous
-- contrat et le nombre d'heures d'une journée. Paramétrage vide au départ : aucune main d'œuvre ni
-- aucun tarif n'est inséré.
--
-- Aucune reprise de données (règle 4 de la méthode) : les prestations existantes restent des
-- prestations ordinaires, sans ces champs.
ALTER TABLE "CataloguePrestation" ADD COLUMN     "estMainOeuvre" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "heuresParJour" DECIMAL(4,2),
ADD COLUMN     "prixHeureSousContratHt" DECIMAL(12,2),
ADD COLUMN     "prixJourHorsContratHt" DECIMAL(12,2),
ADD COLUMN     "prixJourSousContratHt" DECIMAL(12,2);

-- Une main d'œuvre porte ses quatre prix, positifs ou nuls (au centime par le type des colonnes ;
-- l'API refuse une troisième décimale plutôt que de laisser PostgreSQL l'arrondir), et ses heures
-- par jour, strictement positives, 24 au plus, au quart d'heure près (choix par défaut, à
-- confirmer). Son unité est l'heure ; elle n'a ni prix d'achat (son coût est le taux horaire chargé
-- de l'intervenant) ni durée indicative (choix par défaut, à confirmer). Une prestation ordinaire
-- n'a aucun de ces champs propres à la main d'œuvre.
ALTER TABLE "CataloguePrestation" ADD CONSTRAINT "CataloguePrestation_main_oeuvre_check" CHECK (
  CASE WHEN "estMainOeuvre" THEN
    "prixJourHorsContratHt" IS NOT NULL AND "prixHeureSousContratHt" IS NOT NULL
    AND "prixJourSousContratHt" IS NOT NULL AND "heuresParJour" IS NOT NULL
    AND "prixVenteHt" >= 0 AND "prixJourHorsContratHt" >= 0
    AND "prixHeureSousContratHt" >= 0 AND "prixJourSousContratHt" >= 0
    AND "heuresParJour" > 0 AND "heuresParJour" <= 24 AND mod("heuresParJour" * 4, 1) = 0
    AND "unite" = 'heure' AND "prixAchatHt" IS NULL AND "dureeIndicativeMin" IS NULL
  ELSE
    "prixJourHorsContratHt" IS NULL AND "prixHeureSousContratHt" IS NULL
    AND "prixJourSousContratHt" IS NULL AND "heuresParJour" IS NULL
  END
);

-- Cible de la clé étrangère composite des rattachements : (id, vrai) n'existe que pour une main
-- d'œuvre.
CREATE UNIQUE INDEX "CataloguePrestation_id_estMainOeuvre_key" ON "CataloguePrestation"("id", "estMainOeuvre");

-- Rattachement d'un intervenant à une main d'œuvre, facultatif, réglé par l'administration seule
-- (ses heures seront valorisées à ce prix de vente par un lot suivant). Une table à part plutôt
-- qu'une colonne de l'intervenant : le rattachement ne voyage pas avec les fiches intervenant
-- jointes aux heures, au planning ou aux interventions.
CREATE TABLE "IntervenantMainOeuvre" (
    "intervenantId" TEXT NOT NULL,
    "prestationId" TEXT NOT NULL,
    "estMainOeuvre" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntervenantMainOeuvre_pkey" PRIMARY KEY ("intervenantId"),
    -- Toujours vrai : avec la clé étrangère composite, la cible est une main d'œuvre, et une main
    -- d'œuvre rattachée ne redevient pas une prestation ordinaire (ON UPDATE RESTRICT). Une main
    -- d'œuvre désactivée garde ses rattachements (choix par défaut, à confirmer) : l'activité n'est
    -- contrôlée qu'au rattachement, par l'API.
    CONSTRAINT "IntervenantMainOeuvre_estMainOeuvre_check" CHECK ("estMainOeuvre")
);

CREATE INDEX "IntervenantMainOeuvre_prestationId_estMainOeuvre_idx" ON "IntervenantMainOeuvre"("prestationId", "estMainOeuvre");

-- La fiche intervenant supprimée emporte son rattachement (la route de suppression le journalise).
ALTER TABLE "IntervenantMainOeuvre" ADD CONSTRAINT "IntervenantMainOeuvre_intervenantId_fkey" FOREIGN KEY ("intervenantId") REFERENCES "Intervenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Une fiche du catalogue ne se supprime jamais par l'API (désactivation seulement) ; en SQL, une
-- main d'œuvre rattachée ne se supprime pas et ne quitte pas l'état de main d'œuvre.
ALTER TABLE "IntervenantMainOeuvre" ADD CONSTRAINT "IntervenantMainOeuvre_prestationId_estMainOeuvre_fkey" FOREIGN KEY ("prestationId", "estMainOeuvre") REFERENCES "CataloguePrestation"("id", "estMainOeuvre") ON DELETE RESTRICT ON UPDATE RESTRICT;
