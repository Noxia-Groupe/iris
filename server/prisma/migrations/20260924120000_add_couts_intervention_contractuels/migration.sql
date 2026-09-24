-- Coûts SAV d'une intervention issue d'un contrat : tables volontairement distinctes des coûts Chantier.
CREATE TABLE "CoutInterventionHeure" (
  "id" TEXT NOT NULL,
  "interventionId" TEXT NOT NULL,
  "intervenantId" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "nbrHeures" DECIMAL(10,2) NOT NULL,
  "tauxHoraireApplique" DECIMAL(10,2) NOT NULL,
  "commentaire" TEXT,
  "createdById" TEXT NOT NULL,
  "archivedAt" TIMESTAMP(3),
  "archivedById" TEXT,
  "motifArchivage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CoutInterventionHeure_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CoutInterventionHeure_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "Intervention"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CoutInterventionHeure_intervenantId_fkey" FOREIGN KEY ("intervenantId") REFERENCES "Intervenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CoutInterventionHeure_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CoutInterventionHeure_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CoutInterventionHeure_archivage_complet_check" CHECK (
    ("archivedAt" IS NULL AND "archivedById" IS NULL AND "motifArchivage" IS NULL)
    OR ("archivedAt" IS NOT NULL AND "archivedById" IS NOT NULL AND "motifArchivage" IS NOT NULL AND char_length(btrim("motifArchivage")) BETWEEN 3 AND 500)
  )
);
CREATE INDEX "CoutInterventionHeure_interventionId_archivedAt_idx" ON "CoutInterventionHeure"("interventionId", "archivedAt");
CREATE INDEX "CoutInterventionHeure_intervenantId_idx" ON "CoutInterventionHeure"("intervenantId");

CREATE TABLE "CoutInterventionAchat" (
  "id" TEXT NOT NULL,
  "interventionId" TEXT NOT NULL,
  "fournisseurId" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "description" TEXT NOT NULL,
  "montantHT" DECIMAL(12,2) NOT NULL,
  "createdById" TEXT NOT NULL,
  "archivedAt" TIMESTAMP(3),
  "archivedById" TEXT,
  "motifArchivage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CoutInterventionAchat_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CoutInterventionAchat_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "Intervention"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CoutInterventionAchat_fournisseurId_fkey" FOREIGN KEY ("fournisseurId") REFERENCES "Fournisseur"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CoutInterventionAchat_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CoutInterventionAchat_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CoutInterventionAchat_archivage_complet_check" CHECK (
    ("archivedAt" IS NULL AND "archivedById" IS NULL AND "motifArchivage" IS NULL)
    OR ("archivedAt" IS NOT NULL AND "archivedById" IS NOT NULL AND "motifArchivage" IS NOT NULL AND char_length(btrim("motifArchivage")) BETWEEN 3 AND 500)
  )
);
CREATE INDEX "CoutInterventionAchat_interventionId_archivedAt_idx" ON "CoutInterventionAchat"("interventionId", "archivedAt");
CREATE INDEX "CoutInterventionAchat_fournisseurId_idx" ON "CoutInterventionAchat"("fournisseurId");

-- L'auteur et l'intervention d'origine sont des instantanés comptables, jamais modifiables.
-- Cette fonction est commune aux deux tables : elle ne référence que leurs colonnes communes.
CREATE OR REPLACE FUNCTION prevent_cout_intervention_common_immutable_fields()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."interventionId" IS DISTINCT FROM OLD."interventionId" THEN
    RAISE EXCEPTION 'champ immuable d''un coût intervention';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Le taux appliqué n'existe que pour les heures ; il est aussi figé à la création.
CREATE OR REPLACE FUNCTION prevent_cout_intervention_heure_taux_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."tauxHoraireApplique" IS DISTINCT FROM OLD."tauxHoraireApplique" THEN
    RAISE EXCEPTION 'taux horaire appliqué immuable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "CoutInterventionHeure_immutable_fields" BEFORE UPDATE ON "CoutInterventionHeure"
  FOR EACH ROW EXECUTE FUNCTION prevent_cout_intervention_common_immutable_fields();
CREATE TRIGGER "CoutInterventionAchat_immutable_fields" BEFORE UPDATE ON "CoutInterventionAchat"
  FOR EACH ROW EXECUTE FUNCTION prevent_cout_intervention_common_immutable_fields();
CREATE TRIGGER "CoutInterventionHeure_taux_immutable" BEFORE UPDATE ON "CoutInterventionHeure"
  FOR EACH ROW EXECUTE FUNCTION prevent_cout_intervention_heure_taux_immutable();
