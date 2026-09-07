-- Rattachements facultatifs mais cohérents avec le client de l'intervention.
ALTER TABLE "Intervention" ADD COLUMN "siteId" TEXT;
ALTER TABLE "Intervention" ADD COLUMN "contactId" TEXT;
CREATE INDEX "Intervention_siteId_idx" ON "Intervention"("siteId");
CREATE INDEX "Intervention_contactId_idx" ON "Intervention"("contactId");
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "ClientSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "ClientContact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
