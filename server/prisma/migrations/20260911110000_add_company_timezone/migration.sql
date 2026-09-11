ALTER TABLE "CompanySettings"
ADD COLUMN "fuseauHoraire" TEXT DEFAULT 'Europe/Paris';

UPDATE "CompanySettings"
SET "fuseauHoraire" = 'Europe/Paris'
WHERE "fuseauHoraire" IS NULL;