-- L'adresse du client est une mention obligatoire du document de facture et doit être figée à l'émission.
ALTER TABLE "Facture" ADD COLUMN "clientAdresse" TEXT;

-- Les factures historiques reprennent la meilleure adresse connue aujourd'hui. Lorsqu'aucun site
-- n'existe, la valeur reste NULL et l'impression est refusée plutôt que de produire un document incomplet.
UPDATE "Facture" SET "clientAdresse" = retenu."adresse"
FROM (
  SELECT DISTINCT ON (site."clientId") site."clientId",
         concat_ws(E'\n', site."adresse", site."complementAdresse",
                   concat_ws(' ', site."codePostal", site."ville"),
                   NULLIF(site."pays", 'France')) AS "adresse"
  FROM "ClientSite" site
  ORDER BY site."clientId", site."estSiteFacturation" DESC, site."principal" DESC, site."estSiegeSocial" DESC, site."nom" ASC
) AS retenu
WHERE retenu."clientId" = "Facture"."clientId" AND "Facture"."clientAdresse" IS NULL;
