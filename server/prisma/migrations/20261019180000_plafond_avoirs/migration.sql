-- Plafond des avoirs (#230) : les règles que l'application applique en créant un avoir partiel ou en
-- annulant une facture sont garanties en base, pour un avoir écrit directement en SQL. Seuls les
-- avoirs émis comptent, comme pour le reste dû (reste_du_facture) : un avoir resté brouillon n'est
-- pas une pièce, et il est vérifié au moment où il est émis.
--   - un avoir partiel émis ne crédite qu'une facture émise ou réglée : ni une facture annulée, à
--     côté de son avoir d'annulation, ni un brouillon, ni un avoir ;
--   - les avoirs émis d'une facture ne dépassent ni son HT, ni sa TVA, ni son TTC ;
--   - ni, pour chaque taux de TVA, la ventilation de la facture à ce taux (HT, TVA, et HT + TVA
--     au plus son TTC) ; un taux absent de la facture est refusé.
-- La ventilation d'une pièce est celle qu'elle enregistre ; une pièce qui n'en enregistre aucune
-- (documents historiques) la déduit de ses lignes, comme l'application (ventilationFacture) : base
-- HT du taux, et TVA arrondie au centime le plus proche, moitié vers le haut (montants positifs).
-- Vérifié à la validation de chaque transaction qui crée ou modifie un avoir émis, son contenu, ou
-- qui annule une facture. Aucune reprise : les pièces existantes ne sont pas revérifiées (règle 4).
CREATE FUNCTION ventilation_tva_piece(piece_id TEXT) RETURNS TABLE (taux NUMERIC, ht NUMERIC, tva NUMERIC, ttc NUMERIC) LANGUAGE sql STABLE AS $$
  SELECT v."tauxTva", v."totalHt", v."totalTva", v."totalTtc" FROM "FactureVentilationTva" v WHERE v."factureId" = piece_id
  UNION ALL
  SELECT d.taux, d.ht, d.tva, d.ht + d.tva FROM (
    SELECT l."tauxTva" AS taux, SUM(l."totalHt") AS ht, round(SUM(l."totalHt") * l."tauxTva" / 100, 2) AS tva
    FROM "FactureLigne" l WHERE l."factureId" = piece_id GROUP BY l."tauxTva"
  ) d
  WHERE NOT EXISTS (SELECT 1 FROM "FactureVentilationTva" WHERE "factureId" = piece_id)
$$;

CREATE FUNCTION verifier_plafond_avoirs(facture_id TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE facture RECORD; credite RECORD; depassement RECORD;
BEGIN
  -- Verrou de la facture créditée, comme le garde différé des règlements qui la verrouille aussi
  -- pour un avoir : deux transactions qui lui ajoutent chacune un avoir se sérialisent, et la
  -- seconde relit les avoirs validés par la première. L'API tient déjà ce verrou.
  SELECT "type", "statut", "totalHt", "totalTva", "totalTtc" INTO facture FROM "Facture" WHERE "id" = facture_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF (facture."type" <> 'FACTURE' OR facture."statut" NOT IN ('EMISE', 'REGLEE')) AND EXISTS (
    SELECT 1 FROM "Facture" WHERE "factureOrigineId" = facture_id AND "type" = 'AVOIR' AND "statut" <> 'BROUILLON' AND NOT "estAvoirAnnulation"
  ) THEN
    RAISE EXCEPTION 'Un avoir partiel ne crédite qu''une facture émise ou réglée (pièce %, % %).', facture_id, facture."type", facture."statut";
  END IF;
  SELECT COALESCE(SUM("totalHt"), 0) AS ht, COALESCE(SUM("totalTva"), 0) AS tva, COALESCE(SUM("totalTtc"), 0) AS ttc INTO credite
  FROM "Facture" WHERE "factureOrigineId" = facture_id AND "type" = 'AVOIR' AND "statut" <> 'BROUILLON';
  IF credite.ht > facture."totalHt" OR credite.tva > facture."totalTva" OR credite.ttc > facture."totalTtc" THEN
    RAISE EXCEPTION 'Les avoirs de la facture % dépassent son montant total (HT, TVA ou TTC).', facture_id;
  END IF;
  SELECT a.taux, o.taux IS NULL AS absent INTO depassement
  FROM (
    SELECT v.taux, SUM(v.ht) AS ht, SUM(v.tva) AS tva
    FROM "Facture" av CROSS JOIN LATERAL ventilation_tva_piece(av."id") v
    WHERE av."factureOrigineId" = facture_id AND av."type" = 'AVOIR' AND av."statut" <> 'BROUILLON'
    GROUP BY v.taux
  ) a
  LEFT JOIN ventilation_tva_piece(facture_id) o ON o.taux = a.taux
  WHERE o.taux IS NULL OR a.ht > o.ht OR a.tva > o.tva OR a.ht + a.tva > o.ttc
  ORDER BY a.taux LIMIT 1;
  IF FOUND AND depassement.absent THEN
    RAISE EXCEPTION 'Un avoir de la facture % porte un taux de TVA (% %%) absent de la facture.', facture_id, depassement.taux;
  ELSIF FOUND THEN
    RAISE EXCEPTION 'Les avoirs de la facture % dépassent sa ventilation à la TVA de % %%.', facture_id, depassement.taux;
  END IF;
END $$;

-- Pièce : un avoir émis (créé, émis, ou modifié tant qu'il n'est pas scellé) est vérifié sur sa
-- facture ; une facture annulée l'est elle-même (un avoir partiel ne côtoie pas son avoir
-- d'annulation). Nommé pour passer après les gardes d'annulation de la migration précédente, dont
-- les refus plus précis restent ceux que l'on voit.
CREATE FUNCTION declencher_plafond_avoirs() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origine TEXT;
BEGIN
  IF TG_TABLE_NAME = 'Facture' THEN
    PERFORM verifier_plafond_avoirs(CASE WHEN NEW."type" = 'AVOIR' THEN NEW."factureOrigineId" ELSE NEW."id" END);
  ELSE
    -- Ligne ou ventilation d'une pièce : seules celles d'un avoir changent ce qu'il crédite.
    SELECT "factureOrigineId" INTO origine FROM "Facture" WHERE "id" = NEW."factureId" AND "type" = 'AVOIR';
    IF origine IS NOT NULL THEN
      PERFORM verifier_plafond_avoirs(origine);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER facture_plafond_avoirs AFTER INSERT OR UPDATE ON "Facture"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN ((NEW."type" = 'AVOIR' AND NEW."statut" <> 'BROUILLON') OR (NEW."type" = 'FACTURE' AND NEW."statut" = 'ANNULEE'))
EXECUTE FUNCTION declencher_plafond_avoirs();
CREATE CONSTRAINT TRIGGER ligne_plafond_avoirs AFTER INSERT OR UPDATE ON "FactureLigne"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION declencher_plafond_avoirs();
CREATE CONSTRAINT TRIGGER ventilation_plafond_avoirs AFTER INSERT OR UPDATE ON "FactureVentilationTva"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION declencher_plafond_avoirs();
