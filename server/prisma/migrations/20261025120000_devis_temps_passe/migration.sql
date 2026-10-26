-- Devis au temps passé (décisions de Nelson du 24-10-2026, point 20 et « Réglage société », et du
-- 25-10-2026 : « À l'heure seulement », « Ligne minimum comptée », « Aucune, à régler », « Lot
-- suivant »).
--
-- Un devis au temps passé porte une ligne « main d'œuvre au temps passé » : une main d'œuvre du
-- catalogue, au prix à l'heure hors contrat ou sous contrat (jamais le forfait jour), fixé par le
-- serveur et figé, une heure au moins, comptée dans le total ; le matériel est en lignes à part. Le
-- pas du temps passé est un réglage de la société, vide au démarrage, que le devis fige. Le marqueur
-- est reporté sur l'intervention à la conversion. La facture au temps passé viendra avec un lot
-- suivant.
--
-- Aucune reprise de données (règle 4 de la méthode) : les devis, lignes et interventions existants
-- restent ordinaires, et le réglage reste vide.

-- Réglage de la société, en minutes. Vide (NULL) au démarrage : un devis au temps passé est refusé
-- tant que l'administration ne l'a pas fixé. Choix par défaut, à confirmer : de 1 à 60 minutes.
ALTER TABLE "Parametres" ADD COLUMN "pasTempsPasseMinutes" INTEGER;
ALTER TABLE "Parametres" ADD CONSTRAINT "Parametres_pasTempsPasseMinutes_check"
  CHECK ("pasTempsPasseMinutes" IS NULL OR "pasTempsPasseMinutes" BETWEEN 1 AND 60);

-- Marqueur du devis et pas figé : un devis au temps passé porte un pas de 1 à 60 minutes, un devis
-- ordinaire aucun.
ALTER TABLE "Devis" ADD COLUMN "auTempsPasse" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "pasTempsPasseMinutes" INTEGER;
ALTER TABLE "Devis" ADD CONSTRAINT "Devis_temps_passe_pas_check" CHECK (
  CASE WHEN "auTempsPasse" THEN
    "pasTempsPasseMinutes" IS NOT NULL AND "pasTempsPasseMinutes" BETWEEN 1 AND 60
  ELSE
    "pasTempsPasseMinutes" IS NULL
  END
);

-- Ligne au temps passé : une copie d'une main d'œuvre du catalogue (prestation), à l'heure hors
-- contrat ou sous contrat, main-d'œuvre, l'heure pour unité, une heure au moins, sans prix d'achat
-- prévu, et des totaux exacts : HT = quantité × prix unitaire et TTC = HT × (100 + TVA) / 100, chacun
-- arrondi au centime, moitié vers le haut (round de PostgreSQL sur un montant positif), comme le
-- calcul exact de l'API. Chaque terme est écrit pour ne jamais valoir NULL, qu'une contrainte CHECK
-- laisserait passer. Une ligne ordinaire n'a pas de tarif.
ALTER TABLE "DevisLigne" ADD COLUMN "tempsPasse" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "tarifTempsPasse" TEXT;
ALTER TABLE "DevisLigne" ADD CONSTRAINT "DevisLigne_temps_passe_check" CHECK (
  CASE WHEN "tempsPasse" THEN
    "tarifTempsPasse" IS NOT NULL AND "tarifTempsPasse" IN ('HORS_CONTRAT', 'SOUS_CONTRAT')
    AND "nature" = 'MAIN_OEUVRE' AND "unite" IS NOT NULL AND "unite" = 'heure' AND "quantite" >= 1
    AND "catalogueFamille" IS NOT NULL AND "catalogueFamille" = 'prestations'
    AND "catalogueId" IS NOT NULL AND "reference" IS NOT NULL AND "prixAchatUnitaireHt" IS NULL
    AND "totalHt" = round("quantite" * "prixUnitaireHt", 2)
    AND "totalTtc" = round("totalHt" * (100 + "tauxTva") / 100, 2)
  ELSE
    "tarifTempsPasse" IS NULL
  END
);

-- Une seule ligne au temps passé par devis.
CREATE UNIQUE INDEX "DevisLigne_un_temps_passe_par_devis" ON "DevisLigne"("devisId") WHERE "tempsPasse";

-- Un devis au temps passé porte exactement une ligne au temps passé, un devis ordinaire aucune.
-- Vérifié à la validation de la transaction (le devis est inséré avant ses lignes, et sa
-- modification remplace toutes ses lignes), pour chaque devis dont le marqueur change ou qui gagne,
-- perd ou modifie une ligne au temps passé. Un devis supprimé (ses lignes partent avec lui) n'est
-- pas vérifié.
CREATE FUNCTION verifier_devis_temps_passe() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cibles TEXT[];
  cible TEXT;
  marque BOOLEAN;
  nombre INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'Devis' THEN
    cibles := ARRAY[NEW."id"];
  ELSIF TG_OP = 'INSERT' THEN
    cibles := ARRAY[NEW."devisId"];
  ELSIF TG_OP = 'DELETE' THEN
    cibles := ARRAY[OLD."devisId"];
  ELSE
    cibles := ARRAY[OLD."devisId", NEW."devisId"];
  END IF;
  FOREACH cible IN ARRAY cibles LOOP
    SELECT "auTempsPasse" INTO marque FROM "Devis" WHERE "id" = cible;
    CONTINUE WHEN NOT FOUND;
    SELECT count(*) INTO nombre FROM "DevisLigne" WHERE "devisId" = cible AND "tempsPasse";
    IF marque AND nombre <> 1 THEN
      RAISE EXCEPTION 'Devis au temps passé : il porte exactement une ligne de main d’œuvre au temps passé (% trouvée(s)).', nombre;
    END IF;
    IF NOT marque AND nombre > 0 THEN
      RAISE EXCEPTION 'Devis ordinaire : une ligne au temps passé n’existe que sur un devis au temps passé.';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER devis_temps_passe_creation AFTER INSERT ON "Devis"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW."auTempsPasse")
