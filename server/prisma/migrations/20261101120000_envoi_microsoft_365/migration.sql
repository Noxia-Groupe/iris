-- Lot 6b-1b : envoi des documents par Microsoft 365, côté serveur (choix par défaut, à confirmer).
-- Iris produit lui-même le PDF et l'envoie depuis la boîte Microsoft de l'utilisateur connecté, par
-- Microsoft Graph (POST /me/sendMail), puis note l'envoi au journal. La messagerie (lien mailto, lots
-- 6a-3 à 6a-4e) reste toujours disponible.
--
-- 1. Paramètre « mode d'envoi des documents » (règle permanente 1 ; décision A10 du 16-10-2026 :
--    « mode d'envoi choisi dans les paramètres généraux, Microsoft 365 par défaut »). Réglé par le
--    super administrateur, avec les modules (PUT /api/modules), et journalisé. MESSAGERIE refuse
--    l'envoi par Microsoft 365 ; la messagerie reste ouverte dans les deux modes. La ligne existante
--    prend la valeur par défaut, sans réécriture de la table (valeur par défaut constante).
ALTER TABLE "Parametres" ADD COLUMN "modeEnvoi" TEXT NOT NULL DEFAULT 'MICROSOFT_365';
ALTER TABLE "Parametres" ADD CONSTRAINT "Parametres_modeEnvoi_check" CHECK ("modeEnvoi" IN ('MICROSOFT_365', 'MESSAGERIE'));

-- 2. Journal des envois (migrations 20261023120000, 20261031120000 et 20261031200000), étendu sans
--    être recréé. Les trois déclencheurs restent en place, ni supprimés ni recréés, et s'appliquent
--    aux nouvelles lignes : envoi_document_ajout_seul (ni modification ni suppression),
--    envoi_document_sans_vidage (ni vidage) et envoi_document_horodatage (horodatage imposé par la
--    base). Aucune ligne existante n'est réécrite : les colonnes ajoutées, facultatives et sans valeur
--    par défaut, y restent vides, et les contraintes ajoutées ou recréées les acceptent telles quelles
--    (canal MESSAGERIE, colonnes vides).

-- Canal : la messagerie (envoi préparé) ou Microsoft 365 (envoi fait par Iris). Même nom que la
-- contrainte du lot 6a-3.
ALTER TABLE "EnvoiDocument" DROP CONSTRAINT "EnvoiDocument_canal";
ALTER TABLE "EnvoiDocument" ADD CONSTRAINT "EnvoiDocument_canal" CHECK ("canal" IN ('MESSAGERIE', 'MICROSOFT_365'));

-- Trois colonnes, exigées pour un envoi par Microsoft 365 et vides pour la messagerie :
--   - expediteur : l'adresse de la boîte Microsoft d'envoi, contrôlée avant l'envoi (celle du compte
--     Iris de la session) ;
--   - empreintePdf : le SHA-256 du PDF joint, en 64 caractères hexadécimaux minuscules. Il permet de
--     reconnaître le PDF envoyé, non de le retrouver : Iris ne garde pas de copie du PDF (question à
--     Nelson, écart déclaré à la vision) ;
--   - corps : le texte envoyé, qu'Iris écrit et envoie lui-même. La messagerie ne le garde pas : le
--     texte s'y retouche avant l'envoi, et Iris ne sait pas ce qui part.
-- Une contrainte CHECK est satisfaite quand son expression vaut NULL : chaque branche Microsoft 365
-- exige donc d'abord la valeur (IS NOT NULL), pour qu'une colonne vide y soit refusée.
ALTER TABLE "EnvoiDocument" ADD COLUMN "expediteur" TEXT;
ALTER TABLE "EnvoiDocument" ADD COLUMN "empreintePdf" TEXT;
ALTER TABLE "EnvoiDocument" ADD COLUMN "corps" TEXT;

ALTER TABLE "EnvoiDocument" ADD CONSTRAINT "EnvoiDocument_expediteur" CHECK (
  CASE WHEN "canal" = 'MICROSOFT_365' THEN "expediteur" IS NOT NULL AND btrim("expediteur") <> '' ELSE "expediteur" IS NULL END
);
ALTER TABLE "EnvoiDocument" ADD CONSTRAINT "EnvoiDocument_empreintePdf" CHECK (
  CASE WHEN "canal" = 'MICROSOFT_365' THEN "empreintePdf" IS NOT NULL AND "empreintePdf" ~ '^[0-9a-f]{64}$' ELSE "empreintePdf" IS NULL END
);
ALTER TABLE "EnvoiDocument" ADD CONSTRAINT "EnvoiDocument_corps" CHECK (
  CASE WHEN "canal" = 'MICROSOFT_365' THEN "corps" IS NOT NULL AND btrim("corps") <> '' ELSE "corps" IS NULL END
);
