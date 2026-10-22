-- Lot pilote 6a-1 : identité de l'émetteur copiée et figée à l'émission (décision 6 de la
-- proposition de paramétrage, option B de P5 retenue par Nelson le 22-10-2026). Une facture émise
-- ne lit jamais un paramètre vivant : la raison sociale, le SIRET, l'adresse, le logo, la couleur
-- et le pied de page qu'elle imprime viennent d'une copie faite à son émission.

-- Logo des documents, téléversé par le super administrateur. Une version de logo ne change
-- jamais : un nouveau fichier crée une nouvelle ligne, et l'ancienne reste lisible par les
-- pièces qui l'ont figée. L'empreinte (SHA-256 du contenu) évite de stocker deux fois le même
-- fichier.
CREATE TABLE "LogoDocument" (
  "id" TEXT NOT NULL,
  "contenu" BYTEA NOT NULL,
  "typeMime" TEXT NOT NULL,
  "empreinte" TEXT NOT NULL,
  "taille" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LogoDocument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LogoDocument_typeMime_check" CHECK ("typeMime" IN ('image/png', 'image/jpeg')),
  CONSTRAINT "LogoDocument_taille_check" CHECK ("taille" > 0 AND "taille" = octet_length("contenu"))
);
CREATE UNIQUE INDEX "LogoDocument_empreinte_key" ON "LogoDocument"("empreinte");

ALTER TABLE "CompanySettings" ADD COLUMN "logoDocumentId" TEXT;
ALTER TABLE "CompanySettings" ADD CONSTRAINT "CompanySettings_logoDocumentId_fkey"
  FOREIGN KEY ("logoDocumentId") REFERENCES "LogoDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Identité de l'émetteur telle qu'imprimée sur une pièce. Une ligne ne change jamais ; deux