EXECUTE FUNCTION verifier_devis_temps_passe();

CREATE CONSTRAINT TRIGGER devis_temps_passe_marqueur AFTER UPDATE ON "Devis"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD."auTempsPasse" IS DISTINCT FROM NEW."auTempsPasse")
EXECUTE FUNCTION verifier_devis_temps_passe();

CREATE CONSTRAINT TRIGGER devis_ligne_temps_passe_ajout AFTER INSERT ON "DevisLigne"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW."tempsPasse")
EXECUTE FUNCTION verifier_devis_temps_passe();

CREATE CONSTRAINT TRIGGER devis_ligne_temps_passe_modification AFTER UPDATE ON "DevisLigne"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD."tempsPasse" OR NEW."tempsPasse")
EXECUTE FUNCTION verifier_devis_temps_passe();

CREATE CONSTRAINT TRIGGER devis_ligne_temps_passe_retrait AFTER DELETE ON "DevisLigne"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD."tempsPasse")
EXECUTE FUNCTION verifier_devis_temps_passe();

-- Le marqueur et le pas d'un devis signé rejoignent son contenu figé. Corps repris de la migration
-- 20261022180000_devis_document_signature, avec les seules colonnes "auTempsPasse" et
-- "pasTempsPasseMinutes" ajoutées, et nommées dans le message de refus. Les lignes d'un devis signé,
-- ligne au temps passé comprise, sont déjà figées (devis_ligne_figee_si_signe).
CREATE OR REPLACE FUNCTION figer_contenu_devis_signe() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "DevisSignature" WHERE "devisId" = OLD."id") THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Devis signé : il ne se supprime pas.';
  END IF;
  IF (NEW."dossierId", NEW."numero", NEW."version", NEW."clientId", NEW."objet", NEW."totalHt", NEW."totalTva", NEW."totalTtc", NEW."acompteExige", NEW."tauxAcompte", NEW."createdAt", NEW."auTempsPasse", NEW."pasTempsPasseMinutes")
     IS DISTINCT FROM
     (OLD."dossierId", OLD."numero", OLD."version", OLD."clientId", OLD."objet", OLD."totalHt", OLD."totalTva", OLD."totalTtc", OLD."acompteExige", OLD."tauxAcompte", OLD."createdAt", OLD."auTempsPasse", OLD."pasTempsPasseMinutes") THEN
    RAISE EXCEPTION 'Devis signé : client, objet, date, montants, acompte exigé et temps passé (marqueur et pas) sont figés, créez une nouvelle révision.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Intervention au temps passé : marqueur reporté de son devis à la conversion.
ALTER TABLE "Intervention" ADD COLUMN "auTempsPasse" BOOLEAN NOT NULL DEFAULT false;

-- Il ne change plus ensuite : la facture au temps passé (lot suivant) s'y fiera.
CREATE FUNCTION figer_marqueur_temps_passe_intervention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Intervention : le marqueur « au temps passé », reporté de son devis à la conversion, ne change plus.';
END $$;

CREATE TRIGGER intervention_temps_passe_fige BEFORE UPDATE ON "Intervention"
FOR EACH ROW
WHEN (OLD."auTempsPasse" IS DISTINCT FROM NEW."auTempsPasse")
EXECUTE FUNCTION figer_marqueur_temps_passe_intervention();

-- Une conversion en intervention lie une intervention qui porte le marqueur de son devis. La cible
-- d'une conversion n'a pas de clé étrangère (chantier, intervention ou contrat) : une cible absente
-- n'est pas vérifiée ici, comme avant ce lot.
CREATE FUNCTION verifier_marqueur_conversion_intervention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Intervention" i, "Devis" d
    WHERE i."id" = NEW."cibleId" AND d."id" = NEW."devisId" AND i."auTempsPasse" IS DISTINCT FROM d."auTempsPasse"
  ) THEN
    RAISE EXCEPTION 'Conversion en intervention : l’intervention porte le marqueur « au temps passé » de son devis.';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER devis_conversion_marqueur_temps_passe BEFORE INSERT ON "DevisConversion"
FOR EACH ROW
WHEN (NEW."cibleType" = 'INTERVENTION')
EXECUTE FUNCTION verifier_marqueur_conversion_intervention();

-- Réciproquement, une intervention ne naît au temps passé que de la conversion d'un devis au temps
-- passé, enregistrée dans la même transaction : vérifié à la validation.
CREATE FUNCTION verifier_origine_intervention_temps_passe() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Intervention" WHERE "id" = NEW."id" AND "auTempsPasse") AND NOT EXISTS (
    SELECT 1 FROM "DevisConversion" c JOIN "Devis" d ON d."id" = c."devisId"
    WHERE c."cibleType" = 'INTERVENTION' AND c."cibleId" = NEW."id" AND d."auTempsPasse"
  ) THEN
    RAISE EXCEPTION 'Intervention au temps passé : elle ne naît que de la conversion d’un devis au temps passé.';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER intervention_temps_passe_origine AFTER INSERT ON "Intervention"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW."auTempsPasse")
EXECUTE FUNCTION verifier_origine_intervention_temps_passe();
