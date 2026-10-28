-- Temps minimum facturé et pas par tranches de 15 minutes (lot « facture au temps passé », première PR ;
-- décisions de Nelson de la nuit du 26 au 27-10-2026, points 8, 9, 11 et 12).
--
-- Le temps minimum facturé devient un réglage de la société, en minutes, par multiples de 15, de
-- 15 minutes à 8 heures, d'une heure à l'installation ; vidé, il revient à une heure (l'API écrit alors
-- 60). Chaque nouveau devis au temps passé le fige avec le pas, et sa ligne au temps passé vaut ce
-- minimum, puis des multiples du pas (par exemple 1 h, 1 h 15 ou 1 h 30 avec un minimum d'une heure et
-- un pas de 15 minutes).
--
-- Aucune reprise de données (règle 4) : un devis au temps passé fait avant ce lot garde un minimum vide,
-- c'est-à-dire la règle d'alors (une heure minimum, son pas figé, quantité au millième) ; le pas réglé de
-- la société garde ses bornes de 1 à 60 minutes en base, l'API n'acceptant plus que 15, 30, 45 ou 60
-- minutes, et un nouveau devis refusant de figer une autre valeur.

ALTER TABLE "Parametres" ADD COLUMN "tempsMinimumMinutes" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "Parametres" ADD CONSTRAINT "Parametres_tempsMinimumMinutes_check"
  CHECK ("tempsMinimumMinutes" BETWEEN 15 AND 480 AND "tempsMinimumMinutes" % 15 = 0);

-- Minimum figé du devis : vide sur un devis ordinaire ; sur un devis au temps passé, vide (devis
-- antérieur à ce lot) ou un multiple de 15 minutes de 15 minutes à 8 heures, avec alors un pas de 15,
-- 30, 45 ou 60 minutes.
ALTER TABLE "Devis" ADD COLUMN "tempsMinimumMinutes" INTEGER;
ALTER TABLE "Devis" ADD CONSTRAINT "Devis_temps_passe_minimum_check" CHECK (
  CASE WHEN "auTempsPasse" THEN
    "tempsMinimumMinutes" IS NULL OR (
      "tempsMinimumMinutes" BETWEEN 15 AND 480 AND "tempsMinimumMinutes" % 15 = 0
      AND "pasTempsPasseMinutes" IS NOT NULL AND "pasTempsPasseMinutes" IN (15, 30, 45, 60)
    )
  ELSE
    "tempsMinimumMinutes" IS NULL
  END
);

-- La ligne au temps passé n'a plus une heure au moins pour tout devis : son minimum est celui du devis
-- (15 minutes au moins), vérifié avec le pas à la validation de la transaction (plus bas). La contrainte
-- est reprise de la migration 20261025120000_devis_temps_passe, « quantite » >= 1 devenant > 0.
ALTER TABLE "DevisLigne" DROP CONSTRAINT "DevisLigne_temps_passe_check";
ALTER TABLE "DevisLigne" ADD CONSTRAINT "DevisLigne_temps_passe_check" CHECK (
  CASE WHEN "tempsPasse" THEN
    "tarifTempsPasse" IS NOT NULL AND "tarifTempsPasse" IN ('HORS_CONTRAT', 'SOUS_CONTRAT')
    AND "nature" = 'MAIN_OEUVRE' AND "unite" IS NOT NULL AND "unite" = 'heure' AND "quantite" > 0
    AND "catalogueFamille" IS NOT NULL AND "catalogueFamille" = 'prestations'
    AND "catalogueId" IS NOT NULL AND "reference" IS NOT NULL AND "prixAchatUnitaireHt" IS NULL
    AND "totalHt" = round("quantite" * "prixUnitaireHt", 2)
    AND "totalTtc" = round("totalHt" * (100 + "tauxTva") / 100, 2)
  ELSE
    "tarifTempsPasse" IS NULL
  END
);

