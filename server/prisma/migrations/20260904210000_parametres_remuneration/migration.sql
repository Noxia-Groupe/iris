-- Sort les règles de rémunération commerciale du code source.
--
-- Les barèmes, objectifs et primes étaient écrits en dur dans server/index.ts, avec les
-- valeurs d'une société en particulier. Iris étant destiné à être installé chez plusieurs
-- clients, ces valeurs deviennent des données, éditables depuis l'application.

CREATE TABLE "ParametresRemuneration" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "baremeStandard" JSONB NOT NULL,
    "baremeReduit" JSONB NOT NULL,
    "libelleBaremeReduit" TEXT NOT NULL DEFAULT 'Barème réduit',
    "objectifCaMensuel" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "primeObjectifCa" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "objectifMargeMensuel" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "primeObjectifMarge" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "primeSuiviAdministratif" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ParametresRemuneration_pkey" PRIMARY KEY ("id")
);

-- Valeurs de départ : celles qui étaient codées en dur. Une instance existante ne voit
-- donc AUCUN changement de calcul ; une nouvelle instance ajustera les siennes depuis
-- Administration > Rémunération commerciale.
-- `plafond: null` marque la tranche non plafonnée (JSON ne représente pas Infinity).
INSERT INTO "ParametresRemuneration" (
    "id", "baremeStandard", "baremeReduit", "libelleBaremeReduit",
    "objectifCaMensuel", "primeObjectifCa",
    "objectifMargeMensuel", "primeObjectifMarge", "primeSuiviAdministratif", "updatedAt"
) VALUES (
    'singleton',
    '[{"plafond":20000,"taux":16},{"plafond":30000,"taux":20},{"plafond":null,"taux":25}]'::jsonb,
    '[{"plafond":20000,"taux":8},{"plafond":30000,"taux":10},{"plafond":null,"taux":12.5}]'::jsonb,
    'Dossier apporté par la société',
    70000, 450,
    17000, 450, 250, CURRENT_TIMESTAMP
) ON CONFLICT ("id") DO NOTHING;

-- Le nom du champ désignait une société ; il désigne désormais la règle qu'il déclenche.
-- RENAME conserve les valeurs : aucun chantier ne change de barème.
ALTER TABLE "Chantier" RENAME COLUMN "dossierNoxia" TO "baremeReduit";
