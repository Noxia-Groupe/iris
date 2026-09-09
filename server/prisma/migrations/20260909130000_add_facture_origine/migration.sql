-- Chaque facture nouvellement créée déclare son origine métier.
-- Les factures antérieures de cette phase de construction sont explicitement classées hors affaire.
ALTER TABLE "Chantier" ADD COLUMN "clientId" TEXT;
UPDATE "Chantier" SET "clientId" = "Client"."id" FROM "Client" WHERE "Chantier"."client" = "Client"."raisonSociale";
ALTER TABLE "Chantier" ADD CONSTRAINT "Chantier_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Chantier_clientId_idx" ON "Chantier"("clientId");

ALTER TABLE "Facture" ADD COLUMN "origine" TEXT NOT NULL DEFAULT 'HORS_AFFAIRE';
ALTER TABLE "Facture" ADD COLUMN "chantierId" TEXT;
ALTER TABLE "Facture" ADD COLUMN "interventionId" TEXT;
ALTER TABLE "Facture" ADD COLUMN "contratMaintenanceId" TEXT;
ALTER TABLE "Facture" ADD COLUMN "motifHorsAffaire" TEXT;
UPDATE "Facture" SET "motifHorsAffaire" = 'Facture historique antérieure au rattachement à l’affaire.' WHERE "origine" = 'HORS_AFFAIRE';

ALTER TABLE "Facture" ADD CONSTRAINT "Facture_chantierId_fkey" FOREIGN KEY ("chantierId") REFERENCES "Chantier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Facture" ADD CONSTRAINT "Facture_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "Intervention"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Facture" ADD CONSTRAINT "Facture_contratMaintenanceId_fkey" FOREIGN KEY ("contratMaintenanceId") REFERENCES "ContratMaintenance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Facture" ADD CONSTRAINT "Facture_origine_unique_check" CHECK (
  (("chantierId" IS NOT NULL)::int + ("interventionId" IS NOT NULL)::int + ("contratMaintenanceId" IS NOT NULL)::int)
  = CASE WHEN "origine" = 'HORS_AFFAIRE' THEN 0 ELSE 1 END
);
ALTER TABLE "Facture" ADD CONSTRAINT "Facture_hors_affaire_motif_check" CHECK (
  "origine" <> 'HORS_AFFAIRE' OR char_length(coalesce("motifHorsAffaire", '')) >= 3
);

CREATE INDEX "Facture_chantierId_idx" ON "Facture"("chantierId");
CREATE INDEX "Facture_interventionId_idx" ON "Facture"("interventionId");
CREATE INDEX "Facture_contratMaintenanceId_idx" ON "Facture"("contratMaintenanceId");
