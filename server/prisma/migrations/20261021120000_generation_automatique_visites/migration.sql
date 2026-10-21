-- Lot pilote 5 : génération automatique quotidienne des visites de maintenance.

-- Anticipation, en jours civils, de la création d'une visite avant son échéance. Vide (NULL),
-- la génération automatique est désactivée. La ligne de paramètres existante reçoit la valeur
-- par défaut, 30 jours (choix par défaut, à confirmer).
ALTER TABLE "Parametres" ADD COLUMN "anticipationVisitesJours" INTEGER DEFAULT 30;
ALTER TABLE "Parametres" ADD CONSTRAINT "Parametres_anticipationVisitesJours_check"
  CHECK ("anticipationVisitesJours" IS NULL OR "anticipationVisitesJours" BETWEEN 0 AND 365);

-- Journal SAV : une écriture sans compte auteur ne peut venir que de la génération automatique,
-- et seulement pour créer la visite d'un contrat ou avancer son échéance. Les lignes existantes
-- ont toutes un auteur : la contrainte est vérifiée sur elles aussi.
ALTER TABLE "JournalSaisieChantier" ALTER COLUMN "auteurId" DROP NOT NULL;
ALTER TABLE "JournalSaisieChantier" ADD CONSTRAINT "JournalSaisieChantier_auteur_generation_check"
  CHECK (
    "auteurId" IS NOT NULL
    OR (
      "auteurNom" = 'Génération automatique'
      AND (("cible" = 'INTERVENTION' AND "action" = 'CREATION_CONTRAT') OR ("cible" = 'CONTRAT' AND "action" = 'AVANCEMENT_ECHEANCE'))
    )
  );

-- Passages de la génération : un passage automatique au plus par jour civil de la société.
CREATE TABLE "ExecutionGenerationVisites" (
    "id" TEXT NOT NULL,
    "jour" DATE NOT NULL,
    "declenchement" TEXT NOT NULL,
    "cleJourAutomatique" TEXT,
    "auteurId" TEXT,
    "auteurNom" TEXT,
    "anticipationJours" INTEGER NOT NULL,
    "debut" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fin" TIMESTAMP(3),
    "statut" TEXT NOT NULL DEFAULT 'EN_COURS',
    "visitesCreees" INTEGER NOT NULL DEFAULT 0,
    "echeancesAvancees" INTEGER NOT NULL DEFAULT 0,
    "contratsIgnores" JSONB NOT NULL DEFAULT '[]',
    "erreurs" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "ExecutionGenerationVisites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExecutionGenerationVisites_cleJourAutomatique_key" ON "ExecutionGenerationVisites"("cleJourAutomatique");
CREATE INDEX "ExecutionGenerationVisites_debut_idx" ON "ExecutionGenerationVisites"("debut");

-- Un passage automatique porte la clé de son jour, et lui seul ; un passage manuel a un auteur.
-- IS NOT DISTINCT FROM : une clé vide ne doit pas rendre la comparaison inconnue (NULL), ce
-- qu'une contrainte CHECK accepterait.
ALTER TABLE "ExecutionGenerationVisites" ADD CONSTRAINT "ExecutionGenerationVisites_coherence_check"
  CHECK (
    "statut" IN ('EN_COURS', 'REUSSIE', 'ECHEC')
    AND "anticipationJours" BETWEEN 0 AND 365
    AND "visitesCreees" >= 0 AND "echeancesAvancees" >= 0
    AND (
      ("declenchement" = 'AUTOMATIQUE' AND "cleJourAutomatique" IS NOT DISTINCT FROM to_char("jour", 'YYYY-MM-DD') AND "auteurId" IS NULL AND "auteurNom" IS NULL)
      OR ("declenchement" = 'MANUEL' AND "cleJourAutomatique" IS NULL AND "auteurId" IS NOT NULL AND "auteurNom" IS NOT NULL)
    )
  );
