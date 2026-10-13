-- Destinataires du suivi de rentabilité d'un chantier (marge du jour, marge estimée,
-- alertes « en perte » et « marge faible »), réglés par chaque société. Les
-- administrateurs les reçoivent toujours ; les autres catégories sont actives par défaut.
ALTER TABLE "Parametres" ADD COLUMN "rentabiliteConducteur" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Parametres" ADD COLUMN "rentabiliteHierarchie" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Parametres" ADD COLUMN "rentabiliteDirecteurs" BOOLEAN NOT NULL DEFAULT true;

-- Un compte n'est jamais son propre responsable hiérarchique, même écrit hors de l'API.
-- Les boucles plus longues sont refusées par l'API, et la lecture de la branche y résiste.
-- Un auto-rattachement déjà écrit en base (aucun écran ne permettait d'en créer) est
-- d'abord retiré : il ne donnait aucun accès, et bloquerait la contrainte.
UPDATE "User" SET "responsableHierarchiqueId" = NULL WHERE "responsableHierarchiqueId" = "id";
ALTER TABLE "User" ADD CONSTRAINT "user_responsable_hierarchique_pas_soi"
  CHECK ("responsableHierarchiqueId" IS NULL OR "responsableHierarchiqueId" <> "id");