-- pièces émises avec la même identité partagent la même ligne (empreinte du contenu).
CREATE TABLE "IdentiteEmetteur" (
  "id" TEXT NOT NULL,
  "empreinte" TEXT NOT NULL,
  "raisonSociale" TEXT NOT NULL,
  "nomCommercial" TEXT,
  "siret" TEXT NOT NULL,
  "tvaIntra" TEXT,
  "adresse" TEXT NOT NULL,
  "codePostal" TEXT NOT NULL,
  "ville" TEXT NOT NULL,
  "pays" TEXT,
  "telephone" TEXT,
  "email" TEXT,
  "siteWeb" TEXT,
  "piedDocument" TEXT,
  "couleurPrimaire" TEXT NOT NULL,
  "logoId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdentiteEmetteur_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IdentiteEmetteur_couleur_check" CHECK ("couleurPrimaire" ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT "IdentiteEmetteur_obligatoires_check" CHECK (
    btrim("raisonSociale") <> '' AND btrim("siret") <> '' AND btrim("adresse") <> ''
    AND btrim("codePostal") <> '' AND btrim("ville") <> ''
  )
);
CREATE UNIQUE INDEX "IdentiteEmetteur_empreinte_key" ON "IdentiteEmetteur"("empreinte");
CREATE INDEX "IdentiteEmetteur_logoId_idx" ON "IdentiteEmetteur"("logoId");
ALTER TABLE "IdentiteEmetteur" ADD CONSTRAINT "IdentiteEmetteur_logoId_fkey"
  FOREIGN KEY ("logoId") REFERENCES "LogoDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Facture" ADD COLUMN "identiteEmetteurId" TEXT;
CREATE INDEX "Facture_identiteEmetteurId_idx" ON "Facture"("identiteEmetteurId");
ALTER TABLE "Facture" ADD CONSTRAINT "Facture_identiteEmetteurId_fkey"
  FOREIGN KEY ("identiteEmetteurId") REFERENCES "IdentiteEmetteur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Une version de logo et une identité figée ne se modifient jamais. Une ligne qu'aucune pièce ni
-- réglage ne référence peut être supprimée ; les clés étrangères RESTRICT refusent les autres.
CREATE FUNCTION refuser_modification_copie_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[0];
END $$;
CREATE TRIGGER logo_document_immuable BEFORE UPDATE ON "LogoDocument"
FOR EACH ROW EXECUTE FUNCTION refuser_modification_copie_document('Une version de logo est immuable : téléversez un nouveau fichier.');
CREATE TRIGGER identite_emetteur_immuable BEFORE UPDATE ON "IdentiteEmetteur"
FOR EACH ROW EXECUTE FUNCTION refuser_modification_copie_document('L’identité figée d’un émetteur est immuable.');
CREATE TRIGGER logo_document_sans_vidage BEFORE TRUNCATE ON "LogoDocument"
FOR EACH STATEMENT EXECUTE FUNCTION refuser_modification_copie_document('Logos des documents : vidage interdit (TRUNCATE).');
CREATE TRIGGER identite_emetteur_sans_vidage BEFORE TRUNCATE ON "IdentiteEmetteur"
FOR EACH STATEMENT EXECUTE FUNCTION refuser_modification_copie_document('Identités figées des émetteurs : vidage interdit (TRUNCATE).');

-- Une pièce ne quitte le brouillon qu'avec son identité figée : à l'émission d'une facture, comme
-- à la création d'un avoir, qui naît émis. Les pièces émises avant ce lot n'ont pas de copie et
-- gardent leur impression d'origine : le garde ne porte que sur le passage hors brouillon.
CREATE FUNCTION exiger_identite_emetteur_emission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."statut" <> 'BROUILLON' AND NEW."identiteEmetteurId" IS NULL
     AND (TG_OP = 'INSERT' OR OLD."statut" = 'BROUILLON') THEN
    RAISE EXCEPTION 'Une pièce ne s’émet qu’avec l’identité de l’émetteur figée.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER facture_identite_emetteur_emission BEFORE INSERT OR UPDATE ON "Facture"
FOR EACH ROW EXECUTE FUNCTION exiger_identite_emetteur_emission();

-- L'identité figée rejoint les mentions et liens immuables hors brouillon (corps repris de la
-- migration 20261018120000_factures_emises_figees, avec la seule colonne ajoutée).
CREATE OR REPLACE FUNCTION "interdire_modification_origine_facture_emise"() RETURNS trigger AS $$
BEGIN
  IF OLD."statut" <> 'BROUILLON' AND NEW."statut" = 'BROUILLON' THEN
    RAISE EXCEPTION 'Une facture émise ne redevient jamais brouillon.';
  END IF;
  IF OLD."statut" <> 'BROUILLON' AND (
    NEW."origine" IS DISTINCT FROM OLD."origine" OR
    NEW."chantierId" IS DISTINCT FROM OLD."chantierId" OR
    NEW."interventionId" IS DISTINCT FROM OLD."interventionId" OR
    NEW."contratMaintenanceId" IS DISTINCT FROM OLD."contratMaintenanceId" OR
    NEW."motifHorsAffaire" IS DISTINCT FROM OLD."motifHorsAffaire" OR
    NEW."clientRaisonSociale" IS DISTINCT FROM OLD."clientRaisonSociale" OR
    NEW."clientAdresse" IS DISTINCT FROM OLD."clientAdresse" OR
    NEW."type" IS DISTINCT FROM OLD."type" OR
    NEW."factureOrigineId" IS DISTINCT FROM OLD."factureOrigineId" OR
    NEW."estAvoirAnnulation" IS DISTINCT FROM OLD."estAvoirAnnulation" OR
    NEW."mentionsLegalesVersionId" IS DISTINCT FROM OLD."mentionsLegalesVersionId" OR
    NEW."emisLe" IS DISTINCT FROM OLD."emisLe" OR
    NEW."identiteEmetteurId" IS DISTINCT FROM OLD."identiteEmetteurId"
  ) THEN
    RAISE EXCEPTION 'Les mentions et liens figés d’une facture émise sont immuables.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
