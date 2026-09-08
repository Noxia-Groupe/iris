-- Une facture émise conserve l'identité client connue à sa création.
ALTER TABLE "Facture" ADD COLUMN "clientRaisonSociale" TEXT;
UPDATE "Facture" SET "clientRaisonSociale" = "Client"."raisonSociale" FROM "Client" WHERE "Client"."id" = "Facture"."clientId";
ALTER TABLE "Facture" ALTER COLUMN "clientRaisonSociale" SET NOT NULL;
