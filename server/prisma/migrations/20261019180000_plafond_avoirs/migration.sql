-- Plafond des avoirs (#230) : les règles que l'application applique en créant un avoir partiel ou en
-- annulant une facture sont garanties en base, pour un avoir écrit directement en SQL. Seuls les
-- avoirs émis comptent, comme pour le reste dû (reste_du_facture) : un avoir resté brouillon n'est
-- pas une pièce, et il est vérifié au moment où il est émis.
--   - un avoir partiel émis ne crédite qu'une facture émise ou réglée : ni une facture annulée, à
--     côté de son avoir d'annulation, ni un brouillon, ni un avoir ;
--   - chaque avoir émis est une pièce cohérente, comme l'application les produit : aucun montant
--     négatif, TTC = HT + TVA, et une ventilation par taux dont les sommes égalent ses totaux. Sans
--     cela, un avoir négatif compenserait le plafond, et un avoir sans contenu, ou mal ventilé,
--     échapperait au contrôle par taux ;
--   - les avoirs émis d'une facture ne dépassent ni son HT, ni sa TVA, ni son TTC ;
--   - ni, pour chaque taux de TVA, la ventilation de la facture à ce taux (HT, TVA, et HT + TVA
--     au plus son TTC) ; un taux absent de la facture est refusé.
-- La ventilation d'une pièce est celle qu'elle enregistre ; une pièce qui n'en enregistre aucune
-- (documents historiques) la déduit de ses lignes, comme l'application (ventilationFacture) : base
-- HT du taux, et TVA arrondie au centime le plus proche, moitié vers le haut (montants positifs).
-- Aucune reprise : les pièces existantes ne sont pas revérifiées (règle 4), sauf celles d'une
-- facture qui reçoit un nouvel avoir ou s'annule.
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
DECLARE facture RECORD; avoir RECORD; ventile RECORD; credite RECORD; depassement RECORD;
BEGIN
  -- Verrou de la facture créditée, pris avant toute lecture des avoirs, comme le garde différé des
  -- règlements : une transaction qui émet un avoir pendant qu'une autre a déjà validé les siens
  -- attend celle-ci, puis relit ses avoirs. L'API tient déjà ce verrou. Deux transactions qui ont
  -- chacune inséré un avoir avant de valider s'interbloquent (le contrôle de clé étrangère de chaque
  -- insertion tient la facture) : PostgreSQL en annule une, et le plafond n'est jamais dépassé.
  SELECT "type", "statut", "totalHt", "totalTva", "totalTtc" INTO facture FROM "Facture" WHERE "id" = facture_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF (facture."type" <> 'FACTURE' OR facture."statut" NOT IN ('EMISE', 'REGLEE')) AND EXISTS (
    SELECT 1 FROM "Facture" WHERE "factureOrigineId" = facture_id AND "type" = 'AVOIR' AND "statut" <> 'BROUILLON' AND NOT "estAvoirAnnulation"
  ) THEN
    RAISE EXCEPTION 'Un avoir partiel ne crédite qu''une facture émise ou réglée (pièce %, % %).', facture_id, facture."type", facture."statut";
  END IF;
  FOR avoir IN SELECT "id", "totalHt", "totalTva", "totalTtc" FROM "Facture"
    WHERE "factureOrigineId" = facture_id AND "type" = 'AVOIR' AND "statut" <> 'BROUILLON'
  LOOP
    IF avoir."totalHt" < 0 OR avoir."totalTva" < 0 OR avoir."totalTtc" < 0
       OR EXISTS (SELECT 1 FROM ventilation_tva_piece(avoir."id") v WHERE v.ht < 0 OR v.tva < 0 OR v.ttc < 0) THEN
      RAISE EXCEPTION 'L''avoir % de la facture % porte un montant négatif.', avoir."id", facture_id;
    END IF;
    SELECT COALESCE(SUM(v.ht), 0) AS ht, COALESCE(SUM(v.tva), 0) AS tva, COALESCE(bool_and(v.ttc = v.ht + v.tva), TRUE) AS ttc_juste
    INTO ventile FROM ventilation_tva_piece(avoir."id") v;
    IF avoir."totalTtc" <> avoir."totalHt" + avoir."totalTva" OR ventile.ht <> avoir."totalHt" OR ventile.tva <> avoir."totalTva" OR NOT ventile.ttc_juste THEN
      RAISE EXCEPTION 'L''avoir % de la facture % n''a pas des totaux égaux à sa ventilation de TVA (HT, TVA, TTC = HT + TVA).', avoir."id", facture_id;
    END IF;
  END LOOP;
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

-- Un avoir émis (créé émis, ou émis depuis un brouillon) est vérifié sur sa facture, à la
-- validation de la transaction et sur l'état d'alors : son contenu, ajouté dans la même transaction,
-- est donc vu. Ensuite, ses lignes et sa ventilation ne changent plus (scellées à l'émission,
-- figées par le garde de la migration 20261018120000), si bien qu'aucun déclencheur sur ces tables
-- n'est nécessaire. Aucune suppression non plus : elle ne ferait que baisser les avoirs, et ni les
-- lignes ni la ventilation d'une pièce émise ne se suppriment.
-- Une facture annulée est vérifiée elle-même : la migration précédente impose déjà son avoir
-- d'annulation, dont la création déclenche le contrôle, mais ce second déclenchement ne coûte rien.
-- Pour une même ligne, le déclencheur est nommé pour passer après les gardes d'annulation de la
-- migration précédente, dont les refus plus précis restent ceux que l'on voit ; d'une ligne à
-- l'autre, c'est l'ordre des écritures de la transaction qui décide.
CREATE FUNCTION declencher_plafond_avoirs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM verifier_plafond_avoirs(CASE WHEN NEW."type" = 'AVOIR' THEN NEW."factureOrigineId" ELSE NEW."id" END);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER facture_plafond_avoirs AFTER INSERT OR UPDATE ON "Facture"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN ((NEW."type" = 'AVOIR' AND NEW."statut" <> 'BROUILLON') OR (NEW."type" = 'FACTURE' AND NEW."statut" = 'ANNULEE'))
EXECUTE FUNCTION declencher_plafond_avoirs();