-- Vérification à la validation, reprise de la migration 20261025120000_devis_temps_passe : exactement
-- une ligne au temps passé sur un devis au temps passé, aucune sur un devis ordinaire ; et désormais la
-- quantité de cette ligne : une heure au moins sur un devis sans minimum figé (antérieur à ce lot) ; le
-- minimum figé, puis des multiples du pas, en minutes entières, sur les autres.
CREATE OR REPLACE FUNCTION verifier_devis_temps_passe() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cibles TEXT[];
  cible TEXT;
  marque BOOLEAN;
  minimum INTEGER;
  pas INTEGER;
  nombre INTEGER;
  minutes NUMERIC;
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
    SELECT "auTempsPasse", "tempsMinimumMinutes", "pasTempsPasseMinutes" INTO marque, minimum, pas FROM "Devis" WHERE "id" = cible;
    CONTINUE WHEN NOT FOUND;
    SELECT count(*) INTO nombre FROM "DevisLigne" WHERE "devisId" = cible AND "tempsPasse";
    IF marque AND nombre <> 1 THEN
      RAISE EXCEPTION 'Devis au temps passé : il porte exactement une ligne de main d’œuvre au temps passé (% trouvée(s)).', nombre;
    END IF;
    IF NOT marque AND nombre > 0 THEN
      RAISE EXCEPTION 'Devis ordinaire : une ligne au temps passé n’existe que sur un devis au temps passé.';
    END IF;
    IF marque THEN
      SELECT "quantite" * 60 INTO minutes FROM "DevisLigne" WHERE "devisId" = cible AND "tempsPasse";
      IF minimum IS NULL THEN
        IF minutes < 60 THEN
          RAISE EXCEPTION 'Devis au temps passé antérieur au temps minimum réglé : sa ligne au temps passé compte une heure au moins.';
        END IF;
      ELSIF minutes <> trunc(minutes) OR minutes < minimum OR (minutes - minimum) % pas <> 0 THEN
        RAISE EXCEPTION 'Devis au temps passé : sa ligne au temps passé vaut le temps minimum facturé (% minutes), puis des tranches de % minutes.', minimum, pas;
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- Le devis est aussi vérifié quand son minimum ou son pas change (un devis non signé qui passe au temps
-- passé, ou qui en sort, les reçoit ou les perd).
DROP TRIGGER devis_temps_passe_marqueur ON "Devis";
CREATE CONSTRAINT TRIGGER devis_temps_passe_marqueur AFTER UPDATE ON "Devis"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD."auTempsPasse" IS DISTINCT FROM NEW."auTempsPasse"
  OR OLD."tempsMinimumMinutes" IS DISTINCT FROM NEW."tempsMinimumMinutes"
  OR OLD."pasTempsPasseMinutes" IS DISTINCT FROM NEW."pasTempsPasseMinutes")
EXECUTE FUNCTION verifier_devis_temps_passe();

-- Le minimum d'un devis signé rejoint son contenu figé. Corps repris de la migration
-- 20261025120000_devis_temps_passe, avec la seule colonne "tempsMinimumMinutes" ajoutée, et nommée dans
-- le message de refus.
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
  IF (NEW."dossierId", NEW."numero", NEW."version", NEW."clientId", NEW."objet", NEW."totalHt", NEW."totalTva", NEW."totalTtc", NEW."acompteExige", NEW."tauxAcompte", NEW."createdAt", NEW."auTempsPasse", NEW."pasTempsPasseMinutes", NEW."tempsMinimumMinutes")
     IS DISTINCT FROM
     (OLD."dossierId", OLD."numero", OLD."version", OLD."clientId", OLD."objet", OLD."totalHt", OLD."totalTva", OLD."totalTtc", OLD."acompteExige", OLD."tauxAcompte", OLD."createdAt", OLD."auTempsPasse", OLD."pasTempsPasseMinutes", OLD."tempsMinimumMinutes") THEN
    RAISE EXCEPTION 'Devis signé : client, objet, date, montants, acompte exigé et temps passé (marqueur, pas et minimum) sont figés, créez une nouvelle révision.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
