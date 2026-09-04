-- Rôles métier des contacts et unicité des adresses de référence d'un client.
ALTER TABLE "ClientContact"
  ADD COLUMN "estDecisionnaire" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "estSignataire" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ClientSite"
  ADD COLUMN "estSiegeSocial" BOOLEAN NOT NULL DEFAULT false;

-- Une société peut avoir plusieurs sites opérationnels, mais un seul siège et une seule
-- adresse de facturation. Des index partiels permettent de conserver des sites non typés.
CREATE UNIQUE INDEX "ClientSite_unique_siege_social_par_client"
  ON "ClientSite"("clientId")
  WHERE "estSiegeSocial" = true;

CREATE UNIQUE INDEX "ClientSite_unique_facturation_par_client"
  ON "ClientSite"("clientId")
  WHERE "estSiteFacturation" = true;
